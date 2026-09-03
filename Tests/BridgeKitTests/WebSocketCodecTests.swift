// WebSocketCodecTests.swift — the RFC 6455 layer under every bridge. The
// codec is a copy from patchtogether.es9; these tests keep the copy honest.

import XCTest
@testable import BridgeKit

/// Client-side masking, for feeding the (server-side) decoder.
private func maskedFrame(opcode: WSOpcode, payload: [UInt8], fin: Bool = true,
                         key: [UInt8] = [0x11, 0x22, 0x33, 0x44]) -> Data {
    var out = Data()
    out.append((fin ? 0x80 : 0x00) | opcode.rawValue)
    let n = payload.count
    if n < 126 {
        out.append(UInt8(n) | 0x80)
    } else if n <= 0xFFFF {
        out.append(126 | 0x80)
        out.append(UInt8((n >> 8) & 0xFF))
        out.append(UInt8(n & 0xFF))
    } else {
        out.append(127 | 0x80)
        for shift in stride(from: 56, through: 0, by: -8) {
            out.append(UInt8((UInt64(n) >> UInt64(shift)) & 0xFF))
        }
    }
    out.append(contentsOf: key)
    out.append(contentsOf: payload.enumerated().map { $1 ^ key[$0 & 3] })
    return out
}

final class WebSocketCodecTests: XCTestCase {
    func testRFCHandshakeVector() {
        // RFC 6455 §1.3's worked example.
        XCTAssertEqual(WebSocketCodec.acceptKey(for: "dGhlIHNhbXBsZSBub25jZQ=="),
                       "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
    }

    func testDecodeSimpleTextFrame() throws {
        let decoder = WSDecoder()
        let messages = try decoder.feed(maskedFrame(opcode: .text, payload: Array("hi".utf8)))
        XCTAssertEqual(messages, [WSMessage(opcode: .text, payload: Data("hi".utf8))])
    }

    func testRequiresMaskedClientFrames() {
        let decoder = WSDecoder()
        var unmasked = Data([0x81, 0x02])
        unmasked.append(contentsOf: Array("hi".utf8))
        XCTAssertThrowsError(try decoder.feed(unmasked))
    }

    func testFragmentedMessageReassembly() throws {
        let decoder = WSDecoder()
        var stream = maskedFrame(opcode: .binary, payload: [1, 2], fin: false)
        stream.append(maskedFrame(opcode: .continuation, payload: [3], fin: false))
        stream.append(maskedFrame(opcode: .continuation, payload: [4, 5], fin: true))
        let messages = try decoder.feed(stream)
        XCTAssertEqual(messages, [WSMessage(opcode: .binary, payload: Data([1, 2, 3, 4, 5]))])
    }

    func testPartialDelivery() throws {
        let decoder = WSDecoder()
        let frame = maskedFrame(opcode: .binary, payload: Array(repeating: 7, count: 300))
        let mid = frame.count / 2
        XCTAssertEqual(try decoder.feed(frame.prefix(mid)), [])
        let messages = try decoder.feed(frame.suffix(from: mid))
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages[0].payload.count, 300)
    }

    func testControlFrameInterleavesFragments() throws {
        let decoder = WSDecoder()
        var stream = maskedFrame(opcode: .text, payload: Array("ab".utf8), fin: false)
        stream.append(maskedFrame(opcode: .ping, payload: [9]))
        stream.append(maskedFrame(opcode: .continuation, payload: Array("cd".utf8), fin: true))
        let messages = try decoder.feed(stream)
        XCTAssertEqual(messages, [
            WSMessage(opcode: .ping, payload: Data([9])),
            WSMessage(opcode: .text, payload: Data("abcd".utf8)),
        ])
    }

    func testEncodeDecodeAgree() throws {
        // Server frames are unmasked; re-mask them to simulate a client echo.
        let payload = (0..<70000).map { UInt8($0 & 0xFF) }   // forces 64-bit length
        let decoder = WSDecoder()
        let messages = try decoder.feed(maskedFrame(opcode: .binary, payload: payload))
        XCTAssertEqual(messages[0].payload, Data(payload))
    }

    func testHTTPHeadParsing() {
        let raw = "GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nSec-WebSocket-Key: abc\r\nOrigin: https://patchtogether.live\r\n\r\nEXTRA"
        let parsed = HTTPParser.parseRequestHead(Data(raw.utf8))
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.head.path, "/ws")
        XCTAssertEqual(parsed?.head.headers["origin"], "https://patchtogether.live")
        XCTAssertTrue(parsed?.head.isWebSocketUpgrade ?? false)
        XCTAssertEqual(parsed.map { Data(raw.utf8).count - $0.consumed }, 5)  // "EXTRA"
    }
}

final class OriginPolicyTests: XCTestCase {
    func testDefaultPolicy() {
        let allow = WebSocketServer.defaultOriginPolicy
        XCTAssertTrue(allow(nil))                                    // non-browser local process
        XCTAssertTrue(allow("http://localhost:5173"))
        XCTAssertTrue(allow("http://127.0.0.1:9309"))
        XCTAssertTrue(allow("https://patchtogether.live"))
        XCTAssertTrue(allow("https://dev.patchtogether.live"))
        XCTAssertFalse(allow("https://evil.example.com"))
        XCTAssertFalse(allow("https://notpatchtogether.live.example.com"))
    }

    func testExtraOrigins() {
        let allow = WebSocketServer.policy(extraOrigins: ["*.pages.dev", "my.tunnel.example"])
        XCTAssertTrue(allow("https://pr-42.project.pages.dev"))
        XCTAssertTrue(allow("https://my.tunnel.example"))
        XCTAssertTrue(allow("https://dev.patchtogether.live"))       // default still applies
        XCTAssertFalse(allow("https://evil.example.com"))
    }
}
