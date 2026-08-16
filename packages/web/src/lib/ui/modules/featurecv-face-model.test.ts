// packages/web/src/lib/ui/modules/featurecv-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for FEATURECV's seven derived readouts, plus
// the face's own structural claims and the source table its sidebar picture
// draws.
//
// A derived readout earns its place only if it is negative-controlled on the
// input a KNOB readback would be blind to — permanently, not once at authoring
// time (module-faceplates.md, the kickdrum TAIL trap). This module's readouts
// carry FOUR independent controls, each asserted in both directions:
//
//   1. THE TWO PROBES. `idle` and `−12 dB` are the SAME function at two input
//      levels. `idle` is GAIN-INVARIANT (a trim on silence is silence) and
//      `−12 dB` is not, so each is the other's negative control on every
//      render — the unityscalemathematik arrangement (#1717), one module later.
//   2. THE TWO HALVES OF THE MODULE. The three continuous CVs and the ONSET
//      detector share NOTHING: the onset runs per-sample on the raw signal and
//      never touches the analysis window, the followers or the polarity map.
//      So GAIN/ATK/REL/POLARITY must move none of the two onset readouts, and
//      SENS/DEBNCE must move none of the five feature readouts. That is what
//      licenses two PAGES rather than one ranked list of six.
//   3. THE SMOOTHING PAIR. `atk rise` moves with ATTACK and is blind to
//      RELEASE; `rel fall` is the mirror.
//   4. THE DSP CONSTANTS. Every number the model publishes is derived from the
//      SHIPPING core (`packages/dsp/src/lib/featurecv-dsp`), and the sidebar's
//      source table is re-derived from the SHIPPING generators
//      (`noiseGenerators`) rather than trusted — because that table IS the
//      audit's finding about the crest calibration (#1745), and a finding
//      transcribed into a literal is a finding waiting to go stale.
//
// Plus a TOTALITY leg: the generators run on every render, so a throw takes the
// faceplate down mid-drag.

import { describe, expect, it } from 'vitest';
import { featurecvDef } from '$lib/audio/modules/featurecv';
import { faceReadoutValueFor } from '$lib/ui/workflow/face-readout-values';
import { sidebarPanelIds } from '$lib/ui/workflow/sidebar-panels';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import {
  crest,
  rms,
  zcr,
  CREST_MAX,
  CREST_MIN,
  FEATURE_WINDOW,
  ONSET_SENS_THRESH_MAX,
  ONSET_SENS_THRESH_MIN,
} from '../../../../../dsp/src/lib/featurecv-dsp';
import { noiseGenerators } from '../../../../../dsp/src/lib/noise-dsp';
import {
  FEATURECV_FEATURES,
  FEATURECV_GAIN_REACHES,
  FEATURECV_LOUD_CLIP_RMS,
  FEATURECV_PROBE_RMS,
  FEATURECV_SOURCES,
  ONE_POLE_10_90,
  featurecvAtkRiseText,
  featurecvBrightCv,
  featurecvClipText,
  featurecvFaceParams,
  featurecvIdleCv,
  featurecvIdleText,
  featurecvLoudCv,
  featurecvLoudClipDb,
  featurecvMaxRateText,
  featurecvMaxTrigHz,
  featurecvProbeText,
  featurecvPunchCv,
  featurecvRailFill,
  featurecvRelFallText,
  featurecvSourceCv,
  featurecvSourceStat,
  featurecvThreshMult,
  featurecvThreshText,
} from './featurecv-face-model';

/** A `read` over an explicit param map — the shape `FaceReadoutValue` takes. */
const reader =
  (over: Record<string, number> = {}) =>
  (id: string): number | undefined =>
    over[id];

const base = () => featurecvFaceParams(reader());

/** Every readout id the face declares, in declaration order — DERIVED off the
 *  def rather than typed, so a new readout enrols itself in the sweeps below. */
