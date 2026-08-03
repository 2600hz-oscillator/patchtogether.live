// packages/web/src/lib/ui/modules/manual-strike-actions.test.ts
//
// The browser-free pre-gate for the SHARED AUDITION seam — the functions a
// struck voice's legacy-card audition pad and its RACKLINE shell `action` cell
// both call, in BOTH edge shapes (kickdrum STRIKE / karplus PLUCK / snaredrum
// HIT on the one-shot; snaredrum ROLL on the held gate).
//
// ⚠ THIS FILE IS THE MERGE of `manual-strike-actions.test.ts` and the
// separately-landed `snaredrum-strike-actions.test.ts`. Nothing was dropped:
// the one-shot halves of those two suites were the same assertions over the
// same read-key string, and every snaredrum-only clause (the roll's own key,
// the latch's edge accounting, the panic path, the leak guard) is below,
// retargeted at the generic names. One seam, one suite.
//
// What it pins:
//   1. the happy paths reach the engine at the node they were handed, with the
//      STRIKE and the GATE landing on their OWN read keys (a handle that only
//      implements the one-shot must NOT answer the gate — a gate opened by a
//      seam that cannot close it is the forever-rolling drum);
//   2. every way an audition can be unavailable resolves to null rather than
//      throwing — THREE branches, not one (and not four: the header used to say
//      four while the body already explained why it is three);
//   3. neither shape writes ANYTHING to the graph. This is the property that
//      makes them safe to lean on, and the one a future refactor is most likely
//      to break by "just making it a param";
//   4. `fireManualStrike` / `setManualGate` report whether an edge actually
//      reached the engine, so a caller's press flash follows the truth and not
//      the click;
//   5. the LATCH's edge accounting survives the impure wrapper: a repeated press
//      does not re-open, a redundant release does not re-close, and the panic
//      path closes what is actually open.
//
// The engine-level twins are {kickdrum,karplus,snaredrum}-factory-strike.test.ts
// (the REAL factories' ConstantSources); the caller-wiring twin is
// manual-strike-wiring.test.ts (the REAL shell-cell registry); the DOM twins are
// e2e/tests/{kickdrum,karplus,snaredrum}-face.spec.ts, which drive the real pad
// and listen for audible RMS at the module's own output.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { patch, ydoc, undoManager, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import { setActiveEngine } from '$lib/audio/engine-ref';
import type { PatchEngine } from '$lib/audio/engine';
import { tomtomDef } from '$lib/audio/modules/tomtom';
import {
  MANUAL_GATE_KEY,
  MANUAL_STRIKE_KEY,
  __resetManualGateLatch,
  clearStuckMomentaryParams,
  fireManualStrike,
  panicManualGates,
  resolveManualGate,
  resolveManualStrike,
  setManualGate,
  setMomentaryParam,
  type StrikeEngineLike,
} from './manual-strike-actions';

const NID = 'manual-strike-test-node';
const NID2 = 'manual-strike-test-node-2';

function makeNode(id = NID, type = 'kickdrum'): ModuleNode {
  ydoc.transact(() => {
    patch.nodes[id] = {
      id,
      type,
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: { tune: 50 },
      data: {},
    } as unknown as ModuleNode;
  }, LOCAL_ORIGIN);
  return patch.nodes[id] as unknown as ModuleNode;
}

/** A fake engine answering BOTH audition keys with recorders, plus the
 *  `setParam` the PRESS-PAD shape pushes at (`sets`). */
function fakeEngine(): {
  engine: StrikeEngineLike;
  fired: string[];
  gates: string[];
  reads: string[];
  sets: string[];
} {
  const fired: string[] = [];
  const gates: string[] = [];
  const reads: string[] = [];
  const sets: string[] = [];
  return {
    fired,
    gates,
    reads,
    sets,
    engine: {
      read(node: ModuleNode, key: string): unknown {
        reads.push(`${node.id}:${key}`);
        if (key === MANUAL_STRIKE_KEY) return () => fired.push(node.id);
        if (key === MANUAL_GATE_KEY) {
          return (high: boolean) => gates.push(`${node.id}:${high ? 'hi' : 'lo'}`);
        }
        return undefined;
      },
      setParam(node: ModuleNode, paramId: string, value: number): void {
        sets.push(`${node.id}:${paramId}=${value}`);
      },
    } as StrikeEngineLike,
  };
}

