// `ai --request <path> [--timeout <sec>]`: run one question through the
// chosen provider and stream the answer as `chunk <b64>` lines, then `done`.
//
// CLI providers run noninteractively, without tools (claude) or read-only
// (codex sandbox, gemini plan mode, opencode plan agent), in an empty
// working directory, with no session persistence where the CLI supports it.
// Flags were checked against each CLI's --help (claude 2.x, codex exec,
// gemini, opencode run); never by running a real prompt on the dev Mac.

import Foundation
import UniformTypeIdentifiers

let maxChunkBytes = 2048
let defaultAITimeout: TimeInterval = 300
let defaultAnthropicModel = "claude-opus-5-5"

// MARK: - Output

final class AnswerSink {
    private let lock = NSLock()
    private(set) var emittedBytes = 0

    func text(_ s: String) {
        guard !s.isEmpty else { return }
        lock.lock()
        defer { lock.unlock() }
        let data = Data(s.utf8)
        for piece in utf8Chunks(data, size: maxChunkBytes) {
            Out.line(["chunk", b64(piece)])
        }
        emittedBytes += data.count
    }
}

// MARK: - Attachments

struct Attachment {
    let path: String
    let data: Data
    let isImage: Bool
    let mediaType: String
}

func mediaType(of data: Data, path: String) -> String {
    let b = [UInt8](data.prefix(12))
    if b.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "image/png" }
    if b.starts(with: [0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
    if b.starts(with: [0x47, 0x49, 0x46, 0x38]) { return "image/gif" }
    if b.count >= 12 && b[0...3] == [0x52, 0x49, 0x46, 0x46] && b[8...11] == [0x57, 0x45, 0x42, 0x50] { return "image/webp" }
    if b.starts(with: [0x25, 0x50, 0x44, 0x46]) { return "application/pdf" }
    if let t = UTType(filenameExtension: (path as NSString).pathExtension) {
        if t.conforms(to: .image) { return t.preferredMIMEType ?? "image/unknown" }
        if let m = t.preferredMIMEType { return m }
    }
    return "application/octet-stream"
}

func loadAttachments(_ paths: [String]) throws -> [Attachment] {
    try paths.map { p in
        guard let data = FileManager.default.contents(atPath: p) else {
            throw SpecError.bad("attachment not readable: \(p)")
        }
        let mt = mediaType(of: data, path: p)
        return Attachment(path: p, data: data, isImage: mt.hasPrefix("image/"), mediaType: mt)
    }
}

/// An image the Messages API accepts inline (png/jpeg/gif/webp, <= ~3.7 MB
/// raw so base64 stays under 5 MB); larger or other formats are downscaled
/// to PNG.
func apiImage(_ a: Attachment) throws -> (mediaType: String, data: Data) {
    let accepted = ["image/png", "image/jpeg", "image/gif", "image/webp"]
    let limit = 3_700_000
    if accepted.contains(a.mediaType) && a.data.count <= limit { return (a.mediaType, a.data) }
    for side in [2000, 1400, 1000, 700] {
        let t = try thumbnailPNG(a.data, maxSide: side)
        if t.png.count <= limit { return ("image/png", t.png) }
    }
    throw SpecError.bad("image too large to attach: \(a.path)")
}

/// Messages-API content blocks: images and PDFs inline, UTF-8 text files
/// inlined (<= 256 KiB each), other files named only; the prompt last.
func contentBlocks(prompt: String, attachments: [Attachment]) throws -> [[String: Any]] {
    var blocks: [[String: Any]] = []
    var notes: [String] = []
    for a in attachments {
        if a.isImage {
            let img = try apiImage(a)
            blocks.append(["type": "image", "source": ["type": "base64", "media_type": img.mediaType, "data": img.data.base64EncodedString()]])
        } else if a.mediaType == "application/pdf" && a.data.count <= 20_000_000 {
            blocks.append(["type": "document", "source": ["type": "base64", "media_type": "application/pdf", "data": a.data.base64EncodedString()]])
        } else if a.data.count <= 256 * 1024, let text = String(data: a.data, encoding: .utf8) {
            blocks.append(["type": "text", "text": "<file path=\"\(a.path)\">\n\(text)\n</file>"])
        } else {
            notes.append(a.path)
        }
    }
    var text = prompt
    if !notes.isEmpty {
        text += "\n\n(Attached files that could not be included: " + notes.joined(separator: ", ") + ")"
    }
    blocks.append(["type": "text", "text": text])
    return blocks
}

// MARK: - Child process

nonisolated(unsafe) var currentChild: Process?

struct ChildResult {
    let status: Int32
    let timedOut: Bool
    let stderrTail: String
}

/// Run `exe args` in `cwd`, feed `stdin` (then close it), and call `onLine`
/// for every stdout line (without the newline) on a reader thread.
func runChild(_ exe: String, _ args: [String], stdin: Data?, cwd: URL, env: [String: String],
              timeout: TimeInterval, onLine: @escaping (String) -> Void) throws -> ChildResult {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    p.currentDirectoryURL = cwd
    p.environment = env
    let outPipe = Pipe(), errPipe = Pipe(), inPipe = Pipe()
    p.standardOutput = outPipe
    p.standardError = errPipe
    p.standardInput = stdin == nil ? FileHandle.nullDevice : inPipe
    let exited = DispatchSemaphore(value: 0)
    p.terminationHandler = { _ in exited.signal() }
    try p.run()
    currentChild = p

    let readers = DispatchGroup()
    readers.enter()
    Thread.detachNewThread {
        var pending = Data()
        let h = outPipe.fileHandleForReading
        while true {
            let chunk = h.availableData
            if chunk.isEmpty { break }
            pending.append(chunk)
            while let nl = pending.firstIndex(of: 0x0A) {
                let line = String(decoding: pending[pending.startIndex..<nl], as: UTF8.self)
                pending.removeSubrange(pending.startIndex...nl)
                onLine(line)
            }
        }
        if !pending.isEmpty { onLine(String(decoding: pending, as: UTF8.self)) }
        readers.leave()
    }
    var errTail = Data()
    let errLock = NSLock()
    readers.enter()
    Thread.detachNewThread {
        let h = errPipe.fileHandleForReading
        while true {
            let chunk = h.availableData
            if chunk.isEmpty { break }
            errLock.lock()
            errTail.append(chunk)
            if errTail.count > 4096 { errTail = errTail.suffix(4096) }
            errLock.unlock()
        }
        readers.leave()
    }
    if let stdin {
        Thread.detachNewThread {
            let h = inPipe.fileHandleForWriting
            try? h.write(contentsOf: stdin)
            try? h.close()
        }
    }

    var timedOut = false
    if exited.wait(timeout: .now() + timeout) == .timedOut {
        timedOut = true
        p.terminate()
        if exited.wait(timeout: .now() + 2) == .timedOut {
            kill(p.processIdentifier, SIGKILL)
            exited.wait()
        }
    }
    _ = readers.wait(timeout: .now() + 2)
    currentChild = nil
    errLock.lock()
    let tail = String(decoding: errTail, as: UTF8.self)
    errLock.unlock()
    return ChildResult(status: p.terminationStatus, timedOut: timedOut, stderrTail: tail)
}

func childEnv(binDir: String) -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = ([binDir] + searchDirs()).joined(separator: ":")
    env["NO_COLOR"] = "1"
    env["TERM"] = "dumb"
    env["CI"] = env["CI"] ?? "1"
    for k in env.keys where k.hasPrefix("BETTERCAST_") || k.hasPrefix("NATIVE_SDK_") { env[k] = nil }
    return env
}

