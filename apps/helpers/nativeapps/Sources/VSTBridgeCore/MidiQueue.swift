// MidiQueue.swift
//
// Pending MIDI events, ordered by sampleTime — the seam between the socket
// (events arrive in batches, possibly ahead of the audio clock; the web app
// budgets a constant 25 ms MIDI lookahead precisely so jitter becomes fixed
// latency) and the render pump (each audio block consumes the events that
// fall inside its span). Pure value type; owned by the render queue.

import BridgeKit

public struct MidiQueue {
    /// Ring guard: a client that never sends audio blocks (so nothing is
    /// ever consumed) must not grow this without bound.
    public static let capacity = 4096

    private var events: [MidiEvent] = []
    public private(set) var droppedEvents = 0

    public init() {}

    public var count: Int { events.count }

    /// Insert keeping sampleTime order; ties keep arrival order (a note-off
    /// sent after a note-on at the same timestamp must stay after it).
    public mutating func add(_ newEvents: [MidiEvent]) {
        for ev in newEvents {
            if events.count >= Self.capacity {
                events.removeFirst()
                droppedEvents += 1
            }
            // Almost always append-at-end (senders are monotonic).
            if let last = events.last, last.sampleTime > ev.sampleTime {
                let idx = events.firstIndex { $0.sampleTime > ev.sampleTime }!
                events.insert(ev, at: idx)
            } else {
                events.append(ev)
            }
        }
    }

    /// Pop every event with sampleTime < `end` (exclusive), in order.
    /// Events already in the past come out too — the caller clamps their
    /// intra-block offset to 0 (late beats lost).
    public mutating func take(before end: UInt64) -> [MidiEvent] {
        let splitAt = events.firstIndex { $0.sampleTime >= end } ?? events.count
        guard splitAt > 0 else { return [] }
        let taken = Array(events[..<splitAt])
        events.removeFirst(splitAt)
        return taken
    }

    public mutating func removeAll() {
        events.removeAll()
    }
}