function install(engine: StrikeEngineLike | null): void {
  setActiveEngine(engine as unknown as PatchEngine | null);
}

beforeEach(() => {
  __resetManualGateLatch();
});

afterEach(() => {
  install(null);
  __resetManualGateLatch();
  ydoc.transact(() => {
    for (const id of [NID, NID2]) if (patch.nodes[id]) delete patch.nodes[id];
  }, LOCAL_ORIGIN);
});

describe('manual audition — resolution (PURE, injected engine + node)', () => {
  it('resolves the STRIKE and the GATE off their OWN keys, and fires the strike once', () => {
    const node = { id: 'kd-1' } as unknown as ModuleNode;
    const { engine, fired, reads } = fakeEngine();

    const strike = resolveManualStrike(engine, node);
    expect(strike, 'a live engine + node resolves a callable strike').toBeTypeOf('function');
    expect(resolveManualGate(engine, node)).toBeTypeOf('function');
    expect(reads, 'each resolver asks for its OWN read key on THIS node').toEqual([
      `kd-1:${MANUAL_STRIKE_KEY}`,
      `kd-1:${MANUAL_GATE_KEY}`,
    ]);

    strike!();
    expect(fired).toEqual(['kd-1']);
    strike!();
    expect(fired, 'each call is one strike — no latching, no repeat').toEqual(['kd-1', 'kd-1']);
  });

  it('THE KEYS ARE DISTINCT — a handle answering ONLY the strike key yields NO gate', () => {
    // The dangerous fallback. If `resolveManualGate` ever fell back to the
    // strike key, holding a ROLL pad would fire one 5 ms pulse, the pad would
    // report "rolling" over a drum that is not, and the release would do
    // nothing. Also pins that the two constants are not the same string — they
    // WERE, across the two pre-merge modules, and that is what made the one-shot
    // halves a copy rather than a variant.
    expect(MANUAL_STRIKE_KEY).not.toBe(MANUAL_GATE_KEY);
    const strikeOnly: StrikeEngineLike = {
      read: (_n, key) => (key === MANUAL_STRIKE_KEY ? () => {} : undefined),
    };
    const n = { id: 'sd-1' } as unknown as ModuleNode;
    expect(resolveManualStrike(strikeOnly, n)).toBeTypeOf('function');
    expect(resolveManualGate(strikeOnly, n)).toBeNull();
  });

  it('returns null for each of the THREE distinct unavailable branches, on BOTH shapes', () => {
    // ⚠ IT SAID **FOUR**, AND THERE ARE THREE. The old (c) `read: () => 42` and
    // (d) `read: () => undefined` fall through the IDENTICAL guard
    // (`typeof fn === 'function'` in resolveKey) — one deletion reds both, which
    // is what "distinct" is supposed to rule out. Listing a branch count the code
    // does not have is how a suite reads as more thorough than it is. Kept as
    // three named branches plus an explicitly-labelled shape sweep over the
    // fourth.
    const node = { id: 'kd-1' } as unknown as ModuleNode;
    const { engine } = fakeEngine();

    // (a) no engine — the AudioContext has not booted, nothing can sound yet.
    expect(resolveManualStrike(null, node)).toBeNull();
    expect(resolveManualStrike(undefined, node)).toBeNull();
    expect(resolveManualGate(null, node)).toBeNull();
    expect(resolveManualGate(undefined, node)).toBeNull();
    // (b) no node — the module was removed between render and press.
    expect(resolveManualStrike(engine, undefined)).toBeNull();
    expect(resolveManualGate(engine, undefined)).toBeNull();
    // (c) the handle answers the key with a NON-FUNCTION. One branch, several
    //     shapes: a half-implemented seam (42), an unimplemented one
    //     (undefined), a truthy object, null, a string.
    for (const v of [42, undefined, null, {}, 'fn']) {
      expect(resolveManualStrike({ read: () => v }, node), `strike, read → ${String(v)}`).toBeNull();
      expect(resolveManualGate({ read: () => v }, node), `gate, read → ${String(v)}`).toBeNull();
    }
  });
});

describe('manual audition — the ONE-SHOT wiring (fireManualStrike)', () => {
  it('fires at the LIVE node and reports true', () => {
    const f = fakeEngine();
    install(f.engine);
    makeNode();

    expect(fireManualStrike(NID)).toBe(true);
    expect(f.fired).toEqual([NID]);
  });

  it('is a NO-OP (false, no throw) with no engine, and for an unknown node id', () => {
    install(null);
    makeNode();
    expect(fireManualStrike(NID)).toBe(false);

    const f = fakeEngine();
    install(f.engine);
    expect(fireManualStrike('no-such-node')).toBe(false);
    expect(f.fired).toEqual([]);
  });
});

