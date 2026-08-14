// Chaos runner Playwright config — separate from e2e/playwright.config.ts so
// regression and chaos can run independently and so the chaos run can use
// looser timeouts + a single worker.
//
// Run:  CHAOS_SEED=42 npx playwright test --config=e2e/chaos/chaos.config.ts
// Or:   task chaos:run

import { defineConfig, devices } from '@playwright/test';
// #1597: default to this WORKTREE'S OWN derived port (E2E_PORT/E2E_BASE_URL
// win) — never the shared 5173 that reuseExistingServer adopted blindly.
import { localBaseUrl } from '../worktree-port';

const { baseUrl: BASE_URL, port: APP_PORT } = localBaseUrl('dev');
const RACKSPACE_URL = process.env.CHAOS_RACKSPACE_URL;
// Skip the local dev server boot if we're hitting a deployed tier — either
// because E2E_BASE_URL points there or because CHAOS_RACKSPACE_URL is an
// absolute non-localhost URL the bot will navigate to.
const isLocal = (url: string) =>
  url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1');
const IS_LOCAL_TARGET =
  isLocal(BASE_URL) && (!RACKSPACE_URL || isLocal(RACKSPACE_URL)) && APP_PORT !== null;

// HTTP Basic credentials for the deployed tiers' beta gate (see
// packages/web/src/hooks.server.ts). Username defaults to `beta`; pass the
// password via BETA_GATE_PASS (matches the server env var name so contributors
// don't have to learn a second name).
const BETA_USER = process.env.BETA_GATE_USER || 'beta';
const BETA_PASS = process.env.BETA_GATE_PASS;

export default defineConfig({
  testDir: '.',
  testMatch: ['runner.spec.ts'],
  // Single-worker by design: chaos cares about deterministic single-page
  // state, parallelism would just spawn redundant runs against the same
  // dev server and fight for the AudioContext.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: './test-results',
  timeout: 240_000,
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ...(BETA_PASS ? { httpCredentials: { username: BETA_USER, password: BETA_PASS } } : {}),
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--autoplay-policy=no-user-gesture-required'],
        },
      },
    },
  ],
  webServer: IS_LOCAL_TARGET
    ? {
        // Boot on EXACTLY the port `url:` waits on (see vrt.config.ts, #1597).
        command: `npm run dev -w packages/web -- --port ${APP_PORT} --strictPort`,
        cwd: '../..',
        url: BASE_URL,
        reuseExistingServer: true,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 120_000,
      }
    : undefined,
});
