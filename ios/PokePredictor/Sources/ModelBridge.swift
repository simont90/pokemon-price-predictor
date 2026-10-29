import Foundation
import JavaScriptCore

/// One strategy row, as the model produced it.
public struct StrategyRow: Identifiable, Hashable, Sendable {
    public let key: String
    public let label: String
    public let allInGBP: Double
    public let roi: Double
    public let risk: String
    public let estimated: Bool
    public let medal: String?        // "gold" | "silver" | "bronze" | nil
    public var id: String { key }
}

public struct Valuation: Sendable {
    public let rawGBP: Double
    public let psa10GBP: Double
    public let stars: Int
    public let starLabel: String
    public let clearsBar: Bool
    public let rows: [StrategyRow]
}

/// Runs the web app's own valuation model inside JavaScriptCore.
///
/// app.js is loaded verbatim — not translated — so the phone cannot disagree
/// with the website about what a card is worth. A Swift reimplementation would
/// be a third copy of the model (the worker already has a divergent second one)
/// and this app has no business being a fourth opinion.
///
/// `init()` in app.js wires the whole browser UI and cannot run here; the
/// bridge decodes the catalogue itself and calls only the model functions.
public actor ModelBridge {
    public enum Failure: Error, Sendable { case notLoaded, noResult(String) }

    private var context: JSContext?
    private var loadError: String?

    public init() {}

    public var isLoaded: Bool { context != nil }

    /// Loading parses ~35k lines plus the catalogue, so it happens once, off
    /// the main actor, and only when a valuation is first wanted.
    private func ensureLoaded() throws {
        if context != nil { return }
        if let e = loadError { throw Failure.noResult(e) }

        guard let ctx = JSContext() else { throw Failure.notLoaded }
        var caught: String?
        ctx.exceptionHandler = { _, value in
            // app.js's init() throws on the missing DOM. That is expected and
            // harmless: the model functions are already defined by then.
            let msg = value?.toString() ?? "unknown"
            if caught == nil { caught = msg }
        }

        for name in ["prelude", "cards-db", "sets-db", "pokedex-db", "app", "bridge"] {
            guard let url = Bundle.main.url(forResource: name, withExtension: "js"),
                  let src = try? String(contentsOf: url, encoding: .utf8) else {
                loadError = "Missing \(name).js in the bundle."
                throw Failure.noResult(loadError!)
            }
            ctx.evaluateScript(src, withSourceURL: url)
        }

        guard ctx.objectForKeyedSubscript("__bridge")?.isObject == true else {
            loadError = "Bridge did not initialise. First JS error: \(caught ?? "none")"
            throw Failure.noResult(loadError!)
        }
        context = ctx
    }

    public func cardCount() -> Int {
        (try? ensureLoaded())
        return Int(context?.objectForKeyedSubscript("__bridge")?
            .invokeMethod("count", withArguments: [])?.toInt32() ?? 0)
    }

    /// Keeps the model's FX in step with the rate the app is showing, so the
    /// GBP figures on the tiles match the ones beside them.
    public func setFX(_ rate: Double) {
        guard (try? ensureLoaded()) != nil, rate > 0 else { return }
        _ = context?.objectForKeyedSubscript("__bridge")?
            .invokeMethod("setFx", withArguments: [rate])
    }

    public func valuate(cardID: String) throws -> Valuation {
        try ensureLoaded()
        guard let result = context?.objectForKeyedSubscript("__bridge")?
            .invokeMethod("valuate", withArguments: [cardID]),
              let dict = result.toDictionary() else {
            throw Failure.noResult("The model returned nothing.")
        }
        guard (dict["ok"] as? Bool) == true else {
            throw Failure.noResult((dict["why"] as? String) ?? "The model could not price this card.")
        }

        let rows = (dict["rows"] as? [[String: Any]] ?? []).map { r in
            StrategyRow(
                key: r["key"] as? String ?? "",
                label: r["label"] as? String ?? "",
                allInGBP: r["allInGBP"] as? Double ?? 0,
                roi: r["roi"] as? Double ?? 0,
                risk: r["risk"] as? String ?? "",
                estimated: r["estimated"] as? Bool ?? false,
                medal: r["medal"] as? String)
        }
        return Valuation(
            rawGBP: dict["rawGBP"] as? Double ?? 0,
            psa10GBP: dict["psa10GBP"] as? Double ?? 0,
            stars: Int(dict["stars"] as? Double ?? 0),
            starLabel: dict["starLabel"] as? String ?? "",
            clearsBar: dict["clearsBar"] as? Bool ?? false,
            rows: rows)
    }
}
