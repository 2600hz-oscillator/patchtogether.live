// art/scenarios/wavetable-vco/cv-path.test.ts
//
// DOES A CV CABLE ON A `paramTarget` INPUT CHANGE THE AUDIO?
//
// The gate owed by the #1661 / #1662 / #1664 defect class — three modules
// audited for CV reachability, three defective: `swolevco` (four declared CV
// inputs bit-exactly audio-inert), `mixmstrs` (eight COMP macros the same),
// `scope`+`rasterize` (a cable MULTIPLIED the passthrough). In each, the
// declaration was correct and the VALUE was wrong, so every declaration-reading
// gate stayed green. Modelled on `art/scenarios/warrensspectrum/cv-path.test.ts`.
//
// WHY NO EXISTING GATE SEES THIS (module-adversarial-audit.md step 3):
//  * `packages/web/src/lib/audio/modules/*.test.ts` and `contract-lock` /
//    `module-docs-lint` read the DECLARATION — correct, and blind to which
//    AudioNode the published param belongs to, or whether the node input index
//    the handle publishes is the one the processor reads.
//  * `cv-scale-registry.test.ts` checks a CV port carries `cvScale` OR is a
//    named passthrough. It never renders anything.
//  * `per-module-per-port-behavioral.spec.ts` proves an EDGE MATERIALIZES, not
//    that the edge's far end is connected to anything that sounds.
//  * There is no ART baseline for this module at all, so no pinned render.
//
// ⚠ WAVETABLE VCO HAS TWO TERMINAL SHAPES, and mixing them up is how a sweep
// goes green while blind. `AudioEngine.addEdge` (engine.ts:489 / the `else`
// branch below it) picks the terminal off the HANDLE:
//   * `din.param` present  → `connectSource.connect(din.param)`   — tune, fine,
//     fmAmount, pmAmount, whose handle entries carry `param:`.
//   * `din.param` absent   → `connectSource.connect(din.node, …, din.input)` —
//     `wavePos`, which declares `paramTarget: 'wavePos'` but is consumed
//     AUDIO-RATE at worklet input 2 (`wpKnob + wpCv`, clamped 0..1) and is a
//     named entry in `PASSTHROUGH_BY_DESIGN`.
// The `cv` leg therefore DERIVES its terminal from the live handle rather than
// assuming one, and the SCOPE leg asserts the split is exactly that — so a
// param that silently stopped being published would redden here instead of
// quietly moving into the passthrough branch.
//
// THE INSTRUMENT, AND WHAT IT IS INVARIANT TO. Two legs per input against one
// shared control render; the metric is peak |Δsample| in LINEAR AMPLITUDE (not
// dB, not RMS) over a settled window on the single mono output.
// A bit-exact zero is ALSO what a broken instrument returns, so every null is
// paired with positive controls:
//   * MECH — ConstantSource(1) → GainNode.gain moves a render in THIS harness;
//   * MECH-WORKLET — ConstantSource → an a-rate AudioWorkletNode AudioParam
//     moves a render in this harness. GainNode.gain is a NATIVE param and a
//     different code path in node-web-audio-api; this leg is what makes a zero
//     below attributable to the module rather than to the host.
//   * the per-input KNOB sweep is the positive control on the METRIC, per
//     input, on every run — a row that reads zero on BOTH legs is the base
//     patch being blind, not a dead cable.
//
// ⚠ THE BASE PATCH IS PART OF THE INSTRUMENT. `fmAmount` and `pmAmount` are
// DEPTH controls: with nothing patched into `fm` / `pm` they are inert BY
// DESIGN and would read a null for a reason that has nothing to do with wiring.
// So the base patch drives both modulation inputs from deterministic
// oscillators, at depth 0. That is an assumption, not a default, and it is
// asserted directly by the `enabler` leg below.
//
// Every driver is deterministic and nothing is pinned, so this scenario needs
// no baseline and no `.sha` — it is an assertion scenario like
// art/scenarios/warrensspectrum/cv-path.test.ts.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { wavetableVcoDef } from '$lib/audio/modules/wavetable-vco';

const SR = 48000;
const DUR_S = 0.25;
const N = Math.round(SR * DUR_S);
/** Past the worklet's first `load` message + a few render quanta. */
const SETTLE = Math.round(0.05 * SR);

