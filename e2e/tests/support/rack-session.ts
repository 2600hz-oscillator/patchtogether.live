// e2e/tests/support/rack-session.ts
//
// THE SHARED RACK SESSION — one `/rack` boot per WORKER, reused by every row of
// a registry-driven sweep, instead of one boot per row.
//
// ── WHY, MEASURED ──────────────────────────────────────────────────────────
//
// The registry sweeps (`per-module-per-port-*`, `faces-parity*`) are ~175 and
// ~58 rows of "spawn ONE module, assert something about it". Each row paid a
// full `page.goto('/rack…')`. Measured locally against the PREVIEW bundle CI
// serves (`E2E_USE_PREVIEW=1`, the only mode whose numbers transfer — the VRT
// lane's dev-server figures do NOT, see the note at the bottom):
//
//   per-module-per-port-inputs   175 rows   median 1.05 s/row
//   faces-parity                  58 rows   median 1.17 s/row
//   `/rack` page load alone                 0.72 - 0.88 s
//
// So ~70-85 % of a typical row was the page load. Amortising it across a
// worker measured 1.14 s → 0.11 s per case on a spawn+frame+capture core.
//
// ⚠ AND THE COST IS *NOT* THE RACK. This was the wrong hypothesis first time
// round and it is worth pinning so nobody re-derives it: spawning a module and
// waiting for its channel column to form is 0.07-0.17 s. `waitForHooks` is
// 0.01 s. The expense is loading and evaluating the app's module graph, which
// is why the fix is "load it once", not "load something smaller" — a harness
// route that mounts one faceplate still imports the module registry
// (`import.meta.glob` over every def) and measured 1,381 requests against
// `/rack`'s 1,613.
//
// ── WHY IT IS SAFE: THE RESET ALREADY EXISTED ──────────────────────────────
//
// `spawnPatch` clears EVERY node and edge and rebuilds the patch in one Y.Doc
// transaction. The sweeps already lean on that: a module with 16 inputs calls
// `spawnPatch` 16 times inside ONE page load today. So "many modules, one
// boot" is not a new isolation claim — it is the existing per-port claim
// applied one level out, and the per-port claim has been green for months.
//
// What the page load ALSO did, silently, is reset four things `spawnPatch`
// does not touch. Those are this module's whole job, and each is here because
// leaving it out produced a WRONG RESULT rather than a failure:
//
//   1. ⚠ THE CANVAS VIEWPORT. Measured while prototyping: sweeping 24 modules
//      in declared / reversed / shuffled order produced DIFFERENT results for
//      20 of them — identical type, tier, control count and rendered text,
//      differing ONLY in the on-screen `width × height` of the shell, because
//      xyflow's zoom carried over from whatever the previous row left. Every
//      assertion that reads screen geometry (a bounding box, a "is it
//      visible", an overflow measurement) is zoom-sensitive, so a shared page
//      without this reset is a suite that is fast and quietly order-dependent.
//      With the reset, all 24 modules were byte-identical across all three
//      orders AND against a fresh-boot control. This is the reason the file
//      exists; treat it as load-bearing, not tidiness.
//   2. THE DOCK. `dockStore` holds a node id. A row that opened the full view
//      leaves it open, and because the sweeps reuse the SAME node id (`m` /
//      `sut`) the next row's freshly-spawned module can inherit a dock pane it
//      never opened — which looks like a passing dock assertion on a row that
//      never exercised the dock.
//   3. PAGE-ERROR LISTENERS. `collectPageErrors` attached listeners that the
//      discarded page used to take with it. See its `dispose()` note: without
//      it, row N's error list keeps growing from later rows, so a failure is
//      reported against a row that already passed.
//   4. THE `addInitScript` GLOBALS (`__videoEngineFreezeRender`, the
//      `FACE_QUIESCE` flags). ⚠ These are the one thing that genuinely does
//      NOT survive the change of shape, because `addInitScript` only applies
//      on the NEXT navigation and there is no next navigation. They are set
//      LIVE here instead. That is sound for both current consumers because
//      both are read per-frame / at module construction, and construction
//      happens at `spawnPatch` time — i.e. AFTER this reset runs. A future
//      global that is read once at app boot CANNOT use this path, and
//      `freshPage()` below is the declared escape hatch for it.
//
// ── WHAT THIS COSTS, STATED RATHER THAN DISCOVERED ─────────────────────────
//
// Playwright binds `trace` / `screenshot` / `video` to the TEST-scoped
// context. A worker-scoped context silently loses all three, which on a
// ~700-row change would be a large, invisible debuggability regression.
// So tracing is driven MANUALLY here, per row, mirroring the config's
// `retain-on-failure`, and a failure screenshot is attached the same way.
//
// ⚠ PER-TEST VIDEO IS GENUINELY LOST and cannot be recovered: video is
// recorded per CONTEXT for the context's whole lifetime, so a shared context
// can only ever produce one video per worker, not one per row. Traces carry
// screenshots and DOM snapshots and are what this repo's failures are actually
// diagnosed from; that is the trade, and it is named here rather than left for
// someone to find during an incident.