func jsonObject(_ line: String) -> [String: Any]? {
    guard line.first == "{" else { return nil }
    return (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]
}

func jsonLine(_ obj: Any) throws -> Data {
    var d = try JSONSerialization.data(withJSONObject: obj)
    d.append(0x0A)
    return d
}

let ansiPattern = try! NSRegularExpression(pattern: "\u{1B}\\[[0-9;?]*[ -/]*[@-~]|\u{1B}\\][^\u{07}]*\u{07}")

func stripANSI(_ s: String) -> String {
    ansiPattern.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "")
}

// MARK: - Providers

struct ProviderRun {
    var args: [String]
    var stdin: Data?
    var onLine: (String) -> Void
    /// Called after exit: returns an error message when the run failed.
    var finish: (ChildResult) -> String?
}

/// Shared state for the JSON parsers (reader thread writes, main reads after join).
final class ParseState {
    var sawDelta = false
    var error: String?
    var fallbackText = ""
}

func claudeRun(_ req: AIRequest, prompt: String, attachments: [Attachment], sink: AnswerSink) throws -> ProviderRun {
    var args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
                "--include-partial-messages", "--no-session-persistence", "--tools", "",
                "--strict-mcp-config", "--permission-mode", "dontAsk", "--disable-slash-commands"]
    if !req.model.isEmpty { args += ["--model", req.model] }
    let message: [String: Any] = ["type": "user", "message": ["role": "user", "content": try contentBlocks(prompt: prompt, attachments: attachments)]]
    let st = ParseState()
    return ProviderRun(args: args, stdin: try jsonLine(message), onLine: { line in
        guard let o = jsonObject(line), let type = o["type"] as? String else { return }
        switch type {
        case "stream_event":
            if let ev = o["event"] as? [String: Any], ev["type"] as? String == "content_block_delta",
               let delta = ev["delta"] as? [String: Any], delta["type"] as? String == "text_delta",
               let text = delta["text"] as? String {
                st.sawDelta = true
                sink.text(text)
            }
        case "assistant":
            if !st.sawDelta, let msg = o["message"] as? [String: Any], let content = msg["content"] as? [[String: Any]] {
                for block in content where block["type"] as? String == "text" {
                    if let t = block["text"] as? String { sink.text(t) }
                }
            }
        case "result":
            if o["is_error"] as? Bool == true {
                st.error = (o["result"] as? String) ?? (o["subtype"] as? String) ?? "claude reported an error"
            } else if let r = o["result"] as? String {
                st.fallbackText = r
            }
        default: break
        }
    }, finish: { res in
        if let e = st.error { return e }
        if sink.emittedBytes == 0 && !st.fallbackText.isEmpty { sink.text(st.fallbackText) }
        return res.status == 0 ? nil : "claude exited with \(res.status): \(res.stderrTail)"
    })
}

