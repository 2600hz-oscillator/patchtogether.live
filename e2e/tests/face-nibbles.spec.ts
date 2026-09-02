// e2e/tests/face-nibbles.spec.ts
//
// THE NIBBLES FACE, driven for real on the DEFAULT shell — the seams no other
// gate can see.
//
// ⚠ THE FILENAME AND ITS LANE. `e2e/webgl-heavy-globs.ts` classifies by PREFIX,
// and a spec swept into the heavy lane runs NOWHERE in PR CI (that lane was
// deleted in #839). Checked against the live glob list rather than assumed:
// `face-*` matches no heavy glob, so this file lands in the sharded `e2e`
// matrix. ⚠ AND THE NAME MATTERS MORE THAN USUAL HERE, because this module's
// sibling spec `nibbles-render-smoke.spec.ts` DOES match one
// (`**/*-render-smoke.spec.ts`) and therefore runs only in the real-GPU attest
// lane — so a `nibbles-render-*` name for this file would have been green
// forever. Nothing here is WebGL-heavy: it reads DOM facts, graph state and the
// module's own CPU framebuffer, and samples no GPU pixels.
//
// `nibbles-face-model.test.ts` pins the ranking, the glyph judgement, the
// resting-text deletion, the zoom's clamping and every source-level claim.
// `face-rack-status-source.test.ts` proves the body declares what it paints,
// `video-face-screen-source.test.ts` that it OWNS a screen switch, and the
// shared `face-screen-render-*` suite drives that switch. None of them can see:
//
//  1. ⚠ THAT THE GAME CAN BE PLAYED AT ALL UNDER THE SHELL. Promotion stops
//     both default surfaces rendering `NibblesCard`, and the arrow keys — the
//     module's only manual steering — were card-only. This file presses a REAL
//     ArrowDown on the faceplate and watches the SNAKE TURN.
//  2. ⚠ THAT SCREEN OFF DOES NOT STOP THE GAME. nibbles ticks inside
//     `surface.draw`, so unlike frogger and modtris a collapse that stopped the
//     draw would stop the snake and silence three gates, the length CV and both
//     audio outs. The source gates can see that the body reads before it
//     paints; only this can see that the game is still moving.
//  3. ⚠ THAT THE AUTO CELL REACHES THE PARAM. The inert-control trap: a face
//     whose cell writes one place while the factory reads another renders,
//     operates and does nothing, with every def-reading gate green (mappy
//     shipped exactly that).
//  4. ⚠ THAT THE ZOOM SURVIVES A DOCK COLLAPSE. It was component `$state`, so
//     it did not — and "the control still exists" is what every registry test
//     would have said about the broken version.
//  5. ⚠ THAT RESET REACHES THE ENGINE. `faces-parity` structurally cannot make
//     this probe for a VIDEO module — it spawns every module with no `domain`,
//     which defaults to `'audio'`, so the factory is never constructed and the
//     ledger records `delivered: false` on a live button. Measured. That is why
//     RESET is a body button here and why its probe lives in this file.
//
// ⚠ THE SNAKE'S START IS A CONSTANT, NOT A SEED. `newGame` always places a
// 4-cell snake at the board CENTRE heading RIGHT; only the pellet is seeded. So
// the steering leg needs no pin to be deterministic in the axis it asserts —
// but `__nibblesVrtSeed` is installed anyway so the PELLET cannot land in the
// snake's path and grow it (or move it) mid-measurement.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

/** The same seed `vrt-composite-scenes.ts` and the face VRT scenes pin — one
 *  seed for every deterministic nibbles path in the tree. */
const NIBBLES_SEED = 0xC0DE;

/** The game's own board geometry, restated here ONLY as the cell size the head
 *  scan divides by. Everything else about the board is observed. */
const CELL_PX = 4;

async function boot(page: Page): Promise<void> {
  // ⚠ BEFORE `goto`. `maybeApplyVrtSeed` re-seeds on a later draw frame but
  // does NOT repaint, so a post-spawn install would leave the first
  // Date.now()-seeded frame on screen — the same ordering the VRT roster's
  // simPin entry records.
  await page.addInitScript((seed) => {
    (globalThis as unknown as { __nibblesVrtSeed?: number }).__nibblesVrtSeed = seed;
  }, NIBBLES_SEED);
  // Plain /rack — the DEFAULT shell. `?shell=legacy` is precisely the surface
  // promotion does not change, and every existing nibbles spec boots it.
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Open this node's dock faceplate (the auto-retrying tv-librarian pattern —
 *  the tile button is hit-testable while a previous pane is still tearing
 *  down, so one click can land on nothing). */
