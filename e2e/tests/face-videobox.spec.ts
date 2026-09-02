// e2e/tests/face-videobox.spec.ts
//
// THE VIDEOBOX FACE, driven for real on the DEFAULT shell — the seams no other
// gate can see.
//
// ⚠ THE FILENAME IS LOAD-BEARING — NOT `videobox-face.spec.ts` or any
// `videobox-*` name. `e2e/webgl-heavy-globs.ts` classifies by PREFIX
// (`**/videobox-*.spec.ts`), so a spec named after the module would be swept
// into the WebGL-HEAVY lane, which is EXCLUDED from the sharded e2e matrix and
// skipped by the attest job whenever the hash is unchanged — i.e. it would run
// NOWHERE in PR CI, green forever (the `node-source-videobox.spec.ts` header
// records the incident). Nothing here is WebGL-heavy: it reads DOM facts, graph
// state and a media clock, and samples no pixels.
//
// `videobox-face-model.test.ts` pins the ranking, the cell kind, the
// noUserControl declaration, the shader's `uGain` read, the verbatim picker
// port and every other source-level claim the face makes.
// `face-rack-status-source.test.ts` proves the body declares what it paints.
// `video-face-screen-source.test.ts` proves the body OWNS a screen switch, and
// `face-screen-render-4.spec.ts` (the shared suite) drives that switch.
// `collapse-keeps-playing.spec.ts` + `node-source-videobox.spec.ts` own the
// "keeps playing with no surface" P0. `workflow-shell-faces` photographs the
// plate. None of them can see:
//
//  1. ⚠ THAT A FILE CAN BE LOADED AND PLAYED AT ALL UNDER THE SHELL. This is
//     the whole practical argument for the promotion and it is a RENDER fact:
//     videobox left `DOM_SOURCE_LANE_TYPES` in LEG-02 P1 (#1511), so unlike
//     camera or loopback there is no `<HeadlessSourceHost>` keeping an
//     off-screen card around — with the face declared and no body mounted
//     there would be no picker and no transport on ANY surface. So this file
//     asserts the legacy card is absent AND a file still loads and plays.
//  2. THAT THE BODY BLITS RATHER THAN ADOPTS while a file is PLAYING in an
//     OPEN dock — the one-parent constraint, in the exact arrangement where
//     breaking it is tempting. (collapse-keeps-playing's placement leg covers
//     the sweep's members generically; this is the module's own leg.)
//  3. THAT THE DELETED READOUT SURVIVED THE MOVE. The card's `0:04 / 2:00`
//     line is deleted from the face; the position must survive on the seek
//     slider (value + aria-valuetext), and nothing may paint the time as a
//     resting text node.
//  4. THAT SCREEN OFF IS NOT A PAUSE. The switch reclaims the preview's
//     space; the FILE must keep playing while the canvas is gone.

import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

/** The LONG fixture (#1577): 120 s of low-bitrate synthetic video, so the
 *  clip's end is unreachable inside this spec's bounds. Same file
 *  `collapse-keeps-playing` and `node-source-videobox` use, for the same
 *  reason. */
const FIXTURE = fileURLToPath(new URL('../fixtures/lobby-clip-long.webm', import.meta.url));

/** Post-toggle observation window (a CAP on the failure, not the gate — the
 *  gate is accumulated forward progress, measured in-page). */
const OBSERVE_MS = 3_000;
/** Forward seconds of media that must accumulate in that window. Well under
 *  `OBSERVE_MS` so a slow SwiftShader runner has headroom. */
const MIN_PROGRESS_S = 0.4;

async function boot(page: Page): Promise<void> {
  // Plain /rack — the DEFAULT shell. The legacy specs' `?shell=legacy` is
  // precisely the surface promotion does not change.
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

/** Where the node-owned <video> lives and whether it plays — read off the DOM
 *  document-wide, because for a faced module the element is PARKED, never in
 *  the pane. */
async function mediaState(page: Page) {
  return await page.evaluate(() => {
    const v = document.querySelector('video[data-testid="videobox-video"]') as HTMLVideoElement | null;
    if (!v) return null;
    return {
      hasSrc: !!(v.currentSrc || v.getAttribute('src')),
      paused: v.paused,
      currentTime: v.currentTime,
      where: v.closest('[data-testid="dock-full-view"]')
        ? 'dock'
        : v.closest('[data-testid="node-media-parking"]')
          ? 'parking'
          : 'elsewhere',
    };
  });
}

/** Accumulate wrap-safe, seek-proof forward playback progress IN THE PAGE —
 *  never a Playwright-side poll of the thread under measurement (the
 *  node-source-videobox instrument, verbatim shape). */
async function measureProgress(page: Page, ms: number) {
  return await page.evaluate(async (windowMs) => {
    const el = document.querySelector('video[data-testid="videobox-video"]') as HTMLVideoElement | null;
    if (!el) return { progressS: -1, samples: 0, elapsedMs: 0, reason: 'no element' };
    let progress = 0;
    let samples = 0;
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
        // WRAP-SAFE: backwards credits nothing. SEEK-PROOF: forward is
        // credited only up to what playback could produce in dt.
        if (delta > 0) progress += Math.min(delta, (dtMs / 1000) * rate);
        samples++;
        prevT = t; prevMs = nowMs;
        if (nowMs - startMs >= windowMs) { clearInterval(iv); resolve(); }
      }, 100);
    });
    return { progressS: progress, samples, elapsedMs: performance.now() - startMs, reason: '' };
  }, ms);
}

