import Foundation
import CryptoKit
import Darwin
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(Security)
import Security
#endif

enum AIWorkspaceError: Error, Equatable {
  case invalidRequest(String), unsupported(String), limitExceeded(String)
  case unapprovedEndpoint, missingAPIKey, timeout, cancelled
  case processFailed(String), protocolError(String), keychain(Int32)
}

struct AIHTTPConfiguration {
  let endpoint: URL
  let approvedEndpoints: Set<URL>
  let headers: [String: String]
  let keychainAccount: String?
  let timeout: TimeInterval

  init(endpoint: URL, approvedEndpoints: Set<URL>, headers: [String: String] = [:],
       keychainAccount: String? = nil, timeout: TimeInterval = 30) {
    self.endpoint = endpoint; self.approvedEndpoints = approvedEndpoints; self.headers = headers
    self.keychainAccount = keychainAccount; self.timeout = timeout
  }
}

/// Native primitives only. Policy (provider capabilities and per-tool approval) remains in ai-engine.ts.
final class AIWorkspace: @unchecked Sendable {
  static let shared = AIWorkspace()
  static let keychainService = "com.pcstyle.bettercast.ai"
  private let lock = NSLock()
  private var requests: [String: URLSessionDataTask] = [:]
  private var sessions: [String: StdioSession] = [:]

  private init() {}

