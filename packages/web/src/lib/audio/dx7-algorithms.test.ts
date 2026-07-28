// packages/web/src/lib/audio/dx7-algorithms.test.ts
//
// The GOLDEN for the 32-algorithm routing table. This file used to assert only
// structural invariants (six modSrcs slots, carriers in 0..5) — which every
// possible wrong table also satisfies. It let a table ship in which the 32
// algorithms collapsed to just 21 topologically distinct rows, because
// feedback was hardcoded to op6 for all of them and 14 rows' modSrcs were
// wrong. So: pin the real chart, and assert DISTINCTNESS.
//
// The golden below is transcribed from a table DERIVED by decoding two
// independent authoritative sources and checking they agree on all 32 rows:
//
//   (a) the real DX7 OPS-chip ALGORITHM ROM dump — Ken Shirriff, "Yamaha DX7
//       chip reverse-engineering, part 4: how algorithms are implemented"
//       (righto.com, 2021-12), footnote 5.
//   (b) `FmCore::algorithms` in Dexed / Google's music-synthesizer-for-android
//       (`Source/msfa/fm_core.cc`).
//
// Notation below is 1-INDEXED and deliberately human-checkable against a
// printed DX7 algorithm chart: `carriers` are operator NUMBERS, `edges` are
// "src→dst" operator numbers, and `fb` is "src→dst" for the feedback loop
// (`6→6` = the familiar op6 self-loop). The test converts to the module's
// 0-indexed representation, so a typo here fails rather than silently
// re-encoding the bug.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { DX7_ALGORITHMS, getAlgorithm, type DX7AlgorithmDef } from './dx7-algorithms';

interface ChartRow {
  num: number;
  carriers: number[];    // operator NUMBERS 1..6
  edges: string[];       // "src→dst", operator NUMBERS
  fb: string;            // "src→dst", operator NUMBERS
}

const CHART: ChartRow[] = [
  { num: 1,  carriers: [1, 3],          edges: ['2→1', '6→5', '5→4', '4→3'],               fb: '6→6' },
  { num: 2,  carriers: [1, 3],          edges: ['2→1', '6→5', '5→4', '4→3'],               fb: '2→2' },
  { num: 3,  carriers: [1, 4],          edges: ['2→1', '3→2', '6→5', '5→4'],               fb: '6→6' },
  { num: 4,  carriers: [1, 4],          edges: ['2→1', '3→2', '6→5', '5→4'],               fb: '4→6' },
  { num: 5,  carriers: [1, 3, 5],       edges: ['2→1', '4→3', '6→5'],                      fb: '6→6' },
  { num: 6,  carriers: [1, 3, 5],       edges: ['2→1', '4→3', '6→5'],                      fb: '5→6' },
  { num: 7,  carriers: [1, 3],          edges: ['2→1', '4→3', '5→3', '6→5'],               fb: '6→6' },
  { num: 8,  carriers: [1, 3],          edges: ['2→1', '4→3', '5→3', '6→5'],               fb: '4→4' },
  { num: 9,  carriers: [1, 3],          edges: ['2→1', '4→3', '5→3', '6→5'],               fb: '2→2' },
  { num: 10, carriers: [1, 4],          edges: ['2→1', '3→2', '5→4', '6→4'],               fb: '3→3' },
  { num: 11, carriers: [1, 4],          edges: ['2→1', '3→2', '5→4', '6→4'],               fb: '6→6' },
  { num: 12, carriers: [1, 3],          edges: ['2→1', '4→3', '5→3', '6→3'],               fb: '2→2' },
  { num: 13, carriers: [1, 3],          edges: ['2→1', '4→3', '5→3', '6→3'],               fb: '6→6' },
  { num: 14, carriers: [1, 3],          edges: ['2→1', '4→3', '5→4', '6→4'],               fb: '6→6' },
  { num: 15, carriers: [1, 3],          edges: ['2→1', '4→3', '5→4', '6→4'],               fb: '2→2' },
  { num: 16, carriers: [1],             edges: ['2→1', '3→1', '5→1', '4→3', '6→5'],        fb: '6→6' },
  { num: 17, carriers: [1],             edges: ['2→1', '3→1', '5→1', '4→3', '6→5'],        fb: '2→2' },
  { num: 18, carriers: [1],             edges: ['2→1', '3→1', '4→1', '5→4', '6→5'],        fb: '3→3' },
  { num: 19, carriers: [1, 4, 5],       edges: ['2→1', '3→2', '6→4', '6→5'],               fb: '6→6' },
  { num: 20, carriers: [1, 2, 4],       edges: ['3→1', '3→2', '5→4', '6→4'],               fb: '3→3' },
  { num: 21, carriers: [1, 2, 4, 5],    edges: ['3→1', '3→2', '6→4', '6→5'],               fb: '3→3' },
  { num: 22, carriers: [1, 3, 4, 5],    edges: ['2→1', '6→3', '6→4', '6→5'],               fb: '6→6' },
  { num: 23, carriers: [1, 2, 4, 5],    edges: ['3→2', '6→4', '6→5'],                      fb: '6→6' },
  { num: 24, carriers: [1, 2, 3, 4, 5], edges: ['6→3', '6→4', '6→5'],                      fb: '6→6' },
  { num: 25, carriers: [1, 2, 3, 4, 5], edges: ['6→4', '6→5'],                             fb: '6→6' },
  { num: 26, carriers: [1, 2, 4],       edges: ['3→2', '5→4', '6→4'],                      fb: '6→6' },
  { num: 27, carriers: [1, 2, 4],       edges: ['3→2', '5→4', '6→4'],                      fb: '3→3' },
  { num: 28, carriers: [1, 3, 6],       edges: ['2→1', '4→3', '5→4'],                      fb: '5→5' },
  { num: 29, carriers: [1, 2, 3, 5],    edges: ['4→3', '6→5'],                             fb: '6→6' },
  { num: 30, carriers: [1, 2, 3, 6],    edges: ['4→3', '5→4'],                             fb: '5→5' },
  { num: 31, carriers: [1, 2, 3, 4, 5], edges: ['6→5'],                                    fb: '6→6' },
  { num: 32, carriers: [1, 2, 3, 4, 5, 6], edges: [],                                      fb: '6→6' },
];

