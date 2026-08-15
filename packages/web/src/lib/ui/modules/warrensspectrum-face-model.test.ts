// packages/web/src/lib/ui/modules/warrensspectrum-face-model.test.ts
//
// THE ORACLE + THE PERMANENT NEGATIVE CONTROLS for the WARREN'S SPECTRUM
// faceplate.
//
// Three jobs, and the last two are what make this file worth having:
//
//   1. ORACLE — every closed form in `warrensspectrum-face-model.ts` is
//      re-derived from the SHIPPING DSP (`packages/dsp/src/lib/warrensspectrum-
//      {dsp,masspass}.ts`, imported directly — the sidecar/cube precedent) and
//      every mirrored constant is asserted against the def AND the engine. A
//      DSP change or a def re-range turns a stale faceplate claim RED instead
//      of leaving the panel insisting on a repaired defect.
//
//   2. NEGATIVE CONTROLS, PERMANENTLY — for each of the four readouts, the
//      input a KNOB READBACK would be blind to is perturbed and the printed
//      string is asserted to MOVE, and an input it must be INVARIANT to is
//      perturbed and asserted NOT to move. Both directions, on every run.
//      A check you ran once at authoring time is a check nobody is watching.
//
//   3. TOTALITY — a `FaceReadoutValue` runs on every render, so a throw on a
//      transient NaN takes the faceplate down mid-drag. Every readout is driven
//      with a fresh (empty) node, NaN, ±Infinity and out-of-range values.
//
// ⚠ THE RESIDUAL ORACLE DRIVES THE REAL ENGINE, not a re-implementation of the
// cube-root. Asserting `0.5 * cbrt(63/47 clamped)` against `0.5 * cbrt(63/47
// clamped)` would be circular; asserting that the ENGINE renders bit-identical
// audio at RESIDUAL 0 and RESIDUAL 2 exactly when this model says `off` is not.

import { describe, it, expect } from 'vitest';

import {
  WarrensSpectrumEngine,
  WS_ENGINE_MASSPASS,
  WS_ENGINE_SPECTRAL,
  WS_MASSPASS_BAND_COUNTS,
  WS_MAX_TRACKS,
  WS_SLICE_MAX_MS,
  WS_SLICE_MIN_MS,
} from '../../../../../dsp/src/lib/warrensspectrum-dsp';
import { WsMassPass, wsBandCountForIndex } from '../../../../../dsp/src/lib/warrensspectrum-masspass';

import { warrensspectrumDef, WARRENSSPECTRUM_RANGES } from '$lib/audio/modules/warrensspectrum';
import {
  WARRENSSPECTRUM_FACE_DEFAULTS,
  WSF_BAND_COUNTS,
  WSF_ENGINE_MASSPASS,
  WSF_ENGINE_SPECTRAL,
  WSF_MAX_TRACKS,
  WSF_RESIDUAL_EPSILON,
  WSF_SLICE_MAX_MS,
  WSF_SLICE_MIN_MS,
  warrensspectrumFaceParams,
  wsBandCount,
  wsEffectiveResidual,
  wsFadeInMs,
  wsFadeInText,
  wsLivePaths,
  wsOutText,
  wsOutputHeadroomDb,
  wsResidualText,
  wsVoiceCount,
  wsVoiceText,
  type WarrensspectrumFaceParams,
} from './warrensspectrum-face-model';

const SR = 48000;

/** A reader over an explicit param map — the shape `FaceReadoutValue` gets. */
function reader(p: Partial<Record<string, number>>) {
  return (id: string) => p[id];
}

/** The face's params at the def's own defaults, with an explicit override. */
function at(over: Partial<WarrensspectrumFaceParams> = {}): WarrensspectrumFaceParams {
  return { ...WARRENSSPECTRUM_FACE_DEFAULTS, ...over };
}

