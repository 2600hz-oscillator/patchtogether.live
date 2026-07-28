// packages/web/src/lib/audio/dx7-algorithms.ts
//
// Mirror of the 32-algorithm routing table embedded in packages/dsp/src/dx7.ts.
// Exported here so the host can validate the table structure under unit tests
// (the worklet bundle is not directly importable from the web workspace), and
// so dx7-render.ts (the ART renderer) routes exactly like the worklet.
//
// MUST stay in sync with the CARRIER_TABLE / MOD_TABLE / FEEDBACK_TABLE in
// dx7.ts. `dx7-algorithms.test.ts` pins every row against the real DX7 chart
// (a GOLDEN, not a structural sanity check) and asserts that all 32 rows are
// topologically DISTINCT.
//
// PROVENANCE of the table below — it was DERIVED, not hand-typed, by decoding
// two independent authoritative sources and asserting they agree on all 32
// rows (they do, exactly):
//
//   (a) the real DX7 OPS-chip ALGORITHM ROM dump — Ken Shirriff's die-level
//       reverse engineering, "Yamaha DX7 chip reverse-engineering, part 4:
//       how algorithms are implemented" (righto.com, 2021-12), footnote 5.
//       Each ROM word is "SEL / FREN MREN / COM"; column N is the control
//       word latched while operator N's value is at the output, so column N
//       selects operator N-1's modulation source (column 1 wraps to op6).
//       FREN=1 latches the feedback register FROM operator N; SEL=5 is the
//       averaged ("anti-hunting") feedback path INTO operator N-1.
//   (b) `FmCore::algorithms` in Dexed / Google's music-synthesizer-for-android
//       (`Source/msfa/fm_core.cc`), whose 6 bytes per algorithm are ordered
//       op6..op1 and encode in/out bus + FB_IN (receives feedback) /
//       FB_OUT (sources feedback).
//
// FEEDBACK IS PER-ALGORITHM, NOT ALWAYS OP6. The DX7 places the feedback loop
// on a different operator per algorithm — that placement is exactly what
// distinguishes e.g. algorithms 1 and 2, which are otherwise the same routing.
// Two algorithms (4 and 6) use a MULTI-OPERATOR loop rather than a self-loop,
// which is why `feedback` is a {from,to} pair and not a single op index.

/**
 * The feedback loop for one algorithm. The 1-sample feedback memory is fed
 * from operator `from`'s output and modulates operator `to`'s phase, scaled by
 * the patch's feedback depth. `from === to` is the usual self-loop; algorithm
 * 4 (op4 → op6) and algorithm 6 (op5 → op6) are the two multi-operator loops.
 */
export interface DX7Feedback {
  /** Operator index (0..5) whose output feeds the loop's 1-sample memory. */
  from: number;
  /** Operator index (0..5) whose phase that memory modulates. */
  to: number;
}

export interface DX7AlgorithmDef {
  /** 1-indexed algorithm number 1..32. */
  num: number;
  /** Operator indices (0..5) that mix to the audio output. */
  carriers: number[];
  /**
   * Per-op modulator-source list: modSrcs[op] = list of op indices feeding
   * op's phase. The feedback path is NOT listed here — it lives in `feedback`
   * (an op never appears in its own modSrcs list).
   */
  modSrcs: number[][];
  /** Where this algorithm's single feedback loop is wired. */
  feedback: DX7Feedback;
}

