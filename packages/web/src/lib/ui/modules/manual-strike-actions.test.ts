// packages/web/src/lib/ui/modules/manual-strike-actions.test.ts
//
// The browser-free pre-gate for the SHARED AUDITION seam — the ONE function a
// struck voice's legacy-card audition button and its RACKLINE shell `action`
// cell both call (kickdrum's STRIKE and karplus's PLUCK today).
//
// What it pins:
//   1. the happy path fires EXACTLY ONE strike, at the node it was handed;
//   2. every way the audition can be unavailable resolves to null rather than
//      throwing (an audition that cannot fire is a no-op, never an error over
//      a rack) — THREE distinct branches, not one (and not four: this header
//      said four while the test body already explained why it is three);
//   3. the strike writes NOTHING to the graph. This is the property that makes
//      it safe to lean on, and it is the one a future refactor is most likely
//      to break by "just making it a param";
//   4. `fireManualStrike` reports whether a strike actually happened, so a
//      caller's press flash follows the truth and not the click.
//
// The DOM-level twins are e2e/tests/kickdrum-face.spec.ts and
// e2e/tests/karplus-face.spec.ts, which click the real cell and listen for
// audible RMS at the module's own output.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import { setActiveEngine } from '$lib/audio/engine-ref';
import type { PatchEngine } from '$lib/audio/engine';
import {
  MANUAL_STRIKE_KEY,
  fireManualStrike,
  resolveManualStrike,
  type StrikeEngineLike,
} from './manual-strike-actions';

const NID = 'kickdrum-strike-test-node';

function makeNode(): ModuleNode {
  ydoc.transact(() => {
    patch.nodes[NID] = {
      id: NID,
      type: 'kickdrum',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: { tune: 50 },
      data: {},
    } as unknown as ModuleNode;
  }, LOCAL_ORIGIN);
  return patch.nodes[NID] as unknown as ModuleNode;
}

/** A fake engine whose `read` answers the strike key with a counting fn. */
function fakeEngine(): { engine: StrikeEngineLike; fired: string[]; reads: string[] } {
  const fired: string[] = [];
  const reads: string[] = [];
  return {
    fired,
    reads,
    engine: {
      read(node: ModuleNode, key: string): unknown {
        reads.push(`${node.id}:${key}`);
        if (key !== MANUAL_STRIKE_KEY) return undefined;
        return () => fired.push(node.id);
      },
    },
  };
}

describe('manual-strike audition — resolveManualStrike (pure)', () => {
  it('resolves the node’s one-shot strike and fires it EXACTLY once, at that node', () => {
    const node = { id: 'kd-1' } as unknown as ModuleNode;
    const { engine, fired, reads } = fakeEngine();

    const strike = resolveManualStrike(engine, node);
    expect(strike, 'a live engine + node resolves a callable strike').toBeTypeOf('function');
    expect(reads, 'it asks for the manualTrigger read key on THIS node').toEqual(['kd-1:manualTrigger']);

    strike!();
    expect(fired).toEqual(['kd-1']);
    strike!();
    expect(fired, 'each call is one strike — no latching, no repeat').toEqual(['kd-1', 'kd-1']);
  });

  it('returns null for each of the THREE distinct unavailable branches', () => {
    // ⚠ IT SAID **FOUR**, AND THERE ARE THREE. The old (c) `read: () => 42` and
    // (d) `read: () => undefined` fall through the IDENTICAL guard
    // (`typeof fn === 'function'` in resolveManualStrike) — one deletion reds
    // both, which is what "distinct" is supposed to rule out, and the PR's own
    // "NC5a: drop the typeof guard → 1 red" was already consistent with three
    // rather than four. Listing a branch count that the code does not have is
    // how a suite reads as more thorough than it is. Kept as three named
    // branches plus an explicitly-labelled shape sweep over the fourth.
    const node = { id: 'kd-1' } as unknown as ModuleNode;
    const { engine } = fakeEngine();

    // (a) no engine — the AudioContext has not booted, nothing can sound yet.
    expect(resolveManualStrike(null, node)).toBeNull();
    expect(resolveManualStrike(undefined, node)).toBeNull();
    // (b) no node — the module was removed between render and click.
    expect(resolveManualStrike(engine, undefined)).toBeNull();
    // (c) the handle answers the key with a NON-FUNCTION. One branch, several
    //     shapes: a half-implemented seam (42), an unimplemented one
    //     (undefined), a truthy object, null.
    for (const v of [42, undefined, null, {}, 'fn']) {
      expect(resolveManualStrike({ read: () => v }, node), `read → ${String(v)}`).toBeNull();
    }
  });
});

describe('manual-strike audition — fireManualStrike (the shared wiring)', () => {
  beforeEach(() => {
    makeNode();
  });
  afterEach(() => {
    setActiveEngine(null);
    ydoc.transact(() => {
      delete patch.nodes[NID];
    }, LOCAL_ORIGIN);
  });

  it('fires at the LIVE node and reports true', () => {
    const { engine, fired } = fakeEngine();
    setActiveEngine(engine as unknown as PatchEngine);

    expect(fireManualStrike(NID)).toBe(true);
    expect(fired).toEqual([NID]);
  });

  it('is a NO-OP (false, no throw) with no engine, and for an unknown node id', () => {
    setActiveEngine(null);
    expect(fireManualStrike(NID)).toBe(false);

    const { engine, fired } = fakeEngine();
    setActiveEngine(engine as unknown as PatchEngine);
    expect(fireManualStrike('no-such-node')).toBe(false);
    expect(fired).toEqual([]);
  });

  it('writes NOTHING to the graph — no param moves, no data key appears', () => {
    const { engine } = fakeEngine();
    setActiveEngine(engine as unknown as PatchEngine);

    const before = JSON.stringify({
      params: patch.nodes[NID]!.params,
      data: (patch.nodes[NID] as unknown as ModuleNode).data,
    });
    expect(fireManualStrike(NID)).toBe(true);
    expect(fireManualStrike(NID)).toBe(true);
    const after = JSON.stringify({
      params: patch.nodes[NID]!.params,
      data: (patch.nodes[NID] as unknown as ModuleNode).data,
    });

    expect(after, 'the audition is not a param — it must not touch the Y.Doc').toBe(before);
  });
});
