// e2e/tests/doom-keyboard-routing.spec.ts
//
// ⚠ DOOM SPECS ARE NORMALLY OFF-LIMITS — the standing owner ruling is
//   "do not [touch] doom in any way without specific approval". This file was
//   rewritten under a SPECIFIC approval given by the owner on 2026-08-18,
//   verbatim:
//     "okay see if you can go make the doom tests blurrier and less flakey,
//      just knowing doom renders and our kb logic and basic game nav works
//      is fine"
//   That approval covers THE SPECS ONLY — not video/modules/doom.ts, not the
//   WASM/WAD assets, not the netcode. See #1848 and e2e/tests/_doom-helpers.ts.
//
// Regression test for the "arrow keys move the DOOM card on the canvas instead
// of the player in-game" bug AND the follow-up bug where the arrow keys reached
// the WASM but were *decoded as KEY_MINUS* (shrinking the in-game viewport)
// because the patchtogether C shim was masking the doomkey to 7 bits
// (`& 0x7f`). KEY_UPARROW = 0xad → 0x2d after mask = KEY_MINUS =
// key_menu_decscreen.
//
// The fix lives in two places:
//   1. doom/DoomSurface.svelte — window-level capture-phase keydown/keyup,
//      fires BEFORE SvelteFlow's document-level node-keyboard-move handler.
//      This keeps the arrow keys from sliding the node on the canvas.
//   2. doomgeneric_patchtogether.c — encode the full 8-bit doomkey in the low
//      byte (not low 7 bits) of the key-queue entry. This keeps the arrow keys
//      from being mis-decoded as KEY_MINUS inside the WASM.
//
// ── WHAT THIS FILE ASSERTS NOW, AND WHY IT IS BLURRIER (#1848) ─────────────
//
// The owner's bar for DOOM coverage is "doom renders, our kb logic works, basic
// game nav works". Everything finer than that was a liability here, because
// DOOM's game clock IS the frame clock (one rendered frame = one game tic — see
// _doom-helpers.ts), so every "hold a key for N ms, then assert the marine
// travelled at least D" was really an assertion about HOW MANY TICS ELAPSED.
// That is a different assertion on every renderer and under every shard load.
//
// Two of the old thresholds were quietly minimum-tic-count gates:
//   · `|Δangle| > 50_000_000` — DOOM's SLOW turn rate (angleturn[2] = 320, used
//     for the first ~6 tics of a held turn) is 320 << 16 = 20_971_520 per tic,
//     so that threshold needed ≥ 3 tics INSIDE a fixed 800 ms window.
//   · `|dx|+|dy| > 100_000` after a fixed 1200 ms hold — a smaller margin, but
//     the same shape.
//
// So the assertions now read: HOLD THE KEY AND POLL UNTIL THE MARINE IS NO
// LONGER WHERE IT WAS (MOVE_EPS / TURN_EPS — one map unit, ~0.33°), bounded by
// a timeout that BOUNDS THE FAILURE rather than gating it. A frozen sim still
// fails; a slow renderer just takes longer to pass. The direction properties
// that are genuinely tic-count-independent are KEPT (left and right turn
// opposite ways; forward and backward are both motion).
//
// ⚠ NEGATIVE CONTROLS, PERMANENT LEGS OF EACH TEST. "The marine moved" is
// worthless without "the marine does NOT move when nothing is pressed" — a
// probe that always reports motion would pass the positive leg forever. Both
// tests therefore open with a NO-INPUT leg over a real span of TICS and assert
// the marine holds still, using the SAME epsilon and the SAME reader the
// positive legs use. The second test additionally keeps the post-Escape leg,
// which is a negative control by construction.
//
// Cold-start cost: the spec needs the WASM blob + the shareware WAD on the dev
// server. If either is missing (`/doom/doom.js` 404 or `/doom/DOOM1.WAD` 404)
// the test skips with a diagnostic — same gating pattern as
// doom-multiplayer.spec.ts.

import { test, expect, type Page, type Locator } from '@playwright/test';
import { spawnPatch } from './_helpers';
import {
  MOVE_EPS,
  TURN_EPS,
  angleDelta,
  manhattan,
  pressUntilInLevel,
  readPlayer,
  waitTics,
} from './_doom-helpers';

const NODE = 'v-doom';

/** The DOOM game surface — `doom/DoomSurface.svelte`, mounted by the shell's
 *  dock full view. It owns the runtime, the `__doomCards` hook, the keyboard
 *  capture and the "Click to load DOOM" gesture, so the faceplate has to be
 *  open before the WAD can be booted or a key can reach the marine. */
const SURFACE = 'doom-face-surface';

