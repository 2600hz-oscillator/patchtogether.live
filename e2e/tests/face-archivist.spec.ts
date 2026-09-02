// e2e/tests/face-archivist.spec.ts
//
// THE ARCHIVIST FACE, driven for real on the DEFAULT shell — the seams no other
// gate can see.
//
// ⚠ THE FILENAME IS DELIBERATE — NOT `archivist-face.spec.ts`. `face-` is the
// shape `face-videobox.spec.ts` / `face-peertube.spec.ts` established, and it
// cannot be swept into the WebGL-heavy lane by a future broad glob named after
// the module — a spec in that lane runs NOWHERE in PR CI and is green forever.
// Verified against `e2e/webgl-heavy-globs.ts` rather than assumed. Nothing here
// is WebGL-heavy: it reads DOM facts, graph state and a media clock, and
// samples no pixels.
//
// ⚠ THE SHIPPED `archivist.spec.ts` BOOTS `?shell=legacy` (×3), which is
// precisely the surface promotion does not change — so all of it stays green
// while covering a surface no player meets. This file is the default-shell leg
// it owes.
//
// ⚠ AND THE PRECONDITION HERE IS THE OPPOSITE OF PEERTUBE'S, WHICH IS THE WHOLE
// POINT OF THIS MODULE'S PROMOTION. peertube left `DOM_SOURCE_LANE_TYPES`, so
// its face spec asserts NO card exists anywhere. archivist is STILL IN that
// set: its card is MOUNTED, in `<HeadlessSourceHost>`, which is what keeps the
// three node-owned elements attached and a loaded item playing — and it is
// parked at `left:-9999px` with `pointer-events: none`, so nothing on it can be
// clicked. "The card still has those controls" is therefore TRUE and USELESS at
// the same time, and that is the exact combination no unit gate can express.
//
// `archivist-face-model.test.ts` pins the ranking, the cell kind, the
// noUserControl declaration, the shader's `uGain` read, the one-component-
// three-mounts property, the not-a-second-owner property and every other
// source-level claim. `face-rack-status-source.test.ts` proves the body
// declares what it paints. None of them can see:
//
//  1. ⚠ THAT AN ITEM CAN BE FOUND AND LOADED AT ALL UNDER THE SHELL. A fresh
//     archivist has NO item and the factory searches nothing on its own, so
//     with the face declared and no body mounted the module would be a media
//     source that can never be given any media. This is a RENDER fact.
//  2. THAT THE PARKED CARD IS REALLY UNREACHABLE — the premise of the whole
//     design. If the headless host were somehow clickable, the bodies would be
//     redundant rather than load-bearing, and a future author would delete them.
//  3. THAT THE LANE TILE ALONE IS ENOUGH. cameraInput shipped `fullViewBody`-
//     only and lost its only route to a first capture. This drives the TILE
//     with the dock never opened.
//  4. THAT THE DELETED READOUTS SURVIVED THE MOVE. The `0:04 / 2:00` line and
//     the `Internet Archive · {type}` line are deleted on every surface; the
//     facts they carried must survive on a control's `aria-valuetext` and the
//     picture's accessible name, and nothing may paint them as resting text.
//  5. THAT SCREEN OFF IS NOT A PAUSE. The switch reclaims the preview's space;
//     the ITEM must keep playing while the canvas is gone.
//
// ⚠ THE MOCK RETURNS EXACTLY ONE DOC. `loadRandomFromDocs` picks a RANDOM doc
// and auto-advances past any that will not decode, so a multi-row fixture makes
// "which item loaded" a coin flip — the tvLibrarian failure that passed locally
// three times over. One row makes the random pick deterministic and every claim
// below well-posed.

import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnPatch, canvasPane, MAIN_CANVAS } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

/**
 * ⚠ EVERY LANE ASSERTION IS SCOPED TO THE MAIN CANVAS, AND ON THIS MODULE THAT
 * IS LOAD-BEARING RATHER THAN TIDY.
 *
 * `HeadlessSourceHost` mounts the parked card inside its OWN single-node
 * `<SvelteFlow>`, so it contributes a second `.svelte-flow__node[data-id=farc]`
 * carrying a second `archivist-card`. A bare
 * `.svelte-flow__node[data-id="farc"] [data-testid="archivist-card"]` therefore
 * matches the PARKED card and reports "the legacy card is still in the lane" on
 * a perfectly correct promotion — which is exactly what the first draft of this
 * file did. `MAIN_CANVAS` is `_helpers`' own answer (`.flow > .svelte-flow`,
 * the CHILD combinator the host's grandchild flow cannot satisfy), and
 * archivist is the one module where the host is guaranteed present, so the
 * distinction can never be skipped here.
 */
