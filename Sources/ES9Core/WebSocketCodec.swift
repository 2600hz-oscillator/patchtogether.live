// WebSocketCodec.swift
//
// Dependency-free RFC 6455 WebSocket framing + handshake, pure functions and
// an incremental decoder — the testable core under WebSocketServer. Only the
// SERVER side is implemented: we send unmasked frames and require masked
// frames from clients (as the RFC mandates for browsers).
//
// Kept deliberately minimal: no extensions (permessage-deflate is pointless
// for float audio on loopback), no subprotocol negotiation.

import Foundation
import CryptoKit

public enum WSOpcode: UInt8 {
    case continuation = 0x0
    case text = 0x1
    case binary = 0x2
    case close = 0x8
    case ping = 0x9
    case pong = 0xA
}

public enum WebSocketCodec {
    /// RFC 6455 §4.2.2 magic GUID.
    public static let handshakeGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    /// Sec-WebSocket-Accept for a client's Sec-WebSocket-Key.
    public static func acceptKey(for clientKey: String) -> String {
        let digest = Insecure.SHA1.hash(data: Data((clientKey + handshakeGUID).utf8))
        return Data(digest).base64EncodedString()
    }

    /// Build the 101 Switching Protocols response for an upgrade request.
    public static func handshakeResponse(clientKey: String) -> String {
        "HTTP/1.1 101 Switching Protocols\r\n"
            + "Upgrade: websocket\r\n"
            + "Connection: Upgrade\r\n"
            + "Sec-WebSocket-Accept: \(acceptKey(for: clientKey))\r\n"
            + "\r\n"
    }

    /// Encode one server->client frame (unmasked, single fragment).
    public static func encodeFrame(opcode: WSOpcode, payload: Data) -> Data {
        var out = Data(capacity: payload.count + 10)
        out.append(0x80 | opcode.rawValue)              // FIN + opcode
        let n = payload.count
        if n < 126 {
            out.append(UInt8(n))
        } else if n <= 0xFFFF {
            out.append(126)
            out.append(UInt8((n >> 8) & 0xFF))
            out.append(UInt8(n & 0xFF))
        } else {
            out.append(127)
            for shift in stride(from: 56, through: 0, by: -8) {
                out.append(UInt8((UInt64(n) >> UInt64(shift)) & 0xFF))
            }
        }
        out.append(payload)
        return out
    }

    public static func closeFrame(code: UInt16 = 1000) -> Data {
        var payload = Data()
        payload.append(UInt8(code >> 8))
        payload.append(UInt8(code & 0xFF))
        return encodeFrame(opcode: .close, payload: payload)
    }
}

/// One fully-reassembled incoming message (or control frame).
public struct WSMessage: Equatable {
    public let opcode: WSOpcode
    public let payload: Data
    public init(opcode: WSOpcode, payload: Data) {
        self.opcode = opcode
        self.payload = payload
    }
}

/// Incremental decoder: feed raw TCP bytes, pull complete messages.
/// Reassembles fragmented data messages; surfaces control frames (ping/pong/
/// close) individually as required by the RFC (they may interleave fragments).
public final class WSDecoder {
    public enum WSError: Error, Equatable {
        case unmaskedClientFrame
        case reservedBitsSet
        case unknownOpcode(UInt8)
        case controlFrameFragmented
        case controlFrameTooLong
        case messageTooLong
        case unexpectedContinuation
        case newDataFrameDuringFragmentation
    }

    /// Cap on a reassembled message (audio blocks are ~130 KB max; 4 MB is
    /// generous but stops a runaway peer).
    public var maxMessageSize = 4 * 1024 * 1024

    private var buffer = Data()
    private var fragmentOpcode: WSOpcode?
    private var fragmentPayload = Data()

    public init() {}

    /// One decode step: a completed message, progress without a message (a
    /// consumed fragment), or a need for more bytes. Iterative on purpose —
    /// recursing per fragment lets a hostile peer overflow the stack with
    /// thousands of tiny continuation frames in one TCP segment.
    private enum Step {
        case message(WSMessage)
        case progress
        case needMore
    }

    /// Append raw bytes and return every message completed by them.
    public func feed(_ data: Data) throws -> [WSMessage] {
        buffer.append(data)
        var out: [WSMessage] = []
        loop: while true {
            switch try parseStep() {
            case .message(let msg): out.append(msg)
            case .progress: continue
            case .needMore: break loop
            }
        }
        return out
    }

