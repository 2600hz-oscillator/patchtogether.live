// DuplexEngine.swift
//
// A single HAL Output AudioUnit (kAudioUnitSubType_HALOutput, aka AUHAL)
// configured for FULL DUPLEX against one device:
//   - element/bus 1 = INPUT (from device), enabled, with an input callback.
//   - element/bus 0 = OUTPUT (to device),  enabled, with a render callback.
// One AUHAL bound to one device runs both directions on the SAME I/O thread
// and the SAME hardware clock, so there is no cross-device drift to resample
// — this is the canonical low-latency single-interface duplex pattern
// (Apple TN2091). We force a NON-INTERLEAVED Float32 client format so each
// channel is its own buffer in the AudioBufferList, which makes per-pair /
// per-channel addressing a straight buffer copy.
//
// The real-time render path (renderInput) does NO allocation, NO locks, NO
// Swift ARC-heavy work: it AudioUnitRenders the input into a preallocated
// AudioBufferList, copies routed channels into a ring-free staging buffer,
// and the output callback copies staged channels out. RMS is accumulated
// into plain C arrays read by the meter thread.

import CoreAudio
import AudioToolbox
import AudioUnit
import Foundation

public final class DuplexEngine {
    public struct Config {
        public var device: AudioDeviceID
        public var inputChannels: Int
        public var outputChannels: Int
        public var sampleRate: Double
        public var bufferFrames: UInt32
        public var routes: [PairRoute]
        public init(device: AudioDeviceID, inputChannels: Int, outputChannels: Int,
                    sampleRate: Double, bufferFrames: UInt32, routes: [PairRoute]) {
            self.device = device
            self.inputChannels = inputChannels
            self.outputChannels = outputChannels
            self.sampleRate = sampleRate
            self.bufferFrames = bufferFrames
            self.routes = routes
        }
    }

    private var unit: AudioUnit?
    private let config: Config

    // Preallocated input render target (non-interleaved: one buffer/channel).
    private var inputABL: UnsafeMutableAudioBufferListPointer
    private var inputStorage: [UnsafeMutablePointer<Float>]

    // Staging: latest input frame block, per channel, copied out by output cb.
    private var stagedInput: [UnsafeMutablePointer<Float>]
    private var stagedFrameCount: Int = 0

    // Channel map: for each OUTPUT channel, which INPUT channel feeds it
    // (-1 = silence). Built from the pair routes.
    private let outToIn: [Int]

    // RMS accumulators (sum of squares + count) per channel, both directions.
    // Plain C buffers; written on RT thread, snapshotted by meter thread.
    private let inSumSq: UnsafeMutablePointer<Double>
    private let outSumSq: UnsafeMutablePointer<Double>
    private let rmsFrames: UnsafeMutablePointer<Int64>

    public init(_ config: Config) {
        self.config = config

        // Build output<-input channel map from pair routes.
        var map = [Int](repeating: -1, count: config.outputChannels)
        for r in config.routes {
            let oL = r.output.leftChannel, oR = r.output.rightChannel
            let iL = r.input.leftChannel, iR = r.input.rightChannel
            if oL < config.outputChannels && iL < config.inputChannels { map[oL] = iL }
            if oR < config.outputChannels && iR < config.inputChannels { map[oR] = iR }
        }
        self.outToIn = map

        // Preallocate the input AudioBufferList (one mono buffer per channel).
        let inCh = max(config.inputChannels, 1)
        let cap = Int(config.bufferFrames) * 2 + 16 // headroom; HAL may hand a larger block
        inputStorage = (0..<inCh).map { _ in
            UnsafeMutablePointer<Float>.allocate(capacity: cap)
        }
        for p in inputStorage { p.initialize(repeating: 0, count: cap) }
        let abl = AudioBufferList.allocate(maximumBuffers: inCh)
        for i in 0..<inCh {
            abl[i] = AudioBuffer(mNumberChannels: 1,
                                 mDataByteSize: UInt32(cap * MemoryLayout<Float>.size),
                                 mData: inputStorage[i])
        }
        inputABL = abl

        stagedInput = (0..<inCh).map { _ in
            let p = UnsafeMutablePointer<Float>.allocate(capacity: cap)
            p.initialize(repeating: 0, count: cap)
            return p
        }

        inSumSq = .allocate(capacity: inCh); inSumSq.initialize(repeating: 0, count: inCh)
        let outCh = max(config.outputChannels, 1)
        outSumSq = .allocate(capacity: outCh); outSumSq.initialize(repeating: 0, count: outCh)
        rmsFrames = .allocate(capacity: 2); rmsFrames.initialize(repeating: 0, count: 2)
    }

