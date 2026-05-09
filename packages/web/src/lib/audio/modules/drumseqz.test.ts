// packages/web/src/lib/audio/modules/drumseqz.test.ts
//
// Unit tests for DRUMSEQZ pure-data helpers: Bjorklund pattern generator,
// Eucl-slider rewrite contract (rewriting on flags while preserving midi),
// per-track pitch fall-through math.

import { describe, expect, it } from 'vitest';
import {
  bjorklund,
  applyEuclideanToTrack,
  resolveStepVOct,
  defaultTrack,
  defaultTracks,
  STEP_COUNT,
  TRACK_COUNT,
  coerceTracks,
  drumseqzDef,
} from './drumseqz';
import { C3_MIDI, midiToVOct } from '$lib/audio/note-entry';

describe('bjorklund', () => {
  it('k=0 yields all zeros', () => {
    expect(bjorklund(0, 16)).toEqual(new Array(16).fill(0));
  });

  it('k=16 yields all ones', () => {
    expect(bjorklund(16, 16)).toEqual(new Array(16).fill(1));
  });

  it('k=4 n=16 → 4 evenly-spaced pulses on steps 1/5/9/13', () => {
    expect(bjorklund(4, 16)).toEqual([
      1, 0, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
    ]);
  });

  it('k=5 n=16 → 5 pulses, leading on step 0, evenly distributed', () => {
    const out = bjorklund(5, 16);
    expect(out.reduce((a, b) => a + b, 0)).toBe(5);
    expect(out[0]).toBe(1);
    // Anchored, even-distribution form: pulse iff i*5 mod 16 < 5.
    // i values where pulse=1: 0, 4, 7, 10, 13.
    expect(out).toEqual([
      1, 0, 0, 0,
      1, 0, 0, 1,
      0, 0, 1, 0,
      0, 1, 0, 0,
    ]);
  });

  it('k=3 n=8 → [1,0,0,1,0,0,1,0]', () => {
    expect(bjorklund(3, 8)).toEqual([1, 0, 0, 1, 0, 0, 1, 0]);
  });

  it('clamps k > n to all ones (defensive)', () => {
    expect(bjorklund(20, 16)).toEqual(new Array(16).fill(1));
  });

  it('clamps negative k to zeros', () => {
    expect(bjorklund(-1, 16)).toEqual(new Array(16).fill(0));
  });

  it('always emits exactly k pulses for 0 < k < n', () => {
    for (let k = 1; k < STEP_COUNT; k++) {
      const out = bjorklund(k, STEP_COUNT);
      const sum = out.reduce((a, b) => a + b, 0);
      expect(sum, `k=${k}`).toBe(k);
    }
  });
});

describe('applyEuclideanToTrack (Eucl slider rewrite contract)', () => {
  it('rewrites on flags from Bjorklund pattern', () => {
    const blank = defaultTrack();
    const out = applyEuclideanToTrack(blank, 4);
    expect(out.map((c) => (c.on ? 1 : 0))).toEqual([
      1, 0, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
    ]);
  });

  it('preserves per-step midi overrides while rewriting on flags', () => {
    const trk = defaultTrack();
    trk[0] = { on: false, midi: 60 };
    trk[7] = { on: true, midi: 67 };
    trk[15] = { on: false, midi: 72 };
    const out = applyEuclideanToTrack(trk, 4);
    // on flags follow Bjorklund (steps 0, 4, 8, 12).
    expect(out[0].on).toBe(true);
    expect(out[7].on).toBe(false);
    expect(out[15].on).toBe(false);
    // midi values preserved.
    expect(out[0].midi).toBe(60);
    expect(out[7].midi).toBe(67);
    expect(out[15].midi).toBe(72);
  });

  it('k=0 silences every step but keeps midi', () => {
    const trk = defaultTrack();
    trk[3] = { on: true, midi: 65 };
    const out = applyEuclideanToTrack(trk, 0);
    expect(out.every((c) => c.on === false)).toBe(true);
    expect(out[3].midi).toBe(65);
  });

  it('always returns a length-16 track', () => {
    expect(applyEuclideanToTrack([], 5)).toHaveLength(STEP_COUNT);
    expect(applyEuclideanToTrack(defaultTrack(), 5)).toHaveLength(STEP_COUNT);
  });
});

