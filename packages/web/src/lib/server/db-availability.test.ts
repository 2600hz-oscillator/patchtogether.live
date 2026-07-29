// packages/web/src/lib/server/db-availability.test.ts
//
// The classifier has ONE job: separate "the database is unreachable" (503,
// degrade) from "our SQL is wrong" (500, stay loud). Both halves are asserted,
// because getting the SECOND half wrong is the dangerous failure — it would
// silently blind the /r/[id] live-smoke canary that has already caught a real
// P0 (the migration-005 42809 read bug).
//
// NEGATIVE CONTROL, per the repo's VALIDATE-THE-INSTRUMENT standard: the
// `preserves the canary` block feeds in the exact SQLSTATEs from that incident
// and asserts they are NOT degraded. If someone widens the classifier to
// "any DB error → 503", those tests fail.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isDbUnavailableError,
  dbRead,
  DB_UNAVAILABLE_MESSAGE,
} from './db-availability';

/** The VERBATIM error text the Neon HTTP driver produced during the
 *  2026-07-28 compute-quota incident (captured from autotest/dev/prod
 *  /api/health `deps.database.error`). */
const NEON_402_MESSAGE =
  'Server error (HTTP status 402): {"message":"Your account or project has ' +
  'exceeded the compute time quota. Upgrade your plan to increase limits.",' +
  '"code":"","detail":null,"hint":null,"position":null,"internalPosition":null,' +
  '"internalQuery":null,"severity":"","where":null,"table":null,"column":null,' +
  '"schema":null,"dataType":null,"constraint":null,"file":null,"line":null,' +
  '"routine":null,"neon:retryable":true}';

describe('isDbUnavailableError — degrades genuine unreachability', () => {
  it('classifies the real Neon 402 compute-quota error as unavailable', () => {
    expect(isDbUnavailableError(new Error(NEON_402_MESSAGE))).toBe(true);
  });

  it.each([
    ['402 quota', 'Server error (HTTP status 402): {}'],
    ['408 timeout', 'Server error (HTTP status 408): {}'],
    ['429 rate limit', 'Server error (HTTP status 429): {}'],
    ['500 gateway', 'Server error (HTTP status 500): {}'],
    ['503 gateway', 'Server error (HTTP status 503): {}'],
  ])('classifies Neon gateway %s as unavailable', (_label, message) => {
    expect(isDbUnavailableError(new Error(message))).toBe(true);
  });

  it.each([
    ['undici fetch failure', 'fetch failed'],
    ['connection refused', 'connect ECONNREFUSED 127.0.0.1:5432'],
    ['connection reset', 'read ECONNRESET'],
    ['dns failure', 'getaddrinfo ENOTFOUND ep-foo.neon.tech'],
    ['socket timeout', 'connect ETIMEDOUT'],
    ['abort', 'The operation was aborted'],
  ])('classifies transport failure (%s) as unavailable', (_label, message) => {
    expect(isDbUnavailableError(new Error(message))).toBe(true);
  });

  it('honours an explicit neon:retryable flag even without a known status', () => {
    expect(
      isDbUnavailableError(new Error('Server error: {"neon:retryable":true}')),
    ).toBe(true);
  });

  it('classifies an AbortError by name', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(isDbUnavailableError(err)).toBe(true);
  });
});