    deinit {
        if let u = unit { AudioOutputUnitStop(u); AudioUnitUninitialize(u); AudioComponentInstanceDispose(u) }
        inputStorage.forEach { $0.deallocate() }
        stagedInput.forEach { $0.deallocate() }
        free(inputABL.unsafeMutablePointer)
        inSumSq.deallocate(); outSumSq.deallocate(); rmsFrames.deallocate()
    }

    // MARK: - Setup

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

        // 1. Enable IO on both buses (input MUST be enabled before binding dev).
        var enable: UInt32 = 1
        try check(AudioUnitSetProperty(audioUnit, kAudioOutputUnitProperty_EnableIO,
            kAudioUnitScope_Input, 1, &enable, UInt32(MemoryLayout<UInt32>.size)),
            "EnableIO(input,bus1)")
        try check(AudioUnitSetProperty(audioUnit, kAudioOutputUnitProperty_EnableIO,
            kAudioUnitScope_Output, 0, &enable, UInt32(MemoryLayout<UInt32>.size)),
            "EnableIO(output,bus0)")

        // 2. Bind the device (applies to both directions on one AUHAL).
        var dev = config.device
        try check(AudioUnitSetProperty(audioUnit, kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global, 0, &dev, UInt32(MemoryLayout<AudioDeviceID>.size)),
            "SetCurrentDevice")

        // 3. Set buffer frame size on the DEVICE for low latency (clamped to range).
        var frames = config.bufferFrames
        var bfsAddr = addr(kAudioDevicePropertyBufferFrameSize)
        _ = AudioObjectSetPropertyData(config.device, &bfsAddr, 0, nil,
            UInt32(MemoryLayout<UInt32>.size), &frames)

        // 4. Non-interleaved Float32 client formats so each channel is its own
        //    buffer — output scope of input bus (what we receive), input scope
        //    of output bus (what we send).
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

        // 5. Callbacks. refCon = self (unretained — engine outlives the unit).
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        var inCB = AURenderCallbackStruct(inputProc: inputRenderTrampoline, inputProcRefCon: selfPtr)
        try check(AudioUnitSetProperty(audioUnit, kAudioOutputUnitProperty_SetInputCallback,
            kAudioUnitScope_Global, 0, &inCB, UInt32(MemoryLayout<AURenderCallbackStruct>.size)),
            "SetInputCallback")
        var outCB = AURenderCallbackStruct(inputProc: outputRenderTrampoline, inputProcRefCon: selfPtr)
        try check(AudioUnitSetProperty(audioUnit, kAudioUnitProperty_SetRenderCallback,
            kAudioUnitScope_Input, 0, &outCB, UInt32(MemoryLayout<AURenderCallbackStruct>.size)),
            "SetRenderCallback")