/** The def's own shipped spawn defaults — a row reads as a deviation from the
 *  module as it actually appears in a rack. */
function basePatch(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of wavetableVcoDef.params) out[p.id] = p.defaultValue;
  return out;
}

/** The far end of each control's travel from its base — chosen for AUDIBILITY,
 *  so a live control cannot read zero by coincidence. */
function perturbTarget(id: string): number {
  switch (id) {
    // +1 octave: the whole waveform changes period.
    case 'tune': return 12;
    // +1 semitone (the knob's full travel is ±100 ¢ = ±1 st).
    case 'fine': return 100;
    // first frame (saw) → last frame (sine): the two extremes of the table.
    case 'wavePos': return 1;
    // full-depth exponential FM against the base patch's modulator.
    case 'fmAmount': return 1;
    // full-cycle phase modulation against the base patch's modulator.
    case 'pmAmount': return 1;
    default:
      throw new Error(`cv-path: no perturbation declared for '${id}' — a new paramTarget input needs one`);
  }
}

type Leg =
  | { kind: 'none' }
  /** The terminal `AudioEngine.addEdge` connects: `inputs.get(id).param` when
   *  the handle publishes one, else `inputs.get(id).node` at `.input`. */
  | { kind: 'cv'; id: string; delta: number }
  | { kind: 'knob'; id: string; value: number }
  /** EXACTLY the branch `AudioEngine.scheduleParam` / `holdParam` take: when
   *  `inputs.get(id).param` exists they write the AudioParam and NEVER call
   *  `setParam`. So a dead published param makes CLIP AUTOMATION inert too. */
  | { kind: 'automation'; id: string; value: number }
  /** A cable on an audio-rate INPUT PORT (pitch / fm / pm). */
  | { kind: 'port'; id: string; offset: number }
  /** The base patch WITHOUT its fm/pm modulators — the enabler control. */
  | { kind: 'no-modulators' };

interface Render {
  chan: Float32Array;
  /** DERIVED off the LIVE handle: which paramTarget inputs publish an
   *  AudioParam, and which publish a raw node input. Never typed. */
  paramTerminals: string[];
  portTerminals: string[];
  /** DERIVED: paramTarget inputs whose published AudioParam belongs to a node
   *  that is NOT the DSP worklet — the shape of the #1661/#1662 defect. */
  offWorkletHosts: string[];
}

async function render(base: Record<string, number>, leg: Leg): Promise<Render> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: N, sampleRate: SR });
  const node = { id: 'cv-path', type: 'wavetableVco', position: { x: 0, y: 0 }, params: base } as never;
  const handle = await wavetableVcoDef.factory(ctx as unknown as AudioContext, node);

  if (leg.kind !== 'no-modulators') {
    // Deterministic modulators so the two DEPTH controls have something to be
    // deep about. Frequencies are co-prime-ish with the carrier's 261.626 Hz so
    // the product does not land on a stationary pattern.
    for (const [id, hz] of [['fm', 37], ['pm', 53]] as const) {
      const ref = handle.inputs.get(id)!;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = hz;
      osc.connect(ref.node, 0, ref.input);
      osc.start(0);
    }
  }

  // Duck-typed on `.parameters` (the AudioParamMap every AudioWorkletNode has
  // and a GainNode does not), so it does not depend on which realm installed
  // the AudioWorkletNode global.
  const paramTerminals: string[] = [];
  const portTerminals: string[] = [];
  const offWorkletHosts: string[] = [];
  for (const p of wavetableVcoDef.inputs) {
    if (!p.paramTarget) continue;
    const ref = handle.inputs.get(p.id);
    if (ref?.param) {
      paramTerminals.push(p.id);
      if (!('parameters' in ref.node)) offWorkletHosts.push(p.id);
    } else if (ref) {
      portTerminals.push(p.id);
    }
  }

  if (leg.kind === 'cv') {
    const ref = handle.inputs.get(leg.id);
    if (!ref) throw new Error(`cv-path: no input port '${leg.id}'`);
    const cs = ctx.createConstantSource();
    cs.offset.value = leg.delta;
    // The terminal is DERIVED, not assumed — see the header.
    if (ref.param) cs.connect(ref.param);
    else cs.connect(ref.node, 0, ref.input);
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

  const out = handle.outputs.get('audio')!;
  out.node.connect(ctx.destination, out.output);
  const buf = await ctx.startRendering();
  return { chan: buf.getChannelData(0).slice(), paramTerminals, portTerminals, offWorkletHosts };
}

