// e2e/tests/skifree-face.spec.ts
//
// SKIFREE'S FACE — the DEFAULT shell, and the two shipping defects it repairs.
//
// ── ⚠ WHY THIS FILE EXISTS AND WHY IT BOOTS `/rack` ────────────────────────
//
// Every other skifree spec drives `?shell=legacy` (`skifree.spec.ts`) or asserts
// engine state with nothing painted (`skifree-node-lifetime.spec.ts`). Neither
// can see the surface a player actually meets, and `laneRenderKind` reads
// `'legacy'` BEFORE it reads `migrated`, so a green legacy suite says nothing
// about a promoted face. This file is the default-shell half.
//
// ── THE TWO DEFECTS, AND WHAT EACH LEG PROVES ──────────────────────────────
//
//   1. STEERING WAS BROKEN. `controller.enableMouse(el)` attaches its listeners
//      to `el` but computes `canvas.getBoundingClientRect()` against the
//      FACTORY's canvas — DETACHED since #2192, so every field is 0 — and then
//      does `e.clientX - rect.left`. The cursor received RAW VIEWPORT PIXELS in
//      a 0..320 space. ⚠ AND A DISTANCE-CLIMB ASSERTION ALONE WOULD NOT CATCH
//      IT: `setCursor` calls `startMovingIfPossible()` whatever coordinates it
//      is given, so the skier would move under the broken map too — it would
//      simply be pinned to an edge. So this file WRAPS `setCursor` in the page
//      and asserts the ARGUMENTS: a pointer at the picture's centre must write
//      the canvas centre, which is a claim about the MAP and not merely about
//      motion. The distance climb is asserted as well, because a correct map
//      that nothing calls is equally useless.
//   2. THE BLIT CROPPED ON DPR >= 2. That one is NOT provable here and this
//      file says so rather than pretending: Playwright runs at
//      `deviceScaleFactor: 1`, where the source and destination sizes coincide.
//      It is held at the source, in `skifree-face-model.test.ts`.
//
// ── THE THIRD SUBJECT: THE LANE TILE ───────────────────────────────────────
//
// skifree declares `params: []`, so #1974's zero-lane clause `continue`s past
// this face before it measures anything (correctly — that exclusion is what
// lets `flipper` and `videoOut` through), and the face carries a
// `FACES_WITHOUT_SCENES` entry so there is no baseline either. This file and
// `skifree-face-model.test.ts` are the whole of the lane tile's coverage.
//
// NO WALL-CLOCK WAITS: every wait is an auto-retrying `expect`/`expect.poll` on
// the real subject, and the in-page accumulators report their own sample counts
// so a frozen subject and a probe that never looked cannot print the same
// result.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
// ⚠ IMPORTED, NOT RE-DERIVED. This file used to carry its own
// `process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI` and its own
// `30_000 : 15_000` for the topbar — a second, drifting copy of the one bound
// #2286 gave exactly one home. The boot wait is a BOUND, not an assertion, so
// it belongs to the shared budget; the in-test polls below are game-state
// waits and keep their own numbers deliberately.
import { SLOW_RENDER, BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// ⚠ THE PER-TEST BUDGET IS A BOUND, AND IT WAS THE INVISIBLE 30 s DEFAULT.
//
// This file bounds its boot wait with `BOOT_MS` — 30 000 on CI, IDENTICAL to
// the 30 000 default budget it was running inside. 1 site, 1.00x.
//
// An inner bound at or above the budget that CONTAINS it can never come true:
// the outer clock kills the test first, so a legible `element not found` is
// converted into an illegible `Test timeout of 30000ms exceeded` — the class
// #2291 root-caused and #2293 repaired at its second call site. Nothing in this
// file said "30000"; `e2e/playwright.config.ts` never overrides Playwright's
// default, so there was nothing to grep for except the ABSENCE of a budget.
//
// The budget therefore comes from `boot-budget` (90 000 on CI/SwiftShader,
// 30 000 local) instead of the invisible default. A bound only costs wall-clock
// when it is EXCEEDED, so this adds exactly zero to a green run; lane cost stays
// gauged by `--global-timeout`, not by this.
//
// ⚠ BOUNDS ONLY. No assertion, subject or wait target changed here.
test.describe.configure({ mode: 'parallel', timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

const NODE = 'ski';
/** The def's own `SKIFREE_CANVAS_SIZE`. Restated here because an e2e cannot
 *  import from `packages/web`; the unit test is what pins them equal. */
const CANVAS_SIZE = 320;

/** The shipping shell. NOT `?shell=legacy` — see the header. */
async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Resume the AudioContext so the scheduler clock ticks — the factory's CV taps
 *  and the snapshot builder are its subscribers. A local four-line copy rather
 *  than an import: coupling two suites' lifetimes buys nothing. */
async function resumeAudio(page: Page): Promise<void> {
  await page.locator('button:has-text("Tap to start")').first()
    .click({ timeout: 2000 })
    .catch(() => { /* already running */ });
}

interface Snap {
  tick: number;
  distance: number;
  crashes: number;
  gameCreated: boolean;
  gameStarted: boolean;
  cvDriven: boolean;
  bundleError: string | null;
}

async function readSnapshot(page: Page, nodeId: string): Promise<Snap | null> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, unknown> };
      __engine: () => { read: (n: unknown, k: string) => unknown } | null;
    };
    const node = w.__patch.nodes[id];
    const eng = w.__engine();
    if (!node || !eng) return null;
    return (eng.read(node, 'snapshot') as Snap | undefined) ?? null;
  }, nodeId);
}

