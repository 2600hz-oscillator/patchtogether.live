// WireTests.swift — audio + MIDI block codecs (the wire contract).

import XCTest
@testable import BridgeKit

final class AudioWireTests: XCTestCase {
    func testRoundTrip() throws {
        let block = AudioBlock(
            seq: 41, sampleTime: 123_456_789_012, channelMask: 0b1010,
            frameCount: 3, planes: [[0.1, -0.5, 1.0], [-1.0, 0.25, 0.0]])
        let decoded = try BridgeWire.decode(BridgeWire.encode(block))
        XCTAssertEqual(decoded, block)
        XCTAssertEqual(decoded.channels, [1, 3])
        XCTAssertEqual(decoded.plane(channel: 3), [-1.0, 0.25, 0.0])
        XCTAssertNil(decoded.plane(channel: 0))
    }

    func testClockOnlyBlock() throws {
        // mask 0 = a clock block: frames advance, no planes (instrument pull).
        let block = AudioBlock(seq: 1, sampleTime: 480, channelMask: 0,
                               frameCount: 128, planes: [])
        let decoded = try BridgeWire.decode(BridgeWire.encode(block))
        XCTAssertEqual(decoded.frameCount, 128)
        XCTAssertTrue(decoded.planes.isEmpty)
    }

    func testRejectsMalformed() {
        XCTAssertThrowsError(try BridgeWire.decode(Data([0x01, 0x01])))  // too short
        var bad = BridgeWire.encode(AudioBlock(seq: 0, sampleTime: 0,
                                               channelMask: 1, frameCount: 1, planes: [[0]]))
        bad[0] = 0x7F
        XCTAssertThrowsError(try BridgeWire.decode(bad))                 // unknown type
        var truncated = BridgeWire.encode(AudioBlock(seq: 0, sampleTime: 0,
                                                     channelMask: 1, frameCount: 2, planes: [[0, 0]]))
        truncated.removeLast()
        XCTAssertThrowsError(try BridgeWire.decode(truncated))           // size mismatch
    }

    func testChannelMaskHelper() {
        XCTAssertEqual(BridgeWire.channels(in: 0b1010), [1, 3])
        XCTAssertEqual(BridgeWire.channels(in: 0), [])
        XCTAssertEqual(BridgeWire.channels(in: 0x8000_0001), [0, 31])
    }
}

final class MidiWireTests: XCTestCase {
    func testRoundTrip() throws {
        let events = [
            MidiEvent(sampleTime: 1000, bytes: [0x90, 60, 100]),
            MidiEvent(sampleTime: 1512, bytes: [0x80, 60, 0]),
            MidiEvent(sampleTime: 2000, bytes: [0xF8]),          // 1-byte realtime
            MidiEvent(sampleTime: 2001, bytes: [0xC0, 5]),       // 2-byte program change
        ]
        let data = MidiWire.encode(seq: 7, events: events)
        XCTAssertEqual(data.count, MidiWire.headerSize + 4 * MidiWire.eventSize)
        let (seq, decoded) = try MidiWire.decode(data)
        XCTAssertEqual(seq, 7)
        XCTAssertEqual(decoded, events)
    }

    func testEmptyBatch() throws {
        let (_, decoded) = try MidiWire.decode(MidiWire.encode(seq: 0, events: []))
        XCTAssertEqual(decoded, [])
    }

    func testRejectsMalformed() {
        XCTAssertThrowsError(try MidiWire.decode(Data([0x02])))          // too short
        var wrongType = MidiWire.encode(seq: 0, events: [])
        wrongType[0] = 0x01
        XCTAssertThrowsError(try MidiWire.decode(wrongType))
        // Corrupt an event length in place.
        var badLen = MidiWire.encode(seq: 0, events: [MidiEvent(sampleTime: 0, bytes: [0x90, 1, 1])])
        badLen[MidiWire.headerSize + 8] = 0
        XCTAssertThrowsError(try MidiWire.decode(badLen))
        badLen[MidiWire.headerSize + 8] = 9
        XCTAssertThrowsError(try MidiWire.decode(badLen))
        // Truncated payload.
        var short = MidiWire.encode(seq: 0, events: [MidiEvent(sampleTime: 0, bytes: [0x90, 1, 1])])
        short.removeLast()
        XCTAssertThrowsError(try MidiWire.decode(short))
    }
}
