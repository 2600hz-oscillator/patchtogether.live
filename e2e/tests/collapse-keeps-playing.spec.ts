// e2e/tests/collapse-keeps-playing.spec.ts
//
// THE REGRESSION GUARD for the owner P0: "videovarispeed stops playing if its
// card is collapsed. i put it on scene, expand, load video, play → stops
// playing as soon as the expanded tray is dismissed."
//
// WHAT IT DRIVES — the real thing, in the DEFAULT shell:
//   spawn → expand (dock full-view) → load a file → play → COLLAPSE →
//   assert the element is STILL PLAYING.
//
// ⚠ THE DEFAULT SHELL IS THE POINT. The pre-existing videovarispeed specs all
// boot `/rack?shell=legacy`, which keeps the real card in the LANE — so the
// card never moves between mounts and the entire bug class is invisible to
// them. `shellFaces` is TRUE unless `?shell=legacy` is passed
// (Canvas.svelte), i.e. those specs were validating a mode users do not have.
// This spec goes to plain `/rack` deliberately; do not add a shell param.
//
// REGISTRY-DRIVEN, so a new DOM-source video module cannot opt out by
// accident: the subject list is DERIVED from DOM_SOURCE_LANE_TYPES in
// $lib/ui/workflow/dom-source-modules.ts (itself held exhaustive by that
// file's own grep gate). Every such module is spawned and expanded; whichever
// ones expose a local-file input get the full behavioural scenario. Nothing
// here is a hand-typed module list.
//
// NOT NAMED `video-*` DELIBERATELY. That prefix is a WEBGL_HEAVY_GLOB
// (e2e/webgl-heavy-globs.ts), which would enrol this spec on the sharded
// SwiftShader matrix and in the attest's Pass A. It does not belong there: what
// it measures is PLAYBACK LIFETIME — a media clock and an element's existence —
// and its one rendering assertion is a monotonic draw counter whose truth does
// not vary by renderer (verified: green under E2E_SWIFTSHADER=1, which is worth
// running by hand, not on every attest). Keeping it out also keeps the ATTESTED
// SET stable, so this change cannot be confused with one that alters what the
// GPU semaphore covers.
//
// DETERMINISM: the assertions are element STATE (`paused`, `currentTime`
// advancing) and the engine's own draw counter — never pixels, never a
// wall-clock budget standing in for progress. Waits are expressed as "the
// element advanced N seconds of MEDIA time" or as frame counts, both of which
// are renderer-independent; SwiftShader on CI renders ~7.9fps vs ~60 locally,
// so a ms budget would be a different assertion on every machine.

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';

const FIXTURE = fileURLToPath(new URL('../fixtures/lobby-clip.webm', import.meta.url));

/** Derive the DOM-source module types from the shared registry SOURCE, so this
 *  sweep auto-enrols a new module rather than needing a list here. */
function domSourceTypes(): string[] {
  const src = readFileSync(
    fileURLToPath(
      new URL('../../packages/web/src/lib/ui/workflow/dom-source-modules.ts', import.meta.url),
    ),
    'utf8',
  );
  const block = /DOM_SOURCE_LANE_TYPES[^[]*\[([\s\S]*?)\]/.exec(src);
  if (!block) throw new Error('could not parse DOM_SOURCE_LANE_TYPES — has the shape changed?');
  const types = [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  if (types.length === 0) throw new Error('DOM_SOURCE_LANE_TYPES parsed EMPTY — refusing to pass vacuously');
  return types;
}

const TYPES = domSourceTypes();

/** Non-perturbing engine probe. NOT `VideoEngine.read()` — that calls
 *  markWatched() internally, which would pin the node as a pull root and mask
 *  a rendering fault the same measurement is meant to detect. */
async function drawCount(page: Page, nodeId: string): Promise<number> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { getDomain: (d: string) => { framesDrawnFor: (i: string) => number } };
    };
    try { return w.__engine!().getDomain('video').framesDrawnFor(id); } catch { return -1; }
  }, nodeId);
}

/** Every <video>/<img> in the document that currently holds a src, with where
 *  it lives. Reads the DOM directly — the element is node-owned, so it is
 *  found wherever it has been adopted. */
async function liveMedia(page: Page) {
  return await page.evaluate(() =>
    [...document.querySelectorAll('video')]
      .map((v) => v as HTMLVideoElement)
      .filter((v) => !!(v.currentSrc || v.getAttribute('src')))
      .map((v) => ({
        testid: v.getAttribute('data-testid'),
        where: v.closest('[data-testid="dock-full-view"]')
          ? 'dock'
          : v.closest('[data-testid="headless-source-host"]')
            ? 'headless'
            : v.closest('[data-testid="node-media-parking"]')
              ? 'parking'
              : 'lane',
        currentTime: v.currentTime,
        paused: v.paused,
      })),
  );
}

