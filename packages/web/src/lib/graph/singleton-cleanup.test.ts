// packages/web/src/lib/graph/singleton-cleanup.test.ts
//
// Unit tests for the PURE Phase 4c post-merge singleton-cleanup helpers
// (graph/singleton-cleanup.ts). No Yjs / Svelte — plain fake node maps,
// fake defs, and fake awareness peers.
//
// The MULTI-PEER no-double-delete *integration* proof (two real Y.Docs that
// concurrently insert the singleton, sync, then run the converged cleanup) lives
// in graph/singleton-cleanup-ydoc.test.ts — that one is the self-merge gate.

import { describe, it, expect } from 'vitest';
import {
  planSingletonCleanup,
  electDeleter,
  isElectedDeleter,
  isSafeToDelete,
  isTypeLevelCapped,
  PER_USER_CAPPED_TYPES,
  type IdentifiedNode,
  type CleanupDef,
  type CleanupPeer,
} from './singleton-cleanup';

/** Build a `{ id: node }` record from (id, type) pairs. */
function nodeMap(
  entries: Array<[id: string, type: string]>,
): Record<string, IdentifiedNode> {
  const m: Record<string, IdentifiedNode> = {};
  for (const [id, type] of entries) m[id] = { id, type };
  return m;
}

// A tiny def table: TIMELORDE is the singleton undeletable ghost case; DOOM is
// a deletable maxInstances:1; SYNTH is a cap-of-2; VCO is uncapped; PICTUREBOX
// is per-user-capped (must be excluded despite carrying maxInstances).
const DEFS: Record<string, CleanupDef> = {
  timelorde: { type: 'timelorde', maxInstances: 1, undeletable: true },
  doom: { type: 'doom', maxInstances: 1 },
  synth: { type: 'synth', maxInstances: 2 },
  vco: { type: 'vco' }, // uncapped
  picturebox: { type: 'picturebox', maxInstances: 8 }, // per-user → excluded
  cameraInput: { type: 'cameraInput', maxInstances: 4 }, // per-user → excluded
};
const defForType = (t: string): CleanupDef | undefined => DEFS[t];

describe('isTypeLevelCapped', () => {
  it('is true for a finite type-level maxInstances >= 1', () => {
    expect(isTypeLevelCapped(DEFS.timelorde)).toBe(true);
    expect(isTypeLevelCapped(DEFS.doom)).toBe(true);
    expect(isTypeLevelCapped(DEFS.synth)).toBe(true);
  });
  it('is false for an uncapped def / null / undefined', () => {
    expect(isTypeLevelCapped(DEFS.vco)).toBe(false);
    expect(isTypeLevelCapped(null)).toBe(false);
    expect(isTypeLevelCapped(undefined)).toBe(false);
  });
  it('is false for the per-user-capped types even though they carry maxInstances', () => {
    expect(isTypeLevelCapped(DEFS.picturebox)).toBe(false);
    expect(isTypeLevelCapped(DEFS.cameraInput)).toBe(false);
    // sanity: those types are exactly the documented exclusion set.
    expect(PER_USER_CAPPED_TYPES.has('picturebox')).toBe(true);
    expect(PER_USER_CAPPED_TYPES.has('cameraInput')).toBe(true);
    expect(PER_USER_CAPPED_TYPES.has('samsloop')).toBe(true);
  });
  it('treats a cap of 0 / NaN / negative as no cap', () => {
    expect(isTypeLevelCapped({ type: 'x', maxInstances: 0 })).toBe(false);
    expect(isTypeLevelCapped({ type: 'x', maxInstances: Number.NaN })).toBe(false);
    expect(isTypeLevelCapped({ type: 'x', maxInstances: -1 })).toBe(false);
  });
});

