// art/scenarios/warrensspectrum/cv-path.test.ts
//
// DOES A CV CABLE ON A `paramTarget` INPUT CHANGE THE AUDIO?
//
// The gate owed by the #1661 / #1662 defect class (`swolevco`: four declared CV
// inputs bit-exactly audio-inert; `mixmstrs`: eight COMP macros the same) —
// in both, the factory published an AudioParam belonging to a side `GainNode`
// whose output reached no output port, so only the KNOB path (`setParam`) did
// anything while the motorized fader still animated the cable's modulation.
//
// WHY NO EXISTING GATE SEES THIS (module-adversarial-audit.md step 3):
//  * `art/scenarios/warrensspectrum/profile.test.ts` renders the pure-TS
//    `WarrensSpectrumEngine` DIRECTLY. It never builds the def's factory, so
//    the publish-an-AudioParam seam does not exist in it at all.
//  * `packages/web/src/lib/audio/modules/warrensspectrum.test.ts` reads the
//    DECLARATION (port ids, ranges, alias contract) — correct, and blind to
//    which AudioNode the published param belongs to.
//  * `contract-lock` / `module-docs-lint` read the declaration too.
//    (Audit shape 1: the thing that is wrong would be a VALUE, not a
//    declaration.)
//  * `per-module-per-port-behavioral.spec.ts` proves an EDGE MATERIALIZES, not
//    that the edge's far end is connected to anything that sounds.
//
// THE INSTRUMENT, AND WHAT IT IS INVARIANT TO. Two legs per input against one
// shared control render; the metric is peak |Δsample| (LINEAR amplitude, not
// dB, not RMS) over a settled window, maxed across OUT L and OUT R:
//   CV   — ConstantSource(delta) → `handle.inputs.get(id).param`, which is
//          EXACTLY the terminal `AudioEngine.addEdge` connects (engine.ts:489,
//          `connectSource.connect(din.param, connectOutput)`).
//   KNOB — `handle.setParam(id, target)`, which is what the on-screen control
//          calls. A different code path: one can work while the other does not.
// A bit-exact zero is ALSO what a broken instrument returns, so every null is
// paired with positive controls:
//   * MECH — ConstantSource(1) → GainNode.gain moves a render in THIS harness
//     (the mechanism works here at all);
//   * MECH-WORKLET — ConstantSource → a k-rate AudioWorkletNode AudioParam
//     moves a render in this harness. GainNode.gain alone is NOT enough of a
//     control for this module: every param under test is a worklet k-rate
//     param, and node-web-audio-api could in principle honour one and not the
//     other. This leg is the one that makes a zero below attributable.
//   * the per-input KNOB sweep is the positive control on the METRIC, per
//     input, on every run — a row that reads zero on BOTH legs is the base
//     patch being blind, not a dead cable.
//
// ⚠ THE BASE PATCH IS PART OF THE INSTRUMENT. This engine has a 0.6 s default
// amplitude SLEW and a 3-frame stability gate; at those values a 0.5 s render
// is mostly ramp and several controls read a near-null for reasons that have
// nothing to do with wiring. `basePatch()` therefore sets SLEW to its 0.02 s
// floor and STABILITY to 1, and the settle window starts past the first FFT
// commit. Both are stated here because they are assumptions, not defaults.
//
// Every driver is deterministic and nothing is pinned, so this scenario needs
// no baseline and no `.sha` — it is an assertion scenario like
// art/scenarios/mixmstrs/prefader-sends.test.ts.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { warrensspectrumDef, WARRENSSPECTRUM_RANGES } from '$lib/audio/modules/warrensspectrum';

const SR = 48000;
const DUR_S = 0.5;
const N = Math.round(SR * DUR_S);
/** Past the first analysis commits (2048-sample window + 3 × 10 ms slices). */
const SETTLE = Math.round(0.25 * SR);

const OUTS = ['out'] as const;

