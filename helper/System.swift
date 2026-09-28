// Read-only system queries and small actions: `apps`, `providers`, `open`,
// `ax-status`, `ax-prompt`.

import AppKit
import ApplicationServices

let home = FileManager.default.homeDirectoryForCurrentUser.path

// MARK: - apps

let appRoots = [
    "/Applications",
    "/System/Applications",
    "/System/Applications/Utilities",
    "\(home)/Applications",
]

/// Every `.app` bundle under the roots (descending up to two plain folders,
/// e.g. /Applications/Utilities or vendor folders; never into bundles).
func scanApps() -> [(name: String, path: String)] {
    let fm = FileManager.default
    var seen: Set<String> = []
    var out: [(String, String)] = []
    func visit(_ dir: String, depth: Int) {
        guard let entries = try? fm.contentsOfDirectory(atPath: dir) else { return }
        for entry in entries.sorted() where !entry.hasPrefix(".") {
            let path = (dir as NSString).appendingPathComponent(entry)
            if entry.hasSuffix(".app") {
                let real = (path as NSString).resolvingSymlinksInPath
                guard seen.insert(real).inserted else { continue }
                out.append((fm.displayName(atPath: path).replacingOccurrences(of: ".app", with: "", options: [.anchored, .backwards]), path))
            } else if depth > 0 {
                var isDir: ObjCBool = false
                if fm.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue {
                    visit(path, depth: depth - 1)
                }
            }
        }
    }
    for root in appRoots { visit(root, depth: 2) }
    return out.sorted { $0.0.localizedCaseInsensitiveCompare($1.0) == .orderedAscending }
}

func runApps() -> Never {
    for app in scanApps() {
        Out.line(["app", b64(app.name, maxBytes: 1000), b64(app.path, maxBytes: 1800)])
    }
    Out.line(["done"])
    exit(Exit.ok)
}

// MARK: - providers

let providerIds = ["claude", "codex", "gemini", "opencode"]

/// Directories where CLIs usually live, beyond PATH (an app launched from
/// Finder gets a minimal PATH).
func commonBinDirs() -> [String] {
    var dirs = [
        "\(home)/.local/bin", "\(home)/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin",
        "\(home)/.claude/local", "\(home)/.opencode/bin", "\(home)/.npm-global/bin",
        "\(home)/.volta/bin", "\(home)/Library/pnpm", "\(home)/.local/share/pnpm", "\(home)/.yarn/bin",
        "\(home)/.cargo/bin", "/usr/bin", "/bin",
    ]
    // Node version managers: fnm and nvm keep one bin dir per version.
    let fm = FileManager.default
    for (root, suffix) in [("\(home)/.local/share/fnm/node-versions", "installation/bin"),
                           ("\(home)/Library/Application Support/fnm/node-versions", "installation/bin"),
                           ("\(home)/.nvm/versions/node", "bin")] {
        if let versions = try? fm.contentsOfDirectory(atPath: root) {
            for v in versions.sorted().reversed() where !v.hasPrefix(".") {
                dirs.append("\(root)/\(v)/\(suffix)")
            }
        }
    }
    return dirs
}

func searchDirs() -> [String] {
    let path = ProcessInfo.processInfo.environment["PATH"] ?? ""
    var out: [String] = []
    var seen: Set<String> = []
    for d in path.split(separator: ":").map(String.init) + commonBinDirs() where !d.isEmpty {
        if seen.insert(d).inserted { out.append(d) }
    }
    return out
}

func isExecutableFile(_ path: String) -> Bool {
    var isDir: ObjCBool = false
    return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && !isDir.boolValue
        && access(path, X_OK) == 0
}

func findExecutable(_ name: String) -> String? {
    for dir in searchDirs() {
        let p = (dir as NSString).appendingPathComponent(name)
        if isExecutableFile(p) { return p }
    }
    return nil
}

func runProviders() -> Never {
    for id in providerIds {
        if let p = findExecutable(id) {
            Out.line(["provider", id, b64(p, maxBytes: 2000)])
        }
    }
    Out.line(["done"])
    exit(Exit.ok)
}

// MARK: - open

func runOpen(_ args: Args) -> Never {
    let target = args.required("path")
    let url: URL
    if target.contains("://"), let u = URL(string: target) {
        url = u
    } else {
        guard FileManager.default.fileExists(atPath: target) else { fail("not-found", "no such file: \(target)") }
        url = URL(fileURLWithPath: target)
    }
    guard NSWorkspace.shared.open(url) else { fail("open-failed", "could not open \(target)") }
    Out.line(["result", "opened"])
    exit(Exit.ok)
}

// MARK: - Accessibility

func runAXStatus(prompt: Bool) -> Never {
    let trusted: Bool
    if prompt {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        trusted = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    } else {
        trusted = AXIsProcessTrusted()
    }
    Out.line(["ax", trusted ? "1" : "0"])
    exit(trusted ? Exit.ok : Exit.needsAX)
}
