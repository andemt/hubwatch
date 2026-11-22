import AppKit
import WebKit

/// The HubWatch window: the web UI in a WKWebView. Closing it only hides it; links to other sites open in the
/// default browser.
final class MainWindowController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private let window: NSWindow
    private let webView: WKWebView
    private let appURL: URL
    private var serverIsReady = false

    /// Called after the user closed (hid) the window.
    var onHide: (() -> Void)?

    init(appURL: URL) {
        self.appURL = appURL
        webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        super.init()

        window.title = "HubWatch"
        window.minSize = NSSize(width: 480, height: 400)
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.delegate = self
        window.center()
        // Restores the size and position from the previous run, if any.
        window.setFrameAutosaveName("HubWatchMainWindow")

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.underPageBackgroundColor = .windowBackgroundColor // matches light/dark mode while loading
        if #available(macOS 13.3, *) { webView.isInspectable = true } // Safari > Develop, for debugging
        webView.loadHTMLString(Self.startingPage, baseURL: nil)
    }

    func show() {
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
    }

    func serverReady() {
        serverIsReady = true
        webView.load(URLRequest(url: appURL))
    }

    func reload() {
        if serverIsReady { webView.reload() }
    }

    // MARK: NSWindowDelegate

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // The close button hides the window; HubWatch keeps recording in the menu bar.
        window.orderOut(nil)
        onHide?()
        return false
    }

    // MARK: Navigation

    private func isAppURL(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        return ["localhost", "127.0.0.1", "::1"].contains(host) && url.port == appURL.port
    }

    private static func openExternally(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) else { return }
        NSWorkspace.shared.open(url)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        let scheme = url.scheme?.lowercased() ?? ""
        if isAppURL(url) || !["http", "https", "mailto"].contains(scheme) {
            // HubWatch itself, plus about:, data: and blob: URLs.
            decisionHandler(.allow)
        } else {
            Self.openExternally(url)
            decisionHandler(.cancel)
        }
    }

    // target="_blank" and window.open: open in the default browser instead of a new window.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { Self.openExternally(url) }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if serverIsReady { webView.reload() }
    }

    // MARK: JavaScript dialogs (WKWebView shows nothing unless the app does)

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    private static let startingPage = """
        <!doctype html>
        <html><head><meta charset="utf-8"><style>
          :root { color-scheme: light dark; }
          body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
                 font: 15px -apple-system, system-ui, sans-serif; color: #666; }
          @media (prefers-color-scheme: dark) { body { color: #aaa; } }
        </style></head>
        <body>Starting HubWatch…</body></html>
        """
}
