// art/scenarios/charlottes-echos/cv-path.test.ts
//
// DOES THE ONE DECLARED CV JACK CHANGE THE AUDIO — AND IS IT THE SAME TERMINAL
// THE KNOB WRITES?
//
// The gate owed by the #1661 / #1662 / #1664 defect class, run BEFORE this
// module was given a faceplate. In #1661 (`swolevco`) and #1662 (`mixmstrs`)
// the factory published an AudioParam belonging to a side node whose output
// reached no output port, so the KNOB path worked and the CABLE was a dead end
// while the motorized fader still animated. `charlottesEchos` declares exactly
// ONE `paramTarget` input (`delay`), so this sweep is a one-row table — and a
// one-row table is precisely where a per-module sweep is cheapest to skip and
// most expensive to have skipped.
//
// WHY NO EXISTING GATE SEES IT (module-adversarial-audit.md step 3):
//   * `art/scenarios/charlottes-echos/{profile,single-tap,wet-output}.test.ts`
//     drive the SHIPPED PROCESSOR CLASS directly through the registerProcessor
//     shim. They never call `charlottesEchosDef.factory()`, so the
//     publish-an-AudioParam seam does not exist in them at all.
//   * `contract-lock.txt` pins `in delay cv param=delay cvScale=log` — a
//     DECLARATION. The defect class is a VALUE (which node owns the param).
//   * `module-docs-lint` reads prose; `per-module-per-port-behavioral` proves
//     an EDGE MATERIALIZES, not that its far end reaches anything audible.
//
// THE INSTRUMENT, AND WHAT IT IS INVARIANT TO. The metric is peak |Δsample| in
// LINEAR AMPLITUDE (not dB, not RMS) over the whole render, maxed across OUT L
// and OUT R, against one shared control render. Two legs reach the param by two
// genuinely different code paths:
//   CV   — `ConstantSource(Δ) → handle.inputs.get('delay').param`, EXACTLY the
//          terminal `AudioEngine.addEdge` connects (engine.ts:489,
//          `connectSource.connect(din.param, connectOutput)`).
//   KNOB — `handle.setParam('delay', v)`, what the on-screen dial calls.
// A bit-exact zero is ALSO what a broken harness returns, so every null is
// paired with positive controls: a native-param MECH leg, a WORKLET k-rate MECH
// leg (node-web-audio-api could honour one and not the other), and the module's
// own audibility at the base patch.
//
// ⚠ THE STRONG RESULT IS THE AGREEMENT LEG, NOT THE MOVEMENT LEG. "The cable
// moved the audio" is satisfied by a param that is live but WRONG. Because a
// ConstantSource sums onto the AudioParam's own value, `CV(+Δ)` and
// `KNOB(base+Δ)` must produce the SAME RENDER TO THE BIT if — and only if — the
// jack and the dial are writing the same terminal. That is the assertion this
// file exists for; the movement legs are its positive controls.
//
// ⚠ THE BASE PATCH IS PART OF THE INSTRUMENT. `delay` is LOG-curved over
// 0.001..1.5 s and the def ships it at 0.4 s. A render must be long enough to
// contain the first echo at BOTH the base and the perturbed delay, or a live
// jack reads zero because the echo had not arrived yet. `BASE_DELAY_S` is
// pulled DOWN to 0.05 s for that reason and the choice is stated here because
// it is an assumption, not a default.
//
// Every driver is deterministic and nothing is pinned, so this scenario needs
// no baseline and no `.sha` — an assertion scenario like
// art/scenarios/warrensspectrum/cv-path.test.ts.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { CHARLOTTES_ECHOS_RANGES, charlottesEchosDef } from '$lib/audio/modules/charlottes-echos';

const SR = 48000;
const DUR_S = 0.6;
const N = Math.round(SR * DUR_S);

/** Base tap time for every leg. Short enough that several echoes land inside a
 *  0.6 s render at both the base and the perturbed value. */