import { test as base, expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { collectPageErrors, type PageErrorCollector } from '../_page-errors';

/** Globals a row may need set BEFORE its module is constructed. */
export interface RackResetOptions {
  /** Freeze the video engine's per-frame GL draw (the `freezeVideoRender` global). */
  videoFreeze?: boolean;
  /** A `FACE_QUIESCE`-style construction-time flag. */
  quiesce?: { global: string; value: number } | undefined;
  /** The rack URL this row wants. Changing it re-navigates (and is charged). */
  url?: string;
}

export interface RackSession {
  /** The shared, already-booted page. */
  readonly page: Page;
  /**
   * Return the rack to a known-clean state and arm a FRESH error collector for
   * this row. Call it once at the top of every row; the collector is disposed
   * automatically at row teardown.
   */
  reset(opts?: RackResetOptions): Promise<PageErrorCollector>;
  /**
   * An ISOLATED, freshly-navigated page for a row that cannot share.
   *
   * The declared escape hatch, not a convenience: use it for a row whose setup
   * must run before app boot (a global read once at startup), or one whose
   * module is known to leave the page unusable. Closed at row teardown.
   *
   * `beforeBoot` runs against the new page BEFORE its navigation, which is the
   * only window in which `page.addInitScript` can still take effect — the
   * whole reason a row would need this hatch rather than `reset()`.
   */
  freshPage(opts?: { url?: string; beforeBoot?: (page: Page) => Promise<void> }): Promise<Page>;
}

/**
 * The rack URL a sweep boots, as a WORKER-SCOPED OPTION.
 *
 * ⚠ IT HAS TO BE AN OPTION, NOT A CONSTANT, AND THAT IS NOT A GENERALISATION
 * FOR ITS OWN SAKE — the two sweeps genuinely need different renderers:
 *
 *   per-module-per-port-inputs   `/rack?shell=legacy&seed=none`  verbatim cards
 *   faces-parity*                `/rack`                          FACEPLATE tiles
 *
 * `?shell=legacy` renders each module's own *Card.svelte; the bare default
 * renders `ModuleShell` faceplates, and the faces sweep asserts on
 * `[data-testid="module-shell"]`, which does not exist under the legacy
 * renderer. Hard-coding the legacy URL here failed 51 of 58 faces-parity rows
 * with `element(s) not found` — a shared-session bug that reads exactly like a
 * missing face.
 *
 * Because it is WORKER-scoped, Playwright allocates a separate worker per
 * distinct value, so two suites wanting different racks can never end up
 * sharing one booted page.
 */
export const LEGACY_RACK_URL = '/rack?shell=legacy&seed=none';
export const FACEPLATE_RACK_URL = '/rack';

const BOOT_TIMEOUT_MS = 60_000;

/**
 * How many rows one shared page may serve before it is recycled.
 *
 * ⚠ THE SHARED PAGE DEGRADES, AND THIS BOUNDS IT. A policy threshold on a
 * MEASURED quantity, not a population count — it prices page reuse, and it does
 * not go stale when the roster grows.
 *
 * MEASURED on `wavesculpt`, the heaviest GL face in the parity sweep and the
 * only row in that family over 5 s (67.5 s of the family's 284.5 s). Its five
 * chunks, same machine, `E2E_USE_PREVIEW=1`, one worker:
 *
 *   fresh page per row (main)                     10.7 12.2 12.3 12.0 14.0
 *   shared page, run ALONE (~no accumulation)     10.0 11.6 12.1 11.7 13.7
 *   shared page, after ~50 other faces            11.9 13.6 13.5 13.2 15.3
 *
 * Run alone the shared page MATCHES a fresh one, so the reset path itself is
 * not the cost — what costs ~10 % is state the page accumulates across rows
 * (GL resources a Y.Doc node delete does not tear down). Left unbounded that
 * grows with the roster.
 *
 * It is not merely a slow row: under four workers on the same machine the
 * unbounded version blew wavesculpt's budget on FOUR chunks where a fresh page
 * blew it on one, and CI runs these shards three workers wide. So the risk this
 * bounds is a CONTENTION FLAKE on the heaviest module, not a few seconds.
 *
 * 20 keeps the amortisation (a ~216-row family pays ~11 boots instead of 216,
 * i.e. ~10 s of the ~105 s saved) while capping accumulation at a fraction of
 * what produced the measurement above.
 */
const MAX_ROWS_PER_PAGE = 20;

/** A pan/zoom triple, in xyflow's own units. */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * Boot the rack and return THE VIEWPORT A FRESH BOOT PRODUCES.
 *
 * ⚠ THIS RETURN VALUE IS THE WHOLE CORRECTNESS ARGUMENT FOR THE VIEWPORT
 * RESET, and getting it wrong is measured rather than hypothetical. The first
 * version of `resetRack` restored a hand-picked identity transform
 * (`{ x: 0, y: 0, zoom: 1 }`) on the reasoning that "1:1 is neutral". It is
 * not neutral — it is simply a DIFFERENT viewport from the one a fresh `/rack`
 * boot lands on, which frames the channel lanes rather than the flow origin.
 * 51 of 58 faces-parity rows then failed `toBeVisible` on a shell that was
 * genuinely off-screen.
 *
 * So the pristine viewport is READ OFF A REAL BOOT and replayed. The shared
 * page's starting state is then equal to a fresh boot's BY CONSTRUCTION rather
 * than by my choice of constant — which is the only version of this that stays
 * true when the app's default framing changes.
 */
async function bootRack(page: Page, url: string): Promise<Viewport> {
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  // Event-driven readiness, not a settle: the sweeps drive the app through
  // these globals, so "they exist" is exactly the precondition.
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __ensureEngine?: unknown;
        __patch?: unknown;
        __ydoc?: unknown;
        __flow?: unknown;
      };
      return typeof w.__ensureEngine === 'function' && !!w.__patch && !!w.__ydoc && !!w.__flow;
    },
    undefined,
    { timeout: BOOT_TIMEOUT_MS },
  );
  // Two frames so the workflow's own initial framing has settled before it is
  // sampled — reading mid-transition would pin a viewport no boot ever ends on.
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  return page.evaluate(() => {
    const w = globalThis as unknown as { __flow: { getViewport: () => Viewport } };
    return w.__flow.getViewport();
  });
}

