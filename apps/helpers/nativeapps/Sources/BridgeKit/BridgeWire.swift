// BridgeWire.swift
//
// The shared binary wire format of the patchtogether bridge protocol family.
// The audio-block codec is COPIED 2026-08-19 from
// ../patchtogether.es9/Sources/ES9Core/BridgeProtocol.swift (that repo keeps
// shipping unchanged until its es9 build migrates here); the browser-side
// twin is inet.modular packages/web/src/lib/audio/es9/es9-protocol.ts. If a
// bug is found in any copy, fix ALL of them. ES-9-specific control messages
// (deviceInfo/config/meters + ChannelMode) stayed in the es9 repo; each
// bridge defines its own control plane on top of these shared frames.
//
// Transport: one WebSocket on localhost.
//   - TEXT frames  = JSON control messages (per-bridge, plus the shared
//     hello/status/ping/pong in ControlMessages.swift). Low rate.
//   - BINARY frames = high-rate blocks, little-endian, dispatched on the
//     first byte: 0x01 = audio block (this file), 0x02 = MIDI event block
//     (MidiWire.swift).
//
// Binary audio frame layout (little-endian):
//   offset size  field
//   0      1     type        0x01 = audio block
//   1      1     flags       bit0 = planar float32 (always set in v1)
//   2      2     seq         u16, wraps; per-sender monotonic
//   4      8     sampleTime  u64, sender's running frame counter at block start
//   12     4     channelMask u32, bit c set => channel c's plane is present
//   16     2     frameCount  u16, frames per plane
//   18     2     reserved    0
//   20     ...   payload     for each set bit c (ascending): frameCount * f32
//
// A mask of 0 is legal: a "clock block" that carries frameCount frames of
// implied silence and no planes — how a client pulls rendering out of a
// bridge that needs no audio input (e.g. a mounted instrument plugin).

import Foundation

public enum BridgeWire {
    public static let protocolVersion = 1
    public static let audioFrameType: UInt8 = 0x01
    public static let flagPlanarFloat32: UInt8 = 0x01
    public static let headerSize = 20
    /// Hard cap so a hostile/buggy peer can't make us allocate absurd blocks.
    public static let maxFrameCount = 4096
}

/// One decoded audio block: which channels are present and one Float32 plane
/// per present channel (in ascending channel order).
public struct AudioBlock: Equatable {
    public var seq: UInt16
    public var sampleTime: UInt64
    public var channelMask: UInt32
    public var frameCount: Int
    /// Planes in ascending set-bit order of `channelMask`.
    public var planes: [[Float]]

    public init(seq: UInt16, sampleTime: UInt64, channelMask: UInt32,
                frameCount: Int, planes: [[Float]]) {
        self.seq = seq
        self.sampleTime = sampleTime
        self.channelMask = channelMask
        self.frameCount = frameCount
        self.planes = planes
    }

    /// Channel indices present, ascending (e.g. mask 0b1010 -> [1, 3]).
    public var channels: [Int] { BridgeWire.channels(in: channelMask) }

    /// The plane for absolute channel index `c`, or nil if not present.
    public func plane(channel c: Int) -> [Float]? {
        guard channelMask & (1 << UInt32(c)) != 0 else { return nil }
        let idx = channels.firstIndex(of: c)!
        return planes[idx]
    }
}

extension BridgeWire {
    public static func channels(in mask: UInt32) -> [Int] {
        var out: [Int] = []
        var m = mask
        while m != 0 {
            let c = m.trailingZeroBitCount
            out.append(c)
            m &= m - 1
        }
        return out
    }

    // MARK: - Encode

    public static func encode(_ block: AudioBlock) -> Data {
        let chans = block.channels
        precondition(chans.count == block.planes.count, "mask/planes mismatch")
        var data = Data(capacity: headerSize + chans.count * block.frameCount * 4)
        data.append(audioFrameType)
        data.append(flagPlanarFloat32)
        appendLE(&data, block.seq)
        appendLE(&data, block.sampleTime)
        appendLE(&data, block.channelMask)
        appendLE(&data, UInt16(block.frameCount))
        appendLE(&data, UInt16(0))
        for plane in block.planes {
            precondition(plane.count == block.frameCount, "plane length mismatch")
            plane.withUnsafeBytes { data.append(contentsOf: $0) }
        }
        return data
    }

    // MARK: - Decode

    public enum DecodeError: Error, Equatable {
        case tooShort
        case unknownType(UInt8)
        case badFlags(UInt8)
        case frameCountOutOfRange(Int)
        case payloadSizeMismatch(expected: Int, got: Int)
    }

    public static func decode(_ data: Data) throws -> AudioBlock {
        guard data.count >= headerSize else { throw DecodeError.tooShort }
        let bytes = [UInt8](data)   // control-plane rates; copying is fine here
        guard bytes[0] == audioFrameType else { throw DecodeError.unknownType(bytes[0]) }
        guard bytes[1] & flagPlanarFloat32 != 0 else { throw DecodeError.badFlags(bytes[1]) }
        let seq = readLE16(bytes, 2)
        let sampleTime = readLE64(bytes, 4)
        let mask = readLE32(bytes, 12)
        let frameCount = Int(readLE16(bytes, 16))
        guard frameCount > 0, frameCount <= maxFrameCount else {
            throw DecodeError.frameCountOutOfRange(frameCount)
        }
        let chans = channels(in: mask)
        let expected = headerSize + chans.count * frameCount * 4
        guard data.count == expected else {
            throw DecodeError.payloadSizeMismatch(expected: expected, got: data.count)
        }
        var planes: [[Float]] = []
        planes.reserveCapacity(chans.count)
        var off = headerSize
        for _ in chans {
            var plane = [Float](repeating: 0, count: frameCount)
            plane.withUnsafeMutableBytes { dst in
                bytes.withUnsafeBytes { src in
                    dst.copyMemory(from: UnsafeRawBufferPointer(
                        rebasing: src[off..<(off + frameCount * 4)]))
                }
            }
            planes.append(plane)
            off += frameCount * 4
        }
        return AudioBlock(seq: seq, sampleTime: sampleTime, channelMask: mask,
                          frameCount: frameCount, planes: planes)
    }

    // MARK: - little-endian helpers (shared with MidiWire)

    static func appendLE<T: FixedWidthInteger>(_ data: inout Data, _ v: T) {
        var le = v.littleEndian
        withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
    }
    static func readLE16(_ b: [UInt8], _ o: Int) -> UInt16 {
        UInt16(b[o]) | (UInt16(b[o + 1]) << 8)
    }
    static func readLE32(_ b: [UInt8], _ o: Int) -> UInt32 {
        UInt32(b[o]) | (UInt32(b[o + 1]) << 8) | (UInt32(b[o + 2]) << 16) | (UInt32(b[o + 3]) << 24)
    }
    static func readLE64(_ b: [UInt8], _ o: Int) -> UInt64 {
        UInt64(readLE32(b, o)) | (UInt64(readLE32(b, o + 4)) << 32)
    }
}
