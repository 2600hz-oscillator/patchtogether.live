// BridgeProtocol.swift
//
// The wire protocol between the native bridge and a browser client (the
// patchtogether ES-9 module, or the embedded test harness). Version 1.
//
// Transport: one WebSocket on localhost.
//   - TEXT frames  = JSON control messages (hello, deviceInfo, config,
//     meters, status, ping/pong). Low rate, human-debuggable.
//   - BINARY frames = audio/CV blocks, both directions, little-endian,
//     planar Float32. High rate; layout below.
//
// This protocol is the PLATFORM CONTRACT: a future Windows bridge (WASAPI)
// implements exactly this and the browser module works unchanged.
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
// Direction is implied by who sends: bridge->client blocks carry ES-9 INPUT
// channels; client->bridge blocks carry ES-9 OUTPUT channels. The mask lets a
// client subscribe to / drive any subset of channels.

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

    // MARK: - little-endian helpers

    private static func appendLE<T: FixedWidthInteger>(_ data: inout Data, _ v: T) {
        var le = v.littleEndian
        withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
    }
    private static func readLE16(_ b: [UInt8], _ o: Int) -> UInt16 {
        UInt16(b[o]) | (UInt16(b[o + 1]) << 8)
    }
    private static func readLE32(_ b: [UInt8], _ o: Int) -> UInt32 {
        UInt32(b[o]) | (UInt32(b[o + 1]) << 8) | (UInt32(b[o + 2]) << 16) | (UInt32(b[o + 3]) << 24)
    }
    private static func readLE64(_ b: [UInt8], _ o: Int) -> UInt64 {
        UInt64(readLE32(b, o)) | (UInt64(readLE32(b, o + 4)) << 32)
    }
}

// MARK: - JSON control messages

/// Per-output-channel underrun policy. `audio` fades to silence on underrun
/// (speaker-safe); `cv` HOLDS THE LAST VALUE (a CV that snaps to 0 V on a
/// network hiccup would yank every patched parameter — holding is correct).
public enum ChannelMode: String, Codable, Sendable {
    case audio
    case cv
}

/// Client -> bridge, first message after connect.
public struct HelloMessage: Codable, Equatable {
    public var type = "hello"
    /// Client's AudioContext sample rate; the bridge resamples to/from it.
    public var rate: Double
    public var name: String?
    public init(rate: Double, name: String? = nil) {
        self.rate = rate
        self.name = name
    }
}

/// Bridge -> client, reply to hello (and on device change).
public struct DeviceInfoMessage: Codable, Equatable {
    public var type = "deviceInfo"
    public var protocolVersion: Int
    public var name: String
    public var uid: String
    public var rate: Double            // hardware sample rate
    public var inputChannels: Int
    public var outputChannels: Int
    public var bufferFrames: Int
    /// Human labels, index = channel. For the ES-9 defaults: inputs 1-14 are
    /// the DC-coupled jacks, 15/16 the S/PDIF return; outputs 1-8 the
    /// DC-coupled jacks.
    public var inputLabels: [String]
    public var outputLabels: [String]
    public init(protocolVersion: Int = BridgeWire.protocolVersion, name: String, uid: String,
                rate: Double, inputChannels: Int, outputChannels: Int, bufferFrames: Int,
                inputLabels: [String], outputLabels: [String]) {
        self.protocolVersion = protocolVersion
        self.name = name
        self.uid = uid
        self.rate = rate
        self.inputChannels = inputChannels
        self.outputChannels = outputChannels
        self.bufferFrames = bufferFrames
        self.inputLabels = inputLabels
        self.outputLabels = outputLabels
    }
}

/// Client -> bridge: which ES-9 input channels to stream to me, which output
/// channels I will drive, and each driven output's underrun mode.
public struct ConfigMessage: Codable, Equatable {
    public var type = "config"
    public var inputMask: UInt32
    public var outputMask: UInt32
    /// Sparse map: channel index (as string, JSON keys are strings) -> mode.
    /// Channels absent from the map default to `.audio`.
    public var outputModes: [String: ChannelMode]?
    public init(inputMask: UInt32, outputMask: UInt32,
                outputModes: [String: ChannelMode]? = nil) {
        self.inputMask = inputMask
        self.outputMask = outputMask
        self.outputModes = outputModes
    }
}

/// Bridge -> client, ~8 Hz: per-channel dBFS meters and health counters.
public struct MetersMessage: Codable, Equatable {
    public var type = "meters"
    public var inputRMS: [Float]
    public var outputRMS: [Float]
    /// RT-side underruns of the client->hardware ring since start.
    public var underruns: Int
    /// RT-side overflow drops of the hardware->client ring since start.
    public var overruns: Int
    /// Current occupancy (frames) of the client->hardware jitter buffer.
    public var outputBufferFrames: Int
    public init(inputRMS: [Float], outputRMS: [Float], underruns: Int,
                overruns: Int, outputBufferFrames: Int) {
        self.inputRMS = inputRMS
        self.outputRMS = outputRMS
        self.underruns = underruns
        self.overruns = overruns
        self.outputBufferFrames = outputBufferFrames
    }
}

/// Bridge -> client on lifecycle changes.
public struct StatusMessage: Codable, Equatable {
    public var type = "status"
    /// "running" | "no_device" | "device_lost" | "busy"
    public var state: String
    public var detail: String?
    public init(state: String, detail: String? = nil) {
        self.state = state
        self.detail = detail
    }
}

/// Either direction; the peer echoes `t` back as a pong for RTT measurement.
public struct PingMessage: Codable, Equatable {
    public var type = "ping"
    public var t: Double
    public init(t: Double) { self.t = t }
}

public struct PongMessage: Codable, Equatable {
    public var type = "pong"
    public var t: Double
    public init(t: Double) { self.t = t }
}

/// Minimal envelope to sniff the "type" of an incoming control message.
public struct ControlEnvelope: Codable {
    public var type: String
}