/**
 * Is this page still usable as a session host?
 *
 * ⚠ ANCHORED TO THE PAGE, NOT TO A FLAG. A row that crashes the renderer or
 * navigates away would otherwise poison every row after it in the worker, and
 * the failures would land on innocent modules — the single nastiest failure
 * mode of a shared page, because the red test is never the guilty one.
 */
async function sessionIsHealthy(page: Page, url: string): Promise<boolean> {
  if (page.isClosed()) return false;
  try {
    const ok = await page.evaluate(
      () => {
        const w = globalThis as unknown as { __patch?: unknown; __ydoc?: unknown };
        return !!w.__patch && !!w.__ydoc;
      },
      undefined,
    );
    if (!ok) return false;
    // A row that navigated the shared page elsewhere is a leak of exactly the
    // kind this file exists to stop.
    return new URL(page.url()).pathname === new URL(url, page.url()).pathname;
  } catch {
    return false;
  }
}

/**
 * THE RESET. Ordered deliberately: globals first (they must be in place before
 * anything constructs), then the dock, then the graph, then the viewport LAST
 * so nothing that follows can re-pan it.
 */
async function resetRack(page: Page, opts: RackResetOptions, pristine: Viewport): Promise<void> {
  // 2 — THE DOCK, through the product's own close button rather than a store
  // reached from the test. There is no `__dockStore` global and this file
  // deliberately does not add one: `Canvas.svelte` sits in the WebGL attest
  // basis, so a new hook there would force a trusted-GPU re-attest for a
  // teardown convenience. `faceplate-close` is the affordance a user has.
  const dock = page.getByTestId('dock-full-view');
  if (await dock.isVisible().catch(() => false)) {
    await page.getByTestId('faceplate-close').click().catch(() => undefined);
    await dock.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
  }

  await page.evaluate(
    ({ videoFreeze, quiesce, pristine }) => {
      const w = globalThis as unknown as {
        __videoEngineFreezeRender?: boolean;
        __patch?: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc?: { transact: (fn: () => void) => void };
        __flow?: { setViewport: (vp: Viewport, o?: { duration?: number }) => void };
      };

      // 4 — construction-time globals, set LIVE because addInitScript needs a
      // navigation this session deliberately does not make.
      w.__videoEngineFreezeRender = videoFreeze === true;
      if (quiesce) {
        (globalThis as unknown as Record<string, number>)[quiesce.global] = quiesce.value;
      }

      // The graph. `spawnPatch` does this too, but a row that never calls it
      // must still start from an empty rack rather than the previous row's.
      if (w.__patch && w.__ydoc) {
        w.__ydoc.transact(() => {
          for (const id of Object.keys(w.__patch!.edges)) delete w.__patch!.edges[id];
          for (const id of Object.keys(w.__patch!.nodes)) delete w.__patch!.nodes[id];
        });
      }

      // 1 — ⚠ THE VIEWPORT. The measured defect. Restored to the viewport a
      // FRESH BOOT lands on (sampled once, in bootRack) — never to a constant.
      // See bootRack for why the obvious `{0,0,1}` is wrong and what it cost.
      w.__flow?.setViewport(pristine, { duration: 0 });
    },
    { videoFreeze: opts.videoFreeze === true, quiesce: opts.quiesce ?? null, pristine },
  );

  // Let the viewport + unmounts land before the row spawns into them.
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

/**
 * A reset bound to ONE ordinary, already-booted page — the shared session's
 * mechanism without its worker-scoped fixture.
 *
 * ⚠ THIS IS FOR A DIFFERENT SHAPE, AND IT IS THE LOWER-RISK ONE. `faceplate-
 * platform.spec.ts` sweeps the whole migrated-face roster INSIDE a single
 * test — `for (const spec of faces) { await gotoShell(page); … }` — so it
 * already reuses one page and already re-navigates it hundreds of times per
 * run (once per face, and the row-packing leg does it twice over, once per
 * pane width). Swapping that navigation for this reset changes strictly less
 * than the fixture does: the page was ALREADY shared, and only the `goto`
 * goes away.
 *
 * Capture it AFTER the caller's first boot (and after any
 * `setViewportSize`), because the pristine viewport it replays is read from
 * the live page — see `bootRack` for why a constant is wrong.
 */
export async function createPageReset(
  page: Page,
): Promise<(opts?: RackResetOptions) => Promise<void>> {
  const pristine = await page.evaluate(() => {
    const w = globalThis as unknown as { __flow?: { getViewport: () => Viewport } };
    return w.__flow?.getViewport() ?? { x: 0, y: 0, zoom: 1 };
  });
  return (opts: RackResetOptions = {}) => resetRack(page, opts, pristine);
}

/**
 * Attach a failure screenshot for a row on the shared page.
 *
 * ⚠ TRACING IS NOT DRIVEN HERE, AND THE FIRST VERSION OF THIS FILE GOT THAT
 * WRONG. It called `context.tracing.start()` / `.stop()` per row, on the belief
 * that a worker-scoped context loses the config's `trace: 'retain-on-failure'`.
 * It does not: Playwright's artifact manager instruments EVERY context created
 * from the `browser` fixture — including this one — and drives the per-test
 * trace chunks itself. Driving it a second time collided with that and failed
 * 85 of 175 rows with `Must start tracing before starting a new chunk`, on rows
 * that were otherwise green. That is a harness bug wearing the costume of a
 * product failure, which is the exact class this whole change has to avoid, so
 * it is recorded rather than quietly deleted.
 *
 * Traces and per-test screenshots therefore work UNCHANGED. Only per-test VIDEO
 * is lost (see the header).
 */
async function attachFailureShot(page: Page, testInfo: TestInfo): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;
  if (page.isClosed()) return;
  try {
    const shot = await page.screenshot({ fullPage: false });
    await testInfo.attach('rack-session-failure', { body: shot, contentType: 'image/png' });
  } catch {
    /* never let artifact handling change a row's verdict */
  }
}