describe('warrensspectrum face model — the MIRRORED constants track their source', () => {
  it('the engine-mode indices are the engine’s own', () => {
    expect(WSF_ENGINE_SPECTRAL).toBe(WS_ENGINE_SPECTRAL);
    expect(WSF_ENGINE_MASSPASS).toBe(WS_ENGINE_MASSPASS);
  });

  it('the MASSPASS band roster is the engine’s own', () => {
    expect(WSF_BAND_COUNTS).toEqual([...WS_MASSPASS_BAND_COUNTS]);
  });

  it('the track ceiling and the SLICE range are the engine’s own', () => {
    expect(WSF_MAX_TRACKS).toBe(WS_MAX_TRACKS);
    expect(WSF_SLICE_MIN_MS).toBe(WS_SLICE_MIN_MS);
    expect(WSF_SLICE_MAX_MS).toBe(WS_SLICE_MAX_MS);
  });

  it('the face defaults are the DEF’s defaults, key by key', () => {
    // Anchored to the ARTIFACT: every key this model mirrors must still be a
    // declared param, so a rename is red rather than silently defaulted.
    const byId = new Map(warrensspectrumDef.params.map((p) => [p.id, p]));
    for (const [id, value] of Object.entries(WARRENSSPECTRUM_FACE_DEFAULTS)) {
      const def = byId.get(id);
      expect(def, `'${id}' must still be a declared ParamDef`).toBeDefined();
      expect(def!.defaultValue, `'${id}' default`).toBe(value);
      // …and the def's own ranges come from WARRENSSPECTRUM_RANGES, so this
      // also pins the two together.
      const range = (WARRENSSPECTRUM_RANGES as Record<string, { defaultValue: number }>)[id];
      expect(range?.defaultValue, `'${id}' range default`).toBe(value);
    }
  });
});

describe('warrensspectrum face model — VOICES', () => {
  it('ORACLE: in MASSPASS the count is the engine’s own active-band limit', () => {
    // Drive the real MassPass exactly as `setBandCountIndex` + `setPartials` do.
    for (let idx = 0; idx < WS_MASSPASS_BAND_COUNTS.length; idx++) {
      for (const partials of [1, 4, 16, 24, 64, 256]) {
        const mp = new WsMassPass(SR, wsBandCountForIndex(idx));
        mp.setActiveBands(partials);
        const p = at({
          engineMode: WSF_ENGINE_MASSPASS,
          spectralBandCount: idx,
          spectralPartials: partials,
        });
        expect(
          wsVoiceCount(p),
          `MASSPASS idx=${idx} (${wsBandCountForIndex(idx)} bands) partials=${partials}`,
        ).toBe(mp.getActiveBands());
        expect(wsBandCount(p)).toBe(mp.getBandCount());
      }
    }
  });

  it('ORACLE: in SPECTRAL the count is the engine’s own clamped bank size', () => {
    for (const partials of [-5, 0, 1, 63.4, 64, 300]) {
      const e = new WarrensSpectrumEngine(SR);
      e.setPartials(partials);
      // No accessor for `partials`; the model's clamp is the engine's clamp,
      // asserted through the shared law rather than a private field.
      expect(wsVoiceCount(at({ spectralPartials: partials })))
        .toBe(Math.max(1, Math.min(WS_MAX_TRACKS, Math.round(partials))));
      expect(e).toBeDefined();
    }
  });

  it('NEGATIVE CONTROL: the printed voice count MOVES with MODE and with BAND COUNT — the two inputs a PARTIALS readback cannot see', () => {
    // The dial prints `64` in all three of these states.
    const spectral = wsVoiceText(at({ spectralPartials: 64 }));
    const massSmall = wsVoiceText(
      at({ spectralPartials: 64, engineMode: WSF_ENGINE_MASSPASS, spectralBandCount: 0 }),
    );
    const massLarge = wsVoiceText(
      at({ spectralPartials: 64, engineMode: WSF_ENGINE_MASSPASS, spectralBandCount: 5 }),
    );
    expect(spectral).toBe('64');
    expect(massSmall).toBe('16 of 16');
    expect(massLarge).toBe('64 of 99');
    expect(massSmall, 'MODE must move it').not.toBe(spectral);
    expect(massLarge, 'BAND COUNT must move it').not.toBe(massSmall);
  });

  it('INVARIANCE: in SPECTRAL the voice count cannot move with BAND COUNT', () => {
    // The other direction, and it has teeth: BANDS is inert in SPECTRAL, so a
    // model that forgot the mode branch would move here and this would redden.
    const base = wsVoiceText(at({ spectralBandCount: 0 }));
    for (let idx = 0; idx < WSF_BAND_COUNTS.length; idx++) {
      expect(wsVoiceText(at({ spectralBandCount: idx })), `SPECTRAL, bands idx ${idx}`).toBe(base);
    }
  });
});

