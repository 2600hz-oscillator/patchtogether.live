// PluginHostTests.swift — mount and render REAL Audio Units. Uses Apple's
// built-ins (AUDelay effect, DLSMusicDevice GM synth) so the whole hosting
// path — instantiate, format negotiation, allocate, pull-through render,
// sample-accurate MIDI, state round-trip — is exercised on any Mac with no
// third-party plugins and no audio hardware/permissions.

import XCTest
import BridgeKit
@testable import VSTBridgeCore

final class PluginHostTests: XCTestCase {
    private let rate = 48000.0

    override class func setUp() {
        super.setUp()
        // The app runs plugin lifecycle on main; under `swift test` the
        // main queue may not be pumped, so tests use their own serial
        // lifecycle queue (fine for Apple's AUs).
        PluginLifecycle.queue = DispatchQueue(label: "test.plugin.lifecycle")
    }

    private func mount(_ id: String) throws -> PluginHost {
        guard let descriptor = PluginRegistry.find(id: id) else {
            throw XCTSkip("\(id) not present on this system")
        }
        let done = expectation(description: "mount \(id)")
        var result: Result<PluginHost, Error>?
        PluginHost.mount(descriptor: descriptor, rate: rate) { r in
            result = r
            done.fulfill()
        }
        wait(for: [done], timeout: 10)
        switch result {
        case .success(let host): return host
        case .failure(let error): throw error
        case nil: throw PluginHostError.instantiateFailed("no callback")
        }
    }

    private func sine(_ frames: Int, freq: Double = 440, amp: Float = 0.5) -> [Float] {
        (0..<frames).map { amp * Float(sin(2 * .pi * freq * Double($0) / rate)) }
    }

    private func peak(_ plane: [Float]) -> Float {
        plane.reduce(0) { max($0, abs($1)) }
    }

    func testEffectRendersAudio() throws {
        let host = try mount("au:aufx:dely:appl")
        defer { host.teardown() }
        XCTAssertEqual(host.audioInputChannels, 2)
        XCTAssertFalse(host.acceptsMidi)
        XCTAssertGreaterThanOrEqual(host.latencySamples, 0)

        let frames = 512
        let input = sine(frames)
        var sampleTime: UInt64 = 0
        var maxPeak: Float = 0
        for _ in 0..<20 {
            switch host.render(inputPlanes: [input, input], frames: frames,
                               sampleTime: sampleTime, midi: []) {
            case .success(let out):
                XCTAssertEqual(out.count, 2)
                XCTAssertEqual(out[0].count, frames)
                maxPeak = max(maxPeak, peak(out[0]))
            case .failure(let failure):
                XCTFail("render failed: \(failure.status)")
            }
            sampleTime += UInt64(frames)
        }
        // A delay passes (dry+wet) audio: clearly nonzero, not exploding.
        XCTAssertGreaterThan(maxPeak, 0.05)
        XCTAssertLessThan(maxPeak, 4.0)
    }

    func testInstrumentRendersFromMidi() throws {
        let host = try mount("au:aumu:dls :appl")
        defer { host.teardown() }
        XCTAssertEqual(host.audioInputChannels, 0)
        XCTAssertTrue(host.acceptsMidi)

        let frames = 512
        var sampleTime: UInt64 = 0

        // Silence before the note...
        var silentPeak: Float = 0
        for _ in 0..<4 {
            if case .success(let out) = host.render(inputPlanes: [], frames: frames,
                                                    sampleTime: sampleTime, midi: []) {
                silentPeak = max(silentPeak, peak(out[0]))
            }
            sampleTime += UInt64(frames)
        }
        XCTAssertEqual(silentPeak, 0, accuracy: 1e-6)

        // ...note-on, then let it sound for ~0.5 s.
        var midi: [PluginHost.ScheduledMidi] = [.init(offsetFrames: 0, bytes: [0x90, 60, 110])]
        var soundingPeak: Float = 0
        for _ in 0..<47 {
            switch host.render(inputPlanes: [], frames: frames,
                               sampleTime: sampleTime, midi: midi) {
            case .success(let out):
                soundingPeak = max(soundingPeak, peak(out[0]))
            case .failure(let failure):
                XCTFail("render failed: \(failure.status)")
            }
            midi = []
            sampleTime += UInt64(frames)
        }
        XCTAssertGreaterThan(soundingPeak, 0.01,
                             "DLS synth produced no audio after note-on")

        host.allNotesOff()
    }

    func testStateRoundTrip() throws {
        let host = try mount("au:aufx:dely:appl")
        defer { host.teardown() }
        guard let state = host.stateBase64() else {
            XCTFail("no state from AUDelay")
            return
        }
        XCTAssertFalse(state.isEmpty)
        XCTAssertTrue(host.setState(base64: state))
        XCTAssertFalse(host.setState(base64: "not base64!!!"))
    }

    func testMountedMessageShape() throws {
        let host = try mount("au:aumu:dls :appl")
        defer { host.teardown() }
        let message = host.mountedMessage
        XCTAssertEqual(message.plugin.id, "au:aumu:dls :appl")
        XCTAssertEqual(message.audioInputChannels, 0)
        XCTAssertEqual(message.audioOutputChannels, 2)
        XCTAssertTrue(message.acceptsMidi)
    }
}
