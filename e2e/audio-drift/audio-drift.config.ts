// e2e/audio-drift/audio-drift.config.ts
//
// Standalone Playwright config for the audio-drift research harness.
// Runs all scenarios serially (one at a time) to avoid CPU contention biasing
// the AudioContext scheduling — multiple AudioContexts on a single browser
// machine starve each other under load and produce false drift signals.

import { defineConfig, devices } from '@playwright/test';

const USE_PREVIEW = process.env.E2E_USE_PREVIEW === '1';
const DEFAULT_LOCAL = USE_PREVIEW ? 'http://localhost:4173' : 'http://localhost:5173';
const BASE_URL = process.env.E2E_BASE_URL ?? DEFAULT_LOCAL;
const IS_LOCAL_TARGET =
  BASE_URL.startsWith('http://localhost') || BASE_URL.startsWith('http://127.0.0.1');

export default defineConfig({
  testDir: '.',
  testMatch: /audio-drift\.spec\.ts$/,
  // Single worker, full file: each scenario opens 2 browser contexts and
  // captures real audio; running concurrently distorts the metric.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Each scenario does N runs of (warmup + RECORD_SECONDS + sync wait), default
  // 3 × ~10s = ~30s. Bump to 3 minutes so a 5-run × 10s recording also fits.
  timeout: 180_000,
  reporter: [['list']],
  outputDir: '../test-results-audio-drift',

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    httpCredentials: process.env.BETA_GATE_PASS
      ? {
          username: process.env.BETA_GATE_USER || 'beta',
          password: process.env.BETA_GATE_PASS,
        }
      : undefined,
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

  // For local-target runs, boot the SvelteKit + Hocuspocus stack just like
  // the main playwright.config.ts does. The audio-drift harness needs both
  // to do its multi-context Yjs sync.
  //
  // DATABASE_URL fallback: the Hocuspocus server's onLoadDocument throws if
  // DATABASE_URL is unset (no graceful fresh-doc fallback). We default to the
  // Flox-provided local Postgres on port 54320. Override via env to point at
  // a different DB.
  webServer: IS_LOCAL_TARGET
    ? [
        {
          command: USE_PREVIEW
            ? 'npm run preview -w packages/web -- --port 4173'
            : 'npm run dev -w packages/web',
          // Config file is at e2e/audio-drift/audio-drift.config.ts, so '../..'
          // resolves to the workspace root where npm workspaces are anchored.
          cwd: '../..',
          url: BASE_URL,
          // Reuse if up: avoids needless restart between local runs. The
          // task wrapper passes DATABASE_URL down to the started servers
          // (see Taskfile.yml). If a previously-started server is missing
          // DATABASE_URL, kill it manually and re-run.
          reuseExistingServer: !process.env.CI,
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 120_000,
          env: {
            DATABASE_URL:
              process.env.DATABASE_URL ??
              'postgresql://postgres:dev@localhost:54320/patchtogether_dev',
          },
        },
        {
          command: 'npm run dev -w packages/server',
          // Config file is at e2e/audio-drift/audio-drift.config.ts, so '../..'
          // resolves to the workspace root where npm workspaces are anchored.
          cwd: '../..',
          port: 1235,
          // Reuse if up: avoids needless restart between local runs. The
          // task wrapper passes DATABASE_URL down to the started servers
          // (see Taskfile.yml). If a previously-started server is missing
          // DATABASE_URL, kill it manually and re-run.
          reuseExistingServer: !process.env.CI,
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 60_000,
          env: {
            DATABASE_URL:
              process.env.DATABASE_URL ??
              'postgresql://postgres:dev@localhost:54320/patchtogether_dev',
          },
        },
      ]
    : undefined,
});
