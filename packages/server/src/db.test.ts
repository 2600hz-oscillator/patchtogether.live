// packages/server/src/db.test.ts
//
// Regression coverage for the relay tab-switch 500 (PR fix(doom-mp)):
//
//   storeSnapshot ran inside Hocuspocus's onStoreDocument, which has NO catch.
//   A transient pg error (observed live: 'Authentication timed out', code
//   08P01, on connect/disconnect churn from tab-switching with
//   unloadImmediately) was re-thrown, became an unhandled rejection, and
//   CRASHED the whole relay — every connected rack dropped + the Fly machine
//   rebooted, surfacing as a server error on /r/[id]. The fix: storeSnapshot
//   must SWALLOW transient errors (log + return) so a dropped snapshot costs at
//   most one debounce of durability, never the process. It must still swallow
//   the FK violation (23503) it always did, and a healthy write must succeed.
//
// We mock `pg` so no Postgres is required.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// One shared mock query fn + a captured pool so we can assert the 'error'
// listener is wired (the second half of the crash fix: a pg Pool emitting
// 'error' with no listener is itself a hard process crash).
const queryMock = vi.fn();
const poolOn = vi.fn();

vi.mock('pg', () => {
  class Pool {
    query = queryMock;
    on = poolOn;
    constructor(_cfg: unknown) {}
  }
  return { default: { Pool }, Pool };
});

describe('storeSnapshot — never crashes the relay on a persist failure', () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    poolOn.mockReset();
    // Force the Postgres path (not the in-memory dev/e2e fallback).
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/test';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DATABASE_URL;
  });

  it('SWALLOWS a transient pg error (08P01 auth timeout) instead of throwing', async () => {
    const { storeSnapshot } = await import('./db.js');
    const authTimeout = Object.assign(new Error('Authentication timed out'), { code: '08P01' });
    queryMock.mockRejectedValueOnce(authTimeout);
    // The pre-fix code re-threw here → unhandled rejection → relay crash.
    await expect(storeSnapshot('r_x', new Uint8Array([1, 2, 3]))).resolves.toBeUndefined();
  });

  it('still no-ops on a FK violation (23503 — ephemeral test rack)', async () => {
    const { storeSnapshot } = await import('./db.js');
    queryMock.mockRejectedValueOnce(Object.assign(new Error('fk'), { code: '23503' }));
    await expect(storeSnapshot('r_missing', new Uint8Array([1]))).resolves.toBeUndefined();
  });

  it('SWALLOWS a generic connection error (no code) too', async () => {
    const { storeSnapshot } = await import('./db.js');
    queryMock.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));
    await expect(storeSnapshot('r_y', new Uint8Array([9]))).resolves.toBeUndefined();
  });

  it('a healthy write resolves normally', async () => {
    const { storeSnapshot } = await import('./db.js');
    queryMock.mockResolvedValueOnce({ rowCount: 1 });
    await expect(storeSnapshot('r_ok', new Uint8Array([1]))).resolves.toBeUndefined();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('registers a pool error listener so an idle-client error never crashes node', async () => {
    const { storeSnapshot } = await import('./db.js');
    // First query lazily constructs the pool → installs the listener.
    queryMock.mockResolvedValueOnce({ rowCount: 1 });
    await storeSnapshot('r_listener', new Uint8Array([1]));
    expect(poolOn).toHaveBeenCalledWith('error', expect.any(Function));
    // The listener must not re-throw when invoked with a backend error.
    const handler = poolOn.mock.calls.find((c) => c[0] === 'error')?.[1] as (e: Error) => void;
    expect(handler).toBeTypeOf('function');
    expect(() => handler(Object.assign(new Error('idle client died'), { code: '57P01' }))).not.toThrow();
  });
});
