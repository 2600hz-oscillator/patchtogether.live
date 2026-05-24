// e2e/tests/doom-wasm.spec.ts
//
// Asserts that the DOOM card renders real gameplay pixels — i.e. that
// CI built the emcc WASM blob + downloaded the shareware WAD, not just
// the "DOOM WASM not built" overlay. The test:
//
//   1. Spawns a DOOM module via the same __patch / __ydoc dev hook
//      everything else uses.
//   2. Clicks the "Click to load DOOM" overlay button.
//   3. Waits for the load to finish — either ready, or error (with a
//      diagnostic asserting the WASM is actually on disk).
//   4. Lets the rAF blit loop run for ~1.5 s so doomgeneric's title
//      sequence + demo loop has time to paint multiple distinct frames.
//   5. Samples the visible <canvas> pixels at two timepoints ~500 ms
//      apart and asserts the bytes differ — proving the framebuffer
//      is being actively updated rather than frozen at a placeholder.
//
// Why pixel-variance over a screenshot match: doomgeneric's title
// sequence is a deterministic animation, but Playwright's
// `toHaveScreenshot` would still be sensitive to anti-aliasing,
// rounding, and emcc version drift. A "two frames differ" assertion
// is a much weaker but more robust witness that "gameplay is running"
// — exactly what the spec is meant to cover.
//
// Coverage gap kept (deferred to slice 8): audio output. v1 ships
// the runtime with i_sound's null impl so audio_l/audio_r read 0.
// The skip stays in e2e/tests/per-module.spec.ts:SKIP_OUTPUT_ALIVE
// for `doom` until that slice lands.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