func codexRun(_ req: AIRequest, prompt: String, attachments: [Attachment], cwd: URL, sink: AnswerSink) -> ProviderRun {
    let lastMessage = cwd.appendingPathComponent("codex-last-message.txt")
    try? FileManager.default.removeItem(at: lastMessage)
    var args = ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--color", "never",
                "--json", "-C", cwd.path, "-o", lastMessage.path]
    if !req.model.isEmpty { args += ["-m", req.model] }
    var text = prompt
    let files = attachments.filter { !$0.isImage }.map(\.path)
    if !files.isEmpty { text += "\n\nAttached files (read them if needed):\n" + files.map { "- \($0)" }.joined(separator: "\n") }
    args += attachments.filter(\.isImage).map { "--image=\($0.path)" }
    let st = ParseState()
    return ProviderRun(args: args, stdin: Data(text.utf8), onLine: { line in
        guard let o = jsonObject(line), let type = o["type"] as? String else { return }
        if type == "item.completed", let item = o["item"] as? [String: Any],
           item["type"] as? String == "agent_message", let t = item["text"] as? String {
            if sink.emittedBytes > 0 { sink.text("\n\n") }
            sink.text(t)
        } else if type == "turn.failed", let e = o["error"] as? [String: Any] {
            st.error = (e["message"] as? String) ?? "codex turn failed"
        } else if type == "error" {
            st.error = (o["message"] as? String) ?? "codex error"
        }
    }, finish: { res in
        if sink.emittedBytes == 0, let t = try? String(contentsOf: lastMessage, encoding: .utf8), !t.isEmpty { sink.text(t) }
        try? FileManager.default.removeItem(at: lastMessage)
        if sink.emittedBytes > 0 && res.status == 0 { return nil }
        return st.error ?? (res.status == 0 ? nil : "codex exited with \(res.status): \(res.stderrTail)")
    })
}

