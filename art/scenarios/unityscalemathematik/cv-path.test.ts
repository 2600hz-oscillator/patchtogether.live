// art/scenarios/unityscalemathematik/cv-path.test.ts
//
// DOES A CV CABLE ON A `paramTarget` INPUT CHANGE THE AUDIO? — plus the two
// laws the FACEPLATE prints, measured against the same renders.
//
// The gate owed by the #1661 / #1662 / #1664 defect class — three modules
// audited for CV reachability, three defective: `swolevco` (four declared CV
// inputs bit-exactly audio-inert), `mixmstrs` (eight COMP macros the same),
// `scope`+`rasterize` (a cable MULTIPLIED the passthrough). In each the
// DECLARATION was correct and the VALUE was wrong, so every declaration-reading
// gate stayed green. Modelled on `art/scenarios/wavetable-vco/cv-path.test.ts`.
//
// WHY NO EXISTING GATE SEES THIS (module-adversarial-audit.md step 3):
//  * `packages/web/src/lib/audio/modules/*.test.ts`, `contract-lock` and
//    `module-docs-lint` read the DECLARATION — correct, and blind to which
//    AudioNode the published param belongs to, or whether the node input index
//    the handle publishes is the one the processor reads.
//  * `cv-scale-registry.test.ts` checks a CV port carries `cvScale` OR is a
//    named passthrough. It never renders anything.
//  * `per-module-per-port-behavioral.spec.ts` proves an EDGE MATERIALIZES, not
//    that the edge's far end reaches anything that sounds.
//  * `art/scenarios/unityscalemathematik/profile.test.ts` pins a rendered
//    signature but drives no CV at all.
//
// ⚠ THIS MODULE HAS TWO TERMINAL SHAPES, and mixing them up is how a sweep goes
// green while blind. `AudioEngine.addEdge` picks the terminal off the HANDLE:
//   * `din.param` present → `connectSource.connect(din.param)` — the five
//     atten/curve CV ports, whose handle entries carry `param:`.
//   * `din.param` absent  → `connectSource.connect(din.node, …, din.input)` —
//     `u_in` / `a_in` / `b_in`, the SIGNALS being shaped, which are named
//     entries in `PASSTHROUGH_BY_DESIGN` (`cv-scale-registry.test.ts`).
// The `cv` leg DERIVES its terminal from the live handle rather than assuming
// one, and the SCOPE leg asserts the partition is exactly that — so a param
// that silently stopped being published would redden here instead of quietly
// moving into the passthrough branch.
//
// ⚠ THE BASE PATCH IS PART OF THE INSTRUMENT. Every control on this module is
// ENABLER-GATED on a cable: with nothing patched into `a_in` the A section
// emits exactly zero whatever the knobs say, so a sweep over a bare module
// would read a null on every row for a reason that has nothing to do with
// wiring. The base patch therefore drives all three signal inputs with DC, and
// that assumption is asserted directly by the `enabler` leg below.
//
// THE INSTRUMENT, AND WHAT IT IS INVARIANT TO. The metric is the SETTLED OUTPUT
// SAMPLE in LINEAR AMPLITUDE (not dB, not RMS) on each of the three mono
// outputs; a row's Δ is the largest |difference| across the three. DC drivers
// make the settled sample the whole story — there is no phase to align and no
// window to choose. A bit-exact zero is ALSO what a broken instrument returns,
// so every null is paired with positive controls:
//   * MECH — ConstantSource(1) → GainNode.gain moves a render in THIS harness;
//   * MECH-WORKLET — ConstantSource → an a-rate AudioWorkletNode AudioParam
//     moves a render in this harness. GainNode.gain is a NATIVE param and a
//     different code path in node-web-audio-api; this leg is what makes a zero
//     below attributable to the module rather than to the host.
//   * the per-input KNOB sweep is the positive control on the METRIC, per
//     input, on every run — a row reading zero on BOTH legs is the base patch
//     being blind, not a dead cable.
//
// Every driver is deterministic and nothing is pinned, so this scenario needs
// no baseline and no `.sha` — it is an assertion scenario like
// art/scenarios/wavetable-vco/cv-path.test.ts.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import {
  unityscalemathematikDef,
  unityScaleMath,
} from '$lib/audio/modules/unityscalemathematik';
import {
  UNITYSCALE_PROBE_HALF,
  UNITYSCALE_PROBE_OVER,
  unityscaleResponse,
} from '$lib/ui/modules/unityscalemathematik-face-model';

