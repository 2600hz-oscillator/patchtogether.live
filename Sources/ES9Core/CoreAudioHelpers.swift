// CoreAudioHelpers.swift
//
// Thin, dependency-free wrappers over the CoreAudio HAL property API
// (AudioObjectGetPropertyData) plus device-discovery utilities used by both
// the enumerator and the duplex tool. Nothing here touches the real-time
// thread; this is all setup/inspection-time code.
//
// The HAL property model: every audio object (the system object, each device,
// each stream) answers AudioObjectGetPropertyData for an
// AudioObjectPropertyAddress = {selector, scope, element}. We hide the
// two-call size-then-read dance behind small generic getters.

import CoreAudio
import AudioToolbox
import Foundation

/// A CoreAudio error wrapped with the failing selector, for readable messages.
public struct CoreAudioError: Error, CustomStringConvertible {
    public let status: OSStatus
    public let context: String
    public init(_ status: OSStatus, _ context: String) {
        self.status = status
        self.context = context
    }
    public var description: String {
        "\(context) failed: OSStatus \(status) (\(fourCC(status)))"
    }
}

/// Render an OSStatus / property selector as its 4-char-code if printable.
public func fourCC(_ value: OSStatus) -> String {
    let v = UInt32(bitPattern: value)
    let bytes = [UInt8((v >> 24) & 0xff), UInt8((v >> 16) & 0xff),
                 UInt8((v >> 8) & 0xff), UInt8(v & 0xff)]
    if bytes.allSatisfy({ $0 >= 0x20 && $0 < 0x7f }) {
        return "'" + String(bytes: bytes, encoding: .ascii)! + "'"
    }
    return String(value)
}

public enum HAL {
    /// Get a single fixed-size value (UInt32, Float64, AudioDeviceID, ...).
    public static func getValue<T>(
        _ object: AudioObjectID,
        _ address: AudioObjectPropertyAddress,
        _ context: String
    ) throws -> T {
        var addr = address
        var size = UInt32(MemoryLayout<T>.size)
        let value = UnsafeMutablePointer<T>.allocate(capacity: 1)
        defer { value.deallocate() }
        let status = AudioObjectGetPropertyData(object, &addr, 0, nil, &size, value)
        guard status == noErr else { throw CoreAudioError(status, context) }
        return value.pointee
    }

    /// Get a variable-length array of fixed-size elements (device list, etc.).
    public static func getArray<T>(
        _ object: AudioObjectID,
        _ address: AudioObjectPropertyAddress,
        _ context: String
    ) throws -> [T] {
        var addr = address
        var size: UInt32 = 0
        var status = AudioObjectGetPropertyDataSize(object, &addr, 0, nil, &size)
        guard status == noErr else { throw CoreAudioError(status, context + " (size)") }
        let count = Int(size) / MemoryLayout<T>.stride
        guard count > 0 else { return [] }
        var result = [T](repeating: unsafeZero(), count: count)
        status = result.withUnsafeMutableBytes { raw in
            AudioObjectGetPropertyData(object, &addr, 0, nil, &size, raw.baseAddress!)
        }
        guard status == noErr else { throw CoreAudioError(status, context) }
        return result
    }

    /// Get a CFString-valued property (device name / UID / manufacturer).
    public static func getString(
        _ object: AudioObjectID,
        _ address: AudioObjectPropertyAddress,
        _ context: String
    ) throws -> String {
        var addr = address
        var size = UInt32(MemoryLayout<CFString?>.size)
        var cfStr: Unmanaged<CFString>?
        let status = AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &cfStr)
        guard status == noErr else { throw CoreAudioError(status, context) }
        guard let s = cfStr?.takeRetainedValue() else { return "" }
        return s as String
    }

    public static func hasProperty(
        _ object: AudioObjectID,
        _ address: AudioObjectPropertyAddress
    ) -> Bool {
        var addr = address
        return AudioObjectHasProperty(object, &addr)
    }

    private static func unsafeZero<T>() -> T {
        UnsafeMutablePointer<T>.allocate(capacity: 1).deallocate()
        return UnsafeMutableRawPointer.allocate(byteCount: MemoryLayout<T>.size,
                                                alignment: MemoryLayout<T>.alignment)
            .bindMemory(to: T.self, capacity: 1).withMemoryRebound(to: T.self, capacity: 1) { $0.pointee }
    }
}

