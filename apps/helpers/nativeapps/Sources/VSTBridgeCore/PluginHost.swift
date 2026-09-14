// PluginHost.swift
//
// One mounted Audio Unit, wrapped for client-clocked pull-through render:
// the browser's audio blocks ARE the clock — each incoming block renders
// exactly that many frames through the plugin, synchronously, at the
// client's sample rate. No hardware device, no resampler, no drift.
//
// Threading contract: mount() completes on an arbitrary queue; after that,
// render()/state/reset are called ONLY from the service's serial render
// queue, and requestEditor() only from the main thread. Nothing here is on
// a real-time deadline — the render pump is a network peer, not an IOProc —
// so plain Swift allocations are fine; buffers are still preallocated to
// keep per-block work small.

import AudioToolbox
import AVFoundation
import BridgeKit
import CoreAudioKit
import Foundation

/// Where ALL plugin lifecycle runs — the instantiate CALL included, which
/// is the part that matters: for a v2 component, AUAudioUnit.instantiate
/// runs the plugin's constructor synchronously ON THE CALLING THREAD, and
/// Arturia constructors register a main-run-loop source that can then
/// fire CONCURRENTLY with the still-running constructor. That cross-thread
/// race is a segfault (crash thread dump 2026-08-19: renderQueue inside
/// the Acid V constructor while main faulted in its source0 handler at
/// NULL+0x20). auval survives because it opens components on the main
/// thread — the source can't preempt the thread it's queued behind. So:
/// in the app this queue is MAIN (the industry arrangement — JUCE's
/// message thread); tests swap in a private serial queue because XCTest's
/// main-queue pumping isn't guaranteed under `swift test` (fine for
/// Apple's race-free AUs). Render stays on the render queue.
public enum PluginLifecycle {
    public static var queue: DispatchQueue = .main
}

public enum PluginHostError: Error, CustomStringConvertible {
    case instantiateFailed(String)
    case noOutputBus
    case outputFormatRejected(String)
    case inputFormatRejected(String)
    case allocateFailed(String)
    public var description: String {
        switch self {
        case .instantiateFailed(let why): return "instantiation failed: \(why)"
        case .noOutputBus: return "plugin has no output bus"
        case .outputFormatRejected(let why): return "output format rejected: \(why)"
        case .inputFormatRejected(let why): return "input format rejected: \(why)"
        case .allocateFailed(let why): return "allocateRenderResources failed: \(why)"
        }
    }
}

public final class PluginHost: @unchecked Sendable {
    public let descriptor: PluginDescriptor
    public let rate: Double
    /// 0 (instrument/generator: clock blocks only), 1 (mono-only effect —
    /// the host downmixes the client's stereo), or 2.
    public let audioInputChannels: Int
    public let audioOutputChannels = 2
    public let acceptsMidi: Bool

    let audioUnit: AUAudioUnit
    private let renderBlock: AURenderBlock
    private let scheduleMIDI: AUScheduleMIDIEventBlock?
    private let maxFrames: Int

    // Preallocated staging. Input planes feed the pull-input block; output
    // pointers restore the output ABL each render (a plugin may swap
    // mData to its internal buffers — allowed by the AU contract).
    private let inputBuffer: AVAudioPCMBuffer?
    private let outputBuffer: AVAudioPCMBuffer
    private let outputPointers: [UnsafeMutablePointer<Float>]

    /// Valid after allocateRenderResources.
    public var latencySamples: Int { Int((audioUnit.latency * rate).rounded()) }
    public var tailSeconds: Double { audioUnit.tailTime }

    public var mountedMessage: MountedMessage {
        MountedMessage(plugin: descriptor.info,
                       latencySamples: latencySamples,
                       tailSeconds: tailSeconds,
                       audioInputChannels: audioInputChannels,
                       audioOutputChannels: audioOutputChannels,
                       acceptsMidi: acceptsMidi)
    }

    // MARK: - Mount

