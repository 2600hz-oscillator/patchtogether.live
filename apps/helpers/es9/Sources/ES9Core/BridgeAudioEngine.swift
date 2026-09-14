// BridgeAudioEngine.swift
//
// The bridge's real-time half: one full-duplex AUHAL on the ES-9 (same
// pattern DuplexEngine proved — one unit, one device, one clock), but instead
// of routing input pairs to output pairs it moves blocks through two SPSC
// rings shared with the network drain thread:
//
//   RT input callback  --write-->  inputRing   --read-->  drain -> WebSocket
//   WebSocket -> drain --write-->  outputRing  --read-->  RT output callback
//
// DuplexEngine stays untouched as the passthrough spike; this engine is
// deliberately self-contained so the proven es9-duplex tool keeps working.
//
// RT rules preserved: callbacks do no allocation, no locks, no ARC traffic —
// ring ops are memcpy + two atomics; policies below are plain loops over
// preallocated C buffers.
//
// Output underrun policy (per channel, set by the client):
//   .audio — ramp from the last emitted sample to 0 over up to 64 frames,
//            then silence. Speaker-safe, click-free.
//   .cv    — HOLD the last emitted sample. A CV snapping to 0 V on a network
//            hiccup would yank every patched parameter; holding is correct
//            (this is exactly why the ES-9's DC-coupled outs must NOT get an
//            HPF/limiter — the whole path stays bit-transparent).

import CoreAudio
import AudioToolbox
import AudioUnit
import Foundation
import Synchronization

public final class BridgeAudioEngine: @unchecked Sendable {
    public struct Config {
        public var device: AudioDeviceID
        public var inputChannels: Int
        public var outputChannels: Int
        public var sampleRate: Double
        public var bufferFrames: UInt32
        /// Ring capacity in frames (jitter headroom each direction).
        public var ringFrames: Int
        /// Largest block the HAL could ever hand us. The device buffer size
        /// is a GLOBAL property — another app can raise it after we start —
        /// so staging buffers are sized to the device's maximum, not ours.
        public var maxHALFrames: Int
        public init(device: AudioDeviceID, inputChannels: Int, outputChannels: Int,
                    sampleRate: Double, bufferFrames: UInt32, ringFrames: Int = 16384,
                    maxHALFrames: Int = 4096) {
            self.device = device
            self.inputChannels = inputChannels
            self.outputChannels = outputChannels
            self.sampleRate = sampleRate
            self.bufferFrames = bufferFrames
            self.ringFrames = ringFrames
            self.maxHALFrames = maxHALFrames
        }
    }

    public let config: Config
    /// Hardware input -> network. Producer: RT. Consumer: drain thread.
    public let inputRing: SPSCRing
    /// Network -> hardware output. Producer: drain thread. Consumer: RT.
    public let outputRing: SPSCRing

    private var unit: AudioUnit?

    /// Frames each preallocated staging plane can hold.
    private let stagingFrames: Int

    // Preallocated input render target (one buffer per channel).
    private var inputABL: UnsafeMutableAudioBufferListPointer
    private var inputStorage: [UnsafeMutablePointer<Float>]
    private var inputPlanes: UnsafeMutablePointer<UnsafeMutablePointer<Float>>

    // Preallocated output staging (ring read target before policy fill).
    private var outputStorage: [UnsafeMutablePointer<Float>]
    private var outputPlanes: UnsafeMutablePointer<UnsafeMutablePointer<Float>>

    // Per-output-channel state for underrun policy. RT-only access.
    private var lastOutSample: UnsafeMutablePointer<Float>
    /// Per-channel fade decrement while underrunning in audio mode. Persists
    /// ACROSS callbacks so the 64-frame fade is honored even when the ring
    /// runs dry a few frames before a callback boundary (otherwise the ramp
    /// compresses to a click-level snap). 0 = not fading.
    private var fadeStep: UnsafeMutablePointer<Float>
    /// 0 = audio (fade to silence), 1 = cv (hold). Written by the session
    /// thread (single writer), read by RT; single-byte access can't tear.
    public let channelModes: UnsafeMutablePointer<UInt8>

