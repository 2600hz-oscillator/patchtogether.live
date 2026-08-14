// e2e/worktree-port.ts
//
// The per-worktree default app port + base URL for the AUXILIARY Playwright
// configs (vrt / vrt-annotated / chaos / audio-drift).
//
// #1597: those configs used to default to the SHARED `http://localhost:5173`
// with `reuseExistingServer: true`, so a run in one worktree silently adopted
// whatever sibling checkout was already serving 5173 — a green sweep of the
// WRONG BRANCH. The default is now this checkout's own derived port, so reuse
// finds only this worktree's server (or boots one here).
//
// ⚠ ONE derivation. This module SHELLS OUT to scripts/e2e-port.sh rather than
// re-implementing the hash — if the two ever computed different numbers the
// half-honoured-knob failure mode of #1597 would be back. The script honours
// an explicit E2E_PORT and reads E2E_PREVIEW; both behaviors are inherited
// here for free.
//
// (e2e/playwright.config.ts deliberately does NOT import this: that file is in
// the collab + webgl attest bases, and the attest runners now bypass its
// webServer entirely — they boot their own identity-verified server. See
// scripts/worktree-identity.ts.)

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** This worktree's derived default port (E2E_PORT wins — the script echoes it). */
export function derivedWorktreePort(mode: 'dev' | 'preview' = 'dev'): number {
  const out = execFileSync('bash', [join(REPO_ROOT, 'scripts', 'e2e-port.sh'), mode], {
    encoding: 'utf8',
  });
  const port = Number.parseInt(out.trim(), 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`scripts/e2e-port.sh printed no usable port (got ${JSON.stringify(out)})`);
  }
  return port;
}

/** Resolve the base URL a config should target plus the port its webServer
 *  command must bind (so `url:` and `command:` can never disagree — the latent
 *  half of the old bug: the command booted the vite default port while `url:`
 *  waited on whatever E2E_BASE_URL said).
 *
 *  - E2E_BASE_URL set → target it verbatim; `port` parsed from it (null when
 *    not parseable — remote targets never boot a local webServer anyway).
 *  - else → this worktree's derived port on localhost. */
export function localBaseUrl(mode: 'dev' | 'preview' = 'dev'): { baseUrl: string; port: number | null } {
  const explicit = process.env.E2E_BASE_URL;
  if (explicit) {
    try {
      const u = new URL(explicit);
      const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
      return { baseUrl: explicit, port };
    } catch {
      return { baseUrl: explicit, port: null };
    }
  }
  const port = derivedWorktreePort(mode);
  return { baseUrl: `http://localhost:${port}`, port };
}