const BASE_DELAY_S = 0.05;
/** The perturbation, in SECONDS of tap time — a doubling of the base, which
 *  moves every echo by a whole tap. */
const DELTA_S = 0.05;

/** The declared paramTarget inputs, DERIVED from the def. Never a literal: a
 *  second CV jack added tomorrow is swept by this file without an edit. */
const PARAM_INPUT_IDS = charlottesEchosDef.inputs.filter((p) => p.paramTarget).map((p) => p.id);
const PARAM_TARGET_OF = new Map(
  charlottesEchosDef.inputs.filter((p) => p.paramTarget).map((p) => [p.id, p.paramTarget!]),
);

function basePatch(): Record<string, number> {
  const p: Record<string, number> = {};
  for (const d of charlottesEchosDef.params) p[d.id] = d.defaultValue;
  p.delay = BASE_DELAY_S;
  // Wet-only: the dry path is a bit-exact wire (`mix = 0` copies the input), so
  // leaving MIX at 0.5 would put half the SOURCE in every render and shrink
  // every Δ below against a constant. The subject is the wet cascade.
  p.mix = 1;
  return p;
}

type Leg =
  | { kind: 'none' }
  | { kind: 'cv'; id: string; delta: number }
  | { kind: 'knob'; id: string; value: number }
  /** EXACTLY the branch `AudioEngine.scheduleParam` / `holdParam` take: when
   *  `inputs.get(id).param` exists they write the AudioParam and never call
   *  `setParam`, so a dead published param makes CLIP AUTOMATION inert too. */
  | { kind: 'automation'; id: string; value: number }
  /** Nothing patched into L at all. */
  | { kind: 'silent-in' }
  /** A source into L, nothing into R — the mono normal. */
  | { kind: 'mono-in' }
  /** A source into R, nothing into L — the cross-talk probe. */
  | { kind: 'r-in' };

interface Render {
  chans: Float32Array[];
  /** DERIVED off the LIVE handle: which paramTarget inputs publish their
   *  AudioParam on a node that is NOT the DSP worklet — the shape of the
   *  #1661/#1662 defect. */
  offWorkletHosts: string[];
}

async function render(base: Record<string, number>, leg: Leg): Promise<Render> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: N, sampleRate: SR });
  const node = { id: 'cv-path', type: 'charlottesEchos', position: { x: 0, y: 0 }, params: base } as never;
  const handle = await charlottesEchosDef.factory(ctx as unknown as AudioContext, node);

  if (leg.kind !== 'silent-in') {
    // A sawtooth: many harmonics, so a tap-time change shows up as a large
    // sample-wise Δ rather than a phase-shifted sine that can null.
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 220;
    const g = ctx.createGain();
    g.gain.value = 0.5;
    osc.connect(g);
    if (leg.kind !== 'r-in') {
      const l = handle.inputs.get('L')!;
      g.connect(l.node, 0, l.input);
    }
    if (leg.kind !== 'mono-in') {
      const r = handle.inputs.get('R')!;
      g.connect(r.node, 0, r.input);
    }
    osc.start(0);
  }

  // Duck-typed on `.parameters` (the AudioParamMap every AudioWorkletNode has
  // and a GainNode does not) rather than `instanceof`, so it does not depend on
  // which realm installed the AudioWorkletNode global.
  const offWorkletHosts: string[] = [];
  for (const p of charlottesEchosDef.inputs) {
    if (!p.paramTarget) continue;
    const ref = handle.inputs.get(p.id);
    if (ref?.param && !('parameters' in ref.node)) offWorkletHosts.push(p.id);
  }

  if (leg.kind === 'cv') {
    const ref = handle.inputs.get(leg.id);
    if (!ref) throw new Error(`cv-path: no input port '${leg.id}'`);
    if (!ref.param) throw new Error(`cv-path: input '${leg.id}' publishes no AudioParam`);
    const cs = ctx.createConstantSource();
    cs.offset.value = leg.delta;
    cs.connect(ref.param);
    cs.start(0);
  } else if (leg.kind === 'knob') {
    handle.setParam(leg.id, leg.value);
  } else if (leg.kind === 'automation') {
    const param = handle.inputs.get(leg.id)?.param;
    if (param) param.setValueAtTime(leg.value, 0);
    else handle.setParam(leg.id, leg.value);
  }

  const merger = ctx.createChannelMerger(2);
  const outL = handle.outputs.get('L')!;
  const outR = handle.outputs.get('R')!;
  outL.node.connect(merger, outL.output, 0);
  outR.node.connect(merger, outR.output, 1);
  merger.connect(ctx.destination);
  const buf = await ctx.startRendering();
  return { chans: [buf.getChannelData(0).slice(), buf.getChannelData(1).slice()], offWorkletHosts };
}

