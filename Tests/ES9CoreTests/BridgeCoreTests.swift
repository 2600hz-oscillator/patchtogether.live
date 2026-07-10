// Hardware-free tests for the bridge core: wire protocol, SPSC ring,
// resampler + fill controller, WebSocket codec, HTTP head parsing.

import XCTest
@testable import ES9Core

final class BridgeProtocolTests: XCTestCase {
    func testAudioBlockRoundTrip() throws {
        let block = AudioBlock(
            seq: 42, sampleTime: 123_456_789,
            channelMask: 0b1010,                      // channels 1 and 3
            frameCount: 4,
            planes: [[0.1, -0.2, 0.3, -0.4], [1.0, -1.0, 0.5, 0.25]])
        let data = BridgeWire.encode(block)
        XCTAssertEqual(data.count, BridgeWire.headerSize + 2 * 4 * 4)
        let decoded = try BridgeWire.decode(data)
        XCTAssertEqual(decoded, block)
        XCTAssertEqual(decoded.channels, [1, 3])
    }

    func testMaskChannelExtraction() {
        XCTAssertEqual(BridgeWire.channels(in: 0), [])
        XCTAssertEqual(BridgeWire.channels(in: 1), [0])
        XCTAssertEqual(BridgeWire.channels(in: 0b1000_0000_0000_0001), [0, 15])
        XCTAssertEqual(BridgeWire.channels(in: UInt32.max).count, 32)
    }

    func testDecodeRejectsGarbage() {
        XCTAssertThrowsError(try BridgeWire.decode(Data([0x01])))            // too short
        var bad = BridgeWire.encode(AudioBlock(seq: 0, sampleTime: 0,
            channelMask: 1, frameCount: 2, planes: [[0, 0]]))
        bad[0] = 0x7F                                                        // unknown type
        XCTAssertThrowsError(try BridgeWire.decode(bad))
        var truncated = BridgeWire.encode(AudioBlock(seq: 0, sampleTime: 0,
            channelMask: 1, frameCount: 2, planes: [[0, 0]]))
        truncated.removeLast()                                               // size mismatch
        XCTAssertThrowsError(try BridgeWire.decode(truncated))
    }

    func testControlMessagesRoundTripJSON() throws {
        let cfg = ConfigMessage(inputMask: 0xFFFF, outputMask: 0xFF,
                                outputModes: ["0": .cv, "7": .audio])
        let data = try JSONEncoder().encode(cfg)
        let back = try JSONDecoder().decode(ConfigMessage.self, from: data)
        XCTAssertEqual(back, cfg)
        let env = try JSONDecoder().decode(ControlEnvelope.self, from: data)
        XCTAssertEqual(env.type, "config")
    }
}

final class SPSCRingTests: XCTestCase {
    private func makePlanes(_ channels: Int, _ frames: Int,
                            fill: (Int, Int) -> Float) -> [UnsafeMutablePointer<Float>] {
        (0..<channels).map { c in
            let p = UnsafeMutablePointer<Float>.allocate(capacity: frames)
            for f in 0..<frames { p[f] = fill(c, f) }
            return p
        }
    }

    func testWriteReadRoundTripAcrossWrap() {
        let ring = SPSCRing(channels: 2, capacityFrames: 64)   // rounds to 64
        let w = makePlanes(2, 48) { c, f in Float(c * 1000 + f) }
        let r = makePlanes(2, 48) { _, _ in -1 }
        defer { (w + r).forEach { $0.deallocate() } }

        // Three write/read cycles of 48 frames crosses the 64-frame boundary.
        for cycle in 0..<3 {
            let wrote = w.withUnsafeBufferPointer { ring.write(planes: $0.baseAddress!, frames: 48) }
            XCTAssertEqual(wrote, 48, "cycle \(cycle)")
            let read = r.withUnsafeBufferPointer { ring.read(into: $0.baseAddress!, frames: 48) }
            XCTAssertEqual(read, 48, "cycle \(cycle)")
            for c in 0..<2 {
                for f in 0..<48 {
                    XCTAssertEqual(r[c][f], Float(c * 1000 + f), "cycle \(cycle) ch \(c) frame \(f)")
                }
            }
        }
    }

    func testOverflowWritesShort() {
        let ring = SPSCRing(channels: 1, capacityFrames: 32)
        let w = makePlanes(1, 40) { _, f in Float(f) }
        defer { w.forEach { $0.deallocate() } }
        let wrote = w.withUnsafeBufferPointer { ring.write(planes: $0.baseAddress!, frames: 40) }
        XCTAssertEqual(wrote, 32)
        XCTAssertEqual(ring.occupancy, 32)
        XCTAssertEqual(ring.freeSpace, 0)
    }

