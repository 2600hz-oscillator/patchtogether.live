// MidiWire.swift
//
// Binary MIDI event blocks — the 0x02 frame type of the bridge wire format
// (0x01 audio blocks live in BridgeWire.swift). New in this repo: the ES-9
// bridge never needed MIDI; the VST bridge does, and any future bridge may
// reuse it. The browser twin lives with the card (inet.modular) and, like
// the audio codec, DUPLICATES these constants rather than importing them.
//
// Frame layout (little-endian):
//   offset size  field
//   0      1     type      0x02 = MIDI event block
//   1      1     flags     0 in v1
//   2      2     seq       u16, wraps; per-sender monotonic
//   4      2     count     u16 number of events (<= 1024)
//   6      2     reserved  0
//   8      ...   count events, 12 bytes each:
//                  0  8   sampleTime  u64 — the SENDER's sample clock at
//                         which the event should sound (same clock as the
//                         sampleTime in its audio blocks)
//                  8  1   length      1...3
//                  9  3   data        MIDI bytes, zero-padded
//
// v1 carries channel-voice/realtime messages only (1-3 bytes). SysEx would
// need a variable-length frame — deliberately out of scope.

import Foundation

/// One timestamped MIDI event on the sender's sample clock.
public struct MidiEvent: Equatable, Sendable {
    public var sampleTime: UInt64
    /// 1-3 raw MIDI bytes (status + data).
    public var bytes: [UInt8]

    public init(sampleTime: UInt64, bytes: [UInt8]) {
        self.sampleTime = sampleTime
        self.bytes = bytes
    }
}

public enum MidiWire {
    public static let frameType: UInt8 = 0x02
    public static let headerSize = 8
    public static let eventSize = 12
    /// Cap so a hostile/buggy peer can't queue absurd batches.
    public static let maxEvents = 1024

    // MARK: - Encode

    public static func encode(seq: UInt16, events: [MidiEvent]) -> Data {
        precondition(events.count <= maxEvents, "too many events")
        var data = Data(capacity: headerSize + events.count * eventSize)
        data.append(frameType)
        data.append(0)
        BridgeWire.appendLE(&data, seq)
        BridgeWire.appendLE(&data, UInt16(events.count))
        BridgeWire.appendLE(&data, UInt16(0))
        for ev in events {
            precondition((1...3).contains(ev.bytes.count), "bad event length")
            BridgeWire.appendLE(&data, ev.sampleTime)
            data.append(UInt8(ev.bytes.count))
            data.append(contentsOf: ev.bytes)
            for _ in ev.bytes.count..<3 { data.append(0) }
        }
        return data
    }

    // MARK: - Decode

    public enum DecodeError: Error, Equatable {
        case tooShort
        case unknownType(UInt8)
        case countOutOfRange(Int)
        case payloadSizeMismatch(expected: Int, got: Int)
        case badEventLength(Int)
    }

    public static func decode(_ data: Data) throws -> (seq: UInt16, events: [MidiEvent]) {
        guard data.count >= headerSize else { throw DecodeError.tooShort }
        let bytes = [UInt8](data)
        guard bytes[0] == frameType else { throw DecodeError.unknownType(bytes[0]) }
        let seq = BridgeWire.readLE16(bytes, 2)
        let count = Int(BridgeWire.readLE16(bytes, 4))
        guard count <= maxEvents else { throw DecodeError.countOutOfRange(count) }
        let expected = headerSize + count * eventSize
        guard data.count == expected else {
            throw DecodeError.payloadSizeMismatch(expected: expected, got: data.count)
        }
        var events: [MidiEvent] = []
        events.reserveCapacity(count)
        var off = headerSize
        for _ in 0..<count {
            let t = BridgeWire.readLE64(bytes, off)
            let len = Int(bytes[off + 8])
            guard (1...3).contains(len) else { throw DecodeError.badEventLength(len) }
            events.append(MidiEvent(sampleTime: t,
                                    bytes: Array(bytes[(off + 9)..<(off + 9 + len)])))
            off += eventSize
        }
        return (seq, events)
    }
}
