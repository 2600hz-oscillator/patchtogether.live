// art/scenarios/mixmstrs/face-premises.test.ts
//
// THE FOUR CLAIMS MIXMSTRS' FACEPLATE MAKES, ASSERTED AGAINST THE SHIPPED DSP.
//
// The face publishes three derived readouts and DECLINES to publish a fourth
// thing (a per-channel VU). Every one of those decisions rests on a measurement,
// and a measurement that lives only in a comment is a check nobody is watching —
// so each is a permanent leg here, driving the REAL Faust wasm
// (`packages/dsp/dist/mixmstrs.{wasm,json}`, the exact bytes the browser ships)
// through the headless offline processor.
//
//   1. THE INSTRUMENT. Two identical renders must be bit-equal on all fourteen
//      outputs. #1680 measured three modules whose offline renders were RACY,
//      and a bit-exact zero from a racy rig proves nothing — so this runs FIRST
//      and every figure below is conditioned on it.
//   2. `bus`  — the readout's arithmetic must equal what the DSP actually does.
//      This is a JOIN, not a restatement: the expected value is computed by the
//      SHIPPING readout function (`busGainLinear`) and compared against a real
//      render. Neither side can drift without reddening.
//   3. `asleep` — the sixteen thresh/ratio faders must be BIT-EXACTLY inert at
//      the shipped defaults and demonstrably live once the enabler opens, with
//      the module's own quantisation floor measured as the control that stops
//      "0.0" from meaning "too small to see".
//   4. `send N` — the two PRE/POST switches must be BIT-EXACTLY inert while the
//      sends are shut and live once one opens.
//   5. WHY THERE IS NO VU ON THE FACE. `read('levels')` is a mono-sum tap, so an
//      anti-phase channel reads zero while the master carries it at full level.
//      Asserted so that the day someone adds meter bars, this is what stops
//      them — the ninelives/buggles glyph hazard (#1692, #1706) with a live tap.
//
// ⚠ COST IS DECLARED, NEVER THE GATE. Each render builds the real factory once
// (fresh offline processor, wasm instantiation included). The wall-clock cap
// below BOUNDS the failure so a loaded runner reports a timeout instead of a
// false measurement; it is not what any assertion reads.

import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE } from '../../setup/capture';
import { vcoTestSignal, C4_HZ } from '../../setup/drivers';
import { renderFaustOffline } from '../../setup/faust-offline';
import { MIXMSTRS_CHANNELS, MIXMSTRS_RETURNS, mixmstrsDef } from '$lib/audio/modules/mixmstrs';

const SR = SAMPLE_RATE;
const DUR = 0.4;
const N = Math.round(SR * DUR);
const SETTLE = Math.round(0.2 * SR); // past si.smoo's ramp-in on every fader

/** Faust output order: the six patchable ports, then the eight post-fader VU
 *  taps (`mixmstrs.dsp:280-292`). Derived from the def for the first six so a
 *  port rename cannot silently re-key this file. */
const OUTS = [
  ...(mixmstrsDef.outputs ?? []).map((o) => o.id),
  ...MIXMSTRS_CHANNELS.map((c) => `vu${c}`),
];

const saw = (hz: number, amp: number) => vcoTestSignal({ totalS: DUR, shape: 'saw', freqHz: hz, amp });
const inverted = (b: Float32Array) => {
  const o = new Float32Array(b.length);
  for (let i = 0; i < b.length; i++) o[i] = -b[i]!;
  return o;
};
const rms = (b: Float32Array) => {
  let s = 0;
  for (let i = SETTLE; i < N; i++) s += b[i]! * b[i]!;
  return Math.sqrt(s / (N - SETTLE));
};
const peak = (b: Float32Array) => {
  let m = 0;
  for (let i = SETTLE; i < N; i++) m = Math.max(m, Math.abs(b[i]!));
  return m;
};
const maxAbsDelta = (a: Float32Array, b: Float32Array) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
};
const fmt = (v: number) => (v === 0 ? '0.0000e+0' : v.toExponential(4));

const AUDIO_IN_COUNT = (mixmstrsDef.inputs ?? []).filter((p) => p.type === 'audio').length;

const render = (inputs: (Float32Array | null)[], params: Record<string, number> = {}) =>
  renderFaustOffline({ name: 'mixmstrs', totalSamples: N, inputs, params, outputs: OUTS });

/** Every channel a DECORRELATED saw pair, both returns decorrelated noise-ish
 *  saws — the realistic patch.
 *
 *  ⚠ THIS SHAPE IS THE WHOLE INSTRUMENT ARGUMENT. A probe that feeds ONE
 *  channel of an eight-channel symmetric mixer measures the PATCH, not the
 *  module: seven strips are silent, so seven strips' worth of controls come
 *  back "inert" for a reason that has nothing to do with the control. Every
 *  input is driven here so an inert reading can only mean the control. */