    public static func mount(descriptor: PluginDescriptor, rate: Double,
                             maxFrames: Int = BridgeWire.maxFrameCount,
                             completion: @escaping (Result<PluginHost, Error>) -> Void) {
        // v3 extensions get out-of-process hosting (a crashing plugin kills
        // its extension process, not the bridge). v2 components only load
        // in-process — the Bitwig-style per-plugin child process for v2 is
        // future work, documented in docs/vst-bridge-design.md.
        let options: AudioComponentInstantiationOptions =
            descriptor.isV3 ? [.loadOutOfProcess] : []
        // BOTH the instantiate call and the configure run on the lifecycle
        // thread (main in the app) — see PluginLifecycle: the v2 open runs
        // the plugin constructor synchronously on the calling thread, and
        // it must be the thread whose run loop the plugin posts to.
        PluginLifecycle.queue.async {
            AUAudioUnit.instantiate(with: descriptor.componentDescription,
                                    options: options) { audioUnit, error in
                PluginLifecycle.queue.async {
                    guard let audioUnit else {
                        completion(.failure(PluginHostError.instantiateFailed(
                            error.map { "\($0)" } ?? "unknown error")))
                        return
                    }
                    do {
                        let host = try PluginHost(audioUnit: audioUnit,
                                                  descriptor: descriptor,
                                                  rate: rate, maxFrames: maxFrames)
                        completion(.success(host))
                    } catch {
                        completion(.failure(error))
                    }
                }
            }
        }
    }

    private init(audioUnit: AUAudioUnit, descriptor: PluginDescriptor,
                 rate: Double, maxFrames: Int) throws {
        self.descriptor = descriptor
        self.rate = rate
        self.maxFrames = maxFrames
        self.audioUnit = audioUnit

        audioUnit.maximumFramesToRender = AUAudioFrameCount(maxFrames)

        guard let stereo = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 2),
              audioUnit.outputBusses.count > 0 else {
            throw PluginHostError.noOutputBus
        }
        do {
            try audioUnit.outputBusses[0].setFormat(stereo)
        } catch {
            throw PluginHostError.outputFormatRejected("\(error)")
        }

