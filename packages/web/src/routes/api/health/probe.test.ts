import { describe, it, expect } from 'vitest';
import { wsToHealthUrl, probeHocuspocus, probeDatabase, skippedDatabaseProbe } from './probe';

describe('wsToHealthUrl', () => {
  it('wss → https + /health', () => {
    expect(wsToHealthUrl('wss://patchtogether-server.fly.dev')).toBe(
      'https://patchtogether-server.fly.dev/health',
    );
  });
  it('ws → http + /health', () => {
    expect(wsToHealthUrl('ws://localhost:1235')).toBe('http://localhost:1235/health');
  });
  it('strips a trailing slash before appending /health', () => {
    expect(wsToHealthUrl('wss://host/')).toBe('https://host/health');
  });
});

describe('probeHocuspocus', () => {
  const okFetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;

  it('returns a degraded reason (not a throw) when the relay url is unset', async () => {
    const r = await probeHocuspocus(undefined);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unset/);
  });

  it('reports ok + ms on a 200', async () => {
    let t = 1000;
    const r = await probeHocuspocus('wss://host', {
      fetch: okFetch,
      now: () => (t += 5),
    });
    expect(r.ok).toBe(true);
    expect(r.ms).toBe(5);
    expect(r.error).toBeUndefined();
  });

  it('reports the status code on a non-200', async () => {
    const r = await probeHocuspocus('wss://host', {
      fetch: (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/503/);
  });

  it('reports the error message when fetch rejects', async () => {
    const r = await probeHocuspocus('wss://host', {
      fetch: (async () => {
        throw new Error('connection refused');
      }) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/connection refused/);
  });

  it('aborts after the timeout and never hangs', async () => {
    // A fetch that only settles when its abort signal fires.
    const hangingFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const r = await probeHocuspocus('wss://host', { fetch: hangingFetch, timeoutMs: 5 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/abort/i);
  });
});

describe('probeDatabase', () => {
  it('returns a reason (not a throw) when DATABASE_URL is unset', async () => {
    const r = await probeDatabase(false);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unset/);
  });

  it('reachable + racks table present → ok, schema=current, ms', async () => {
    let t = 1000;
    const r = await probeDatabase(true, {
      queryRacksTableCount: async () => 1, // information_schema returned the table
      now: () => (t += 7),
    });
    expect(r.ok).toBe(true);
    expect(r.schema).toBe('current');
    expect(r.ms).toBe(7);
    expect(r.error).toBeUndefined();
  });

  it('reachable but unmigrated (no racks table) → ok, schema=racks-missing', async () => {
    const r = await probeDatabase(true, { queryRacksTableCount: async () => 0 });
    expect(r.ok).toBe(true);
    expect(r.schema).toBe('racks-missing'); // the deploy-before-migrate drift signal
  });

  it('reports the error (not a throw) when the query REJECTS (db unreachable)', async () => {
    const r = await probeDatabase(true, {
      queryRacksTableCount: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(r.ok).toBe(false);
    expect(r.schema).toBeUndefined();
    expect(r.error).toMatch(/ECONNREFUSED/);
  });

  it('times out and never hangs when the query stalls', async () => {
    const r = await probeDatabase(true, {
      queryRacksTableCount: () => new Promise<number>(() => {}), // never settles
      timeoutMs: 5,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// THE SHALLOW DEFAULT — and the derived-field traps it sets.
//
// `/api/health` is polled every 3 MINUTES by Better Stack on prod and dev
// (confirmed in the dashboard 2026-08-11; the setup doc's "30s" is stale).
// Neon suspends idle compute after 300s, so a DB read on that path meant the
// gap never opened: both branches ~99% awake from 2026-07-19, compute 99.8% of
// the bill, and the 2026-07-29 HTTP 402 outage. Hence `?deep=1`.
//
// The subtle part is not skipping the query — it is that `ok` becomes `null`,
// and every downstream `!database.ok` then reads an UNASKED question as a BAD
// ANSWER. Both traps below were live in the first draft of this change.
describe('skippedDatabaseProbe — an unasked question is not a bad answer', () => {
  it('reports ok=null and probed=false, NOT ok=false', () => {
    const r = skippedDatabaseProbe('shallow');
    // ok=false would be a LIE: it claims the DB was found unreachable.
    expect(r.ok).toBeNull();
    expect(r.probed).toBe(false);
    expect(r.skipped).toBe('shallow');
  });

  it('the field is PRESENT, so a consumer can tell "not probed" from "gone"', () => {
    // Omitting deps.database entirely would make a monitor that reads
    // `.deps.database.ok` see `null` either way — indistinguishable from a
    // refactor that dropped the field. `probed` is the discriminator.
    expect(Object.prototype.hasOwnProperty.call(skippedDatabaseProbe('x'), 'probed')).toBe(true);
  });

  it('every REAL probe result is marked probed=true (the flag is not shallow-only)', async () => {
    // If only the skipped path set `probed`, `probed === true` could never be
    // asserted by the smoke script — the check would pass vacuously on every
    // real response by being absent rather than false.
    expect((await probeDatabase(true, { queryRacksTableCount: async () => 1 })).probed).toBe(true);
    expect((await probeDatabase(true, { queryRacksTableCount: async () => 0 })).probed).toBe(true);
    expect((await probeDatabase(false)).probed).toBe(true);
    const threw = await probeDatabase(true, {
      queryRacksTableCount: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(threw.probed).toBe(true);
  });

  it('TRAP 1: a naive `!ok` reads the skipped probe as unreachable', () => {
    const skipped = skippedDatabaseProbe('shallow');
    // This is the +server.ts status expression BEFORE the `deep &&` guard.
    // It must be demonstrably wrong, or the guard has nothing to defend.
    expect(!skipped.ok).toBe(true); // ← would have reported status:'down'
    // The guarded form, which is what ships:
    const deep = false;
    expect(deep && !skipped.ok).toBe(false);
  });

  it('TRAP 2: `ok === true` is the safe test for the degraded branch', () => {
    const skipped = skippedDatabaseProbe('shallow');
    // `skipped.ok && …` is falsy-correct by luck; `ok === true` says what it
    // means and survives ok becoming any other falsy sentinel later.
    expect(skipped.ok === true).toBe(false);
  });
});
