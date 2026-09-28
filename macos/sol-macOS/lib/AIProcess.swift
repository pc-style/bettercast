import Foundation
import Darwin

enum AIProcessError: String, Error {
  case invalidRequest = "AI_INVALID_REQUEST"
  case unavailable = "AI_UNAVAILABLE"
  case failed = "AI_FAILED"
  case cancelled = "AI_CANCELLED"
  case timedOut = "AI_TIMEOUT"
  case outputLimit = "AI_OUTPUT_LIMIT"
}

// Only Claude has a verified invocation that disables tools, hooks and project instructions.
final class AIProcess {
  static let shared = AIProcess()
  static let outputLimit = 1_048_576
  static let claudeArguments = [
    "-p", "--safe-mode", "--tools", "", "--strict-mcp-config",
    "--permission-prompts", "none", "--no-session-persistence", "--output-format", "json",
  ]
  // These flags are covered by synthetic invocation tests, not a live provider probe.
  static let claudeStreamingArguments = [
    "-p", "--safe-mode", "--tools", "", "--strict-mcp-config",
    "--permission-prompts", "none", "--no-session-persistence", "--output-format", "stream-json",
    "--verbose", "--include-partial-messages",
  ]
  private let lock = NSLock()
  private var active: [String: Run] = [:]

  private final class Run {
    let process = Process()
    var reason: AIProcessError?
  }

  static func claudeExecutable(path: String = ProcessInfo.processInfo.environment["PATH"] ?? "") -> URL? {
    let directories = path.split(separator: ":").map(String.init)
      + ["/opt/homebrew/bin", "/usr/local/bin", FileManager.default.homeDirectoryForCurrentUser.path + "/.local/bin"]
    for directory in directories where directory.hasPrefix("/") {
      let url = URL(fileURLWithPath: directory).appendingPathComponent("claude")
      if FileManager.default.isExecutableFile(atPath: url.path) { return url }
    }
    return nil
  }

  static func parseClaudeResponse(_ output: String) -> String? {
    guard let data = output.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          json["is_error"] as? Bool == false else { return nil }
    return json["result"] as? String
  }

  func cancel(_ id: String) {
    lock.lock()
    if let run = active[id] {
      stop(id: id, run: run, reason: .cancelled)
    }
    lock.unlock()
  }