const DECLARED_READOUTS: readonly string[] = [
  ...(featurecvDef.face?.hero?.readouts ?? []),
  ...(featurecvDef.face?.sidebar ?? []).flatMap((b) => (b.kind === 'readouts' ? b.entries : [])),
]
  .map((r) => r.valueId)
  .filter((v): v is string => typeof v === 'string');

/** Print every declared readout at a given param overlay. */
const snapshot = (over: Record<string, number> = {}): Record<string, string> =>
  Object.fromEntries(DECLARED_READOUTS.map((id) => [id, faceReadoutValueFor(id)!(reader(over))]));

describe('featurecv face model — the shipped defaults', () => {
  it('resolves the def defaults for anything untouched', () => {
    // The fallbacks in the model must BE the def's defaults, not a second copy
    // that happens to agree today.
    const declared = Object.fromEntries(featurecvDef.params.map((p) => [p.id, p.defaultValue]));
    expect(base()).toEqual({
      gain: declared.gain,
      attack: declared.attack,
      release: declared.release,
      bipolar: declared.bipolar,
      onsetSens: declared.onset_sens,
      onsetDebounce: declared.onset_debounce,
    });
  });

  it('prints the numbers the docs and the def comment state', () => {
    expect(snapshot()).toEqual({
      // BIPOLAR default: silence maps to the BOTTOM rail, not the centre.
      'featurecv-idle': '−1.00',
      // −12.04 dBFS RMS × makeup 2 × gain 1 = 0.5 unipolar = 0.00 bipolar.
      'featurecv-probe': '0.00',
      // SENS 0.50 → 2.60× the running mean flux, and the map is INVERTED.
      'featurecv-thresh': '2.60×',
      // DEBNCE 80 ms → a 12.5 Hz ceiling on the trigger.
      'featurecv-max-rate': '12.5 Hz',
      // ATK/REL are one-pole TIME CONSTANTS; ln(9) ≈ 2.197× is the 10→90 move.
      'featurecv-atk-rise': '22 ms',
      'featurecv-rel-fall': '220 ms',
      // LOUD pins at full scale above rms 0.5 at unity trim.
      'featurecv-loud-clip': '-6.0 dBFS',
    });
  });
});

describe('CONTROL 1 — the two probes: `idle` is GAIN-blind and `−12 dB` is not', () => {
  it('GAIN moves the probe across its whole range and never moves idle', () => {
    const rows = [0.25, 0.5, 1, 2, 4].map((gain) => ({
      gain,
      idle: featurecvIdleText(featurecvFaceParams(reader({ gain }))),
      probe: featurecvProbeText(featurecvFaceParams(reader({ gain }))),
    }));
    // The probe rises monotonically until the clamp catches it…
    expect(rows.map((r) => r.probe)).toEqual(['−0.75', '−0.50', '0.00', '+1.00', '+1.00']);
    // …and idle does not move at all, at any trim. This is the leg that makes
    // "the jacks rest at the bottom rail" a property of POLARITY rather than of
    // whatever the trim happened to be.
    for (const r of rows) expect(r.idle, `GAIN ${r.gain} moved the idle level`).toBe('−1.00');
  });

  it('POLARITY moves BOTH, which is what makes it rank 1', () => {
    const bi = snapshot();
    const uni = snapshot({ bipolar: 0 });
    expect(uni['featurecv-idle']).toBe('0.00');
    expect(uni['featurecv-probe']).toBe('+0.50');
    expect(bi['featurecv-idle']).not.toBe(uni['featurecv-idle']);
    expect(bi['featurecv-probe']).not.toBe(uni['featurecv-probe']);
    // A FULL RAIL with nothing patched — the measurement the rank-1 argument
    // rests on. Every other control is inert on silence and this one is not.
    expect(featurecvIdleCv(base())).toBeCloseTo(-1, 9);
    expect(featurecvIdleCv(featurecvFaceParams(reader({ bipolar: 0 })))).toBeCloseTo(0, 9);
  });

  it('the CLAMP is a real ceiling, and `loud clip` is where it lands', () => {
    // Above the clip level the probe stops responding to the source entirely —
    // which is the fact the readout exists to publish.
    const hot = featurecvFaceParams(reader({ gain: 4 }));
    expect(featurecvLoudCv(FEATURECV_LOUD_CLIP_RMS / 4, hot)).toBeCloseTo(1, 9);
    expect(featurecvLoudCv(1.0, hot)).toBeCloseTo(1, 9);
    expect(featurecvLoudClipDb(hot)).toBeCloseTo(20 * Math.log10(FEATURECV_LOUD_CLIP_RMS / 4), 6);
    // 6.02 dB per doubling of the trim, asserted as a RELATION rather than a
    // table of numbers.
    for (const gain of [0.5, 1, 2, 4]) {
      const a = featurecvLoudClipDb(featurecvFaceParams(reader({ gain })));
      const b = featurecvLoudClipDb(featurecvFaceParams(reader({ gain: gain * 2 })));
      expect(a - b, `doubling GAIN from ${gain} must drop the clip level 6.02 dB`).toBeCloseTo(6.0206, 3);
    }
    // Below GAIN 0.5 the clamp needs an RMS above full scale, so the honest
    // answer is not a number.
    expect(featurecvClipText(featurecvFaceParams(reader({ gain: 0.25 })))).toBe('never');
    expect(featurecvClipText(featurecvFaceParams(reader({ gain: 0.5 })))).toBe('0.0 dBFS');
  });
});

