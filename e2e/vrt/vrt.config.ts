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
// #1597: the default target is this WORKTREE'S OWN derived port (E2E_PORT /
// E2E_BASE_URL still win) — never the shared 5173, where reuseExistingServer
// silently adopted a sibling checkout's dev server and swept the wrong branch.
// APP_PORT feeds the webServer command below so url/command cannot disagree.
import { localBaseUrl } from '../worktree-port';

const { baseUrl: BASE_URL, port: APP_PORT } = localBaseUrl('dev');
const IS_LOCAL_TARGET =
  (BASE_URL.startsWith('http://localhost') || BASE_URL.startsWith('http://127.0.0.1')) &&
  APP_PORT !== null;

// ── RENDERER SELECTION ─────────────────────────────────────────────────────
//
// `e2e/playwright.config.ts` has honoured E2E_SWIFTSHADER / E2E_REAL_GPU for a
// long time; THIS config never did, so "reproduce under the renderer that
// actually failed" — the CLAUDE.md rule — had no lever for the VRT lane at all.
// Added 2026-08-11 while sizing the timeouts below.
//
// ⚠ MEASURED, and it is the opposite of the intuitive answer: a HEADLESS
// Chromium on macOS is ALREADY on SwiftShader with no flags at all. Probing
// UNMASKED_RENDERER_WEBGL through this config's exact `args` reports
//
//     ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0)
//            (0x0000C0DE)), SwiftShader driver)
//
// so a local VRT run and CI already share a renderer, and the gap between them
// is CPU width, not rasterizer. That is worth stating because it means a local
// timing figure IS transferable here (unlike the e2e lane, where a Mac dev gets
// Metal) — while a local PIXEL comparison still is not, because font
// rasterization differs. Setting the flag explicitly pins the property instead
// of inheriting it by accident, and E2E_REAL_GPU=1 is the escape hatch for
// asking "is this scene GPU-dependent?".
const GPU_ARGS =
  process.env.E2E_SWIFTSHADER === '1'
    ? ['--use-gl=angle', '--use-angle=swiftshader', '--use-cmd-decoder=passthrough']
    : process.env.E2E_REAL_GPU === '1'
      ? [
          '--use-gl=angle',
          `--use-angle=${process.env.E2E_ANGLE_BACKEND || (process.platform === 'darwin' ? 'metal' : 'default')}`,
        ]
      : [];

// `VRT_STRICT=1` narrows the spec set to the REQUIRED lane: the per-module
// card-baseline pass (filtered to STRICT_VRT_MODULES inside the spec) and the
// curated FACEPLATES. The auxiliary specs (composite scenes, playhead,
// interactions, skins) lean harder on animated state + multi-card layout
// timing — they belong to the informational lane (`task vrt`), not the gate.
//
// ── WHY workflow-shell-faces.spec.ts IS HERE (2026-08-12) ──────────────────
//
// ⚠ IT USED NOT TO BE, AND THAT MEANT NO FACEPLATE REGRESSION COULD EVER BLOCK
// A MERGE. Every `face-<type>-{compact,dock}` baseline lived only in the
// informational `vrt` job (`continue-on-error: true`, outside the `ci`
// umbrella's `needs`), so a moved face baseline posted a diff gallery and a PR
// comment and shipped. The spec's own residual-scope note said so in as many
// words — "'Impossible to miss' here means VISIBLE, not ENFORCED" — and it was
// filed as a follow-up rather than a hole. Two PRs demonstrated the hole
// inside a week: #1468 removed a sidebar block from twelve modules with all
// twelve dock baselines stale, and the required lane was green throughout.
//
// The whole faceplate programme (32 faces, 64 baselines) was gated by a lane
// that cannot block a merge. Promoting the spec is the smallest change that
// makes "a face regression is un-mergeable" true, because a faceplate
// regression is a PIXEL regression — no def-reading gate can substitute.
//
// MEASURED CI COST, from run 31581123866 (ubuntu-latest, the numbers this
// decision was made on):
//
//   workflow-shell-faces.spec.ts   9.56 min  (64 scenes + 2 negative controls)
//   vrt-strict, before             6.60 min  → after ≈ 16.2 min
//   the merge-gating critical path 16.14 min (e2e shard 10/10)
//
// So the time-to-merge delta is ≈ ZERO: vrt-strict lands level with the
// longest required job rather than becoming the new bound. `timeout-minutes`
// on that job is raised 10 → 25 in the same commit, since 10 was already below
// the new figure. RUNNER-MINUTES cost is real and is +9.6/run: the spec stays
// in FULL_MATCH as well, because `task vrt:update` (the baseline CAPTURE) does
// NOT set VRT_STRICT, and dropping the faces from FULL_MATCH would silently
// stop capturing 64 baselines — a far worse failure than a duplicated run.
const STRICT_MATCH = ['vrt.spec.ts', 'workflow-shell-faces.spec.ts'];
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
  'dashboard.spec.ts',
  'landing.spec.ts',
];