const laneNode = (nodeId: string) =>
  `${MAIN_CANVAS} .svelte-flow__node[data-id="${nodeId}"]`;

/** VP8 + Opus (~2 s), an open codec the test Chromium decodes with no OS H.264
 *  encoder — the fixture `archivist.spec.ts` already resolves to. */
const SHORT_WEBM = readFileSync(fileURLToPath(new URL('../fixtures/av-clip.webm', import.meta.url)));

/** ⚠ THE LONG FIXTURE (120 s), FOR THE LEG THAT MEASURES A CLOCK. The
 *  peertube face spec paid the tuition for this and recorded it: its SCREEN leg
 *  shipped on the ~2 s clip, was green locally three times, and failed on CI
 *  shard 2/12 with `0.000 s over 19 samples` — the clip had simply ENDED inside
 *  the observation window on a loaded shard. ⚠ NOTE WHAT THAT FAILURE LOOKED
 *  LIKE: a zero that reads exactly like "the SCREEN switch became a pause", a
 *  product P0, when it was the fixture. The headroom is ASSERTED below rather
 *  than assumed, so a future fixture swap reddens on the headroom line instead
 *  of on the ruling. */
const LONG_WEBM = readFileSync(fileURLToPath(new URL('../fixtures/lobby-clip-long.webm', import.meta.url)));

/** A REAL PNG, for the leg that loads an IMAGE item — the fixture
 *  `archivist.spec.ts` uses for the same purpose. See the tile leg's note. */
const TINY_PNG = readFileSync(fileURLToPath(new URL('../fixtures/tiny.png', import.meta.url)));

const IDENT = 'face_arc_1';
const TITLE = 'A Mock Archive Film';

/** Post-toggle observation window (a CAP on the failure, not the gate — the
 *  gate is accumulated forward progress, measured in-page). */
const OBSERVE_MS = 3_000;
/** Forward seconds of media that must accumulate in that window. Well under
 *  `OBSERVE_MS` so a slow SwiftShader runner has headroom. */
const MIN_PROGRESS_S = 0.3;
/** The media time this spec's SCREEN leg can consume between "the element is
 *  playing" and the end of its observation window, worst case on a loaded
 *  SwiftShader shard. Asserted against the LIVE element's remaining duration,
 *  never against a number remembered about a file. */
const WORST_CASE_MEDIA_S = 30;

