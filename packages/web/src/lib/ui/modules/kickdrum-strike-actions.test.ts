// packages/web/src/lib/ui/modules/kickdrum-strike-actions.test.ts
//
// The browser-free pre-gate for KICK DRUM's AUDITION — the ONE seam the legacy
// card's STRIKE button and the RACKLINE shell's `kickdrum-strike` action cell
// both call.
//
// What it pins:
//   1. the happy path fires EXACTLY ONE strike, at the node it was handed;
//   2. every way the audition can be unavailable resolves to null rather than
//      throwing (an audition that cannot fire is a no-op, never an error over
//      a rack) — and they are four DISTINCT states, not one;
//   3. the strike writes NOTHING to the graph. This is the property that makes
//      it safe to lean on, and it is the one a future refactor is most likely
//      to break by "just making it a param";
//   4. `fireKickdrumStrike` reports whether a strike actually happened, so a
//      caller's press flash follows the truth and not the click.
//
// The DOM-level twin is e2e/tests/kickdrum-face.spec.ts, which clicks the real
// cell and listens for audible RMS at the output.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import { setActiveEngine } from '$lib/audio/engine-ref';
import type { PatchEngine } from '$lib/audio/engine';
import {
  KICKDRUM_STRIKE_KEY,
  fireKickdrumStrike,
  resolveManualStrike,
  type StrikeEngineLike,
} from './kickdrum-strike-actions';

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
        if (key !== KICKDRUM_STRIKE_KEY) return undefined;
        return () => fired.push(node.id);
      },
    },
  };
}

describe('kickdrum audition — resolveManualStrike (pure)', () => {
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

describe('kickdrum audition — fireKickdrumStrike (the shared wiring)', () => {
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

    expect(fireKickdrumStrike(NID)).toBe(true);
    expect(fired).toEqual([NID]);
  });

  it('is a NO-OP (false, no throw) with no engine, and for an unknown node id', () => {
    setActiveEngine(null);
    expect(fireKickdrumStrike(NID)).toBe(false);

    const { engine, fired } = fakeEngine();
    setActiveEngine(engine as unknown as PatchEngine);
    expect(fireKickdrumStrike('no-such-node')).toBe(false);
    expect(fired).toEqual([]);
  });

  it('writes NOTHING to the graph — no param moves, no data key appears', () => {
    const { engine } = fakeEngine();
    setActiveEngine(engine as unknown as PatchEngine);

    const before = JSON.stringify({
      params: patch.nodes[NID]!.params,
      data: (patch.nodes[NID] as unknown as ModuleNode).data,
    });
    expect(fireKickdrumStrike(NID)).toBe(true);
    expect(fireKickdrumStrike(NID)).toBe(true);
    const after = JSON.stringify({
      params: patch.nodes[NID]!.params,
      data: (patch.nodes[NID] as unknown as ModuleNode).data,
    });

    expect(after, 'the audition is not a param — it must not touch the Y.Doc').toBe(before);
  });
});
