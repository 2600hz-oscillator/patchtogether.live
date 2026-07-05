// packages/web/src/lib/docs/contract-signature.ts
//
// The DETERMINISTIC contract projection for the living-docs drift gate
// (.myrobots/plans/living-docs-drift-2026-06-24.md). This is the "what is
// pinned" layer — the analog of ART's `moduleSourceSha` and VRT's baseline
// image, applied to a module's I/O CONTRACT instead of audio/pixels.
//
// It projects each registered module def to a CANONICAL, whitelisted, fully
// sorted text form (the API-Extractor `.api.md` golden pattern). The committed
// golden lives at `contract-lock.txt`; the `contract-lock.test.ts` gate
// regenerates this text from the LIVE registry and string-compares — any port
// added/removed/renamed/retyped, any param range/curve/default change, any
// stereo/expose/control-family change produces a readable line diff and fails
// CI until a human re-pins (`task docs:accept`) or recognizes a bug.
//
// WHY a whitelisted projection (never the whole def): adding a `factory`,
// `migrate`, `card`, `palette`, or a cosmetic `label`/`category` field must NOT
// churn the contract — only the I/O + persistence-shaping surface is the
// contract. WHY readable text (not a sha): `git diff contract-lock.txt` IS the
// review surface (unlike pixels, you can read it), and one-line-per-element
// keeps merges line-granular (the Roslyn PublicAPI.txt lesson).
//
// PURE + browser-safe: no node:crypto, no fs — just string building, so it is
// importable from anywhere. The gate test owns the fs read/write + the
// side-effect registry imports.

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import type { ControlFamily, ModuleDocs } from '$lib/graph/types';

/** The minimal structural shape the projection reads off any registered def
 *  (audio / video / meta). Everything optional so each domain's def shape
 *  satisfies it; unknown extra fields are ignored (whitelist by construction). */
interface ContractDefLike {
  type: string;
  domain: string;
  inputs?: readonly ContractPortLike[];
  outputs?: readonly ContractPortLike[];
  params?: readonly ContractParamLike[];
  stereoPairs?: readonly (readonly [string, string])[];
  maxInstances?: number;
  exposesSequence?: boolean;
  undeletable?: boolean;
  ownerOnly?: boolean;
  exposableControls?: readonly { id: string }[];
  controlFamilies?: readonly ControlFamily[];
}
interface ContractPortLike {
  id: string;
  type: string;
  paramTarget?: string;
  cvScale?: { mode: string; depth?: number };
  accepts?: readonly string[];
  edge?: 'trigger' | 'gate';
  adoptsUpstreamFrom?: string;
}
interface ContractParamLike {
  id: string;
  defaultValue: number;
  min: number;
  max: number;
  curve: string;
  units?: string;
}

const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
const num = (n: number): string => String(n);

/** One INPUT/OUTPUT port → a canonical line body (sans the `<type> in/out`
 *  prefix). Fields appear in a fixed order; absent fields are omitted. */
function portLine(p: ContractPortLike): string {
  const parts = [p.id, p.type];
  if (p.paramTarget) parts.push(`param=${p.paramTarget}`);
  if (p.cvScale) {
    parts.push(`cvScale=${p.cvScale.mode}${p.cvScale.depth !== undefined ? `:${num(p.cvScale.depth)}` : ''}`);
  }
  if (p.accepts && p.accepts.length) parts.push(`accepts=${[...p.accepts].sort().join(',')}`);
  if (p.edge) parts.push(`edge=${p.edge}`);
  if (p.adoptsUpstreamFrom) parts.push(`adopts=${p.adoptsUpstreamFrom}`);
  return parts.join(' ');
}

/** All canonical lines for ONE module, deterministically ordered. Each line is
 *  prefixed with the module `type` so the golden greps + merges line-granular. */
export function serializeModuleContract(def: ContractDefLike): string[] {
  const t = def.type;
  const lines: string[] = [];

  // meta line: domain + persistence-shaping flags (sorted flag order).
  const meta = [`domain=${def.domain}`];
  if (def.maxInstances !== undefined) meta.push(`maxInstances=${num(def.maxInstances)}`);
  if (def.exposesSequence) meta.push('exposesSequence');
  if (def.undeletable) meta.push('undeletable');
  if (def.ownerOnly) meta.push('ownerOnly');
  lines.push(`${t} meta ${meta.join(' ')}`);

  for (const p of [...(def.inputs ?? [])].sort(byId)) lines.push(`${t} in ${portLine(p)}`);
  for (const p of [...(def.outputs ?? [])].sort(byId)) lines.push(`${t} out ${portLine(p)}`);
  for (const p of [...(def.params ?? [])].sort(byId)) {
    const unit = p.units ? ` unit=${p.units}` : '';
    lines.push(`${t} param ${p.id} ${num(p.min)}..${num(p.max)} ${p.curve} default=${num(p.defaultValue)}${unit}`);
  }
  // stereo pairs: order WITHIN a pair is meaningful (L,R); sort the LIST.
  const pairs = [...(def.stereoPairs ?? [])].map(([l, r]) => `${l}+${r}`).sort();
  for (const s of pairs) lines.push(`${t} stereo ${s}`);
  for (const c of [...(def.exposableControls ?? [])].sort(byId)) lines.push(`${t} expose ${c.id}`);
  for (const f of [...(def.controlFamilies ?? [])].sort(byId)) {
    lines.push(
      `${t} family ${f.id} kind=${f.kind} prefix=${f.testidPrefix}${f.countParam ? ` count=${f.countParam}` : ''}`,
    );
  }
  return lines;
}