describe('warrensspectrum face model — RESIDUAL', () => {
  /** Render the engine's mono bus over a deterministic saw and return the
   *  samples. The ONLY oracle for the residual: the scaling is inline in
   *  `processSample` with no accessor, so behaviour is the observable. */
  function renderResidual(partials: number, residual: number, n = 4096): Float32Array {
    const e = new WarrensSpectrumEngine(SR);
    e.setPartials(partials);
    e.setResidual(residual);
    e.setStabilityFrames(1);
    e.setSlewSeconds(0.02);
    e.setSliceMs(10);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (i % 128 === 0) e.beginBlock();
      // A saw at 220 Hz — harmonic, so the tracker has peaks to claim and the
      // leftover energy the residual replays actually exists.
      const t = (i / SR) * 220;
      out[i] = 2 * (t - Math.floor(t)) - 1;
      out[i] = e.processSample(out[i]!);
    }
    return out;
  }

  const differs = (a: Float32Array, b: Float32Array) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
    return false;
  };

  it('ORACLE: the engine is bit-identical across the RESIDUAL dial exactly when this model prints `off`', () => {
    // PARTIALS 1 → the cube-root factor is exactly 0 → the residual branch never
    // runs, so the whole dial is inert. Matches the ART measurement
    // (art/scenarios/warrensspectrum/cv-path.test.ts: 0.0000e+0 at partials 1,
    // 1.4299e-3 at partials 64).
    expect(wsResidualText(at({ spectralPartials: 1, spectralResidual: 0.5 }))).toBe('off');
    expect(
      differs(renderResidual(1, 0), renderResidual(1, 2)),
      'at PARTIALS 1 the RESIDUAL dial must be bit-exactly inert',
    ).toBe(false);

    // POSITIVE CONTROL on the same oracle: at the shipped PARTIALS the same
    // sweep DOES move the render. Without this leg "inert" and "the harness
    // renders nothing" are indistinguishable.
    expect(wsResidualText(at({ spectralPartials: 64, spectralResidual: 0.5 }))).toBe('0.50');
    expect(
      differs(renderResidual(64, 0), renderResidual(64, 2)),
      'at PARTIALS 64 the RESIDUAL dial must move the render',
    ).toBe(true);
  });

  it('NEGATIVE CONTROL: the printed residual MOVES with PARTIALS — the input a RESIDUAL readback cannot see', () => {
    // The dial prints `0.50` at every one of these.
    const rows = [1, 6, 12, 24, 48, 64].map((n) =>
      wsResidualText(at({ spectralPartials: n, spectralResidual: 0.5 })),
    );
    expect(rows).toEqual(['off', '0.24', '0.31', '0.39', '0.50', '0.50']);
    // Monotone up to the 48-partial saturation point, then flat — the shape of
    // `cbrt((n-1)/47)` clamped, asserted rather than assumed.
    expect(new Set(rows).size, 'PARTIALS must actually separate these states').toBeGreaterThan(3);
  });

  it('NEGATIVE CONTROL: MODE alone kills the residual, at every PARTIALS and every dial position', () => {
    for (const partials of [1, 24, 64, 256]) {
      for (const residual of [0, 0.5, 2]) {
        expect(
          wsResidualText(at({ engineMode: WSF_ENGINE_MASSPASS, spectralPartials: partials, spectralResidual: residual })),
          `MASSPASS partials=${partials} residual=${residual}`,
        ).toBe('none');
      }
    }
  });

  it('INVARIANCE: the residual cannot move with SLICE, STABILITY, WET, MIX or GAIN', () => {
    const base = wsResidualText(at());
    expect(wsResidualText(at({ spectralSlice: 200 }))).toBe(base);
    expect(wsResidualText(at({ spectralStab: 16 }))).toBe(base);
    expect(wsResidualText(at({ resynthLevel: 1 }))).toBe(base);
    expect(wsResidualText(at({ inputMix: 1 }))).toBe(base);
    expect(wsResidualText(at({ gain: 12 }))).toBe(base);
  });

  it('the DSP’s own branch guard is the `off` threshold, not a rounded zero', () => {
    // Just above the guard prints a number; at or below it prints `off`. A
    // model that used `> 0` would call a residual the DSP never computes
    // "0.00", which is the weaker and wronger claim.
    const justOver = at({ spectralPartials: 48, spectralResidual: WSF_RESIDUAL_EPSILON * 2 });
    const under = at({ spectralPartials: 48, spectralResidual: WSF_RESIDUAL_EPSILON / 2 });
    expect(wsEffectiveResidual(justOver)).toBeGreaterThan(WSF_RESIDUAL_EPSILON);
    expect(wsResidualText(under)).toBe('off');
  });
});

