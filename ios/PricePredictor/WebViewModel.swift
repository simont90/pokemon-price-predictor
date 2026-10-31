import Combine
import UIKit
import WebKit

/// Hosts the live website in a WKWebView.
///
/// The app is deliberately a shell: every feature is the website's own code,
/// so a push to `main` reaches the app on its next launch with no rebuild.
/// What lives here is only what a browser provides and WKWebView does not:
/// JS dialogs, file downloads, external links, and recovery when iOS kills
/// the web content process in the background.
@MainActor
final class WebViewModel: NSObject, ObservableObject {

    static let appURL = URL(string: "https://simont90.github.io/pokemon-price-predictor/")!

    /// Matches `--bg` / `theme-color` on the site, so launch and reloads never flash white.
    static let background = UIColor(red: 14/255, green: 15/255, blue: 19/255, alpha: 1)
    /// `--accent`
    static let accent = UIColor(red: 232/255, green: 182/255, blue: 52/255, alpha: 1)

    let webView: WKWebView

    @Published var isLoading = true
    @Published var loadProgress: Double = 0
    @Published var isOffline = false

    private var progressObserver: NSKeyValueObservation?
    private var downloadDestinations: [ObjectIdentifier: URL] = [:]
    private var hasLoadedOnce = false

    override init() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        // Service workers only run in WKWebView for App-Bound Domains
        // (WKAppBoundDomains in the Info.plist). With them, sw.js caches the
        // site and the 26k-card catalogue, so the app opens offline after the
        // first launch exactly as the Home Screen web app does.
        config.limitsNavigationsToAppBoundDomains = true
        // Persistent store: localStorage (the collection, the sync pair code)
        // survives relaunches. It is separate from Safari's storage.
        config.websiteDataStore = .default()
        // Lets the site tell it is running inside the app if it ever needs to.
        config.applicationNameForUserAgent = "PricePredictorApp/1.0 Mobile/15E148 Safari/604.1"

        webView = WKWebView(frame: .zero, configuration: config)

        // The web app manages its own history via pushState / popstate.
        webView.allowsBackForwardNavigationGestures = false
        // Debug from Safari on the Mac: Develop → <iPhone> → Price Predictor.
        webView.isInspectable = true

        webView.isOpaque = false
        webView.backgroundColor = Self.background
        webView.scrollView.backgroundColor = Self.background
        // The site already pads for the notch / home indicator with
        // env(safe-area-inset-*) under viewport-fit=cover; don't double it.
        webView.scrollView.contentInsetAdjustmentBehavior = .never

        super.init()

        webView.navigationDelegate = self
        webView.uiDelegate = self

        let refresh = UIRefreshControl()
        refresh.tintColor = Self.accent
        refresh.addTarget(self, action: #selector(handleRefresh(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = refresh

        progressObserver = webView.observe(\.estimatedProgress, options: .new) { [weak self] _, change in
            let value = change.newValue ?? 0
            Task { @MainActor in self?.loadProgress = value }
        }

        load()
    }

    func load() {
        isOffline = false
        isLoading = true
        if hasLoadedOnce, webView.url != nil {
            webView.reload()
        } else {
            webView.load(URLRequest(url: Self.appURL))
        }
    }

    @objc private func handleRefresh(_ sender: UIRefreshControl) {
        webView.reload()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { sender.endRefreshing() }
    }

    private func isAppPage(_ url: URL) -> Bool {
        url.host == Self.appURL.host
    }

    private func openExternally(_ url: URL) {
        // UIApplication.open lets Universal Links land in the eBay / Collectr
        // apps when installed, and falls back to Safari otherwise.
        UIApplication.shared.open(url)
    }

    // MARK: Presentation helpers

    private func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        guard let root = scene?.keyWindow?.rootViewController ?? scene?.windows.first?.rootViewController
        else { return nil }
        var top = root
        while let presented = top.presentedViewController { top = presented }
        return top
    }

    private func present(_ vc: UIViewController) {
        if let pop = vc.popoverPresentationController {
            // iPad presents share sheets as popovers and needs an anchor.
            pop.sourceView = webView
            pop.sourceRect = CGRect(x: webView.bounds.midX, y: webView.bounds.midY, width: 0, height: 0)
            pop.permittedArrowDirections = []
        }
        topViewController()?.present(vc, animated: true)
    }

    private func showMessage(_ message: String) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert)
    }
}

