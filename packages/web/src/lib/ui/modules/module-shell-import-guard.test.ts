// packages/web/src/lib/ui/modules/module-shell-import-guard.test.ts
//
// THE MODULE-SHELL IMPORT GUARD (#1512) — deny by default.
//
// ModuleShell is the ONE shared renderer every migrated module fills. It
// carried its first module-specific import (`./dx7/Dx7AlgorithmGlyph.svelte`)
// — the exact trajectory that produced the 8,610-line Canvas — and #1512
// moved that through the extension registry (shell-extensions.ts). This gate
// keeps the seam closed: the NEXT special case turns a test red instead of
// merging quietly.
//
// THE MODEL: the shell layer is SHARED files (ModuleShell + the workflow
// model files + the lib/ui(/modules) root plumbing) plus a small set of
// DECLARED REGISTRY files whose entire job is mapping module ids to module
// code. A SHARED file referencing module-specific code is the defect this
// gate exists for. A REGISTRY file naming modules is its design — each is a
// typed roster entry carrying the lints that own its content, and the walk
// treats it as a BOUNDARY: reached, not traversed (what a module's own code
// imports — typically its own def — is co-location, not shell coupling).
//
// WHAT A SHARED FILE MAY NOT IMPORT (`moduleOwnedOffence`):
//   - anything under a lib/ui/modules SUBDIRECTORY (`./dx7/…`,
//     `$lib/ui/modules/cube/…`) — module-owned directories;
//   - any module DEF path (`$lib/{audio,video,meta}/modules/<anything>`);
//   - a lib/ui(/modules) ROOT file whose basename NAMES a registered module
//     type (`./Dx7AlgorithmGlyph.svelte`, `./kickdrum-face-model`) — the
//     root-level dodge the directory rule is blind to.
//
// WHAT IT STRUCTURALLY CANNOT SEE (stated per the blind-gates rule):
//   - DYNAMIC imports — including shell-extensions' lazy glob, BY DESIGN:
//     that glob is the sanctioned route for module code into the shell.
//   - Inside a REGISTRY boundary — each entry names the gates that cover it.
//   - $lib/ui/{controls,canvas,dock,…} and non-ui namespaces beyond the deny
//     patterns — different subsystems, out of this gate's subject.
//   - A module-owned root file whose basename does NOT start with its
//     module's type id (naming is the only root-level signal there is).
//   - References that are not imports (string literals, runtime lookups).
//
// The predicates are negative-controlled below IN BOTH DIRECTIONS, and those
// controls are permanent legs of the suite — the first fixture is the exact
// import #1512 removed.

import { describe, it, expect } from 'vitest';

import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';

// ── The scanned layer, as RAW SOURCE (the mutate.guard idiom — no fs) ──────
// Canonical ids: 'ui/<file>' (lib/ui root), 'modules/<path>', 'workflow/<path>'.
const RAW = import.meta.glob(
  [
    './**/*.ts',
    './**/*.svelte',
    '../workflow/**/*.ts',
    '../workflow/**/*.svelte',
    '../*.ts',
    '../*.svelte',
  ],
  { eager: true, query: '?raw', import: 'default' },
) as Record<string, string>;

const FILES = new Map<string, string>();
for (const [key, src] of Object.entries(RAW)) {
  if (key.startsWith('./')) FILES.set(`modules/${key.slice(2)}`, src);
  else if (key.startsWith('../workflow/')) FILES.set(`workflow/${key.slice('../workflow/'.length)}`, src);
  else if (key.startsWith('../')) FILES.set(`ui/${key.slice(3)}`, src);
}

const ROOT_ID = 'modules/ModuleShell.svelte';

// ── Import extraction (line-based; comments starting `//` or `*` never match) ─
export function importSpecifiers(src: string): string[] {
  const out: string[] = [];
  for (const line of src.split('\n')) {
    // side-effect import: `import 'x';`
    let m = line.match(/^\s*import\s*['"]([^'"]+)['"]/);
    if (m) {
      out.push(m[1]);
      continue;
    }
    // single-line import/export-from: `import X from 'x'` / `export * from 'x'`
    m = line.match(/^\s*(?:import|export)\b.*?\bfrom\s*['"]([^'"]+)['"]/);
    if (m) {
      out.push(m[1]);
      continue;
    }
    // the closing line of a multiline import: `} from 'x';`
    m = line.match(/^\s*\}\s*from\s*['"]([^'"]+)['"]/);
    if (m) out.push(m[1]);
  }
  return out;
}