/** Every registered def (audio + video + meta), sorted by type. Requires the
 *  module barrels to have been side-effect-imported (the gate test does this). */
export function getContractDefs(): ContractDefLike[] {
  const all = [
    ...(listModuleDefs() as unknown as ContractDefLike[]),
    ...(listVideoModuleDefs() as unknown as ContractDefLike[]),
    ...(listMetaModuleDefs() as unknown as ContractDefLike[]),
  ];
  return all.slice().sort((a, b) => a.type.localeCompare(b.type));
}

const HEADER = [
  '# contract-lock.txt — DETERMINISTIC module I/O contract golden (living-docs gate).',
  '# Generated; DO NOT hand-edit. Regenerate after an INTENTIONAL contract change:',
  '#   flox activate -- task docs:accept            (all modules)',
  '#   flox activate -- task docs:accept -- <type>  (one module)',
  '# A diff here means a module contract changed: re-author the doc + re-pin, OR',
  '# recognize it as a bug/side-effect. The docs-drift gate fails on any mismatch.',
].join('\n');

/** The full committed golden text for the whole registry. Deterministic +
 *  trailing-newline-terminated so the file is POSIX-clean. */
export function serializeContractLock(defs: ContractDefLike[] = getContractDefs()): string {
  const body = defs.flatMap((d) => serializeModuleContract(d)).join('\n');
  return `${HEADER}\n${body}\n`;
}

// ---- AUTHORED docs → committed render module (prerender-safe) ----
// The doc page prerenders and CANNOT import the live registry (worklet ?url /
// .wasm in the factories break SSR), so it cannot read `def.docs` directly.
// We emit the authored docs into a plain committed data module the page CAN
// import. Regenerated by `task docs:accept`, freshness-gated by contract-lock.test.

/** Canonicalize one module's docs: keep only present sections, sort sub-keys
 *  so the emitted module is deterministic regardless of authoring order. */
function canonDocs(docs: ModuleDocs): ModuleDocs {
  const out: ModuleDocs = {};
  if (docs.explanation) out.explanation = docs.explanation;
  for (const section of ['inputs', 'outputs', 'controls'] as const) {
    const m = docs[section];
    if (m && Object.keys(m).length) {
      const sorted: Record<string, string> = {};
      for (const k of Object.keys(m).sort()) sorted[k] = m[k];
      out[section] = sorted;
    }
  }
  return out;
}

/** Sorted map of every authored module's docs (defs without `docs` omitted). */
export function getDocsByType(): Record<string, ModuleDocs> {
  const all = [
    ...(listModuleDefs() as unknown as { type: string; docs?: ModuleDocs }[]),
    ...(listVideoModuleDefs() as unknown as { type: string; docs?: ModuleDocs }[]),
    ...(listMetaModuleDefs() as unknown as { type: string; docs?: ModuleDocs }[]),
  ].slice().sort((a, b) => a.type.localeCompare(b.type));
  const out: Record<string, ModuleDocs> = {};
  for (const def of all) if (def.docs) out[def.type] = canonDocs(def.docs);
  return out;
}

/** The committed `module-docs.generated.ts` content (a plain data module the
 *  prerendered doc page imports). */
export function serializeModuleDocsModule(map: Record<string, ModuleDocs> = getDocsByType()): string {
  return (
    "// GENERATED by `task docs:accept` — DO NOT EDIT.\n" +
    "// Source of truth: each module def's co-located `docs` field. The prerendered\n" +
    '// doc page imports this because it cannot import the live registry. Freshness is\n' +
    '// gated by contract-lock.test.ts (a stale copy fails CI).\n' +
    "import type { ModuleDocs } from '$lib/graph/types';\n\n" +
    `export const MODULE_DOCS: Record<string, ModuleDocs> = ${JSON.stringify(map, null, 2)};\n`
  );
}
