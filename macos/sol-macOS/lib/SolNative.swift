import Foundation
import HotKey
import LaunchAtLogin

private let keychain = Keychain(service: "com.pcstyle.bettercast")

@objc(SolNative)
class SolNative: RCTEventEmitter {
  let appDelegate = NSApp.delegate as? AppDelegate

  override init() {
    super.init()
    SolEmitter.sharedInstance.registerEmitter(emitter: self)
    ApplicationSearcher.shared.onApplicationsChanged = {
      self.sendEvent(
        withName: "applicationsChanged",
        body: [])
    }
  }

  @objc override func constantsToExport() -> [AnyHashable: Any]! {
    return [
      "accentColor": NSColor.controlAccentColor.usingColorSpace(.sRGB)!
        .hexString,
      "OSVersion": ProcessInfo.processInfo.operatingSystemVersion.majorVersion,
    ]
  }

  @objc override func startObserving() {
    SolEmitter.sharedInstance.hasListeners = true
  }

  @objc override func stopObserving() {
    SolEmitter.sharedInstance.hasListeners = false
  }

  @objc override static func requiresMainQueueSetup() -> Bool {
    return true
  }

  func sendKeyDown(characters: String) {
    sendEvent(
      withName: "keyDown",
      body: [
        "key": characters
      ])
  }

  @objc override func supportedEvents() -> [String]? {
    return [
      "keyDown",
      "keyUp",
      "onShow",
      "onHide",
      "onTextCopied",
      "onFileCopied",
      "onFileSearch",
      "onStatusBarItemClick",
      "hotkey",
      "applicationsChanged",
      "clipboardChanged",
      "workspaceChunk",
    ]
  }

  @objc func getApps(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    let apps = ApplicationSearcher.shared.getAllApplications()
    resolve(apps)
  }

  @objc func openFile(_ path: String) {
    // This is deprecated but it opens the apps with a single line of code
    NSWorkspace.shared.openFile(path)
  }

  @objc func openWithFinder(_ path: String) {
    guard let URL = URL(string: path) else {
      return
    }

    let configuration = NSWorkspace.OpenConfiguration()
    configuration.promptsUserIfNeeded = true

    let finder = NSWorkspace.shared
      .urlForApplication(withBundleIdentifier: "com.apple.finder")
    NSWorkspace.shared.open(
      [URL],
      withApplicationAt: finder!,
      configuration: configuration
    )
  }

  @objc func toggleDarkMode() {
    DarkMode.isEnabled = !DarkMode.isEnabled
  }

  @objc func executeAppleScript(
    _ source: String, resolve: RCTPromiseResolveBlock,
    reject: RCTPromiseRejectBlock
  ) {

    let error = AppleScriptHelper.runAppleScript(source)
    if error == nil {
      resolve(nil)
    } else {
      reject(
        "AppleScriptError",
        error!["NSAppleScriptErrorMessage"] as? String,
        nil
      )
    }
  }

  @objc func executeBashScript(
    _ source: String,
    resolver: RCTPromiseResolveBlock,
    rejecter _: RCTPromiseRejectBlock
  ) {
    let output = ShellHelper.shWithFloatingPanel(source)
    resolver(output)
  }

  @objc func getAIProviders(
    _ resolve: RCTPromiseResolveBlock,
    rejecter _: RCTPromiseRejectBlock
  ) {
    resolve([
      ["provider": "claude", "available": AIProcess.claudeExecutable() != nil],
      ["provider": "codex", "available": false],
    ])
  }

  @objc func runAI(
    _ request: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let provider = request["provider"] as? String, provider == "claude",
          let id = request["requestId"] as? String,
          let prompt = request["prompt"] as? String else {
      reject(AIProcessError.invalidRequest.rawValue, "Only Claude is supported", nil)
      return
    }
    guard let executable = AIProcess.claudeExecutable() else {
      reject(AIProcessError.unavailable.rawValue, "Claude CLI is not installed", nil)
      return
    }
    AIProcess.shared.run(
      id: id, prompt: prompt, executable: executable,
      arguments: AIProcess.claudeArguments
    ) { result in
      switch result {
      case .failure(let error):
        let message = error == .failed
          ? "Claude failed; verify CLI supports --safe-mode and --permission-prompts none"
          : "AI request failed (\(error.rawValue))"
        reject(error.rawValue, message, nil)
      case .success(let output):
        guard let text = AIProcess.parseClaudeResponse(output) else {
          reject(AIProcessError.failed.rawValue, "Claude returned an invalid response", nil)
          return
        }
        resolve(["text": text])
      }
    }
  }

