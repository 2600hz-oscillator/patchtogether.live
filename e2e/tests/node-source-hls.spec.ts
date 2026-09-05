// e2e/tests/node-source-hls.spec.ts
//
// ⚠ THE FILENAME IS LOAD-BEARING — DO NOT RENAME THIS TO `peertube-*.spec.ts`,
// `tv-librarian-*.spec.ts`, `video-*.spec.ts` OR ANYTHING ENDING
// `-render-smoke.spec.ts`. `e2e/webgl-heavy-globs.ts` classifies by BASENAME
// PREFIX, and its own header says "ADDING A SPEC TO THIS LIST DELETES ITS PR
// COVERAGE. IT DOES NOT MOVE IT" — the `e2e-video` lane it used to move things
// to was deleted in #839. A spec swept into the heavy lane runs NOWHERE on a PR.
//
// ⚠ THIS HAS ALREADY HAPPENED TO THIS EXACT ISSUE. P1's acceptance spec shipped
// as `videobox-node-lifetime.spec.ts`, matched `**/videobox-*.spec.ts`, and ran
// green-because-absent for its whole first life. VERIFIED for this file against
// the real `minimatch` over the real glob list before it was written: it matches
// NO heavy glob, so it rides the sharded PR matrix. Nothing here is WebGL-heavy
// anyway — it reads element counts, one engine flag and one media src, and
// samples no pixels.
//
// LEG-02 P3 (#1511) — PEERTUBE's and TV LIBRARIAN's source belongs to the NODE,
// not to a mounted card. This is the acceptance test for that claim, and it is
// written so that it can only pass for the right reason.
//
// ── WHY THE OBVIOUS SPEC WOULD BE WORTHLESS ─────────────────────────────────
//
// "Tune a channel and assert it streams" passes on `main` too — because on
// `main` the source survives via `<HeadlessSourceHost>`, which parks the REAL
// card off-screen at `left:-9999px` and keeps every one of its loops running.
// The picture is identical; the ownership is not. So a spec that only asserts
// the media is alive cannot tell the fix from the compensation it replaces, and
// would go on passing if someone reinstated the host tomorrow.
//
// ⚠ THE DISCRIMINATOR IS THE ABSENCE, AND IT IS A PERMANENT LEG OF EVERY TEST
// HERE: the module's card count is 0 AND its `headless-source-host` count is 0,
// asserted IN THE SAME TEST as the liveness. Without that pair, "it still works"
// and "the host is still rescuing it" are indistinguishable from the output.
//
// ── THE LIVENESS INSTRUMENT, AND WHY IT IS NOT A DECODED FRAME ──────────────
//
// The observable is `<video>.currentSrc` reaching a `blob:` URL. That is the
// MediaSource hls.js mints inside `attachMedia()`, so it is present the moment
// the demuxer is attached and BEFORE any byte is decoded. Deliberate:
//
//   * it is CODEC-INDEPENDENT. A headless Chromium without proprietary codecs
//     cannot decode the AVC/AAC fixture — which is exactly why
//     `peertube.spec.ts` and `tv-librarian-audio.spec.ts` carry a named
//     capability skip in `scripts/e2e-skip-budget.mjs`. Those two are the
//     real-media audio guards and stay that way; this file must run everywhere,
//     so it must not depend on a decoder.
//   * it is RENDERER-INDEPENDENT. No frames, no rAF, no wall-clock budget
//     standing in for a frame count.
//   * it is SPECIFIC to the claim. A `blob:` src cannot appear unless something
//     resolved the persisted selection to a URL and handed it to hls.js — and in
//     these tests the only candidate is the controller, because there is no card.
//
// Every network request is route-fulfilled: CI never contacts famelack, Sepia
// Search or a PeerTube instance.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

/** A trivially-empty HLS manifest — enough for `attachMedia()` to mint its
 *  MediaSource, which is all this file measures. hls.js then fails to find
 *  playable media and the controller marks the stream unavailable, which is the
 *  graceful path and not what is under test here. */
const STUB_M3U8 = '#EXTM3U\n#EXT-X-ENDLIST\n';

