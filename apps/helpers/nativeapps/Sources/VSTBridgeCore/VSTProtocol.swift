// VSTProtocol.swift
//
// The VST bridge's control plane, layered on the shared BridgeKit wire
// format. Version 1. This file is the SPEC for the browser card
// (inet.modular "VST BRIDGE"), which duplicates these shapes per the
// cross-repo convention.
//
// SESSION MODEL: one WebSocket connection = one plugin INSTANCE. A patch
// with an instrument card and an effect card opens TWO connections, each
// mounting its own plugin. `hello.clientId` (the card's stable id from the
// patch) makes an instance survive reconnects: on disconnect it is parked
// (plugin + state kept) for a grace window and a reconnect with the same
// clientId adopts it — the bridge replays `mounted` so the card re-syncs.
// A hello whose clientId is held by a live session evicts that session
// (status "stopped"): a crashed tab is reclaimed instantly. Anonymous
// sessions (no clientId) are torn down when their socket closes. Above
// the instance cap a hello gets status "busy" and the socket closes.
//
// Flow (per connection, ws://127.0.0.1:9309/ws):
//
//   client                                bridge
//   ──────                                ──────
//   hello {rate, name?, clientId?} ─►
//                                ◄─  helperInfo {…}
//                                ◄─  pluginList {plugins: […]}
//                                ◄─  mounted {…}          (only when the
//                                                          clientId adopted a
//                                                          parked instance
//                                                          with a plugin
//                                                          mounted)
//   mount {pluginId}             ─►
//                                ◄─  mounted {…} | mountError {…}
//   0x01 audio blocks            ─►      (plugin input; mask 0 = clock-only
//                                         block for instruments)
//                                ◄─  0x01 audio blocks (plugin output,
//                                     stereo mask 0b11, SAME sampleTime as
//                                     the input block that pulled it)
//   0x02 MIDI blocks             ─►      (timestamped on the client's sample
//                                         clock; delivered sample-accurately
//                                         into the plugin's render)
//   openEditor / closeEditor     ─►
//                                ◄─  editor {open, custom?}
//   getState                     ─►
//                                ◄─  state {pluginId, data}
//   setState {data}              ─►
//                                ◄─  stateSet {ok, detail?}
//   unmount                      ─►
//                                ◄─  unmounted
//   rescanPlugins                ─►
//                                ◄─  pluginList {…}
//   ping/pong — shared semantics with the ES-9 bridge. (No takeover
//   message here: plugins aren't exclusive hardware, so the es9 bridge's
//   single-active-client policy does not apply; clientId eviction covers
//   the crashed-tab case.)
//
//   meters {…}                   ◄─  ~8 Hz per live instance.
//
// The bridge renders AT the client's hello rate — no resampling anywhere.
// If a client reconnects with a different rate while a plugin is mounted,
// the bridge remounts it at the new rate, preserving state.

import Foundation
import BridgeKit

public enum VSTBridgeInfo {
    public static let name = "vst-bridge"
    public static let version = "0.1.0"
    /// 9209 is the es9 bridge; 9210 is the port its "port in use" message
    /// tells users to fall back to. 9309 collides with neither, nor with
    /// inet.modular's reserved 1234/1235/5173/4173.
    public static let defaultPort: UInt16 = 9309
}

/// What kind of plugin a component is (from its AudioComponent type).
public enum PluginKind: String, Codable, Sendable {
    case instrument     // aumu — MIDI in, audio out
    case effect         // aufx — audio in, audio out
    case musicEffect    // aumf — audio + MIDI in, audio out
    case generator      // augn — audio out, no MIDI
}

/// One installed plugin, as listed to the client. `id` is the stable mount
/// key: "au:<type>:<subtype>:<manufacturer>" (fourCC slots, decimal when a
/// code isn't printable ASCII).
public struct PluginInfo: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var manufacturer: String
    public var version: String
    public var kind: PluginKind
    public var format = "au"

    public init(id: String, name: String, manufacturer: String,
                version: String, kind: PluginKind) {
        self.id = id
        self.name = name
        self.manufacturer = manufacturer
        self.version = version
        self.kind = kind
    }
}

// MARK: - Bridge -> client