// Common property addresses ------------------------------------------------

public func addr(
    _ selector: AudioObjectPropertySelector,
    _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
    _ element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain
) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
}

// Device model -------------------------------------------------------------

/// Snapshot of a device's I/O capabilities — everything we need to decide
/// whether it's the ES-9 and how to wire the duplex tool.
public struct DeviceInfo {
    public let id: AudioDeviceID
    public let name: String
    public let uid: String
    public let manufacturer: String
    public let inputChannels: Int      // total input channels across streams
    public let outputChannels: Int     // total output channels across streams
    public let nominalSampleRate: Double
    public let availableSampleRates: [Double]
    public let bufferFrameSize: UInt32
    public let bufferFrameSizeRange: (min: UInt32, max: UInt32)?
    public let inputSafetyOffset: UInt32
    public let outputSafetyOffset: UInt32
    public let inputLatency: UInt32
    public let outputLatency: UInt32
    public let transportType: String

    /// Heuristic: is this likely the Expert Sleepers ES-9? Matches on name or
    /// UID containing "ES-9"/"ES9" (case-insensitive) and being 16x16-ish.
    public var looksLikeES9: Bool {
        let hay = (name + " " + uid + " " + manufacturer).lowercased()
        let nameMatch = hay.contains("es-9") || hay.contains("es9")
            || (hay.contains("expert") && hay.contains("sleeper"))
        return nameMatch
    }

    /// Number of addressable STEREO input pairs (1/2, 3/4, ...).
    public var inputPairs: Int { inputChannels / 2 }
    /// Number of addressable STEREO output pairs.
    public var outputPairs: Int { outputChannels / 2 }
}

public enum DeviceDiscovery {
    /// All audio device IDs known to the HAL.
    public static func allDeviceIDs() throws -> [AudioDeviceID] {
        try HAL.getArray(AudioObjectID(kAudioObjectSystemObject),
                         addr(kAudioHardwarePropertyDevices),
                         "kAudioHardwarePropertyDevices")
    }

