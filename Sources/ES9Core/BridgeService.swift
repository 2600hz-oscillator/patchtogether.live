// BridgeService.swift
//
// The non-real-time half of the bridge: owns the WebSocket server, the single
// active client session, the resamplers, and the drain loop that pumps the
// two SPSC rings. Everything here may allocate — it never runs on the RT
// audio thread.
//
// Data flow (one active client):
//
//   inputRing  --drain thread-->  hw->client resampler  --> AUDIO frames -> WS
//   WS binary  --conn queue---->  client->hw resampler  --> outputRing
//
// Clock model: the ES-9 and the client's AudioContext run on independent
// crystals. The client->hw path is trimmed by a PI controller on outputRing
// occupancy (see StreamResampler). The hw->client path is trimmed by the
// CLIENT (sample-slip in its worklet, standard jitter-buffer practice), so
// here it runs at the nominal ratio.

import Foundation
import Synchronization

/// What the service needs from an engine — satisfied by the real
/// BridgeAudioEngine (AUHAL on the ES-9) and by SyntheticEngine (no-hardware
/// dev mode).
public protocol BridgeEngineProtocol: AnyObject {
    var inputRing: SPSCRing { get }
    var outputRing: SPSCRing { get }
    var inputChannelCount: Int { get }
    var outputChannelCount: Int { get }
    var hardwareRate: Double { get }
    var hardwareBufferFrames: Int { get }
    /// `input` gates hardware->client capture; `output` marks that a client
    /// is feeding the output ring (enables underrun accounting).
    func setStreaming(input: Bool, output: Bool)
    func setChannelMode(_ channel: Int, _ mode: ChannelMode)
    func meterSnapshot() -> (input: [Float], output: [Float])
    var underrunCount: Int { get }
    var overrunCount: Int { get }
    func start() throws
    func stop()
}

extension BridgeAudioEngine: BridgeEngineProtocol {
    public var inputChannelCount: Int { config.inputChannels }
    public var outputChannelCount: Int { config.outputChannels }
    public var hardwareRate: Double { config.sampleRate }
    public var hardwareBufferFrames: Int { Int(config.bufferFrames) }
    public func setStreaming(input: Bool, output: Bool) {
        inputStreaming.store(input, ordering: .releasing)
        outputStreaming.store(output, ordering: .releasing)
    }
    public func meterSnapshot() -> (input: [Float], output: [Float]) {
        let m = sampleMeters()
        return (m.inputRMS, m.outputRMS)
    }
    public var underrunCount: Int { underruns.load(ordering: .relaxed) }
    public var overrunCount: Int { overruns.load(ordering: .relaxed) }
}

public final class BridgeService: @unchecked Sendable {
    public struct Config {
        public var port: UInt16
        public var deviceName: String
        public var deviceUID: String
        public var inputLabels: [String]
        public var outputLabels: [String]
        /// Jitter-buffer target depth (hardware frames) for client->hw audio.
        public var outputTargetFrames: Int
        public var harnessHTML: Data
        /// How long the incumbent may be SILENT before a new client may take
        /// its slot without asking. Default 4× the web client's 2 s ping
        /// interval — long enough that a healthy client is never displaced by a
        /// hiccup, short enough that a dead one self-heals before a user gives
        /// up. Injectable so tests can shrink it instead of sleeping 8 s.
        /// ⚠ Tied to the client's ping cadence; they are ONE contract.
        public var staleAfter: TimeInterval
        /// How long a client told `busy` may linger able to send `takeover`.
        public var takeoverWindow: TimeInterval
        public init(port: UInt16, deviceName: String, deviceUID: String,
                    inputLabels: [String], outputLabels: [String],
                    outputTargetFrames: Int, harnessHTML: Data,
                    staleAfter: TimeInterval = 8.0,
                    takeoverWindow: TimeInterval = 10.0) {
            self.staleAfter = staleAfter
            self.takeoverWindow = takeoverWindow
            self.port = port
            self.deviceName = deviceName
            self.deviceUID = deviceUID
            self.inputLabels = inputLabels
            self.outputLabels = outputLabels
            self.outputTargetFrames = outputTargetFrames
            self.harnessHTML = harnessHTML
        }
    }

    private let engine: BridgeEngineProtocol
    private let config: Config
    private let server: WebSocketServer

