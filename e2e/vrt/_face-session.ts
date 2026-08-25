// e2e/vrt/_face-session.ts
//
// ONE `/rack` BOOT PER SHARD, reused by every curated-face scene, instead of one
// boot per scene.
//
// ── WHY, MEASURED ───────────────────────────────────────────────────────────
//
// `vrt-strict` stopped FAILING and started TIMING OUT. ci.yml run 32869571989,
// shards 6/8 and 7/8: `45 passed (10.0m), 1 did not run`, ZERO test failures,
// killed by the lane's 600 s `--global-timeout`. It was one shard earlier the
// same day and two by the evening, because the lane grows with the roster:
// 4 334 CPU-s over 360 tests at 8 shards is 542 s of fair share against that
// 600 s cap, and every face that merges adds ~25 s.
//
// `workflow-shell-faces.spec.ts` is 4 005 s of the 4 334 (92 %), so it is the
// only place worth changing. Measured with `vrt-boot-probe.spec.ts` (this
// worktree, warm dev server, headless SwiftShader, one worker):
//
//     newContext + newPage                    38 ms      <- NOT the cost
//     goto + networkidle + fonts + hooks   1 500 ms      <- the cost
//       of which networkidle alone         1 428 ms
//     the rest of bootWithFace('adsr')     1 081 ms
//
// ⚠ AND IT IS NOT CACHE-BOUND, which is the finding that rules out the safe-
// looking alternative. A REPEAT `goto` on an already-warm page still costs
// 1 312 ms against a cold 1 473 ms — a warm HTTP + V8 cache is worth 161 ms. So
// "keep the context, re-navigate per scene" would buy ~10 % of the load and keep
// all of its own safety; it simply does not pay. What costs 1.5 s is the APP
// booting — the module registry's `import.meta.glob`, the pinned workflow rack's
// construction — and the only way not to pay it per scene is not to navigate.
//
// End to end on real scenes, same machine, same run (probe D):
//
//     compact scene   fresh 3 453 ms -> shared 1 892 ms   1.83x
//
// ── WHY IT IS SAFE ──────────────────────────────────────────────────────────
//
// This lane pins committed PNGs, so "faster" is worth nothing if a scene
// captures a pixel it would not have captured from a fresh boot. Two structural
// choices, then one measurement:
//
//   REUSE THE PAGE, NEVER REPLACE THE RENDER CONTEXT. Same real rack, same real
//   dock, same real spawn path. `bootWithFace` is now literally
//   `loadFaceRack` + `spawnFace`, and a shared scene calls the SECOND of those —
//   the same function, not a second boot path that "does the same thing". A
//   fresh-page scene and a shared-page scene cannot drift apart by construction.
//
//   RESTORE, DON'T WIPE. `resetFaceRack` returns the rack to a state SAMPLED
//   from a real boot — see its own comment for the two mutations a plain
//   "delete everything" gets wrong in opposite directions, and for why replaying
//   a hand-picked `{0,0,1}` viewport is also wrong.
//
//   THEN MEASURE IT. `vrt-boot-probe.spec.ts` captures each scene from a shared
//   page AND from a fresh boot ON THE SAME MACHINE IN THE SAME RUN and compares
//   them at 1/255 — not the gate's 26/255, because there is no run-to-run GPU
//   drift for a tolerance to absorb inside one run. It compares the dock scenes'
//   GEOMETRY too (`hiddenY` / `hiddenX` / `topY` / width slack / `plateW` / tab
//   count), because those are numbers a leaked viewport can move without moving
//   a pixel of the tile. Three orders — declared, reversed, shuffled — because
//   the failure to rule out is a scene that is right alone and wrong after fifty
//   others.
//
// ⚠ AND THE PROBE CARRIES A CONTROL ON ITSELF. A shared context does NOT inherit
// `vrt.config.ts`'s `use` block: Playwright applies viewport / deviceScaleFactor
// / reducedMotion through the `context` and `page` FIXTURES, and a context made
// off the `browser` fixture gets none of them. `rack-session.ts` calls
// `browser.newContext()` with no options at all — harmless for a functional
// sweep, a silent baseline move here. So the options are passed explicitly
// below, and the probe compares the config's OWN `page` fixture against a
// hand-built context to prove they render the same thing. Without that leg both
// sides of every other comparison could be equally wrong and every number would
// still come back clean.

