// packages/web/src/hooks.server.test.ts
//
// Targeted tests for the beta-gate carve-out. Importing hooks.server.ts
// pulls in $env/dynamic/* which is a SvelteKit virtual module — vitest
// doesn't have it in its module graph by default. To keep this test
// hermetic we mock the env modules to an empty Record so the import
// doesn't throw at collect time.

import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
// withClerkHandler reads from process.env synchronously and bombs out at
// import time when its expected vars are missing. Stub the whole module.
vi.mock('svelte-clerk/server', () => ({
  withClerkHandler: () => async (_args: unknown) => new Response(''),
}));

import { isBetaGatePublic } from './hooks.server';

describe('isBetaGatePublic', () => {
  it('exempts /api/health (uptime probe)', () => {
    expect(isBetaGatePublic('/api/health')).toBe(true);
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
    expect(isBetaGatePublic('/')).toBe(false);
    expect(isBetaGatePublic('/dashboard')).toBe(false);
    expect(isBetaGatePublic('/sign-in')).toBe(false);
    expect(isBetaGatePublic('/r/abc123')).toBe(false);
    expect(isBetaGatePublic('/api/rackspaces')).toBe(false);
  });
});