    // ---- session state; mutated on connection queues + drain thread, so all
    // access goes through `lock`. (Audio payload copies happen OUTSIDE the
    // lock; only pointers/flags/masks live under it.)
    private let lock = NSLock()
    private var active: WebSocketSession?

    // ── LIVENESS + TAKEOVER (2026-08-07) ────────────────────────────────────
    // A single-client server must not be permanently disabled by a client that
    // went away rudely. Measured incident: nine sockets in TCP CLOSED, all
    // still held, and the app answered `busy` to everything until restarted —
    // so a browser tab that crashed (or a laptop that slept) bricked the bridge
    // and the only cure was a human noticing and restarting it.
    //
    // Liveness is "when did we last hear ANYTHING from the active session".
    // The web client already pings every 2 s (bridge.worker.ts PING_INTERVAL_MS)
    // and every inbound frame — ping, config, audio — is equally good evidence
    // of life, so nothing new is required on the wire.
    private var lastHeardAt: DispatchTime = .now()

    /// Record that the ACTIVE session is alive. Any inbound frame counts —
    /// ping, config, or audio — because all three prove the peer is there, and
    /// a streaming client can go long stretches sending only binary.
    private func noteHeard(_ session: WebSocketSession) {
        lock.lock()
        if active === session { lastHeardAt = .now() }
        lock.unlock()
    }

    /// Seconds since the active session was last heard from. Caller holds `lock`.
    private func idleSecondsLocked() -> TimeInterval {
        Double(DispatchTime.now().uptimeNanoseconds &- lastHeardAt.uptimeNanoseconds) / 1_000_000_000
    }
    private var clientRate: Double = 0
    private var inputMask: UInt32 = 0
    private var outputMask: UInt32 = 0
    private var configured = false
    private var outputPrimed = false
    private var outResampler: StreamResampler?   // client rate -> hw rate
    private var inResampler: StreamResampler?    // hw rate -> client rate
    private var fill = BufferFillController(targetFrames: 0)
    private var sendSeq: UInt16 = 0
    private var sentSampleTime: UInt64 = 0

    private var drainThread: Thread?
    private let running = Atomic<Bool>(false)

    // Preallocated drain-side staging (hw rate + client rate sides). Sized
    // above the protocol's 4096-frame block cap so a max-size block still
    // fits after resampling (trim < 1 produces slightly more than 1:1).
    private let stagingCapacity = 8192
    private var hwPlanes: [UnsafeMutablePointer<Float>] = []
    private var clientPlanes: [UnsafeMutablePointer<Float>] = []
    private var outHwPlanes: [UnsafeMutablePointer<Float>] = []
    private var outClientPlanes: [UnsafeMutablePointer<Float>] = []

    public init(engine: BridgeEngineProtocol, config: Config) {
        self.engine = engine
        self.config = config
        self.server = WebSocketServer(
            port: config.port,
            pages: [.init(path: "/", contentType: "text/html; charset=utf-8",
                          body: config.harnessHTML)])

        let inCh = engine.inputChannelCount
        let outCh = engine.outputChannelCount
        hwPlanes = Self.allocPlanes(inCh, stagingCapacity)
        clientPlanes = Self.allocPlanes(inCh, stagingCapacity)
        outHwPlanes = Self.allocPlanes(outCh, stagingCapacity)
        outClientPlanes = Self.allocPlanes(outCh, stagingCapacity)
    }

    deinit {
        (hwPlanes + clientPlanes + outHwPlanes + outClientPlanes).forEach { $0.deallocate() }
    }

    private static func allocPlanes(_ channels: Int, _ cap: Int) -> [UnsafeMutablePointer<Float>] {
        (0..<channels).map { _ in
            let p = UnsafeMutablePointer<Float>.allocate(capacity: cap)
            p.initialize(repeating: 0, count: cap)
            return p
        }
    }

    // MARK: - Lifecycle

    public func start() throws {
        try engine.start()
        server.onSession = { [weak self] session in
            self?.attach(session)
        }
        do {
            try server.start()
        } catch {
            engine.stop()   // don't leak a running engine on a port collision
            throw error
        }
        running.store(true, ordering: .releasing)
        let t = Thread { [weak self] in self?.drainLoop() }
        t.name = "es9.bridge.drain"
        t.qualityOfService = .userInteractive
        t.start()
        drainThread = t
    }

