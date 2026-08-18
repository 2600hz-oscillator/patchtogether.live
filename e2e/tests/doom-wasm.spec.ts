// e2e/tests/doom-wasm.spec.ts
//
// ⚠ DOOM SPECS ARE NORMALLY OFF-LIMITS — the standing owner ruling is
//   "do not fuck with doom in any way without specific approval". This file's
//   frame-difference probe was rewritten under a SPECIFIC approval given by
//   the owner on 2026-08-18, verbatim:
//     "okay see if you can go make the doom tests blurrier and less flakey,
//      just knowing doom renders and our kb logic and basic game nav works
//      is fine"
//   That approval covers THE SPECS ONLY — not video/modules/doom.ts, not the
//   WASM/WAD assets, not the netcode. See #1848 and e2e/tests/_doom-helpers.ts.
//
// This file is the owner's FIRST named property — "doom renders" — so it is
// the one place where blurring most risks producing a green light wired to
// nothing. Two things guard against that, both permanent legs below:
// the frame must not be BLACK at every sampled pixel, and the probe must
// report how many frames it actually looked at (a max-diff of 0 from a probe
// that never sampled is "never looked", not "frozen", and the two are
// indistinguishable from the number alone).
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

    await page.goto('/rack?shell=legacy&seed=none');
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

    // ── DOOM RENDERS: a non-black frame arrives, and the frame CHANGES ─────
    //
    // Was: wait 2500 ms for the title-pause to end, then compare two samples
    // 800 ms apart, up to 4 times. Every one of those numbers is a bet on how
    // many FRAMES land in a wall-clock window — and here a frame is a game tic,
    // so the whole probe was a different assertion on every renderer. Worse,
    // the samples were taken from the PLAYWRIGHT side: ~1 MB across the CDP
    // boundary per sample, on the same main thread as the thing being measured,
    // and blind to every frame between two samples.
    //
    // Now: ONE page-side rAF probe accumulates the largest per-frame difference
    // against a reference frame, so it SEES EVERY PAINTED FRAME, and the test
    // polls that accumulator. The title-pause needs no special handling — the
    // poll simply waits through it.
    await installFrameProbe(page);

    // The probe must actually be looking. A max-diff of 0 from a probe that
    // never ran is "never looked", not "frozen".
    await expect
      .poll(async () => (await readFrameProbe(page)).frames, {
        timeout: 20_000,
        message:
          'the page-side frame probe never sampled a frame — its later verdict, ' +
          'whatever it is, would be vacuous.',
      })
      .toBeGreaterThan(3);

    // NEGATIVE CONTROL (permanent): the frame is not BLACK at every sampled
    // pixel. Without it, "the canvas changed" is satisfied by a canvas
    // flickering between two shades of nothing — the repo's documented
    // "unwired LAYER INPUT passing on a dead canvas" failure.
    const seen = await readFrameProbe(page);
    expect(
      seen.nonZeroBytes,
      `every sampled pixel of the DOOM canvas is BLACK (${seen.frames} frames, ` +
        `${Math.round(seen.elapsedMs)}ms). That is a dead or cleared canvas, not a ` +
        `rendered DOOM frame — and the "it changed" assertion below would pass on ` +
        `one anyway.`,
    ).toBeGreaterThan(0);

    // THE VERDICT: the framebuffer is actively repainting. Polled, so the
    // renderer sets the duration and never the outcome. 1000 differing sampled
    // bytes is well above 1-pixel noise and well below a scene cut — the demo
    // loop's quietest frames (status-bar face, breath sway, weapon bob) clear
    // it easily and a frozen title card cannot.
    await expect
      .poll(async () => (await readFrameProbe(page)).maxDiff, {
        timeout: 60_000,
        intervals: [250, 500, 1000],
        message:
          'the DOOM canvas never changed by more than a pixel or two. The runtime ' +
          "froze or the rAF blit loop isn't running; if it were the \"WASM not " +
          'built" overlay path, the pre-flight asserts above would have fired first.',
      })
      .toBeGreaterThan(1000);

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

/** What the page-side frame probe has seen since it was installed. */
interface FrameProbe {
  /** Largest number of differing sampled bytes against the reference frame. */
  maxDiff: number;
  /** Frames the probe actually read (0 ⇒ its verdict is vacuous). */
  frames: number;
  /** Sampled bytes that were non-zero in any observed frame (0 ⇒ black). */
  nonZeroBytes: number;
  /** Wall-clock the probe has been running, ms. */
  elapsedMs: number;
}

/**
 * Install ONE rAF-paced probe INSIDE the page that fingerprints every painted
 * frame against a reference.
 *
 * ⚠ This is an INSTRUMENT fix, not a threshold fix. The old sampler shipped
 * ~1 MB of pixels across the CDP boundary per sample, on the SAME MAIN THREAD
 * as the renderer it was measuring, and could only ever see the two frames it
 * happened to grab. CLAUDE.md names that exact shape: never sample a page-side
 * quantity with a Playwright-side poll loop — move the accumulator into the
 * page and report frames/elapsedMs alongside the value.
 *
 * Only the RED byte of every 4th pixel is compared (skip alpha, which the card
 * always writes 255) — enough signal for a flicker without walking a megabyte
 * twice per frame.
 */
async function installFrameProbe(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __doomFrameProbe?: { maxDiff: number; frames: number; nonZeroBytes: number; t0: number };
      __doomFrameProbeStop?: () => void;
    };
    w.__doomFrameProbeStop?.();
    const state = { maxDiff: 0, frames: 0, nonZeroBytes: 0, t0: performance.now() };
    w.__doomFrameProbe = state;
    let ref: Uint8ClampedArray | null = null;
    let raf = 0;
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      const cv = document.querySelector('[data-testid="doom-canvas"]') as HTMLCanvasElement | null;
      const ctx = cv?.getContext('2d');
      if (!cv || !ctx || cv.width === 0 || cv.height === 0) return;
      const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
      state.frames++;
      let nonZero = 0;
      for (let i = 0; i < data.length; i += 16) if (data[i] !== 0) nonZero++;
      if (nonZero > state.nonZeroBytes) state.nonZeroBytes = nonZero;
      if (!ref) {
        ref = new Uint8ClampedArray(data);
        return;
      }
      let diff = 0;
      const n = Math.min(ref.length, data.length);
      for (let i = 0; i < n; i += 4) if (ref[i] !== data[i]) diff++;
      if (diff > state.maxDiff) state.maxDiff = diff;
    };
    raf = requestAnimationFrame(tick);
    w.__doomFrameProbeStop = () => cancelAnimationFrame(raf);
  });
}

/** Read the probe without disturbing it. */
async function readFrameProbe(page: import('@playwright/test').Page): Promise<FrameProbe> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as {
      __doomFrameProbe?: { maxDiff: number; frames: number; nonZeroBytes: number; t0: number };
    };
    const s = w.__doomFrameProbe;
    if (!s) return { maxDiff: -1, frames: 0, nonZeroBytes: -1, elapsedMs: 0 };
    return {
      maxDiff: s.maxDiff,
      frames: s.frames,
      nonZeroBytes: s.nonZeroBytes,
      elapsedMs: performance.now() - s.t0,
    };
  });
}