/** Install archive.org route mocks. ⚠ ONE DOC — see the header. */
async function installMocks(
  page: Page,
  opts: { mediatype: string; file: string; format: string; bytes: Buffer; contentType: string },
): Promise<void> {
  await page.route('**/advancedsearch.php**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        responseHeader: { status: 0 },
        response: {
          numFound: 1,
          start: 0,
          docs: [{ identifier: IDENT, title: TITLE, mediatype: opts.mediatype }],
        },
      }),
    }),
  );
  await page.route('**/metadata/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        server: 'mock.archive.test',
        dir: `/0/items/${IDENT}`,
        metadata: { identifier: IDENT, title: TITLE, 'access-restricted-item': 'false' },
        files: [
          { name: '__ia_thumb.jpg', format: 'Item Tile', source: 'original' },
          { name: opts.file, format: opts.format, source: 'original' },
        ],
      }),
    }),
  );
  await page.route(`**/items/${IDENT}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: opts.contentType,
      headers: { 'access-control-allow-origin': '*', 'accept-ranges': 'bytes' },
      body: opts.bytes,
    }),
  );
}

const VIDEO_MOCK = {
  mediatype: 'movies', file: 'film.webm', format: 'WebM',
  bytes: SHORT_WEBM, contentType: 'video/webm',
} as const;

async function boot(page: Page): Promise<void> {
  // Plain /rack — the DEFAULT shell. `archivist.spec.ts`'s `?shell=legacy` is
  // precisely the surface promotion does not change.
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  // `canvasPane` rather than `.svelte-flow__pane:visible.first()` — the hosts
  // contribute panes of their own, and "the first one in markup order" is a
  // coincidence rather than an address (see `_helpers`' MAIN_CANVAS note).
  await canvasPane(page).waitFor({ state: 'visible' });
}

/** Open this node's dock faceplate (the auto-retrying tv-librarian pattern —
 *  the tile button is hit-testable while a previous pane is still tearing
 *  down, so one click can land on nothing). */
async function openDock(page: Page, nodeId: string): Promise<Locator> {
  const shell = page.locator(`${laneNode(nodeId)} [data-testid="module-shell"]`);
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

/** The node-owned media element's live state, read document-wide — for a faced
 *  archivist the element is PARKED in the headless host, never in the pane. */
async function mediaState(page: Page) {
  return await page.evaluate(() => {
    const v = document.querySelector('video[data-testid="archivist-video"]') as HTMLVideoElement | null;
    if (!v) return null;
    return {
      hasSrc: !!(v.currentSrc || v.getAttribute('src')),
      paused: v.paused,
      currentTime: v.currentTime,
      duration: v.duration,
    };
  });
}

/** Accumulate FORWARD media progress in-page over `ms`. A running accumulator
 *  rather than a start/end delta, so a loop the page never scheduled is
 *  distinguishable from a clock that genuinely did not advance. */
async function measureProgress(page: Page, ms: number) {
  return await page.evaluate(async (windowMs) => {
    const v = document.querySelector('video[data-testid="archivist-video"]') as HTMLVideoElement | null;
    if (!v) return { progressS: 0, samples: 0, elapsedMs: 0, reason: 'no element' };
    const startMs = performance.now();
    let last = v.currentTime;
    let progress = 0;
    let samples = 0;
    await new Promise<void>((resolve) => {
      const tick = () => {
        const now = v.currentTime;
        if (now > last) progress += now - last;
        last = now;
        samples += 1;
        if (performance.now() - startMs >= windowMs) { resolve(); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return { progressS: progress, samples, elapsedMs: performance.now() - startMs, reason: '' };
  }, ms);
}

/** Search through a FACE surface's own box and wait for the item to land on the
 *  GRAPH — the observable that says the off-screen card received the command
 *  and completed the whole fetch → parse → pick → attach chain. */
async function searchFrom(page: Page, scope: Locator, prefix: string, type: string): Promise<void> {
  await scope.locator(`[data-testid="${prefix}-type"]`).selectOption(type);
  await scope.locator(`[data-testid="${prefix}-search"]`).fill('nasa');
  await scope.locator(`[data-testid="${prefix}-search"]`).press('Enter');
  await page.waitForFunction(
    (id) => {
      const w = window as unknown as {
        __patch?: { nodes: Record<string, { data?: { item?: unknown } }> };
      };
      return !!w.__patch?.nodes?.[id]?.data?.item;
    },
    'farc',
    { timeout: SLOW_BOOT_TEST_TIMEOUT_MS },
  );
}

test.describe('ARCHIVIST face — the promotion is what makes it reachable', () => {
  // ⚠ A PAGE ERROR FAILS EVERY TEST IN THIS FILE. A TypeError inside a
  // `$derived` does not surface as a thrown assertion — it takes the subtree's
  // render down and the symptom lands somewhere else entirely (the
  // tv-librarian-face incident, twice).
  // ⚠ MOCKS ARE INSTALLED PER TEST, NOT HERE, because the fixture is part of
  // each leg's correctness budget: the SCREEN leg measures a media clock and
  // needs the 120 s file, the others do not.
  test.beforeEach(({ page }) => {
    page.on('pageerror', (err) => {
      throw new Error(`uncaught page error during an archivist face test: ${err.message}`);
    });
  });

  test('the card is PARKED and UNCLICKABLE, and the face still SEARCHES and LOADS @video', async ({ page }) => {
    // Serialises the dock's lazy body chunk plus a real webm decode behind the
    // boot — bounded from the one export site, never a flat literal.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await installMocks(page, VIDEO_MOCK);
    await boot(page);
    await spawnPatch(page, [{ id: 'farc', type: 'archivist', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });

    // ⚠ THE PRECONDITION THIS WHOLE FILE RESTS ON, AND IT IS TWO-SIDED — which
    // is what makes archivist different from peertube. The card must NOT be in
    // the lane (the MAIN canvas's lane — see `laneNode`; the parked card lives
    // in a flow node of its own and is asserted present two lines down)...
    const laneCard = page.locator(`${laneNode('farc')} [data-testid="archivist-card"]`);
    await expect(laneCard).toHaveCount(0);

    // ...and it MUST be alive in the headless host, because that mount is what
    // keeps the three node-owned elements attached. A promotion that lost it
    // would take the module's source with it.
    const host = page.locator('[data-testid="headless-source-host"][data-node-id="farc"]');
    await expect(host).toHaveCount(1, { timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await expect(host.locator('[data-testid="archivist-card"]')).toHaveCount(1);

    // ⚠ AND IT IS GENUINELY UNREACHABLE — the premise of the whole design,
    // measured rather than assumed. If this ever became clickable the bodies
    // would be redundant and a future author would delete them.
    const parked = await host.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { pointerEvents: cs.pointerEvents, left: cs.left, ariaHidden: el.getAttribute('aria-hidden') };
    });
    expect(parked.pointerEvents, 'the headless host must not take pointer events').toBe('none');
    expect(parked.ariaHidden).toBe('true');

    // The face body is the only reachable surface, and it works.
    const dock = await openDock(page, 'farc');
    const body = dock.getByTestId('archivist-face-body');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // Nothing is loaded yet — the empty state names this surface's own
    // condition, and the transport does not exist because there is no item.
    await expect(body.getByTestId('archivist-face-empty')).toBeVisible();
    await expect(body.getByTestId('archivist-face-play')).toHaveCount(0);

    // ⚠ A YEAR BOUND IS TYPED BEFORE THE SEARCH, AND THIS LINE IS THE WHOLE
    // REASON THE LEG DOES IT. `<input type="number">` under `bind:value` is
    // NUMBER-LIKE to Svelte: its binding writes `to_number(input.value)`, so
    // the bound state holds a NUMBER (or null when empty) the moment a digit is
    // typed — never the string the declaration's initialiser suggests. A
    // `writeSearchInputs` that called `.trim()` on it therefore threw a
    // TypeError inside `ydoc.transact`, taking the search gesture down with it,
    // and every shipped archivist test left the year boxes empty so nothing
    // ever reached the line. Filling one is the only way a gate sees it.
    await body.getByTestId('archivist-face-year-from').fill('1970');
    await body.getByTestId('archivist-face-year-to').fill('1985');

    await searchFrom(page, body, 'archivist-face', 'video');

    // The bounds really reached the GRAPH as NUMBERS — the shape `currentQuery`
    // accepts. A NaN or a string here means the parse silently dropped them and
    // the query ran unbounded.
    const years = await page.evaluate(() => {
      const w = window as unknown as {
        __patch?: { nodes: Record<string, { data?: { yearFrom?: unknown; yearTo?: unknown } }> };
      };
      const d = w.__patch?.nodes?.farc?.data;
      return { from: d?.yearFrom, to: d?.yearTo };
    });
    expect(years, 'the typed year bounds reached the graph as finite numbers').toEqual({
      from: 1970,
      to: 1985,
    });

    // The whole chain ran: the off-screen card received the command, fetched,
    // parsed, picked a derivative and ATTACHED it to the node-owned element.
    await expect(body).toHaveAttribute('data-has-item', 'true');
    await expect(body).toHaveAttribute('data-media-type', 'video');
    await expect
      .poll(async () => (await mediaState(page))?.hasSrc ?? false, {
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
        message: 'the node-owned <video> received the mocked src',
      })
      .toBe(true);

    // ⚠ AND THE ELEMENT IS STILL IN THE PARKED HOST, NOT IN THE PANE. The body
    // BLITS the engine output and must never adopt — a DOM node has one parent
    // and the card owns the lease.
    const whereIsElement = await page.evaluate(() => {
      const v = document.querySelector('video[data-testid="archivist-video"]');
      return {
        inHost: !!v?.closest('[data-testid="headless-source-host"]'),
        inDock: !!v?.closest('[data-testid="dock-full-view"]'),
      };
    });
    expect(whereIsElement.inHost, 'the element must stay parked with its owner').toBe(true);
    expect(whereIsElement.inDock, 'the body must BLIT, never ADOPT').toBe(false);

    // The transport appears for time media, and the picture's accessible name
    // carries the identity the deleted `Internet Archive · {type}` line held.
    await expect(body.getByTestId('archivist-face-play')).toBeVisible();
    await expect(body.getByTestId('archivist-face-preview')).toHaveAttribute(
      'aria-label',
      new RegExp(TITLE),
    );
  });

  test('the LANE TILE alone can search — the dock is never opened @video', async ({ page }) => {
    // ⚠ cameraInput's LESSON, on the module it costs most. A fresh archivist
    // has no item, so a `fullViewBody`-only extension would leave the lane an
    // idle gradient with no way to fill it and the player would have to already
    // know to open the dock.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    // ⚠ AN IMAGE ITEM MUST BE SERVED REAL IMAGE BYTES. The first draft spread
    // `VIDEO_MOCK` and overrode only the mediatype/file/format, so archive.org's
    // "still.png" arrived as `video/webm` with a webm body. `loadRandomFromDocs`
    // AUTO-ADVANCES past a derivative that will not decode, and with the header's
    // deliberate ONE-doc fixture there is nothing to advance to — so no item
    // ever reached the graph and the leg failed inside `searchFrom`, blaming the
    // tile for a fixture that could not have loaded on any surface.
    await installMocks(page, {
      mediatype: 'image', file: 'still.png', format: 'PNG',
      bytes: TINY_PNG, contentType: 'image/png',
    });
    await boot(page);
    await spawnPatch(page, [{ id: 'farc', type: 'archivist', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });

    const tile = page.locator(`${laneNode('farc')} [data-testid="module-shell"]`);
    await expect(tile).toBeVisible({ timeout: BOOT_MS });
    const tileControls = tile.getByTestId('archivist-tile-controls');
    await expect(tileControls).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // The dock is NEVER opened in this test — that is the point.
    await expect(page.getByTestId('dock-full-view')).toHaveCount(0);

    await searchFrom(page, tileControls, 'archivist-tile', 'image');

    // It really loaded, from the tile, with no dock anywhere.
    await expect(page.getByTestId('dock-full-view')).toHaveCount(0);
    await expect
      .poll(async () => await page.evaluate(() => {
        const img = document.querySelector('img[data-testid="archivist-image"]') as HTMLImageElement | null;
        return !!img && img.complete && img.naturalWidth > 0;
      }), {
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
        message: 'the node-owned <img> decoded the mocked still',
      })
      .toBe(true);

    // ⚠ THE COMPACT TILE DROPS ONLY WHAT A 192 px LANE CANNOT HOLD. The year
    // bounds and the attribution row are gone; the search and ↻ next — the only
    // routes to an item — are not.
    await expect(tileControls.getByTestId('archivist-tile-year-from')).toHaveCount(0);
    await expect(tileControls.getByTestId('archivist-tile-search-btn')).toBeVisible();
    await expect(tileControls.getByTestId('archivist-tile-reroll-btn')).toBeVisible();
  });

  test('the DELETED readouts are gone, and what they carried survives @video', async ({ page }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await installMocks(page, VIDEO_MOCK);
    await boot(page);
    await spawnPatch(page, [{ id: 'farc', type: 'archivist', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });
    const dock = await openDock(page, 'farc');
    const body = dock.getByTestId('archivist-face-body');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await searchFrom(page, body, 'archivist-face', 'video');

    // ⚠ THE `0:04 / 2:00` LINE IS GONE — from the DOM, not merely hidden.
    await expect(page.getByTestId('archivist-face-time')).toHaveCount(0);
    await expect(page.getByTestId('archivist-time')).toHaveCount(0);

    // ...and no surface paints a `m:ss / m:ss` pair as a resting text node.
    // Read off the rendered TEXT rather than a selector, so a differently-named
    // element carrying the same readout is caught too.
    const bodyText = (await body.innerText()).replace(/\s+/g, ' ');
    expect(bodyText, `a m:ss / m:ss readout is painted: ${bodyText}`).not.toMatch(/\d+:\d{2}\s*\/\s*\d+:\d{2}/);

    // ⚠ WHAT IT CARRIED SURVIVES ON THE CONTROL, speakable and assertable.
    const seek = body.getByTestId('archivist-face-seek');
    await expect(seek).toBeVisible();
    await expect(seek).toHaveAttribute('aria-valuetext', /\d+:\d{2} of \d+:\d{2}/);

    // ⚠ THE `Internet Archive · {type}` LINE IS GONE, and its content lives on
    // the picture's accessible name.
    expect(bodyText).not.toContain('Internet Archive ·');
    await expect(body.getByTestId('archivist-face-preview')).toHaveAttribute(
      'aria-label',
      /from the Internet Archive/,
    );

    // ⚠ THE PLAY-ONLY WARNING IS A LAMP WITH A STATIC CAPTION — kept, because
    // it is the only account of a patched `video` jack delivering the idle
    // pattern, but painting no derived text.
    const lamp = body.getByTestId('archivist-face-cors-warn');
    await expect(lamp).toBeVisible();
    await expect(lamp).toHaveAttribute('data-lit', '1'); // a video item is NOT clean
    await expect(lamp).toHaveAttribute('aria-label', /PLAY-ONLY/);
    expect(bodyText).toContain('CLEAN OUT');
    expect(bodyText).not.toContain('play-only (no clean output)');

    // The attribution anchor — a navigational CONTROL, kept — really points at
    // the item's archive.org page.
    await expect(body.locator('[data-testid="archivist-face-meta"] a')).toHaveAttribute(
      'href',
      new RegExp(`archive\\.org/details/${IDENT}`),
    );
  });

  test('SCREEN OFF collapses the picture and is NOT a pause @video', async ({ page }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    // ⚠ THE LONG FIXTURE. See its declaration — a ~2 s clip ENDS inside the
    // observation window on a loaded shard and reports a zero that reads
    // exactly like the product bug this leg exists to catch.
    await installMocks(page, { ...VIDEO_MOCK, bytes: LONG_WEBM });
    await boot(page);
    await spawnPatch(page, [{ id: 'farc', type: 'archivist', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });
    const dock = await openDock(page, 'farc');
    const body = dock.getByTestId('archivist-face-body');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await searchFrom(page, body, 'archivist-face', 'video');

    // MUTE the parked element before playing: headless Chromium's autoplay
    // policy rejects play() on a video WITH an audio track even under a
    // gesture, and the card swallows that rejection — so an unmuted element
    // would make this leg measure the browser's policy rather than the SCREEN
    // switch. `archivist.spec.ts` mutes for the same reason.
    await page.evaluate(() => {
      const v = document.querySelector('video[data-testid="archivist-video"]') as HTMLVideoElement | null;
      if (v) v.muted = true;
    });

    await body.getByTestId('archivist-face-play').click();
    await expect
      .poll(async () => (await mediaState(page))?.paused ?? true, {
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
        message: 'the parked element started playing',
      })
      .toBe(false);

    // ⚠ HEADROOM ASSERTED, NOT ASSUMED. If the fixture is ever swapped for a
    // short one this line goes red instead of the ruling below.
    const before = await mediaState(page);
    expect(before, 'the element exists').not.toBeNull();
    expect(
      before!.duration - before!.currentTime,
      `the fixture must outlast the observation window (${WORST_CASE_MEDIA_S}s worst case)`,
    ).toBeGreaterThan(WORST_CASE_MEDIA_S);

    // Turn the SCREEN off. The canvas goes; the item must not.
    await body.getByTestId('archivist-face-screen-toggle').click();
    await expect(body.getByTestId('archivist-face-preview')).toHaveAttribute(
      'data-preview-collapsed',
      'true',
    );
    await expect(body.getByTestId('archivist-face-canvas')).toHaveCount(0);

    const measured = await measureProgress(page, OBSERVE_MS);
    expect(measured.samples, 'the in-page accumulator actually ran').toBeGreaterThan(5);
    expect(
      measured.progressS,
      `SCREEN OFF stopped playback: ${measured.progressS.toFixed(3)} s over ${measured.samples} `
        + `samples / ${Math.round(measured.elapsedMs)} ms. The switch must reclaim the preview's `
        + 'space and nothing else — the element, its play() and the playhead pump all belong to '
        + 'the off-screen card, which this body never touches.',
    ).toBeGreaterThan(MIN_PROGRESS_S);

    // And switching it back on restores a LIVE picture, not a stale frame.
    await body.getByTestId('archivist-face-screen-toggle').click();
    await expect(body.getByTestId('archivist-face-canvas')).toBeVisible();
    expect((await mediaState(page))!.paused, 'the item is still playing').toBe(false);
  });
});
