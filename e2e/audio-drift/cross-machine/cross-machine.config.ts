// e2e/audio-drift/cross-machine/cross-machine.config.ts
//
// Playwright config for one runner of the cross-machine audio-drift test.
// Loads the rack URL passed via AUDIO_DRIFT_RACK_URL; the runner.spec.ts
// drives one role (author or listener) against autotest.

import { defineConfig, devices } from '@playwright/test';

const RACK_URL = process.env.AUDIO_DRIFT_RACK_URL;
const BASE_URL = (() => {
  if (!RACK_URL) return undefined;
  try {
    const u = new URL(RACK_URL);
    return `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
})();

export default defineConfig({
  testDir: '.',
  testMatch: /runner\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // 60s for sync + warmup + (record + transfer). Tighter than the same-machine
  // harness because each runner runs ONE scenario, ONE role.
  timeout: 120_000,
  reporter: [['list']],
  outputDir: '../../test-results-audio-drift-cross-machine',

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
});
