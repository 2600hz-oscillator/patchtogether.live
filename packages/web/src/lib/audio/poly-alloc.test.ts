// packages/web/src/lib/audio/poly-alloc.test.ts
//
// Unit tests for the STABLE per-voice allocator (Phase 2a of the gate/held-note
// plan §3.2). Pure — no Web Audio, no engine. Pins the contract the clipplayer
// audition wiring relies on: stable lane retention, lowest-free reuse, LRU-steal
// at cap, the release-after-steal NO-OP (the adversarial-review edge case), and
// unknown-key release.

import { describe, it, expect } from 'vitest';
import { createVoiceAllocator } from './poly-alloc';
import { POLY_CHANNEL_PAIRS } from './poly';

describe('poly-alloc: lowest-free assignment', () => {
  it('assigns lanes 0,1,2 in order for three distinct notes', () => {
    const a = createVoiceAllocator(POLY_CHANNEL_PAIRS);
    expect(a.noteOn(60)).toBe(0);
    expect(a.noteOn(64)).toBe(1);
    expect(a.noteOn(67)).toBe(2);
    expect(a.activeCount()).toBe(3);
    expect(a.ownerOf(0)).toBe(60);
    expect(a.ownerOf(1)).toBe(64);
    expect(a.ownerOf(2)).toBe(67);
  });

  it('a re-noteOn of a held key returns its SAME lane (dedupe by key)', () => {
    const a = createVoiceAllocator(5);
    expect(a.noteOn(60)).toBe(0);
    expect(a.noteOn(64)).toBe(1);
    // same pitch again → same lane, no new voice, count unchanged.
    expect(a.noteOn(60)).toBe(0);
    expect(a.activeCount()).toBe(2);
  });

  it('reuses the LOWEST freed lane, not the next unused one', () => {
    const a = createVoiceAllocator(5);
    a.noteOn(60); // lane 0
    a.noteOn(64); // lane 1
    a.noteOn(67); // lane 2
    // free lane 1 (the middle).
    expect(a.noteOff(64)).toBe(1);
    // a new note takes the LOWEST free lane = 1 (reuse), not 3.
    expect(a.noteOn(72)).toBe(1);
    expect(a.ownerOf(0)).toBe(60);
    expect(a.ownerOf(1)).toBe(72);
    expect(a.ownerOf(2)).toBe(67);
  });
});

describe('poly-alloc: STABLE lane retention (the core fix)', () => {
  it('releasing a LOW note leaves the other notes on their OWN lanes (no shift)', () => {
    const a = createVoiceAllocator(5);
    a.noteOn(60); // lane 0 (low)
    a.noteOn(64); // lane 1
    a.noteOn(67); // lane 2 (high)
    // release the LOW note.
    expect(a.noteOff(60)).toBe(0);
    // the higher notes DID NOT MOVE — this is the positional-repack glitch fix.
    expect(a.ownerOf(1)).toBe(64);
    expect(a.ownerOf(2)).toBe(67);
    expect(a.laneOf(64)).toBe(1);
    expect(a.laneOf(67)).toBe(2);
    expect(a.ownerOf(0)).toBeNull(); // only the released lane freed
  });

  it('a note keeps its lane across unrelated on/off churn', () => {
    const a = createVoiceAllocator(5);
    a.noteOn(50); // lane 0 — the "sustained pad"
    for (let k = 0; k < 20; k++) {
      const m = 70 + k;
      const lane = a.noteOn(m); // lane 1
      expect(lane).toBe(1);
      expect(a.laneOf(50)).toBe(0); // pad never moves
      a.noteOff(m);
    }
    expect(a.ownerOf(0)).toBe(50);
  });
});

describe('poly-alloc: LRU-steal at cap', () => {
  it('when all lanes are busy, the OLDEST note is stolen', () => {
    const a = createVoiceAllocator(3);
    a.noteOn(1); // lane 0 (oldest)
    a.noteOn(2); // lane 1
    a.noteOn(3); // lane 2 (newest)
    expect(a.activeCount()).toBe(3);
    // overflow: steal the LRU (lane 0, note 1).
    expect(a.noteOn(4)).toBe(0);
    expect(a.ownerOf(0)).toBe(4);
    expect(a.laneOf(1)).toBeNull(); // note 1 was evicted
    expect(a.activeCount()).toBe(3); // still full, not 4
    // next overflow steals the now-oldest surviving note (2, lane 1).
    expect(a.noteOn(5)).toBe(1);
    expect(a.ownerOf(1)).toBe(5);
    expect(a.laneOf(2)).toBeNull();
  });

  it('a re-noteOn refreshes recency so a held key is not the next steal victim', () => {
    const a = createVoiceAllocator(3);
    a.noteOn(1); // lane 0 (oldest)
    a.noteOn(2); // lane 1
    a.noteOn(3); // lane 2
    // touch note 1 again → it becomes the MOST recent, so note 2 is now oldest.
    a.noteOn(1);
    expect(a.noteOn(9)).toBe(1); // steals note 2 (lane 1), not note 1
    expect(a.ownerOf(0)).toBe(1); // note 1 survived
    expect(a.ownerOf(1)).toBe(9);
  });
});

