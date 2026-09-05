// packages/web/src/lib/ui/modules/card-flow-store-guard.test.ts
//
// A PLAIN-MOUNTED MODULE SURFACE MUST NOT CALL `useStore()` BARE — the
// SOURCE-level gate for a defect no runtime gate in this repo could see.
//
// THE MEASURED BUG (#1587, found while confirming the producer-lifetime fix):
// WavesculptCard did `const flowStore = useStore()` at init. An occupant of a
// dock rail is PLAIN-MOUNTED by DockFullView / DockCardHost — deliberately
// OUTSIDE the SvelteFlow provider (see DockFullView's header: "PatchPanel
// self-gates outside the provider… so the node's ONLY handles live on its
// canvas tile"). `useStore()` throws there. MEASURED:
// `__openDockFullView('ws1')` produced ZERO
// `[data-testid="dock-full-view"]` elements and exactly one pageerror —
//
//   "To call useStore outside of <SvelteFlow /> you need to wrap your component
//    in a <SvelteFlowProvider /> … in DockFullView.svelte"
//
// — i.e. WAVESCULPT could not be expanded AT ALL under the shell. The throw
// aborts the Svelte flush MID-RENDER, so the symptom is not "an error toast",
// it is "the drawer stayed empty" or "expanding B while A is open switched
// nothing". Silent by construction.
//
// ⚠ THE SUBJECT IS THE MOUNT SITE, NOT THE FILENAME SUFFIX — widened here from
// `*Card.svelte` to the whole module-surface tree. `DockCardHost` mounts
// `<ModuleShell view='drawer'>` for a promoted module and the verbatim card for
// an un-promoted one, so BOTH are plain-mounted outside the provider and both
// have always been in scope for this defect; only the scan was narrower than
// the hazard. The walk is now every `.svelte` in this directory plus ONE level
// of module subdirectory beneath it — the same depth `card-preview-gate` walks,
// and the depth the shell-extension glob itself loads from, so a `fullViewBody`
// or `tileBody` that reaches for the store is caught the day it lands rather
// than the day somebody widens the scan again.
//
// WHY A SOURCE GATE AND NOT A RENDER TEST. The surface renders perfectly INSIDE
// the provider, which is every canvas mount and every VRT scene — so the whole
// existing gate set is structurally blind to it. Only the dock plain-mount
// path reaches it, and that path is per-surface. A grep over the surface
// sources is the ONE check whose subject is every surface at once.
//
// THE RULE: a surface that needs the store imports `captureFlowStore` from
// ./card-kit, which is the same call wrapped in the try/catch that returns null
// outside the provider (zoom 1 for card-resize). No module surface imports
// `useStore` from '@xyflow/svelte'.
//
// UNCONDITIONAL — `expect(offenders).toEqual([])`, no exemption list, no
// ceiling. Every surface in the walked tree that needed the store already went
// through the helper; WavesculptCard was the last bare call, so the honest
// shape of this gate is zero, forever. A surface that genuinely cannot use the
// helper does not get an entry here — it gets a fix.
//
// ⚠ THE TWO PROVIDER-COUPLED FILES THE DOCK MOUNTS ARE OUT OF THE WALK AND
// ANCHORED INSTEAD (the last leg). `card-kit.ts` is the sanctioned wrapper and
// `PatchPanel.svelte` — shared chrome the faceplate renders as the tray's only
// patch surface — carries its own identical guarded capture. Both are asserted
// to still wrap the call, so this file always has a LIVE `useStore` import in
// the tree to read: that anchor, not the walked population, is what keeps the
// import predicate from going quietly vacuous.
//
// WHAT THIS GATE CANNOT SEE (stated so it is not mistaken for more than it is):
//   * a surface reaching the store through some OTHER un-guarded xyflow hook
//     (`useSvelteFlow`, `useNodes`, …). Those have the same provider
//     requirement; if one appears, it belongs in PROVIDER_HOOKS.
//   * dynamic access (`await import('@xyflow/svelte')`). Nothing in the walked
//     tree does that today, and the positive control below proves the
//     predicate is reading real import statements rather than passing vacuously.
//   * whether the surface BEHAVES correctly outside the provider — only that it
//     does not throw at init.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** The module-surface directory this walk reads (this file's own directory). */
const CARD_DIR = fileURLToPath(new URL('./', import.meta.url));

/**
 * Provider-requiring xyflow hooks. Each throws when called outside
 * `<SvelteFlow>`, which is exactly the dock plain-mount. `useStore` is the one
 * that actually bit; the rest are listed because they share the failure mode
 * and a card reaching for them should trip this gate on the first commit, not
 * after the same P0 is reported a second time.
 */
const PROVIDER_HOOKS = ['useStore', 'useSvelteFlow', 'useNodes', 'useEdges', 'useConnection'] as const;

/** An `import { … } from '@xyflow/svelte'` statement's brace list. */
const XYFLOW_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*['"]@xyflow\/svelte['"]/g;

/** Names a source imports from '@xyflow/svelte' (specifier text, `type` and
 *  aliases stripped down to the imported symbol). */
export function xyflowImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(XYFLOW_IMPORT_RE)) {
    for (const raw of m[1]!.split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
      if (name) out.push(name);
    }
  }
  return out;
}

/** Provider-requiring hooks a source imports directly from '@xyflow/svelte'. */
export function unguardedFlowHooks(src: string): string[] {
  const imported = new Set(xyflowImports(src));
  return PROVIDER_HOOKS.filter((h) => imported.has(h));
}