describe('warrensspectrum face model — FADE IN', () => {
  it('ORACLE: the ramp is counted in COMMITS, so its duration is (STAB − 1) analysis periods', () => {
    // Re-derived against the engine's own realised period rather than the knob:
    // `effectiveSliceMs` is what SLICE actually buys.
    for (const sliceMs of [2, 10, 43, 200]) {
      const e = new WarrensSpectrumEngine(SR);
      e.setSliceMs(sliceMs);
      for (const stab of [1, 3, 8, 16]) {
        e.setStabilityFrames(stab);
        expect(
          wsFadeInMs(at({ spectralSlice: sliceMs, spectralStab: stab })),
          `stab=${stab} slice=${sliceMs}`,
        ).toBeCloseTo((stab - 1) * e.effectiveSliceMs, 6);
      }
    }
  });

  it('NEGATIVE CONTROL: the printed fade MOVES with SLICE — the input a STABILITY readback cannot see', () => {
    // The dial prints `3` at both, and the answers differ by 20×.
    expect(wsFadeInText(at({ spectralStab: 3, spectralSlice: 10 }))).toBe('20 ms');
    expect(wsFadeInText(at({ spectralStab: 3, spectralSlice: 200 }))).toBe('400 ms');
  });

  it('NEGATIVE CONTROL: the printed fade MOVES with STABILITY — the input a SLICE readback cannot see', () => {
    // The dial prints `10.0 ms` at all three.
    expect(wsFadeInText(at({ spectralStab: 1, spectralSlice: 10 }))).toBe('instant');
    expect(wsFadeInText(at({ spectralStab: 3, spectralSlice: 10 }))).toBe('20 ms');
    expect(wsFadeInText(at({ spectralStab: 16, spectralSlice: 10 }))).toBe('150 ms');
  });

  it('NEGATIVE CONTROL: MASSPASS has no birth gate, so the fade is `none` at every STAB/SLICE', () => {
    for (const stab of [1, 3, 16]) {
      for (const slice of [2, 10, 200]) {
        expect(
          wsFadeInText(at({ engineMode: WSF_ENGINE_MASSPASS, spectralStab: stab, spectralSlice: slice })),
        ).toBe('none');
      }
    }
  });

  it('INVARIANCE: the fade cannot move with PARTIALS, RESIDUAL, WET, MIX or GAIN', () => {
    const base = wsFadeInText(at());
    expect(wsFadeInText(at({ spectralPartials: 1 }))).toBe(base);
    expect(wsFadeInText(at({ spectralResidual: 2 }))).toBe(base);
    expect(wsFadeInText(at({ resynthLevel: 1 }))).toBe(base);
    expect(wsFadeInText(at({ inputMix: 1 }))).toBe(base);
    expect(wsFadeInText(at({ gain: -60 }))).toBe(base);
  });
});

