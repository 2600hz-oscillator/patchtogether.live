// e2e/tests/skifree-node-lifetime.spec.ts
//
// SKIFREE'S GAME MUST BELONG TO THE NODE, NOT TO THE CARD.
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
//
// `SkifreeCard.svelte` is the ONLY place the game is ever created: `onMount`
// injects the bundle `<script>` and calls `window.SkiFree.create({ canvas })`
// against the CARD's own canvas, and `onDestroy` calls `controller.dispose()`.
// The def says so in its own words — "The card owns the canvas + the loaded
// bundle's controller" (`skifree.ts`).
//
// Under the SHIPPING shell an un-migrated module renders a placeholder tile and
// its real card exists only while the dock full-view is open. So:
//
//   * a rack containing SKIFREE has NO GAME AT ALL until someone expands the
//     dock pane — this is the DEFAULT state, not a collapse edge case; and
//   * collapsing that pane (or letting the dock LRU-evict it when a third
//     module is expanded) DESTROYS THE RUN IN PROGRESS.
//
// ⚠ WHY IT SURVIVED: IT FAILS BLACK, NOT BROKEN. The factory's `drawFrame`
// reads `bridge?.controller?.canvas` and RETURNS EARLY when it is absent, so
// the `out` VIDEO port yields a black frame rather than an error. A downstream
// VIDEO OUT looks plausible, nothing throws, and no console error is logged.
//
// ── ⚠ WHY THIS SPEC BOOTS THE REAL SHELL, AND WHY THAT IS THE WHOLE POINT ───
//
// `e2e/tests/skifree.spec.ts` boots `/rack?shell=legacy`, where the lane paints
// the real card — so the card is always mounted and the bug cannot appear. That
// is true of EVERY existing skifree test, which is why nothing caught this. A
// version of this spec on `?shell=legacy` would pass against the broken code.
//
// ── THE OBSERVABLE, AND ITS BUILT-IN NEGATIVE CONTROL ───────────────────────
//
// `read(node, 'snapshot')` is assembled in the factory's scheduler tick:
// `tick` and `cvDriven` are written EVERY tick unconditionally, while
// `distance` / `lives` / `crashes` are read from `controller.getState()` and
// are only refreshed when a controller EXISTS. So one sample carries both
// halves of the question:
//
//   tick climbing      → the engine is materialized and ticking (so a zero
//                        `distance` is not "the harness never looked")
//   distance climbing  → the GAME is actually running
//
// "the module is dead" and "the probe is dead" therefore cannot look alike,
// which is the failure mode this file would otherwise be prone to.
//
// ⚠ SAMPLED IN THE PAGE, NOT BY A PLAYWRIGHT POLL LOOP. A per-sample round trip
// runs on the same main thread as the subject, so a loaded runner starves both
// and "frozen" becomes indistinguishable from "never looked" — the exact
// confusion this spec exists to resolve. The accumulator lives in the page and
// reports `samples` / `elapsedMs` alongside the values.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;
const NODE = 'ski';

/** The shipping shell. NOT `?shell=legacy` — see the header. */
async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({
    timeout: SLOW_RENDER ? 30_000 : 15_000,
  });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/**
 * Resume the AudioContext so the scheduler clock ticks.
 *
 * ⚠ REQUIRED HERE, NOT COSMETIC: the factory's CV taps and the snapshot builder
 * are scheduler-clock subscribers, so with a suspended context the cursor is
 * never written and the skier never starts. A local copy of `skifree.spec.ts`'s
 * helper — it is four lines, not exported, and importing across spec files
 * would couple two suites' lifetimes for no gain.
 */
async function resumeAudio(page: Page): Promise<void> {
  await page.locator('button:has-text("Tap to start")').first()
    .click({ timeout: 2000 })
    .catch(() => { /* already running */ });
}

