// packages/web/src/lib/audio/modules/illogic.ts
//
// ILLOGIC — combined attenuverter / math / logic utility.
//
// 4 cv/audio inputs (in1..in4) feed a per-channel bipolar attenuverter
// (-1..0..+1, default +1). The post-attenuverter signals are then summed
// in two ways (sum, diff). Inputs in1 and in2 are also treated as gates
// (threshold = 0.5) and combined into AND/NAND/OR outputs; in1 alone
// drives a NOT output.
//
// Pure-JS Web Audio: no Faust DSP. The math + logic decompose into
// GainNodes (for the attenuverters and signed sums) and WaveShaperNodes
// (for the gate thresholds). Boolean composition uses Web Audio's
// "modulate-the-gain-AudioParam" multiplier trick (see AND below) to
// produce clean 0/1 outputs without curve-interpolation artifacts.
//
// Why pure JS: the operations are trivial (gain + threshold + multiply)
// and have no loop / state / sample-rate concerns. Skipping Faust
// avoids a wasm build for what is essentially a routing module, and
// keeps the math inspectable from the unit tests below.
//
// I/O surface (mirrors illogicDef):
//
//   in1 ──► [×att1] ──► sum(+) ───► sum
//                  └──► diff(+) ──► diff
//   in2 ──► [×att2] ──► sum(+) ───► sum
//                  └──► diff(+) ──► diff
//   in3 ──► [×att3] ──► sum(+) ───► sum
//                  └──► diff(-) ──► diff
//   in4 ──► [×att4] ──► sum(+) ───► sum
//                  └──► diff(-) ──► diff
//
//   in1 ──► [thresh ≥0.5] ──► g1 ──► gate1 × gate2 ──► and ──► [1 - and] ──► nand
//   in2 ──► [thresh ≥0.5] ──► g2 ──┘                  │
//                                                      └─► g1 + g2 - and ──► or
//   in1 ──► [thresh ≥0.5] ──► g1 ──► [1 - g1] ──► not
//
// AND uses the GainNode-modulator multiplier: andOut.gain.value = 0,
// then connect gate1 → andOut (audio input) AND gate2 → andOut.gain
// (modulator). Effective output = gate1 × (0 + gate2) = gate1 × gate2.
// NAND/OR/NOT compose from AND + threshold gates via straight signed
// sums (GainNode(-1) negation + a unifying sum bus).
//
// Inputs:
//   in1 / in2 / in3 / in4 (cv): four signal inputs. Treated as bipolar audio/CV.
//
// Outputs:
//   att1..att4 (cv): post-attenuverter passthroughs.
//   sum (cv): att1 + att2 + att3 + att4.
//   diff (cv): att1 + att2 - att3 - att4 (sign-aware).
//   and / nand / or (gate): boolean combinations of in1 + in2 thresholded at 0.5.
//   not (gate): NOT of in1 thresholded at 0.5.
//
// Params:
//   att{1..4}_amount (linear -1..1, default 1): per-channel attenuverter.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

/** Pure helpers extracted so the unit tests can exercise the math without
 *  spinning up a Web Audio context. */
export const illogicMath = {
  /** Bipolar attenuverter: y = x * gain, with gain ∈ [-1, +1]. */
  atten(x: number, gain: number): number {
    return x * gain;
  },
  /** Threshold an input as a gate. Returns 1 if v >= 0.5, else 0. */
  gate(v: number): 0 | 1 {
    return v >= 0.5 ? 1 : 0;
  },
  and(a: number, b: number): 0 | 1 {
    return illogicMath.gate(a) === 1 && illogicMath.gate(b) === 1 ? 1 : 0;
  },
  nand(a: number, b: number): 0 | 1 {
    return illogicMath.and(a, b) === 1 ? 0 : 1;
  },
  or(a: number, b: number): 0 | 1 {
    return illogicMath.gate(a) === 1 || illogicMath.gate(b) === 1 ? 1 : 0;
  },
  /** Single-input NOT of in1. Returns 1 when input < 0.5 (i.e., gate is low). */
  not(a: number): 0 | 1 {
    return illogicMath.gate(a) === 1 ? 0 : 1;
  },
};

