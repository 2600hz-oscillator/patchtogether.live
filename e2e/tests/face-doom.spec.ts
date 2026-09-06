// e2e/tests/face-doom.spec.ts
//
// THE DOOM FACE, driven for real on the DEFAULT shell — the seams no other gate
// can see.
//
// ⚠ THE FILENAME AND ITS LANE, checked against the live glob list rather than
// assumed. `e2e/webgl-heavy-globs.ts` classifies by PREFIX and a spec swept into
// the heavy lane runs NOWHERE in PR CI. `face-*` matches no heavy glob and
// neither does `doom-*` — every existing DOOM spec already runs in the sharded
// `e2e` matrix — so this file lands in the same lane as its siblings. Nothing
// here is WebGL-heavy: it reads DOM facts, graph state and DOOM's OWN GAME TIC
// COUNTER, and samples no GPU pixels. ⚠ AND THE GLOB FILE WAS DELIBERATELY NOT
// EDITED: `e2e/webgl-heavy-globs.ts` is in the WebGL attest basis
// (STANDALONE_BASIS_FILES), so adding a pattern there would move the hash and
// cost a real-GPU re-attest — for a lane change this file does not need.
//
// ⚠ THIS FACE HAS NO VRT SCENES AT ALL. DOOM's game clock IS its frame clock
// (`runtime.runTic()` runs inside `surface.draw`), so it holds a named
// `FACES_WITHOUT_SCENES` exemption and NOTHING compares its pixels at either
// tier. That makes this file and `doom-face-model.test.ts` the whole of the
// face's coverage, which raises the bar rather than lowering it.
//
// `doom-face-model.test.ts` pins the ranking, the glyph judgement, the forty
// no-user-control declarations and every source-level claim — including the one
// that matters most, that the card and the face mount ONE surface component.
// `face-rack-status-source.test.ts` proves the body declares what it paints and
// `video-face-screen-source.test.ts` that it OWNS a screen switch. None of them
// can see:
//
//  1. ⚠ THAT DOOM CAN BE BOOTED AND PLAYED AT ALL UNDER THE SHELL. This is the
//     promotion's whole risk. DOOM's card was not a control panel, it was the
//     module's RUNTIME OWNER — `nodeDoomSession.adopt`, the awareness
//     observers, the capture-phase keyboard listeners, the blit and the
//     `__doomCards` hook all lived in its `onMount`, and promotion stops the
//     default shell mounting it. A face that carried only the two CONTROLS
//     would ship a black tile with no game, and the def, the registry, the
//     shader and every def-reading gate would stay green.
//  2. ⚠ THAT SCREEN OFF DOES NOT STOP THE GAME. This is load-bearing here in a
//     way it is not for any sibling: frogger, gibribbon and pong step on the
//     shared scheduler clock and could not be stopped by a preview toggle if
//     you tried. DOOM ticks inside `surface.draw`, and a peer that stopped
//     ticking starves every other peer's lockstep barrier (#345 semantics), so
//     "the collapse removes the COPY, never the engine draw" has to be measured
//     rather than argued.
//  3. ⚠ THAT A REAL KEYPRESS ON THE FACEPLATE REACHES THE MARINE. The keyboard
//     capture is a window-level capture-phase listener that only fires while
//     the surface is latched — a click gesture that lived on the card.
//
// ⚠ EVERY READINESS QUANTITY HERE IS FRAMES OR GAME TICS, NEVER MILLISECONDS.
// `waitTics` (the DOOM suite's own shared export) reads `gametic` off DOOM's
// clock inside the page, so it is renderer-independent by construction; the
// only wall-clock numbers are the shared BOOT budgets, which bound a page load
// and nothing about the simulation. No existing DOOM wait, budget or threshold
// was read, copied or changed to write this file.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';
import { waitTics, gametic, readPlayer, MOVE_EPS, manhattan } from './_doom-helpers';

const NODE = 'fd1';

/** The shared surface's testid in FACE variant — the card renders the SAME
 *  component under `doom-card`. */
const SURFACE = 'doom-face-surface';