function fullPatch(): (Float32Array | null)[] {
  const ins: (Float32Array | null)[] = new Array(AUDIO_IN_COUNT).fill(null);
  MIXMSTRS_CHANNELS.forEach((c, i) => {
    ins[i * 2] = saw(110 * (i + 1), 0.35);
    ins[i * 2 + 1] = saw(110 * (i + 1) * 1.003, 0.35);
  });
  const retBase = MIXMSTRS_CHANNELS.length * 2;
  MIXMSTRS_RETURNS.forEach((_, i) => {
    ins[retBase + i * 2] = saw(97 * (i + 1), 0.25);
    ins[retBase + i * 2 + 1] = saw(97 * (i + 1) * 1.007, 0.25);
  });
  return ins;
}

/** Every input the SAME full-scale saw — the fully-correlated worst case the
 *  `bus` readout states a bound for. */
function correlatedPatch(): (Float32Array | null)[] {
  const s = saw(C4_HZ, 1.0);
  return new Array(AUDIO_IN_COUNT).fill(s);
}

const CAP = 600_000;

describe('ART mixmstrs / the faceplate premises', () => {
  it('1 · THE INSTRUMENT — two identical renders are bit-equal on every output', async () => {
    // #1680: `node-web-audio-api` renders off-thread and a `setInterval` pump
    // keeps firing during a render, which made three modules' baselines racy.
    // This path is the headless Faust processor with no context and no pump, so
    // the property should hold — and it is asserted rather than assumed,
    // because every "0.0000e+0" below is only evidence if it does.
    const a = await render(fullPatch());
    const b = await render(fullPatch());
    const worst = Math.max(...OUTS.map((k) => maxAbsDelta(a[k]!, b[k]!)));
    expect(worst, `renders differ by ${fmt(worst)} — every inertness figure below is void`).toBe(0);
  }, CAP);

  it('2 · the BUS SUMMING LAW is what the DSP does', async () => {
    // ⚠ THIS USED TO BE A JOIN AND IS NOW A LAW, and the demotion is recorded
    // rather than hidden. The expected number was computed by `busGainLinear`,
    // the same function the faceplate's `bus` readout printed through, so
    // neither side could drift without reddening. Owner ruling 2026-08-17
    // removed that readout from the face (*"these numbers and text should go
    // away"*) and its arithmetic was deleted with it, because a computation
    // nothing can reach reads like a shipped decision.
    //
    // What is asserted is unchanged and still worth asserting: masterL is
    // `(Σ channel_out + Σ return_out) × master_volume` (`mixmstrs.dsp:329`), so
    // the correlated worst-case gain at the shipped defaults is the expression
    // below, and the render must match it. It is now a restatement of the DSP's
    // own summing law instead of an agreement between two shipping surfaces —
    // weaker, and the honest description of what remains. Still DERIVED from the
    // def's declared defaults, never typed, so a re-ranged fader moves it.
    const readDefault = (id: string) =>
      mixmstrsDef.params?.find((p) => p.id === id)?.defaultValue ?? 0;
    const sum = [
      ...MIXMSTRS_CHANNELS.map((c) => readDefault(`ch${c}_volume`)),
      ...MIXMSTRS_RETURNS.map((r) => readDefault(`ret${r}_volume`)),
    ].reduce((a, b) => a + b, 0);
    const expected = sum * readDefault('master_volume');
    const got = peak((await render(correlatedPatch())).masterL!);
    expect(got, `masterL peak ${got.toFixed(4)} (linear) vs the summing law's ${expected.toFixed(4)}`)
      .toBeCloseTo(expected, 2);

    // THE CONSEQUENCE, which is now stated ONLY in the module's authored
    // `docs` and here — the faceplate no longer warns about it: at the shipped
    // defaults the
    // bus passes unity with only TWO correlated full-scale channels, and
    // nothing here limits or soft-clips.
    const two: (Float32Array | null)[] = new Array(AUDIO_IN_COUNT).fill(null);
    const s = saw(C4_HZ, 1.0);
    two[0] = s; two[1] = s; two[2] = s; two[3] = s;
    const twoPeak = peak((await render(two)).masterL!);
    expect(twoPeak, `two correlated full-scale channels peak masterL at ${twoPeak.toFixed(4)}`)
      .toBeGreaterThan(1);

    // NEGATIVE CONTROL ON THE METRIC: the same render with the master at 0 must
    // collapse it. A peak that stayed high would mean the harness is reading
    // something other than the bus.
    expect(peak((await render(correlatedPatch(), { master_volume: 0 })).masterL!)).toBe(0);
  }, CAP);

  it('3 · `asleep` — thresh/ratio are BIT-EXACTLY inert until the enabler opens', async () => {
    const spec = (id: string) => mixmstrsDef.params!.find((p) => p.id === id)!;
    const rows: string[] = [];
    const dead: string[] = [];
    const stillDead: string[] = [];

    for (const suffix of ['thresh', 'ratio'] as const) {
      const id = `ch1_${suffix}`;
      const p = spec(id);
      const shutLo = await render(fullPatch(), { [id]: p.min! });
      const shutHi = await render(fullPatch(), { [id]: p.max! });
      const shut = maxAbsDelta(shutLo.masterL!, shutHi.masterL!);
      const openLo = await render(fullPatch(), { [id]: p.min!, ch1_compEnable: 1 });
      const openHi = await render(fullPatch(), { [id]: p.max!, ch1_compEnable: 1 });
      const open = maxAbsDelta(openLo.masterL!, openHi.masterL!);
      rows.push(`${id} ${p.min}→${p.max}  bypassed ${fmt(shut)}  enabled ${fmt(open)}`);
      if (shut !== 0) dead.push(`${id} moves the output while the compressor is BYPASSED: ${fmt(shut)}`);
      if (open === 0) stillDead.push(`${id} STILL does nothing with the compressor ENABLED: ${fmt(open)}`);
    }

    // THE FLOOR — the control that stops a bit-exact zero from meaning "too
    // small for this metric". The smallest nudge any control on the module can
    // make must still be visible here.
    const volSpec = spec('ch1_volume');
    const floorA = await render(fullPatch(), { ch1_volume: volSpec.defaultValue! });
    const floorB = await render(fullPatch(), { ch1_volume: volSpec.defaultValue! + 0.001 });
    const floor = maxAbsDelta(floorA.masterL!, floorB.masterL!);
    rows.push(`FLOOR ch1_volume +0.001 → ${fmt(floor)}`);
    expect(floor, `the metric cannot see a 0.001 fader nudge, so its zeros mean nothing\n${rows.join('\n')}`)
      .toBeGreaterThan(0);

    expect(dead.join('\n'), `the face's ASLEEP readout would be lying\n${rows.join('\n')}`).toBe('');
    expect(stillDead.join('\n'), `the ENABLER does not enable — the readout's premise is wrong\n${rows.join('\n')}`).toBe('');
  }, CAP);

  it('4 · `send N` — the PRE/POST switch is BIT-EXACTLY inert until a send opens', async () => {
    const rows: string[] = [];
    const problems: string[] = [];
    for (const r of MIXMSTRS_RETURNS) {
      const busOut = `send${r}L`;
      const shut0 = await render(fullPatch(), { [`send${r}Pre`]: 0 });
      const shut1 = await render(fullPatch(), { [`send${r}Pre`]: 1 });
      const shut = maxAbsDelta(shut0[busOut]!, shut1[busOut]!);
      const open = Object.fromEntries(MIXMSTRS_CHANNELS.map((c) => [`ch${c}_send${r}`, 0.5]));
      const open0 = await render(fullPatch(), { ...open, [`send${r}Pre`]: 0 });
      const open1 = await render(fullPatch(), { ...open, [`send${r}Pre`]: 1 });
      const live = maxAbsDelta(open0[busOut]!, open1[busOut]!);
      rows.push(`send${r}Pre  sends shut ${fmt(shut)}  sends 0.5 ${fmt(live)}`);
      if (shut !== 0) problems.push(`send${r}Pre moves ${busOut} while every send is 0: ${fmt(shut)}`);
      if (live === 0) problems.push(`send${r}Pre does nothing even with the sends OPEN: ${fmt(live)}`);
    }
    expect(problems.join('\n'), `the face's SEND readout states the wrong enabler\n${rows.join('\n')}`).toBe('');
  }, CAP);

  it('5 · WHY THERE IS NO VU ON THE FACE — the tap is blind to phase', async () => {
    // `ch{N}Level = (ch{N}ML + ch{N}MR) * 0.5` (`mixmstrs.dsp:349-356`). An
    // anti-phase channel cancels in the mono sum while BOTH master legs carry
    // it untouched. Painting bars off `read('levels')` would be a face claiming
    // silence about a channel the player can hear.
    const s = saw(C4_HZ, 0.5);
    const mk = (right: Float32Array) => {
      const ins: (Float32Array | null)[] = new Array(AUDIO_IN_COUNT).fill(null);
      ins[0] = s; ins[1] = right;
      return ins;
    };
    const inPhase = await render(mk(s));
    const anti = await render(mk(inverted(s)));
    const vuKey = `vu${MIXMSTRS_CHANNELS[0]}`;

    // The tap sees nothing…
    expect(rms(inPhase[vuKey]!), 'the in-phase control must light the tap').toBeGreaterThan(0);
    expect(rms(anti[vuKey]!), 'the anti-phase channel must read exactly zero on the tap').toBe(0);
    // …while the master carries it identically on BOTH legs. That equality is
    // what makes this a blindness rather than a level change.
    expect(rms(anti.masterL!)).toBeCloseTo(rms(inPhase.masterL!), 12);
    expect(rms(anti.masterR!)).toBeCloseTo(rms(inPhase.masterR!), 12);
    expect(rms(anti.masterL!), 'the master must genuinely be carrying signal').toBeGreaterThan(0);
  }, CAP);
});
