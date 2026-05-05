// e2e/playwright.config.ts
//
// Playwright config for inet.modular E2E tests.
// Targets Chromium with autoplay-allowed flags so AudioContext can start
// without a real user gesture (Playwright's button.click() counts as one,
// but the flags belt-and-suspender it).

import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './tests',
  // Parallelize: each test file runs in its own worker. Tests within a file
  // run serially. Each worker gets its own browser context (separate
  // AudioContexts), so audio-related tests don't interfere across files.
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined, // undefined = Playwright default (≈ half cores)
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  outputDir: './test-results',

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
          args: [
            '--autoplay-policy=no-user-gesture-required',
            // COOP/COEP isolation only matters when the headers are set;
            // Playwright doesn't need extra flags for this.
          ],
        },
      },
    },
  ],

  // Boot the SvelteKit dev server before tests run, reusing if already up.
  webServer: {
    command: 'npm run dev -w packages/web',
    cwd: '..',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
  },
});
