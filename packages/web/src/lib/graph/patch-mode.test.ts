// packages/web/src/lib/graph/patch-mode.test.ts
//
// Pure-unit gate for the cross-mode import guard's two decisions:
//   * detectPatchMode  — stamp-first, infer-from-content second
//   * assertLoadable    — same-mode ok, cross-mode rejected (both directions)
// plus the stamp helper. No Svelte / Yjs — plain fixtures.

import { describe, it, expect } from 'vitest';
import {
  detectPatchMode,
  assertLoadable,
  stampEnvelopeMode,
  normalizeStampMode,
  hasWorkflowMarker,
  inferPatchMode,
  CROSS_MODE_MESSAGES,
  type PatchModeNode,
} from './patch-mode';

const pinned: PatchModeNode = { type: 'mixmstrs', data: { pinned: true } };
const hidden: PatchModeNode = { type: 'camera', data: { hiddenCard: true } };
const defaultWired: PatchModeNode = { type: 'audioOut', data: { workflowDefaultWired: true } };
const plain: PatchModeNode = { type: 'analogVco', data: {} };
const plainNoData: PatchModeNode = { type: 'scope' };

describe('detectPatchMode — stamp wins when present', () => {
  it('stamped workflow → workflow (even with dawless-looking content)', () => {
    expect(detectPatchMode({ mode: 'workflow', nodes: [plain, plainNoData] })).toBe('workflow');
    expect(detectPatchMode({ mode: 'workflow', nodes: [] })).toBe('workflow');
  });

  it('stamped dawless → dawless (even when content carries workflow markers)', () => {
    expect(detectPatchMode({ mode: 'dawless', nodes: [pinned, defaultWired] })).toBe('dawless');
  });

  it('a garbage / absent stamp falls through to content inference', () => {
    expect(detectPatchMode({ mode: 'nonsense', nodes: [pinned] })).toBe('workflow');
    expect(detectPatchMode({ mode: undefined, nodes: [plain] })).toBe('dawless');
    expect(detectPatchMode({ mode: null, nodes: [] })).toBe('dawless');
  });
});

describe('detectPatchMode — legacy inference from content', () => {
  it('any pinned node ⇒ workflow', () => {
    expect(detectPatchMode({ nodes: [plain, pinned] })).toBe('workflow');
  });
  it('any hiddenCard node ⇒ workflow', () => {
    expect(detectPatchMode({ nodes: [plain, hidden] })).toBe('workflow');
  });
  it('any workflowDefaultWired node ⇒ workflow', () => {
    expect(detectPatchMode({ nodes: [plain, defaultWired] })).toBe('workflow');
  });
  it('no markers (dawless content) ⇒ dawless', () => {
    expect(detectPatchMode({ nodes: [plain, plainNoData] })).toBe('dawless');
  });
  it('empty / missing nodes ⇒ dawless', () => {
    expect(detectPatchMode({ nodes: [] })).toBe('dawless');
    expect(detectPatchMode({})).toBe('dawless');
    expect(detectPatchMode({ nodes: null })).toBe('dawless');
  });
});

describe('assertLoadable — same-mode ok, cross-mode rejected', () => {
  it('same mode is loadable (both directions)', () => {
    expect(assertLoadable('dawless', 'dawless')).toEqual({ ok: true });
    expect(assertLoadable('workflow', 'workflow')).toEqual({ ok: true });
  });

  it('workflow patch into a dawless rack is rejected with the workflow message', () => {
    const v = assertLoadable('workflow', 'dawless');
    expect(v.ok).toBe(false);
    expect(v).toEqual({ ok: false, message: CROSS_MODE_MESSAGES.workflowIntoDawless });
    // message names the direction (a workflow patch)
    expect((v as { message: string }).message).toMatch(/WORKFLOW/);
  });

  it('dawless patch into a workflow rack is rejected with the dawless message', () => {
    const v = assertLoadable('dawless', 'workflow');
    expect(v.ok).toBe(false);
    expect(v).toEqual({ ok: false, message: CROSS_MODE_MESSAGES.dawlessIntoWorkflow });
    expect((v as { message: string }).message).toMatch(/dawless/);
  });
});

describe('stampEnvelopeMode', () => {
  it('adds the mode field without mutating the input', () => {
    const env = { envelopeVersion: 2, savedAt: 'x', update: 'abc' };
    const stamped = stampEnvelopeMode(env, 'workflow');
    expect(stamped).toEqual({ envelopeVersion: 2, savedAt: 'x', update: 'abc', mode: 'workflow' });
    expect(env).not.toHaveProperty('mode'); // input untouched
    expect(stamped).not.toBe(env);
  });
});

describe('primitive helpers', () => {
  it('normalizeStampMode returns the mode or null (never coerces to dawless)', () => {
    expect(normalizeStampMode('workflow')).toBe('workflow');
    expect(normalizeStampMode('dawless')).toBe('dawless');
    expect(normalizeStampMode(undefined)).toBeNull();
    expect(normalizeStampMode('garbage')).toBeNull();
    expect(normalizeStampMode(1)).toBeNull();
  });

  it('hasWorkflowMarker only trips on the three markers set to true', () => {
    expect(hasWorkflowMarker(pinned)).toBe(true);
    expect(hasWorkflowMarker(hidden)).toBe(true);
    expect(hasWorkflowMarker(defaultWired)).toBe(true);
    expect(hasWorkflowMarker(plain)).toBe(false);
    expect(hasWorkflowMarker(plainNoData)).toBe(false);
    expect(hasWorkflowMarker({ type: 'x', data: { pinned: 'yes' } })).toBe(false); // must be === true
    expect(hasWorkflowMarker(null)).toBe(false);
  });

  it('inferPatchMode short-circuits on the first marker', () => {
    expect(inferPatchMode([plain, plain, pinned])).toBe('workflow');
    expect(inferPatchMode([plain, plain])).toBe('dawless');
    expect(inferPatchMode(null)).toBe('dawless');
  });
});
