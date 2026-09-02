// e2e/tests/face-videovarispeed.spec.ts
//
// VIDEOVARISPEED's faceplate — the acceptance test for the wave-4 promotion.
//
// ⚠ THE FILENAME IS LOAD-BEARING — NOT `videovarispeed-face.spec.ts` or any
// `videovarispeed-*` name. `e2e/webgl-heavy-globs.ts` classifies by PREFIX
// (`**/videovarispeed-*.spec.ts`), so a spec named after the module would be
// swept into the WebGL-HEAVY lane, which is EXCLUDED from the sharded e2e
// matrix and skipped by the attest job whenever the hash is unchanged — i.e. it
// would run NOWHERE in PR CI, green forever. `node-source-videovarispeed.spec.ts`
// records the incident that established the rule; `face-videobox.spec.ts` is
// the naming precedent this follows.
//
// ⚠ EVERY LEG RUNS ON THE DEFAULT SHELL, WITH NO CARD. That is not a variation
// on the existing videovarispeed specs — it is the surface those specs
// structurally cannot reach. Six of the seven pre-existing ones boot
// `?shell=legacy` (the surface promotion does not change), and the seventh
// asserts the CV path with nothing mounted. None of them can see the faceplate,
// so without this file the promotion would ship with the operated surface
// untested.
//
// WHAT THIS PROVES, in the order the legs run:
//
//   1. The shell REPLACES the card (count 0 on the default shell) and the face
//      still loads, plays, seeks and shows the clip — the "a promoted module
//      you cannot give a file to" failure.
//   2. The BLIT-NEVER-ADOPT invariant: the node-owned <video> is PARKED while
//      this module's dock pane is open. A body that adopted it would take the
//      element out from under the legacy card's mount under `?shell=legacy`.
//   3. The deleted resting readout STAYS deleted, and its replacement carries
//      the information (`aria-valuetext`).
//   4. SCREEN OFF collapses the picture and does NOT pause the clip.
//   5. ⚠ THE REPAIR, and the reason this PR is bigger than videobox's: the
//      multi-slot EXPORT resolver and the saved-handle RESTORE are the
//      controller's, so a rack whose varispeed was never docked still carries
//      its bytes into "Export performance" and still gets them back on reload.
//      Both were card `$effect`s and therefore dock-gated on `main`, while
//      being the documented delivery mechanism for the Loaded-Assets picker.

import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { spawnPatch } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

/** The LONG fixture (#1577): 120 s of low-bitrate synthetic video, so the
 *  clip's end is unreachable inside this spec's bounds. Same file
 *  `collapse-keeps-playing` and `node-source-videovarispeed` use. */
const FIXTURE = fileURLToPath(new URL('../fixtures/lobby-clip-long.webm', import.meta.url));

/** Post-toggle observation window (a CAP on the failure, not the gate — the
 *  gate is accumulated forward progress, measured in-page). */
const OBSERVE_MS = 3_000;
/** Forward seconds of media that must accumulate in that window. Well under
 *  `OBSERVE_MS` so a slow SwiftShader runner has headroom. */
const MIN_PROGRESS_S = 0.4;

const VVS = 'fvv1';

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

/** Where the node-owned slot-0 <video> lives and whether it plays — read off
 *  the DOM document-wide, because for a faced module the element is PARKED,
 *  never in the pane. */
async function mediaState(page: Page) {
  return await page.evaluate(() => {
    const v = document.querySelector('video[data-testid="videovarispeed-video"]') as HTMLVideoElement | null;
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
 *  never a Playwright-side poll of the thread under measurement. */
async function measureProgress(page: Page, ms: number) {
  return await page.evaluate(async (windowMs) => {
    const el = document.querySelector('video[data-testid="videovarispeed-video"]') as HTMLVideoElement | null;
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
        // WRAP-SAFE: backwards credits nothing. SEEK-PROOF: forward is credited
        // only up to what playback could produce in dt.
        if (delta > 0) progress += Math.min(delta, (dtMs / 1000) * rate);
        samples++;
        prevT = t; prevMs = nowMs;
        if (nowMs - startMs >= windowMs) { clearInterval(iv); resolve(); }
      }, 100);
    });
    return { progressS: progress, samples, elapsedMs: performance.now() - startMs, reason: '' };
  }, ms);
}