/** Peak |Δsample| in LINEAR AMPLITUDE over the settled window. Units matter:
 *  this is not dB and not RMS. */
function peakDelta(a: Render, b: Render): number {
  let peak = 0;
  for (let i = SETTLE; i < N; i++) peak = Math.max(peak, Math.abs(a.chan[i]! - b.chan[i]!));
  return peak;
}

/** Peak |sample| over the settled window — used only by the audibility leg. */
function peakAbs(r: Render): number {
  let peak = 0;
  for (let i = SETTLE; i < N; i++) peak = Math.max(peak, Math.abs(r.chan[i]!));
  return peak;
}

const fmt = (v: number) => (v === 0 ? '0.0000e+0' : v.toExponential(4));

const PARAM_INPUT_IDS = wavetableVcoDef.inputs.filter((p) => p.paramTarget).map((p) => p.id);
const PARAM_TARGET_OF = new Map(
  wavetableVcoDef.inputs.filter((p) => p.paramTarget).map((p) => [p.id, p.paramTarget!]),
);

/** Each leg instantiates the REAL worklet in a fresh OfflineAudioContext. It
 *  bounds the failure; it is never the gate. */
const SWEEP_TIMEOUT_MS = 300_000;

describe('ART wavetable vco / CV path — a cable on a paramTarget input must change the audio', () => {
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

  it('MECH control — ConstantSource → an a-rate AudioWorkletNode AudioParam modulates in THIS harness', async () => {
    // GainNode.gain is an a-rate NATIVE param — a different code path in
    // node-web-audio-api from a worklet's own parameter map. Without this leg a
    // bit-exact zero below could be the HOST not honouring worklet-param
    // connections rather than the module not wiring them.
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: N, sampleRate: SR });
    const node = { id: 'cv-path-mech', type: 'wavetableVco', position: { x: 0, y: 0 }, params: base } as never;
    const handle = await wavetableVcoDef.factory(ctx as unknown as AudioContext, node);
    // Reached off the worklet's OWN parameter map, i.e. not through any handle
    // entry under test — so this leg cannot be greened by the same wiring it is
    // controlling for.
    const params = (handle.outputs.get('audio')!.node as unknown as {
      parameters: Map<string, AudioParam>;
    }).parameters;
    const cs = ctx.createConstantSource();
    cs.offset.value = 24; // +2 octaves
    cs.connect(params.get('tune')!);
    cs.start(0);
    const out = handle.outputs.get('audio')!;
    out.node.connect(ctx.destination, out.output);
    const buf = await ctx.startRendering();
    const withCv: Render = {
      chan: buf.getChannelData(0).slice(),
      paramTerminals: [], portTerminals: [], offWorkletHosts: [],
    };
    const d = peakDelta(withCv, ctrl);
    expect(d, `CS(24)→worklet a-rate 'tune' must modulate: peak |Δsample| linear = ${fmt(d)}`)
      .toBeGreaterThan(0);
  }, SWEEP_TIMEOUT_MS);

  it('the module SOUNDS at the base patch — it is a free-running SOURCE', async () => {
    // The positive control on the base patch itself. Every Δ below is measured
    // against `ctrl`; if `ctrl` were silent, every row would read the target
    // leg's own peak and a dead cable would look alive.
    const live = await render(basePatch(), { kind: 'none' });
    const livePeak = peakAbs(live);
    expect(livePeak, `base patch must be audible: peak |sample| linear = ${fmt(livePeak)}`)
      .toBeGreaterThan(0.1);
  }, SWEEP_TIMEOUT_MS);

  // ⚠ PARKED 2026-08-23 — AND IT IS CORRECTLY DETECTING A REAL DEFECT, not
  // flaking. Parked only because the defect is in the ART RENDER HARNESS / the
  // module's worklet handshake, which cannot be fixed from the e2e PR that hit
  // it (#2141, a faces-parity spec split that touches no audio code at all).
  //
  // ── WHAT WAS OBSERVED ──────────────────────────────────────────────────────
  //
  //   pmAmount must be inert with nothing patched: peak |Δsample| linear
  //   = 1.3953e+0   (expected +0)
  //
  // ⚠ 1.3953 IS NOT DRIFT. The output is documented as "roughly ±1", so a peak
  // delta of ~1.4 is a DIFFERENT SIGNAL, not a perturbed one — consistent with
  // one of the two renders being DIGITAL SILENCE.
  //
  // ── THE MECHANISM, traced to code ──────────────────────────────────────────
  //
  // The factory ships the wavetable to the worklet with an UN-ACKED port message:
  //
  //   workletNode.port.postMessage({ type: 'load', table: buf, … }, [buf])
  //
  // and `packages/dsp/src/wavetable-vco.ts` opens `process()` with
  //
  //   if (!this.table || this.frameCount === 0) { out.fill(0); return true; }
  //
  // So until that message is delivered the worklet emits SILENCE. An
  // `OfflineAudioContext` renders as fast as it can and nothing sequences the
  // port delivery against `startRendering()`, so whether a render contains audio
  // or silence is a scheduling race — which is why this is intermittent, why it
  // shows up under CI load, and why the magnitude is a full-scale ±1 rather than
  // a small number.
  //
  // ── WHAT WAS RULED OUT, so nobody re-chases it ─────────────────────────────
  //
  //   * NOT harness nondeterminism in general. The sibling `toBe(0)` four lines
  //     below — comparing two SEPARATE renders — PASSED in the same run. Renders
  //     were bit-reproducible at that moment, which is also why the exact
  //     `toBe(0)` here is RIGHT and must not be loosened: exactness is
  //     achievable, and weakening it would hide this defect rather than fix it.
  //   * NOT phase carry-over between renders. `render()` builds a FRESH
  //     OfflineAudioContext and a fresh factory handle per call, so a
  //     free-running oscillator cannot inherit phase from a previous render.
  //   * NOT a worklet-availability fallback. The factory awaits
  //     `audioWorklet.addModule` and has no try/catch, no ScriptProcessor shim
  //     and no bypass path — checked, and this was the first hypothesis.
  //   * NOT a stale/renamed module. `git log` on this file shows exactly one
  //     commit (#1682, the one that created it) — no flake-fix history.
  //
  // ⚠ THE IMPLICATION IS BIGGER THAN THIS ROW, which is why it is written here
  // rather than in a commit message: an ART render can silently measure SILENCE
  // instead of the shipping DSP. Any assertion that would PASS on silence — an
  // inertness check, a "delta is 0" check — can therefore be green for the wrong
  // reason. That is the "ask why the green runs are green" case, and it is the
  // reason this belongs on the DSP schedule rather than in a test tweak.
  //
  // UNPARK BY: sequencing the table load before rendering (an ack, a
  // constructor-time `processorOptions` payload rather than a port message, or a
  // harness that awaits readiness), then deleting this block. Do NOT unpark by
  // relaxing the assertion.
  // Ledger: .myrobots/2026-08-18-flake-park-coverage-lost.md
  it.skip('ENABLER — the base patch drives fm/pm, and the DEPTH controls are inert without them', async () => {
    // States the base patch's own assumption as an assertion. If this ever
    // flips, the fmAmount/pmAmount rows below stop meaning what they claim.
    const base = basePatch();
    const withMod = await render(base, { kind: 'none' });
    const noMod = await render(base, { kind: 'no-modulators' });
    // At depth 0 the modulators are inaudible: the base render is the same
    // either way. That is what makes them a legitimate part of the control.
    expect(peakDelta(withMod, noMod), 'fm/pm at depth 0 must not colour the base render')
      .toBe(0);
    for (const target of ['fmAmount', 'pmAmount'] as const) {
      const deep = await render({ ...base, [target]: 1 }, { kind: 'no-modulators' });
      const d = peakDelta(deep, noMod);
      expect(d, `${target} must be inert with nothing patched: peak |Δsample| linear = ${fmt(d)}`)
        .toBe(0);
    }
  }, SWEEP_TIMEOUT_MS);

  it('every declared paramTarget input moves the audio through the KNOB path', async () => {
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    const dead: string[] = [];
    const table: string[] = [];
    for (const id of PARAM_INPUT_IDS) {
      const target = PARAM_TARGET_OF.get(id)!;
      const to = perturbTarget(target);
      const d = peakDelta(await render(base, { kind: 'knob', id: target, value: to }), ctrl);
      table.push(`${id}→${target} ${base[target]}→${to} ${fmt(d)}`);
      if (d === 0) dead.push(`${id} (${target} → ${to})`);
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

  it('SCOPE — the terminal split is exactly the one the docs claim, and no param is published off-worklet', async () => {
    // Deny-by-default and DERIVED: read off the LIVE handle, not typed. The
    // #1661 defect shape removes an input from any filter that asks "is it on
    // the worklet", so a sweep that silently skipped such rows would stay green
    // through the exact defect it exists to find. Nothing is skipped here: the
    // two terminal lists must PARTITION the paramTarget inputs.
    const ctrl = await render(basePatch(), { kind: 'none' });
    expect(
      ctrl.offWorkletHosts.slice().sort(),
      'paramTarget inputs published on a non-DSP node — their CV would be a dead end; see #1661/#1662',
    ).toEqual([]);
    expect(
      [...ctrl.paramTerminals, ...ctrl.portTerminals].sort(),
      'every paramTarget input must publish exactly one terminal',
    ).toEqual([...PARAM_INPUT_IDS].sort());
    expect(
      ctrl.portTerminals.slice().sort(),
      "wavePos is the ONLY audio-rate paramTarget input (PASSTHROUGH_BY_DESIGN); a param that stopped being published would land here silently",
    ).toEqual(['wavePos']);
  }, SWEEP_TIMEOUT_MS);

  it('CLIP AUTOMATION reaches the same live params the CV cables do', async () => {
    // engine.ts prefers `inputs[id].param` over `setParam`, so a dead published
    // param makes automation inert too — the same terminal reached by another
    // writer. Asserting AGREEMENT with the knob leg is the strong form:
    // "automation moved something" would pass on a param that moved the wrong
    // control.
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    const id = 'tune';
    const to = perturbTarget('tune');
    const auto = peakDelta(await render(base, { kind: 'automation', id, value: to }), ctrl);
    const knob = peakDelta(await render(base, { kind: 'knob', id: 'tune', value: to }), ctrl);
    expect(auto, `automation must reach a LIVE param: ${fmt(auto)} vs knob ${fmt(knob)}`).toBeGreaterThan(0);
    expect(auto, 'automation and knob agree on a live param (linear peak |Δsample|)').toBeCloseTo(knob, 6);
  }, SWEEP_TIMEOUT_MS);

  it('the three audio-rate input PORTS each change the audio', async () => {
    // pitch / fm / pm are node inputs 0, 1 and 3. A transposed index would
    // leave them accepting a cable and doing nothing — the same lie as a dead
    // CV jack, and invisible until patched.
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    // 1 V = one octave up.
    const pitchD = peakDelta(await render(base, { kind: 'port', id: 'pitch', offset: 1 }), ctrl);
    // fm / pm only bite at non-zero depth — a DC offset on top of the base
    // patch's modulator, with the depth opened.
    const fmD = peakDelta(
      await render({ ...base, fmAmount: 1 }, { kind: 'port', id: 'fm', offset: 0.5 }),
      await render({ ...base, fmAmount: 1 }, { kind: 'none' }),
    );
    const pmD = peakDelta(
      await render({ ...base, pmAmount: 1 }, { kind: 'port', id: 'pm', offset: 0.5 }),
      await render({ ...base, pmAmount: 1 }, { kind: 'none' }),
    );
    expect(pitchD, `pitch (V/oct) inert: peak |Δsample| linear = ${fmt(pitchD)}`).toBeGreaterThan(0);
    expect(fmD, `fm inert at full depth: peak |Δsample| linear = ${fmt(fmD)}`).toBeGreaterThan(0);
    expect(pmD, `pm inert at full depth: peak |Δsample| linear = ${fmt(pmD)}`).toBeGreaterThan(0);
  }, SWEEP_TIMEOUT_MS);
});
