// swift-tools-version: 5.9
import PackageDescription

// The data layer the iOS app sits on. Foundation only, no SwiftUI and no UIKit,
// so it builds and tests with Command Line Tools alone — Xcode is only needed
// for the app target that imports it.
let package = Package(
    name: "PokePredictorKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "PokePredictorKit", targets: ["PokePredictorKit"]),
    ],
    targets: [
        .target(name: "PokePredictorKit"),
        .testTarget(name: "PokePredictorKitTests", dependencies: ["PokePredictorKit"]),
    ]
)
