import Foundation
import SQLCipher
import CryptoKit
#if canImport(AppKit)
import AppKit
import ImageIO
#endif

enum ClipboardRepositoryError: Error { case database, invalidRequest, full, missing, persistence }

/// All calls run on `work`; the archive and full payloads never cross the JS bridge.
/// The SQLCipher index and AES-GCM payloads are protected by the shared local vault key.
final class ClipboardRepository {
  static let shared = ClipboardRepository()
  let work = DispatchQueue(label: "com.pcstyle.bettercast.clipboard", qos: .utility)
  private let root: URL
  private var db: OpaquePointer?
  private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
  private(set) var lastError: String?
  private var capShortened = false
  private let injectedKey: Data?

  init(directory: URL? = nil, key: Data? = nil) {
    root = directory ?? FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".config/bettercast/vault-v1/clipboard-v1", isDirectory: true)
    injectedKey = key
  }
  deinit { sqlite3_close(db) }

  func open() throws {
    if db != nil { return }
    // Obtain/create the key before making a vault subdirectory. A nonempty vault
    // without a key is a recovery error, not a reason to generate a replacement.
    let key = try injectedKey ?? LocalVault.key()
    try FileManager.default.createDirectory(at: root.appendingPathComponent("payloads"), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
    guard key.count == 32,
          sqlite3_open(root.appendingPathComponent("index.sqlite").path, &db) == SQLITE_OK else { throw ClipboardRepositoryError.database }
    do {
      let keyResult = key.withUnsafeBytes { bytes in sqlite3_key(db, bytes.baseAddress, Int32(bytes.count)) }
      guard keyResult == SQLITE_OK,
            !(try rows("PRAGMA cipher_version")).isEmpty else { throw ClipboardRepositoryError.database }
      _ = try rows("SELECT count(*) AS count FROM sqlite_master")
      try execute("PRAGMA temp_store=MEMORY")
      try? execute("PRAGMA cipher_memory_security=ON")
      try execute("PRAGMA auto_vacuum=INCREMENTAL")
      try execute("PRAGMA journal_mode=DELETE")
      try execute("PRAGMA secure_delete=ON")
      try execute("PRAGMA foreign_keys=ON")
      try execute("CREATE TABLE IF NOT EXISTS payloads (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL)")
      try execute("CREATE TABLE IF NOT EXISTS clips (id TEXT PRIMARY KEY, hash TEXT NOT NULL REFERENCES payloads(hash), kind TEXT NOT NULL, preview TEXT NOT NULL, preview_truncated INTEGER NOT NULL DEFAULT 0, copied REAL NOT NULL, source TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0)")
      if (try rows("PRAGMA table_info(clips)")).allSatisfy({ ($0["name"] as? String) != "preview_truncated" }) {
        try execute("ALTER TABLE clips ADD COLUMN preview_truncated INTEGER NOT NULL DEFAULT 0")
      }
      try execute("CREATE INDEX IF NOT EXISTS clips_recency ON clips(copied DESC, id DESC)")
      try execute("CREATE INDEX IF NOT EXISTS clips_payload ON clips(hash)")
      try execute("CREATE VIRTUAL TABLE IF NOT EXISTS clip_search USING fts5(id UNINDEXED, body, tokenize='unicode61 remove_diacritics 2')")
      try execute("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
      try execute("PRAGMA user_version=1")
      capShortened = (try metadata("capShortened")?["value"] as? Bool) ?? false
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: root.appendingPathComponent("index.sqlite").path)
      try sweepOrphans()
      try prune(now: Date().timeIntervalSince1970 * 1000)
    } catch { sqlite3_close(db); db = nil; throw error }
  }

  private func execute(_ sql: String, _ args: [Any] = []) throws {
    _ = try rows(sql, args)
  }
  private func rows(_ sql: String, _ args: [Any] = []) throws -> [[String: Any]] {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { throw ClipboardRepositoryError.database }
    defer { sqlite3_finalize(statement) }
    for (index, value) in args.enumerated() {
      let position = Int32(index + 1)
      if let value = value as? String { sqlite3_bind_text(statement, position, value, -1, transient) }
      else if let value = value as? NSNumber { sqlite3_bind_double(statement, position, value.doubleValue) }
      else { throw ClipboardRepositoryError.invalidRequest }
    }
    var result: [[String: Any]] = []
    while true {
      let status = sqlite3_step(statement)
      if status == SQLITE_DONE { return result }
      guard status == SQLITE_ROW else { throw ClipboardRepositoryError.database }
      var row: [String: Any] = [:]
      for i in 0..<sqlite3_column_count(statement) {
        let name = String(cString: sqlite3_column_name(statement, i))
        if sqlite3_column_type(statement, i) == SQLITE_TEXT, let text = sqlite3_column_text(statement, i) { row[name] = String(cString: text) }
        else { row[name] = sqlite3_column_double(statement, i) }
      }
      result.append(row)
    }
  }
  private func transaction(_ action: () throws -> Void) throws {
    try execute("BEGIN IMMEDIATE")
    do { try action(); try execute("COMMIT") }
    catch { try? execute("ROLLBACK"); throw error }
  }
  func metadata(_ key: String) throws -> [String: Any]? {
    guard let raw = try rows("SELECT value FROM metadata WHERE key=?", [key]).first?["value"] as? String,
          let data = raw.data(using: .utf8) else { return nil }
    guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ClipboardRepositoryError.persistence }
    return value
  }
  func setMetadata(_ key: String, _ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    guard data.count <= 1_048_576, let text = String(data: data, encoding: .utf8) else { throw ClipboardRepositoryError.invalidRequest }
    try execute("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)", [key, text])
  }
  func configuration() throws -> [String: Any] {
    var config: [String: Any] = ["retentionDays": 30, "capBytes": 1_073_741_824, "excludedBundleIds": [], "skipSensitive": true, "enabled": false, "private": false, "paused": true]
    if let saved = try metadata("config") { config.merge(saved) { _, new in new } }
    return config
  }
  func configure(_ updates: [String: Any]) throws -> [String: Any] {
    var config = try configuration()
    let allowed = Set(["retentionDays", "capBytes", "excludedBundleIds", "skipSensitive", "enabled", "private", "paused", "pauseUntil"])
    guard Set(updates.keys).isSubset(of: allowed) else { throw ClipboardRepositoryError.invalidRequest }
    config.merge(updates) { _, new in new }
    guard let days = number(config["retentionDays"])?.intValue, (1...365).contains(days),
          let cap = number(config["capBytes"])?.doubleValue, cap >= 1_048_576, cap <= 107_374_182_400,
          let exclusions = config["excludedBundleIds"] as? [String], exclusions.count <= 1000 else { throw ClipboardRepositoryError.invalidRequest }
    try setMetadata("config", config)
    try prune(now: Date().timeIntervalSince1970 * 1000)
    return try status()
  }
  private func number(_ value: Any?) -> NSNumber? {
    guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return nil }
    return value
  }
  private func vaultKey() throws -> SymmetricKey {
    let data = try injectedKey ?? LocalVault.key()
    guard data.count == 32 else { throw ClipboardRepositoryError.persistence }
    return SymmetricKey(data: data)
  }
  private func seal(_ data: Data) throws -> Data {
    guard let combined = try AES.GCM.seal(data, using: vaultKey()).combined else { throw ClipboardRepositoryError.persistence }
    return combined
  }
  private func unseal(_ data: Data) throws -> Data {
    do { return try AES.GCM.open(AES.GCM.SealedBox(combined: data), using: vaultKey()) }
    catch { throw ClipboardRepositoryError.persistence }
  }
  func captureAllowed(bundle: String, sensitive: Bool, now: Double) throws -> Bool {
    let config = try configuration()
    guard config["enabled"] as? Bool == true, config["private"] as? Bool != true else { return false }
    if config["paused"] as? Bool == true {
      guard let until = config["pauseUntil"] as? Double, until > 0, until <= now else { return false }
    }
    if (config["excludedBundleIds"] as? [String] ?? []).contains(bundle) { return false }
    if sensitive && config["skipSensitive"] as? Bool != false { return false }
    return true
  }

  /// Snapshot representations preserve originals (including text/RTF alongside images).
  @discardableResult func insert(kind: String, text: String, representations: [String: Data], files: [String] = [], source: [String: String] = [:], now: Double) throws -> String {
    guard ["text", "url", "image", "file"].contains(kind), text.utf8.count <= 4_194_304,
          representations.values.reduce(0, { $0 + $1.count }) <= 67_108_864 else { throw ClipboardRepositoryError.invalidRequest }
    let payload: [String: Any] = ["representations": representations, "files": files, "text": representations["public.utf8-plain-text"].flatMap { String(data: $0, encoding: .utf8) } ?? text]
    let data = try PropertyListSerialization.data(fromPropertyList: payload, format: .binary, options: 0)
    let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    let path = root.appendingPathComponent("payloads/\(hash)")
    let newPayload = !FileManager.default.fileExists(atPath: path.path)
    let config = try configuration()
    guard data.count <= (number(config["capBytes"])?.intValue ?? 1_073_741_824) else { throw ClipboardRepositoryError.full }
    if newPayload {
      try seal(data).write(to: path, options: .atomic)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
    }
    var thumbnailBytes = 0
    #if canImport(AppKit)
    if kind == "image", let image = ["public.png", "public.jpeg", "public.tiff"].compactMap({ representations[$0] }).first,
       let source = CGImageSourceCreateWithData(image as CFData, nil),
       let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 480, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary),
       let png = NSBitmapImageRep(cgImage: thumbnail).representation(using: .png, properties: [:]) {
      let thumbnailURL = root.appendingPathComponent("payloads/\(hash).thumb")
      try seal(png).write(to: thumbnailURL, options: .atomic)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: thumbnailURL.path)
      thumbnailBytes = png.count
    }
    #endif
    let id = UUID().uuidString
    let sourceJSON = String(data: try JSONSerialization.data(withJSONObject: source), encoding: .utf8)!
    do {
      try transaction {
        try execute("INSERT OR IGNORE INTO payloads(hash,bytes) VALUES(?,?)", [hash, data.count + thumbnailBytes])
        try execute("INSERT INTO clips(id,hash,kind,preview,preview_truncated,copied,source) VALUES(?,?,?,?,?,?,?)", [id, hash, kind, String(text.prefix(1500)), text.count > 1500 ? 1 : 0, now, sourceJSON])
        try execute("INSERT INTO clip_search(id,body) VALUES(?,?)", [id, text])
      }
      try prune(now: now)
      guard !(try rows("SELECT id FROM clips WHERE id=?", [id])).isEmpty else { throw ClipboardRepositoryError.full }
      if try usedBytes() > (number(config["capBytes"])?.doubleValue ?? 1_073_741_824) {
        try delete(ids: [id]); throw ClipboardRepositoryError.full
      }
      lastError = nil
      return id
    } catch { try? sweepOrphans(); lastError = "Clipboard storage could not retain this item. Pinned and queued items are protected."; throw error }
  }
  func page(text: String, kinds: [String], since: Double?, offset: Int) throws -> [String: Any] {
    guard text.count <= 1000, offset >= 0, offset <= 1_000_000, kinds.allSatisfy({ ["text", "url", "file", "image"].contains($0) }) else { throw ClipboardRepositoryError.invalidRequest }
    var clauses = ["1=1"], args: [Any] = []
    let tokens = text.components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
    if !tokens.isEmpty {
      clauses.append("c.id IN (SELECT id FROM clip_search WHERE clip_search MATCH ?)")
      args.append(tokens.map { "\"\($0.replacingOccurrences(of: "\"", with: "\"\""))\"*" }.joined(separator: " AND "))
    } else if !text.isEmpty {
      clauses.append("instr(c.preview,?)>0"); args.append(text)
    }
    if let since { clauses.append("c.copied>=?"); args.append(since) }
    if !kinds.isEmpty { clauses.append("c.kind IN (\(kinds.map { _ in "?" }.joined(separator: ",")))"); args.append(contentsOf: kinds) }
    let results = try rows("SELECT c.*, p.bytes FROM clips c JOIN payloads p ON p.hash=c.hash WHERE \(clauses.joined(separator: " AND ")) ORDER BY c.copied DESC,c.id DESC LIMIT 51 OFFSET ?", args + [offset])
    let items = try results.prefix(50).map { row -> [String: Any] in
      let preview = row["preview"] as? String ?? ""
      var item: [String: Any] = ["id": row["id"]!, "kind": row["kind"]!, "preview": preview, "previewTruncated": (row["preview_truncated"] as? Double ?? 0) != 0, "copiedAt": row["copied"]!, "byteSize": row["bytes"]!, "pinned": (row["pinned"] as? Double ?? 0) != 0, "available": true]
      if let raw = row["source"] as? String, let data = raw.data(using: .utf8), let source = try? JSONSerialization.jsonObject(with: data) as? [String: String], !source.isEmpty { item["sourceApp"] = source }
      if row["kind"] as? String == "image", let hash = row["hash"] as? String {
        let thumbnail = root.appendingPathComponent("payloads/\(hash).thumb")
        if let encrypted = try? Data(contentsOf: thumbnail), let png = try? unseal(encrypted), png.count <= 4_194_304 {
          item["thumbnailPath"] = "data:image/png;base64,\(png.base64EncodedString())"
        }
      }
      if row["kind"] as? String == "file", let id = row["id"] as? String {
        let payload = try read(id: id)
        let files = payload["files"] as? [String] ?? []
        item["path"] = files.first
        item["available"] = files.allSatisfy { FileManager.default.isReadableFile(atPath: $0) }
      }
      return item
    }
    return ["items": items, "hasMore": results.count > 50]
  }
  func read(id: String) throws -> [String: Any] {
    guard let hash = try rows("SELECT hash FROM clips WHERE id=?", [id]).first?["hash"] as? String else { throw ClipboardRepositoryError.missing }
    let data = try unseal(Data(contentsOf: root.appendingPathComponent("payloads/\(hash)")))
    guard let value = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else { throw ClipboardRepositoryError.persistence }
    return value
  }
  func pin(id: String, pinned: Bool) throws { try execute("UPDATE clips SET pinned=? WHERE id=?", [pinned ? 1 : 0, id]) }
  func delete(ids: [String]) throws {
    guard !ids.isEmpty else { return }
    var removedHashes = Set<String>()
    try transaction {
      for id in ids {
        if let hash = try rows("SELECT hash FROM clips WHERE id=?", [id]).first?["hash"] as? String { removedHashes.insert(hash) }
        try execute("DELETE FROM clip_search WHERE id=?", [id])
        try execute("DELETE FROM clips WHERE id=?", [id])
      }
      for hash in removedHashes {
        try execute("DELETE FROM payloads WHERE hash=? AND NOT EXISTS(SELECT 1 FROM clips WHERE hash=?)", [hash, hash])
      }
      if var queue = try metadata("queue") {
        let removed = Set(ids)
        if let itemIDs = queue["itemIds"] as? [String] { queue["itemIds"] = itemIDs.filter { !removed.contains($0) } }
        if let items = queue["items"] as? [[String: Any]] { queue["items"] = items.filter { item in
          guard let id = item["id"] as? String else { return false }
          return !removed.contains(id)
        } }
        try setMetadata("queue", queue)
      }
    }
    for hash in removedHashes where try rows("SELECT 1 FROM payloads WHERE hash=?", [hash]).isEmpty {
      for name in [hash, "\(hash).thumb"] {
        let url = root.appendingPathComponent("payloads/\(name)")
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
      }
    }
    try execute("PRAGMA incremental_vacuum")
  }
  func clear() throws {
    try transaction { try execute("DELETE FROM clips"); try execute("DELETE FROM clip_search"); try execute("DELETE FROM metadata WHERE key='queue'"); try setMetadata("capShortened", ["value": false]) }
    capShortened = false
    try sweepOrphans()
    try execute("VACUUM")
  }
  private func protectedIDs() throws -> Set<String> {
    Set(try metadata("queue")?["itemIds"] as? [String] ?? [])
  }
  func prune(now: Double) throws {
    let config = try configuration()
    let days = number(config["retentionDays"])?.doubleValue ?? 30
    let cap = number(config["capBytes"])?.doubleValue ?? 1_073_741_824
    let protected = try protectedIDs()
    let expired = try rows("SELECT id FROM clips WHERE pinned=0 AND copied<?", [now - days * 86_400_000])
      .compactMap { $0["id"] as? String }.filter { !protected.contains($0) }
    try delete(ids: expired)
    var bytes = try usedBytes()
    var shortenedNow = false
    if bytes > cap {
      for row in try rows("SELECT id FROM clips WHERE pinned=0 ORDER BY copied ASC,id ASC") {
        guard let id = row["id"] as? String, !protected.contains(id) else { continue }
        try delete(ids: [id]); shortenedNow = true
        bytes = try usedBytes()
        if bytes <= cap { break }
      }
    }
    capShortened = shortenedNow
    try setMetadata("capShortened", ["value": capShortened])
  }
  private func usedBytes() throws -> Double {
    let payload = try rows("SELECT COALESCE(SUM(bytes),0) AS bytes FROM payloads").first?["bytes"] as? Double ?? 0
    let index = (try? FileManager.default.attributesOfItem(atPath: root.appendingPathComponent("index.sqlite").path)[.size] as? NSNumber)?.doubleValue ?? 0
    return payload + index
  }
  private func sweepOrphans() throws {
    try execute("DELETE FROM payloads WHERE hash NOT IN (SELECT hash FROM clips)")
    let retained = Set(try rows("SELECT hash FROM payloads").compactMap { $0["hash"] as? String })
    for url in try FileManager.default.contentsOfDirectory(at: root.appendingPathComponent("payloads"), includingPropertiesForKeys: nil) where !retained.contains(url.deletingPathExtension().lastPathComponent) { try FileManager.default.removeItem(at: url) }
  }
  func status() throws -> [String: Any] {
    let config = try configuration(), now = Date().timeIntervalSince1970 * 1000
    let summary = try rows("SELECT COUNT(*) AS count,MIN(copied) AS oldest FROM clips").first ?? [:]
    var capture: [String: Any] = ["status": "capturing"]
    if config["enabled"] as? Bool != true { capture = ["status": "paused"] }
    else if config["private"] as? Bool == true { capture = ["status": "private"] }
    else if config["paused"] as? Bool == true, (config["pauseUntil"] as? Double ?? 0) == 0 || (config["pauseUntil"] as? Double ?? 0) > now { capture = ["status": "paused", "until": config["pauseUntil"] ?? 0] }
    if let error = lastError { capture = ["status": "error", "message": error] }
    let days = number(config["retentionDays"])?.doubleValue ?? 30
    return ["config": config, "capture": capture, "retention": ["retentionDays": days, "capBytes": config["capBytes"]!, "usedBytes": try usedBytes(), "itemCount": summary["count"] ?? 0, "effectiveDays": capShortened ? min(days, max(0, (now - (summary["oldest"] as? Double ?? now)) / 86_400_000)) : days], "queue": try metadata("queue") ?? [:], "storageProtection": "Encrypted local vault. No previous clipboard history is imported."]
  }
}

