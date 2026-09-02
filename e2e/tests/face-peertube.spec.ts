// e2e/tests/face-peertube.spec.ts
//
// THE PEERTUBE FACE, driven for real on the DEFAULT shell — the seams no other
// gate can see.
//
// ⚠ THE FILENAME IS DELIBERATE — NOT `peertube-face.spec.ts`. `peertube-*`
// happens to match no entry in `e2e/webgl-heavy-globs.ts` TODAY (verified with
// minimatch against the live list, not by reading the neighbouring prose, which
// warns about a `peertube-*` heaviness that the current glob list does not
// have). `face-` is the shape `face-videobox.spec.ts` established and it cannot
// be swept into the heavy lane by a future broad glob named after the module —
// and a spec in that lane runs NOWHERE in PR CI, green forever. Nothing here is
// WebGL-heavy: it reads DOM facts, graph state and a media clock, and samples
// no pixels.
//
// ⚠ EVERY OTHER PEERTUBE E2E BOOTS `?shell=legacy` (`peertube.spec.ts` ×3,
// `node-source-hls.spec.ts`), so all of it stays green after promotion while
// covering a surface no player meets. This file is the default-shell leg those
// owe.
//
// `peertube-face-model.test.ts` pins the ranking, the cell kind, the
// noUserControl declaration, the shader's `uGain` read, the shared-picker
// no-drift property and every other source-level claim.
// `face-rack-status-source.test.ts` proves the body declares what it paints,
// and the shared `face-screen-render-*` suite drives the SCREEN switch
// generically. None of them can see:
//
//  1. ⚠ THAT A VIDEO CAN BE FOUND AND PLAYED AT ALL UNDER THE SHELL. This is
//     the whole practical argument for the promotion and it is a RENDER fact:
//     peertube left `DOM_SOURCE_LANE_TYPES` in LEG-02 P3 (#1511) and is in
//     neither half of `HEADLESS_MOUNT_LANE_TYPES`, so with the face declared
//     and no body mounted there would be no search box on ANY surface. So this
//     file asserts the legacy card is absent AND a search still works.
//  2. THAT THE BODY BLITS RATHER THAN ADOPTS while a stream is PLAYING in an
//     OPEN dock — the one-parent constraint, in the exact arrangement where
//     breaking it is tempting.
//  3. THAT THE DELETED READOUT SURVIVED THE MOVE. The card's
//     `peertube-now-playing` line is deleted from BOTH surfaces; the identity
//     must survive on the picture's accessible name, and nothing may paint the
//     video's name as a resting text node outside a control.
//  4. THAT THE KEPT ATTRIBUTION ANCHOR REALLY POINTS AT THE CREATOR'S PAGE.
//     Its justification is legal, and `face-resting-text-source.test.ts`
//     declares body text its own blind spot — so nothing else would notice it
//     going missing or going wrong.
//  5. THAT SCREEN OFF IS NOT A PAUSE. The switch reclaims the preview's space;
//     the STREAM must keep playing while the canvas is gone.
//
// ⚠ THE MOCK RETURNS EXACTLY ONE RESULT. A multi-row fixture races the
// module's own "display unavailable -> auto-skip to the next result" path, so
// any "which video is playing" claim becomes a coin flip — the failure that
// reddened tvLibrarian's CI after passing locally three times over. One row
// makes the skip target the row itself, and the claim well-posed.

import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

/** VP8 + Opus, an open codec the test Chromium decodes with no OS H.264
 *  encoder — the same fixture `peertube.spec.ts` resolves to, for the same
 *  reason. Served as a PROGRESSIVE file so no hls.js fragment decode is in the
 *  path (the recorderbox/edges local-passes-CI-fails trap). */
const WEBM = readFileSync(fileURLToPath(new URL('../fixtures/av-clip.webm', import.meta.url)));

const HOST = 'mock.peertube.test';
const UUID = 'vid-face-1';
const NAME = 'Mock Federated Clip';
const MEDIA_URL = `https://${HOST}/static/web-videos/${UUID}-720.mp4`;

/** Post-toggle observation window (a CAP on the failure, not the gate — the
 *  gate is accumulated forward progress, measured in-page). */
const OBSERVE_MS = 3_000;
/** Forward seconds of media that must accumulate in that window. Well under
 *  `OBSERVE_MS` so a slow SwiftShader runner has headroom. */
const MIN_PROGRESS_S = 0.3;

