// PluginRegistry.swift
//
// Discovery of the user's installed Audio Unit plugins via the system
// AudioComponent registry (AVAudioUnitComponentManager) — the browser can't
// enumerate anything; this is the "sees available VSTs" half of the card.
// Practically every commercial macOS plugin ships an AU build alongside its
// VST3, so hosting AUs covers the user's plugin folder without touching the
// C++ VST3 SDK. A VST3 backend can slot in behind the same PluginDescriptor
// later (id scheme "vst3:…").

import AudioToolbox
import AVFoundation
import Foundation

/// One discovered plugin: the wire-facing PluginInfo plus what the host
/// needs to instantiate it.
public struct PluginDescriptor: Sendable {
    public let info: PluginInfo
    public let componentDescription: AudioComponentDescription
    /// v3 (app-extension) audio units can load out-of-process for crash
    /// isolation; v2 components always load in-process.
    public let isV3: Bool
}

public enum PluginRegistry {
    /// The component types worth listing. Everything else (converters,
    /// mixers, outputs, panners) is plumbing, not a mountable plugin.
    static let kindByType: [OSType: PluginKind] = [
        kAudioUnitType_MusicDevice: .instrument,
        kAudioUnitType_Effect: .effect,
        kAudioUnitType_MusicEffect: .musicEffect,
        kAudioUnitType_Generator: .generator,
    ]

    /// Scan the registry. Fast (the registrar caches); safe to call on
    /// connect. Sorted by name for stable UI.
    public static func scan() -> [PluginDescriptor] {
        let manager = AVAudioUnitComponentManager.shared()
        let components = manager.components { _, _ in true }
        var out: [PluginDescriptor] = []
        for component in components {
            let desc = component.audioComponentDescription
            guard let kind = kindByType[desc.componentType] else { continue }
            let info = PluginInfo(
                id: pluginID(for: desc),
                name: component.name,
                manufacturer: component.manufacturerName,
                version: component.versionString,
                kind: kind)
            let isV3 = desc.componentFlags & AudioComponentFlags.isV3AudioUnit.rawValue != 0
            out.append(PluginDescriptor(info: info, componentDescription: desc, isV3: isV3))
        }
        return out.sorted {
            $0.info.name.localizedCaseInsensitiveCompare($1.info.name) == .orderedAscending
        }
    }

    public static func find(id: String, in plugins: [PluginDescriptor]? = nil) -> PluginDescriptor? {
        (plugins ?? scan()).first { $0.info.id == id }
    }

    // MARK: - Plugin IDs ("au:<type>:<subtype>:<manufacturer>")

    public static func pluginID(for desc: AudioComponentDescription) -> String {
        "au:\(fourCC(desc.componentType)):\(fourCC(desc.componentSubType)):\(fourCC(desc.componentManufacturer))"
    }

    /// OSType -> printable fourCC, or its decimal value when any byte isn't
    /// printable ASCII (some vendors register binary codes).
    static func fourCC(_ code: OSType) -> String {
        let bytes = [UInt8((code >> 24) & 0xff), UInt8((code >> 16) & 0xff),
                     UInt8((code >> 8) & 0xff), UInt8(code & 0xff)]
        if bytes.allSatisfy({ (0x20...0x7e).contains($0) }) {
            return String(bytes: bytes, encoding: .ascii)!
        }
        return String(code)
    }

    static func osType(_ slot: String) -> OSType? {
        let scalars = Array(slot.unicodeScalars)
        if scalars.count == 4, scalars.allSatisfy({ $0.isASCII }) {
            return scalars.reduce(OSType(0)) { ($0 << 8) | OSType($1.value) }
        }
        return OSType(slot)   // decimal fallback
    }
}
