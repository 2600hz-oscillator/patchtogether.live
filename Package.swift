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
// Build:   swift build -c release          (compiles only — starts nothing)
// Run:     swift run -c release es9-bridge --synthetic   # the bridge, no hw
//          .build/release/es9-devices
//          .build/release/es9-duplex --help
//          NB: bare `swift run` is ambiguous — this package has three
//          executables, so always name the one you want.
//
import PackageDescription

let package = Package(
    name: "patchtogether-es9",
    // macOS 15 for the Synchronization framework (lock-free Atomic<> used on
    // the real-time audio path). The original spike targeted v12; the bridge
    // needs modern atomics and Network.framework niceties.
    platforms: [.macOS("15.0")],
    targets: [
        // Shared CoreAudio helpers (device discovery, property getters),
        // pair-routing model, duplex engine, and the bridge core (ring
        // buffers, wire protocol, resampler, WebSocket server).
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
        // The bridge app: ES-9 <-> browser (patchtogether) audio+CV bridge.
        // Serves an embedded test-harness page over HTTP and streams audio
        // both directions over a localhost WebSocket.
        .executableTarget(
            name: "es9-bridge",
            dependencies: ["ES9Core"],
            resources: [.embedInCode("Resources/harness.html")]
        ),
        .testTarget(
            name: "ES9CoreTests",
            dependencies: ["ES9Core"]
        ),
    ]
)
