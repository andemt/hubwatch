import AppKit
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let serverURL = URL(string: "http://localhost:5080")!
    private var server: ServerProcess?
    private var mainWindow: MainWindowController!
    private var statusItem: NSStatusItem!
    private var loginItemMenuItem: NSMenuItem!
    private var quitting = false

    private static let backgroundHintKey = "ShownBackgroundHint"

    // MARK: Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        let launchedAtLogin = Self.wasLaunchedAsLoginItem()

        NSApp.mainMenu = MainMenu.build()
        setUpStatusItem()

        mainWindow = MainWindowController(appURL: serverURL)
        mainWindow.onHide = { [weak self] in self?.windowWasHidden() }

        // Started at login: record in the menu bar only, like --minimized on Windows.
        if !launchedAtLogin { showWindow() }
        startServer()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // Opened again from Finder, Launchpad or Spotlight while running: bring the window forward.
        showWindow()
        return false
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        quitting = true
        guard let server, server.isRunning else { return .terminateNow }
        // Let the server shut down cleanly (flushes the database and the log file) before exiting.
        server.stop {
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    // MARK: Server

    private func startServer() {
        ServerProcess.probeExisting(at: serverURL) { [weak self] existing in
            guard let self else { return }
            switch existing {
            case .withUI:
                // Already running (brew services, the command-line version, or left over after a crash): use that one.
                self.mainWindow.serverReady()
                return
            case .withoutUI:
                self.showError("Another HubWatch server is already using port 5080, but it has no web UI.",
                               details: "This is usually a development server (dotnet watch). Stop it and choose Restart.",
                               canRestart: true)
                return
            case .none:
                break
            }
            let server = ServerProcess(executable: Self.serverExecutable, url: self.serverURL)
            server.onExit = { [weak self] status, output in self?.serverExited(status: status, output: output) }
            do {
                try server.start()
            } catch {
                self.showError("HubWatch could not start.", details: error.localizedDescription, canRestart: false)
                return
            }
            self.server = server
            server.waitUntilReady(timeout: 60) { [weak self] ready in
                guard let self else { return }
                if ready {
                    self.mainWindow.serverReady()
                } else if server.isRunning {
                    self.showError("HubWatch did not start within a minute.", details: server.recentOutput, canRestart: true)
                }
                // Not ready and not running: serverExited reports it.
            }
        }
    }

    private func serverExited(status: Int32, output: String) {
        if quitting { return }
        server = nil
        if output.localizedCaseInsensitiveContains("address already in use") {
            showError("HubWatch could not start because its port (5080) is already in use.",
                      details: "Is another program using port 5080? If HubWatch runs as a Homebrew service, it is used automatically when it responds; try Restart.\n\n" + output,
                      canRestart: true)
        } else {
            showError("HubWatch stopped unexpectedly (exit code \(status)).", details: output, canRestart: true)
        }
    }

    private static var serverExecutable: URL {
        Bundle.main.resourceURL!.appendingPathComponent("server/HubWatch")
    }

    private func showError(_ message: String, details: String, canRestart: Bool) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = message
        let trimmed = details.trimmingCharacters(in: .whitespacesAndNewlines)
        alert.informativeText = trimmed.count > 1500 ? "…" + trimmed.suffix(1500) : trimmed
        if canRestart { alert.addButton(withTitle: "Restart") }
        alert.addButton(withTitle: "Quit HubWatch")
        let response = alert.runModal()
        if canRestart && response == .alertFirstButtonReturn {
            startServer()
        } else {
            quit()
        }
    }

    // MARK: Window

    private func showWindow() {
        // A Dock icon and the app menu while the window is open; menu bar only when it is closed.
        NSApp.setActivationPolicy(.regular)
        mainWindow.show()
        NSApp.activate(ignoringOtherApps: true)
    }

    private func windowWasHidden() {
        let defaults = UserDefaults.standard
        if !defaults.bool(forKey: Self.backgroundHintKey) {
            defaults.set(true, forKey: Self.backgroundHintKey)
            let alert = NSAlert()
            alert.messageText = "HubWatch is still recording"
            alert.informativeText = "HubWatch keeps running in the menu bar. Use its icon to open it again or to quit."
            alert.addButton(withTitle: "OK")
            alert.runModal()
        }
        NSApp.setActivationPolicy(.accessory)
    }

    // MARK: Menu bar icon

    private func setUpStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            let image = NSImage(systemSymbolName: "lightbulb", accessibilityDescription: "HubWatch")
            image?.isTemplate = true
            button.image = image
            button.toolTip = "HubWatch"
        }

        let menu = NSMenu()
        menu.addItem(withTitle: "Open HubWatch", action: #selector(openWindow(_:)), keyEquivalent: "")
        menu.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser(_:)), keyEquivalent: "")
        menu.addItem(.separator())
        loginItemMenuItem = menu.addItem(withTitle: "Open at Login", action: #selector(toggleLoginItem(_:)), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit HubWatch", action: #selector(quitFromMenu(_:)), keyEquivalent: "")
        for item in menu.items where !item.isSeparatorItem { item.target = self }
        menu.delegate = self
        statusItem.menu = menu
    }

    func menuWillOpen(_ menu: NSMenu) {
        loginItemMenuItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    @objc private func openWindow(_ sender: Any?) { showWindow() }

    @objc func openInBrowser(_ sender: Any?) { NSWorkspace.shared.open(serverURL) }

    @objc func reloadPage(_ sender: Any?) { mainWindow.reload() }

    @objc private func quitFromMenu(_ sender: Any?) { quit() }

    private func quit() {
        quitting = true
        NSApp.terminate(nil)
    }

    @objc private func toggleLoginItem(_ sender: Any?) {
        let service = SMAppService.mainApp
        do {
            if service.status == .enabled {
                try service.unregister()
            } else {
                try service.register()
                if service.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
            }
        } catch {
            let alert = NSAlert(error: error)
            alert.messageText = "HubWatch could not change Open at Login."
            alert.runModal()
        }
    }

    private static func wasLaunchedAsLoginItem() -> Bool {
        guard let event = NSAppleEventManager.shared().currentAppleEvent else { return false }
        return event.eventID == AEEventID(kAEOpenApplication)
            && event.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))?.enumCodeValue == OSType(keyAELaunchedAsLogInItem)
    }
}
