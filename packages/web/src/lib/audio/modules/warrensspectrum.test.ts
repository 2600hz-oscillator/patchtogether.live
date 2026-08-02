// packages/web/src/lib/audio/modules/warrensspectrum.test.ts
//
// Def-level gates for WARREN'S SPECTRUM. The DSP itself is pinned by
// packages/dsp/src/lib/warrensspectrum-dsp.test.ts (including the permanent
// SLICE negative control and the RESIDUAL acceptance criterion) and by the
// ART audio profile; this file guards the CONTRACT — the parts a rename or a
// range edit could break silently.
//
// The first block is the important one: the FOUR port ids the `callsine`
// migration depends on. The plan makes them a design constraint, so they are
// enforced MECHANICALLY rather than by a comment — a rename must fail a test,
// not a user's rack.

import { describe, it, expect } from 'vitest';
import {
  warrensspectrumDef,
  WARRENSSPECTRUM_ALIASED_PORT_IDS,
  WARRENSSPECTRUM_RANGES,
} from './warrensspectrum';
import {
  WS_MAX_TRACKS,
  WS_SLICE_MAX_MS,
  WS_SLICE_MIN_MS,
  WarrensSpectrumEngine,
} from '../../../../../dsp/src/lib/warrensspectrum-dsp';

describe("warren's spectrum — the ALIASED PORT-ID CONTRACT", () => {
  // A saved `callsine` node keeps exactly four cables across the alias
  // (persistence.ts RETIRED_TYPE_ALIASES). Rename any of these and the alias
  // still "works" — the node survives — but every cable on it is dropped by
  // validateEdge, so the migration delivers nothing and NOTHING ELSE NOTICES.
  // That is why this is a test and not a comment.
  it.each(['audio_in', 'pitch', 'gate', 'out'])(
    'declares port `%s` by EXACT id (the callsine alias depends on it)',
    (portId) => {
      const all = [...warrensspectrumDef.inputs, ...warrensspectrumDef.outputs];
      expect(
        all.map((p) => p.id),
        `renaming '${portId}' silently voids the callsine migration: the node ` +
          'would survive with every cable dropped. Rename it only together with ' +
          'a decision to drop the alias entirely.',
      ).toContain(portId);
    },
  );

  it('the exported list and the def agree (a gate reading one side proves nothing)', () => {
    const ids = new Set([...warrensspectrumDef.inputs, ...warrensspectrumDef.outputs].map((p) => p.id));
    for (const id of WARRENSSPECTRUM_ALIASED_PORT_IDS) expect(ids.has(id)).toBe(true);
    expect(WARRENSSPECTRUM_ALIASED_PORT_IDS).toHaveLength(4);
  });

  it('the four keep their CABLE TYPES, or a surviving edge would fail validation', () => {
    const byId = Object.fromEntries(
      [...warrensspectrumDef.inputs, ...warrensspectrumDef.outputs].map((p) => [p.id, p]),
    );
    expect(byId['audio_in']!.type).toBe('audio');
    expect(byId['pitch']!.type).toBe('pitch');
    expect(byId['gate']!.type).toBe('gate');
    expect(byId['out']!.type).toBe('audio');
  });

  it('is registered under the DOUBLE-S id (a single-s id would silently resurrect the old bank)', () => {
    // `warrenspectrum` (one s) resolves by EXACT match in the registry, so
    // reusing that string would make every retired resonator-bank node load
    // silently against this def — no alias entry, no diagnostic, and a
    // completely different instrument. The distinct id is what makes the drop
    // observable at all.
    expect(warrensspectrumDef.type).toBe('warrensspectrum');
  });
});