/** Load the fixture into a slot through the FACE body's own input. */
async function loadSlot(
  page: Page,
  body: ReturnType<Page['locator']>,
  testid: string,
): Promise<void> {
  await body.locator(`[data-testid="${testid}"]`).setInputFiles(FIXTURE);
  await expect(body.locator('[data-testid="videovarispeed-face-body"]').first())
    .toHaveAttribute('data-has-local-file', 'true', { timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
}

test.describe('VIDEOVARISPEED face — the promotion is what makes it loadable', () => {
  // ⚠ A PAGE ERROR FAILS EVERY TEST IN THIS FILE. A TypeError inside a
  // `$derived` does not surface as a thrown assertion — it takes the subtree's
  // render down and the symptom lands somewhere else entirely.
  test.beforeEach(({ page }) => {
    page.on('pageerror', (err) => {
      throw new Error(`uncaught page error during a videovarispeed face test: ${err.message}`);
    });
  });

  test('the shell replaces the card, and the face still LOADS, PLAYS and SEEKS @video', async ({ page }) => {
    // Serialises the dock's lazy body chunk plus a real webm decode behind the
    // boot — bounded from the one export site, never a flat literal.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await spawnPatch(page, [{ id: VVS, type: 'videovarispeed', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });

    // THE PROMOTION ITSELF: the default shell mounts no card anywhere.
    await expect(
      page.locator('[data-testid="videovarispeed-card"]'),
      'a legacy card is mounted on the default shell — the shell did not replace it',
    ).toHaveCount(0);

    const dock = await openDock(page, VVS);
    const body = dock.locator('[data-testid="videovarispeed-face-body"]');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // Unloaded resting state.
    await expect(body.locator('[data-testid="videovarispeed-drop-hint"]')).toBeVisible();
    await expect(body.locator('[data-testid="videovarispeed-seek"]')).toBeDisabled();
    await expect(body.locator('[data-testid="videovarispeed-speed-readout"]')).toHaveText('+1.0×');

    await loadSlot(page, body, 'videovarispeed-file-input');
    await expect(body.locator('[data-testid="videovarispeed-filename"]'))
      .toContainText('lobby-clip-long');

    await body.locator('[data-testid="videovarispeed-play-btn"]').click();
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video[data-testid="videovarispeed-video"]') as HTMLVideoElement | null;
        return !!v && !v.paused && v.currentTime > 0.05;
      },
      undefined,
      { timeout: SLOW_BOOT_TEST_TIMEOUT_MS },
    );
    await expect(body.locator('[data-testid="videovarispeed-play-btn"]')).toHaveText('Pause');
    await expect(body).toHaveAttribute('data-is-playing', 'true');

    // ── LEG: BLIT, NEVER ADOPT ────────────────────────────────────────────
    // The element has ONE parent and `?shell=legacy` mounts a card that adopts
    // it; a body that adopted it here would move it out from under that mount.
    const placed = await mediaState(page);
    expect(placed, 'no node-owned <video> exists at all').not.toBeNull();
    expect(
      placed!.where,
      `the node-owned <video> is ${placed!.where} — a FACED module's body must blit, never adopt`,
    ).toBe('parking');
    await expect(body.locator('[data-testid="videovarispeed-face-canvas"]')).toBeVisible();

    // ── LEG: the deleted resting readout stays deleted ────────────────────
    await expect(
      page.locator('[data-testid="videovarispeed-time"]'),
      'the card\'s `0:04 / 2:00` line is back — it is DELETED, not hidden (owner ruling 2026-08-17)',
    ).toHaveCount(0);
    // …and its information survives on the control that replaced it.
    await expect(body.locator('[data-testid="videovarispeed-seek"]'))
      .toHaveAttribute('aria-valuetext', /of/);

    // ── LEG: SEEK from the face ───────────────────────────────────────────
    const seek = body.locator('[data-testid="videovarispeed-seek"]');
    await seek.evaluate((el) => {
      const input = el as HTMLInputElement;
      input.value = '30';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video[data-testid="videovarispeed-video"]') as HTMLVideoElement | null;
        return !!v && v.currentTime > 25;
      },
      undefined,
      { timeout: SLOW_BOOT_TEST_TIMEOUT_MS },
    );
  });

  test('two slots are loaded and SWITCHED from the face, with no card @video', async ({ page }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await spawnPatch(page, [{ id: VVS, type: 'videovarispeed', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });
    const dock = await openDock(page, VVS);
    const body = dock.locator('[data-testid="videovarispeed-face-body"]');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // The 7-slot bank is a PERMANENT section here — on the card it was behind a
    // whole-card `oncontextmenu` a faceplate cannot reuse.
    await expect(body.locator('[data-testid="videovarispeed-multi-panel"]')).toBeVisible();

    await loadSlot(page, body, 'videovarispeed-slot-input-0');
    await body.locator('[data-testid="videovarispeed-slot-input-2"]').setInputFiles(FIXTURE);
    await expect(body.locator('[data-testid="videovarispeed-slot-2"]'))
      .toHaveAttribute('data-slot-local', 'true', { timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // A click on the row is the same command the ASSET gate fires.
    await body.locator('[data-testid="videovarispeed-slot-select-2"]').click();
    await expect(
      body,
      'the switch did not reach the node — activeSlot is NODE state, not the surface\'s',
    ).toHaveAttribute('data-active-slot', '2', { timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await expect(page.locator('[data-testid="videovarispeed-card"]')).toHaveCount(0);
  });

  test('CROP is added from the face and reaches the engine @video', async ({ page }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await spawnPatch(page, [{ id: VVS, type: 'videovarispeed', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });
    const dock = await openDock(page, VVS);
    const body = dock.locator('[data-testid="videovarispeed-face-body"]');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // Passthrough until a crop exists — the CROP output is never black.
    const cropActive = async () => await page.evaluate((id) => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain(d: string): { read(n: string, k: string): unknown } };
      };
      try { return w.__engine?.().getDomain('video').read(id, 'cropActive') === true; }
      catch { return null; }
    }, VVS);
    await expect.poll(cropActive, { timeout: SLOW_BOOT_TEST_TIMEOUT_MS }).toBe(false);

    await body.locator('[data-testid="videovarispeed-add-crop"]').click();
    // The gate is the ENGINE's own view, not the button's pressed state: the
    // push is the CONTROLLER's, and a body that only wrote node.data would look
    // identical on screen while the CROP output kept passing the full frame.
    await expect.poll(cropActive, { timeout: SLOW_BOOT_TEST_TIMEOUT_MS }).toBe(true);

    await body.locator('[data-testid="videovarispeed-remove-crop"]').click();
    await expect.poll(cropActive, { timeout: SLOW_BOOT_TEST_TIMEOUT_MS }).toBe(false);
    await expect(page.locator('[data-testid="videovarispeed-card"]')).toHaveCount(0);
  });

  test('SCREEN OFF collapses the picture and does NOT pause the clip @video', async ({ page }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await spawnPatch(page, [{ id: VVS, type: 'videovarispeed', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });
    const dock = await openDock(page, VVS);
    const body = dock.locator('[data-testid="videovarispeed-face-body"]');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    await loadSlot(page, body, 'videovarispeed-file-input');
    await body.locator('[data-testid="videovarispeed-play-btn"]').click();
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video[data-testid="videovarispeed-video"]') as HTMLVideoElement | null;
        return !!v && !v.paused && v.currentTime > 0.05;
      },
      undefined,
      { timeout: SLOW_BOOT_TEST_TIMEOUT_MS },
    );

    const toggle = body.locator('[data-testid="videovarispeed-face-screen-toggle"]');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // COLLAPSE FIRST, THEN MEASURE — the measurement window must lie entirely
    // inside the collapsed state or a still-running prefix would carry it.
    await toggle.click();
    await expect(body.locator('[data-testid="videovarispeed-face-canvas"]')).toHaveCount(0);
    await expect(body.locator('[data-testid="videovarispeed-face-wrap"]'))
      .toHaveAttribute('data-preview-collapsed', 'true');

    const progress = await measureProgress(page, OBSERVE_MS);
    expect(progress.samples, 'the in-page accumulator never sampled — a zero-sample run proves nothing')
      .toBeGreaterThan(0);
    expect(
      progress.progressS,
      `SCREEN OFF stopped the clip: ${progress.progressS.toFixed(3)}s of forward media over `
        + `${progress.samples} samples / ${Math.round(progress.elapsedMs)}ms. The switch collapses the `
        + 'PREVIEW COPY, never the producer.',
    ).toBeGreaterThan(MIN_PROGRESS_S);

    await toggle.click();
    await expect(body.locator('[data-testid="videovarispeed-face-canvas"]')).toBeVisible();
  });

  test('THE REPAIR: "Export performance" carries the bytes with no card ever mounted @video', async ({ page }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await spawnPatch(page, [{ id: VVS, type: 'videovarispeed', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });
    const dock = await openDock(page, VVS);
    const body = dock.locator('[data-testid="videovarispeed-face-body"]');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await loadSlot(page, body, 'videovarispeed-file-input');
    await body.locator('[data-testid="videovarispeed-slot-input-3"]').setInputFiles(FIXTURE);
    await expect(body.locator('[data-testid="videovarispeed-slot-3"]'))
      .toHaveAttribute('data-slot-local', 'true', { timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // ⚠ CLOSE THE DOCK BEFORE EXPORTING. That is the whole point: on `main` the
    // export resolver was registered from the CARD's onMount, so a rack whose
    // varispeed was not currently docked exported none of its slots' bytes —
    // and on the default shell the card is only ever mounted inside this pane.
    await page.getByTestId('faceplate-collapse').click();
    await expect(page.getByTestId('dock-full-view')).toHaveCount(0);
    await expect(page.locator('[data-testid="videovarispeed-card"]')).toHaveCount(0);

    const zipLen = await page.evaluate(async () => {
      const hook = (globalThis as unknown as {
        __perfZip?: { export(): Promise<Uint8Array> };
      }).__perfZip;
      if (!hook) return -1;
      return (await hook.export()).byteLength;
    });
    test.skip(zipLen === -1, 'the perf-zip e2e hook is not exposed in this build');

    // The fixture is ~120 s of webm in TWO slots; an envelope with no media is
    // a few KB, so a threshold well above that proves bytes travelled.
    const fixtureBytes = readFileSync(FIXTURE).byteLength;
    expect(
      zipLen,
      `the exported .zip is ${zipLen} bytes — with two populated slots of a ${fixtureBytes}-byte `
        + 'fixture it must carry real media. A card-registered resolver exports nothing when no '
        + 'card is mounted, which on the default shell is always.',
    ).toBeGreaterThan(fixtureBytes);
  });
});