/** "6→5" → [5, 4] (0-indexed src, dst). */
function parseEdge(e: string): [number, number] {
  const m = /^(\d)→(\d)$/.exec(e);
  if (!m) throw new Error(`bad edge "${e}"`);
  return [Number(m[1]) - 1, Number(m[2]) - 1];
}

/** Expand a ChartRow into the module's 0-indexed shape. */
function expand(row: ChartRow): DX7AlgorithmDef {
  const modSrcs: number[][] = [[], [], [], [], [], []];
  for (const e of row.edges) {
    const [src, dst] = parseEdge(e);
    modSrcs[dst]!.push(src);
  }
  for (const l of modSrcs) l.sort((a, b) => a - b);
  const [from, to] = parseEdge(row.fb);
  return {
    num: row.num,
    carriers: row.carriers.map((c) => c - 1),
    modSrcs,
    feedback: { from, to },
  };
}

/** Canonical, order-insensitive serialization of one algorithm row. */
function fingerprint(a: DX7AlgorithmDef): string {
  const car = [...a.carriers].sort((x, y) => x - y).join(',');
  const mods = a.modSrcs
    .map((l) => [...l].sort((x, y) => x - y).join('.'))
    .join('|');
  return `c[${car}] m[${mods}] fb[${a.feedback.from}>${a.feedback.to}]`;
}

describe('DX7_ALGORITHMS — golden pin against the real DX7 chart', () => {
  it('has exactly 32 entries, numbered 1..32 in order', () => {
    expect(DX7_ALGORITHMS).toHaveLength(32);
    expect(DX7_ALGORITHMS.map((a) => a.num)).toEqual(
      Array.from({ length: 32 }, (_, i) => i + 1),
    );
  });

  it.each(CHART.map((r) => [r.num, r] as const))(
    'algorithm %i matches the chart (carriers, routing and feedback)',
    (num, row) => {
      const actual = getAlgorithm(num)!;
      const expected = expand(row);
      expect(fingerprint(actual), `alg ${num}`).toBe(fingerprint(expected));
    },
  );
});

describe('DX7_ALGORITHMS — all 32 rows are topologically DISTINCT', () => {
  // THE regression gate for this bug class. With feedback hardcoded to op6 and
  // 14 wrong modSrcs rows, this table collapsed to 21 distinct topologies:
  // algorithms 1/2, 3/4, 5/6, 7/8/9, 10/11, 12/13, 14/15, 16/17, 24/25 and
  // 26/27 were byte-identical, so the picker would draw two different diagrams
  // that sound the same. On the real DX7 no two algorithms are the same
  // instrument.
  it('no two algorithms share a (carriers, modSrcs, feedback) fingerprint', () => {
    const seen = new Map<string, number>();
    const dupes: string[] = [];
    for (const a of DX7_ALGORITHMS) {
      const fp = fingerprint(a);
      const prev = seen.get(fp);
      if (prev !== undefined) dupes.push(`alg ${a.num} is identical to alg ${prev}: ${fp}`);
      else seen.set(fp, a.num);
    }
    expect(dupes, dupes.join('\n')).toEqual([]);
    expect(seen.size, 'distinct algorithm topologies').toBe(32);
  });

  it('the routing alone is NOT enough — feedback placement is load-bearing', () => {
    // Documents WHY the fingerprint must include feedback: 10 sibling pairs on
    // the real DX7 share their carriers+modSrcs and differ only in where the
    // feedback loop sits. Drop feedback from the key and 32 collapses to 22.
    const routingOnly = new Set(
      DX7_ALGORITHMS.map((a) => fingerprint(a).replace(/ fb\[.*\]$/, '')),
    );
    expect(routingOnly.size).toBe(22);
  });
});

