// packages/web/src/lib/audio/dx7-algorithms.ts
//
// Mirror of the 32-algorithm routing table embedded in packages/dsp/src/dx7.ts.
// Exported here so the host can validate the table structure under unit tests
// (the worklet bundle is not directly importable from the web workspace).
//
// MUST stay in sync with the CARRIER_TABLE / MOD_TABLE in dx7.ts. The
// `algorithm-table.test.ts` unit test asserts the structural invariants
// (every entry has 6 modSrcs lists; carriers are non-empty subsets of [0..5];
// no carrier is also a modulator within the same op; etc.).

export interface DX7AlgorithmDef {
  /** 1-indexed algorithm number 1..32. */
  num: number;
  /** Operator indices (0..5) that mix to the audio output. */
  carriers: number[];
  /** Per-op modulator-source list: modSrcs[op] = list of op indices feeding op's phase. */
  modSrcs: number[][];
}

export const DX7_ALGORITHMS: DX7AlgorithmDef[] = [
  { num: 1,  carriers: [0, 2],          modSrcs: [[1], [], [3], [4], [5], []] },
  { num: 2,  carriers: [0, 2],          modSrcs: [[1], [], [3], [4], [5], []] },
  { num: 3,  carriers: [0, 3],          modSrcs: [[1], [2], [], [4], [5], []] },
  { num: 4,  carriers: [0, 3],          modSrcs: [[1], [2], [], [4], [5], []] },
  { num: 5,  carriers: [0, 2, 4],       modSrcs: [[1], [], [3], [], [5], []] },
  { num: 6,  carriers: [0, 2, 4],       modSrcs: [[1], [], [3], [], [5], []] },
  { num: 7,  carriers: [0, 2],          modSrcs: [[1], [], [3, 4], [], [5], []] },
  { num: 8,  carriers: [0, 2],          modSrcs: [[1], [], [3, 4], [], [5], []] },
  { num: 9,  carriers: [0, 2],          modSrcs: [[1], [], [3, 4], [], [5], []] },
  { num: 10, carriers: [0, 3],          modSrcs: [[1, 2], [], [], [4], [5], []] },
  { num: 11, carriers: [0, 3],          modSrcs: [[1, 2], [], [], [4], [5], []] },
  { num: 12, carriers: [0, 2],          modSrcs: [[1], [], [3, 4, 5], [], [], []] },
  { num: 13, carriers: [0, 2],          modSrcs: [[1], [], [3, 4, 5], [], [], []] },
  { num: 14, carriers: [0, 2],          modSrcs: [[1], [], [3], [4, 5], [], []] },
  { num: 15, carriers: [0, 2],          modSrcs: [[1], [], [3], [4, 5], [], []] },
  { num: 16, carriers: [0],             modSrcs: [[1, 2, 4], [], [3], [], [5], []] },
  { num: 17, carriers: [0],             modSrcs: [[1, 2, 4], [], [3], [], [5], []] },
  { num: 18, carriers: [0],             modSrcs: [[1, 2, 3], [], [], [4, 5], [], []] },
  { num: 19, carriers: [0, 3, 4],       modSrcs: [[1, 2], [], [], [], [5], []] },
  { num: 20, carriers: [0, 1, 3],       modSrcs: [[2], [2], [3, 4], [], [5], []] },
  { num: 21, carriers: [0, 1, 3, 4],    modSrcs: [[2], [2], [3, 4], [4], [5], []] },
  { num: 22, carriers: [0, 2, 3, 4],    modSrcs: [[1], [], [5], [5], [5], []] },
  { num: 23, carriers: [0, 1, 3, 4],    modSrcs: [[1], [], [3], [4], [5], []] },
  { num: 24, carriers: [0, 1, 2, 3, 4], modSrcs: [[1, 2], [2], [4, 5], [], [], []] },
  { num: 25, carriers: [0, 1, 2, 3, 4], modSrcs: [[1, 2], [2], [4, 5], [], [], []] },
  { num: 26, carriers: [0, 1, 3],       modSrcs: [[1], [3, 4], [], [4], [5], []] },
  { num: 27, carriers: [0, 1, 3],       modSrcs: [[1], [3, 4], [], [4], [5], []] },
  { num: 28, carriers: [0, 2, 5],       modSrcs: [[1], [], [3], [4], [], []] },
  { num: 29, carriers: [0, 1, 2, 4],    modSrcs: [[2], [], [3], [4, 5], [], []] },
  { num: 30, carriers: [0, 1, 2, 5],    modSrcs: [[1], [], [3, 4], [], [], []] },
  { num: 31, carriers: [0, 1, 2, 3, 4], modSrcs: [[1], [], [], [], [5], []] },
  { num: 32, carriers: [0, 1, 2, 3, 4, 5], modSrcs: [[], [], [], [], [], [5]] },
];

export function getAlgorithm(num: number): DX7AlgorithmDef | undefined {
  if (num < 1 || num > 32 || !Number.isInteger(num)) return undefined;
  return DX7_ALGORITHMS[num - 1];
}
