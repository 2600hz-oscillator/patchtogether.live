// MidiQueueTests.swift

import XCTest
import BridgeKit
@testable import VSTBridgeCore

final class MidiQueueTests: XCTestCase {
    private func ev(_ t: UInt64, _ status: UInt8 = 0x90) -> MidiEvent {
        MidiEvent(sampleTime: t, bytes: [status, 60, 100])
    }

    func testTakeBeforeIsExclusiveAndOrdered() {
        var q = MidiQueue()
        q.add([ev(100), ev(300), ev(200)])
        let taken = q.take(before: 300)
        XCTAssertEqual(taken.map(\.sampleTime), [100, 200])
        XCTAssertEqual(q.count, 1)
        XCTAssertEqual(q.take(before: 1000).map(\.sampleTime), [300])
        XCTAssertTrue(q.take(before: .max).isEmpty)
    }

    func testTiesKeepArrivalOrder() {
        // A note-off queued after a note-on at the same timestamp must come
        // out after it, or every zero-length note swallows its own on.
        var q = MidiQueue()
        q.add([MidiEvent(sampleTime: 500, bytes: [0x90, 60, 100])])
        q.add([MidiEvent(sampleTime: 500, bytes: [0x80, 60, 0])])
        let taken = q.take(before: 501)
        XCTAssertEqual(taken.map { $0.bytes[0] }, [0x90, 0x80])
    }

    func testLateEventsStillComeOut() {
        var q = MidiQueue()
        q.add([ev(10)])
        // Block span [1000, 1512): the late event is delivered (offset
        // clamping is the caller's job), not silently stuck.
        XCTAssertEqual(q.take(before: 1512).count, 1)
    }

    func testOverflowDropsOldest() {
        var q = MidiQueue()
        q.add((0..<MidiQueue.capacity + 10).map { ev(UInt64($0)) })
        XCTAssertEqual(q.count, MidiQueue.capacity)
        XCTAssertEqual(q.droppedEvents, 10)
        XCTAssertEqual(q.take(before: 11).count, 1)   // 0-9 were dropped
    }

    func testRemoveAll() {
        var q = MidiQueue()
        q.add([ev(1), ev(2)])
        q.removeAll()
        XCTAssertEqual(q.count, 0)
    }
}