describe('DX7_ALGORITHMS — structural invariants', () => {
  it('every algorithm has 6 modSrcs slots and at least one carrier', () => {
    for (const a of DX7_ALGORITHMS) {
      expect(a.modSrcs, `alg ${a.num}.modSrcs`).toHaveLength(6);
      expect(a.carriers.length, `alg ${a.num}.carriers`).toBeGreaterThan(0);
    }
  });

  it('all carrier / modulator / feedback indices are in 0..5', () => {
    for (const a of DX7_ALGORITHMS) {
      for (const c of a.carriers) expect(c, `alg ${a.num} carrier`).toBeGreaterThanOrEqual(0);
      for (const c of a.carriers) expect(c, `alg ${a.num} carrier`).toBeLessThanOrEqual(5);
      for (const l of a.modSrcs) {
        for (const m of l) {
          expect(m, `alg ${a.num} modSrc`).toBeGreaterThanOrEqual(0);
          expect(m, `alg ${a.num} modSrc`).toBeLessThanOrEqual(5);
        }
      }
      for (const k of [a.feedback.from, a.feedback.to]) {
        expect(k, `alg ${a.num} feedback`).toBeGreaterThanOrEqual(0);
        expect(k, `alg ${a.num} feedback`).toBeLessThanOrEqual(5);
      }
    }
  });

  it('no operator appears in its own modSrcs list — feedback lives in `feedback`', () => {
    // The engines inject the feedback memory keyed on `feedback.to` ONLY. A
    // self-entry smuggled back into modSrcs would double-count (or, worse,
    // read the raw op output instead of the averaged loop memory).
    for (const a of DX7_ALGORITHMS) {
      for (let op = 0; op < 6; op++) {
        expect(a.modSrcs[op], `alg ${a.num} op${op + 1} self-modSrc`).not.toContain(op);
      }
    }
  });

  it('no operator is both a carrier and absent from the graph in a way that strands it', () => {
    // Every op either reaches the output directly (carrier) or modulates
    // something. A stranded op would be an inaudible, un-diagrammable block.
    for (const a of DX7_ALGORITHMS) {
      const modulates = new Set<number>();
      for (const l of a.modSrcs) for (const m of l) modulates.add(m);
      for (let op = 0; op < 6; op++) {
        const used = a.carriers.includes(op) || modulates.has(op) || a.feedback.from === op;
        expect(used, `alg ${a.num} op${op + 1} is stranded`).toBe(true);
      }
    }
  });

  it('modulation flows strictly downward — an op is only fed by higher-numbered ops', () => {
    // A documented DX7 hardware constraint: the modulation pipeline processes
    // operators 6 → 1, so an operator can only be modulated by one with a
    // HIGHER number. The single exception is the feedback register, which is
    // buffered and therefore may travel upward (algorithms 4 and 6).
    for (const a of DX7_ALGORITHMS) {
      for (let op = 0; op < 6; op++) {
        for (const m of a.modSrcs[op]!) {
          expect(m, `alg ${a.num}: op${m + 1} → op${op + 1}`).toBeGreaterThan(op);
        }
      }
    }
  });

  it('getAlgorithm rejects out-of-range', () => {
    expect(getAlgorithm(0)).toBeUndefined();
    expect(getAlgorithm(33)).toBeUndefined();
    expect(getAlgorithm(2.5)).toBeUndefined();
  });
});

