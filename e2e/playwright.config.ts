// e2e/playwright.config.ts
//
// Playwright config for patchtogether.live E2E tests.
// Targets Chromium with autoplay-allowed flags so AudioContext can start
// without a real user gesture (Playwright's button.click() counts as one,
// but the flags belt-and-suspender it).

import { defineConfig, devices } from '@playwright/test';
// THE single source of truth for the WebGL-heavy spec set — exported so the
// WebGL-attestation hash/coverage tooling reads the SAME literal Playwright
// uses (adversarial-review fix V4). See e2e/webgl-heavy-globs.ts.
import { resolveEffectiveHeavySpecGlobs } from './webgl-heavy-globs';

// The EFFECTIVE heavy spec set = heavy globs MINUS the RE-BINned exclusions,
// resolved to concrete `**/<file>.spec.ts` patterns (see webgl-heavy-globs.ts
// for why concrete files rather than the raw globs — testMatch/testIgnore have
// no native subtraction). This is exactly the set the serialized e2e-video lane
// runs and the sharded matrix ignores.
const EFFECTIVE_HEAVY_GLOBS = resolveEffectiveHeavySpecGlobs();

// E2E_USE_PREVIEW=1 swaps the dev server for `vite preview` so we can run the
// @smoke subset against the prod-built bundle locally. Catches regressions
// that only manifest under minification / static-asset paths (e.g. Faust's
// runtime worklet stitching breaking when classes are mangled).
const USE_PREVIEW = process.env.E2E_USE_PREVIEW === '1';
const DEFAULT_LOCAL = USE_PREVIEW ? 'http://localhost:4173' : 'http://localhost:5173';
const BASE_URL = process.env.E2E_BASE_URL ?? DEFAULT_LOCAL;

// E2E_SWIFTSHADER=1 forces Chromium's WebGL onto the SwiftShader software
// rasterizer (via ANGLE). Headless Linux CI runners have no GPU → they get
// SwiftShader for free; a local Mac/desktop uses the real GPU and CANNOT
// otherwise reproduce the CI-only software-renderer timeouts/flakes in the
// WebGL/video specs. Set it for a faithful local flake-check.
const SWIFTSHADER_ARGS =
  process.env.E2E_SWIFTSHADER === '1'
    ? ['--use-gl=angle', '--use-angle=swiftshader', '--use-cmd-decoder=passthrough']
    : [];
// E2E_REAL_GPU=1 forces Chromium's WebGL onto the REAL hardware GPU via the
// platform ANGLE backend (Metal on macOS, the default ANGLE backend elsewhere).
// HEADLESS Chromium on macOS otherwise falls back to SwiftShader EVEN ON A REAL
// GPU machine (verified: default headless → "SwiftShader driver"; with these
// flags → "ANGLE Metal Renderer: Apple M*"). The WebGL-attestation runner
// (scripts/webgl-attest.ts) sets this for all three real-GPU passes so the
// attested run is genuinely on the GPU, not software. Mutually exclusive with
// E2E_SWIFTSHADER (which wins if both are set, to keep the SwiftShader floor
// honest). Defaults to macOS Metal; override the backend via E2E_ANGLE_BACKEND.
const REAL_GPU_ARGS =
  process.env.E2E_SWIFTSHADER !== '1' && process.env.E2E_REAL_GPU === '1'
    ? [
        '--use-gl=angle',
        `--use-angle=${process.env.E2E_ANGLE_BACKEND || (process.platform === 'darwin' ? 'metal' : 'default')}`,
      ]
    : [];
const GPU_ARGS = [...SWIFTSHADER_ARGS, ...REAL_GPU_ARGS];
// --------------------------------------------------------------------------
// WebGL-HEAVY partition (shard rebalance, #68) — the SINGLE source of truth is
// now e2e/webgl-heavy-globs.ts (imported as WEBGL_HEAVY_GLOBS above), so the
// WebGL-attestation hash/coverage tooling can resolve the SAME spec set without
// text-parsing this file (adversarial-review fix V4).
//
// One glob list, two CI modes (mirrors how @collab/@capacity/behavioral are
// partitioned into their own lanes via grep — but file-glob, not title-grep,
// so it's robust to a spec growing extra describe blocks):
//   E2E_WEBGL_HEAVY=only     → run ONLY these specs   (the e2e-video job)
//   E2E_WEBGL_HEAVY=exclude  → run everything EXCEPT  (the sharded e2e matrix)
//   unset                    → run everything         (local dev / single runner)
//
// To re-classify a spec, edit e2e/webgl-heavy-globs.ts only — no per-describe
// tag to forget when a heavy file gains a second describe (the fragility that
// sank option A).
const WEBGL_HEAVY_MODE = process.env.E2E_WEBGL_HEAVY; // 'only' | 'exclude' | undefined

