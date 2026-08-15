// art/scenarios/mixmstrs/cv-path.test.ts
//
// DOES A CV CABLE ON A `paramTarget` INPUT CHANGE THE AUDIO?
//
// The gate owed by the #1661 defect class (`swolevco`: four declared CV inputs
// that were bit-exactly audio-inert because the factory published an AudioParam
// on a node whose output was connected to nothing). #1661 named this file's
// module as using the same vocabulary, unverified. It does — for its eight
// `comp{N}` macros, and only for those. Every other declared CV input is live.
//
// WHY NO EXISTING GATE SEES THIS (module-adversarial-audit.md step 3):
//  * `art/scenarios/mixmstrs/{profile,prefader-sends,passthrough}.test.ts` all
//    render through `renderFaustOffline`, which sets Faust UI params DIRECTLY on
//    the DSP. They never build the module's factory, so no publish-an-AudioParam
//    seam exists in them at all.
//  * `packages/web/src/lib/audio/modules/mixmstrs.test.ts` covers the pure
//    helpers (`mapCompMacro`, `rmsLevel`) — correct, and blind to the wiring.
//  * `per-module-per-port-behavioral.spec.ts` — the one registry-driven sweep
//    that drives real CV edges — carries a written EXEMPTION for mixmstrs
//    (spawn-count budget + per-channel-on-summed-mix), so it never ran here.
//  * `contract-lock` / `module-docs-lint` read the DECLARATION. The declaration
//    is right; the wiring is not. (Audit shape 1: contract vs value.)
//
// THE INSTRUMENT, AND WHAT IT IS INVARIANT TO. Two legs per input against one
// shared control render, peak |Δsample| (linear amplitude) over a settled
// window, maxed across masterL/R + send1L + send2L:
//   CV   — ConstantSource(delta) → `handle.inputs.get(id).param`, which is
//          EXACTLY what `AudioEngine.addEdge` connects (engine.ts:489).
//   KNOB — `handle.setParam(id, target)`, which is what the on-screen control
//          calls. Different code path; one can work while the other does not.
// A bit-exact zero is also what a broken instrument returns, so:
//   * the KNOB leg of every input is asserted to move — that is the positive
//     control on the METRIC, per input, on every run;
//   * `MECH` asserts ConstantSource(1) → GainNode.gain moves a render in this
//     same harness — the positive control on the MECHANISM;
//   * the live CV legs prove `cs.connect(<worklet AudioParam>)` modulates under
//     node-web-audio-api, so a zero elsewhere is not a harness artifact.
// ⚠ The metric is blind to a param on a channel that is INAUDIBLE in the base
// patch. The first pass muted ch8 (to give send1Pre authority) and every ch8
// row came back 0.0000e+0 on BOTH legs — a false null the per-input KNOB
// control caught immediately. `basePatch()` keeps every channel audible.
//
// NEGATIVE-CONTROLLED IN BOTH DIRECTIONS, by forcing `ch1_volume` broken in the
// factory two different ways and confirming which leg reddens each time:
//
//  A. published on a NON-worklet node (`{ node: deadGain, param: deadGain.gain }`)
//     → SCOPE reddens (`ch1_volume` joins the excluded set) and the automation
//       leg reddens (0.0000e+0 vs knob 1.6946e-1). The CV sweep stays green —
//       because the defect REMOVED its own subject from the sweep's filter.
//       That is precisely why SCOPE exists and why it is asserted both ways.
//  B. kept ON the worklet node but pointed at a dead param
//     (`{ node: f, param: deadGain.gain }`) → the CV sweep reddens naming
//       `ch1_volume 0.8→0 0.0000e+0` while every other row prints a live value,
//       and SCOPE correctly stays green.
//
// So an input cannot be made CV-dead without reddening at least one leg, and the
// SCOPE leg is the permanent one that keeps the sweep's filter honest.
//
// Every driver here is deterministic and nothing is pinned, so this scenario
// needs no baseline and no `.sha` — it is an assertion scenario like
// prefader-sends.test.ts.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { mixmstrsDef, MIXMSTRS_CHANNELS, MIXMSTRS_RETURNS } from '$lib/audio/modules/mixmstrs';

const SR = 48000;
const DUR_S = 0.25;
const N = Math.round(SR * DUR_S);
const SETTLE = Math.round(0.15 * SR); // past the si.smoo ramp-in on faders/flags

const OUTS = ['masterL', 'masterR', 'send1L', 'send2L'] as const;
const AUDIO_IN = [
  ...MIXMSTRS_CHANNELS.flatMap((c) => [`ch${c}L`, `ch${c}R`]),
  ...MIXMSTRS_RETURNS.flatMap((r) => [`ret${r}L`, `ret${r}R`]),
];

