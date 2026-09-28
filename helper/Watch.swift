// `watch`: long-lived event stream for the core. Global hotkeys (Carbon
// RegisterEventHotKey), frontmost-app changes (NSWorkspace), pasteboard
// changes (changeCount polled every 250 ms), Accessibility trust changes.

import AppKit
import Carbon.HIToolbox
import ApplicationServices

private let hotkeySignature: OSType = 0x4254_4353 // 'BTCS'
nonisolated(unsafe) private var registeredTokens: [UInt32: String] = [:]

private func hotkeyHandler(_: EventHandlerCallRef?, _ event: EventRef?, _: UnsafeMutableRawPointer?) -> OSStatus {
    guard let event else { return OSStatus(eventNotHandledErr) }
    var id = EventHotKeyID()
    let st = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                               nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
    guard st == noErr, id.signature == hotkeySignature, let token = registeredTokens[id.id] else {
        return OSStatus(eventNotHandledErr)
    }
    Out.line(["hotkey", token])
    return noErr
}

final class Watcher: NSObject {
    let clipsDir: URL
    let imagesEnabled: Bool
    let parentPid: pid_t
    private var lastChange: Int
    private var lastFront: pid_t = -2
    private var lastAX: Bool
    private var hotkeyRefs: [EventHotKeyRef] = []
    private let work = DispatchQueue(label: "bettercast.clip", qos: .utility)
    /// sha of raw source image bytes -> stored clip, so re-copying the same
    /// big image does not re-encode it.
    private var imageCache: [String: StoredClip] = [:]

    init(clipsDir: URL, imagesEnabled: Bool) {
        self.clipsDir = clipsDir
        self.imagesEnabled = imagesEnabled
        self.parentPid = Watchdog.parentPid
        // Only changes after startup are recorded; the current clipboard is not read.
        self.lastChange = NSPasteboard.general.changeCount
        self.lastAX = AXIsProcessTrusted()
    }

    func registerHotkeys(_ specs: [HotkeySpec]) -> [(String, OSStatus)] {
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetEventDispatcherTarget(), hotkeyHandler, 1, &eventType, nil, nil)
        var failures: [(String, OSStatus)] = []
        for (i, spec) in specs.enumerated() {
            let id = EventHotKeyID(signature: hotkeySignature, id: UInt32(i + 1))
            var ref: EventHotKeyRef?
            // Exclusive: fail loudly when another app (e.g. Raycast) already owns the chord.
            let st = RegisterEventHotKey(spec.keyCode, spec.carbonMods, id, GetEventDispatcherTarget(),
                                         OptionBits(kEventHotKeyExclusive), &ref)
            if st == noErr, let ref {
                hotkeyRefs.append(ref)
                registeredTokens[id.id] = spec.token
            } else {
                failures.append((spec.token, st == noErr ? OSStatus(eventInternalErr) : st))
            }
        }
        return failures
    }

    func start() {
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(appActivated(_:)),
            name: NSWorkspace.didActivateApplicationNotification, object: nil)
        if let app = NSWorkspace.shared.frontmostApplication { reportFront(app) }
        Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.pollPasteboard() }
        Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in self?.pollAX() }
    }

    @objc private func appActivated(_ note: Notification) {
        guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
        reportFront(app)
    }

    private func reportFront(_ app: NSRunningApplication) {
        let pid = app.processIdentifier
        guard pid != parentPid, pid != getpid(), pid != lastFront else { return }
        lastFront = pid
        Out.line(["front", String(pid), b64(app.bundleIdentifier ?? "", maxBytes: 900), b64(app.localizedName ?? "", maxBytes: 900)])
    }

    private func pollAX() {
        let now = AXIsProcessTrusted()
        if now != lastAX {
            lastAX = now
            Out.line(["ax", now ? "1" : "0"])
        }
    }

    private func pollPasteboard() {
        let pb = NSPasteboard.general
        let change = pb.changeCount
        guard change != lastChange else { return }
        lastChange = change
        let at = nowMs()
        let source = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
        var types = (pb.types ?? []).map(\.rawValue)
        if let item = pb.pasteboardItems?.first { types += item.types.map(\.rawValue) }
        let text = pb.string(forType: .string)
        let decision = classifyPasteboard(types: types, hasNonEmptyText: text.map { !isBlank($0) } ?? false,
                                          imagesEnabled: imagesEnabled)
        switch decision {
        case .skip(let reason):
            Out.line(["clip-skip", reason])
        case .text:
            guard let text else { Out.line(["clip-skip", "empty"]); return }
            if text.utf8.count > maxClipBytes { Out.line(["clip-skip", "too-large"]); return }
            work.async { self.recordText(text, at: at, source: source) }
        case .image(let type):
            guard let data = pb.data(forType: NSPasteboard.PasteboardType(type)), !data.isEmpty else {
                Out.line(["clip-skip", "empty"]); return
            }
            if data.count > maxClipBytes { Out.line(["clip-skip", "too-large"]); return }
            work.async { self.recordImage(data, at: at, source: source) }
        }
    }

    private func recordText(_ text: String, at: Int64, source: String) {
        do {
            let c = try storeTextClip(text, clipsDir: clipsDir)
            let preview = utf8Prefix(text, maxBytes: 240)
            Out.line(["clip", "text", String(at), c.sha, String(c.bytes), b64(preview), b64(source, maxBytes: 600)])
        } catch {
            Out.error("clip-write", "\(error)")
        }
    }

    private func recordImage(_ data: Data, at: Int64, source: String) {
        do {
            let rawSha = sha256Hex(data)
            let c: StoredClip
            if let cached = imageCache[rawSha],
               FileManager.default.fileExists(atPath: clipsDir.appendingPathComponent("\(cached.sha).png").path) {
                c = cached
            } else {
                c = try storeImageClip(data, clipsDir: clipsDir)
                if imageCache.count > 64 { imageCache.removeAll() }
                imageCache[rawSha] = c
            }
            Out.line(["clip", "image", String(at), c.sha, String(c.bytes), String(c.width), String(c.height), b64(source, maxBytes: 600)])
        } catch ImageError.decode {
            Out.line(["clip-skip", "unsupported"])
        } catch {
            Out.error("clip-write", "\(error)")
        }
    }
}

func runWatch(_ args: Args) -> Never {
    let specs: [HotkeySpec]
    do {
        specs = try parseHotkeySpec(args.required("hotkeys"))
    } catch SpecError.bad(let msg) {
        usage(msg)
    } catch {
        usage("\(error)")
    }
    let dataDir = URL(fileURLWithPath: args.required("data-dir"), isDirectory: true)
    let images = args.optional("images") ?? "1"
    guard images == "0" || images == "1" else { usage("--images must be 0 or 1") }
    let clipsDir = dataDir.appendingPathComponent("clips", isDirectory: true)
    do {
        try FileManager.default.createDirectory(at: clipsDir, withIntermediateDirectories: true)
    } catch {
        fail("data-dir", "cannot create \(clipsDir.path): \(error)")
    }

    Watchdog.start(watchStdin: true)
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let watcher = Watcher(clipsDir: clipsDir, imagesEnabled: images == "1")
    let failures = watcher.registerHotkeys(specs)
    Out.line(["ready", helperVersion, "ax=\(AXIsProcessTrusted() ? 1 : 0)"])
    for (token, status) in failures {
        Out.line(["hotkey-error", token, String(status)])
    }
    watcher.start()
    withExtendedLifetime(watcher) {
        app.run()
    }
    exit(Exit.ok)
}