/** Allocate a Float32Array on a bare ArrayBuffer (not SharedArrayBuffer).
 *  WaveShaperNode.curve requires `Float32Array<ArrayBuffer>`; the default
 *  Float32Array constructor returns `Float32Array<ArrayBufferLike>` which
 *  TypeScript treats as a wider type that includes SharedArrayBuffer.
 *  Allocating through a fresh ArrayBuffer pins the generic param. */
function newCurve(size: number): Float32Array<ArrayBuffer> {
  return new Float32Array(new ArrayBuffer(size * 4));
}

/** WaveShaper curve: hard-threshold to 0/1 at v >= 0.5 (gate semantics).
 *  We sample 4096 points across the WaveShaper input range [-1, +1] (the
 *  default oversample range). For inputs outside ±1 (e.g., gate sources
 *  emitting +1 cleanly, or audio peaks), the WaveShaperNode clips the
 *  curve at the table endpoints, which is fine for our threshold. */
function thresholdCurve(threshold = 0.5, size = 4096): Float32Array<ArrayBuffer> {
  const curve = newCurve(size);
  for (let i = 0; i < size; i++) {
    // Map index [0, size-1] → x ∈ [-1, +1].
    const x = (i / (size - 1)) * 2 - 1;
    curve[i] = x >= threshold ? 1 : 0;
  }
  return curve;
}