async function installMocks(page: Page): Promise<void> {
  // ⚠ ONE ROW. See the header.
  await page.route('**/sepiasearch.org/api/v1/search/videos**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        total: 1,
        data: [
          {
            uuid: UUID, name: NAME, duration: 4, isLive: false, nsfw: false,
            account: { host: HOST },
            channel: { displayName: 'Mock Channel' },
            thumbnailPath: '/static/thumbnails/abc.jpg',
          },
        ],
      }),
    }),
  );
  // No streamingPlaylists → resolveStream falls back to the progressive file.
  await page.route(`**/${HOST}/api/v1/videos/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ name: NAME, streamingPlaylists: [], files: [{ fileUrl: MEDIA_URL, resolution: { id: 720 } }] }),
    }),
  );
  await page.route(`**/${HOST}/static/web-videos/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'video/webm',
      headers: { 'access-control-allow-origin': '*', 'accept-ranges': 'bytes' },
      body: WEBM,
    }),
  );
  await page.route('**/static/thumbnails/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAAAAACw=', 'base64') }),
  );
}

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
async function openDock(page: Page, nodeId: string): Promise<Locator> {
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
    const v = document.querySelector('video[data-testid="peertube-video"]') as HTMLVideoElement | null;
    if (!v) return null;
    return {
      hasSrc: !!(v.currentSrc || v.getAttribute('src')),
      paused: v.paused,
      muted: v.muted,
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
    const el = document.querySelector('video[data-testid="peertube-video"]') as HTMLVideoElement | null;
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
        // WRAP-SAFE: backwards credits nothing (the clip loops/ends). SEEK-PROOF:
        // forward is credited only up to what playback could produce in dt.
        if (delta > 0) progress += Math.min(delta, (dtMs / 1000) * rate);
        samples++;
        prevT = t; prevMs = nowMs;
        if (nowMs - startMs >= windowMs) { clearInterval(iv); resolve(); }
      }, 100);
    });
    return { progressS: progress, samples, elapsedMs: performance.now() - startMs, reason: '' };
  }, ms);
}

