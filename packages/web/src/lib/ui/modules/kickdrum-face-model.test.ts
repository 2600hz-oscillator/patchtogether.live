// packages/web/src/lib/ui/modules/kickdrum-face-model.test.ts
//
// The hero graph is only worth drawing if it MOVES. Every block below is built
// as a NEGATIVE CONTROL on the instrument, not a restatement of it: perturb the
// one param the number claims to be about, and assert the number moves in the
// direction and roughly the magnitude the DSP implies. A test that only checked
// `tailMs > 0` would pass on a hardcoded constant — which is exactly the
// "picture of a kick" this model exists to not be.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { kickdrumDef } from '$lib/audio/modules/kickdrum';
import type { FacePreset, FaceSidebarBlock } from '$lib/graph/types';
import { readoutText } from '$lib/ui/workflow/dock-faceplate-model';
import {
  KICK_TAIL_FLOOR_DB,
  fmtAmount,
  fmtBipolar,
  fmtDb,
  fmtHz,
  fmtMs,
  fmtSemitones,
  kickdrumEnvelopeParams,
  kickdrumGraph,
  kickdrumLayerAmps,
  kickdrumSweep,
  kickdrumTailMs,
  unwarpX,
  warpX,
  type KickdrumEnvelopeParams,
} from './kickdrum-face-model';

/** The three sidebar blocks the DEF declares — the source of truth for the
 *  chain, the crossover and the roster now that they are platform DATA rather
 *  than a per-module component. Reading them here is what keeps the assertions
 *  two-sided: they run the DECLARATION through the model/DSP, never restate it. */
const SIDEBAR = (kickdrumDef.face!.sidebar ?? []) as readonly FaceSidebarBlock[];
function block<K extends FaceSidebarBlock['kind']>(kind: K): Extract<FaceSidebarBlock, { kind: K }> {
  const b = SIDEBAR.find((x) => x.kind === kind);
  if (!b) throw new Error(`kickdrum's face declares no '${kind}' sidebar block`);
  return b as Extract<FaceSidebarBlock, { kind: K }>;
}

/** What the faceplate's TAIL readout actually prints for a set of live values —
 *  resolved the way the shell resolves it (through the `valueId` registry), so
 *  these assertions cover the wiring as well as the arithmetic. */
function printedTail(over: Partial<KickdrumEnvelopeParams> = {}): string {
  return readoutText({ label: 'tail', valueId: 'kickdrum-tail' }, kickdrumDef.params, (pid) =>
    (over as Record<string, number>)[pid],
  );
}

/** The DEF's own defaults — never re-typed here (CLAUDE.md: ONE place). This is
 *  the SAME resolver the panel and the derived readout use, so an empty reader
 *  is exactly the state a freshly spawned node presents. */
function defaults(): KickdrumEnvelopeParams {
  return kickdrumEnvelopeParams(() => undefined);
}

describe('kickdrum hero — the TAIL figure is measured, not drawn', () => {
  it('at the def defaults the summed voice reaches the −60 dB floor at ~398 ms', () => {
    const t = kickdrumTailMs(defaults());
    // The SUB knob says 450 ms and the tail says 398: the difference is the
    // LAYER MIX (sub_level 0.9 against a peak of 2.0), not a second definition
    // of decay. If this ever equals sub_decay exactly, the model has stopped
    // summing the layers.
    expect(t).toBeGreaterThan(390);
    expect(t).toBeLessThan(406);
    expect(t, 'the tail is NOT just the sub-decay knob read back').not.toBeCloseTo(
      defaults().sub_decay,
      0,
    );
  });

  it('NEGATIVE CONTROL — doubling SUB DEC moves the tail; the caption follows', () => {
    const base = defaults();
    const longer = { ...base, sub_decay: base.sub_decay * 2 };
    const t0 = kickdrumTailMs(base);
    const t1 = kickdrumTailMs(longer);
    // The sub dominates the floor crossing, so doubling its decay very nearly
    // doubles the tail (the body/click terms are ~0 by then).
    expect(t1 / t0).toBeGreaterThan(1.9);
    expect(t1 / t0).toBeLessThan(2.1);
    expect(printedTail(), 'and the printed readout follows').not.toBe(
      printedTail({ sub_decay: base.sub_decay * 2 }),
    );
  });

  it('NEGATIVE CONTROL — the tail also moves on a LEVEL change, not just a time', () => {
    // The blind version of this model would read sub_decay and print it. That
    // model is invariant to sub_level; this one is not, because the floor is
    // relative to the SUMMED peak.
    const base = defaults();
    const quietSub = { ...base, sub_level: base.sub_level / 3 };
    expect(kickdrumTailMs(quietSub)).toBeLessThan(kickdrumTailMs(base));
  });

  it('a fully muted voice has no tail rather than a NaN caption', () => {
    const silent = { ...defaults(), sub_level: 0, body_level: 0, click_level: 0 };
    expect(kickdrumTailMs(silent)).toBe(0);
    expect(printedTail({ sub_level: 0, body_level: 0, click_level: 0 })).toBe('0 ms');
  });

  it('the floor constant is the one the caption is measured to', () => {
    const p = defaults();
    const peak = kickdrumLayerAmps(p, 0).sum;
    const at = kickdrumLayerAmps(p, kickdrumTailMs(p)).sum;
    const db = 20 * Math.log10(at / peak);
    expect(db).toBeCloseTo(KICK_TAIL_FLOOR_DB, 3);
  });
});

