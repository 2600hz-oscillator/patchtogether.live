// packages/web/src/lib/server/rackspaces-capacity.test.ts
//
// Regression for the joinRackspace capacity-race window flagged by the Codex
// audit: the original CTE checked `counts.n < MAX_MEMBERS` and INSERTed in
// the same statement, but without a row lock two concurrent joins on the
// last slot would both see `n=3`, both pass the guard, and both succeed —
// over-filling the rack to 5 members. The fix is `pg_advisory_xact_lock`
// keyed per-rack, held for the transaction's lifetime.
//
// To prove the lock actually fires (not just that the code path runs), this
// test hits a REAL Postgres via `pg` — the production code uses Neon's HTTP
// `transaction([...])` API; we mock `./db.js` to expose the same surface
// backed by a local pg.Pool. That makes the test exercise the real SQL
// semantics: BEGIN, pg_advisory_xact_lock, the CTE, COMMIT, the lock-release
// — end to end against Postgres.
//
// Skips with an obvious log if no local Postgres is reachable (no DATABASE_URL
// + no localhost:54320). CI runs with PG_TEST_URL set.
//
// Per memory feedback_collab_tests_vacuous_without_db: we ASSERT that
// the test actually hit Postgres (not just skip-passed); if the fallback
// pg connection fails we hard-fail rather than masquerade as green.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { neonShim } from './test-helpers/neon-pg-shim.js';

const TEST_DB_URL =
  process.env.PG_TEST_URL ??
  process.env.DATABASE_URL ??
  'postgresql://postgres:dev@localhost:54320/patchtogether_test';

const pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 10 });

// Probe once before any tests; if PG isn't reachable, skip the whole suite
// with a loud reason rather than silently passing.
let pgAvailable = false;
let probeError: Error | null = null;

beforeAll(async () => {
  try {
    await pool.query('SELECT 1');
    // Make sure the schema we need is present (test DB might be empty).
    const tablesPresent = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name IN ('racks','rack_members')`,
    );
    if (tablesPresent.rowCount !== 2) {
      throw new Error(
        `test DB missing schema (need 'racks' + 'rack_members' tables; ` +
          `got: ${tablesPresent.rows.map((r) => r.table_name).join(', ')}). ` +
          `Apply db/schema/001_init.sql to ${TEST_DB_URL}.`,
      );
    }
    // createRackspace/joinRackspace now read/write racks.mode (workflow-mode
    // P1) — probe for the column so a not-yet-migrated test DB fails with an
    // actionable message instead of a mid-test SQL error.
    const modeColumn = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='racks' AND column_name='mode'`,
    );
    if (modeColumn.rowCount !== 1) {
      throw new Error(
        `test DB missing the racks.mode column. ` +
          `Apply db/schema/005_rackspace_mode.sql to ${TEST_DB_URL}.`,
      );
    }
    pgAvailable = true;
  } catch (e) {
    probeError = e as Error;
  }
});

afterAll(async () => {
  await pool.end();
});

// Hook the shim into the rackspaces module by mocking ./db.js
import { vi } from 'vitest';
vi.mock('./db.js', () => ({
  sql: () => neonShim(pool),
}));

const { joinRackspace, createRackspace } = await import('./rackspaces');

async function freshFullishRack(): Promise<string> {
  // Seed: 1 owner + 2 members = 3/4. Use createRackspace then 2 joins to
  // exercise the full production path (so the test confirms the seeding
  // path also still works with the lock change).
  const ownerId = `u_owner_${Math.random().toString(36).slice(2, 10)}`;
  const created = await createRackspace(ownerId, 'race-test-rack');
  if (created.status !== 'ok') throw new Error(`seed failed: ${created.status}`);
  const rackId = created.rackspace.id;
  // Add two real members so the rack sits at 3/4 going in.
  const r1 = await joinRackspace(rackId, `u_seed1_${Math.random().toString(36).slice(2, 8)}`);
  expect(r1.status).toBe('ok');
  const r2 = await joinRackspace(rackId, `u_seed2_${Math.random().toString(36).slice(2, 8)}`);
  expect(r2.status).toBe('ok');
  return rackId;
}

describe.skipIf(!process.env.RUN_DB_TESTS && !process.env.CI)(
  'joinRackspace — capacity race (real Postgres)',
  () => {
    beforeEach(() => {
      if (!pgAvailable) {
        throw new Error(
          `Postgres test DB unreachable at ${TEST_DB_URL}: ${probeError?.message ?? 'unknown'}. ` +
            `This test MUST actually hit Postgres; refusing to skip-pass. ` +
            `Set PG_TEST_URL or start local Postgres on :54320 with patchtogether_test.`,
        );
      }
    });

    it('with the advisory lock, two simultaneous joins on the LAST slot: exactly one wins (N=20)', async () => {
      // 20 independent racks, each at 3/4. For each rack, fire two joins
      // concurrently. The cap is 4. Without the lock, both can land
      // (rack ends at 5 members). With the lock, exactly one lands and
      // the other gets `status: 'full'`.
      const iterations = 20;
      const tallies = { ok: 0, full: 0, other: 0, totalMembersOver4: 0 };
      for (let i = 0; i < iterations; i++) {
        const rackId = await freshFullishRack();
        const userA = `u_raceA_${i}_${Math.random().toString(36).slice(2, 8)}`;
        const userB = `u_raceB_${i}_${Math.random().toString(36).slice(2, 8)}`;
        const [resA, resB] = await Promise.all([
          joinRackspace(rackId, userA),
          joinRackspace(rackId, userB),
        ]);
        for (const r of [resA, resB]) {
          if (r.status === 'ok') tallies.ok++;
          else if (r.status === 'full') tallies.full++;
          else tallies.other++;
        }
        // Independent ground-truth check: query the DB directly. This
        // verifies the lock actually held (not just that the code path
        // returned 'full' for the right one).
        const count = await pool.query<{ n: string }>(
          'SELECT COUNT(*)::text AS n FROM rack_members WHERE rack_id = $1',
          [rackId],
        );
        const n = Number(count.rows[0].n);
        if (n > 4) tallies.totalMembersOver4++;
        expect(n, `rack ${rackId} exceeded 4 members (got ${n})`).toBe(4);
      }

      // Aggregate assertion: exactly one OK and one FULL per pair, never
      // both OK, never both FULL. 20 iterations → 20 ok + 20 full + 0 other.
      expect(tallies).toEqual({ ok: iterations, full: iterations, other: 0, totalMembersOver4: 0 });
    }, 30_000);

    it('two simultaneous joins when there is room for BOTH succeed', async () => {
      // Rack at 1/4 (owner only). Two joins should both land.
      const ownerId = `u_owner_${Math.random().toString(36).slice(2, 10)}`;
      const created = await createRackspace(ownerId, 'roomy');
      if (created.status !== 'ok') throw new Error(`seed failed: ${created.status}`);
      const rackId = created.rackspace.id;
      const userA = `u_A_${Math.random().toString(36).slice(2, 8)}`;
      const userB = `u_B_${Math.random().toString(36).slice(2, 8)}`;
      const [resA, resB] = await Promise.all([
        joinRackspace(rackId, userA),
        joinRackspace(rackId, userB),
      ]);
      expect(resA.status).toBe('ok');
      expect(resB.status).toBe('ok');
      const count = await pool.query<{ n: string }>(
        'SELECT COUNT(*)::text AS n FROM rack_members WHERE rack_id = $1',
        [rackId],
      );
      expect(Number(count.rows[0].n)).toBe(3);
    });
  },
);