// Skip the local webServer when targeting a deployed URL (live smoke). Detected
// by E2E_BASE_URL being set to anything non-localhost.
// E2E_SKIP_WEBSERVER=1 also skips it — used by local dev workflows that
// already have a dev server running on a non-default port (multi-worktree
// agent runs that need a per-worktree dev server).
const IS_LOCAL_TARGET =
  (BASE_URL.startsWith('http://localhost') || BASE_URL.startsWith('http://127.0.0.1'))
  && process.env.E2E_SKIP_WEBSERVER !== '1';

export default defineConfig({
  testDir: './tests',
  // Parallelize: each test file runs in its own worker. Tests within a file
  // run serially. Each worker gets its own browser context (separate
  // AudioContexts), so audio-related tests don't interfere across files.
  fullyParallel: true,
  // ubuntu-latest runners have 4 vCPU. Bumped CI workers 3 → 4 alongside
  // E2E sharding (4 parallel CI jobs × 4 workers each). Each test gets its
  // own browser context (own AudioContext), so cross-test interference is
  // bounded; if flake regresses under the shard fan-out, drop back to 3.
  // Note: the SvelteKit dev server + Hocuspocus still share the runner, but
  // most worker time is spent waiting on network / waitFor selectors /
  // animation frames where the OS schedules cooperatively.
  workers: process.env.CI ? 4 : undefined, // undefined = Playwright default (≈ half cores)
  forbidOnly: !!process.env.CI,
  // ⚠ THE `RETRIES` ENV VAR ON THE CI JOBS IS INERT — MEASURED 2026-08-12.
  //
  // Every `e2e` and `behavioral` job on CI prints `RETRIES: 3` in its step
  // environment. NOTHING IN THIS REPOSITORY READS IT: `grep -rn RETRIES` over
  // `.github/`, `Taskfile.yml`, `e2e/`, `.flox/` and this file returns nothing
  // but `--health-retries` on the postgres service and the three ATTEST
  // scripts' own private `WEBGL_/COLLAB_/GRAND_ATTEST_RETRIES`. It is not in
  // ci.yml on any branch. It is a repository-level Actions variable set
  // outside the tree, and the effective retry count on those lanes is the
  // line below — ONE, i.e. two attempts, not four.
  //
  // WHY IT MATTERS beyond tidiness: it is a control that lies about what it
  // does, and it lies in the direction of reassurance. Anyone reasoning about
  // "how much does CI mask a load-sensitive failure?" from that variable gets
  // the wrong number, and the number they get is a bigger safety net than
  // exists. It cannot be fixed from the tree — deleting it needs repo settings
  // access — so it is recorded here, at the line that actually decides.
  //
  // ⚠ AND DO NOT "FIX" IT BY READING IT HERE. Honouring RETRIES would take the
  // lane from 2 attempts to 4, i.e. MORE masking, which is the opposite of
  // what the finding asks for. The fix is to delete the Actions variable.
  //
  // WHAT retries=1 STILL COSTS: a test that fails once and passes on the retry
  // is reported as `1 flaky` in a summary line and the job is SUCCESS.
  //
  // ⚠ AND IT IS NOT TWO TESTS. This comment used to name two, from two runs.
  // MEASURED 2026-08-13 (#1502) by downloading the blob-report artifacts of
  // EIGHTEEN consecutive completed ci.yml runs, merging each with
  // `playwright merge-reports --reporter json` and auditing them with
  // `scripts/e2e-report-audit.mjs`: SIXTEEN of the eighteen carried at least
  // one recovered flake, across NINE distinct tests —
  //
  //   behavioral-observation-window.spec.ts   11/18 ← root-caused, see the file
  //   camera-input.spec.ts                     6/18 ← fixed by #1564
  //   collapse-keeps-playing.spec.ts           5/18 (videobox 3, videovarispeed 2)
  //   matrixmix.spec.ts                        2/18
  //   midi / patch-load-leak / samsloop-record /
  //     clipplayer-custom-scale /
  //     workflow-channel-columns               1/18 each
  //
  // Two runs of one test is a sample, not a rate; that is why the audit had to
  // be run over a SERIES before anything was concluded from it. The attest
  // scripts already model the right response — `collab-attest.ts` and
  // `grand-attest.ts` REFUSE on a flaky outcome rather than absorb it — and
  // that is the shape this lane wants. `merge-reports` in ci.yml can arm it
  // today by passing `--fail-on-flaky`; it deliberately does NOT, because at a
  // measured 10/12 that would redden the required lane on day one and be
  // reverted rather than fixed. It gets armed when the tail above is drained.
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
    // Basic-auth gate: hooks.server.ts enforces it when BETA_GATE_PASS is
    // set in the deploy env. Live-smoke jobs forward the gate creds via
    // BETA_GATE_USER + BETA_GATE_PASS env vars; Playwright auto-attaches
    // them to every request when httpCredentials is configured.
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
      // Default project — every spec EXCEPT the camera spec + audio-in
      // spec lives here. Those move to their own projects so the
      // fake-camera / fake-mic flags don't leak into unrelated tests.
      // (SAMSLOOP's record path no longer goes through getUserMedia at
      // all — it records from patched audio cables via an in-graph tap
      // worklet, so the old samsloop-mic project / fake-mic flag is no
      // longer needed.)
      //
      // WebGL-heavy partition (see WEBGL_HEAVY_GLOBS above): in 'exclude' mode
      // (the sharded e2e matrix) the heavy specs are ignored here so the
      // functional shards stay light/uniform; in 'only' mode (the dedicated
      // serialized e2e-video job) ONLY the heavy specs run. Camera/audio-in
      // live in their own projects below and are unaffected.
      testIgnore:
        WEBGL_HEAVY_MODE === 'exclude'
          ? ['**/camera-input.spec.ts', '**/audio-in.spec.ts', ...EFFECTIVE_HEAVY_GLOBS]
          : ['**/camera-input.spec.ts', '**/audio-in.spec.ts'],
      ...(WEBGL_HEAVY_MODE === 'only' ? { testMatch: [...EFFECTIVE_HEAVY_GLOBS] } : {}),
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--autoplay-policy=no-user-gesture-required',
            // COOP/COEP isolation only matters when the headers are set;
            // Playwright doesn't need extra flags for this.
            ...GPU_ARGS,
          ],
        },
      },
    },
    {
      // AUDIO IN module. --use-fake-device-for-media-stream injects a
      // synthetic 440 Hz sine for audio + microphone permission is
      // pre-granted. Lives in its own project so the fake-mic doesn't
      // leak into the default chromium runs, where many specs depend on
      // getUserMedia failing predictably with NotAllowedError.
      name: 'chromium-audio-in',
      // Not WebGL-heavy → it belongs in the functional (sharded) lane, not the
      // e2e-video lane. Disable it in 'only' mode (empty testMatch = no specs)
      // so the dedicated video job runs ONLY the WebGL-heavy globs.
      testMatch: WEBGL_HEAVY_MODE === 'only' ? [] : ['**/audio-in.spec.ts'],
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['microphone'],
        launchOptions: {
          args: [
            '--autoplay-policy=no-user-gesture-required',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            ...GPU_ARGS,
          ],
        },
      },
    },
    {
      name: 'chromium-camera',
      // Specs that need a webcam: getUserMedia returns a synthetic
      // green/red striped MediaStream produced by Chromium's fake video
      // device, and the permission prompt UI is auto-accepted (the
      // newContext({ permissions: ['camera'] }) call in the spec covers
      // most cases, but --use-fake-ui covers the prompt edge cases).
      // Not WebGL-heavy → functional (sharded) lane; disabled in 'only' mode
      // (empty testMatch) so the e2e-video job runs ONLY the heavy globs.
      testMatch: WEBGL_HEAVY_MODE === 'only' ? [] : ['**/camera-input.spec.ts'],
      use: {
        ...devices['Desktop Chrome'],
        // Grant camera permission in this project so the spec doesn't
        // need to wire it on every newContext.
        permissions: ['camera'],
        launchOptions: {
          args: [
            '--autoplay-policy=no-user-gesture-required',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            ...GPU_ARGS,
          ],
        },
      },
    },
  ],

  // Boot the SvelteKit dev server before tests run, reusing if already up.
  // Skipped when E2E_BASE_URL points at a live deploy.
  //
  // Two webServers when targeting local: the SvelteKit app PLUS the
  // Hocuspocus collaboration server. The @collab tests connect from two
  // browser contexts to the Hocuspocus instance via __attachProvider.
  // The Hocuspocus server is harmless to non-collab tests (they don't
  // import the provider), so we boot it unconditionally for local runs.
  webServer: IS_LOCAL_TARGET
    ? [
        {
          command: USE_PREVIEW
            ? 'npm run preview -w packages/web -- --port 4173'
            : 'npm run dev -w packages/web',
          cwd: '..',
          url: BASE_URL,
          reuseExistingServer: !process.env.CI,
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 120_000,
        },
        {
          // Hocuspocus on ws://localhost:1235 (not Hocuspocus's documented
          // default 1234, which BitwigStudio reserves for OSC). The provider
          // in the web app reads VITE_SERVER_WS_URL with that as the default.
          command: 'npm run dev -w packages/server',
          cwd: '..',
          // Ready signal: TCP port. Hocuspocus's HTTP request handler is
          // intercepted by an internal extension that doesn't write a
          // response (curl reports "Empty reply from server"), so url:
          // can't be used. port: just waits for the OS-level port to
          // accept connections, which is the meaningful readiness for a
          // WebSocket server anyway.
          port: 1235,
          reuseExistingServer: !process.env.CI,
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 60_000,
        },
      ]
    : undefined,
});