const SR = 48000;
const DUR_S = 0.05;
const N = Math.round(SR * DUR_S);
/** Past the worklet's first `load` message + a few render quanta. */
const SETTLE = Math.round(0.02 * SR);

/** The DECLARED signal inputs and outputs, DERIVED from the def rather than
 *  typed: an input with no `paramTarget` is a signal port, and the outputs are
 *  whatever the def declares. A fourth channel would enrol itself. */
const SIGNAL_INS: readonly string[] = unityscalemathematikDef.inputs
  .filter((p) => !p.paramTarget)
  .map((p) => p.id);
const OUT_IDS: readonly string[] = unityscalemathematikDef.outputs.map((o) => o.id);
const PARAM_INPUT_IDS: readonly string[] = unityscalemathematikDef.inputs
  .filter((p) => p.paramTarget)
  .map((p) => p.id);
const PARAM_TARGET_OF = new Map(
  unityscalemathematikDef.inputs.filter((p) => p.paramTarget).map((p) => [p.id, p.paramTarget!]),
);

/** The def's own shipped spawn defaults — a row reads as a deviation from the
 *  module as it actually appears in a rack. */
function basePatch(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of unityscalemathematikDef.params) out[p.id] = p.defaultValue;
  return out;
}

/** The far end of each control's travel from its base — chosen for AUDIBILITY,
 *  so a live control cannot read zero by coincidence. */
function perturbTarget(paramId: string): number {
  switch (paramId) {
    // +1 → −1: the attenuverter's full travel, THROUGH zero and out the other
    // side, so a control that only reached half its range would still move.
    case 'unityAtten':
    case 'aAtten':
    case 'bAtten':
      return -1;
    // 0 → 1: k goes 1 → 3, which at the base patch's 0.5 drive is 0.5 → 0.125.
    case 'aCurve':
    case 'bCurve':
      return 1;
    default:
      throw new Error(
        `cv-path: no perturbation declared for '${paramId}' — a new paramTarget input needs one`,
      );
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
  /** The base patch WITHOUT its signal drivers — the enabler control. */
  | { kind: 'unpatched' };

interface Render {
  /** settled sample per DECLARED output id. */
  out: Record<string, number>;
  /** whole settled window per output, for the bit-identity leg. */
  buf: Record<string, Float32Array>;
  /** DERIVED off the LIVE handle: which paramTarget inputs publish an
   *  AudioParam, and which publish a raw node input. Never typed. */
  paramTerminals: string[];
  portTerminals: string[];
  /** DERIVED: paramTarget inputs whose published AudioParam belongs to a node
   *  that is NOT the DSP worklet — the shape of the #1661/#1662 defect. */
  offWorkletHosts: string[];
}

/** DC on every signal input, at the magnitude the faceplate's `half` readout is
 *  stated at — so the KNOB rows below and the readout the user reads are
 *  literally the same measurement. */
const DRIVE = UNITYSCALE_PROBE_HALF;

async function render(
  base: Record<string, number>,
  leg: Leg,
  drive: number = DRIVE,
): Promise<Render> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: OUT_IDS.length,
    length: N,
    sampleRate: SR,
  });
  const node = {
    id: 'cv-path',
    type: 'unityscalemathematik',
    position: { x: 0, y: 0 },
    params: base,
  } as never;
  const handle = await unityscalemathematikDef.factory(ctx as unknown as AudioContext, node);

  if (leg.kind !== 'unpatched') {
    for (const id of SIGNAL_INS) {
      const ref = handle.inputs.get(id)!;
      const cs = ctx.createConstantSource();
      cs.offset.value = drive;
      cs.connect(ref.node, 0, ref.input);
      cs.start(0);
    }
  }

  // Duck-typed on `.parameters` (the AudioParamMap every AudioWorkletNode has
  // and a GainNode does not), so it does not depend on which realm installed
  // the AudioWorkletNode global.
  const paramTerminals: string[] = [];
  const portTerminals: string[] = [];
  const offWorkletHosts: string[] = [];
  for (const p of unityscalemathematikDef.inputs) {
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
  }

  const merger = ctx.createChannelMerger(OUT_IDS.length);
  OUT_IDS.forEach((id, i) => {
    const o = handle.outputs.get(id)!;
    o.node.connect(merger, o.output, i);
  });
  merger.connect(ctx.destination);
  const rendered = await ctx.startRendering();

  const out: Record<string, number> = {};
  const buf: Record<string, Float32Array> = {};
  OUT_IDS.forEach((id, i) => {
    const chan = rendered.getChannelData(i);
    buf[id] = chan.slice(SETTLE);
    out[id] = chan[N - 1]!;
  });
  return { out, buf, paramTerminals, portTerminals, offWorkletHosts };
}