import { test as base, expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import {
  loadFaceRack,
  resetFaceRack,
  sampleFaceRackPristine,
  LEGACY_FOLD_VIEWPORT,
  type BootFaceOptions,
  type FaceRackPristine,
} from './_shell-faces';

/**
 * ⚠ THE CONTEXT OPTIONS ARE A COPY OF `vrt.config.ts`'s `use` BLOCK, and that is
 * a Playwright constraint rather than a choice — a context created off the
 * `browser` fixture receives none of them. They are asserted equal to the
 * config's by `vrt-config-budget.test.ts`'s sibling check, and the probe's
 * CONTROL leg proves it renders identically, so this cannot drift silently in
 * either direction.
 */
const SESSION_CONTEXT_OPTIONS = {
  viewport: LEGACY_FOLD_VIEWPORT,
  deviceScaleFactor: 1,
  reducedMotion: 'reduce',
} as const;

/**
 * How many SCENES one shared page may serve before it is recycled.
 *
 * ⚠ A POLICY THRESHOLD ON A MEASURED QUANTITY, not a population count: it prices
 * page reuse and does not go stale when the roster grows.
 *
 * ⚠ AND IT IS NOT `rack-session.ts`'s 20. That number was measured on the
 * FUNCTIONAL lane, where `wavesculpt` is the only GL-heavy row in a family of
 * DOM ones; here EVERY scene is GL, every scene screenshots, and the lane runs
 * `workers: 1` with `retries: 0`. Carrying a constant across that difference is
 * the thing this repo keeps getting bitten by, so it was re-measured on this
 * lane rather than ported — see the PR body for the per-scene curve.
 *
 * The amortisation is insensitive to the exact value, which is why it is set
 * conservatively: a shard runs ~46 scenes, so 12 pays 4 boots instead of 46 and
 * still banks 42 of the 45 available. Halving it again would cost ~4 boots of the
 * ~63 s saved.
 */
export const MAX_SCENES_PER_PAGE = 12;

export interface FaceSession {
  /** The shared, already-booted page. */
  readonly page: Page;
  /**
   * Return the rack to the state a fresh boot leaves it in, and hand back a page
   * ready for `spawnFace`. Call it once at the top of every scene.
   */
  reset(): Promise<Page>;
  /**
   * Start collecting `pageerror` for THIS scene, and stop at scene teardown.
   *
   * ⚠ THE LISTENER HAS TO BE OWNED BY THE FIXTURE, NOT BY THE TEST BODY. On a
   * page that outlives the scene, a listener the body forgets to remove keeps
   * collecting from LATER scenes — and a body only removes it on the path where
   * nothing threw, which is exactly the path where it does not matter. The
   * failure that results is the shared page's nastiest: an error raised by
   * module A is reported against module B, which already passed.
   */
  armErrors(page: Page): string[];
  /**
   * A page of this scene's own, freshly navigated.
   *
   * ⚠ THE DECLARED ESCAPE HATCH, NOT A CONVENIENCE. A scene whose setup must run
   * BEFORE the app boots cannot share, because `addInitScript` only applies on a
   * navigation and skipping the navigation is the whole point. `simPin` is
   * exactly that, and `faceSceneNeedsFreshPage` decides it from the mechanism
   * rather than from a list of modules.
   */
  freshPage(opts?: BootFaceOptions): Promise<Page>;
}

interface FaceHost {
  context: BrowserContext;
  page: Page;
  pristine: FaceRackPristine;
  scenes: number;
}

async function bootHostPage(context: BrowserContext): Promise<{ page: Page; pristine: FaceRackPristine }> {
  const page = await context.newPage();
  await page.setViewportSize(LEGACY_FOLD_VIEWPORT);
  await loadFaceRack(page, {});
  return { page, pristine: await sampleFaceRackPristine(page) };
}

/**
 * Is this page still usable as a session host?
 *
 * ⚠ ANCHORED TO THE PAGE, NOT TO A FLAG. A scene that crashes the renderer or
 * navigates away would otherwise poison every scene after it in the shard, and
 * the failures would land on innocent MODULES — the single nastiest failure mode
 * of a shared page, because the red scene is never the guilty one. On a lane with
 * `retries: 0` that is a red main, not a re-run.
 */
async function hostIsHealthy(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  try {
    const ok = await page.evaluate(() => {
      const w = globalThis as unknown as { __patch?: unknown; __ydoc?: unknown; __flow?: unknown };
      return !!w.__patch && !!w.__ydoc && !!w.__flow;
    });
    if (!ok) return false;
    return new URL(page.url()).pathname === '/rack';
  } catch {
    return false;
  }
}

/**
 * Attach a failure screenshot for a scene on the shared page.
 *
 * ⚠ THE CONFIG'S `screenshot: 'only-on-failure'` FOLLOWS THE `page` FIXTURE, and
 * a shared page is not it — so a failing scene would otherwise arrive with no
 * picture of the page it failed on, in the one lane whose whole subject is what
 * the page looked like. Driven manually here, mirroring the config's setting.
 *
 * ⚠ TRACING IS DELIBERATELY NOT DRIVEN HERE. Playwright's artifact manager
 * instruments EVERY context created from the `browser` fixture — including this
 * one — and drives the per-test trace chunks itself. `rack-session.ts` drove it a
 * second time and failed 85 of 175 otherwise-green rows with "Must start tracing
 * before starting a new chunk": a harness bug wearing the costume of a product
 * failure. `trace: 'retain-on-failure'` therefore works unchanged; `video` is
 * already `off` in this config, so nothing is lost there either.
 */
async function attachFailureShot(page: Page, testInfo: TestInfo): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;
  if (page.isClosed()) return;
  try {
    const shot = await page.screenshot({ fullPage: false });
    await testInfo.attach('face-session-failure', { body: shot, contentType: 'image/png' });
  } catch {
    /* never let artifact handling change a scene's verdict */
  }
}