async function openDock(page: Page, nodeId: string) {
  const shell = page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible({ timeout: BOOT_MS });
  const dockShell = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${nodeId}"]`);
  await expect(async () => {
    if (await dockShell.count() === 0) {
      await shell.getByTestId('shell-open-dock').click();
    }
    await expect(dockShell).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  return dockShell;
}

interface HeadTrack {
  /** Distinct head CELLS in visit order — the snake's path. */
  cells: { x: number; y: number }[];
  /** rAF frames actually observed. A ZERO here is the vacuous run. */
  frames: number;
  /** Wall-clock the accumulator ran, for the assertion message only. */
  elapsedMs: number;
  alive: boolean;
  score: number;
}

/**
 * Follow the snake's HEAD across rAF frames, IN THE PAGE.
 *
 * ⚠ THE ACCUMULATOR IS PAGE-SIDE AND THAT IS A HOUSE RULE, not a preference.
 * A Playwright-side poll of a page quantity is a round trip per sample on the
 * same main thread as the subject, so a loaded runner starves both — and "the
 * game is frozen" and "the test never looked" print the same result. One
 * evaluate, one loop, and the sample count comes back so a zero-sample run is
 * an explicit failure rather than a silent pass.
 *
 * ⚠ IT READS THE MODULE'S OWN FRAMEBUFFER, not a canvas. `read(node,'snapshot')`
 * is the same `ImageData` the faceplate blits, and it keeps being repainted
 * while the SCREEN is OFF — which is exactly the property the collapse leg
 * needs to observe and a canvas read could not, because there is no canvas.
 *
 * The head is found by COLOUR: `paintFrame` uses `COLOR_SNAKE_HEAD` for cell 0
 * and nothing else, then darkens every other row to 85%, so the head is the
 * unique run of (192,255,128) or its (163,216,108) scanline twin.
 */
async function trackHead(
  page: Page,
  nodeId: string,
  wantCells: number,
  frameBudget: number,
): Promise<HeadTrack> {
  return page.evaluate(
    async ({ id, want, budget, cell }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      if (!eng || !node) throw new Error(`trackHead: no engine or no node '${id}'`);

      const headCell = (): { x: number; y: number } | null => {
        const snap = eng.read(node, 'snapshot') as ImageData | undefined;
        if (!snap) return null;
        const d = snap.data;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!;
          // The head colour, bright and scanline-darkened.
          if ((r === 192 && g === 255 && b === 128) || (r === 163 && g === 216 && b === 108)) {
            const px = (i / 4) % snap.width;
            const py = Math.floor(i / 4 / snap.width);
            return { x: Math.floor(px / cell), y: Math.floor(py / cell) };
          }
        }
        return null;
      };

      const cells: { x: number; y: number }[] = [];
      const t0 = performance.now();
      let frames = 0;
      while (frames < budget && cells.length < want) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        frames += 1;
        const h = headCell();
        if (!h) continue;
        const last = cells[cells.length - 1];
        if (!last || last.x !== h.x || last.y !== h.y) cells.push(h);
      }
      return {
        cells,
        frames,
        elapsedMs: Math.round(performance.now() - t0),
        alive: eng.read(node, 'alive') === true,
        score: (eng.read(node, 'score') as number | undefined) ?? -1,
      };
    },
    { id: nodeId, want: wantCells, budget: frameBudget, cell: CELL_PX },
  );
}

/** The axis a path segment travels on — 'x', 'y', or null when it did not
 *  move on exactly one axis. */
function axisOf(a: { x: number; y: number }, b: { x: number; y: number }): 'x' | 'y' | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx !== 0 && dy === 0) return 'x';
  if (dy !== 0 && dx === 0) return 'y';
  return null;
}

/** The persisted node state the ENGINE reads, in one page round-trip. */
async function nodeState(page: Page, nodeId: string) {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params?: Record<string, number>; data?: Record<string, unknown> }> };
    };
    const n = w.__patch.nodes[id];
    return {
      auto: n?.params?.auto,
      tickMs: n?.params?.tick_ms,
      previewScale: n?.data?.previewScale,
      previewCollapsed: n?.data?.previewCollapsed,
    };
  }, nodeId);
}

/** The audition ledger, as the shell publishes it for tests. The SAME hook
 *  `faces-parity` reads (`__auditionLog`), so this leg and that sweep are
 *  looking at one record rather than two. */
async function auditionLog(page: Page): Promise<
  { seq: number; nodeId: string; seam: string; delivered: boolean }[]
> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __auditionLog?: () => { seq: number; nodeId: string; seam: string; delivered: boolean }[];
    };
    return w.__auditionLog ? w.__auditionLog() : [];
  });
}

const CELL = (key: string) => `[data-cell-key="${key}"]`;

test.describe('NIBBLES face — the promotion is what makes it playable', () => {
  // ⚠ A PAGE ERROR FAILS EVERY TEST IN THIS FILE. A TypeError inside a
  // `$derived` does not surface as a thrown assertion — it takes the subtree's
  // render down and the symptom lands somewhere else entirely (a shared
  // derivation repaired on the placeholder can still throw in ModuleShell, and
  // only promoting reveals it).
  test.beforeEach(({ page }) => {
    page.on('pageerror', (err) => {
      throw new Error(`uncaught page error during a nibbles face test: ${err.message}`);
    });
  });

  test('the shell replaces the card, and a REAL ARROW KEY still steers the snake', async ({ page }) => {
    // Serialises the dock's lazy body chunk behind the boot — bounded from the
    // one export site, never a flat literal.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 3);
    await boot(page);
    // ⚠ `tick_ms` AT ITS MAXIMUM, and it is the thing that makes this leg safe
    // rather than lucky. The snake starts at the board centre (40,25) heading
    // RIGHT with 39 cells of room, and 24 below it; at 200 ms/tick that is ~7.8 s
    // to the right wall and ~4.8 s after the turn. The game advances on
    // `frame.time` deltas with up to 4 ticks per frame, so its rate is REAL TIME
    // and does not change with the runner's frame rate — which is exactly why a
    // slow SwiftShader box cannot turn this into a race.
    await spawnPatch(page, [
      { id: 'fn1', type: 'nibbles', domain: 'video', params: { tick_ms: 200 } },
    ], [], { mountTimeout: BOOT_MS });

    // ⚠ THE PRECONDITION THIS FILE RESTS ON: on the default shell no nibbles
    // card is mounted anywhere. If this ever finds one, nothing below proves
    // anything about the face. `nibbles-score` is the card's own testid for the
    // `LEN {n}` row the resting-text ruling deletes, so its absence is BOTH
    // halves of the claim in one locator.
    await expect(page.locator('.nibbles-card')).toHaveCount(0);
    await expect(page.locator('[data-testid="nibbles-score"]')).toHaveCount(0);

    const dock = await openDock(page, 'fn1');
    const body = dock.locator('[data-testid="nibbles-face-body"]');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    const frame = body.locator('[data-testid="nibbles-face-screen-frame"]');
    await expect(frame).toBeVisible();

    // ── THE SNAKE IS MOVING, AND IT IS MOVING ON X ─────────────────────────
    // Observed rather than asserted from `newGame`: this is also the check
    // that the framebuffer read works at all, so a later zero-motion result
    // cannot be blamed on the instrument.
    const before = await trackHead(page, 'fn1', 3, 900);
    expect(
      before.cells.length,
      `the snake must be moving before any key is pressed — saw ${before.cells.length} `
        + `distinct head cells over ${before.frames} frames / ${before.elapsedMs} ms `
        + `(alive=${before.alive}, score=${before.score})`,
    ).toBeGreaterThanOrEqual(2);
    const startAxis = axisOf(before.cells[0]!, before.cells[1]!);
    expect(
      startAxis,
      `a fresh nibbles heads RIGHT from the board centre, so the first move is on X — `
        + `got ${JSON.stringify(before.cells.slice(0, 3))}`,
    ).toBe('x');

    // ── ⚠ THE LOAD-BEARING LEG: PRESS AN ARROW ON THE FACEPLATE ────────────
    // The card gated the arrows on FOCUS and so does this body — but at
    // `tabindex="-1"`, so the pointer press is what takes the keyboard and Tab
    // is left alone as the faceplate flip gesture. A real click, then a real
    // keydown, on the surface a player actually has after promotion.
    await frame.click({ position: { x: 20, y: 20 } });
    await expect(frame).toBeFocused();
    await page.keyboard.press('ArrowDown');

    const after = await trackHead(page, 'fn1', 4, 900);
    expect(
      after.cells.length,
      `the snake must still be moving after the key press — saw ${after.cells.length} `
        + `distinct head cells over ${after.frames} frames / ${after.elapsedMs} ms `
        + `(alive=${after.alive}, score=${after.score})`,
    ).toBeGreaterThanOrEqual(2);
    // The LAST segment is the one the key can have caused; the first may still
    // be the pre-turn heading, because the pending direction is applied at the
    // next TICK boundary rather than on the press.
    const endAxis = axisOf(
      after.cells[after.cells.length - 2]!,
      after.cells[after.cells.length - 1]!,
    );
    expect(
      endAxis,
      `ArrowDown on the faceplate must turn the snake onto the Y axis — the arrow keys are `
        + `this module's only manual steering and they were CARD-ONLY before the promotion. `
        + `path=${JSON.stringify(after.cells)} alive=${after.alive} frames=${after.frames}`,
    ).toBe('y');
    // …and DOWN specifically, not merely "some turn".
    expect(after.cells[after.cells.length - 1]!.y)
      .toBeGreaterThan(after.cells[after.cells.length - 2]!.y);
  });

  test('SCREEN OFF collapses the picture and the GAME KEEPS RUNNING', async ({ page }) => {
    // ⚠ THE SINGLE MOST VALUABLE ASSERTION ON THIS SURFACE, and the one whose
    // sibling bodies do NOT need it: frogger and modtris step their games on
    // the shared scheduler clock in their factory, so a preview toggle could
    // not stop them if it tried. NIBBLES ticks inside `surface.draw`, so a
    // collapse that dropped the node out of the pull set would stop the snake
    // and silence PELLET / DEATH / DIR, the length CV and both square waves —
    // none of which this surface shows.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 3);
    await boot(page);
    await spawnPatch(page, [
      { id: 'fn2', type: 'nibbles', domain: 'video', params: { tick_ms: 200, auto: 1 } },
    ], [], { mountTimeout: BOOT_MS });

    const dock = await openDock(page, 'fn2');
    const body = dock.locator('[data-testid="nibbles-face-body"]');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    const toggle = body.locator('[data-testid="nibbles-face-screen-toggle"]');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(body.locator('[data-testid="nibbles-screen"]')).toBeVisible();

    await toggle.click();
    // The picture is REMOVED (not hidden) — that is what reclaims the space.
    await expect(body.locator('[data-testid="nibbles-screen"]')).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect((await nodeState(page, 'fn2')).previewCollapsed).toBe(true);

    // ⚠ AND THE GAME IS STILL MOVING, read off the module's own framebuffer —
    // which there is no canvas to read, which is the whole point.
    const collapsed = await trackHead(page, 'fn2', 4, 900);
    expect(
      collapsed.cells.length,
      `the snake must keep moving with SCREEN OFF: the game ticks inside surface.draw, so a `
        + `collapse that stopped the draw would stop the module. saw ${collapsed.cells.length} `
        + `distinct head cells over ${collapsed.frames} frames / ${collapsed.elapsedMs} ms `
        + `(alive=${collapsed.alive}, score=${collapsed.score})`,
    ).toBeGreaterThanOrEqual(3);

    // …and switching back on shows the LIVE game, not a stale frame.
    await toggle.click();
    await expect(body.locator('[data-testid="nibbles-screen"]')).toBeVisible();
    const back = await trackHead(page, 'fn2', 3, 900);
    expect(
      back.cells.length,
      `the picture must resume LIVE after SCREEN ON — frames=${back.frames} `
        + `elapsed=${back.elapsedMs} ms alive=${back.alive}`,
    ).toBeGreaterThanOrEqual(2);
  });

  test('the ranked AUTO toggle reaches the PARAM — the inert-control trap, from outside', async ({ page }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await spawnPatch(page, [
      { id: 'fn3', type: 'nibbles', domain: 'video' },
    ], [], { mountTimeout: BOOT_MS });

    const dock = await openDock(page, 'fn3');
    await expect(dock.locator('[data-testid="nibbles-face-body"]'))
      .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // ⚠ A TOGGLE, NOT A DIAL — derived from the `0..1 discrete` shape rather
    // than declared. The moog962 failure is one param shape away: a two-state
    // control drawn across a whole dial renders, drags and quantises back.
    const auto = dock.locator(CELL('auto'));
    await expect(auto).toHaveAttribute('data-cell-control', 'toggle');
    const sw = auto.locator('[data-testid="control-auto"]');
    await expect(sw).toHaveAttribute('role', 'switch');
    await expect(sw).toHaveAttribute('aria-checked', 'false');

    await sw.click();
    await expect
      .poll(async () => (await nodeState(page, 'fn3')).auto, {
        message:
          'the faceplate AUTO cell must reach `params.auto` — the factory reads that param as a '
          + 'bare level on every tick, and a cell writing anywhere else is the inert-control trap',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe(1);
    await expect(sw).toHaveAttribute('aria-checked', 'true');

  });

  test('RESET on the faceplate reaches the engine and DELIVERS', async ({ page }) => {
    // ⚠ THIS IS THE PROBE THE `faces-parity` SWEEP CANNOT MAKE, and that is why
    // RESET is a body button rather than a ranked `ShellActionCell`. An action
    // cell must declare a probe, and the only honest one here is an AUDITION —
    // `extras.reset()` writes no param and no `node.data`, because the game is
    // factory-internal, so `readParam`/`readData` are structurally blind to it
    // and a `data-rev` probe is outlawed ("a revision-only probe passes on a
    // dead button that bumps the counter").
    //
    // But the sweep spawns EVERY module with `spawnPatch({ id, type, position })`
    // and no `domain`, which `_helpers.ts` defaults to `'audio'` — so a VIDEO
    // module's factory is never constructed there at all. MEASURED on this
    // module before the design changed, both directions, on the default shell:
    // spawned `domain: 'video'` the ledger records `delivered: true`; spawned
    // the sweep's way, `read(node, 'extras')` is `undefined` and it records
    // `delivered: false` on a perfectly live button.
    //
    // So the probe lives HERE, on a REAL constructed nibbles — which is
    // strictly stronger than the sweep's version rather than a consolation.
    // ⚠ `delivered: false` IS THE FAILURE THIS WATCHES FOR, not the absence of
    // a record: "never pressed" and "pressed and reached nothing" are different
    // facts and the ledger keeps both.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await spawnPatch(page, [
      { id: 'fn5', type: 'nibbles', domain: 'video' },
    ], [], { mountTimeout: BOOT_MS });

    const dock = await openDock(page, 'fn5');
    const body = dock.locator('[data-testid="nibbles-face-body"]');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    const before = await auditionLog(page);
    expect(
      before.filter((r) => r.nodeId === 'fn5'),
      'no audition may be recorded for this node before the press — otherwise the leg below '
        + 'could be satisfied by something that happened at boot',
    ).toEqual([]);

    const reset = body.locator('[data-testid="nibbles-reset"]');
    await expect(reset).toBeEnabled();
    await reset.click();

    await expect
      .poll(async () => (await auditionLog(page)).filter((r) => r.nodeId === 'fn5'), {
        message:
          'the RESET press must resolve `reset` off the live engine handle and CALL it. A record '
          + 'with delivered:false means the button ran its handler and reached nothing — the '
          + 'audition is dead while the control looks perfectly alive.',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toEqual([{ nodeId: 'fn5', seam: 'engine-message', delivered: true, seq: 1 }]);
  });

  test('the SCALE zoom survives a dock collapse — it used to be component state', async ({ page }) => {
    // ⚠ THE BUG THIS PINS WAS LIVE. `let scale = $state(1)` in NibblesCard, and
    // under the shipping shell an un-migrated module's card exists ONLY inside
    // the dock full view — so collapsing the pane already reset a user's 4x
    // zoom to 1x, and the dock's LRU eviction did it to a module they never
    // touched (#1531 / #1574 / #1583). "The control still exists" is what every
    // registry test would have said about the broken version.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await spawnPatch(page, [
      { id: 'fn4', type: 'nibbles', domain: 'video' },
    ], [], { mountTimeout: BOOT_MS });

    const dock = await openDock(page, 'fn4');
    const body = dock.locator('[data-testid="nibbles-face-body"]');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    const scale = body.locator('[data-testid="nibbles-scale"]');
    await expect(scale).toHaveText('1×');

    await scale.click();
    await scale.click();
    await expect(scale).toHaveText('3×');
    expect((await nodeState(page, 'fn4')).previewScale).toBe(3);

    // COLLAPSE the pane back to the lane — the component unmounts, which is
    // exactly what used to lose the zoom. (`faceplate-collapse` rather than
    // `faceplate-close`: collapse is the ordinary gesture a player makes many
    // times a session, and it is the one the LRU eviction imitates.)
    await page.getByTestId('dock-full-view').getByTestId('faceplate-collapse').click();
    await expect(page.getByTestId('dock-full-view')).toHaveCount(0);
    await expect(page.locator('[data-testid="nibbles-face-body"]')).toHaveCount(0);

    const reopened = await openDock(page, 'fn4');
    const scaleAgain = reopened.locator('[data-testid="nibbles-scale"]');
    await expect(
      scaleAgain,
      'the zoom must survive the remount — it lives on node.data.previewScale now, not in the '
        + 'component that just died',
    ).toHaveText('3×');
    // …and the picture is actually drawn at that zoom, not merely labelled.
    await expect(reopened.locator('[data-testid="nibbles-screen"]'))
      .toHaveAttribute('style', /width: 960px/);
  });
});
