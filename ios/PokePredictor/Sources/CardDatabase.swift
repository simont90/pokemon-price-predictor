import Foundation

/// A card from the bundled catalogue.
public struct Card: Identifiable, Hashable, Sendable {
    public let id: String          // "base5-5"
    public let name: String
    public let setName: String
    public let setCode: String
    public let rarity: String
    public let rarityCode: String
    public let number: Int
    public let numberString: String
    public let priceUSD: Double
    public let printedTotal: Int
    public let language: String    // "" for EN, "JP" for Japanese
    public let japaneseName: String

    public var isJapanese: Bool { language == "JP" }
}

/// Loads the catalogue shipped in the bundle. It is stored column-wise with
/// shared string tables — as 27k JSON objects the file roughly triples, and the
/// decode is what the first screen waits on.
@MainActor
public final class CardDatabase: ObservableObject {
    @Published public private(set) var cards: [Card] = []
    @Published public private(set) var sets: [String: SetInfo] = [:]
    @Published public private(set) var isLoading = true

    public struct SetInfo: Codable, Sendable {
        public let name: String
        public let series: String
        public let releaseDate: String
        public let printedTotal: Int
        public let logo: String
    }

    private struct Payload: Decodable {
        let sets: [String], codes: [String], rars: [String], rcodes: [String]
        let cards: [[CardField]]
    }

    /// Columns are mixed string/number, so each cell decodes as either.
    private enum CardField: Decodable {
        case s(String), n(Double)
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let v = try? c.decode(String.self) { self = .s(v) }
            else { self = .n((try? c.decode(Double.self)) ?? 0) }
        }
        var string: String { if case .s(let v) = self { return v }; if case .n(let v) = self { return String(Int(v)) }; return "" }
        var int: Int { if case .n(let v) = self { return Int(v) }; if case .s(let v) = self { return Int(v) ?? 0 }; return 0 }
        var double: Double { if case .n(let v) = self { return v }; if case .s(let v) = self { return Double(v) ?? 0 }; return 0 }
    }

    public init() { Task { await load() } }

    public func load() async {
        let decoded: ([Card], [String: SetInfo])? = await Task.detached(priority: .userInitiated) {
            guard let cu = Bundle.main.url(forResource: "cards", withExtension: "json"),
                  let cd = try? Data(contentsOf: cu),
                  let p  = try? JSONDecoder().decode(Payload.self, from: cd) else { return nil }
            var out: [Card] = []
            out.reserveCapacity(p.cards.count)
            for r in p.cards where r.count >= 12 {
                let si = r[2].int, ci = r[3].int, ri = r[4].int, rci = r[5].int
                out.append(Card(
                    id: r[0].string, name: r[1].string,
                    setName: si < p.sets.count ? p.sets[si] : "",
                    setCode: ci < p.codes.count ? p.codes[ci] : "",
                    rarity: ri < p.rars.count ? p.rars[ri] : "",
                    rarityCode: rci < p.rcodes.count ? p.rcodes[rci] : "",
                    number: r[6].int, numberString: r[7].string,
                    priceUSD: r[8].double, printedTotal: r[9].int,
                    language: r[10].string, japaneseName: r[11].string))
            }
            var setMap: [String: SetInfo] = [:]
            if let su = Bundle.main.url(forResource: "sets", withExtension: "json"),
               let sd = try? Data(contentsOf: su) {
                setMap = (try? JSONDecoder().decode([String: SetInfo].self, from: sd)) ?? [:]
            }
            return (out, setMap)
        }.value

        if let (c, s) = decoded { self.cards = c; self.sets = s }
        self.isLoading = false
    }

    /// Name, set or card number. Japanese names are searchable too — romanising
    /// them away would lose half the catalogue's identity.
    public func search(_ query: String, limit: Int = 120) -> [Card] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard q.count >= 2 else { return [] }
        var hits: [Card] = []
        for c in cards {
            if c.name.lowercased().contains(q)
                || c.japaneseName.contains(query)
                || c.setName.lowercased().contains(q)
                || c.numberString.lowercased() == q {
                hits.append(c)
                if hits.count >= limit { break }
            }
        }
        return hits
    }

    public func card(id: String) -> Card? { cards.first { $0.id == id } }
}