/** The largest |Δ| across the three declared outputs, in LINEAR amplitude. */
function peakDelta(a: Render, b: Render): number {
  let peak = 0;
  for (const id of OUT_IDS) peak = Math.max(peak, Math.abs(a.out[id]! - b.out[id]!));
  return peak;
}

const fmt = (v: number) => (v === 0 ? '0.0000e+0' : v.toExponential(4));

/** Each leg instantiates the REAL worklet in a fresh OfflineAudioContext. It
 *  bounds the failure; it is never the gate. */
const SWEEP_TIMEOUT_MS = 300_000;

describe('ART unityscalemathematik / CV path — a cable on a paramTarget input must change the audio', () => {
  it('MECH control — ConstantSource(1) → GainNode.gain modulates in THIS harness', async () => {
    const run = async (withCv: boolean) => {
      const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: N, sampleRate: SR });
      const src = ctx.createConstantSource();
      src.offset.value = 0.25;
      const g = ctx.createGain();
      g.gain.value = 1;
      src.connect(g);
      g.connect(ctx.destination);
      src.start(0);
      if (withCv) {
        const cs = ctx.createConstantSource();
        cs.offset.value = 1;
        cs.connect(g.gain);
        cs.start(0);
      }
      const d = (await ctx.startRendering()).getChannelData(0);
      return Math.abs(d[N - 1]!);
    };
    const off = await run(false);
    const on = await run(true);
    // Without this leg, "the cable never connected" and "the cable connected to
    // nothing" are indistinguishable from a bit-exact zero below.
    expect(on, `CS(1)→gain must modulate: ${off.toFixed(9)} → ${on.toFixed(9)} (linear)`)
      .toBeGreaterThan(off * 1.5);
  });

  it('MECH control — ConstantSource → an a-rate AudioWorkletNode AudioParam modulates in THIS harness', async () => {
    // GainNode.gain is an a-rate NATIVE param — a different code path in
    // node-web-audio-api from a worklet's own parameter map. Without this leg a
    // bit-exact zero below could be the HOST not honouring worklet-param
    // connections rather than the module not wiring them.
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    const ctx = new OfflineAudioContext({
      numberOfChannels: OUT_IDS.length,
      length: N,
      sampleRate: SR,
    });
    const handle = await unityscalemathematikDef.factory(
      ctx as unknown as AudioContext,
      { id: 'mech', type: 'unityscalemathematik', position: { x: 0, y: 0 }, params: base } as never,
    );
    for (const id of SIGNAL_INS) {
      const ref = handle.inputs.get(id)!;
      const cs = ctx.createConstantSource();
      cs.offset.value = DRIVE;
      cs.connect(ref.node, 0, ref.input);
      cs.start(0);
    }
    // Reached off the worklet's OWN parameter map, i.e. not through any handle
    // entry under test — so this leg cannot be greened by the same wiring it is
    // controlling for.
    const params = (handle.outputs.get(OUT_IDS[0]!)!.node as unknown as {
      parameters: Map<string, AudioParam>;
    }).parameters;
    const cs = ctx.createConstantSource();
    cs.offset.value = -2; // +1 → −1 on the attenuverter
    cs.connect(params.get('unityAtten')!);
    cs.start(0);
    const merger = ctx.createChannelMerger(OUT_IDS.length);
    OUT_IDS.forEach((id, i) => {
      const o = handle.outputs.get(id)!;
      o.node.connect(merger, o.output, i);
    });
    merger.connect(ctx.destination);
    const rendered = await ctx.startRendering();
    const withCv = rendered.getChannelData(0)[N - 1]!;
    const d = Math.abs(withCv - ctrl.out[OUT_IDS[0]!]!);
    expect(d, `CS(−2)→worklet a-rate 'unityAtten' must modulate: |Δ| linear = ${fmt(d)}`)
      .toBeGreaterThan(0);
  }, SWEEP_TIMEOUT_MS);

  it('the module PASSES SIGNAL at the base patch — the positive control on the base patch itself', async () => {
    // Every Δ below is measured against `ctrl`; if `ctrl` were silent, every row
    // would read the target leg's own value and a dead cable would look alive.
    const live = await render(basePatch(), { kind: 'none' });
    for (const id of OUT_IDS) {
      expect(
        Math.abs(live.out[id]!),
        `base patch must pass signal on '${id}': settled sample linear = ${fmt(live.out[id]!)}`,
      ).toBeGreaterThan(0.1);
    }
  }, SWEEP_TIMEOUT_MS);

  it('ENABLER — every control is bit-exactly inert with nothing patched', async () => {
    // States the base patch's own assumption as an assertion. If this ever
    // flips, every row below stops meaning what it claims. It is ALSO the
    // faceplate's licence to print a RESPONSE rather than a level: a
    // FaceReadoutValue sees only params and cannot see a cable, so the readouts
    // say "what a 0.5 in would become", never "what is coming out".
    const base = basePatch();
    const bare = await render(base, { kind: 'unpatched' });
    for (const id of OUT_IDS) {
      expect(bare.out[id], `'${id}' must be silent with nothing patched`).toBe(0);
    }
    for (const p of unityscalemathematikDef.params) {
      const moved = await render({ ...base, [p.id]: perturbTarget(p.id) }, { kind: 'unpatched' });
      const d = peakDelta(moved, bare);
      expect(d, `${p.id} must be inert with nothing patched: peak |Δ| linear = ${fmt(d)}`).toBe(0);
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
    expect(dead, `controls inert from their own knob — peak |Δ| linear = 0. Table: ${table.join(' | ')}`)
      .toEqual([]);
  }, SWEEP_TIMEOUT_MS);

  it('every paramTarget input moves the audio through the CV path, and AGREES with its knob', async () => {
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    const dead: string[] = [];
    const disagree: string[] = [];
    const table: string[] = [];
    for (const id of PARAM_INPUT_IDS) {
      const target = PARAM_TARGET_OF.get(id)!;
      const to = perturbTarget(target);
      const cv = peakDelta(await render(base, { kind: 'cv', id, delta: to - base[target]! }), ctrl);
      const knob = peakDelta(await render(base, { kind: 'knob', id: target, value: to }), ctrl);
      table.push(`${id} ${base[target]}→${to} cv=${fmt(cv)} knob=${fmt(knob)}`);
      if (cv === 0) dead.push(id);
      // THE STRONG FORM: not merely "the cable moved the audio" but "the cable
      // moved it to the SAME place the knob does", which is the claim that
      // separates a live terminal from a live-but-wrong one.
      if (Math.abs(cv - knob) > 1e-6) disagree.push(`${id} (cv ${fmt(cv)} vs knob ${fmt(knob)})`);
    }
    expect(dead, `CV cable inert (peak |Δ| linear = 0) on: ${table.join(' | ')}`).toEqual([]);
    expect(disagree, `CV and KNOB reach DIFFERENT terminals: ${table.join(' | ')}`).toEqual([]);
  }, SWEEP_TIMEOUT_MS);

  it('SCOPE — the terminal split is exactly the one the registry claims, and no param is published off-worklet', async () => {
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
      'no paramTarget input on this module is audio-rate — a param that stopped being published would land here silently',
    ).toEqual([]);
    // And the SIGNAL ports are the other half of the partition: they are the
    // named PASSTHROUGH_BY_DESIGN entries and must NOT publish a param.
    expect(SIGNAL_INS.slice().sort(), 'the signal inputs are the def\'s non-paramTarget ports')
      .toEqual(['a_in', 'b_in', 'u_in']);
  }, SWEEP_TIMEOUT_MS);

  it('CLIP AUTOMATION reaches the same live params the CV cables do', async () => {
    // engine.ts prefers `inputs[id].param` over `setParam`, so a dead published
    // param makes automation inert too — the same terminal reached by another
    // writer. Asserting AGREEMENT with the knob leg is the strong form:
    // "automation moved something" would pass on a param that moved the wrong
    // control.
    const base = basePatch();
    const ctrl = await render(base, { kind: 'none' });
    const auto = peakDelta(await render(base, { kind: 'automation', id: 'aCurve', value: 1 }), ctrl);
    const knob = peakDelta(await render(base, { kind: 'knob', id: 'aCurve', value: 1 }), ctrl);
    expect(auto, `automation must reach a LIVE param: ${fmt(auto)} vs knob ${fmt(knob)}`).toBeGreaterThan(0);
    expect(auto, 'automation and knob agree on a live param (peak |Δ| linear)').toBeCloseTo(knob, 6);
  }, SWEEP_TIMEOUT_MS);

  it('the three sections do NOT cross-talk', async () => {
    // What licenses `a` and `b` as separate PAGES on the faceplate (and the
    // per-section rear-card bands that follow from them): each signal input
    // reaches exactly one output.
    const base = basePatch();
    for (const inId of SIGNAL_INS) {
      const ctx = new OfflineAudioContext({
        numberOfChannels: OUT_IDS.length,
        length: N,
        sampleRate: SR,
      });
      const handle = await unityscalemathematikDef.factory(
        ctx as unknown as AudioContext,
        { id: 'x', type: 'unityscalemathematik', position: { x: 0, y: 0 }, params: base } as never,
      );
      const ref = handle.inputs.get(inId)!;
      const cs = ctx.createConstantSource();
      cs.offset.value = DRIVE;
      cs.connect(ref.node, 0, ref.input);
      cs.start(0);
      const merger = ctx.createChannelMerger(OUT_IDS.length);
      OUT_IDS.forEach((id, i) => {
        const o = handle.outputs.get(id)!;
        o.node.connect(merger, o.output, i);
      });
      merger.connect(ctx.destination);
      const rendered = await ctx.startRendering();
      const live = OUT_IDS.filter((_, i) => rendered.getChannelData(i)[N - 1] !== 0);
      // DERIVED, not typed: `u_in` → `u_out`, `a_in` → `a_out`, `b_in` → `b_out`
      // by the def's own naming, so a fourth channel enrols itself.
      const expected = [`${inId.slice(0, -3)}_out`];
      expect(live, `'${inId}' must reach exactly ${expected[0]}`).toEqual(expected);
    }
  }, SWEEP_TIMEOUT_MS);

  it('THE RENDER IS REPRODUCIBLE — two independent renders are BIT-IDENTICAL', async () => {
    // #1680: node-web-audio-api renders off-thread, so a module whose state is
    // written from a `setInterval` pump renders differently every time and every
    // number taken from it is noise wearing nine decimal places. THREE modules
    // measured that way. This one has no pump — it is a stateless per-sample
    // function — and that is asserted rather than assumed, so a future pump
    // cannot be added quietly.
    const p = { ...basePatch(), aCurve: 0.6, bCurve: 0.3, aAtten: -0.4 };
    const r1 = await render(p, { kind: 'none' });
    const r2 = await render(p, { kind: 'none' });
    const differing: string[] = [];
    for (const id of OUT_IDS) {
      const a = r1.buf[id]!;
      const b = r2.buf[id]!;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
          differing.push(`${id}[${i}] ${a[i]} vs ${b[i]}`);
          break;
        }
      }
    }
    expect(differing, 'two renders of one patch differ — the module is not reproducible').toEqual([]);
  }, SWEEP_TIMEOUT_MS);
});