// MARK: - WKNavigationDelegate

extension WebViewModel: WKNavigationDelegate {

    func webView(_ webView: WKWebView, didStartProvisionalNavigation _: WKNavigation!) {
        isLoading = true
        isOffline = false
    }

    func webView(_ webView: WKWebView, didFinish _: WKNavigation!) {
        isLoading = false
        hasLoadedOnce = true
    }

    func webView(_ webView: WKWebView, didFail _: WKNavigation!, withError error: Error) {
        isLoading = false
        handleError(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError error: Error) {
        isLoading = false
        handleError(error)
    }

    /// iOS reclaims the web content process when the app sits in the
    /// background; without this the app comes back to a blank screen.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    private func handleError(_ error: Error) {
        let nsError = error as NSError
        if nsError.code == NSURLErrorCancelled { return }
        let offline = [NSURLErrorNotConnectedToInternet,
                       NSURLErrorNetworkConnectionLost,
                       NSURLErrorTimedOut,
                       NSURLErrorCannotConnectToHost,
                       NSURLErrorCannotFindHost,
                       NSURLErrorDNSLookupFailed]
        // Only replace the page with the offline screen if there is no page
        // to show; once loaded, the service worker serves it offline.
        if offline.contains(nsError.code) && !hasLoadedOnce { isOffline = true }
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // <a download> — the backup export in Sync settings.
        if action.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        guard let url = action.request.url, let scheme = url.scheme?.lowercased() else {
            decisionHandler(.allow); return
        }
        // Subframes are left alone: redirecting them would bounce the user to
        // Safari whenever an embedded frame loads.
        let isMainFrame = action.targetFrame?.isMainFrame ?? true
        switch scheme {
        case "http", "https":
            if isAppPage(url) || !isMainFrame {
                decisionHandler(.allow)
            } else {
                openExternally(url)
                decisionHandler(.cancel)
            }
        case "about", "blob", "data":
            decisionHandler(.allow)
        default:
            // mailto:, tel:, sms:, app schemes.
            openExternally(url)
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction _: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse _: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }
}

// MARK: - WKDownloadDelegate

/// A browser saves downloads to disk; an app hands them to the share sheet,
/// which offers Save to Files, AirDrop, Mail and so on.
extension WebViewModel: WKDownloadDelegate {

    func download(_ download: WKDownload,
                  decideDestinationUsing _: URLResponse,
                  suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            completionHandler(nil); return
        }
        let name = suggestedFilename.isEmpty ? "download" : suggestedFilename
        let dest = dir.appendingPathComponent(name)
        downloadDestinations[ObjectIdentifier(download)] = dest
        completionHandler(dest)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = downloadDestinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
        present(UIActivityViewController(activityItems: [url], applicationActivities: nil))
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData _: Data?) {
        downloadDestinations.removeValue(forKey: ObjectIdentifier(download))
        showMessage("Download failed: \(error.localizedDescription)")
    }
}

// MARK: - WKUIDelegate

extension WebViewModel: WKUIDelegate {

    /// window.open() and target="_blank": external pages go to Safari or the
    /// matching app; pages of the site itself open in place.
    func webView(_ webView: WKWebView,
                 createWebViewWith _: WKWebViewConfiguration,
                 for action: WKNavigationAction,
                 windowFeatures _: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if isAppPage(url) {
                webView.load(action.request)
            } else {
                openExternally(url)
            }
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame _: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        guard let top = topViewController() else { completionHandler(); return }
        top.present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame _: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        guard let top = topViewController() else { completionHandler(false); return }
        top.present(alert, animated: true)
    }

    /// prompt() — used for naming groups and similar. Without this WKWebView
    /// returns null immediately and the action silently does nothing.
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame _: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in
            completionHandler(alert?.textFields?.first?.text ?? "")
        })
        guard let top = topViewController() else { completionHandler(nil); return }
        top.present(alert, animated: true)
    }
}
