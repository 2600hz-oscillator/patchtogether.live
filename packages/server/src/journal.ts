// packages/server/src/journal.ts
//
// Append-style PER-UPDATE journal beside the debounced snapshot store.
//
// Why: Hocuspocus persists full snapshots on a 2s/5s debounce
// (snapshot-config.ts). A relay crash between debounces loses the window;
// a snapshot-write FAILURE stretch (pg auth timeouts — the tab-switch-500
// family) loses everything since the last successful store. The journal
// closes both: every incremental Yjs update is appended as it arrives, and
// doc load replays journal rows on top of the snapshot. Yjs updates are
// idempotent + commutative under Y.applyUpdate, so replaying rows the
// snapshot already contains is harmless — which is what makes the
// recovery/compaction protocol below simple and race-safe.
//
// Protocol (wired in index.ts):
//   append   — onChange: fire-and-forget insert (never blocks or crashes
//              the relay; a lost append degrades to today's snapshot-only
//              durability for that update).
//   recover  — onLoadDocument: load snapshot, then apply every journal row
//              in seq order (skipping corrupt rows individually).
//   compact  — onStoreDocument: read the watermark seq BEFORE encoding the
//              doc, store the snapshot, and ONLY IF the store reports
//              durable (see db.ts storeSnapshot's boolean) delete rows
//              <= watermark. Ordering proof: a journal row exists at
//              watermark time ⇒ its insert completed ⇒ onChange had fired
//              ⇒ the update was already applied to the doc ⇒ the encode
//              (which happens after the watermark read) contains it.
//              Fire-and-forget appends can only make compaction miss rows
//              (under-delete) — the safe direction; leftovers replay
//              idempotently on the next load.
//
// Growth bound: steady-state ≈ one debounce window of updates per active
// rack (compaction runs on every successful store). The journal only grows
// while snapshot writes fail — exactly when it's earning its keep.
//
// Storage: same split as db.ts — Postgres when DATABASE_URL is set
// (rack_update_journal, db/schema/004_rack_update_journal.sql), else an
// in-memory map (local dev + the collab e2e suite + unit tests). The FK
// 23503 swallow mirrors storeSnapshot (ephemeral Playwright racks have no
// racks row; they don't snapshot either).

import { getPool } from './db.js';

const USE_MEMORY = !process.env.DATABASE_URL;

export interface JournalEntry {
  seq: number;
  update: Uint8Array;
}

// ── In-memory backend (no DATABASE_URL) ─────────────────────────────────────
const memJournal = new Map<string, JournalEntry[]>();
let memSeq = 0;

/** Append one incremental Yjs update. NEVER throws — persistence failures
 *  are logged and swallowed (an unhandled rejection here would be a relay
 *  crash; see relay-error-handlers.ts for why that's catastrophic). Callers
 *  fire-and-forget: `void appendJournalUpdate(…)`. */
export async function appendJournalUpdate(rackId: string, update: Uint8Array): Promise<void> {
  if (USE_MEMORY) {
    memSeq += 1;
    const list = memJournal.get(rackId) ?? [];
    list.push({ seq: memSeq, update });
    memJournal.set(rackId, list);
    return;
  }
  try {
    await getPool().query(
      'INSERT INTO rack_update_journal (rack_id, yjs_update) VALUES ($1, $2)',
      [rackId, Buffer.from(update)],
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23503') return; // ephemeral test rack — mirrors storeSnapshot
    if ((err as { code?: string }).code === '42P01') {
      // Table missing (schema 004 not applied yet): degrade loudly but
      // safely to snapshot-only durability instead of log-spamming per
      // update — one line per boot.
      warnMissingTableOnce(err as Error);
      return;
    }
    // eslint-disable-next-line no-console
    console.error(
      `[hocuspocus] journal append FAILED (snapshot-only durability for this update): doc=${rackId} ` +
        `code=${(err as { code?: string }).code ?? ''} ${(err as Error).message}`,
    );
  }
}

let warnedMissingTable = false;
function warnMissingTableOnce(err: Error): void {
  if (warnedMissingTable) return;
  warnedMissingTable = true;
  // eslint-disable-next-line no-console
  console.error(
    `event=relay_journal_table_missing level=error msg="rack_update_journal missing — ` +
      `apply db/schema/004_rack_update_journal.sql; relay degrades to snapshot-only durability" ` +
      `detail="${err.message.replace(/"/g, '\\"')}"`,
  );
}

/** All journal rows for a rack in seq order. Returns [] on any read error
 *  (load degrades to snapshot-only recovery — same as before the journal
 *  existed — rather than blocking the doc load). */
export async function loadJournalUpdates(rackId: string): Promise<JournalEntry[]> {
  if (USE_MEMORY) return [...(memJournal.get(rackId) ?? [])];
  try {
    const result = await getPool().query<{ seq: string; yjs_update: Buffer }>(
      'SELECT seq, yjs_update FROM rack_update_journal WHERE rack_id = $1 ORDER BY seq ASC',
      [rackId],
    );
    return result.rows.map((r) => ({ seq: Number(r.seq), update: new Uint8Array(r.yjs_update) }));
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') {
      warnMissingTableOnce(err as Error);
      return [];
    }
    // eslint-disable-next-line no-console
    console.error(
      `[hocuspocus] journal load FAILED (recovering from snapshot only): doc=${rackId} ` +
        `${(err as Error).message}`,
    );
    return [];
  }
}

/** Highest journal seq currently visible for a rack, or null when none.
 *  Read BEFORE encoding a snapshot — it's the compaction watermark. */
export async function latestJournalSeq(rackId: string): Promise<number | null> {
  if (USE_MEMORY) {
    const list = memJournal.get(rackId);
    return list && list.length > 0 ? list[list.length - 1]!.seq : null;
  }
  try {
    const result = await getPool().query<{ max: string | null }>(
      'SELECT MAX(seq) AS max FROM rack_update_journal WHERE rack_id = $1',
      [rackId],
    );
    const raw = result.rows[0]?.max;
    return raw == null ? null : Number(raw);
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') {
      warnMissingTableOnce(err as Error);
      return null;
    }
    // eslint-disable-next-line no-console
    console.error(`[hocuspocus] journal seq read FAILED: doc=${rackId} ${(err as Error).message}`);
    return null; // no watermark → no compaction this round (safe: under-delete)
  }
}

/** Delete journal rows with seq <= upToSeq for a rack. Call ONLY after the
 *  snapshot covering them was durably stored. Returns rows deleted (0 on
 *  swallowed error — under-deletion is safe; rows replay idempotently). */
export async function compactJournal(rackId: string, upToSeq: number): Promise<number> {
  if (USE_MEMORY) {
    const list = memJournal.get(rackId) ?? [];
    const keep = list.filter((e) => e.seq > upToSeq);
    const removed = list.length - keep.length;
    if (keep.length === 0) memJournal.delete(rackId);
    else memJournal.set(rackId, keep);
    return removed;
  }
  try {
    const result = await getPool().query(
      'DELETE FROM rack_update_journal WHERE rack_id = $1 AND seq <= $2',
      [rackId, upToSeq],
    );
    return result.rowCount ?? 0;
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') {
      warnMissingTableOnce(err as Error);
      return 0;
    }
    // eslint-disable-next-line no-console
    console.error(
      `[hocuspocus] journal compact FAILED (rows linger, replay stays idempotent): doc=${rackId} ` +
        `${(err as Error).message}`,
    );
    return 0;
  }
}

/** Test-only: wipe the in-memory journal between cases. */
export function _resetMemoryJournal(): void {
  memJournal.clear();
  memSeq = 0;
}
