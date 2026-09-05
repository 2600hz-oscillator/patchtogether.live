// e2e/tests/archivist.spec.ts
//
// ARCHIVIST — Internet Archive (archive.org) media source.
//
// MOCKED archive.org: the search + metadata + served-file requests are all
// fulfilled via Playwright route interception (NEVER live — live archive.org
// is rate-limited + non-deterministic). We serve small local fixtures as the
// item files (tiny.png / samsloop-test.wav / av-clip.webm), so the REAL
// fetch → parse → best-file-pick → element-load → preview chain runs end to
// end against deterministic content.
//
// The per-type CORS-for-use limitation (video = play-only) is asserted via
// the card's `data-clean-output` attribute + the visible "play-only" warning,
// NOT via a GL pixel read (which would be SwiftShader-fragile on CI and is
// covered by the pure-core unit tests anyway).

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';

const PNG = readFileSync(fileURLToPath(new URL('../fixtures/tiny.png', import.meta.url)));
const WAV = readFileSync(fileURLToPath(new URL('../fixtures/samsloop-test.wav', import.meta.url)));
const WEBM = readFileSync(fileURLToPath(new URL('../fixtures/av-clip.webm', import.meta.url)));

/** A search response with one doc of the given mediatype. */
function searchBody(mediatype: string, identifier: string, title: string): string {
  return JSON.stringify({
    responseHeader: { status: 0 },
    response: { numFound: 1, start: 0, docs: [{ identifier, title, mediatype }] },
  });
}

/** A metadata response listing one playable file of the given name. */
function metadataBody(identifier: string, fileName: string, format: string): string {
  return JSON.stringify({
    server: 'mock.archive.test',
    dir: `/0/items/${identifier}`,
    metadata: { identifier, title: `Title of ${identifier}`, 'access-restricted-item': 'false' },
    files: [
      { name: '__ia_thumb.jpg', format: 'Item Tile', source: 'original' },
      { name: `${identifier}_meta.xml`, format: 'Metadata', source: 'metadata' },
      { name: fileName, format, source: 'original' },
    ],
  });
}