    /// True while a client subscribes to inputs; gates inputRing writes (and
    /// overrun counting) so the ring doesn't fill when nobody is listening.
    public let inputStreaming = Atomic<Bool>(false)
    /// True while a client drives outputs; gates UNDERRUN COUNTING only — the
    /// output callback always drains the ring and applies the per-channel
    /// policy, so a disconnect fades audio out / releases CV cleanly.
    public let outputStreaming = Atomic<Bool>(false)

    // Health counters (RT increments, telemetry reads).
    public let underruns = Atomic<Int>(0)   // output ring came up short
    public let overruns = Atomic<Int>(0)    // input ring overflowed (drops)

    // RMS accumulators. RT is the ONLY writer and accumulates CUMULATIVELY
    // (never reset); the meter reader snapshots under a generation seqlock
    // (meterGen bumps once per callback) and diffs against its previous
    // snapshot. The reader never writes RT memory, so no update can be lost
    // and windows can't smear into each other.
    private let inSumSq: UnsafeMutablePointer<Double>
    private let outSumSq: UnsafeMutablePointer<Double>
    private let rmsFrames: UnsafeMutablePointer<Int64>
    private let meterGen = Atomic<UInt64>(0)
    // Reader-owned previous snapshot (drain thread only).
    private var prevInSumSq: [Double]
    private var prevOutSumSq: [Double]
    private var prevFrames: [Int64] = [0, 0]

    public init(_ config: Config) {
        self.config = config
        let inCh = max(config.inputChannels, 1)
        let outCh = max(config.outputChannels, 1)
        inputRing = SPSCRing(channels: inCh, capacityFrames: config.ringFrames)
        outputRing = SPSCRing(channels: outCh, capacityFrames: config.ringFrames)

        let cap = max(Int(config.bufferFrames) * 4 + 32, config.maxHALFrames)
        self.stagingFrames = cap
        inputStorage = (0..<inCh).map { _ in
            let p = UnsafeMutablePointer<Float>.allocate(capacity: cap)
            p.initialize(repeating: 0, count: cap)
            return p
        }
        let abl = AudioBufferList.allocate(maximumBuffers: inCh)
        for i in 0..<inCh {
            abl[i] = AudioBuffer(mNumberChannels: 1,
                                 mDataByteSize: UInt32(cap * MemoryLayout<Float>.size),
                                 mData: inputStorage[i])
        }
        inputABL = abl
        inputPlanes = .allocate(capacity: inCh)
        for i in 0..<inCh { inputPlanes[i] = inputStorage[i] }

        outputStorage = (0..<outCh).map { _ in
            let p = UnsafeMutablePointer<Float>.allocate(capacity: cap)
            p.initialize(repeating: 0, count: cap)
            return p
        }
        outputPlanes = .allocate(capacity: outCh)
        for i in 0..<outCh { outputPlanes[i] = outputStorage[i] }

        lastOutSample = .allocate(capacity: outCh)
        lastOutSample.initialize(repeating: 0, count: outCh)
        fadeStep = .allocate(capacity: outCh)
        fadeStep.initialize(repeating: 0, count: outCh)
        channelModes = .allocate(capacity: outCh)
        channelModes.initialize(repeating: 0, count: outCh)

        inSumSq = .allocate(capacity: inCh); inSumSq.initialize(repeating: 0, count: inCh)
        outSumSq = .allocate(capacity: outCh); outSumSq.initialize(repeating: 0, count: outCh)
        rmsFrames = .allocate(capacity: 2); rmsFrames.initialize(repeating: 0, count: 2)
        prevInSumSq = .init(repeating: 0, count: inCh)
        prevOutSumSq = .init(repeating: 0, count: outCh)
    }

    deinit {
        if let u = unit { AudioOutputUnitStop(u); AudioUnitUninitialize(u); AudioComponentInstanceDispose(u) }
        inputStorage.forEach { $0.deallocate() }
        outputStorage.forEach { $0.deallocate() }
        free(inputABL.unsafeMutablePointer)
        inputPlanes.deallocate()
        outputPlanes.deallocate()
        lastOutSample.deallocate()
        fadeStep.deallocate()
        channelModes.deallocate()
        inSumSq.deallocate(); outSumSq.deallocate(); rmsFrames.deallocate()
    }