  @objc func cancelAI(_ requestId: String) {
    AIProcess.shared.cancel(requestId)
  }

  @objc func clipboardRequest(_ request: NSDictionary, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      ClipboardCapture.shared.start()
      ClipboardCapture.shared.onChange = { [weak self] in self?.sendEvent(withName: "clipboardChanged", body: [:]) }
    }
    let repository = ClipboardRepository.shared
    repository.work.async {
      do {
        try repository.open()
        switch request["op"] as? String {
        case "status": resolve(try repository.status())
        case "configure": resolve(try repository.configure(request["config"] as? [String: Any] ?? [:]))
        case "query":
          let query = request["query"] as? [String: Any] ?? [:]
          resolve(try repository.page(text: query["text"] as? String ?? "", kinds: query["kinds"] as? [String] ?? [], since: query["since"] as? Double, offset: request["offset"] as? Int ?? 0))
        case "queue":
          guard let queue = request["queue"] as? [String: Any], let ids = queue["itemIds"] as? [String], ids.count <= 200 else { throw ClipboardRepositoryError.invalidRequest }
          try repository.setMetadata("queue", queue); resolve([:])
        case "clear": try repository.clear(); resolve([:])
        case "attachment":
          guard let id = request["id"] as? String else { throw ClipboardRepositoryError.invalidRequest }
          let payload = try repository.read(id: id)
          let representations = payload["representations"] as? [String: Data] ?? [:]
          if let type = ["public.png", "public.jpeg"].first(where: { representations[$0] != nil }), let data = representations[type], data.count <= 8_388_608 {
            resolve(["kind": "image", "mimeType": type == "public.png" ? "image/png" : "image/jpeg", "data": data.base64EncodedString(), "bytes": data.count])
          } else if let text = payload["text"] as? String, text.utf8.count <= 128_000 { resolve(["kind": "text", "text": text, "bytes": text.utf8.count]) }
          else { throw ClipboardRepositoryError.invalidRequest }
        case "action":
          guard let id = request["id"] as? String, let action = request["action"] as? String else { throw ClipboardRepositoryError.invalidRequest }
          if action == "delete" { try repository.delete(ids: [id]); resolve(["status": "done"]); return }
          if action == "pin" || action == "unpin" { try repository.pin(id: id, pinned: action == "pin"); resolve(["status": "done"]); return }
          let payload = try repository.read(id: id)
          DispatchQueue.main.async {
            if action == "reveal", let files = payload["files"] as? [String], !files.isEmpty {
              NSWorkspace.shared.activateFileViewerSelecting(files.map { URL(fileURLWithPath: $0) }); resolve(["status": "done"])
            } else if action == "saveImage" {
              let representations = payload["representations"] as? [String: Data] ?? [:]
              guard let type = ["public.png", "public.jpeg", "public.tiff"].first(where: { representations[$0] != nil }), let data = representations[type] else { resolve(["status": "failed", "message": "No supported original image representation."]); return }
              let panel = NSSavePanel(); panel.nameFieldStringValue = "Clipboard.\(type == "public.png" ? "png" : type == "public.jpeg" ? "jpg" : "tiff")"
              panel.begin { response in
                guard response == .OK, let url = panel.url else { resolve(["status": "failed", "message": "Save cancelled"]); return }
                repository.work.async { do { try data.write(to: url, options: .atomic); resolve(["status": "done"]) } catch { reject("CLIPBOARD_SAVE", "Could not save original image", nil) } }
              }
            } else if ["paste", "pastePlain", "copy"].contains(action) { ClipboardCapture.shared.deliver(payload: payload, action: action, completion: resolve) }
            else { resolve(["status": "failed", "message": "Action is not supported for this item."]) }
          }
        default: throw ClipboardRepositoryError.invalidRequest
        }
      } catch { reject("CLIPBOARD_ERROR", "Clipboard operation failed (\(error)). No delivery is confirmed.", nil) }
    }
  }

  @objc func workspaceRequest(_ request: NSDictionary, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    let operation = request["op"] as? String ?? ""
    let id = request["id"] as? String ?? UUID().uuidString
    if operation == "cancel" { AIWorkspace.cancel(id: id); AIWorkspace.closeStdioSession(id: id); AIProcess.shared.cancel(id); resolve([:]); return }
    if operation == "pasteText" {
      guard let text = request["text"] as? String, text.utf8.count <= 1_048_576 else { reject("WORKSPACE_INPUT", "Invalid insertion", nil); return }
      DispatchQueue.main.async { ClipboardCapture.shared.deliver(payload: ["text": text, "files": [], "representations": ["public.utf8-plain-text": Data(text.utf8)]], action: "paste", completion: resolve) }; return
    }
    if operation == "claude" || operation == "script" {
      let executable = operation == "claude" ? AIProcess.claudeExecutable() : (request["executable"] as? String).map { URL(fileURLWithPath: $0) }
      guard let executable else { reject("WORKSPACE_UNAVAILABLE", "Required executable is unavailable", nil); return }
      let arguments = operation == "claude" ? AIProcess.claudeStreamingArguments : request["arguments"] as? [String] ?? []
      let prompt = operation == "claude" ? request["prompt"] as? String ?? "" : "\n"
      AIProcess.shared.run(id: id, prompt: prompt, executable: executable, arguments: arguments, timeout: min(120, max(1, request["timeout"] as? Double ?? 120)), currentDirectory: (request["cwd"] as? String).map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory, onChunk: { chunk in
        DispatchQueue.main.async { self.sendEvent(withName: "workspaceChunk", body: ["id": id, "bytes": Array(chunk)]) }
      }) { result in
        DispatchQueue.main.async { switch result { case .success(let output): resolve(["output": output]); case .failure(let error): reject(error.rawValue, "Process failed (\(error.rawValue))", nil) } }
      }
      return
    }
    Task {
      do {
        switch operation {
        case "saveKey":
          guard let account = request["account"] as? String, let value = request["value"] as? String else { throw AIWorkspaceError.invalidRequest("Key requires account and value") }
          try AIWorkspace.storeAPIKey(value, account: account); resolve([:])
        case "http":
          guard let endpoint = request["endpoint"] as? String, let url = URL(string: endpoint), let body = request["body"] as? String else { throw AIWorkspaceError.invalidRequest("HTTP requires endpoint and body") }
          let config = AIHTTPConfiguration(endpoint: url, approvedEndpoints: [url], headers: request["headers"] as? [String: String] ?? [:], keychainAccount: request["account"] as? String, timeout: 120)
          for try await chunk in AIWorkspace.streamHTTP(id: id, configuration: config, body: Data(body.utf8), onResponse: { status, headers in
            DispatchQueue.main.async { self.sendEvent(withName: "workspaceChunk", body: ["id": id, "status": status, "headers": headers]) }
          }) {
            DispatchQueue.main.async { self.sendEvent(withName: "workspaceChunk", body: ["id": id, "bytes": Array(chunk)]) }
          }
          DispatchQueue.main.async { resolve([:]) }
        case "attachment":
          guard let path = request["path"] as? String else { throw AIWorkspaceError.invalidRequest("Select a file") }
          let data = try await AIWorkspace.readAttachment(path: path, selectedPaths: [path], maxBytes: 8_388_608)
          let ext = URL(fileURLWithPath: path).pathExtension.lowercased()
          if ["png", "jpg", "jpeg", "gif", "webp"].contains(ext) { resolve(["kind": "image", "mimeType": "image/\(ext == "jpg" ? "jpeg" : ext)", "bytes": data.count, "data": data.base64EncodedString()]) }
          else if ext == "pdf" { resolve(["kind": "pdf", "bytes": data.count, "unsupported": "PDF extraction is not available; choose a text or image attachment."]) }
          else if let text = String(data: data, encoding: .utf8), data.count <= 128_000 { resolve(["kind": "text", "bytes": data.count, "text": text]) }
          else { resolve(["kind": "other", "bytes": data.count, "unsupported": "Not a supported UTF-8 text or image file (text limit 128 KB)."] ) }
        case "stdioOpen":
          guard let executable = request["executable"] as? String else { throw AIWorkspaceError.invalidRequest("Missing executable") }
          try AIWorkspace.openStdioSession(id: id, executable: URL(fileURLWithPath: executable), arguments: request["arguments"] as? [String] ?? []); resolve([:])
        case "stdioSend":
          guard let body = request["body"] as? String else { throw AIWorkspaceError.invalidRequest("Missing JSON") }
          let data = try await AIWorkspace.stdioRequest(sessionID: id, json: Data(body.utf8))
          resolve(data.isEmpty ? [:] : try JSONSerialization.jsonObject(with: data))
        case "stdioClose": AIWorkspace.closeStdioSession(id: id); resolve([:])
        case "readDocument": resolve(try LocalVault.read(id: id))
        case "writeDocument":
          guard let value = request["value"] as? String else { throw AIWorkspaceError.invalidRequest("Missing document") }
          try LocalVault.write(id: id, text: value); resolve([:])
        case "deleteDocument": try LocalVault.delete(id: id); resolve([:])
        default: throw AIWorkspaceError.invalidRequest("Unknown workspace operation")
        }
      } catch { reject("WORKSPACE_ERROR", "Workspace operation failed: \(error)", nil) }
    }
  }

  @objc func getMediaInfo(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: RCTPromiseRejectBlock
  ) {
    MediaHelper.getCurrentMedia(callback: { information in
      let pathUrl = NSWorkspace.shared
        .urlForApplication(
          withBundleIdentifier: information["bundleIdentifier"]! as! String
        )?
        .path
      let imageData =
        information["kMRMediaRemoteNowPlayingInfoArtworkData"] as? Data

      if imageData == nil {
        resolve([
          "title": information["kMRMediaRemoteNowPlayingInfoTitle"],
          "artist": information["kMRMediaRemoteNowPlayingInfoArtist"],
          "bundleIdentifier": information["bundleIdentifier"],
          "url": pathUrl,
        ])
      } else {
        let bitmap = NSBitmapImageRep(data: imageData!)
        let data = bitmap?.representation(using: .jpeg, properties: [:])
        let base64 =
          data != nil
          ? "data:image/jpeg;base64,"
            + data!
            .base64EncodedString() : nil
        resolve([
          "title": information["kMRMediaRemoteNowPlayingInfoTitle"],
          "artist": information["kMRMediaRemoteNowPlayingInfoArtist"],
          "artwork": base64,
          "bundleIdentifier": information["bundleIdentifier"],
          "url": pathUrl,
        ])
      }

    })
  }

  @objc func setGlobalShortcut(_ key: String) {
    HotKeyManager.shared.mainHotKey?.isPaused = true
    HotKeyManager.shared.mainHotKey = nil
    if key == "command" {
      HotKeyManager.shared.mainHotKey = HotKey(
        key: .space,
        modifiers: [.command],
        keyDownHandler: PanelManager.shared.toggle
      )
    } else if key == "option" {
      HotKeyManager.shared.mainHotKey = HotKey(
        key: .space,
        modifiers: [.option],
        keyDownHandler: PanelManager.shared.toggle
      )
    } else if key == "control" {
      HotKeyManager.shared.mainHotKey = HotKey(
        key: .space,
        modifiers: [.control],
        keyDownHandler: PanelManager.shared.toggle
      )
    }
  }

  @objc func getAccessibilityStatus(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: RCTPromiseRejectBlock
  ) {
    resolve(AXIsProcessTrusted())
  }

  @objc func requestAccessibilityAccess(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: RCTPromiseRejectBlock
  ) {
    let options: NSDictionary = [
      kAXTrustedCheckOptionPrompt.takeRetainedValue() as NSString: true
    ]
    let accessibilityEnabled = AXIsProcessTrustedWithOptions(options)
    resolve(accessibilityEnabled)
  }

  @objc func setLaunchAtLogin(_ enabled: Bool) {
    if LaunchAtLogin.isEnabled != enabled {
      LaunchAtLogin.isEnabled = enabled
    }
  }

  @objc func resizeFrontmostTopHalf() {
    WindowManager.sharedInstance.moveHalf(.top)
  }

  @objc func resizeFrontmostBottomHalf() {
    DispatchQueue.main.async { WindowManager.sharedInstance.moveHalf(.bottom) }
  }

  @objc func resizeFrontmostRightHalf() {
    DispatchQueue.main.async { WindowManager.sharedInstance.moveHalf(.right) }
  }

  @objc func resizeFrontmostLeftHalf() {
    DispatchQueue.main.async { WindowManager.sharedInstance.moveHalf(.left) }
  }

  @objc func resizeFrontmostFullscreen() {
    DispatchQueue.main.async { WindowManager.sharedInstance.fullscreen() }
  }

  @objc func resizeTopLeft() {
    DispatchQueue.main.async { WindowManager.sharedInstance.moveQuarter(.topLeft) }
  }

  @objc func resizeTopRight() {
    DispatchQueue.main.async { WindowManager.sharedInstance.moveQuarter(.topRight) }
  }

  @objc func resizeBottomLeft() {
    DispatchQueue.main.async { WindowManager.sharedInstance.moveQuarter(.bottomLeft) }
  }

  @objc func resizeBottomRight() {
    DispatchQueue.main.async { WindowManager.sharedInstance.moveQuarter(.bottomRight) }
  }

  @objc func resizeLeftThird() {
    DispatchQueue.main.async { WindowManager.sharedInstance.moveThird(.left) }
  }

  @objc func resizeCenterThird() {
    DispatchQueue.main.async { WindowManager.sharedInstance.moveThird(.center) }
  }

  @objc func resizeRightThird() {
    DispatchQueue.main.async { WindowManager.sharedInstance.moveThird(.right) }
  }

  @objc func resizeLeftTwoThirds() {
    DispatchQueue.main.async { WindowManager.sharedInstance.moveTwoThirds(.left) }
  }

  @objc func resizeRightTwoThirds() {
    DispatchQueue.main.async { WindowManager.sharedInstance.moveTwoThirds(.right) }
  }

  @objc func moveFrontmostNextScreen() {
    DispatchQueue.main.async { WindowManager.sharedInstance.moveToNextScreen() }
  }

  @objc func moveFrontmostPrevScreen() {
    DispatchQueue.main.async { WindowManager.sharedInstance.moveToPrevScreen() }
  }

  @objc func moveFrontmostCenter() {
    DispatchQueue.main.async { WindowManager.sharedInstance.center() }
  }

  @objc func moveFrontmostToNextSpace() {
    DispatchQueue.main.async { WindowManager.sharedInstance.moveFrontmostToNextSpace() }
  }

  @objc func moveFrontmostToPreviousSpace() {
    DispatchQueue.main.async { WindowManager.sharedInstance.moveFrontmostToPreviousSpace() }
  }

  @objc func pasteToFrontmostApp(_ content: String) {
    ClipboardHelper.pasteToFrontmostApp(content)
  }

  @objc func pasteImageToFrontmostApp(_ path: String) {
    ClipboardHelper.pasteImageFileToFrontmostApp(path)
  }

  @objc func insertToFrontmostApp(_ content: String) {
    ClipboardHelper.insertToFrontmostApp(content)
  }

  @objc func turnOnHorizontalArrowsListeners() {
    HotKeyManager.shared.catchHorizontalArrowsPress = true
  }

  @objc func turnOffHorizontalArrowsListeners() {
    HotKeyManager.shared.catchHorizontalArrowsPress = false
  }

  @objc func turnOnVerticalArrowsListeners() {
    HotKeyManager.shared.catchVerticalArrowsPress = true
  }

  @objc func turnOffVerticalArrowsListeners() {
    HotKeyManager.shared.catchVerticalArrowsPress = false
  }

  @objc func turnOnEnterListener() {
    HotKeyManager.shared.catchEnterPress = true
  }

  @objc func turnOffEnterListener() {
    HotKeyManager.shared.catchEnterPress = false
  }

  @objc func checkForUpdates() {
    appDelegate?.checkForUpdates()
  }

  @objc func setWindowRelativeSize(_ relative: NSNumber) {
    DispatchQueue.main.async {
      PanelManager.shared.setRelativeSize(relative as! Double)
    }
  }

  @objc func openFinderAt(_ path: String) {
    NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
  }

  @objc func setShowWindowOn(_ on: String) {
    switch on {
    case "screenWithFrontmost":
      PanelManager.shared.setPreferredScreen(.frontmost)
      break
    default:
      PanelManager.shared.setPreferredScreen(.withMouse)
      break
    }
  }

  @objc func toggleDND() {
    DoNotDisturb.toggle()
  }

  @objc func securelyStore(
    _ key: NSString,
    payload: NSString,
    resolver: RCTPromiseResolveBlock,
    rejecter _: RCTPromiseRejectBlock
  ) {
    keychain[key as String] = payload as String
    resolver(true)
  }

  @objc func securelyRetrieve(
    _ key: NSString,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter _: RCTPromiseRejectBlock
  ) {
    let value = keychain[key as String]
    return resolve(value)
  }

  @objc func showToast(_ text: String, variant: String, timeout: NSNumber) {
    DispatchQueue.main.async {
      ToastManager.shared.showToast(
        text, variant: variant, timeout: timeout, image: nil)
    }
  }

  @objc func useBackgroundOverlay(_ v: Bool) {
    //    appDelegate?.useBackgroundOverlay = v
  }

  @objc func hideNotch() {
    NotchHelper.shared.hideNotch()
  }

  @objc func showWifiQR(_ SSID: String, password: String) {
    let image = WifiQR(name: SSID, password: password)
    DispatchQueue.main.async {
      let wifiInfo = "SSID: \(SSID)\nPassword: \(password)"
      ToastManager.shared.showToast(
        wifiInfo, variant: "none", timeout: 30, image: image)
    }
  }

  @objc func hasFullDiskAccess(
    _ resolve: RCTPromiseResolveBlock,
    rejecter _: RCTPromiseRejectBlock
  ) {
    resolve(BookmarkHelper.hasFullDiskAccess())
  }

  @objc func getSafariBookmarks(
    _ resolve: RCTPromiseResolveBlock,
    rejecter _: RCTPromiseRejectBlock
  ) {
    let bookmarks = BookmarkHelper.getSafariBookmars()
    resolve(bookmarks)
  }

  @objc func quit() {
    DispatchQueue.main.async {
      NSApplication.shared.terminate(self)
    }
  }

  @objc func setStatusBarItemTitle(_ title: String) {
    StatusBarItemManager.shared.setStatusBarTitle(title)
  }

  @objc func setMediaKeyForwardingEnabled(_ v: Bool) {
    DispatchQueue.main.async {
      self.appDelegate?.setMediaKeyForwardingEnabled(v)
    }
  }

  @objc func openFilePicker(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let panel = NSOpenPanel()
      panel.allowsMultipleSelection = false
      panel.canChooseDirectories = true
      panel.canChooseFiles = false
      if panel.runModal() == .OK {
        let fileName = panel.url?.absoluteString
        resolve(fileName)
      } else {
        reject(nil, nil, nil)
      }
    }
  }

  @objc func updateHotkeys(_ hotkeys: NSDictionary) {
    guard let hotkeys = hotkeys as? [String: String] else { return }
    HotKeyManager.shared.updateHotkeys(hotkeyMap: hotkeys)
  }

  @objc func setUpcomingEventEnabled(_ enabled: Bool) {
    StatusBarCalendarManager.shared.enabled = enabled
  }

  @objc func setHyperKeyEnabled(_ enabled: Bool) {
    if enabled {
      DispatchQueue.main.async {
        HotKeyManager.shared.setupCapsLockMonitoring()
      }
    } else {
      DispatchQueue.main.async {

        HotKeyManager.shared.resetCapsLockMonitoring()
      }
    }
  }

}