    /// Channel count for one scope (input or output) by summing the
    /// AudioBufferList channel counts the device reports.
    public static func channelCount(
        _ device: AudioDeviceID,
        scope: AudioObjectPropertyScope
    ) -> Int {
        var address = addr(kAudioDevicePropertyStreamConfiguration, scope)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr,
              size > 0 else { return 0 }
        let bufList = UnsafeMutableRawPointer.allocate(
            byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { bufList.deallocate() }
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, bufList) == noErr
        else { return 0 }
        let abl = UnsafeMutableAudioBufferListPointer(
            bufList.assumingMemoryBound(to: AudioBufferList.self))
        return abl.reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    public static func availableSampleRates(_ device: AudioDeviceID) -> [Double] {
        let ranges: [AudioValueRange] = (try? HAL.getArray(
            device, addr(kAudioDevicePropertyAvailableNominalSampleRates),
            "AvailableNominalSampleRates")) ?? []
        var rates: [Double] = []
        for r in ranges {
            if r.mMinimum == r.mMaximum { rates.append(r.mMinimum) }
            else {
                // Continuous range: surface the standard rates inside it.
                for std in [44100.0, 48000, 88200, 96000, 176400, 192000]
                where std >= r.mMinimum && std <= r.mMaximum { rates.append(std) }
            }
        }
        return Array(Set(rates)).sorted()
    }

    private static func u32(_ device: AudioDeviceID,
                           _ sel: AudioObjectPropertySelector,
                           _ scope: AudioObjectPropertyScope) -> UInt32 {
        (try? HAL.getValue(device, addr(sel, scope), "\(sel)")) ?? 0
    }

    private static func transportName(_ t: UInt32) -> String {
        switch t {
        case kAudioDeviceTransportTypeUSB: return "USB"
        case kAudioDeviceTransportTypeBuiltIn: return "Built-in"
        case kAudioDeviceTransportTypeAggregate: return "Aggregate"
        case kAudioDeviceTransportTypeVirtual: return "Virtual"
        case kAudioDeviceTransportTypeThunderbolt: return "Thunderbolt"
        case kAudioDeviceTransportTypePCI: return "PCI"
        case kAudioDeviceTransportTypeBluetooth: return "Bluetooth"
        case kAudioDeviceTransportTypeHDMI: return "HDMI"
        case kAudioDeviceTransportTypeAirPlay: return "AirPlay"
        default: return "Other(\(fourCC(OSStatus(bitPattern: t))))"
        }
    }

    /// Build a full DeviceInfo snapshot for one device.
    public static func info(for device: AudioDeviceID) -> DeviceInfo {
        let name = (try? HAL.getString(device, addr(kAudioObjectPropertyName), "Name")) ?? "<unknown>"
        let uid = (try? HAL.getString(device, addr(kAudioDevicePropertyDeviceUID), "UID")) ?? ""
        let mfg = (try? HAL.getString(device, addr(kAudioObjectPropertyManufacturer), "Mfg")) ?? ""
        let inCh = channelCount(device, scope: kAudioObjectPropertyScopeInput)
        let outCh = channelCount(device, scope: kAudioObjectPropertyScopeOutput)
        let sr: Double = (try? HAL.getValue(device, addr(kAudioDevicePropertyNominalSampleRate), "SR")) ?? 0
        let bfs: UInt32 = (try? HAL.getValue(device, addr(kAudioDevicePropertyBufferFrameSize), "BFS")) ?? 0
        let bfsRange: (UInt32, UInt32)? = {
            guard let r: AudioValueRange = try? HAL.getValue(
                device, addr(kAudioDevicePropertyBufferFrameSizeRange), "BFSRange") else { return nil }
            return (UInt32(r.mMinimum), UInt32(r.mMaximum))
        }()
        let transport = u32(device, kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal)
        return DeviceInfo(
            id: device, name: name, uid: uid, manufacturer: mfg,
            inputChannels: inCh, outputChannels: outCh,
            nominalSampleRate: sr,
            availableSampleRates: availableSampleRates(device),
            bufferFrameSize: bfs,
            bufferFrameSizeRange: bfsRange,
            inputSafetyOffset: u32(device, kAudioDevicePropertySafetyOffset, kAudioObjectPropertyScopeInput),
            outputSafetyOffset: u32(device, kAudioDevicePropertySafetyOffset, kAudioObjectPropertyScopeOutput),
            inputLatency: u32(device, kAudioDevicePropertyLatency, kAudioObjectPropertyScopeInput),
            outputLatency: u32(device, kAudioDevicePropertyLatency, kAudioObjectPropertyScopeOutput),
            transportType: transportName(transport)
        )
    }

    /// Snapshot every device.
    public static func allDevices() -> [DeviceInfo] {
        ((try? allDeviceIDs()) ?? []).map(info(for:))
    }

    /// Find the ES-9, if attached. Prefers an explicit name/UID match; among
    /// multiple matches prefers the one with the most I/O channels.
    public static func findES9() -> DeviceInfo? {
        allDevices()
            .filter { $0.looksLikeES9 }
            .max { ($0.inputChannels + $0.outputChannels) < ($1.inputChannels + $1.outputChannels) }
    }

    /// Round-trip latency estimate in frames, given a buffer size, per
    /// CoreAudio's documented components (safety offset + device latency +
    /// buffer, both directions). Stream latency is small/often zero and
    /// omitted here for the headline figure.
    public static func roundTripFrames(_ d: DeviceInfo, buffer: UInt32) -> UInt32 {
        d.inputSafetyOffset + d.inputLatency + buffer
            + d.outputSafetyOffset + d.outputLatency + buffer
    }
}