    public func stop() {
        running.store(false, ordering: .releasing)
        server.stop()
        engine.stop()
    }

    // MARK: - Session wiring

    private func attach(_ session: WebSocketSession) {
        var evicted: WebSocketSession?
        var incumbentIdle: TimeInterval = 0
        let accepted: Bool = {
            lock.lock(); defer { lock.unlock() }
            if let incumbent = active {
                incumbentIdle = idleSecondsLocked()
                // GRACE TAKEOVER: the slot is held by a session we have not
                // heard from in longer than `staleAfter`. It is not coming
                // back — hand the slot to the newcomer rather than making a
                // human restart the app. The incumbent is dropped OUTSIDE the
                // lock (below) so its close path cannot deadlock against us.
                guard incumbentIdle > config.staleAfter else { return false }
                evicted = incumbent
            }
            active = session
            lastHeardAt = .now()
            configured = false
            outputPrimed = false
            clientRate = 0
            inputMask = 0
            outputMask = 0
            sendSeq = 0
            sentSampleTime = 0
            return true
        }()
        if let evicted {
            evicted.sendText(Self.encodeJSON(StatusMessage(
                state: "stopped",
                detail: "another client took over after \(Int(incumbentIdle))s without contact")))
            evicted.close()
        }

        guard accepted else {
            // BUSY, but not a dead end. The session is kept for a bounded
            // window so the client may answer with `takeover` — the whole
            // point being that a user faced with "another client is connected"
            // gets an ACTION instead of a button that appears to do nothing.
            // The detail carries the incumbent's idle time so the UI can say
            // WHY, which is what was missing when this bricked in the field.
            session.sendText(Self.encodeJSON(StatusMessage(
                state: "busy",
                detail: "another client is connected (last heard \(Int(incumbentIdle))s ago) — send {\"type\":\"takeover\"} to claim it")))
            session.onText = { [weak self] s, text in self?.handleWaitingText(s, text) }
            session.onClose = { _ in }
            // Never let a rejected session linger indefinitely against maxSessions.
            DispatchQueue.global().asyncAfter(deadline: .now() + config.takeoverWindow) { [weak self, weak session] in
                guard let session else { return }
                var stillWaiting = false
                if let self { self.lock.lock(); stillWaiting = self.active !== session; self.lock.unlock() }
                if stillWaiting { session.close() }
            }
            return
        }

        session.onText = { [weak self] s, text in self?.handleText(s, text) }
        session.onBinary = { [weak self] s, data in self?.handleBinary(s, data) }
        session.onClose = { [weak self] s in self?.detach(s) }
    }

    /// Message handler for a session that was told `busy`. It may do exactly
    /// one thing: claim the slot. Anything else is ignored — a waiting session
    /// must not be able to configure or stream.
    private func handleWaitingText(_ session: WebSocketSession, _ text: String) {
        guard let data = text.data(using: .utf8),
              let envelope = try? JSONDecoder().decode(ControlEnvelope.self, from: data),
              envelope.type == "takeover"
        else { return }

        var evicted: WebSocketSession?
        lock.lock()
        if let incumbent = active, incumbent !== session {
            evicted = incumbent
        }
        active = session
        lastHeardAt = .now()
        configured = false
        outputPrimed = false
        clientRate = 0
        inputMask = 0
        outputMask = 0
        sendSeq = 0
        sentSampleTime = 0
        lock.unlock()

        if let evicted {
            evicted.sendText(Self.encodeJSON(StatusMessage(
                state: "stopped", detail: "another client took over")))
            evicted.close()
        }
        session.onText = { [weak self] s, t in self?.handleText(s, t) }
        session.onBinary = { [weak self] s, d in self?.handleBinary(s, d) }
        session.onClose = { [weak self] s in self?.detach(s) }
    }

    private func detach(_ session: WebSocketSession) {
        // Engine calls stay INSIDE the lock (they're just atomic stores):
        // dropping the lock first would let a new session attach+configure
        // and then have this stale detach stomp its streaming flags.
        lock.lock()
        if active === session {
            active = nil
            configured = false
            // Audio-mode fade-out will silence outputs as the ring drains;
            // flip every channel to audio so no CV stays held forever.
            for c in 0..<engine.outputChannelCount { engine.setChannelMode(c, .audio) }
            engine.setStreaming(input: false, output: false)
        }
        lock.unlock()
    }

