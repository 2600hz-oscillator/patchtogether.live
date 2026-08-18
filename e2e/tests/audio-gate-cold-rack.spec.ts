// e2e/tests/audio-gate-cold-rack.spec.ts
//
// THE UN-GESTURED STATE OF THE DEFAULT ROUTE.
//
// ── ⚠ THE ABSENCE OF A GESTURE IS THE SUBJECT OF THIS FILE ─────────────────
//
// The first test below performs NO click, NO spawn, NO drag, NO key press and
// dispatches no input event of any kind before it asserts. That is not an
// oversight to be tidied up later — it is the entire point, and any future edit
// that adds an interaction above the assertions deletes the coverage while
// leaving the test green-looking.
//
// It is also why #1826 shipped. `AudioGate.svelte` renders "Click anywhere to
// enable audio" whenever the audio gate is not running, and it was mounted in
// exactly ONE route — `/r/[id]`. `/rack`, the default route and the one most
// people land on, had zero references to it. So the scratch rack booted no
// engine, painted every video surface black, made no sound, and said nothing
// about why. The owner hit it and reasonably read it as "video output is
// broken", which cost a scoped investigation to disprove.
//
// No test caught it because EVERY existing spec gestures first — the `rack`
// fixture navigates and then the body spawns a patch through `__ensureEngine`,
// or clicks, or drags — so the state a real user starts in was exercised by
// nothing at all. A suite can be large, green and completely blind to the first
// frame the product shows.
//
// ── THE MECHANISM (worth knowing before editing) ───────────────────────────
//
// `ensureEngine()` in Canvas.svelte constructs the AudioContext, awaits
// `resume()`, and only THEN reaches `new VideoEngine(...)`. Without a gesture
// there is no engine AT ALL — not a video engine that failed to construct, so
// this never reaches Canvas's WebGL2-unavailable catch branch. `window.__engine()`
// returning falsy on a cold load is the DEFECT; the overlay is the AFFORDANCE
// that explains it. This file asserts both, in both directions:
//
//   cold  → overlay present  AND  no engine
//   after → overlay gone     AND  engine + a running AudioContext
//
// One leg without the other pins half a contract: "overlay present" alone is
// satisfied by an overlay that is ALWAYS on, and "overlay gone after a click"
// alone is satisfied by an overlay that never appeared.
//
// ── WHY BARE `/rack` AND NOT THE `rack` FIXTURE ────────────────────────────
//
// The fixtures navigate to `/rack?shell=legacy&seed=none` — a renderer opt-out
// plus a test-only empty rack. Neither is what a user gets. This spec drives the
// URL the product actually ships as its default route, with no query string at
// all, because the claim under test is about that route and not about a
// convenient variant of it.
//
// ── WHAT THIS FILE STRUCTURALLY CANNOT SEE ─────────────────────────────────
//
//   * `/r/[id]`. It needs a rackspace + a session; the route-set gate
//     `packages/web/src/routes/canvas-routes-audio-gate.test.ts` is what makes
//     gate coverage a property of EVERY route that mounts the canvas rather
//     than of the one route this spec can reach without auth.
//   * Whether the overlay is LEGIBLE, or whether the engine it boots renders
//     anything. Those are the VRT lane's and the per-module lane's jobs.

import { expect, test } from './_fixtures';

/** The engine hook Canvas installs on mount under VITE_E2E_HOOKS. */
interface EngineHookWindow {
  __engine?: () => unknown;
}

/**
 * Read the engine through `window.__engine`, and report the HOOK'S OWN state
 * alongside the answer.
 *
 * ⚠ INSTRUMENT VALIDATION, not defensiveness. `!!w.__engine?.()` is falsy both
 * when there is no engine (the finding) and when the hook was tree-shaken out
 * of the bundle (a broken measurement) — the two are indistinguishable from the
 * boolean alone, and the blind one is the one that reads as a pass. Returning
 * `hookInstalled` separately lets the assertions below reject the second case
 * loudly instead of scoring it as a green cold-load.
 */
async function readEngine(page: import('@playwright/test').Page): Promise<{
  hookInstalled: boolean;
  engine: boolean;
}> {
  return page.evaluate(() => {
    const w = globalThis as unknown as EngineHookWindow;
    return {
      hookInstalled: typeof w.__engine === 'function',
      engine: typeof w.__engine === 'function' ? !!w.__engine() : false,
    };
  });
}

/**
 * Navigate to the bare default route and wait for the CANVAS TO HAVE MOUNTED —
 * without touching the page.
 *
 * ⚠ THIS PRECONDITION IS NOT CEREMONY; ITS ABSENCE WAS A REAL DEFECT IN THIS
 * FILE. Without it the first assertion was `expect(overlay).toBeVisible()` on a
 * default 5 s budget, and on a COLD dev server the first /rack load spends longer
 * than that compiling. MEASURED, deterministically reproducible by restarting the
 * server and running this spec immediately: leg 1 failed `Timeout: 5000ms ...
 * element(s) not found` while leg 2 — same file, now-warm server — passed.
 *
 * The failure is the dangerous kind, because "the overlay is missing" and "the
 * page has not booted yet" are the SAME OUTPUT and need OPPOSITE fixes, and the
 * message it printed was the #1826 one — it would have sent the next reader
 * hunting for a mounting bug in the gate. Waiting on the app's own readiness
 * signal first splits them into two distinguishable failures.
 *
 * `__ensureEngine` is the right signal precisely because it is the boot function
 * that has NOT been called yet: its presence proves Canvas mounted and installed
 * its hooks, while `__engine()` is still falsy — which is exactly the state under
 * test. And it is gesture-free: `waitForFunction` polls inside the page.
 */