interface Watch {
  samples: number;
  elapsedMs: number;
  tickFirst: number;
  tickLast: number;
  distFirst: number;
  distLast: number;
  hasController: boolean;
  /** Did the NODE build its game? True from `create()`, which is BEFORE the
   *  skier exists. */
  createdLast: boolean;
  /** Has the skier EVER moved? Latched by the factory, so it survives the boot
   *  gap — this is what separates "still booting" from "booted and stalled". */
  startedLast: boolean;
  /** Non-null when the bundle failed to load, so a zero distance is explained
   *  rather than mysterious. */
  bundleError: string | null;
  /** Is the factory currently writing the cursor from CV? Without this, "the
   *  skier is not moving" cannot be told apart from "nothing is steering it". */
  cvDrivenLast: boolean;
  /** Crashes on the CURRENT controller. Per-controller state, so a game that was
   *  destroyed and rebuilt reads 0 — which is what makes it the right subject
   *  for run CONTINUITY across a collapse. */
  crashesLast: number;
}

/**
 * Watch the node's own snapshot for `frames` animation frames, IN THE PAGE.
 * Returns first/last of both counters plus how many samples were actually
 * taken — a report with `samples: 0` is a broken probe, not a frozen module.
 */
async function watchSnapshot(page: Page, nodeId: string, frames: number): Promise<Watch> {
  return page.evaluate(
    async ({ id, n }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown> };
        __engine: () => { read: (node: unknown, key: string) => unknown } | null;
        __skifree?: { controller: unknown };
      };
      interface Snap {
        tick: number; distance: number; cvDriven: boolean; crashes: number;
        gameCreated: boolean; gameStarted: boolean; bundleError: string | null;
      }
      const read = (): Snap | null => {
        const node = w.__patch.nodes[id];
        const eng = w.__engine();
        if (!node || !eng) return null;
        return (eng.read(node, 'snapshot') as Snap | undefined) ?? null;
      };
      const t0 = performance.now();
      let samples = 0;
      let tickFirst = -1;
      let tickLast = -1;
      let distFirst = -1;
      let distLast = -1;
      let createdLast = false;
      let startedLast = false;
      let bundleError: string | null = null;
      let cvDrivenLast = false;
      let crashesLast = 0;
      await new Promise<void>((resolve) => {
        let left = n;
        const step = (): void => {
          const s = read();
          if (s) {
            samples++;
            if (tickFirst < 0) { tickFirst = s.tick; distFirst = s.distance; }
            tickLast = s.tick;
            distLast = s.distance;
            createdLast = s.gameCreated;
            startedLast = s.gameStarted;
            bundleError = s.bundleError;
            cvDrivenLast = s.cvDriven;
            crashesLast = s.crashes;
          }
          if (--left <= 0) { resolve(); return; }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      return {
        samples,
        elapsedMs: Math.round(performance.now() - t0),
        tickFirst, tickLast, distFirst, distLast,
        hasController: !!w.__skifree?.controller,
        createdLast, startedLast, bundleError, cvDrivenLast, crashesLast,
      };
    },
    { id: nodeId, n: frames },
  );
}

/**
 * Wait until the node has BUILT a playable game.
 *
 * ⚠ "A CONTROLLER EXISTS" IS NOT THAT, AND THE SIBLING SPEC ALREADY SAYS SO.
 * `skifree.spec.ts` documents it at its own `waitForGameReady`:
 * *"`window.SkiFree.create()` returns a controller SYNCHRONOUSLY, but the
 * game's classes (player/game) are only built after the two sprite-sheet PNGs
 * finish loading (loadImagesThen → buildGame), an async step."* So there is a
 * real interval with a controller and no skier behind it, and a probe that
 * stopped at `controller != null` would measure that gap and call it a broken
 * game. An earlier draft of this file did exactly that.
 *
 * The bundle fetch plus two PNG decodes is a REAL PRODUCT-SIDE LATENCY, so this
 * waits on the SUBJECT rather than on a clock, and costs nothing once warm.
 *
 * ⚠ It waits on `_forceCrash` REGISTERING — the same signal the sibling uses —
 * because that is the only readiness signal the bundle exposes that implies the
 * PLAYER exists. It mutates the run by one crash, which is fine here and is why
 * every caller treats the crash counter as a baseline to read AFTER readiness
 * rather than a number that starts at zero.
 */
async function waitForGame(page: Page, nodeId: string): Promise<void> {
  try {
    await expect
      .poll(() => forceCrash(page, nodeId), { timeout: SLOW_RENDER ? 30_000 : 15_000 })
      .toBeGreaterThan(0);
  } catch (e) {
    // ⚠ A WAIT THAT TIMES OUT MUST SAY WHAT IT SAW. "no crash registered" is
    // consistent with four different failures — no node, no game, a bundle that
    // failed to load, or a controller whose sprites never decoded — and they
    // need four different fixes. `gameCreated` / `gameStarted` / `bundleError`
    // ride the snapshot precisely so this message can be specific.
    const w = await watchSnapshot(page, nodeId, 5);
    throw new Error(
      `the node never built a playable game. Final state: ${JSON.stringify(w)}\n`
        + `  created=${w.createdLast} error=${w.bundleError ?? 'none'}\n`
        + '  created=false + no error -> the node never built its game (the DEFECT)\n'
        + '  created=false + error    -> the bundle failed to load (see the error)\n'
        + '  created=true             -> built, but the player never appeared\n'
        + `  (original: ${(e as Error).message})`,
    );
  }
}

/**
 * Force one crash on the node's game and return the resulting crash count.
 *
 * Returns 0 when there is no game or no player yet, which is what makes it
 * usable as BOTH the readiness probe and the liveness assertion — a dead or
 * half-built game cannot fake a rising counter.
 */
async function forceCrash(page: Page, nodeId: string): Promise<number> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, unknown> };
      __engine: () => { read: (node: unknown, key: string) => unknown } | null;
    };
    const node = w.__patch.nodes[id];
    const eng = w.__engine();
    if (!node || !eng) return 0;
    const ctl = eng.read(node, 'controller') as
      | { _forceCrash(): void; getState(): { crashes: number } }
      | null
      | undefined;
    if (!ctl) return 0;
    ctl._forceCrash();
    return ctl.getState().crashes;
  }, nodeId);
}