/** Every strip audible and every flag consequential, so no row can read zero
 *  merely because the base patch gave that control nothing to act on. */
function basePatch(): Record<string, number> {
  const p: Record<string, number> = { master_volume: 0.8, send1Pre: 0, send2Pre: 0 };
  for (const c of MIXMSTRS_CHANNELS) {
    // A fader at 0.8 (not 1) is what gives send1Pre/send2Pre authority: the PRE
    // tap sits at unity, the POST tap at 0.8. Muting a channel to make the point
    // instead would blind every other control on that channel — see the header.
    p[`ch${c}_volume`] = 0.8;
    p[`ch${c}_low`] = 0; p[`ch${c}_mid`] = 0; p[`ch${c}_high`] = 0;
    p[`ch${c}_thresh`] = -12; p[`ch${c}_ratio`] = 2; p[`ch${c}_compEnable`] = 1;
    p[`comp${c}`] = 0.5; // ⚠ applied LAST at construction; overwrites the three above
    p[`ch${c}_send1`] = 0.5;
    p[`ch${c}_send2`] = 0.5;
  }
  for (const r of MIXMSTRS_RETURNS) {
    p[`ret${r}_volume`] = 1; p[`ret${r}_low`] = 0; p[`ret${r}_mid`] = 0; p[`ret${r}_high`] = 0;
  }
  return p;
}

/** The far end of each control's travel from its base — chosen for audibility,
 *  not for prettiness, so a live control cannot read zero by coincidence. */
function perturbTarget(id: string): number {
  if (id === 'master_volume') return 0;
  if (id === 'send1Pre' || id === 'send2Pre') return 1;
  if (/^ret\d_volume$/.test(id)) return 0;
  if (/^ret\d_(low|mid|high)$/.test(id)) return 12;
  if (/^comp\d$/.test(id)) return 0;
  if (/^ch\d_volume$/.test(id)) return 0;
  if (/^ch\d_(low|mid|high)$/.test(id)) return 12;
  if (/^ch\d_thresh$/.test(id)) return -36;
  if (/^ch\d_ratio$/.test(id)) return 10;
  if (/^ch\d_compEnable$/.test(id)) return 0;
  if (/^ch\d_send[12]$/.test(id)) return 1;
  throw new Error(`cv-path: no perturbation declared for '${id}' — a new param needs one`);
}

/** Where the param ACTUALLY sits after construction. `basePatch()` is not the
 *  truth for the compressor triple: the comp macro is applied last and
 *  overwrites thresh/ratio/compEnable, so the CV delta must be measured from
 *  the macro's values or the leg silently tests the wrong displacement. */
function effectiveBase(id: string, base: Record<string, number>): number {
  const m = /^ch(\d)_(thresh|ratio|compEnable)$/.exec(id);
  if (!m) return base[id]!;
  const comp = base[`comp${m[1]}`] ?? 0;
  if (m[2] === 'compEnable') return comp === 0 ? 0 : 1;
  if (m[2] === 'thresh') return comp === 0 ? 0 : -20 * comp;
  return comp === 0 ? 1 : 1 + 3 * comp;
}

type Leg =
  | { kind: 'none' }
  | { kind: 'cv'; id: string; delta: number }
  | { kind: 'knob'; id: string; value: number }
  /** EXACTLY the branch `AudioEngine.scheduleParam` (engine.ts:700) and
   *  `holdParam` (:754) take: when `inputs.get(id).param` exists they write the
   *  AudioParam and NEVER call `setParam`. So a dead published param makes clip
   *  automation of that control inert too. */
  | { kind: 'automation'; id: string; value: number };

interface Render { chans: Float32Array[]; offWorkletHosts: string[] }

