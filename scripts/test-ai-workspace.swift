import Foundation
import Darwin

@main struct AIWorkspaceChecks {
  static func main() async throws {
    if CommandLine.arguments.count > 1 {
      if CommandLine.arguments[1] == "rpc" {
        FileHandle.standardError.write(Data(repeating: 69, count: 128_000))
        var requests = [[String: Any]]()
        while let line = readLine(), let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
          if object["id"] == nil { continue }
          requests.append(object)
          if requests.count == 2 {
            let responses = requests.reversed().map { request -> [String: Any] in
              ["jsonrpc": "2.0", "id": request["id"]!, "result": request["method"]!]
            }
            let lines: [[String: Any]] = [
              ["jsonrpc": "2.0", "method": "progress", "params": [:]],
            ] + responses
            let output = try! lines.map { String(data: try! JSONSerialization.data(withJSONObject: $0), encoding: .utf8)! }.joined(separator: "\n") + "\n"
            FileHandle.standardOutput.write(Data(output.utf8))
            requests.removeAll()
          }
        }
        return
      }
      if CommandLine.arguments[1] == "stubborn" {
        signal(SIGTERM, SIG_IGN); while true { Thread.sleep(forTimeInterval: 1) }
      }
    }
    let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try Data("bounded".utf8).write(to: temporary)
    defer { try? FileManager.default.removeItem(at: temporary) }

    let data = try await AIWorkspace.readAttachment(path: temporary.path, selectedPaths: [temporary.path], maxBytes: 64)
    precondition(String(data: data, encoding: .utf8) == "bounded")
    do { _ = try await AIWorkspace.readAttachment(path: temporary.path, selectedPaths: [], maxBytes: 64); fatalError("unapproved path accepted") }
    catch AIWorkspaceError.invalidRequest { }

    let key = Data(repeating: 7, count: 32), wrongKey = Data(repeating: 8, count: 32)
    let encrypted = try LocalVault.seal(Data("private".utf8), key: key)
    precondition(encrypted.range(of: Data("private".utf8)) == nil)
    let decrypted = try LocalVault.open(encrypted, key: key)
    precondition(decrypted == Data("private".utf8))
    do { _ = try LocalVault.open(encrypted, key: wrongKey); fatalError("wrong vault key accepted") } catch { }
    do { _ = try LocalVault.open(Data(encrypted.dropLast()), key: key); fatalError("corrupt vault accepted") } catch { }
    do { _ = try LocalVault.documentURL(id: "../bad", directory: temporary); fatalError("bad id accepted") } catch { }

    let vault = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: vault, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: vault) }
    let missing = try LocalVault.read(id: "absent", directory: vault)
    precondition(missing == nil)
    let document = try LocalVault.documentURL(id: "conversation-1", directory: vault)
    try encrypted.write(to: document)
    do { try LocalVault.delete(id: "../bad", directory: vault); fatalError("bad deletion id accepted") }
    catch AIWorkspaceError.invalidRequest { }
    precondition(FileManager.default.fileExists(atPath: document.path))
    try LocalVault.delete(id: "conversation-1", directory: vault)
    precondition(!FileManager.default.fileExists(atPath: document.path))
    try LocalVault.delete(id: "conversation-1", directory: vault)
    try encrypted.write(to: document)
    try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: vault.path)
    do {
      defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: vault.path) }
      do { try LocalVault.delete(id: "conversation-1", directory: vault); fatalError("inaccessible vault accepted") }
      catch { precondition((error as NSError).code != NSFileNoSuchFileError) }
      do { _ = try LocalVault.read(id: "conversation-1", directory: vault); fatalError("inaccessible vault read as absent") }
      catch { precondition((error as NSError).code != NSFileReadNoSuchFileError) }
    }
    precondition(FileManager.default.fileExists(atPath: document.path))

    let executable = URL(fileURLWithPath: CommandLine.arguments[0])
    try AIWorkspace.openStdioSession(id: "rpc", executable: executable, arguments: ["rpc"], maxOutputBytes: 512_000)
    defer { AIWorkspace.closeStdioSession(id: "rpc") }
    let notification = Data(#"{"jsonrpc":"2.0","method":"ready"}"#.utf8)
    let notified = try await AIWorkspace.stdioRequest(sessionID: "rpc", json: notification, timeout: 1)
    precondition(notified.isEmpty)
    let largeParameter = String(repeating: "x", count: 100_000)
    let firstRequest = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": 1, "method": "one", "params": [largeParameter]])
    let secondRequest = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": "two", "method": "two", "params": [largeParameter]])
    async let first = AIWorkspace.stdioRequest(sessionID: "rpc", json: firstRequest, timeout: 2)
    async let second = AIWorkspace.stdioRequest(sessionID: "rpc", json: secondRequest, timeout: 2)
    let responses = try await (first, second)
    let firstObject = try JSONSerialization.jsonObject(with: responses.0) as! [String: Any]
    let secondObject = try JSONSerialization.jsonObject(with: responses.1) as! [String: Any]
    precondition(firstObject["result"] as? String == "one")
    precondition(secondObject["result"] as? String == "two")

    try AIWorkspace.openStdioSession(id: "stubborn", executable: executable, arguments: ["stubborn"])
    let start = Date()
    do {
      _ = try await AIWorkspace.stdioRequest(sessionID: "stubborn", json: Data(#"{"jsonrpc":"2.0","id":9,"method":"hang"}"#.utf8), timeout: 0.1)
      fatalError("timeout accepted")
    } catch AIWorkspaceError.timeout { }
    precondition(Date().timeIntervalSince(start) < 2)
    AIWorkspace.closeStdioSession(id: "stubborn")
    print("AIWorkspace attachment, vault crypto, multiplexed stdio and timeout checks passed")
  }
}
