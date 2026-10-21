import Foundation

public enum WorkerError: Error, Sendable, Equatable {
    case badStatus(Int, body: String)
    case badResponse
    case creditsExhausted          // the worker's 402: parse.bot allowance spent, recoverable
    case notConfigured             // no pair code set
}

/// Client for the Cloudflare Worker that already backs the web app.
///
/// The iOS app is a second client on the *same* backend, not a second
/// implementation of it: `/sync` is the shared state and the worker owns every
/// third-party key. Nothing here holds an API secret.
public actor WorkerClient {
    public static let defaultBaseURL = URL(string: "https://pokemon-marketplace.simontariq.workers.dev")!

    private let baseURL: URL
    private let session: URLSession
    private var pairCode: String?

    public init(baseURL: URL = WorkerClient.defaultBaseURL,
                pairCode: String? = nil,
                session: URLSession = .shared) {
        self.baseURL = baseURL
        self.pairCode = pairCode
        self.session = session
    }

    /// The pair code is a credential: on device it belongs in the Keychain, and
    /// the caller owns that. The client only ever holds it in memory.
    public func setPairCode(_ code: String?) { self.pairCode = code }

    public func health() async throws -> Bool {
        let (data, response) = try await session.data(from: baseURL.appending(path: "health"))
        guard let http = response as? HTTPURLResponse else { throw WorkerError.badResponse }
        guard http.statusCode == 200 else {
            throw WorkerError.badStatus(http.statusCode, body: String(decoding: data, as: UTF8.self))
        }
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines) == "ok"
    }

    // MARK: - Sync

    public func fetchSnapshot() async throws -> SyncSnapshot {
        guard let code = pairCode, !code.isEmpty else { throw WorkerError.notConfigured }
        var comps = URLComponents(url: baseURL.appending(path: "sync"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "key", value: code)]
        let (data, response) = try await session.data(from: comps.url!)
        try Self.check(response, data)
        return try Self.decodeSnapshot(data)
    }

    /// The worker stores the body verbatim, so the envelope must match what the
    /// web client writes: every value a JSON *string*.
    public func pushSnapshot(_ values: [String: String]) async throws {
        guard let code = pairCode, !code.isEmpty else { throw WorkerError.notConfigured }
        var comps = URLComponents(url: baseURL.appending(path: "sync"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "key", value: code)]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let envelope: [String: Any] = [
            "data": values,
            "ts": Int(Date().timeIntervalSince1970 * 1000),
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: envelope)
        let (data, response) = try await session.data(for: req)
        try Self.check(response, data)
    }

    // MARK: - Decoding

    /// `{ "data": { key: "<raw json>" }, "ts": n }`, or `{ "data": null, "ts": 0 }`
    /// when nothing has been pushed yet — which is a valid empty state, not an error.
    public static func decodeSnapshot(_ data: Data) throws -> SyncSnapshot {
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw WorkerError.badResponse
        }
        let ts = (obj["ts"] as? Int) ?? 0
        guard let dict = obj["data"] as? [String: Any] else {
            return SyncSnapshot(raw: [:], timestamp: ts)   // data: null
        }
        var raw: [String: String] = [:]
        for (k, v) in dict {
            if let s = v as? String {
                raw[k] = s
            } else if let d = try? JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed]) {
                // Tolerate an already-parsed value, so a hand-written blob still loads.
                raw[k] = String(decoding: d, as: UTF8.self)
            }
        }
        return SyncSnapshot(raw: raw, timestamp: ts)
    }

    public static func check(_ response: URLResponse, _ data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw WorkerError.badResponse }
        if http.statusCode == 402 { throw WorkerError.creditsExhausted }
        guard (200..<300).contains(http.statusCode) else {
            throw WorkerError.badStatus(http.statusCode, body: String(decoding: data, as: UTF8.self))
        }
    }
}