const US_CHANNELS = [
  {
    nanoid: 'usa1', name: 'Mock News USA',
    stream_urls: ['https://mock.example/usa-news/playlist.m3u8'], youtube_urls: [],
    languages: ['eng'], country: 'us', isGeoBlocked: false,
  },
  {
    nanoid: 'usa2', name: 'Mock Sports USA',
    stream_urls: ['https://mock.example/usa-sports/playlist.m3u8'], youtube_urls: [],
    languages: ['eng'], country: 'us', isGeoBlocked: false,
  },
];

const PT_DETAILS = {
  name: 'Mock Federated Clip',
  streamingPlaylists: [{ playlistUrl: 'https://mock.example/peertube/master.m3u8' }],
};

async function installMocks(page: Page): Promise<void> {
  await page.route('**/famelack-data/**/countries_metadata.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ US: { country: 'United States', hasChannels: true, channelCount: 2 } }),
    }),
  );
  await page.route('**/famelack-data/**/countries/us.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(US_CHANNELS) }),
  );
  await page.route('**/sepiasearch.org/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [], total: 0 }) }),
  );
  await page.route('**/api/v1/videos/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PT_DETAILS) }),
  );
  await page.route('**/*.m3u8', (route) =>
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: STUB_M3U8 }),
  );
}

/** ⚠ A CAP THAT BOUNDS A FAILURE, NOT A GATE, and set at P1's measured number
 *  for the same measured reason: the FIRST `goto` of a run against a cold
 *  `task e2e:serve` pays Vite's on-demand transform of the whole module graph,
 *  which is a start-up cost of whichever spec runs first rather than a property
 *  of this one. Warm, this resolves in ~2 s. Nothing here is gated on elapsed
 *  time — the gates are element counts, an engine flag and a media src. */
const BOOT_CAP_MS = 90_000;

async function boot(page: Page): Promise<void> {
  await installMocks(page);
  // Plain `/rack` — the DEFAULT shell, where an unfaced module renders a
  // placeholder tile and its real card exists only inside the dock full view.
  // That is the state a saved rack is in, not an edge case.
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_CAP_MS });
}

/*
 * ⚠ `expectNoCardAndNoHost` STOOD HERE AND IS DELETED. READ THIS BEFORE
 * REPLACING IT WITH SOMETHING THAT LOOKS LIKE IT.
 *
 * It was this file's "PERMANENT DISCRIMINATOR": every liveness assertion was
 * paired with `toHaveCount(0)` on a per-module surface testid and on an
 * off-screen `headless-source-host`, so a green liveness result could not be
 * explained by some OTHER mount doing the work.
 *
 * Neither testid is emitted by anything in the tree any more. A matcher whose
 * selector cannot match is satisfied by a page that rendered nothing at all,
 * so the discriminator had stopped discriminating — it reported "no other
 * owner" for the same reason it would report it on a blank page.
 *
 * ⚠ NAMED COVERAGE LOSS, carried into the PR body. The alternative explanation
 * it ruled out (a surface, not the node, owning the source) is now ruled out
 * by CONSTRUCTION: the node source registry is the only owner and no component
 * competes with it. Re-arming this as a RUNTIME claim would need a new
 * discriminator against the faceplate dock body — a new gate, which is an
 * owner decision rather than this branch's.
 */

/** Does the ENGINE hold this node's element? The one observable that separates
 *  "a <video> exists in the DOM" from "the module has a live source". */
async function engineHasElement(page: Page, nodeId: string): Promise<boolean> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { getDomain: (d: string) => { read: (i: string, k: string) => unknown } };
    };
    try {
      return w.__engine!().getDomain('video').read(id, 'hasVideoElement') === true;
    } catch {
      return false;
    }
  }, nodeId);
}

/** The node-owned element's placement + whether a demuxer is attached to it. */
async function mediaState(page: Page, testId: string) {
  return await page.evaluate((tid) => {
    const els = [...document.querySelectorAll(`video[data-testid="${tid}"]`)] as HTMLVideoElement[];
    return els.map((el) => ({
      src: el.currentSrc || el.getAttribute('src') || '',
      muted: el.muted,
      where: el.closest('[data-testid="headless-source-host"]')
        ? 'headless'
        : el.closest('[data-testid="dock-full-view"]')
          ? 'dock'
          : el.closest('[data-testid="node-media-parking"]')
            ? 'parking'
            : 'lane',
    }));
  }, testId);
}

/** Write a PERSISTED selection straight into `node.data`, which is the exact
 *  shape a saved rack carries and the exact route a PEER's tune arrives by. No
 *  card is involved at any point — that is the whole test. */
