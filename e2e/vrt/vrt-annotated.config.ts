// e2e/vrt/vrt-annotated.config.ts
//
// Playwright config for the numbered card-FACE generator (vrt-annotated.spec.ts).
// Reuses the deterministic VRT rendering settings (viewport / DPR / pinned
// fonts / reduced motion) from vrt.config.ts but:
//   - matches ONLY vrt-annotated.spec.ts (so the card faces never run in the
//     `task vrt` regression gate, where they'd be diffed as if they were
//     regression baselines — they are DOC ASSETS),
//   - writes the numbered PNGs to e2e/vrt/__annotated__/{type}.png
//     (committed via LFS; the doc build copies them into static/).
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

  // Annotated faces live under __annotated__/{type}.png — a flat dir (no
  // {testFilePath} nesting), since these are doc assets the build copies
  // straight into static/docs/module-faces/, next to the {type}.legend.json
  // the spec writes.
  //
  // ⚠ NO `{platform}` SEGMENT, matching vrt.config.ts — see the long note
  // there. These were `__annotated__/darwin/` and copy-doc-faces.sh hardcoded
  // that subdir, so the published doc face was whatever the last macOS author
  // rendered. One set, one path.
  snapshotPathTemplate: '__annotated__/{arg}{ext}',

  expect: {
    // ⚠ `timeout` is NOT a `toHaveScreenshot` key — it belongs HERE, on
    // `expect`. It sat nested inside the matcher options until 2026-08-09,
    // where Playwright silently ignored it: the annotated GENERATION run was
    // bounded by the 5 s default, not the 15 s intended. `vrt.config.ts` had
    // the identical bug, was fixed, and grew a regression test — but that test
    // hard-coded `vrt.config.ts`, so this sibling kept the defect. The test is
    // now parameterized over EVERY Playwright config (`vrt-config-budget.test.ts`).
    timeout: 15_000,
    toHaveScreenshot: {
      // The annotated face is a doc asset the build copies into
      // static/docs/module-faces/, so this tolerance decides whether the
      // GENERATION run aborts — it is not gating a regression. Still tightened
      // 2026-07-31 from threshold 0.2 / ratio 0.1: a 10% budget on a doc asset
      // meant the published image could drift a tenth of its area from the
      // face it claims to document, and nothing would say so.
      //
      // ⚠ "not a regression target" is an assumption worth revisiting — these
      // images are what the docs SHOW users, so a silent drift here is a
      // documentation lie even if no gate is meant to catch it.
      threshold: 0.15,
      maxDiffPixelRatio: 0.02,
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