// `VRT_PROBE=1` swaps the whole suite for the MEASUREMENT tools below. None of
// them asserts anything and none is in FULL_MATCH, so no lane picks them up by
// accident and they cost CI nothing. (This said "the two" while listing five;
// corrected in passing while adding the sixth, and again at the eighth — the
// prose is a LIST and goes stale silently, so add your entry when you add the
// file.)
//
//   * vrt-frame-stability.spec.ts — does this card SETTLE? Prints the pixels
//     that change between consecutive frames, and the bounding box of the
//     element responsible. This is what decides whether a surface belongs in
//     the live-surface registry at all, because `toHaveScreenshot` needs two
//     consecutive stable captures before it will even compare.
//   * vrt-surface-probe.spec.ts — what does the region SCORE? Prints the
//     statistics live vs force-killed, so a companion's floors can be DERIVED
//     from a measurement instead of guessed.
//   * vrt-geom-probe.spec.ts — where does the CAPTURE BOX come from? Prints the
//     element's layout box, its scroll container's box and the viewport, so a
//     baseline whose PNG DIMENSIONS move can be explained instead of re-pinned.
//   * vrt-fold-probe.spec.ts — what does the capture box CUT OFF, and is a
//     PASSING baseline actually identical? Prints, per curated face, the dock
//     pane's content height against the height the `max-height: min(60vh,
//     680px)` clamp lets it show plus the per-band offsets; then the exact diff
//     of every committed dock baseline at threshold 1/255 AND at the 26/255 the
//     gate applies. The instrument that measured the below-fold blindness, and
//     the one that tells a stale-but-passing baseline from an identical one.
//   * vrt-lane-tier-probe.spec.ts — what does a LANE TILE lay out, per tier?
//     Prints the tile body box, the chosen layout (row/plate), every cell's
//     CSS-px geometry and any pair of cells whose painted boxes INTERSECT, at
//     mini / compact / full. The `full` lane tier has no pixel baseline (see
//     workflow-shell-faces' own residual-scope list), which is how marbles
//     shipped a tile of overlapping faders to dev; this is the instrument that
//     measured it, and it found adsr's 13 px knob-readout overrun on the same
//     run. `PROBE_TYPES=<types>` picks the modules.
//   * vrt-face-audio-probe.spec.ts — is the AUDIO GRAPH running under a curated
//     face scene, and does the compact tile settle? Prints, per module, an
//     AnalyserNode's peak + frame-to-frame motion on the module's own audio
//     output alongside three consecutive tile captures, RUNNING and then
//     FROZEN. `moving > 0` is the free-running condition measured at its cause;
//     the paired capture diffs are the pixel consequence. `PROBE_FACES=<types>`
//     points it at modules outside the FACES roster.
//   * vrt-determinism-probe.spec.ts — does this face SCENE REPRODUCE? Boots the
//     same face TWICE through the gate's own scene code and prints the diff of
//     BOOT 1 against BOOT 2 at threshold 1/255 (any difference at all) as well
//     as at 26/255 — the threshold the gate applied when this probe was written,
//     kept as a second column because it separates a real render change from
//     last-significant-bit shimmer. The gate's own bar is now the ±2-LSB band
//     (threshold 0.01 — the tolerance block below), which sits BETWEEN the two
//     columns: read 1/255 for "does it reproduce at all", and remember that a
//     nonzero row whose max channel delta is ≤2 passes the gate anyway (that
//     band is the fleet's own per-CPU noise). Also prints the max channel delta
//     and the bounding box. The baseline is out of the loop entirely, so a
//     non-zero row cannot mean "the baseline is stale" — it can only mean the
//     scene does not reproduce. Negative AND positive control on every row.
const PROBE_MATCH = [
  'vrt-determinism-probe.spec.ts',
  'vrt-lane-tier-probe.spec.ts',
  'vrt-surface-probe.spec.ts',
  'vrt-face-audio-probe.spec.ts',
  'vrt-frame-stability.spec.ts',
  'vrt-geom-probe.spec.ts',
  'vrt-fold-probe.spec.ts',
  'vrt-sr-probe.spec.ts',
  'vrt-legacy-mask-audit.spec.ts',
];

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
  // VRT_JSON_REPORT appends the `json` reporter writing to that file. It is
  // how the strict shards make each failed screenshot assertion's attachment
  // metadata machine-readable — the `-expected` attachment's `path` is
  // Playwright's own absolute baseline path (SnapshotHelper.expectedPath), the
  // ONE authoritative `actual → baseline` mapping. The accept-candidates step
  // (ci.yml) depends on it because the test-results FOLDER names are
  // truncated (`moog907a` → `…--3cb78-g907a-…`) and must never be parsed for
  // a path that real bytes get written to. Env-gated and additive so the
  // `list` reporter's stdout — which scripts/vrt-shard-coverage.mjs diffs the
  // executed set out of — is untouched. Pass an ABSOLUTE path: a relative
  // outputFile resolves against this config's directory, not the caller's cwd.
  reporter: [
    ...(process.env.CI
      ? ([['github'], ['html', { open: 'never', outputFolder: './report' }], ['list']] as const)
      : ([['list'], ['html', { open: 'never', outputFolder: './report' }]] as const)),
    ...(process.env.VRT_JSON_REPORT
      ? ([['json', { outputFile: process.env.VRT_JSON_REPORT }]] as const)
      : []),
  ],
  outputDir: './test-results',

  // ── PER-TEST TIMEOUT ─────────────────────────────────────────────────────
  //
  // ⚠ THIS USED TO BE 30_000, WHICH WAS SMALLER THAN THE SUM OF THE BUDGETS
  // NESTED INSIDE IT. `vrt.spec.ts` alone declares `card.waitFor` 10 s +
  // `expect.timeout` for the screenshot, and then still has to pay page load,
  // networkidle, font decode, spawnPatch, the height-settle loop and the
  // live-surface companion + its negative control. At the old pair (30 s outer,
  // 15 s screenshot) the declared inner waits were already 25 s of a 30 s cap,
  // so on a slow renderer the outer bound killed tests that were making normal
  // progress. That is an arithmetic defect, not a renderer problem: no value of
  // "how fast is the runner" makes 10 + 15 + setup fit in 30.
  //
  // MEASURED — the first full single-baseline capture on linux CI (run
  // 31453467770, 292 passing tests, ubuntu-latest / SwiftShader):
  //
  //     median  5.6 s          > 15 s   48 tests
  //     p90    19.6 s          > 20 s   22 tests
  //     p95    25.9 s          > 25 s   16 tests
  //     p99    31.0 s          > 30 s    4 tests
  //     max    51.6 s  (cellshade-smooth, which passes under a 90 s spec-local cap)
  //
  // The old 30 s cap sat at the **p99 of its own passing population**. The
  // slowest test that passed under it did so at 26.2 s — 3.8 s of headroom —
  // and the tests just past it (mandelbulb, mandleblot, toybox combine-editor)
  // were the five capture failures. A budget at p99 is not a margin, it is a
  // coin flip, and it is the reason a *different* scene failed each dispatch.
  //
  // 90 s is chosen so the outer bound EXCEEDS the sum of its own inner budgets
  // (10 s waitFor + 30 s screenshot + setup + companions ≈ 45 s worst observed)
  // with better than 2x headroom, and it matches what the heavy specs already
  // declare for themselves via `test.setTimeout(90_000)` — cellshade-composite,
  // mirrorpool-composite and vrt-colourofmagic all pass under exactly this
  // number today, including a 51.6 s one. Those per-spec calls are now
  // redundant with the default rather than load-bearing above it.
  //
  // CI WALL-TIME COST: zero on green. A timeout is a cap, not a sleep — only a
  // test that is ALREADY failing runs to it, and it then costs 90 s instead of
  // 30 s. The required lane (`VRT_STRICT=1`) is the deterministic pure-DOM
  // subset whose median is 5.6 s, so it never approaches either number.
  //
  // ⚠ Do NOT "fix" a slow scene by raising THIS number. It is the bound for
  // every test in the lane, and moving it moves the bound for scenes nobody
  // measured.
  //
  // ⚠ AND THE SENTENCE THAT USED TO FOLLOW WAS WRONG, so it is corrected rather
  // than repeated (#1949). It read: "Past ~90 s the answer is that the scene is
  // not converging, which is a determinism finding." That conflates two
  // different budgets:
  //
  //   * CONVERGENCE is bounded by `expect.timeout` (30_000, below) — the
  //     screenshot-until-two-consecutive-captures-agree retry loop. A scene that
  //     never settles fails THERE, with the px ladder, at 30 s, regardless of
  //     what this number says.
  //   * THIS number bounds everything else: page load, font decode, spawnPatch,
  //     the freeze retries, the height-settle loop, the companion diffs. That is
  //     SCENE WEIGHT.
  //
  // MEASURED, capture run 32288252788: b3ntb0x's two face scenes both CONVERGED
  // and both wrote their actual PNG (55.6 s and ~88.6 s), and the dock one was
  // then killed by this cap 1.4 s after its snapshot write. Neither tripped
  // `expect.timeout`. "It is not converging" was falsified by the scene's own
  // output, and raising this number would not have made a non-converging scene
  // pass anyway — the determinism gate is the other budget.
  //
  // So a genuinely heavy scene gets a PER-SCENE bound instead, declared with the
  // measurement that justifies it and derived from it: see `faceSceneTimeout` /
  // `FaceSceneWeight` in `e2e/vrt/_shell-faces.ts`. Deny-by-default, `why` in
  // the type, and this number stays the floor for everything that does not
  // declare one.
  //
  // For what a REAL determinism fix looks like, see the frame-count convergence
  // loop in vrt-toybox.spec.ts.
  timeout: 90_000,

  // Snapshot path template. Default would scatter PNGs under
  // test-results/; we want them under __screenshots__/ so they're easy
  // to commit + diff in PRs.
  //
  // ⚠ NO `{platform}` SEGMENT — ONE baseline set, authored by LINUX CI.
  //
  // It used to be '__screenshots__/{testFilePath}/{platform}/{arg}{ext}',
  // which substitutes `process.platform` on the RUNNING machine: a macOS dev
  // wrote `darwin/`, CI read `linux/`. Two populations, therefore divergence,
  // therefore an apparatus to track divergence — four gap-declaration
  // mechanisms, three ratchets, a 617-line enumerator and a per-platform
  // capture matrix. Measured on `main` the day it was removed: 300 darwin PNGs
  // against 156 linux, of which 146 darwin scenes had NO linux sibling — i.e.
  // 146 scenes that looked covered everywhere and were never diffed on the
  // platform that gates.
  //
  // A local macOS run now compares against the LINUX baselines, so it will
  // show AA/font drift. That is the honest reading and it always was: the
  // green a Mac dev used to get proved nothing about CI, because CI never read
  // the darwin set. Use the Docker fast path (`task vrt:docker`) for a
  // pixel-exact local loop, and treat a native local run as a smoke test —
  // does it render, does it throw.
  //
  // LFS-tracked via the path-glob in .gitattributes
  // (`e2e/vrt/__screenshots__/**/*.png filter=lfs`).
  snapshotPathTemplate: '__screenshots__/{testFilePath}/{arg}{ext}',

  expect: {
    // ⚠⚠ THE SCREENSHOT SETTLE BUDGET LIVES HERE, NOT UNDER
    // `toHaveScreenshot` — AND IT USED TO LIVE IN THE WRONG PLACE.
    //
    // `expect.toHaveScreenshot` accepts EXACTLY seven keys (Playwright 1.59
    // types, node_modules/playwright/types/test.d.ts:191): threshold,
    // maxDiffPixels, maxDiffPixelRatio, animations, caret, scale, stylePath,
    // pathTemplate. There is NO `timeout`. A `timeout: 15_000` sat in that
    // object with a 14-line comment explaining that it existed to stop
    // `--update-snapshots` wedging on the heavy WebGL cards, and Playwright
    // silently ignored it: the real budget was the 5000 ms default, and the
    // regen kept wedging exactly as the comment said it would.
    //
    // MEASURED 2026-08-01 — the failure that exposed it, verbatim:
    //     Timeout: 5000ms
    //       Failed to take two consecutive stable screenshots.
    //   mandelbulb  4082 / 3954 / 3936 px  (ratio 0.02)
    //   toybox      5784 / 6604 / 5929 px  (ratio 0.02)
    // "Timeout: 5000ms" against a config that says 15_000 is the whole tell.
    //
    // TypeScript would have rejected the excess property on sight — but the
    // `e2e` workspace has NO `typecheck` script and NO tsconfig.json, so
    // `npm run typecheck --workspaces --if-present` skips it entirely and
    // NOTHING type-checks this file. That is why it survived. (Guarded now by
    // packages/web/src/lib/ui/vrt-config-budget.test.ts, which asserts the
    // budget is at a key Playwright actually reads and that no unknown key
    // reappears inside toHaveScreenshot.)
    //
    // `expect.timeout` IS the knob: it bounds the whole assertion, which for
    // toHaveScreenshot is the screenshot-until-two-consecutive-captures-agree
    // retry loop. CI wall-time delta ≈ 0: only a screenshot that is ALREADY
    // failing runs to the cap.
    //
    // RAISED 15_000 → 30_000 (2026-08-11), sized from the capture that exposed
    // it rather than guessed. The retry loop needs at least TWO captures that
    // AGREE, so the budget must hold at least two — and preferably four, since
    // the first pair disagreeing is the normal case on an animated card.
    //
    // MEASURED, from the failing call logs of run 31453467770: the loop got
    // through exactly TWO capture attempts before the 15 s cap, on both the
    // page path (cellshade-ink) and the element path (mandleblot) — i.e. ~7 s
    // per attempt for a heavy WebGL card under SwiftShader. 15 s bought two
    // attempts with no room to compare them; 30 s buys ~4.
    //
    // ⚠ READ THE CALL LOG BEFORE TOUCHING THIS — it distinguishes the two
    // failures that look identical from the outside, and they need opposite
    // fixes:
    //   * "Failed to take two consecutive stable screenshots" + a px ladder
    //     (e.g. `4082 / 3954 / 3936 px`) = the page genuinely never settles.
    //     Raising the budget cannot fix that; freeze the source of motion.
    //   * "Timeout Nms exceeded" with only 2 capture attempts logged and NO px
    //     ladder = the loop never got far enough to compare anything. That is
    //     pacing, and it is what all of the 2026-08-11 failures were.
    timeout: 30_000,
    toHaveScreenshot: {
      // ── ZERO DIFFERING PIXELS, ±2-LSB BAND (2026-08-29, owner-approved) ──
      //
      // The pixel COUNT budget is still zero: `maxDiffPixelRatio: 0` here and
      // `_shell-faces.ts`'s COMPACT_MAX_DIFF / DOCK_MAX_DIFF (per-scene
      // `maxDiffPixels`, both 0) allow NO differing pixel at all. What
      // `threshold: 0.01` changes is the DEFINITION of "differing": from
      // any-nonzero-delta to beyond-the-±2-LSB-band. ONE pixel beyond the
      // band still fails the gate.
      //
      // THE HISTORY, both rulings quoted so neither is lost:
      //
      // 2026-08-25, OWNER RULING (zero tolerance): *"VRTs are useless if
      // they can't be pixel perfect every time … i would never have consciously
      // allowed even a 1px tolerance"*. threshold and maxDiffPixelRatio both
      // went to 0; a comparison failed on ONE differing pixel of ONE channel
      // level. Zeroing was RIGHT about everything it found: a preview that had
      // STOPPED DRAWING (#2220), two unpinned simulations (spirographs' engine
      // clock, pong's tick accumulator), synthetic-bold text (#2257), and the
      // per-VM LCD-vs-grayscale AA coin-flip (#2260) — none visible at the
      // old 26/255 bar. Every one of those sat ABOVE the band this absorbs.
      //
      // WHAT FALSIFIED "pixel perfect every time" ON THIS FLEET, measured:
      // the hosted-runner pool mixes 4+ CPU models (three named so far —
      // EPYC 7763 / EPYC 9V74 / Xeon Platinum 8573C; ci.yml's 'Name the
      // runner CPU' log line exists because of this hunt), and with EVERY AA
      // pin active (font pinned, hinting none, skia-runtime-opts off,
      // lcd-text off, srgb profile) SwiftShader/Skia's per-uarch code paths
      // still rasterize anti-aliased edges 1-2 LSB apart PER CPU MODEL.
      // Identical code, byte-stable per draw, different bytes per
      // microarchitecture. Seven incidents in two days: the six
      // owner-approved 2026-08-28 card demotions (runs 33217755378 ff.),
      // then face-moog904a-compact red three more times on 2026-08-29 (e.g.
      // run 33282588837: 7 px of 88x82, every channel delta ±1-2) — each
      // incident 3-7 px per scene, max channel delta 2. moog902's baseline
      // was re-authored TWICE from verified actuals and the next draw on a
      // different CPU flipped it back red: unconvergeable by promotion,
      // because an AA edge has no single byte-truth on a heterogeneous
      // fleet. "Pixel-perfect every time" and "runs on whatever CPU the pool
      // hands out" cannot both hold; the owner chose the band (2026-08-29),
      // superseding the 2026-08-25 ruling, and the demoted scenes return to
      // coverage in the same change.
      //
      // THE BAR, mechanically (playwright-core `server/utils/comparators.js`):
      // `threshold` is passed straight to pixelmatch, whose per-pixel bar is
      // `35215 * threshold²` on the YIQ colour delta — t=0.01 → bar ≈ 3.52.
      // A gray/AA shift of ±2 LSB on all channels scores ≈ 2.02 → PASSES;
      // ±3 LSB scores ≈ 4.55 → FAILS. `maxDiffPixelRatio` becomes
      // `w * h * 0` = 0 differing pixels allowed, and the check is
      // `count > maxDiffPixels` — the file tests `!== undefined`, not
      // truthiness, so the zero is honoured rather than falling back to a
      // default.
      //
      // ⚠ THE BLIND SPOT, stated rather than implied: a REAL change confined
      // everywhere to the band — every pixel within ±2 LSB/channel of its
      // baseline (the YIQ bar honestly admits up to ±4 on a SINGLE channel)
      // — is now invisible to this gate, permanently. That band is exactly
      // where identical code already renders differently by CPU, so no
      // comparison on this fleet could attribute such a delta anyway. A
      // gray/AA delta of 3+ LSB, or ONE extra differing pixel, still fails.
      //
      // ⚠ THE BAND IS PINNED BY A PERMANENT INSTRUMENT LEG (the CLAUDE.md
      // negative-control-the-instrument rule):
      // `packages/web/src/lib/ui/vrt-comparator-band.test.ts` drives THE SAME
      // playwright-core comparator function this gate calls, both directions,
      // on every unit run — identical pass; one-pixel ±2 pass; one-pixel ±3
      // FAIL; the measured 7-px moog904a scatter (run 33282588837, exact
      // deltas) pass; and the same ±2 pixel FAIL at threshold 0, proving the
      // threshold is what does the work. Changing `threshold` here reddens
      // that test until the band is re-derived — by design.
      //
      // ⚠ A LOCAL macOS RUN IS STILL NOT A VERIFICATION. The darwin audit
      // measured dx7-dock 17 px, mirrorpool-compact 8 px, moog903a-compact
      // 4 px, scaler-compact 4 px — all maxDelta 1-2, so Metal-vs-linux
      // shimmer now mostly sits INSIDE the band instead of failing on it,
      // which makes a local green MORE seductive and exactly as meaningless
      // as before: linux CI authors the one baseline set, and a local run
      // can still fail on over-band font metrics. Use `task vrt:docker` for
      // a pixel-exact local loop.
      //
      // (Older history, kept: TIGHTENED 2026-07-31 from threshold 0.2 /
      // ratio 0.05, whose own comment said it "can be tightened toward 0.01
      // once baselines settle on each platform". At ratio 5% a 320x240 card
      // could change 3,840 pixels — a ~62x62 block, a whole knob — and stay
      // green. The documented case is A2/#1213: swapping filter's MODE from
      // a bare detented knob to a LABELLED SEGMENTED control, an entire
      // primitive swap, moved the dock face by 865 px; under that budget the
      // gate passed AND `--update-snapshots` refused to regenerate
      // (Playwright only rewrites a snapshot when the comparison FAILS), so
      // the change was both invisible and unfixable. `workflow-dock-patch`
      // likewise sat inside its budget for months while still rendering
      // v1.2.0-era chrome. The old per-channel threshold 0.1-0.2 compounded
      // it: a pixel shifting up to 10-20% per channel was not counted as
      // different AT ALL. Nothing about t=0.01 revives that class — its bar
      // sits at ~3.5 of the 35215 YIQ scale, between the fleet's own ±2
      // noise and the smallest deliberate edit ever measured here.)
      threshold: 0.01,
      maxDiffPixelRatio: 0,
      // Per-screenshot settle/capture timeout. Playwright's default is
      // 5000ms, which the heavy WebGL/animated cards (MANDLEBLOT,
      // MANDELBULB, WAVESCULPT-BLINK, …) intermittently blow on the CI
      // macOS runner — most visibly during `--update-snapshots`, where
      // "Failed to re-generate expected. Timeout 5000ms exceeded" aborts
      // the WHOLE baseline regen (vrt-update.yml) before it can commit —
      // the capture is ONE job — so a single heavy-card render stall (a
      // different card each dispatch — wavesculpt-blink, then mandleblot)
      // (The settle/capture budget that used to be MIS-SPELLED here as
      // `timeout: 15_000` now lives on `expect.timeout` above, where
      // Playwright actually reads it. See the note there.)
      //
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
    // ⚠ #1499: this MUST live inside `contextOptions` — Playwright 1.59 has no
    // top-level `reducedMotion` test option, and a top-level key is SILENTLY
    // IGNORED (verified against the fixture list in playwright/lib/index.js:
    // only `contextOptions` is spread into browser.newContext). The previous
    // top-level placement meant VRT captured WITHOUT prefers-reduced-motion.
    contextOptions: { reducedMotion: 'reduce' },
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
            // ── PIN THE AA MODE ITSELF (2026-08-28) ─────────────────────────
            // LCD-vs-grayscale text antialiasing is decided by Chromium per
            // ENVIRONMENT (compositing/surface state), not per build — and on
            // the hosted-runner fleet that decision measured BISTABLE PER VM:
            // whole strict-shard jobs rendered EVERY text-bearing tile with
            // grayscale AA against baselines authored with LCD fringes
            // (expected pixels like rgb(163,172,153)/(99,153,183) — strong
            // per-channel spread = subpixel fringes; actuals grayscale with
            // shifted metrics). Same commit, same runner image 20260823.283.1,
            // ~28 of 32 scenes per affected job, byte-stable within a job,
            // set shifting between jobs. Forcing grayscale removes the
            // decision. ⚠ A DELIBERATE ONE-TIME FULL RECAPTURE accompanies
            // this flag — every committed text baseline carried the fringes.
            '--disable-lcd-text',
            // Same family: pin colour management, so a VM's detected display
            // profile can never tint every gradient/AA edge by 1-2 units
            // (the residual delta band under the fringe diffs).
            '--force-color-profile=srgb',
            // Disable the smoothScrolling animation that fires on the
            // first .svelte-flow viewport mount.
            '--disable-smooth-scrolling',
            // Empty unless E2E_SWIFTSHADER / E2E_REAL_GPU is set — see GPU_ARGS.
            ...GPU_ARGS,
          ],
        },
      },
    },
  ],

  webServer: IS_LOCAL_TARGET
    ? {
        // --port + --strictPort: boot on EXACTLY the port `url:` waits on (the
        // derived per-worktree default, or the explicit E2E_PORT/E2E_BASE_URL
        // port). The old bare `npm run dev` booted vite's own default port, so
        // with any non-default target the command and the url disagreed and
        // only an already-running server (whosever it was) could satisfy it.
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
