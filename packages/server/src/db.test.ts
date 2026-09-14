// packages/server/src/db.test.ts
//
// Regression coverage for the relay tab-switch 500 (PR fix(doom-mp)):
//
//   storeSnapshotRecord ran inside Hocuspocus's onStoreDocument, which has NO catch.
//   A transient pg error (observed live: 'Authentication timed out', code
//   08P01, on connect/disconnect churn from tab-switching with
//   unloadImmediately) was re-thrown, became an unhandled rejection, and
//   CRASHED the whole relay — every connected rack dropped + the Fly machine
//   rebooted, surfacing as a server error on /r/[id]. The fix: storeSnapshotRecord
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

describe('storeSnapshotRecord — never crashes the relay on a persist failure', () => {
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
    const { storeSnapshotRecord } = await import('./db.js');
    const authTimeout = Object.assign(new Error('Authentication timed out'), { code: '08P01' });
    queryMock.mockRejectedValueOnce(authTimeout);
    // The pre-fix code re-threw here → unhandled rejection → relay crash.
    // Since the journal slice, the swallow also reports NOT-durable (false)
    // so the caller must not compact the update journal on this round.
    await expect(storeSnapshotRecord('r_x', { state: new Uint8Array([1, 2, 3]), generation: '1', r2Key: null })).resolves.toBe(false);
  });

  it('returns non-durable on a FK violation (23503)', async () => {
    const { storeSnapshotRecord } = await import('./db.js');
    queryMock.mockRejectedValueOnce(Object.assign(new Error('fk'), { code: '23503' }));
    // A missing parent is not a durable save; never authorize compaction.
    await expect(storeSnapshotRecord('r_missing', { state: new Uint8Array([1]), generation: '1', r2Key: null })).resolves.toBe(false);
  });

  it('SWALLOWS a generic connection error (no code) too', async () => {
    const { storeSnapshotRecord } = await import('./db.js');
    queryMock.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));
    await expect(storeSnapshotRecord('r_y', { state: new Uint8Array([9]), generation: '1', r2Key: null })).resolves.toBe(false);
  });

  it('a healthy write resolves normally', async () => {
    const { storeSnapshotRecord } = await import('./db.js');
    queryMock.mockResolvedValueOnce({ rowCount: 1 });
    await expect(storeSnapshotRecord('r_ok', { state: new Uint8Array([1]), generation: '1', r2Key: null })).resolves.toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('registers a pool error listener so an idle-client error never crashes node', async () => {
    const { storeSnapshotRecord } = await import('./db.js');
    // First query lazily constructs the pool → installs the listener.
    queryMock.mockResolvedValueOnce({ rowCount: 1 });
    await storeSnapshotRecord('r_listener', { state: new Uint8Array([1]), generation: '1', r2Key: null });
    expect(poolOn).toHaveBeenCalledWith('error', expect.any(Function));
    // The listener must not re-throw when invoked with a backend error.
    const handler = poolOn.mock.calls.find((c) => c[0] === 'error')?.[1] as (e: Error) => void;
    expect(handler).toBeTypeOf('function');
    expect(() => handler(Object.assign(new Error('idle client died'), { code: '57P01' }))).not.toThrow();
  });
});

// ── Phase 2a / FW1: persistence mode + prod fail-fast guard ─────────────────
//
// USE_MEMORY (and thus persistenceMode()) is captured at module LOAD from
// DATABASE_URL, so we vi.resetModules() and set/unset the env before each
// import to exercise both branches. shouldFailFast is a PURE function so the
// guard can be tested without ever calling process.exit().
describe('persistenceMode — flips on DATABASE_URL presence at module load', () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    poolOn.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DATABASE_URL;
  });

  it("returns 'postgres' when DATABASE_URL is set", async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/test';
    const { persistenceMode } = await import('./db.js');
    expect(persistenceMode()).toBe('postgres');
  });

  it("returns 'memory' when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    const { persistenceMode } = await import('./db.js');
    expect(persistenceMode()).toBe('memory');
  });
});

describe('shouldFailFast — prod fail-fast guard (pure, no process.exit)', () => {
  // Module-load env is irrelevant: shouldFailFast takes env + usingMemory as
  // explicit args, so we drive the truth table directly.
  let shouldFailFast: typeof import('./db.js').shouldFailFast;
  beforeEach(async () => {
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Pin a known load-time state; every assertion passes usingMemory explicitly.
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/test';
    ({ shouldFailFast } = await import('./db.js'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DATABASE_URL;
  });

  it('FIRES in production + memory mode + no escape hatch', () => {
    expect(shouldFailFast({ NODE_ENV: 'production' }, true)).toBe(true);
  });

  it('does NOT fire in dev/test even in memory mode (the @collab CI/test path)', () => {
    expect(shouldFailFast({ NODE_ENV: 'test' }, true)).toBe(false);
    expect(shouldFailFast({ NODE_ENV: 'development' }, true)).toBe(false);
    expect(shouldFailFast({}, true)).toBe(false); // NODE_ENV unset (local + CI default)
  });

  it('does NOT fire in production when DATABASE_URL is configured (postgres mode)', () => {
    expect(shouldFailFast({ NODE_ENV: 'production' }, false)).toBe(false);
  });

  it('does NOT fire when the ALLOW_MEMORY_STORE=1 escape hatch is set', () => {
    expect(shouldFailFast({ NODE_ENV: 'production', ALLOW_MEMORY_STORE: '1' }, true)).toBe(false);
  });

  it('STILL fires when ALLOW_MEMORY_STORE is set to a non-"1" value', () => {
    expect(shouldFailFast({ NODE_ENV: 'production', ALLOW_MEMORY_STORE: '0' }, true)).toBe(true);
    expect(shouldFailFast({ NODE_ENV: 'production', ALLOW_MEMORY_STORE: 'true' }, true)).toBe(true);
  });

  it('defaults usingMemory to the live persistence mode (postgres here → no fire)', () => {
    // Loaded with DATABASE_URL set above → persistenceMode() === 'postgres'.
    expect(shouldFailFast({ NODE_ENV: 'production' })).toBe(false);
  });
});