describe('planSingletonCleanup', () => {
  it('1 node of a maxInstances:1 type → no-op (empty plan)', () => {
    const nodes = nodeMap([['timelorde-a', 'timelorde']]);
    expect(planSingletonCleanup(nodes, defForType)).toEqual([]);
  });

  it('2 nodes of a maxInstances:1 type → deletes exactly the lex-larger, keeps lex-smaller', () => {
    const nodes = nodeMap([
      ['timelorde-zzz', 'timelorde'],
      ['timelorde-aaa', 'timelorde'],
    ]);
    const plan = planSingletonCleanup(nodes, defForType);
    expect(plan).toHaveLength(1);
    expect(plan[0].id).toBe('timelorde-zzz'); // lex-larger → deleted
    expect(plan[0].keptId).toBe('timelorde-aaa'); // lex-smaller → survives
    expect(plan[0].type).toBe('timelorde');
    expect(plan[0].undeletable).toBe(true);
  });

  it('3 nodes of a maxInstances:1 type → keeps exactly 1 (lex-smallest), deletes 2', () => {
    const nodes = nodeMap([
      ['timelorde-m', 'timelorde'],
      ['timelorde-a', 'timelorde'],
      ['timelorde-z', 'timelorde'],
    ]);
    const plan = planSingletonCleanup(nodes, defForType);
    expect(plan.map((d) => d.id)).toEqual(['timelorde-m', 'timelorde-z']);
    for (const d of plan) expect(d.keptId).toBe('timelorde-a');
    // the survivor is NOT in the deletion set
    expect(plan.some((d) => d.id === 'timelorde-a')).toBe(false);
  });

  it('respects a cap > 1: 3 nodes of a cap-2 type → keeps the 2 lex-smallest, deletes 1', () => {
    const nodes = nodeMap([
      ['synth-3', 'synth'],
      ['synth-1', 'synth'],
      ['synth-2', 'synth'],
    ]);
    const plan = planSingletonCleanup(nodes, defForType);
    expect(plan).toHaveLength(1);
    expect(plan[0].id).toBe('synth-3'); // only the lex-largest beyond cap=2
    expect(plan[0].keptId).toBe('synth-1');
  });

  it('uncapped type → never planned even with many instances', () => {
    const nodes = nodeMap([
      ['vco-1', 'vco'],
      ['vco-2', 'vco'],
      ['vco-3', 'vco'],
    ]);
    expect(planSingletonCleanup(nodes, defForType)).toEqual([]);
  });

  it('per-user-capped types are NEVER planned even when over their numeric cap', () => {
    // 3 pictureboxes (numeric cap 8 not even reached, but the point is the type
    // is excluded regardless of count) AND 5 cameras → both excluded.
    const nodes = nodeMap([
      ['picturebox-1', 'picturebox'],
      ['picturebox-2', 'picturebox'],
      ['cameraInput-1', 'cameraInput'],
      ['cameraInput-2', 'cameraInput'],
      ['cameraInput-3', 'cameraInput'],
      ['cameraInput-4', 'cameraInput'],
      ['cameraInput-5', 'cameraInput'], // over cap 4, still excluded
    ]);
    expect(planSingletonCleanup(nodes, defForType)).toEqual([]);
  });

  it('handles MULTIPLE over-cap types in one pass, output stably sorted', () => {
    const nodes = nodeMap([
      ['doom-b', 'doom'],
      ['doom-a', 'doom'],
      ['timelorde-y', 'timelorde'],
      ['timelorde-x', 'timelorde'],
      ['vco-1', 'vco'], // uncapped, untouched
    ]);
    const plan = planSingletonCleanup(nodes, defForType);
    // sorted by (type, id): doom before timelorde
    expect(plan.map((d) => `${d.type}:${d.id}`)).toEqual([
      'doom:doom-b',
      'timelorde:timelorde-y',
    ]);
  });

  it('skips null/undefined holes and nodes whose def is unknown', () => {
    const nodes: Record<string, IdentifiedNode | null | undefined> = {
      'timelorde-a': { id: 'timelorde-a', type: 'timelorde' },
      'timelorde-b': { id: 'timelorde-b', type: 'timelorde' },
      hole1: null,
      hole2: undefined,
      'mystery-1': { id: 'mystery-1', type: 'no-such-def' },
      'mystery-2': { id: 'mystery-2', type: 'no-such-def' },
    };
    const plan = planSingletonCleanup(nodes, defForType);
    expect(plan).toHaveLength(1);
    expect(plan[0].id).toBe('timelorde-b');
  });

  it('is IDEMPOTENT — re-running after applying the plan yields an empty plan', () => {
    const nodes = nodeMap([
      ['timelorde-z', 'timelorde'],
      ['timelorde-a', 'timelorde'],
      ['timelorde-m', 'timelorde'],
    ]);
    const plan1 = planSingletonCleanup(nodes, defForType);
    for (const d of plan1) delete nodes[d.id]; // apply
    expect(planSingletonCleanup(nodes, defForType)).toEqual([]);
    // exactly one survivor remains, and it's the lex-smallest.
    expect(Object.keys(nodes)).toEqual(['timelorde-a']);
  });
});