export const DX7_ALGORITHMS: DX7AlgorithmDef[] = [
  { num: 1,  carriers: [0, 2],          modSrcs: [[1], [], [3], [4], [5], []],       feedback: { from: 5, to: 5 } },
  { num: 2,  carriers: [0, 2],          modSrcs: [[1], [], [3], [4], [5], []],       feedback: { from: 1, to: 1 } },
  { num: 3,  carriers: [0, 3],          modSrcs: [[1], [2], [], [4], [5], []],       feedback: { from: 5, to: 5 } },
  { num: 4,  carriers: [0, 3],          modSrcs: [[1], [2], [], [4], [5], []],       feedback: { from: 3, to: 5 } },
  { num: 5,  carriers: [0, 2, 4],       modSrcs: [[1], [], [3], [], [5], []],        feedback: { from: 5, to: 5 } },
  { num: 6,  carriers: [0, 2, 4],       modSrcs: [[1], [], [3], [], [5], []],        feedback: { from: 4, to: 5 } },
  { num: 7,  carriers: [0, 2],          modSrcs: [[1], [], [3, 4], [], [5], []],     feedback: { from: 5, to: 5 } },
  { num: 8,  carriers: [0, 2],          modSrcs: [[1], [], [3, 4], [], [5], []],     feedback: { from: 3, to: 3 } },
  { num: 9,  carriers: [0, 2],          modSrcs: [[1], [], [3, 4], [], [5], []],     feedback: { from: 1, to: 1 } },
  { num: 10, carriers: [0, 3],          modSrcs: [[1], [2], [], [4, 5], [], []],     feedback: { from: 2, to: 2 } },
  { num: 11, carriers: [0, 3],          modSrcs: [[1], [2], [], [4, 5], [], []],     feedback: { from: 5, to: 5 } },
  { num: 12, carriers: [0, 2],          modSrcs: [[1], [], [3, 4, 5], [], [], []],   feedback: { from: 1, to: 1 } },
  { num: 13, carriers: [0, 2],          modSrcs: [[1], [], [3, 4, 5], [], [], []],   feedback: { from: 5, to: 5 } },
  { num: 14, carriers: [0, 2],          modSrcs: [[1], [], [3], [4, 5], [], []],     feedback: { from: 5, to: 5 } },
  { num: 15, carriers: [0, 2],          modSrcs: [[1], [], [3], [4, 5], [], []],     feedback: { from: 1, to: 1 } },
  { num: 16, carriers: [0],             modSrcs: [[1, 2, 4], [], [3], [], [5], []],  feedback: { from: 5, to: 5 } },
  { num: 17, carriers: [0],             modSrcs: [[1, 2, 4], [], [3], [], [5], []],  feedback: { from: 1, to: 1 } },
  { num: 18, carriers: [0],             modSrcs: [[1, 2, 3], [], [], [4], [5], []],  feedback: { from: 2, to: 2 } },
  { num: 19, carriers: [0, 3, 4],       modSrcs: [[1], [2], [], [5], [5], []],       feedback: { from: 5, to: 5 } },
  { num: 20, carriers: [0, 1, 3],       modSrcs: [[2], [2], [], [4, 5], [], []],     feedback: { from: 2, to: 2 } },
  { num: 21, carriers: [0, 1, 3, 4],    modSrcs: [[2], [2], [], [5], [5], []],       feedback: { from: 2, to: 2 } },
  { num: 22, carriers: [0, 2, 3, 4],    modSrcs: [[1], [], [5], [5], [5], []],       feedback: { from: 5, to: 5 } },
  { num: 23, carriers: [0, 1, 3, 4],    modSrcs: [[], [2], [], [5], [5], []],        feedback: { from: 5, to: 5 } },
  { num: 24, carriers: [0, 1, 2, 3, 4], modSrcs: [[], [], [5], [5], [5], []],        feedback: { from: 5, to: 5 } },
  { num: 25, carriers: [0, 1, 2, 3, 4], modSrcs: [[], [], [], [5], [5], []],         feedback: { from: 5, to: 5 } },
  { num: 26, carriers: [0, 1, 3],       modSrcs: [[], [2], [], [4, 5], [], []],      feedback: { from: 5, to: 5 } },
  { num: 27, carriers: [0, 1, 3],       modSrcs: [[], [2], [], [4, 5], [], []],      feedback: { from: 2, to: 2 } },
  { num: 28, carriers: [0, 2, 5],       modSrcs: [[1], [], [3], [4], [], []],        feedback: { from: 4, to: 4 } },
  { num: 29, carriers: [0, 1, 2, 4],    modSrcs: [[], [], [3], [], [5], []],         feedback: { from: 5, to: 5 } },
  { num: 30, carriers: [0, 1, 2, 5],    modSrcs: [[], [], [3], [4], [], []],         feedback: { from: 4, to: 4 } },
  { num: 31, carriers: [0, 1, 2, 3, 4], modSrcs: [[], [], [], [], [5], []],          feedback: { from: 5, to: 5 } },
  { num: 32, carriers: [0, 1, 2, 3, 4, 5], modSrcs: [[], [], [], [], [], []],        feedback: { from: 5, to: 5 } },
];

export function getAlgorithm(num: number): DX7AlgorithmDef | undefined {
  if (num < 1 || num > 32 || !Number.isInteger(num)) return undefined;
  return DX7_ALGORITHMS[num - 1];
}