  // API keys are write-only through this API except while constructing an authorized request.
  static func storeAPIKey(_ key: String, account: String) throws {
    guard !key.isEmpty, !account.isEmpty else { throw AIWorkspaceError.invalidRequest("Empty key or account") }
    #if canImport(Security)
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: keychainService, kSecAttrAccount as String: account]
    SecItemDelete(query as CFDictionary)
    var item = query; item[kSecValueData as String] = Data(key.utf8)
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(item as CFDictionary, nil)
    guard status == errSecSuccess else { throw AIWorkspaceError.keychain(status) }
    #else
    throw AIWorkspaceError.unsupported("Security framework unavailable")
    #endif
  }

  static func deleteAPIKey(account: String) throws {
    #if canImport(Security)
    let status = SecItemDelete([kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: keychainService, kSecAttrAccount as String: account] as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw AIWorkspaceError.keychain(status) }
    #else
    throw AIWorkspaceError.unsupported("Security framework unavailable")
    #endif
  }

  private static func apiKey(account: String) throws -> String {
    #if canImport(Security)
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: keychainService, kSecAttrAccount as String: account,
      kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var value: CFTypeRef?; let status = SecItemCopyMatching(query as CFDictionary, &value)
    guard status == errSecSuccess, let data = value as? Data, let key = String(data: data, encoding: .utf8) else {
      if status == errSecItemNotFound { throw AIWorkspaceError.missingAPIKey }
      throw AIWorkspaceError.keychain(status)
    }
    return key
    #else
    throw AIWorkspaceError.unsupported("Security framework unavailable")
    #endif
  }

  /// Streams raw response bytes. Callers parse the configured provider's advertised protocol.
  func streamHTTP(id: String, configuration: AIHTTPConfiguration, body: Data, onResponse: ((Int, [String: String]) -> Void)? = nil) -> AsyncThrowingStream<Data, Error> {
    AsyncThrowingStream { continuation in
      guard configuration.approvedEndpoints.contains(configuration.endpoint),
            ["https", "http"].contains(configuration.endpoint.scheme?.lowercased() ?? ""),
            configuration.endpoint.user == nil, configuration.endpoint.password == nil,
            configuration.endpoint.fragment == nil else {
        continuation.finish(throwing: AIWorkspaceError.unapprovedEndpoint); return
      }
      guard body.count <= 16 * 1024 * 1024 else {
        continuation.finish(throwing: AIWorkspaceError.limitExceeded("HTTP body too large")); return
      }
      if configuration.endpoint.scheme?.lowercased() == "http",
         !["localhost", "127.0.0.1", "::1"].contains(configuration.endpoint.host?.lowercased() ?? "") {
        continuation.finish(throwing: AIWorkspaceError.unapprovedEndpoint); return
      }
      do {
        var request = URLRequest(url: configuration.endpoint, timeoutInterval: configuration.timeout)
        request.httpMethod = "POST"; request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        for (name, value) in configuration.headers { request.setValue(value, forHTTPHeaderField: name) }
        if let account = configuration.keychainAccount {
          request.setValue("Bearer \(try Self.apiKey(account: account))", forHTTPHeaderField: "Authorization")
        }
        let token = UUID()
        let delegate = StreamDelegate(limit: 16 * 1024 * 1024, endpoint: configuration.endpoint,
                                      continuation: continuation, onResponse: onResponse) { [weak self] in self?.removeRequest(id, token: token) }
        let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
        let task = session.dataTask(with: request); delegate.retain(session: session)
        lock.lock()
        guard requests[id] == nil else {
          lock.unlock(); session.invalidateAndCancel()
          continuation.finish(throwing: AIWorkspaceError.invalidRequest("Duplicate active HTTP request id")); return
        }
        requests[id] = task; requestTokens[id] = token; lock.unlock(); task.resume()
        continuation.onTermination = { [weak self] _ in self?.cancel(id: id) }
      } catch { continuation.finish(throwing: error) }
    }
  }

  static func streamHTTP(id: String, configuration: AIHTTPConfiguration, body: Data, onResponse: ((Int, [String: String]) -> Void)? = nil) -> AsyncThrowingStream<Data, Error> {
    shared.streamHTTP(id: id, configuration: configuration, body: body, onResponse: onResponse)
  }

  func cancel(id: String) { lock.lock(); let task = requests.removeValue(forKey: id); requestTokens.removeValue(forKey: id); lock.unlock(); task?.cancel() }
  static func cancel(id: String) { shared.cancel(id: id) }
  private var requestTokens: [String: UUID] = [:]
  private func removeRequest(_ id: String, token: UUID) {
    lock.lock(); if requestTokens[id] == token { requests.removeValue(forKey: id); requestTokens.removeValue(forKey: id) }; lock.unlock()
  }

  /// Reads only a path present in the picker-produced allowlist, with a hard byte bound.
  static func readAttachment(path: String, selectedPaths: Set<String>, maxBytes: Int) async throws -> Data {
    guard maxBytes > 0 else { throw AIWorkspaceError.invalidRequest("Invalid attachment limit") }
    let url = URL(fileURLWithPath: path).standardizedFileURL
    let approved = Set(selectedPaths.map { URL(fileURLWithPath: $0).standardizedFileURL.path })
    guard approved.contains(url.path) else { throw AIWorkspaceError.invalidRequest("Path was not selected") }
    return try await Task.detached {
      #if os(macOS)
      let scoped = url.startAccessingSecurityScopedResource(); defer { if scoped { url.stopAccessingSecurityScopedResource() } }
      #endif
      let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
      let data = try handle.read(upToCount: maxBytes + 1) ?? Data()
      guard data.count <= maxBytes else { throw AIWorkspaceError.limitExceeded("Attachment too large") }
      return data
    }.value
  }

  /// Starts an executable directly with an argument vector. No shell is involved.
  func openStdioSession(id: String, executable: URL, arguments: [String], maxOutputBytes: Int = 4 * 1024 * 1024) throws {
    guard executable.isFileURL, executable.path.hasPrefix("/"), maxOutputBytes > 0 else { throw AIWorkspaceError.invalidRequest("Invalid stdio configuration") }
    let session = try StdioSession(executable: executable, arguments: arguments, maxOutputBytes: maxOutputBytes)
    lock.lock(); let old = sessions.updateValue(session, forKey: id); lock.unlock(); old?.close()
  }

  func stdioRequest(sessionID: String, json: Data, timeout: TimeInterval = 30) async throws -> Data {
    guard timeout > 0, json.count <= 1024 * 1024, (try? JSONSerialization.jsonObject(with: json)) != nil else { throw AIWorkspaceError.invalidRequest("Invalid JSON-RPC request") }
    lock.lock(); let session = sessions[sessionID]; lock.unlock()
    guard let session else { throw AIWorkspaceError.invalidRequest("Unknown stdio session") }
    return try await session.request(json: json, timeout: timeout)
  }

  func closeStdioSession(id: String) { lock.lock(); let session = sessions.removeValue(forKey: id); lock.unlock(); session?.close() }
  static func openStdioSession(id: String, executable: URL, arguments: [String], maxOutputBytes: Int = 4 * 1024 * 1024) throws { try shared.openStdioSession(id: id, executable: executable, arguments: arguments, maxOutputBytes: maxOutputBytes) }
  static func stdioRequest(sessionID: String, json: Data, timeout: TimeInterval = 30) async throws -> Data { try await shared.stdioRequest(sessionID: sessionID, json: json, timeout: timeout) }
  static func closeStdioSession(id: String) { shared.closeStdioSession(id: id) }
}

