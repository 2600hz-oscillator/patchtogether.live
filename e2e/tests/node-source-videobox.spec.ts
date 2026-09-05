// e2e/tests/node-source-videobox.spec.ts
//
// ⚠ THE FILENAME IS LOAD-BEARING — DO NOT RENAME THIS BACK TO `videobox-node-lifetime.spec.ts`.
// `e2e/webgl-heavy-globs.ts` classifies by PREFIX (`**/videobox-*.spec.ts`,
// `**/videovarispeed-*.spec.ts`), so a spec named after either module is swept
// into the WebGL-HEAVY lane whatever it actually does. That lane is EXCLUDED
// from the sharded e2e matrix (`E2E_WEBGL_HEAVY=exclude`) and the attest job
// SKIPS it whenever the attest hash is unchanged — its log says so outright:
// "Heavy WebGL lane skipped (trusting the local run)". Under the old name this
// spec therefore ran NOWHERE in PR CI, green run after green run, while being
// the acceptance test for the whole conversion.
//
// Nothing here is WebGL-heavy: it reads graph edges, element counts and a slot
// index, and samples no pixels. `collapse-keeps-playing.spec.ts` does the same
// real-video-decode work under a non-matching name and rides the sharded lane,
// which is the precedent this follows. The glob list is deliberately NOT edited
// — the classification is fine, the prefix collision was the accident.
//
// LEG-02 P1 (#1511) — VIDEOBOX's source belongs to the NODE, not to any mounted
// surface. This is the acceptance test for that claim.
//
// ── WHY THE OBVIOUS SPEC WOULD HAVE BEEN WORTHLESS WHEN THIS WAS WRITTEN ────
//
// "Load a video and assert it plays" passed on the pre-conversion tree too,
// because the source survived in an off-screen host that kept a second copy of
// the module and all its loops running. The picture was identical; the
// ownership was not. So the liveness assertions here were each PAIRED with an
// absence leg naming that host, so that "it works" and "something else is
// rescuing it" could be told apart.
//
// ⚠ THAT PAIRING IS GONE, AND THE DELETION NOTE WHERE THE HELPER STOOD SAYS
// WHY. Short version: both testids it named are emitted by nothing in the tree,
// so the absence legs could not fail; the alternative owner they ruled out is
// now ruled out by construction. See `expectNoCardAndNoHost`'s tombstone below
// before adding anything of that shape back.
//
// ── WHAT MOVED HERE FROM WHERE ──────────────────────────────────────────────
//
// ⚠ `collapse-keeps-playing.spec.ts` DERIVES its subjects from
// `DOM_SOURCE_LANE_TYPES`, so videobox leaving that set silently removed it from
// that sweep. That is a real coverage transfer, not a side effect to shrug at,
// and this file is where it lands: the collapse scenario is reproduced below,
// with the media asserted to survive the pane being dismissed.
//
// ── THE PLAYBACK INSTRUMENT ─────────────────────────────────────────────────
//
// Progress is accumulated IN THE PAGE (CLAUDE.md defence #5: a Playwright-side
// poll samples the very main thread it is measuring, and on a loaded runner
// "frozen" and "never looked" are indistinguishable). Two properties, both
// inherited from `collapse-keeps-playing`'s measured instrument:
//
//   WRAP-SAFE   a negative delta credits ZERO, so a loop/rewind can only cost
//               progress, never fake it. `videobox`'s `currentTime` is a WALL
//               CLOCK driven by the drift correction, not a free-running media
//               clock, so a bare `after > before` is not a comparison at all.
//   SEEK-PROOF  a positive delta is credited only up to `dt × 1.0` — what real
//               playback could have produced — so a drift SEEK cannot be
//               mistaken for playing.
//
// Frames, not milliseconds, wherever paint is the subject; the wall-clock caps
// here BOUND a failure and are never the gate.

import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';

/** The LONG fixture (#1577): 120 s of low-bitrate synthetic video, so the clip's
 *  end is unreachable inside this spec's bounds and no loop/rewind perturbation
 *  is in play. Same file `collapse-keeps-playing` uses, for the same reason. */
const FIXTURE = fileURLToPath(new URL('../fixtures/lobby-clip-long.webm', import.meta.url));

/** How long the post-dismissal observation window runs. A CAP on the failure,
 *  not the gate: the gate is accumulated forward progress. */
const OBSERVE_MS = 3_000;
/** Forward seconds of real playback that must accumulate in that window. Well
 *  under `OBSERVE_MS` so a slow SwiftShader runner has headroom; the point is
 *  "moving at all", not a rate. */
const MIN_PROGRESS_S = 0.4;

const NODE = 'vb-lifetime';

