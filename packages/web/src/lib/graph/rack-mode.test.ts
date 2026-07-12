// packages/web/src/lib/graph/rack-mode.test.ts
//
// WORKFLOW MODE P1 — mode normalization + the doc-meta mirror, exercised
// against a REAL Y.Doc (never a mock — [[yjs-save-load-real-ydoc]]).

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  normalizeRackMode,
  readRackModeFromDoc,
  ensureRackModeInDoc,
  RACK_META_MAP_KEY,
  RACK_META_MODE_KEY,
  RACK_MODE_ORIGIN,
} from './rack-mode';

describe('normalizeRackMode — old rows / garbage read as dawless', () => {
  it('passes the two valid modes through', () => {
    expect(normalizeRackMode('dawless')).toBe('dawless');
    expect(normalizeRackMode('workflow')).toBe('workflow');
  });

  it('coerces pre-migration / absent / garbage values to dawless', () => {
    expect(normalizeRackMode(null)).toBe('dawless');
    expect(normalizeRackMode(undefined)).toBe('dawless');
    expect(normalizeRackMode('')).toBe('dawless');
    expect(normalizeRackMode('WORKFLOW')).toBe('dawless'); // exact-match only
    expect(normalizeRackMode(1)).toBe('dawless');
    expect(normalizeRackMode({})).toBe('dawless');
  });
});

describe('doc-meta mirror (real Y.Doc)', () => {
  it('readRackModeFromDoc returns null on a fresh doc', () => {
    const ydoc = new Y.Doc();
    expect(readRackModeFromDoc(ydoc)).toBeNull();
  });

  it('ensureRackModeInDoc writes when absent and reads back', () => {
    const ydoc = new Y.Doc();
    expect(ensureRackModeInDoc(ydoc, 'workflow')).toBe(true);
    expect(readRackModeFromDoc(ydoc)).toBe('workflow');
    expect(ydoc.getMap(RACK_META_MAP_KEY).get(RACK_META_MODE_KEY)).toBe('workflow');
  });

  it('is idempotent — matching value is a no-op (no transaction)', () => {
    const ydoc = new Y.Doc();
    ensureRackModeInDoc(ydoc, 'workflow');
    let updates = 0;
    ydoc.on('update', () => updates++);
    expect(ensureRackModeInDoc(ydoc, 'workflow')).toBe(false);
    expect(updates).toBe(0); // observer-safe: no ping-pong writes
  });

  it('corrects a divergent value back to the server-authoritative mode', () => {
    const ydoc = new Y.Doc();
    // Simulate a stray write / foreign snapshot flipping the mirror.
    ydoc.getMap(RACK_META_MAP_KEY).set(RACK_META_MODE_KEY, 'workflow');
    expect(ensureRackModeInDoc(ydoc, 'dawless')).toBe(true);
    expect(readRackModeFromDoc(ydoc)).toBe('dawless');
  });

  it('garbage in the map reads as null (readRackModeFromDoc is strict)', () => {
    const ydoc = new Y.Doc();
    ydoc.getMap(RACK_META_MAP_KEY).set(RACK_META_MODE_KEY, 'yolo');
    expect(readRackModeFromDoc(ydoc)).toBeNull();
  });

  it('the mirror write carries the non-tracked RACK_MODE_ORIGIN', () => {
    const ydoc = new Y.Doc();
    let seenOrigin: unknown = 'unset';
    ydoc.on('update', (_u: Uint8Array, origin: unknown) => {
      seenOrigin = origin;
    });
    ensureRackModeInDoc(ydoc, 'workflow');
    expect(seenOrigin).toBe(RACK_MODE_ORIGIN);
  });

  it('the mirror syncs to a second real doc via a Yjs update', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    ensureRackModeInDoc(a, 'workflow');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(readRackModeFromDoc(b)).toBe('workflow');
  });
});