  // Called with lock held. SIGTERM allows clean shutdown; SIGKILL bounds a stuck CLI.
  private func stop(id: String, run: Run, reason: AIProcessError) {
    guard run.reason == nil else { return }
    run.reason = reason
    if run.process.isRunning { run.process.terminate() }
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) {
      self.lock.lock()
      if self.active[id] === run && run.process.isRunning {
        Darwin.kill(run.process.processIdentifier, SIGKILL)
      }
      self.lock.unlock()
    }
  }

  func run(id: String, prompt: String, executable: URL, arguments: [String], timeout: TimeInterval = 120,
           currentDirectory: URL = FileManager.default.temporaryDirectory,
           onChunk: ((Data) -> Void)? = nil,
           beforeLaunch: (() -> Void)? = nil,
           completion: @escaping (Result<String, AIProcessError>) -> Void) {
    guard !id.isEmpty, !prompt.isEmpty, prompt.utf8.count <= 128_000 else {
      completion(.failure(.invalidRequest))
      return
    }
    let invocation = Run()
    lock.lock()
    guard active[id] == nil else {
      lock.unlock()
      completion(.failure(.invalidRequest))
      return
    }
    active[id] = invocation
    lock.unlock()

    DispatchQueue.global(qos: .userInitiated).async {
      beforeLaunch?()
      let process = invocation.process
      let input = Pipe()
      let output = Pipe()
      let errors = Pipe()
      process.executableURL = executable
      process.arguments = arguments
      process.currentDirectoryURL = currentDirectory
      process.standardInput = input
      process.standardOutput = output
      process.standardError = errors
      // Foundation's FileHandle.write can still raise SIGPIPE when a child exits early.
      _ = fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)

      let dataLock = NSLock()
      var stdout = Data()
      var stderrCount = 0
      var closed = false
      func collect(_ pipe: Pipe, isError: Bool) {
        let fd = pipe.fileHandleForReading.fileDescriptor
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        pipe.fileHandleForReading.readabilityHandler = { handle in
          dataLock.lock()
          guard !closed else {
            dataLock.unlock()
            return
          }
          var buffer = [UInt8](repeating: 0, count: 16_384)
          let count = Darwin.read(fd, &buffer, buffer.count)
          if count == 0 {
            handle.readabilityHandler = nil
            dataLock.unlock()
            return
          }
          if count < 0 {
            dataLock.unlock()  // EAGAIN is possible if another read drained the pipe.
            return
          }
          if isError { stderrCount = min(Self.outputLimit + 1, stderrCount + count) }
          else if stdout.count <= Self.outputLimit {
            stdout.append(contentsOf: buffer.prefix(min(count, Self.outputLimit + 1 - stdout.count)))
            onChunk?(Data(buffer.prefix(count)))
          }
          let exceeded = stdout.count > Self.outputLimit || stderrCount > Self.outputLimit
          dataLock.unlock()
          if exceeded {
            self.lock.lock()
            self.stop(id: id, run: invocation, reason: .outputLimit)
            self.lock.unlock()
          }
        }
      }
      collect(output, isError: false)
      collect(errors, isError: true)

      func closeUnstartedPipes() {
        dataLock.lock()
        closed = true
        output.fileHandleForReading.readabilityHandler = nil
        errors.fileHandleForReading.readabilityHandler = nil
        for handle in [input.fileHandleForReading, input.fileHandleForWriting,
                       output.fileHandleForReading, output.fileHandleForWriting,
                       errors.fileHandleForReading, errors.fileHandleForWriting] {
          try? handle.close()
        }
        dataLock.unlock()
      }

      // Serialize cancellation with launch. A cancellation before this lock wins
      // without starting; one after it sees a running process and schedules KILL.
      self.lock.lock()
      if invocation.reason != nil {
        self.lock.unlock()
        closeUnstartedPipes()
        self.finish(id: id, invocation: invocation, result: .failure(.cancelled), completion: completion)
        return
      }
      do {
        try process.run()
      } catch {
        self.lock.unlock()
        closeUnstartedPipes()
        self.finish(id: id, invocation: invocation, result: .failure(.unavailable), completion: completion)
        return
      }
      self.lock.unlock()
      try? output.fileHandleForWriting.close()
      try? errors.fileHandleForWriting.close()
      self.lock.lock()
      if invocation.reason != nil, process.isRunning { process.terminate() }
      self.lock.unlock()

      DispatchQueue.global().async {
        // A large prompt must not block the worker waiting for stdin capacity.
        try? input.fileHandleForWriting.write(contentsOf: Data(prompt.utf8))
        try? input.fileHandleForWriting.close()
      }
      DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
        self.lock.lock()
        if self.active[id] === invocation && invocation.reason == nil {
          self.stop(id: id, run: invocation, reason: .timedOut)
        }
        self.lock.unlock()
      }
      process.waitUntilExit()
      // Do not wait for pipe EOF: a descendant can inherit a write descriptor.
      dataLock.lock()
      closed = true
      output.fileHandleForReading.readabilityHandler = nil
      errors.fileHandleForReading.readabilityHandler = nil
      func drainAvailable(_ pipe: Pipe, isError: Bool) {
        let fd = pipe.fileHandleForReading.fileDescriptor
        var buffer = [UInt8](repeating: 0, count: 16_384)
        while stdout.count <= Self.outputLimit && stderrCount <= Self.outputLimit {
          let count = Darwin.read(fd, &buffer, buffer.count)
          if count <= 0 { break }  // EOF or EAGAIN (descendant still holds the pipe).
          if isError { stderrCount = min(Self.outputLimit + 1, stderrCount + count) }
          else {
            stdout.append(contentsOf: buffer.prefix(min(count, Self.outputLimit + 1 - stdout.count)))
            onChunk?(Data(buffer.prefix(count)))
          }
        }
      }
      drainAvailable(output, isError: false)
      drainAvailable(errors, isError: true)
      let response = stdout
      let exceeded = response.count > Self.outputLimit || stderrCount > Self.outputLimit
      try? output.fileHandleForReading.close()
      try? errors.fileHandleForReading.close()
      dataLock.unlock()
      self.lock.lock()
      let reason = invocation.reason
      self.lock.unlock()
      let result: Result<String, AIProcessError>
      if let reason = reason { result = .failure(reason) }
      else if exceeded { result = .failure(.outputLimit) }
      else if process.terminationStatus != 0 { result = .failure(.failed) }
      else if let text = String(data: response, encoding: .utf8) { result = .success(text) }
      else { result = .failure(.failed) }
      self.finish(id: id, invocation: invocation, result: result, completion: completion)
    }
  }

  private func finish(id: String, invocation: Run, result: Result<String, AIProcessError>,
                      completion: @escaping (Result<String, AIProcessError>) -> Void) {
    lock.lock()
    if active[id] === invocation { active.removeValue(forKey: id) }
    lock.unlock()
    completion(result)
  }
}