        // Effects (and music effects) take audio in; try stereo, fall back
        // to mono (downmix at the staging step). Instruments/generators
        // render from MIDI/nothing and are pulled by clock blocks.
        let wantsInput = descriptor.info.kind == .effect || descriptor.info.kind == .musicEffect
        var inputChannels = 0
        var inputFormat: AVAudioFormat? = nil
        if wantsInput, audioUnit.inputBusses.count > 0 {
            if (try? audioUnit.inputBusses[0].setFormat(stereo)) != nil {
                inputChannels = 2
                inputFormat = stereo
            } else if let mono = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1),
                      (try? audioUnit.inputBusses[0].setFormat(mono)) != nil {
                inputChannels = 1
                inputFormat = mono
            } else {
                throw PluginHostError.inputFormatRejected(
                    "neither stereo nor mono accepted at \(Int(rate)) Hz")
            }
            // Input busses default to DISABLED; without this the render
            // block answers kAudioUnitErr_NoConnection (-10876) instead of
            // pulling our input block. Must happen before allocate.
            audioUnit.inputBusses[0].isEnabled = true
        }
        self.audioInputChannels = inputChannels
        self.acceptsMidi = descriptor.info.kind == .instrument
            || descriptor.info.kind == .musicEffect

        do {
            try audioUnit.allocateRenderResources()
        } catch {
            throw PluginHostError.allocateFailed("\(error)")
        }

        self.renderBlock = audioUnit.renderBlock
        self.scheduleMIDI = audioUnit.scheduleMIDIEventBlock

        self.inputBuffer = inputFormat.flatMap {
            AVAudioPCMBuffer(pcmFormat: $0, frameCapacity: AVAudioFrameCount(maxFrames))
        }
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: stereo,
                                            frameCapacity: AVAudioFrameCount(maxFrames)),
              let outPtrs = outBuf.floatChannelData else {
            throw PluginHostError.allocateFailed("output staging allocation failed")
        }
        self.outputBuffer = outBuf
        self.outputPointers = (0..<2).map { outPtrs[$0] }
    }

    // MARK: - Render (render queue only)

    /// One event ready for the plugin: intra-block frame offset + raw bytes.
    public struct ScheduledMidi {
        public var offsetFrames: Int
        public var bytes: [UInt8]
        public init(offsetFrames: Int, bytes: [UInt8]) {
            self.offsetFrames = offsetFrames
            self.bytes = bytes
        }
    }

    /// The AU's render block said no.
    public struct RenderFailure: Error {
        public let status: OSStatus
    }

    /// Render `frames` frames. `inputPlanes` are the client's planes for
    /// channels 0/1 (missing/short planes read as silence); ignored when the
    /// plugin takes no audio input. Returns stereo output planes, or the
    /// error status.
    public func render(inputPlanes: [[Float]], frames: Int, sampleTime: UInt64,
                       midi: [ScheduledMidi]) -> Result<[[Float]], RenderFailure> {
        let frames = min(frames, maxFrames)

        // Stage input for the pull block.
        if let inputBuffer, audioInputChannels > 0, let planes = inputBuffer.floatChannelData {
            let left: [Float] = inputPlanes.count > 0 ? inputPlanes[0] : []
            let right: [Float] = inputPlanes.count > 1 ? inputPlanes[1] : left
            if audioInputChannels == 1 {
                for i in 0..<frames {
                    let l = i < left.count ? left[i] : 0
                    let r = i < right.count ? right[i] : l
                    planes[0][i] = (l + r) * 0.5
                }
            } else {
                for i in 0..<frames { planes[0][i] = i < left.count ? left[i] : 0 }
                for i in 0..<frames { planes[1][i] = i < right.count ? right[i] : 0 }
            }
        }

        // Sample-accurate MIDI: schedule against the current render cycle
        // using the immediate-plus-offset convention, right before pulling
        // the block on the same thread.
        if let scheduleMIDI {
            for ev in midi where (1...3).contains(ev.bytes.count) {
                let offset = AUEventSampleTime(min(max(ev.offsetFrames, 0), frames - 1))
                ev.bytes.withUnsafeBufferPointer { p in
                    scheduleMIDI(AUEventSampleTimeImmediate + offset, 0,
                                 p.count, p.baseAddress!)
                }
            }
        }

        // Size the output ABL through frameLength FIRST — accessing
        // mutableAudioBufferList re-syncs each mDataByteSize from
        // frameLength, so manual byte sizes set before an access get wiped
        // (that was a real -50). Then restore mData to our staging on the
        // captured pointer (a previous render may have pointed the ABL at
        // plugin-internal memory) and hand that exact pointer to render.
        outputBuffer.frameLength = AVAudioFrameCount(frames)
        let byteSize = UInt32(frames * MemoryLayout<Float>.size)
        let ablPointer = outputBuffer.mutableAudioBufferList
        let outABL = UnsafeMutableAudioBufferListPointer(ablPointer)
        for i in 0..<outABL.count {
            outABL[i].mData = UnsafeMutableRawPointer(outputPointers[i])
            outABL[i].mDataByteSize = byteSize
        }

        let pullInput: AURenderPullInputBlock? = (audioInputChannels == 0) ? nil
            : { [inputBuffer] _, _, frameCount, _, ablPointer in
                guard let inputBuffer,
                      let src = inputBuffer.floatChannelData else { return kAudioUnitErr_NoConnection }
                let abl = UnsafeMutableAudioBufferListPointer(ablPointer)
                let bytes = Int(frameCount) * MemoryLayout<Float>.size
                for i in 0..<abl.count {
                    let plane = src[min(i, Int(inputBuffer.format.channelCount) - 1)]
                    if let dst = abl[i].mData {
                        memcpy(dst, plane, bytes)
                    } else {
                        abl[i].mData = UnsafeMutableRawPointer(plane)
                    }
                    abl[i].mDataByteSize = UInt32(bytes)
                }
                return noErr
            }

        var flags = AudioUnitRenderActionFlags()
        var timestamp = AudioTimeStamp()
        timestamp.mSampleTime = Double(sampleTime)
        timestamp.mHostTime = mach_absolute_time()
        timestamp.mFlags = [.sampleTimeValid, .hostTimeValid]

        let status = renderBlock(&flags, &timestamp, AUAudioFrameCount(frames),
                                 0, ablPointer, pullInput)
        guard status == noErr else { return .failure(RenderFailure(status: status)) }

        // Copy out from wherever the ABL now points.
        var out: [[Float]] = []
        out.reserveCapacity(2)
        for i in 0..<2 {
            let buf = outABL[min(i, outABL.count - 1)]
            if let data = buf.mData {
                let p = data.assumingMemoryBound(to: Float.self)
                out.append([Float](UnsafeBufferPointer(start: p, count: frames)))
            } else {
                out.append([Float](repeating: 0, count: frames))
            }
        }
        return .success(out)
    }

    // MARK: - State (render queue only)

    public func stateBase64() -> String? {
        guard let dict = audioUnit.fullState else { return nil }
        guard let data = try? PropertyListSerialization.data(
            fromPropertyList: dict, format: .binary, options: 0) else { return nil }
        return data.base64EncodedString()
    }

    public func setState(base64: String) -> Bool {
        guard let data = Data(base64Encoded: base64),
              let plist = try? PropertyListSerialization.propertyList(
                from: data, options: [], format: nil),
              let dict = plist as? [String: Any] else { return false }
        audioUnit.fullState = dict
        return true
    }

    // MARK: - Panic / teardown (render queue only)

    /// Kill sounding notes: reset() drops voices and tails directly; the
    /// all-notes-off CCs cover plugins that keep state across reset.
    public func allNotesOff() {
        if let scheduleMIDI {
            for channel: UInt8 in 0..<16 {
                for controller: UInt8 in [120, 123] {   // all sound off, all notes off
                    let bytes: [UInt8] = [0xB0 | channel, controller, 0]
                    bytes.withUnsafeBufferPointer { p in
                        scheduleMIDI(AUEventSampleTimeImmediate, 0, p.count, p.baseAddress!)
                    }
                }
            }
        }
        audioUnit.reset()
    }

    /// True once teardown ran — late editor callbacks must not touch the
    /// (possibly disposed) audio unit.
    public private(set) var tornDown = false

    /// Call on PluginLifecycle.queue (the service's retire() does).
    public func teardown() {
        tornDown = true
        audioUnit.deallocateRenderResources()
    }

    // MARK: - Editor (main thread only)

    /// The plugin's own view controller, or the generic parameter view when
    /// it has none. Completion on the main thread; `custom` says which.
    ///
    /// v2 components get the classic `kAudioUnitProperty_CocoaUI` path
    /// directly: the v2 bridge's requestViewController never calls back for
    /// some third-party plugins (Arturia, observed 2026-08-19), which read
    /// as a dead "open editor" button.
    public func requestEditor(_ completion: @escaping (NSViewController, _ custom: Bool) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !tornDown else { return }

        if !descriptor.isV3, let unit = (audioUnit as? AUAudioUnitV2Bridge)?.audioUnit {
            if let view = Self.cocoaUIView(for: unit) {
                let controller = NSViewController()
                controller.view = view
                completion(controller, true)
            } else {
                let generic = AUGenericView(audioUnit: unit)
                generic.showsExpertParameters = true
                let controller = NSViewController()
                controller.view = generic
                completion(controller, false)
            }
            return
        }

        audioUnit.requestViewController { [weak self] viewController in
            let finish = {
                guard let self, !self.tornDown else { return }
                if let viewController {
                    completion(viewController, true)
                } else {
                    let generic = AUGenericViewController()
                    generic.auAudioUnit = self.audioUnit
                    completion(generic, false)
                }
            }
            if Thread.isMainThread { finish() } else { DispatchQueue.main.async(execute: finish) }
        }
    }

    /// Load a v2 plugin's own Cocoa UI: query kAudioUnitProperty_CocoaUI,
    /// load the view-factory bundle, ask it for the view.
    private static func cocoaUIView(for unit: AudioUnit) -> NSView? {
        var dataSize: UInt32 = 0
        var writable: DarwinBoolean = false
        guard AudioUnitGetPropertyInfo(unit, kAudioUnitProperty_CocoaUI,
                                       kAudioUnitScope_Global, 0, &dataSize, &writable) == noErr,
              dataSize >= UInt32(MemoryLayout<AudioUnitCocoaViewInfo>.size) else { return nil }
        // AudioUnitCocoaViewInfo has no Swift initializer (Unmanaged
        // fields) — fill raw memory instead.
        let infoPointer = UnsafeMutablePointer<AudioUnitCocoaViewInfo>.allocate(capacity: 1)
        defer { infoPointer.deallocate() }
        var size = UInt32(MemoryLayout<AudioUnitCocoaViewInfo>.size)
        guard AudioUnitGetProperty(unit, kAudioUnitProperty_CocoaUI,
                                   kAudioUnitScope_Global, 0, infoPointer, &size) == noErr else { return nil }
        let info = infoPointer.pointee
        let bundleURL = info.mCocoaAUViewBundleLocation.takeRetainedValue() as URL
        let className = info.mCocoaAUViewClass.takeRetainedValue() as String
        guard let bundle = Bundle(url: bundleURL),
              let factoryClass = bundle.classNamed(className) as? NSObject.Type else { return nil }
        // The AUCocoaUIBase protocol isn't exposed to Swift; call
        // uiViewForAudioUnit:withSize: through its IMP.
        let factory = factoryClass.init()
        let selector = NSSelectorFromString("uiViewForAudioUnit:withSize:")
        guard factory.responds(to: selector) else { return nil }
        typealias UIViewForAudioUnit = @convention(c) (AnyObject, Selector, AudioUnit, NSSize) -> NSView?
        let call = unsafeBitCast(factory.method(for: selector), to: UIViewForAudioUnit.self)
        return call(factory, selector, unit, NSSize(width: 900, height: 620))
    }
}