describe('resolveStepVOct (per-track pitch fall-through math)', () => {
  it('uses per-step midi override when set', () => {
    const cell = { on: true, midi: 60 }; // C4
    const v = resolveStepVOct(cell, 48 /* C3 */, 0, 0);
    expect(v).toBeCloseTo(midiToVOct(60), 12);
  });

  it('falls through to track root when midi is null', () => {
    const cell = { on: true, midi: null };
    const v = resolveStepVOct(cell, 60 /* C4 */, 0, 0);
    expect(v).toBeCloseTo(midiToVOct(60), 12);
  });

  it('adds track octave + global octave AFTER midi→V/oct conversion', () => {
    const cell = { on: true, midi: 60 }; // C4 = 0V
    const v = resolveStepVOct(cell, C3_MIDI, 1, -1);
    // 0V + 1 + -1 = 0V
    expect(v).toBeCloseTo(0, 12);
  });

  it('per-step override beats track root', () => {
    const cell = { on: true, midi: 72 }; // C5 = +1V
    const v = resolveStepVOct(cell, 48 /* C3 = -1V */, 0, 0);
    expect(v).toBeCloseTo(1, 12);
  });

  it('null midi + non-zero track root uses the track root', () => {
    const cell = { on: true, midi: null };
    const v = resolveStepVOct(cell, C3_MIDI, 0, 0);
    expect(v).toBeCloseTo(midiToVOct(C3_MIDI), 12);
  });
});

describe('coerceTracks', () => {
  it('returns 4 default tracks for invalid input', () => {
    const out = coerceTracks(null);
    expect(out).toHaveLength(TRACK_COUNT);
    for (const t of out) {
      expect(t).toHaveLength(STEP_COUNT);
      expect(t.every((c) => c.on === false && c.midi === null)).toBe(true);
    }
  });

  it('coerces partial track arrays + clamps midi out of range', () => {
    const raw = [
      [{ on: true, midi: 60 }, { on: false, midi: 200 /* out of range */ }],
      // missing tracks 1..3
    ];
    const out = coerceTracks(raw);
    expect(out).toHaveLength(TRACK_COUNT);
    expect(out[0][0]).toEqual({ on: true, midi: 60 });
    expect(out[0][1]).toEqual({ on: false, midi: null });
    expect(out[1].every((c) => c.on === false && c.midi === null)).toBe(true);
  });
});

describe('drumseqzDef shape', () => {
  it('declares 9 outputs (4 gate + 4 pitch + chained clock)', () => {
    const ids = drumseqzDef.outputs.map((p) => p.id);
    expect(ids).toEqual([
      'gate1', 'pitch1',
      'gate2', 'pitch2',
      'gate3', 'pitch3',
      'gate4', 'pitch4',
      'clock',
    ]);
  });

  it('declares clock + transport CV inputs', () => {
    expect(drumseqzDef.inputs.map((p) => p.id)).toEqual([
      'clock',
      'play_cv', 'reset_cv',
      'queue1_cv', 'queue2_cv', 'queue3_cv', 'queue4_cv',
    ]);
  });

  it('declares per-track euclid/root/octave params', () => {
    const ids = drumseqzDef.params.map((p) => p.id);
    for (let t = 1; t <= TRACK_COUNT; t++) {
      expect(ids).toContain(`trk${t}_euclid`);
      expect(ids).toContain(`trk${t}_root`);
      expect(ids).toContain(`trk${t}_octave`);
    }
    expect(ids).toContain('bpm');
    expect(ids).toContain('isPlaying');
    expect(ids).toContain('swing');
  });

  it('schemaVersion is 1', () => {
    expect(drumseqzDef.schemaVersion).toBe(1);
  });
});