describe('isDbUnavailableError — PRESERVES THE CANARY (negative control)', () => {
  // If any of these start returning true, a schema/query bug would render as a
  // friendly 503 and the live smoke would go green while the app is broken.
  it('does NOT degrade 42809 — the migration-005 `r.mode` ordered-set aggregate bug', () => {
    const err = Object.assign(
      new Error('WITHIN GROUP is required for ordered-set aggregate mode'),
      { code: '42809' },
    );
    expect(isDbUnavailableError(err)).toBe(false);
  });

  it('does NOT degrade 42703 — undefined_column (bare `mode` on writes)', () => {
    const err = Object.assign(new Error('column "mode" does not exist'), {
      code: '42703',
    });
    expect(isDbUnavailableError(err)).toBe(false);
  });

  it.each([
    ['42P01 undefined_table', '42P01', 'relation "racks" does not exist'],
    ['42601 syntax_error', '42601', 'syntax error at or near "SELCT"'],
    ['23505 unique_violation', '23505', 'duplicate key value violates unique constraint'],
    ['23503 foreign_key_violation', '23503', 'insert or update violates foreign key constraint'],
  ])('does NOT degrade %s', (_label, code, message) => {
    expect(isDbUnavailableError(Object.assign(new Error(message), { code }))).toBe(false);
  });

  it('a SQLSTATE wins even when the message looks transport-ish', () => {
    // Postgres ANSWERED (it gave us a SQLSTATE), so this is our bug regardless
    // of what words happen to be in the message.
    const err = Object.assign(new Error('fetch failed while planning'), {
      code: '42703',
    });
    expect(isDbUnavailableError(err)).toBe(false);
  });

  it('does NOT degrade auth/config gateway statuses (401/403/404)', () => {
    // A revoked token or wrong connection string is a MISCONFIGURATION and must
    // stay loud rather than look like a transient blip.
    for (const status of [400, 401, 403, 404]) {
      expect(
        isDbUnavailableError(new Error(`Server error (HTTP status ${status}): {}`)),
        `HTTP ${status} must not degrade`,
      ).toBe(false);
    }
  });

  it('does NOT degrade an unrecognised error (safe default)', () => {
    expect(isDbUnavailableError(new Error('something entirely novel'))).toBe(false);
    expect(isDbUnavailableError(null)).toBe(false);
    expect(isDbUnavailableError(undefined)).toBe(false);
    expect(isDbUnavailableError('plain string')).toBe(false);
    expect(isDbUnavailableError({})).toBe(false);
  });
});

describe('dbRead', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('passes the value through on success', async () => {
    await expect(dbRead('op', async () => 'value')).resolves.toBe('value');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('throws a 503 HttpError when the database is unreachable', async () => {
    const thrown = await dbRead('getRackspace', async () => {
      throw new Error(NEON_402_MESSAGE);
    }).then(
      () => null,
      (e) => e,
    );

    expect(thrown).toBeTruthy();
    expect(thrown.status).toBe(503);
    expect(thrown.body?.message).toBe(DB_UNAVAILABLE_MESSAGE);
  });

  it('logs a greppable single-line JSON diagnostic when it degrades', async () => {
    await dbRead('getRackspace', async () => {
      throw new Error(NEON_402_MESSAGE);
    }).catch(() => {});

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0][0]);
    // Single line — greppable out of `wrangler pages tail`.
    expect(line).not.toContain('\n');
    const parsed = JSON.parse(line);
    expect(parsed.tag).toBe('db-unavailable');
    expect(parsed.op).toBe('getRackspace');
    expect(parsed.message).toContain('compute time quota');
  });

  it('RETHROWS a SQLSTATE error unchanged (so it still 500s)', async () => {
    const original = Object.assign(new Error('aggregate mode'), { code: '42809' });
    const thrown = await dbRead('getRackspace', async () => {
      throw original;
    }).then(
      () => null,
      (e) => e,
    );

    // Identity, not just shape: nothing wrapped or reclassified it.
    expect(thrown).toBe(original);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does not swallow SvelteKit control-flow throws it did not cause', async () => {
    // Defensive: dbRead wraps only the DB call, but if a redirect object ever
    // reached it, it must pass straight through rather than become a 503.
    const redirectLike = { status: 303, location: '/sign-in' };
    const thrown = await dbRead('op', async () => {
      throw redirectLike;
    }).then(
      () => null,
      (e) => e,
    );
    expect(thrown).toBe(redirectLike);
  });
});