    func testUnderrunReadsShortAndSkip() {
        let ring = SPSCRing(channels: 1, capacityFrames: 32)
        let w = makePlanes(1, 10) { _, f in Float(f) }
        let r = makePlanes(1, 20) { _, _ in -1 }
        defer { (w + r).forEach { $0.deallocate() } }
        w.withUnsafeBufferPointer { ring.write(planes: $0.baseAddress!, frames: 10) }
        let read = r.withUnsafeBufferPointer { ring.read(into: $0.baseAddress!, frames: 20) }
        XCTAssertEqual(read, 10)
        w.withUnsafeBufferPointer { ring.write(planes: $0.baseAddress!, frames: 10) }
        XCTAssertEqual(ring.skip(frames: 6), 6)
        XCTAssertEqual(ring.occupancy, 4)
    }

    func testConcurrentProducerConsumerPreservesSequence() {
        let ring = SPSCRing(channels: 1, capacityFrames: 256)
        let total = 100_000
        let done = expectation(description: "consumer finished")

        Thread.detachNewThread {
            let buf = UnsafeMutablePointer<Float>.allocate(capacity: 64)
            defer { buf.deallocate() }
            var planes = [buf]
            var next = 0
            while next < total {
                let n = min(64, total - next)
                for i in 0..<n { buf[i] = Float(next + i) }
                let wrote = planes.withUnsafeBufferPointer {
                    ring.write(planes: $0.baseAddress!, frames: n)
                }
                next += wrote
                if wrote == 0 { usleep(100) }
            }
        }

        Thread.detachNewThread {
            let buf = UnsafeMutablePointer<Float>.allocate(capacity: 64)
            defer { buf.deallocate() }
            var planes = [buf]
            var expected = 0
            var ok = true
            while expected < total {
                let got = planes.withUnsafeBufferPointer {
                    ring.read(into: $0.baseAddress!, frames: 64)
                }
                for i in 0..<got where buf[i] != Float(expected + i) { ok = false }
                expected += got
                if got == 0 { usleep(100) }
            }
            XCTAssertTrue(ok, "consumer saw out-of-sequence samples")
            done.fulfill()
        }

        wait(for: [done], timeout: 10)
    }
}

final class ResamplerTests: XCTestCase {
    private func planes(_ channels: Int, _ cap: Int) -> [UnsafeMutablePointer<Float>] {
        (0..<channels).map { _ in
            let p = UnsafeMutablePointer<Float>.allocate(capacity: cap)
            p.initialize(repeating: 0, count: cap)
            return p
        }
    }

    func testUnityRatioIsTransparentModuloOneSampleDelay() {
        let rs = StreamResampler(channels: 1, sourceRate: 48000, targetRate: 48000)
        let src = planes(1, 64), dst = planes(1, 128)
        defer { (src + dst).forEach { $0.deallocate() } }
        for f in 0..<64 { src[0][f] = Float(f + 1) }
        let produced = src.withUnsafeBufferPointer { s in
            dst.withUnsafeBufferPointer { d in
                rs.process(input: s.baseAddress!, frames: 64,
                           output: d.baseAddress!, outputCapacity: 128)
            }
        }
        XCTAssertEqual(produced, 64)
        // First output interpolates from history (0), then exact passthrough
        // delayed by one sample.
        XCTAssertEqual(dst[0][0], 0, accuracy: 1e-6)
        for f in 1..<64 { XCTAssertEqual(dst[0][f], Float(f), accuracy: 1e-5) }
    }

    func testDCIsExactAtAnyRatio() {
        // The CV guarantee: a held voltage must pass through bit-exactly
        // (once past the first interpolated sample) even while resampling.
        let rs = StreamResampler(channels: 1, sourceRate: 48000, targetRate: 44100)
        let src = planes(1, 480), dst = planes(1, 600)
        defer { (src + dst).forEach { $0.deallocate() } }
        for f in 0..<480 { src[0][f] = 0.7301 }
        var total = 0
        for _ in 0..<5 {
            let produced = src.withUnsafeBufferPointer { s in
                dst.withUnsafeBufferPointer { d in
                    rs.process(input: s.baseAddress!, frames: 480,
                               output: d.baseAddress!, outputCapacity: 600)
                }
            }
            for f in 0..<produced where total + f > 0 {
                XCTAssertEqual(dst[0][f], 0.7301, accuracy: 1e-7)
            }
            total += produced
        }
        // 2400 source frames at 48k->44.1k ≈ 2205 output frames.
        XCTAssertEqual(Double(total), 2400.0 * 44100.0 / 48000.0, accuracy: 3)
    }

