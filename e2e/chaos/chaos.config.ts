// Chaos runner Playwright config — separate from e2e/playwright.config.ts so
// regression and chaos can run independently and so the chaos run can use
// looser timeouts + a single worker.
//
// Run:  CHAOS_SEED=42 npx playwright test --config=e2e/chaos/chaos.config.ts
// Or:   task chaos:run

import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const IS_LOCAL_TARGET =
  BASE_URL.startsWith('http://localhost') || BASE_URL.startsWith('http://127.0.0.1');

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
        command: 'npm run dev -w packages/web',
        cwd: '../..',
        url: BASE_URL,
        reuseExistingServer: true,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 120_000,
      }
    : undefined,
});