/** Load the fixture through the FACE body's own input and press its Play. */
async function loadAndPlay(page: Page, body: ReturnType<Page['locator']>): Promise<void> {
  await body.locator('[data-testid="videobox-file-input"]').setInputFiles(FIXTURE);
  await expect(body.locator('[data-testid="videobox-face-body"]').first())
    .toHaveAttribute('data-has-local-file', 'true', { timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await body.locator('[data-testid="videobox-play-btn"]').click();
  // Genuine playback, in-page: the media clock moves off zero.
  await page.waitForFunction(
    () => {
      const v = document.querySelector('video[data-testid="videobox-video"]') as HTMLVideoElement | null;
      return !!v && !v.paused && v.currentTime > 0.05;
    },
    undefined,
    { timeout: SLOW_BOOT_TEST_TIMEOUT_MS },
  );
}

test.describe('VIDEOBOX face — the promotion is what makes it loadable', () => {
  // ⚠ A PAGE ERROR FAILS EVERY TEST IN THIS FILE. A TypeError inside a
  // `$derived` does not surface as a thrown assertion — it takes the subtree's
  // render down and the symptom lands somewhere else entirely (the
  // tv-librarian-face incident, twice).
  test.beforeEach(({ page }) => {
    page.on('pageerror', (err) => {
      throw new Error(`uncaught page error during a videobox face test: ${err.message}`);
    });
  });

  test('the shell replaces the card, and the face still LOADS and PLAYS a file @video', async ({ page }) => {
    // Serialises the dock's lazy body chunk plus a real webm decode behind the
    // boot — bounded from the one export site, never a flat literal.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await spawnPatch(page, [{ id: 'fvb1', type: 'videobox', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });

    // ⚠ THE PRECONDITION THIS WHOLE FILE RESTS ON: on the default shell no
    // videobox card is mounted anywhere — not in the lane, not in a headless
    // host (videobox left DOM_SOURCE_LANE_TYPES in LEG-02 P1). If this ever
    // finds a card, the rest proves nothing about the face.
    await expect(page.locator('[data-testid="videobox-card"]')).toHaveCount(0);

    const dock = await openDock(page, 'fvb1');
    const body = dock.locator('[data-testid="videobox-face-body"]');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // Nothing loaded: the drop-hint names this surface's own condition, and
    // the seek thumb has nothing to move over.
    await expect(body.locator('[data-testid="videobox-drop-hint"]')).toBeVisible();
    await expect(body.locator('[data-testid="videobox-seek"]')).toBeDisabled();

    await loadAndPlay(page, dock);

    // The loaded file's identity is painted as the row's own caption…
    await expect(body.locator('[data-testid="videobox-filename"]')).toContainText('lobby-clip-long');
    // …and the deleted readout STAYS deleted: no `videobox-time` anywhere, on
    // either surface, with the position surviving on the slider itself.
    await expect(page.locator('[data-testid="videobox-time"]')).toHaveCount(0);
    const seek = body.locator('[data-testid="videobox-seek"]');
    await expect(seek).toBeEnabled();
    await expect(seek).toHaveAttribute('aria-valuetext', / of /);
    await expect
      .poll(async () => Number(await seek.inputValue()), {
        message: 'the seek thumb tracks the playing clock (media s)',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBeGreaterThan(0.05);

    // ⚠ LEG 2 — BLIT, NEVER ADOPT, measured in the arrangement where adoption
    // is tempting: a file PLAYING while THIS module's dock pane is OPEN. The
    // node-owned element must be parked, not inside the pane, and the pane's
    // picture must be the body's own canvas.
    const media = await mediaState(page);
    expect(media, 'the node-owned <video> exists and holds the file').not.toBeNull();
    expect(media!.hasSrc).toBe(true);
    expect(
      media!.where,
      'the face body must BLIT the engine output — the node-owned <video> has ONE parent ' +
        '(the legacy card adopts it under ?shell=legacy) and must stay PARKED under the shell',
    ).toBe('parking');
    await expect(body.locator('[data-testid="videobox-face-canvas"]')).toBeVisible();

    // The transport reflects the shared multiplayer state, not a local mirror.
    await expect(body.locator('[data-testid="videobox-play-btn"]')).toHaveText('Pause');
    await expect(body.first()).toHaveAttribute('data-is-playing', 'true');
  });

  test('SCREEN OFF collapses the picture and does NOT pause the file @video', async ({ page }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await spawnPatch(page, [{ id: 'fvb2', type: 'videobox', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });
    const dock = await openDock(page, 'fvb2');
    const body = dock.locator('[data-testid="videobox-face-body"]');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await loadAndPlay(page, dock);

    const toggle = body.locator('[data-testid="videobox-face-screen-toggle"]');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // ⚠ COLLAPSE FIRST, THEN MEASURE — asserting "still playing" before the
    // toggle would pass on a switch that pauses, because the pre-toggle state
    // also plays. The canvas is REMOVED (space reclaimed), and the media
    // clock must then still accumulate forward progress.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(body.locator('[data-testid="videobox-face-canvas"]')).toHaveCount(0);

    const rec = await measureProgress(page, OBSERVE_MS);
    expect(
      rec.progressS,
      `forward playback progress with the SCREEN off: ${rec.progressS.toFixed(3)} s over ` +
        `${rec.samples} samples / ${rec.elapsedMs.toFixed(0)} ms. Units: SECONDS of media time, ` +
        'wrap-safe and seek-proof. A zero here means the SCREEN switch became a pause — the ' +
        'exact mute the 2026-08-18 ruling forbids.',
    ).toBeGreaterThan(MIN_PROGRESS_S);

    // It comes back, and it comes back LIVE.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(body.locator('[data-testid="videobox-face-canvas"]')).toBeVisible();
  });
});