/** ⚠ A CAP THAT BOUNDS A FAILURE, NOT A GATE — and raised above the fleet's
 *  usual 30 s for a measured reason rather than to make a red run green.
 *
 *  MEASURED on this spec's first outing against a COLD `task e2e:serve`: test 1
 *  failed here at 30 s while tests 2 and 3, in the SAME run and through the SAME
 *  `boot()`, passed in 5.5 s and 4.5 s. That shape is definitional — the first
 *  `goto` pays Vite's on-demand transform of the whole module graph and every
 *  later one is warm — so it is a start-up cost of whichever spec happens to run
 *  first, not a property of this one. Warm, this wait resolves in ~2 s.
 *
 *  Raising it does not weaken anything: nothing here is gated on elapsed time.
 *  The gates are accumulated playback progress, an engine read, and two element
 *  counts, all of which run to completion either way. */
const BOOT_CAP_MS = 90_000;

async function boot(page: Page): Promise<void> {
  // Plain `/rack` — the default surface, which is the state a saved rack is in
  // rather than an edge case.
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_CAP_MS });
}

/*
 * ⚠ `expectNoCardAndNoHost` STOOD HERE AND IS DELETED. READ THIS BEFORE
 * REPLACING IT WITH SOMETHING THAT LOOKS LIKE IT.
 *
 * It was this file's "PERMANENT DISCRIMINATOR": every liveness assertion was
 * paired with `toHaveCount(0)` on `videobox-card` and on an off-screen
 * `headless-source-host`, so a green liveness result could not be explained by
 * some OTHER mount keeping the <video> alive.
 *
 * Both of those testids are now emitted by NOTHING in the tree. A matcher
 * whose selector cannot match is satisfied by a page that rendered nothing at
 * all, so the discriminator had stopped discriminating — it was reporting
 * "no other owner" for the same reason it would report it on a blank page.
 *
 * ⚠ NAMED COVERAGE LOSS, carried into the PR body. The alternative explanation
 * it ruled out (a surface, not the node, owning the source) is now ruled out by
 * CONSTRUCTION: `$lib/ui/media/node-video-source-registry` is the only owner
 * and no component competes with it. Re-arming this as a RUNTIME claim would
 * need a new discriminator against the faceplate dock body — a new gate, which
 * is an owner decision rather than this branch's.
 */

/** Does the ENGINE hold this node's element? The one observable that separates
 *  "a decoded file exists in the DOM" from "the module has a live source". */
async function engineHasElement(page: Page, nodeId: string): Promise<boolean> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { getDomain: (d: string) => { read: (i: string, k: string) => unknown } };
    };
    try { return w.__engine!().getDomain('video').read(id, 'hasVideoElement') === true; } catch { return false; }
  }, nodeId);
}

/** Where the node-owned <video> currently lives, and whether it holds bytes. */
async function mediaPlacement(page: Page) {
  return await page.evaluate(() =>
    [...document.querySelectorAll('video[data-testid="videobox-video"]')].map((v) => {
      const el = v as HTMLVideoElement;
      return {
        hasSrc: !!(el.currentSrc || el.getAttribute('src')),
        where: el.closest('[data-testid="dock-full-view"]')
          ? 'dock'
          : el.closest('[data-testid="headless-source-host"]')
            ? 'headless'
            : el.closest('[data-testid="node-media-parking"]')
              ? 'parking'
              : 'lane',
      };
    }),
  );
}

/** Accumulate wrap-safe, seek-proof forward playback progress in the page. */
async function measureProgress(page: Page, ms: number) {
  return await page.evaluate(async (windowMs) => {
    const el = document.querySelector('video[data-testid="videobox-video"]') as HTMLVideoElement | null;
    if (!el) return { progressS: -1, samples: 0, elapsedMs: 0, sawPlaying: false, reason: 'no element' };
    let progress = 0;
    let samples = 0;
    let sawPlaying = false;
    let prevT = el.currentTime;
    let prevMs = performance.now();
    const startMs = prevMs;
    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        const nowMs = performance.now();
        const t = el.currentTime;
        const dtMs = nowMs - prevMs;
        const rate = el.paused ? 0 : (el.playbackRate || 1);
        const delta = t - prevT;
        // WRAP-SAFE: a backwards move credits nothing.
        // SEEK-PROOF: a forward move is credited only up to what playback could
        // have produced in dt at the current rate.
        if (delta > 0) progress += Math.min(delta, (dtMs / 1000) * rate);
        if (!el.paused) sawPlaying = true;
        samples++;
        prevT = t; prevMs = nowMs;
        if (nowMs - startMs >= windowMs) { clearInterval(iv); resolve(); }
      }, 100);
    });
    return {
      progressS: progress,
      samples,
      elapsedMs: performance.now() - startMs,
      sawPlaying,
      reason: '',
    };
  }, ms);
}

