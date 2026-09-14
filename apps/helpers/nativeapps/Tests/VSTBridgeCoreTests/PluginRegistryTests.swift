// PluginRegistryTests.swift — discovery against the real system registry
// (Apple's built-in Audio Units are on every macOS install, so these run
// hardware- and third-party-free).

import AudioToolbox
import XCTest
@testable import VSTBridgeCore

final class PluginRegistryTests: XCTestCase {
    func testFourCCRoundTrip() {
        XCTAssertEqual(PluginRegistry.fourCC(kAudioUnitType_Effect), "aufx")
        XCTAssertEqual(PluginRegistry.osType("aufx"), kAudioUnitType_Effect)
        XCTAssertEqual(PluginRegistry.osType("dls "), kAudioUnitSubType_DLSSynth)
        // Non-printable code falls back to decimal, and parses back.
        let weird: OSType = 0x0102_0304
        XCTAssertEqual(PluginRegistry.fourCC(weird), "\(weird)")
        XCTAssertEqual(PluginRegistry.osType("\(weird)"), weird)
    }

    func testScanFindsAppleBuiltins() {
        let plugins = PluginRegistry.scan()
        XCTAssertFalse(plugins.isEmpty)
        // AUDelay (effect) and DLSMusicDevice (instrument) ship with macOS.
        XCTAssertNotNil(PluginRegistry.find(id: "au:aufx:dely:appl", in: plugins),
                        "AUDelay missing from scan")
        XCTAssertNotNil(PluginRegistry.find(id: "au:aumu:dls :appl", in: plugins),
                        "DLSMusicDevice missing from scan")
        for p in plugins {
            XCTAssertFalse(p.info.name.isEmpty)
            XCTAssertTrue(p.info.id.hasPrefix("au:"))
        }
    }
}
