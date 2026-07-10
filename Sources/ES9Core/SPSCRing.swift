// SPSCRing.swift
//
// A lock-free single-producer / single-consumer ring buffer of multichannel
// Float32 frames, used to move audio between the real-time CoreAudio callbacks
// and the (non-RT) network drain thread:
//
//   hardware input  : RT input callback  (producer)  ->  drain thread (consumer)
//   hardware output : drain thread       (producer)  ->  RT output callback (consumer)
//
// Storage is PLANAR — one contiguous plane of `capacity` frames per channel —
// so both sides move data with at most two memcpys per channel (wraparound
// split). Indices are monotonically increasing UInt64 frame counters; the
// producer only writes `head`, the consumer only writes `tail` (classic SPSC),
// with acquire/release atomics from the Synchronization framework. No locks,
// no allocation after init — safe to call from the CoreAudio RT thread.

import Foundation
import Synchronization

public final class SPSCRing: @unchecked Sendable {
    public let channels: Int
    public let capacity: Int          // frames per channel, power of two
    private let mask: UInt64

    private let storage: UnsafeMutablePointer<Float>   // channels * capacity
    private let head = Atomic<UInt64>(0)               // total frames written
    private let tail = Atomic<UInt64>(0)               // total frames read

    public init(channels: Int, capacityFrames: Int) {
        precondition(channels > 0)
        // Round capacity up to a power of two so index math is a mask.
        var cap = 1
        while cap < max(capacityFrames, 2) { cap <<= 1 }
        self.channels = channels
        self.capacity = cap
        self.mask = UInt64(cap - 1)
        self.storage = .allocate(capacity: channels * cap)
        self.storage.initialize(repeating: 0, count: channels * cap)
    }

    deinit { storage.deallocate() }

    /// Frames currently readable.
    public var occupancy: Int {
        let h = head.load(ordering: .acquiring)
        let t = tail.load(ordering: .acquiring)
        return Int(h &- t)
    }

    /// Frames currently writable without overwriting unread data.
    public var freeSpace: Int { capacity - occupancy }

    @inline(__always)
    private func plane(_ ch: Int) -> UnsafeMutablePointer<Float> {
        storage + ch * capacity
    }

    /// Producer side. Copies up to `frames` frames from `planes` (one pointer
    /// per channel, at least `channels` entries) into the ring. Returns the
    /// number of frames actually written (short on overflow — the caller
    /// decides whether dropped frames matter). RT-safe.
    @discardableResult
    public func write(planes: UnsafePointer<UnsafeMutablePointer<Float>>, frames: Int) -> Int {
        let h = head.load(ordering: .relaxed)          // we are the only writer
        let t = tail.load(ordering: .acquiring)
        let free = capacity - Int(h &- t)
        let n = min(frames, free)
        if n <= 0 { return 0 }

        let start = Int(h & mask)
        let first = min(n, capacity - start)           // frames before wrap
        let second = n - first
        for c in 0..<channels {
            let p = plane(c)
            memcpy(p + start, planes[c], first * MemoryLayout<Float>.size)
            if second > 0 {
                memcpy(p, planes[c] + first, second * MemoryLayout<Float>.size)
            }
        }
        head.store(h &+ UInt64(n), ordering: .releasing)
        return n
    }

    /// Consumer side. Copies up to `frames` frames into `planes`. Returns the
    /// number of frames actually read (short on underrun — caller fills the
    /// tail per its policy: silence for audio, hold-last for CV). RT-safe.
    @discardableResult
    public func read(into planes: UnsafePointer<UnsafeMutablePointer<Float>>, frames: Int) -> Int {
        let t = tail.load(ordering: .relaxed)          // we are the only reader
        let h = head.load(ordering: .acquiring)
        let avail = Int(h &- t)
        let n = min(frames, avail)
        if n <= 0 { return 0 }

        let start = Int(t & mask)
        let first = min(n, capacity - start)
        let second = n - first
        for c in 0..<channels {
            let p = plane(c)
            memcpy(planes[c], p + start, first * MemoryLayout<Float>.size)
            if second > 0 {
                memcpy(planes[c] + first, p, second * MemoryLayout<Float>.size)
            }
        }
        tail.store(t &+ UInt64(n), ordering: .releasing)
        return n
    }

    /// Consumer side: throw away up to `frames` frames (used to re-center a
    /// jitter buffer that has grown past its target depth). Returns frames
    /// actually discarded. RT-safe.
    @discardableResult
    public func skip(frames: Int) -> Int {
        let t = tail.load(ordering: .relaxed)
        let h = head.load(ordering: .acquiring)
        let n = min(frames, Int(h &- t))
        if n <= 0 { return 0 }
        tail.store(t &+ UInt64(n), ordering: .releasing)
        return n
    }
}