describe('DX7_ALGORITHMS — the packages/dsp/src/dx7.ts worklet MIRROR', () => {
  // `packages/dsp/src/dx7.ts` declares this file a SYNC PARTNER and carries its
  // own copy of the tables (the worklet bundle can't import from the web
  // workspace). That mirror was previously unguarded — nothing would have
  // noticed a routing fix landing on one side only, and the ART scenarios run
  // against the WEB renderer, so the worklet could drift silently. Parse the
  // worklet's literals off disk and require them to agree, exactly.
  const WORKLET = fileURLToPath(
    new URL('../../../../dsp/src/dx7.ts', import.meta.url),
  );
  const src = readFileSync(WORKLET, 'utf8');

  /** Pull `const <name>...= [ ... ];` and JSON-parse the (numeric-only) body. */
  function parseTable<T>(name: string): T {
    const start = src.indexOf(`const ${name}`);
    expect(start, `${name} not found in ${WORKLET}`).toBeGreaterThan(-1);
    // Skip the type annotation (`: number[][]`) — the literal starts after `=`.
    const eq = src.indexOf('=', start);
    const open = src.indexOf('[', eq);
    const close = src.indexOf('\n];', open);
    expect(close, `${name} closing bracket not found`).toBeGreaterThan(open);
    const body = src
      .slice(open, close + 2)
      .replace(/\/\*[\s\S]*?\*\//g, '')   // strip the /* 12 */ row markers
      .replace(/\/\/[^\n]*/g, '')         // strip trailing line comments
      .replace(/,(\s*[\]}])/g, '$1');     // strip trailing commas
    return JSON.parse(body) as T;
  }

  it('CARRIER_TABLE / MOD_TABLE / FEEDBACK_TABLE match the web table exactly', () => {
    const carriers = parseTable<number[][]>('CARRIER_TABLE');
    const mods = parseTable<number[][][]>('MOD_TABLE');
    const fbs = parseTable<[number, number][]>('FEEDBACK_TABLE');
    expect(carriers).toHaveLength(32);
    expect(mods).toHaveLength(32);
    expect(fbs).toHaveLength(32);
    const worklet: DX7AlgorithmDef[] = DX7_ALGORITHMS.map((_, i) => ({
      num: i + 1,
      carriers: carriers[i]!,
      modSrcs: mods[i]!,
      feedback: { from: fbs[i]![0], to: fbs[i]![1] },
    }));
    expect(worklet.map(fingerprint)).toEqual(DX7_ALGORITHMS.map(fingerprint));
  });

  it('the worklet no longer carries a hardcoded feedback operator', () => {
    // The bug: `const FEEDBACK_OP_DEFAULT = 5` applied to all 32 algorithms.
    expect(src).not.toContain('FEEDBACK_OP_DEFAULT');
    // And neither engine may source the feedback memory from a fixed op6.
    expect(src).not.toMatch(/fbMem\s*=\s*\(v\.fbMem\s*\+\s*v\.opOut\[5\]/);
  });
});

describe('DX7_ALGORITHMS — feedback placement', () => {
  // The placement table, restated as a grouping so a future edit that drags an
  // algorithm into the wrong bucket reads as an obvious diff.
  const SELF_LOOP: Record<number, number[]> = {
    6: [1, 3, 5, 7, 11, 13, 14, 16, 19, 22, 23, 24, 25, 26, 29, 31, 32],
    2: [2, 9, 12, 15, 17],
    3: [10, 18, 20, 21, 27],
    4: [8],
    5: [28, 30],
  };
  const MULTI_OP: Record<number, [number, number]> = {
    // alg → [from, to], 1-indexed. The loop wraps a whole operator stack.
    4: [4, 6],
    6: [5, 6],
  };

  it('every algorithm is in exactly one feedback bucket', () => {
    const claimed = [
      ...Object.values(SELF_LOOP).flat(),
      ...Object.keys(MULTI_OP).map(Number),
    ].sort((a, b) => a - b);
    expect(claimed).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
  });

  it.each(Object.entries(SELF_LOOP))('op%s carries the self-loop for its algorithms', (opStr, algs) => {
    const op = Number(opStr) - 1;
    for (const n of algs) {
      const a = getAlgorithm(n)!;
      expect(a.feedback, `alg ${n} feedback`).toEqual({ from: op, to: op });
    }
  });

  it.each(Object.entries(MULTI_OP))('algorithm %s uses a multi-operator loop', (numStr, pair) => {
    const a = getAlgorithm(Number(numStr))!;
    expect(a.feedback.from, `alg ${numStr} feedback source`).toBe(pair[0] - 1);
    expect(a.feedback.to, `alg ${numStr} feedback destination`).toBe(pair[1] - 1);
    expect(a.feedback.from).not.toBe(a.feedback.to);
  });

  it('exactly 2 algorithms use a multi-operator loop; the other 30 self-loop', () => {
    const multi = DX7_ALGORITHMS.filter((a) => a.feedback.from !== a.feedback.to);
    expect(multi.map((a) => a.num)).toEqual([4, 6]);
  });
});