describe('CONTROL 2 — the two halves of the module are independent, in both directions', () => {
  const FEATURE_READOUTS = [
    'featurecv-idle',
    'featurecv-probe',
    'featurecv-atk-rise',
    'featurecv-rel-fall',
    'featurecv-loud-clip',
  ] as const;
  const ONSET_READOUTS = ['featurecv-thresh', 'featurecv-max-rate'] as const;

  it('the two lists PARTITION the declared readouts — no readout is unwatched', () => {
    // Derived from the def so a new readout cannot slip past both sweeps below.
    expect([...FEATURE_READOUTS, ...ONSET_READOUTS].sort()).toEqual([...DECLARED_READOUTS].sort());
  });

  it('the FEATURE dials move no ONSET readout', () => {
    const before = snapshot();
    for (const [id, to] of [
      ['gain', 4],
      ['attack', 500],
      ['release', 2000],
      ['bipolar', 0],
    ] as const) {
      const after = snapshot({ [id]: to });
      for (const r of ONSET_READOUTS) {
        expect(after[r], `'${id}' → ${to} moved '${r}'`).toBe(before[r]);
      }
      // …and it moved at least one feature readout, so the sweep is not vacuous.
      expect(
        FEATURE_READOUTS.some((r) => after[r] !== before[r]),
        `'${id}' → ${to} moved NOTHING — the sweep is measuring nothing`,
      ).toBe(true);
    }
  });

  it('the ONSET dials move no FEATURE readout', () => {
    const before = snapshot();
    for (const [id, to] of [
      ['onset_sens', 1],
      ['onset_debounce', 1000],
    ] as const) {
      const after = snapshot({ [id]: to });
      for (const r of FEATURE_READOUTS) {
        expect(after[r], `'${id}' → ${to} moved '${r}'`).toBe(before[r]);
      }
      expect(
        ONSET_READOUTS.some((r) => after[r] !== before[r]),
        `'${id}' → ${to} moved NOTHING — the sweep is measuring nothing`,
      ).toBe(true);
    }
  });

  it('every declared param moves at least one readout — deny-by-default over the roster', () => {
    // The other half of the pair above. A dial that moves nothing on the
    // faceplate is either an un-modelled quantity or a dead control, and both
    // should be loud.
    const before = snapshot();
    const far: Record<string, number> = {
      gain: 4,
      attack: 500,
      release: 2000,
      bipolar: 0,
      onset_sens: 1,
      onset_debounce: 1000,
    };
    for (const p of featurecvDef.params) {
      const after = snapshot({ [p.id]: far[p.id]! });
      expect(after, `'${p.id}' moved no readout at all`).not.toEqual(before);
    }
  });
});