describe('kickdrum hero — the PITCH SWEEP half of the caption', () => {
  it('at defaults the body starts an octave + 24 st above the settled sub', () => {
    const { startHz, endHz, semitones } = kickdrumSweep(defaults());
    expect(endHz).toBeCloseTo(50, 6); // = TUNE, the pitch the kick is heard at
    expect(semitones).toBe(24);
    // settled body = 2 × tune = 100 Hz, swept from +24 st = ×4 ⇒ 400 Hz.
    expect(startHz).toBeCloseTo(400, 6);
  });

  it('NEGATIVE CONTROL — P AMT moves the start pitch AND the printed semitones', () => {
    const base = defaults();
    const deeper = { ...base, pitch_amt: 36 };
    expect(kickdrumSweep(deeper).startHz).toBeGreaterThan(kickdrumSweep(base).startHz);
    // The SWEEP readout is the `pitch_amt` param itself, printed through the
    // def's own formatter — the same string the dial under it shows.
    const fmt = kickdrumDef.params.find((q) => q.id === 'pitch_amt')!.format!;
    expect(fmt(kickdrumSweep(deeper).semitones)).toBe('+36 st');
    expect(fmt(kickdrumSweep(base).semitones)).toBe('+24 st');
  });

  it('NEGATIVE CONTROL — TUNE moves the SETTLES TO figure', () => {
    const base = defaults();
    const fmt = kickdrumDef.params.find((q) => q.id === 'tune')!.format!;
    expect(fmt(kickdrumSweep(base).endHz)).toBe('50 Hz');
    expect(fmt(kickdrumSweep({ ...base, tune: 38 }).endHz)).toBe('38 Hz');
  });

  it('THE THREE HERO NUMBERS, as the faceplate prints them at the defaults', () => {
    // The mock's `tail ≈ 398 ms · +24 st → 50 Hz`, now three declared readouts
    // rather than one baked sentence. TAIL resolves through the DERIVED
    // registry; the other two are the params they are named after.
    // The reader resolves def defaults exactly as the shell's does (card-kit
    // `paramVal`), because `node.params` is a sparse overlay of what has been
    // TOUCHED — a fresh node stores nothing at all.
    const read = (pid: string) => kickdrumDef.params.find((q) => q.id === pid)?.defaultValue;
    expect(printedTail()).toBe('398 ms');
    expect(readoutText({ label: 'sweep', paramId: 'pitch_amt' }, kickdrumDef.params, read)).toBe(
      '+24 st',
    );
    expect(readoutText({ label: 'settles to', paramId: 'tune' }, kickdrumDef.params, read)).toBe(
      '50 Hz',
    );
  });

  it('the DEF declares exactly those three readouts, and TAIL is the DERIVED one', () => {
    // The two-sided half: the numbers above are only on the faceplate because
    // the def asks for them, and TAIL must not quietly become a knob readback.
    const ro = kickdrumDef.face!.hero!.readouts!;
    expect(ro.map((r) => r.label)).toEqual(['tail', 'sweep', 'settles to']);
    expect(ro[0]!.valueId, 'TAIL is DERIVED').toBe('kickdrum-tail');
    expect(ro[0]!.paramId, 'and is NOT a param readback — sub_decay prints 450 ms').toBeUndefined();
    expect(ro[1]!.paramId).toBe('pitch_amt');
    expect(ro[2]!.paramId).toBe('tune');
  });
});