/** THIS node's LANE tile. Scoped to the node wrapper on purpose: with a
 *  faceplate open there are TWO `module-shell` elements for the same node (the
 *  lane tile and the dock tile), and only the lane one is the SvelteFlow node
 *  whose selection the arrow keys would steal. */
const LANE_TILE = `.svelte-flow__node[data-id="${NODE}"] [data-testid="module-shell"]`;

/** Open the DOOM faceplate through the app's own hook and wait for its surface
 *  — the dock boot is SEQUENTIAL (it does not overlap the page load), so this
 *  is a real wait rather than a formality. */
async function openDoomFace(page: Page): Promise<void> {
  await page.evaluate(
    (n) => (globalThis as unknown as { __openDockFullView(x: string): void }).__openDockFullView(n),
    NODE,
  );
  await expect(page.getByTestId(SURFACE)).toBeVisible({ timeout: 20_000 });
}

/** How many GAME TICS a no-input control leg observes. Tics, never ms: the
 *  claim is "the marine did not move while the sim ran", and the sim's clock is
 *  the only honest unit for "while the sim ran". 25 tics is a hair over the
 *  ~0.7 s of DOOM game time in which a held key produces obvious travel, so the
 *  control leg covers the same span of GAME time the positive leg needs. */
const CONTROL_TICS = 25;

interface PlayerState {
  x: number;
  y: number;
  angle: number;
}

