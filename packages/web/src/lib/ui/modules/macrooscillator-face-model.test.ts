// packages/web/src/lib/ui/modules/macrooscillator-face-model.test.ts
//
// THE FACE'S CLAIMS, ANCHORED TO THE ARTIFACT.
//
// ⚠ THIS FILE IS NOT A TABLE TEST. Every shape claim the engine roster makes —
// "HARMONICS is 8 buckets on FM 2OP", "WAVETABLE's MORPH is dead below 0.5",
// "MODAL's TIMBRE runs backwards", "MODAL is 76.6 dB below FM 2OP" — is
// RE-DERIVED here from `macrooscillatorMath`, the same pure-math mirror the
// unit suite and the ART scenario drive. The roster is the FACE's claim; the
// mirror is the ARTIFACT; this file is what stops them drifting.
//
// The direction that matters is the SECOND one. It is obvious that a face
// should go red if it under-claims. What is easy to miss is that four of these
// readouts report a DEFECT, so the day someone fixes WAVETABLE's dead morph
// half in the worklet, `inertBelow: 0.5` stops being true — and a faceplate
// that keeps telling you a control is dead after it has been repaired is the
// same defect pointed the other way. These assertions fail in BOTH directions
// because they compare against renders, not against themselves.
//
// ⚠ AND THE INSTRUMENT IS NEGATIVE-CONTROLLED ON EVERY RUN, PERMANENTLY. The
// first build of this face reported three LIVE macros as bit-exactly dead
// because its analysis window (4096 samples, 85 ms) was SHORTER THAN MODAL's
// own 250 ms impulse period. That reading was confident, reproducible and
// false. The window is now 15360 samples for MODAL, and the false reading is
// pinned below as a permanent leg — so a future "simplify the window" edit
// re-manufactures the wrong answer and this file says so, instead of the wrong
// answer quietly becoming the roster.

import { describe, it, expect } from 'vitest';
import { macrooscillatorMath } from '$lib/audio/modules/macrooscillator';
import {
  MACRO_ENGINES,
  macroBucket,
  type MacroEngine,
} from '$lib/audio/modules/macro-engine-roster';
import {
  MACRO_LEVEL_SPREAD_DB,
  MACRO_LOUDEST_DB,
  MACRO_MEASURED_LEVEL,
  MACRO_STRUCK_COUNT,
  fmtMacroDb,
  fmtMacroGain,
  macroAliasText,
  macroAuxOffsetDb,
  macroAuxText,
  macroFaceParams,
  macroHarmonicsText,
  macroHeroTrace,
  macroHeroWarmup,
  macroLevelVsLoudestDb,
  macroMorphText,
  macroOutLevelDb,
  macroStrikeText,
  macroTimbreText,
  type MacroFaceParams,
} from './macrooscillator-face-model';

// ── THE MEASUREMENT CONDITIONS ──────────────────────────────────────────────
// Stated once, cited everywhere. The roster's dB figures were taken at exactly
// these, so a test that used different ones would be comparing two different
// experiments and calling the difference a regression.
const SR = 48000;
const MEASURE_PITCH_V = 0.75; // 440 Hz
const MEASURE_WINDOW = 24000; // 500 ms — the window the roster's dB came from

/** The window a SHAPE probe uses. 4096 (85 ms) everywhere except MODAL, whose
 *  exciter is a fixed 4 Hz impulse train — see the header. */
function shapeWindow(e: MacroEngine): number {
  return e.name === 'MODAL' ? 15360 : 4096;
}

const DEFAULTS: MacroFaceParams = {
  model: 0, note: 0, harmonics: 0.3, timbre: 0.3, morph: 0.5, level: 0.8,
};

function render(p: Partial<MacroFaceParams>, n: number) {
  const q = { ...DEFAULTS, ...p };
  return macrooscillatorMath.render(n, SR, MEASURE_PITCH_V, q);
}

const rms = (a: Float32Array): number => {
  let s = 0;
  for (const v of a) s += v * v;
  return Math.sqrt(s / a.length);
};
const db = (x: number): number => 20 * Math.log10(Math.max(x, 1e-12));
const maxAbsDiff = (a: Float32Array, b: Float32Array): number => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
};