/**
 * Force one crash on the node's game and return the resulting crash count.
 *
 * Returns 0 when there is no game or no player yet, which is what makes it
 * usable as BOTH the readiness probe and a liveness assertion — a dead or
 * half-built game cannot fake a rising counter. (`SkiFree.create()` returns a
 * controller SYNCHRONOUSLY but only builds the player once two sprite-sheet
 * PNGs decode, so "a controller exists" is not "a game exists".)
 */
async function forceCrash(page: Page, nodeId: string): Promise<number> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, unknown> };
      __engine: () => { read: (n: unknown, k: string) => unknown } | null;
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

/**
 * Wait until the NODE has built its controller — the NON-DESTRUCTIVE readiness.
 *
 * ⚠ IT IS NOT "the game is playable", and the distinction matters enough that
 * both helpers exist. `SkiFree.create()` returns synchronously, before two
 * sprite-sheet PNGs decode into a `player`. `waitForGame` below closes that gap
 * by firing a crash until one registers — which is the right probe when the
 * subject is the GATE, and exactly the wrong one when the subject is the skier
 * MOVING, because a crashed skier cannot start (`startMovingIfPossible` is a
 * no-op while `hasBeenHit`).
 */
async function waitForController(page: Page, nodeId: string): Promise<void> {
  await expect
    .poll(() => page.evaluate((id) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown> };
        __engine: () => { read: (n: unknown, k: string) => unknown } | null;
      };
      const node = w.__patch.nodes[id];
      const eng = w.__engine();
      return !!(node && eng && eng.read(node, 'controller'));
    }, nodeId), {
      timeout: SLOW_RENDER ? 30_000 : 15_000,
      message: 'the node never built a controller — the bundle failed to load, or the factory '
        + 'never ran (check snapshot.bundleError)',
    })
    .toBe(true);
}

async function waitForGame(page: Page, nodeId: string): Promise<void> {
  try {
    await expect
      .poll(() => forceCrash(page, nodeId), { timeout: SLOW_RENDER ? 30_000 : 15_000 })
      .toBeGreaterThan(0);
  } catch (e) {
    // ⚠ A WAIT THAT TIMES OUT MUST SAY WHAT IT SAW: "no crash registered" is
    // consistent with no node, no game, a failed bundle load, or sprites that
    // never decoded, and they need four different fixes.
    const s = await readSnapshot(page, nodeId);
    throw new Error(
      `the node never built a playable game. Final snapshot: ${JSON.stringify(s)}\n`
        + '  created=false + no error -> the node never built its game\n'
        + '  created=false + error    -> the bundle failed to load (see bundleError)\n'
        + '  created=true             -> built, but the player never appeared\n'
        + `  (original: ${(e as Error).message})`,
    );
  }
}

/**
 * WRAP the node controller's `setCursor` so the page records every write.
 *
 * ⚠ THIS IS THE INSTRUMENT THE DEFECT NEEDS, AND A DISTANCE ASSERTION IS NOT.
 * The broken path still MOVED the skier — `setCursor` unconditionally calls
 * `player.startMovingIfPossible()` — it simply moved it toward a cursor in the
 * wrong units. The only observable that separates "steering works" from
 * "steering fires" is what reaches `setCursor`, and the controller does not
 * publish it, so the test reads it at the seam.
 *
 * It FORWARDS to the original, so the game still steers and the distance
 * assertion below is measuring the real thing rather than a stub.
 */