    // MARK: - Setup (mirrors DuplexEngine; see that file for the rationale)

    public func start() throws {
        var desc = AudioComponentDescription(
            componentType: kAudioUnitType_Output,
            componentSubType: kAudioUnitSubType_HALOutput,
            componentManufacturer: kAudioUnitManufacturer_Apple,
            componentFlags: 0, componentFlagsMask: 0)
        guard let comp = AudioComponentFindNext(nil, &desc) else {
            throw CoreAudioError(-1, "AudioComponentFindNext(HALOutput)")
        }
        var u: AudioUnit?
        try check(AudioComponentInstanceNew(comp, &u), "AudioComponentInstanceNew")
        guard let audioUnit = u else { throw CoreAudioError(-1, "null AudioUnit") }
        self.unit = audioUnit

        var enable: UInt32 = 1
        try check(AudioUnitSetProperty(audioUnit, kAudioOutputUnitProperty_EnableIO,
            kAudioUnitScope_Input, 1, &enable, UInt32(MemoryLayout<UInt32>.size)),
            "EnableIO(input,bus1)")
        try check(AudioUnitSetProperty(audioUnit, kAudioOutputUnitProperty_EnableIO,
            kAudioUnitScope_Output, 0, &enable, UInt32(MemoryLayout<UInt32>.size)),
            "EnableIO(output,bus0)")

        var dev = config.device
        try check(AudioUnitSetProperty(audioUnit, kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global, 0, &dev, UInt32(MemoryLayout<AudioDeviceID>.size)),
            "SetCurrentDevice")

        // Nominal sample rate + buffer size on the device.
        var rate = config.sampleRate
        var srAddr = addr(kAudioDevicePropertyNominalSampleRate)
        _ = AudioObjectSetPropertyData(config.device, &srAddr, 0, nil,
            UInt32(MemoryLayout<Double>.size), &rate)
        var frames = config.bufferFrames
        var bfsAddr = addr(kAudioDevicePropertyBufferFrameSize)
        _ = AudioObjectSetPropertyData(config.device, &bfsAddr, 0, nil,
            UInt32(MemoryLayout<UInt32>.size), &frames)

        let inFmt = nonInterleavedFloat(channels: config.inputChannels, rate: config.sampleRate)
        var inFmtVar = inFmt
        try check(AudioUnitSetProperty(audioUnit, kAudioUnitProperty_StreamFormat,
            kAudioUnitScope_Output, 1, &inFmtVar, UInt32(MemoryLayout<AudioStreamBasicDescription>.size)),
            "StreamFormat(input client)")
        let outFmt = nonInterleavedFloat(channels: config.outputChannels, rate: config.sampleRate)
        var outFmtVar = outFmt
        try check(AudioUnitSetProperty(audioUnit, kAudioUnitProperty_StreamFormat,
            kAudioUnitScope_Input, 0, &outFmtVar, UInt32(MemoryLayout<AudioStreamBasicDescription>.size)),
            "StreamFormat(output client)")

        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        var inCB = AURenderCallbackStruct(inputProc: bridgeInputTrampoline, inputProcRefCon: selfPtr)
        try check(AudioUnitSetProperty(audioUnit, kAudioOutputUnitProperty_SetInputCallback,
            kAudioUnitScope_Global, 0, &inCB, UInt32(MemoryLayout<AURenderCallbackStruct>.size)),
            "SetInputCallback")
        var outCB = AURenderCallbackStruct(inputProc: bridgeOutputTrampoline, inputProcRefCon: selfPtr)
        try check(AudioUnitSetProperty(audioUnit, kAudioUnitProperty_SetRenderCallback,
            kAudioUnitScope_Input, 0, &outCB, UInt32(MemoryLayout<AURenderCallbackStruct>.size)),
            "SetRenderCallback")

        try check(AudioUnitInitialize(audioUnit), "AudioUnitInitialize")
        try check(AudioOutputUnitStart(audioUnit), "AudioOutputUnitStart")
    }