async function gotoColdRack(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/rack');
  await page.waitForFunction(
    () => typeof (globalThis as unknown as { __ensureEngine?: unknown }).__ensureEngine === 'function',
    undefined,
    // A bound on the FAILURE, not the gate: it exists so a page that never boots
    // fails as "never booted" instead of masquerading as a missing overlay. Sized
    // for a cold vite compile on a loaded CI shard, where this spec may be first.
    { timeout: 60_000 },
  );
}

test.describe('audio gate on the DEFAULT route', () => {
  test('COLD /rack — the overlay is up and NO engine exists, with no gesture at all', async ({
    page,
    errorWatch,
  }) => {
    // ⚠ NOTHING BETWEEN THIS NAVIGATION AND THE ASSERTIONS MAY TOUCH THE PAGE.
    // A gesture here would boot the engine and make every assertion below
    // vacuously true — the exact shape of the blind spot that shipped #1826.
    // (`gotoColdRack` only WAITS — it dispatches no input; see its comment.)
    await gotoColdRack(page);

    // State readiness on the REAL subject, auto-retrying — not a wall-clock
    // wait. Canvas mounts client-side, so "the overlay is visible" is the thing
    // to poll, and `toBeVisible` already retries until the test's own timeout.
    await expect(
      page.getByTestId('audio-gate'),
      'a cold /rack must explain itself: no engine has booted, so the "click anywhere ' +
        'to enable audio" overlay is the only thing standing between the user and a ' +
        'silent, black canvas with no explanation (#1826)',
    ).toBeVisible();

    // The overlay says what it says — assert the text, not just the box, so a
    // testid left on a hollowed-out element cannot pass.
    await expect(page.getByTestId('audio-gate')).toContainText('Click anywhere to enable audio');

    // THE CONSEQUENCE the overlay is explaining. This is the defect itself:
    // ensureEngine() has never run, so there is no PatchEngine and no
    // VideoEngine — video paints black and audio is silent.
    const cold = await readEngine(page);
    expect(
      cold.hookInstalled,
      'window.__engine is missing, so this test measured NOTHING — the app was built ' +
        'without VITE_E2E_HOOKS=1 and a falsy engine here is an instrument failure, ' +
        'not a finding',
    ).toBe(true);
    expect(
      cold.engine,
      'a cold /rack is expected to have NO engine — if this is true, the boot path ' +
        'changed and the overlay assertion above may now be the stale half of the pair',
    ).toBe(false);

    errorWatch.assertClean();
  });

  test('after a real gesture the overlay goes away and an engine exists', async ({
    page,
    errorWatch,
  }) => {
    await gotoColdRack(page);

    const gate = page.getByTestId('audio-gate');
    await expect(gate).toBeVisible();

    // "Click anywhere" is LITERAL — assert it before relying on it. The overlay
    // spans the viewport at z-index 1000, so if it were pointer-interactive it
    // would be the hit target here and the whole app would sit behind a click
    // trap until dismissed (that is exactly what mounting the pre-#1826 modal
    // scrim on /rack did: 29 e2e tests died on intercepted clicks).
    const CLICK_AT = { x: 640, y: 500 } as const;
    const hit = await page.evaluate(
      (p) => {
        const el = document.elementFromPoint(p.x, p.y);
        return {
          isGate: !!el?.closest('[data-testid="audio-gate"]'),
          tag: el?.tagName ?? 'none',
          cls: el?.className?.toString?.().slice(0, 80) ?? '',
        };
      },
      CLICK_AT,
    );
    expect(
      hit.isGate,
      `the element under (${CLICK_AT.x}, ${CLICK_AT.y}) CSS px is the audio-gate overlay ` +
        `(got <${hit.tag} class="${hit.cls}">) — the overlay is swallowing the click it ` +
        'is asking for, so every control behind it is unreachable',
    ).toBe(false);

    // THE gesture — the only one in this file, and it is the complementary leg.
    // Without it "the overlay is present" is also satisfied by an overlay that
    // is unconditionally on, which would be a worse bug than the one being fixed.
    //
    // Deliberately a RAW pointer gesture aimed at the canvas, NOT a click on the
    // overlay: what has to work is "any interaction anywhere enables audio", and
    // clicking the notice itself would only prove the notice is clickable.
    await page.mouse.click(CLICK_AT.x, CLICK_AT.y);

    await expect(
      gate,
      'the overlay must clear once audio is running, or it becomes a permanent ' +
        'full-viewport click trap over the canvas',
    ).toHaveCount(0);

    // ... and the engine the overlay promised really did boot. `expect.poll`
    // (auto-retrying, on the real subject) rather than a timeout: ensureEngine
    // constructs the AudioContext, awaits resume(), and only then reaches the
    // VideoEngine, so how long that takes is a property of the machine.
    await expect
      .poll(async () => (await readEngine(page)).engine, {
        message:
          'clicking the gate calls the booter Canvas registered (ensureEngine) — a ' +
          'still-falsy __engine() here means the overlay dismissed itself without ' +
          'booting anything, which is the #1826 symptom with the sign flipped',
      })
      .toBe(true);

    // The AudioContext is the thing the autoplay policy was blocking, so read
    // its state directly rather than inferring it from the overlay being gone.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const w = globalThis as unknown as {
              __engine?: () => {
                getDomain?: (d: string) => { ctx?: AudioContext } | undefined;
              } | null;
            };
            return w.__engine?.()?.getDomain?.('audio')?.ctx?.state ?? 'no-ctx';
          }),
        { message: 'the audio domain AudioContext should be running after the gate click' },
      )
      .toBe('running');

    errorWatch.assertClean();
  });
});
