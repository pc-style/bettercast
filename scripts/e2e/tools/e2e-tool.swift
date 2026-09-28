// e2e-tool: small macOS helper for the hosted-CI end-to-end suite.
//
// CI ONLY for everything that touches the session (keys, pasteboard, AX,
// windows, activation). The pure file commands (make-png, tiff-size,
// nonblank) are safe anywhere and are what a local dry run exercises.
//
// Build: swiftc -O -o e2e-tool scripts/e2e/tools/e2e-tool.swift
// Usage: e2e-tool <command> [args]   (run with no args for the list)

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// MARK: - output helpers

func out(_ s: String) { FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!) }
func err(_ s: String) { FileHandle.standardError.write(("e2e-tool: " + s + "\n").data(using: .utf8)!) }
func die(_ s: String, _ code: Int32 = 1) -> Never { err(s); exit(code) }
func usage() -> Never {
    die("""
    usage: e2e-tool <command>
      perm                              ax=0|1 post=0|1 screen=0|1 for this process
      key <chord> [repeat]              post a key chord via CGEvent (opt+space, cmd+k, ctrl+cmd+v, tab, shift+tab, escape, return, down, up)
      type <text>                       type unicode text via CGEvent
      pb-text <text> [--concealed|--transient]
      pb-image <png>                    put PNG + TIFF representations on the pasteboard (like a screenshot copy)
      pb-types                          list current pasteboard types
      make-png <out> <w> <h>            deterministic asymmetric RGBA test image
      tiff-size <png>                   png/tiff byte sizes for the same pixels
      nonblank <png> [--baseline <png>] [--min-changed <fraction>]
      windows <pid>                     on-screen windows owned by pid
      front                             frontmost app pid + bundle id
      activate <bundle-id>              activate a running app
      ax-dump <pid>                     accessibility tree of an app
      ax-text <bundle-id>               value of the first text area in the app's focused window
    """, 2)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { usage() }

// MARK: - keys

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
    "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
    "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36,
    "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43,
    "comma": 43, "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50,
    "backspace": 51, "delete": 51, "escape": 53, "esc": 53, "f1": 122, "f2": 120,
    "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101,
    "f10": 109, "f11": 103, "f12": 111, "home": 115, "end": 119, "left": 123,
    "arrowleft": 123, "right": 124, "arrowright": 124, "down": 125, "arrowdown": 125,
    "up": 126, "arrowup": 126,
]

func parseChord(_ chord: String) -> (CGKeyCode, CGEventFlags) {
    var flags: CGEventFlags = []
    var parts = chord.lowercased().split(separator: "+", omittingEmptySubsequences: false).map(String.init)
    // "cmd++" style is not supported; a trailing "+" means the key is "+".
    let keyName = parts.removeLast()
    for p in parts {
        switch p {
        case "cmd", "command", "super", "meta": flags.insert(.maskCommand)
        case "opt", "option", "alt": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "shift": flags.insert(.maskShift)
        default: die("unknown modifier '\(p)' in '\(chord)'", 2)
        }
    }
    guard let code = keyCodes[keyName] else { die("unknown key '\(keyName)' in '\(chord)'", 2) }
    return (code, flags)
}

func postKey(_ code: CGKeyCode, _ flags: CGEventFlags) {
    let src = CGEventSource(stateID: .hidSystemState)
    guard let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) else {
        die("could not create key event")
    }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    usleep(12_000)
    up.post(tap: .cghidEventTap)
    usleep(40_000)
}

func typeText(_ text: String) {
    let src = CGEventSource(stateID: .hidSystemState)
    for ch in text {
        let units = Array(String(ch).utf16)
        if ch == "\n" { postKey(36, []); continue }
        if ch == "\t" { postKey(48, []); continue }
        guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) else {
            die("could not create key event")
        }
        down.flags = []
        up.flags = []
        down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        down.post(tap: .cghidEventTap)
        usleep(8_000)
        up.post(tap: .cghidEventTap)
        usleep(30_000)
    }
}

// MARK: - images

func loadRep(_ path: String) -> NSBitmapImageRep {
    guard let data = FileManager.default.contents(atPath: path) else { die("cannot read \(path)") }
    guard let rep = NSBitmapImageRep(data: data) else { die("not an image: \(path)") }
    return rep
}

