import Combine
import WebKit

class WebViewModel: NSObject, ObservableObject {

    let webView: WKWebView

    @Published var isLoading = true
    @Published var loadProgress: Double = 0
    @Published var isOffline = false

    private let appURL = URL(string: "https://simont90.github.io/pokemon-price-predictor/")!
    private var progressObserver: NSKeyValueObservation?

    override init() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        // Allow the JS localStorage / history API to work fully
        let prefs = WKWebpagePreferences()
        prefs.allowsContentJavaScript = true
        config.defaultWebpagePreferences = prefs

        webView = WKWebView(frame: .zero, configuration: config)

        // Disable WKWebView's own back/forward gesture — the web app manages
        // its own history stack via history.pushState and handles popstate.
        webView.allowsBackForwardNavigationGestures = false

        // Make the web view background match the app's dark theme so there's
        // no white flash during load.
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 14/255, green: 15/255, blue: 19/255, alpha: 1)
        webView.scrollView.backgroundColor = UIColor(red: 14/255, green: 15/255, blue: 19/255, alpha: 1)

        super.init()

        webView.navigationDelegate = self
        webView.uiDelegate = self

        // Pull-to-refresh
        let refresh = UIRefreshControl()
        refresh.tintColor = UIColor(red: 232/255, green: 182/255, blue: 52/255, alpha: 1)
        refresh.addTarget(self, action: #selector(handleRefresh(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = refresh

        // Native loading progress bar driven by KVO
        progressObserver = webView.observe(\.estimatedProgress, options: .new) { [weak self] _, change in
            DispatchQueue.main.async {
                self?.loadProgress = change.newValue ?? 0
            }
        }

        load()
    }

    func load() {
        isOffline = false
        isLoading = true
        webView.load(URLRequest(url: appURL))
    }

    @objc private func handleRefresh(_ sender: UIRefreshControl) {
        webView.reload()
        // End refreshing after a short delay so the spinner is visible
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            sender.endRefreshing()
        }
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
    }

    func webView(_ webView: WKWebView, didFail _: WKNavigation!, withError error: Error) {
        isLoading = false
        handleError(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError error: Error) {
        isLoading = false
        handleError(error)
    }

    private func handleError(_ error: Error) {
        let code = (error as NSError).code
        let offline = [NSURLErrorNotConnectedToInternet,
                       NSURLErrorNetworkConnectionLost,
                       NSURLErrorTimedOut,
                       NSURLErrorCannotConnectToHost]
        if offline.contains(code) { isOffline = true }
    }

    // Keep all navigation inside the WKWebView; open external links in Safari
    func webView(_ webView: WKWebView,
                 decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.allow); return }

        // Allow same-origin and about:blank
        if url.host == appURL.host || url.scheme == "about" {
            decisionHandler(.allow)
            return
        }
        // External link → hand off to Safari
        if ["http", "https"].contains(url.scheme ?? "") {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}

// MARK: - WKUIDelegate
extension WebViewModel: WKUIDelegate {
    // Handle window.open() — load in the same view instead of a new window
    func webView(_ webView: WKWebView,
                 createWebViewWith _: WKWebViewConfiguration,
                 for action: WKNavigationAction,
                 windowFeatures _: WKWindowFeatures) -> WKWebView? {
        if action.targetFrame?.isMainFrame != true {
            webView.load(action.request)
        }
        return nil
    }

    // Native alert / confirm / prompt passthrough
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame _: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        topViewController()?.present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame _: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        topViewController()?.present(alert, animated: true)
    }

    private func topViewController() -> UIViewController? {
        guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
              let root = scene.windows.first?.rootViewController else { return nil }
        var top: UIViewController = root
        while let presented = top.presentedViewController { top = presented }
        return top
    }
}