/**
 * A control render every leg is compared against. SLEW and STABILITY are
 * pulled off their defaults on purpose — see the header. Everything else is
 * the def's own shipped default, so a row reads as a deviation from the
 * module as it spawns.
 */
function basePatch(): Record<string, number> {
  return {
    engineMode: WARRENSSPECTRUM_RANGES.engineMode.defaultValue,
    spectralBandCount: WARRENSSPECTRUM_RANGES.spectralBandCount.defaultValue,
    spectralPartials: WARRENSSPECTRUM_RANGES.spectralPartials.defaultValue,
    spectralFloor: WARRENSSPECTRUM_RANGES.spectralFloor.defaultValue,
    spectralLock: WARRENSSPECTRUM_RANGES.spectralLock.defaultValue,
    spectralResidual: WARRENSSPECTRUM_RANGES.spectralResidual.defaultValue,
    spectralShape: WARRENSSPECTRUM_RANGES.spectralShape.defaultValue,
    spectralCenter: WARRENSSPECTRUM_RANGES.spectralCenter.defaultValue,
    spectralSlice: WARRENSSPECTRUM_RANGES.spectralSlice.defaultValue,
    engineFreeze: WARRENSSPECTRUM_RANGES.engineFreeze.defaultValue,
    resynthLevel: WARRENSSPECTRUM_RANGES.resynthLevel.defaultValue,
    inputMix: WARRENSSPECTRUM_RANGES.inputMix.defaultValue,
    gain: WARRENSSPECTRUM_RANGES.gain.defaultValue,
    // ── the two deliberate deviations ──
    // 0.6 s of amplitude smoothing over a 0.5 s render makes every leg a ramp.
    spectralSlew: WARRENSSPECTRUM_RANGES.spectralSlew.min,
    // 3 frames of birth-gating delays every partial past the settle window at
    // the shortest useful SLICE.
    spectralStab: WARRENSSPECTRUM_RANGES.spectralStab.min,
  };
}

/** The far end of each control's travel from its base — chosen for AUDIBILITY,
 *  so a live control cannot read zero by coincidence. */
function perturbTarget(id: string): number {
  switch (id) {
    // 64 tracked partials → a bare fundamental.
    case 'spectralPartials': return 4;
    // harmonic comb → the raw analysed frequencies.
    case 'spectralLock': return 0;
    // half residual → double residual.
    case 'spectralResidual': return WARRENSSPECTRUM_RANGES.spectralResidual.max;
    // sine voices → square voices.
    case 'spectralShape': return WARRENSSPECTRUM_RANGES.spectralShape.max;
    // 10 ms re-analysis → 200 ms sample-and-hold.
    case 'spectralSlice': return WARRENSSPECTRUM_RANGES.spectralSlice.max;
    // unison → up an octave.
    case 'spectralCenter': return 1200;
    default:
      throw new Error(`cv-path: no perturbation declared for '${id}' — a new paramTarget input needs one`);
  }
}

type Leg =
  | { kind: 'none' }
  | { kind: 'cv'; id: string; delta: number }
  | { kind: 'knob'; id: string; value: number }
  /** EXACTLY the branch `AudioEngine.scheduleParam` (engine.ts:700) and
   *  `holdParam` (:754) take: when `inputs.get(id).param` exists they write
   *  the AudioParam and NEVER call `setParam`. So a dead published param makes
   *  CLIP AUTOMATION of that control inert too. */
  | { kind: 'automation'; id: string; value: number }
  /** A cable on one of the three audio-rate INPUT PORTS (audio_in / pitch /
   *  gate). Not a paramTarget — this leg drives `ref.node` at `ref.input`. */
  | { kind: 'port'; id: string; offset: number }
  /** No source patched into audio_in at all. */
  | { kind: 'silent-in' };

interface Render {
  chans: Float32Array[];
  /** DERIVED: which paramTarget inputs publish their AudioParam on a node that
   *  is NOT the DSP worklet — the shape of the #1661/#1662 defect. */
  offWorkletHosts: string[];
}