/// Deterministic, asymmetric test pattern: diagonal gradient, an off-centre
/// block, a stripe band, and a partially transparent corner. Compresses
/// well as PNG but is far from uniform.
func makePNG(path: String, width: Int, height: Int) {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: width * 4, bitsPerPixel: 32),
          let base = rep.bitmapData else { die("cannot allocate bitmap") }
    for y in 0..<height {
        for x in 0..<width {
            let i = (y * width + x) * 4
            var r = UInt8((x * 255) / max(1, width - 1))
            var g = UInt8((y * 255) / max(1, height - 1))
            var b = UInt8(((x + 2 * y) * 3) & 0xff)
            var a: UInt8 = 255
            if x > width / 5 && x < width / 2 && y > height / 3 && y < (height * 4) / 5 { r = 20; g = 160; b = 90 }
            if (y / 7) % 5 == 0 && x > (width * 2) / 3 { r = 250; g = 240; b = 10 }
            if x < width / 6 && y < height / 6 { a = 128; r = r / 2; g = g / 2; b = b / 2 }
            base[i] = r; base[i + 1] = g; base[i + 2] = b; base[i + 3] = a
        }
    }
    guard let png = rep.representation(using: .png, properties: [:]) else { die("PNG encode failed") }
    do { try png.write(to: URL(fileURLWithPath: path)) } catch { die("write failed: \(error)") }
    out("png \(path) \(width)x\(height) bytes=\(png.count)")
}

struct Stats { var width = 0; var height = 0; var distinct = 0; var stddev = 0.0; var mean = 0.0 }

func rgbaBuffer(_ rep: NSBitmapImageRep) -> (Int, Int, [UInt8]) {
    let w = rep.pixelsWide, h = rep.pixelsHigh
    var buf = [UInt8](repeating: 0, count: w * h * 4)
    let cs = CGColorSpaceCreateDeviceRGB()
    guard let cg = rep.cgImage,
          let ctx = CGContext(data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                              space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        die("cannot decode pixels")
    }
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    return (w, h, buf)
}

func stats(_ w: Int, _ h: Int, _ buf: [UInt8]) -> Stats {
    var s = Stats()
    s.width = w; s.height = h
    var colors = Set<UInt32>()
    var sum = 0.0, sumSq = 0.0
    var n = 0.0
    let step = max(1, (w * h) / 400_000)
    var p = 0
    while p < w * h {
        let i = p * 4
        let r = buf[i], g = buf[i + 1], b = buf[i + 2]
        if colors.count < 100_000 { colors.insert(UInt32(r) << 16 | UInt32(g) << 8 | UInt32(b)) }
        let l = 0.2126 * Double(r) + 0.7152 * Double(g) + 0.0722 * Double(b)
        sum += l; sumSq += l * l; n += 1
        p += step
    }
    s.distinct = colors.count
    s.mean = sum / max(1, n)
    s.stddev = (max(0, sumSq / max(1, n) - s.mean * s.mean)).squareRoot()
    return s
}

// MARK: - pasteboard

func setPasteboard(text: String, extraTypes: [String]) {
    let pb = NSPasteboard.general
    pb.clearContents()
    let item = NSPasteboardItem()
    item.setString(text, forType: .string)
    for t in extraTypes { item.setData(Data(), forType: NSPasteboard.PasteboardType(t)) }
    guard pb.writeObjects([item]) else { die("pasteboard write failed") }
    out("pasteboard text bytes=\(text.utf8.count) changeCount=\(pb.changeCount) extra=\(extraTypes.joined(separator: ","))")
}

// MARK: - accessibility

func axAttr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    let r = AXUIElementCopyAttributeValue(el, name as CFString, &value)
    return r == .success ? value : nil
}

func axString(_ el: AXUIElement, _ name: String) -> String {
    guard let v = axAttr(el, name) else { return "" }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return ""
}

func clean(_ s: String, _ max: Int = 160) -> String {
    var t = s.replacingOccurrences(of: "\n", with: "\\n").replacingOccurrences(of: "\"", with: "'")
    if t.count > max { t = String(t.prefix(max)) + "…" }
    return t
}

var axNodes = 0
func axDump(_ el: AXUIElement, depth: Int) {
    if axNodes > 6000 || depth > 40 { return }
    axNodes += 1
    let role = axString(el, kAXRoleAttribute)
    let subrole = axString(el, kAXSubroleAttribute)
    let title = axString(el, kAXTitleAttribute)
    let desc = axString(el, kAXDescriptionAttribute)
    let help = axString(el, kAXHelpAttribute)
    let value = axString(el, kAXValueAttribute)
    let ident = axString(el, "AXIdentifier")
    let enabled = axString(el, kAXEnabledAttribute)
    let focused = axString(el, kAXFocusedAttribute)
    let selected = axString(el, kAXSelectedAttribute)
    var line = String(repeating: "  ", count: depth) + "role=\(role)"
    if !subrole.isEmpty { line += " subrole=\(subrole)" }
    if !title.isEmpty { line += " title=\"\(clean(title))\"" }
    if !desc.isEmpty { line += " description=\"\(clean(desc))\"" }
    if !help.isEmpty { line += " help=\"\(clean(help))\"" }
    if !value.isEmpty { line += " value=\"\(clean(value))\"" }
    if !ident.isEmpty { line += " id=\"\(clean(ident))\"" }
    if !enabled.isEmpty { line += " enabled=\(enabled)" }
    if focused == "1" { line += " focused=1" }
    if selected == "1" { line += " selected=1" }
    out(line)
    if let children = axAttr(el, kAXChildrenAttribute) as? [AXUIElement] {
        for c in children { axDump(c, depth: depth + 1) }
    }
}

