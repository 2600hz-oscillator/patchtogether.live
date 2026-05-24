// e2e/tests/doom-keyboard-routing.spec.ts
//
// Regression test for the "arrow keys move the DOOM card on the canvas
// instead of the player in-game" bug. The fix is a window-level capture-
// phase keydown/keyup listener in DoomCard.svelte that runs BEFORE
// SvelteFlow's document-level node-keyboard-move handler — when the
// DOOM card is focused/selected, it preventDefault + stopPropagation +
// routes the key to the runtime.
//
// What this spec asserts (all must hold for a single keypress burst):
//
//   1. After spawning DOOM + selecting the card, the card's on-canvas
//      position (the .svelte-flow__node[data-id="v-doom"] CSS transform)
//      does NOT change when arrow keys are pressed. Before the fix,
//      SvelteFlow's arrow-key-to-move handler shifted the node by 5px
//      per press.
//   2. The visible <canvas data-testid="doom-canvas"> framebuffer DOES
//      change in the same window — proving the key reached the runtime
//      and the player actually moved/turned in-game.
//   3. SvelteFlow's zoom is unchanged (no F11-style viewport shrink).
//
// We exercise three arrow keys (Up = move forward, Left/Right = turn)
// so a single broken mapping doesn't slip through.
//
// Cold-start cost: the spec needs the WASM blob + the shareware WAD on
// the dev server. If either is missing (`/doom/doom.js` 404 or `/doom/
// DOOM1.WAD` 404) the test skips with a diagnostic — same gating pattern
// as doom-multiplayer.spec.ts.

