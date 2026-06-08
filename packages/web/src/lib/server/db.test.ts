// packages/web/src/lib/server/db.test.ts
//
// Phase 2b: the Postgres connection-string resolver must FAIL LOUD on a
// deployed (non-dev) runtime when DATABASE_URL is unset, instead of silently
// falling back to localhost — on a Cloudflare Worker that silent fallback
// resolves to localhost and surfaces as an opaque CF 1003 "Direct IP access
// not allowed", which is exactly how the original bug hid.
//
// We test the PURE resolver (resolveConnectionString) with the env + dev flag
// injected, so all three branches are deterministic and don't depend on
// vitest's inability to toggle the build-time `import.meta.env.DEV` constant.

import { describe, it, expect, vi } from 'vitest';

// db.ts imports the SvelteKit virtual module `$env/dynamic/private`, which has
// no node resolution outside vite. The pure resolver under test doesn't touch
// it, but the import must resolve for the module to load — stub it. (The other
// server tests sidestep this by mocking `./db.js` wholesale; here we want the
// REAL resolver, so we stub only its env dependency.)
vi.mock('$env/dynamic/private', () => ({ env: {} }));

const { resolveConnectionString, LOCALHOST_DB_URL, MissingDatabaseUrlError } =
  await import('./db.js');

describe('resolveConnectionString', () => {
  const PROD_URL =
    'postgresql://user:pass@ep-cool-name-123.us-east-2.aws.neon.tech/db';

  it('(a) DATABASE_URL set → returns it (regardless of dev flag)', () => {
    // set + prod
    expect(resolveConnectionString({ databaseUrl: PROD_URL, isDev: false })).toBe(
      PROD_URL
    );
    // set + dev: the configured URL still wins over the localhost fallback
    expect(resolveConnectionString({ databaseUrl: PROD_URL, isDev: true })).toBe(
      PROD_URL
    );
  });

  it('(b) dev + unset → returns the localhost fallback', () => {
    expect(resolveConnectionString({ databaseUrl: undefined, isDev: true })).toBe(
      LOCALHOST_DB_URL
    );
    // empty string is treated as unset
    expect(resolveConnectionString({ databaseUrl: '', isDev: true })).toBe(
      LOCALHOST_DB_URL
    );
  });

  it('(c) not-dev + unset → throws the named config error', () => {
    expect(() =>
      resolveConnectionString({ databaseUrl: undefined, isDev: false })
    ).toThrow(MissingDatabaseUrlError);
    expect(() =>
      resolveConnectionString({ databaseUrl: undefined, isDev: false })
    ).toThrow(/DATABASE_URL is required in production/);
    // empty string is treated as unset on prod too → loud throw, never localhost
    expect(() =>
      resolveConnectionString({ databaseUrl: '', isDev: false })
    ).toThrow(MissingDatabaseUrlError);
  });

  it('allowLocalhost escape hatch lets a non-dev runtime fall back to localhost', () => {
    expect(
      resolveConnectionString({
        databaseUrl: undefined,
        isDev: false,
        allowLocalhost: true,
      })
    ).toBe(LOCALHOST_DB_URL);
  });

  it('never returns the localhost URL on a misconfigured deploy', () => {
    // The whole point of Phase 2b: a deployed Worker with no DATABASE_URL must
    // NOT silently point at localhost.
    let resolved: string | undefined;
    try {
      resolved = resolveConnectionString({ databaseUrl: undefined, isDev: false });
    } catch {
      resolved = undefined;
    }
    expect(resolved).not.toBe(LOCALHOST_DB_URL);
  });
});
