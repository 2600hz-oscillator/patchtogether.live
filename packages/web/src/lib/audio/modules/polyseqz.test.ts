// packages/web/src/lib/audio/modules/polyseqz.test.ts
//
// Module-level unit tests for POLYSEQZ. Validates the def shape, default
// step seeding, and step coercion / round-trip — the audio-graph factory
// path is exercised in the ART scenario + E2E spec.

import { describe, it, expect } from 'vitest';
import {
  polyseqzDef,
  defaultChordSteps,
  coerceToChordStep,
  STEP_COUNT,
  POLYSEQZ_VOICE_LANES,
  type ChordStep,
} from './polyseqz';
import { CHORD_QUALITY_NAMES, VOICE_LANES } from '$lib/audio/chord-tables';
import { POLY_CHANNEL_PAIRS } from '$lib/audio/poly';
import { TRANSPORT_CV_PORT_DEFS } from './transport-cv';

describe('polyseqz: module def', () => {
  it('registers as audio-domain module type "polyseqz"', () => {
    expect(polyseqzDef.type).toBe('polyseqz');
    expect(polyseqzDef.domain).toBe('audio');
    expect(polyseqzDef.label).toBe('polyseqz');
    expect(polyseqzDef.category).toBe('modulation');
  });

  it('declares the polyPitchGate output port', () => {
    const out = polyseqzDef.outputs.find((p) => p.id === 'poly');
    expect(out).toBeDefined();
    expect(out?.type).toBe('polyPitchGate');
  });

  it('exposes humanize CV input + knob param', () => {
    const inp = polyseqzDef.inputs.find((p) => p.id === 'humanize_cv');
    expect(inp?.type).toBe('cv');
    expect(inp?.paramTarget).toBe('humanize');
    const knob = polyseqzDef.params.find((p) => p.id === 'humanize');
    expect(knob).toBeDefined();
    expect(knob?.min).toBe(0);
    expect(knob?.max).toBe(1);
    expect(knob?.defaultValue).toBe(0);
  });

  it('exposes a length param matching STEP_COUNT', () => {
    const length = polyseqzDef.params.find((p) => p.id === 'length');
    expect(length).toBeDefined();
    expect(length?.max).toBe(STEP_COUNT);
  });

  it('declares a discrete s&h param defaulting ON (1), lowercase label', () => {
    const snh = polyseqzDef.params.find((p) => p.id === 'snh');
    expect(snh).toBeDefined();
    expect(snh!.defaultValue).toBe(1);
    expect(snh!.min).toBe(0);
    expect(snh!.max).toBe(1);
    expect(snh!.curve).toBe('discrete');
    expect(snh!.label).toBe(snh!.label.toLowerCase());
  });

  it('voice lane count matches the polyPitchGate cable', () => {
    expect(POLYSEQZ_VOICE_LANES).toBe(POLY_CHANNEL_PAIRS);
    expect(POLYSEQZ_VOICE_LANES).toBe(VOICE_LANES);
  });
});

describe('polyseqz: defaultChordSteps', () => {
  it('returns STEP_COUNT entries', () => {
    const steps = defaultChordSteps();
    expect(steps.length).toBe(STEP_COUNT);
  });

  it('every default step is off, with C3 root and maj/closed/inv0', () => {
    const steps = defaultChordSteps();
    for (const s of steps) {
      expect(s.on).toBe(false);
      expect(s.root).toBe(48); // C3
      expect(s.quality).toBe('maj');
      expect(s.inversion).toBe(0);
      expect(s.voicing).toBe('closed');
    }
  });
});

