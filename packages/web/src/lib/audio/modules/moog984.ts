// packages/web/src/lib/audio/modules/moog984.ts
//
// MOOG 984 4-CHANNEL MATRIX MIXER — a slice of the Moog System 55 / 35 clone
// initiative (.myrobots/MOOG/). The 984 is a passive routing/mixing module: a
// 4×4 cross-point matrix that lets any of the four inputs be mixed, at an
// independent level, into any of the four outputs.
//
//   out_j = Σ_i (in_i × m_ij)   for i,j ∈ {1..4}
//
// PURE WEB AUDIO — no AudioWorklet, no Faust .dsp. The whole matrix is built
// from plain GainNodes (mirrors the pure-gain factory pattern of attenumix /
// mixer): 16 cross-point gains carry the m_ij coefficients, four per-input
// unity "fan" gains let each input feed its whole row from a single receiving
// node, and four summing gains collect each column into an output. Default
// cross-point level is 0, so a freshly spawned matrix is silent until the user
// dials in a connection — exactly how a patch-matrix behaves.
//
// Inputs:
//   in1..in4 (audio): the four signals to route.
//
// Outputs:
//   out1..out4 (audio): the four summed buses (each = Σ_i in_i × m_i,out).
//
// Params:
//   m11..m44 (linear 0..1, default 0): the 16 cross-point levels. `mIJ` is the
//     amount of input I that reaches output J (row = input, column = output).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ParamDef } from '$lib/graph/types';

const N = 4; // 4 inputs × 4 outputs.

/** Cross-point param id for input row i, output column j (1-based). */
function crossId(i: number, j: number): string {
  return `m${i}${j}`;
}

// Build the 16 cross-point param defs once (m11..m44), row-major.
const CROSS_PARAMS: ParamDef[] = (() => {
  const out: ParamDef[] = [];
  for (let i = 1; i <= N; i++) {
    for (let j = 1; j <= N; j++) {
      out.push({
        id: crossId(i, j),
        label: `${i}→${j}`,
        defaultValue: 0,
        min: 0,
        max: 1,
        curve: 'linear',
      });
    }
  }
  return out;
})();