// ── Resolution to a canonical layer id (or null = outside the walked layer) ─
function resolveCanonical(fromId: string, spec: string): string | null {
  let path: string | null = null;
  if (spec.startsWith('$lib/ui/')) {
    const rest = spec.slice('$lib/ui/'.length);
    path = rest.includes('/') ? rest : `ui/${rest}`;
    if (!/^(ui|modules|workflow)\//.test(path)) return null; // another ui subsystem
  } else if (spec.startsWith('./') || spec.startsWith('../')) {
    const base = fromId.split('/').slice(0, -1);
    for (const seg of spec.split('/')) {
      if (seg === '.' || seg === '') continue;
      else if (seg === '..') base.pop();
      else base.push(seg);
    }
    path = base.join('/');
    if (!/^(ui|modules|workflow)\//.test(path)) return null; // escaped the layer
  } else {
    return null;
  }
  for (const cand of [path, `${path}.ts`, `${path}.svelte`, `${path}.svelte.ts`, `${path}/index.ts`]) {
    if (FILES.has(cand)) return cand;
  }
  // Canonicalizable but not on disk (e.g. a just-invented module file): return
  // the bare path so the deny predicate can still judge it.
  return path;
}

// ── Module-type naming (the root-level signal) ──────────────────────────────
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}
function basenameTokens(path: string): string[] {
  const base = (path.split('/').pop() ?? '').replace(/\.(svelte|ts)(\.ts)?$/g, '');
  return base
    .split(/[-_.]/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .filter(Boolean);
}
/** The registered module type a basename's leading tokens spell, or null.
 *  Token-boundary-aware so `scope-screen-model` can only match a type that IS
 *  'scope' (it is one — which is why this only judges the walked layer's own
 *  roots, where no such shared file lives; controls/ is out of scope). */
export function moduleNamedBasename(path: string, types: ReadonlySet<string>): string | null {
  const tokens = basenameTokens(path);
  let prefix = '';
  for (const t of tokens) {
    prefix += normalize(t);
    if (types.has(prefix)) return prefix;
  }
  return null;
}

function registeredTypeIds(): Set<string> {
  const out = new Set<string>();
  for (const d of [...listModuleDefs(), ...listVideoModuleDefs(), ...listMetaModuleDefs()]) {
    out.add(normalize((d as { type: string }).type));
  }
  return out;
}

// ── The deny predicate — shared by the gate and its negative controls ───────
export function moduleOwnedOffence(
  fromId: string,
  spec: string,
  types: ReadonlySet<string>,
): string | null {
  // a module DEF path (or anything else co-located in a def directory) — the
  // registries load defs via their own globs; the shell layer never does.
  if (/^\$lib\/(audio|video|meta)\/modules\/.+/.test(spec)) {
    return `imports a module def path '${spec}'`;
  }
  const canonical = resolveCanonical(fromId, spec);
  if (!canonical) return null;
  if (/^modules\/[^/]+\//.test(canonical)) {
    return `imports from a module-owned directory '${spec}' (→ ${canonical})`;
  }
  const named = moduleNamedBasename(canonical, types);
  if (named) {
    return `imports module-named root file '${spec}' (basename names module type '${named}')`;
  }
  return null;
}

// ── DECLARED REGISTRY BOUNDARIES — the sanctioned module↔shell couplers ─────
interface RegistryBoundary {
  /** Canonical id of the registry file. Must exist AND be reached by the walk
   *  — a boundary nothing imports is a dead entry and reddens. */
  file: string;
  /** Why this file may name modules. Required by the type. */
  why: string;
  /** The gates that own what happens INSIDE the boundary. Required. */
  coveredBy: string;
}

const REGISTRY_BOUNDARIES: readonly RegistryBoundary[] = [
  {
    file: 'workflow/shell-cells.ts',
    why:
      'The PF-14 cell/panel registry — the declared seam mapping module types to cell specs and bespoke panel components. Naming modules is its entire job; registering here is the sanctioned alternative to touching ModuleShell.',
    coveredBy:
      'shell-cells.test.ts (spec shape; a panel/action must declare an operability probe) + module-face-lint (panel tier rules, inert-cell coverage) + the faces-parity e2e.',
  },
  {
    file: 'workflow/face-readout-values.ts',
    why:
      'The derived-readout registry — face hero/sidebar valueIds resolve here to pure per-module derivations, which live beside the module code they read (their def imports are co-location, not shell coupling).',
    coveredBy:
      'module-face-lint (every declared valueId is registered; totality) + the per-module <mod>-face-model.test.ts negative controls.',
  },
  {
    file: 'workflow/shell-param-writes.ts',
    why:
      'The PF-13 param-write-override registry — maps one (module type, param) pair to a replacement durable writer (a MACRO commit like cloudseed preset recall), so the redirect is declared here instead of branching inside ModuleShell.',
    coveredBy:
      'shell-param-writes.test.ts (the settle-commit storm guard + readCurrent seam) + faces-parity (the cell still drives and reads back).',
  },
];

const BOUNDARY_IDS = new Set(REGISTRY_BOUNDARIES.map((b) => b.file));

// ── The walk ────────────────────────────────────────────────────────────────
function walkClosure(types: ReadonlySet<string>): { visited: Set<string>; offenders: string[] } {
  const visited = new Set<string>();
  const offenders: string[] = [];
  const queue = [ROOT_ID];
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    if (BOUNDARY_IDS.has(id)) continue; // a registry: reached, never traversed
    const src = FILES.get(id);
    if (!src) continue;
    for (const spec of importSpecifiers(src)) {
      const offence = moduleOwnedOffence(id, spec, types);
      if (offence) {
        offenders.push(`${id} ${offence}`);
        continue; // never walk INTO module-owned code
      }
      const canonical = resolveCanonical(id, spec);
      if (canonical && FILES.has(canonical) && !visited.has(canonical)) queue.push(canonical);
    }
  }
  return { visited, offenders };
}

describe('ModuleShell import guard (#1512) — deny by default', () => {
  it('the walk sees the shell layer (instrument check: membership, not a count)', () => {
    expect(FILES.has(ROOT_ID)).toBe(true);
    const { visited } = walkClosure(registeredTypeIds());
    // A broken resolver yields a closure missing the load-bearing members —
    // red HERE rather than a vacuous green on the offence sweep below.
    for (const mustSee of [
      'workflow/shell-cells.ts',
      'workflow/curated-face.ts',
      'workflow/shell-extensions.ts',
      'modules/card-kit.ts',
    ]) {
      expect(visited, `closure must reach ${mustSee}`).toContain(mustSee);
    }
  });

  it('ModuleShell + its shared shell-layer closure reference no module-specific path', () => {
    const { offenders } = walkClosure(registeredTypeIds());
    expect(offenders).toEqual([]);
  });

  it('every registry boundary is real, reached, and substantively justified', () => {
    const { visited } = walkClosure(registeredTypeIds());
    const stale: string[] = [];
    for (const b of REGISTRY_BOUNDARIES) {
      if (!FILES.has(b.file)) stale.push(`${b.file} (file gone)`);
      else if (!visited.has(b.file)) stale.push(`${b.file} (nothing in the closure imports it — dead boundary)`);
      expect(b.why.length, `boundary why for ${b.file}`).toBeGreaterThan(60);
      expect(b.coveredBy.length, `boundary coveredBy for ${b.file}`).toBeGreaterThan(40);
    }
    expect(stale).toEqual([]);
    // The renderer and the extension registry can never BE boundaries — that
    // would exempt the exact files this gate is about.
    expect(BOUNDARY_IDS.has(ROOT_ID)).toBe(false);
    expect(BOUNDARY_IDS.has('workflow/shell-extensions.ts')).toBe(false);
  });

  // ── NEGATIVE CONTROLS — permanent legs calling the SAME predicates ────────
  it('NEGATIVE CONTROL: the historical direct import reddens (every deny rule)', () => {
    const types = registeredTypeIds();
    expect(types.has('dx7')).toBe(true); // anchor: the predicate's subject exists
    // the exact import #1512 removed (module-owned directory):
    expect(moduleOwnedOffence(ROOT_ID, './dx7/Dx7AlgorithmGlyph.svelte', types)).toMatch(
      /module-owned directory/,
    );
    // the future case the issue names, laundered through a NON-boundary file:
    expect(
      moduleOwnedOffence('workflow/module-shell-model.ts', '$lib/ui/modules/clipplayer/ClipEditor.svelte', types),
    ).toMatch(/module-owned directory/);
    // a module def import:
    expect(moduleOwnedOffence(ROOT_ID, '$lib/audio/modules/dx7', types)).toMatch(/module def path/);
    // the root-level dodge (a module-named sibling, no subdirectory):
    expect(moduleOwnedOffence(ROOT_ID, './Dx7AlgorithmGlyph.svelte', types)).toMatch(
      /module-named root file/,
    );
    expect(moduleOwnedOffence(ROOT_ID, './kickdrum-face-model', types)).toMatch(
      /module-named root file/,
    );
  });

  it('NEGATIVE CONTROL (other direction): shared shell imports stay green', () => {
    const types = registeredTypeIds();
    expect(moduleOwnedOffence(ROOT_ID, './card-kit', types)).toBeNull();
    expect(moduleOwnedOffence(ROOT_ID, './VideoTileThumb.svelte', types)).toBeNull();
    expect(moduleOwnedOffence(ROOT_ID, '$lib/ui/workflow/shell-extensions', types)).toBeNull();
    expect(moduleOwnedOffence(ROOT_ID, '$lib/audio/module-registry', types)).toBeNull();
    expect(moduleOwnedOffence(ROOT_ID, '$lib/audio/momentary-params', types)).toBeNull();
    expect(moduleOwnedOffence(ROOT_ID, '$lib/ui/PatchPanel.svelte', types)).toBeNull();
  });

  it('NEGATIVE CONTROL: the extractor sees real imports and ignores comments', () => {
    const fixture = [
      "import Dx7AlgorithmGlyph from './dx7/Dx7AlgorithmGlyph.svelte';",
      'import {',
      '  shellCellFor,',
      "} from '$lib/ui/workflow/shell-cells';",
      "// import Phantom from './dx7/Phantom.svelte';",
      " * import Ghost from './cube/Ghost.svelte';",
      "import './side-effect';",
    ].join('\n');
    const specs = importSpecifiers(fixture);
    expect(specs).toContain('./dx7/Dx7AlgorithmGlyph.svelte');
    expect(specs).toContain('$lib/ui/workflow/shell-cells');
    expect(specs).toContain('./side-effect');
    expect(specs).not.toContain('./dx7/Phantom.svelte');
    expect(specs).not.toContain('./cube/Ghost.svelte');
  });
});