/** Peak |Δsample| in LINEAR AMPLITUDE across both output channels. */
function peakDelta(a: Render, b: Render): number {
  let peak = 0;
  for (let k = 0; k < a.chans.length; k++) {
    const x = a.chans[k]!;
    const y = b.chans[k]!;
    for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(x[i]! - y[i]!));
  }
  return peak;
}
/** Peak |sample| in LINEAR AMPLITUDE across both output channels. */
function peakAbs(r: Render): number {
  let peak = 0;
  for (const ch of r.chans) for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(ch[i]!));
  return peak;
}
const fmt = (v: number) => (v === 0 ? '0.0000e+0' : v.toExponential(4));

/** Each leg builds a fresh OfflineAudioContext around the REAL worklet. */
const SWEEP_TIMEOUT_MS = 300_000;

describe("ART charlotte's echos / CV path — the DELAY jack and the DELAY dial are one terminal", () => {
  it('MECH control — ConstantSource(1) → GainNode.gain modulates in THIS harness', async () => {
    const run = async (withCv: boolean) => {
      const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: N, sampleRate: SR });
      const osc = ctx.createOscillator();
      osc.frequency.value = 220;
      const g = ctx.createGain();
      g.gain.value = 0.25;
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(0);
      if (withCv) {
        const cs = ctx.createConstantSource();
        cs.offset.value = 1;
        cs.connect(g.gain);
        cs.start(0);
      }
      const d = (await ctx.startRendering()).getChannelData(0);
      let peak = 0;
      for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(d[i]!));
      return peak;
    };
    const off = await run(false);
    const on = await run(true);
    // Without this leg, "the cable never connected" and "the cable connected to
    // nothing" are indistinguishable from a bit-exact zero below.
    expect(on, `CS(1)→gain must modulate: ${off.toFixed(9)} → ${on.toFixed(9)} (linear peak)`)
      .toBeGreaterThan(off * 2);
  }, SWEEP_TIMEOUT_MS);

  it('MECH control — ConstantSource → an AudioWorkletNode AudioParam modulates in THIS harness', async () => {
    // GainNode.gain is a NATIVE param. The param under test is an
    // AudioWorkletNode param, a different code path in node-web-audio-api.
    // Without this leg a bit-exact zero below could be the HOST not honouring
    // worklet-param connections rather than the module not wiring them — the
    // two are indistinguishable from the output alone. `mix` is used because it
    // is a pure output scalar with no dependence on the delay line's state.
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: N, sampleRate: SR });
    const node = { id: 'cv-path-mech', type: 'charlottesEchos', position: { x: 0, y: 0 }, params: base } as never;
    const handle = await charlottesEchosDef.factory(ctx as unknown as AudioContext, node);
    const l = handle.inputs.get('L')!;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 220;
    const g = ctx.createGain();
    g.gain.value = 0.5;
    osc.connect(g);
    g.connect(l.node, 0, l.input);
    const r = handle.inputs.get('R')!;
    g.connect(r.node, 0, r.input);
    osc.start(0);
    // `mix` has no CV input port, so this reaches its AudioParam the only way
    // the platform can: off the worklet's own parameter map.
    const mixParam = (handle.inputs.get('delay')!.node as unknown as {
      parameters: Map<string, AudioParam>;
    }).parameters.get('mix')!;
    const cs = ctx.createConstantSource();
    cs.offset.value = -1; // wet 1 → dry (clamped)
    cs.connect(mixParam);
    cs.start(0);
    const merger = ctx.createChannelMerger(2);
    const oL = handle.outputs.get('L')!;
    const oR = handle.outputs.get('R')!;
    oL.node.connect(merger, oL.output, 0);
    oR.node.connect(merger, oR.output, 1);
    merger.connect(ctx.destination);
    const buf = await ctx.startRendering();
    const withCv: Render = {
      chans: [buf.getChannelData(0).slice(), buf.getChannelData(1).slice()],
      offWorkletHosts: [],
    };
    const d = peakDelta(withCv, ctrl);
    expect(d, `CS(-1)→worklet 'mix' must modulate: peak |Δsample| linear = ${fmt(d)}`)
      .toBeGreaterThan(0);
  }, SWEEP_TIMEOUT_MS);

  it('the module SOUNDS at the base patch, and only because L is patched', async () => {
    // The positive control on the base patch itself. Every Δ below is measured
    // against `ctrl`; if `ctrl` were silent, every row would read the target
    // leg's own peak and a dead cable would look alive.
    const base = basePatch();
    const live = await render(base, { kind: 'none' });
    const silent = await render(base, { kind: 'silent-in' });
    const livePeak = peakAbs(live);
    const silentPeak = peakAbs(silent);
    expect(livePeak, `base patch must be audible: peak |sample| linear = ${fmt(livePeak)}`)
      .toBeGreaterThan(0.01);
    // An EFFECT with nothing patched is silent — and it is the factory's own
    // `silenceL` ConstantSource that keeps the node alive while producing this
    // zero. `mono-normal-not-defeated.test.ts` owns WHY it is on input 0 only.
    expect(silentPeak, `an effect with nothing patched must be silent: ${fmt(silentPeak)}`).toBe(0);
  }, SWEEP_TIMEOUT_MS);

  it('every declared paramTarget input moves the audio through the KNOB path', async () => {
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    const dead: string[] = [];
    const table: string[] = [];
    for (const id of PARAM_INPUT_IDS) {
      const target = PARAM_TARGET_OF.get(id)!;
      const to = base[target]! + DELTA_S;
      const d = peakDelta(await render(base, { kind: 'knob', id: target, value: to }), ctrl);
      table.push(`${id}→${target} ${base[target]}→${to} ${fmt(d)}`);
      if (d === 0) dead.push(`${id} (${target} → ${to})`);
    }
    // BOTH a real assertion and the per-input positive control for the CV sweep
    // below: a row that reads zero on both legs is the base patch being blind,
    // not a dead cable.
    expect(dead, `controls inert from their own knob — peak |Δsample| linear = 0. Table: ${table.join(' | ')}`)
      .toEqual([]);
  }, SWEEP_TIMEOUT_MS);

  it('every paramTarget input moves the audio through the CV path', async () => {
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    const dead: string[] = [];
    const table: string[] = [];
    for (const id of PARAM_INPUT_IDS) {
      const d = peakDelta(await render(base, { kind: 'cv', id, delta: DELTA_S }), ctrl);
      table.push(`${id} +${DELTA_S}s ${fmt(d)}`);
      if (d === 0) dead.push(id);
    }
    expect(dead, `CV cable inert (linear peak |Δsample| = 0) on: ${table.join(' | ')}`).toEqual([]);
  }, SWEEP_TIMEOUT_MS);

  it('THE STRONG LEG — CV(+Δ) and KNOB(base+Δ) are the SAME RENDER, to the bit', async () => {
    // A ConstantSource SUMS onto the AudioParam's own value, so if the jack and
    // the dial write the same terminal these two renders are identical. A live
    // jack wired to a DIFFERENT param (or through a stray scaler) still moves
    // the audio and still passes the sweep above — it fails here.
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    for (const id of PARAM_INPUT_IDS) {
      const target = PARAM_TARGET_OF.get(id)!;
      const viaCv = await render(base, { kind: 'cv', id, delta: DELTA_S });
      const viaKnob = await render(base, { kind: 'knob', id: target, value: base[target]! + DELTA_S });
      const agree = peakDelta(viaCv, viaKnob);
      const moved = peakDelta(viaCv, ctrl);
      expect(
        moved,
        `${id}: the perturbation must LAND before agreement means anything — ` +
          `peak |Δsample| linear vs control = ${fmt(moved)}`,
      ).toBeGreaterThan(0);
      expect(
        agree,
        `${id} → ${target}: CV(+${DELTA_S}) vs KNOB(${base[target]! + DELTA_S}) must be the same ` +
          `terminal — peak |Δsample| linear = ${fmt(agree)}, while each moved ${fmt(moved)} ` +
          `against the control`,
      ).toBe(0);
    }
  }, SWEEP_TIMEOUT_MS);

  it('SCOPE — no paramTarget input is published on a node other than the DSP worklet', async () => {
    // Deny-by-default and DERIVED off the LIVE handle, not typed. The #1661
    // defect shape removes an input from any filter that asks "is it on the
    // worklet", so a sweep that silently skipped such rows would stay green
    // through the exact defect it exists to find. Nothing is skipped here and
    // the expected set is EMPTY, so the two cannot both be satisfied by a
    // vanishing subject.
    const ctrl = await render(basePatch(), { kind: 'none' });
    expect(
      ctrl.offWorkletHosts.slice().sort(),
      'paramTarget inputs published on a non-DSP node — their CV would be a dead end; see #1661/#1662',
    ).toEqual([]);
    // …and the subject is non-empty: a sweep over nothing is green for free.
    expect(PARAM_INPUT_IDS.length, 'this module declares at least one CV jack to sweep')
      .toBeGreaterThan(0);
  }, SWEEP_TIMEOUT_MS);

  it('CLIP AUTOMATION reaches the same live param the CV cable does', async () => {
    // engine.ts prefers `inputs[id].param` over `setParam`, so a dead published
    // param makes automation inert too. Asserting AGREEMENT with the knob leg is
    // the strong form: "automation moved something" passes on a param that moved
    // the wrong control.
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    for (const id of PARAM_INPUT_IDS) {
      const target = PARAM_TARGET_OF.get(id)!;
      const to = base[target]! + DELTA_S;
      const auto = peakDelta(await render(base, { kind: 'automation', id, value: to }), ctrl);
      const knob = peakDelta(await render(base, { kind: 'knob', id: target, value: to }), ctrl);
      expect(auto, `${id}: automation must reach a LIVE param: ${fmt(auto)} vs knob ${fmt(knob)}`)
        .toBeGreaterThan(0);
      expect(auto, `${id}: automation and knob agree (linear peak |Δsample|)`).toBeCloseTo(knob, 9);
    }
  }, SWEEP_TIMEOUT_MS);

  it('the two audio INPUT PORTS are SEPARABLE — two independent cascades, zero cross-talk', async () => {
    // The factory maps L→worklet input 0 and R→input 1. A transposed index would
    // leave one of them accepting a cable and doing nothing — the same lie as a
    // dead CV jack, and invisible until patched.
    //
    // This also measures the fact the faceplate's sidebar PRINTS ("dual mono —
    // no width, no ping-pong"): the two channels never interact, because
    // `charlottes-echos.ts` pins stereoOffset / pan / panMode to 0 for every
    // stage. Signal into R alone must leave OUT L bit-exactly silent.
    const base = basePatch();
    const rOnly = await render(base, { kind: 'r-in' });
    let lPeak = 0;
    let rPeak = 0;
    for (let i = 0; i < N; i++) {
      lPeak = Math.max(lPeak, Math.abs(rOnly.chans[0]![i]!));
      rPeak = Math.max(rPeak, Math.abs(rOnly.chans[1]![i]!));
    }
    expect(rPeak, `a source into R must reach OUT R: peak |sample| linear = ${fmt(rPeak)}`)
      .toBeGreaterThan(0.01);
    expect(
      lPeak,
      `…and must NOT reach OUT L — the two cascades are independent: ${fmt(lPeak)}`,
    ).toBe(0);
  }, SWEEP_TIMEOUT_MS);

  it("SCOPE — this harness CANNOT see the mono normal, and here is the proof", async () => {
    // ⚠ STATE WHAT THE GATE IS STRUCTURALLY UNABLE TO SEE, and assert it, so a
    // green run here is never mistaken for coverage of the normal.
    //
    // The DSP reads `inputs[1]?.[0] ?? inputs[0]?.[0]`, so an UNPATCHED R
    // follows L — in CHROME, where an unconnected worklet input is ABSENT.
    // node-web-audio-api hands the processor a zero-filled buffer for input 1
    // regardless, so the `??` can never fire here and an unpatched R renders as
    // digital silence: MEASURED max|L−R| = 9.011e-1 on this leg, against
    // 0.000e+0 in a real browser.
    //
    // That is a property of THIS HOST, not of the module — and it is the exact
    // shape of the #1343 defect (`clouds` / `shimmershine` / `charlottes-echos` /
    // `cofefve` all pinned a ConstantSource to input 1 "for liveness" and
    // defeated their own normal), which is why it is asserted rather than left
    // as a comment. The property itself is owned by
    // `packages/web/src/lib/audio/mono-normal-not-defeated.test.ts` (source
    // level, every spelling) and `e2e/tests/stereo-mono-normal.spec.ts` (a REAL
    // browser). If this assertion ever goes red, node-web-audio-api has started
    // modelling absent inputs and this leg should become the real check.
    const base = basePatch();
    const mono = await render(base, { kind: 'mono-in' });
    let monoDiff = 0;
    for (let i = 0; i < N; i++) {
      monoDiff = Math.max(monoDiff, Math.abs(mono.chans[0]![i]! - mono.chans[1]![i]!));
    }
    expect(
      monoDiff,
      'this harness zero-fills an unconnected worklet input, so the DSP mono normal ' +
        `cannot fire here — see mono-normal-not-defeated.test.ts. max|L−R| = ${fmt(monoDiff)}`,
    ).toBeGreaterThan(0);
    // …and the leg is not vacuous: L is genuinely audible, so the difference is
    // "R is silent", not "both are".
    expect(peakAbs(mono), 'the L cascade must be audible for that difference to mean anything')
      .toBeGreaterThan(0.01);
  }, SWEEP_TIMEOUT_MS);

  it('the RANGES the card binds are the DEF own ParamDefs, by identity', () => {
    // The card/def divergence class (analogVco: `min={0}` against a def
    // declaring −1) is a SOURCE property no render can see. `CHARLOTTES_ECHOS_RANGES`
    // is the one place the numbers live; this asserts the export IS the def's
    // params rather than a second copy that could drift.
    for (const p of charlottesEchosDef.params) {
      expect(CHARLOTTES_ECHOS_RANGES[p.id], `'${p.id}' must be the def's own ParamDef object`).toBe(p);
    }
    expect(Object.keys(CHARLOTTES_ECHOS_RANGES).sort()).toEqual(
      charlottesEchosDef.params.map((p) => p.id).sort(),
    );
  });
});