    func testProducedCountTracksRatio() {
        let rs = StreamResampler(channels: 1, sourceRate: 96000, targetRate: 48000)
        let src = planes(1, 512), dst = planes(1, 512)
        defer { (src + dst).forEach { $0.deallocate() } }
        var total = 0
        for _ in 0..<10 {
            total += src.withUnsafeBufferPointer { s in
                dst.withUnsafeBufferPointer { d in
                    rs.process(input: s.baseAddress!, frames: 512,
                               output: d.baseAddress!, outputCapacity: 512)
                }
            }
        }
        XCTAssertEqual(Double(total), 2560, accuracy: 3)   // half of 5120
    }

    func testTrimClampAndEffect() {
        let rs = StreamResampler(channels: 1, sourceRate: 48000, targetRate: 48000)
        rs.setRateTrim(5.0)
        XCTAssertEqual(rs.rateTrim, 1.02, accuracy: 1e-9)
        rs.setRateTrim(0.5)
        XCTAssertEqual(rs.rateTrim, 0.98, accuracy: 1e-9)
    }

    func testCapacityCappedCallDoesNotCorruptNextCall() {
        // Regression: an output-capacity-capped process() used to leave
        // `pos` negative, making the NEXT call read input[-1] (OOB).
        let rs = StreamResampler(channels: 1, sourceRate: 48000, targetRate: 48000)
        let src = planes(1, 256), dst = planes(1, 16)   // tiny output capacity
        defer { (src + dst).forEach { $0.deallocate() } }
        for f in 0..<256 { src[0][f] = 0.5 }
        let first = src.withUnsafeBufferPointer { s in
            dst.withUnsafeBufferPointer { d in
                rs.process(input: s.baseAddress!, frames: 256,
                           output: d.baseAddress!, outputCapacity: 16)
            }
        }
        XCTAssertEqual(first, 16)
        XCTAssertTrue(rs.droppedLastCall)
        // Next call must not crash and must produce sane (DC-exact) output.
        let second = src.withUnsafeBufferPointer { s in
            dst.withUnsafeBufferPointer { d in
                rs.process(input: s.baseAddress!, frames: 16,
                           output: d.baseAddress!, outputCapacity: 16)
            }
        }
        XCTAssertGreaterThan(second, 0)
        for f in 0..<second { XCTAssertEqual(dst[0][f], 0.5, accuracy: 1e-6) }
    }

    func testFillControllerDirection() {
        var pi = BufferFillController(targetFrames: 384)
        // Buffer above target -> trim > 1 (consume source faster, produce
        // fewer frames, buffer shrinks).
        XCTAssertGreaterThan(pi.update(occupancy: 2000), 1.0)
        pi.reset()
        // Buffer below target -> trim < 1 (produce more frames, buffer grows).
        XCTAssertLessThan(pi.update(occupancy: 0), 1.0)
    }
}

