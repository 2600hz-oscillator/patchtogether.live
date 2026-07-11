// packages/web/src/lib/graph/workflow-pins.test.ts
//
// WORKFLOW MODE P1 — pinned-singleton planning + drawer keymap + the
// keyboard typing guard. Pure-unit (plain fixtures, no DOM, no Yjs).

import { describe, it, expect } from 'vitest';
import {
  WORKFLOW_PINNED_MODULES,
  DRAWER_KEY_TO_PINNED,
  planPinnedSpawns,
  isPinnedNode,
  isTypingTarget,
} from './workflow-pins';

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

describe('planPinnedSpawns', () => {
  it('an empty rack plans all three, in M/E/C order', () => {
    expect(planPinnedSpawns([]).map((s) => s.type)).toEqual([
      'mixmstrs',
      'electraControl',
      'clipplayer',
    ]);
  });

  it('plans only the missing specs', () => {
    const nodes = [
      { type: 'mixmstrs', data: { pinned: true } },
      { type: 'clipplayer', data: { pinned: true } },
    ];
    expect(planPinnedSpawns(nodes).map((s) => s.type)).toEqual(['electraControl']);
  });

  it('a full trio plans nothing (the ensure is idempotent)', () => {
    const nodes = WORKFLOW_PINNED_MODULES.map((s) => ({
      type: s.type,
      data: { pinned: true },
    }));
    expect(planPinnedSpawns(nodes)).toEqual([]);
  });

  it('UNPINNED instances of the same types do NOT satisfy the invariant', () => {
    // A user-spawned canvas mixmstrs is a normal card, not the pinned one.
    const nodes = [
      { type: 'mixmstrs', data: {} },
      { type: 'electraControl' },
      { type: 'clipplayer', data: { pinned: false } },
    ];
    expect(planPinnedSpawns(nodes).map((s) => s.type)).toEqual([
      'mixmstrs',
      'electraControl',
      'clipplayer',
    ]);
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