test.describe('videobox: the source belongs to the NODE (#1511)', () => {
  test('the engine holds the element with no surface ever mounted', async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await boot(page);
    // Spawn and then touch NOTHING. The dock is never opened, so no videobox
    // surface is ever constructed at any point in this test.
    await spawnPatch(page, [{ id: NODE, type: 'videobox', domain: 'video' }], [], {
      mountTimeout: 30_000,
    });

    // ⚠ THIS IS THE HEADLINE: the engine holds the element although nothing
    // has ever rendered this module. Before the conversion the same result was
    // produced by an off-screen host keeping a second copy alive; there is no
    // such host now, so the node is the only thing that could have done it.
    await expect
      .poll(() => engineHasElement(page, NODE), {
        timeout: 20_000,
        message:
          'the engine never received this node\'s <video>. The controller ensures and attaches it at ' +
          'NODE creation, so this failing means the graph sync never ran or the attach retry never converged',
      })
      .toBe(true);

    // The element is PARKED — created off-screen by the registry and adopted by
    // nobody, which is exactly the state "no surface is displaying it" should
    // produce.
    const placement = await mediaPlacement(page);
    expect(placement.length, 'the node-owned <video> does not exist at all').toBe(1);
    expect(placement[0]!.where, 'the element is not parked — some surface adopted it').toBe('parking');

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('playback survives the surface being dismissed, with nothing to rescue it', async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await boot(page);
    await spawnPatch(page, [{ id: NODE, type: 'videobox', domain: 'video' }], [], {
      mountTimeout: 30_000,
    });

    // ── The GESTURE half, which genuinely needs a surface ────────────────────
    //
    // Opening the dock is not a workaround: a file picker is only honoured
    // inside a real user gesture, and an off-screen `pointer-events: none` host
    // was never clickable either. So loading a file has ALWAYS required an
    // expanded surface — today the ModuleShell face body. What this test is
    // about is what happens after it closes.
    await page.evaluate((id) => {
      (globalThis as unknown as { __openDockFullView: (i: string) => void }).__openDockFullView(id);
    }, NODE);
    const pane = page.locator('[data-testid="dock-full-view"]');
    await expect(pane).toHaveCount(1, { timeout: 20_000 });

    await pane.locator('[data-testid="videobox-file-input"]').setInputFiles(FIXTURE);
    const playBtn = pane.locator('[data-testid$="-play-btn"]').first();
    await expect(playBtn).toBeVisible({ timeout: 20_000 });
    await playBtn.click();

    // Confirm REAL playback before touching anything — in-page, never a
    // Playwright poll of the thread under measurement.
    //
    // ⚠ THE NODE-OWNED ELEMENT, NOT A DOCK-SCOPED QUERY (wave 3 repair).
    // videobox is FACED now: the dock pane mounts a ModuleShell body that
    // BLITS the engine output and never adopts the <video>, so the element
    // stays PARKED even while the pane is open and a
    // `[data-testid="dock-full-view"] video` query would wait forever on a
    // file that is genuinely playing. `mediaPlacement` below is what pins
    // WHERE it lives; this wait only cares that it PLAYS.
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video[data-testid="videobox-video"]') as HTMLVideoElement | null;
        return !!v && !v.paused && v.currentTime > 0.05;
      },
      undefined,
      { timeout: 30_000 },
    );

    // ── DISMISS. The ModuleShell face body unmounts, and nothing re-mounts
    //    the module anywhere. ──────────────────────────────────
    await page.getByTestId('faceplate-collapse').click();
    await expect(pane).toHaveCount(0, { timeout: 20_000 });

    expect(
      await engineHasElement(page, NODE),
      'the engine lost the element when the pane closed',
    ).toBe(true);

    const placement = await mediaPlacement(page);
    expect(placement.length, 'the node-owned <video> vanished with the surface').toBe(1);
    expect(placement[0]!.hasSrc, 'the loaded file was released when the surface unmounted').toBe(true);
    expect(placement[0]!.where, 'the element should be parked once no surface displays it').toBe('parking');

    // ...and it is still PLAYING, measured as forward progress.
    const rec = await measureProgress(page, OBSERVE_MS);
    expect(
      rec.progressS,
      `forward playback progress with no surface mounted: ${rec.progressS.toFixed(3)} s over ` +
        `${rec.samples} samples / ${rec.elapsedMs.toFixed(0)} ms (sawPlaying=${rec.sawPlaying}). ` +
        'Units: SECONDS of media time, wrap-safe and seek-proof. A zero here means the drift loop ' +
        'died with the surface — which is the #1511 defect, not a flake.',
    ).toBeGreaterThan(MIN_PROGRESS_S);

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('deleting the node tears the source down — the only teardown there is', async ({ page }) => {
    test.setTimeout(120_000);
    await boot(page);
    await spawnPatch(page, [{ id: NODE, type: 'videobox', domain: 'video' }], [], {
      mountTimeout: 30_000,
    });
    await expect.poll(() => engineHasElement(page, NODE), { timeout: 20_000 }).toBe(true);

    // ⚠ THE OTHER HALF OF "no surface teardown". A lifecycle that never tears down
    // is not node ownership, it is a leak — and it would pass every assertion
    // above. The graph is the authority, so removing the node must free it.
    await spawnPatch(page, [], [], { mountTimeout: 30_000 });
    await expect
      .poll(() => mediaPlacement(page).then((m) => m.length), {
        timeout: 20_000,
        message: 'the node left the graph and its <video> is still in the document — the sweep did not run',
      })
      .toBe(0);
  });
});
