import Foundation
import AppKit

enum TestFailure: Error { case failed(String) }
func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
  if try !condition() { throw TestFailure.failed(message) }
}

func syntheticImage(_ type: NSBitmapImageRep.FileType) throws -> Data {
  guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else {
    throw TestFailure.failed("could not create synthetic image")
  }
  bitmap.setColor(.systemRed, atX: 0, y: 0)
  bitmap.setColor(.systemGreen, atX: 1, y: 0)
  bitmap.setColor(.systemBlue, atX: 0, y: 1)
  bitmap.setColor(.white, atX: 1, y: 1)
  guard let data = bitmap.representation(using: type, properties: [:]) else {
    throw TestFailure.failed("could not encode synthetic image")
  }
  return data
}

@main struct ClipboardRepositoryTests {
  static func main() throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appendingPathComponent("bettercast-clipboard-\(UUID().uuidString)")
    defer { try? fm.removeItem(at: root) }
    let key = Data((0..<32).map(UInt8.init))
    let marker = "ZAŻÓŁĆ-GĘŚLĄ-UNIQUE-PAYLOAD"
    var expected: [String: Data] = [:]
    var ids: [String] = []
    let started = Date()
    let baseTimestamp = started.addingTimeInterval(-86_400).timeIntervalSince1970 * 1000
    let imageRepresentations = [
      "public.png": try syntheticImage(.png),
      "public.jpeg": try syntheticImage(.jpeg),
      "public.tiff": try syntheticImage(.tiff),
    ]

    var repository: ClipboardRepository? = ClipboardRepository(directory: root, key: key)
    try repository!.open()
    try repository!.configure(["enabled": true, "paused": false, "retentionDays": NSNumber(value: 30), "capBytes": NSNumber(value: 1_073_741_824)])
    for index in 0..<10_000 {
      let kind = index % 100 < 70 ? "text" : index % 100 < 97 ? "image" : "file"
      let text = index % 997 == 0 ? "\(marker) nr \(index), punctuation!" : "Polish żółw item \(index)"
      let bytes = Data("exact:\(index):\(text)".utf8)
      let imageType = ["public.png", "public.jpeg", "public.tiff"][index % 3]
      let reps = kind == "image" ? [imageType: imageRepresentations[imageType]!] : ["public.utf8-plain-text": bytes]
      let files = kind == "file" ? ["/tmp/missing-\(index)"] : []
      let id = try repository!.insert(kind: kind, text: text, representations: reps, files: files, now: baseTimestamp + Double(index))
      expected[id] = reps.values.first!; ids.append(id)
    }
    let duplicateA = try repository!.insert(kind: "text", text: "duplicate", representations: ["public.utf8-plain-text": Data("same".utf8)], now: baseTimestamp + 10_001)
    let duplicateB = try repository!.insert(kind: "text", text: "duplicate", representations: ["public.utf8-plain-text": Data("same".utf8)], now: baseTimestamp + 10_002)
    try expect(duplicateA != duplicateB, "duplicate occurrences were collapsed")
    let search = try repository!.page(text: "ZAŻÓŁĆ punctuation", kinds: [], since: baseTimestamp - 1, offset: 0)
    try expect(!(search["items"] as? [[String: Any]] ?? []).isEmpty, "FTS punctuation/diacritic query failed")
    let images = try repository!.page(text: "Polish", kinds: ["image"], since: nil, offset: 0)
    try expect((images["items"] as? [[String: Any]] ?? []).allSatisfy { $0["kind"] as? String == "image" }, "type filter failed")
    let thumbnails = (images["items"] as? [[String: Any]] ?? []).compactMap { $0["thumbnailPath"] as? String }
    try expect(!thumbnails.isEmpty && thumbnails.allSatisfy { $0.hasPrefix("data:image/png;base64,") }, "real image thumbnail generation failed")