async function boot(page: Page): Promise<void> {
  // Plain /rack — the DEFAULT shell. See the header.
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
}

for (const type of TYPES) {
  test(`${type}: media survives the expanded tray being dismissed`, async ({ page }) => {
    test.setTimeout(180_000);
    const nodeId = `collapse-${type}`;
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await boot(page);
    await spawnPatch(page, [{ id: nodeId, type, domain: 'video' }], [], { mountTimeout: 30_000 });

    // EXPAND — the owner's "expand".
    await page.evaluate((id) => {
      (globalThis as unknown as { __openDockFullView: (i: string) => void }).__openDockFullView(id);
    }, nodeId);
    const pane = page.locator('[data-testid="dock-full-view"]');
    await expect(pane).toHaveCount(1, { timeout: 20_000 });

    // Enrolment is DERIVED from the card, not declared here: a module gets the
    // full behavioural scenario iff its expanded card exposes BOTH a local-file
    // input and a transport play button — i.e. it is a local-file PLAYER, the
    // only shape whose "is it still playing?" question is even well posed.
    // Two groups fall out, and neither can opt out silently:
    //   * network / capture sources (peertube, tvLibrarian, archivist,
    //     cameraInput, loopback) — no fixture can drive them in CI;
    //   * one-shot loaders (frametable, videocube) — they upload a file into an
    //     atlas/texture and have no transport, so there is no playback to lose.
    // BOTH groups are still covered, by the SOURCE-level gate
    // (packages/web/src/lib/ui/media/card-media-lifetime.test.ts), which reads
    // every DOM-source card's unmount path and needs no browser.
    const fileInput = pane.locator('input[type="file"][data-testid$="-file-input"]').first();
    const playBtn = pane.locator('button[data-testid$="-play-btn"]').first();
    const isPlayer = (await fileInput.count()) > 0 && (await playBtn.count()) > 0;
    test.skip(
      !isPlayer,
      `${type} is not a local-file player (no file input and/or no transport) — its unmount path is gated by card-media-lifetime.test.ts`,
    );

    await fileInput.setInputFiles(FIXTURE);
    await expect(playBtn).toBeVisible({ timeout: 20_000 });
    await playBtn.click();

    // Confirm genuine playback BEFORE touching anything, in-page (never a
    // Playwright poll loop — that samples the very main thread it measures).
    await page.waitForFunction(
      () => {
        const vids = [...document.querySelectorAll('[data-testid="dock-full-view"] video')];
        return vids.some((v) => {
          const el = v as HTMLVideoElement;
          return !el.paused && el.currentTime > 0.05;
        });
      },
      undefined,
      { timeout: 30_000 },
    );

    const before = await liveMedia(page);
    const playingBefore = before.filter((m) => !m.paused);
    expect(playingBefore.length, `something must be playing before the collapse: ${JSON.stringify(before)}`)
      .toBeGreaterThan(0);
    const tBefore = Math.max(...playingBefore.map((m) => m.currentTime));
    const drawsBefore = await drawCount(page, nodeId);

    // COLLAPSE — the owner's "expanded tray is dismissed".
    await page.getByTestId('faceplate-collapse').click();
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(0, { timeout: 20_000 });

    // THE ASSERTION: the element still exists, still has its src, and its
    // MEDIA CLOCK advances past where it was. Waiting on media time rather
    // than wall-clock makes this renderer-independent by construction; the
    // timeout only BOUNDS the failure.
    const ADVANCE_S = 0.4;
    await page.waitForFunction(
      (target) => {
        const vids = [...document.querySelectorAll('video')].map((v) => v as HTMLVideoElement);
        return vids.some(
          (v) => !!(v.currentSrc || v.getAttribute('src')) && !v.paused && v.currentTime > target,
        );
      },
      tBefore + ADVANCE_S,
      { timeout: 30_000 },
    );

    const after = await liveMedia(page);
    const drawsAfter = await drawCount(page, nodeId);

    // The element survived the card move (it is now wherever the UI put it —
    // typically the off-screen headless host).
    expect(after.length, `the node's media element must survive the collapse: ${JSON.stringify(after)}`)
      .toBeGreaterThan(0);
    expect(
      after.some((m) => !m.paused),
      `media must still be PLAYING after the collapse: ${JSON.stringify(after)}`,
    ).toBe(true);
    expect(
      Math.max(...after.map((m) => m.currentTime)),
      `the media clock must have advanced past ${tBefore.toFixed(3)}s`,
    ).toBeGreaterThan(tBefore);

    // Rendering was never the fault (measured on the original bug: draws kept
    // advancing while playback died) — assert it stays healthy so a future
    // "fix" cannot trade playback for a frozen chain.
    expect(drawsAfter, `engine draws must keep advancing (${drawsBefore} -> ${drawsAfter})`)
      .toBeGreaterThan(drawsBefore);

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });
}
