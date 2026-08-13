// packages/web/src/lib/audio/ringback-crush-model.test.ts
//
// The RINGBACK crush model + the claims its curated face makes about the
// module. Five groups, and only the first is an ordinary formatter test:
//
//  1. the readouts (`ParamDef.format`) and the derived arithmetic behind them;
//  2. the LANE FIT — every string the three formatters can produce, swept in
//     PIXELS against the real column cap (`lane-readout-fit`);
//  3. the DEF ↔ WORKLET range gate — the third copy of the ranges lives in
//     `packages/dsp/src/ringback.ts`'s `parameterDescriptors` and no runtime
//     gate reads it, so this one parses it;
//  4. the `~` AUDIO-RATE CLAIM the face's rear card draws, checked against the
//     worklet's own read pattern rather than against a comment;
//  5. the FACE, including the empirical claim behind `glyph: 'scope'` —
//     measured on the real per-sample DSP core, with the instrument
//     negative-controlled in both directions.
//
// Every group carries a negative control: a gate that has never been seen to
// fail is not a gate (CLAUDE.md).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  RINGBACK_FEEDBACK,
  RINGBACK_MIX,
  RINGBACK_RATE,
  RINGBACK_RINGING_LAPS,
  RINGBACK_SIZE,
  crushDivisor,
  formatRingbackFeedback,
  formatRingbackMix,
  formatRingbackRate,
  ringLapsToSilence,
} from './ringback-crush-model';
import { ringbackDef } from './modules/ringback';
import {
  LANE_KCOL_MAX_PX,
  READOUT_MAX_CHARS,
  readoutFitsLane,
  readoutWidthPx,
} from '$lib/ui/workflow/lane-readout-fit';
import { curatedFace } from '$lib/ui/workflow/curated-face';
import { laneBodyPlan } from '$lib/ui/workflow/module-shell-model';
import { rearFieldPlan } from '$lib/ui/workflow/rear-card-model';
import { RingChannel } from '../../../../dsp/src/lib/ringback-core';

// ───────────────────────────────────────────────────────────────────────────
// 1. THE READOUTS
// ───────────────────────────────────────────────────────────────────────────