describe('kickdrum hero — the plotted geometry', () => {
  it('starts at full amplitude and at the top of the sweep, and decays', () => {
    const g = kickdrumGraph(defaults(), 600);
    expect(g.points[0]!.amp).toBeCloseTo(1, 6);
    expect(g.points[0]!.pitch).toBeCloseTo(1, 6);
    expect(g.points.at(-1)!.amp).toBeLessThan(0.01);
    // Monotone decreasing amplitude — three summed decaying exponentials.
    for (let i = 1; i < g.points.length; i++) {
      expect(g.points[i]!.amp).toBeLessThanOrEqual(g.points[i - 1]!.amp + 1e-12);
    }
  });

  it('the sweep lands on the BODY’s octave, not on the fundamental', () => {
    // FOUND BY THIS TEST, and it is the picture's most useful fact: the body
    // starts 24 st over its own settled pitch, and that settled pitch is
    // 2 × TUNE. So a trace normalised against the SUB's 50 Hz cannot reach 0 —
    // it rests at log(2)/log(400/50) = 1/3. A model that ended at 0 would be
    // drawing the punch landing on the fundamental, which it never does.
    const g = kickdrumGraph(defaults(), 600);
    expect(g.bodySettledY).toBeCloseTo(1 / 3, 6);
    expect(g.points.at(-1)!.pitch).toBeCloseTo(g.bodySettledY, 3);
  });

  it('NEGATIVE CONTROL — the WINDOW is fixed, so a longer tail reaches further right', () => {
    // The failure this guards: an auto-scaled window renders every tail as the
    // same picture, so the drawing is invariant to the quantity it is about.
    const base = defaults();
    const g0 = kickdrumGraph(base, 600);
    const g1 = kickdrumGraph({ ...base, sub_decay: base.sub_decay * 2 }, 600);
    const mid = Math.floor(g0.points.length / 2);
    expect(g1.points[mid]!.amp).toBeGreaterThan(g0.points[mid]!.amp * 1.5);
    expect(g1.windowMs).toBe(g0.windowMs);
  });

  it('the tail marker leaves the window when the tail outruns it', () => {
    const base = defaults();
    expect(kickdrumGraph(base, 600).tailX).toBeGreaterThan(0);
    expect(kickdrumGraph(base, 200).tailX).toBeNull();
  });

  it('the WARPED axis makes the 30 ms chirp legible beside the 400 ms tail', () => {
    // FOUND BY LOOKING AT THE RENDER. On a linear axis the pitch chirp
    // (pitch_time 30 ms) occupies 30/600 = 5 % of the plot — about five of 96
    // points — and draws as a tick against the y-axis. The sqrt axis is the
    // fix, and this is the assertion that proves it is doing work: count the
    // sample points that land inside the first 60 ms.
    const g = kickdrumGraph(defaults(), 600);
    const early = g.points.filter((q) => unwarpX(q.x, 600) <= 60).length;
    expect(early, `${early} of ${g.points.length} points in the first 60 ms`).toBeGreaterThan(25);
    // …and the same count on the LINEAR axis, as the negative control: it is
    // ~10, which is what the unreadable render was.
    const linear = g.points.filter((q) => q.x * 600 <= 60).length;
    expect(linear).toBeLessThan(12);
  });

  it('the tail MARKER and the CURVE use the same axis — a mismatched marker points at nothing', () => {
    const g = kickdrumGraph(defaults(), 600);
    expect(g.tailX).toBeCloseTo(warpX(g.tailMs, 600), 12);
    // The linear position it must NOT be: 398/600 = 0.663 vs √(398/600) = 0.815.
    expect(g.tailX).not.toBeCloseTo(g.tailMs / 600, 2);
    // The curve at the marker really is at the −60 dB floor (0.001 of peak).
    const at = g.points.reduce((best, q) =>
      Math.abs(q.x - g.tailX!) < Math.abs(best.x - g.tailX!) ? q : best,
    );
    expect(at.amp).toBeLessThan(0.01);
  });

  it('warpX / unwarpX are inverses and are total on a degenerate window', () => {
    for (const t of [0, 12, 30, 120, 398, 600]) {
      expect(unwarpX(warpX(t, 600), 600)).toBeCloseTo(t, 6);
    }
    expect(warpX(100, 0)).toBe(0);
    expect(warpX(-5, 600)).toBe(0);
    expect(warpX(9999, 600)).toBe(1);
  });

  it('a zero-depth sweep plots FLAT — there is no chirp to draw', () => {
    const g = kickdrumGraph({ ...defaults(), pitch_amt: 0 }, 600);
    const first = g.points[0]!.pitch;
    expect(g.points.every((q) => Math.abs(q.pitch - first) < 1e-9)).toBe(true);
    expect(Number.isFinite(first)).toBe(true);
    // No chirp ⇒ no sign to carry: `0 st`, not `+0 st`.
    expect(kickdrumDef.params.find((q) => q.id === 'pitch_amt')!.format!(0)).toBe('0 st');
  });

  it('a fully degenerate span does not divide by log(1)', () => {
    // tune 0 collapses both ends of the span; the guard must return finite
    // geometry rather than NaN/Infinity (this runs every animation frame).
    const g = kickdrumGraph({ ...defaults(), tune: 0, pitch_amt: 0 }, 600);
    expect(g.points.every((q) => Number.isFinite(q.pitch))).toBe(true);
    expect(Number.isFinite(g.bodySettledY)).toBe(true);
  });
});