describe('CONTROL 3 — SENS is INVERTED and DEBNCE is a rate, and each is blind to the other', () => {
  it('turning SENS UP lowers the threshold multiplier, monotonically', () => {
    const rows = [0, 0.25, 0.5, 0.75, 1].map((onset_sens) => ({
      onset_sens,
      mult: featurecvThreshMult(featurecvFaceParams(reader({ onset_sens }))),
    }));
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.mult, `the multiplier must FALL as SENS rises: ${JSON.stringify(rows)}`).toBeLessThan(
        rows[i - 1]!.mult,
      );
    }
    // The ends come off the DSP's own constants, not from a second copy.
    expect(rows[0]!.mult).toBeCloseTo(ONSET_SENS_THRESH_MAX, 9);
    expect(rows[rows.length - 1]!.mult).toBeCloseTo(ONSET_SENS_THRESH_MIN, 9);
    expect(featurecvThreshText(featurecvFaceParams(reader({ onset_sens: 0 })))).toBe('4.00×');
    expect(featurecvThreshText(featurecvFaceParams(reader({ onset_sens: 1 })))).toBe('1.20×');
  });

  it('DEBNCE is the reciprocal, across the whole travel', () => {
    for (const onset_debounce of [20, 80, 250, 1000]) {
      const p = featurecvFaceParams(reader({ onset_debounce }));
      expect(featurecvMaxTrigHz(p)).toBeCloseTo(1000 / onset_debounce, 9);
    }
    expect(featurecvMaxRateText(featurecvFaceParams(reader({ onset_debounce: 20 })))).toBe('50.0 Hz');
    expect(featurecvMaxRateText(featurecvFaceParams(reader({ onset_debounce: 1000 })))).toBe('1.0 Hz');
  });
});

describe('CONTROL 4 — the smoothing pair, each blind to the other', () => {
  it('ATTACK moves `atk rise` and never `rel fall`, and vice versa', () => {
    const before = { atk: featurecvAtkRiseText(base()), rel: featurecvRelFallText(base()) };
    const atkMoved = featurecvFaceParams(reader({ attack: 500 }));
    expect(featurecvAtkRiseText(atkMoved)).not.toBe(before.atk);
    expect(featurecvRelFallText(atkMoved)).toBe(before.rel);
    const relMoved = featurecvFaceParams(reader({ release: 2000 }));
    expect(featurecvRelFallText(relMoved)).not.toBe(before.rel);
    expect(featurecvAtkRiseText(relMoved)).toBe(before.atk);
  });

  it('the delivered move is ln(9) × the printed time constant, at every setting', () => {
    // The claim the readout exists for: the dial is NOT a rise time, and the
    // ratio is a constant of the one-pole rather than of any particular dial
    // position.
    expect(ONE_POLE_10_90).toBeCloseTo(2.1972, 4);
    for (const attack of [0.5, 10, 120, 500]) {
      const p = featurecvFaceParams(reader({ attack }));
      expect(featurecvAtkRiseText(p)).toBe(
        attack * ONE_POLE_10_90 >= 10
          ? `${Math.round(attack * ONE_POLE_10_90)} ms`
          : `${(attack * ONE_POLE_10_90).toFixed(1)} ms`,
      );
    }
  });
});