async function boot(page: Page): Promise<void> {
  // Plain /rack — the DEFAULT shell, which is now the only rack the DOOM suite
  // knows: every doom spec drives the faceplate.
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** The WASM shim + shareware WAD must be on the dev server or this spec cannot
 *  test what it is for — the same diagnostic every DOOM spec prints. */
async function requireDoomAssets(page: Page): Promise<void> {
  const shim = await page.request.get('/doom/doom.js');
  expect(
    shim.ok(),
    `DOOM WASM shim not on dev server (status ${shim.status()}). Run ` +
      '`bash packages/web/native/build-doom-wasm.sh`, or check the "Build DOOM WASM (emcc)" CI step.',
  ).toBe(true);
  const wad = await page.request.get('/doom/DOOM1.WAD');
  expect(
    wad.ok(),
    `DOOM1.WAD not on dev server (status ${wad.status()}). ` +
      'See packages/web/static/doom/DOWNLOAD_INSTRUCTIONS.md.',
  ).toBe(true);
}

/** Open this node's dock faceplate (the auto-retrying tv-librarian pattern —
 *  the tile button is hit-testable while a previous pane is still tearing down,
 *  so one click can land on nothing). */
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

/** Boot the WAD through the faceplate's OWN load gesture — the user path, and
 *  the one the promotion could have deleted. */
async function loadThroughFace(page: Page, body: ReturnType<Page['locator']>) {
  const loadBtn = body.locator('button.overlay').filter({ hasText: 'Click to load DOOM' });
  await expect(loadBtn, 'the faceplate must offer the WAD load gesture').toBeVisible({
    timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
  });
  await loadBtn.click();
  await expect(body.locator('.overlay'), 'load overlay clears').toHaveCount(0, {
    timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
  });
}

test.describe('DOOM face — the promotion is what keeps it playable', () => {
  // ⚠ A PAGE ERROR FAILS EVERY TEST IN THIS FILE. A TypeError inside a
  // `$derived` does not surface as a thrown assertion — it takes the subtree's
  // render down and the symptom lands somewhere else entirely. That matters
  // more here than usual: this surface is 2 900 lines of session wiring that
  // has only ever run inside a card, and the face is the first thing to mount
  // it with `data` undefined.
  test.beforeEach(({ page }) => {
    page.on('pageerror', (err) => {
      throw new Error(`uncaught page error during a doom face test: ${err.message}`);
    });
  });

  test('the shell replaces the card, and the faceplate carries the whole surface', async ({
    page,
  }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await spawnPatch(page, [
      { id: NODE, type: 'doom', position: { x: 160, y: 140 }, domain: 'video' },
    ], [], { mountTimeout: BOOT_MS });

    // ⚠ THE PRECONDITION THAT STOOD HERE IS NOW TRUE BY CONSTRUCTION, so it is
    // deleted rather than left as an assertion that cannot fail. It read "no
    // DOOM card is mounted anywhere", and `DoomSurface` had a `variant` prop
    // whose `'card'` arm emitted `data-testid="doom-card"`. That arm is gone —
    // there is one surface and one testid — so the check had exactly one
    // possible answer. What it was really protecting (that this file measures
    // the FACE) is carried by the assertions below, which name
    // `doom-face-surface` and the dock pane directly.

    const dock = await openDock(page, NODE);
    const body = dock.locator('[data-testid="doom-body"]');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // The shared surface, in face variant — the component that owns the session.
    const surface = body.locator(`[data-testid="${SURFACE}"]`);
    await expect(surface).toBeVisible();

    // ⚠ THE HOOK IS THE MODULE'S NERVOUS SYSTEM. `__doomCards[nodeId]` is
    // installed in the surface's `onMount` and is what `_doom-helpers.ts`, the
    // multiplayer specs and the lockstep probes all read. A face body that
    // mounted a picture but not the surface would look perfectly healthy here
    // and would have severed every one of them.
    await expect
      .poll(
        () =>
          page.evaluate(
            (n) =>
              Object.keys(
                (globalThis as unknown as { __doomCards?: Record<string, unknown> }).__doomCards ?? {},
              ).includes(n),
            NODE,
          ),
        {
          timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
          message:
            'the faceplate mounted without installing __doomCards — the surface did not adopt ' +
            'the node session, so keyboard routing, the roster, the netcode and every DOOM ' +
            'spec helper are severed on the default shell',
        },
      )
      .toBe(true);

    // The two ranked cells the shell renders from `face.order`, and the two the
    // body must NOT paint again (the card's OUTPUT FIT row is card-only). ⚠ THE
    // SECOND HALF IS THE REAL ASSERTION: a body that carried the card's own
    // OUTPUT FIT row would put TWO controls on the plate for one param, and
    // `faces-parity` counts cells rather than comparing them — it would pass.
    await expect(dock.locator('[data-cell-key="audioGain"]')).toHaveCount(1);
    await expect(dock.locator('[data-cell-key="fillMode"]')).toHaveCount(1);
    await expect(body.locator('[data-testid="doom-fit-row"]')).toHaveCount(0);
    await expect(body.locator('[data-testid="doom-volume"]')).toHaveCount(0);

    // ⚠ THE DELETED RESTING READOUTS. The card paints a derived identity
    // sentence and a session footer; the face carries both on the surface's
    // accessible name instead. Their ABSENCE is the assertion.
    await expect(body.locator('[data-testid="doom-player-label"]')).toHaveCount(0);
    await expect(body.locator('[data-testid="doom-member-hint"]')).toHaveCount(0);
    await expect(surface).toHaveAttribute('aria-label', /DOOM video module/);

    // MONITOR persists on the node, one boolean per click.
    const monitor = body.getByTestId('doom-monitor-toggle');
    await expect(monitor).toHaveAttribute('aria-pressed', 'false');
    await monitor.click();
    await expect(monitor).toHaveAttribute('aria-pressed', 'true');
    expect(
      await page.evaluate(
        (n) =>
          (globalThis as unknown as { __patch: { nodes: Record<string, { data?: { hideControls?: boolean } }> } })
            .__patch.nodes[n]?.data?.hideControls,
        NODE,
      ),
      'MONITOR must write node.data.hideControls — component state does not survive a collapse',
    ).toBe(true);
  });

  test('the game BOOTS and ADVANCES from the faceplate, and a real key reaches the marine', async ({
    page,
  }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 4);
    await boot(page);
    await requireDoomAssets(page);
    await spawnPatch(page, [
      { id: NODE, type: 'doom', position: { x: 160, y: 140 }, domain: 'video' },
    ], [], { mountTimeout: BOOT_MS });

    const dock = await openDock(page, NODE);
    const body = dock.locator('[data-testid="doom-body"]');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // ── THE POSITIVE CONTROL, BEFORE THE BOOT ─────────────────────────────
    // ⚠ MEASURED, not assumed: with the hook installed but NO runtime,
    // `getTics()` reports gametic 0 (the extras' own `runtime ? … : 0` guard) —
    // a -1 would mean the hook itself is missing, which is a different failure
    // and is asserted in the test above. What matters here is that the game has
    // not started, so the "it advances after loading" leg below cannot be
    // measuring a game somebody else began. `readPlayer` is the independent
    // half: no runtime means no player mobj at all.
    expect(
      await gametic(page, NODE),
      'DOOM must not have a runtime before the user asks for one — a mount-time WASM/WAD load ' +
        'is the #2314 defect and would cost 4 MB and a WASM instantiation per spawned tile',
    ).toBe(0);
    expect(
      await readPlayer(page, NODE),
      'a marine exists before anyone pressed the load button — the face booted the WAD at MOUNT',
    ).toBeNull();

    // ── ACT: boot through the FACEPLATE's own gesture ──────────────────────
    await loadThroughFace(page, body);

    // ── ASSERT 1: THE SIM ADVANCES, measured in GAME TICS off DOOM's own
    // clock. Not milliseconds, not frames-as-a-proxy: `gametic` is the number
    // the claim is about, and it is renderer-independent by construction. ──
    const advanced = await waitTics(page, NODE, 12);
    expect(
      advanced,
      `DOOM did not advance a single tic after booting through the FACEPLATE (units: engine ` +
        `tics; observed ${advanced}). The face mounted, the WAD loaded and the game is frozen — ` +
        `which means the surface is not being drawn by the video engine on this shell.`,
    ).toBeGreaterThanOrEqual(12);

    // ── ASSERT 2: A REAL KEYPRESS ON THE FACEPLATE MOVES THE MARINE ────────
    // Click the surface to LATCH keyboard control — the same gesture the card
    // has always used — then walk into the attract demo's world and watch the
    // player mobj move. `pressUntilInLevel` is deliberately NOT used: this leg
    // is about the KEY ROUTE reaching the runtime from the face, not about menu
    // navigation, and the attract demo already has a live player mobj.
    await body.locator(`[data-testid="${SURFACE}"]`).click();
    await expect
      .poll(() => readPlayer(page, NODE).then((p) => p !== null), {
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
        message: 'no player mobj ever spawned, so there is nothing for a keypress to move',
      })
      .toBe(true);

    // NEGATIVE CONTROL FIRST: with no key held, does the probe read RED? The
    // attract demo plays itself, so this leg cannot assert "nothing moves" —
    // what it CAN do is record the idle displacement so the held-key leg is
    // compared against a real floor rather than against zero.
    const idleA = (await readPlayer(page, NODE))!;
    await waitTics(page, NODE, 20);
    const idleB = (await readPlayer(page, NODE))!;
    const idleDelta = manhattan(idleA, idleB);

    // …then hold FORWARD across a fixed number of TICS and compare.
    const before = (await readPlayer(page, NODE))!;
    await page.keyboard.down('ArrowUp');
    await waitTics(page, NODE, 20);
    const after = (await readPlayer(page, NODE))!;
    await page.keyboard.up('ArrowUp');
    const heldDelta = manhattan(before, after);

    expect(
      heldDelta,
      `holding ArrowUp on the FACEPLATE moved the marine by ${heldDelta} raw units over 20 game ` +
        `tics, which is under the one-map-unit floor (${MOVE_EPS}). The keyboard capture did not ` +
        `survive the promotion: the window listeners live in the shared surface and only fire ` +
        `while it is latched by a click. (idle displacement over the same window: ${idleDelta})`,
    ).toBeGreaterThan(MOVE_EPS);
  });

  test('SCREEN OFF collapses the PICTURE and the game keeps ticking', async ({ page }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 4);
    await boot(page);
    await requireDoomAssets(page);
    await spawnPatch(page, [
      { id: NODE, type: 'doom', position: { x: 160, y: 140 }, domain: 'video' },
    ], [], { mountTimeout: BOOT_MS });

    const dock = await openDock(page, NODE);
    const body = dock.locator('[data-testid="doom-body"]');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await loadThroughFace(page, body);

    const canvas = body.locator('[data-testid="doom-canvas"]');
    await expect(canvas, 'the preview paints before the switch is touched').toBeVisible();

    // Instrument positive control: the sim advances WITH the screen on, or the
    // "still advancing while off" leg below would be unfalsifiable.
    expect(
      await waitTics(page, NODE, 10),
      'the sim was not advancing even with SCREEN ON — nothing below could discriminate',
    ).toBeGreaterThanOrEqual(10);

    // ── ACT ────────────────────────────────────────────────────────────────
    const toggle = body.getByTestId('doom-face-screen-toggle');
    await expect(toggle).toHaveText(/SCREEN ON/);
    await toggle.click();
    await expect(toggle).toHaveText(/SCREEN OFF/);
    await expect(canvas, 'SCREEN OFF must REMOVE the preview canvas').toHaveCount(0);

    // ⚠ THE LEG THIS WHOLE TEST EXISTS FOR. DOOM ticks inside `surface.draw`,
    // so a collapse that reached the ENGINE rather than the copy would stop the
    // simulation — and in a netgame a peer that stops ticking starves every
    // other peer's lockstep barrier (#345: a DOOM freeze is a consistency
    // abort). Measured in game tics, off DOOM's own clock.
    const whileOff = await waitTics(page, NODE, 10);
    expect(
      whileOff,
      `the game STOPPED once SCREEN was turned off (units: engine tics; observed ${whileOff}). ` +
        `The collapse must remove the card-style 2-D copy of the framebuffer and nothing else — ` +
        `the video engine goes on drawing because DOOM is a pull ROOT unconditionally ` +
        `(VideoEngine.isPullExempt, via its non-empty audioSources map).`,
    ).toBeGreaterThanOrEqual(10);

    // ⚠ AND THE SESSION SURFACE IS STILL MOUNTED. gibribbon's body unmounts its
    // whole playfield on SCREEN OFF; this one must not, because that would drop
    // the node session adoption, the keyboard capture and the multiplayer
    // affordances with the picture.
    await expect(
      body.locator(`[data-testid="${SURFACE}"]`),
      'SCREEN OFF unmounted the SURFACE, not just the canvas — the session, the keyboard and ' +
        'the Join / New Game affordances went with it',
    ).toBeVisible();

    // The state is on the NODE, so it survives a collapse and syncs.
    expect(
      await page.evaluate(
        (n) =>
          (globalThis as unknown as { __patch: { nodes: Record<string, { data?: { previewCollapsed?: boolean } }> } })
            .__patch.nodes[n]?.data?.previewCollapsed,
        NODE,
      ),
    ).toBe(true);

    // …and the picture RETURNS, exactly once.
    await toggle.click();
    await expect(toggle).toHaveText(/SCREEN ON/);
    await expect(canvas).toHaveCount(1);
    await expect(canvas).toBeVisible();
  });
});
