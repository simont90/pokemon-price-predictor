import AuthenticationServices
import WebKit

/// Native Sign in with Apple for the website running inside the app.
///
/// The page calls
///     window.webkit.messageHandlers.appleSignIn.postMessage({ nonce })
/// with the SHA-256 of a one-time nonce. This shows Apple's own sheet
/// (Face ID / passcode), then answers by calling
///     window.__appleSignInResult({ idToken } | { cancelled: true } | { error })
/// The page posts the identity token and the raw nonce to the worker's
/// /auth/apple, which verifies it — nothing is trusted on this side.
///
/// Needs the Sign in with Apple capability (PricePredictor.entitlements),
/// which a paid developer team provides; a free Personal Team cannot sign it.
@MainActor
final class AppleSignInBridge: NSObject, WKScriptMessageHandler {

    static let messageName = "appleSignIn"

    weak var webView: WKWebView?
    private var controller: ASAuthorizationController?

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard controller == nil else { return }   // one sheet at a time
        let body = message.body as? [String: Any]
        guard let nonce = body?["nonce"] as? String, !nonce.isEmpty else {
            reply(["error": "Missing nonce."])
            return
        }
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = []   // no name or email: the account only needs the id
        request.nonce = nonce

        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        self.controller = controller
        controller.performRequests()
    }

    private func reply(_ payload: [String: Any]) {
        controller = nil
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript(
            "window.__appleSignInResult && window.__appleSignInResult(\(json));",
            completionHandler: nil)
    }
}

extension AppleSignInBridge: ASAuthorizationControllerDelegate {

    func authorizationController(controller: ASAuthorizationController,
                                 didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken,
              let token = String(data: tokenData, encoding: .utf8) else {
            reply(["error": "Apple returned no identity token."])
            return
        }
        reply(["idToken": token])
    }

    func authorizationController(controller: ASAuthorizationController,
                                 didCompleteWithError error: Error) {
        if let authError = error as? ASAuthorizationError, authError.code == .canceled {
            reply(["cancelled": true])
        } else {
            reply(["error": error.localizedDescription])
        }
    }
}

extension AppleSignInBridge: ASAuthorizationControllerPresentationContextProviding {
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        webView?.window ?? ASPresentationAnchor()
    }
}
