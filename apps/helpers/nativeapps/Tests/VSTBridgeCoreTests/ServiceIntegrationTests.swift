// ServiceIntegrationTests.swift — full-stack: a real VSTBridgeService on an
// ephemeral port, driven through a real WebSocket exactly like the browser
// harness/card. Covers the handshake, bypass render, wire-level mount +
// effect render, MIDI → instrument audio, and the busy/takeover policy.

import XCTest
import BridgeKit
@testable import VSTBridgeCore

private struct TimeoutError: Error {}

private func withTimeout<T>(_ seconds: Double,
                            _ op: @escaping () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await op() }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(seconds * 1e9))
            throw TimeoutError()
        }
        let result = try await group.next()!
        group.cancelAll()
        return result
    }
}

final class ServiceIntegrationTests: XCTestCase {
    private var service: VSTBridgeService!

    override class func setUp() {
        super.setUp()
        // See PluginHostTests: tests replace the main-thread lifecycle
        // queue with a private serial one.
        PluginLifecycle.queue = DispatchQueue(label: "test.plugin.lifecycle")
    }

    override func setUpWithError() throws {
        service = VSTBridgeService(config: .init(
            port: 0, harnessHTML: Data("<html></html>".utf8)))
        try service.start()
    }

    override func tearDown() {
        service.stop()
        service = nil
    }

    // MARK: - Wire helpers

    private func open() -> URLSessionWebSocketTask {
        let url = URL(string: "ws://127.0.0.1:\(service.boundPort)/ws")!
        let task = URLSession.shared.webSocketTask(with: url)
        task.resume()
        return task
    }

    private func sendJSON(_ task: URLSessionWebSocketTask, _ obj: [String: Any]) async throws {
        let data = try JSONSerialization.data(withJSONObject: obj)
        try await task.send(.string(String(data: data, encoding: .utf8)!))
    }

    /// Next control message of `type`, skipping meters/status/other chatter.
    private func nextText(_ task: URLSessionWebSocketTask, type: String,
                          timeout: Double = 10) async throws -> [String: Any] {
        try await withTimeout(timeout) {
            while true {
                guard case .string(let text) = try await task.receive() else { continue }
                guard let obj = try JSONSerialization.jsonObject(
                    with: Data(text.utf8)) as? [String: Any] else { continue }
                if obj["type"] as? String == type { return obj }
            }
        }
    }

    private func nextBinary(_ task: URLSessionWebSocketTask,
                            timeout: Double = 10) async throws -> AudioBlock {
        try await withTimeout(timeout) {
            while true {
                if case .data(let data) = try await task.receive() {
                    return try BridgeWire.decode(data)
                }
            }
        }
    }

    private func hello(_ task: URLSessionWebSocketTask, rate: Double = 48000,
                       clientId: String? = nil) async throws {
        var msg: [String: Any] = ["type": "hello", "rate": rate, "name": "test"]
        if let clientId { msg["clientId"] = clientId }
        try await sendJSON(task, msg)
    }

    private func sendAudio(_ task: URLSessionWebSocketTask, seq: UInt16,
                           sampleTime: UInt64, planes: [[Float]]) async throws {
        let mask: UInt32 = planes.isEmpty ? 0 : (planes.count == 1 ? 0b1 : 0b11)
        let block = AudioBlock(seq: seq, sampleTime: sampleTime, channelMask: mask,
                               frameCount: planes.first?.count ?? 128, planes: planes)
        try await task.send(.data(BridgeWire.encode(block)))
    }

    private func sine(_ frames: Int, rate: Double = 48000) -> [Float] {
        (0..<frames).map { 0.5 * Float(sin(2 * .pi * 440 * Double($0) / rate)) }
    }

    // MARK: - Tests

    func testHandshake() async throws {
        let task = open()
        defer { task.cancel(with: .normalClosure, reason: nil) }
        try await hello(task)
        let info = try await nextText(task, type: "helperInfo")
        XCTAssertEqual(info["rate"] as? Double, 48000)
        XCTAssertEqual(info["name"] as? String, "vst-bridge")
        let list = try await nextText(task, type: "pluginList")
        let plugins = list["plugins"] as? [[String: Any]] ?? []
        XCTAssertFalse(plugins.isEmpty, "pluginList empty")
    }

