// e2e/tests/doom-keyboard-routing.spec.ts
//
// Regression test for the "arrow keys move the DOOM card on the canvas
// instead of the player in-game" bug AND the follow-up bug where the
// arrow keys reached the WASM but were *decoded as KEY_MINUS* (shrinking
// the in-game viewport) because the patchtogether C shim was masking the
// doomkey to 7 bits (`& 0x7f`). KEY_UPARROW = 0xad → 0x2d after mask =
// KEY_MINUS = key_menu_decscreen.
//
// The fix lives in two places:
//   1. DoomCard.svelte — window-level capture-phase keydown/keyup, fires
//      BEFORE SvelteFlow's document-level node-keyboard-move handler.
//      This keeps the arrow keys from sliding the card on the canvas.
//   2. doomgeneric_patchtogether.c — encode the full 8-bit doomkey in
//      the low byte (not low 7 bits) of the key-queue entry. This keeps
//      the arrow keys from being mis-decoded as KEY_MINUS inside the
//      WASM.
//
// What this spec asserts (all must hold for a single keypress burst):
//
//   1. After spawning DOOM + clicking the card, the card's on-canvas
//      position (the .svelte-flow__node[data-id="v-doom"] CSS transform)
//      does NOT change when arrow keys are pressed.
//   2. SvelteFlow's viewport zoom/pan is unchanged.
//   3. **The player's in-game x/y position changes when ArrowUp is held**
//      (forward movement on E1M1 — verified by reading players[0].mo->y
//      via dgpt_get_player_y exported from the WASM, NOT by sampling the
//      framebuffer, which the broken-key bug also changed).
//   4. **The player's facing angle changes when ArrowLeft / ArrowRight
//      is held** (left turns increase angle, right turns decrease angle
//      per DOOM's CCW convention).
//
// Cold-start cost: the spec needs the WASM blob + the shareware WAD on
// the dev server. If either is missing (`/doom/doom.js` 404 or `/doom/
// DOOM1.WAD` 404) the test skips with a diagnostic — same gating pattern
// as doom-multiplayer.spec.ts.

import { test, expect, type Page, type Locator } from '@playwright/test';
import { spawnPatch } from './_helpers';

interface PlayerState {
  x: number;
  y: number;
  angle: number;
}

