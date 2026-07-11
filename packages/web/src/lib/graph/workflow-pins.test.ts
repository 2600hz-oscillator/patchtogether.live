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
  DRAWER_KEY_TO_PINNED,
  planPinnedSpawns,
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