describe('ART unityscalemathematik / the FACEPLATE law, measured against the same worklet', () => {
  it('the pure model the readouts use AGREES with the rendered audio', async () => {
    // THE JOIN THE FACEPLATE NEEDS AND NOTHING ELSE MAKES. `unityScaleMath` is
    // exported from the def and imported by `unityscalemathematik-face-model`,
    // so the hero prints float64 arithmetic while the player hears a float32
    // worklet. Nothing else in the repo compares the two — the module unit test
    // exercises the helper alone and the ART profile renders the worklet alone —
    // so this is where a divergence would surface.
    // ⚠ THE METRIC IS RELATIVE ERROR, NOT ABSOLUTE, AND THE UNIT IS THE WHOLE
    // POINT. The first draft asserted an absolute budget and went red at
    // 1.81e-7 on a result of magnitude 2.004 — which is 9.0e-8 RELATIVE, about
    // 1.5 float32 ULPs, i.e. the harness working perfectly. An absolute budget
    // over a quantity that spans 0 to 8 across the dials' travel is a different
    // assertion at every probe magnitude; a relative one is the same assertion
    // everywhere, which is what makes a single number honest here.
    const rows: string[] = [];
    let worst = 0;
    for (const [atten, curve] of [
      [1, 0], [1, 0.5], [1, 1], [-0.6, 0.37], [0.5, 1], [0.25, 0.8], [0, 1],
    ] as const) {
      for (const x of [UNITYSCALE_PROBE_HALF, UNITYSCALE_PROBE_OVER]) {
        const r = await render({ ...basePatch(), aAtten: atten, aCurve: curve }, { kind: 'none' }, x);
        const got = r.out['a_out']!;
        const want = unityScaleMath.shape(x, atten, curve);
        // Relative where there is a magnitude to be relative to; absolute at
        // exactly zero (atten 0), where the two agree bit-exactly anyway.
        const rel = want === 0 ? Math.abs(got) : Math.abs(got - want) / Math.abs(want);
        worst = Math.max(worst, rel);
        rows.push(
          `x=${x} att=${atten} crv=${curve} worklet=${got.toPrecision(9)} model=${want.toPrecision(9)} rel=${fmt(rel)}`,
        );
      }
    }
    // float32 render vs float64 `Math.pow`, and nothing else. `Math.fround`'s
    // eps is 1.19e-7, and a `pow` chain rounds a couple of times, so a few ULP
    // is the floor any correct implementation sits at. MEASURED worst case at
    // authoring: 9.02e-8 relative (~0.76 ULP). The budget is 1e-6 — an order of
    // magnitude of slack over that and still four orders tighter than any real
    // disagreement in the law could be (a wrong `k` moves these by ×2 or more).
    expect(worst, `model vs worklet, RELATIVE error (dimensionless; budget 1e-6): ${rows.join(' | ')}`)
      .toBeLessThan(1e-6);
  }, SWEEP_TIMEOUT_MS);

  it('|x| = 1 IS THE ONLY FIXED POINT — the curve attenuates below it and EXPANDS above it (#1715)', async () => {
    // The claim the shipped docs got HALF right ("compresses small signals while
    // leaving larger excursions intact"). Measured on the real worklet, at full
    // curve, with the attenuverter at unity so the curve is the only actor.
    const at = async (x: number) =>
      (await render({ ...basePatch(), aAtten: 1, aCurve: 1 }, { kind: 'none' }, x)).out['a_out']!;
    const below = await at(0.5);
    const unity = await at(1);
    const above = await at(2);
    expect(below, `0.5 in must be pushed DOWN: ${below.toPrecision(9)}`).toBeCloseTo(0.125, 5);
    expect(unity, `1.0 in is the fixed point: ${unity.toPrecision(9)}`).toBeCloseTo(1, 5);
    expect(above, `2.0 in must be LIFTED, not "left intact": ${above.toPrecision(9)}`).toBeCloseTo(8, 4);
    // And the two hero readouts are computed off exactly this law, in opposite
    // directions — the property that makes them each other's negative control.
    const p = { unityAtten: 1, aAtten: 1, aCurve: 1, bAtten: 1, bCurve: 1 };
    expect(unityscaleResponse('a', UNITYSCALE_PROBE_HALF, p)).toBeLessThan(UNITYSCALE_PROBE_HALF);
    expect(unityscaleResponse('a', UNITYSCALE_PROBE_OVER, p)).toBeGreaterThan(UNITYSCALE_PROBE_OVER);
  }, SWEEP_TIMEOUT_MS);
});