describe('poly-alloc: release-after-steal is a NO-OP (adversarial edge case)', () => {
  it('A owns lane 2 → F steals lane 2 → A note-off is a no-op (does NOT kill F)', () => {
    // Fill so the next note must steal. maxVoices=3: A,B,C busy.
    const a = createVoiceAllocator(3);
    const A = 60,
      B = 62,
      C = 64,
      F = 72;
    a.noteOn(A); // lane 0 (oldest → the steal target)
    a.noteOn(B); // lane 1
    a.noteOn(C); // lane 2
    expect(a.laneOf(A)).toBe(0);
    // F overflows and STEALS A's lane (lane 0, the LRU).
    expect(a.noteOn(F)).toBe(0);
    expect(a.ownerOf(0)).toBe(F);
    expect(a.laneOf(A)).toBeNull(); // A's ownership invalidated by the steal
    // NOW A's stale note-off arrives — must be a NO-OP resolved by identity.
    expect(a.noteOff(A)).toBeNull(); // <-- caller writes NOTHING
    // F (the stealer) is UNTOUCHED — the naive "free A's old lane 2/0" bug.
    expect(a.ownerOf(0)).toBe(F);
    expect(a.laneOf(F)).toBe(0);
    expect(a.activeCount()).toBe(3); // B, C, F all still sounding
  });

  it('exact plan scenario: A on lane 2, F steals lane 2, A off is a no-op on F', () => {
    // Build so lane 2 specifically is A's and is the LRU when F arrives.
    const a = createVoiceAllocator(3);
    const X = 40,
      Y = 41,
      A = 42,
      F = 99;
    a.noteOn(X); // lane 0
    a.noteOn(Y); // lane 1
    a.noteOn(A); // lane 2
    // free lanes 0 and 1, then re-add newer notes so lane 2 (A) is the oldest.
    a.noteOff(X);
    a.noteOff(Y);
    a.noteOn(50); // lane 0 (newer than A)
    a.noteOn(51); // lane 1 (newer than A)
    expect(a.laneOf(A)).toBe(2);
    // full again; F steals the LRU = A on lane 2.
    expect(a.noteOn(F)).toBe(2);
    expect(a.ownerOf(2)).toBe(F);
    // A's release resolves to CURRENT owner (none) → no-op, F survives on lane 2.
    expect(a.noteOff(A)).toBeNull();
    expect(a.ownerOf(2)).toBe(F);
  });
});

describe('poly-alloc: unknown / double release', () => {
  it('note-off of a never-pressed key returns null', () => {
    const a = createVoiceAllocator(5);
    a.noteOn(60);
    expect(a.noteOff(999)).toBeNull();
    expect(a.ownerOf(0)).toBe(60); // untouched
  });

  it('a double note-off returns the lane once, then null', () => {
    const a = createVoiceAllocator(5);
    a.noteOn(60); // lane 0
    expect(a.noteOff(60)).toBe(0);
    expect(a.noteOff(60)).toBeNull(); // second release is a no-op
    expect(a.activeCount()).toBe(0);
  });
});

describe('poly-alloc: misc contract', () => {
  it('maxVoices is clamped to >= 1 and exposed', () => {
    expect(createVoiceAllocator(5).maxVoices).toBe(5);
    expect(createVoiceAllocator(0).maxVoices).toBe(1);
    expect(createVoiceAllocator(-3).maxVoices).toBe(1);
  });

  it('reset frees every lane', () => {
    const a = createVoiceAllocator(3);
    a.noteOn(1);
    a.noteOn(2);
    expect(a.activeCount()).toBe(2);
    a.reset();
    expect(a.activeCount()).toBe(0);
    expect(a.ownerOf(0)).toBeNull();
    // and lanes are reusable from 0 after reset.
    expect(a.noteOn(5)).toBe(0);
  });

  it('ownerOf out of range returns null (defensive)', () => {
    const a = createVoiceAllocator(3);
    expect(a.ownerOf(99)).toBeNull();
    expect(a.ownerOf(-1)).toBeNull();
  });
});