async function persistData(page: Page, nodeId: string, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    ({ id, data }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      };
      const n = w.__patch.nodes[id];
      if (!n) throw new Error(`no node ${id}`);
      if (!n.data) n.data = {};
      for (const [k, v] of Object.entries(data)) n.data[k] = v;
    },
    { id: nodeId, data: patch },
  );
}

test.describe('the HLS tuners: the source belongs to the NODE (#1511)', () => {
  test('TV LIBRARIAN tunes a persisted channel with NO card ever mounted @video', async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await boot(page);
    // Spawn and then touch NOTHING. The dock is never opened, so no
    // tv-librarian card is ever constructed at any point in this test.
    await spawnPatch(page, [{ id: 'tv-node', type: 'tvLibrarian', domain: 'video' }], [], {
      mountTimeout: 30_000,
    });


    // The ELEMENT exists and the ENGINE holds it, with nothing mounted. On
    // `main` this was true only because the headless host had constructed the
    // card and its `onMount` poll had run.
    await expect
      .poll(() => engineHasElement(page, 'tv-node'), {
        message: 'the engine never received the node-owned <video> — attachExternalSource is nobody\'s job now',
        timeout: 15_000,
      })
      .toBe(true);
    const parked = await mediaState(page, 'tv-video');
    expect(parked, 'exactly ONE node-owned element for this node').toHaveLength(1);
    expect(parked[0]!.where, 'the element is PARKED, not inside any surface').toBe('parking');
    expect(parked[0]!.muted, 'the element is created muted so its autoplay is allowed').toBe(true);
    // ⚠ THE BEFORE HALF, so the poll below measures a TRANSITION rather than a
    // state that was already true. Without it a `blob:` src that arrived from
    // anywhere — a seeded rack, a leftover element — would satisfy the gate and
    // the test would be invariant to the thing it claims to measure.
    expect(parked[0]!.src, 'nothing has been selected yet, so nothing should be attached').toBe('');

    // A SAVED RACK / A PEER'S TUNE: the selection arrives in node.data and
    // nothing else happens. The controller has to notice it, resolve it and
    // hand it to hls.js.
    await persistData(page, 'tv-node', {
      countryCode: 'US',
      channel: {
        nanoid: 'usa1',
        name: 'Mock News USA',
        streamUrl: 'https://mock.example/usa-news/playlist.m3u8',
        country: 'us',
        languages: ['eng'],
      },
    });

    await expect
      .poll(async () => (await mediaState(page, 'tv-video'))[0]?.src ?? '', {
        message:
          'the persisted channel never reached hls.js. With no card anywhere, the selection -> stream step had no owner before #1511 — this is that defect, not a mock problem',
        timeout: 20_000,
      })
      .toMatch(/^blob:/);

    // THE DISCRIMINATOR AGAIN, after the liveness: a host or a card appearing
    // mid-test would make everything above prove nothing.
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('PEERTUBE resolves a persisted video with NO card ever mounted @video', async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await boot(page);
    await spawnPatch(page, [{ id: 'pt-node', type: 'peertube', domain: 'video' }], [], {
      mountTimeout: 30_000,
    });

    await expect
      .poll(() => engineHasElement(page, 'pt-node'), {
        message: 'the engine never received the node-owned <video>',
        timeout: 15_000,
      })
      .toBe(true);
    // The BEFORE half — see the tvLibrarian test: the poll below must measure a
    // transition, not a state that was already true.
    expect(
      (await mediaState(page, 'peertube-video'))[0]?.src,
      'nothing has been selected yet, so nothing should be attached',
    ).toBe('');

    // peertube's selection is a (host, uuid) PAIR and resolving it needs a
    // per-instance DETAILS hop that tvLibrarian does not have — so this leg
    // exercises a genuinely different half of the controller rather than the
    // same one twice.
    await persistData(page, 'pt-node', {
      selectedHost: 'mock.example',
      uuid: 'mock-uuid-1',
      name: 'Mock Federated Clip',
    });

    await expect
      .poll(async () => (await mediaState(page, 'peertube-video'))[0]?.src ?? '', {
        message:
          'the persisted video never reached hls.js — the details hop and the attach both live on the controller now, and neither ran',
        timeout: 20_000,
      })
      .toMatch(/^blob:/);

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