/** Render one engine at one value of one axis, everything else at defaults. */
function axisRender(e: MacroEngine, axis: 'harmonics' | 'timbre' | 'morph', v: number): Float32Array {
  return render({ model: e.index, [axis]: v }, shapeWindow(e)).main;
}

const AXES = ['harmonics', 'timbre', 'morph'] as const;

// ─────────────────────────────────────────────────────────────────────────────
describe('macrooscillator face model — the roster is ANCHORED to the DSP mirror', () => {
  it('the roster covers exactly the fourteen engines, indexed by `model`', () => {
    expect(MACRO_ENGINES).toHaveLength(14);
    expect(MACRO_ENGINES.map((e) => e.index)).toEqual([...Array(14).keys()]);
    // Names are what MACSEQ, the card and the MODEL selector all print, so a
    // duplicate would make two engines indistinguishable in three places.
    expect(new Set(MACRO_ENGINES.map((e) => e.name)).size).toBe(14);
  });

  // ── SHAPE: 'stepped' ──────────────────────────────────────────────────────
  //
  // The claim is "N buckets and NOTHING in between", and the honest test of it
  // is two-sided: identical INSIDE a bucket (which a readout tracking the
  // fader would fail) and different ACROSS the boundary (which a readout stuck
  // on the engine would fail).
  const stepped = MACRO_ENGINES.flatMap((e) =>
    AXES.filter((a) => e[a].shape.kind === 'stepped').map((a) => ({ e, a })),
  );
  it.each(stepped.map(({ e, a }) => [e.name, a, e, a] as const))(
    '%s %s is STEPPED — identical inside a bucket, different across the boundary',
    (_n, _ax, e, axis) => {
      const s = e[axis].shape;
      if (s.kind !== 'stepped') throw new Error('unreachable');
      const N = s.steps;
      for (let k = 0; k < N; k++) {
        // Two DIFFERENT values inside bucket k: just past its floor, and just
        // under its ceiling. Co-prime-ish offsets rather than the centre, so a
        // probe cannot alias onto a boundary.
        const lo = (k + 0.07) / N;
        const hi = (k + 0.93) / N;
        expect(macroBucket(lo, N), `bucket of ${lo}`).toBe(k);
        expect(macroBucket(hi, N), `bucket of ${hi}`).toBe(k);
        expect(
          maxAbsDiff(axisRender(e, axis, lo), axisRender(e, axis, hi)),
          `${e.name} ${axis}: ${lo.toFixed(3)} and ${hi.toFixed(3)} are both bucket ${k} of ${N}, so the render must be BIT-IDENTICAL — a fader that moved here would mean the roster's 'stepped' claim is wrong`,
        ).toBe(0);
        if (k + 1 < N) {
          const next = (k + 1.07) / N;
          expect(
            maxAbsDiff(axisRender(e, axis, hi), axisRender(e, axis, next)),
            `${e.name} ${axis}: crossing from bucket ${k} to ${k + 1} must CHANGE the render`,
          ).toBeGreaterThan(0);
        }
      }
    },
  );

  // ── SHAPE: 'blend' ────────────────────────────────────────────────────────
  //
  // WAVETABLE's HARMONICS is the one the batch-3 spec got wrong: it called
  // HARMONICS "a quantiser in FIVE engines" and counted this one. It is a
  // genuine interpolation across the 8 frames, so the readout says WHERE
  // between two frames you are rather than printing a bucket index.
  const blended = MACRO_ENGINES.flatMap((e) =>
    AXES.filter((a) => e[a].shape.kind === 'blend').map((a) => ({ e, a })),
  );
  it.each(blended.map(({ e, a }) => [e.name, a, e, a] as const))(
    '%s %s is a BLEND, not a quantiser — every probe renders differently',
    (_n, _ax, e, axis) => {
      const s = e[axis].shape;
      if (s.kind !== 'blend') throw new Error('unreachable');
      // Probes INSIDE what would be one bucket if this were stepped. If the
      // roster were wrong and this were quantised, these would be identical.
      const inOneBucket = [0.02, 0.06, 0.1];
      for (let i = 1; i < inOneBucket.length; i++) {
        expect(
          maxAbsDiff(axisRender(e, axis, inOneBucket[0]!), axisRender(e, axis, inOneBucket[i]!)),
          `${e.name} ${axis}: ${inOneBucket[0]} vs ${inOneBucket[i]} must differ — they sit inside one frame of ${s.frames}, so identical renders would mean this axis is STEPPED and the roster says 'blend'`,
        ).toBeGreaterThan(0);
      }
    },
  );

  // ── SHAPE: 'inertBelow' — THE DEFECT ──────────────────────────────────────
  const inert = MACRO_ENGINES.flatMap((e) =>
    AXES.filter((a) => e[a].shape.kind === 'inertBelow').map((a) => ({ e, a })),
  );
  it('exactly ONE axis is declared inert, and it is WAVETABLE morph', () => {
    expect(inert.map(({ e, a }) => `${e.name}.${a}`)).toEqual(['WAVETABLE.morph']);
  });
  it.each(inert.map(({ e, a }) => [e.name, a, e, a] as const))(
    '%s %s is BIT-EXACTLY DEAD up to its threshold and live above it',
    (_n, _ax, e, axis) => {
      const s = e[axis].shape;
      if (s.kind !== 'inertBelow') throw new Error('unreachable');
      const t = s.threshold;
      const base = axisRender(e, axis, 0);
      // ⚠ THE THRESHOLD IS INCLUSIVE. The worklet guards on `morph < 0.5`, so
      // 0.5 itself is still dead and 0.5001 is the first live value. An
      // exclusive reading would put the boundary one step off and the readout
      // would call a live control dead.
      for (const v of [0.1, t / 2, t * 0.98, t]) {
        expect(
          maxAbsDiff(base, axisRender(e, axis, v)),
          `${e.name} ${axis} at ${v}: must be bit-identical to 0 — the roster claims DEAD up to and INCLUDING ${t}`,
        ).toBe(0);
      }
      expect(
        maxAbsDiff(base, axisRender(e, axis, t + 0.0001)),
        `${e.name} ${axis}: must come alive immediately past ${t}. If this is 0 the dead zone is BIGGER than the roster says and the readout under-reports it`,
      ).toBeGreaterThan(0);
      expect(maxAbsDiff(base, axisRender(e, axis, 1))).toBeGreaterThan(0);
    },
  );

  // ── SHAPE: 'inverted' — THE DEFECT ────────────────────────────────────────
  const inverted = MACRO_ENGINES.flatMap((e) =>
    AXES.filter((a) => e[a].shape.kind === 'inverted').map((a) => ({ e, a })),
  );
  it('exactly ONE axis is declared inverted, and it is MODAL timbre', () => {
    expect(inverted.map(({ e, a }) => `${e.name}.${a}`)).toEqual(['MODAL.timbre']);
  });
  it.each(inverted.map(({ e, a }) => [e.name, a, e, a] as const))(
    '%s %s is MONOTONICALLY QUIETER as it rises',
    (_n, _ax, e, axis) => {
      const levels = [0, 0.25, 0.5, 0.75, 1].map((v) => db(rms(axisRender(e, axis, v))));
      for (let i = 1; i < levels.length; i++) {
        expect(
          levels[i]!,
          `${e.name} ${axis}: level at step ${i} (${levels[i]!.toFixed(1)} dBFS) must be BELOW step ${i - 1} (${levels[i - 1]!.toFixed(1)} dBFS) — the roster claims this control runs backwards, and if it no longer does the readout is lying`,
        ).toBeLessThan(levels[i - 1]!);
      }
      // And the size of it, so a fix that merely flattens the curve is caught.
      expect(levels[0]! - levels[4]!, `${e.name} ${axis}: total inversion span`).toBeGreaterThan(10);
    },
  );

  // ── SHAPE: 'continuous' ───────────────────────────────────────────────────
  it('every axis the roster calls CONTINUOUS actually moves at small steps', () => {
    const bad: string[] = [];
    for (const e of MACRO_ENGINES) {
      for (const axis of AXES) {
        if (e[axis].shape.kind !== 'continuous') continue;
        // Two probes 5 % apart, off-centre so neither lands on a round number.
        const a = axisRender(e, axis, 0.41);
        const b = axisRender(e, axis, 0.46);
        if (maxAbsDiff(a, b) === 0) bad.push(`${e.name}.${axis}`);
      }
    }
    expect(
      bad.join(', '),
      'axes the roster calls CONTINUOUS that render identically 5 % apart — either they are stepped/inert (fix the roster, the readout is lying) or the window is too short to see them (fix the window, see the header)',
    ).toBe('');
  });

  // ── THE INSTRUMENT'S OWN NEGATIVE CONTROL, PERMANENT ─────────────────────
  it('NEGATIVE CONTROL (instrument): a SHORT window reports MODAL\'s live macros as dead', () => {
    const modal = MACRO_ENGINES.find((e) => e.name === 'MODAL')!;
    // The exact false reading the first build of this face shipped on.
    const SHORT = 4096;
    const shortRender = (v: number): Float32Array =>
      macrooscillatorMath.render(SHORT, SR, MEASURE_PITCH_V, { ...DEFAULTS, model: modal.index, timbre: v }).main;
    expect(
      maxAbsDiff(shortRender(0), shortRender(1)),
      'a 4096-sample window must still read MODAL as bit-exactly dead. If this is NON-ZERO the engine has changed and the 15360-sample window this file uses may no longer be measuring what it thinks — re-derive it rather than adjusting this number.',
    ).toBe(0);
    // …and the window this file actually uses does NOT.
    expect(
      maxAbsDiff(axisRender(modal, 'timbre', 0), axisRender(modal, 'timbre', 1)),
      `the ${shapeWindow(modal)}-sample window MUST see the same control the 4096 one calls dead — that difference is the entire reason for the per-engine window`,
    ).toBeGreaterThan(0);
    // The cause, stated as a number rather than as prose.
    const r = macrooscillatorMath.render(MEASURE_WINDOW, SR, MEASURE_PITCH_V, { ...DEFAULTS, model: modal.index }).main;
    let first = -1;
    for (let i = 0; i < r.length; i++) if (r[i] !== 0) { first = i; break; }
    expect(first, 'MODAL first non-zero sample (a fixed 4 Hz impulse train)').toBe(11999);
    expect(first).toBeGreaterThan(SHORT);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('macrooscillator face model — the LEVEL figures are re-measured, not remembered', () => {
  it('every roster outRmsDb / auxRmsDb matches a fresh render', () => {
    const drift: string[] = [];
    for (const e of MACRO_ENGINES) {
      const r = macrooscillatorMath.render(MEASURE_WINDOW, SR, MEASURE_PITCH_V, {
        ...DEFAULTS, model: e.index, level: MACRO_MEASURED_LEVEL,
      });
      const out = db(rms(r.main));
      const aux = db(rms(r.aux));
      if (Math.abs(out - e.outRmsDb) > 0.15) drift.push(`${e.name} OUT: roster ${e.outRmsDb} vs measured ${out.toFixed(1)}`);
      if (Math.abs(aux - e.auxRmsDb) > 0.15) drift.push(`${e.name} AUX: roster ${e.auxRmsDb} vs measured ${aux.toFixed(1)}`);
    }
    expect(
      drift.join('\n'),
      `roster level figures have drifted from the DSP. These are MEASUREMENTS, not law — if the change is intentional, re-measure at ${MEASURE_WINDOW} samples / ${SR} Hz / pitch ${MEASURE_PITCH_V} V and update macro-engine-roster.ts. If it is NOT intentional it is an audio regression.`,
    ).toBe('');
  });

  it('the spread between engines is the 76.6 dB the face claims, and MODAL is the floor', () => {
    expect(MACRO_LEVEL_SPREAD_DB).toBeGreaterThan(70);
    expect(MACRO_LOUDEST_DB).toBeCloseTo(-5.0, 1);
    const quietest = [...MACRO_ENGINES].sort((a, b) => a.outRmsDb - b.outRmsDb)[0]!;
    expect(quietest.name).toBe('MODAL');
  });

  it('five of the fourteen engines are silent unpatched, and the audition exists for them', () => {
    expect(MACRO_STRUCK_COUNT).toBe(5);
    expect(MACRO_ENGINES.filter((e) => e.needsStrike).map((e) => e.name).sort()).toEqual(
      ['FM 6OP', 'HIHAT', 'KICK', 'SNARE', 'STRING'],
    );
  });

  it('exactly one engine is band-limited', () => {
    expect(MACRO_ENGINES.filter((e) => e.bandLimited).map((e) => e.name)).toEqual(['VA']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('macrooscillator face model — the readouts, and what each is NOT', () => {
  const read = (p: Partial<MacroFaceParams>) => macroFaceParams((id) => (p as Record<string, number>)[id]);

  it('macroFaceParams resolves DEF DEFAULTS for anything untouched', () => {
    // `node.params` is a sparse overlay; reading it bare prints 0 for every
    // dial nobody has moved, which on this module means MODEL 0 / LEVEL 0 —
    // i.e. a silent VA — beside dials showing their real defaults.
    const p = read({});
    expect(p).toEqual({ model: 0, note: 0, harmonics: 0.3, timbre: 0.3, morph: 0.5, level: 0.8 });
  });

  // ── harmonics ─────────────────────────────────────────────────────────────
  it('NEGATIVE CONTROL (harmonics): MODEL changes it while the FADER does not move', () => {
    const h = 0.3;
    const texts = MACRO_ENGINES.map((e) => macroHarmonicsText(read({ model: e.index, harmonics: h })));
    // A `paramId: 'harmonics'` readout would print the identical `0.30` in all
    // fourteen. This is the whole argument for the derived readout.
    expect(new Set(texts).size, `harmonics readout across 14 engines at a FIXED fader: ${texts.join(' | ')}`).toBeGreaterThanOrEqual(8);
  });

  it('SECOND LEG (harmonics): inside a bucket the FADER moves and the readout does NOT', () => {
    // FM 2OP, 8 buckets. 0.80 and 0.87 are both bucket 6 — a readout that
    // moved here would be echoing the fader rather than the engine.
    const fm2 = MACRO_ENGINES.find((e) => e.name === 'FM 2OP')!;
    expect(macroBucket(0.8, 8)).toBe(6);
    expect(macroBucket(0.87, 8)).toBe(6);
    expect(macroHarmonicsText(read({ model: fm2.index, harmonics: 0.8 }))).toBe(
      macroHarmonicsText(read({ model: fm2.index, harmonics: 0.87 })),
    );
    // …and it DOES move across the boundary.
    expect(macroHarmonicsText(read({ model: fm2.index, harmonics: 0.8 }))).not.toBe(
      macroHarmonicsText(read({ model: fm2.index, harmonics: 0.9 })),
    );
  });

  it('the top bucket is DOUBLE WIDTH and the readout reports it honestly', () => {
    // `floor(1.0 * 8)` = 8 overflows and clamps to 7, so 0.875 and 1.000 are
    // the same bucket — measured, and the reason the readout prints the bucket
    // rather than the fader.
    const fm2 = MACRO_ENGINES.find((e) => e.name === 'FM 2OP')!;
    expect(macroHarmonicsText(read({ model: fm2.index, harmonics: 0.875 }))).toBe(
      macroHarmonicsText(read({ model: fm2.index, harmonics: 1.0 })),
    );
    expect(macroHarmonicsText(read({ model: fm2.index, harmonics: 1.0 }))).toContain('8/8');
  });

  // ── timbre / morph ────────────────────────────────────────────────────────
  it('NEGATIVE CONTROL (timbre + morph): both move on MODEL and NEITHER moves on the OTHER axis', () => {
    const base = read({ model: 4, timbre: 0.3, morph: 0.5 });
    const otherEngine = read({ model: 12, timbre: 0.3, morph: 0.5 });
    expect(macroTimbreText(base)).not.toBe(macroTimbreText(otherEngine));
    expect(macroMorphText(base)).not.toBe(macroMorphText(otherEngine));
    // CHORD's timbre + morph are both continuous, so their readouts are a
    // function of `model` ALONE — a readout that reacted to the knob it labels
    // is the failure mode here, not the success case.
    expect(macroTimbreText(read({ model: 4, timbre: 0.9, morph: 0.5 }))).toBe(macroTimbreText(base));
    expect(macroMorphText(read({ model: 4, timbre: 0.3, morph: 0.9 }))).toBe(macroMorphText(base));
  });

  it('the WAVETABLE morph readout says DEAD below 50 % and stays saying it across the dead zone', () => {
    const wt = MACRO_ENGINES.find((e) => e.name === 'WAVETABLE')!;
    const dead = [0, 0.1, 0.25, 0.49, 0.5].map((m) => macroMorphText(read({ model: wt.index, morph: m })));
    expect(new Set(dead).size, `the readout must be CONSTANT across the dead zone — the audio is: ${dead.join(' | ')}`).toBe(1);
    expect(dead[0]).toContain('DEAD');
    // …and it must start reporting travel the moment the audio does.
    expect(macroMorphText(read({ model: wt.index, morph: 0.75 }))).not.toContain('DEAD');
    expect(macroMorphText(read({ model: wt.index, morph: 0.75 }))).not.toBe(dead[0]);
  });

  it('the GRANULAR morph readout is three states and nothing between', () => {
    const gr = MACRO_ENGINES.find((e) => e.name === 'GRANULAR')!;
    const seen = new Set<string>();
    for (let k = 0; k <= 40; k++) seen.add(macroMorphText(read({ model: gr.index, morph: k / 40 })));
    expect([...seen].sort(), 'GRANULAR morph readout over a 41-step sweep').toHaveLength(3);
  });

  it('the MODAL timbre readout states the DIRECTION, which is the surprise', () => {
    const modal = MACRO_ENGINES.find((e) => e.name === 'MODAL')!;
    expect(macroTimbreText(read({ model: modal.index, timbre: 0.5 }))).toContain('quieter');
  });

  // ── level / aux ───────────────────────────────────────────────────────────
  it('NEGATIVE CONTROL (out level): MODEL moves it 76.6 dB while the LEVEL knob does not budge', () => {
    const lvls = MACRO_ENGINES.map((e) => macroOutLevelDb(read({ model: e.index, level: 0.8 })));
    expect(Math.max(...lvls) - Math.min(...lvls)).toBeCloseTo(MACRO_LEVEL_SPREAD_DB, 6);
    expect(Math.max(...lvls) - Math.min(...lvls)).toBeGreaterThan(70);
  });

  it('SECOND LEG (out level): LEVEL moves it by the SAME dB on every engine', () => {
    const expected = 20 * Math.log10(0.4 / 0.8);
    for (const e of MACRO_ENGINES) {
      const hi = macroOutLevelDb(read({ model: e.index, level: 0.8 }));
      const lo = macroOutLevelDb(read({ model: e.index, level: 0.4 }));
      expect(lo - hi, `${e.name}: halving LEVEL must be exactly ${expected.toFixed(2)} dB`).toBeCloseTo(expected, 9);
    }
    expect(macroOutLevelDb(read({ model: 0, level: 0 }))).toBe(-Infinity);
  });

  it('NEGATIVE CONTROL (aux vs out): at LEVEL 0 the OUT is silent and AUX is NOT', () => {
    // Measured: at LEVEL 0, OUT peak is 0.0000 on all fourteen while AUX peak
    // is 1.0000 on eight of them. A `paramId: 'level'` readout prints `0.00`
    // and says nothing at all about that.
    expect(macroAuxOffsetDb(read({ model: 0, level: 0 }))).toBe(Infinity);
    expect(fmtMacroDb(macroAuxOffsetDb(read({ model: 0, level: 0 })))).toBe('OUT is silent');
    const r = macrooscillatorMath.render(MEASURE_WINDOW, SR, MEASURE_PITCH_V, { ...DEFAULTS, level: 0 });
    let outPeak = 0, auxPeak = 0;
    for (let i = 0; i < r.main.length; i++) {
      outPeak = Math.max(outPeak, Math.abs(r.main[i]!));
      auxPeak = Math.max(auxPeak, Math.abs(r.aux[i]!));
    }
    expect(outPeak, 'OUT at LEVEL 0').toBe(0);
    expect(auxPeak, 'AUX at LEVEL 0 — the whole point of the readout').toBeGreaterThan(0.9);
  });

  it('SECOND LEG (aux vs out): MODEL moves it too — the AUX/OUT ratio is not constant', () => {
    const offsets = MACRO_ENGINES.map((e) => macroAuxOffsetDb(read({ model: e.index, level: 0.8 })));
    expect(new Set(offsets.map((o) => o.toFixed(1))).size).toBeGreaterThan(8);
  });

  it('`vs loudest` is invariant to LEVEL and moves only on MODEL', () => {
    const fm2 = MACRO_ENGINES.find((e) => e.name === 'FM 2OP')!;
    expect(macroLevelVsLoudestDb(read({ model: fm2.index }))).toBe(0);
    for (const lvl of [0, 0.2, 0.8, 1]) {
      expect(
        macroLevelVsLoudestDb(read({ model: 7, level: lvl })),
        'LEVEL cannot close the gap between engines — it moves both sides equally, which is the fact this readout exists to state',
      ).toBeCloseTo(MACRO_ENGINES[7]!.outRmsDb - MACRO_LOUDEST_DB, 9);
    }
  });

  // ── the two engine-class readouts ─────────────────────────────────────────
  it('NEGATIVE CONTROL (band-limiting): NOTE does not move it, MODEL does', () => {
    const va = read({ model: 0, note: 0 });
    expect(
      macroAliasText(read({ model: 0, note: 36 })),
      'band-limiting is a property of the ENGINE, not the pitch — the AUDIBLE aliasing changes enormously at +36 st and this must not',
    ).toBe(macroAliasText(va));
    expect(macroAliasText(read({ model: 1 }))).not.toBe(macroAliasText(va));
  });

  it('NEGATIVE CONTROL (strike): no MACRO moves it, MODEL does', () => {
    const va = read({ model: 0 });
    for (const axis of AXES) {
      expect(macroStrikeText(read({ model: 0, [axis]: 0.9 }))).toBe(macroStrikeText(va));
    }
    expect(macroStrikeText(va)).toBe('free-running');
    expect(macroStrikeText(read({ model: 8 }))).toBe('needs a strike');
  });

  it('the AUX tap noun is per-engine and distinct enough to be worth printing', () => {
    const taps = MACRO_ENGINES.map((e) => macroAuxText(read({ model: e.index })));
    expect(new Set(taps).size).toBeGreaterThanOrEqual(10);
  });

  // ── THE LAYOUT CONSTRAINT, ASSERTED AS ONE ────────────────────────────────
  it('every readout stays inside the 26-char sidebar budget, on all 14 engines', () => {
    // ⚠ MEASURED, NOT GUESSED: the dock sidebar's content column is 258 px, and
    // longer values pushed the dock 78 CSS px past its right edge (1298 vs
    // 1220). That makes value LENGTH a property of this model, so it is
    // asserted here across the whole roster rather than eyeballed at defaults.
    const LIMIT = 26;
    const over: string[] = [];
    for (const e of MACRO_ENGINES) {
      for (const v of [0, 0.34, 0.67, 1]) {
        const p = read({ model: e.index, harmonics: v, timbre: v, morph: v, level: v > 0 ? v : 0.8 });
        for (const [name, text] of [
          ['harmonics', macroHarmonicsText(p)],
          ['timbre', macroTimbreText(p)],
          ['morph', macroMorphText(p)],
          ['aux tap', macroAuxText(p)],
          ['aux offset', fmtMacroDb(macroAuxOffsetDb(p))],
          ['strike', macroStrikeText(p)],
          ['alias', macroAliasText(p)],
        ] as const) {
          if (text.length > LIMIT) over.push(`${e.name} @${v} ${name}: ${text.length} chars — "${text}"`);
        }
      }
    }
    expect(over.join('\n'), `readout values over ${LIMIT} characters — the sidebar overflows`).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('macrooscillator face model — the hero picture', () => {
  const read = (p: Partial<MacroFaceParams>) => macroFaceParams((id) => (p as Record<string, number>)[id]);

  it('the warm-up is non-zero for MODAL ALONE, and it clears MODAL\'s dead lead-in', () => {
    for (const e of MACRO_ENGINES) {
      const w = macroHeroWarmup(e, SR);
      if (e.name === 'MODAL') {
        expect(w, 'MODAL first non-zero sample is 11999, so the warm-up must reach it').toBeGreaterThanOrEqual(11999);
      } else {
        expect(w, `${e.name} must not pay a warm-up it does not need`).toBe(0);
      }
    }
  });

  it('MODAL is drawn from AFTER its lead-in — without the warm-up the picture is a flat line', () => {
    const modal = MACRO_ENGINES.find((e) => e.name === 'MODAL')!;
    const t = macroHeroTrace(read({ model: modal.index }), SR, 100);
    expect(t.warmupMs).toBeCloseTo(250, 0);
    expect(t.peak, 'the drawn window must contain actual signal').toBeGreaterThan(1e-6);
    // The negative control: the SAME window taken from t=0 is exactly zero.
    const fromZero = macrooscillatorMath.render(2048, SR, 0, { ...DEFAULTS, model: modal.index });
    let p0 = 0;
    for (const v of fromZero.main) p0 = Math.max(p0, Math.abs(v));
    expect(p0, 'MODAL from t=0 over the hero window — this is what the picture would show WITHOUT the warm-up').toBe(0);
  });

  it('ONE shared gain: OUT and AUX keep their relative heights', () => {
    // The single most useful thing the picture says is that AUX is routinely
    // louder than OUT and LEVEL never touches it. Normalising the two traces
    // separately would destroy exactly that.
    const t = macroHeroTrace(read({ model: 0, level: 0.8 }), SR, 200);
    const h = (cols: readonly (readonly [number, number])[]) =>
      Math.max(...cols.map((c) => Math.max(Math.abs(c[0]), Math.abs(c[1]))));
    expect(h(t.aux)).toBeGreaterThan(h(t.out));
    // …and at LEVEL 0 the OUT trace collapses while AUX does not move at all.
    const silent = macroHeroTrace(read({ model: 0, level: 0 }), SR, 200);
    expect(h(silent.out)).toBe(0);
    expect(h(silent.aux)).toBeCloseTo(1, 6);
  });

  it('the gain is REPORTED, because an un-scaled MODAL trace is indistinguishable from silence', () => {
    const modal = MACRO_ENGINES.find((e) => e.name === 'MODAL')!;
    const t = macroHeroTrace(read({ model: modal.index }), SR, 200);
    expect(t.peak, 'MODAL peaks around 0.003').toBeLessThan(0.02);
    expect(t.gain, 'so the picture must magnify it by a lot, and say so').toBeGreaterThan(20);
    expect(fmtMacroGain(t.gain)).toMatch(/^×\d+$/);
    // A loud engine needs no magnification, and the caption prints ×1 rather
    // than hiding the absence of one.
    const va = macroHeroTrace(read({ model: 0 }), SR, 200);
    expect(fmtMacroGain(va.gain)).toBe('×1');
  });

  it('the trace responds to every macro, on an engine where all three are live', () => {
    const key = (p: Partial<MacroFaceParams>) =>
      JSON.stringify(macroHeroTrace(read({ model: 0, ...p }), SR, 64).out);
    const base = key({});
    for (const axis of AXES) {
      expect(key({ [axis]: 0.85 }), `hero trace must move on ${axis}`).not.toBe(base);
    }
    expect(key({ model: 5 }), 'hero trace must move on MODEL').not.toBe(base);
  });

  it('the trace is DETERMINISTIC — the dock VRT scene depends on it', () => {
    const a = macroHeroTrace(read({ model: 3, harmonics: 0.42 }), SR, 200);
    const b = macroHeroTrace(read({ model: 3, harmonics: 0.42 }), SR, 200);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('columns are min/max ENVELOPES, so a decimated window cannot alias into a fake waveform', () => {
    const t = macroHeroTrace(read({ model: 0 }), SR, 32);
    expect(t.out).toHaveLength(32);
    for (const [lo, hi] of t.out) expect(hi).toBeGreaterThanOrEqual(lo);
    for (const [lo, hi] of t.aux) expect(hi).toBeGreaterThanOrEqual(lo);
  });
});