        try check(AudioUnitInitialize(audioUnit), "AudioUnitInitialize")
        try check(AudioOutputUnitStart(audioUnit), "AudioOutputUnitStart")
    }

    public func stop() {
        if let u = unit { AudioOutputUnitStop(u) }
    }

    // MARK: - RT render path (NO allocation / locks / ARC)

    fileprivate func renderInput(_ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
                                 _ ts: UnsafePointer<AudioTimeStamp>,
                                 _ frames: UInt32) -> OSStatus {
        guard let u = unit else { return noErr }
        // Reset byte sizes (AudioUnitRender wants them sized to this block).
        let bytes = UInt32(Int(frames) * MemoryLayout<Float>.size)
        for i in 0..<inputABL.count { inputABL[i].mDataByteSize = bytes }
        let st = AudioUnitRender(u, flags, ts, 1, frames, inputABL.unsafeMutablePointer)
        if st != noErr { return st }
        let n = Int(frames)
        // Stage input + accumulate input RMS.
        for ch in 0..<config.inputChannels {
            let src = inputABL[ch].mData!.assumingMemoryBound(to: Float.self)
            memcpy(stagedInput[ch], src, n * MemoryLayout<Float>.size)
            var ss = 0.0
            for f in 0..<n { let v = Double(src[f]); ss += v * v }
            inSumSq[ch] += ss
        }
        stagedFrameCount = n
        rmsFrames[0] += Int64(n)
        return noErr
    }

    fileprivate func renderOutput(_ frames: UInt32, _ ioData: UnsafeMutablePointer<AudioBufferList>?) -> OSStatus {
        guard let ioData = ioData else { return noErr }
        let abl = UnsafeMutableAudioBufferListPointer(ioData)
        let n = min(Int(frames), stagedFrameCount == 0 ? Int(frames) : stagedFrameCount)
        for outCh in 0..<min(abl.count, config.outputChannels) {
            let dst = abl[outCh].mData!.assumingMemoryBound(to: Float.self)
            let inCh = outToIn[outCh]
            if inCh >= 0 && inCh < config.inputChannels && stagedFrameCount > 0 {
                memcpy(dst, stagedInput[inCh], n * MemoryLayout<Float>.size)
                if n < Int(frames) { // zero any tail
                    memset(dst + n, 0, (Int(frames) - n) * MemoryLayout<Float>.size)
                }
            } else {
                memset(dst, 0, Int(frames) * MemoryLayout<Float>.size)
            }
            var ss = 0.0
            for f in 0..<Int(frames) { let v = Double(dst[f]); ss += v * v }
            outSumSq[outCh] += ss
        }
        rmsFrames[1] += Int64(frames)
        return noErr
    }

    // MARK: - Metering (called off the RT thread)

    public struct Meters {
        public let inputRMS: [Float]   // dBFS per input channel
        public let outputRMS: [Float]  // dBFS per output channel
    }

    /// Snapshot + RESET the RMS accumulators (windowed metering).
    public func sampleMeters() -> Meters {
        let inN = max(rmsFrames[0], 1)
        let outN = max(rmsFrames[1], 1)
        var inDB = [Float](); inDB.reserveCapacity(config.inputChannels)
        for ch in 0..<config.inputChannels {
            inDB.append(rmsToDBFS(Float((inSumSq[ch] / Double(inN)).squareRoot())))
            inSumSq[ch] = 0
        }
        var outDB = [Float](); outDB.reserveCapacity(config.outputChannels)
        for ch in 0..<config.outputChannels {
            outDB.append(rmsToDBFS(Float((outSumSq[ch] / Double(outN)).squareRoot())))
            outSumSq[ch] = 0
        }
        rmsFrames[0] = 0; rmsFrames[1] = 0
        return Meters(inputRMS: inDB, outputRMS: outDB)
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

// C-callable trampolines bridge to the instance methods. They run on the RT
// audio thread; keep them allocation-free.

private func inputRenderTrampoline(
    _ refCon: UnsafeMutableRawPointer,
    _ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
    _ ts: UnsafePointer<AudioTimeStamp>,
    _ bus: UInt32,
    _ frames: UInt32,
    _ ioData: UnsafeMutablePointer<AudioBufferList>?
) -> OSStatus {
    let engine = Unmanaged<DuplexEngine>.fromOpaque(refCon).takeUnretainedValue()
    return engine.renderInput(flags, ts, frames)
}

private func outputRenderTrampoline(
    _ refCon: UnsafeMutableRawPointer,
    _ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
    _ ts: UnsafePointer<AudioTimeStamp>,
    _ bus: UInt32,
    _ frames: UInt32,
    _ ioData: UnsafeMutablePointer<AudioBufferList>?
) -> OSStatus {
    let engine = Unmanaged<DuplexEngine>.fromOpaque(refCon).takeUnretainedValue()
    return engine.renderOutput(frames, ioData)
}
