// packages/web/src/lib/server/test-helpers/neon-pg-shim.ts
//
// Minimal Neon-HTTP-shape facade backed by a real `pg` Pool. Lets the
// rackspaces capacity-race test exercise the production join code (which
// uses `sql.transaction([advisory_lock, CTE])`) against a real Postgres
// — proving the lock actually serializes concurrent joins, not just that
// the code path runs.
//
// The Neon HTTP `sql` template has two shapes the rackspaces.ts code uses:
//
//   sql`SELECT ... ${p1} ... ${p2}`             → Promise<Row[]>
//   sql.transaction([sql`...`, sql`...`])       → Promise<Row[][]>
//
// We implement both with `pg`. The transaction shape is the load-bearing
// one — it MUST run the advisory_lock and the CTE inside a single
// BEGIN/COMMIT (otherwise the lock releases before the CTE runs and
// the test would be vacuous).
//
// Not intended for prod use — only the queries the rackspaces module
// happens to need are supported.

import type pg from 'pg';

/** A "deferred query" — the template-literal we captured for later
 *  execution inside transaction(). Mirrors Neon's NeonQueryPromise. */
interface DeferredQuery {
  __isNeonShim: true;
  text: string;
  values: unknown[];
  /** When awaited directly (no transaction), runs against the pool with its
   *  own implicit tx. MUST honor the full thenable contract (onRejected too):
   *  before 2026-07-11 the rejection handler was dropped, so a FAILING
   *  standalone query never settled its awaiter (test timeout) and surfaced
   *  as an unhandled rejection — first hit by the 42703 mode-fallback test. */
  then: <T>(
    resolve: (v: Record<string, unknown>[]) => T,
    reject?: (err: unknown) => T,
  ) => Promise<T>;
}

function buildPgQuery(strings: TemplateStringsArray, params: unknown[]): { text: string; values: unknown[] } {
  // Convert tagged-template parts into a $1/$2 placeholder string the
  // way Neon's HTTP API does. Pure positional substitution; we don't
  // try to spread arrays or handle sub-queries (rackspaces.ts doesn't
  // use those features).
  let text = strings[0];
  for (let i = 0; i < params.length; i++) {
    text += `$${i + 1}` + strings[i + 1];
  }
  return { text, values: params };
}

export interface NeonShim {
  (strings: TemplateStringsArray, ...params: unknown[]): DeferredQuery;
  transaction: (queries: DeferredQuery[]) => Promise<Record<string, unknown>[][]>;
}

export function neonShim(pool: pg.Pool): NeonShim {
  const tag: NeonShim = ((strings: TemplateStringsArray, ...params: unknown[]) => {
    const { text, values } = buildPgQuery(strings, params);
    const deferred: DeferredQuery = {
      __isNeonShim: true,
      text,
      values,
      // Thenable: awaiting the deferred runs its own one-off query against
      // the pool. Inside transaction() we read .text/.values directly and
      // never await it, so this branch only fires for stand-alone queries.
      then: (<T>(
        onFulfilled: (v: Record<string, unknown>[]) => T,
        onRejected?: (err: unknown) => T,
      ) =>
        pool.query(text, values).then((r) => onFulfilled(r.rows), onRejected)) as DeferredQuery['then'],
    };
    return deferred;
  }) as NeonShim;

  tag.transaction = async (queries: DeferredQuery[]): Promise<Record<string, unknown>[][]> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const results: Record<string, unknown>[][] = [];
      for (const q of queries) {
        const r = await client.query(q.text, q.values);
        results.push(r.rows);
      }
      await client.query('COMMIT');
      return results;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback failure; the original error matters
      }
      throw err;
    } finally {
      client.release();
    }
  };

  return tag;
}
