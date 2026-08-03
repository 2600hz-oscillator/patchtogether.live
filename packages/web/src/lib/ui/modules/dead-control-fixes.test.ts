// packages/web/src/lib/ui/modules/dead-control-fixes.test.ts
//
// TWO CONTROLS THAT WERE ON THE PANEL AND DID NOT WORK, and the assertions that
// would have caught each. Both are the same shape — a CARD disagreeing with the
// rest of the system, on a dimension no def-reading gate can see — and neither
// is an audio bug, so neither ART nor the behavioral sweep could have flagged
// them either.
//
//   1. analogVco FM / PM — the def declares both `-1..1`; the card hardcoded
//      `min={0}`. The ENTIRE NEGATIVE HALF of both modulation-depth controls
//      had no user interface, on a module whose inverted depth is a real,
//      deliberately-implemented feature with its own unit test
//      (analog-vco-modulation.test.ts: "negative PM depth inverts the phase
//      offset (bipolar)"). contract-lock, module-docs-lint and every range
//      assertion read the DEF — and the def was right.
//
//   2. filter MODE — committed as a BARE proxy assignment
//      (`patch.nodes[id].params.mode = m`) instead of `setNodeParam`, so it
//      landed in the document untagged. The UndoManager tracks only
//      `LOCAL_ORIGIN`, so switching LP→BP was NOT UNDOABLE while cutoff and
//      resonance on the same card were. `mutate.guard.test.ts`'s
//      RAW_PARAM_WRITE check is bracket-form only (`params['x'] =`), so the
//      guard and the bug were blind in the same direction.
//
// The filter half is a BEHAVIOUR test against the real Y.Doc + UndoManager —
// undo granularity is a property of the real store and a mock cannot see it.
// The analogVco half is necessarily a SOURCE assertion, because there is no
// Svelte component harness in this repo and a literal in markup has no runtime
// representation to probe. That is the same reason `module-docs-lint`'s
// controlFamilies→testid check is a grep.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { patch, ydoc, undoManager, LOCAL_ORIGIN } from '$lib/graph/store';
import { setNodeParam } from '$lib/graph/mutate';
import { analogVcoDef } from '$lib/audio/modules/analog-vco';
import { filterDef } from '$lib/audio/modules/filter';
import type { ModuleNode } from '$lib/graph/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const cardSource = (file: string): string => readFileSync(join(HERE, file), 'utf8');

/**
 * The card's source with COMMENTS REMOVED — block, line and HTML.
 *
 * Load-bearing, and it caught itself: both fixed cards now carry a comment
 * QUOTING the defect (`min={0}`, `patch.nodes[id].params.mode = m`) so the next
 * reader knows what not to reintroduce, and a raw scan flagged those sentences
 * as the bug. A guard that cannot tell code from prose would make documenting a
 * fix impossible — the pressure would be to delete the explanation, which is
 * the opposite of what should happen.
 */
const cardCode = (file: string): string =>
  cardSource(file)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, ' ');

// ── 1 · analogVco: the negative half is reachable ───────────────────────────

describe('analogVco — bipolar modulation depth is reachable from the card', () => {
  it('the DEF declares FM and PM bipolar (the fact the card must not narrow)', () => {
    for (const id of ['fmAmount', 'pmAmount']) {
      const p = analogVcoDef.params.find((q) => q.id === id)!;
      expect(p.min, `${id}.min — inverted depth is a shipped feature`).toBeLessThan(0);
      expect(p.max, `${id}.max`).toBeGreaterThan(0);
    }
  });

  it('the CARD passes no literal range prop — every one comes from the def', () => {
    // The narrow, card-scoped form of the repo's "a range comes from ONE
    // place" rule. `min={0} max={1}` on `fmAmount` is what shipped, and it
    // read as perfectly ordinary markup next to five neighbours that agreed
    // with their def by coincidence.
    const src = cardCode('AnalogVcoCard.svelte');
    const offenders = [...src.matchAll(/\b(min|max|defaultValue)=\{-?[\d.]+\}/g)]
      .map((m) => m[0]);
    expect(
      offenders.join(', '),
      'AnalogVcoCard re-types a range the def already declares — bind it through spec()',
    ).toBe('');
  });

  it('the card threads every fader through the def-reading spec() helper', () => {
    // The positive half: "no literals" would also pass on a card with no
    // faders at all. Six params, six spreads.
    const src = cardSource('AnalogVcoCard.svelte');
    for (const p of analogVcoDef.params) {
      expect(src, `AnalogVcoCard must bind ${p.id} to the def`).toContain(`spec('${p.id}')`);
    }
  });
});

// ── 2 · filter: MODE is undoable ────────────────────────────────────────────

describe('filter — MODE lands on the undo stack like every other control', () => {
  const NID = 'filter-mode-undo-test';

  function spawn(): void {
    ydoc.transact(() => {
      patch.nodes[NID] = {
        id: NID,
        type: 'filter',
        domain: 'audio',
        position: { x: 0, y: 0 },
        params: { cutoff: 1000, resonance: 0.1, mode: 0 },
        data: {},
      } as unknown as ModuleNode;
    }, LOCAL_ORIGIN);
    undoManager.clear();
    undoManager.stopCapturing();
  }

  beforeEach(() => {
    if (patch.nodes[NID]) ydoc.transact(() => { delete patch.nodes[NID]; }, LOCAL_ORIGIN);
    spawn();
  });
  afterEach(() => {
    if (patch.nodes[NID]) ydoc.transact(() => { delete patch.nodes[NID]; }, LOCAL_ORIGIN);
    undoManager.clear();
  });

  it('`mode` is a real param, so an untagged write reaches the doc but not undo', () => {
    expect(filterDef.params.find((p) => p.id === 'mode')).toBeTruthy();
  });

  it('THE BUG: a bare proxy assignment changes the value and adds NO undo entry', () => {
    // The negative control on the test itself — reproduce the shipped commit
    // form and show it really is invisible to undo. Without this leg, the
    // passing test below could be passing for any reason at all.
    const depth = undoManager.undoStack.length;
    patch.nodes[NID]!.params.mode = 2;
    expect(patch.nodes[NID]!.params.mode, 'the raw write DOES reach the document').toBe(2);
    expect(
      undoManager.undoStack.length,
      'an untagged write is invisible to the UndoManager — this is what shipped',
    ).toBe(depth);
  });

  it('THE FIX: the setNodeParam commit is undoable, and Cmd-Z restores the mode', () => {
    const depth = undoManager.undoStack.length;
    setNodeParam(NID, 'mode', 2);
    undoManager.stopCapturing();
    expect(patch.nodes[NID]!.params.mode).toBe(2);
    expect(undoManager.undoStack.length, 'MODE must be undoable like cutoff/res').toBe(depth + 1);
    undoManager.undo();
    expect(patch.nodes[NID]!.params.mode, 'undo returns to the previous mode').toBe(0);
  });

  it('the CARD commits through the shared setter, not a bare assignment', () => {
    const src = cardCode('FilterCard.svelte');
    expect(src).toContain("set('mode')");
    // The exact shipped line, in any spacing, must be gone.
    expect(src).not.toMatch(/\bt\.params\.mode\s*=/);
    expect(src).not.toMatch(/patch\.nodes\[[^\]]+\]\.params\.mode\s*=/);
  });
});
