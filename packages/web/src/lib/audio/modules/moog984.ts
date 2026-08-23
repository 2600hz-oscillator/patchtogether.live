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

  // ── THE FACEPLATE ──────────────────────────────────────────────────────────
  //
  // WHAT IT IS FOR. Every other panel in this family DOES something to a
  // signal. The 984 does nothing to one — it decides HOW MUCH OF IT GOES WHERE,
  // to four places at once. It is the only module in the family whose surface
  // is a TABLE rather than a row of controls: the verb is CROSS-FADING A PATCH,
  // moving a source from one destination to another without touching a cable,
  // and blending several sources into one bus on the way.
  //
  // ⚠ THE SIXTEEN CROSS-POINTS ARE BIT-EXACTLY SYMMETRIC, and this face says so
  // rather than inventing a hierarchy. They are emitted from ONE loop above, so
  // every min / max / defaultValue / curve is identical, and the factory gives
  // each an identical GainNode reached through identical code. No measurement
  // distinguishes any one of them from any other. So `order` below is a stated
  // CONVENTION, not a ranking argument — the `moog993` precedent, where the
  // merit is likewise carried by a readout rather than by the ranking.
  //
  // THE LADDER, read back as a sentence: mini shows IN 1 → OUT 1; compact adds
  // IN 2 and IN 3 into the same output; the plate shows every source that can
  // reach OUT 1, plus the first two into OUT 2; the dock shows the whole
  // matrix. The convention is COLUMN-MAJOR, so what a shrinking tier keeps is a
  // COMPLETE OUTPUT BUS — four sources blended into one destination, which is
  // still a working mixer. Ranking row-major would keep a complete fan-OUT
  // instead; both are defensible and the choice is decided by the module's own
  // name and by its outputs being summed buses ("each output is the sum of its
  // column", `docs.explanation`). It would be the WRONG convention for a 1→N
  // distributor, where the row is the unit.
  //
  // ⚠ `order` AND `pages` DISAGREE, DELIBERATELY, AND THIS IS THE ONE FACE
  // WHERE THE DISAGREEMENT IS THE POINT. `order` is column-major (the priority
  // ranking, which only ever decides what a LANE TIER paints as a subset);
  // `pages` is ROW-major, because the dock renders everything and there the
  // layout must be the physical matrix — rows are inputs, columns are outputs,
  // exactly as `m_ij` is named, as `docs` describes it and as the legacy card
  // draws it. Transposing the dock to match the ranking would make the face
  // disagree with every other statement of the same object.
  //
  // ── THE GRID IS REAL, AND IT IS ONE BAND ─────────────────────────────────
  //
  // ONE band of four equal clusters, NOT four bands. `consoleGridCols`
  // (`$lib/ui/workflow/console-grid.ts:80`) turns a band into a CONSOLE GRID —
  // fixed-width columns on the shared `DOCK_KCOL_W` ruler, so column j has the
  // same centre in every cluster — when the band has at least two clusters, all
  // of equal size, at least two cells each, and does not ask for
  // `clusterFlow: 'row'`. Four clusters of four satisfies every clause, so this
  // band answers 4 and the four output columns line up by construction.
  //
  // ⚠ FOUR BANDS WOULD DESTROY IT, silently and while looking correct:
  // `dock-row-plan`'s `packRun` packs whole bands onto a row up to
  // `DOCK_ROW_MAX_CONTROLS = 10`, so `[4,4,4,4]` becomes two rows of eight and
  // there is no matrix left. The cluster is a ~14 px sub-header against a
  // ~81 px band, which is the other reason: four band headers to say `in 1..4`
  // is four times the vertical cost of the thing they label.
  //
  // (This face has ONE console band, so `faceConsoleGridCols`'s face-level
  // ruler — which needs `FACE_CONSOLE_MIN_BANDS = 2` — correctly does not
  // engage. A lone console band has nothing to be aligned to and keeps its own.)
  //
  // ── WHY NO GLYPH ─────────────────────────────────────────────────────────
  //
  // `'none'`, and it is a refusal rather than an omission. The outputs are
  // audio, so a `meter` WOULD resolve — onto `out1` alone, because
  // `primaryAudioOutPortId` takes the first. A picture that silently means "one
  // of these four buses" on the module whose entire subject is which bus
  // carries what is the mixmstrs blind-tap hazard with a live tap instead of a
  // dead one. Declaring `'none'` also buys the compact tier a third cell.
  //
  // ── WHAT THE READOUTS CARRY ──────────────────────────────────────────────
  //
  // Four, one per output bus — the column sums, `Σ_i m_ij`, in dB. This is the
  // whole merit case and it is the only thing on the face that is not a knob
  // relabelled: an output's gain is a JOIN over four params, so a readback of
  // the nearest cross-point is blind to three quarters of it while moving
  // convincingly. See `moog984-face-model.ts`; both negative-control legs
  // (moves with its column, invariant to its row) are permanent in
  // `moog984-face-model.test.ts`.
  face: {
    order: [
      // COLUMN-MAJOR: everything that reaches OUT 1, then OUT 2, and so on.
      // Built from the def's own roster so it cannot drift from `params`.
      ...[1, 2, 3, 4].flatMap((j) => [1, 2, 3, 4].map((i) => crossId(i, j))),
    ],
    glyph: 'none',
    pages: [
      {
        // ROW-MAJOR, one cluster per input — the physical matrix. The band
        // label names what the sixteen controls ARE; the module's own name is
        // already painted once by the dock title bar and is not repeated here.
        id: 'crosspoints',
        label: 'cross-points',
        controls: [...[1, 2, 3, 4].flatMap((i) => [1, 2, 3, 4].map((j) => crossId(i, j)))],
        clusters: [1, 2, 3, 4].map((i) => ({
          label: `in ${i}`,
          controls: [1, 2, 3, 4].map((j) => crossId(i, j)),
        })),
      },
    ],
  },

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
