import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import pg from 'pg';
import * as Y from 'yjs';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Match the capacity-race suite: required in CI, opt in locally with RUN_DB_TESTS.
// All writes are in a unique schema; never modify the database's public tables.
describe.skipIf(!process.env.RUN_DB_TESTS && !process.env.CI)('snapshot authority (real Postgres)', () => {
  const schema = 'snapshot_test_' + randomUUID().replaceAll('-', '');
  const databaseUrl = process.env.PG_TEST_URL ?? 'postgresql://postgres:dev@localhost:54320/patchtogether_test';
  const admin = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  let db: typeof import('./db.js');
  let journal: typeof import('./journal.js');
  let createSnapshotStore: typeof import('./snapshot-store.js').createSnapshotStore;
  beforeAll(async () => {
    await admin.query('CREATE SCHEMA ' + schema);
    const url = new URL(databaseUrl);
    url.searchParams.set('options', '-c search_path=' + schema);
    vi.stubEnv('DATABASE_URL', url.toString());
    vi.resetModules();
    db = await import('./db.js');
    journal = await import('./journal.js');
    ({ createSnapshotStore } = await import('./snapshot-store.js'));
    for (const file of ['001_init.sql', '004_rack_update_journal.sql', '008_snapshot_authority.sql']) {
      await db.getPool().query(readFileSync(new URL('../../../db/schema/' + file, import.meta.url), 'utf8'));
    }
  });
  afterAll(async () => {
    if (db) await db.getPool().end();
    await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await admin.end();
    vi.unstubAllEnvs();
  });

  const env = { R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', R2_BUCKET: 'test' };
  it('reloads both layers after failed R2 PUT, journal compaction, and storage recovery', async () => {
    await db.getPool().query("INSERT INTO racks(id,owner_user_id,name) VALUES ('layers','owner','layers')");
    const objects = new Map<string, Uint8Array>();
    let failPut = false;
    const fetchFn: import('./snapshot-store.js').FetchLike = async (url, init) => {
      if (init.method === 'PUT') {
        if (failPut) return { status: 503, arrayBuffer: async () => new ArrayBuffer(0) };
        objects.set(url, init.body!.slice());
        return { status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      const bytes = objects.get(url);
      return { status: bytes ? 200 : 404, arrayBuffer: async () => bytes!.slice().buffer as ArrayBuffer };
    };
    const a = new Y.Doc(); const b = new Y.Doc();
    a.getMap('layers').set('one', 'red');
    const store = createSnapshotStore({ env, fetchFn });
    expect(await store.store('layers', Y.encodeStateAsUpdate(a))).toBe(true);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    a.getMap('layers').set('one', 'blue');
    b.getMap('layers').set('two', 'green');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    const update = Y.encodeStateAsUpdate(a);
    await journal.appendJournalUpdate('layers', update);
    const watermark = await journal.latestJournalSeq('layers');
    expect(watermark).not.toBeNull();
    failPut = true;
    expect(await store.store('layers', update)).toBe(true);
    expect(await journal.compactJournal('layers', watermark!)).toBe(1);
    failPut = false;
    const fresh = createSnapshotStore({ env, fetchFn });
    const restored = new Y.Doc();
    Y.applyUpdate(restored, (await fresh.load('layers'))!);
    expect(restored.getMap('layers').toJSON()).toEqual({ one: 'blue', two: 'green' });
    expect(await journal.loadJournalUpdates('layers')).toEqual([]);
    a.destroy(); b.destroy(); restored.destroy();
  });

  it('commits the newest generation and queues superseded/deleted objects in the same transaction', async () => {
    await db.getPool().query("INSERT INTO racks(id,owner_user_id,name) VALUES ('race','owner','race')");
    const old = await db.nextSnapshotGeneration();
    const newer = await db.nextSnapshotGeneration();
    expect(await db.storeSnapshotRecord('race', { generation: newer, state: new Uint8Array(), r2Key: 'new' })).toBe(true);
    // An idempotent authority retry must never retire the live object.
    expect(await db.storeSnapshotRecord('race', { generation: newer, state: new Uint8Array(), r2Key: 'new' })).toBe(true);
    expect(await db.storeSnapshotRecord('race', { generation: old, state: new Uint8Array(), r2Key: 'old' })).toBe(true);
    expect((await db.loadSnapshotRecord('race'))!.r2Key).toBe('new');
    const queued = async () => (await db.getPool().query<{object_key:string}>(
      'SELECT object_key FROM rack_snapshot_garbage ORDER BY object_key')).rows.map(r => r.object_key);
    expect(await queued()).toContain('old');
    expect(await queued()).not.toContain('new');
    await db.getPool().query("DELETE FROM racks WHERE id='race'");
    expect(await queued()).toContain('new');
    expect(await db.storeSnapshotRecord('deleted', {
      generation: await db.nextSnapshotGeneration(), state: new Uint8Array([1]), r2Key: null,
    })).toBe(false);
  });
});
