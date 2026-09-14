// StreamResampler.swift
//
// A streaming linear-interpolation resampler for multichannel planar Float32,
// used on the NON-real-time drain thread to convert between the client's
// AudioContext rate and the ES-9's hardware rate — and, more importantly, to
// absorb CLOCK DRIFT. Two independent clocks (ES-9 crystal vs the browser's
// output-device clock) always drift; the bridge trims the effective ratio a
// few hundred ppm around nominal (driven by jitter-buffer occupancy) so the
// buffer neither drains nor grows without bound.
//
// Linear interpolation is deliberate for v1: it is exact for the DC/CV case
// (a held voltage stays bit-identical), artifact-free for LFO-rate signals,
// and acceptable for audio-rate material; a windowed-sinc upgrade can slot in
// behind the same interface later. All channels share one phase so channels
// stay sample-aligned.

import Foundation

public final class StreamResampler {
    public let channels: Int
    /// Nominal conversion step in source samples per output sample.
    public private(set) var nominalStep: Double
    /// Multiplicative trim around nominal (1.0 = no trim). Clamped to ±0.02
    /// (20 000 ppm) — far beyond any real crystal drift; the clamp only guards
    /// against a runaway controller.
    public private(set) var rateTrim: Double = 1.0

    // Phase into the virtual stream [prev, block[0], ..., block[n-1]];
    // valid interpolation positions are [0, frames).
    private var pos: Double = 0
    private var prev: [Float]

    public init(channels: Int, sourceRate: Double, targetRate: Double) {
        precondition(channels > 0 && sourceRate > 0 && targetRate > 0)
        self.channels = channels
        self.nominalStep = sourceRate / targetRate
        self.prev = [Float](repeating: 0, count: channels)
    }

    public func setRates(sourceRate: Double, targetRate: Double) {
        precondition(sourceRate > 0 && targetRate > 0)
        nominalStep = sourceRate / targetRate
    }

    public func setRateTrim(_ trim: Double) {
        rateTrim = min(max(trim, 0.98), 1.02)
    }

    private var step: Double { nominalStep * rateTrim }

    /// Upper bound on output frames `process` can produce for `frames` input.
    public func maxOutputFrames(forInput frames: Int) -> Int {
        Int(Double(frames) / step) + 2
    }

    /// Consume `frames` source frames from `input` planes, produce resampled
    /// frames into `output` planes (each with room for `outputCapacity`).
    /// Returns frames produced. Both pointer arrays must have >= `channels`
    /// entries. Never produces more than `outputCapacity` (drops the
    /// remainder and reports via the return value + `droppedLastCall`).
    @discardableResult
    public func process(input: UnsafePointer<UnsafeMutablePointer<Float>>,
                        frames: Int,
                        output: UnsafePointer<UnsafeMutablePointer<Float>>,
                        outputCapacity: Int) -> Int {
        droppedLastCall = false
        guard frames > 0 else { return 0 }
        let s = step
        var produced = 0
        var p = pos
        while p < Double(frames) {
            if produced >= outputCapacity { droppedLastCall = true; break }
            let i = Int(p.rounded(.down))       // -0.x never occurs; p >= 0
            let frac = Float(p - Double(i))
            for c in 0..<channels {
                let a: Float = i == 0 ? prev[c] : input[c][i - 1]
                let b: Float = input[c][i]      // i < frames always holds here
                output[c][produced] = a + frac * (b - a)
            }
            produced += 1
            p += s
        }
        // Advance the virtual stream: next block's virt[0] is this block's
        // last sample. If the loop stopped early on outputCapacity, p may
        // still be inside this block — the un-emitted span is dropped
        // (droppedLastCall), so clamp instead of going negative, which would
        // index out of bounds on the next call.
        pos = max(p - Double(frames), 0)
        for c in 0..<channels { prev[c] = input[c][frames - 1] }
        return produced
    }

    /// True if the previous `process` call hit `outputCapacity` and had to
    /// drop output frames.
    public private(set) var droppedLastCall = false

    /// Reset phase and history (e.g. after a stream restart).
    public func reset() {
        pos = 0
        for c in 0..<channels { prev[c] = 0 }
    }
}

/// A little proportional-integral controller that turns jitter-buffer
/// occupancy error into a resampler rate trim. Tuned gently: it should chase
/// crystal drift (tens of ppm) without audibly warbling pitch.
public struct BufferFillController {
    public var targetFrames: Double
    /// Proportional gain in trim per frame of error.
    public var kP: Double
    /// Integral gain per update.
    public var kI: Double
    private var integral: Double = 0

    public init(targetFrames: Double, kP: Double = 2e-7, kI: Double = 5e-9) {
        self.targetFrames = targetFrames
        self.kP = kP
        self.kI = kI
    }

    /// Feed the current occupancy, get the trim to apply (≈1.0). A buffer
    /// running BELOW target must slow consumption... no: the producer-side
    /// resampler must produce MORE frames per input block, i.e. trim < 1
    /// lowers `step`, producing more output per source frame, refilling the
    /// buffer. Positive error (occupancy above target) => trim > 1.
    public mutating func update(occupancy: Int) -> Double {
        let error = Double(occupancy) - targetFrames
        integral += error
        // Anti-windup: bound the integral's contribution to ±1000 ppm.
        let iMax = 1e-3 / max(kI, .leastNormalMagnitude)
        integral = min(max(integral, -iMax), iMax)
        return 1.0 + kP * error + kI * integral
    }

    public mutating func reset() { integral = 0 }
}