    repository = nil
    repository = ClipboardRepository(directory: root, key: key); try repository!.open()
    for id in Swift.stride(from: 0, to: ids.count, by: 997).map({ ids[$0] }) {
      let payload = try repository!.read(id: id)
      let reps = payload["representations"] as! [String: Data]
      try expect(reps.values.first == expected[id], "restart changed original payload bytes")
    }
    try repository!.pin(id: ids[0], pinned: true)
    try repository!.setMetadata("queue", ["itemIds": [ids[1]], "items": [["id": ids[1], "preview": "secret preview"]], "position": 0])
    try repository!.prune(now: started.addingTimeInterval(40 * 86_400).timeIntervalSince1970 * 1000)
    _ = try repository!.read(id: ids[0]); _ = try repository!.read(id: ids[1])
    do { _ = try repository!.read(id: ids[2]); throw TestFailure.failed("expired unprotected item retained") }
    catch ClipboardRepositoryError.missing { }
    try repository!.delete(ids: [ids[1]])
    try expect((try repository!.metadata("queue")?["items"] as? [[String: Any]])?.isEmpty == true, "deleted queue preview retained")

    repository = nil
    do { let wrong = ClipboardRepository(directory: root, key: Data(repeating: 9, count: 32)); try wrong.open(); throw TestFailure.failed("wrong key opened vault") }
    catch ClipboardRepositoryError.database { }
    let diskFiles = try fm.subpathsOfDirectory(atPath: root.path).map { root.appendingPathComponent($0) }
    for file in diskFiles where !(try file.resourceValues(forKeys: [.isDirectoryKey]).isDirectory ?? false) {
      let bytes = try Data(contentsOf: file)
      try expect(bytes.range(of: Data(marker.utf8)) == nil, "plaintext marker found in \(file.lastPathComponent)")
    }

    let capRoot = fm.temporaryDirectory.appendingPathComponent("bettercast-clipboard-cap-\(UUID().uuidString)")
    defer { try? fm.removeItem(at: capRoot) }
    let capped = ClipboardRepository(directory: capRoot, key: key)
    try capped.open()
    try capped.configure(["enabled": true, "paused": false, "retentionDays": NSNumber(value: 30), "capBytes": NSNumber(value: 1_048_576)])
    let capBytes = Data((0..<600_000).map { UInt8($0 % 251) })
    let evicted = try capped.insert(kind: "text", text: "old", representations: ["public.utf8-plain-text": capBytes], now: baseTimestamp)
    let retained = try capped.insert(kind: "text", text: "new", representations: ["public.utf8-plain-text": Data(capBytes.reversed())], now: baseTimestamp + 1)
    _ = try capped.read(id: retained)
    do { _ = try capped.read(id: evicted); throw TestFailure.failed("cap did not evict oldest unprotected item") }
    catch ClipboardRepositoryError.missing { }

    try capped.setMetadata("queue", ["itemIds": ["before", retained, "after"], "items": [["id": "before"], ["id": retained, "preview": "must be removed"], ["id": "after"]], "position": 2, "reversed": true])
    try capped.delete(ids: [retained])
    let savedQueue = try capped.metadata("queue")!
    try expect((savedQueue["itemIds"] as? [String]) == ["before", "after"], "deleted queue item ID retained")
    try expect((savedQueue["position"] as? NSNumber)?.intValue == 1, "deletion skipped next reversed queue item")
    try expect((savedQueue["state"] as? [String: Any])?["status"] as? String == "interrupted", "queue deletion did not interrupt delivery")

    let clear = ClipboardRepository(directory: root, key: key); try clear.open(); try clear.clear()
    let payloads = root.appendingPathComponent("payloads")
    try expect((try fm.contentsOfDirectory(atPath: payloads.path)).isEmpty, "clear left orphan payloads")
    let elapsed = Date().timeIntervalSince(started)
    print("PASS: 10,000 mixed clipboard items; observed test runtime \(String(format: "%.2f", elapsed))s (test observation, not an app latency promise)")
  }
}