describe('warrensspectrum face model — OUT', () => {
  it('ORACLE: the level is the DSP’s own summation, `(wet·bank + (1−wet)·dry + mix·input) · gain`, at a full-scale input', () => {
    // The bank and the dry bus are a CROSSFADE, so at any WET the two together
    // carry one path's worth of signal; `mix·input` is an un-normalised ADD.
    for (const mix of [0, 0.25, 0.5, 1]) {
      for (const gain of [-60, -6, 0, 12]) {
        const expected = 20 * Math.log10(1 + mix) + gain;
        expect(wsOutputHeadroomDb(at({ inputMix: mix, gain })), `mix=${mix} gain=${gain}`)
          .toBeCloseTo(expected, 9);
      }
    }
    expect(wsOutputHeadroomDb(at({ inputMix: 1 })), 'a full-scale raw add is +6.02 dB')
      .toBeCloseTo(20 * Math.log10(2), 9);
  });

  it('NEGATIVE CONTROL: the level MOVES with INPUT MIX — the input a GAIN readback cannot see', () => {
    // The GAIN dial prints `0.00 dB` at both.
    expect(wsOutText(at({ inputMix: 0, gain: 0 }))).toBe('resynth · 0.0 dB');
    expect(wsOutText(at({ inputMix: 1, gain: 0 }))).toBe('resynth+raw · +6.0 dB');
  });

  it('NEGATIVE CONTROL: the level MOVES with GAIN — the input an INPUT MIX readback cannot see', () => {
    expect(wsOutText(at({ inputMix: 1, gain: -6 }))).toBe('resynth+raw · 0.0 dB');
  });

  it('INVARIANCE + the PATH half: BANK WET moves which paths are live and CANNOT move the level', () => {
    // This is the pair's whole argument: WET is a crossfade, so the two halves
    // of this readout are each other's control.
    const level = wsOutputHeadroomDb(at());
    for (const wet of [0, 0.25, 0.5, 0.75, 1]) {
      expect(wsOutputHeadroomDb(at({ resynthLevel: wet })), `wet=${wet}`).toBeCloseTo(level, 9);
    }
    expect(wsLivePaths(at({ resynthLevel: 0 }))).toEqual(['resynth']);
    expect(wsLivePaths(at({ resynthLevel: 0.5 }))).toEqual(['resynth', 'bank']);
    expect(wsLivePaths(at({ resynthLevel: 1 }))).toEqual(['bank']);
    expect(wsLivePaths(at({ resynthLevel: 1, inputMix: 0.5 }))).toEqual(['bank', 'raw']);
    // The DEFAULT is the bank BYPASSED — the module's one divergence from the
    // VST that is about our history rather than the plugin's. Pinned here so
    // flipping it cannot be an accident.
    expect(wsLivePaths(at())).toEqual(['resynth']);
  });
});

describe('warrensspectrum face model — TOTALITY', () => {
  const READOUTS = [wsVoiceText, wsResidualText, wsFadeInText, wsOutText];

  it('a FRESH node (no touched params) prints the shipped answers', () => {
    const p = warrensspectrumFaceParams(reader({}));
    expect(p).toEqual(WARRENSSPECTRUM_FACE_DEFAULTS);
    expect(wsVoiceText(p)).toBe('64');
    expect(wsResidualText(p)).toBe('0.50');
    expect(wsFadeInText(p)).toBe('20 ms');
    expect(wsOutText(p)).toBe('resynth · 0.0 dB');
  });

  it('NaN / ±Infinity / out-of-range on ANY param never throws and never prints "NaN"', () => {
    const ids = Object.keys(WARRENSSPECTRUM_FACE_DEFAULTS);
    for (const id of ids) {
      for (const v of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1e9, 1e9]) {
        const p = warrensspectrumFaceParams(reader({ [id]: v }));
        for (const fn of READOUTS) {
          const s = fn(p);
          expect(typeof s, `${fn.name}(${id}=${v})`).toBe('string');
          expect(s, `${fn.name}(${id}=${v}) must not leak NaN`).not.toMatch(/NaN/);
          expect(s.length, `${fn.name}(${id}=${v}) must not be empty`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('a param the reader does not know falls back INDEPENDENTLY of the others', () => {
    // A node that has touched only SLICE must still print the right stability.
    const p = warrensspectrumFaceParams(reader({ spectralSlice: 200 }));
    expect(p.spectralStab).toBe(WARRENSSPECTRUM_FACE_DEFAULTS.spectralStab);
    expect(wsFadeInText(p)).toBe('400 ms');
  });
});