    private func parseStep() throws -> Step {
        guard buffer.count >= 2 else { return .needMore }
        let b0 = buffer[buffer.startIndex]
        let b1 = buffer[buffer.startIndex + 1]
        let fin = (b0 & 0x80) != 0
        guard (b0 & 0x70) == 0 else { throw WSError.reservedBitsSet }
        let rawOp = b0 & 0x0F
        guard let opcode = WSOpcode(rawValue: rawOp) else { throw WSError.unknownOpcode(rawOp) }
        let masked = (b1 & 0x80) != 0
        guard masked else { throw WSError.unmaskedClientFrame }

        var lenField = Int(b1 & 0x7F)
        var offset = 2
        if lenField == 126 {
            guard buffer.count >= 4 else { return .needMore }
            lenField = Int(buffer[buffer.startIndex + 2]) << 8 | Int(buffer[buffer.startIndex + 3])
            offset = 4
        } else if lenField == 127 {
            guard buffer.count >= 10 else { return .needMore }
            var v: UInt64 = 0
            for i in 0..<8 { v = (v << 8) | UInt64(buffer[buffer.startIndex + 2 + i]) }
            guard v <= UInt64(maxMessageSize) else { throw WSError.messageTooLong }
            lenField = Int(v)
            offset = 10
        }
        guard lenField <= maxMessageSize else { throw WSError.messageTooLong }
        let total = offset + 4 + lenField          // +4 = masking key
        guard buffer.count >= total else { return .needMore }

        let start = buffer.startIndex
        let key = [UInt8](buffer[(start + offset)..<(start + offset + 4)])
        var payload = [UInt8](buffer[(start + offset + 4)..<(start + total)])
        for i in 0..<payload.count { payload[i] ^= key[i & 3] }
        buffer.removeSubrange(start..<(start + total))

        // Control frames: never fragmented, <=125 bytes, surface immediately.
        if opcode == .close || opcode == .ping || opcode == .pong {
            guard fin else { throw WSError.controlFrameFragmented }
            guard payload.count <= 125 else { throw WSError.controlFrameTooLong }
            return .message(WSMessage(opcode: opcode, payload: Data(payload)))
        }

        // Data frames, possibly fragmented.
        if opcode == .continuation {
            guard let firstOp = fragmentOpcode else { throw WSError.unexpectedContinuation }
            fragmentPayload.append(contentsOf: payload)
            guard fragmentPayload.count <= maxMessageSize else { throw WSError.messageTooLong }
            if fin {
                let msg = WSMessage(opcode: firstOp, payload: fragmentPayload)
                fragmentOpcode = nil
                fragmentPayload = Data()
                return .message(msg)
            }
            return .progress    // consumed a fragment; caller loops
        }

        // text/binary
        if fragmentOpcode != nil { throw WSError.newDataFrameDuringFragmentation }
        if fin {
            return .message(WSMessage(opcode: opcode, payload: Data(payload)))
        }
        fragmentOpcode = opcode
        fragmentPayload = Data(payload)
        return .progress
    }
}

// MARK: - Minimal HTTP request head parsing (for the upgrade + static page)

public struct HTTPRequestHead {
    public let method: String
    public let path: String
    /// Header names lowercased.
    public let headers: [String: String]

    public var isWebSocketUpgrade: Bool {
        headers["upgrade"]?.lowercased() == "websocket"
            && headers["sec-websocket-key"] != nil
    }
}

public enum HTTPParser {
    /// Parse a request head if `data` contains the full CRLFCRLF terminator.
    /// Returns the head and the number of bytes consumed, or nil if
    /// incomplete.
    public static func parseRequestHead(_ data: Data) -> (head: HTTPRequestHead, consumed: Int)? {
        guard let range = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        guard let text = String(data: data[data.startIndex..<range.lowerBound], encoding: .utf8)
        else { return nil }
        var lines = text.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { return nil }
        let requestLine = lines.removeFirst().split(separator: " ")
        guard requestLine.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[name] = value
        }
        let consumed = data.distance(from: data.startIndex, to: range.upperBound)
        return (HTTPRequestHead(method: String(requestLine[0]),
                                path: String(requestLine[1]),
                                headers: headers), consumed)
    }
}