test.describe('DOOM — keyboard routing (arrows reach player, not viewport)', () => {
  // Cold-start WASM init + 4 MB WAD fetch + menu nav + several polled key
  // bursts. Generous per-test budget; the assertions gate, this only bounds it.
  test.setTimeout(180_000);

  test('arrow keys move the player in-game, and nothing moves without them', async ({ page }) => {
    page.on('pageerror', (e) => console.error('pageerror:', e.message));

    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');

    const skip = await assetsMissing(page);
    if (skip) {
      test.skip(true, skip);
      return;
    }

    await spawnPatch(page, [
      { id: NODE, type: 'doom', position: { x: 200, y: 120 }, domain: 'video' },
    ]);

    await openDoomFace(page);
    const card = page.locator(`[data-testid="${SURFACE}"]`);
    await expect(card, 'DOOM surface mounts').toHaveCount(1);

    // Boot the runtime via the "Click to load DOOM" overlay button.
    const loadBtn = card.locator('button.overlay').filter({ hasText: 'Click to load DOOM' });
    await expect(loadBtn).toBeVisible();
    await loadBtn.click();
    await expect(card.locator('.overlay'), 'load overlay clears').toHaveCount(0, {
      timeout: 30_000,
    });

    // TWO gestures, because on the shell they land on two different surfaces
    // and the test needs both. Clicking the LANE TILE selects the SvelteFlow
    // node (SF marks it .selected) — that is what arms the hazard the
    // "the node did not move on canvas" assertions below are about, since SF's
    // keyboard-move handler only fires for a SELECTED node. Clicking the
    // FACEPLATE then latches keyboard control (its onclick calls cardEl.focus()
    // + latchKeyboard()). The tile grip is used rather than the tile body so
    // the gesture cannot land on a ranked control and write a param.
    await page.locator(LANE_TILE).locator('.tile-kind').click();
    await card.click();
    await expect(
      page.locator('.svelte-flow__node[data-id="v-doom"].selected'),
      'the lane tile becomes the selected SF node after click',
    ).toHaveCount(1);

    // ── BASIC GAME NAV: keyboard walks the title sequence into E1M1 ─────────
    // Enter → exits the demo loop into the main menu → "New Game" → skill
    // picker → confirms skill → E1M1. Pressed until the marine EXISTS rather
    // than four times on a wall-clock cadence, so a slow renderer cannot leave
    // the walk stranded in the skill picker (see pressUntilInLevel).
    const presses = await pressUntilInLevel(page, NODE);
    expect(
      presses,
      `keyboard nav reached E1M1 in ${presses} Enter presses (vanilla walk is 4). A ` +
        `much larger number means presses are being DROPPED, which is the very ` +
        `routing bug this file exists to catch — not merely a slow machine.`,
    ).toBeLessThanOrEqual(12);

    const nodeWrapper = page.locator('.svelte-flow__node[data-id="v-doom"]');
    const viewport = page.locator('.svelte-flow__viewport');

    // ── NEGATIVE CONTROL (permanent): NO KEY HELD ⇒ the marine holds still ──
    // Read with the same reader and judged against the same epsilon as every
    // positive leg below. Without this, "the marine is not where it was" would
    // be satisfied by a probe that reports motion unconditionally, and all
    // four positive legs would be green lights wired to nothing.
    const idleBefore = await readState();
    const idleTics = await waitTics(page, NODE, CONTROL_TICS, 30_000);
    const idleAfter = await readState();
    expect(
      idleTics,
      `DOOM's game clock did not advance ${CONTROL_TICS} tics (advanced ${idleTics}). ` +
        `A frozen sim makes the control leg below vacuous — it would report "did not ` +
        `move" for a sim that cannot move at all.`,
    ).toBeGreaterThanOrEqual(CONTROL_TICS);
    expect(
      manhattan(idleBefore, idleAfter),
      `the marine MOVED with no key held (|dx|+|dy|=${manhattan(idleBefore, idleAfter)} ` +
        `over ${idleTics} tics, before=(${idleBefore.x}, ${idleBefore.y}) ` +
        `after=(${idleAfter.x}, ${idleAfter.y})). Every "a key moved the marine" ` +
        `assertion below is meaningless while this is true.`,
    ).toBeLessThan(MOVE_EPS);
    expect(
      Math.abs(angleDelta(idleBefore.angle, idleAfter.angle)),
      `the marine TURNED with no key held (Δangle=` +
        `${angleDelta(idleBefore.angle, idleAfter.angle)} over ${idleTics} tics).`,
    ).toBeLessThan(TURN_EPS);

    // ── ArrowUp: forward movement ──────────────────────────────────────────
    // The exact movement axis (x vs y) depends on the spawn-facing angle on
    // E1M1, so this is |dx|+|dy| — not a specific axis. And it is a POLL, not a
    // fixed hold: the key stays down until the marine is somewhere else, so the
    // tic rate sets the DURATION and never the VERDICT.
    const transformBefore = await readTransform(nodeWrapper);
    const viewportBefore = await readTransform(viewport);
    const beforeUp = await readState();

    await page.keyboard.down('ArrowUp');
    let movedUp = 0;
    try {
      await expect
        .poll(
          async () => {
            movedUp = manhattan(beforeUp, await readState());
            return movedUp;
          },
          {
            timeout: 30_000,
            intervals: [100, 200, 400],
            message:
              'ArrowUp produced no player movement. The doomkey was either lost en ' +
              'route OR mis-decoded inside the WASM. Check ' +
              'doomgeneric_patchtogether.c → dgpt_set_key / DG_GetKey: KEY_UPARROW ' +
              '(0xad) must round-trip the full 8 bits; the original "& 0x7f" mask ' +
              'aliased it to KEY_MINUS (0x2d) and shrunk the screen instead of ' +
              'moving forward.',
          },
        )
        .toBeGreaterThan(MOVE_EPS);
    } finally {
      await page.keyboard.up('ArrowUp');
    }

    expect(
      await readTransform(nodeWrapper),
      `the node moved on canvas during ArrowUp (was ${transformBefore}). SvelteFlow ` +
        `stole the arrow key instead of DOOM consuming it.`,
    ).toBe(transformBefore);
    expect(
      await readTransform(viewport),
      `canvas zoom/pan changed during ArrowUp (was ${viewportBefore}). Some part of ` +
        `the canvas chrome received the key.`,
    ).toBe(viewportBefore);

    // ── ArrowLeft / ArrowRight: the view turns, and in OPPOSITE directions ──
    // Direction is the part of a turn that does NOT depend on how many tics
    // elapsed, so it survives the blur while the magnitude does not.
    const angleDeltaL = await turnAndMeasure('ArrowLeft', nodeWrapper, viewport);
    const angleDeltaR = await turnAndMeasure('ArrowRight', nodeWrapper, viewport);
    expect(
      Math.sign(angleDeltaL),
      `ArrowLeft and ArrowRight turned the SAME way (Δleft=${angleDeltaL} ` +
        `Δright=${angleDeltaR}). Both keys reaching the game is not enough — if they ` +
        `produce the same rotation, one of them is being decoded as the other.`,
    ).toBe(-Math.sign(angleDeltaR));

    // ── ArrowDown: backward movement ───────────────────────────────────────
    const beforeD = await readState();
    await page.keyboard.down('ArrowDown');
    try {
      await expect
        .poll(async () => manhattan(beforeD, await readState()), {
          timeout: 30_000,
          intervals: [100, 200, 400],
          message: `ArrowDown produced no player movement from (${beforeD.x}, ${beforeD.y}).`,
        })
        .toBeGreaterThan(MOVE_EPS);
    } finally {
      await page.keyboard.up('ArrowDown');
    }

    // ---- local helpers, closed over `page` ----

    async function readState(): Promise<PlayerState> {
      const s = await readPlayer(page, NODE);
      if (!s) throw new Error('runtime.getPlayerState() returned null — no level loaded');
      return s;
    }

    /** Hold a turn key until the facing angle has moved past TURN_EPS, assert
     *  the canvas chrome did not eat the key, and return the SIGNED delta. */
    async function turnAndMeasure(
      key: 'ArrowLeft' | 'ArrowRight',
      wrapper: Locator,
      vp: Locator,
    ): Promise<number> {
      const tBefore = await readTransform(wrapper);
      const vBefore = await readTransform(vp);
      const before = await readState();
      let delta = 0;
      await page.keyboard.down(key);
      try {
        await expect
          .poll(
            async () => {
              delta = angleDelta(before.angle, (await readState()).angle);
              return Math.abs(delta);
            },
            {
              timeout: 30_000,
              intervals: [100, 200, 400],
              message:
                `${key} produced no facing-angle change from ${before.angle}. The key ` +
                `never reached the WASM, or it was decoded as something else.`,
            },
          )
          .toBeGreaterThan(TURN_EPS);
      } finally {
        await page.keyboard.up(key);
      }
      expect(await readTransform(wrapper), `the node moved on canvas during ${key}`).toBe(tBefore);
      expect(await readTransform(vp), `canvas zoom changed during ${key}`).toBe(vBefore);
      return delta;
    }
  });

  // Regression for the multiplayer "keyboard capture keeps dropping — have to
  // keep clicking the DOOM window" symptom. Sync churn (frame broadcasts,
  // roster writes, host election) re-renders the SvelteFlow node ~10×/s, which
  // momentarily drops the `.selected` class and/or steals focus. Pre-fix,
  // shouldClaimKey() read that transient state live, so capture flickered off
  // and arrow keys stopped reaching the game until the user re-clicked. The fix
  // is a STICKY LATCH set on click + held until an explicit release (Esc /
  // click-away / tab-hide). This test simulates the churn by forcibly blurring
  // the card AND stripping the `.selected` class, then asserts keys STILL move
  // the player — and that Escape (explicit release) stops capture.
  test('keyboard capture survives a re-render churn (sticky latch) + Esc releases it', async ({
    page,
  }) => {
    page.on('pageerror', (e) => console.error('pageerror:', e.message));
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');

    const skip = await assetsMissing(page);
    if (skip) {
      test.skip(true, skip);
      return;
    }

    await spawnPatch(page, [
      { id: NODE, type: 'doom', position: { x: 200, y: 120 }, domain: 'video' },
    ]);
    await openDoomFace(page);
    const card = page.locator(`[data-testid="${SURFACE}"]`);
    await expect(card, 'DOOM surface mounts').toHaveCount(1);

    const loadBtn = card.locator('button.overlay').filter({ hasText: 'Click to load DOOM' });
    await expect(loadBtn).toBeVisible();
    await loadBtn.click();
    await expect(card.locator('.overlay'), 'load overlay clears').toHaveCount(0, {
      timeout: 30_000,
    });

    // Click latches keyboard control; keyboard walks into E1M1.
    await card.click();
    await pressUntilInLevel(page, NODE);

    async function readState(): Promise<PlayerState> {
      const s = await readPlayer(page, NODE);
      if (!s) throw new Error('no player state');
      return s;
    }

    // SIMULATE SYNC CHURN: blur the focused surface + strip the SF `.selected`
    // class, exactly what a multiplayer re-render does. Pre-fix this killed
    // capture; the latch must keep it alive.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      document
        .querySelector('.svelte-flow__node[data-id="v-doom"]')
        ?.classList.remove('selected');
    });

    // ── NEGATIVE CONTROL (permanent): churn alone must not move the marine ──
    // The positive leg below claims "the latch survived the churn, so the key
    // still moves the player". That claim only means something if the CHURN
    // ITSELF does not move the player — otherwise the leg passes on a marine
    // that was already sliding.
    const idleBefore = await readState();
    const idleTics = await waitTics(page, NODE, CONTROL_TICS, 30_000);
    const idleAfter = await readState();
    expect(
      idleTics,
      `game clock did not advance ${CONTROL_TICS} tics after the churn (advanced ` +
        `${idleTics}) — the control leg below would be vacuous.`,
    ).toBeGreaterThanOrEqual(CONTROL_TICS);
    expect(
      manhattan(idleBefore, idleAfter),
      `the marine moved during the churn itself with no key held ` +
        `(|dx|+|dy|=${manhattan(idleBefore, idleAfter)} over ${idleTics} tics).`,
    ).toBeLessThan(MOVE_EPS);

    // ── The latch survived: a held ArrowUp still reaches the game ───────────
    const before = await readState();
    await page.keyboard.down('ArrowUp');
    try {
      await expect
        .poll(async () => manhattan(before, await readState()), {
          timeout: 30_000,
          intervals: [100, 200, 400],
          message:
            'player did NOT move after a re-render churn. The sticky keyboard latch ' +
            'should keep DOOM capturing keys even when focus / .selected drop.',
        })
        .toBeGreaterThan(MOVE_EPS);
    } finally {
      await page.keyboard.up('ArrowUp');
    }

    // ── Escape = explicit release. A fresh press must NOT move the player ───
    //
    // ⚠ ESCAPE DOES TWO THINGS ON THE SHELL, and the second one is the dock's,
    // not DOOM's: the surface's capture handler unlatches the keyboard and
    // deliberately lets the event through (`do NOT preventDefault, so normal
    // Esc behaviour still works`), and Canvas's own window handler then closes
    // the open full view. The faceplate is where the surface lives, so the
    // press that hands the keyboard back also takes the game pane down with it
    // — and the `__doomCards` hook every reader below goes through with it.
    // Re-opening the pane restores the reader; it does not re-latch anything
    // (re-engaging keyboard control needs a fresh CLICK), which is exactly the
    // state the assertions below are about.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId(SURFACE)).toHaveCount(0, { timeout: 15_000 });
    await openDoomFace(page);

    // Let residual momentum from the forward burst decay BEFORE measuring the
    // post-release press. The latched ArrowUp built up momentum; DOOM friction
    // decays it over ~1 s of GAME TICS, and the runtime advances tics on the
    // rAF clock — so a fixed wall-clock window here catches leftover slide, not
    // key routing. Poll until the marine is STATIONARY instead. If forward were
    // genuinely STUCK (a real release bug) it would never settle and this times
    // out, so it cannot mask a real bug — only the momentum confound.
    let prev = await readState();
    await expect
      .poll(
        async () => {
          // Sample across a few TICS so "settled" means settled in game time,
          // not "two Playwright reads landed in the same frame" — an even
          // wall-clock lag against a paused renderer aliases to a constant and
          // would declare a still-sliding marine stationary.
          await waitTics(page, NODE, 5, 5_000);
          const cur = await readState();
          const delta = manhattan(prev, cur);
          prev = cur;
          return delta;
        },
        {
          timeout: 30_000,
          message:
            'player never stopped moving after Escape — forward momentum should decay ' +
            'and DOOM should stop consuming keys once the latch is released.',
        },
      )
      .toBeLessThan(MOVE_EPS);

    const beforeRelease = await readState();
    await page.keyboard.down('ArrowUp');
    const heldTics = await waitTics(page, NODE, CONTROL_TICS, 30_000);
    await page.keyboard.up('ArrowUp');
    const afterRelease = await readState();
    expect(
      heldTics,
      `game clock did not advance ${CONTROL_TICS} tics while ArrowUp was held after ` +
        `Escape (advanced ${heldTics}). "The marine did not move" is vacuous when the ` +
        `sim did not run — this is the leg that stops a frozen renderer from reading ` +
        `as a correctly-released keyboard.`,
    ).toBeGreaterThanOrEqual(CONTROL_TICS);
    expect(
      manhattan(beforeRelease, afterRelease),
      `player moved after Escape released the latch ` +
        `(|dx|+|dy|=${manhattan(beforeRelease, afterRelease)} over ${heldTics} tics). ` +
        `Escape should hand the keyboard back so DOOM stops consuming keys.`,
    ).toBeLessThan(MOVE_EPS);
  });
});

// ---------------- helpers ----------------

async function assetsMissing(page: Page): Promise<string | null> {
  const wasm = await page.request.get('/doom/doom.js');
  if (!wasm.ok()) {
    return (
      `DOOM WASM not on dev server (status ${wasm.status()}). ` +
      `Run \`bash packages/web/native/build-doom-wasm.sh\` to enable this test locally.`
    );
  }
  const wad = await page.request.get('/doom/DOOM1.WAD');
  if (!wad.ok()) {
    return (
      `DOOM1.WAD missing (status ${wad.status()}). ` +
      `See packages/web/static/doom/DOWNLOAD_INSTRUCTIONS.md.`
    );
  }
  return null;
}

async function readTransform(loc: Locator): Promise<string> {
  // Read the inline CSS transform xyflow writes to the node wrapper /
  // viewport. We compare strings — exact byte equality is what we want
  // ("not moved" = "transform string identical").
  return await loc.evaluate((el) => (el as HTMLElement).style.transform || '');
}
