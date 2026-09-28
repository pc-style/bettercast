import Foundation
import Darwin

@main
struct AIProcessTests {
  static func main() {
    let executable = CommandLine.arguments[0]
    if CommandLine.arguments.last == "--claude-probe" {
      guard let claude = AIProcess.claudeExecutable() else { preconditionFailure("Claude CLI unavailable") }
      let done = DispatchSemaphore(value: 0)
      AIProcess().run(id: "probe", prompt: "Reply with exactly: BETTERCAST_AI_OK",
                      executable: claude, arguments: AIProcess.claudeArguments) { result in
        guard case .success(let output) = result,
              AIProcess.parseClaudeResponse(output) == "BETTERCAST_AI_OK" else {
          preconditionFailure("Claude bridge probe failed: \(result.map { _ in "unexpected output" })")
        }
        print("Claude bridge probe passed")
        done.signal()
      }
      precondition(done.wait(timeout: .now() + 125) == .success, "Claude bridge probe timed out")
      return
    }
    if CommandLine.arguments.count > 1 {
      switch CommandLine.arguments[1] {
      case "ignore-term":
        signal(SIGTERM, SIG_IGN)
        Thread.sleep(forTimeInterval: 10)
      case "burst":
        FileHandle.standardOutput.write(Data(repeating: 65, count: 900_000))
        FileHandle.standardError.write(Data(repeating: 66, count: 900_000))
        FileHandle.standardOutput.write(Data(repeating: 65, count: 900_000))
      case "stderr-burst":
        FileHandle.standardError.write(Data(repeating: 66, count: 1_800_000))
      case "quick":
        FileHandle.standardOutput.write(Data("quick reply".utf8))
      case "inherited-pipe":
        let descendant = Process()
        descendant.executableURL = URL(fileURLWithPath: "/bin/sleep")
        descendant.arguments = ["2"]
        descendant.standardOutput = FileHandle.standardOutput
        descendant.standardError = FileHandle.standardError
        try! descendant.run()
      default: preconditionFailure("unknown test fixture")
      }
      return
    }
    let bridge = AIProcess()
    precondition(AIProcess.parseClaudeResponse("{\"is_error\":false,\"result\":\"ok\"}") == "ok")
    precondition(AIProcess.parseClaudeResponse("{\"is_error\":true,\"result\":\"private\"}") == nil)
    precondition(AIProcess.parseClaudeResponse("not JSON") == nil)
    precondition(AIProcess.claudeStreamingArguments.suffix(3) == ["stream-json", "--verbose", "--include-partial-messages"])

    func check(_ id: String, prompt: String, executable: String, arguments: [String] = [],
               timeout: TimeInterval = 3, cancel: Bool = false,
               expect: Result<String, AIProcessError>) {
      let done = DispatchSemaphore(value: 0)
      bridge.run(id: id, prompt: prompt, executable: URL(fileURLWithPath: executable),
                 arguments: arguments, timeout: timeout) { result in
        switch (result, expect) {
        case (.success(let actual), .success(let expected)):
          precondition(actual == expected, "\(id): output mismatch")
        case (.failure(let actual), .failure(let expected)):
          precondition(actual == expected, "\(id): \(actual), expected \(expected)")
        default:
          preconditionFailure("\(id): unexpected result \(result)")
        }
        done.signal()
      }
      if cancel {
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { bridge.cancel(id) }
      }
      precondition(done.wait(timeout: .now() + 8) == .success, "\(id): completion timed out")
    }

    // Shell-looking text must be treated as data, not as an executable command.
    let prompt = "hello; touch /tmp/bettercast-ai-should-not-exist\nsecond line"
    check("stdin", prompt: prompt, executable: "/bin/cat", expect: .success(prompt))
    let streamed = DispatchSemaphore(value: 0)
    var chunks = Data()
    bridge.run(id: "stream", prompt: "x", executable: URL(fileURLWithPath: executable), arguments: ["quick"],
               onChunk: { chunks.append($0) }) { result in
      guard case .success("quick reply") = result else { preconditionFailure("stream run failed") }
      streamed.signal()
    }
    precondition(streamed.wait(timeout: .now() + 3) == .success)
    precondition(String(data: chunks, encoding: .utf8) == "quick reply", "chunks were duplicated or lost")
    check("exit", prompt: "x", executable: "/usr/bin/false", expect: .failure(.failed))
    for iteration in 0..<10 {
      check("early-exit-large-\(iteration)", prompt: String(repeating: "a", count: 127_000),
            executable: "/usr/bin/true", expect: .success(""))
    }
    check("cancel", prompt: "x", executable: "/bin/sleep", arguments: ["10"], cancel: true,
          expect: .failure(.cancelled))
    check("timeout", prompt: "x", executable: "/bin/sleep", arguments: ["10"], timeout: 0.1,
          expect: .failure(.timedOut))
    check("limit", prompt: "x", executable: "/usr/bin/yes", expect: .failure(.outputLimit))
    for iteration in 0..<20 {
      check("quick-\(iteration)", prompt: "x", executable: executable, arguments: ["quick"],
            expect: .success("quick reply"))
    }
    check("burst", prompt: "x", executable: executable, arguments: ["burst"],
          expect: .failure(.outputLimit))
    check("stderr-burst", prompt: "x", executable: executable, arguments: ["stderr-burst"],
          expect: .failure(.outputLimit))
    let gate = DispatchSemaphore(value: 0)
    let cancelled = DispatchSemaphore(value: 0)
    bridge.run(id: "cancel-before-start", prompt: "x", executable: URL(fileURLWithPath: executable),
               arguments: ["ignore-term"], beforeLaunch: { gate.wait() }) { result in
      guard case .failure(.cancelled) = result else { preconditionFailure("prelaunch cancel failed") }
      cancelled.signal()
    }
    bridge.cancel("cancel-before-start")
    gate.signal()
    precondition(cancelled.wait(timeout: .now() + 2) == .success)
    check("cancel-stubborn", prompt: "x", executable: executable, arguments: ["ignore-term"],
          cancel: true, expect: .failure(.cancelled))
    let start = Date()
    check("stubborn", prompt: "x", executable: executable, arguments: ["ignore-term"], timeout: 0.1,
          expect: .failure(.timedOut))
    precondition(Date().timeIntervalSince(start) < 2, "SIGKILL escalation failed")
    let pipeStart = Date()
    check("inherited-pipe", prompt: "x", executable: executable, arguments: ["inherited-pipe"],
          expect: .success(""))
    precondition(Date().timeIntervalSince(pipeStart) < 1, "pipe drain waited for descendant")

    func openFDCount() -> Int {
      return (try! FileManager.default.contentsOfDirectory(atPath: "/dev/fd")).count
    }
    let initialFDs = openFDCount()
    for iteration in 0..<50 {
      check("unavailable-\(iteration)", prompt: "x", executable: "/not/a/bettercast/executable",
            expect: .failure(.unavailable))
      let gate = DispatchSemaphore(value: 0)
      let done = DispatchSemaphore(value: 0)
      let id = "prelaunch-fd-\(iteration)"
      bridge.run(id: id, prompt: "x", executable: URL(fileURLWithPath: executable),
                 arguments: ["ignore-term"], beforeLaunch: { gate.wait() }) { result in
        guard case .failure(.cancelled) = result else { preconditionFailure("prelaunch cancel failed") }
        done.signal()
      }
      bridge.cancel(id)
      gate.signal()
      precondition(done.wait(timeout: .now() + 2) == .success)
    }
    precondition(openFDCount() <= initialFDs + 2, "unstarted AI runs leaked pipe descriptors")
    precondition(!FileManager.default.fileExists(atPath: "/tmp/bettercast-ai-should-not-exist"))
    // Give any asynchronous stdin writer time to observe EPIPE before the harness exits.
    Thread.sleep(forTimeInterval: 0.3)
    print("AI process tests passed")
  }
}