// Larger overall budget: cold-start of the WASM init + 4 MB WAD fetch +
// emscripten cache prime can take ~10–20 s on a CI runner. The
// per-expect timeouts inside still gate sensibly; this just keeps the
// overall test from racing the suite default.
test.describe('DOOM — WASM gameplay renders real pixels in CI', () => {
  test.setTimeout(90_000);

  test('canvas updates over time (proves WASM + WAD are loaded, not overlay)', async ({ page }) => {
    // Collect console + page errors so we can surface them on failure.
    // We tolerate a few benign ones (AudioContext autoplay warnings on
    // some Chromium revs); we'll filter those out before asserting.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Pre-flight: make sure /doom/doom.js exists on the dev server. If
    // not, the WASM build step was skipped or failed; bail with a
    // diagnostic before going through the spawn dance.
    const wasmShim = await page.request.get('/doom/doom.js');
    expect(
      wasmShim.ok(),
      `DOOM WASM shim not on dev server (status ${wasmShim.status()}). ` +
        `Run \`bash packages/web/native/build-doom-wasm.sh\` locally, or ` +
        `check the "Build DOOM WASM (emcc)" step in CI.`,
    ).toBe(true);

    const wadResp = await page.request.get('/doom/DOOM1.WAD');
    expect(
      wadResp.ok(),
      `DOOM1.WAD not on dev server (status ${wadResp.status()}). ` +
        `See packages/web/static/doom/DOWNLOAD_INSTRUCTIONS.md, or ` +
        `check the "Download DOOM1.WAD" step in CI.`,
    ).toBe(true);

    // Spawn just DOOM — no upstream needed, the runtime drives itself.
    await spawnPatch(page, [
      { id: 'v-doom', type: 'doom', position: { x: 200, y: 120 }, domain: 'video' },
    ]);

    const card = page.locator('[data-testid="doom-card"]');
    await expect(card, 'DOOM card mounts').toHaveCount(1);

    const canvas = page.locator('[data-testid="doom-canvas"]');
    await expect(canvas, 'DOOM canvas mounts').toHaveCount(1);

    // The card boots in `loadStatus === 'idle'` — a "Click to load DOOM"
    // overlay button covers the canvas until clicked. Click it to kick
    // off the WASM + WAD load path (avoids autoplay races; users do the
    // same thing manually).
    const loadBtn = card.locator('button.overlay').filter({ hasText: 'Click to load DOOM' });
    await expect(loadBtn, 'load-overlay button visible before click').toBeVisible();
    await loadBtn.click();

    // Wait for the load to settle (success or error). The overlay
    // changes class/text in either case; the simplest gate is "no
    // .overlay element remains visible". 25s budget covers a cold start
    // where the browser has to fetch the 4 MB WAD over the network.
    await expect(
      card.locator('.overlay'),
      'load overlay clears (either success or error → assertion below)',
    ).toHaveCount(0, { timeout: 25_000 });

    // If load errored, the card would show an .overlay.error block —
    // which the above expects to be gone. So at this point we should
    // be in the `loadStatus === 'ready'` state and the rAF blit loop
    // should be actively painting frames into the 2D canvas.

    // Let DOOM's title-demo settle into actively animating frames.
    // The demo opens with a static title patch (~2 s pagetic) before
    // playing back the demo lump, which DOES animate. Wait through the
    // title-pause window first so the two samples land on animating
    // content — sampling during the static title would give a 0 diff
    // and look like the runtime froze.
    await page.waitForTimeout(2500);

    // Sample-pair loop with a slightly longer window. Even on the
    // demo loop's quieter HUD frames we should see a per-pixel diff
    // of at least 1000 bytes (status-bar face animation, breath sway,
    // weapon bob — none of which the title-card has). 3 retries to
    // absorb the rare case where both samples land on demo-end and
    // next-loop frames that happen to be identical.
    let diffBytes = 0;
    let sampleA: CanvasSample | null = null;
    let sampleB: CanvasSample | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      sampleA = await sampleCanvas(page);
      expect(sampleA.bytesLen, 'canvas yielded image data').toBeGreaterThan(0);
      // Active wait so the rAF loop keeps painting. waitForTimeout
      // pauses test execution but doesn't pause the browser's rAF clock.
      await page.waitForTimeout(800);
      sampleB = await sampleCanvas(page);
      expect(sampleB.bytesLen, 'canvas yielded image data').toBeGreaterThan(0);
      diffBytes = countDiffBytes(sampleA.bytes, sampleB.bytes);
      if (diffBytes > 1000) break;
    }

    expect(
      diffBytes,
      `expected canvas to update across ~800ms windows (4 attempts) — ` +
        `only ${diffBytes} bytes differ on the last pair. If this is 0, ` +
        `the runtime froze or the rAF blit loop isn't running; if it's ` +
        `the "WASM not built" overlay path, the pre-flight asserts above ` +
        `would have fired first.`,
    ).toBeGreaterThan(1000);

    // Save the last frame as an artifact for triage.
    await canvas.screenshot({ path: 'test-results/doom-wasm-frame.png' });

    // Benign console noise we ignore in this test:
    //   - The autoplay-policy warning that Chromium emits even with
    //     --autoplay-policy=no-user-gesture-required (the flag covers
    //     gesture requirement, not the deprecation warning).
    //   - 404s for optional sprite/MP3 sidecars some Vite plugins try
    //     to fetch in dev — none affect DOOM specifically.
    const realErrors = errors.filter(
      (e) =>
        !e.includes('autoplay') &&
        !e.includes('AudioContext') &&
        !e.includes('favicon'),
    );
    expect(realErrors, `unexpected errors: ${realErrors.join(' | ')}`).toEqual([]);
  });
});

interface CanvasSample {
  bytes: Uint8Array;
  bytesLen: number;
  width: number;
  height: number;
}

async function sampleCanvas(page: import('@playwright/test').Page): Promise<CanvasSample> {
  const data = await page.locator('[data-testid="doom-canvas"]').evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const img = ctx.getImageData(0, 0, c.width, c.height);
    // Serialise the raw Uint8ClampedArray into a regular array of
    // numbers so it crosses the CDP boundary intact. ~1 MB per frame
    // — fine for two samples in a single test.
    return {
      width: img.width,
      height: img.height,
      bytes: Array.from(img.data),
    };
  });
  if (!data) throw new Error('DOOM canvas: getContext("2d") returned null');
  return {
    bytes: new Uint8Array(data.bytes),
    bytesLen: data.bytes.length,
    width: data.width,
    height: data.height,
  };
}

function countDiffBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  let diff = 0;
  // Skip alpha — the card always writes 255 there. Sample every 4th
  // byte starting from R; that's enough signal to detect even a tiny
  // flicker without iterating the full ~1 MB twice.
  for (let i = 0; i < n; i += 4) {
    if (a[i] !== b[i]) diff++;
  }
  return diff;
}
