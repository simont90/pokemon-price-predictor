import XCTest
@testable import PokePredictorKit

final class SyncSnapshotTests: XCTestCase {

    /// The real envelope: values are JSON *strings*, not nested objects.
    func testDecodesStringEncodedValues() throws {
        let body = """
        {"data":{"pkm-portfolio":"[{\\"id\\":\\"base5-5\\",\\"quantity\\":2}]",
                 "pkm-budget-max-gbp":"500"},"ts":1760000000000}
        """.data(using: .utf8)!
        let snap = try WorkerClient.decodeSnapshot(body)
        XCTAssertEqual(snap.timestamp, 1_760_000_000_000)
        let owned = snap.value(.portfolio, as: [OwnedCard].self)
        XCTAssertEqual(owned?.count, 1)
        XCTAssertEqual(owned?.first?.id, "base5-5")
        XCTAssertEqual(owned?.first?.quantity, 2)
        XCTAssertEqual(snap.double(.budgetMaxGBP), 500)
    }

    /// `{data:null,ts:0}` is what the worker returns before anything is pushed.
    /// That is an empty collection, not a failure.
    func testNullDataIsEmptyNotAnError() throws {
        let snap = try WorkerClient.decodeSnapshot(#"{"data":null,"ts":0}"#.data(using: .utf8)!)
        XCTAssertTrue(snap.isEmpty)
        XCTAssertNil(snap.updatedAt)
        XCTAssertNil(snap.value(.portfolio, as: [OwnedCard].self))
    }

    /// Older entries key the card as `i`, newer ones as `id`. Both must load,
    /// or half the collection silently disappears.
    func testAcceptsLegacyCardIdKey() throws {
        let json = #"[{"i":"base1-4"},{"id":"sv3pt5-199","quantity":3}]"#.data(using: .utf8)!
        let cards = try JSONDecoder().decode([OwnedCard].self, from: json)
        XCTAssertEqual(cards.map(\.id), ["base1-4", "sv3pt5-199"])
        XCTAssertEqual(cards[1].quantity, 3)
    }

    /// `pkm-binder-sort-v1` holds the bare string `dex`, which is not valid JSON.
    /// Parsing it threw in the web client and the whole key was skipped, so
    /// those settings never synced at all. It must not throw here.
    func testBareStringKeyDoesNotThrow() throws {
        let body = #"{"data":{"pkm-binder-sort-v1":"dex"},"ts":1}"#.data(using: .utf8)!
        let snap = try WorkerClient.decodeSnapshot(body)
        XCTAssertEqual(snap.string(.binderSort), "dex")
        XCTAssertNil(snap.value(.binderSort, as: [String].self))   // wrong type: nil, not a crash
    }

    /// One malformed key must never cost the others.
    func testOneBadKeyDoesNotPoisonTheRest() throws {
        let body = #"{"data":{"pkm-portfolio":"not json at all","pkm-budget-max-gbp":"250"},"ts":5}"#
            .data(using: .utf8)!
        let snap = try WorkerClient.decodeSnapshot(body)
        XCTAssertNil(snap.value(.portfolio, as: [OwnedCard].self))
        XCTAssertEqual(snap.double(.budgetMaxGBP), 250)
    }

    /// A 402 from the Collectr route means the parse.bot allowance is spent.
    /// It is recoverable and must be distinguishable from a generic failure.
    func testCreditsExhaustedIsItsOwnError() {
        let url = URL(string: "https://example.invalid/collectr")!
        let resp = HTTPURLResponse(url: url, statusCode: 402, httpVersion: nil, headerFields: nil)!
        XCTAssertThrowsError(try WorkerClient.check(resp, Data())) { error in
            XCTAssertEqual(error as? WorkerError, .creditsExhausted)
        }
    }

    /// Every synced key must carry the `pkm-` prefix. Anything without it is
    /// device-local by design and writing it would push junk to every device.
    func testEverySyncKeyIsPrefixed() {
        for key in SyncKey.allCases {
            XCTAssertTrue(key.rawValue.hasPrefix("pkm-"), "\(key.rawValue) is not a synced key")
        }
    }
}
