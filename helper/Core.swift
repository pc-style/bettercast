// Shared plumbing for bettercast-helper: the stdout line protocol, base64,
// hashing, argument parsing, hotkey spec and AI request parsing, and the
// parent-death watchdog. See app/src/contract.md "Helper CLI".

import Foundation
import CryptoKit

let helperVersion = "0.1.0"

/// Spawn line bound of the Native SDK runtime; every line we print must be
/// strictly shorter (including the trailing newline).
let maxLineBytes = 4096

enum Exit {
    static let ok: Int32 = 0
    static let failure: Int32 = 1
    static let usage: Int32 = 2
    static let needsAX: Int32 = 3
}

// MARK: - Output

enum Out {
    private static let lock = NSLock()

    /// Print one protocol line. Fields must already be ASCII without spaces
    /// (use `b64` for free text). Lines that would exceed the bound are
    /// replaced by an `error line-too-long` line so the core never sees a
    /// cut line.
    static func line(_ fields: [String]) {
        var text = fields.joined(separator: " ")
        if text.utf8.count + 1 >= maxLineBytes || !text.allSatisfy({ $0.isASCII && $0 != "\n" && $0 != "\r" }) {
            text = "error line-too-long " + b64("dropped a \(fields.first ?? "?") line of \(text.utf8.count) bytes")
        }
        text += "\n"
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardOutput.write(text.data(using: .ascii)!)
    }

    static func error(_ code: String, _ message: String) {
        line(["error", code, b64(message)])
    }
}

/// Exit after printing `error <code> <msg>`.
func fail(_ code: String, _ message: String, exit status: Int32 = Exit.failure) -> Never {
    Out.error(code, message)
    exit(status)
}

func usage(_ message: String) -> Never {
    fail("usage", message, exit: Exit.usage)
}

// MARK: - Encoding

/// Standard base64 (RFC 4648, padded); empty input is `-`.
func b64(_ data: Data) -> String {
    data.isEmpty ? "-" : data.base64EncodedString()
}

func b64(_ string: String, maxBytes: Int = 1024) -> String {
    b64(utf8Prefix(string, maxBytes: maxBytes))
}

func unb64(_ field: String) -> Data? {
    if field == "-" { return Data() }
    return Data(base64Encoded: field)
}

/// The longest prefix of `string`'s UTF-8 bytes that is <= maxBytes and does
/// not cut a scalar.
func utf8Prefix(_ string: String, maxBytes: Int) -> Data {
    let bytes = Array(string.utf8)
    return utf8Prefix(bytes: bytes, maxBytes: maxBytes)
}

func utf8Prefix(bytes: [UInt8], maxBytes: Int) -> Data {
    if bytes.count <= maxBytes { return Data(bytes) }
    var end = maxBytes
    // Back up over continuation bytes (10xxxxxx) so we cut before a lead byte.
    while end > 0 && (bytes[end] & 0xC0) == 0x80 { end -= 1 }
    return Data(bytes[0..<end])
}

func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func nowMs() -> Int64 {
    Int64((Date().timeIntervalSince1970 * 1000).rounded())
}

/// Split a byte buffer into pieces of at most `size` bytes without cutting a
/// UTF-8 scalar (when the input is valid UTF-8).
func utf8Chunks(_ data: Data, size: Int) -> [Data] {
    var out: [Data] = []
    let bytes = [UInt8](data)
    var start = 0
    while start < bytes.count {
        var end = min(start + size, bytes.count)
        if end < bytes.count {
            var e = end
            while e > start && (bytes[e] & 0xC0) == 0x80 { e -= 1 }
            if e > start { end = e }
        }
        out.append(Data(bytes[start..<end]))
        start = end
    }
    return out
}

// MARK: - Arguments

struct Args {
    private var values: [String: String] = [:]
    private(set) var flags: Set<String> = []

    /// Parse `--name value` pairs; names listed in `boolFlags` take no value.
    init(_ argv: ArraySlice<String>, boolFlags: Set<String> = []) {
        var it = argv.makeIterator()
        while let a = it.next() {
            guard a.hasPrefix("--") else { usage("unexpected argument \(a)") }
            let name = String(a.dropFirst(2))
            if boolFlags.contains(name) {
                flags.insert(name)
                continue
            }
            guard let v = it.next() else { usage("--\(name) needs a value") }
            values[name] = v
        }
    }

    func optional(_ name: String) -> String? { values[name] }

    func required(_ name: String) -> String {
        guard let v = values[name], !v.isEmpty else { usage("missing --\(name)") }
        return v
    }
}

// MARK: - Hotkey spec

struct HotkeySpec: Equatable {
    let token: String
    let keyCode: UInt32
    let carbonMods: UInt32
}

