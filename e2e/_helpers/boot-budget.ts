// e2e/_helpers/boot-budget.ts
//
// THE latency bounds for BOOT and FIRST PAINT. One export site, imported by
// specs — the same argument that gives frame waits exactly one home in
// `./frames.ts`.
//
// ── why a bound is not an assertion ────────────────────────────────────────
//
// A wait on the topbar after `goto` is not a claim about how fast the topbar
// paints. It is a BOUND: the number that decides how long the test is willing
// to wait before calling the app broken. No spec here asserts boot latency, so
// no spec here should fail on it.
//
// A FLAT wall-clock bound is therefore not one assertion — it is a DIFFERENT
// assertion on every runner. CI's 2-core runners swing >=2x run-to-run on
// identical code (#1860), and ten e2e shards run in parallel on top of that. A
// flat bound is a lottery ticket, and the lane buys a losing one a few times a
// day.
//
// ── what it cost, measured ─────────────────────────────────────────────────
//
// #1875 lost TWO `main` push runs in one day to exactly this. Read off the
// failing attempt in the blob reports of every completed `ci.yml` run in the
// window to 2026-08-19 (31 runs, all 10 shards each), the single most common
// flake in the entire suite was one line, verbatim:
//
//   Error: expect(locator).toBeVisible() failed
//   Locator: getByTestId('workflow-topbar')
//   Expected: visible
//   Timeout: 5000ms          <-- Playwright's DEFAULT expect timeout
//   Error: element(s) not found
//
// `workflow-shell.spec.ts` alone recovered that flake on 16 of the 31 runs.
// Every occurrence was `failed -> passed` on the SAME SHA: the runner lottery,
// not a defect. Each one rode a GREEN job, because `retries: 1` recovered it.
//
// ── ⚠ the bug is the DEFAULT, and the default is INVISIBLE ─────────────────
//
// `expect(locator).toBeVisible()` with no options takes the 5 s expect
// timeout. Nothing in the source says "5000" — which is precisely why this
// spread to twenty-odd sites unnoticed and why a runtime gate can never see
// it. There is nothing to grep for except the ABSENCE of an option, so the
// guard has to be a source-level one (`scripts/e2e-boot-bound-source.test.ts`).
//
// ⚠ Note the two APIs do NOT share a default, and conflating them is an easy
// mistake: `expect(...).toBeVisible()` bounds at the 5 s EXPECT timeout, while
// `locator.waitFor()` has no timeout of its own ("Defaults to 0 - no timeout")
// and is bounded only by the TEST budget. Only the first is the #1875 defect;
// see the source gate's scope note for what that means for the second.
//
// ── why generous is free ───────────────────────────────────────────────────
//
// A bound only costs wall-clock when it is EXCEEDED. The wait exits the
// instant the element paints, so raising it adds exactly zero to a green run
// and changes only what happens on a run that was going to be a false red.
// The bound still exists to stop a genuinely broken app hanging the lane —
// which is what `--global-timeout` and `scripts/e2e-shard-budget.sh` bound
// from the outside anyway.
//
// ⚠ THIS IS NOT A LICENCE TO WIDEN AN ASSERTION. Bounds only. If a number is
// the thing a test CLAIMS, scaling it is moving the goalposts — and the rule
// for renderer-dependent claims is to count FRAMES instead (`./frames.ts`).

/**
 * True where first paint is slow and highly variable: CI's shared 2-core
 * runners, and any local run forced onto SwiftShader.
 *
 * Kept as one exported predicate because ~12 face specs each declared their
 * own local `SLOW_RENDER` with its own pair of numbers — the drift shape this
 * module exists to end.
 */
export const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

/**
 * Bound for BOOT / FIRST PAINT — the topbar, the flow pane, the canvas root:
 * whatever a spec waits for after `goto` to decide the app came up.
 *
 * The local bound is not 5 s either: a sibling agent's install or suite load
 * can push first paint past 5 s on a dev box (measured at 5.3 s against the
 * old bound while 13 of 14 sibling tests passed), so the flat default is a
 * lottery locally too — just a rarer one.
 */
export const BOOT_MS = SLOW_RENDER ? 30_000 : 15_000;

/**
 * Bound for a PLACEHOLDER / TILE to paint after boot — strictly later than
 * boot, because the shell must be up before it can lay a tile out, so it gets
 * its own larger number rather than reusing BOOT_MS.
 */
export const PLACEHOLDER_PAINT_MS = SLOW_RENDER ? 45_000 : 15_000;

/**
 * Per-test budget for a spec whose WHOLE test timed out on a slow runner while
 * waiting on a post-boot subject.
 *
 * Playwright's default per-test timeout is 30 s and this suite does not
 * override it, so for any wait that carries no timeout of its own the test
 * budget IS the bound. Four specs were measured recovering `timedOut ->
 * passed` on the same SHA against it. Applied per-spec via
 * `test.describe.configure({ timeout })`, never in `e2e/playwright.config.ts`:
 * that file is in the WebGL attest basis (`STANDALONE_BASIS_FILES`), so a
 * one-line edit there costs a real-GPU re-attest, while `e2e/tests/**` is
 * hash-transparent by design.
 *
 * ⚠ Raising a FAILURE bound does not hide a COST regression. Lane cost is
 * gated separately and explicitly by `scripts/e2e-shard-budget.sh`, which
 * fails a shard at 0.85 of its `--global-timeout` and prints the percentage on
 * every run, green or not. The budget is the gauge; this is only the bound.
 */
export const SLOW_BOOT_TEST_TIMEOUT_MS = SLOW_RENDER ? 90_000 : 30_000;