enum LocalVault {
  static let service = "com.pcstyle.bettercast.vault"
  private static let account = "master-key-v1"
  private static let keyLock = NSLock()
  private static let maxDocumentBytes = 32 * 1024 * 1024

  static func key() throws -> Data {
    keyLock.lock(); defer { keyLock.unlock() }
    #if canImport(Security)
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service, kSecAttrAccount as String: account,
      kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecSuccess, let data = result as? Data, data.count == 32 { return data }
    guard status == errSecItemNotFound else { throw AIWorkspaceError.keychain(status) }
    let directory = vaultDirectory()
    if let entries = try? FileManager.default.contentsOfDirectory(atPath: directory.path), !entries.isEmpty {
      throw AIWorkspaceError.protocolError("Vault key is missing")
    }
    var data = Data(count: 32)
    let randomStatus = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
    guard randomStatus == errSecSuccess else { throw AIWorkspaceError.keychain(randomStatus) }
    let item: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service, kSecAttrAccount as String: account,
      kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
    let addStatus = SecItemAdd(item as CFDictionary, nil)
    guard addStatus == errSecSuccess else { throw AIWorkspaceError.keychain(addStatus) }
    return data
    #else
    throw AIWorkspaceError.unsupported("Security framework unavailable")
    #endif
  }

  static func read(id: String) throws -> String? {
    let url = try documentURL(id: id, directory: vaultDirectory())
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    let encrypted = try Data(contentsOf: url, options: .mappedIfSafe)
    guard encrypted.count <= maxDocumentBytes + 64 else { throw AIWorkspaceError.limitExceeded("Vault document too large") }
    let clear = try open(encrypted, key: key())
    guard let text = String(data: clear, encoding: .utf8) else { throw AIWorkspaceError.protocolError("Invalid vault document") }
    return text
  }