describe('quicksave snapshot helpers (transport-card)', () => {
  // Round-trip: SAVE → LOAD restores the snapshot exactly.
  // We simulate the card-side flow without instantiating Svelte: build a
  // fake patch + ModuleNode, run handleSlotClick under each pendingMode.

  type Cell = { on: boolean; midi: number | null };

  function makeNode(): {
    nodeId: string;
    patch: { nodes: Record<string, { id: string; type: string; domain: 'audio'; position: { x: number; y: number }; params: Record<string, number>; data?: Record<string, unknown> } | undefined> };
    deps: import('./transport-card').TransportCardDeps;
    snap: () => Record<string, unknown>;
    apply: (s: Record<string, unknown>) => void;
  } {
    const nodeId = 'drum-test';
    const patch = {
      nodes: {
        [nodeId]: {
          id: nodeId,
          type: 'drumseqz',
          domain: 'audio' as const,
          position: { x: 0, y: 0 },
          params: { bpm: 120, length: 16 },
          data: { tracks: defaultTracks() },
        },
      },
    };
    const snap = () => {
      const t = patch.nodes[nodeId]!;
      return {
        tracks: ((t.data as Record<string, unknown>).tracks as Cell[][]).map((tr) =>
          tr.map((c) => ({ on: c.on, midi: c.midi })),
        ),
        bpm: t.params.bpm,
        length: t.params.length,
      };
    };
    const apply = (s: Record<string, unknown>) => {
      const t = patch.nodes[nodeId]!;
      if (Array.isArray(s.tracks)) {
        (t.data as Record<string, unknown>).tracks = s.tracks;
      }
      if (typeof s.bpm === 'number') t.params.bpm = s.bpm;
      if (typeof s.length === 'number') t.params.length = s.length;
    };
    return {
      nodeId,
      patch,
      snap,
      apply,
      deps: {
        nodeId,
        patch,
        transact: (fn) => fn(),
        snapshot: snap,
        applySnapshot: apply,
      },
    };
  }

  it('SAVE writes the snapshot into slots[N]', async () => {
    const { handleSlotClick, setPendingMode } = await import('./transport-card');
    const env = makeNode();
    // Mutate one cell so the snapshot is non-default.
    const t = env.patch.nodes[env.nodeId]!;
    (t.data as { tracks: Cell[][] }).tracks[0][0] = { on: true, midi: 60 };
    setPendingMode(env.deps, 'save');
    const action = handleSlotClick(env.deps, '2');
    expect(action).toBe('save');
    const slots = (t.data as { slots?: Record<string, unknown> }).slots;
    expect(slots).toBeDefined();
    expect(slots?.['2']).toBeTruthy();
    const stored = slots!['2'] as { tracks: Cell[][] };
    expect(stored.tracks[0][0]).toEqual({ on: true, midi: 60 });
  });

  it('LOAD restores the snapshot saved earlier', async () => {
    const { handleSlotClick, setPendingMode } = await import('./transport-card');
    const env = makeNode();
    const t = env.patch.nodes[env.nodeId]!;
    (t.data as { tracks: Cell[][] }).tracks[0][0] = { on: true, midi: 64 };
    setPendingMode(env.deps, 'save');
    handleSlotClick(env.deps, '1');
    // Now mutate so the live state differs from slot 1.
    (t.data as { tracks: Cell[][] }).tracks[0][0] = { on: false, midi: null };
    expect((t.data as { tracks: Cell[][] }).tracks[0][0]).toEqual({ on: false, midi: null });
    setPendingMode(env.deps, 'load');
    const action = handleSlotClick(env.deps, '1');
    expect(action).toBe('load');
    expect((t.data as { tracks: Cell[][] }).tracks[0][0]).toEqual({ on: true, midi: 64 });
    // After LOAD, lastLoadedSlot is set + queuedSlot is cleared.
    expect((t.data as { lastLoadedSlot?: string }).lastLoadedSlot).toBe('1');
  });

  it('QUEUE sets queuedSlot but does not load immediately', async () => {
    const { handleSlotClick, setPendingMode } = await import('./transport-card');
    const env = makeNode();
    const t = env.patch.nodes[env.nodeId]!;
    // Pre-populate slot 3.
    (t.data as { tracks: Cell[][] }).tracks[1][0] = { on: true, midi: 67 };
    setPendingMode(env.deps, 'save');
    handleSlotClick(env.deps, '3');
    // Mutate live so slot 3 differs.
    (t.data as { tracks: Cell[][] }).tracks[1][0] = { on: false, midi: null };
    setPendingMode(env.deps, 'queue');
    const action = handleSlotClick(env.deps, '3');
    expect(action).toBe('queue');
    expect((t.data as { queuedSlot?: string }).queuedSlot).toBe('3');
    // Live state is UNCHANGED — engine performs the swap on sequence-end.
    expect((t.data as { tracks: Cell[][] }).tracks[1][0]).toEqual({ on: false, midi: null });
  });

  it('clicking a slot button without a pending mode is a noop', async () => {
    const { handleSlotClick } = await import('./transport-card');
    const env = makeNode();
    const action = handleSlotClick(env.deps, '4');
    expect(action).toBe('noop');
  });
});