describe('ringback readouts — the number, converted into what it does', () => {
  it('RATE prints the sample rate the wet path actually runs at', () => {
    // Below 1 the cursor moves less than a cell per sample, so 1/rate input
    // samples share a cell and only the last survives.
    expect(formatRingbackRate(0.5)).toBe('SR/2.0');
    expect(formatRingbackRate(0.25)).toBe('SR/4.0');
    expect(formatRingbackRate(0.05)).toBe('SR/20');
    // The decimal is dropped once the divisor reaches 10 — a WIDTH decision
    // (see group 2), and 10 is where it takes effect.
    expect(formatRingbackRate(0.1)).toBe('SR/10');
    expect(formatRingbackRate(1 / 9.9)).toBe('SR/9.9');
    // At and above 1 nothing is discarded.
    expect(formatRingbackRate(1)).toBe('FULL SR');
    expect(formatRingbackRate(2.5)).toBe('FULL SR');
    expect(formatRingbackRate(4)).toBe('FULL SR');
  });

  it('RATE is total: out-of-range and non-finite values clamp instead of throwing', () => {
    // `format` runs on every animation frame while a value moves.
    expect(formatRingbackRate(-99)).toBe(formatRingbackRate(RINGBACK_RATE.min));
    expect(formatRingbackRate(1e9)).toBe('FULL SR');
    expect(formatRingbackRate(Number.NaN)).toBe(formatRingbackRate(RINGBACK_RATE.default));
    expect(formatRingbackRate(Number.POSITIVE_INFINITY)).toBe(
      formatRingbackRate(RINGBACK_RATE.default),
    );
  });

  it('the decimation divisor is 1/rate below 1 and exactly 1 above it', () => {
    expect(crushDivisor(0.5)).toBeCloseTo(2, 12);
    expect(crushDivisor(0.05)).toBeCloseTo(20, 12);
    expect(crushDivisor(1)).toBe(1);
    expect(crushDivisor(4)).toBe(1);
  });

  it('FEEDBACK prints how many ring LAPS the tail survives', () => {
    // Geometric decay: ln(0.001)/ln(fb) laps to −60 dB.
    expect(ringLapsToSilence(0)).toBe(0);
    expect(ringLapsToSilence(0.3)).toBe(6); // 5.74
    expect(ringLapsToSilence(0.5)).toBe(10); // 9.97
    expect(ringLapsToSilence(0.9)).toBe(66); // 65.6
    expect(ringLapsToSilence(RINGBACK_FEEDBACK.max)).toBe(342);

    expect(formatRingbackFeedback(0)).toBe('1 PASS');
    expect(formatRingbackFeedback(RINGBACK_FEEDBACK.default)).toBe('6 LAPS');
    expect(formatRingbackFeedback(0.9)).toBe('66 LAPS');
    expect(formatRingbackFeedback(RINGBACK_FEEDBACK.max)).toBe('RINGING');
    // A vanishingly small amount of regeneration is still one lap, and the
    // singular is spelled.
    expect(formatRingbackFeedback(1e-4)).toBe('1 LAP');
  });

  it('the RINGING threshold is where the counted branch stops, on both sides', () => {
    // The boundary is a real one, so pin it from BOTH directions rather than
    // trusting the constant: the last counted lap and the first named one.
    let lastCounted = 0;
    let firstRinging = 1;
    for (let i = 0; i <= 1000; i++) {
      const fb = (RINGBACK_FEEDBACK.max * i) / 1000;
      if (ringLapsToSilence(fb) < RINGBACK_RINGING_LAPS) lastCounted = fb;
      else {
        firstRinging = fb;
        break;
      }
    }
    expect(formatRingbackFeedback(lastCounted)).toMatch(/^\d+ LAPS?$/);
    expect(formatRingbackFeedback(firstRinging)).toBe('RINGING');
    expect(ringLapsToSilence(lastCounted)).toBeLessThan(RINGBACK_RINGING_LAPS);
    expect(ringLapsToSilence(firstRinging)).toBeGreaterThanOrEqual(RINGBACK_RINGING_LAPS);
    // …and it sits near the top of the knob, which is the claim the model's
    // comment makes about it.
    expect(firstRinging / RINGBACK_FEEDBACK.max).toBeGreaterThan(0.9);
  });

  it('MIX names the END, and never contradicts the number beside it', () => {
    expect(formatRingbackMix(0)).toBe('DRY');
    expect(formatRingbackMix(RINGBACK_MIX.default)).toBe('WET');
    expect(formatRingbackMix(0.35)).toBe('35% WET');
    expect(formatRingbackMix(0.5)).toBe('50% WET');
    // The DRY/WET ends are decided on the ROUNDED percentage, so a value that
    // displays as 100 % never prints `100% WET` (8 glyphs) and a value that
    // displays as 0 % never prints `0% WET`.
    expect(formatRingbackMix(0.999)).toBe('WET');
    expect(formatRingbackMix(0.001)).toBe('DRY');
    expect(formatRingbackMix(0.995)).toBe('WET');
    expect(formatRingbackMix(0.994)).toBe('99% WET');
  });

  it('NEGATIVE CONTROL: each readout moves with ITS OWN param and nothing else', () => {
    // The failure this catches is a formatter wired to a constant (or to the
    // wrong param): every assertion above would still pass on a function that
    // ignored its argument inside one branch.
    const rate = [0.05, 0.2, 0.5, 0.9].map(formatRingbackRate);
    expect(new Set(rate).size, `RATE readouts collapsed: ${rate.join(' ')}`).toBe(4);
    const fb = [0, 0.2, 0.5, 0.9, 0.98].map(formatRingbackFeedback);
    expect(new Set(fb).size, `FEEDBACK readouts collapsed: ${fb.join(' ')}`).toBe(5);
    const mix = [0, 0.25, 0.5, 0.75, 1].map(formatRingbackMix);
    expect(new Set(mix).size, `MIX readouts collapsed: ${mix.join(' ')}`).toBe(5);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. THE LANE FIT — in PIXELS, not in characters
// ───────────────────────────────────────────────────────────────────────────

/** Dense sweep of a declared range (inclusive of both ends). */
function sweep(min: number, max: number, n = 400): number[] {
  return Array.from({ length: n + 1 }, (_, i) => min + ((max - min) * i) / n);
}

describe('ringback readouts fit the 46 px lane knob column', () => {
  // A persistent readout that outgrows `--kcol-max` does NOT ellipsize — it
  // escapes the column and pins `.kcol` to its cap (measured; see
  // lane-readout-fit.ts). So the constraint is width, and the only thing
  // holding it is the string.
  const CASES: [string, (v: number) => string, { min: number; max: number }][] = [
    ['rate', formatRingbackRate, RINGBACK_RATE],
    ['feedback', formatRingbackFeedback, RINGBACK_FEEDBACK],
    ['mix', formatRingbackMix, RINGBACK_MIX],
  ];

  it.each(CASES)('%s: every string across the whole range stays inside the column', (id, fmt, r) => {
    const worst = sweep(r.min, r.max)
      .map(fmt)
      .reduce((a, b) => (readoutWidthPx(b) > readoutWidthPx(a) ? b : a));
    expect(
      readoutFitsLane(worst),
      `${id}: widest readout '${worst}' is ${worst.length} glyph(s) = ` +
        `${readoutWidthPx(worst).toFixed(1)} px against a ${LANE_KCOL_MAX_PX} px column ` +
        `(budget ${READOUT_MAX_CHARS} glyphs) — shorten the format`,
    ).toBe(true);
  });

  it('NEGATIVE CONTROL: the fit check REJECTS a string one glyph too wide', () => {
    // Without this the sweep above is green for a check that returns `true`.
    expect(readoutFitsLane('X'.repeat(READOUT_MAX_CHARS))).toBe(true);
    expect(readoutFitsLane('X'.repeat(READOUT_MAX_CHARS + 1))).toBe(false);
    // The realistic near-miss: the count branch without its RINGING cap.
    expect(readoutFitsLane('342 LAPS')).toBe(false);
    expect(readoutFitsLane('RINGING')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. THE DEF ↔ WORKLET RANGE GATE
// ───────────────────────────────────────────────────────────────────────────

/**
 * The worklet's `parameterDescriptors` table, parsed out of the DSP source.
 *
 * ⚠ WHY A SOURCE PARSE AND NOT AN IMPORT. `packages/dsp/src/ringback.ts`
 * deliberately exports NOTHING at the top level (a top-level export pollutes
 * the bundled classic-script worklet and breaks the ART harness's eval), so the
 * descriptor table is unreachable from a test any other way. The same shape as
 * `card-range-source.test.ts`'s literal grep and `module-docs-lint`'s
 * card-testid grep: a textual guard is the only instrument that can see this
 * side of the contract.
 */
const WORKLET_SRC = readFileSync(
  fileURLToPath(new URL('../../../../dsp/src/ringback.ts', import.meta.url)),
  'utf8',
);

interface Descriptor {
  name: string;
  defaultValue: number;
  minValue: number;
  maxValue: number;
  automationRate: string;
}

/** Identifiers the descriptor table is allowed to use, resolved to the SAME
 *  constants the model exports (so an identifier is not a hole in the check). */
const RESOLVABLE: Record<string, number> = { RINGBACK_MAX_SIZE: RINGBACK_SIZE.max };

const DESCRIPTOR_RE =
  /\{\s*name:\s*'([^']+)',\s*defaultValue:\s*([^,]+?),\s*minValue:\s*([^,]+?),\s*maxValue:\s*([^,]+?),\s*automationRate:\s*'([^']+)'/g;

function parseDescriptors(src: string): Descriptor[] {
  const num = (tok: string): number => {
    const t = tok.trim();
    if (t in RESOLVABLE) return RESOLVABLE[t]!;
    const n = Number(t);
    if (!Number.isFinite(n)) {
      throw new Error(
        `ringback worklet descriptor uses '${t}', which this parser cannot resolve. ` +
          `Add it to RESOLVABLE (bound to the model constant) — leaving it unresolvable ` +
          `would silently drop the range from the check.`,
      );
    }
    return n;
  };
  DESCRIPTOR_RE.lastIndex = 0;
  return [...src.matchAll(DESCRIPTOR_RE)].map((m) => ({
    name: m[1]!,
    defaultValue: num(m[2]!),
    minValue: num(m[3]!),
    maxValue: num(m[4]!),
    automationRate: m[5]!,
  }));
}

describe('the DEF agrees with the WORKLET about every range', () => {
  // The worklet's descriptors are the REAL clamp — a Web Audio AudioParam pins
  // to minValue/maxValue whatever the UI sends — so a def that disagrees gives
  // a knob travel that silently does nothing at one end. contract-lock pins the
  // DEF against itself and cannot see this side at all.
  const RANGES = {
    rate: RINGBACK_RATE,
    size: RINGBACK_SIZE,
    feedback: RINGBACK_FEEDBACK,
    mix: RINGBACK_MIX,
  } as const;

  it('parses all four descriptors', () => {
    const found = parseDescriptors(WORKLET_SRC).map((d) => d.name);
    expect(found).toEqual(['rate', 'size', 'feedback', 'mix']);
  });

  it.each(Object.keys(RANGES))('%s: worklet, model and ParamDef state the same range', (id) => {
    const d = parseDescriptors(WORKLET_SRC).find((x) => x.name === id)!;
    const model = RANGES[id as keyof typeof RANGES];
    const param = ringbackDef.params.find((p) => p.id === id)!;

    expect([d.minValue, d.maxValue, d.defaultValue], `${id}: worklet vs model`).toEqual([
      model.min,
      model.max,
      model.default,
    ]);
    expect([param.min, param.max, param.defaultValue], `${id}: ParamDef vs model`).toEqual([
      model.min,
      model.max,
      model.default,
    ]);
  });

  it('NEGATIVE CONTROL: a drifted worklet range FAILS the comparison', () => {
    // Perturb the instrument's input, not the code, and confirm the number the
    // check reads actually moves.
    const drifted = WORKLET_SRC.replace("maxValue: 4,", "maxValue: 8,");
    expect(drifted, 'the substitution must actually apply').not.toBe(WORKLET_SRC);
    const d = parseDescriptors(drifted).find((x) => x.name === 'rate')!;
    expect(d.maxValue).toBe(8);
    expect(d.maxValue).not.toBe(RINGBACK_RATE.max);
  });

  it('NEGATIVE CONTROL: an unresolvable identifier THROWS instead of passing quietly', () => {
    const opaque = WORKLET_SRC.replace('maxValue: 0.98,', 'maxValue: SOME_NEW_CONST,');
    expect(opaque).not.toBe(WORKLET_SRC);
    expect(() => parseDescriptors(opaque)).toThrow(/cannot resolve/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. THE `~` AUDIO-RATE CLAIM
// ───────────────────────────────────────────────────────────────────────────

describe('face.rear.audioRate is TRUE of the worklet, not just declared', () => {
  // The rear card draws a `~` tick per listed input. CLAUDE.md / the design
  // program's step 6: a tick is a CLAIM and the source must be cited. There is
  // no `PortDef.rate` field for a runtime gate to read, so the citation is
  // checked here.
  const ticked = ringbackDef.face!.rear!.audioRate!;

  it('every ticked jack targets a param the worklet declares a-rate', () => {
    const descriptors = new Map(parseDescriptors(WORKLET_SRC).map((d) => [d.name, d]));
    for (const portId of ticked) {
      const port = ringbackDef.inputs.find((p) => p.id === portId)!;
      const target = port.paramTarget ?? portId;
      expect(descriptors.get(target)?.automationRate, `${portId} → ${target}`).toBe('a-rate');
    }
  });

  it('and the process loop READS them per frame (a-rate declared ≠ a-rate read)', () => {
    // An `automationRate: 'a-rate'` descriptor whose process loop reads
    // `parameters.rate[0]` once per block is a k-rate consumer wearing an
    // a-rate label — and the `~` would be a lie. So check the read.
    const HANDLES: Record<string, string> = {
      rate: 'pr',
      size: 'ps',
      feedback: 'pf',
      mix: 'pm',
    };
    for (const portId of ticked) {
      const target = ringbackDef.inputs.find((p) => p.id === portId)!.paramTarget ?? portId;
      const handle = HANDLES[target]!;
      expect(WORKLET_SRC, `${target} is not read per frame`).toContain(`av(${handle}, i)`);
    }
    // …and the helper that indexing goes through really is per-frame.
    expect(WORKLET_SRC).toMatch(/const av = \(arr: Float32Array, i: number\)/);
  });

  it('NEGATIVE CONTROL: a block-rate read is NOT accepted as per-frame', () => {
    const blockRate = WORKLET_SRC.replace('av(pr, i)', 'pr[0]!');
    expect(blockRate).not.toBe(WORKLET_SRC);
    expect(blockRate).not.toContain('av(pr, i)');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. THE FACE
// ───────────────────────────────────────────────────────────────────────────

const SR = 48000;
const RENDER_FRAMES = 12000; // 0.25 s at 48 kHz — the figures are stable to ±0.01 across 0.1–0.5 s

/** RMS — what a `meter` glyph reports. */
function rms(a: Float32Array): number {
  let s = 0;
  for (const v of a) s += v * v;
  return Math.sqrt(s / a.length);
}

/**
 * Normalised first-difference energy — a proxy for what a `scope` glyph SHOWS.
 *
 * It measures how jagged the drawn line is, and it is DIVIDED BY RMS on
 * purpose: the property under test is waveform SHAPE, so the metric must be
 * invariant to level (negative-controlled below in both directions).
 */
function roughness(a: Float32Array): number {
  let s = 0;
  for (let i = 1; i < a.length; i++) {
    const d = a[i]! - a[i - 1]!;
    s += d * d;
  }
  return Math.sqrt(s / (a.length - 1)) / (rms(a) || 1);
}

/** Render the REAL per-sample core over a C4 saw (the ART driver's signal). */
function render(over: Partial<Record<string, number>> = {}): Float32Array {
  const p = {
    rate: RINGBACK_RATE.default,
    size: RINGBACK_SIZE.default,
    feedback: RINGBACK_FEEDBACK.default,
    mix: RINGBACK_MIX.default,
    ...over,
  };
  const ch = new RingChannel();
  const out = new Float32Array(RENDER_FRAMES);
  for (let i = 0; i < RENDER_FRAMES; i++) {
    const t = ((i * 261.63) / SR) % 1;
    out[i] = ch.step(0.5 * (2 * t - 1), p.rate!, p.size!, p.feedback!, p.mix!);
  }
  return out;
}

/** Sweep one param across its declared range, others at default. */
function sweepParam(id: string, n = 9): Float32Array[] {
  const r = { rate: RINGBACK_RATE, size: RINGBACK_SIZE, feedback: RINGBACK_FEEDBACK, mix: RINGBACK_MIX }[id]!;
  const log = ringbackDef.params.find((p) => p.id === id)!.curve === 'log';
  return Array.from({ length: n }, (_, k) => {
    const f = k / (n - 1);
    const v = log ? r.min * Math.pow(r.max / r.min, f) : r.min + (r.max - r.min) * f;
    return render({ [id]: v });
  });
}

const spread = (xs: number[]): number => Math.max(...xs) / Math.min(...xs);

describe('ringback face — the ranking and the glyph are claims about the DSP', () => {
  const face = ringbackDef.face!;

  it('ranks every param exactly once, and pages partition them', () => {
    const ids = ringbackDef.params.map((p) => p.id);
    expect([...face.order].sort()).toEqual([...ids].sort());
    const paged = face.pages!.flatMap((p) => [...p.controls]);
    expect([...paged].sort(), 'every control is on exactly one page').toEqual([...ids].sort());
  });

  it('the tier ladder is 1 / 2 / 4(plate, no glyph) / 4 — derived, not asserted', () => {
    const mini = curatedFace(ringbackDef, 'mini')!;
    const compact = curatedFace(ringbackDef, 'compact')!;
    const full = curatedFace(ringbackDef, 'full')!;
    const dock = curatedFace(ringbackDef, 'dock')!;
    expect(mini.controls.map((c) => c.key)).toEqual(['rate']);
    expect(compact.controls.map((c) => c.key)).toEqual(['rate', 'size']);
    // ⚠ THREE, NOT FOUR, SINCE 2026-08-12 — and the reason is a HEIGHT, not the
    // ranking. RATE, FEEDBACK and MIX each declare a `format`, so each earns a
    // readout line and each cell is 57 CSS px rather than the 42 px design row.
    // RATE is rank 1, so the plate's FIRST row is 57 — and two 57 px rows plus
    // the 4 px gap is 118 px against a 112 px body. One row fits, so the plate
    // paints three cells and MIX becomes dock-only.
    //
    // This is the narrow half of a trade measured across the whole roster: the
    // plate's tracks are now sized PER ROW, so a tall cell costs only the rows
    // beneath it. Four faces whose tall cell sits in the LAST row (cofefve,
    // filter, resofilter, tidyVco) lose nothing at all; ringback is one of the
    // four that do, because its tall cell leads the ranking.
    expect(full.controls).toHaveLength(3);
    expect(dock.controls).toHaveLength(4);
    expect(dock.pages).toHaveLength(2);

    // Ranked controls outrank the glyph, so the `full` LANE tile paints no
    // glyph at all. That is a design fact the ranking was written against, not
    // a surprise to discover in a screenshot.
    const plan = laneBodyPlan(full.cellHeights, full.glyph !== 'none', 'full');
    expect(plan.layout).toBe('plate');
    expect(plan.cellCount).toBe(3);
    expect(plan.rowTracks, 'ONE row, sized to the readout-bearing cells in it').toEqual([57]);
    expect(
      plan.glyph,
      'the strip is refused under a taller-than-design row — see plateGlyphFitsRows',
    ).toBe(false);
    // …while the two tiers that DO show it select exactly two cells beside it.
    expect(laneBodyPlan(compact.controls.length, true, 'compact').glyph).toBe(true);
    expect(laneBodyPlan(mini.controls.length, true, 'mini').glyph).toBe(true);
  });

  it('the rear card is total and its bands read stereo in / crush ring / output blend', () => {
    const plan = rearFieldPlan(ringbackDef);
    // PR-4: each derived stereo pair renders as ONE hole addressing TWO ports,
    // so totality is stated over `portCount`; `holeCount` is two lower here
    // (in_l+in_r and out_l+out_r each collapse).
    expect(plan.portCount).toBe(ringbackDef.inputs.length + ringbackDef.outputs.length);
    expect(plan.holeCount).toBe(plan.portCount - 2);
    expect(plan.bands.map((b) => b.label)).toEqual(['stereo in', 'crush ring', 'output blend']);
    // The audio pair claims the LEADING slot as ONE stereo hole, and the
    // per-param CV holes fall into the band of the page whose control they
    // target.
    expect(plan.bands[0]!.holes.map((h) => h.portId)).toEqual(['in_l']);
    expect(plan.bands[0]!.holes[0]!.stereoSiblingPortId).toBe('in_r');
    expect(plan.bands[0]!.holes[0]!.label).toBe('IN');
    expect(plan.bands[1]!.holes.map((h) => h.portId)).toEqual(['rate', 'size', 'feedback']);
    expect(plan.bands[2]!.holes.map((h) => h.portId)).toEqual(['mix']);
    // The `~` tick lands on the four CV holes and NOWHERE else: the audio pair
    // is not "an audio-rate consumer" in the sense the tick marks (delay ticks
    // its `time` CV and not its `audio` input, for the same reason), and the
    // outputs rail never ticks at all.
    const ticked = plan.bands
      .flatMap((b) => b.holes)
      .filter((h) => h.audioRate)
      .map((h) => h.portId);
    expect(ticked).toEqual(['rate', 'size', 'feedback', 'mix']);
    expect(plan.outputs.some((h) => h.audioRate)).toBe(false);
    // The outputs rail knows L and R are one pair — and now DRAWS it as one
    // stereo hole (owner Q5), named from the pair's shared stem rather than
    // from either leg's own 'L' / 'R' label.
    expect(plan.outputs.map((h) => h.label)).toEqual(['OUT']);
    expect(plan.outputs[0]!.portId).toBe('out_l');
    expect(plan.outputs[0]!.stereoSiblingPortId).toBe('out_r');
  });

  // ── THE GLYPH CHOICE, MEASURED ─────────────────────────────────────────
  //
  // `scope` over the FX-family default `meter`, and the argument is that an RMS
  // meter is nearly BLIND to this module's hero control. That is an empirical
  // claim about the DSP, so it is measured here rather than asserted in the
  // face comment (CLAUDE.md: a metric blind to the dimension under test returns
  // a clean number regardless of what the code does).

  it('NEGATIVE CONTROL (the instrument, both directions)', () => {
    const a = render();
    const loud = Float32Array.from(a, (v) => v * 3);
    // The trace proxy must be invariant to LEVEL — it measures shape. (8 dp,
    // not exact: the buffer is Float32 and ×3 re-quantises the mantissa, so the
    // residual is ~5e-10 — six orders of magnitude below the 4.3× movement the
    // claim below is about.)
    expect(roughness(loud)).toBeCloseTo(roughness(a), 8);
    // …and the meter proxy must NOT be, or "the meter is blind" would be a
    // statement about a broken meter rather than about the module.
    expect(rms(loud) / rms(a)).toBeCloseTo(3, 7);
    // And the trace proxy must MOVE when the shape moves: the dry saw against
    // the default crush.
    const dry = render({ mix: 0 });
    expect(roughness(a)).toBeGreaterThan(roughness(dry) * 2);
  });

  it('an RMS meter barely twitches over RATE while the waveform changes completely', () => {
    const rendered = sweepParam('rate');
    const levels = rendered.map(rms);
    const shapes = rendered.map(roughness);
    const levelDb = 20 * Math.log10(spread(levels));
    const shapeSpread = spread(shapes);

    // MEASURED on this core (0.25 s of C4 saw, 9 points across 0.05..4):
    // level spread 3.96 dB, shape spread 5.05×.
    expect(
      levelDb,
      `an RMS meter moves ${levelDb.toFixed(2)} dB across RATE's whole range — ` +
        `if this grew, a 'meter' glyph might now be worth its rank`,
    ).toBeLessThan(5);
    expect(
      shapeSpread,
      `the waveform's roughness moves ${shapeSpread.toFixed(2)}× over the same sweep`,
    ).toBeGreaterThan(3);
    expect(shapeSpread / spread(levels)).toBeGreaterThan(2.5);
  });

  it('the two cells the COMPACT tile shows are the two the timbre is most sensitive to', () => {
    // The ranking is DERIVED from the DSP and the face is checked against it,
    // so a future re-rank has to re-argue the property instead of editing a
    // literal (the vca-gain-model precedent).
    const sensitivity = ringbackDef.params
      .map((p) => ({ id: p.id, s: spread(sweepParam(p.id).map(roughness)) }))
      .sort((a, b) => b.s - a.s);
    const topTwo = sensitivity.slice(0, 2).map((x) => x.id);
    const compact = curatedFace(ringbackDef, 'compact')!.controls.map((c) => c.key);
    expect(
      [...compact].sort(),
      `timbral sensitivity ranks ${sensitivity.map((x) => `${x.id}=${x.s.toFixed(2)}`).join(' ')}`,
    ).toEqual([...topTwo].sort());
    // And the gap to rank 3 is real, not a coin flip.
    expect(sensitivity[1]!.s / sensitivity[2]!.s).toBeGreaterThan(1.2);
  });

  it('NOTHING is inert at spawn — which is why this face does not rank MIX first', () => {
    // The vca face ranked by REACHABILITY (its defaults made every other cell
    // inert). That argument does not transfer, and the difference is testable:
    // moving ANY of the four defaults audibly changes the output.
    const base = render();
    for (const p of ringbackDef.params) {
      const other = p.id === 'mix' ? 0 : p.defaultValue === p.max ? p.min : p.max;
      const moved = render({ [p.id]: other });
      let maxDev = 0;
      for (let i = 0; i < base.length; i++) maxDev = Math.max(maxDev, Math.abs(base[i]! - moved[i]!));
      expect(maxDev, `${p.id} does nothing from the spawn state`).toBeGreaterThan(0.01);
    }
  });
});