describe('manual audition — the HELD GATE wiring (setManualGate)', () => {
  it('sends ONE high edge and ONE low edge for a press/release pair', () => {
    const f = fakeEngine();
    install(f.engine);
    makeNode(NID, 'snaredrum');
    expect(setManualGate(NID, true)).toBe(true);
    expect(setManualGate(NID, false)).toBe(true);
    expect(f.gates).toEqual([`${NID}:hi`, `${NID}:lo`]);
  });

  it('a REPEATED press does not re-open, and a redundant release does not re-close', () => {
    // Both happen for real: keyboard auto-repeat on the press side, and on the
    // release side the <Button>'s own onGate(false) AND the window-level panic
    // firing on the same pointerup.
    const f = fakeEngine();
    install(f.engine);
    makeNode(NID, 'snaredrum');
    expect(setManualGate(NID, true)).toBe(true);
    expect(setManualGate(NID, true), 'the second press is a no-op').toBe(false);
    expect(setManualGate(NID, false)).toBe(true);
    expect(setManualGate(NID, false), 'the redundant release is a no-op').toBe(false);
    expect(f.gates, 'exactly one edge each way reached the engine').toEqual([
      `${NID}:hi`,
      `${NID}:lo`,
    ]);
  });

  it('PANIC closes every open gate, once, and is idempotent', () => {
    const f = fakeEngine();
    install(f.engine);
    makeNode(NID, 'snaredrum');
    makeNode(NID2, 'snaredrum');
    setManualGate(NID, true);
    setManualGate(NID2, true);
    f.gates.length = 0;

    expect(panicManualGates().sort()).toEqual([NID, NID2].sort());
    expect(f.gates.sort()).toEqual([`${NID}:lo`, `${NID2}:lo`].sort());

    f.gates.length = 0;
    expect(panicManualGates(), 'a second panic has nothing to close').toEqual([]);
    expect(f.gates).toEqual([]);
  });

  it('a release with the engine GONE clears the latch, so a later panic is not a phantom close', () => {
    const f = fakeEngine();
    install(f.engine);
    makeNode(NID, 'snaredrum');
    setManualGate(NID, true);
    install(null); // the AudioContext went away mid-hold
    expect(setManualGate(NID, false), 'nothing could be sent').toBe(false);
    install(f.engine);
    f.gates.length = 0;
    expect(panicManualGates(), 'the latch no longer thinks this node is open').toEqual([]);
    expect(f.gates).toEqual([]);
  });
});

describe('manual audition — the LEAK GUARD is really installed and really fires', () => {
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

  it('a held gate registers the four release listeners, once', () => {
    const f = fakeEngine();
    install(f.engine);
    makeNode(NID, 'snaredrum');
    withFakeWindow((listeners) => {
      setManualGate(NID, true);
      expect([...listeners.keys()].sort()).toEqual(
        ['blur', 'pointercancel', 'pointerup', 'visibilitychange'].sort(),
      );
      // A second hold must not stack another set (they are process-wide).
      setManualGate(NID, false);
      setManualGate(NID, true);
      for (const [type, cbs] of listeners) expect(cbs, `${type} registered once`).toHaveLength(1);
    });
  });

  it('the ONE-SHOT installs NOTHING — the held machinery is free to a trigger-only module', () => {
    // The load-bearing half of the merge argument (this seam's header, point 2):
    // folding the gate shape in here must not make kickdrum/karplus start
    // registering window listeners. `ensurePanicListeners` is reached only from
    // the `high` branch of setManualGate, and this is what proves it.
    const f = fakeEngine();
    install(f.engine);
    makeNode();
    withFakeWindow((listeners) => {
      expect(fireManualStrike(NID)).toBe(true);
      expect([...listeners.keys()], 'a one-shot audition installs no leak guard').toEqual([]);
    });
  });

  it('a window POINTERUP the button never saw still closes the gate', () => {
    // The leak this exists for: the pane closes (or the module is deleted)
    // mid-hold, so the <Button> unmounts and no pointerup ever reaches it.
    const f = fakeEngine();
    install(f.engine);
    makeNode(NID, 'snaredrum');
    withFakeWindow((listeners) => {
      setManualGate(NID, true);
      f.gates.length = 0;
      for (const cb of listeners.get('pointerup') ?? []) cb();
      expect(f.gates, 'the window-level release closed the gate').toEqual([`${NID}:lo`]);
      // …and the state agrees, so a later panic is not a phantom close.
      f.gates.length = 0;
      expect(panicManualGates()).toEqual([]);
      expect(f.gates).toEqual([]);
    });
  });

  it('NEGATIVE CONTROL: with NO window the hold still works and simply installs nothing', () => {
    // The guard is feature-detected, so a partial `window` (the unit lane leaves
    // one behind) must not throw — and the audition must still function.
    const f = fakeEngine();
    install(f.engine);
    makeNode(NID, 'snaredrum');
    const g = globalThis as unknown as Record<string, unknown>;
    const had = 'window' in g;
    const prev = g['window'];
    g['window'] = {}; // present, but with no addEventListener — the real shape
    try {
      expect(() => setManualGate(NID, true)).not.toThrow();
      expect(f.gates).toEqual([`${NID}:hi`]);
      expect(setManualGate(NID, false)).toBe(true);
    } finally {
      if (had) g['window'] = prev; else delete g['window'];
    }
  });
});