import { test, expect, type Page, type Locator } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('DOOM — keyboard routing (arrows reach game, not canvas)', () => {
  // Cold-start WASM init + 4 MB WAD fetch + menu nav + the per-keypress
  // delays add up; bump the per-test budget.
  test.setTimeout(120_000);

  test('arrow keys move the player in-game, not the card on the canvas', async ({ page }) => {
    page.on('pageerror', (e) => console.error('pageerror:', e.message));

    await page.goto('/');
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

    // Boot the runtime via the "Click to load DOOM" overlay button —
    // same UX path the user takes.
    const loadBtn = card.locator('button.overlay').filter({ hasText: 'Click to load DOOM' });
    await expect(loadBtn).toBeVisible();
    await loadBtn.click();
    await expect(card.locator('.overlay'), 'load overlay clears').toHaveCount(0, {
      timeout: 30_000,
    });

    // Click the card to give it focus + selection. SvelteFlow's
    // single-click selects the node (adds .selected to the wrapper);
    // the card's onclick also calls cardEl.focus().
    await card.click();
    await expect(
      page.locator('.svelte-flow__node[data-id="v-doom"].selected'),
      'card becomes the selected SF node after click',
    ).toHaveCount(1);

    // Navigate the title-screen menu into actual gameplay:
    //   Enter → exits the demo loop into the main menu
    //   Enter → "New Game"
    //   Enter → skill picker default ("I'm too young to die" is the
    //           top entry; the menu highlights it by default)
    //   Enter → confirms skill, drops us into E1M1
    //
    // We sleep a bit between presses so doomgeneric's menu state
    // machine actually processes the input. The runtime ticks at 35 Hz
    // (vanilla DOOM PageTic = 1000/35 ms); 250 ms is ~9 tics, plenty.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
    }
    // Let the level finish loading + the player view settle.
    await page.waitForTimeout(1500);

    const nodeWrapper = page.locator('.svelte-flow__node[data-id="v-doom"]');
    const viewport = page.locator('.svelte-flow__viewport');

    const transformBefore = await readTransform(nodeWrapper);
    const viewportBefore = await readTransform(viewport);
    const frameBefore = await sampleCanvas(card.locator('[data-testid="doom-canvas"]'));

    // Hold ArrowUp for ~1s — move the player forward. Use a hold rather
    // than discrete presses so the runtime sees a sustained key-down
    // event (forward movement accumulates per-tic).
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(1000);
    await page.keyboard.up('ArrowUp');
    // Tic out so the framebuffer reflects the up-arrow's last frame.
    await page.waitForTimeout(300);

    const transformAfterUp = await readTransform(nodeWrapper);
    const viewportAfterUp = await readTransform(viewport);
    const frameAfterUp = await sampleCanvas(card.locator('[data-testid="doom-canvas"]'));

    expect(
      transformAfterUp,
      `card moved on canvas after ArrowUp — was ${transformBefore}, now ${transformAfterUp}. ` +
        `SvelteFlow's node-keyboard-move stole the key instead of DOOM consuming it.`,
    ).toBe(transformBefore);

    expect(
      viewportAfterUp,
      `canvas zoom/pan changed after ArrowUp — was ${viewportBefore}, now ${viewportAfterUp}. ` +
        `Some part of the canvas chrome (SF pan/zoom shortcut, viewport-shrink, etc.) ` +
        `received the key instead of DOOM.`,
    ).toBe(viewportBefore);

    const upDiff = countDiffBytes(frameBefore, frameAfterUp);
    expect(
      upDiff,
      `ArrowUp produced no framebuffer change (${upDiff} byte diff) — runtime didn't ` +
        `receive the keypress. Without the capture-phase listener, this is the ` +
        `failure mode the user reported: card slides on canvas, game never moves.`,
    ).toBeGreaterThan(500);

    // Now do the same with ArrowLeft + ArrowRight (turn left, turn
    // right). Same assertions: card on canvas doesn't move, framebuffer
    // changes (different view direction). The turn-rate threshold is
    // intentionally lower than the forward-move one: turning rotates the
    // view a few degrees and only changes a small slice of the visible
    // framebuffer (the new wall edge that rotated into view + the
    // status-bar's face direction indicator), whereas forward movement
    // shifts the entire scene's parallax.
    //
    // Sample-pair retry: a single hold-release-sample cycle can race the
    // rAF blit loop (the card's 2D-canvas mirror updates at 60 Hz; if we
    // sample right at the end of a key repeat we can catch a frame that
    // happens to be near-identical to "before"). Retry up to 4× and keep
    // the largest diff — the goal is "key reached runtime", not exact
    // pixel-count reproducibility.
    for (const key of ['ArrowLeft', 'ArrowRight'] as const) {
      const tBefore = await readTransform(nodeWrapper);
      const vBefore = await readTransform(viewport);

      let bestDiff = 0;
      for (let attempt = 0; attempt < 4 && bestDiff < 100; attempt++) {
        // Re-focus + re-click the card each attempt — if anything stole
        // focus between iterations (rAF tick repaint, etc.) the selection
        // class is still on the SF node wrapper but we want to be sure.
        await card.click();
        const fBefore = await sampleCanvas(card.locator('[data-testid="doom-canvas"]'));
        await page.keyboard.down(key);
        await page.waitForTimeout(1200);
        await page.keyboard.up(key);
        await page.waitForTimeout(400);
        const fAfter = await sampleCanvas(card.locator('[data-testid="doom-canvas"]'));
        const diff = countDiffBytes(fBefore, fAfter);
        if (diff > bestDiff) bestDiff = diff;
      }

      const tAfter = await readTransform(nodeWrapper);
      const vAfter = await readTransform(viewport);

      expect(tAfter, `card moved on canvas after ${key}`).toBe(tBefore);
      expect(vAfter, `canvas zoom changed after ${key}`).toBe(vBefore);
      // Threshold 100 (vs 500 for ArrowUp): turning produces a tighter
      // pixel-diff than walking. The point of the assertion is "key
      // reached runtime" — any non-trivial diff is sufficient signal
      // (the broken path produces a 0 / single-digit diff because the
      // framebuffer keeps streaming gameplay but the player neither moves
      // nor turns).
      expect(
        bestDiff,
        `${key} produced no framebuffer change after 4 attempts (best diff ${bestDiff} bytes) — turn key didn't reach runtime`,
      ).toBeGreaterThan(100);
    }
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

interface CanvasFrame {
  bytes: Uint8Array;
  width: number;
  height: number;
}

async function sampleCanvas(canvasLoc: Locator): Promise<CanvasFrame> {
  const data = await canvasLoc.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const img = ctx.getImageData(0, 0, c.width, c.height);
    return { width: img.width, height: img.height, bytes: Array.from(img.data) };
  });
  if (!data) throw new Error('DOOM canvas: getContext("2d") returned null');
  return {
    bytes: new Uint8Array(data.bytes),
    width: data.width,
    height: data.height,
  };
}

function countDiffBytes(a: CanvasFrame, b: CanvasFrame): number {
  const n = Math.min(a.bytes.length, b.bytes.length);
  let diff = 0;
  // Sample every 4th byte (R channel) — skip alpha (always 255 on the
  // card's 2D blit). This is the same shape doom-wasm.spec.ts uses.
  for (let i = 0; i < n; i += 4) {
    if (a.bytes[i] !== b.bytes[i]) diff++;
  }
  return diff;
}