async function recordCursorWrites(page: Page, nodeId: string): Promise<void> {
  await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, unknown> };
      __engine: () => { read: (n: unknown, k: string) => unknown } | null;
      __skifreeCursorLog?: { x: number; y: number }[];
    };
    const node = w.__patch.nodes[id];
    const eng = w.__engine();
    const ctl = eng?.read(node, 'controller') as
      | { setCursor(x: number, y: number): void }
      | null
      | undefined;
    if (!ctl) throw new Error('no controller to instrument — call waitForGame first');
    const log: { x: number; y: number }[] = [];
    w.__skifreeCursorLog = log;
    const original = ctl.setCursor.bind(ctl);
    ctl.setCursor = (x: number, y: number) => {
      log.push({ x, y });
      original(x, y);
    };
  }, nodeId);
}

async function cursorWrites(page: Page): Promise<{ x: number; y: number }[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __skifreeCursorLog?: { x: number; y: number }[] };
    return w.__skifreeCursorLog ?? [];
  });
}

/** A `pageerror` collector. ⚠ EVERY FACE SPEC OWES ONE: a shared derivation
 *  repaired on `ModuleShellPlaceholder` can still throw inside `ModuleShell`,
 *  and only PROMOTING reveals it — a face that throws mid-render leaves a
 *  plausible-looking empty tile. */
function watchPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}

function realErrors(errors: string[]): string[] {
  return errors.filter((e) => !e.includes('AudioContext'));
}