    public func stop() {
        if let u = unit { AudioOutputUnitStop(u) }
    }

    // MARK: - RT callbacks

    fileprivate func renderInput(_ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
                                 _ ts: UnsafePointer<AudioTimeStamp>,
                                 _ frames: UInt32) -> OSStatus {
        guard let u = unit else { return noErr }
        // Never let a larger-than-staged block scribble past our buffers.
        guard Int(frames) <= stagingFrames else { return kAudioUnitErr_TooManyFramesToProcess }
        let bytes = UInt32(Int(frames) * MemoryLayout<Float>.size)
        for i in 0..<inputABL.count { inputABL[i].mDataByteSize = bytes }
        let st = AudioUnitRender(u, flags, ts, 1, frames, inputABL.unsafeMutablePointer)
        if st != noErr { return st }
        let n = Int(frames)

        // RMS accumulate (always, so meters work with no client).
        for ch in 0..<config.inputChannels {
            let src = inputABL[ch].mData!.assumingMemoryBound(to: Float.self)
            var ss = 0.0
            for f in 0..<n { let v = Double(src[f]); ss += v * v }
            inSumSq[ch] += ss
        }
        rmsFrames[0] += Int64(n)
        meterGen.wrappingAdd(1, ordering: .releasing)

        // Ship to the drain only when someone is listening.
        if inputStreaming.load(ordering: .acquiring) {
            let wrote = inputRing.write(planes: inputPlanes, frames: n)
            if wrote < n {
                overruns.wrappingAdd(1, ordering: .relaxed)
            }
        }
        return noErr
    }

    fileprivate func renderOutput(_ frames: UInt32,
                                  _ ioData: UnsafeMutablePointer<AudioBufferList>?) -> OSStatus {
        guard let ioData = ioData else { return noErr }
        let abl = UnsafeMutableAudioBufferListPointer(ioData)
        let n = Int(frames)
        guard n <= stagingFrames else { return kAudioUnitErr_TooManyFramesToProcess }
        let outCh = min(abl.count, config.outputChannels)
        let streaming = outputStreaming.load(ordering: .acquiring)

        // Always drain the ring (so a disconnect fades out / releases CV);
        // only count underruns while a client is supposed to be feeding it.
        let got = outputRing.read(into: outputPlanes, frames: n)
        if streaming && got < n {
            underruns.wrappingAdd(1, ordering: .relaxed)
        }

        for ch in 0..<outCh {
            let dst = abl[ch].mData!.assumingMemoryBound(to: Float.self)
            let staged = outputPlanes[ch]
            if got > 0 {
                memcpy(dst, staged, got * MemoryLayout<Float>.size)
                lastOutSample[ch] = staged[got - 1]
                fadeStep[ch] = 0            // fresh data cancels any fade
            }
            if got < n {
                // Underrun tail: policy fill from the last emitted sample.
                if channelModes[ch] == 1 {
                    // CV: hold.
                    let last = lastOutSample[ch]
                    for f in got..<n { dst[f] = last }
                } else {
                    // Audio: linear fade to 0 over 64 frames TOTAL, carried
                    // across callbacks — the ring can run dry one frame
                    // before a callback boundary, and compressing the fade
                    // into that remainder would be a full-scale click.
                    var last = lastOutSample[ch]
                    var step = fadeStep[ch]
                    if step == 0 && last != 0 { step = last / 64 }
                    for f in got..<n {
                        last -= step
                        if step == 0 || (step > 0 && last <= 0) || (step < 0 && last >= 0) {
                            last = 0
                            step = 0
                        }
                        dst[f] = last
                    }
                    lastOutSample[ch] = last
                    fadeStep[ch] = step
                }
            }
            var ss = 0.0
            for f in 0..<n { let v = Double(dst[f]); ss += v * v }
            outSumSq[ch] += ss
        }
        rmsFrames[1] += Int64(frames)
        meterGen.wrappingAdd(1, ordering: .releasing)
        return noErr
    }

