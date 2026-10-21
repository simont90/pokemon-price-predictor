import Foundation

/// The cross-device blob the worker stores at `GET/PUT /sync?key=<pair-code>`.
///
/// The envelope is `{ "data": { "<key>": "<raw JSON string>" }, "ts": 123 }` —
/// every value is a **string holding JSON**, not a nested object, because the
/// web client writes `localStorage` verbatim. A sort order is the bare string
/// `"dex"` and parsing that as JSON throws, so each key is decoded on demand
/// and a failure on one key never costs the others.
public struct SyncSnapshot: Sendable {
    public let raw: [String: String]
    public let timestamp: Int

    public init(raw: [String: String], timestamp: Int) {
        self.raw = raw
        self.timestamp = timestamp
    }

    public var isEmpty: Bool { raw.isEmpty }
    public var updatedAt: Date? { timestamp > 0 ? Date(timeIntervalSince1970: TimeInterval(timestamp) / 1000) : nil }

    /// Decode one synced key. Returns nil rather than throwing: a key the web
    /// app has never written is absent, which is normal, not an error.
    public func value<T: Decodable>(_ key: SyncKey, as type: T.Type) -> T? {
        guard let s = raw[key.rawValue], let data = s.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    /// For the keys that hold a bare string rather than JSON (`pkm-binder-sort-v1`).
    public func string(_ key: SyncKey) -> String? {
        guard let s = raw[key.rawValue] else { return nil }
        if let d = s.data(using: .utf8), let unwrapped = try? JSONDecoder().decode(String.self, from: d) { return unwrapped }
        return s
    }

    public func double(_ key: SyncKey) -> Double? {
        guard let s = raw[key.rawValue] else { return nil }
        if let d = s.data(using: .utf8), let v = try? JSONDecoder().decode(Double.self, from: d) { return v }
        return Double(s)
    }
}

/// The synced surface. Mirrors `SYNC_KEYS` in app.js; anything not prefixed
/// `pkm-` is deliberately device-local and must never be written here.
public enum SyncKey: String, CaseIterable, Sendable {
    case portfolio              = "pkm-portfolio"
    case wishlist               = "pkm-wishlist"
    case watchlist              = "pkm-watchlist-v1"
    case compare                = "pkm-compare"
    case acquisitions           = "pkm-acquisitions-v1"
    case holdOverrides          = "pkm-hold-overrides"
    case gemOverrides           = "pkm-gem-overrides-v1"
    case budgetMaxGBP           = "pkm-budget-max-gbp"
    case binderPages            = "pkm-binder-pages-v1"
    case connectedArt           = "pkm-connected-art-v1"
    case vintageTargets         = "pkm-vintage-v1"
    case ebayWatch              = "pkm-ebay-watch-v1"
    case pcOverrides            = "pkm-pc-overrides-v1"
    case collectrIds            = "pkm-collectr-ids-v1"
    case userCards              = "pkm-user-cards-v1"
    case portfolioHistory       = "pkm-portfolio-history-v1"
    case binderSort             = "pkm-binder-sort-v1"
    case gradingService         = "pkm-grading-service-v1"
    case etbSets                = "pkm-etb-sets-v1"
}

/// A card in the collection. The web app writes `id` on newer entries and `i`
/// on older ones, so both are accepted and normalised.
public struct OwnedCard: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public var quantity: Int?
    public var grade: String?
    public var variant: String?
    public var paidGBP: Double?

    enum CodingKeys: String, CodingKey {
        case id, i, quantity, qty, grade, variant, paid, paidGBP
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let v = try? c.decode(String.self, forKey: .id) { id = v }
        else { id = try c.decode(String.self, forKey: .i) }
        quantity = (try? c.decode(Int.self, forKey: .quantity)) ?? (try? c.decode(Int.self, forKey: .qty))
        grade    = try? c.decode(String.self, forKey: .grade)
        variant  = try? c.decode(String.self, forKey: .variant)
        paidGBP  = (try? c.decode(Double.self, forKey: .paidGBP)) ?? (try? c.decode(Double.self, forKey: .paid))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encodeIfPresent(quantity, forKey: .quantity)
        try c.encodeIfPresent(grade, forKey: .grade)
        try c.encodeIfPresent(variant, forKey: .variant)
        try c.encodeIfPresent(paidGBP, forKey: .paidGBP)
    }

    public init(id: String, quantity: Int? = nil, grade: String? = nil, variant: String? = nil, paidGBP: Double? = nil) {
        self.id = id; self.quantity = quantity; self.grade = grade; self.variant = variant; self.paidGBP = paidGBP
    }
}
