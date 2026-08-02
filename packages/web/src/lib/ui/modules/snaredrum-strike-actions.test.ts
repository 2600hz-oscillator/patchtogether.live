// packages/web/src/lib/ui/modules/snaredrum-strike-actions.test.ts
//
// The browser-free pre-gate for SNARE DRUM's TWO auditions — the seams the
// legacy card's pads and the RACKLINE shell's `snaredrum-hit` /
// `snaredrum-roll` cells both call.
//
// What it pins:
//   1. the happy paths reach the engine at the node they were handed, with the
//      HIT and the ROLL landing on their OWN read keys (a handle that only
//      implements the one-shot must NOT answer the roll — a roll opened by a
//      seam that cannot close it is the forever-rolling drum);
//   2. every way an audition can be unavailable resolves to null rather than
//      throwing (a no-op, never an error dialog over a rack);
//   3. neither writes ANYTHING to the graph — the property that makes them safe
//      to lean on, and the one a future refactor is most likely to break by
//      "just making it a param";
//   4. the LATCH's edge accounting survives the impure wrapper: a repeated
//      press does not re-open, a redundant release does not re-close, and the
//      panic path closes what is actually open.
//
// The engine-level twin is snaredrum-factory-strike.test.ts (the REAL factory's
// ConstantSources); the DOM twin is e2e/tests/snaredrum-face.spec.ts, which
// holds the real pad and listens for audible RMS.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import { setActiveEngine } from '$lib/audio/engine-ref';
import type { PatchEngine } from '$lib/audio/engine';
import {
  SNAREDRUM_HIT_KEY,
  SNAREDRUM_ROLL_KEY,
  __resetSnaredrumRollLatch,
  fireSnaredrumHit,
  panicSnaredrumRolls,
  resolveManualRoll,
  resolveManualStrike,
  setSnaredrumRoll,
  type StrikeEngineLike,
} from './snaredrum-strike-actions';

const NID = 'snaredrum-strike-test-node';
const NID2 = 'snaredrum-strike-test-node-2';

function makeNode(id = NID): ModuleNode {
  ydoc.transact(() => {
    patch.nodes[id] = {
      id,
      type: 'snaredrum',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: { tune: 180 },
      data: {},
    } as unknown as ModuleNode;
  }, LOCAL_ORIGIN);
  return patch.nodes[id] as unknown as ModuleNode;
}

/** A fake engine answering both audition keys with recorders. */
function fakeEngine(): {
  engine: StrikeEngineLike;
  hits: string[];
  gates: string[];
  reads: string[];
} {
  const hits: string[] = [];
  const gates: string[] = [];
  const reads: string[] = [];
  return {
    hits,
    gates,
    reads,
    engine: {
      read(node: ModuleNode, key: string): unknown {
        reads.push(`${node.id}:${key}`);
        if (key === SNAREDRUM_HIT_KEY) return () => hits.push(node.id);
        if (key === SNAREDRUM_ROLL_KEY) return (high: boolean) => gates.push(`${node.id}:${high ? 'hi' : 'lo'}`);
        return undefined;
      },
    },
  };
}

function install(engine: StrikeEngineLike | null): void {
  setActiveEngine(engine as unknown as PatchEngine | null);
}

beforeEach(() => {
  __resetSnaredrumRollLatch();
});

afterEach(() => {
  install(null);
  __resetSnaredrumRollLatch();
  ydoc.transact(() => {
    for (const id of [NID, NID2]) if (patch.nodes[id]) delete patch.nodes[id];
  }, LOCAL_ORIGIN);
});