final class WebSocketCodecTests: XCTestCase {
    func testRFC6455AcceptKeyVector() {
        // The worked example from RFC 6455 §1.3.
        XCTAssertEqual(WebSocketCodec.acceptKey(for: "dGhlIHNhbXBsZSBub25jZQ=="),
                       "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
    }

    private func maskedClientFrame(opcode: WSOpcode, payload: [UInt8],
                                   fin: Bool = true, key: [UInt8] = [1, 2, 3, 4]) -> Data {
        var out = Data()
        out.append((fin ? 0x80 : 0x00) | opcode.rawValue)
        if payload.count < 126 {
            out.append(0x80 | UInt8(payload.count))
        } else {
            out.append(0x80 | 126)
            out.append(UInt8(payload.count >> 8))
            out.append(UInt8(payload.count & 0xFF))
        }
        out.append(contentsOf: key)
        for (i, b) in payload.enumerated() { out.append(b ^ key[i & 3]) }
        return out
    }

    func testDecodeMaskedTextFrame() throws {
        let dec = WSDecoder()
        let msgs = try dec.feed(maskedClientFrame(opcode: .text, payload: Array("hello".utf8)))
        XCTAssertEqual(msgs, [WSMessage(opcode: .text, payload: Data("hello".utf8))])
    }

    func testDecodeAcrossPartialReads() throws {
        let dec = WSDecoder()
        let frame = maskedClientFrame(opcode: .binary, payload: [UInt8](repeating: 7, count: 300))
        var all: [WSMessage] = []
        for chunk in stride(from: 0, to: frame.count, by: 11) {
            let end = min(chunk + 11, frame.count)
            all += try dec.feed(frame.subdata(in: chunk..<end))
        }
        XCTAssertEqual(all.count, 1)
        XCTAssertEqual(all[0].payload.count, 300)
    }

    func testRejectsUnmaskedClientFrame() {
        let dec = WSDecoder()
        var frame = Data([0x81, 0x01, 0x41])    // unmasked "A"
        XCTAssertThrowsError(try dec.feed(frame))
        frame = Data()
    }

    func testFragmentedMessageReassembly() throws {
        let dec = WSDecoder()
        var bytes = maskedClientFrame(opcode: .text, payload: Array("ab".utf8), fin: false)
        bytes.append(maskedClientFrame(opcode: .continuation, payload: Array("cd".utf8)))
        let msgs = try dec.feed(bytes)
        XCTAssertEqual(msgs, [WSMessage(opcode: .text, payload: Data("abcd".utf8))])
    }

    func testFragmentFloodDoesNotOverflowStack() throws {
        // Regression: parseOne recursed once per fragment, so thousands of
        // tiny continuation frames in ONE feed() call blew the 512 KB
        // dispatch-thread stack (reproduced as SIGBUS pre-fix).
        let dec = WSDecoder()
        var bytes = maskedClientFrame(opcode: .text, payload: [65], fin: false)
        for _ in 0..<20_000 {
            bytes.append(maskedClientFrame(opcode: .continuation, payload: [], fin: false))
        }
        bytes.append(maskedClientFrame(opcode: .continuation, payload: [66]))
        let exp = expectation(description: "decoded on a dispatch worker stack")
        DispatchQueue(label: "flood-test").async {
            let msgs = try? dec.feed(bytes)
            XCTAssertEqual(msgs?.count, 1)
            XCTAssertEqual(msgs?.first?.payload, Data("AB".utf8))
            exp.fulfill()
        }
        wait(for: [exp], timeout: 10)
    }

    func testControlFrameInterleavesFragments() throws {
        let dec = WSDecoder()
        var bytes = maskedClientFrame(opcode: .text, payload: Array("ab".utf8), fin: false)
        bytes.append(maskedClientFrame(opcode: .ping, payload: [9]))
        bytes.append(maskedClientFrame(opcode: .continuation, payload: Array("cd".utf8)))
        let msgs = try dec.feed(bytes)
        XCTAssertEqual(msgs.count, 2)
        XCTAssertEqual(msgs[0].opcode, .ping)
        XCTAssertEqual(msgs[1], WSMessage(opcode: .text, payload: Data("abcd".utf8)))
    }

    func testServerFrameEncodesLengths() {
        // 8-byte payload -> short form.
        var f = WebSocketCodec.encodeFrame(opcode: .binary, payload: Data(count: 8))
        XCTAssertEqual([UInt8](f.prefix(2)), [0x82, 8])
        // 300 bytes -> 16-bit extended length.
        f = WebSocketCodec.encodeFrame(opcode: .binary, payload: Data(count: 300))
        XCTAssertEqual([UInt8](f.prefix(4)), [0x82, 126, 0x01, 0x2C])
        // 70000 bytes -> 64-bit extended length.
        f = WebSocketCodec.encodeFrame(opcode: .binary, payload: Data(count: 70000))
        XCTAssertEqual(f[f.startIndex + 1], 127)
    }

    func testHTTPHeadParsing() {
        let raw = Data(("GET /ws HTTP/1.1\r\nHost: 127.0.0.1:9209\r\n"
            + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").utf8)
        let parsed = HTTPParser.parseRequestHead(raw)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.head.method, "GET")
        XCTAssertEqual(parsed?.head.path, "/ws")
        XCTAssertTrue(parsed?.head.isWebSocketUpgrade ?? false)
        XCTAssertEqual(parsed?.consumed, raw.count)

        // Incomplete head -> nil.
        XCTAssertNil(HTTPParser.parseRequestHead(Data("GET / HTTP/1.1\r\nHost: x\r\n".utf8)))
    }
}