/** Search through the FACE body's own box and pick the single result. */
async function searchAndPick(page: Page, body: Locator): Promise<void> {
  await body.locator('[data-testid="peertube-search"]').fill('blender');
  await body.locator('[data-testid="peertube-search"]').press('Enter');
  const row = body.locator('[data-testid="peertube-result"]');
  await expect(row).toHaveCount(1, { timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await row.first().click();
  // Genuine attach, in-page: the element carries a src and is un-muted (the
  // audio trap — a muted element makes audio_l/audio_r carry silence).
  await page.waitForFunction(
    () => {
      const v = document.querySelector('video[data-testid="peertube-video"]') as HTMLVideoElement | null;
      return !!v && !!(v.currentSrc || v.getAttribute('src'));
    },
    undefined,
    { timeout: SLOW_BOOT_TEST_TIMEOUT_MS },
  );
}

test.describe('PEERTUBE face — the promotion is what makes it searchable', () => {
  // ⚠ A PAGE ERROR FAILS EVERY TEST IN THIS FILE. A TypeError inside a
  // `$derived` does not surface as a thrown assertion — it takes the subtree's
  // render down and the symptom lands somewhere else entirely (the
  // tv-librarian-face incident, twice).
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (err) => {
      throw new Error(`uncaught page error during a peertube face test: ${err.message}`);
    });
    await installMocks(page);
  });

  test('the shell replaces the card, and the face still SEARCHES and PLAYS @video', async ({ page }) => {
    // Serialises the dock's lazy body chunk plus a real webm decode behind the
    // boot — bounded from the one export site, never a flat literal.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await spawnPatch(page, [{ id: 'fpt1', type: 'peertube', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });

    // ⚠ THE PRECONDITION THIS WHOLE FILE RESTS ON: on the default shell no
    // peertube card is mounted anywhere — not in the lane, not in a headless
    // host (peertube left DOM_SOURCE_LANE_TYPES in LEG-02 P3). If this ever
    // finds a card, the rest proves nothing about the face.
    await expect(page.locator('[data-testid="peertube-card"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="headless-source-host"][data-node-id="fpt1"]')).toHaveCount(0);

    const dock = await openDock(page, 'fpt1');
    const body = dock.locator('[data-testid="peertube-face-body"]');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // Nothing selected: the placeholder names this surface's own condition, ↻
    // next has an empty roster to advance through, and the transport does not
    // exist yet.
    await expect(body.locator('[data-testid="peertube-empty"]')).toBeVisible();
    await expect(body.locator('[data-testid="peertube-next"]')).toBeDisabled();
    await expect(body.locator('[data-testid="peertube-play"]')).toHaveCount(0);
    // The DEAD control is gone from every surface, permanently.
    await expect(page.locator('[data-testid="peertube-instance"]')).toHaveCount(0);

    await searchAndPick(page, body);

    // ⚠ LEG 3 — THE DELETED READOUT STAYS DELETED, and the identity survives.
    await expect(page.locator('[data-testid="peertube-now-playing"]')).toHaveCount(0);
    await expect(body.locator('[data-testid="peertube-face-preview"]'))
      .toHaveAttribute('aria-label', new RegExp(`playing ${NAME}`), { timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // ⚠ LEG 4 — THE KEPT ATTRIBUTION ANCHOR really reaches the creator's page,
    // and is the only place the instance host is now named.
    const link = body.locator('[data-testid="peertube-watch-link"]');
    await expect(link).toHaveAttribute('href', `https://${HOST}/w/${UUID}`);
    await expect(link).toHaveText(HOST);
    await expect(body.locator('[data-testid="peertube-disclaimer"]')).toBeVisible();

    // The selection reached the SYNCED graph, so a rack-mate resolves the same
    // stream — the face writes the node, not component state.
    const persisted = await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: Record<string, unknown> }> } };
      const d = w.__patch.nodes['fpt1']?.data ?? {};
      return { uuid: d.uuid, selectedHost: d.selectedHost, name: d.name, searchTerm: d.searchTerm };
    });
    expect(persisted).toMatchObject({ uuid: UUID, selectedHost: HOST, name: NAME, searchTerm: 'blender' });

    // ⚠ LEG 2 — BLIT, NEVER ADOPT, measured in the arrangement where adoption
    // is tempting: a stream attached while THIS module's dock pane is OPEN. The
    // node-owned element must be parked, not inside the pane, and the pane's
    // picture must be the body's own canvas.
    const media = await mediaState(page);
    expect(media, 'the node-owned <video> exists and holds the stream').not.toBeNull();
    expect(media!.hasSrc).toBe(true);
    expect(
      media!.where,
      'the face body must BLIT the engine output — the node-owned <video> has ONE parent ' +
        '(the legacy card adopts it under ?shell=legacy) and must stay PARKED under the shell',
    ).toBe('parking');
    expect(
      media!.muted,
      'the element must be UN-MUTED after the audio tap is wired, or audio_l/audio_r carry ' +
        'silence — the #785/#786 audio trap this module pair was born with',
    ).toBe(false);
    await expect(body.locator('[data-testid="peertube-face-canvas"]')).toBeVisible();
  });

  test('SCREEN OFF collapses the picture and does NOT pause the stream @video', async ({ page }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await spawnPatch(page, [{ id: 'fpt2', type: 'peertube', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });
    const dock = await openDock(page, 'fpt2');
    const body = dock.locator('[data-testid="peertube-face-body"]');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await searchAndPick(page, body);

    // Reach real playback before measuring — the controller autoplays a fresh
    // selection, and a paused start would make the post-toggle window vacuous.
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video[data-testid="peertube-video"]') as HTMLVideoElement | null;
        return !!v && !v.paused && v.currentTime > 0.05;
      },
      undefined,
      { timeout: SLOW_BOOT_TEST_TIMEOUT_MS },
    );

    const toggle = body.locator('[data-testid="peertube-face-screen-toggle"]');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // ⚠ COLLAPSE FIRST, THEN MEASURE — asserting "still playing" before the
    // toggle would pass on a switch that pauses, because the pre-toggle state
    // also plays. The canvas is REMOVED (space reclaimed), and the media clock
    // must then still accumulate forward progress.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(body.locator('[data-testid="peertube-face-canvas"]')).toHaveCount(0);

    const rec = await measureProgress(page, OBSERVE_MS);
    expect(
      rec.progressS,
      `forward playback progress with the SCREEN off: ${rec.progressS.toFixed(3)} s over ` +
        `${rec.samples} samples / ${rec.elapsedMs.toFixed(0)} ms. Units: SECONDS of media time, ` +
        'wrap-safe and seek-proof. A zero here means the SCREEN switch became a pause — the ' +
        'exact mute the 2026-08-18 ruling forbids, and on a SOURCE it would idle the picture ' +
        'every downstream consumer samples.',
    ).toBeGreaterThan(MIN_PROGRESS_S);

    // The collapse persisted on the node (not component state), and the
    // picture comes back LIVE.
    expect(
      await page.evaluate(() => {
        const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: Record<string, unknown> }> } };
        return w.__patch.nodes['fpt2']?.data?.previewCollapsed;
      }),
    ).toBe(true);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(body.locator('[data-testid="peertube-face-canvas"]')).toBeVisible();
  });
});