describe('kickdrum readouts — the units vocabulary under every knob', () => {
  it('prints the mock strings for the mock values', () => {
    expect(fmtMs(450)).toBe('450 ms');
    expect(fmtSemitones(24)).toBe('+24 st');
    expect(fmtHz(2800)).toBe('2.8 kHz');
    expect(fmtHz(500)).toBe('500 Hz');
    expect(fmtDb(3)).toBe('+3.0 dB');
    expect(fmtAmount(0.7)).toBe('0.70');
  });

  it('a bipolar amount always says WHICH WAY', () => {
    expect(fmtBipolar(0.2)).toBe('+0.20');
    expect(fmtBipolar(-0.35)).toBe('−0.35');
    expect(fmtBipolar(0)).toBe('0.00');
  });

  it('is total on a non-finite value (it runs every animation frame)', () => {
    for (const f of [fmtHz, fmtMs, fmtDb, fmtSemitones, fmtAmount, fmtBipolar]) {
      expect(() => f(NaN)).not.toThrow();
      expect(() => f(Infinity)).not.toThrow();
    }
  });

  it('every KNOB carries a readout vocabulary (the mock: a value under EVERY knob)', () => {
    // `knobReadout` prints NOTHING unless one of format/options/landmarks is
    // declared, so this is the exact predicate that decides whether a dial has
    // a value under it. `hard` is the sole exemption: it is a 0/1 switch and
    // renders as a <Toggle>, which states its own position — and naming it
    // here rather than filtering by shape means a NEW switch-shaped param
    // cannot inherit the exemption by accident.
    const bare = kickdrumDef.params
      .filter((p) => !p.format && !p.options && !p.landmarks)
      .map((p) => p.id);
    expect(bare, 'these knobs would print a bare label with no value').toEqual(['hard']);
  });

  it('SHAPE reads its waveform NAME, not a float', () => {
    const shape = kickdrumDef.params.find((p) => p.id === 'body_shape')!;
    expect(shape.landmarks?.map((l) => l.label)).toEqual(['SINE', 'TRI', 'RECT']);
    expect(shape.format, 'a format would override the landmark name').toBeUndefined();
  });

  it('each formatter agrees with the param it is attached to', () => {
    const byId = new Map(kickdrumDef.params.map((p) => [p.id, p]));
    expect(byId.get('sub_decay')!.format!(450)).toBe('450 ms');
    expect(byId.get('pitch_amt')!.format!(24)).toBe('+24 st');
    expect(byId.get('body_decay')!.format!(120)).toBe('120 ms');
    expect(byId.get('click_tone')!.format!(2800)).toBe('2.8 kHz');
    expect(byId.get('body_eq')!.format!(3)).toBe('+3.0 dB');
    expect(byId.get('body_level')!.format!(0.7)).toBe('0.70');
    expect(byId.get('tune')!.format!(50)).toBe('50 Hz');
  });
});

describe('kickdrum — the TRANSLATE branch is stated where a reader can check it', () => {
  // The signal-flow sidebar block used to carry this, and it was the ONLY
  // surface that did. The block is gone (a hand-authored chain nothing verified
  // against the DSP), so the claim now has to survive in the def's own prose —
  // which is what the doc gates already read.
  it('docs.explanation still names TRANSLATE as a PARALLEL branch off the raw sub', () => {
    expect(kickdrumDef.docs!.explanation!).toContain('PARALLEL branch');
  });
});

