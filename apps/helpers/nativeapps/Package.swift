// swift-tools-version:5.9
//
// patchtogether.nativeapps — the umbrella package for patchtogether's native
// companion apps ("bridges"): local helpers that give the browser app
// capabilities the web platform structurally cannot provide, each an
// arm's-length process speaking a documented localhost protocol.
//
// Today:
//   BridgeKit     — the shared bridge platform: RFC 6455 WebSocket server
//                   (Network.framework, loopback-only, Origin-gated) + the
//                   binary wire protocol (planar-f32 audio blocks, MIDI
//                   event blocks) + shared control messages. Extracted from
//                   ../patchtogether.es9 (which remains the shipping ES-9
//                   bridge, untouched, until this repo's es9 build is ready
//                   to regression-test).
//   vst-bridge    — hosts the user's installed Audio Unit plugins (the AU
//                   builds of their "VSTs") and bridges audio+MIDI to the
//                   browser: browser sends audio/MIDI blocks, the plugin
//                   renders, audio comes back. Client-clocked: no hardware,
//                   no resampling — the browser's AudioContext is the clock.
//
// Planned:
//   es9-bridge    — migrates here from ../patchtogether.es9 once the owner
//                   wants to regression-test it against BridgeKit.
//
// Build:   swift build -c release        (compiles only — starts nothing)
// Run:     swift run -c release vst-bridge
//          .build/release/vst-bridge --list
// Test:    swift test
//
import PackageDescription

let package = Package(
    name: "patchtogether-nativeapps",
    // macOS 15 for the Synchronization framework (lock-free Atomic<>),
    // matching the es9 bridge this extracts from.
    platforms: [.macOS("15.0")],
    targets: [
        // Shared transport + wire protocol. No audio-backend code here —
        // this is the layer every bridge (VST, ES-9, future ones) stands on.
        .target(
            name: "BridgeKit",
            linkerSettings: [
                .linkedFramework("Network"),
            ]
        ),
        // The AU plugin host + VST-bridge protocol extensions + service.
        .target(
            name: "VSTBridgeCore",
            dependencies: ["BridgeKit"],
            linkerSettings: [
                .linkedFramework("AudioToolbox"),
                .linkedFramework("AVFAudio"),
                .linkedFramework("CoreAudioKit"),
                .linkedFramework("AppKit"),
            ]
        ),
        // The app: serves an embedded test-harness page over HTTP and the
        // bridge protocol over a localhost WebSocket; hosts plugin editor
        // windows on the main thread.
        .executableTarget(
            name: "vst-bridge",
            dependencies: ["BridgeKit", "VSTBridgeCore"],
            resources: [.embedInCode("Resources/harness.html")]
        ),
        .testTarget(
            name: "BridgeKitTests",
            dependencies: ["BridgeKit"]
        ),
        .testTarget(
            name: "VSTBridgeCoreTests",
            dependencies: ["VSTBridgeCore", "BridgeKit"]
        ),
    ]
)
