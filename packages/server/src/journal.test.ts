// packages/server/src/journal.test.ts
//
// The append-journal durability protocol, exercised with REAL Y.Docs (no
// mocked Yjs — house rule): write → journal → crash → recover must lose
// nothing, and compaction must never delete a row the stored snapshot
// doesn't contain.
//
// The in-memory backend (no DATABASE_URL) runs the identical protocol code
// paths index.ts uses, so the recovery/compaction semantics proven here
// are the semantics prod runs — only the row storage differs. The Postgres
// failure paths (transient error swallow, FK 23503, missing table 42P01)
// are covered with the same mocked-pg pattern db.test.ts uses.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';

// Shared pg mock (Postgres-path tests only; memory-path tests never touch it).
const queryMock = vi.fn();
vi.mock('pg', () => {
  class Pool {
    query = queryMock;
    on = vi.fn();
    constructor(_cfg: unknown) {}
  }
  return { default: { Pool }, Pool };
});

/** Fresh module instance per test so USE_MEMORY re-reads DATABASE_URL. */
async function importJournal() {
  return import('./journal.js');
}

/** A tiny "rack" edit: set a key in the nodes map inside a transaction. */
function edit(doc: Y.Doc, key: string, value: string): void {
  doc.transact(() => {
    doc.getMap('nodes').set(key, value);
  });
}

function nodesOf(doc: Y.Doc): Record<string, unknown> {
  return Object.fromEntries(doc.getMap('nodes').entries());
}

describe('journal — memory backend protocol (real Y.Docs)', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.DATABASE_URL;
  });

  it('append → load returns entries in seq order', async () => {
    const j = await importJournal();
    j._resetMemoryJournal();
    await j.appendJournalUpdate('rack-a', new Uint8Array([1]));
    await j.appendJournalUpdate('rack-a', new Uint8Array([2]));
    await j.appendJournalUpdate('rack-b', new Uint8Array([3]));
    const a = await j.loadJournalUpdates('rack-a');
    expect(a.map((e) => [...e.update])).toEqual([[1], [2]]);
    expect(a[0]!.seq).toBeLessThan(a[1]!.seq);
    // Racks are isolated.
    expect((await j.loadJournalUpdates('rack-b')).map((e) => [...e.update])).toEqual([[3]]);
    expect(await j.loadJournalUpdates('rack-none')).toEqual([]);
  });

  it('CRASH RECOVERY: snapshot + journal replay reconstructs every edit', async () => {
    const j = await importJournal();
    j._resetMemoryJournal();

    // Live doc on the relay; every incremental update is journaled the way
    // index.ts's onChange does it.
    const live = new Y.Doc();
    live.on('update', (u: Uint8Array) => {
      void j.appendJournalUpdate('rack-a', u);
    });

    edit(live, 'osc-1', 'sine');
    edit(live, 'vcf-1', 'lowpass');

    // Debounced snapshot fires: watermark BEFORE encode, then store, then
    // compact <= watermark (the index.ts onStoreDocument protocol).
    const watermark = await j.latestJournalSeq('rack-a');
    const snapshot = Y.encodeStateAsUpdate(live);
    expect(watermark).not.toBeNull();
    await j.compactJournal('rack-a', watermark!);

    // More edits after the snapshot — the crash window.
    edit(live, 'lfo-1', 'triangle');
    edit(live, 'osc-1', 'saw'); // overwrite too, not just adds

    // CRASH. Recover on a fresh doc: snapshot + journal replay.
    const recovered = new Y.Doc();
    Y.applyUpdate(recovered, snapshot);
    for (const entry of await j.loadJournalUpdates('rack-a')) {
      Y.applyUpdate(recovered, entry.update);
    }
    expect(nodesOf(recovered)).toEqual({ 'osc-1': 'saw', 'vcf-1': 'lowpass', 'lfo-1': 'triangle' });
    expect(nodesOf(recovered)).toEqual(nodesOf(live));
  });

  it('replaying rows the snapshot ALREADY contains is a harmless no-op (idempotence)', async () => {
    const j = await importJournal();
    j._resetMemoryJournal();

    const live = new Y.Doc();
    live.on('update', (u: Uint8Array) => {
      void j.appendJournalUpdate('rack-a', u);
    });
    edit(live, 'osc-1', 'sine');
    edit(live, 'vcf-1', 'lowpass');

    // Snapshot succeeds but compaction never ran (e.g. crash right between
    // store and compact) — every journaled row overlaps the snapshot.
    const snapshot = Y.encodeStateAsUpdate(live);
    const recovered = new Y.Doc();
    Y.applyUpdate(recovered, snapshot);
    for (const entry of await j.loadJournalUpdates('rack-a')) {
      Y.applyUpdate(recovered, entry.update);
    }
    expect(nodesOf(recovered)).toEqual(nodesOf(live));
  });

  it('compaction is bounded by the watermark: post-watermark rows survive', async () => {
    const j = await importJournal();
    j._resetMemoryJournal();
    await j.appendJournalUpdate('rack-a', new Uint8Array([1]));
    await j.appendJournalUpdate('rack-a', new Uint8Array([2]));
    const watermark = (await j.latestJournalSeq('rack-a'))!;
    await j.appendJournalUpdate('rack-a', new Uint8Array([3])); // lands after watermark
    const removed = await j.compactJournal('rack-a', watermark);
    expect(removed).toBe(2);
    const left = await j.loadJournalUpdates('rack-a');
    expect(left.map((e) => [...e.update])).toEqual([[3]]);
  });

  it('latestJournalSeq is null for an empty rack (→ no compaction possible)', async () => {
    const j = await importJournal();
    j._resetMemoryJournal();
    expect(await j.latestJournalSeq('rack-a')).toBeNull();
  });

  it('recovery works from journal ALONE (crash before the first snapshot)', async () => {
    const j = await importJournal();
    j._resetMemoryJournal();
    const live = new Y.Doc();
    live.on('update', (u: Uint8Array) => {
      void j.appendJournalUpdate('rack-a', u);
    });
    edit(live, 'osc-1', 'sine');

    const recovered = new Y.Doc();
    for (const entry of await j.loadJournalUpdates('rack-a')) {
      Y.applyUpdate(recovered, entry.update);
    }
    expect(nodesOf(recovered)).toEqual({ 'osc-1': 'sine' });
  });
});