    func testBypassEchoesInput() async throws {
        let task = open()
        defer { task.cancel(with: .normalClosure, reason: nil) }
        try await hello(task)
        _ = try await nextText(task, type: "pluginList")

        let input = sine(256)
        try await sendAudio(task, seq: 1, sampleTime: 12345, planes: [input, input])
        let reply = try await nextBinary(task)
        XCTAssertEqual(reply.sampleTime, 12345)
        XCTAssertEqual(reply.frameCount, 256)
        XCTAssertEqual(reply.channelMask, 0b11)
        XCTAssertEqual(reply.planes[0], input, "bypass must be bit-transparent")
    }

    func testMountEffectOverWire() async throws {
        let task = open()
        defer { task.cancel(with: .normalClosure, reason: nil) }
        try await hello(task)
        _ = try await nextText(task, type: "pluginList")

        try await sendJSON(task, ["type": "mount", "pluginId": "au:aufx:dely:appl"])
        let mounted = try await nextText(task, type: "mounted")
        XCTAssertEqual((mounted["plugin"] as? [String: Any])?["id"] as? String,
                       "au:aufx:dely:appl")

        let input = sine(512)
        var peak: Float = 0
        var sampleTime: UInt64 = 0
        for seq in 0..<10 {
            try await sendAudio(task, seq: UInt16(seq), sampleTime: sampleTime,
                                planes: [input, input])
            let reply = try await nextBinary(task)
            XCTAssertEqual(reply.frameCount, 512)
            peak = max(peak, reply.planes[0].reduce(0) { max($0, abs($1)) })
            sampleTime += 512
        }
        XCTAssertGreaterThan(peak, 0.05, "mounted delay produced no audio")

        try await sendJSON(task, ["type": "unmount"])
        _ = try await nextText(task, type: "unmounted")
    }

    func testInstrumentPlaysNotesOverWire() async throws {
        let task = open()
        defer { task.cancel(with: .normalClosure, reason: nil) }
        try await hello(task)
        _ = try await nextText(task, type: "pluginList")

        try await sendJSON(task, ["type": "mount", "pluginId": "au:aumu:dls :appl"])
        let mounted = try await nextText(task, type: "mounted")
        XCTAssertEqual(mounted["audioInputChannels"] as? Int, 0)
        XCTAssertEqual(mounted["acceptsMidi"] as? Bool, true)

        // Note-on at t=0, then pull rendering with clock-only blocks.
        try await task.send(.data(MidiWire.encode(
            seq: 0, events: [MidiEvent(sampleTime: 0, bytes: [0x90, 60, 110])])))
        var peak: Float = 0
        var sampleTime: UInt64 = 0
        for seq in 0..<50 {
            try await sendAudio(task, seq: UInt16(seq), sampleTime: sampleTime, planes: [])
            let reply = try await nextBinary(task)
            peak = max(peak, reply.planes[0].reduce(0) { max($0, abs($1)) })
            sampleTime += 128
            if peak > 0.01 { break }
        }
        XCTAssertGreaterThan(peak, 0.01, "instrument produced no audio from MIDI")
    }

    func testStateRoundTripOverWire() async throws {
        let task = open()
        defer { task.cancel(with: .normalClosure, reason: nil) }
        try await hello(task)
        _ = try await nextText(task, type: "pluginList")
        try await sendJSON(task, ["type": "mount", "pluginId": "au:aufx:dely:appl"])
        _ = try await nextText(task, type: "mounted")

        try await sendJSON(task, ["type": "getState"])
        let state = try await nextText(task, type: "state")
        let blob = state["data"] as? String ?? ""
        XCTAssertFalse(blob.isEmpty)

        try await sendJSON(task, ["type": "setState", "data": blob])
        let ack = try await nextText(task, type: "stateSet")
        XCTAssertEqual(ack["ok"] as? Bool, true)
    }

