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

    public func pull() async {
        guard !pairCode.isEmpty else { status = "Enter your pair code first."; return }
        isSyncing = true; status = "Fetching…"
        defer { isSyncing = false }
        await client.setPairCode(pairCode)
        do {
            let snap = try await client.fetchSnapshot()
            owned = snap.value(.portfolio, as: [OwnedCard].self) ?? []
            lastSynced = snap.updatedAt
            status = snap.isEmpty
                ? "Nothing stored yet — press Sync now on the website first."
                : "\(owned.count) cards in the collection."
        } catch WorkerError.notConfigured {
            status = "Enter your pair code first."
        } catch {
            status = "Sync failed: \(error)"
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
