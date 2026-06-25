// e2e/vrt/vrt-annotated.config.ts
//
// Playwright config for the numbered card-FACE generator (vrt-annotated.spec.ts).
// Reuses the deterministic VRT rendering settings (viewport / DPR / pinned
// fonts / reduced motion) from vrt.config.ts but:
//   - matches ONLY vrt-annotated.spec.ts (so the card faces never run in the
//     `task vrt` regression gate, where they'd be diffed as if they were
//     regression baselines — they are DOC ASSETS),
//   - writes the numbered PNGs to e2e/vrt/__annotated__/{platform}/{type}.png
//     (committed via LFS; the doc build copies darwin into static/).
//
// The legend JSON ({type}.legend.json — number → stable test id) is written by
// the spec; the doc page resolves it to authored docs.controls blobs.

import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const IS_LOCAL_TARGET =
  BASE_URL.startsWith('http://localhost') || BASE_URL.startsWith('http://127.0.0.1');

export default defineConfig({
  testDir: '.',
  testMatch: ['vrt-annotated.spec.ts'],
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI
    ? [['github'], ['list']]
    : [['list']],
  outputDir: './test-results-annotated',
  timeout: 30_000,

  // Annotated faces live under __annotated__/{platform}/{type}.png — a flat
  // per-platform dir (no {testFilePath} nesting), since these are doc assets
  // the build copies straight into static/docs/module-faces/.
  snapshotPathTemplate: '__annotated__/{platform}/{arg}{ext}',

  expect: {
    toHaveScreenshot: {
      // The annotated face is a doc asset, not a regression target — generous
      // tolerance so a sub-pixel AA difference never fails the generation run.
      threshold: 0.2,
      maxDiffPixelRatio: 0.1,
      timeout: 15_000,
      animations: 'disabled',
    },
  },

  use: {
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    httpCredentials: process.env.BETA_GATE_PASS
      ? {
          username: process.env.BETA_GATE_USER || 'beta',
          password: process.env.BETA_GATE_PASS,
        }
      : undefined,
  },

  projects: [
    {
      name: 'chromium-vrt-annotated',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
        launchOptions: {
          args: [
            '--autoplay-policy=no-user-gesture-required',
            '--font-render-hinting=none',
            '--disable-skia-runtime-opts',
            '--disable-smooth-scrolling',
          ],
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
