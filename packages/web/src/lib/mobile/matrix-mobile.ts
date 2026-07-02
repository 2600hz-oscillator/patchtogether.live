// packages/web/src/lib/mobile/matrix-mobile.ts
//
// PURE helpers for the mobile FROM→TO matrix (spec §3 PATCH):
//   - output/input jack filtering over the shared jacksForDef core
//     (the desktop matrix shows ALL×ALL jacks; the mobile grid pre-filters
//     to outputs × inputs — ~half the desktop grid is dead cells),
//   - stereo-pair ROW combining (ch{N}L/R, ret{N}L/R, audioOut L/R render
//     as ONE "L+R" row with an expander),
//   - the stereo tap plan: mono source → double-patch both sides;
//     recognizable stereo-pair source → L→L / R→R,
//   - MIXMSTRS TO-density sectioning (CH1…CH6 · RET · MASTER-CV) with the
//     per-section audio/cv split (cv collapsed behind "+ cv").
//
// No Svelte, no Yjs — unit-tested in isolation.

import { jacksForDef, type Jack } from '$lib/ui/matrixmix-grid';
import { canConnectToPort } from '$lib/graph/types';

export interface DefLike {
  inputs: readonly import('$lib/graph/types').PortDef[];
  outputs: readonly import('$lib/graph/types').PortDef[];
  stereoPairs?: readonly (readonly [string, string])[];
}

export function outputJacks(def: DefLike | undefined): Jack[] {
  if (!def) return [];
  return jacksForDef(def).filter((j) => j.direction === 'output');
}

export function inputJacks(def: DefLike | undefined): Jack[] {
  if (!def) return [];
  return jacksForDef(def).filter((j) => j.direction === 'input');
}

// ---------------- Stereo-pair rows ----------------

export type InputRow =
  | { kind: 'single'; jack: Jack }
  | { kind: 'pair'; label: string; left: Jack; right: Jack };

/** Detect L/R sibling ids: declared def.stereoPairs first (mixmstrs), then
 *  the `<base>L`/`<base>R` naming convention, then the bare audioOut L/R. */
function pairKey(def: DefLike | undefined, portId: string): { base: string; side: 'L' | 'R' } | null {
  if (def?.stereoPairs) {
    for (const [l, r] of def.stereoPairs) {
      if (portId === l) return { base: l.replace(/L$/, ''), side: 'L' };
      if (portId === r) return { base: r.replace(/R$/, ''), side: 'R' };
    }
  }
  if (/^(.+)L$/.test(portId)) return { base: portId.slice(0, -1), side: 'L' };
  if (/^(.+)R$/.test(portId)) return { base: portId.slice(0, -1), side: 'R' };
  if (portId === 'L') return { base: '', side: 'L' };
  if (portId === 'R') return { base: '', side: 'R' };
  return null;
}

/** Combine a def's INPUT jacks into rows, merging complete L/R pairs. */
export function buildInputRows(def: DefLike | undefined, jacks?: Jack[]): InputRow[] {
  const list = jacks ?? inputJacks(def);
  const rows: InputRow[] = [];
  const consumed = new Set<string>();
  for (const jack of list) {
    if (consumed.has(jack.portId)) continue;
    const key = pairKey(def, jack.portId);
    if (key && key.side === 'L') {
      const rightId = key.base === '' ? 'R' : `${key.base}R`;
      const right = list.find((j) => j.portId === rightId && j.type === jack.type);
      if (right) {
        consumed.add(jack.portId);
        consumed.add(right.portId);
        rows.push({ kind: 'pair', label: key.base === '' ? 'L+R' : `${key.base} L+R`, left: jack, right });
        continue;
      }
    }
    consumed.add(jack.portId);
    rows.push({ kind: 'single', jack });
  }
  return rows;
}

// ---------------- Stereo tap plan ----------------

/** Output ids that form recognizable stereo pairs on the FROM side —
 *  `masterL/R`, `send{N}L/R` (mixmstrs), `audio_l/audio_r` + `audio_l_out/
 *  audio_r_out` conventions (audioIn & friends). */
