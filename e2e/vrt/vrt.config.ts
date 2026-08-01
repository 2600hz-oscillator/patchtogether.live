// e2e/vrt/vrt.config.ts
//
// Visual Regression Test (VRT) Playwright config.
//
// Goals:
//   - Deterministic, comparable screenshots of every module card.
//   - Pinned viewport + device-pixel-ratio + reduced motion so the only
//     thing that drives a pixel diff is an intentional UI change.
//   - Baselines committed under e2e/vrt/__screenshots__/, LFS-tracked
//     (see .gitattributes — `e2e/vrt/__screenshots__/**/*.png filter=lfs`).
//     The repo already runs git-lfs for ART (.f32 / .wav) baselines, and
//     PNGs benefit from the same out-of-pack storage even though each
//     individual file is small (~10-50KB): they're regenerated on every
//     intentional UI change, which would balloon pack history fast.
//     CI must check out with `lfs: true`, else `toHaveScreenshot` compares
//     against the LFS pointer-file bytes instead of the real image and
//     every test "fails" with a giant diff.
//
// Separate from e2e/playwright.config.ts because:
//   - VRT needs a single worker (parallel workers race for GPU + paint
//     timing → flake). The main E2E config uses 3 workers in CI.
//   - VRT pins viewport explicitly; the main config defaults to the
//     'Desktop Chrome' device which is 1280x720 today but could change.
//   - VRT failures upload a different artifact bundle (the HTML gallery).

import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const IS_LOCAL_TARGET =
  BASE_URL.startsWith('http://localhost') || BASE_URL.startsWith('http://127.0.0.1');

// `VRT_STRICT=1` narrows the spec set to ONLY vrt.spec.ts (the per-
// module card-baseline pass, filtered to STRICT_VRT_MODULES inside the
// spec). The auxiliary specs (composite scenes, playhead, interactions,
// skins) lean harder on animated state + multi-card layout timing — they
// belong to the informational lane (`task vrt`), not the gate.
const STRICT_MATCH = ['vrt.spec.ts'];
const FULL_MATCH = [
  'vrt.spec.ts',
  'vrt-wavesculpt-blink.spec.ts',
  'vrt-wavesculpt-walls.spec.ts',
  'vrt-scope-modes.spec.ts',
  'vrt-composite.spec.ts',
  'vrt-composite-coverage.spec.ts',
  'vrt-synesthesia-composite.spec.ts',
  'pentemelodica-composite.spec.ts',
  'cube-adsr-composite.spec.ts',
  'vrt-synesthesia-video.spec.ts',
  'vrt-quadralogical.spec.ts',
  'vrt-clap.spec.ts',
  'vrt-tidy-vco.spec.ts',
  'vrt-karplus-tomtom-states.spec.ts',
  'vrt-posterbox-states.spec.ts',
  'vrt-colourofmagic.spec.ts',
  'cellshade-composite.spec.ts',
  'mirrorpool-composite.spec.ts',
  'workflow-audio-io-composite.spec.ts',
  'workflow-dock-composite.spec.ts',
  'workflow-shell-zoom.spec.ts',
  'workflow-shell-faces.spec.ts',
  'workflow-rear-card.spec.ts',
  'vrt-toybox.spec.ts',
  'vrt-aspect-16x9.spec.ts',
  'topbar.spec.ts',
  'playhead.spec.ts',
  'interactions.spec.ts',
  'groups.spec.ts',
  'dashboard.spec.ts',
  'landing.spec.ts',
];

// `VRT_PROBE=1` swaps the whole suite for the MEASUREMENT tool
// (vrt-surface-probe.spec.ts): it prints the region statistics a live surface
// scores, live vs force-killed, so a companion's floors can be DERIVED from a
// measurement instead of guessed. It asserts nothing and never runs in CI —
// it is not in FULL_MATCH, so no lane picks it up by accident.
const PROBE_MATCH = ['vrt-surface-probe.spec.ts'];

function testMatch(): string[] {
  if (process.env.VRT_PROBE === '1') return PROBE_MATCH;
  return process.env.VRT_STRICT === '1' ? STRICT_MATCH : FULL_MATCH;
}