    // MARK: - Session-side controls (non-RT)

    /// Set an output channel's underrun mode (single writer: session queue).
    public func setChannelMode(_ channel: Int, _ mode: ChannelMode) {
        guard channel >= 0 && channel < config.outputChannels else { return }
        channelModes[channel] = mode == .cv ? 1 : 0
    }

    /// Windowed RMS since the previous call. Reader-side only: snapshots the
    /// cumulative accumulators under the meterGen seqlock (bounded retries;
    /// a mid-callback read only smears one block's energy across adjacent
    /// windows) and diffs against the previous snapshot. Call from ONE
    /// thread (the drain thread).
    public func sampleMeters() -> DuplexEngine.Meters {
        let inCh = config.inputChannels
        let outCh = config.outputChannels
        var inS = [Double](repeating: 0, count: inCh)
        var outS = [Double](repeating: 0, count: outCh)
        var fr: [Int64] = [0, 0]
        for _ in 0..<4 {
            let g1 = meterGen.load(ordering: .acquiring)
            for ch in 0..<inCh { inS[ch] = inSumSq[ch] }
            for ch in 0..<outCh { outS[ch] = outSumSq[ch] }
            fr[0] = rmsFrames[0]; fr[1] = rmsFrames[1]
            if meterGen.load(ordering: .acquiring) == g1 { break }
        }
        let inN = max(fr[0] - prevFrames[0], 1)
        let outN = max(fr[1] - prevFrames[1], 1)
        var inDB = [Float](); inDB.reserveCapacity(inCh)
        for ch in 0..<inCh {
            let delta = max(inS[ch] - prevInSumSq[ch], 0)
            inDB.append(rmsToDBFS(Float((delta / Double(inN)).squareRoot())))
        }
        var outDB = [Float](); outDB.reserveCapacity(outCh)
        for ch in 0..<outCh {
            let delta = max(outS[ch] - prevOutSumSq[ch], 0)
            outDB.append(rmsToDBFS(Float((delta / Double(outN)).squareRoot())))
        }
        prevInSumSq = inS
        prevOutSumSq = outS
        prevFrames = fr
        return DuplexEngine.Meters(inputRMS: inDB, outputRMS: outDB)
    }

    private func nonInterleavedFloat(channels: Int, rate: Double) -> AudioStreamBasicDescription {
        let bytesPerSample = UInt32(MemoryLayout<Float>.size)
        return AudioStreamBasicDescription(
            mSampleRate: rate,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsNonInterleaved | kAudioFormatFlagsNativeEndian,
            mBytesPerPacket: bytesPerSample,
            mFramesPerPacket: 1,
            mBytesPerFrame: bytesPerSample,
            mChannelsPerFrame: UInt32(max(channels, 1)),
            mBitsPerChannel: bytesPerSample * 8,
            mReserved: 0)
    }

    private func check(_ status: OSStatus, _ ctx: String) throws {
        if status != noErr { throw CoreAudioError(status, ctx) }
    }
}

private func bridgeInputTrampoline(
    _ refCon: UnsafeMutableRawPointer,
    _ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
    _ ts: UnsafePointer<AudioTimeStamp>,
    _ bus: UInt32,
    _ frames: UInt32,
    _ ioData: UnsafeMutablePointer<AudioBufferList>?
) -> OSStatus {
    let engine = Unmanaged<BridgeAudioEngine>.fromOpaque(refCon).takeUnretainedValue()
    return engine.renderInput(flags, ts, frames)
}

private func bridgeOutputTrampoline(
    _ refCon: UnsafeMutableRawPointer,
    _ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
    _ ts: UnsafePointer<AudioTimeStamp>,
    _ bus: UInt32,
    _ frames: UInt32,
    _ ioData: UnsafeMutablePointer<AudioBufferList>?
) -> OSStatus {
    let engine = Unmanaged<BridgeAudioEngine>.fromOpaque(refCon).takeUnretainedValue()
    return engine.renderOutput(frames, ioData)
}