describe('the SIDEBAR SOURCE TABLE is re-derived from the SHIPPING generators (#1745)', () => {
  /** The last analysis window of a signal — exactly what the extractor sees. */
  const lastWindow = (sig: Float32Array): Float32Array => sig.subarray(sig.length - FEATURE_WINDOW);
  const SR = 48000;
  const SEED = 0xc0ffee;

  const measured: Record<string, { rms: number; zcr: number; crest: number }> = (() => {
    const out: Record<string, { rms: number; zcr: number; crest: number }> = {};
    for (const flavor of ['white', 'pink', 'brown'] as const) {
      const w = lastWindow(noiseGenerators[flavor](SR, SEED));
      out[flavor] = { rms: rms(w), zcr: zcr(w), crest: crest(w) };
    }
    const n = SR;
    const sine = new Float32Array(n);
    for (let i = 0; i < n; i++) sine[i] = 0.8 * Math.sin((2 * Math.PI * 1000 * i) / SR);
    const sw = lastWindow(sine);
    out.sine = { rms: rms(sw), zcr: zcr(sw), crest: crest(sw) };
    return out;
  })();

  it('every marker on the picture matches the generator it names, to 3 decimals', () => {
    for (const src of FEATURECV_SOURCES) {
      const m = measured[src.id];
      expect(m, `no generator measured for source '${src.id}'`).toBeTruthy();
      expect(src.rms, `${src.id} rms`).toBeCloseTo(m!.rms, 3);
      expect(src.zcr, `${src.id} zcr`).toBeCloseTo(m!.zcr, 3);
      expect(src.crest, `${src.id} crest`).toBeCloseTo(m!.crest, 3);
    }
  });

  it('THE FINDING ITSELF: uniform white noise lands PUNCH at the BOTTOM of the rail, not the middle', () => {
    // The DSP comment used to promise "white noise (~3.5) → ~0.5". √3 ≈ 1.732
    // is the crest of a UNIFORM distribution and is INDEPENDENT of window
    // length, which is why no longer window rescues the old figure.
    expect(measured.white!.crest).toBeCloseTo(Math.sqrt(3), 1);
    const uni = featurecvFaceParams(reader({ bipolar: 0 }));
    const white = FEATURECV_SOURCES.find((s) => s.id === 'white')!;
    expect(featurecvPunchCv(white.crest, uni)).toBeLessThan(0.2);
    expect(featurecvPunchCv(white.crest, base())).toBeLessThan(-0.6);
    // And the ordering the old comment implied is BACKWARDS: pink and brown are
    // the peakier taps here.
    for (const id of ['pink', 'brown'] as const) {
      expect(measured[id]!.crest, `${id} must be peakier than white`).toBeGreaterThan(measured.white!.crest);
    }
  });

  it('GAIN reaches exactly ONE of the three rails, bit-exactly', () => {
    // The claim the panel's `no gain` caption makes, and the docs correction
    // (#1746 sibling): ZCR counts sign changes and crest is a ratio, so a trim
    // in front of the analyser cannot move either.
    for (const src of FEATURECV_SOURCES) {
      for (const gain of [0.25, 1, 4]) {
        const p = featurecvFaceParams(reader({ gain }));
        expect(featurecvBrightCv(src.zcr, p)).toBe(featurecvBrightCv(src.zcr, base()));
        expect(featurecvPunchCv(src.crest, p)).toBe(featurecvPunchCv(src.crest, base()));
      }
    }
    // …and the one it DOES reach really moves.
    const white = FEATURECV_SOURCES.find((s) => s.id === 'white')!;
    expect(featurecvLoudCv(white.rms, featurecvFaceParams(reader({ gain: 0.25 })))).not.toBe(
      featurecvLoudCv(white.rms, base()),
    );
    expect([...FEATURECV_GAIN_REACHES]).toEqual(['loud']);
  });

  it('the FEATURE roster is the def OUTPUT roster minus the trigger, derived both ways', () => {
    const cvOuts = featurecvDef.outputs.filter((o) => o.type === 'cv').map((o) => o.id);
    expect([...FEATURECV_FEATURES].sort()).toEqual([...cvOuts].sort());
    // The gate output is NOT a rail — it has no level to draw.
    expect(FEATURECV_FEATURES as readonly string[]).not.toContain('onset');
  });

  it('every rail FILL is inside [0,1] for every source at every polarity and trim', () => {
    for (const feature of FEATURECV_FEATURES) {
      for (const src of FEATURECV_SOURCES) {
        const overlays: Record<string, number>[] = [{}, { bipolar: 0 }, { gain: 0.25 }, { gain: 4 }];
        for (const over of overlays) {
          const p = featurecvFaceParams(reader(over));
          const fill = featurecvRailFill(featurecvSourceCv(feature, src, p), p);
          expect(fill, `${feature}/${src.id} @ ${JSON.stringify(over)}`).toBeGreaterThanOrEqual(0);
          expect(fill).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('the crest map is calibrated on the DSP\'s own window, not a re-typed one', () => {
    expect(CREST_MIN).toBe(1);
    expect(CREST_MAX).toBe(6);
    // A sine is the map's stated anchor and it is the value the docs quote.
    const sine = FEATURECV_SOURCES.find((s) => s.id === 'sine')!;
    expect(featurecvSourceStat('punch', sine)).toBeCloseTo(Math.SQRT2, 1);
    expect(featurecvPunchCv(sine.crest, featurecvFaceParams(reader({ bipolar: 0 })))).toBeCloseTo(0.082, 2);
  });
});

describe('TOTALITY — the generators run on every render', () => {
  it('survives a fresh node, NaN and ±Infinity on every param', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0]) {
      for (const p of featurecvDef.params) {
        for (const id of DECLARED_READOUTS) {
          const out = faceReadoutValueFor(id)!(reader({ [p.id]: bad }));
          expect(typeof out, `'${id}' at ${p.id}=${bad}`).toBe('string');
          expect(out.length, `'${id}' at ${p.id}=${bad} printed nothing`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('a fresh node with NO stored params prints the same as the def defaults', () => {
    // `node.params` is a SPARSE overlay of what has been TOUCHED — the
    // StereoCrossoverPanel scar. A reader that returns undefined for everything
    // must resolve the def, not zero.
    expect(Object.fromEntries(DECLARED_READOUTS.map((id) => [id, faceReadoutValueFor(id)!(() => undefined)]))).toEqual(
      snapshot(),
    );
  });

  it('a rail fill on a NaN CV is 0, never NaN — the panel must not paint `NaNpx`', () => {
    expect(featurecvRailFill(Number.NaN, base())).toBe(0);
    expect(featurecvRailFill(Number.POSITIVE_INFINITY, base())).toBe(1);
    expect(featurecvSourceCv('loud' as never, { id: 'x', label: 'x', rms: Number.NaN, zcr: 0, crest: 1 }, base()))
      .toBeNaN();
  });
});

describe('the FACE itself', () => {
  const face = featurecvDef.face!;

  it('is promoted, and every readout it declares is registered', () => {
    expect(STRICT_FACES.has('featurecv')).toBe(true);
    expect(DECLARED_READOUTS.length).toBeGreaterThan(0);
    for (const id of DECLARED_READOUTS) {
      expect(faceReadoutValueFor(id), `readout '${id}' is not registered`).toBeTruthy();
    }
  });

  it("declares glyph 'none' BECAUSE the module publishes no audio output", () => {
    // ⚠ THE MARBLES DEFECT (#1692), asserted at its cause rather than at its
    // symptom. `primaryAudioOutPortId` matches `type === 'audio'`; this module
    // declares three `cv` outputs and one `gate`, so any other glyph would
    // resolve to `{ kind: 'static' }` — a live-looking readout of nothing that a
    // VRT baseline captures perfectly deterministically and therefore cannot
    // see.
    expect(primaryAudioOutPortId(featurecvDef)).toBeNull();
    expect(face.glyph).toBe('none');
    expect(glyphBinding(featurecvDef).kind).toBe('none');
    // NEGATIVE CONTROL, both directions, against the REAL resolver.
    for (const glyph of ['scope', 'meter', 'envelope', 'waveform'] as const) {
      const withGlyph = { ...featurecvDef, face: { ...face, glyph } };
      expect(glyphBinding(withGlyph).kind, `'${glyph}' must resolve DEAD on this def`).toBe('static');
    }
    const withAudio = {
      ...featurecvDef,
      face: { ...face, glyph: 'meter' as const },
      outputs: [...featurecvDef.outputs, { id: 'audio', type: 'audio' as const }],
    };
    expect(glyphBinding(withAudio).kind).toBe('live-audio');
  });

  it('THE CV AUDIT IS VACUOUS BY CONSTRUCTION, and this is the leg that says so', () => {
    // The Q12 precedent: state the absence rather than running a null sweep
    // that passes. The #1661/#1662/#1664 rig drives `paramTarget` inputs; this
    // module has none, and exactly one input of any kind.
    expect(featurecvDef.inputs.filter((i) => i.paramTarget)).toEqual([]);
    expect(featurecvDef.inputs.filter((i) => i.type === 'cv')).toEqual([]);
    expect(featurecvDef.inputs.map((i) => i.id)).toEqual(['in']);
    // Goes RED the day someone adds one without an audit.
    expect(featurecvDef.inputs.length).toBe(featurecvDef.inputs.filter((i) => i.type === 'audio').length);
  });

  it('ranks POLARITY first, on the one property that is not conditional', () => {
    // The ranking argument, asserted rather than left in a comment. POLARITY is
    // the only param that changes an output level with NOTHING patched, because
    // every other one acts on a measurement of a signal that is not there.
    expect(face.order[0]).toBe('bipolar');
    expect(face.order[face.order.length - 1]).toBe('onset_debounce');
    // The measurable form of "unconditional": at silence, only POLARITY moves
    // the jack.
    const at = (over: Record<string, number>) => featurecvIdleCv(featurecvFaceParams(reader(over)));
    for (const id of ['gain', 'attack', 'release', 'onset_sens', 'onset_debounce']) {
      expect(at({ [id]: 4 }), `'${id}' moved an idle jack`).toBe(at({}));
    }
    expect(at({ bipolar: 0 })).not.toBe(at({}));
  });

  it('pages partition the params by ENGINE, which is what the rear card projects', () => {
    const paged = (face.pages ?? []).flatMap((pg) => pg.controls);
    expect([...paged].sort()).toEqual(featurecvDef.params.map((p) => p.id).sort());
    // The `onset` page is exactly the params whose ids name the onset detector,
    // read off the id rather than listed.
    const onsetPage = (face.pages ?? []).find((pg) => pg.id === 'onset')!;
    expect([...onsetPage.controls].sort()).toEqual(
      featurecvDef.params.filter((p) => p.id.startsWith('onset_')).map((p) => p.id).sort(),
    );
  });

  it('declares the maps panel, and the panel is registered', () => {
    const custom = (face.sidebar ?? []).filter((b) => b.kind === 'custom');
    expect(custom.map((b) => (b as { panelId: string }).panelId)).toEqual(['featurecv-maps']);
    expect(sidebarPanelIds()).toContain('featurecv-maps');
  });

  it('POLARITY keeps the card\'s UNI/BI vocabulary through a declared options roster', () => {
    // Undeclared, a 0..1 discrete param renders as an anonymous Toggle printing
    // 0/1 where the card has always printed UNI/BI. `ParamOption` is cosmetic,
    // so this costs no contract movement.
    const bipolar = featurecvDef.params.find((p) => p.id === 'bipolar')!;
    expect(bipolar.curve).toBe('discrete');
    expect(bipolar.options?.map((o) => o.label)).toEqual(['UNI', 'BI']);
    for (const o of bipolar.options ?? []) {
      expect(o.value).toBeGreaterThanOrEqual(bipolar.min);
      expect(o.value).toBeLessThanOrEqual(bipolar.max);
    }
  });

  it('the model reads only params the def declares', () => {
    const declared = new Set(featurecvDef.params.map((p) => p.id));
    for (const id of ['gain', 'attack', 'release', 'bipolar', 'onset_sens', 'onset_debounce']) {
      expect(declared.has(id), `the model reads '${id}', which the def must declare`).toBe(true);
    }
    // The probe level must sit BELOW the clamp at unity trim, or the `−12 dB`
    // readout would print the same string across most of the GAIN travel and
    // the two-probe arrangement would collapse into one.
    expect(FEATURECV_PROBE_RMS).toBeLessThan(FEATURECV_LOUD_CLIP_RMS);
  });
});