describe('journal — Postgres backend failure paths (mocked pg, db.test.ts pattern)', () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/test';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DATABASE_URL;
  });

  it('append inserts rack_id + bytes', async () => {
    const j = await importJournal();
    queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await j.appendJournalUpdate('rack-a', new Uint8Array([7, 8]));
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0]!;
    expect(sql).toContain('INSERT INTO rack_update_journal');
    expect(params[0]).toBe('rack-a');
    expect([...(params[1] as Buffer)]).toEqual([7, 8]);
  });

  it('append SWALLOWS a transient pg error (relay must never crash)', async () => {
    const j = await importJournal();
    const boom = Object.assign(new Error('Authentication timed out'), { code: '08P01' });
    queryMock.mockRejectedValueOnce(boom);
    await expect(j.appendJournalUpdate('rack-a', new Uint8Array([1]))).resolves.toBeUndefined();
  });

  it('append swallows FK 23503 silently (ephemeral Playwright racks)', async () => {
    const j = await importJournal();
    const fk = Object.assign(new Error('violates foreign key'), { code: '23503' });
    queryMock.mockRejectedValueOnce(fk);
    await j.appendJournalUpdate('rack-a', new Uint8Array([1]));
    expect(console.error).not.toHaveBeenCalled();
  });

  it('missing table (42P01) warns ONCE and degrades to snapshot-only', async () => {
    const j = await importJournal();
    const missing = Object.assign(new Error('relation "rack_update_journal" does not exist'), {
      code: '42P01',
    });
    queryMock.mockRejectedValue(missing);
    await j.appendJournalUpdate('rack-a', new Uint8Array([1]));
    await j.appendJournalUpdate('rack-a', new Uint8Array([2]));
    expect(await j.loadJournalUpdates('rack-a')).toEqual([]);
    expect(await j.latestJournalSeq('rack-a')).toBeNull();
    expect(await j.compactJournal('rack-a', 99)).toBe(0);
    // One tagged line total, not one per call.
    const tagged = (console.error as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).includes('event=relay_journal_table_missing'),
    );
    expect(tagged).toHaveLength(1);
  });

  it('load returns [] on read error (doc load degrades to snapshot-only, never blocks)', async () => {
    const j = await importJournal();
    queryMock.mockRejectedValueOnce(new Error('connection refused'));
    expect(await j.loadJournalUpdates('rack-a')).toEqual([]);
  });

  it('load maps rows to seq-ordered entries', async () => {
    const j = await importJournal();
    queryMock.mockResolvedValueOnce({
      rowCount: 2,
      rows: [
        { seq: '5', yjs_update: Buffer.from([1]) },
        { seq: '9', yjs_update: Buffer.from([2]) },
      ],
    });
    const entries = await j.loadJournalUpdates('rack-a');
    expect(entries).toEqual([
      { seq: 5, update: new Uint8Array([1]) },
      { seq: 9, update: new Uint8Array([2]) },
    ]);
  });

  it('latestJournalSeq returns the MAX(seq) and null when empty or erroring', async () => {
    const j = await importJournal();
    queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [{ max: '42' }] });
    expect(await j.latestJournalSeq('rack-a')).toBe(42);
    queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [{ max: null }] });
    expect(await j.latestJournalSeq('rack-a')).toBeNull();
    queryMock.mockRejectedValueOnce(new Error('nope'));
    expect(await j.latestJournalSeq('rack-a')).toBeNull(); // → skip compaction (safe)
  });

  it('compact deletes <= seq and swallows errors as 0 (under-delete is safe)', async () => {
    const j = await importJournal();
    queryMock.mockResolvedValueOnce({ rowCount: 3, rows: [] });
    expect(await j.compactJournal('rack-a', 42)).toBe(3);
    const [sql, params] = queryMock.mock.calls[0]!;
    expect(sql).toContain('DELETE FROM rack_update_journal');
    expect(sql).toContain('seq <= $2');
    expect(params).toEqual(['rack-a', 42]);
    queryMock.mockRejectedValueOnce(new Error('nope'));
    expect(await j.compactJournal('rack-a', 42)).toBe(0);
  });
});