async function render(base: Record<string, number>, leg: Leg): Promise<Render> {
  const ctx = new OfflineAudioContext({ numberOfChannels: OUTS.length, length: N, sampleRate: SR });
  const node = { id: 'cv-path', type: 'mixmstrs', position: { x: 0, y: 0 }, params: base } as never;
  const handle = await mixmstrsDef.factory(ctx as unknown as AudioContext, node);

  AUDIO_IN.forEach((id, i) => {
    const ref = handle.inputs.get(id)!;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 110 + i * 37; // mutually inharmonic, so no two strips cancel
    const g = ctx.createGain();
    g.gain.value = 0.35;
    osc.connect(g);
    g.connect(ref.node, 0, ref.input);
    osc.start(0);
  });

  // DERIVED, not typed: which paramTarget inputs publish their AudioParam on a
  // node that is NOT the DSP worklet. That is the shape of the #1661 defect —
  // a param on a side node whose output reaches no declared output port.
  // Duck-typed on `.parameters` (the AudioParamMap every AudioWorkletNode has
  // and a GainNode does not) rather than `instanceof`, so it does not depend on
  // which realm installed the AudioWorkletNode global.
  const offWorkletHosts: string[] = [];
  for (const p of mixmstrsDef.inputs) {
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

  const merger = ctx.createChannelMerger(OUTS.length);
  OUTS.forEach((id, k) => {
    const ref = handle.outputs.get(id)!;
    ref.node.connect(merger, ref.output, k);
  });
  merger.connect(ctx.destination);
  const buf = await ctx.startRendering();
  return { chans: OUTS.map((_, k) => buf.getChannelData(k).slice()), offWorkletHosts };
}

/** Peak |Δsample| in LINEAR AMPLITUDE over the settled window, across every
 *  captured output. Units matter: this is not dB and not RMS. */
function peakDelta(a: Render, b: Render): number {
  let peak = 0;
  for (let k = 0; k < a.chans.length; k++) {
    const x = a.chans[k]!, y = b.chans[k]!;
    for (let i = SETTLE; i < N; i++) peak = Math.max(peak, Math.abs(x[i]! - y[i]!));
  }
  return peak;
}

const fmt = (v: number) => (v === 0 ? '0.0000e+0' : v.toExponential(4));
const PARAM_INPUT_IDS = mixmstrsDef.inputs.filter((p) => p.paramTarget).map((p) => p.id);

describe('ART mixmstrs / CV path — a cable on a paramTarget input must change the audio', () => {
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

  it('every declared paramTarget input moves the audio through the KNOB path', async () => {
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    const dead: string[] = [];
    for (const id of PARAM_INPUT_IDS) {
      const d = peakDelta(await render(base, { kind: 'knob', id, value: perturbTarget(id) }), ctrl);
      if (d === 0) dead.push(`${id} (→ ${perturbTarget(id)})`);
    }
    // This is BOTH a real assertion (no control may be inert from its own knob)
    // and the per-input positive control for the CV sweep below: a row that
    // reads zero on both legs is the metric being blind, not a dead cable.
    expect(dead, 'controls inert from their own knob — peak |Δsample| linear = 0').toEqual([]);
  });

  it('every paramTarget input hosted ON THE DSP WORKLET moves the audio through the CV path', async () => {
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    const live = PARAM_INPUT_IDS.filter((id) => !ctrl.offWorkletHosts.includes(id));
    const dead: string[] = [];
    const table: string[] = [];
    for (const id of live) {
      const target = perturbTarget(id);
      const d = peakDelta(await render(base, { kind: 'cv', id, delta: target - effectiveBase(id, base) }), ctrl);
      table.push(`${id} ${effectiveBase(id, base)}→${target} ${fmt(d)}`);
      if (d === 0) dead.push(id);
    }
    expect(dead, `CV cable inert (linear peak |Δsample| = 0) on: ${table.join(' | ')}`).toEqual([]);
  });

  it('SCOPE — the inputs this scenario CANNOT certify are exactly the comp macros (#1661)', async () => {
    // Deny-by-default and DERIVED on both sides: the left is read off the live
    // handle (which published params sit on a node that is not the DSP worklet),
    // the right off the def's own exported channel list. Nothing is hand-typed
    // and nothing is counted. When the comp macros are moved onto the worklet —
    // or onto any node whose output reaches an output port — this assertion goes
    // RED and must be deleted along with the exclusion above, so the carve-out
    // cannot outlive the defect.
    const ctrl = await render(basePatch(), { kind: 'none' });
    expect(
      ctrl.offWorkletHosts.slice().sort(),
      'paramTarget inputs published on a non-DSP node — their CV is a dead end; see #1661',
    ).toEqual(MIXMSTRS_CHANNELS.map((c) => `comp${c}`).sort());
  });

  it('a dead published param also makes CLIP AUTOMATION of that control inert', async () => {
    // engine.ts:700 / :754 prefer `inputs[id].param` over `setParam`, so this is
    // not a second bug — it is the same dead terminal reached by another writer.
    // `ch1_volume` is the positive control: same branch, live param.
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    const auto = async (id: string, v: number) =>
      peakDelta(await render(base, { kind: 'automation', id, value: v }), ctrl);
    const knob = async (id: string, v: number) =>
      peakDelta(await render(base, { kind: 'knob', id, value: v }), ctrl);

    const liveAuto = await auto('ch1_volume', 0);
    const liveKnob = await knob('ch1_volume', 0);
    expect(liveAuto, `automation must reach a LIVE param: ${fmt(liveAuto)} vs knob ${fmt(liveKnob)}`)
      .toBeGreaterThan(0);
    expect(liveAuto, 'automation and knob agree on a live param').toBeCloseTo(liveKnob, 6);
  });
});
