// packages/web/src/lib/observability/sentry-config.test.ts

import { afterEach, describe, expect, it, vi } from 'vitest';
import { sentryEnabled, sentryEnvironment, sentryRelease } from './sentry-config';

// sentry-config reads VITE_APP_VERSION from import.meta.env (build-inlined) with
// a process.env fallback that exists specifically as this test seam. vitest's
// vi.stubEnv writes to process.env, so it drives the fallback. (Each module's
// import.meta.env is a separate transformed object in vitest, so mutating it
// from the test wouldn't reach the source — hence the process.env seam.)
function setVersion(v: string | undefined): void {
  if (v === undefined) vi.stubEnv('VITE_APP_VERSION', '');
  else vi.stubEnv('VITE_APP_VERSION', v);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sentryEnabled', () => {
  it('is false for undefined / null / empty / whitespace DSN (the no-op gate)', () => {
    expect(sentryEnabled(undefined)).toBe(false);
    expect(sentryEnabled(null)).toBe(false);
    expect(sentryEnabled('')).toBe(false);
    expect(sentryEnabled('   ')).toBe(false);
  });

  it('is true for a non-empty DSN', () => {
    expect(sentryEnabled('https://abc@o1.ingest.sentry.io/2')).toBe(true);
  });
});

describe('sentryRelease', () => {
  it('returns undefined when VITE_APP_VERSION is unset or the "unknown" sentinel', () => {
    setVersion(undefined);
    expect(sentryRelease()).toBeUndefined();
    setVersion('unknown');
    expect(sentryRelease()).toBeUndefined();
  });

  it('returns the version when set', () => {
    setVersion('0.0.0-prod');
    expect(sentryRelease()).toBe('0.0.0-prod');
  });
});

describe('sentryEnvironment', () => {
  it('is "local" when no release is baked', () => {
    setVersion(undefined);
    expect(sentryEnvironment()).toBe('local');
  });

  it('derives the tier from the release suffix the deploy workflow appends', () => {
    for (const tier of ['prod', 'dev', 'autotest', 'preview']) {
      setVersion(`1.2.3-${tier}`);
      expect(sentryEnvironment()).toBe(tier);
    }
  });

  it('is "unknown" for an unrecognized suffix', () => {
    setVersion('1.2.3-weird');
    expect(sentryEnvironment()).toBe('unknown');
  });
});