describe('snaredrum auditions — resolution (PURE, injected engine + node)', () => {
  it('resolves the HIT and the ROLL off their OWN keys', () => {
    const f = fakeEngine();
    const n = makeNode();
    expect(typeof resolveManualStrike(f.engine, n)).toBe('function');
    expect(typeof resolveManualRoll(f.engine, n)).toBe('function');
    expect(f.reads).toEqual([`${NID}:${SNAREDRUM_HIT_KEY}`, `${NID}:${SNAREDRUM_ROLL_KEY}`]);
  });

  it('a handle that answers ONLY the hit key does NOT yield a roll setter', () => {
    // The dangerous fallback. If `resolveManualRoll` ever fell back to the hit
    // key, holding ROLL would fire one 5 ms pulse and the pad would report
    // "rolling" over a drum that is not — and the release would do nothing.
    const hitOnly: StrikeEngineLike = {
      read: (_n, key) => (key === SNAREDRUM_HIT_KEY ? () => {} : undefined),
    };
    const n = makeNode();
    expect(resolveManualStrike(hitOnly, n)).toBeTypeOf('function');
    expect(resolveManualRoll(hitOnly, n)).toBeNull();
  });

  it('THREE distinct unavailable states resolve to null, on both auditions', () => {
    const f = fakeEngine();
    const n = makeNode();
    // (a) no engine — the AudioContext has not booted.
    expect(resolveManualStrike(null, n)).toBeNull();
    expect(resolveManualRoll(undefined, n)).toBeNull();
    // (b) no node — removed between render and press.
    expect(resolveManualStrike(f.engine, undefined)).toBeNull();
    expect(resolveManualRoll(f.engine, undefined)).toBeNull();
    // (c) the handle answers with something that is not callable. A number and
    // an absent `read` are ONE branch (the same `typeof fn === 'function'`
    // guard), swept over several shapes rather than named as several branches.
    for (const v of [42, undefined, null, 'nope', {}]) {
      const odd: StrikeEngineLike = { read: () => v };
      expect(resolveManualStrike(odd, n)).toBeNull();
      expect(resolveManualRoll(odd, n)).toBeNull();
    }
  });
});

describe('snaredrum auditions — firing at the LIVE node', () => {
  it('HIT fires exactly once, at the node it was handed', () => {
    const f = fakeEngine();
    install(f.engine);
    makeNode();
    expect(fireSnaredrumHit(NID)).toBe(true);
    expect(f.hits).toEqual([NID]);
  });

  it('HIT reports FALSE (and does nothing) when the audition is unavailable', () => {
    const f = fakeEngine();
    install(f.engine);
    // No such node in the graph.
    expect(fireSnaredrumHit('ghost')).toBe(false);
    expect(f.hits).toEqual([]);
    // No engine at all.
    install(null);
    makeNode();
    expect(fireSnaredrumHit(NID)).toBe(false);
  });

  it('ROLL sends ONE high edge and ONE low edge for a press/release pair', () => {
    const f = fakeEngine();
    install(f.engine);
    makeNode();
    expect(setSnaredrumRoll(NID, true)).toBe(true);
    expect(setSnaredrumRoll(NID, false)).toBe(true);
    expect(f.gates).toEqual([`${NID}:hi`, `${NID}:lo`]);
  });

  it('a REPEATED press does not re-open, and a redundant release does not re-close', () => {
    // Both happen for real: keyboard auto-repeat on the press side, and on the
    // release side the <Button>'s own onGate(false) AND the window-level panic
    // firing on the same pointerup.
    const f = fakeEngine();
    install(f.engine);
    makeNode();
    expect(setSnaredrumRoll(NID, true)).toBe(true);
    expect(setSnaredrumRoll(NID, true), 'the second press is a no-op').toBe(false);
    expect(setSnaredrumRoll(NID, false)).toBe(true);
    expect(setSnaredrumRoll(NID, false), 'the redundant release is a no-op').toBe(false);
    expect(f.gates, 'exactly one edge each way reached the engine').toEqual([`${NID}:hi`, `${NID}:lo`]);
  });

  it('PANIC closes every open roll, once, and is idempotent', () => {
    const f = fakeEngine();
    install(f.engine);
    makeNode(NID);
    makeNode(NID2);
    setSnaredrumRoll(NID, true);
    setSnaredrumRoll(NID2, true);
    f.gates.length = 0;

    expect(panicSnaredrumRolls().sort()).toEqual([NID, NID2].sort());
    expect(f.gates.sort()).toEqual([`${NID}:lo`, `${NID2}:lo`].sort());

    f.gates.length = 0;
    expect(panicSnaredrumRolls(), 'a second panic has nothing to close').toEqual([]);
    expect(f.gates).toEqual([]);
  });

  it('a release with the engine GONE clears the latch, so a later panic is not a phantom close', () => {
    const f = fakeEngine();
    install(f.engine);
    makeNode();
    setSnaredrumRoll(NID, true);
    install(null); // the AudioContext went away mid-hold
    expect(setSnaredrumRoll(NID, false), 'nothing could be sent').toBe(false);
    install(f.engine);
    f.gates.length = 0;
    expect(panicSnaredrumRolls(), 'the latch no longer thinks this node is rolling').toEqual([]);
    expect(f.gates).toEqual([]);
  });
});