async function render(base: Record<string, number>, leg: Leg): Promise<Render> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: N, sampleRate: SR });
  const node = { id: 'cv-path', type: 'warrensspectrum', position: { x: 0, y: 0 }, params: base } as never;
  const handle = await warrensspectrumDef.factory(ctx as unknown as AudioContext, node);

  if (leg.kind !== 'silent-in') {
    // A sawtooth is the honest source for a peak tracker: many partials, all
    // harmonic, so PARTIALS / LOCK / SHAPE / CENTER each have something to act
    // on. Deterministic under node-web-audio-api.
    const ref = handle.inputs.get('audio_in')!;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 220;
    const g = ctx.createGain();
    g.gain.value = 0.5;
    osc.connect(g);
    g.connect(ref.node, 0, ref.input);
    osc.start(0);
  }

  // Duck-typed on `.parameters` (the AudioParamMap every AudioWorkletNode has
  // and a GainNode does not) rather than `instanceof`, so it does not depend on
  // which realm installed the AudioWorkletNode global.
  const offWorkletHosts: string[] = [];
  for (const p of warrensspectrumDef.inputs) {
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
  } else if (leg.kind === 'port') {
    const ref = handle.inputs.get(leg.id);
    if (!ref) throw new Error(`cv-path: no input port '${leg.id}'`);
    const cs = ctx.createConstantSource();
    cs.offset.value = leg.offset;
    cs.connect(ref.node, 0, ref.input);
    cs.start(0);
  }

  const merger = ctx.createChannelMerger(2);
  const out = handle.outputs.get('out')!;
  // The module's output is STEREO on one port; split it so both channels reach
  // the metric. A bank-panned image would otherwise be invisible on the left.
  const splitter = ctx.createChannelSplitter(2);
  out.node.connect(splitter, out.output);
  splitter.connect(merger, 0, 0);
  splitter.connect(merger, 1, 1);
  merger.connect(ctx.destination);
  const buf = await ctx.startRendering();
  return { chans: [buf.getChannelData(0).slice(), buf.getChannelData(1).slice()], offWorkletHosts };
}

/** Peak |Δsample| in LINEAR AMPLITUDE over the settled window, across both
 *  output channels. Units matter: this is not dB and not RMS. */
function peakDelta(a: Render, b: Render): number {
  let peak = 0;
  for (let k = 0; k < a.chans.length; k++) {
    const x = a.chans[k]!;
    const y = b.chans[k]!;
    for (let i = SETTLE; i < N; i++) peak = Math.max(peak, Math.abs(x[i]! - y[i]!));
  }
  return peak;
}

/** Peak |sample| over the settled window — used only by the audibility leg. */
function peakAbs(r: Render): number {
  let peak = 0;
  for (const ch of r.chans) for (let i = SETTLE; i < N; i++) peak = Math.max(peak, Math.abs(ch[i]!));
  return peak;
}

const fmt = (v: number) => (v === 0 ? '0.0000e+0' : v.toExponential(4));

const PARAM_INPUT_IDS = warrensspectrumDef.inputs.filter((p) => p.paramTarget).map((p) => p.id);
const PARAM_TARGET_OF = new Map(
  warrensspectrumDef.inputs.filter((p) => p.paramTarget).map((p) => [p.id, p.paramTarget!]),
);

/** Each leg instantiates the REAL worklet in a fresh OfflineAudioContext and
 *  renders 0.5 s of a 64-partial FFT resynthesis. Measured ~1.5 s per leg on an
 *  idle box; a sweep is 6 of them plus a control. The ART default of 30 s is
 *  close enough that a loaded runner turns a correct measurement into a
 *  timeout, so the cap is DECLARED — it bounds the failure, it is never the
 *  gate. */
const SWEEP_TIMEOUT_MS = 300_000;