describe("warren's spectrum — def / DSP agreement", () => {
  it('declares SLICE over the DSP\'s own full range (no re-typed numbers)', () => {
    expect(WARRENSSPECTRUM_RANGES.spectralSlice.min).toBe(WS_SLICE_MIN_MS);
    expect(WARRENSSPECTRUM_RANGES.spectralSlice.max).toBe(WS_SLICE_MAX_MS);
    const p = warrensspectrumDef.params.find((q) => q.id === 'spectralSlice')!;
    expect(p.min).toBe(WS_SLICE_MIN_MS);
    expect(p.max).toBe(WS_SLICE_MAX_MS);
  });

  it('the declared SLICE CEILING is actually REACHABLE — the VST\'s is not', () => {
    // The whole point of the divergence. Declaring 2..200 ms while the engine
    // clamped at 21.33 ms would reproduce, in our own def, exactly the defect
    // this port set out to fix.
    const sr = 48000;
    const e = new WarrensSpectrumEngine(sr);
    e.setSliceMs(WS_SLICE_MAX_MS);
    expect(
      e.effectiveSliceMs,
      `SLICE ${WS_SLICE_MAX_MS} ms must realise near ${WS_SLICE_MAX_MS} ms, not the VST's ` +
        `${WarrensSpectrumEngine.vstClampedSliceMs(WS_SLICE_MAX_MS, sr).toFixed(2)} ms clamp (unit: ms)`,
    ).toBeGreaterThan(0.9 * WS_SLICE_MAX_MS);
  });

  it('PARTIALS ceilings at the engine\'s own track cap', () => {
    expect(WARRENSSPECTRUM_RANGES.spectralPartials.max).toBe(WS_MAX_TRACKS);
    expect(WS_MAX_TRACKS).toBe(256);
  });

  it('every param range in the def matches the exported single source', () => {
    for (const p of warrensspectrumDef.params) {
      const r = (WARRENSSPECTRUM_RANGES as Record<string, { min: number; max: number; defaultValue: number }>)[p.id];
      expect(r, `${p.id} must be declared in WARRENSSPECTRUM_RANGES`).toBeDefined();
      expect([p.min, p.max, p.defaultValue]).toEqual([r!.min, r!.max, r!.defaultValue]);
    }
  });

  it('every default lies inside its own range (the cheapest possible sanity check)', () => {
    for (const p of warrensspectrumDef.params) {
      expect(p.defaultValue, `${p.id} default`).toBeGreaterThanOrEqual(p.min);
      expect(p.defaultValue, `${p.id} default`).toBeLessThanOrEqual(p.max);
    }
  });
});

describe("warren's spectrum — contract shape", () => {
  it('every CV port targets a declared param', () => {
    const paramIds = new Set(warrensspectrumDef.params.map((p) => p.id));
    for (const input of warrensspectrumDef.inputs) {
      if (input.type !== 'cv') continue;
      expect(input.paramTarget, `${input.id} must declare a paramTarget`).toBeDefined();
      expect(paramIds.has(input.paramTarget!), `${input.id} → ${input.paramTarget}`).toBe(true);
    }
  });

  it('GATE is declared level-sensitive, matching how the worklet reads it', () => {
    // FREEZE in the VST is a HELD boolean, and the worklet reads the gate
    // LEVEL per sample. CLAUDE.md forbids converting a gate consumer to
    // edge-only, so the declaration and the DSP must agree here.
    const gate = warrensspectrumDef.inputs.find((p) => p.id === 'gate')!;
    expect(gate.edge).toBe('gate');
  });

  it('is MONO in and MONO out (phase 1 has no filterbank, so no pan exists)', () => {
    expect(warrensspectrumDef.outputs).toHaveLength(1);
    expect(warrensspectrumDef.inputs.filter((p) => p.type === 'audio')).toHaveLength(1);
  });

  it('declares NO chainWiring override — it is an EFFECT, not a source', () => {
    // Its predecessor `callsine` declared role:'source' because its lone audio
    // input was an exciter on a pitch+gate VOICE. This module resynthesises
    // whatever is patched in, so `audio_in` IS the signal-chain insert and the
    // port inference is already right. Declaring 'source' would make the
    // reconciler treat a silent, unpatched analyser as a chain head.
    expect(warrensspectrumDef.chainWiring).toBeUndefined();
  });

  it('keeps the upstream OSS attribution', () => {
    expect(warrensspectrumDef.ossAttribution?.author).toBe(
      "callsine contributors (Warren's Spectrum)",
    );
  });

  it('has a lowercase label (the repo-wide guard)', () => {
    expect(warrensspectrumDef.label).toBe(warrensspectrumDef.label.toLowerCase());
  });
});