  static func write(id: String, text: String) throws {
    let clear = Data(text.utf8)
    guard clear.count <= maxDocumentBytes else { throw AIWorkspaceError.limitExceeded("Vault document too large") }
    let directory = vaultDirectory(), url = try documentURL(id: id, directory: directory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                            attributes: [.posixPermissions: 0o700])
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    try seal(clear, key: key()).write(to: url, options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }

  static func delete(id: String, directory: URL = vaultDirectory()) throws {
    let url = try documentURL(id: id, directory: directory)
    if FileManager.default.fileExists(atPath: url.path) {
      try FileManager.default.removeItem(at: url)
    }
  }

  static func vaultDirectory(base: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
    base.appendingPathComponent(".config/bettercast/vault-v1", isDirectory: true)
  }
  static func documentURL(id: String, directory: URL) throws -> URL {
    guard id.count <= 100, !id.isEmpty,
          id.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else {
      throw AIWorkspaceError.invalidRequest("Invalid vault id")
    }
    return directory.appendingPathComponent(id, isDirectory: false)
  }
  static func seal(_ clear: Data, key: Data) throws -> Data {
    guard key.count == 32 else { throw AIWorkspaceError.invalidRequest("Invalid vault key") }
    let box = try AES.GCM.seal(clear, using: SymmetricKey(data: key))
    guard let combined = box.combined else { throw AIWorkspaceError.protocolError("Encryption failed") }
    return combined
  }
  static func open(_ encrypted: Data, key: Data) throws -> Data {
    guard key.count == 32 else { throw AIWorkspaceError.invalidRequest("Invalid vault key") }
    return try AES.GCM.open(AES.GCM.SealedBox(combined: encrypted), using: SymmetricKey(data: key))
  }
}

private final class StreamDelegate: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate, @unchecked Sendable {
  private let limit: Int; private var count = 0; private let continuation: AsyncThrowingStream<Data, Error>.Continuation
  private let endpoint: URL; private let finished: () -> Void; private var session: URLSession?
  private var terminalError: Error?
  private let onResponse: ((Int, [String: String]) -> Void)?
  init(limit: Int, endpoint: URL, continuation: AsyncThrowingStream<Data, Error>.Continuation, onResponse: ((Int, [String: String]) -> Void)?, finished: @escaping () -> Void) {
    self.limit = limit; self.endpoint = endpoint; self.continuation = continuation; self.finished = finished; self.onResponse = onResponse
  }
  func retain(session: URLSession) { self.session = session }
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    terminalError = AIWorkspaceError.unapprovedEndpoint
    completionHandler(nil)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    if let http = response as? HTTPURLResponse {
      var headers: [String: String] = [:]
      for (key, value) in http.allHeaderFields { headers[String(describing: key).lowercased()] = String(describing: value) }
      onResponse?(http.statusCode, headers)
    }
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      terminalError = AIWorkspaceError.protocolError("HTTP response rejected")
      completionHandler(.cancel); return
    }
    completionHandler(.allow)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard terminalError == nil else { return }
    count += data.count
    if count > limit { terminalError = AIWorkspaceError.limitExceeded("HTTP output too large"); dataTask.cancel() }
    else { continuation.yield(data) }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    finished(); self.session?.finishTasksAndInvalidate()
    if let terminalError { continuation.finish(throwing: terminalError) }
    else if let error { continuation.finish(throwing: (error as NSError).code == NSURLErrorCancelled ? AIWorkspaceError.cancelled : error) }
    else { continuation.finish() }
  }
}

