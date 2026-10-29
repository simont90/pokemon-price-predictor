import Foundation

/// Sync state and the owner's collection, read from the same worker blob the
/// web app writes. Nothing here recomputes a valuation: the model lives in one
/// place and this client renders what it is given.
@MainActor
public final class AppModel: ObservableObject {
    @Published public var pairCode: String = "" { didSet { persistPairCode() } }
    @Published public private(set) var owned: [OwnedCard] = []
    @Published public private(set) var lastSynced: Date?
    @Published public private(set) var status: String = ""
    @Published public private(set) var isSyncing = false
    @Published public var fxRate: Double = 0.7559      // GBP per USD; refreshed on launch

    private let client = WorkerClient()
    /// The website's model, running on-device. Shared so it loads once.
    public let bridge = ModelBridge()
    private let pairKey = "pairCode"

    public init() {
        pairCode = UserDefaults.standard.string(forKey: pairKey) ?? ""
        Task { await refreshFX() }
    }

    private func persistPairCode() {
        // A pair code is a credential; UserDefaults is a placeholder and this
        // belongs in the Keychain before the app leaves the simulator.
        UserDefaults.standard.set(pairCode, forKey: pairKey)
    }

    public func gbp(_ usd: Double) -> Double { usd * fxRate }

    public func formatGBP(_ gbp: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "GBP"
        f.locale = Locale(identifier: "en_GB")
        return f.string(from: NSNumber(value: gbp)) ?? "£0"
    }

    /// The worker's contract, which the website's generator also follows: 24
    /// random bytes base64url-encoded, so 32 characters. Checking it here turns
    /// a doomed round-trip and a raw 400 into a sentence that says what to do.
    public var pairCodeProblem: String? {
        let c = pairCode.trimmingCharacters(in: .whitespacesAndNewlines)
        if c.isEmpty { return nil }
        if c.range(of: "^[A-Za-z0-9_-]{16,64}$", options: .regularExpression) == nil {
            return c.count < 16
                ? "That is \(c.count) characters. The code is 32 — copy the whole thing from the website's Sync panel."
                : "Letters, digits, underscore and hyphen only, 16–64 characters."
        }
        return nil
    }

    public var canPull: Bool {
        !pairCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && pairCodeProblem == nil && !isSyncing
    }

    public func pull() async {
        let code = pairCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty else { status = "Enter your pair code first."; return }
        if let problem = pairCodeProblem { status = problem; return }

        isSyncing = true; status = "Fetching…"
        defer { isSyncing = false }
        await client.setPairCode(code)
        do {
            let snap = try await client.fetchSnapshot()
            owned = snap.value(.portfolio, as: [OwnedCard].self) ?? []
            lastSynced = snap.updatedAt
            status = snap.isEmpty
                ? "The code worked, but nothing is stored under it yet. Press Sync now on the website."
                : "Pulled \(owned.count) cards."
        } catch WorkerError.notConfigured {
            status = "Enter your pair code first."
        } catch WorkerError.badStatus(let code, let body) {
            // Surface the worker's own sentence, not a Swift enum dump.
            let detail = (try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any])
                .flatMap { ($0?["detail"] as? String) ?? ($0?["error"] as? String) }
            status = detail ?? "The worker refused the request (\(code))."
        } catch WorkerError.creditsExhausted {
            status = "Collectr credits are spent — that is recoverable, top up on parse.bot."
        } catch {
            status = "Could not reach the worker. Check the connection and try again."
        }
    }

    public func checkHealth() async -> Bool { (try? await client.health()) ?? false }

    /// The web app treats the rate as global rather than user data and never
    /// blocks startup on it, so this refreshes in the background and keeps the
    /// last good value on failure.
    private func refreshFX() async {
        struct R: Decodable { let rates: [String: Double] }
        guard let url = URL(string: "https://open.er-api.com/v6/latest/USD"),
              let (d, _) = try? await URLSession.shared.data(from: url),
              let r = try? JSONDecoder().decode(R.self, from: d),
              let gbp = r.rates["GBP"], gbp > 0 else { return }
        fxRate = gbp
    }
}