describe('manual audition — the graph is NOT touched', () => {
  it('NO shape writes a param, a data key, or a node — including the press-pad', () => {
    const f = fakeEngine();
    install(f.engine);
    makeNode(NID, 'snaredrum');
    const before = JSON.stringify({
      params: patch.nodes[NID]!.params,
      data: (patch.nodes[NID] as unknown as ModuleNode).data,
      keys: Object.keys(patch.nodes).sort(),
    });

    fireManualStrike(NID);
    fireManualStrike(NID);
    setManualGate(NID, true);
    setManualGate(NID, false);
    // THE REGRESSION. This is the shape that DID write the Y.Doc, and it is
    // why a rack could be saved with tomtom's STRIKE stuck at 1 — permanently
    // masking `trigger_in`, because the worklet ORs pad and jack as LEVELS.
    setMomentaryParam(NID, 'strike', true);
    setMomentaryParam(NID, 'strike', false);
    panicManualGates();

    const after = JSON.stringify({
      params: patch.nodes[NID]!.params,
      data: (patch.nodes[NID] as unknown as ModuleNode).data,
      keys: Object.keys(patch.nodes).sort(),
    });
    expect(after, 'an audition must never reach the Y.Doc (no persist, no undo, no sync)').toBe(
      before,
    );
    // …and the negative control: it DID reach the engine, so "nothing was
    // written" is not passing because nothing happened at all.
    expect(f.sets).toEqual([`${NID}:strike=1`, `${NID}:strike=0`]);
  });
});

// ── THE PRESS-PAD (setMomentaryParam / clearStuckMomentaryParams) ───────────

