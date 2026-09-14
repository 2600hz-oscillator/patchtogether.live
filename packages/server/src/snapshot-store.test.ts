// The snapshot-blob storage abstraction: backend resolution from env,
// exact-current-behavior passthrough when R2 is absent, and the R2 mode's
// fallback semantics (migration reads via 404 → Postgres, durability
// fallback on failed writes). Network is a fake FetchLike; the base store
// runs in the real in-memory db.ts mode (no DATABASE_URL) so the
// passthroughs are the actual code paths local dev + e2e use.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Y from 'yjs';

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
    expect(calls[0]!.url).toMatch(
      /^https:\/\/acct123.r2.cloudflarestorage.com\/pt-rack-snapshots\/rack-snapshots\/versions\/rack-a\/1-[a-f0-9-]{36}$/,
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
    expect(calls[0]!.url).toContain('/rack-snapshots/versions/rack%2F..%2Fetc/');
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
    await db.storeSnapshotRecord('rack-a', { state: new Uint8Array([7]), generation: '0', r2Key: null });
    const { fetchFn } = makeFetch({ status: 404 });
    const store = createSnapshotStore({ env: { ...R2_ENV }, fetchFn });
    expect([...(await store.load('rack-a'))!]).toEqual([7]);
  });

  it('refuses an ambiguous legacy fallback when R2 is unavailable', async () => {
    const { createSnapshotStore } = await importStore();
    const db = await importDb();
    db._resetMemorySnapshots();
    await db.storeSnapshotRecord('rack-a', { state: new Uint8Array([8]), generation: '0', r2Key: null });
    const fetchFn = vi.fn(async () => {
      throw new Error('connect ETIMEDOUT');
    });
    const store = createSnapshotStore({ env: { ...R2_ENV }, fetchFn });
    await expect(store.load('rack-a')).rejects.toThrow('connect ETIMEDOUT');
  });

  it('store falls back to the base store when the R2 PUT fails (durability first)', async () => {
    const { createSnapshotStore } = await importStore();
    const db = await importDb();
    db._resetMemorySnapshots();
    const { fetchFn } = makeFetch({ status: 500 });
    const store = createSnapshotStore({ env: { ...R2_ENV }, fetchFn });
    expect(await store.store('rack-a', new Uint8Array([6]))).toBe(true);
    // The bytes landed in the base store despite the R2 failure.
    expect([...(await db.loadSnapshotRecord('rack-a'))!.state]).toEqual([6]);
  });

  it('an R2 exception still allows a successful inline save', async () => {
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

describe('snapshot authority across outages and overlapping saves', () => {
  async function fixture() {
    const { createSnapshotStore } = await importStore();
    const db = await importDb();
    db._resetMemorySnapshots();
    const objects = new Map<string, Uint8Array>();
    const faults = { put: false, get: false };
    const fetchFn = vi.fn(async (url: string, init: { method: string; body?: Uint8Array }) => {
      if (init.method === 'PUT' && !faults.put) objects.set(url, init.body!.slice());
      const body = objects.get(url);
      return {
        status: (init.method === 'PUT' ? faults.put : faults.get) ? 503 : init.method === 'PUT' || body ? 200 : 404,
        arrayBuffer: async () => body!.slice().buffer as ArrayBuffer,
      };
    });
    return { db, objects, faults, fetchFn, create: () => createSnapshotStore({ env: R2_ENV, fetchFn }) };
  }

  it('recovered R2 cannot hide a newer inline fallback, even with a fresh store instance', async () => {
    const f = await fixture();
    expect(await f.create().store('rack', new Uint8Array([1]))).toBe(true);
    f.faults.put = true;
    expect(await f.create().store('rack', new Uint8Array([2]))).toBe(true);
    f.faults.put = false;
    expect(await f.create().load('rack')).toEqual(new Uint8Array([2]));
    f.faults.get = true;
    expect(await f.create().load('rack')).toEqual(new Uint8Array([2]));
    expect(await f.create().store('rack', new Uint8Array([3]))).toBe(true);
    await expect(f.create().load('rack')).rejects.toThrow('503');
    f.faults.get = false;
    expect(await f.create().load('rack')).toEqual(new Uint8Array([3]));
  });

  it('does not treat a missing committed object as a legacy 404', async () => {
    const f = await fixture();
    await f.create().store('rack', new Uint8Array([1]));
    f.objects.clear();
    await expect(f.create().load('rack')).rejects.toThrow('404');
    const { createSnapshotStore } = await importStore();
    await expect(createSnapshotStore({ env: {} }).load('rack')).rejects.toThrow('R2 configuration');
  });

  it('an older PUT completing last cannot replace the newer snapshot', async () => {
    const f = await fixture();
    const { createSnapshotStore } = await importStore();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const store = createSnapshotStore({ env: R2_ENV, fetchFn: async (url, init) => {
      if (init.method === 'PUT' && init.body![0] === 1) { entered(); await gate; }
      return f.fetchFn(url, init);
    }});
    const old = store.store('rack', new Uint8Array([1]));
    await started;
    await store.store('rack', new Uint8Array([2]));
    release(); await old;
    expect(await f.create().load('rack')).toEqual(new Uint8Array([2]));
  });

  it('merges legacy documents from both stores, including edits and deletions', async () => {
    const f = await fixture();
    const a = new Y.Doc(); a.getMap('layers').set('deleted', 'old');
    const b = new Y.Doc(); Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    a.getMap('layers').set('left', 'red');
    b.getMap('layers').delete('deleted'); b.getMap('layers').set('right', 'blue');
    await f.db.storeSnapshotRecord('rack', { state: Y.encodeStateAsUpdate(a), generation: '0', r2Key: null });
    f.objects.set('https://acct123.r2.cloudflarestorage.com/pt-rack-snapshots/rack-snapshots/rack', Y.encodeStateAsUpdate(b));
    const loaded = new Y.Doc(); Y.applyUpdate(loaded, (await f.create().load('rack'))!);
    expect(loaded.getMap('layers').toJSON()).toEqual({ left: 'red', right: 'blue' });
    a.destroy(); b.destroy(); loaded.destroy();
  });

  it('does not permit journal compaction if the authority commit fails', async () => {
    const f = await fixture();
    vi.spyOn(f.db, 'storeSnapshotRecord').mockResolvedValueOnce(false);
    expect(await f.create().store('rack', new Uint8Array([1]))).toBe(false);
    expect(await f.db.loadSnapshotRecord('rack')).toBeNull();
  });
});

it('retired objects respect the reader grace period, drain multiple pages, and retry failures', async () => {
  const db = await importDb();
  const { createSnapshotStore } = await importStore();
  db._resetMemorySnapshots();
  let time = Date.now();
  const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => time);
  let failDeletes = false;
  const deleted: string[] = [];
  const fetchFn = vi.fn(async (url: string, init: { method: string }) => {
    if (init.method === 'DELETE') {
      if (failDeletes) return { status: 503, arrayBuffer: async () => new ArrayBuffer(0) };
      deleted.push(url);
    }
    return { status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  });
  try {
    const store = createSnapshotStore({ env: R2_ENV, fetchFn, now: () => new Date(time) });
    for (let i = 0; i < 41; i++) expect(await store.store('rack', new Uint8Array([i]))).toBe(true);
    const currentKey = (await db.loadSnapshotRecord('rack'))!.r2Key!;
    expect(deleted).toEqual([]);
    expect(await db.retiredSnapshotObjects()).toEqual([]);
    time += 3600_001;
    failDeletes = true;
    await store.store('other', new Uint8Array([1]));
    await vi.waitFor(() => expect(fetchFn.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(32));
    expect(await db.retiredSnapshotObjects()).toHaveLength(32);
    failDeletes = false;
    time += 60_001;
    await store.store('other', new Uint8Array([2]));
    await vi.waitFor(() => expect(deleted).toHaveLength(40));
    expect(deleted.some(url => url.endsWith(currentKey))).toBe(false);
    expect(await db.retiredSnapshotObjects()).toEqual([]);
  } finally { dateSpy.mockRestore(); }
});

it('an independently restored database cannot overwrite a previous immutable object', async () => {
  const db = await importDb();
  const { createSnapshotStore } = await importStore();
  const { fetchFn, calls } = makeFetch({ status: 200 }, { status: 200 });
  const store = createSnapshotStore({ env: R2_ENV, fetchFn });
  await store.store('same-rack', new Uint8Array([1]));
  db._resetMemorySnapshots(); // Models a restored/cloned sequence starting at one again.
  await store.store('same-rack', new Uint8Array([2]));
  expect(calls).toHaveLength(2);
  expect(calls[0]!.url).not.toBe(calls[1]!.url);
});

it('a delayed generation allocation cannot give an older captured document the newer generation', async () => {
  const db = await importDb();
  const { createSnapshotStore } = await importStore();
  const allocate = db.nextSnapshotGeneration;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const allocation = vi.spyOn(db, 'nextSnapshotGeneration')
    .mockImplementationOnce(async () => { await gate; return allocate(); });
  try {
    const first = createSnapshotStore({ env: {} }).store('race', new Uint8Array([1]));
    await Promise.resolve();
    const second = createSnapshotStore({ env: {} }).store('race', new Uint8Array([2]));
    await Promise.resolve();
    expect(allocation).toHaveBeenCalledTimes(1);
    release();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect((await db.loadSnapshotRecord('race'))!.state).toEqual(new Uint8Array([2]));
  } finally { release(); allocation.mockRestore(); }
});