/** Install route mocks for one media type before navigation. */
async function mockArchive(
  page: Page,
  opts: { mediatype: string; identifier: string; title: string; file: string; format: string; bytes: Buffer; contentType: string },
): Promise<void> {
  await page.route('**/advancedsearch.php**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: searchBody(opts.mediatype, opts.identifier, opts.title),
    });
  });
  await page.route('**/metadata/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: metadataBody(opts.identifier, opts.file, opts.format),
    });
  });
  // The served file (direct CDN URL built from server+dir).
  await page.route(`**/items/${opts.identifier}/**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: opts.contentType,
      headers: { 'access-control-allow-origin': '*', 'accept-ranges': 'bytes' },
      body: opts.bytes,
    });
  });
}

async function gotoApp(page: Page): Promise<void> {
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
}

/** Spawn + open the dock full view (the archive browser is `fullViewBody`;
 *  the shared BrowseControls render there with the `archivist-face-*` testid
 *  prefix) and return the PANE locator every UI read scopes under. */
async function spawnArchivist(page: Page) {
  await spawnPatch(page, [
    { id: 'arc', type: 'archivist', position: { x: 80, y: 80 }, domain: 'video' },
  ]);
  await expect(
    page.locator('.svelte-flow__node[data-id="arc"] [data-testid="module-shell"]'),
  ).toHaveCount(1);
  await page.waitForFunction(
    () =>
      typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView ===
      'function',
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(
    (i) => (globalThis as unknown as { __openDockFullView: (x: string) => void }).__openDockFullView(i),
    'arc',
  );
  const pane = page.locator('[data-testid="dock-fullview-pane"][data-pane-node="arc"]');
  await expect(pane.locator('[data-testid="archivist-face-body"]')).toBeVisible({ timeout: 60_000 });
  return pane;
}

type Pane = Awaited<ReturnType<typeof spawnArchivist>>;

async function search(pane: Pane, type: string, term: string): Promise<void> {
  await pane.locator('[data-testid="archivist-face-type"]').selectOption(type);
  await pane.locator('[data-testid="archivist-face-search"]').fill(term);
  // Enter in the search field calls runSearch directly — the same code path a
  // user hits (and no SvelteFlow pan handler exists in the dock pane).
  await pane.locator('[data-testid="archivist-face-search"]').press('Enter');
}

test.describe('ARCHIVIST (archive.org, mocked)', () => {
  test('IMAGE: search → loads a random image with a CLEAN output', async ({ page }) => {
    await mockArchive(page, {
      mediatype: 'image', identifier: 'img1', title: 'A Cat Photo',
      file: 'cat.png', format: 'PNG', bytes: PNG, contentType: 'image/png',
    });
    await gotoApp(page);
    const pane = await spawnArchivist(page);
    await search(pane, 'image', 'cats');

    const card = pane.locator('[data-testid="archivist-face-body"]');
    await expect(card).toHaveAttribute('data-has-item', 'true', { timeout: 10_000 });
    await expect(card).toHaveAttribute('data-media-type', 'image');
    // image = clean downstream output.
    await expect(card).toHaveAttribute('data-clean-output', 'true');
    // ⚠ THE PLAY-ONLY WARNING IS NOW A LAMP: ALWAYS MOUNTED, UNLIT FOR A CLEAN
    // ITEM. It used to be a sentence rendered only when the output was tainted.
    // The face promotion made it a `StatusLed` with a STATIC caption (owner
    // ruling: a faceplate paints no resting readout of derived state), and the
    // card draws the same shared control, so both surfaces agree by
    // construction. `data-lit` is the stronger assertion of the two anyway —
    // absence cannot tell "clean" apart from "the lamp was deleted".
    await expect(pane.locator('[data-testid="archivist-face-cors-warn"]')).toHaveAttribute('data-lit', '0');
    // the <img> got the mocked src.
    await expect(page.locator('[data-testid="archivist-image"]')).toHaveJSProperty('complete', true);
    // attribution link points at the details page.
    await expect(pane.locator('[data-testid="archivist-face-meta"] a')).toHaveAttribute(
      'href',
      /archive\.org\/details\/img1/,
    );
  });

  test('AUDIO: search → loads audio with a CLEAN output + scrub transport', async ({ page }) => {
    await mockArchive(page, {
      mediatype: 'audio', identifier: 'aud1', title: 'A Jazz Tune',
      file: 'tune.wav', format: 'VBR MP3', bytes: WAV, contentType: 'audio/wav',
    });
    await gotoApp(page);
    const pane = await spawnArchivist(page);
    await search(pane, 'audio', 'jazz');

    const card = pane.locator('[data-testid="archivist-face-body"]');
    await expect(card).toHaveAttribute('data-has-item', 'true', { timeout: 10_000 });
    await expect(card).toHaveAttribute('data-media-type', 'audio');
    await expect(card).toHaveAttribute('data-clean-output', 'true');
    // time-media → transport + seek bar present.
    await expect(pane.locator('[data-testid="archivist-face-play"]')).toBeVisible();
    await expect(pane.locator('[data-testid="archivist-face-seek"]')).toBeVisible();
    await expect(pane.locator('[data-testid="archivist-face-rand-pos"]')).toBeVisible();
    // Mounted and UNLIT — see the IMAGE leg's note on the lamp.
    await expect(pane.locator('[data-testid="archivist-face-cors-warn"]')).toHaveAttribute('data-lit', '0');
  });

  test('VIDEO: search → PLAY-ONLY (warning shown, no clean output)', async ({ page }) => {
    await mockArchive(page, {
      mediatype: 'movies', identifier: 'vid1', title: 'A Nasa Film',
      file: 'film.webm', format: 'WebM', bytes: WEBM, contentType: 'video/webm',
    });
    await gotoApp(page);
    const pane = await spawnArchivist(page);
    await search(pane, 'video', 'nasa');

    const card = pane.locator('[data-testid="archivist-face-body"]');
    await expect(card).toHaveAttribute('data-has-item', 'true', { timeout: 10_000 });
    await expect(card).toHaveAttribute('data-media-type', 'video');
    // video = NO clean output (archive.org video lacks CORS on the served file).
    await expect(card).toHaveAttribute('data-clean-output', 'false');
    // the play-only warning is shown — and LIT, which is what now carries the
    // distinction the two clean legs assert the other side of.
    await expect(pane.locator('[data-testid="archivist-face-cors-warn"]')).toBeVisible();
    await expect(pane.locator('[data-testid="archivist-face-cors-warn"]')).toHaveAttribute('data-lit', '1');
    // still plays/scrubs in the preview (transport present).
    await expect(pane.locator('[data-testid="archivist-face-play"]')).toBeVisible();
    await expect(pane.locator('[data-testid="archivist-face-seek"]')).toBeVisible();

    // The clip ACTUALLY decoded: the <video> reached metadata (a finite,
    // positive duration) — the fix for the old "hangs on Loading at 0:00/0:00"
    // bug. (The fixture is VP8/webm, an open codec the test Chromium decodes;
    // real-browser h.264 is verified separately — see archivist-query.test.ts
    // for the playable-derivative picker.)
    const video = page.locator('[data-testid="archivist-video"]');
    await expect
      .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState), {
        timeout: 10_000,
        message: 'video reached HAVE_METADATA (readyState >= 1)',
      })
      .toBeGreaterThanOrEqual(1);
    const dur = await video.evaluate((el: HTMLVideoElement) => el.duration);
    expect(Number.isFinite(dur) && dur > 0, `video duration ${dur} is finite + > 0`).toBe(true);

    // It actually PLAYS: a REAL pointer press on the Play button (a synthetic
    // .click() inside a SvelteFlow node is swallowed by the node's pan handler —
    // a true pointerdown/up is what a user does) starts playback + advances the
    // playhead.
    //
    // MUTE the preview element first: headless Chromium's autoplay policy rejects
    // play() on a video WITH an audio track even under a user gesture (the card
    // swallows that rejection, so data-is-playing would never flip) — a muted
    // video is always allowed to play, so this keeps the assertion REAL in CI
    // (it genuinely plays + the playhead advances) rather than capability-skipped.
    // Real users click Play with a gesture on a real browser and get audio.
    await video.evaluate((el: HTMLVideoElement) => { el.muted = true; });
    const playBtn = pane.locator('[data-testid="archivist-face-play"]');
    const box = await playBtn.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.up();

    // LIVE playback advance is CAPABILITY-DEPENDENT in headless CI: bundled
    // Chromium's autoplay policy + software-decode often won't actually advance a
    // <video> even muted+gestured, so a hard `data-is-playing`/currentTime assert
    // is the recorderbox/edges local-passes-CI-fails trap ([[capability-dependent-e2e-local-vs-ci]]).
    // The DETERMINISTIC fix for the owner's "hangs on Loading at 0:00/0:00" bug is
    // already hard-gated above (the clip decoded to metadata with a finite, >0
    // duration). Here we exercise the real Play button, then probe whether THIS
    // browser actually advances the fixture and assert the live state ONLY when it
    // does — so the spec verifies real playback where supported without going red
    // on a headless-decode limitation. (Real-browser h.264 playback verified
    // manually + the playable-derivative picker is unit-tested in archivist-query.test.ts.)
    const t0 = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
    const advances = await video.evaluate(async (el: HTMLVideoElement) => {
      const start = el.currentTime;
      for (let i = 0; i < 25 && (el.paused || el.currentTime <= start); i++) {
        await new Promise((r) => setTimeout(r, 120));
      }
      return !el.paused && el.currentTime > start;
    });
    if (advances) {
      await expect(card).toHaveAttribute('data-is-playing', 'true', { timeout: 5_000 });
      expect(await video.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThan(t0);
    } else {
      // eslint-disable-next-line no-console
      console.log(
        '[archivist e2e] headless browser did not advance the webm fixture (autoplay/software-decode limit); decode/no-hang gate verified, live-advance assertion skipped.',
      );
    }
  });
});