    private func handleText(_ session: WebSocketSession, _ text: String) {
        noteHeard(session)
        guard let data = text.data(using: .utf8),
              let envelope = try? JSONDecoder().decode(ControlEnvelope.self, from: data)
        else { return }
        switch envelope.type {
        case "hello":
            guard let hello = try? JSONDecoder().decode(HelloMessage.self, from: data),
                  hello.rate > 8000, hello.rate <= 384000 else { return }
            lock.lock()
            clientRate = hello.rate
            outResampler = StreamResampler(channels: engine.outputChannelCount,
                                           sourceRate: hello.rate,
                                           targetRate: engine.hardwareRate)
            inResampler = StreamResampler(channels: engine.inputChannelCount,
                                          sourceRate: engine.hardwareRate,
                                          targetRate: hello.rate)
            fill = BufferFillController(targetFrames: Double(config.outputTargetFrames))
            lock.unlock()
            session.sendText(Self.encodeJSON(DeviceInfoMessage(
                name: config.deviceName, uid: config.deviceUID,
                rate: engine.hardwareRate,
                inputChannels: engine.inputChannelCount,
                outputChannels: engine.outputChannelCount,
                bufferFrames: engine.hardwareBufferFrames,
                inputLabels: config.inputLabels,
                outputLabels: config.outputLabels)))
        case "config":
            guard let cfg = try? JSONDecoder().decode(ConfigMessage.self, from: data) else { return }
            lock.lock()
            guard active === session else { lock.unlock(); return }
            inputMask = cfg.inputMask
            outputMask = cfg.outputMask
            configured = clientRate > 0
            let outputRising = configured && cfg.outputMask != 0 && !outputPrimed
            if outputRising { outputPrimed = true }
            for c in 0..<engine.outputChannelCount {
                engine.setChannelMode(c, cfg.outputModes?[String(c)] ?? .audio)
            }
            // Prime BEFORE enabling underrun accounting so the RT consumer
            // starts with a full jitter cushion. All engine calls stay under
            // the lock so a concurrent detach can't interleave.
            if outputRising { primeOutputRing() }
            engine.setStreaming(input: configured && cfg.inputMask != 0,
                                output: configured && cfg.outputMask != 0)
            lock.unlock()
        case "ping":
            if let ping = try? JSONDecoder().decode(PingMessage.self, from: data) {
                session.sendText(Self.encodeJSON(PongMessage(t: ping.t)))
            }
        default:
            break
        }
    }

    /// Pre-fill the client->hw ring with silence to its target depth so the
    /// RT consumer has a cushion before the first client block lands. Loops
    /// in staging-sized chunks (a --target-frames above stagingCapacity must
    /// still reach target) and clamps to half the ring so priming can never
    /// leave the ring with no room for real audio.
    private func primeOutputRing() {
        var remaining = min(config.outputTargetFrames, engine.outputRing.capacity / 2)
        for p in outHwPlanes { p.update(repeating: 0, count: min(remaining, stagingCapacity)) }
        while remaining > 0 {
            let n = min(remaining, stagingCapacity)
            let wrote = outHwPlanes.withUnsafeBufferPointer { bp in
                engine.outputRing.write(planes: bp.baseAddress!, frames: n)
            }
            if wrote < n { break }   // ring full — cushion is as deep as it gets
            remaining -= wrote
        }
    }

    // MARK: - Client -> hardware (runs on the connection's queue)

