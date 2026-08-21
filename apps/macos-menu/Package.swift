// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "TokenlessMenuBar",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .executable(name: "TokenlessMenuBar", targets: ["TokenlessMenuBar"]),
    ],
    targets: [
        .executableTarget(
            name: "TokenlessMenuBar",
            path: "Sources/TokenlessMenuBar"
        ),
    ]
)