describe('polyseqz: coerceToChordStep — round-trip + tolerance', () => {
  it('round-trips a fully-specified step', () => {
    const raw = { on: true, root: 67, quality: 'min7', inversion: 1, voicing: 'open' };
    const out = coerceToChordStep(raw);
    expect(out.on).toBe(true);
    expect(out.root).toBe(67);
    expect(out.quality).toBe('min7');
    expect(out.inversion).toBe(1);
    expect(out.voicing).toBe('open');
  });

  it('falls back to defaults when fields missing', () => {
    const out = coerceToChordStep({ on: true });
    expect(out.on).toBe(true);
    expect(out.quality).toBe('maj');
    expect(out.inversion).toBe(0);
    expect(out.voicing).toBe('closed');
  });

  it('drops invalid quality values', () => {
    const out = coerceToChordStep({ on: true, root: 60, quality: 'bogus' });
    expect(out.quality).toBe('maj');
  });

  it('drops invalid inversion values', () => {
    const out = coerceToChordStep({ on: true, root: 60, inversion: 99 });
    expect(out.inversion).toBe(0);
  });

  it('accepts midi field for backward compat with NoteStep shape', () => {
    // Reuses coerceToNoteStep underneath — older sequencer-style
    // {on, midi, ...} blobs should still load.
    const out = coerceToChordStep({ on: true, midi: 64, quality: 'min' });
    expect(out.on).toBe(true);
    expect(out.root).toBe(64);
    expect(out.quality).toBe('min');
  });

  it('null root means empty step', () => {
    const out = coerceToChordStep({ on: true, root: null });
    expect(out.root).toBeNull();
  });

  it('all CHORD_QUALITY_NAMES round-trip cleanly', () => {
    for (const q of CHORD_QUALITY_NAMES) {
      const out = coerceToChordStep({ on: true, root: 60, quality: q });
      expect(out.quality).toBe(q);
    }
  });
});

// ----------------------------------------------------------------------------
// PR feat/polyseqz-transport-parity — shared transport surface lives on the
// def's input ports + the card's quicksave snapshot helpers. We verify the
// def-side declaration here; the card-side handleSlotClick path is exercised
// in the e2e spec (it needs DOM + Yjs to run end-to-end).
// ----------------------------------------------------------------------------

describe('polyseqz: shared transport CV inputs', () => {
  it('declares the 6 transport CV input ports (play_cv, reset_cv, queue1..4_cv)', () => {
    const ids = polyseqzDef.inputs.map((p) => p.id);
    for (const t of TRANSPORT_CV_PORT_DEFS) {
      expect(ids, `polyseqz inputs include ${t.id}`).toContain(t.id);
    }
  });

  it('the transport CV ports are all gate-typed (matches Sequencer / DRUMSEQZ / SCORE)', () => {
    const transportIds = new Set(TRANSPORT_CV_PORT_DEFS.map((p) => p.id));
    for (const port of polyseqzDef.inputs) {
      if (!transportIds.has(port.id)) continue;
      expect(port.type, `${port.id} is gate-typed`).toBe('gate');
    }
  });

  it('keeps clock + humanize_cv + the 6 transport CV ports = 8 inputs total', () => {
    expect(polyseqzDef.inputs.length).toBe(8);
    const ids = new Set(polyseqzDef.inputs.map((p) => p.id));
    expect(ids.has('clock')).toBe(true);
    expect(ids.has('humanize_cv')).toBe(true);
    expect(ids.has('play_cv')).toBe(true);
    expect(ids.has('reset_cv')).toBe(true);
    expect(ids.has('queue1_cv')).toBe(true);
    expect(ids.has('queue2_cv')).toBe(true);
    expect(ids.has('queue3_cv')).toBe(true);
    expect(ids.has('queue4_cv')).toBe(true);
  });
});