export function stereoSiblingOutput(outputs: readonly Jack[], portId: string): Jack | null {
  const conventions: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
    [/^(.*)L$/, (m) => `${m[1]}R`],
    [/^(.*)_l$/, (m) => `${m[1]}_r`],
    [/^(.*)_l_out$/, (m) => `${m[1]}_r_out`],
  ];
  for (const [re, sib] of conventions) {
    const m = portId.match(re);
    if (!m) continue;
    const sibling = outputs.find((j) => j.portId === sib(m));
    if (sibling) return sibling;
  }
  return null;
}

export interface PairPatchLeg {
  sourcePortId: string;
  targetPortId: string;
}

/**
 * Plan the edges a tap on a PAIR row creates for a given FROM output:
 *   - the output has a recognizable R sibling → L→L, R→R (true stereo),
 *   - otherwise (mono source) → the SAME output into BOTH sides.
 * Type legality is the caller's job (each leg still goes through
 * createMatrixEdge's shared validateEdge).
 */
export function planPairPatch(
  fromOutputs: readonly Jack[],
  sourcePortId: string,
  row: Extract<InputRow, { kind: 'pair' }>,
): PairPatchLeg[] {
  const sibling = stereoSiblingOutput(fromOutputs, sourcePortId);
  if (sibling) {
    return [
      { sourcePortId, targetPortId: row.left.portId },
      { sourcePortId: sibling.portId, targetPortId: row.right.portId },
    ];
  }
  return [
    { sourcePortId, targetPortId: row.left.portId },
    { sourcePortId, targetPortId: row.right.portId },
  ];
}

// ---------------- Row filtering (hide incompatible) ----------------

/** Can ANY of the FROM module's outputs legally reach this input row? */
export function rowCompatible(row: InputRow, fromOutputs: readonly Jack[]): boolean {
  const inputs = row.kind === 'single' ? [row.jack] : [row.left, row.right];
  for (const out of fromOutputs) {
    for (const inp of inputs) {
      if (canConnectToPort(out.type, { type: inp.type, accepts: inp.accepts })) return true;
    }
  }
  return false;
}

export function splitRowsByCompatibility(
  rows: InputRow[],
  fromOutputs: readonly Jack[],
): { compatible: InputRow[]; hidden: number } {
  const compatible = rows.filter((r) => rowCompatible(r, fromOutputs));
  return { compatible, hidden: rows.length - compatible.length };
}

// ---------------- MIXMSTRS sectioning ----------------

export type MixSection = 'ch1' | 'ch2' | 'ch3' | 'ch4' | 'ch5' | 'ch6' | 'ret' | 'master-cv';

export const MIX_SECTIONS: readonly { id: MixSection; label: string }[] = [
  { id: 'ch1', label: 'CH1' },
  { id: 'ch2', label: 'CH2' },
  { id: 'ch3', label: 'CH3' },
  { id: 'ch4', label: 'CH4' },
  { id: 'ch5', label: 'CH5' },
  { id: 'ch6', label: 'CH6' },
  { id: 'ret', label: 'RET' },
  { id: 'master-cv', label: 'MASTER-CV' },
];

/** Which section a mixmstrs INPUT port belongs to. ch{N}L/R + every
 *  ch{N}_* CV + comp{N} → chN; ret{1,2}L/R → ret; master_volume → master-cv. */
export function mixmstrsSection(portId: string): MixSection {
  let m = portId.match(/^ch([1-6])/);
  if (m) return `ch${m[1]}` as MixSection;
  m = portId.match(/^comp([1-6])$/);
  if (m) return `ch${m[1]}` as MixSection;
  if (/^ret[12][LR]$/.test(portId)) return 'ret';
  return 'master-cv';
}

/** Is this mixmstrs input a CV input (collapsed behind "+ cv")? The audio
 *  jacks are the ch/ret L/R ports; everything else is a paramTarget CV. */
export function isMixmstrsCvInput(jack: Jack): boolean {
  return jack.type === 'cv';
}

export interface SectionRows {
  audio: InputRow[];
  cv: InputRow[];
}

/** Scope mixmstrs input rows to ONE section, split audio vs cv. */
export function mixmstrsSectionRows(rows: InputRow[], section: MixSection): SectionRows {
  const audio: InputRow[] = [];
  const cv: InputRow[] = [];
  for (const row of rows) {
    const jack = row.kind === 'single' ? row.jack : row.left;
    if (mixmstrsSection(jack.portId) !== section) continue;
    if (row.kind === 'single' && isMixmstrsCvInput(row.jack)) cv.push(row);
    else audio.push(row);
  }
  return { audio, cv };
}