func geminiRun(_ req: AIRequest, prompt: String, attachments: [Attachment], sink: AnswerSink) throws -> ProviderRun {
    var args = ["--approval-mode", "plan", "-o", "stream-json"]
    if !req.model.isEmpty { args += ["-m", req.model] }
    let dirs = Array(Set(attachments.map { ($0.path as NSString).deletingLastPathComponent }))
    if !dirs.isEmpty { args += ["--include-directories", dirs.sorted().joined(separator: ",")] }
    guard prompt.utf8.count <= 200_000 else { throw SpecError.bad("prompt too long for gemini") }
    var text = prompt
    // gemini's @path syntax includes a file; spaces are backslash-escaped.
    for a in attachments { text += " @" + a.path.replacingOccurrences(of: " ", with: "\\ ") }
    args += ["-p", text]
    let st = ParseState()
    return ProviderRun(args: args, stdin: nil, onLine: { line in
        guard let o = jsonObject(line), let type = o["type"] as? String else { return }
        if type == "message", o["role"] as? String == "assistant", let c = o["content"] as? String {
            sink.text(c)
        } else if type == "result", o["status"] as? String == "error" {
            st.error = ((o["error"] as? [String: Any])?["message"] as? String) ?? "gemini reported an error"
        } else if type == "error" {
            st.error = (o["message"] as? String) ?? "gemini error"
        }
    }, finish: { res in
        if let e = st.error { return e }
        return res.status == 0 ? nil : "gemini exited with \(res.status): \(res.stderrTail)"
    })
}

func opencodeRun(_ req: AIRequest, prompt: String, attachments: [Attachment], sink: AnswerSink) -> ProviderRun {
    var args = ["run", "--standalone", "--agent", "plan"]
    if !req.model.isEmpty { args += ["-m", req.model] }
    for a in attachments { args += ["-f", a.path] }
    // A leading dash would parse as a flag.
    args.append(prompt.hasPrefix("-") ? " " + prompt : prompt)
    return ProviderRun(args: args, stdin: nil, onLine: { line in
        sink.text(stripANSI(line) + "\n")
    }, finish: { res in
        res.status == 0 ? nil : "opencode exited with \(res.status): \(res.stderrTail)"
    })
}

// MARK: - API (Anthropic Messages, streaming)

