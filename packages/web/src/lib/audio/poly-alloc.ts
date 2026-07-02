// packages/web/src/lib/audio/poly-alloc.ts
//
// STABLE per-voice allocator for the poly cable — Phase 2a of the gate/held-note
// model (.myrobots/plans/gate-heldnote-model-2026-07-01.md §3.2).
//
// THE PROBLEM it fixes. Live-keyboard / audition voices used to be packed
// POSITIONALLY into lanes 0..n-1 and REBUILT on every key edge (clipplayer
// serviceAudition pre-Phase-2a; midi-lane buildPolyLanes). Releasing a LOW note
// SHIFTED the remaining notes down a lane → rewrote pitch on a STILL-SOUNDING
// voice → glitch / retrigger.
//
// THE FIX. A note keeps its lane until IT is released:
//   - noteOn(key)  → assigns the LOWEST FREE lane and keeps it. A re-noteOn of an
//     already-owned key returns its existing lane (dedupe by key) and refreshes
//     its recency. When all `maxVoices` lanes are busy it LRU-STEALS the
//     least-recently-used voice (the one whose note-on is OLDEST), opening the
//     new note on that lane.
//   - noteOff(key) → frees ONLY that note's CURRENT lane and returns it; no other
//     lane moves. Returns `null` when the key owns no lane, i.e. it's UNKNOWN or
//     its ownership was already STOLEN — the caller then writes NOTHING.
//
// THE CRITICAL EDGE CASE — release-after-steal. If A owns lane 2, then an
// overflow steals lane 2 for F, then A's note-off arrives: `noteOff(A)` returns
// `null` (A no longer owns any lane), so the caller is a NO-OP on lane 2 (now
// F's). Naively "freeing lane 2" would kill the stealer F. Ownership is always
// resolved by note-IDENTITY → CURRENT owner, never by a stale lane number.
//
// KEYING. Phase 2a keys by MIDI note number, so two note-ons of the SAME pitch
// dedupe to one voice (a same-key re-noteOn is idempotent on the lane). The
// LinnStrument "dedupe by voice-id not pitch" lesson (so two touches of the same
// pitch can coexist with independent pressure) is a Phase-3 concern — the key
// type here is `number` so a caller CAN pass a synthetic voice id later without
// changing this module.
//
// PURE + engine-free (like poly.ts chord math / poly-osc-sum) → unit-tested with
// zero Web Audio. The wiring (clipplayer serviceAudition) reconciles this
// ownership map into minimal, clean 0/1 gate edges; this module never touches CV.

/** A note identity. Phase 2a passes the MIDI note number; a later phase may pass
 *  a synthetic per-touch voice id (both are `number`). */
export type NoteKey = number;

export interface VoiceAllocator {
  /** Assign `noteKey` a lane and return it. Lowest free lane; a re-noteOn of an
   *  already-owned key returns its existing lane (dedupe) and refreshes recency;
   *  on overflow past `maxVoices`, LRU-steals the least-recently-used lane. */
  noteOn(noteKey: NoteKey): number;
  /** Release `noteKey`. Returns the lane it OWNED (now free), or `null` when the
   *  key owns no lane (unknown, or already stolen → release-after-steal NO-OP).
   *  No other lane is ever touched. */
  noteOff(noteKey: NoteKey): number | null;
  /** The key currently owning `lane`, or `null` when the lane is free. */
  ownerOf(lane: number): NoteKey | null;
  /** The lane `noteKey` currently owns, or `null` when it owns none. */
  laneOf(noteKey: NoteKey): number | null;
  /** How many lanes are currently held (0..maxVoices). */
  activeCount(): number;
  /** Total lanes (== maxVoices). */
  readonly maxVoices: number;
  /** Free every lane. */
  reset(): void;
}

/**
 * Create a stable LRU voice allocator with `maxVoices` lanes (0..maxVoices-1).
 * `maxVoices` is clamped to ≥1.
 */
export function createVoiceAllocator(maxVoices: number): VoiceAllocator {
  const N = Math.max(1, Math.floor(maxVoices));
  // owner[lane] = the key holding that lane, or null when free.
  const owner: (NoteKey | null)[] = new Array<NoteKey | null>(N).fill(null);
  // lastUsed[lane] = the monotonic seq at which the lane's CURRENT note was
  // assigned / last refreshed (only meaningful when owner[lane] !== null). The
  // lane with the SMALLEST lastUsed among busy lanes is the LRU steal target.
  const lastUsed: number[] = new Array<number>(N).fill(0);
  // key → lane, kept in lockstep with owner[] for O(1) identity lookup.
  const keyToLane = new Map<NoteKey, number>();
  let seq = 0;

  function noteOn(noteKey: NoteKey): number {
    // Dedupe by identity: a re-noteOn of a held key keeps its lane (idempotent),
    // just refreshing recency so it's not the next steal victim.
    const existing = keyToLane.get(noteKey);
    if (existing !== undefined) {
      lastUsed[existing] = ++seq;
      return existing;
    }
    // Lowest FREE lane.
    for (let i = 0; i < N; i++) {
      if (owner[i] === null) {
        owner[i] = noteKey;
        lastUsed[i] = ++seq;
        keyToLane.set(noteKey, i);
        return i;
      }
    }
    // All busy → LRU-steal the oldest (smallest lastUsed).
    let steal = 0;
    for (let i = 1; i < N; i++) {
      if (lastUsed[i]! < lastUsed[steal]!) steal = i;
    }
    const evicted = owner[steal]!;
    keyToLane.delete(evicted);
    owner[steal] = noteKey;
    lastUsed[steal] = ++seq;
    keyToLane.set(noteKey, steal);
    return steal;
  }

  function noteOff(noteKey: NoteKey): number | null {
    const lane = keyToLane.get(noteKey);
    // Unknown key, OR the key's lane was already stolen (release-after-steal):
    // keyToLane no longer maps it → NO-OP. Never free a lane by a stale number.
    if (lane === undefined) return null;
    owner[lane] = null;
    keyToLane.delete(noteKey);
    return lane;
  }

  function ownerOf(lane: number): NoteKey | null {
    return owner[lane] ?? null;
  }

  function laneOf(noteKey: NoteKey): number | null {
    const lane = keyToLane.get(noteKey);
    return lane === undefined ? null : lane;
  }

  function activeCount(): number {
    return keyToLane.size;
  }

  function reset(): void {
    owner.fill(null);
    lastUsed.fill(0);
    keyToLane.clear();
    seq = 0;
  }

  return {
    noteOn,
    noteOff,
    ownerOf,
    laneOf,
    activeCount,
    maxVoices: N,
    reset,
  };
}
