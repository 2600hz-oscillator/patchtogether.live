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
  warrensspectrumBands,
  warrensspectrumBandsSignature,
  wsDefaultBands,
  WARRENSSPECTRUM_ALIASED_PORT_IDS,
  WARRENSSPECTRUM_BAND_SPEC,
  WARRENSSPECTRUM_RANGES,
  WS_NUM_BANDS,
} from './warrensspectrum';
import {
  WS_MAX_TRACKS,
  WS_SLICE_MAX_MS,
  WS_SLICE_MIN_MS,
  WarrensSpectrumEngine,
} from '../../../../../dsp/src/lib/warrensspectrum-dsp';
import {
  WS_BAND_CUTOFF_MAX_HZ,
  WS_BAND_CUTOFF_MIN_HZ,
  WS_BAND_Q_MAX,
  WS_BAND_Q_MIN,
} from '../../../../../dsp/src/lib/warrensspectrum-filterbank';

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

  it('is MONO in and has exactly ONE audio out (stereo rides the channels)', () => {
    // Phase 2 made the OUTPUT stereo without adding a port: the worklet node
    // declares `outputChannelCount: [2]` and the single `out` port carries
    // both channels, which is how every other stereo module here works. The
    // input stays mono — upstream sums to mono before the engine too.
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

describe("warren's spectrum — the FILTERBANK contract (phase 2)", () => {
  it('BANK WET defaults to 0 — the divergence that protects a saved rack', () => {
    // If this ever defaults non-zero, every rack saved under phase 1 changes
    // sound on load. The engine-level proof is in
    // warrensspectrum-filterbank.test.ts; this is the contract-level one, and
    // it is deliberately stated as an EQUALITY to 0 rather than "falsy".
    const wet = warrensspectrumDef.params.find((p) => p.id === 'resynthLevel');
    expect(wet?.defaultValue, "FILTERBANK WET must ship OFF (the VST's 1.0 would re-voice phase-1 racks)").toBe(0);
    const mix = warrensspectrumDef.params.find((p) => p.id === 'inputMix');
    expect(mix?.defaultValue).toBe(0);
  });

  it('the bank is ONE control family, not 40 params', () => {
    // The plan's §5.3 decision, mechanised: if someone later promotes the
    // band values to ParamDefs, the param count explodes past every other
    // module here and this fails rather than the face silently breaking.
    const fam = warrensspectrumDef.controlFamilies?.find((f) => f.id === 'ws-filterbank');
    expect(fam, 'the filterbank must be declared as a control family').toBeDefined();
    expect(fam?.testidPrefix).toBe('ws-band');
    const bandParams = warrensspectrumDef.params.filter((p) => /^wsBand/i.test(p.id));
    expect(bandParams.map((p) => p.id), 'per-band values must NOT be ParamDefs').toEqual([]);
  });

  it('the band spec covers EVERY band field, with bounds from the engine', () => {
    // The card binds to this and nothing else; a field missing here is a
    // control the card would have to hand-type, which card-range-source
    // catches — but only after someone writes the literal. This catches it
    // at the source.
    const covered = Object.keys(WARRENSSPECTRUM_BAND_SPEC).sort();
    expect(covered).toEqual(['cutoffHz', 'pan', 'q', 'send', 'type']);
    expect(WARRENSSPECTRUM_BAND_SPEC.cutoffHz.min).toBe(WS_BAND_CUTOFF_MIN_HZ);
    expect(WARRENSSPECTRUM_BAND_SPEC.cutoffHz.max).toBe(WS_BAND_CUTOFF_MAX_HZ);
    expect(WARRENSSPECTRUM_BAND_SPEC.q.min).toBe(WS_BAND_Q_MIN);
    expect(WARRENSSPECTRUM_BAND_SPEC.q.max).toBe(WS_BAND_Q_MAX);
    // CUTOFF and Q are LOG. A linear card against a log range puts the
    // fader's midpoint at 10 kHz instead of ~630 Hz.
    expect(WARRENSSPECTRUM_BAND_SPEC.cutoffHz.curve).toBe('log');
    expect(WARRENSSPECTRUM_BAND_SPEC.q.curve).toBe('log');
  });

  it('warrensspectrumBands resolves an absent / partial / proxied table to 8 bands', () => {
    expect(warrensspectrumBands(undefined)).toHaveLength(WS_NUM_BANDS);
    expect(warrensspectrumBands({ data: {} })).toHaveLength(WS_NUM_BANDS);
    expect(warrensspectrumBands({ data: { wsBands: [{ send: 1 }] } })).toHaveLength(WS_NUM_BANDS);
    // A Yjs array proxy is NOT `Array.isArray`, so a table that is genuinely
    // present would silently resolve to the defaults without the toJSON
    // unwrap — the DX7 structured-clone scar, in its read direction.
    const proxied = { toJSON: () => [{ cutoffHz: 999, q: 3, type: 1, pan: -1, send: 1 }] };
    const out = warrensspectrumBands({ data: { wsBands: proxied } });
    expect(out[0]!.cutoffHz, 'a Yjs-proxied band table must not read as absent').toBe(999);
  });

  it('a saved table survives the round trip the worklet message makes of it', () => {
    // The factory hand-builds plain numbers for postMessage; this proves the
    // shape it builds is the shape the normalizer accepts, so the two cannot
    // drift into a silently-defaulted bank.
    const saved = wsDefaultBands().map((b, i) => ({ ...b, pan: i % 2 ? 1 : -1, send: 0.25 }));
    const roundTripped = warrensspectrumBands({ data: { wsBands: saved } });
    expect(roundTripped).toEqual(saved);
  });

  it('the bands CONTENT signature separates tables the rev counter aliases', () => {
    // The factory's re-push test is `warrensspectrumBandsSignature`, not
    // `wsBandsRev` — the rev is persisted per patch, so loading patch B over
    // patch A can move the TABLE while the rev stands still (both saved at
    // rev 3). Content cannot alias: two different tables must sign differently
    // WHATEVER the rev keys say, and the same table must sign identically
    // THROUGH a Yjs proxy (the read the live factory makes).
    const a = wsDefaultBands();
    const b = wsDefaultBands().map((band, i) => (i === 3 ? { ...band, cutoffHz: 1234 } : band));
    const sigA = warrensspectrumBandsSignature({ data: { wsBands: a, wsBandsRev: 3 } });
    const sigB = warrensspectrumBandsSignature({ data: { wsBands: b, wsBandsRev: 3 } });
    expect(sigB, 'different tables at the SAME rev must not alias').not.toBe(sigA);
    const proxied = { toJSON: () => b };
    expect(
      warrensspectrumBandsSignature({ data: { wsBands: proxied, wsBandsRev: 99 } }),
      'a Yjs-proxied table signs like its plain form, whatever the rev',
    ).toBe(sigB);
    // And an absent table signs like the defaults — a fresh node never
    // re-pushes just because the key materialises.
    expect(warrensspectrumBandsSignature({ data: {} })).toBe(
      warrensspectrumBandsSignature({ data: { wsBands: a } }),
    );
    expect(warrensspectrumBandsSignature(undefined)).toBe(
      warrensspectrumBandsSignature({ data: { wsBands: a } }),
    );
  });
});