func runAPI(_ req: AIRequest, prompt: String, attachments: [Attachment], timeout: TimeInterval, sink: AnswerSink) -> String? {
    let keyData = FileHandle.standardInput.readDataToEndOfFile()
    let key = String(decoding: keyData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    guard !key.isEmpty else { return "no API key saved (Manage > AI)" }
    let model = req.model.isEmpty ? defaultAnthropicModel : req.model
    var body: [String: Any] = [
        "model": model,
        "max_tokens": 16000,
        "stream": true,
    ]
    var request = URLRequest(url: URL(string: "https://api.anthropic.com/v1/messages")!)
    request.httpMethod = "POST"
    request.timeoutInterval = timeout
    request.setValue(key, forHTTPHeaderField: "x-api-key")
    request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    if model == defaultAnthropicModel {
        // Server-side refusal fallback for the default model.
        request.setValue("server-side-fallback-2026-07-01", forHTTPHeaderField: "anthropic-beta")
        body["fallbacks"] = "default"
    }
    do {
        body["messages"] = [["role": "user", "content": try contentBlocks(prompt: prompt, attachments: attachments)]]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
    } catch {
        return "\(error)"
    }

    final class Box: @unchecked Sendable { var error: String? }
    let box = Box()
    let done = DispatchSemaphore(value: 0)
    let task = Task {
        defer { done.signal() }
        do {
            let (bytes, response) = try await URLSession.shared.bytes(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if status != 200 {
                var raw = ""
                for try await line in bytes.lines { raw += line; if raw.count > 8000 { break } }
                let msg = ((jsonObject(raw)?["error"] as? [String: Any])?["message"] as? String) ?? raw
                box.error = "HTTP \(status): \(msg)"
                return
            }
            for try await line in bytes.lines {
                guard line.hasPrefix("data:") else { continue }
                guard let o = jsonObject(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)),
                      let type = o["type"] as? String else { continue }
                if type == "content_block_delta", let d = o["delta"] as? [String: Any],
                   d["type"] as? String == "text_delta", let t = d["text"] as? String {
                    sink.text(t)
                } else if type == "message_delta", let d = o["delta"] as? [String: Any],
                          d["stop_reason"] as? String == "refusal" {
                    box.error = "the model declined to answer"
                } else if type == "error" {
                    box.error = ((o["error"] as? [String: Any])?["message"] as? String) ?? "API error"
                }
            }
        } catch {
            box.error = "\(error.localizedDescription)"
        }
    }
    if done.wait(timeout: .now() + timeout) == .timedOut {
        task.cancel()
        return "timed out after \(Int(timeout)) s"
    }
    return box.error
}

// MARK: - Fake (CI)

/// Deterministic provider for CI (BETTERCAST_AI_FAKE=1): echoes what it got,
/// in several chunks; a prompt containing FAIL produces an error.
func runFake(prompt: String, attachments: [Attachment], sink: AnswerSink) -> String? {
    if prompt.contains("FAIL") { return "fake provider failure (prompt contained FAIL)" }
    let names = attachments.map { "\(($0.path as NSString).lastPathComponent) (\($0.mediaType), \($0.data.count) bytes)" }
    var answer = "Fake answer.\nPrompt: \(prompt.utf8.count) bytes.\nAttachments: \(attachments.count)"
    if !names.isEmpty { answer += " - " + names.joined(separator: ", ") }
    answer += ".\nEcho: " + prompt
    for (i, piece) in utf8Chunks(Data(answer.utf8), size: 40).enumerated() {
        if i > 0 { usleep(20_000) }
        sink.text(String(decoding: piece, as: UTF8.self))
    }
    return nil
}

// MARK: - Command

func runAI(_ args: Args) -> Never {
    let requestPath = args.required("request")
    let timeout = args.optional("timeout").flatMap(TimeInterval.init) ?? defaultAITimeout
    guard let raw = FileManager.default.contents(atPath: requestPath) else { fail("request", "cannot read \(requestPath)") }
    var req: AIRequest
    do { req = try parseAIRequest(raw) } catch { fail("request", "\(error)") }
    if let override = args.optional("provider") { req.provider = override }
    let prompt = String(decoding: req.prompt, as: UTF8.self)
    guard !isBlank(prompt) else { fail("empty-prompt", "the question is empty") }
    let attachments: [Attachment]
    do { attachments = try loadAttachments(req.attachments) } catch { fail("attachment", "\(error)") }

    Watchdog.start(watchStdin: false, onExit: { currentChild?.terminate() })
    let sink = AnswerSink()
    var failure: String?
    switch req.provider {
    case "fake":
        guard ProcessInfo.processInfo.environment["BETTERCAST_AI_FAKE"] == "1" else {
            fail("provider", "the fake provider needs BETTERCAST_AI_FAKE=1")
        }
        failure = runFake(prompt: prompt, attachments: attachments, sink: sink)
    case "api":
        failure = runAPI(req, prompt: prompt, attachments: attachments, timeout: timeout, sink: sink)
    case "claude", "codex", "gemini", "opencode":
        let bin = req.bin.isEmpty ? findExecutable(req.provider) : req.bin
        guard let bin, isExecutableFile(bin) else { fail("provider-missing", "\(req.provider) CLI not found") }
        // Empty scratch dir next to the request file: no project context, nothing to read.
        let cwd = URL(fileURLWithPath: requestPath).deletingLastPathComponent().appendingPathComponent("ai-cwd", isDirectory: true)
        try? FileManager.default.createDirectory(at: cwd, withIntermediateDirectories: true)
        do {
            let run: ProviderRun
            switch req.provider {
            case "claude": run = try claudeRun(req, prompt: prompt, attachments: attachments, sink: sink)
            case "codex": run = codexRun(req, prompt: prompt, attachments: attachments, cwd: cwd, sink: sink)
            case "gemini": run = try geminiRun(req, prompt: prompt, attachments: attachments, sink: sink)
            default: run = opencodeRun(req, prompt: prompt, attachments: attachments, sink: sink)
            }
            let res = try runChild(bin, run.args, stdin: run.stdin, cwd: cwd,
                                   env: childEnv(binDir: (bin as NSString).deletingLastPathComponent),
                                   timeout: timeout, onLine: run.onLine)
            failure = res.timedOut ? "timed out after \(Int(timeout)) s" : run.finish(res)
        } catch {
            failure = "\(error)"
        }
    default:
        fail("provider", "unknown provider \(req.provider)", exit: Exit.usage)
    }
    if let failure {
        Out.error("ai-failed", String(failure.prefix(1500)))
        exit(Exit.failure)
    }
    Out.line(["done"])
    exit(Exit.ok)
}
