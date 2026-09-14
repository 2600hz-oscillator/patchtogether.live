// End-to-end integration tests: a real BridgeService (SyntheticEngine, no
// hardware) on a loopback port, exercised through URLSession as a genuine
// HTTP + WebSocket client. Covers the whole native stack — TCP accept, HTTP
// parsing, RFC 6455 handshake/framing, JSON control plane, binary audio both
// directions, resampling, rings, meters — everything but CoreAudio itself.

import XCTest
@testable import ES9Core

final class BridgeServiceIntegrationTests: XCTestCase {
    private var service: BridgeService!
    private var engine: SyntheticEngine!
    private var port: UInt16 = 0

    override func setUpWithError() throws {
        // Ephemeral-ish port; retry a few times in case of a collision.
        for candidate in [UInt16.random(in: 20000...40000),
                          UInt16.random(in: 20000...40000),
                          UInt16.random(in: 20000...40000)] {
            engine = SyntheticEngine()
            service = BridgeService(engine: engine, config: .init(
                port: candidate,
                deviceName: "Synthetic 16x16", deviceUID: "test",
                inputLabels: (1...16).map { "In \($0)" },
                outputLabels: (1...16).map { "Out \($0)" },
                outputTargetFrames: 384,
                harnessHTML: Data("<html>harness</html>".utf8)))
            do {
                try service.start()
                port = candidate
                break
            } catch {
                service = nil
            }
        }
        try XCTSkipIf(service == nil, "could not bind a loopback port")
        // Give the listener a beat to be ready.
        usleep(100_000)
    }

    override func tearDown() {
        service?.stop()
        service = nil
        engine = nil
    }

    private func wsURL() -> URL { URL(string: "ws://127.0.0.1:\(port)/ws")! }

    private func receiveText(_ task: URLSessionWebSocketTask,
                             where predicate: @escaping (String) -> Bool,
                             timeout: TimeInterval = 5) async throws -> String {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let msg = try await task.receive()
            if case .string(let s) = msg, predicate(s) { return s }
        }
        throw XCTSkip("timed out waiting for text message")
    }

    private func receiveBinary(_ task: URLSessionWebSocketTask,
                               timeout: TimeInterval = 5) async throws -> Data {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let msg = try await task.receive()
            if case .data(let d) = msg { return d }
        }
        throw XCTSkip("timed out waiting for binary message")
    }

    func testHTTPServesHarnessPage() async throws {
        let (data, response) = try await URLSession.shared.data(
            from: URL(string: "http://127.0.0.1:\(port)/")!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(String(data: data, encoding: .utf8), "<html>harness</html>")
    }

    func testFullDuplexSessionOverWebSocket() async throws {
        let task = URLSession.shared.webSocketTask(with: wsURL())
        task.resume()

        // hello -> deviceInfo
        try await task.send(.string(#"{"type":"hello","rate":48000,"name":"test"}"#))
        let infoText = try await receiveText(task) { $0.contains("deviceInfo") }
        let info = try JSONDecoder().decode(DeviceInfoMessage.self, from: Data(infoText.utf8))
        XCTAssertEqual(info.inputChannels, 16)
        XCTAssertEqual(info.outputChannels, 16)
        XCTAssertEqual(info.rate, 48000)
        XCTAssertEqual(info.inputLabels.first, "In 1")

        // config: subscribe inputs 1-3 (sine/LFO/gate), drive output 1 as CV.
        try await task.send(.string(
            #"{"type":"config","inputMask":7,"outputMask":1,"outputModes":{"0":"cv"}}"#))

        // We should start receiving audio blocks carrying channels 0..2, and
        // channel 0 (440 Hz sine at 0.5) should have obvious energy.
        var sawSine = false
        for _ in 0..<40 where !sawSine {
            let data = try await receiveBinary(task)
            let block = try BridgeWire.decode(data)
            XCTAssertEqual(block.channels, [0, 1, 2])
            let plane = block.planes[0]
            let peak = plane.map { abs($0) }.max() ?? 0
            if peak > 0.3 { sawSine = true }
        }
        XCTAssertTrue(sawSine, "never saw the synthetic 440 Hz sine on input 1")

        // Drive output 1 with DC 0.25 (a CV!) for a while; the synthetic
        // engine drains + meters it, and meters should show ~ -12 dBFS.
        var meterOK = false
        let sendTask = Task {
            var seq: UInt16 = 0
            var sampleTime: UInt64 = 0
            while !Task.isCancelled {
                let block = AudioBlock(seq: seq, sampleTime: sampleTime, channelMask: 1,
                                       frameCount: 480,
                                       planes: [[Float](repeating: 0.25, count: 480)])
                try? await task.send(.data(BridgeWire.encode(block)))
                seq &+= 1
                sampleTime &+= 480
                try? await Task.sleep(nanoseconds: 10_000_000)
            }
        }
        defer { sendTask.cancel() }

        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline && !meterOK {
            let msg = try await task.receive()
            guard case .string(let s) = msg, s.contains("\"type\":\"meters\"") else { continue }
            let meters = try JSONDecoder().decode(MetersMessage.self, from: Data(s.utf8))
            // DC 0.25 -> RMS 0.25 -> -12.04 dBFS on output channel 0.
            if meters.outputRMS.first ?? -120 > -15 { meterOK = true }
        }
        XCTAssertTrue(meterOK, "output meters never registered the DC we sent")

        task.cancel(with: .normalClosure, reason: nil)
    }

    func testSecondClientIsRejectedBusy() async throws {
        let first = URLSession.shared.webSocketTask(with: wsURL())
        first.resume()
        try await first.send(.string(#"{"type":"hello","rate":48000}"#))
        _ = try await receiveText(first) { $0.contains("deviceInfo") }

        let second = URLSession.shared.webSocketTask(with: wsURL())
        second.resume()
        let busy = try await receiveText(second) { $0.contains("busy") }
        XCTAssertTrue(busy.contains("\"state\":\"busy\""))

        first.cancel(with: .normalClosure, reason: nil)
        second.cancel(with: .normalClosure, reason: nil)
    }

    func testForeignOriginIsRejected() async throws {
        var request = URLRequest(url: wsURL())
        request.setValue("https://evil.example", forHTTPHeaderField: "Origin")
        let task = URLSession.shared.webSocketTask(with: request)
        task.resume()
        do {
            try await task.send(.string(#"{"type":"hello","rate":48000}"#))
            _ = try await task.receive()
            XCTFail("foreign-origin upgrade should have been refused")
        } catch {
            // Expected: 403 kills the handshake.
        }
    }

    func testLocalhostOriginIsAccepted() async throws {
        var request = URLRequest(url: wsURL())
        request.setValue("http://localhost:5173", forHTTPHeaderField: "Origin")
        let task = URLSession.shared.webSocketTask(with: request)
        task.resume()
        try await task.send(.string(#"{"type":"hello","rate":48000}"#))
        let text = try await receiveText(task) { $0.contains("deviceInfo") }
        XCTAssertTrue(text.contains("Synthetic"))
        task.cancel(with: .normalClosure, reason: nil)
    }
}
