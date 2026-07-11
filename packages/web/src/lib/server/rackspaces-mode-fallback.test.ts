// packages/web/src/lib/server/rackspaces-mode-fallback.test.ts
//
// REGRESSION for the dev login 500 (2026-07-11): #1050 shipped code reading
// `racks.mode` while 005_rackspace_mode.sql is a MANUAL migration. Main
// auto-deploys to dev, so dev ran mode-reading queries against a pre-005
// database — every authenticated /dashboard load threw 42703 and login
// appeared broken with a 500.
//
// The fix (withModeFallback in rackspaces.ts) latches on the first
// undefined-column error and serves mode='dawless' from column-free legacy
// queries. THIS test proves it against a REAL Postgres whose racks table
// deliberately lacks the mode column — i.e. exactly dev's broken state:
// create / list / get / join must all succeed (not throw), report
// mode='dawless', and the latch must log its tagged line exactly once.
//
// Harness mirrors rackspaces-capacity.test.ts (pg.Pool + neonShim mocking
// ./db.js), but in a DEDICATED database (pt_mode_fallback_test) so dropping
// the mode column can't disturb suites that require the migrated schema.
// Per feedback_collab_tests_vacuous_without_db: if PG is unreachable the
// suite SKIPS loudly; it never skip-passes silently in CI (PG_TEST_URL set).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_001 = resolve(__dirname, '../../../../../db/schema/001_init.sql');

const ADMIN_URL =
  process.env.PG_TEST_URL ??
  process.env.DATABASE_URL ??
  'postgresql://postgres:dev@localhost:54320/patchtogether_test';

const FALLBACK_DB = 'pt_mode_fallback_test';

function withDbName(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

let pgAvailable = false;
let probeError: Error | null = null;
let pool: pg.Pool | null = null;

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  try {
    await admin.query('SELECT 1');
    // Fresh dedicated DB with ONLY 001 applied → racks has NO mode column,
    // byte-for-byte the pre-005 dev state.
    await admin.query(`DROP DATABASE IF EXISTS ${FALLBACK_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${FALLBACK_DB}`);
    pool = new pg.Pool({ connectionString: withDbName(ADMIN_URL, FALLBACK_DB), max: 5 });
    await pool.query(readFileSync(SCHEMA_001, 'utf8'));
    const modeCol = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='racks' AND column_name='mode'`,
    );
    if (modeCol.rowCount !== 0) {
      throw new Error('pre-005 fixture unexpectedly HAS racks.mode — 001_init.sql grew it?');
    }
    pgAvailable = true;
  } catch (err) {
    probeError = err as Error;
  } finally {
    await admin.end();
  }
});

afterAll(async () => {
  await pool?.end();
});

// Mock ./db.js with the shared neon-compatible pg shim (same pattern as
// rackspaces-capacity.test.ts), pointed at the dedicated pre-005 database.
// The pool is created in beforeAll; the shim call is lazy per sql() call.
vi.mock('./db.js', async () => {
  const { neonShim } = await import('./test-helpers/neon-pg-shim.js');
  return { sql: () => neonShim(pool!) };
});

describe('rackspaces mode fallback (pre-005 database — the dev login 500)', () => {
  it('create → list → get → join all serve dawless instead of throwing 42703', async () => {
    if (!pgAvailable) {
      // eslint-disable-next-line no-console
      console.error(
        `[mode-fallback] SKIP — no Postgres reachable (${probeError?.message}). ` +
          'CI must run this (PG_TEST_URL); a silent skip here would mask the login-500 class.',
      );
      expect(process.env.CI ?? '').toBe(''); // hard-fail on CI, skip locally
      return;
    }

    const { createRackspace, listRackspacesForUser, getRackspace, joinRackspace, __resetModeColumnLatchForTests } =
      await import('./rackspaces.js');
    __resetModeColumnLatchForTests();

    const errSpy = vi.spyOn(console, 'error');

    // CREATE: modern INSERT (with mode) must 42703 → latch → legacy INSERT.
    const created = await createRackspace('user_a', 'pre-005 rack', 'workflow');
    expect(created.status).toBe('ok');
    if (created.status !== 'ok') return;
    // The requested 'workflow' CANNOT be stored pre-005 — served as dawless.
    expect(created.rackspace.mode).toBe('dawless');

    // The latch line fired exactly once, tagged for the log monitors.
    const latchLines = errSpy.mock.calls.filter((c) =>
      String(c[0]).includes('event=rackspaces_mode_column_missing'),
    );
    expect(latchLines.length).toBe(1);

    // LIST (the exact query behind the post-login /dashboard 500).
    const listed = await listRackspacesForUser('user_a');
    expect(listed.map((r) => r.id)).toContain(created.rackspace.id);
    expect(listed.every((r) => r.mode === 'dawless')).toBe(true);

    // GET
    const got = await getRackspace(created.rackspace.id);
    expect(got?.mode).toBe('dawless');

    // JOIN (transactional CTE variant)
    const joined = await joinRackspace(created.rackspace.id, 'user_b');
    expect(joined.status).toBe('ok');
    if (joined.status === 'ok') expect(joined.rackspace.mode).toBe('dawless');

    // Latched: no ADDITIONAL latch lines from the later calls.
    const latchLinesAfter = errSpy.mock.calls.filter((c) =>
      String(c[0]).includes('event=rackspaces_mode_column_missing'),
    );
    expect(latchLinesAfter.length).toBe(1);
    errSpy.mockRestore();
  });

  it('post-migration behavior is untouched (latch reset + mode column present)', async () => {
    if (!pgAvailable) return;
    const { createRackspace, __resetModeColumnLatchForTests } = await import('./rackspaces.js');
    // Apply 005 to the dedicated DB, reset the latch → modern path works and
    // stores the requested mode.
    const SCHEMA_005 = resolve(__dirname, '../../../../../db/schema/005_rackspace_mode.sql');
    await pool!.query(readFileSync(SCHEMA_005, 'utf8'));
    __resetModeColumnLatchForTests();
    const created = await createRackspace('user_c', 'post-005 rack', 'workflow');
    expect(created.status).toBe('ok');
    if (created.status === 'ok') expect(created.rackspace.mode).toBe('workflow');
  });
});