private final class StdioSession: @unchecked Sendable {
  private struct Pending { let continuation: CheckedContinuation<Data, Error>; let timer: DispatchSourceTimer }
  private let process = Process(), input = Pipe(), output = Pipe(), error = Pipe(), maxOutputBytes: Int
  private let queue = DispatchQueue(label: "bettercast.ai.stdio")
  private let writeQueue = DispatchQueue(label: "bettercast.ai.stdio.write")
  private var buffer = Data(), pending: [String: Pending] = [:], closed = false
  private var ignoredNotificationBytes = 0, stderrBytes = 0
  init(executable: URL, arguments: [String], maxOutputBytes: Int) throws {
    self.maxOutputBytes = maxOutputBytes; process.executableURL = executable; process.arguments = arguments
    process.standardInput = input; process.standardOutput = output; process.standardError = error
    guard fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) == 0 else {
      throw AIWorkspaceError.processFailed("Could not protect stdin pipe")
    }
    try process.run()
    try? output.fileHandleForWriting.close(); try? error.fileHandleForWriting.close()
    output.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      self?.queue.async { self?.consume(data) }
    }
    error.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      self?.queue.async { self?.consumeError(data) }
    }
    process.terminationHandler = { [weak self] _ in self?.queue.async { self?.failAll(AIWorkspaceError.processFailed("Process exited")) } }
  }
  func request(json: Data, timeout: TimeInterval) async throws -> Data {
    try await withTaskCancellationHandler(operation: {
      try await withCheckedThrowingContinuation { continuation in
        queue.async { [weak self] in
          guard let self, !self.closed, self.process.isRunning else { continuation.resume(throwing: AIWorkspaceError.processFailed("Process is not running")); return }
          guard let object = try? JSONSerialization.jsonObject(with: json) as? [String: Any] else { continuation.resume(throwing: AIWorkspaceError.invalidRequest("Invalid JSON-RPC request")); return }
          let requestID = Self.idKey(object["id"])
          if requestID == nil { // JSON-RPC notification: it has no response.
            self.write(json, completion: continuation); return
          }
          guard self.pending[requestID!] == nil else { continuation.resume(throwing: AIWorkspaceError.invalidRequest("Duplicate JSON-RPC id")); return }
          let timer = DispatchSource.makeTimerSource(queue: self.queue)
          timer.schedule(deadline: .now() + timeout)
          timer.setEventHandler { [weak self] in self?.failAndClose(AIWorkspaceError.timeout) }
          self.pending[requestID!] = Pending(continuation: continuation, timer: timer); timer.resume()
          self.write(json, completion: nil)
        }
      }
    }, onCancel: { self.close() })
  }
  private static func idKey(_ value: Any?) -> String? {
    guard let value, !(value is NSNull) else { return nil }
    if let string = value as? String { return "s:\(string)" }
    if let number = value as? NSNumber { return "n:\(number.stringValue)" }
    return nil
  }
  private func write(_ json: Data, completion: CheckedContinuation<Data, Error>?) {
    var line = json; line.append(0x0A)
    writeQueue.async { [weak self] in
      guard let self else {
        completion?.resume(throwing: AIWorkspaceError.processFailed("Session closed")); return
      }
      do {
        try self.input.fileHandleForWriting.write(contentsOf: line)
        completion?.resume(returning: Data())
      } catch {
        // Request continuations are owned by pending/failAll. Only notifications
        // carry their continuation into this write operation.
        self.queue.async { self.failAndClose(AIWorkspaceError.processFailed("stdin closed")) }
        completion?.resume(throwing: AIWorkspaceError.processFailed("stdin closed"))
      }
    }
  }
  private func consume(_ chunk: Data) {
    guard !closed else { return }
    if chunk.isEmpty { failAndClose(AIWorkspaceError.processFailed("Process closed stdout")); return }
    buffer.append(chunk)
    if buffer.count > maxOutputBytes { failAndClose(AIWorkspaceError.limitExceeded("stdio output too large")); return }
    while let newline = buffer.firstIndex(of: 0x0A) {
      let line = Data(buffer[..<newline]); buffer.removeSubrange(...newline)
      guard !line.isEmpty, let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { failAndClose(AIWorkspaceError.protocolError("Invalid NDJSON")); return }
      if object["method"] != nil, object["id"] != nil {
        // Never execute a server request. Return JSON-RPC method-not-found.
        let reply: [String: Any] = ["jsonrpc": "2.0", "id": object["id"]!, "error": ["code": -32601, "message": "Client methods unsupported"]]
        if let data = try? JSONSerialization.data(withJSONObject: reply) { write(data, completion: nil) }
      } else if let key = Self.idKey(object["id"]), let item = pending.removeValue(forKey: key) {
        item.timer.cancel(); item.continuation.resume(returning: line)
      } else {
        ignoredNotificationBytes += line.count
        if ignoredNotificationBytes > maxOutputBytes { failAndClose(AIWorkspaceError.limitExceeded("stdio notifications too large")); return }
      }
    }
  }
  private func consumeError(_ chunk: Data) {
    if chunk.isEmpty { error.fileHandleForReading.readabilityHandler = nil; return }
    stderrBytes += chunk.count
    if stderrBytes > maxOutputBytes { failAndClose(AIWorkspaceError.limitExceeded("stdio stderr too large")) }
  }
  private func failAll(_ error: Error) {
    guard !closed else { return }; closed = true
    output.fileHandleForReading.readabilityHandler = nil; self.error.fileHandleForReading.readabilityHandler = nil
    let values = pending.values; pending.removeAll()
    for item in values { item.timer.cancel(); item.continuation.resume(throwing: error) }
  }
  private func failAndClose(_ error: Error) { failAll(error); terminate() }
  func close() { queue.async { self.failAndClose(AIWorkspaceError.cancelled) } }
  private func terminate() {
    try? input.fileHandleForWriting.close()
    guard process.isRunning else { return }; process.terminate()
    let pid = process.processIdentifier
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { if self.process.isRunning { Darwin.kill(pid, SIGKILL) } }
  }
  deinit { terminate() }
}