test.describe('DOOM — keyboard routing (arrows reach player, not viewport)', () => {
  // Cold-start WASM init + 4 MB WAD fetch + menu nav + the per-keypress
  // delays add up; bump the per-test budget.
  test.setTimeout(180_000);

  test('arrow keys move the player in-game (verified via player.x/y/angle delta)', async ({
    page,
  }) => {
    page.on('pageerror', (e) => console.error('pageerror:', e.message));

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    const skip = await assetsMissing(page);
    if (skip) {
      test.skip(true, skip);
      return;
    }

    await spawnPatch(page, [
      { id: 'v-doom', type: 'doom', position: { x: 200, y: 120 }, domain: 'video' },
    ]);

    const card = page.locator('[data-testid="doom-card"]');
    await expect(card, 'DOOM card mounts').toHaveCount(1);

    // Boot the runtime via the "Click to load DOOM" overlay button.
    const loadBtn = card.locator('button.overlay').filter({ hasText: 'Click to load DOOM' });
    await expect(loadBtn).toBeVisible();
    await loadBtn.click();
    await expect(card.locator('.overlay'), 'load overlay clears').toHaveCount(0, {
      timeout: 30_000,
    });

    // Click to select + focus the card (SF marks it .selected; the card's
    // onclick handler calls cardEl.focus()).
    await card.click();
    await expect(
      page.locator('.svelte-flow__node[data-id="v-doom"].selected'),
      'card becomes the selected SF node after click',
    ).toHaveCount(1);

    // Walk the title-screen menu into actual gameplay:
    //   Enter → exits the demo loop into the main menu
    //   Enter → "New Game"
    //   Enter → skill picker (default = "I'm too young to die")
    //   Enter → confirms skill, drops us into E1M1
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
    }

    // Wait for the player mobj to actually spawn into the level (E1M1
    // loads asynchronously after the skill picker). hasPlayerMobj()
    // flips true once the player thinker has placed the mobj on the map.
    await page.waitForFunction(
      () => {
        const w = globalThis as unknown as {
          __engine?: () => {
            getDomain?: (d: string) => {
              read?: (id: string, k: string) => unknown;
            } | null;
          } | null;
        };
        const ve = w.__engine?.()?.getDomain?.('video');
        const extras = ve?.read?.('v-doom', 'extras') as {
          getRuntime?: () => { hasPlayerMobj?: () => boolean } | null;
        } | undefined;
        return extras?.getRuntime?.()?.hasPlayerMobj?.() === true;
      },
      { timeout: 30_000 },
    );

    // Helper to snapshot player state from the runtime.
    async function readPlayerState(): Promise<PlayerState> {
      const state = await page.evaluate(() => {
        const w = globalThis as unknown as {
          __engine?: () => {
            getDomain?: (d: string) => {
              read?: (id: string, k: string) => unknown;
            } | null;
          } | null;
        };
        const ve = w.__engine?.()?.getDomain?.('video');
        const extras = ve?.read?.('v-doom', 'extras') as {
          getRuntime?: () => {
            getPlayerState?: () => { x: number; y: number; angle: number } | null;
          } | null;
        } | undefined;
        return extras?.getRuntime?.()?.getPlayerState?.() ?? null;
      });
      if (!state) throw new Error('runtime.getPlayerState() returned null — no level loaded');
      return state;
    }

    const nodeWrapper = page.locator('.svelte-flow__node[data-id="v-doom"]');
    const viewport = page.locator('.svelte-flow__viewport');

    // -------- ArrowUp: forward movement --------
    //
    // Sample player state before + after holding ArrowUp ~1s. The exact
    // movement axis (x vs y) depends on the player's spawn-facing angle
    // on E1M1; the player starts facing east (angle = 0), so forward
    // movement increments x. We assert |dx| + |dy| > threshold rather
    // than pinning to a specific axis, so the test isn't fragile to
    // map-specific spawn angles.

    const transformBefore = await readTransform(nodeWrapper);
    const viewportBefore = await readTransform(viewport);
    const before = await readPlayerState();

    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(1200);
    await page.keyboard.up('ArrowUp');
    await page.waitForTimeout(300);

    const transformAfterUp = await readTransform(nodeWrapper);
    const viewportAfterUp = await readTransform(viewport);
    const afterUp = await readPlayerState();

    expect(
      transformAfterUp,
      `card moved on canvas after ArrowUp (${transformBefore} → ${transformAfterUp}). ` +
        `SvelteFlow stole the arrow key instead of DOOM consuming it.`,
    ).toBe(transformBefore);

    expect(
      viewportAfterUp,
      `canvas zoom/pan changed after ArrowUp (${viewportBefore} → ${viewportAfterUp}). ` +
        `Some part of the canvas chrome received the key.`,
    ).toBe(viewportBefore);

    const dxUp = Math.abs(afterUp.x - before.x);
    const dyUp = Math.abs(afterUp.y - before.y);
    const movedDistance = dxUp + dyUp; // Manhattan distance in fixed-point map units (16.16).
    // Forward walk speed on Doom's lowest skill is ~25 map units/sec
    // (the player's forwardmove[0] = 25 with frictionless start). Over
    // ~1.2 s that's ~30 units → 30 << 16 = ~1.97 M raw fixed-point units.
    // Threshold of 100,000 fixed-point units (~1.5 map units) is well above
    // any noise/jitter from the spawn animation but well below real walk.
    expect(
      movedDistance,
      `ArrowUp produced no player movement (|dx|+|dy| = ${movedDistance} fixed-point units, ` +
        `before=(${before.x}, ${before.y}), after=(${afterUp.x}, ${afterUp.y})). ` +
        `The doomkey was either lost en route OR mis-decoded inside the WASM. ` +
        `Check doomgeneric_patchtogether.c → dgpt_set_key / DG_GetKey: KEY_UPARROW (0xad) ` +
        `must round-trip the full 8 bits; the original "& 0x7f" mask aliased it to ` +
        `KEY_MINUS (0x2d) and shrunk the screen instead of moving forward.`,
    ).toBeGreaterThan(100_000);

    // -------- ArrowLeft: turn left (angle increases per DOOM convention) --------

    const beforeL = await readPlayerState();
    const tBeforeL = await readTransform(nodeWrapper);
    const vBeforeL = await readTransform(viewport);
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(800);
    await page.keyboard.up('ArrowLeft');
    await page.waitForTimeout(300);
    const afterL = await readPlayerState();
    const tAfterL = await readTransform(nodeWrapper);
    const vAfterL = await readTransform(viewport);

    expect(tAfterL, `card moved on canvas after ArrowLeft`).toBe(tBeforeL);
    expect(vAfterL, `canvas zoom changed after ArrowLeft`).toBe(vBeforeL);

    // angle is angle_t (uint32 — modular). Use unsigned-mod arithmetic.
    const angleDeltaL = angleDelta(beforeL.angle, afterL.angle);
    expect(
      Math.abs(angleDeltaL),
      `ArrowLeft produced no facing-angle change (Δangle = ${angleDeltaL}). ` +
        `before=${beforeL.angle} after=${afterL.angle}`,
    ).toBeGreaterThan(50_000_000);

    // -------- ArrowRight: turn right (angle decreases) --------

    const beforeR = await readPlayerState();
    const tBeforeR = await readTransform(nodeWrapper);
    const vBeforeR = await readTransform(viewport);
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(800);
    await page.keyboard.up('ArrowRight');
    await page.waitForTimeout(300);
    const afterR = await readPlayerState();
    const tAfterR = await readTransform(nodeWrapper);
    const vAfterR = await readTransform(viewport);

    expect(tAfterR, `card moved on canvas after ArrowRight`).toBe(tBeforeR);
    expect(vAfterR, `canvas zoom changed after ArrowRight`).toBe(vBeforeR);

    const angleDeltaR = angleDelta(beforeR.angle, afterR.angle);
    expect(
      Math.abs(angleDeltaR),
      `ArrowRight produced no facing-angle change (Δangle = ${angleDeltaR}). ` +
        `before=${beforeR.angle} after=${afterR.angle}`,
    ).toBeGreaterThan(50_000_000);
    // Left + right should be opposite directions.
    expect(
      Math.sign(angleDeltaL) === -Math.sign(angleDeltaR),
      `ArrowLeft and ArrowRight should turn in opposite directions ` +
        `(Δleft=${angleDeltaL} Δright=${angleDeltaR})`,
    ).toBe(true);

    // -------- ArrowDown: backward movement --------

    const beforeD = await readPlayerState();
    await page.keyboard.down('ArrowDown');
    await page.waitForTimeout(800);
    await page.keyboard.up('ArrowDown');
    await page.waitForTimeout(300);
    const afterD = await readPlayerState();
    const movedDistanceD = Math.abs(afterD.x - beforeD.x) + Math.abs(afterD.y - beforeD.y);
    expect(
      movedDistanceD,
      `ArrowDown produced no player movement (|dx|+|dy| = ${movedDistanceD}). ` +
        `before=(${beforeD.x}, ${beforeD.y}), after=(${afterD.x}, ${afterD.y}).`,
    ).toBeGreaterThan(50_000);
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
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    const skip = await assetsMissing(page);
    if (skip) {
      test.skip(true, skip);
      return;
    }

    await spawnPatch(page, [
      { id: 'v-doom', type: 'doom', position: { x: 200, y: 120 }, domain: 'video' },
    ]);
    const card = page.locator('[data-testid="doom-card"]');
    await expect(card, 'DOOM card mounts').toHaveCount(1);

    const loadBtn = card.locator('button.overlay').filter({ hasText: 'Click to load DOOM' });
    await expect(loadBtn).toBeVisible();
    await loadBtn.click();
    await expect(card.locator('.overlay'), 'load overlay clears').toHaveCount(0, {
      timeout: 30_000,
    });

    // Click latches keyboard control.
    await card.click();
    // Walk into E1M1.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
    }
    await page.waitForFunction(
      () => {
        const w = globalThis as unknown as {
          __engine?: () => { getDomain?: (d: string) => { read?: (id: string, k: string) => unknown } | null } | null;
        };
        const ve = w.__engine?.()?.getDomain?.('video');
        const extras = ve?.read?.('v-doom', 'extras') as {
          getRuntime?: () => { hasPlayerMobj?: () => boolean } | null;
        } | undefined;
        return extras?.getRuntime?.()?.hasPlayerMobj?.() === true;
      },
      { timeout: 30_000 },
    );

    async function readState(): Promise<PlayerState> {
      const s = await page.evaluate(() => {
        const w = globalThis as unknown as {
          __engine?: () => { getDomain?: (d: string) => { read?: (id: string, k: string) => unknown } | null } | null;
        };
        const ve = w.__engine?.()?.getDomain?.('video');
        const extras = ve?.read?.('v-doom', 'extras') as {
          getRuntime?: () => { getPlayerState?: () => { x: number; y: number; angle: number } | null } | null;
        } | undefined;
        return extras?.getRuntime?.()?.getPlayerState?.() ?? null;
      });
      if (!s) throw new Error('no player state');
      return s;
    }

    // SIMULATE SYNC CHURN: blur the focused card + strip the SF `.selected`
    // class, exactly what a multiplayer re-render does. Pre-fix this killed
    // capture; the latch must keep it alive.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      document
        .querySelector('.svelte-flow__node[data-id="v-doom"]')
        ?.classList.remove('selected');
    });
    await page.waitForTimeout(100);

    const before = await readState();
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(1000);
    await page.keyboard.up('ArrowUp');
    await page.waitForTimeout(200);
    const after = await readState();
    const moved = Math.abs(after.x - before.x) + Math.abs(after.y - before.y);
    expect(
      moved,
      `player did NOT move after a re-render churn (|dx|+|dy|=${moved}). The sticky ` +
        `keyboard latch should keep DOOM capturing keys even when focus / .selected drop.`,
    ).toBeGreaterThan(100_000);

    // Escape = explicit release. After it, a fresh key press must NOT move the
    // player (capture handed back).
    await page.keyboard.press('Escape');

    // Let residual momentum from the forward burst fully decay BEFORE we
    // measure the post-release press. The latched ArrowUp built up player
    // momentum; DOOM friction decays it over ~1s of *game tics*, but the
    // runtime advances tics on the rAF clock — which CI throttles into bursts,
    // so the decay lurches forward well after the key is up. Measuring a fixed
    // 800ms window right after Esc therefore catches leftover slide (~0.5–1M
    // units), not key routing, and flakes. Instead poll until the marine is
    // STATIONARY (two consecutive ~stable samples), which isolates "does a new
    // key after Esc move the player" from momentum. If forward were genuinely
    // STUCK (a real release bug) the marine would never settle and this loop
    // times out — so this can't mask a real bug, only the momentum confound.
    const STILL = 8_000; // < 0.13 map units between samples == settled
    let prev = await readState();
    const settleDeadline = Date.now() + 8_000;
    let settled = false;
    while (Date.now() < settleDeadline) {
      await page.waitForTimeout(150);
      const cur = await readState();
      const delta = Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y);
      prev = cur;
      if (delta < STILL) {
        settled = true;
        break;
      }
    }
    expect(
      settled,
      `player never stopped moving after Escape — forward momentum should decay ` +
        `and DOOM should stop consuming keys once the latch is released.`,
    ).toBe(true);

    const beforeRelease = await readState();
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(800);
    await page.keyboard.up('ArrowUp');
    await page.waitForTimeout(200);
    const afterRelease = await readState();
    const movedAfterEsc =
      Math.abs(afterRelease.x - beforeRelease.x) + Math.abs(afterRelease.y - beforeRelease.y);
    expect(
      movedAfterEsc,
      `player moved after Escape released the latch (|dx|+|dy|=${movedAfterEsc}). ` +
        `Escape should hand the keyboard back so DOOM stops consuming keys.`,
    ).toBeLessThan(100_000);
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

// DOOM's angle_t is a uint32 representing angle as 2^32 = full rotation.
// Compute the SHORTEST signed delta (handles wrap-around) so a turn of
// just-past-zero doesn't show as a near-360° turn.
function angleDelta(before: number, after: number): number {
  // Both inputs are in [0, 2^32). JS bitwise ops would force into 32-bit
  // signed; use plain modular subtraction in floating point and re-center
  // into (-2^31, 2^31].
  const TWO32 = 4_294_967_296;
  let d = after - before;
  if (d > TWO32 / 2) d -= TWO32;
  if (d < -TWO32 / 2) d += TWO32;
  return d;
}
