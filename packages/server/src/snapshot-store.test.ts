// packages/server/src/snapshot-store.test.ts
//
// The snapshot-blob storage abstraction: backend resolution from env,
// exact-current-behavior passthrough when R2 is absent, and the R2 mode's
// fallback semantics (migration reads via 404 → Postgres, durability
// fallback on failed writes). Network is a fake FetchLike; the base store
// runs in the real in-memory db.ts mode (no DATABASE_URL) so the
// passthroughs are the actual code paths local dev + e2e use.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const R2_ENV = {
  R2_ACCOUNT_ID: 'acct123',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'pt-rack-snapshots',
};

async function importStore() {
  return import('./snapshot-store.js');
}
async function importDb() {
  return import('./db.js');
}

type FakeResponse = { status: number; body?: Uint8Array };

/** Fake FetchLike recording calls; responses dequeue in order. */
function makeFetch(...responses: FakeResponse[]) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: Uint8Array }> = [];
  const fetchFn = vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array }) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const next = responses.shift() ?? { status: 500 };
    return {
      status: next.status,
      arrayBuffer: async () => (next.body ?? new Uint8Array()).buffer as ArrayBuffer,
    };
  });
  return { fetchFn, calls };
}

beforeEach(() => {
  vi.resetModules();
  delete process.env.DATABASE_URL;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('readR2Config', () => {
  it('is null unless ALL four required vars are present', async () => {
    const { readR2Config } = await importStore();
    expect(readR2Config({})).toBeNull();
    for (const missing of Object.keys(R2_ENV)) {
      const env = { ...R2_ENV } as Record<string, string | undefined>;
      delete env[missing];
      expect(readR2Config(env)).toBeNull();
    }
  });

  it('derives the account endpoint + default prefix, honours overrides', async () => {
    const { readR2Config } = await importStore();
    expect(readR2Config({ ...R2_ENV })).toEqual({
      accountId: 'acct123',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      bucket: 'pt-rack-snapshots',
      prefix: 'rack-snapshots/',
      endpoint: 'https://acct123.r2.cloudflarestorage.com',
    });
    const custom = readR2Config({ ...R2_ENV, R2_PREFIX: 'x/', R2_ENDPOINT: 'https://alt.example' });
    expect(custom?.prefix).toBe('x/');
    expect(custom?.endpoint).toBe('https://alt.example');
  });
});

describe('createSnapshotStore — no R2 (current behavior passthrough)', () => {
  it('reports the db.ts mode and round-trips via the base store', async () => {
    const { createSnapshotStore } = await importStore();
    const db = await importDb();
    db._resetMemorySnapshots();
    const store = createSnapshotStore({ env: {} });
    expect(store.mode()).toBe('memory'); // no DATABASE_URL in this test env
    expect(await store.load('rack-a')).toBeNull();
    expect(await store.store('rack-a', new Uint8Array([1, 2, 3]))).toBe(true);
    expect([...(await store.load('rack-a'))!]).toEqual([1, 2, 3]);
  });
});

describe('createSnapshotStore — R2 mode', () => {
  it('mode() is r2 and store PUTs a signed request to the bucket key', async () => {
    const { createSnapshotStore } = await importStore();
    const { fetchFn, calls } = makeFetch({ status: 200 });
    const store = createSnapshotStore({
      env: { ...R2_ENV },
      fetchFn,
      now: () => new Date(Date.UTC(2026, 6, 10, 12, 0, 0)),
    });
    expect(store.mode()).toBe('r2');
    expect(await store.store('rack-a', new Uint8Array([9]))).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toBe(
      'https://acct123.r2.cloudflarestorage.com/pt-rack-snapshots/rack-snapshots/rack-a',
    );
    expect(calls[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=key\/20260710\/auto\/s3\/aws4_request/);
    expect(calls[0]!.headers['x-amz-date']).toBe('20260710T120000Z');
    expect([...(calls[0]!.body ?? [])]).toEqual([9]);
  });

  it('URI-encodes hostile rack ids into the object key', async () => {
    const { createSnapshotStore } = await importStore();
    const { fetchFn, calls } = makeFetch({ status: 200 });
    const store = createSnapshotStore({ env: { ...R2_ENV }, fetchFn });
    await store.store('rack/../etc', new Uint8Array([1]));
    expect(calls[0]!.url).toContain('/rack-snapshots/rack%2F..%2Fetc');
  });

  it('load returns the R2 blob on 200', async () => {
    const { createSnapshotStore } = await importStore();
    const { fetchFn } = makeFetch({ status: 200, body: new Uint8Array([4, 5]) });
    const store = createSnapshotStore({ env: { ...R2_ENV }, fetchFn });
    expect([...(await store.load('rack-a'))!]).toEqual([4, 5]);
  });

  it('load falls back to the Postgres/base row on 404 (pre-R2 racks, web-seeded snapshots)', async () => {
    const { createSnapshotStore } = await importStore();
    const db = await importDb();
    db._resetMemorySnapshots();
    // Seed the BASE store the way rackspaces.ts seeds rack_snapshots.
    await db.storeSnapshot('rack-a', new Uint8Array([7]));
    const { fetchFn } = makeFetch({ status: 404 });
    const store = createSnapshotStore({ env: { ...R2_ENV }, fetchFn });
    expect([...(await store.load('rack-a'))!]).toEqual([7]);
  });

  it('load falls back to the base row when R2 errors (network down ≠ data gone)', async () => {
    const { createSnapshotStore } = await importStore();
    const db = await importDb();
    db._resetMemorySnapshots();
    await db.storeSnapshot('rack-a', new Uint8Array([8]));
    const fetchFn = vi.fn(async () => {
      throw new Error('connect ETIMEDOUT');
    });
    const store = createSnapshotStore({ env: { ...R2_ENV }, fetchFn });
    expect([...(await store.load('rack-a'))!]).toEqual([8]);
  });

  it('store falls back to the base store when the R2 PUT fails (durability first)', async () => {
    const { createSnapshotStore } = await importStore();
    const db = await importDb();
    db._resetMemorySnapshots();
    const { fetchFn } = makeFetch({ status: 500 });
    const store = createSnapshotStore({ env: { ...R2_ENV }, fetchFn });
    expect(await store.store('rack-a', new Uint8Array([6]))).toBe(true);
    // The bytes landed in the base store despite the R2 failure.
    expect([...(await db.loadSnapshot('rack-a'))!]).toEqual([6]);
  });

  it('store NEVER throws even when both backends fail', async () => {
    const { createSnapshotStore } = await importStore();
    // Base store here is the in-memory map which cannot fail — force the
    // R2 throw path and assert the boolean contract holds.
    const fetchFn = vi.fn(async () => {
      throw new Error('boom');
    });
    const store = createSnapshotStore({ env: { ...R2_ENV }, fetchFn });
    await expect(store.store('rack-a', new Uint8Array([1]))).resolves.toBe(true);
  });
});
