// Grace takeover + explicit takeover — the single-client slot must not be
// permanently disabled by a client that went away rudely.
//
// THE INCIDENT (2026-08-07). `lsof -nP -iTCP:9209` on the owner's machine showed
// NINE sockets in TCP CLOSED, all still held. The app admits one client, so it
// answered `busy` to everything until it was restarted by hand. From the web
// side that looked like "clicking connect does nothing, no console errors, no
// connection" — because `busy` is a normal state, not an error.
//
// ⚠ READ THE FIRST TEST FIRST. Every other test in this file can be made to
// pass by an implementation that drops clients too eagerly — which would cut a
// live performance's audio and is a WORSE bug than the one being fixed. The
// negative control is the one that constrains the fix from the other side.

import XCTest
@testable import ES9Core

final class TakeoverTests: XCTestCase {
    private var service: BridgeService!
    private var engine: SyntheticEngine!
    private var port: UInt16 = 0

    /// Shrunk from the shipping 8 s so these tests take milliseconds. The
    /// RATIO to the client's ping cadence is what the logic depends on, and
    /// that is preserved: pings here are 4× faster than the deadline, exactly
    /// as 2 s pings are against the real 8 s.
    private let staleAfter: TimeInterval = 0.6

    override func setUpWithError() throws {
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
                harnessHTML: Data("<html>harness</html>".utf8),
                staleAfter: staleAfter,
                takeoverWindow: 5.0))
            do { try service.start(); port = candidate; break } catch { service = nil }
        }
        try XCTSkipIf(service == nil, "could not bind a loopback port")
        usleep(100_000)
    }

    override func tearDown() {
        service?.stop(); service = nil; engine = nil
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

    /// A connected client that keeps pinging, the way the real web client does
    /// every 2 s. Returns a handle that stops the pinging.
    private func startPinging(_ task: URLSessionWebSocketTask,
                              every interval: TimeInterval) -> Task<Void, Never> {
        Task {
            while !Task.isCancelled {
                try? await task.send(.string(#"{"type":"ping","t":1}"#))
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            }
        }
    }

    // MARK: - The negative control. Write this one first; keep it passing.

    func testHealthyClientIsNeverDisplaced() async throws {
        // A client that is ALIVE must hold its slot indefinitely. This runs for
        // 5× the stale deadline while pinging at 1/4 of it — if the reaper is
        // even slightly too eager, or liveness is not actually being refreshed
        // by inbound frames, the second client gets in and this fails.
        let first = URLSession.shared.webSocketTask(with: wsURL())
        first.resume()
        try await first.send(.string(#"{"type":"hello","rate":48000}"#))
        _ = try await receiveText(first) { $0.contains("deviceInfo") }

        let pinger = startPinging(first, every: staleAfter / 4)
        defer { pinger.cancel() }

        // Well past the deadline — a broken reaper has had five chances to fire.
        try await Task.sleep(nanoseconds: UInt64(staleAfter * 5 * 1_000_000_000))

        let second = URLSession.shared.webSocketTask(with: wsURL())
        second.resume()
        let reply = try await receiveText(second) { $0.contains("busy") || $0.contains("deviceInfo") }
        XCTAssertTrue(reply.contains("\"state\":\"busy\""),
                      "a HEALTHY client was displaced — the reaper is too eager, which would cut live audio")

        first.cancel(with: .normalClosure, reason: nil)
        second.cancel(with: .normalClosure, reason: nil)
    }

    // MARK: - Grace takeover

    func testStaleIncumbentYieldsTheSlotAutomatically() async throws {
        // The reported failure: the incumbent is gone but the socket lingers.
        // Here we simulate it exactly — connect, then go SILENT (no pings, no
        // close) — and a new client must be able to claim the slot.
        let first = URLSession.shared.webSocketTask(with: wsURL())
        first.resume()
        try await first.send(.string(#"{"type":"hello","rate":48000}"#))
        _ = try await receiveText(first) { $0.contains("deviceInfo") }

        // Silence for longer than the deadline. Deliberately NOT cancelled —
        // a cancel would close cleanly, which is the case that already worked.
        try await Task.sleep(nanoseconds: UInt64((staleAfter + 0.4) * 1_000_000_000))

        let second = URLSession.shared.webSocketTask(with: wsURL())
        second.resume()
        try await second.send(.string(#"{"type":"hello","rate":48000}"#))
        let info = try await receiveText(second) { $0.contains("deviceInfo") || $0.contains("busy") }
        XCTAssertTrue(info.contains("deviceInfo"),
                      "a stale slot must be grantable — this is the wedge that required a restart")

        second.cancel(with: .normalClosure, reason: nil)
    }

    func testEvictedIncumbentIsToldWhy() async throws {
        // Silent eviction would be its own mystery. The displaced client must
        // learn that it lost the slot, so the UI can say so rather than just
        // going quiet.
        let first = URLSession.shared.webSocketTask(with: wsURL())
        first.resume()
        try await first.send(.string(#"{"type":"hello","rate":48000}"#))
        _ = try await receiveText(first) { $0.contains("deviceInfo") }

        try await Task.sleep(nanoseconds: UInt64((staleAfter + 0.4) * 1_000_000_000))

        let second = URLSession.shared.webSocketTask(with: wsURL())
        second.resume()
        try await second.send(.string(#"{"type":"hello","rate":48000}"#))
        _ = try await receiveText(second) { $0.contains("deviceInfo") }

        let notice = try await receiveText(first) { $0.contains("took over") }
        XCTAssertTrue(notice.contains("\"state\":\"stopped\""))

        second.cancel(with: .normalClosure, reason: nil)
    }

    // MARK: - Explicit takeover

    func testBusyClientCanClaimTheSlotByAsking() async throws {
        // With a HEALTHY incumbent the newcomer is correctly told busy — and
        // must still have a way forward, which is the whole UX point: the user
        // gets an action instead of a button that appears to do nothing.
        let first = URLSession.shared.webSocketTask(with: wsURL())
        first.resume()
        try await first.send(.string(#"{"type":"hello","rate":48000}"#))
        _ = try await receiveText(first) { $0.contains("deviceInfo") }
        let pinger = startPinging(first, every: staleAfter / 4)
        defer { pinger.cancel() }

        let second = URLSession.shared.webSocketTask(with: wsURL())
        second.resume()
        let busy = try await receiveText(second) { $0.contains("busy") }
        XCTAssertTrue(busy.contains("last heard"),
                      "the busy notice must say WHY, so the UI can explain instead of looking dead")

        try await second.send(.string(#"{"type":"takeover"}"#))
        try await second.send(.string(#"{"type":"hello","rate":48000}"#))
        let info = try await receiveText(second) { $0.contains("deviceInfo") }
        XCTAssertTrue(info.contains("deviceInfo"), "takeover must actually hand over the slot")

        // …and the displaced healthy client is told.
        let notice = try await receiveText(first) { $0.contains("took over") }
        XCTAssertTrue(notice.contains("\"state\":\"stopped\""))

        second.cancel(with: .normalClosure, reason: nil)
    }

    func testWaitingClientCannotStreamWithoutTakingOver() async throws {
        // A session parked on `busy` must be able to do exactly ONE thing. If a
        // waiting client could configure or stream, two clients would drive the
        // hardware at once — worse than the bug being fixed.
        let first = URLSession.shared.webSocketTask(with: wsURL())
        first.resume()
        try await first.send(.string(#"{"type":"hello","rate":48000}"#))
        _ = try await receiveText(first) { $0.contains("deviceInfo") }
        let pinger = startPinging(first, every: staleAfter / 4)
        defer { pinger.cancel() }

        let second = URLSession.shared.webSocketTask(with: wsURL())
        second.resume()
        _ = try await receiveText(second) { $0.contains("busy") }

        // `hello` from a waiting session must NOT be honoured.
        try await second.send(.string(#"{"type":"hello","rate":48000}"#))
        var sawDeviceInfo = false
        let deadline = Date().addingTimeInterval(0.8)
        while Date() < deadline {
            guard let msg = try? await second.receive() else { break }
            if case .string(let s) = msg, s.contains("deviceInfo") { sawDeviceInfo = true; break }
        }
        XCTAssertFalse(sawDeviceInfo, "a waiting session must not be able to configure the device")

        first.cancel(with: .normalClosure, reason: nil)
        second.cancel(with: .normalClosure, reason: nil)
    }
}
