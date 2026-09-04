// Shell e2e harness (PH skeleton). Tier A subject: UNPACKAGED `electron .`
// against the PT_DESKTOP_BUILD=1 test web build (VITE_E2E_HOOKS=1 baked at
// build) — NOT the shipped artifact; packaged seams are Tier B/manual.
//
// Deps live in THIS package — NEVER in e2e/package.json, which is a
// webgl-attest toolchain pin (touching it forces a real-GPU re-attest).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // One Electron app at a time; the shell binds a real loopback port.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // Explicit budgets — the invisible 30 s default has burned this repo before.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: './test-results',
});
