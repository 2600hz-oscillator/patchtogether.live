// packages/web/src/lib/video/vfpga/registry.ts
//
// The VFPGA catalog — every bundled `.vfpga` spec, collected GLOB-DRIVEN from
// `$lib/video/vfpga/specs/*.ts` at build time (Vite `import.meta.glob`). Adding
// a VFPGA needs NO edit here: drop `specs/<id>.ts` exporting a `<id>Spec`
// (VfpgaSpec) and it's picked up automatically — zero hand-maintained index, so
// no shared-file merge conflicts across concurrent VFPGA PRs.
//
// This registry feeds BOTH:
//   - the host card's "load preset…" menu (one option per spec), and
//   - the docs VFPGA index (/docs/modules/vfpga-runner/) + per-spec subpages.

import type { VfpgaSpec } from './types';

const SPEC_MODULES = import.meta.glob<Record<string, unknown>>(
  ['./specs/*.ts', '!./specs/*.test.ts'],
  { eager: true },
);

/** Does this exported value look like a VfpgaSpec? Requires a string `id`,
 *  a string `docSlug`, and EITHER a hand-authored `effect.outputs.vout1`
 *  (the legacy render graph) OR a `fabric.outputs.vout1` (the P&R'd bitstream —
 *  design §2). Helper exports that lack those are ignored. */
function looksLikeVfpgaSpec(v: unknown): v is VfpgaSpec {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string') return false;
  if (typeof o.docSlug !== 'string') return false;
  const effect = o.effect as { outputs?: { vout1?: unknown } } | undefined;
  const hasEffect = !!effect && !!effect.outputs && typeof effect.outputs.vout1 === 'string';
  const fabric = o.fabric as { outputs?: { vout1?: unknown } } | undefined;
  const hasFabric = !!fabric && !!fabric.outputs && typeof fabric.outputs.vout1 === 'string';
  return hasEffect || hasFabric;
}

/** Collect every bundled VFPGA spec, deduped by id, sorted by id for a
 *  deterministic menu + docs order. */
export function collectVfpgaSpecs(): VfpgaSpec[] {
  const byId = new Map<string, VfpgaSpec>();
  for (const mod of Object.values(SPEC_MODULES)) {
    for (const [exportName, value] of Object.entries(mod)) {
      if (!exportName.endsWith('Spec')) continue;
      if (!looksLikeVfpgaSpec(value)) continue;
      if (!byId.has(value.id)) byId.set(value.id, value);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

let cache: VfpgaSpec[] | null = null;

/** The full VFPGA catalog (cached). */
export function listVfpgaSpecs(): VfpgaSpec[] {
  if (!cache) cache = collectVfpgaSpecs();
  return cache;
}

/** Look up one VFPGA spec by id, or undefined. */
export function getVfpgaSpec(id: string): VfpgaSpec | undefined {
  return listVfpgaSpecs().find((s) => s.id === id);
}

/** The default VFPGA loaded on a fresh host spawn (the only one v1 ships). */
export const DEFAULT_VFPGA_ID = 'smpte-bars';