/// Reply to hello.
public struct HelperInfoMessage: Codable, Equatable {
    public var type = "helperInfo"
    public var protocolVersion: Int
    public var name: String
    public var version: String
    /// The rate the bridge accepted and renders at (echo of hello.rate).
    public var rate: Double
    public var maxBlockFrames: Int
    public var formats: [String]
    public init(protocolVersion: Int = BridgeWire.protocolVersion,
                name: String = VSTBridgeInfo.name,
                version: String = VSTBridgeInfo.version,
                rate: Double, maxBlockFrames: Int = BridgeWire.maxFrameCount,
                formats: [String] = ["au"]) {
        self.protocolVersion = protocolVersion
        self.name = name
        self.version = version
        self.rate = rate
        self.maxBlockFrames = maxBlockFrames
        self.formats = formats
    }
}

public struct PluginListMessage: Codable, Equatable {
    public var type = "pluginList"
    public var plugins: [PluginInfo]
    public init(plugins: [PluginInfo]) { self.plugins = plugins }
}

/// A plugin is mounted and rendering. Sent after a successful mount, and on
/// (re)connect when a plugin is already mounted.
public struct MountedMessage: Codable, Equatable {
    public var type = "mounted"
    public var plugin: PluginInfo
    /// Plugin-reported processing latency, in samples at the render rate —
    /// the card should fold this into its delay compensation someday.
    public var latencySamples: Int
    public var tailSeconds: Double
    /// 0 for instruments/generators (send mask-0 clock blocks), else 1-2.
    public var audioInputChannels: Int
    public var audioOutputChannels: Int
    public var acceptsMidi: Bool
    public init(plugin: PluginInfo, latencySamples: Int, tailSeconds: Double,
                audioInputChannels: Int, audioOutputChannels: Int, acceptsMidi: Bool) {
        self.plugin = plugin
        self.latencySamples = latencySamples
        self.tailSeconds = tailSeconds
        self.audioInputChannels = audioInputChannels
        self.audioOutputChannels = audioOutputChannels
        self.acceptsMidi = acceptsMidi
    }
}

public struct MountErrorMessage: Codable, Equatable {
    public var type = "mountError"
    public var pluginId: String
    public var message: String
    public init(pluginId: String, message: String) {
        self.pluginId = pluginId
        self.message = message
    }
}

public struct UnmountedMessage: Codable, Equatable {
    public var type = "unmounted"
    public init() {}
}

public struct EditorMessage: Codable, Equatable {
    public var type = "editor"
    public var open: Bool
    /// true = the plugin's own UI; false = the generic parameter view.
    public var custom: Bool?
    public init(open: Bool, custom: Bool? = nil) {
        self.open = open
        self.custom = custom
    }
}

public struct StateMessage: Codable, Equatable {
    public var type = "state"
    public var pluginId: String
    /// base64 of the AU's fullState, binary-plist-serialized. Opaque to the
    /// client; round-trips through setState.
    public var data: String
    public init(pluginId: String, data: String) {
        self.pluginId = pluginId
        self.data = data
    }
}

public struct StateSetMessage: Codable, Equatable {
    public var type = "stateSet"
    public var ok: Bool
    public var detail: String?
    public init(ok: Bool, detail: String? = nil) {
        self.ok = ok
        self.detail = detail
    }
}

/// ~8 Hz while a client is active.
public struct VSTMetersMessage: Codable, Equatable {
    public var type = "meters"
    /// dBFS per channel over the last meter window (plugin input as
    /// received / plugin output as sent). -120 = silence floor.
    public var inputRMS: [Float]
    public var outputRMS: [Float]
    /// Render-block calls that returned an error since mount.
    public var renderErrors: Int
    /// Inbound audio blocks dropped (malformed, or the render queue was
    /// saturated) since connect.
    public var droppedBlocks: Int
    /// MIDI events currently waiting for their sampleTime.
    public var midiQueued: Int
    /// Plugin render time as a percentage of the audio time rendered in the
    /// last meter window (100 ⇒ the plugin can't keep up with realtime).
    public var loadPct: Float
    public init(inputRMS: [Float], outputRMS: [Float], renderErrors: Int,
                droppedBlocks: Int, midiQueued: Int, loadPct: Float) {
        self.inputRMS = inputRMS
        self.outputRMS = outputRMS
        self.renderErrors = renderErrors
        self.droppedBlocks = droppedBlocks
        self.midiQueued = midiQueued
        self.loadPct = loadPct
    }
}

// MARK: - Client -> bridge

public struct MountMessage: Codable, Equatable {
    public var type = "mount"
    public var pluginId: String
    public init(pluginId: String) { self.pluginId = pluginId }
}

public struct SetStateMessage: Codable, Equatable {
    public var type = "setState"
    public var data: String
    public init(data: String) { self.data = data }
}