    private func handleBinary(_ session: WebSocketSession, _ data: Data) {
        noteHeard(session)
        guard let block = try? BridgeWire.decode(data) else { return }
        lock.lock()
        guard active === session, configured, let resampler = outResampler else {
            lock.unlock(); return
        }
        let mask = outputMask
        lock.unlock()

        let outCh = engine.outputChannelCount
        let frames = min(block.frameCount, stagingCapacity)

        // Expand sparse planes to full width (undriven channels = 0).
        for c in 0..<outCh { outClientPlanes[c].update(repeating: 0, count: frames) }
        var planeIdx = 0
        for c in block.channels {
            defer { planeIdx += 1 }
            guard c < outCh, (mask & (1 << UInt32(c))) != 0 else { continue }
            block.planes[planeIdx].withUnsafeBufferPointer { src in
                outClientPlanes[c].update(from: src.baseAddress!, count: frames)
            }
        }

        // Trim the resampler toward the occupancy target, then convert and
        // enqueue for the RT consumer. Convert in slices so the resampler's
        // output never hits outputCapacity even at extreme ratios (a capped
        // process() drops samples) — 512 client frames upconverted to the
        // ES-9's max 96 kHz from the minimum hello rate stays well under
        // stagingCapacity.
        let trim = lockThen { fill.update(occupancy: engine.outputRing.occupancy) }
        resampler.setRateTrim(trim)
        var consumed = 0
        while consumed < frames {
            let sliceLen = min(512, frames - consumed)
            let slice = outClientPlanes.map { $0 + consumed }
            let produced = slice.withUnsafeBufferPointer { src in
                outHwPlanes.withUnsafeBufferPointer { dst in
                    resampler.process(input: src.baseAddress!, frames: sliceLen,
                                      output: dst.baseAddress!, outputCapacity: stagingCapacity)
                }
            }
            if produced > 0 {
                _ = outHwPlanes.withUnsafeBufferPointer { bp in
                    engine.outputRing.write(planes: bp.baseAddress!, frames: produced)
                }
            }
            consumed += sliceLen
        }
    }

    private func lockThen<T>(_ body: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return body()
    }

    // MARK: - Hardware -> client (drain thread)

    private func drainLoop() {
        var lastMeters = ContinuousClock.now
        while running.load(ordering: .acquiring) {
            usleep(2000)   // ~2 ms cadence; rings absorb scheduling jitter

            let (session, resampler, mask): (WebSocketSession?, StreamResampler?, UInt32) = lockThen {
                (configured ? active : nil, inResampler, inputMask)
            }

            if let session, let resampler, mask != 0 {
                pumpInput(session, resampler, mask)
            } else if engine.inputRing.occupancy > 0 {
                engine.inputRing.skip(frames: engine.inputRing.occupancy)
            }

            // Meters + health at ~8 Hz to whoever is connected.
            let now = ContinuousClock.now
            if now - lastMeters > .milliseconds(125) {
                lastMeters = now
                let target: WebSocketSession? = lockThen { active }
                if let target {
                    let m = engine.meterSnapshot()
                    target.sendText(Self.encodeJSON(MetersMessage(
                        inputRMS: m.input, outputRMS: m.output,
                        underruns: engine.underrunCount,
                        overruns: engine.overrunCount,
                        outputBufferFrames: engine.outputRing.occupancy)))
                }
            }
        }
    }

    private func pumpInput(_ session: WebSocketSession, _ resampler: StreamResampler, _ mask: UInt32) {
        let inCh = engine.inputChannelCount
        while true {
            let chunk = min(engine.inputRing.occupancy, 512)
            if chunk <= 0 { break }
            let got = hwPlanes.withUnsafeBufferPointer { bp in
                engine.inputRing.read(into: bp.baseAddress!, frames: chunk)
            }
            if got <= 0 { break }
            let produced = hwPlanes.withUnsafeBufferPointer { src in
                clientPlanes.withUnsafeBufferPointer { dst in
                    resampler.process(input: src.baseAddress!, frames: got,
                                      output: dst.baseAddress!, outputCapacity: stagingCapacity)
                }
            }
            guard produced > 0 else { continue }

            var planes: [[Float]] = []
            var sentMask: UInt32 = 0
            for c in 0..<inCh where (mask & (1 << UInt32(c))) != 0 {
                planes.append([Float](UnsafeBufferPointer(start: clientPlanes[c], count: produced)))
                sentMask |= 1 << UInt32(c)
            }
            guard sentMask != 0 else { continue }
            // seq + sampleTime advance under ONE lock hold so attach()'s
            // reset can't interleave with this read-modify-write.
            let (seq, sampleTime): (UInt16, UInt64) = lockThen {
                sendSeq &+= 1
                let t = sentSampleTime
                sentSampleTime &+= UInt64(produced)
                return (sendSeq, t)
            }
            let block = AudioBlock(seq: seq, sampleTime: sampleTime,
                                   channelMask: sentMask, frameCount: produced,
                                   planes: planes)
            session.sendBinary(BridgeWire.encode(block))
        }
    }

    private static func encodeJSON<T: Encodable>(_ value: T) -> String {
        guard let data = try? JSONEncoder().encode(value) else { return "{}" }
        return String(data: data, encoding: .utf8) ?? "{}"
    }
}
