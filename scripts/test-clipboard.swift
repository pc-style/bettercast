import Foundation

enum TestFailure: Error { case failed(String) }
func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
  if try !condition() { throw TestFailure.failed(message) }
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

    var repository: ClipboardRepository? = ClipboardRepository(directory: root, key: key)
    try repository!.open()
    try repository!.configure(["enabled": true, "paused": false, "retentionDays": NSNumber(value: 30), "capBytes": NSNumber(value: 1_073_741_824)])
    for index in 0..<10_000 {
      let kind = index % 100 < 70 ? "text" : index % 100 < 97 ? "image" : "file"
      let text = index % 997 == 0 ? "\(marker) nr \(index), punctuation!" : "Polish żółw item \(index)"
      let bytes = Data("exact:\(index):\(text)".utf8)
      let reps = kind == "image" ? ["public.png": bytes] : ["public.utf8-plain-text": bytes]
      let files = kind == "file" ? ["/tmp/missing-\(index)"] : []
      let id = try repository!.insert(kind: kind, text: text, representations: reps, files: files, now: 1_800_000_000_000 + Double(index))
      expected[id] = bytes; ids.append(id)
    }
    let duplicateA = try repository!.insert(kind: "text", text: "duplicate", representations: ["public.utf8-plain-text": Data("same".utf8)], now: 1_800_000_010_001)
    let duplicateB = try repository!.insert(kind: "text", text: "duplicate", representations: ["public.utf8-plain-text": Data("same".utf8)], now: 1_800_000_010_002)
    try expect(duplicateA != duplicateB, "duplicate occurrences were collapsed")
    let search = try repository!.page(text: "ZAŻÓŁĆ punctuation", kinds: [], since: 1_799_999_999_999, offset: 0)
    try expect(!(search["items"] as? [[String: Any]] ?? []).isEmpty, "FTS punctuation/diacritic query failed")
    let images = try repository!.page(text: "Polish", kinds: ["image"], since: nil, offset: 0)
    try expect((images["items"] as? [[String: Any]] ?? []).allSatisfy { $0["kind"] as? String == "image" }, "type filter failed")

    repository = nil
    repository = ClipboardRepository(directory: root, key: key); try repository!.open()
    for id in Swift.stride(from: 0, to: ids.count, by: 997).map({ ids[$0] }) {
      let payload = try repository!.read(id: id)
      let reps = payload["representations"] as! [String: Data]
      try expect(reps.values.first == expected[id], "restart changed original payload bytes")
    }
    try repository!.pin(id: ids[0], pinned: true)
    try repository!.setMetadata("queue", ["itemIds": [ids[1]], "items": [["id": ids[1], "preview": "secret preview"]], "position": 0])
    try repository!.prune(now: 1_900_000_000_000)
    _ = try repository!.read(id: ids[0]); _ = try repository!.read(id: ids[1])
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

    let clear = ClipboardRepository(directory: root, key: key); try clear.open(); try clear.clear()
    let payloads = root.appendingPathComponent("payloads")
    try expect((try fm.contentsOfDirectory(atPath: payloads.path)).isEmpty, "clear left orphan payloads")
    let elapsed = Date().timeIntervalSince(started)
    print("PASS: 10,000 mixed clipboard items; observed test runtime \(String(format: "%.2f", elapsed))s (test observation, not an app latency promise)")
  }
}
