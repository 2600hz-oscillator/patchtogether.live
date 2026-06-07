// e2e/playwright.config.ts
//
// Playwright config for patchtogether.live E2E tests.
// Targets Chromium with autoplay-allowed flags so AudioContext can start
// without a real user gesture (Playwright's button.click() counts as one,
// but the flags belt-and-suspender it).

import { defineConfig, devices } from '@playwright/test';

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
// --------------------------------------------------------------------------
// WebGL-HEAVY partition (shard rebalance, #68) — the SINGLE source of truth.
//
// Playwright's default shard splitter sorts SPEC FILES alphabetically then
// round-robins, so the alphabetically-late, heavy cross-domain WebGL specs
// (toybox-*, video-*, wavesculpt*, multi-video, …) all cluster onto the
// high-numbered shards. On CI's SwiftShader (software WebGL) those co-tenant
// heavies starve the single GL context / main thread and overrun their
// per-test budgets — the toybox-node-menu / presets-io SAVE / video-projection
// / combine-editor timeout class (#621/#629/#625). Spreading them by bumping
// the shard COUNT (#600, 8→10) helped wall-clock but did NOT un-cluster them
// (they're still adjacent alphabetically).
//
// FIX (option C from triage): pull every WebGL-heavy spec OUT of the sharded
// matrix and run them on their own dedicated, NON-sharded, serialized job
// (`e2e-video` in ci.yml: --workers=1, so no two heavies ever co-tenant a
// SwiftShader context). The functional shards then carry a uniform, light load
// and stop timing out on unrelated PRs.
//
// One glob list, two CI modes (mirrors how @collab/@capacity/behavioral are
// partitioned into their own lanes via grep — but file-glob, not title-grep,
// so it's robust to a spec growing extra describe blocks):
//   E2E_WEBGL_HEAVY=only     → run ONLY these specs   (the e2e-video job)
//   E2E_WEBGL_HEAVY=exclude  → run everything EXCEPT  (the sharded e2e matrix)
//   unset                    → run everything         (local dev / single runner)
//
// To re-classify a spec, edit THIS list only — no per-describe tag to forget
// when a heavy file gains a second describe (the fragility that sank option A).
const WEBGL_HEAVY_GLOBS = [
  '**/toybox-*.spec.ts',
  '**/video-*.spec.ts',
  '**/videobox-*.spec.ts',
  '**/videovarispeed-*.spec.ts',
  '**/multi-video-playback.spec.ts',
  '**/wavesculpt*.spec.ts',
  '**/wavecel-video-outs.spec.ts',
  '**/scope-video-out.spec.ts',
  '**/synesthesia-video-mode.spec.ts',
  '**/freezeframe.spec.ts',
  '**/picturebox-*.spec.ts',
  '**/b3ntb0x.spec.ts',
  // 1024×768 bump (#662): these three are GPU-fractal / multi-input video
  // mixers + routers whose page.screenshot/evaluate budgets blow on CI's
  // SwiftShader at 2.56× the old pixel count (they pass on a real GPU). Same
  // class as the toybox/video heavies above — run them in the serialized
  // e2e-video lane, not the sharded matrix.
  '**/4plexvid.spec.ts', // 4×4 video router — heavy WebGL screenshot
  '**/quadralogical.spec.ts', // 4-input video mixer — heavy WebGL evaluate
  '**/mandleblot.spec.ts', // GPU Mandelbrot fractal
];
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
          ? ['**/camera-input.spec.ts', '**/audio-in.spec.ts', ...WEBGL_HEAVY_GLOBS]
          : ['**/camera-input.spec.ts', '**/audio-in.spec.ts'],
      ...(WEBGL_HEAVY_MODE === 'only' ? { testMatch: WEBGL_HEAVY_GLOBS } : {}),
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--autoplay-policy=no-user-gesture-required',
            // COOP/COEP isolation only matters when the headers are set;
            // Playwright doesn't need extra flags for this.
            ...SWIFTSHADER_ARGS,
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
            ...SWIFTSHADER_ARGS,
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
            ...SWIFTSHADER_ARGS,
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