func firstTextArea(_ el: AXUIElement, depth: Int = 0) -> AXUIElement? {
    if depth > 30 { return nil }
    if axString(el, kAXRoleAttribute) == "AXTextArea" { return el }
    if let children = axAttr(el, kAXChildrenAttribute) as? [AXUIElement] {
        for c in children { if let f = firstTextArea(c, depth: depth + 1) { return f } }
    }
    return nil
}

func runningApp(_ bundleId: String) -> NSRunningApplication {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
        die("\(bundleId) is not running")
    }
    return app
}

// MARK: - commands

switch command {
case "perm":
    let ax = AXIsProcessTrusted()
    let post = CGPreflightPostEventAccess()
    let screen = CGPreflightScreenCaptureAccess()
    out("ax=\(ax ? 1 : 0) post=\(post ? 1 : 0) screen=\(screen ? 1 : 0) pid=\(getpid())")

case "key":
    guard args.count >= 2 else { usage() }
    let (code, flags) = parseChord(args[1])
    let times = args.count >= 3 ? max(1, Int(args[2]) ?? 1) : 1
    for _ in 0..<times { postKey(code, flags) }
    out("key \(args[1]) x\(times)")

case "type":
    guard args.count >= 2 else { usage() }
    typeText(args[1])
    out("typed \(args[1].count) chars")

case "pb-text":
    guard args.count >= 2 else { usage() }
    var extra: [String] = []
    if args.contains("--concealed") { extra.append("org.nspasteboard.ConcealedType") }
    if args.contains("--transient") { extra.append("org.nspasteboard.TransientType") }
    setPasteboard(text: args[1], extraTypes: extra)

case "pb-image":
    guard args.count >= 2 else { usage() }
    guard let png = FileManager.default.contents(atPath: args[1]) else { die("cannot read \(args[1])") }
    let rep = loadRep(args[1])
    guard let tiff = rep.tiffRepresentation else { die("TIFF encode failed") }
    let pb = NSPasteboard.general
    pb.clearContents()
    let item = NSPasteboardItem()
    item.setData(png, forType: .png)
    item.setData(tiff, forType: .tiff)
    guard pb.writeObjects([item]) else { die("pasteboard write failed") }
    out("pasteboard image png=\(png.count) tiff=\(tiff.count) changeCount=\(pb.changeCount)")

case "pb-types":
    let pb = NSPasteboard.general
    let types = (pb.pasteboardItems ?? []).flatMap { $0.types.map { $0.rawValue } }
    out("changeCount=\(pb.changeCount) types=\(types.joined(separator: ","))")

case "make-png":
    guard args.count >= 4, let w = Int(args[2]), let h = Int(args[3]), w > 0, h > 0 else { usage() }
    makePNG(path: args[1], width: w, height: h)

case "tiff-size":
    guard args.count >= 2 else { usage() }
    let pngBytes = (try? FileManager.default.attributesOfItem(atPath: args[1])[.size] as? NSNumber)??.intValue ?? 0
    let rep = loadRep(args[1])
    let tiffNone = rep.tiffRepresentation(using: .none, factor: 0)?.count ?? 0
    let pixels = rep.pixelsWide * rep.pixelsHigh
    let bpp = pixels > 0 ? Double(tiffNone) / Double(pixels) : 0
    let ratio = pngBytes > 0 ? Double(tiffNone) / Double(pngBytes) : 0
    out(String(format: "{\"png_bytes\":%d,\"tiff_bytes\":%d,\"width\":%d,\"height\":%d,\"tiff_bytes_per_pixel\":%.2f,\"tiff_over_png\":%.2f}",
               pngBytes, tiffNone, rep.pixelsWide, rep.pixelsHigh, bpp, ratio))

case "nonblank":
    guard args.count >= 2 else { usage() }
    var baseline: String?
    var minChanged = 0.002
    var i = 2
    while i < args.count {
        if args[i] == "--baseline", i + 1 < args.count { baseline = args[i + 1]; i += 2; continue }
        if args[i] == "--min-changed", i + 1 < args.count { minChanged = Double(args[i + 1]) ?? minChanged; i += 2; continue }
        usage()
    }
    let (w, h, buf) = rgbaBuffer(loadRep(args[1]))
    let s = stats(w, h, buf)
    var ok = s.distinct > 16 && s.stddev > 3.0
    var reason = ok ? "varied" : "uniform (distinct=\(s.distinct) stddev=\(String(format: "%.2f", s.stddev)))"
    var changed = -1.0
    if let base = baseline {
        let (bw, bh, bbuf) = rgbaBuffer(loadRep(base))
        if bw != w || bh != h {
            ok = false
            reason = "baseline size \(bw)x\(bh) != \(w)x\(h)"
        } else {
            var diff = 0
            var p = 0
            while p < w * h {
                let k = p * 4
                let d = abs(Int(buf[k]) - Int(bbuf[k])) + abs(Int(buf[k + 1]) - Int(bbuf[k + 1])) + abs(Int(buf[k + 2]) - Int(bbuf[k + 2]))
                if d > 24 { diff += 1 }
                p += 1
            }
            changed = Double(diff) / Double(max(1, w * h))
            if changed < minChanged {
                ok = false
                reason = "same as baseline (changed=\(String(format: "%.4f", changed)) < \(minChanged)): wallpaper-only or no app pixels"
            }
        }
    }
    out(String(format: "{\"ok\":%@,\"width\":%d,\"height\":%d,\"distinct_colors\":%d,\"luma_stddev\":%.2f,\"changed_vs_baseline\":%.4f,\"reason\":\"%@\"}",
               ok ? "true" : "false", w, h, s.distinct, s.stddev, changed, reason))
    exit(ok ? 0 : 1)

case "windows":
    guard args.count >= 2, let pid = Int(args[1]) else { usage() }
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    var n = 0
    for w in list where (w[kCGWindowOwnerPID as String] as? Int) == pid {
        let b = (w[kCGWindowBounds as String] as? [String: Any]) ?? [:]
        let x = (b["X"] as? Double) ?? 0, y = (b["Y"] as? Double) ?? 0
        let ww = (b["Width"] as? Double) ?? 0, hh = (b["Height"] as? Double) ?? 0
        let layer = (w[kCGWindowLayer as String] as? Int) ?? 0
        let alpha = (w[kCGWindowAlpha as String] as? Double) ?? 1
        let name = (w[kCGWindowName as String] as? String) ?? ""
        out("window id=\(w[kCGWindowNumber as String] ?? 0) layer=\(layer) alpha=\(alpha) x=\(Int(x)) y=\(Int(y)) w=\(Int(ww)) h=\(Int(hh)) name=\"\(clean(name))\"")
        n += 1
    }
    out("count=\(n)")

case "front":
    if let app = NSWorkspace.shared.frontmostApplication {
        out("front pid=\(app.processIdentifier) bundle=\(app.bundleIdentifier ?? "-") name=\"\(app.localizedName ?? "")\"")
    } else {
        out("front none")
    }

case "activate":
    guard args.count >= 2 else { usage() }
    let app = runningApp(args[1])
    _ = app.activate(options: [.activateAllWindows])
    usleep(400_000)
    out("activated \(args[1]) pid=\(app.processIdentifier)")

case "ax-dump":
    guard args.count >= 2, let pid = Int32(args[1]) else { usage() }
    if !AXIsProcessTrusted() { die("not AX-trusted: grant Accessibility to this process (or its responsible parent)", 3) }
    let appEl = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(appEl, 3)
    out("# ax-dump pid=\(pid)")
    axDump(appEl, depth: 0)
    // Windows that are not children of the app element (panels ordered out) are still listed by AXWindows.
    if let wins = axAttr(appEl, kAXWindowsAttribute) as? [AXUIElement] { out("# AXWindows count=\(wins.count)") }
    out("# nodes=\(axNodes)")

case "ax-text":
    guard args.count >= 2 else { usage() }
    if !AXIsProcessTrusted() { die("not AX-trusted", 3) }
    let app = runningApp(args[1])
    let appEl = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(appEl, 3)
    var root: AXUIElement = appEl
    if let w = axAttr(appEl, kAXFocusedWindowAttribute) { root = w as! AXUIElement }
    guard let area = firstTextArea(root) else { die("no text area found in \(args[1])") }
    FileHandle.standardOutput.write(axString(area, kAXValueAttribute).data(using: .utf8)!)

default:
    usage()
}
