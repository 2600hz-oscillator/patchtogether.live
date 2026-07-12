// packages/web/src/lib/graph/workflow-pins.test.ts
//
// WORKFLOW MODE P1 — pinned-singleton planning + drawer keymap + the
// keyboard typing guard. P2 — the always-on topbar SURFACE pins
// (timelorde / midiclock / audioIn / audioOut) and their presence rules.
// Pure-unit (plain fixtures, no DOM, no Yjs).

import { describe, it, expect } from 'vitest';
import {
  WORKFLOW_PINNED_MODULES,
  WORKFLOW_PINNED_SURFACES,
  ALL_WORKFLOW_PINNED,
  WORKFLOW_DEFAULT_WIRES,
  WORKFLOW_DEFAULT_WIRE_LATCH,
  DRAWER_KEY_TO_PINNED,
  planPinnedSpawns,
  planDefaultWires,
  isPinnedNode,
  isTypingTarget,
} from './workflow-pins';

/** Fixture: every always-on module present in its pinned form. */
function fullPinnedSet() {
  return ALL_WORKFLOW_PINNED.map((s) => ({ type: s.type, data: { pinned: true } }));
}

describe('WORKFLOW_PINNED_MODULES — the M/E/C trio contract', () => {
  it('is exactly mixmstrs + electraControl + clipplayer with deterministic ids', () => {
    expect(WORKFLOW_PINNED_MODULES.map((s) => [s.key, s.type, s.id])).toEqual([
      ['m', 'mixmstrs', 'pinned-mixmstrs'],
      ['e', 'electraControl', 'pinned-electraControl'],
      ['c', 'clipplayer', 'pinned-clipplayer'],
    ]);
  });

  it('drawer keymap covers every spec, keyed lowercase', () => {
    expect(DRAWER_KEY_TO_PINNED.size).toBe(WORKFLOW_PINNED_MODULES.length);
    expect(DRAWER_KEY_TO_PINNED.get('m')?.type).toBe('mixmstrs');
    expect(DRAWER_KEY_TO_PINNED.get('e')?.type).toBe('electraControl');
    expect(DRAWER_KEY_TO_PINNED.get('c')?.type).toBe('clipplayer');
    expect(DRAWER_KEY_TO_PINNED.get('M')).toBeUndefined(); // callers lowercase first
  });
});

describe('WORKFLOW_PINNED_SURFACES — the P2 topbar surface contract', () => {
  it('is timelorde + midiclock + audioIn + audioOut with deterministic ids', () => {
    expect(WORKFLOW_PINNED_SURFACES.map((s) => [s.type, s.id, s.presence ?? 'pinned'])).toEqual([
      ['timelorde', 'pinned-timelorde', 'type'],
      ['midiclock', 'pinned-midiclock', 'pinned'],
      ['audioIn', 'pinned-audioIn', 'pinned'],
      ['audioOut', 'pinned-audioOut', 'pinned'],
    ]);
  });

  it('surface pins have NO drawer key (their faces are topbar menus)', () => {
    for (const s of WORKFLOW_PINNED_SURFACES) {
      expect('key' in s).toBe(false);
    }
    // The drawer keymap stays trio-only.
    expect(DRAWER_KEY_TO_PINNED.size).toBe(WORKFLOW_PINNED_MODULES.length);
  });

  it('ALL_WORKFLOW_PINNED is trio-then-surfaces with globally unique ids', () => {
    expect(ALL_WORKFLOW_PINNED.map((s) => s.type)).toEqual([
      'mixmstrs',
      'electraControl',
      'clipplayer',
      'timelorde',
      'midiclock',
      'audioIn',
      'audioOut',
    ]);
    const ids = ALL_WORKFLOW_PINNED.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of ALL_WORKFLOW_PINNED) expect(s.id).toBe(`pinned-${s.type}`);
  });
});

describe('planPinnedSpawns', () => {
  it('an empty rack plans every always-on module, trio first', () => {
    expect(planPinnedSpawns([]).map((s) => s.type)).toEqual([
      'mixmstrs',
      'electraControl',
      'clipplayer',
      'timelorde',
      'midiclock',
      'audioIn',
      'audioOut',
    ]);
  });

  it('plans only the missing specs', () => {
    const nodes = fullPinnedSet().filter((n) => n.type !== 'electraControl');
    expect(planPinnedSpawns(nodes).map((s) => s.type)).toEqual(['electraControl']);
  });

  it('a full pinned set plans nothing (the ensure is idempotent)', () => {
    expect(planPinnedSpawns(fullPinnedSet())).toEqual([]);
  });

  it('UNPINNED instances do NOT satisfy presence:"pinned" specs', () => {
    // A user-spawned canvas mixmstrs / audioIn is a normal card, not the
    // always-on hidden one.
    const nodes = [
      { type: 'mixmstrs', data: {} },
      { type: 'electraControl' },
      { type: 'clipplayer', data: { pinned: false } },
      { type: 'audioIn', data: {} },
      { type: 'audioOut', data: {} },
      { type: 'midiclock', data: {} },
    ];
    expect(planPinnedSpawns(nodes).map((s) => s.type)).toEqual([
      'mixmstrs',
      'electraControl',
      'clipplayer',
      'timelorde',
      'midiclock',
      'audioIn',
      'audioOut',
    ]);
  });

  it('an UNPINNED canvas timelorde DOES satisfy the presence:"type" spec', () => {
    // A dawless-authored patch loaded into a workflow rack carries a
    // random-id canvas TIMELORDE; it is the rack clock (maxInstances=1) —
    // no hidden competitor may spawn.
    const nodes = [
      ...fullPinnedSet().filter((n) => n.type !== 'timelorde'),
      { type: 'timelorde', data: {} },
    ];
    expect(planPinnedSpawns(nodes)).toEqual([]);
  });

  it('a PINNED timelorde satisfies the presence:"type" spec too', () => {
    expect(planPinnedSpawns(fullPinnedSet())).toEqual([]);
  });
});