export const moog984Def: AudioModuleDef = {
  type: 'moog984',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  domain: 'audio',
  label: '984 matrix',
  category: 'utilities',
  schemaVersion: 1,

  inputs: [
    { id: 'in1', type: 'audio' },
    { id: 'in2', type: 'audio' },
    { id: 'in3', type: 'audio' },
    { id: 'in4', type: 'audio' },
  ],
  outputs: [
    { id: 'out1', type: 'audio' },
    { id: 'out2', type: 'audio' },
    { id: 'out3', type: 'audio' },
    { id: 'out4', type: 'audio' },
  ],
  params: CROSS_PARAMS,

  docs: {
    explanation:
      "A clean-room recreation of the Moog 984 Matrix Mixer — a 4×4 cross-point router that lets any of the four inputs be mixed, at an independent level, into any of the four outputs. The faceplate is the matrix itself: rows are inputs (IN 1–4), columns are outputs (OUT 1–4), and each of the 16 cross-point knobs sets how much of that row's input reaches that column's output (each output is the sum of its column). Every cross-point starts at 0, so a freshly placed matrix is silent until you dial in connections — exactly how a patch matrix behaves. Mental model: 16 independent send levels arranged in a grid, so one source can fan out to several destinations and several sources can be blended into one — patch four oscillators or effect sends and freely route/blend them to four destinations. Works for audio or CV (the mix is DC-transparent).",
    inputs: {
      in1: "Input row 1 — fed to OUT 1–4 by the amounts set in matrix row 1 (the m1* knobs).",
      in2: "Input row 2 — fed to the four outputs by the amounts in matrix row 2 (m2*).",
      in3: "Input row 3 — fed to the four outputs by the amounts in matrix row 3 (m3*).",
      in4: "Input row 4 — fed to the four outputs by the amounts in matrix row 4 (m4*).",
    },
    outputs: {
      out1: "Output column 1 — the sum of every input scaled by its 'i→1' cross-point (m11 + m21 + m31 + m41 contributions).",
      out2: "Output column 2 — the sum of every input scaled by its 'i→2' cross-point.",
      out3: "Output column 3 — the sum of every input scaled by its 'i→3' cross-point.",
      out4: "Output column 4 — the sum of every input scaled by its 'i→4' cross-point.",
    },
    controls: {
      m11: "Cross-point IN 1 → OUT 1: how much of input 1 is mixed into output 1 (0 = no connection, 1 = unity).",
      m12: "Cross-point IN 1 → OUT 2: amount of input 1 sent to output 2.",
      m13: "Cross-point IN 1 → OUT 3: amount of input 1 sent to output 3.",
      m14: "Cross-point IN 1 → OUT 4: amount of input 1 sent to output 4.",
      m21: "Cross-point IN 2 → OUT 1: amount of input 2 sent to output 1.",
      m22: "Cross-point IN 2 → OUT 2: amount of input 2 sent to output 2.",
      m23: "Cross-point IN 2 → OUT 3: amount of input 2 sent to output 3.",
      m24: "Cross-point IN 2 → OUT 4: amount of input 2 sent to output 4.",
      m31: "Cross-point IN 3 → OUT 1: amount of input 3 sent to output 1.",
      m32: "Cross-point IN 3 → OUT 2: amount of input 3 sent to output 2.",
      m33: "Cross-point IN 3 → OUT 3: amount of input 3 sent to output 3.",
      m34: "Cross-point IN 3 → OUT 4: amount of input 3 sent to output 4.",
      m41: "Cross-point IN 4 → OUT 1: amount of input 4 sent to output 1.",
      m42: "Cross-point IN 4 → OUT 2: amount of input 4 sent to output 2.",
      m43: "Cross-point IN 4 → OUT 3: amount of input 4 sent to output 3.",
      m44: "Cross-point IN 4 → OUT 4: amount of input 4 sent to output 4 (0 = no connection, 1 = unity).",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const initial = node.params ?? {};
    const readInitial = (id: string): number => {
      const def = moog984Def.params.find((p) => p.id === id)!;
      return initial[id] ?? def.defaultValue;
    };

    // Per-input unity "fan" gains: each input feeds ONE receiving node that
    // fans out to its whole row of cross-points. This is what the inputs Map
    // points at (an input port maps to exactly one node).
    const fanIn: GainNode[] = [];
    for (let i = 0; i < N; i++) {
      const g = ctx.createGain();
      g.gain.value = 1;
      fanIn.push(g);
    }

    // Per-output summing gains (unity): all cross-points of a column feed here,
    // and this node is the output port.
    const sumOut: GainNode[] = [];
    for (let j = 0; j < N; j++) {
      const g = ctx.createGain();
      g.gain.value = 1;
      sumOut.push(g);
    }

    // 16 cross-point gains, indexed [i][j] (row=input, column=output). gain =
    // m_(i+1)(j+1). fanIn[i] → cross[i][j] → sumOut[j].
    const cross: GainNode[][] = [];
    for (let i = 0; i < N; i++) {
      const row: GainNode[] = [];
      for (let j = 0; j < N; j++) {
        const g = ctx.createGain();
        g.gain.value = readInitial(crossId(i + 1, j + 1));
        fanIn[i]!.connect(g);
        g.connect(sumOut[j]!);
        row.push(g);
      }
      cross.push(row);
    }

    /** Locate the cross-point GainNode for a param id like 'm23'. */
    function crossNodeFor(paramId: string): GainNode | undefined {
      if (paramId.length !== 3 || paramId[0] !== 'm') return undefined;
      const i = Number(paramId[1]) - 1;
      const j = Number(paramId[2]) - 1;
      if (i < 0 || i >= N || j < 0 || j >= N) return undefined;
      return cross[i]?.[j];
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['in1', { node: fanIn[0]!, input: 0 }],
        ['in2', { node: fanIn[1]!, input: 0 }],
        ['in3', { node: fanIn[2]!, input: 0 }],
        ['in4', { node: fanIn[3]!, input: 0 }],
      ]),
      outputs: new Map([
        ['out1', { node: sumOut[0]!, output: 0 }],
        ['out2', { node: sumOut[1]!, output: 0 }],
        ['out3', { node: sumOut[2]!, output: 0 }],
        ['out4', { node: sumOut[3]!, output: 0 }],
      ]),
      setParam(paramId, value) {
        const g = crossNodeFor(paramId);
        if (g) g.gain.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return crossNodeFor(paramId)?.gain.value;
      },
      dispose() {
        for (const g of fanIn) {
          try { g.disconnect(); } catch { /* */ }
        }
        for (const row of cross) {
          for (const g of row) {
            try { g.disconnect(); } catch { /* */ }
          }
        }
        for (const g of sumOut) {
          try { g.disconnect(); } catch { /* */ }
        }
      },
    };
  },
};
