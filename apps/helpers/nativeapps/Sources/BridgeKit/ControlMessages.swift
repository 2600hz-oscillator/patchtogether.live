// ControlMessages.swift
//
// The control messages every bridge shares, COPIED 2026-08-19 from
// ../patchtogether.es9/Sources/ES9Core/BridgeProtocol.swift (hello, status,
// ping/pong, the type-sniffing envelope). Bridge-specific messages (the
// ES-9's deviceInfo/config/meters; the VST bridge's pluginList/mount/...)
// live with their bridge.

import Foundation

/// Client -> bridge, first message after connect.
public struct HelloMessage: Codable, Equatable {
    public var type = "hello"
    /// Client's AudioContext sample rate. What a bridge does with it is
    /// bridge-specific: the ES-9 resamples to/from hardware; the VST bridge
    /// renders plugins AT this rate.
    public var rate: Double
    public var name: String?
    /// Optional stable identity for this client instance (e.g. a card's
    /// persistent id from the patch). Bridges that keep per-client state
    /// use it to hand that state back after a reconnect (page refresh) and
    /// to evict a stale session claiming the same identity. Absent = an
    /// anonymous session whose server-side state dies with the socket.
    public var clientId: String?
    public init(rate: Double, name: String? = nil, clientId: String? = nil) {
        self.rate = rate
        self.name = name
        self.clientId = clientId
    }
}

/// Bridge -> client on lifecycle changes.
/// Shared states: "busy" (another client holds the slot; send
/// {"type":"takeover"} to claim it) and "stopped" (this session lost the
/// slot / the bridge is shutting down). Bridges may add their own.
public struct StatusMessage: Codable, Equatable {
    public var state: String
    public var detail: String?
    public var type = "status"
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

/// JSON-encode a control message for a text frame. Never throws — a message
/// that fails to encode becomes "{}", which peers ignore.
public func encodeControlJSON<T: Encodable>(_ value: T) -> String {
    guard let data = try? JSONEncoder().encode(value) else { return "{}" }
    return String(data: data, encoding: .utf8) ?? "{}"
}