/**
 * Every module-owned SURFACE the dock can plain-mount: the flat `.svelte` in
 * this directory AND one level of module subdirectory beneath it — the depth
 * the shell-extension glob itself loads a `fullViewBody`/`tileBody` from, and
 * the same boundary `card-preview-gate` walks for the identical reason (a face
 * PR moves a surface's code across it EVERY time).
 */
function surfaceFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(CARD_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const inner of readdirSync(join(CARD_DIR, entry.name))) {
        if (inner.endsWith('.svelte')) out.push(`${entry.name}/${inner}`);
      }
      continue;
    }
    if (entry.name.endsWith('.svelte')) out.push(entry.name);
  }
  return out.sort();
}

describe('module surfaces must reach the SvelteFlow store through captureFlowStore()', () => {
  it('no module surface imports a provider-requiring xyflow hook directly', () => {
    const offenders: string[] = [];
    for (const file of surfaceFiles()) {
      const src = readFileSync(join(CARD_DIR, file), 'utf8');
      for (const hook of unguardedFlowHooks(src)) {
        offenders.push(
          `${file}: imports ${hook} from '@xyflow/svelte' — it THROWS when the dock plain-mounts ` +
            "this surface outside the provider. Import { captureFlowStore } from './card-kit' instead.",
        );
      }
    }
    expect(offenders.sort()).toEqual([]);
  });

  it('VACUITY GUARD: the walk really reaches BOTH levels of the surface tree', () => {
    // If the walk ever resolves to nothing — a renamed directory, a changed
    // suffix — the assertion above passes while measuring zero files. Anchor it
    // to the artifact instead of trusting it.
    //
    // ⚠ THE ANCHOR IS THE MOUNT SITE, not a file count and not "somebody still
    // imports xyflow". `ModuleShell.svelte` is the component `DockCardHost`
    // plain-mounts for a promoted module, so a walk that cannot see it is not
    // looking at the dock's render tree at all. The SUBDIRECTORY leg is
    // asserted separately because that half is the one that silently emptied
    // before: it is where every `fullViewBody`/`tileBody` lives.
    const files = surfaceFiles();
    expect(files, 'the surface walk resolved NO .svelte files').not.toEqual([]);
    expect(
      files,
      'ModuleShell.svelte is what DockCardHost plain-mounts — a walk that misses it is ' +
        'measuring the wrong tree',
    ).toContain('ModuleShell.svelte');
    expect(
      files.filter((f) => f.includes('/')).length,
      'the walk found NO module subdirectory surfaces — the second level has stopped ' +
        'resolving, and that is exactly where a fullViewBody/tileBody lives',
    ).toBeGreaterThan(0);
  });

  it('POSITIVE CONTROL: the predicate SEES the offending form (and the guarded one is clean)', () => {
    // The exact line WavesculptCard carried, and the exact line it carries now.
    expect(unguardedFlowHooks("import { useStore, type NodeProps } from '@xyflow/svelte';")).toEqual([
      'useStore',
    ]);
    expect(unguardedFlowHooks("import { type NodeProps } from '@xyflow/svelte';")).toEqual([]);
    expect(unguardedFlowHooks("import { captureFlowStore } from './card-kit';")).toEqual([]);

    // Aliases and multi-line forms must not slip past.
    expect(unguardedFlowHooks("import { useStore as s } from '@xyflow/svelte';")).toEqual(['useStore']);
    expect(
      unguardedFlowHooks("import {\n  Handle,\n  useSvelteFlow,\n} from '@xyflow/svelte';"),
    ).toEqual(['useSvelteFlow']);

    // And a MENTION is not an import — the gate must not fire on prose about
    // the very bug it exists for (this file, and WavesculptCard's comment).
    expect(unguardedFlowHooks('// a bare useStore() throws outside the provider')).toEqual([]);
    expect(unguardedFlowHooks("import { useStore } from './card-kit';")).toEqual([]);
  });

  it('the two GUARDED wrappers still wrap — the live anchor for the predicate', () => {
    // ANCHORED, and doing two jobs at once.
    //
    // (1) If card-kit ever stops exporting captureFlowStore, the failure
    //     message above tells every future surface to import something gone.
    // (2) These are the ONLY files in the dock's render tree that reach the
    //     provider-coupled call, so they are what keeps `xyflowImports` reading
    //     a REAL import statement every run. The walked population deliberately
    //     imports nothing from '@xyflow/svelte' — that is the state this gate
    //     exists to hold — so anchoring liveness on the population instead
    //     would make the anchor false the moment the gate succeeded.
    const kit = readFileSync(join(CARD_DIR, 'card-kit.ts'), 'utf8');
    expect(kit).toMatch(/export function captureFlowStore\(/);
    // card-kit is one of the two places allowed to call it — that is the design.
    expect(unguardedFlowHooks(kit)).toEqual(['useStore']);

    // PatchPanel is the other: shared chrome, not a module surface, and the
    // faceplate renders it as the dock tray's ONLY patch surface — so it is
    // plain-mounted outside the provider on exactly the path this gate is
    // about. It carries its own identical guarded capture rather than importing
    // the kit's (it predates it), and a bare call there would take the whole
    // drawer down the same way WavesculptCard did.
    const panel = readFileSync(
      fileURLToPath(new URL('../PatchPanel.svelte', import.meta.url)),
      'utf8',
    );
    expect(unguardedFlowHooks(panel)).toEqual(['useStore']);
    expect(
      panel,
      'PatchPanel calls useStore() OUTSIDE a try/catch — the dock mounts it outside the ' +
        'provider, where that throw aborts the whole faceplate render',
    ).toMatch(/function captureFlowStore\(\)[\s\S]{0,120}try\s*\{[\s\S]{0,80}useStore\(\)/);
  });
});