describe('electDeleter', () => {
  it('returns null for an empty peer roster', () => {
    expect(electDeleter([])).toBeNull();
  });
  it('picks the lex-min clientID when there is no owner', () => {
    const peers: CleanupPeer[] = [
      { clientID: 30 },
      { clientID: 10 },
      { clientID: 20 },
    ];
    expect(electDeleter(peers)).toBe(10);
  });
  it('prefers an owner over a lower-id non-owner (owner-preferred)', () => {
    const peers: CleanupPeer[] = [
      { clientID: 5, isRackOwner: false },
      { clientID: 99, isRackOwner: true }, // owner, but highest id
      { clientID: 7 },
    ];
    expect(electDeleter(peers)).toBe(99);
  });
  it('among multiple owners, picks the lex-min owner clientID', () => {
    const peers: CleanupPeer[] = [
      { clientID: 80, isRackOwner: true },
      { clientID: 40, isRackOwner: true },
      { clientID: 1, isRackOwner: false },
    ];
    expect(electDeleter(peers)).toBe(40);
  });
});

describe('isElectedDeleter (only the elected peer acts)', () => {
  const peers: CleanupPeer[] = [
    { clientID: 10 },
    { clientID: 20 },
    { clientID: 30 },
  ];

  it('single-user / no provider (localClientID == null) → always the deleter', () => {
    expect(isElectedDeleter(null, [])).toBe(true);
    expect(isElectedDeleter(undefined, [])).toBe(true);
  });

  it('the elected (lex-min) peer acts; the others do NOT', () => {
    expect(isElectedDeleter(10, peers)).toBe(true); // elected
    expect(isElectedDeleter(20, peers)).toBe(false);
    expect(isElectedDeleter(30, peers)).toBe(false);
  });

  it('with an owner present, only the owner peer acts regardless of id order', () => {
    const withOwner: CleanupPeer[] = [
      { clientID: 5 },
      { clientID: 50, isRackOwner: true },
      { clientID: 7 },
    ];
    expect(isElectedDeleter(50, withOwner)).toBe(true);
    expect(isElectedDeleter(5, withOwner)).toBe(false);
    expect(isElectedDeleter(7, withOwner)).toBe(false);
  });

  it('a local id with no peers known yet still acts (in-transact recheck backstops)', () => {
    expect(isElectedDeleter(42, [])).toBe(true);
  });
});

describe('isSafeToDelete (in-transact never-delete-last guard)', () => {
  it('refuses when only one node of the type remains (would drop to zero)', () => {
    const live = nodeMap([['timelorde-a', 'timelorde']]);
    expect(isSafeToDelete(live, 'timelorde-a', 'timelorde')).toBe(false);
  });
  it('allows deleting a surplus while another remains', () => {
    const live = nodeMap([
      ['timelorde-a', 'timelorde'],
      ['timelorde-b', 'timelorde'],
    ]);
    expect(isSafeToDelete(live, 'timelorde-b', 'timelorde')).toBe(true);
  });
  it('refuses when the node is already gone (rack-mate deleted it)', () => {
    const live = nodeMap([['timelorde-a', 'timelorde']]);
    expect(isSafeToDelete(live, 'timelorde-gone', 'timelorde')).toBe(false);
  });
  it('refuses when the id now points at a different type', () => {
    const live = nodeMap([
      ['timelorde-a', 'timelorde'],
      ['x', 'vco'], // id "x" is a vco now
    ]);
    expect(isSafeToDelete(live, 'x', 'timelorde')).toBe(false);
  });
});

describe('pinned nodes are never planned (workflow P1)', () => {
  it('a pinned instance + a canvas instance of a maxInstances:1 type is NOT over-cap', () => {
    // Workflow rack steady state: pinned ELECTRA CONTROL (drawer) + one
    // user-spawned canvas instance. The pinned one is outside the cap
    // economy — the cleanup must not lex-delete either.
    const nodes = {
      'electraControl-zz': { id: 'electraControl-zz', type: 'electraControl' },
      'pinned-electraControl': {
        id: 'pinned-electraControl',
        type: 'electraControl',
        data: { pinned: true },
      },
    };
    const defs = (type: string) =>
      type === 'electraControl' ? { type, maxInstances: 1 } : undefined;
    expect(planSingletonCleanup(nodes, defs)).toEqual([]);
  });

  it('surplus among UNPINNED instances still cleans up, pinned untouched', () => {
    const nodes = {
      'electraControl-bb': { id: 'electraControl-bb', type: 'electraControl' },
      'electraControl-aa': { id: 'electraControl-aa', type: 'electraControl' },
      'pinned-electraControl': {
        id: 'pinned-electraControl',
        type: 'electraControl',
        data: { pinned: true },
      },
    };
    const defs = (type: string) =>
      type === 'electraControl' ? { type, maxInstances: 1 } : undefined;
    const plan = planSingletonCleanup(nodes, defs);
    // lex-smallest UNPINNED survives; pinned never appears in the plan.
    expect(plan).toEqual([
      {
        id: 'electraControl-bb',
        type: 'electraControl',
        keptId: 'electraControl-aa',
        undeletable: false,
      },
    ]);
  });
});
