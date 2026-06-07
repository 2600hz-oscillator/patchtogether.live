// swift-tools-version:5.9
//
// patchtogether.es9 — standalone CoreAudio proof-of-concept for
// low-latency, multi-channel (16x16) duplex I/O with the Expert Sleepers ES-9.
//
// Two executables:
//   es9-devices — enumerate CoreAudio devices, find the ES-9, dump its
//                 stream config (channel counts, sample rates, buffer-size
//                 range, latency + safety offset). Safe to run with NO
//                 hardware attached (it just won't find an ES-9).
//   es9-duplex  — open ONE HAL Output AudioUnit (AUHAL) full-duplex against
//                 the ES-9, do channel-addressable passthrough (input pair N
//                 -> output pair M) with per-channel RMS metering, at a
//                 configurable buffer size so you can hear/measure latency.
//
// Both link CoreAudio + AudioToolbox + AudioUnit (system frameworks; no deps).
//
// Build:   swift build -c release
// Run:     .build/release/es9-devices
//          .build/release/es9-duplex --help
//
import PackageDescription

let package = Package(
    name: "patchtogether-es9",
    platforms: [.macOS(.v12)],
    targets: [
        // Shared CoreAudio helpers (device discovery, property getters).
        .target(
            name: "ES9Core",
            linkerSettings: [
                .linkedFramework("CoreAudio"),
                .linkedFramework("AudioToolbox"),
                .linkedFramework("AudioUnit"),
            ]
        ),
        .executableTarget(
            name: "es9-devices",
            dependencies: ["ES9Core"]
        ),
        .executableTarget(
            name: "es9-duplex",
            dependencies: ["ES9Core"]
        ),
        .testTarget(
            name: "ES9CoreTests",
            dependencies: ["ES9Core"]
        ),
    ]
)