/**
 * The face suite's `test` object: `@playwright/test`'s, plus `faceSession`.
 *
 * `faceSession` is WORKER-scoped, and `vrt.config.ts` is `workers: 1`, so a shard
 * boots ONCE (or once per `MAX_SCENES_PER_PAGE`) rather than once per scene. The
 * one-off tests in the spec keep destructuring `{ page }` and keep getting an
 * ordinary per-test page — several of them deliberately drive abnormal states (an
 * unfrozen graph, a re-folded pane) that must not leak into a scene.
 */
export const test = base.extend<
  { faceSession: FaceSession },
  { faceHost: FaceHost }
>({
  faceHost: [
    async ({ browser }, use) => {
      const context = await browser.newContext(SESSION_CONTEXT_OPTIONS);
      const { page, pristine } = await bootHostPage(context);
      await use({ context, page, pristine, scenes: 0 });
      await context.close();
    },
    { scope: 'worker' },
  ],

  faceSession: async ({ faceHost }, use, testInfo) => {
    const owned: Page[] = [];

    // ⚠ RE-BOOT RATHER THAN INHERIT, for either of two reasons: the previous
    // scene may have killed the page, or the page may simply have served enough
    // scenes to have accumulated measurable state (see MAX_SCENES_PER_PAGE).
    faceHost.scenes += 1;
    const worn = faceHost.scenes > MAX_SCENES_PER_PAGE;
    if (worn || !(await hostIsHealthy(faceHost.page))) {
      if (!faceHost.page.isClosed()) await faceHost.page.close().catch(() => undefined);
      const booted = await bootHostPage(faceHost.context);
      faceHost.page = booted.page;
      faceHost.pristine = booted.pristine;
      faceHost.scenes = 1;
    }

    const armed: { page: Page; handler: (e: Error) => void }[] = [];

    const session: FaceSession = {
      get page() { return faceHost.page; },
      async reset() {
        await resetFaceRack(faceHost.page, faceHost.pristine);
        return faceHost.page;
      },
      armErrors(page: Page) {
        const errors: string[] = [];
        const handler = (e: Error) => errors.push(e.message);
        page.on('pageerror', handler);
        armed.push({ page, handler });
        return errors;
      },
      async freshPage(opts: BootFaceOptions = {}) {
        const p = await faceHost.context.newPage();
        owned.push(p);
        await p.setViewportSize(LEGACY_FOLD_VIEWPORT);
        await loadFaceRack(p, opts);
        return p;
      },
    };

    await use(session);

    // ⚠ DETACHED HERE, ON EVERY PATH — including the one where the scene threw,
    // which is the only path that matters (see `armErrors`).
    for (const { page, handler } of armed) {
      if (!page.isClosed()) page.off('pageerror', handler);
    }
    await attachFailureShot(faceHost.page, testInfo);
    for (const p of owned) if (!p.isClosed()) await p.close().catch(() => undefined);
  },
});

export { expect };