describe('WORKFLOW_DEFAULT_WIRES — the mixmstrs→audioOut default-wire contract', () => {
  it('is exactly master L/R → audioOut L/R with deterministic e-… ids', () => {
    // Port ids are pinned to the defs: mixmstrs outputs masterL/masterR
    // (mixmstrs.ts), audioOut inputs L/R (audio-out.ts). The id template is
    // the SAME `e-<src>-<srcPort>-<dst>-<dstPort>` handleConnect writes, so
    // racing clients converge on one Y.Map entry per wire.
    expect(WORKFLOW_DEFAULT_WIRES).toEqual([
      {
        id: 'e-pinned-mixmstrs-masterL-pinned-audioOut-L',
        source: { nodeId: 'pinned-mixmstrs', portId: 'masterL' },
        target: { nodeId: 'pinned-audioOut', portId: 'L' },
        sourceType: 'audio',
        targetType: 'audio',
      },
      {
        id: 'e-pinned-mixmstrs-masterR-pinned-audioOut-R',
        source: { nodeId: 'pinned-mixmstrs', portId: 'masterR' },
        target: { nodeId: 'pinned-audioOut', portId: 'R' },
        sourceType: 'audio',
        targetType: 'audio',
      },
    ]);
  });
});

describe('planDefaultWires — one-shot seed, never re-fight the user', () => {
  const mix = { id: 'pinned-mixmstrs', data: { pinned: true } };
  const out = { id: 'pinned-audioOut', data: { pinned: true } };

  it('plans both wires + the latch when both pins exist and nothing is latched', () => {
    const plan = planDefaultWires([mix, out], []);
    expect(plan.latch).toBe(true);
    expect(plan.wires).toEqual([...WORKFLOW_DEFAULT_WIRES]);
  });

  it('plans NOTHING while either endpoint is still missing (replan later, no latch burn)', () => {
    expect(planDefaultWires([mix], [])).toEqual({ wires: [], latch: false });
    expect(planDefaultWires([out], [])).toEqual({ wires: [], latch: false });
    expect(planDefaultWires([], [])).toEqual({ wires: [], latch: false });
  });

  it('the latch on the pinned audioOut suppresses re-seeding forever (user delete respected)', () => {
    const latched = { id: 'pinned-audioOut', data: { pinned: true, [WORKFLOW_DEFAULT_WIRE_LATCH]: true } };
    // Even with ZERO edges present — i.e. the user deleted the default
    // cables — a latched audioOut plans nothing.
    expect(planDefaultWires([mix, latched], [])).toEqual({ wires: [], latch: false });
  });

  it('a non-boolean latch value does not count (strict === true)', () => {
    const weird = { id: 'pinned-audioOut', data: { [WORKFLOW_DEFAULT_WIRE_LATCH]: 'yes' } };
    expect(planDefaultWires([mix, weird], []).latch).toBe(true);
  });

  it('skips a wire whose target input is already occupied (never replace a user patch)', () => {
    const edges = [{ target: { nodeId: 'pinned-audioOut', portId: 'L' } }];
    const plan = planDefaultWires([mix, out], edges);
    expect(plan.latch).toBe(true);
    expect(plan.wires.map((w) => w.target.portId)).toEqual(['R']);
  });

  it('both targets occupied → empty wires but the latch still burns (seed consumed)', () => {
    const edges = [
      { target: { nodeId: 'pinned-audioOut', portId: 'L' } },
      { target: { nodeId: 'pinned-audioOut', portId: 'R' } },
    ];
    expect(planDefaultWires([mix, out], edges)).toEqual({ wires: [], latch: true });
  });

  it('tolerates sparse edge arrays (Y.Map holes)', () => {
    const plan = planDefaultWires([mix, out], [null, undefined]);
    expect(plan.wires).toHaveLength(2);
  });
});

describe('isPinnedNode', () => {
  it('true only for data.pinned === true', () => {
    expect(isPinnedNode({ type: 'x', data: { pinned: true } })).toBe(true);
    expect(isPinnedNode({ type: 'x', data: { pinned: 'true' } })).toBe(false);
    expect(isPinnedNode({ type: 'x', data: {} })).toBe(false);
    expect(isPinnedNode({ type: 'x' })).toBe(false);
    expect(isPinnedNode(null)).toBe(false);
    expect(isPinnedNode(undefined)).toBe(false);
  });
});

describe('isTypingTarget — the M/E/C inert-while-typing guard', () => {
  it('inputs / textareas / selects / contenteditable are typing targets', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'input' })).toBe(true); // case-insensitive
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('plain elements / null / non-objects are not', () => {
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: false })).toBe(false);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
    expect(isTypingTarget('input')).toBe(false);
    expect(isTypingTarget({})).toBe(false);
  });
});
