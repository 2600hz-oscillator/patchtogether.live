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
  await page.goto('/');
  await page.waitForLoadState('networkidle');
}

async function spawnArchivist(page: Page): Promise<void> {
  await spawnPatch(page, [
    { id: 'arc', type: 'archivist', position: { x: 80, y: 80 }, domain: 'video' },
  ]);
  await expect(page.locator('[data-testid="archivist-card"]')).toHaveCount(1);
}

async function search(page: Page, type: string, term: string): Promise<void> {
  await page.locator('[data-testid="archivist-type"]').selectOption(type);
  await page.locator('[data-testid="archivist-search"]').fill(term);
  // Press Enter rather than clicking the button: a real pointer .click() on an
  // element inside a SvelteFlow node is captured by the node's pan/drag handler
  // (even with `nodrag`), so it never reaches the button's onclick. Enter in the
  // search field calls runSearch directly — the same code path a user hits.
  await page.locator('[data-testid="archivist-search"]').press('Enter');
}

test.describe('ARCHIVIST (archive.org, mocked)', () => {
  test('IMAGE: search → loads a random image with a CLEAN output', async ({ page }) => {
    await mockArchive(page, {
      mediatype: 'image', identifier: 'img1', title: 'A Cat Photo',
      file: 'cat.png', format: 'PNG', bytes: PNG, contentType: 'image/png',
    });
    await gotoApp(page);
    await spawnArchivist(page);
    await search(page, 'image', 'cats');

    const card = page.locator('[data-testid="archivist-card"]');
    await expect(card).toHaveAttribute('data-has-item', 'true', { timeout: 10_000 });
    await expect(card).toHaveAttribute('data-media-type', 'image');
    // image = clean downstream output.
    await expect(card).toHaveAttribute('data-clean-output', 'true');
    // no play-only warning for images.
    await expect(page.locator('[data-testid="archivist-cors-warn"]')).toHaveCount(0);
    // the <img> got the mocked src.
    await expect(page.locator('[data-testid="archivist-image"]')).toHaveJSProperty('complete', true);
    // attribution link points at the details page.
    await expect(page.locator('[data-testid="archivist-meta"] a')).toHaveAttribute(
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
    await spawnArchivist(page);
    await search(page, 'audio', 'jazz');

    const card = page.locator('[data-testid="archivist-card"]');
    await expect(card).toHaveAttribute('data-has-item', 'true', { timeout: 10_000 });
    await expect(card).toHaveAttribute('data-media-type', 'audio');
    await expect(card).toHaveAttribute('data-clean-output', 'true');
    // time-media → transport + seek bar present.
    await expect(page.locator('[data-testid="archivist-play"]')).toBeVisible();
    await expect(page.locator('[data-testid="archivist-seek"]')).toBeVisible();
    await expect(page.locator('[data-testid="archivist-rand-pos"]')).toBeVisible();
    await expect(page.locator('[data-testid="archivist-cors-warn"]')).toHaveCount(0);
  });

  test('VIDEO: search → PLAY-ONLY (warning shown, no clean output)', async ({ page }) => {
    await mockArchive(page, {
      mediatype: 'movies', identifier: 'vid1', title: 'A Nasa Film',
      file: 'film.webm', format: 'WebM', bytes: WEBM, contentType: 'video/webm',
    });
    await gotoApp(page);
    await spawnArchivist(page);
    await search(page, 'video', 'nasa');

    const card = page.locator('[data-testid="archivist-card"]');
    await expect(card).toHaveAttribute('data-has-item', 'true', { timeout: 10_000 });
    await expect(card).toHaveAttribute('data-media-type', 'video');
    // video = NO clean output (archive.org video lacks CORS on the served file).
    await expect(card).toHaveAttribute('data-clean-output', 'false');
    // the play-only warning is shown.
    await expect(page.locator('[data-testid="archivist-cors-warn"]')).toBeVisible();
    // still plays/scrubs in the preview (transport present).
    await expect(page.locator('[data-testid="archivist-play"]')).toBeVisible();
    await expect(page.locator('[data-testid="archivist-seek"]')).toBeVisible();

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
    const playBtn = page.locator('[data-testid="archivist-play"]');
    const box = await playBtn.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await expect(card).toHaveAttribute('data-is-playing', 'true', { timeout: 5_000 });
    const t0 = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
    await expect
      .poll(async () => video.evaluate((el: HTMLVideoElement) => el.currentTime), {
        timeout: 5_000,
        message: 'playhead advances while playing',
      })
      .toBeGreaterThan(t0);
  });
});