describe('press-pad — the engine gets the edge, the document gets nothing', () => {
  it('pushes 1 on press and the REST value on release', () => {
    const f = fakeEngine();
    install(f.engine);
    makeNode(NID, 'tomtom');
    expect(setMomentaryParam(NID, 'strike', true, 0)).toBe(true);
    expect(setMomentaryParam(NID, 'strike', false, 0)).toBe(true);
    expect(f.sets).toEqual([`${NID}:strike=1`, `${NID}:strike=0`]);
  });

  it('rest is whatever the CALLER declares, not a hardcoded 0', () => {
    const f = fakeEngine();
    install(f.engine);
    makeNode(NID, 'tomtom');
    setMomentaryParam(NID, 'strike', true, 0.25);
    setMomentaryParam(NID, 'strike', false, 0.25);
    expect(f.sets).toEqual([`${NID}:strike=1`, `${NID}:strike=0.25`]);
  });

  it('a repeated press does not re-fire, and a redundant release does not re-push', () => {
    // Keyboard auto-repeat sends a stream of pointerdown-equivalents; the pad
    // must not schedule a second AudioParam event at the same context time.
    const f = fakeEngine();
    install(f.engine);
    makeNode(NID, 'tomtom');
    expect(setMomentaryParam(NID, 'strike', true, 0)).toBe(true);
    expect(setMomentaryParam(NID, 'strike', true, 0)).toBe(false);
    expect(setMomentaryParam(NID, 'strike', false, 0)).toBe(true);
    expect(setMomentaryParam(NID, 'strike', false, 0)).toBe(false);
    expect(f.sets).toEqual([`${NID}:strike=1`, `${NID}:strike=0`]);
  });

  it('two pads on the SAME node do not steal each other\'s release', () => {
    // The reason this uses its own latch instead of the gate latch, whose
    // header states the constraint: keyed by node id, one held thing per node.
    const f = fakeEngine();
    install(f.engine);
    makeNode(NID, 'tidyVco');
    setMomentaryParam(NID, 'hold', true, 0);
    setMomentaryParam(NID, 'strike', true, 0);
    setMomentaryParam(NID, 'hold', false, 0);
    // `strike` is still held — a shared node-keyed latch would have closed it.
    expect(setMomentaryParam(NID, 'strike', false, 0)).toBe(true);
    expect(f.sets).toEqual([
      `${NID}:hold=1`, `${NID}:strike=1`, `${NID}:hold=0`, `${NID}:strike=0`,
    ]);
  });

  it('THE PANIC PATH releases a pad whose button never saw the pointerup', () => {
    // The whole failure mode, reproduced: the surface goes away mid-hold and
    // the release edge is lost. Under the old code that left a DURABLE 1 in
    // the Y.Doc; now the window-level listeners the seam installs push rest at
    // the engine instead, and there was never anything durable to leak.
    const f = fakeEngine();
    install(f.engine);
    makeNode(NID, 'tomtom');
    setMomentaryParam(NID, 'strike', true, 0);
    expect(f.sets).toEqual([`${NID}:strike=1`]);
    expect(panicManualGates()).toEqual([`${NID} strike`]);
    expect(f.sets).toEqual([`${NID}:strike=1`, `${NID}:strike=0`]);
    // Idempotent — a second panic (pointerup AND blur both fire) is a no-op.
    expect(panicManualGates()).toEqual([]);
    expect(f.sets).toHaveLength(2);
  });

  it('a press with NO engine leaves the latch clean (a later panic must not "release" it)', () => {
    install(null);
    makeNode(NID, 'tomtom');
    expect(setMomentaryParam(NID, 'strike', true, 0)).toBe(false);
    expect(panicManualGates()).toEqual([]);
  });
});

describe('press-pad — REPAIRING a rack already saved with the pad stuck', () => {
  /** Save the node the way a lost release left it: `strike` durable at 1. */
  function makeStuckTomtom(): void {
    ydoc.transact(() => {
      patch.nodes[NID] = {
        id: NID,
        type: 'tomtom',
        domain: 'audio',
        position: { x: 0, y: 0 },
        params: { strike: 1, tune: 180 },
        data: {},
      } as unknown as ModuleNode;
    }, LOCAL_ORIGIN);
  }

  it('clears the stuck pad, reports it, and touches nothing else', () => {
    makeStuckTomtom();
    expect(patch.nodes[NID]!.params.strike).toBe(1);
    expect(clearStuckMomentaryParams(NID, tomtomDef)).toEqual(['strike']);
    expect(patch.nodes[NID]!.params.strike).toBe(0);
    expect(patch.nodes[NID]!.params.tune, 'the rack\'s knobs are not a repair target').toBe(180);
  });

  it('is a NO-OP on a healthy node, and on a module with no press-pad at all', () => {
    makeNode(NID, 'tomtom'); // params: { tune: 50 } — no strike key
    expect(clearStuckMomentaryParams(NID, tomtomDef)).toEqual([]);
    makeNode(NID2, 'kickdrum');
    expect(clearStuckMomentaryParams(NID2, undefined)).toEqual([]);
  });

  it('the repair is NOT an undo entry — Cmd-Z must not restore the broken state', () => {
    // A tracked repair would let one Cmd-Z put `strike: 1` back and re-brick
    // the module, which is worse than leaving it: the user would have no idea
    // what they had just done.
    makeStuckTomtom();
    undoManager.clear();
    undoManager.stopCapturing();
    const depth = undoManager.undoStack.length;
    clearStuckMomentaryParams(NID, tomtomDef);
    expect(undoManager.undoStack.length, 'the repair must not land on the undo stack').toBe(depth);
    expect(patch.nodes[NID]!.params.strike).toBe(0);
  });

  it('a node that is gone is a no-op, not a throw', () => {
    expect(clearStuckMomentaryParams('no-such-node', tomtomDef)).toEqual([]);
  });
});