    func testTwoConcurrentInstances() async throws {
        // The two-cards-in-a-lane scenario: an effect and an instrument
        // mounted at the same time on separate connections.
        let effect = open()
        defer { effect.cancel(with: .normalClosure, reason: nil) }
        try await hello(effect)
        _ = try await nextText(effect, type: "pluginList")
        try await sendJSON(effect, ["type": "mount", "pluginId": "au:aufx:dely:appl"])
        let effectMounted = try await nextText(effect, type: "mounted")
        XCTAssertEqual((effectMounted["plugin"] as? [String: Any])?["id"] as? String,
                       "au:aufx:dely:appl")

        let instrument = open()
        defer { instrument.cancel(with: .normalClosure, reason: nil) }
        try await hello(instrument)
        _ = try await nextText(instrument, type: "pluginList")
        try await sendJSON(instrument, ["type": "mount", "pluginId": "au:aumu:dls :appl"])
        let instrumentMounted = try await nextText(instrument, type: "mounted")
        XCTAssertEqual((instrumentMounted["plugin"] as? [String: Any])?["id"] as? String,
                       "au:aumu:dls :appl")

        // Both render, independently: the effect passes audio; the
        // instrument sounds a note pulled by clock blocks.
        try await instrument.send(.data(MidiWire.encode(
            seq: 0, events: [MidiEvent(sampleTime: 0, bytes: [0x90, 60, 110])])))
        let input = sine(512)
        var effectPeak: Float = 0
        var instrumentPeak: Float = 0
        var sampleTime: UInt64 = 0
        for seq in 0..<50 {
            try await sendAudio(effect, seq: UInt16(seq), sampleTime: sampleTime,
                                planes: [input, input])
            effectPeak = max(effectPeak, try await nextBinary(effect)
                .planes[0].reduce(0) { max($0, abs($1)) })
            try await sendAudio(instrument, seq: UInt16(seq), sampleTime: sampleTime, planes: [])
            instrumentPeak = max(instrumentPeak, try await nextBinary(instrument)
                .planes[0].reduce(0) { max($0, abs($1)) })
            sampleTime += 512
            if effectPeak > 0.05, instrumentPeak > 0.01 { break }
        }
        XCTAssertGreaterThan(effectPeak, 0.05, "effect instance produced no audio")
        XCTAssertGreaterThan(instrumentPeak, 0.01, "instrument instance produced no audio")
    }

    func testClientIdReattachKeepsPlugin() async throws {
        let first = open()
        try await hello(first, clientId: "card-A")
        _ = try await nextText(first, type: "pluginList")
        try await sendJSON(first, ["type": "mount", "pluginId": "au:aufx:dely:appl"])
        _ = try await nextText(first, type: "mounted")
        first.cancel(with: .normalClosure, reason: nil)

        // Give the server a beat to process the close (it parks the instance).
        try await Task.sleep(nanoseconds: 200_000_000)

        let second = open()
        defer { second.cancel(with: .normalClosure, reason: nil) }
        try await hello(second, clientId: "card-A")
        // No mount sent — the parked instance replays `mounted` by itself.
        let remounted = try await nextText(second, type: "mounted")
        XCTAssertEqual((remounted["plugin"] as? [String: Any])?["id"] as? String,
                       "au:aufx:dely:appl")
    }

    func testDuplicateClientIdEvictsLiveSession() async throws {
        let first = open()
        defer { first.cancel(with: .normalClosure, reason: nil) }
        try await hello(first, clientId: "card-B")
        _ = try await nextText(first, type: "pluginList")

        let second = open()
        defer { second.cancel(with: .normalClosure, reason: nil) }
        try await hello(second, clientId: "card-B")
        let info = try await nextText(second, type: "helperInfo")
        XCTAssertEqual(info["rate"] as? Double, 48000)

        let stopped = try await nextText(first, type: "status")
        XCTAssertEqual(stopped["state"] as? String, "stopped")
    }
}