let hotkeyTokens: Set<String> = ["launcher", "clipboard", "paste_next", "ask_ai"]
/// cmd=256 shift=512 option=2048 control=4096 (Carbon cmdKey, shiftKey, optionKey, controlKey).
let carbonModMask: UInt32 = 256 | 512 | 2048 | 4096

enum SpecError: Error, Equatable { case bad(String) }

/// `-` or comma-separated `<token>:<carbonKeyCode>:<carbonMods>`.
func parseHotkeySpec(_ spec: String) throws -> [HotkeySpec] {
    if spec == "-" || spec.isEmpty { return [] }
    var out: [HotkeySpec] = []
    var seen: Set<String> = []
    for part in spec.split(separator: ",", omittingEmptySubsequences: false) {
        let f = part.split(separator: ":", omittingEmptySubsequences: false)
        guard f.count == 3 else { throw SpecError.bad("expected token:code:mods in \(part)") }
        let token = String(f[0])
        guard hotkeyTokens.contains(token) else { throw SpecError.bad("unknown hotkey token \(token)") }
        guard !seen.contains(token) else { throw SpecError.bad("duplicate hotkey token \(token)") }
        guard let code = UInt32(f[1]), code <= 127 else { throw SpecError.bad("bad key code in \(part)") }
        guard let mods = UInt32(f[2]), mods & ~carbonModMask == 0 else { throw SpecError.bad("bad modifiers in \(part)") }
        seen.insert(token)
        out.append(HotkeySpec(token: token, keyCode: code, carbonMods: mods))
    }
    return out
}

// MARK: - AI request file

struct AIRequest {
    var provider: String
    var bin: String
    var model: String
    var attachments: [String]
    var prompt: Data
}

/// `provider <token>\nbin <b64|->\nmodel <b64|->\n(attach <b64 path>\n)*prompt\n<raw prompt to EOF>`
func parseAIRequest(_ data: Data) throws -> AIRequest {
    var req = AIRequest(provider: "", bin: "", model: "", attachments: [], prompt: Data())
    var index = data.startIndex
    var sawPrompt = false
    func str(_ d: Data) -> String { String(decoding: d, as: UTF8.self) }
    while index < data.endIndex {
        let nl = data[index...].firstIndex(of: 0x0A) ?? data.endIndex
        let line = str(data[index..<nl])
        index = nl < data.endIndex ? data.index(after: nl) : nl
        if line == "prompt" {
            req.prompt = Data(data[index...])
            sawPrompt = true
            break
        }
        let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { throw SpecError.bad("bad request line: \(line.prefix(60))") }
        let key = parts[0]
        let value = parts[1]
        func decoded() throws -> String {
            guard let d = unb64(value) else { throw SpecError.bad("bad base64 for \(key)") }
            return str(d)
        }
        switch key {
        case "provider": req.provider = value
        case "bin": req.bin = try decoded()
        case "model": req.model = try decoded()
        case "attach": req.attachments.append(try decoded())
        default: throw SpecError.bad("unknown request key \(key)")
        }
    }
    guard sawPrompt else { throw SpecError.bad("request has no prompt section") }
    guard !req.provider.isEmpty else { throw SpecError.bad("request has no provider") }
    return req
}

// MARK: - Parent watchdog

/// Exit (status 0) when the process that spawned us dies: its pid is gone
/// or we were reparented to launchd. Runs `onExit` first (e.g. to kill a
/// child). Also exits when stdin is a pipe/socket that reaches EOF (the
/// Native SDK spawns without stdin, which is /dev/null, so that path only
/// applies when a caller deliberately holds a pipe open).
enum Watchdog {
    static let parentPid = getppid()

    static func start(watchStdin: Bool, onExit: @escaping () -> Void = {}) {
        let parent = parentPid
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
        timer.setEventHandler {
            if getppid() != parent || (parent > 1 && kill(parent, 0) != 0 && errno == ESRCH) {
                onExit()
                exit(Exit.ok)
            }
        }
        timer.resume()
        retained.append(timer)

        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: DispatchQueue.global(qos: .utility))
            src.setEventHandler {
                onExit()
                exit(Exit.ok)
            }
            src.resume()
            retained.append(src)
        }

        if watchStdin {
            var st = stat()
            if fstat(STDIN_FILENO, &st) == 0 {
                let type = st.st_mode & S_IFMT
                if type == S_IFIFO || type == S_IFSOCK {
                    Thread.detachNewThread {
                        var buf = [UInt8](repeating: 0, count: 256)
                        while true {
                            let n = read(STDIN_FILENO, &buf, buf.count)
                            if n == 0 || (n < 0 && errno != EINTR) { break }
                        }
                        onExit()
                        exit(Exit.ok)
                    }
                }
            }
        }
    }

    nonisolated(unsafe) private static var retained: [AnyObject] = []
}