describe('kickdrum sidebar — the STEREO CROSSOVER number is the worklet’s', () => {
  const xover = block('custom');

  it('declares the registered crossover panel and its split', () => {
    expect(xover.panelId).toBe('stereo-crossover');
    expect(xover.props?.widthParam).toBe('width');
    expect(typeof xover.props?.splitHz).toBe('number');
  });

  it('the DSP source still splits at the frequency the picture draws', () => {
    // ⚠ THE DECLARED NUMBER IS ONE SIDE OF A TWO-SIDED CONTRACT. `kickdrum-dsp
    // .ts` sits inside two ART source-SHA pins, so exporting a constant from it
    // would cost two baseline re-pins for zero audio change. Reading the SOURCE
    // is the guard instead: if the worklet's split moves, the sidebar's
    // "mono ‹ 120 Hz" becomes a lie and this goes red.
    const src = readFileSync(
      fileURLToPath(new URL('../../../../../dsp/src/lib/kickdrum-dsp.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toContain(`${xover.props!.splitHz} Hz`);
  });
});

describe('kickdrum presets — five voices that SELECT, declared on the face', () => {
  const presets = block('presets').entries as readonly FacePreset[];

  it('is exactly the mock roster, in the mock order', () => {
    expect(presets.map((p) => p.label)).toEqual([
      'DEEP CLUB',
      'TECHNO PUNCH',
      '909 CLASSIC',
      'SUB BOOM',
      'LO-FI THUMP',
    ]);
    expect(presets.map((p) => p.note)).toEqual(['50 Hz', 'hard', '62 Hz', '38 Hz', 'crush']);
  });

  it('every stamped key is a DECLARED param and every value is inside its range', () => {
    const byId = new Map(kickdrumDef.params.map((p) => [p.id, p]));
    for (const preset of presets) {
      for (const [id, value] of Object.entries(preset.values)) {
        const pd = byId.get(id);
        expect(pd, `${preset.id} stamps '${id}', which kickdrum does not declare`).toBeDefined();
        expect(
          value,
          `${preset.id}.${id} = ${value} is outside the def's ${pd!.min}..${pd!.max}`,
        ).toBeGreaterThanOrEqual(pd!.min);
        expect(value).toBeLessThanOrEqual(pd!.max);
      }
    }
  });

  it('each entry is a COMPLETE voice, and the doc says exactly that', () => {
    // ⚠ THIS PINS THE PROSE TO THE DATA. An earlier draft stamped 24 of the 25
    // params while its shipped doc said a preset "stamps only the values that
    // make it that voice and leaves the rest of your settings alone" — a
    // sentence that was false at 24/25, with nothing able to see it. Either
    // answer is defensible; a doc that disagrees with the table is not.
    const declared = kickdrumDef.params.map((p) => p.id).sort();
    for (const preset of presets) {
      expect(Object.keys(preset.values).sort(), `${preset.id} recalls every param`).toEqual(
        declared,
      );
    }
    expect(kickdrumDef.docs!.explanation!).toContain('a COMPLETE voice — all 25 params');
  });

  it('the notes are not decoration — each names its own TUNE or character', () => {
    const byLabel = new Map(presets.map((p) => [p.label, p]));
    expect(byLabel.get('DEEP CLUB')!.values.tune).toBe(50);
    expect(byLabel.get('909 CLASSIC')!.values.tune).toBe(62);
    expect(byLabel.get('SUB BOOM')!.values.tune).toBe(38);
    expect(byLabel.get('TECHNO PUNCH')!.values.hard).toBe(1);
    expect(byLabel.get('LO-FI THUMP')!.values.drive).toBeGreaterThan(0.8);
  });

  it('the five voices are AUDIBLY different where the roster says they are', () => {
    // Not "the objects differ" — the derived tail figures do, which is what a
    // player hears and what the hero readout prints.
    const tails = presets.map((p) =>
      Math.round(kickdrumTailMs({ ...defaults(), ...(p.values as Partial<KickdrumEnvelopeParams>) })),
    );
    expect(new Set(tails).size, `tails: ${tails.join(', ')}`).toBe(presets.length);
    // SUB BOOM must be the longest and LO-FI THUMP the shortest, by design.
    expect(Math.max(...tails)).toBe(tails[3]);
    expect(Math.min(...tails)).toBe(tails[4]);
  });

  it('the preset ids are unique and stable (they are what `node.data` records)', () => {
    const ids = presets.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('909-classic');
  });
});

describe('kickdrum docs — the hero prose cannot drift off the live model', () => {
  it('the number the doc quotes IS the number the model computes', () => {
    // The doc names 398 ms as the default tail. `contract-lock` does not cover
    // prose, so without this a defaults change would leave the shipped
    // documentation quietly wrong while every other gate stayed green.
    const doc = kickdrumDef.docs!.controls!['kickdrum-hero-{n}']!;
    expect(doc).toContain(`the tail is ${fmtMs(kickdrumTailMs(defaults()))}`);
    // …and it names the SUB DEC knob it is deliberately NOT equal to.
    const subDecay = kickdrumDef.params.find((p) => p.id === 'sub_decay')!;
    expect(doc).toContain(`${subDecay.format!(subDecay.defaultValue)} SUB DEC`);
  });
});
