// packages/web/src/lib/video/vfpga/cells/index.ts
//
// The CELL LIBRARY registry — every primitive cell, GLOB-collected from
// `cells/*.ts` (Vite `import.meta.glob`, eager) keyed by (type, op). Adding a
// tile op is a drop-in `cells/<op>.ts` exporting a `VfpgaCell`; NO edit here, so
// concurrent cell PRs never collide on a shared index (same discipline as the
// specs registry). P&R looks a tile's (type, op) up here; the validation gate
// rejects a fabric that references a (type, op) with no cell.

import type { VfpgaTileType } from '$lib/video/vfpga/types';
import type { VfpgaCell } from './types';

const CELL_MODULES = import.meta.glob<Record<string, unknown>>(
  ['./*.ts', '!./*.test.ts', '!./types.ts', '!./index.ts'],
  { eager: true },
);

/** Does this exported value look like a VfpgaCell? Requires a string `type`,
 *  a string `op`, an `inputs` array, and a `kernel` function. */
function looksLikeCell(v: unknown): v is VfpgaCell {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.type === 'string' &&
    typeof o.op === 'string' &&
    Array.isArray(o.inputs) &&
    typeof o.kernel === 'function'
  );
}

/** `${type}:${op}` lookup key. */
const cellKey = (type: VfpgaTileType, op: string): string => `${type}:${op}`;

function collect(): Map<string, VfpgaCell> {
  const byKey = new Map<string, VfpgaCell>();
  for (const mod of Object.values(CELL_MODULES)) {
    for (const [exportName, value] of Object.entries(mod)) {
      if (!exportName.endsWith('Cell')) continue;
      if (!looksLikeCell(value)) continue;
      const key = cellKey(value.type, value.op);
      if (!byKey.has(key)) byKey.set(key, value);
    }
  }
  return byKey;
}

let cache: Map<string, VfpgaCell> | null = null;

function cells(): Map<string, VfpgaCell> {
  if (!cache) cache = collect();
  return cache;
}

/** Look up a cell by tile type + op, or undefined if no such cell exists. */
export function getCell(type: VfpgaTileType, op: string): VfpgaCell | undefined {
  return cells().get(cellKey(type, op));
}

/** Is there a cell registered for this (type, op)? (validation gate). */
export function hasCell(type: VfpgaTileType, op: string): boolean {
  return cells().has(cellKey(type, op));
}

/** Every registered cell (sorted by type:op for a deterministic docs order). */
export function listCells(): VfpgaCell[] {
  return [...cells().values()].sort((a, b) =>
    cellKey(a.type, a.op).localeCompare(cellKey(b.type, b.op)),
  );
}
