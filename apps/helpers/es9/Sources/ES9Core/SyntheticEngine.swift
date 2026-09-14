// SyntheticEngine.swift
//
// A no-hardware stand-in for BridgeAudioEngine so the bridge (and the browser
// harness / future patchtogether module) can be developed and tested without
// an ES-9 attached (`es9-bridge --synthetic`). A timer thread plays the role
// of the RT callbacks at hardware cadence:
//
//   inputs:  ch1 = 440 Hz sine, ch2 = 0.5 Hz triangle "LFO" (CV-like),
//            ch3 = 1 Hz gate (0/+0.8), others silent.
//   outputs: drained and metered, so a client's outgoing audio/CV shows up in
//            the meters exactly as it would on hardware.

import Foundation
import Synchronization

public final class SyntheticEngine: BridgeEngineProtocol, @unchecked Sendable {
    public let inputRing: SPSCRing
    public let outputRing: SPSCRing
    public let inputChannelCount: Int
    public let outputChannelCount: Int
    public let hardwareRate: Double
    public let hardwareBufferFrames: Int

    private let inputActive = Atomic<Bool>(false)
    private let outputActive = Atomic<Bool>(false)
    private let running = Atomic<Bool>(false)
    private let underrunsA = Atomic<Int>(0)
    private let overrunsA = Atomic<Int>(0)

    private var thread: Thread?
    private var phase: Double = 0        // sine phase (cycles)
    private var lfoPhase: Double = 0     // triangle phase (cycles)
    private var frameClock: UInt64 = 0

    private var genPlanes: [UnsafeMutablePointer<Float>]
    private var sinkPlanes: [UnsafeMutablePointer<Float>]
    private let blockFrames: Int

    // Windowed RMS accumulators (same contract as the real engine).
    private var inSumSq: [Double]
    private var outSumSq: [Double]
    private var inFrames: Int64 = 0
    private var outFrames: Int64 = 0
    private let meterLock = NSLock()

    public init(inputChannels: Int = 16, outputChannels: Int = 16,
                rate: Double = 48000, bufferFrames: Int = 128) {
        inputChannelCount = inputChannels
        outputChannelCount = outputChannels
        hardwareRate = rate
        hardwareBufferFrames = bufferFrames
        blockFrames = bufferFrames
        inputRing = SPSCRing(channels: inputChannels, capacityFrames: 16384)
        outputRing = SPSCRing(channels: outputChannels, capacityFrames: 16384)
        genPlanes = (0..<inputChannels).map { _ in
            let p = UnsafeMutablePointer<Float>.allocate(capacity: bufferFrames)
            p.initialize(repeating: 0, count: bufferFrames)
            return p
        }
        sinkPlanes = (0..<outputChannels).map { _ in
            let p = UnsafeMutablePointer<Float>.allocate(capacity: bufferFrames)
            p.initialize(repeating: 0, count: bufferFrames)
            return p
        }
        inSumSq = .init(repeating: 0, count: inputChannels)
        outSumSq = .init(repeating: 0, count: outputChannels)
    }

    deinit {
        (genPlanes + sinkPlanes).forEach { $0.deallocate() }
    }

    public func setStreaming(input: Bool, output: Bool) {
        inputActive.store(input, ordering: .releasing)
        outputActive.store(output, ordering: .releasing)
    }
    public func setChannelMode(_ channel: Int, _ mode: ChannelMode) {}
    public var underrunCount: Int { underrunsA.load(ordering: .relaxed) }
    public var overrunCount: Int { overrunsA.load(ordering: .relaxed) }

    public func meterSnapshot() -> (input: [Float], output: [Float]) {
        meterLock.lock(); defer { meterLock.unlock() }
        let iN = Double(max(inFrames, 1)), oN = Double(max(outFrames, 1))
        let inDB = inSumSq.map { rmsToDBFS(Float(($0 / iN).squareRoot())) }
        let outDB = outSumSq.map { rmsToDBFS(Float(($0 / oN).squareRoot())) }
        for i in inSumSq.indices { inSumSq[i] = 0 }
        for i in outSumSq.indices { outSumSq[i] = 0 }
        inFrames = 0; outFrames = 0
        return (inDB, outDB)
    }

    public func start() throws {
        running.store(true, ordering: .releasing)
        let t = Thread { [weak self] in self?.loop() }
        t.name = "es9.synthetic"
        t.qualityOfService = .userInteractive
        t.start()
        thread = t
    }

    public func stop() {
        running.store(false, ordering: .releasing)
    }

    private func loop() {
        let blockDur = Double(blockFrames) / hardwareRate
        var next = Date()
        while running.load(ordering: .acquiring) {
            next = next.addingTimeInterval(blockDur)
            let wait = next.timeIntervalSinceNow
            if wait > 0 { usleep(UInt32(wait * 1_000_000)) } else { next = Date() }
            tick()
        }
    }

    private func tick() {
        let n = blockFrames
        // Generate inputs.
        for f in 0..<n {
            let sine = Float(sin(2 * .pi * phase))
            // Triangle in [-0.5, +0.5] — reads like a slow bipolar CV LFO.
            let triRaw = lfoPhase - lfoPhase.rounded(.down)
            let tri = Float(abs(triRaw * 2 - 1) - 0.5)
            // 1 Hz gate (two cycles per 0.5 Hz LFO period), as documented.
            let gateRaw = (triRaw * 2) - (triRaw * 2).rounded(.down)
            let gate: Float = gateRaw < 0.5 ? 0.8 : 0.0
            genPlanes[0][f] = 0.5 * sine
            if inputChannelCount > 1 { genPlanes[1][f] = tri }
            if inputChannelCount > 2 { genPlanes[2][f] = gate }
            phase += 440.0 / hardwareRate
            if phase >= 1 { phase -= 1 }
            lfoPhase += 0.5 / hardwareRate
            if lfoPhase >= 1 { lfoPhase -= 1 }
        }
        for c in 3..<inputChannelCount { genPlanes[c].update(repeating: 0, count: n) }

        meterLock.lock()
        for c in 0..<inputChannelCount {
            var ss = 0.0
            for f in 0..<n { let v = Double(genPlanes[c][f]); ss += v * v }
            inSumSq[c] += ss
        }
        inFrames += Int64(n)
        meterLock.unlock()

        if inputActive.load(ordering: .acquiring) {
            let wrote = genPlanes.withUnsafeBufferPointer { bp in
                inputRing.write(planes: bp.baseAddress!, frames: n)
            }
            if wrote < n { overrunsA.wrappingAdd(1, ordering: .relaxed) }
        }

        // Drain client audio like a DAC would, meter it.
        let got = sinkPlanes.withUnsafeBufferPointer { bp in
            outputRing.read(into: bp.baseAddress!, frames: n)
        }
        if outputActive.load(ordering: .acquiring) && got < n {
            underrunsA.wrappingAdd(1, ordering: .relaxed)
        }
        if got > 0 {
            meterLock.lock()
            for c in 0..<outputChannelCount {
                var ss = 0.0
                for f in 0..<got { let v = Double(sinkPlanes[c][f]); ss += v * v }
                outSumSq[c] += ss
            }
            outFrames += Int64(got)
            meterLock.unlock()
        }
        frameClock &+= UInt64(n)
    }
}