export const illogicDef: AudioModuleDef = {
  type: 'illogic',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'illogic',
  category: 'utilities',
  schemaVersion: 1,

  inputs: [
    { id: 'in1', type: 'cv' },
    { id: 'in2', type: 'cv' },
    { id: 'in3', type: 'cv' },
    { id: 'in4', type: 'cv' },
  ],
  outputs: [
    // Per-channel attenuverted outs (the "attenuator" half of the module).
    { id: 'att1', type: 'cv' },
    { id: 'att2', type: 'cv' },
    { id: 'att3', type: 'cv' },
    { id: 'att4', type: 'cv' },
    // Math outs (the "math" half).
    { id: 'sum',  type: 'cv' },
    { id: 'diff', type: 'cv' },
    // Logic outs (the "logic" half — in1 + in2 thresholded as gates).
    { id: 'and',  type: 'gate' },
    { id: 'nand', type: 'gate' },
    { id: 'or',   type: 'gate' },
    { id: 'not',  type: 'gate' },
  ],
  params: [
    { id: 'att1_amount', label: 'Att1', defaultValue: 1, min: -1, max: 1, curve: 'linear' },
    { id: 'att2_amount', label: 'Att2', defaultValue: 1, min: -1, max: 1, curve: 'linear' },
    { id: 'att3_amount', label: 'Att3', defaultValue: 1, min: -1, max: 1, curve: 'linear' },
    { id: 'att4_amount', label: 'Att4', defaultValue: 1, min: -1, max: 1, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // ---------------- Attenuverters (per channel) ----------------
    //
    // Each input feeds a GainNode whose .gain AudioParam holds the per-
    // channel attenuverter coefficient (the "attN_amount" param). Because
    // gain ∈ [-1, +1] is supported by GainNode, this gives us bipolar
    // attenuverter behavior (negative gain = sign-inverted output) with
    // zero extra DSP.
    //
    // The gain node's output IS the per-channel `attN` outport.
    function makeAtten(initial: number): GainNode {
      const g = ctx.createGain();
      g.gain.setValueAtTime(initial, ctx.currentTime);
      return g;
    }
    const initA1 = (node.params ?? {}).att1_amount ?? 1;
    const initA2 = (node.params ?? {}).att2_amount ?? 1;
    const initA3 = (node.params ?? {}).att3_amount ?? 1;
    const initA4 = (node.params ?? {}).att4_amount ?? 1;
    const att1 = makeAtten(initA1);
    const att2 = makeAtten(initA2);
    const att3 = makeAtten(initA3);
    const att4 = makeAtten(initA4);

    // ---------------- Math: sum + diff ----------------
    //
    // Web Audio summing is implicit: every connection into a node's input
    // sums with whatever else lands on that input. So `sum` = a single
    // GainNode(1) with all four att outputs feeding input 0.
    //
    // `diff` = (att1 + att2) - (att3 + att4). We negate att3 + att4 by
    // routing them through GainNode(-1) before the diff sum bus.
    const sumBus = ctx.createGain();
    sumBus.gain.value = 1;
    att1.connect(sumBus);
    att2.connect(sumBus);
    att3.connect(sumBus);
    att4.connect(sumBus);

    const diffBus = ctx.createGain();
    diffBus.gain.value = 1;
    const negA3 = ctx.createGain();
    negA3.gain.value = -1;
    const negA4 = ctx.createGain();
    negA4.gain.value = -1;
    att1.connect(diffBus);
    att2.connect(diffBus);
    att3.connect(negA3);
    att4.connect(negA4);
    negA3.connect(diffBus);
    negA4.connect(diffBus);

    // ---------------- Logic: AND / NAND / OR / NOT ----------------
    //
    // We need to reach ports in1 and in2 as logic inputs (gate-thresholded
    // pre-attenuverter — the spec says "logic block that produces AND
    // NAND OR NOT outputs for 1&2"). To keep one input port per declared
    // input, we tee in1 + in2 INTO the attenuverter GainNodes' input as
    // usual, but ALSO into a parallel pair of GainNode(1) "logic taps"
    // that the user's input cable reaches automatically because Web Audio
    // connections to a GainNode sum into the destination — and the
    // destination here is a tap node that also gets the same source via
    // the engine's reconciler.
    //
    // Wait — that's not how it works. When the engine wires a cable
    // `src -> in1`, it calls `srcNode.connect(handle.inputs.get('in1').node)`
    // exactly once, with the registered node = `att1`. Nothing else
    // automatically fans out.
    //
    // The trick: register the input port as a fan-out point. We'll
    // expose a single "input bus" GainNode per logic-relevant channel
    // (in1, in2) that feeds BOTH the corresponding attenuverter AND
    // the gate-threshold pipeline. The bus replaces `att1` / `att2` as
    // the destination registered in `inputs`.
    const in1Bus = ctx.createGain();
    in1Bus.gain.value = 1;
    in1Bus.connect(att1);
    const in2Bus = ctx.createGain();
    in2Bus.gain.value = 1;
    in2Bus.connect(att2);

    // Threshold curves: in1Bus + in2Bus → 0 or 1. WaveShaper clips inputs
    // to its curve range and interpolates between adjacent samples; with a
    // dense step at index = (0.5+1)/2 * (size-1), inputs well above 0.5
    // resolve to a clean 1 and inputs well below resolve to a clean 0.
    // Inputs near the threshold yield interpolated values, but the
    // downstream multiplication trick uses these gates as AudioParam
    // modulators where any > 0 value still semantically registers as
    // "rising". Truth-table tests use 0.0 / 1.0 inputs that lie far from
    // the threshold so interpolation noise doesn't matter.
    const thr = thresholdCurve();
    const gate1 = ctx.createWaveShaper();
    gate1.curve = thr;
    const gate2 = ctx.createWaveShaper();
    gate2.curve = thr;
    in1Bus.connect(gate1);
    in2Bus.connect(gate2);

    // ConstantSource(+1) used by NAND/NOT/OR for the (1 - x) inversion.
    const oneSrc = ctx.createConstantSource();
    oneSrc.offset.value = 1;
    oneSrc.start();

    // ----- True multiplication via Gain × AudioParam -----
    //
    // Web Audio doesn't expose a "multiply two audio signals" node, but a
    // GainNode whose .gain AudioParam is being modulated by an audio
    // source IS effectively a multiplier: out = audioInput × (gain.value +
    // sum_of_modulator_signals). Setting the intrinsic .gain.value = 0
    // turns the GainNode into a pure multiplier of (audioInput) ×
    // (modulator).
    //
    // AND = gate1 × gate2.
    // The cardinal trick: feed gate1 → andOut (audio input), and connect
    // gate2 to andOut.gain (after zeroing the intrinsic gain). When both
    // gates are 1, andOut emits 1 × 1 = 1; otherwise one of them is 0 so
    // the product is 0. Truly 0 / 1 with no interpolation artifacts.
    const andOut = ctx.createGain();
    andOut.gain.value = 0;
    gate1.connect(andOut);
    gate2.connect(andOut.gain);

    // NAND = 1 - AND.
    // Sum oneSrc (= +1) with negAnd (= -andOut) → gives 1 - andOut.
    // Output is 0 or 1, no clamp needed since both inputs are clean.
    const nandOut = ctx.createGain();
    nandOut.gain.value = 1;
    oneSrc.connect(nandOut);
    const negAnd = ctx.createGain();
    negAnd.gain.value = -1;
    andOut.connect(negAnd);
    negAnd.connect(nandOut);

    // OR = gate1 + gate2 - (gate1 × gate2).
    // De Morgan-style decomposition; emits 0 / 1 / 1 / 1 across the four
    // combinations of (gate1, gate2). Compose as:
    //   orOut = gate1 + gate2 - andOut    (0/0)→0, (1/0)→1, (0/1)→1, (1/1)→1
    const orOut = ctx.createGain();
    orOut.gain.value = 1;
    gate1.connect(orOut);
    gate2.connect(orOut);
    const negAndForOr = ctx.createGain();
    negAndForOr.gain.value = -1;
    andOut.connect(negAndForOr);
    negAndForOr.connect(orOut);

    // NOT (in1 only) = 1 - gate1.
    const notOut = ctx.createGain();
    notOut.gain.value = 1;
    oneSrc.connect(notOut);
    const negG1 = ctx.createGain();
    negG1.gain.value = -1;
    gate1.connect(negG1);
    negG1.connect(notOut);

    return {
      domain: 'audio',
      inputs: new Map([
        ['in1', { node: in1Bus, input: 0 }],
        ['in2', { node: in2Bus, input: 0 }],
        // in3 and in4 don't need a logic tap, so they go straight to their
        // attenuverter inputs.
        ['in3', { node: att3,   input: 0 }],
        ['in4', { node: att4,   input: 0 }],
      ]),
      outputs: new Map([
        ['att1', { node: att1,    output: 0 }],
        ['att2', { node: att2,    output: 0 }],
        ['att3', { node: att3,    output: 0 }],
        ['att4', { node: att4,    output: 0 }],
        ['sum',  { node: sumBus,  output: 0 }],
        ['diff', { node: diffBus, output: 0 }],
        ['and',  { node: andOut,  output: 0 }],
        ['nand', { node: nandOut, output: 0 }],
        ['or',   { node: orOut,   output: 0 }],
        ['not',  { node: notOut,  output: 0 }],
      ]),
      setParam(paramId, value) {
        switch (paramId) {
          case 'att1_amount': att1.gain.setValueAtTime(value, ctx.currentTime); return;
          case 'att2_amount': att2.gain.setValueAtTime(value, ctx.currentTime); return;
          case 'att3_amount': att3.gain.setValueAtTime(value, ctx.currentTime); return;
          case 'att4_amount': att4.gain.setValueAtTime(value, ctx.currentTime); return;
        }
      },
      readParam(paramId) {
        switch (paramId) {
          case 'att1_amount': return att1.gain.value;
          case 'att2_amount': return att2.gain.value;
          case 'att3_amount': return att3.gain.value;
          case 'att4_amount': return att4.gain.value;
        }
        return undefined;
      },
      dispose() {
        try { oneSrc.stop(); } catch { /* already stopped */ }
        oneSrc.disconnect();
        in1Bus.disconnect();
        in2Bus.disconnect();
        att1.disconnect();
        att2.disconnect();
        att3.disconnect();
        att4.disconnect();
        sumBus.disconnect();
        diffBus.disconnect();
        negA3.disconnect();
        negA4.disconnect();
        gate1.disconnect();
        gate2.disconnect();
        andOut.disconnect();
        negAnd.disconnect();
        nandOut.disconnect();
        negAndForOr.disconnect();
        orOut.disconnect();
        notOut.disconnect();
        negG1.disconnect();
      },
    };
  },
};