describe('snaredrum auditions — the LEAK GUARD is really installed and really fires', () => {
  /** Swap in a fake window/document that records listeners, and restore after. */
  function withFakeWindow<T>(fn: (listeners: Map<string, (() => void)[]>) => T): T {
    const listeners = new Map<string, (() => void)[]>();
    const add = (type: string, cb: () => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), cb]);
    };
    const g = globalThis as unknown as Record<string, unknown>;
    const hadW = 'window' in g;
    const hadD = 'document' in g;
    const prevW = g['window'];
    const prevD = g['document'];
    g['window'] = { addEventListener: add };
    g['document'] = { addEventListener: add, visibilityState: 'visible' };
    try {
      return fn(listeners);
    } finally {
      if (hadW) g['window'] = prevW; else delete g['window'];
      if (hadD) g['document'] = prevD; else delete g['document'];
    }
  }

  it('a held roll registers the four release listeners, once', () => {
    const f = fakeEngine();
    install(f.engine);
    makeNode();
    withFakeWindow((listeners) => {
      setSnaredrumRoll(NID, true);
      expect([...listeners.keys()].sort()).toEqual(
        ['blur', 'pointercancel', 'pointerup', 'visibilitychange'].sort(),
      );
      // A second hold must not stack another set (they are process-wide).
      setSnaredrumRoll(NID, false);
      setSnaredrumRoll(NID, true);
      for (const [type, cbs] of listeners) expect(cbs, `${type} registered once`).toHaveLength(1);
    });
  });

  it('a window POINTERUP the button never saw still closes the gate', () => {
    // The leak this exists for: the pane closes (or the module is deleted)
    // mid-hold, so the <Button> unmounts and no pointerup ever reaches it.
    const f = fakeEngine();
    install(f.engine);
    makeNode();
    withFakeWindow((listeners) => {
      setSnaredrumRoll(NID, true);
      f.gates.length = 0;
      for (const cb of listeners.get('pointerup') ?? []) cb();
      expect(f.gates, 'the window-level release closed the roll').toEqual([`${NID}:lo`]);
      // …and the state agrees, so a later panic is not a phantom close.
      f.gates.length = 0;
      expect(panicSnaredrumRolls()).toEqual([]);
      expect(f.gates).toEqual([]);
    });
  });

  it('NEGATIVE CONTROL: with NO window the hold still works and simply installs nothing', () => {
    // The guard is feature-detected, so a partial `window` (the unit lane leaves
    // one behind) must not throw — and the audition must still function.
    const f = fakeEngine();
    install(f.engine);
    makeNode();
    const g = globalThis as unknown as Record<string, unknown>;
    const had = 'window' in g;
    const prev = g['window'];
    g['window'] = {}; // present, but with no addEventListener — the real shape
    try {
      expect(() => setSnaredrumRoll(NID, true)).not.toThrow();
      expect(f.gates).toEqual([`${NID}:hi`]);
      expect(setSnaredrumRoll(NID, false)).toBe(true);
    } finally {
      if (had) g['window'] = prev; else delete g['window'];
    }
  });
});

describe('snaredrum auditions — the graph is NOT touched', () => {
  it('neither audition writes a param, a data key, or a node', () => {
    const f = fakeEngine();
    install(f.engine);
    makeNode();
    const before = JSON.stringify({
      params: patch.nodes[NID]!.params,
      data: (patch.nodes[NID] as ModuleNode).data,
      keys: Object.keys(patch.nodes).sort(),
    });

    fireSnaredrumHit(NID);
    setSnaredrumRoll(NID, true);
    setSnaredrumRoll(NID, false);
    panicSnaredrumRolls();

    const after = JSON.stringify({
      params: patch.nodes[NID]!.params,
      data: (patch.nodes[NID] as ModuleNode).data,
      keys: Object.keys(patch.nodes).sort(),
    });
    expect(after, 'an audition must never reach the Y.Doc (no persist, no undo, no sync)').toBe(before);
  });
});