export default defineConfig({
  testDir: '.',
  testMatch: testMatch(),
  // Single-worker by design. VRT screenshots care about exact pixel
  // output; running multiple workers in parallel against the same dev
  // server creates GPU contention + paint-timing variability that
  // shows up as random 1-2 pixel diffs.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Zero retries: a VRT either passes deterministically or the
  // baseline is wrong. Retrying just delays surfacing the truth.
  retries: 0,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: './report' }], ['list']]
    : [['list'], ['html', { open: 'never', outputFolder: './report' }]],
  outputDir: './test-results',

  // Per-spec timeout — module spawn + first paint should be well under
  // 10s, but we bake in slack for slow CI runners.
  timeout: 30_000,

  // Snapshot path template. Default would scatter PNGs under
  // test-results/; we want them under __screenshots__/ so they're easy
  // to commit + diff in PRs.
  //
  // Per-platform subdir ({platform}) — Playwright substitutes
  // process.platform (`linux` on CI, `darwin` on local macOS dev,
  // `win32` on Windows). Without this, devs on macOS see the entire
  // 49-baseline set as drifted because the authoritative baselines
  // are captured under Linux CI. Each platform gets its own committed
  // baseline directory; both are LFS-tracked via the path-glob in
  // .gitattributes (`e2e/vrt/__screenshots__/**/*.png filter=lfs`).
  snapshotPathTemplate: '__screenshots__/{testFilePath}/{platform}/{arg}{ext}',

  expect: {
    toHaveScreenshot: {
      // Tolerance budget. Browsers + GPU drivers emit sub-pixel
      // anti-aliasing differences that aren't semantically meaningful
      // even on the same platform across runs. Baselines are committed
      // per-platform (see snapshotPathTemplate above), so we no longer
      // need to absorb cross-platform AA drift here — but small
      // intra-platform drift on text-heavy cards still does occur.
      //
      // 0.1 = a pixel must differ by >10% per channel before it counts.
      // maxDiffPixelRatio = 0.01 = up to 1% of pixels may differ under that
      // per-channel threshold.
      //
      // TIGHTENED 2026-07-31 from threshold 0.2 / ratio 0.05. The old comment
      // said this "can be tightened toward 0.01 once baselines settle on each
      // platform" — the per-platform `snapshotPathTemplate` above IS that
      // settling, and it landed long ago; the tightening never followed.
      //
      // WHY IT MATTERS, measured, not theorised: at 5% a 320x240 card could
      // change 3,840 pixels — a ~62x62 block, a whole knob — and stay green.
      // The documented case is A2/#1213: swapping filter's MODE from a bare
      // detented knob to a LABELLED SEGMENTED control, an entire primitive
      // swap, moved the dock face by 865 px. Under the old budget the gate
      // passed AND `--update-snapshots` refused to regenerate (Playwright only
      // rewrites a snapshot when the comparison FAILS), so the change was both
      // invisible and unfixable. `workflow-dock-patch` likewise sat inside its
      // budget for months while still rendering v1.2.0-era chrome.
      //
      // The per-channel `threshold` compounds it: a pixel shifting up to 20%
      // per channel was not counted as different AT ALL, so a colour or
      // contrast change under that bar was invisible at ANY ratio.
      threshold: 0.1,
      maxDiffPixelRatio: 0.01,
      // Per-screenshot settle/capture timeout. Playwright's default is
      // 5000ms, which the heavy WebGL/animated cards (MANDLEBLOT,
      // MANDELBULB, WAVESCULPT-BLINK, …) intermittently blow on the CI
      // macOS runner — most visibly during `--update-snapshots`, where
      // "Failed to re-generate expected. Timeout 5000ms exceeded" aborts
      // the WHOLE darwin baseline regen (vrt-update.yml) before it can
      // commit, so a single heavy-card render stall (a different card
      // each dispatch — wavesculpt-blink, then mandleblot) repeatedly
      // wedges the baseline refresh. The per-spec budget is already
      // 30_000ms (above); raise the screenshot op to match so a slow
      // GPU-bound settle has room instead of tripping the 5s default.
      // This only ADDS settle headroom — it cannot turn a passing
      // comparison into a failure (threshold/maxDiffPixelRatio unchanged).
      timeout: 15_000,
      // Disable animations so on-card LEDs / hover effects / running
      // visualizers don't bake non-deterministic frames into the
      // baseline. Note: this is on top of the prefers-reduced-motion
      // emulation we set on the use{} block.
      animations: 'disabled',
    },
  },

  use: {
    baseURL: BASE_URL,
    // Fixed viewport: 1280x720 @ 1x DPR. The main e2e config inherits
    // devices['Desktop Chrome'] which is also 1280x720 today, but we
    // pin it here so a future Playwright device-preset change can't
    // silently shift our baselines.
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    // Belt + suspenders: prefers-reduced-motion blocks CSS @media
    // (prefers-reduced-motion: reduce) transitions on modules that
    // honor it. Combined with expect.toHaveScreenshot.animations:
    // 'disabled' (which freezes CSS animations at t=0) we get the
    // tightest determinism Playwright offers without a custom rAF
    // mock.
    reducedMotion: 'reduce',
    // Higher trace + screenshot fidelity: a VRT failure is itself the
    // signal, but we still want the full trace bundle so reviewers
    // can see the surrounding DOM state.
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
      name: 'chromium-vrt',
      use: {
        ...devices['Desktop Chrome'],
        // Re-override viewport + DPR because spreading devices['Desktop
        // Chrome'] would otherwise re-apply its defaults.
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
        launchOptions: {
          args: [
            '--autoplay-policy=no-user-gesture-required',
            // Force consistent font rendering across local + CI Chromium.
            // Subpixel antialiasing differences between macOS dev + Linux
            // CI runners are the #1 source of VRT flake. --font-render-
            // hinting=none + a deterministic subpixel-text setting flattens
            // most of it out.
            '--font-render-hinting=none',
            '--disable-skia-runtime-opts',
            // Disable the smoothScrolling animation that fires on the
            // first .svelte-flow viewport mount.
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