test.describe('SKIFREE — the game belongs to the NODE', () => {
  test('a rack with SKIFREE builds its game with NOTHING expanded', async ({ page }) => {
    // ⚠ THE DEFAULT STATE. No dock opened, no click, no collapse — this is what
    // a player sees on loading a saved rack that contains SKIFREE.
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'skifree', position: { x: 200, y: 200 } }]);
    await resumeAudio(page);

    // ── the ENGINE is alive: the negative control, asserted FIRST ──────────
    // Without this leg, everything below would be equally consistent with "the
    // node was never materialized" and "the harness never looked", and telling
    // those apart from the defect is this file's entire job.
    const w = await watchSnapshot(page, NODE, SLOW_RENDER ? 90 : 45);
    expect(w.samples, `the probe took no samples at all (${JSON.stringify(w)})`).toBeGreaterThan(5);
    expect(
      w.tickLast,
      `the factory's scheduler tick never advanced, so this test would be measuring a dead `
        + `ENGINE rather than a dead GAME (${JSON.stringify(w)})`,
    ).toBeGreaterThan(w.tickFirst);

    // ── the NODE built its own game ───────────────────────────────────────
    // BEFORE THE FIX this failed here with:
    //   samples 45 / 368 ms · tick 0 -> 15 · distance 0 -> 0 · controller false
    // — engine ticking, no controller in existence, no game anywhere.
    await waitForGame(page, NODE);
    const built = await watchSnapshot(page, NODE, 5);
    expect(built.createdLast, JSON.stringify(built)).toBe(true);
    expect(built.hasController, JSON.stringify(built)).toBe(true);
    expect(built.bundleError, 'the bundle loaded cleanly').toBeNull();

    // ── and it is a REAL, PLAYABLE game, not just an allocated object ──────
    // ⚠ `gameCreated` ALONE WOULD PASS AGAINST A HALF-BUILT GAME. `create()`
    // returns SYNCHRONOUSLY and the bundle only builds the player after two
    // sprite sheets decode, so a controller can exist with no skier behind it.
    // A crash that actually registers is what proves the player exists — the
    // strongest liveness claim available without steering the thing.
    const crashes = await forceCrash(page, NODE);
    expect(
      crashes,
      'a forced crash must register on a node-owned game with no card mounted',
    ).toBeGreaterThan(0);
  });

  test('COLLAPSING the dock does not destroy the run in progress', async ({ page }) => {
    // ⚠ THE SUBJECT IS RUN CONTINUITY, NOT DISTANCE, AND THE FIRST DRAFT GOT
    // THAT WRONG — worth writing down, because the wrong version passed once.
    // Distance only advances while the cursor sits BELOW the skier (the def:
    // "pulling the cursor lower makes the skier point more steeply downhill"),
    // so driving x/y from a bipolar LFO made movement a function of WHERE THE
    // WINDOW LANDED IN THE OSCILLATOR'S PHASE. Measured across four runs of
    // identical code: 2 passed, 2 failed, 1 failed, 2 failed. That is a
    // TEST-bug — the assertion was timing-coupled by construction — and
    // re-running it until it went green would have shipped a spec that fails
    // one CI shard in three.
    //
    // The crash COUNTER is the right subject and it is deterministic: it is
    // per-controller state, so if a collapse destroyed the game and a re-expand
    // built a fresh one, the count resets to 0. Nothing about it depends on a
    // clock, an oscillator, or how many frames elapsed.
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'skifree', position: { x: 200, y: 200 } }]);
    await resumeAudio(page);
    await waitForGame(page, NODE);

    // Establish a run with real state on it, with NOTHING expanded.
    await forceCrash(page, NODE);
    const before = await forceCrash(page, NODE);
    expect(before, 'two forced crashes are on the record').toBeGreaterThanOrEqual(2);

    // ⚠ THE LANE TILE IS A `module-shell-placeholder`, NOT A `module-shell` —
    // skifree is un-migrated, so the shipping shell paints the placeholder and
    // the real card exists only inside the dock full view. That IS the defect's
    // setting, so the locator says it out loud rather than reaching for the
    // faced one.
    const tile = page.locator(
      `.svelte-flow__node[data-id="${NODE}"] [data-testid="module-shell-placeholder"]`,
    );
    await expect(tile).toBeVisible();

    // Open the dock to LOOK at the game — the ordinary reason a player expands.
    const expand = tile.getByTestId('shell-open-dock');
    await expect(expand).toHaveAttribute('data-expanded', 'false');
    await expand.click();
    await expect(page.getByTestId('dock-full-view')).toBeVisible();
    await expect(expand).toHaveAttribute('data-expanded', 'true');

    // Collapse it with ESC — which `ModuleShellPlaceholder` documents as the
    // gesture ("TRANSIENT dockStore full-view occupancy, per-tab, ESC-closable").
    // ⚠ NOT the EXPAND pill: while the pane is open the dock overlay sits over
    // the lane tile, so the pill resolves and reports visible/enabled/stable and
    // the click never lands — a 30 s timeout with a perfectly healthy-looking
    // call log. A pane also closes on dock LRU eviction when a third module is
    // expanded; none of these mean the player stopped playing.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dock-full-view')).toBeHidden();
    await expect(expand).toHaveAttribute('data-expanded', 'false');

    // ── THE ASSERTION: the run survived ───────────────────────────────────
    const after = await watchSnapshot(page, NODE, SLOW_RENDER ? 60 : 30);
    expect(
      after.samples,
      `the probe stopped sampling after the collapse (${JSON.stringify(after)})`,
    ).toBeGreaterThan(5);
    expect(
      after.hasController,
      `the game was destroyed by the collapse (${JSON.stringify(after)})`,
    ).toBe(true);
    expect(
      after.crashesLast,
      `the run RESTARTED across the expand/collapse cycle: crashes went ${before} -> `
        + `${after.crashesLast}. A collapse is not a quit (${JSON.stringify(after)})`,
    ).toBeGreaterThanOrEqual(before);

    // ⚠ NEGATIVE CONTROL, IN THE SAME TEST: the counter is not merely frozen or
    // stale-but-readable. A FRESH crash after the collapse must still register,
    // which proves the surviving game is LIVE rather than a corpse whose old
    // numbers happen to still be legible.
    const revived = await forceCrash(page, NODE);
    expect(
      revived,
      'the game must still be PLAYABLE after the collapse, not merely present',
    ).toBeGreaterThan(after.crashesLast);
  });
});