#if canImport(AppKit) && !CLIPBOARD_TEST
/// Main-thread pasteboard snapshots; database and payload work happen off the event loop.
final class ClipboardCapture {
  static let shared = ClipboardCapture()
  private var timer: Timer?
  private var changeCount = NSPasteboard.general.changeCount
  private var observer: NSObjectProtocol?
  private(set) var target: NSRunningApplication?
  var onChange: (() -> Void)?
  func start() {
    guard timer == nil else { return }
    target = NSWorkspace.shared.frontmostApplication
    observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
      if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication, app.processIdentifier != ProcessInfo.processInfo.processIdentifier { self?.target = app }
    }
    timer = Timer.scheduledTimer(withTimeInterval: 0.75, repeats: true) { [weak self] _ in self?.poll() }
  }
  func suppressOwnCopy() { changeCount = NSPasteboard.general.changeCount }
  private func poll() {
    let pasteboard = NSPasteboard.general
    guard pasteboard.changeCount != changeCount else { return }
    changeCount = pasteboard.changeCount
    let snapshotCount = changeCount
    let app = NSWorkspace.shared.frontmostApplication
    let bundle = app?.bundleIdentifier ?? ""
    let types = Set((pasteboard.types ?? []).map { $0.rawValue })
    let sensitive = !types.isDisjoint(with: ["org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType", "org.nspasteboard.AutoGeneratedType", "com.agilebits.onepassword"])
    // Do not read a password manager's content even when heuristic filtering is disabled.
    if sensitive { return }
    let now = Date().timeIntervalSince1970 * 1000
    let repository = ClipboardRepository.shared
    // Policy must be checked before reading any pasteboard payload.
    repository.work.async {
      do {
        try repository.open()
        guard try repository.captureAllowed(bundle: bundle, sensitive: sensitive, now: now) else { return }
        DispatchQueue.main.async {
          guard pasteboard.changeCount == snapshotCount else { return }
          var representations: [String: Data] = [:]
          let supported = ["public.utf8-plain-text", "public.rtf", "public.html", "public.png", "public.jpeg", "public.tiff"]
          for type in supported where types.contains(type) {
            if let data = pasteboard.data(forType: NSPasteboard.PasteboardType(type)), data.count <= 67_108_864 { representations[type] = data }
          }
          let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
          let files = urls.map { $0.path }
          let image = ["public.png", "public.jpeg", "public.tiff"].contains { representations[$0] != nil }
          let text = pasteboard.string(forType: .string) ?? ""
          let kind = !files.isEmpty ? "file" : image ? "image" : text.hasPrefix("https://") || text.hasPrefix("http://") ? "url" : "text"
          guard !representations.isEmpty || !files.isEmpty else { return }
          let preview = !files.isEmpty ? urls.map { $0.lastPathComponent }.joined(separator: "\n") : image ? "Image copied from \(app?.localizedName ?? "Unknown app")" : text
          repository.work.async {
            do {
              // Recheck privacy policy in case it changed while snapshotting.
              guard try repository.captureAllowed(bundle: bundle, sensitive: sensitive, now: now) else { return }
              try repository.insert(kind: kind, text: preview, representations: representations, files: files, source: ["name": app?.localizedName ?? "Unknown", "bundleId": bundle, "evidence": "inferred"], now: now)
              DispatchQueue.main.async { self.onChange?() }
            } catch { DispatchQueue.main.async { self.onChange?() } }
          }
        }
      } catch { DispatchQueue.main.async { self.onChange?() } }
    }
  }
  func deliver(payload: [String: Any], action: String, completion: @escaping ([String: Any]) -> Void) {
    let representations = payload["representations"] as? [String: Data] ?? [:]
    let files = payload["files"] as? [String] ?? []
    if !files.allSatisfy({ FileManager.default.isReadableFile(atPath: $0) }) { completion(["status": "failed", "message": "A referenced file is unavailable."]); return }
    let intended = target
    if action != "copy" {
      guard AXIsProcessTrusted() else { completion(["status": "failed", "message": "Accessibility permission is required to dispatch paste."]); return }
      guard let intended, !intended.isTerminated, intended.processIdentifier != ProcessInfo.processInfo.processIdentifier else { completion(["status": "focusChanged", "message": "No destination application is available."]); return }
      let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
      guard front == ProcessInfo.processInfo.processIdentifier || front == intended.processIdentifier else { completion(["status": "focusChanged", "message": "The destination changed. Reopen Bettercast from the intended app."]); return }
      PanelManager.shared.hideWindow()
      intended.activate(options: [])
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + (action == "copy" ? 0 : 0.15)) {
      if action != "copy", NSWorkspace.shared.frontmostApplication?.processIdentifier != intended?.processIdentifier { completion(["status": "focusChanged", "message": "Destination lost focus; nothing was pasted."]); return }
      let pasteboard = NSPasteboard.general
      pasteboard.clearContents()
      if action == "pastePlain" { pasteboard.setString(payload["text"] as? String ?? "", forType: .string) }
      else if !files.isEmpty { pasteboard.writeObjects(files.map { NSURL(fileURLWithPath: $0) }) }
      else { for (type, data) in representations { pasteboard.setData(data, forType: NSPasteboard.PasteboardType(type)) } }
      self.suppressOwnCopy()
      if action == "copy" { completion(["status": "copied"]); return }
      for down in [true, false] {
        let event = CGEvent(keyboardEventSource: nil, virtualKey: 0x09, keyDown: down)
        event?.flags = down ? .maskCommand : []
        event?.post(tap: .cghidEventTap)
      }
      completion(["status": "dispatched"])
    }
  }
}
#endif