describe("ART warren's spectrum / CV path — a cable on a paramTarget input must change the audio", () => {
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
      for (let i = SETTLE; i < N; i++) peak = Math.max(peak, Math.abs(d[i]!));
      return peak;
    };
    const off = await run(false);
    const on = await run(true);
    // Without this leg, "the cable never connected" and "the cable connected to
    // nothing" are indistinguishable from a bit-exact zero below.
    expect(on, `CS(1)→gain must modulate: ${off.toFixed(9)} → ${on.toFixed(9)} (linear peak)`)
      .toBeGreaterThan(off * 2);
  });

  it('MECH control — ConstantSource → a k-rate AudioWorkletNode AudioParam modulates in THIS harness', async () => {
    // GainNode.gain is an a-rate NATIVE param. Every param under test here is a
    // k-rate param on an AudioWorkletNode, which is a different code path in
    // node-web-audio-api. Without this leg a bit-exact zero below could be the
    // HOST not honouring worklet-param connections rather than the module not
    // wiring them — the two are indistinguishable from the output alone.
    // `gain` is used because it is the module's own last-stage output scalar:
    // a pure multiply, so its authority does not depend on the analyser.
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: N, sampleRate: SR });
    const node = { id: 'cv-path-mech', type: 'warrensspectrum', position: { x: 0, y: 0 }, params: base } as never;
    const handle = await warrensspectrumDef.factory(ctx as unknown as AudioContext, node);
    const inRef = handle.inputs.get('audio_in')!;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 220;
    const g = ctx.createGain();
    g.gain.value = 0.5;
    osc.connect(g);
    g.connect(inRef.node, 0, inRef.input);
    osc.start(0);
    // `gain` has no CV input port, so this reaches the AudioParam the only way
    // the platform can: off the worklet's own parameter map.
    const gainParam = (handle.inputs.get('partials_cv')!.node as unknown as {
      parameters: Map<string, AudioParam>;
    }).parameters.get('gain')!;
    const cs = ctx.createConstantSource();
    cs.offset.value = -60; // floor the output
    cs.connect(gainParam);
    cs.start(0);
    const merger = ctx.createChannelMerger(2);
    const out = handle.outputs.get('out')!;
    const splitter = ctx.createChannelSplitter(2);
    out.node.connect(splitter, out.output);
    splitter.connect(merger, 0, 0);
    splitter.connect(merger, 1, 1);
    merger.connect(ctx.destination);
    const buf = await ctx.startRendering();
    const withCv: Render = {
      chans: [buf.getChannelData(0).slice(), buf.getChannelData(1).slice()],
      offWorkletHosts: [],
    };
    const d = peakDelta(withCv, ctrl);
    expect(d, `CS(-60)→worklet k-rate 'gain' must modulate: peak |Δsample| linear = ${fmt(d)}`)
      .toBeGreaterThan(0);
  }, SWEEP_TIMEOUT_MS);

  it('the module SOUNDS at the base patch, and only because audio_in is patched', async () => {
    // The positive control on the base patch itself. Every Δ below is measured
    // against `ctrl`; if `ctrl` were silent, every row would read the target
    // leg's own peak and a dead cable would look alive.
    const base = basePatch();
    const live = await render(base, { kind: 'none' });
    const silent = await render(base, { kind: 'silent-in' });
    const livePeak = peakAbs(live);
    const silentPeak = peakAbs(silent);
    expect(livePeak, `base patch must be audible: peak |sample| linear = ${fmt(livePeak)}`).toBeGreaterThan(0.001);
    expect(silentPeak, `an EFFECT with nothing patched must be silent: ${fmt(silentPeak)}`).toBe(0);
  }, SWEEP_TIMEOUT_MS);

  it('every declared paramTarget input moves the audio through the KNOB path', async () => {
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    const dead: string[] = [];
    const table: string[] = [];
    for (const id of PARAM_INPUT_IDS) {
      const target = PARAM_TARGET_OF.get(id)!;
      const d = peakDelta(await render(base, { kind: 'knob', id: target, value: perturbTarget(target) }), ctrl);
      table.push(`${id}→${target} ${base[target]}→${perturbTarget(target)} ${fmt(d)}`);
      if (d === 0) dead.push(`${id} (${target} → ${perturbTarget(target)})`);
    }
    // BOTH a real assertion (no control may be inert from its own knob) and the
    // per-input positive control for the CV sweep below: a row that reads zero
    // on both legs is the metric being blind, not a dead cable.
    expect(dead, `controls inert from their own knob — peak |Δsample| linear = 0. Table: ${table.join(' | ')}`)
      .toEqual([]);
  }, SWEEP_TIMEOUT_MS);

  it('every paramTarget input moves the audio through the CV path', async () => {
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    const dead: string[] = [];
    const table: string[] = [];
    for (const id of PARAM_INPUT_IDS) {
      const target = PARAM_TARGET_OF.get(id)!;
      const to = perturbTarget(target);
      const d = peakDelta(await render(base, { kind: 'cv', id, delta: to - base[target]! }), ctrl);
      table.push(`${id} ${base[target]}→${to} ${fmt(d)}`);
      if (d === 0) dead.push(id);
    }
    expect(dead, `CV cable inert (linear peak |Δsample| = 0) on: ${table.join(' | ')}`).toEqual([]);
  }, SWEEP_TIMEOUT_MS);

  it('SCOPE — no paramTarget input is published on a node other than the DSP worklet', async () => {
    // Deny-by-default and DERIVED: read off the LIVE handle, not typed. This is
    // the leg that keeps the sweep's own subject honest — the #1661 defect
    // shape removes an input from any filter that asks "is it on the worklet",
    // so a sweep that silently skipped such rows would stay green through the
    // exact defect it exists to find. Here nothing is skipped and the expected
    // set is EMPTY, so the two assertions cannot both be satisfied by a
    // vanishing subject.
    const ctrl = await render(basePatch(), { kind: 'none' });
    expect(
      ctrl.offWorkletHosts.slice().sort(),
      'paramTarget inputs published on a non-DSP node — their CV would be a dead end; see #1661/#1662',
    ).toEqual([]);
  }, SWEEP_TIMEOUT_MS);

  it('CLIP AUTOMATION reaches the same live params the CV cables do', async () => {
    // engine.ts:700 / :754 prefer `inputs[id].param` over `setParam`, so a dead
    // published param makes automation inert too — the same terminal reached by
    // another writer. Asserting agreement with the KNOB leg is the strong form:
    // "automation moved something" would pass on a param that moved the wrong
    // control.
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    const id = 'shape_cv';
    const target = PARAM_TARGET_OF.get(id)!;
    const to = perturbTarget(target);
    const auto = peakDelta(await render(base, { kind: 'automation', id, value: to }), ctrl);
    const knob = peakDelta(await render(base, { kind: 'knob', id: target, value: to }), ctrl);
    expect(auto, `automation must reach a LIVE param: ${fmt(auto)} vs knob ${fmt(knob)}`).toBeGreaterThan(0);
    expect(auto, 'automation and knob agree on a live param (linear peak |Δsample|)').toBeCloseTo(knob, 6);
  }, SWEEP_TIMEOUT_MS);

  it('the three audio-rate input PORTS each change the audio', async () => {
    // audio_in is covered by the audibility leg above. `pitch` and `gate` are
    // node inputs 1 and 2 — a transposed index would leave them accepting a
    // cable and doing nothing, which is the same lie as a dead CV jack and is
    // invisible until patched.
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    // 1 V = one octave up on the whole resynth.
    const pitchD = peakDelta(await render(base, { kind: 'port', id: 'pitch', offset: 1 }), ctrl);
    // A gate held HIGH from t=0 freezes the analyser before it ever commits.
    const gateD = peakDelta(await render(base, { kind: 'port', id: 'gate', offset: 1 }), ctrl);
    expect(pitchD, `pitch (V/oct) inert: peak |Δsample| linear = ${fmt(pitchD)}`).toBeGreaterThan(0);
    expect(gateD, `gate (FREEZE) inert: peak |Δsample| linear = ${fmt(gateD)}`).toBeGreaterThan(0);
  }, SWEEP_TIMEOUT_MS);
});