/**
 * The sweep `test` object: same API as `@playwright/test`'s, plus `rack`.
 *
 * `rack` is WORKER-scoped, so the boot is paid once per worker rather than
 * once per row. Rows that need real isolation call `rack.freshPage()`.
 */
export const test = base.extend<
  { rack: RackSession },
  {
    rackUrl: string;
    rackHost: {
      context: BrowserContext;
      page: Page;
      url: string;
      pristine: Viewport;
      rows: number;
    };
  }
>({
  // Declared `option: true` so a suite sets it with `test.use({ rackUrl })`.
  rackUrl: [LEGACY_RACK_URL, { scope: 'worker', option: true }],

  rackHost: [
    async ({ browser, rackUrl }, use) => {
      const url = rackUrl;
      const context = await browser.newContext();
      const page = await context.newPage();
      const pristine = await bootRack(page, url);
      await use({ context, page, url, pristine, rows: 0 });
      await context.close();
    },
    { scope: 'worker' },
  ],

  rack: async ({ rackHost }, use, testInfo) => {
    let { page } = rackHost;
    const { context, url } = rackHost;
    let { pristine } = rackHost;

    // ⚠ RE-BOOT RATHER THAN INHERIT, for either of two reasons: the previous
    // row may have killed the page, or the page may simply have served enough
    // rows to have accumulated measurable state (see MAX_ROWS_PER_PAGE).
    rackHost.rows += 1;
    const worn = rackHost.rows > MAX_ROWS_PER_PAGE;
    if (worn || !(await sessionIsHealthy(page, url))) {
      if (!page.isClosed()) await page.close().catch(() => undefined);
      page = await context.newPage();
      rackHost.page = page;
      pristine = await bootRack(page, url);
      rackHost.pristine = pristine;
      rackHost.rows = 1;
    }

    const extraPages: Page[] = [];
    // A holder rather than a bare `let`: the only writes happen inside
    // `reset()`'s closure, which TypeScript's control-flow analysis cannot
    // see, so a plain local narrows to `never` by the teardown below.
    const state: { collector: PageErrorCollector | null } = { collector: null };

    const session: RackSession = {
      get page() {
        return page;
      },
      reset: async (opts: RackResetOptions = {}) => {
        if (opts.url && opts.url !== url) {
          // An explicit different rack — honour it, and pay for it.
          await page.goto(opts.url);
          await page.waitForLoadState('networkidle');
        }
        await resetRack(page, opts, pristine);
        state.collector?.dispose();
        state.collector = collectPageErrors(page);
        return state.collector;
      },
      freshPage: async (o = {}) => {
        const p = await context.newPage();
        extraPages.push(p);
        if (o.beforeBoot) await o.beforeBoot(p);
        await bootRack(p, o.url ?? url);
        return p;
      },
    };

    await use(session);

    state.collector?.dispose();
    for (const p of extraPages) await p.close().catch(() => undefined);
    await attachFailureShot(page, testInfo);
  },
});

export { expect };
