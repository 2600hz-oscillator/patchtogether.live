// packages/web/src/lib/ui/modules/card-flow-store-guard.test.ts
//
// A CARD MUST NOT CALL `useStore()` BARE — the SOURCE-level gate for a defect
// no runtime gate in this repo could see.
//
// THE MEASURED BUG (#1587, found while confirming the producer-lifetime fix):
// WavesculptCard did `const flowStore = useStore()` at init. Under the
// faceplate shell an un-migrated module's card is PLAIN-MOUNTED by
// DockFullView / DockCardHost — deliberately OUTSIDE the SvelteFlow provider
// (see DockFullView's header: "PatchPanel self-gates outside the provider…
// so the node's ONLY handles live on its canvas tile"). `useStore()` throws
// there. MEASURED: `__openDockFullView('ws1')` produced ZERO
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
// WHY A SOURCE GATE AND NOT A RENDER TEST. The card renders perfectly INSIDE
// the provider, which is every canvas mount and every VRT scene — so the whole
// existing gate set is structurally blind to it. Only the dock plain-mount
// path reaches it, and that path is per-card. A grep over the card sources is
// the ONE check whose subject is every card at once.
//
// THE RULE: cards import `captureFlowStore` from ./card-kit, which is the same
// call wrapped in the try/catch that returns null outside the provider (zoom 1
// for card-resize). No card imports `useStore` from '@xyflow/svelte'.
//
// UNCONDITIONAL — `expect(offenders).toEqual([])`, no exemption list, no
// ceiling. Every card in the glob directory that needed the store already went
// through the helper; WavesculptCard was the last bare call, so the honest
// shape of this gate is zero, forever. A card that genuinely cannot use the
// helper does not get an entry here — it gets a fix.
//
// WHAT THIS GATE CANNOT SEE (stated so it is not mistaken for more than it is):
//   * a card reaching the store through some OTHER un-guarded xyflow hook
//     (`useSvelteFlow`, `useNodes`, …). Those have the same provider
//     requirement; if one appears in a card, it belongs in HOOK_RE.
//   * dynamic access (`await import('@xyflow/svelte')`). Nothing in the card
//     directory does that today, and the positive control below proves the
//     predicate is reading real import statements rather than passing vacuously.
//   * whether the card BEHAVES correctly outside the provider — only that it
//     does not throw at init.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The card directory the glob resolver reads (this file's own directory). */
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

function cardFiles(): string[] {
  return readdirSync(CARD_DIR).filter((f) => f.endsWith('Card.svelte'));
}

describe('module cards must reach the SvelteFlow store through captureFlowStore()', () => {
  it('no card imports a provider-requiring xyflow hook directly', () => {
    const offenders: string[] = [];
    for (const file of cardFiles()) {
      const src = readFileSync(new URL(file, `file://${CARD_DIR}`), 'utf8');
      for (const hook of unguardedFlowHooks(src)) {
        offenders.push(
          `${file}: imports ${hook} from '@xyflow/svelte' — it THROWS when the dock plain-mounts ` +
            "this card outside the provider. Import { captureFlowStore } from './card-kit' instead.",
        );
      }
    }
    expect(offenders.sort()).toEqual([]);
  });

  it('VACUITY GUARD: the scan actually reads cards, and they really do import from xyflow', () => {
    // If the glob ever resolves to nothing — a renamed directory, a changed
    // suffix — the assertion above passes while measuring zero files. Anchor it
    // to the artifact instead of trusting it.
    const files = cardFiles();
    expect(files.length, 'the card glob resolved to NO *Card.svelte files').toBeGreaterThan(0);
    const withXyflow = files.filter((f) =>
      xyflowImports(readFileSync(new URL(f, `file://${CARD_DIR}`), 'utf8')).length > 0,
    );
    expect(
      withXyflow.length,
      "no card imports anything from '@xyflow/svelte' — the import regex has stopped matching",
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

  it('the guarded helper exists and is what the cards are pointed at', () => {
    // ANCHORED: if card-kit ever stops exporting captureFlowStore, the failure
    // message above tells every future card to import something that is gone.
    const kit = readFileSync(new URL('./card-kit.ts', `file://${CARD_DIR}`), 'utf8');
    expect(kit).toMatch(/export function captureFlowStore\(/);
    // card-kit is the ONE place allowed to call it — that is the whole design.
    expect(unguardedFlowHooks(kit)).toEqual(['useStore']);
  });
});
