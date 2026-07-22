// packages/web/src/hooks.server.test.ts
//
// Targeted tests for the beta-gate carve-out. Importing hooks.server.ts
// pulls in $env/dynamic/* which is a SvelteKit virtual module — vitest
// doesn't have it in its module graph by default. To keep this test
// hermetic we mock the env modules to an empty Record so the import
// doesn't throw at collect time.

import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));
// PUBLIC_SENTRY_DSN is deliberately ABSENT here — this is the no-op gating
// case the whole Sentry wiring is built around (local/CI/prod-pre-DSN).
vi.mock('$env/dynamic/public', () => ({ env: {} }));
// withClerkHandler reads from process.env synchronously and bombs out at
// import time when its expected vars are missing. Stub the whole module.
vi.mock('svelte-clerk/server', () => ({
  withClerkHandler: () => async (_args: unknown) => new Response(''),
}));
// Spy on the server-side Sentry module so we can assert it is NEVER touched
// when the DSN is unset. If the gate regressed, ensureSentryServer would be
// imported + called and this mock would record it.
const ensureSentryServer = vi.fn();
const captureServerError = vi.fn();
vi.mock('$lib/observability/sentry-server', () => ({
  ensureSentryServer,
  captureServerError,
}));

import {
  accessLogShipTarget,
  handleError,
  isBetaGatePublic,
  isIsolatedPath,
} from './hooks.server';

describe('isIsolatedPath — COOP/COEP route scoping', () => {
  it('isolates the engine-hosting routes: /rack, /present, /r/*, and the mobile pair', () => {
    expect(isIsolatedPath('/rack')).toBe(true);
    expect(isIsolatedPath('/present')).toBe(true);
    expect(isIsolatedPath('/r/abc123')).toBe(true);
    // Mobile prototype: both engine-hosting routes get the same belt-and-
    // suspenders isolation headers as /rack (COOP same-origin + COEP
    // credentialless) so SAB-gated features keep working in dev.
    expect(isIsolatedPath('/m/cam')).toBe(true);
    expect(isIsolatedPath('/m/synth')).toBe(true);
  });

  it('does NOT isolate the static /m chooser, the landing, or auth routes', () => {
    // /m is a static chooser — no engine, no SAB, and isolation headers on it
    // would only cost third-party-resource compatibility for no benefit.
    expect(isIsolatedPath('/m')).toBe(false);
    expect(isIsolatedPath('/')).toBe(false);
    expect(isIsolatedPath('/sign-in')).toBe(false);
    expect(isIsolatedPath('/dashboard')).toBe(false);
    // Exact-match only — no prefix bleed from the mobile pair.
    expect(isIsolatedPath('/m/camera')).toBe(false);
    expect(isIsolatedPath('/m/synth/extra')).toBe(false);
  });
});

describe('isBetaGatePublic', () => {
  it('keeps the mobile routes GATED (not public) — owner opens them with beta creds', () => {
    expect(isBetaGatePublic('/m')).toBe(false);
    expect(isBetaGatePublic('/m/cam')).toBe(false);
    expect(isBetaGatePublic('/m/synth')).toBe(false);
  });

  it('exempts /api/health (uptime probe)', () => {
    expect(isBetaGatePublic('/api/health')).toBe(true);
  });

  it('exempts EXACTLY / (the public landing / front door), never the app under it', () => {
    // Finding C of the landing-page overhaul: the prerendered landing at `/`
    // must return 200 to anon/crawlers with the beta gate active, or the whole
    // "public front door" rationale for moving the canvas off `/` is defeated.
    expect(isBetaGatePublic('/')).toBe(true);
    // EXACT match only (BETA_GATE_PUBLIC_PATHS, not a prefix): the moved canvas
    // at /rack and everything else stay gated.
    expect(isBetaGatePublic('/rack')).toBe(false);
    expect(isBetaGatePublic('/rackspaces')).toBe(false);
  });

  it('exempts /docs and every /docs/* descendant', () => {
    expect(isBetaGatePublic('/docs')).toBe(true);
    expect(isBetaGatePublic('/docs/')).toBe(true);
    expect(isBetaGatePublic('/docs/modules')).toBe(true);
    expect(isBetaGatePublic('/docs/modules/sequencer')).toBe(true);
    expect(isBetaGatePublic('/docs/testing')).toBe(true);
    expect(isBetaGatePublic('/docs/deploy')).toBe(true);
  });

  it('does NOT exempt /docs-prefix-spoof or paths that merely start with the substring', () => {
    expect(isBetaGatePublic('/docss')).toBe(false);
    expect(isBetaGatePublic('/docs-foo')).toBe(false);
    expect(isBetaGatePublic('/api/docs')).toBe(false);
  });

  it('does NOT exempt other auth-touched paths', () => {
    expect(isBetaGatePublic('/rack')).toBe(false);
    expect(isBetaGatePublic('/media')).toBe(false); // media loader — gated like /rack
    expect(isBetaGatePublic('/dashboard')).toBe(false);
    expect(isBetaGatePublic('/sign-in')).toBe(false);
    expect(isBetaGatePublic('/r/abc123')).toBe(false);
    expect(isBetaGatePublic('/api/rackspaces')).toBe(false);
  });
});

describe('accessLogShipTarget — Better Stack ship gating', () => {
  it('is null (no-op) when the token OR host is unset — the default prod-pre-provisioning case', () => {
    expect(accessLogShipTarget(undefined, undefined)).toBeNull();
    expect(accessLogShipTarget('tok', undefined)).toBeNull();
    expect(accessLogShipTarget(undefined, 'sNNN.betterstackdata.com')).toBeNull();
    expect(accessLogShipTarget('', 'sNNN.betterstackdata.com')).toBeNull();
    expect(accessLogShipTarget('tok', '')).toBeNull();
  });

  it('returns the POST target when both are set (bare host → https URL)', () => {
    expect(accessLogShipTarget('tok', 's123.eu-fsn-3.betterstackdata.com')).toEqual({
      url: 'https://s123.eu-fsn-3.betterstackdata.com',
      token: 'tok',
    });
  });

  it('accepts a full-URL host verbatim (no double scheme)', () => {
    expect(accessLogShipTarget('tok', 'https://in.logs.betterstack.com')).toEqual({
      url: 'https://in.logs.betterstack.com',
      token: 'tok',
    });
  });
});

describe('handleError — Sentry gating', () => {
  it('is a total no-op when PUBLIC_SENTRY_DSN is unset (never touches the SDK)', async () => {
    const error = new Error('boom');
    const event = {
      locals: { requestId: 'req-123' },
    } as unknown as Parameters<typeof handleError>[0]['event'];

    const result = await handleError({
      error,
      event,
      status: 500,
      message: 'Internal Error',
    } as Parameters<typeof handleError>[0]);

    // Default-shaped message preserved (with the request id stitched in).
    expect(result).toEqual({ message: 'Internal Error', requestId: 'req-123' });
    // The DSN is unset → the Sentry server module must NEVER be invoked.
    expect(ensureSentryServer).not.toHaveBeenCalled();
    expect(captureServerError).not.toHaveBeenCalled();
  });

  it('returns the default message even without a request id', async () => {
    const result = await handleError({
      error: new Error('x'),
      event: { locals: {} } as unknown as Parameters<typeof handleError>[0]['event'],
      status: 500,
      message: 'Internal Error',
    } as Parameters<typeof handleError>[0]);
    expect(result).toEqual({ message: 'Internal Error' });
    expect(captureServerError).not.toHaveBeenCalled();
  });
});