describe('polyseqz: quicksave snapshot helpers (transport-card)', () => {
  // Mirror DRUMSEQZ's snapshot tests: stand up a fake patch + ModuleNode,
  // call handleSlotClick under each pendingMode. We exercise SAVE then LOAD
  // round-tripping the per-step chord data exactly (root + quality +
  // inversion + voicing for every step) plus the transport params.

  function makeNode(): {
    nodeId: string;
    patch: { nodes: Record<string, { id: string; type: string; domain: 'audio'; position: { x: number; y: number }; params: Record<string, number>; data?: Record<string, unknown> } | undefined> };
    deps: import('./transport-card').TransportCardDeps;
  } {
    const nodeId = 'polyseqz-test';
    const patch = {
      nodes: {
        [nodeId]: {
          id: nodeId,
          type: 'polyseqz',
          domain: 'audio' as const,
          position: { x: 0, y: 0 },
          params: { bpm: 90, length: 8, octave: 0, gateLength: 0.6, humanize: 0, isPlaying: 0 },
          data: { steps: defaultChordSteps() },
        },
      },
    };
    const snap = (): Record<string, unknown> => {
      const t = patch.nodes[nodeId]!;
      const steps = (t.data as { steps?: ChordStep[] }).steps ?? defaultChordSteps();
      return {
        steps: steps.map((s) => ({
          on: s.on,
          root: s.root,
          quality: s.quality,
          inversion: s.inversion,
          voicing: s.voicing,
        })),
        bpm: t.params.bpm,
        length: t.params.length,
        octave: t.params.octave,
        gateLength: t.params.gateLength,
        humanize: t.params.humanize,
      };
    };
    const apply = (s: Record<string, unknown>): void => {
      const t = patch.nodes[nodeId]!;
      if (Array.isArray(s.steps)) {
        // Deep-clone — same reasoning as the card-side applySnapshot.
        (t.data as Record<string, unknown>).steps = (s.steps as Array<Record<string, unknown>>).map((step) => ({ ...step }));
      }
      for (const k of ['bpm', 'length', 'octave', 'gateLength', 'humanize'] as const) {
        const v = s[k];
        if (typeof v === 'number') t.params[k] = v;
      }
    };
    return {
      nodeId,
      patch,
      deps: {
        nodeId,
        patch,
        transact: (fn) => fn(),
        snapshot: snap,
        applySnapshot: apply,
      },
    };
  }

  it('SAVE writes the per-step chord snapshot into slots[N]', async () => {
    const { handleSlotClick, setPendingMode } = await import('./transport-card');
    const env = makeNode();
    const t = env.patch.nodes[env.nodeId]!;
    // Mutate the first 3 steps so the snapshot is non-default.
    const steps = (t.data as { steps: ChordStep[] }).steps;
    steps[0] = { on: true, root: 60, quality: 'maj7', inversion: 0, voicing: 'closed' };
    steps[1] = { on: true, root: 64, quality: 'min7', inversion: 1, voicing: 'open' };
    steps[2] = { on: true, root: 67, quality: 'dom7', inversion: 2, voicing: 'spread' };
    t.params.bpm = 145;
    setPendingMode(env.deps, 'save');
    const action = handleSlotClick(env.deps, '2');
    expect(action).toBe('save');
    const slots = (t.data as { slots?: Record<string, unknown> }).slots;
    expect(slots).toBeDefined();
    const stored = slots!['2'] as { steps: ChordStep[]; bpm: number };
    expect(stored.bpm).toBe(145);
    expect(stored.steps[0]).toMatchObject({ on: true, root: 60, quality: 'maj7', inversion: 0, voicing: 'closed' });
    expect(stored.steps[1]).toMatchObject({ on: true, root: 64, quality: 'min7', inversion: 1, voicing: 'open' });
    expect(stored.steps[2]).toMatchObject({ on: true, root: 67, quality: 'dom7', inversion: 2, voicing: 'spread' });
  });

  it('LOAD restores the per-step chord data exactly (round-trip)', async () => {
    const { handleSlotClick, setPendingMode } = await import('./transport-card');
    const env = makeNode();
    const t = env.patch.nodes[env.nodeId]!;
    // Save a non-default chord pattern.
    const steps = (t.data as { steps: ChordStep[] }).steps;
    steps[0] = { on: true, root: 62, quality: 'sus4', inversion: 0, voicing: 'open' };
    steps[5] = { on: true, root: 71, quality: 'aug', inversion: 2, voicing: 'spread' };
    t.params.bpm = 132;
    t.params.length = 12;
    t.params.gateLength = 0.8;
    setPendingMode(env.deps, 'save');
    handleSlotClick(env.deps, '1');

    // Mutate live state to differ from slot 1.
    steps[0] = { on: false, root: null, quality: 'maj', inversion: 0, voicing: 'closed' };
    steps[5] = { on: false, root: null, quality: 'maj', inversion: 0, voicing: 'closed' };
    t.params.bpm = 90;
    t.params.length = 8;
    t.params.gateLength = 0.6;

    setPendingMode(env.deps, 'load');
    const action = handleSlotClick(env.deps, '1');
    expect(action).toBe('load');

    const restored = (t.data as { steps: ChordStep[] }).steps;
    expect(restored[0]).toMatchObject({ on: true, root: 62, quality: 'sus4', inversion: 0, voicing: 'open' });
    expect(restored[5]).toMatchObject({ on: true, root: 71, quality: 'aug', inversion: 2, voicing: 'spread' });
    expect(t.params.bpm).toBe(132);
    expect(t.params.length).toBe(12);
    expect(t.params.gateLength).toBeCloseTo(0.8, 5);
    // After LOAD, lastLoadedSlot is set + queuedSlot cleared.
    expect((t.data as { lastLoadedSlot?: string }).lastLoadedSlot).toBe('1');
  });

  it('QUEUE arms queuedSlot on node.data without applying immediately', async () => {
    const { handleSlotClick, setPendingMode } = await import('./transport-card');
    const env = makeNode();
    const t = env.patch.nodes[env.nodeId]!;
    // Pre-populate slot 3 with a distinctive pattern.
    const steps = (t.data as { steps: ChordStep[] }).steps;
    steps[0] = { on: true, root: 60, quality: 'maj', inversion: 0, voicing: 'closed' };
    setPendingMode(env.deps, 'save');
    handleSlotClick(env.deps, '3');
    // Mutate live so slot 3 differs.
    steps[0] = { on: false, root: null, quality: 'maj', inversion: 0, voicing: 'closed' };
    setPendingMode(env.deps, 'queue');
    const action = handleSlotClick(env.deps, '3');
    expect(action).toBe('queue');
    expect((t.data as { queuedSlot?: string }).queuedSlot).toBe('3');
    // Live state UNCHANGED — engine performs the swap on sequence-end.
    expect(steps[0]).toMatchObject({ on: false, root: null, quality: 'maj' });
  });

  it('clicking a slot button without a pending mode is a noop', async () => {
    const { handleSlotClick } = await import('./transport-card');
    const env = makeNode();
    const action = handleSlotClick(env.deps, '4');
    expect(action).toBe('noop');
  });

  it('apply path deep-clones step objects (no shared references with slot snapshot)', async () => {
    // Yjs forbids reassigning the same object at two paths in the tree. We
    // verify the apply path emits fresh step objects so the snap living in
    // slots[N] doesn't get aliased into data.steps. See PR-82's analogous
    // sequencer.ts fix.
    const { handleSlotClick, setPendingMode } = await import('./transport-card');
    const env = makeNode();
    const t = env.patch.nodes[env.nodeId]!;
    const steps = (t.data as { steps: ChordStep[] }).steps;
    steps[0] = { on: true, root: 60, quality: 'maj7', inversion: 1, voicing: 'open' };
    setPendingMode(env.deps, 'save');
    handleSlotClick(env.deps, '1');
    setPendingMode(env.deps, 'load');
    handleSlotClick(env.deps, '1');

    const slots = (t.data as { slots: Record<string, { steps: unknown[] }> }).slots;
    const stepsAfter = (t.data as { steps: ChordStep[] }).steps;
    const slotStep0 = (slots['1'].steps as unknown[])[0];
    // Different identity — they happen to be value-equal, but must not be
    // === the same JS object (otherwise the round-trip aliased the Y-tree).
    expect(stepsAfter[0]).not.toBe(slotStep0);
  });
});