test.describe('SKIFREE — the promoted FACE, on the default shell', () => {
  test('the LANE TILE paints the module\'s own slope with NOTHING expanded', async ({ page }) => {
    // ⚠ THE STATE NOTHING ELSE WATCHES. #1974's zero-lane clause skips an
    // `order: []` face before it measures anything, and this face carries a
    // FACES_WITHOUT_SCENES entry, so no shared gate and no baseline can tell a
    // tile with a slope on it from a title bar and a jack rail.
    const errors = watchPageErrors(page);
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'skifree', position: { x: 200, y: 200 } }]);
    await resumeAudio(page);

    const tile = page.locator(
      `.svelte-flow__node[data-id="${NODE}"] [data-testid="module-shell"]`,
    );
    await expect(tile, 'a promoted module paints the curated shell, not the placeholder')
      .toBeVisible();
    await expect(
      page.locator(`.svelte-flow__node[data-id="${NODE}"] [data-testid="module-shell-placeholder"]`),
      'the placeholder must be gone — promotion is what swaps them',
    ).toHaveCount(0);

    const canvas = tile.getByTestId('skifree-tile-canvas');
    await expect(canvas, 'the tileBody is the ONLY thing on this tile').toBeVisible();

    // The picture has real geometry rather than a collapsed 0x0 box — the shape
    // a body that mounted but never sized would take.
    const box = await canvas.boundingBox();
    expect(box, 'the tile canvas must have a layout box').not.toBeNull();
    expect(box!.width, `tile canvas width (${JSON.stringify(box)})`).toBeGreaterThan(40);
    expect(box!.height, `tile canvas height (${JSON.stringify(box)})`).toBeGreaterThan(40);

    // ⚠ AND IT IS THE SMALL ONE. The lane tile and an open dock pane can be
    // mounted at once, so the two bodies namespace their testids; asserting the
    // tile is NOT dock-sized is what proves this locator resolved the tile.
    expect(
      box!.width,
      'the lane tile must be the compact picture, not the 320 px dock slope — if this is 320 '
        + 'the locator found the wrong body',
    ).toBeLessThan(CANVAS_SIZE);

    // The tile is READ-ONLY: no steering frame and no SCREEN switch down here.
    await expect(tile.getByTestId('skifree-tile-screen-toggle')).toHaveCount(0);
    await expect(tile.locator('[data-testid="skifree-tile-slope"][role="application"]'))
      .toHaveCount(0);

    // …and the module is genuinely alive behind it, so a painted tile is not a
    // still frame over a dead node.
    await waitForGame(page, NODE);
    const s = await readSnapshot(page, NODE);
    expect(s?.gameCreated, JSON.stringify(s)).toBe(true);
    expect(s?.bundleError, 'the bundle loaded cleanly').toBeNull();

    expect(realErrors(errors), 'a face that throws mid-render leaves a plausible empty tile')
      .toEqual([]);
  });

  test('STEERING THROUGH THE FACE writes CANVAS coordinates, and the skier moves', async ({ page }) => {
    const errors = watchPageErrors(page);
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'skifree', position: { x: 200, y: 200 } }]);
    await resumeAudio(page);
    // ⚠ NO `waitForGame` HERE, AND THE OMISSION IS THE POINT. That helper's only
    // readiness signal is `_forceCrash` REGISTERING, which leaves the skier
    // `hasBeenHit` — and `startMovingIfPossible()` is a no-op while it is
    // (skier.js: recovery is a `SKIER_CRASH_RECOVERY_MS` timeout). The first
    // draft of this test used it and then asserted the skier moves, which is a
    // test that crashes its own subject and then asks why it is not skiing. It
    // failed exactly that way on the first run.
    //
    // The non-destructive readiness is the CONTROLLER existing, which is all the
    // instrument below needs; the GAME's own boot latency (two sprite-sheet PNG
    // decodes) is absorbed by holding the pointer until the run starts, which is
    // also what a player does.
    await waitForController(page, NODE);

    // Open the dock — the steerable slope is the `fullViewBody`, and the lane
    // tile is deliberately read-only.
    const tile = page.locator(
      `.svelte-flow__node[data-id="${NODE}"] [data-testid="module-shell"]`,
    );
    await tile.getByTestId('shell-open-dock').click();
    await expect(page.getByTestId('dock-full-view')).toBeVisible();

    const slope = page.getByTestId('skifree-face-canvas');
    await expect(slope, 'the dock body must paint the steerable slope').toBeVisible();
    const box = await slope.boundingBox();
    expect(box, 'the dock slope must have a layout box').not.toBeNull();

    // ── THE BASELINE: nothing has steered yet ──────────────────────────────
    // ⚠ ASSERTED BEFORE THE ACT, so "the skier moved" cannot be satisfied by a
    // skier that was already moving. Nothing is patched into x/y, so `cvDriven`
    // is false and the ONLY thing that can start this run is a cursor write.
    const before = await readSnapshot(page, NODE);
    expect(before?.cvDriven, 'nothing is patched, so CV must not be driving').toBe(false);
    expect(
      before?.gameStarted,
      `the skier must be idle before the gesture (${JSON.stringify(before)})`,
    ).toBe(false);

    await recordCursorWrites(page, NODE);

    // ── THE ACT: click the slope to arm, then steer BELOW the skier ─────────
    // ⚠ THE DIRECTION IS NOT ARBITRARY. Distance only advances while the cursor
    // sits BELOW the skier (the def: "pulling the cursor lower makes the skier
    // point more steeply downhill"), which is why the sibling lifetime spec
    // records that driving x/y from an LFO made this a coin flip. A fixed point
    // in the lower half is deterministic by construction.
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.up();

    // ── ASSERTION 1: THE MAP. The centre of the picture is the centre of the
    // canvas — 160, not 700-and-something. This is the defect: the vendored
    // handler subtracted a DETACHED canvas's all-zero rect, so it wrote raw
    // viewport pixels into a 0..320 space.
    await expect
      .poll(async () => (await cursorWrites(page)).length, {
        timeout: SLOW_RENDER ? 15_000 : 8_000,
        message: 'the click on the slope must reach controller.setCursor — zero writes means the '
          + 'body is not bound to the pointer at all',
      })
      .toBeGreaterThan(0);
    const firstWrite = (await cursorWrites(page))[0]!;
    expect(
      firstWrite.x,
      `a pointer at the picture's CENTRE must write the canvas centre. Got ${JSON.stringify(firstWrite)} `
        + `for a click at viewport (${Math.round(cx)}, ${Math.round(cy)}) on a box of `
        + `${JSON.stringify(box)}. A value near the viewport x is the pre-fix behaviour: the `
        + 'bundle\'s enableMouse handlers take their rect from the FACTORY\'s DETACHED canvas.',
    ).toBeCloseTo(CANVAS_SIZE / 2, 0);
    expect(firstWrite.y).toBeCloseTo(CANVAS_SIZE / 2, 0);

    // …and EVERY write is inside the canvas, which is the property the whole
    // 0..320 space depends on.
    for (const w of await cursorWrites(page)) {
      expect(w.x, `cursor x out of the canvas: ${JSON.stringify(w)}`).toBeGreaterThanOrEqual(0);
      expect(w.x, `cursor x out of the canvas: ${JSON.stringify(w)}`).toBeLessThanOrEqual(CANVAS_SIZE);
      expect(w.y, `cursor y out of the canvas: ${JSON.stringify(w)}`).toBeGreaterThanOrEqual(0);
      expect(w.y, `cursor y out of the canvas: ${JSON.stringify(w)}`).toBeLessThanOrEqual(CANVAS_SIZE);
    }

    // ── ASSERTION 2: THE MOTION. A correct map that nothing calls is equally
    // useless, so the run has to become real.
    //
    // ⚠ THE POINTER IS HELD, NOT FLICKED, and the direction is not arbitrary.
    // Distance advances while the cursor sits BELOW the skier (the def:
    // "pulling the cursor lower makes the skier point more steeply downhill"),
    // which is why the sibling lifetime spec records that steering from an LFO
    // made an identical assertion a 2-in-5 coin flip. Holding a fixed point in
    // the lower slope is deterministic in DIRECTION; what is not deterministic
    // is WHEN the bundle finishes decoding its two sprite sheets, and a hold
    // absorbs that without a wall-clock wait — `setCursor` is a no-op until the
    // game exists (`if (!game || disposed) return`), so the hold IS the wait.
    let holds = 0;
    try {
      await expect
        .poll(async () => {
          holds++;
          // ⚠ THE BOX IS RE-MEASURED EVERY HOLD, not captured once. The dock
          // pane lays out around a live body, so a stale rect points the
          // pointer at whatever moved into that place — which is how the first
          // draft got ONE cursor write from fifty-one gestures while every
          // other assertion stayed green.
          const b = await slope.boundingBox();
          if (!b) return 0;
          const x = b.width / 2 + (holds % 2 === 0 ? 1 : -1);
          const y = b.height * 0.75;
          // ⚠ ELEMENT-RELATIVE, THROUGH THE LOCATOR, not raw viewport pixels.
          // `boundingBox()` reports the element's own box whether or not the
          // dock pane is CLIPPING it, so a raw `page.mouse.move` at 85 % height
          // can land outside the pane and hit nothing — which is how the first
          // draft got ONE cursor write out of fifty-one gestures with every
          // other assertion green. The locator scrolls the point into view and
          // checks actionability before it dispatches.
          //
          // Re-arm AND move: the click is the documented gesture and the move
          // is the one that steers, so each hold exercises both paths rather
          // than assuming the armed state survived whatever the dock did.
          await slope.click({ position: { x, y }, force: true });
          await slope.hover({ position: { x: x + 2, y: y + 2 }, force: true });
          return (await readSnapshot(page, NODE))?.distance ?? 0;
        }, {
          timeout: SLOW_RENDER ? 30_000 : 15_000,
          intervals: [100, 100, 200, 200, 300],
        })
        .toBeGreaterThan(0);
    } catch (e) {
      const s = await readSnapshot(page, NODE);
      const writes = await cursorWrites(page);
      throw new Error(
        `the skier never moved while the pointer was held on the lower slope.\n`
          + `  holds=${holds} cursorWrites=${writes.length} last=${JSON.stringify(writes.at(-1))}\n`
          + `  snapshot=${JSON.stringify(s)}\n`
          + '  writes=0            -> the body is not bound to the pointer\n'
          + '  writes>0, tick flat -> the ENGINE is dead, not the game\n'
          + '  writes>0, tick rising, distance 0 -> the cursor is reaching the game in the '
          + 'WRONG UNITS, or the skier is stuck hasBeenHit\n'
          + `  (original: ${(e as Error).message})`,
      );
    }

    const after = await readSnapshot(page, NODE);
    expect(after?.gameStarted, JSON.stringify(after)).toBe(true);
    expect(realErrors(errors)).toEqual([]);
  });

  test('SCREEN OFF stops the picture and NOTHING else — the gate keeps firing', async ({ page }) => {
    // ⚠ THE CLAIM MOST LIKELY TO BE FALSE WITHOUT ANYONE NOTICING, because a
    // collapsed picture and a stopped game look identical on the plate.
    const errors = watchPageErrors(page);
    await gotoShell(page);
    await spawnPatch(page, [
      { id: NODE, type: 'skifree', position: { x: 120, y: 120 } },
      { id: 'sc', type: 'scope', position: { x: 520, y: 120 } },
    ], [
      {
        id: 'e1',
        from: { nodeId: NODE, portId: 'gate' },
        to: { nodeId: 'sc', portId: 'ch1' },
        sourceType: 'gate',
        targetType: 'audio',
      },
    ]);
    await resumeAudio(page);
    await waitForGame(page, NODE);

    const tile = page.locator(
      `.svelte-flow__node[data-id="${NODE}"] [data-testid="module-shell"]`,
    );
    await tile.getByTestId('shell-open-dock').click();
    await expect(page.getByTestId('dock-full-view')).toBeVisible();
    await expect(page.getByTestId('skifree-face-canvas')).toBeVisible();

    // ── THE ACT ────────────────────────────────────────────────────────────
    const toggle = page.getByTestId('skifree-face-screen-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(
      page.getByTestId('skifree-face-canvas'),
      'SCREEN OFF must actually remove the picture, or the switch is decorative',
    ).toHaveCount(0);
    // The lane tile follows the same node.data flag — one switch, two surfaces.
    await expect(tile.getByTestId('skifree-tile-canvas')).toHaveCount(0);

    // ── THE ASSERTION: the module is untouched ─────────────────────────────
    // ⚠ FIRE THE CRASH AND SAMPLE THE SCOPE IN ONE EVALUATE. The gate is a
    // 10 ms ConstantSourceNode pulse and the scope's analyser is fftSize 2048
    // (~43 ms at 48 kHz), so a Playwright round trip between firing and reading
    // reliably loses it — `skifree.spec.ts` records that measurement and this
    // is the same in-page shape for the same reason.
    const fireAndSample = () => page.evaluate(async ({ id, scId }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown> };
        __engine: () => { read: (n: unknown, k: string) => unknown } | null;
      };
      const eng = w.__engine();
      const node = w.__patch.nodes[id];
      const scNode = w.__patch.nodes[scId];
      const ctl = eng?.read(node, 'controller') as
        | { _forceCrash(): void; getState(): { crashes: number } }
        | null
        | undefined;
      const before = ctl?.getState().crashes ?? -1;
      ctl?._forceCrash();
      const after = ctl?.getState().crashes ?? -1;

      let peak = 0;
      let samples = 0;
      if (eng && scNode) {
        const t0 = performance.now();
        while (performance.now() - t0 < 250) {
          const snap = eng.read(scNode, 'snapshot') as { ch1?: Float32Array } | undefined;
          if (snap?.ch1) {
            samples++;
            for (let i = 0; i < snap.ch1.length; i++) {
              const a = Math.abs(snap.ch1[i]!);
              if (a > peak) peak = a;
            }
            if (peak > 0.5) break;
          }
          await new Promise((r) => setTimeout(r, 2));
        }
      }
      return { before, after, peak, samples };
    }, { id: NODE, scId: 'sc' });

    // Retry across a few crashes: every crash pulses an IDENTICAL gate, so the
    // COUNTER is the deterministic assertion and the SCOPE peak is the
    // signal-flow one, which a loaded runner can miss on a single 10 ms pulse.
    // (`skifree.spec.ts` uses the same 5-attempt shape for the same reason.)
    let observed = await fireAndSample();
    for (let i = 0; i < 4 && observed.peak <= 0.5; i++) {
      const next = await fireAndSample();
      observed = { ...next, peak: Math.max(observed.peak, next.peak) };
    }

    expect(
      observed.samples,
      `the scope probe took no samples at all (${JSON.stringify(observed)}) — a zero peak from a `
        + 'probe that never read is not evidence about the gate',
    ).toBeGreaterThan(0);
    expect(
      observed.after,
      `the game stopped counting crashes with the screen off (${JSON.stringify(observed)})`,
    ).toBeGreaterThan(observed.before);
    expect(
      observed.peak,
      `the GATE did not reach the downstream SCOPE with the screen off `
        + `(${JSON.stringify(observed)}). SCREEN is a picture switch, never a producer switch.`,
    ).toBeGreaterThan(0.5);

    // …and the node keeps ticking, so "the gate fired" is not the last gasp of
    // a module about to go quiet.
    const s1 = await readSnapshot(page, NODE);
    await expect
      .poll(async () => (await readSnapshot(page, NODE))?.tick ?? 0, {
        timeout: SLOW_RENDER ? 15_000 : 8_000,
        message: 'the scheduler tick stopped advancing with the screen off',
      })
      .toBeGreaterThan(s1?.tick ?? 0);

    // Turning it back on restores the picture — the switch is reversible, and
    // the state lives on node.data rather than in a component that unmounts.
    await toggle.click();
    await expect(page.getByTestId('skifree-face-canvas')).toBeVisible();
    await expect(tile.getByTestId('skifree-tile-canvas')).toBeVisible();

    expect(realErrors(errors)).toEqual([]);
  });
});
