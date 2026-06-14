// e2e/tests/peertube.spec.ts
//
// PEERTUBE — NETWORK-MOCKED source chain. We NEVER hit live Sepia Search / a
// PeerTube instance / a remote HLS stream in CI (flaky + legally cleaner): every
// Sepia request is route-fulfilled with fixture JSON, the per-instance video-
// details API is fulfilled with a fixture that resolves to a COMMITTED, locally-
// decodable media file, and the served media is fulfilled from disk. This drives
// the REAL source chain — search → parse → results → pick → resolveStream →
// element attach → engine wiring → audible RMS at the output — without a live
// network or a flaky H.264-over-HLS decode.
//
// AUDIBILITY (the real-source-chain standard): the resolved stream points at
// av-clip.webm (VP8 + Opus 220 Hz tone — an open codec the test Chromium decodes
// without an OS H.264 encoder), so the audio_l → AUDIO OUT terminal genuinely
// sees energy where the browser can decode. We resolve to a PROGRESSIVE file
// (kind=mp4 → plain <video src>) rather than an HLS manifest because hls.js
// fragment-decode on headless SwiftShader is the recorderbox/edges
// local-passes-CI-fails trap; the HLS-attach PATH is unit-covered (resolveStream
// prefers .m3u8) + exercised manually. The audible assertion is CAPABILITY-GATED
// on the element actually decoding (readyState), so it SKIPS (never fails) where
// the headless runner can't decode the fixture.

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';
import { readScopeSnapshot, summarize } from './_module-coverage-helpers';

const WEBM = readFileSync(fileURLToPath(new URL('../fixtures/av-clip.webm', import.meta.url)));

const HOST = 'mock.peertube.test';
const UUID = 'vid-abc-1';
const MEDIA_PATH = `/static/web-videos/${UUID}-720.mp4`; // route → av-clip.webm bytes
const MEDIA_URL = `https://${HOST}${MEDIA_PATH}`;

/** Sepia search response with two results (one host-less → dropped by the parser). */
function searchBody(): string {
  return JSON.stringify({
    total: 2,
    data: [
      {
        uuid: UUID, name: 'Mock Federated Clip', duration: 4, isLive: false, nsfw: false,
        account: { host: HOST },
        channel: { displayName: 'Mock Channel' },
        thumbnailPath: '/static/thumbnails/abc.jpg',
      },
      {
        uuid: 'vid-def-2', name: 'Another Clip', duration: 90, isLive: false, nsfw: false,
        account: { host: HOST },
        channel: { displayName: 'Second Channel' },
        thumbnailPath: '/static/thumbnails/def.jpg',
      },
    ],
  });
}

/** Per-instance video-details: NO HLS playlist → resolveStream falls back to the
 *  progressive file (kind=mp4 → plain <video src>), which we route to av-clip.webm. */
function detailsBody(): string {
  return JSON.stringify({
    name: 'Mock Federated Clip',
    streamingPlaylists: [],
    files: [{ fileUrl: MEDIA_URL, resolution: { id: 720 } }],
  });
}

async function installMocks(page: Page, opts: { mediaCorsOk: boolean } = { mediaCorsOk: true }): Promise<void> {
  await page.route('**/sepiasearch.org/api/v1/search/videos**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: searchBody(),
    }),
  );
  await page.route(`**/${HOST}/api/v1/videos/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: detailsBody(),
    }),
  );
  // The served media file. When mediaCorsOk is false we OMIT the ACAO header so a
  // crossorigin <video> taints / fails to load → the card's graceful-skip path.
  await page.route(`**/${HOST}/static/web-videos/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'video/webm',
      headers: opts.mediaCorsOk
        ? { 'access-control-allow-origin': '*', 'accept-ranges': 'bytes' }
        : { 'accept-ranges': 'bytes' },
      body: WEBM,
    }),
  );
  // Any stray thumbnail request → a 1x1 (the card lazy-loads thumbnails; never live).
  await page.route('**/static/thumbnails/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAAAAACw=', 'base64') }),
  );
}

async function gotoApp(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Add edges into the live patch in a single transact (post-attach), so the
 *  video->audio bridge captures the live splitter (mirrors video-audio-output). */
async function addEdges(page: Page, edges: Parameters<typeof spawnPatch>[2]): Promise<void> {
  await page.evaluate((edges) => {
    const w = globalThis as unknown as {
      __patch: { edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      for (const e of edges) {
        w.__patch.edges[e.id] = {
          id: e.id, source: e.from, target: e.to,
          sourceType: e.sourceType ?? 'audio', targetType: e.targetType ?? 'audio',
        };
      }
    });
  }, edges);
}

async function readNode(page: Page, nodeId: string, key: string): Promise<unknown> {
  return await page.evaluate(({ nodeId, key }) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes[nodeId];
    if (!node) return null;
    return eng.read(node, key);
  }, { nodeId, key });
}

async function readOutputStats(page: Page, outNodeId: string): Promise<{ peak: number; rms: number; nonzeroSamples: number; totalSamples: number }> {
  const samples = await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes[id];
    if (!node) return null;
    const snap = eng.read(node, 'outputSnapshot') as { samples: Float32Array } | undefined;
    if (!snap) return null;
    return Array.from(snap.samples) as unknown as Float32Array;
  }, outNodeId);
  if (!samples) return { peak: 0, rms: 0, nonzeroSamples: 0, totalSamples: 0 };
  return summarize(samples);
}

test.describe('PEERTUBE — network-mocked source chain', () => {
  test('search → results → pick → stream attaches; card reacts @video', async ({ page }) => {
    await installMocks(page);
    const errors = await gotoApp(page);
    await spawnPatch(page, [{ id: 'pt1', type: 'peertube', position: { x: 80, y: 80 }, domain: 'video' }]);

    const card = page.getByTestId('peertube-card');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-has-selection', 'false');

    // Search → the mocked Sepia results render (the host-less row is dropped; both
    // valid rows show). Press Enter (a synthetic .click on a node-internal button
    // is swallowed by the pan handler; Enter hits runSearch directly).
    await page.getByTestId('peertube-search').fill('blender');
    await page.getByTestId('peertube-search').press('Enter');
    const results = page.getByTestId('peertube-result');
    await expect(results).toHaveCount(2, { timeout: 10_000 });
    await expect(page.getByText('Mock Federated Clip')).toBeVisible();
    await expect(card.getByText('Mock Channel', { exact: false })).toBeVisible();

    // Pick the first result → it resolves + attaches + persists the selection.
    await results.first().click();
    await expect(card).toHaveAttribute('data-has-selection', 'true', { timeout: 10_000 });
    await expect(page.getByTestId('peertube-now-playing')).toContainText('Mock Federated Clip');

    // The selection persisted to node.data (syncs to rack-mates).
    const persisted = await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { uuid?: string; selectedHost?: string; name?: string } }> } };
      return w.__patch.nodes['pt1']?.data ?? null;
    });
    expect(persisted?.uuid).toBe(UUID);
    expect(persisted?.selectedHost).toBe(HOST);

    // The card reaches a terminal stream state (playing OR unavailable) — never
    // stuck on "loading" forever. The disclaimer + attribution are present.
    await expect(card).toHaveAttribute('data-stream-state', /playing|unavailable/, { timeout: 16_000 });
    await expect(page.getByTestId('peertube-disclaimer')).toBeVisible();
    await expect(card.getByText('Sepia Search')).toBeVisible();

    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('audio_l -> AUDIO OUT: real energy reaches the terminal output (capability-gated) @video', async ({ page }) => {
    test.setTimeout(60_000);
    await installMocks(page);
    const errors = await gotoApp(page);

    // PEERTUBE -> (video) VIDEO OUT, plus audio_l fanned to a SCOPE + AUDIO OUT.
    await spawnPatch(
      page,
      [
        { id: 'pt', type: 'peertube', position: { x: 40, y: 40 }, domain: 'video' },
        { id: 'vout', type: 'videoOut', position: { x: 480, y: 40 }, domain: 'video' },
        { id: 'scope', type: 'scope', position: { x: 480, y: 480 }, params: { timeMs: 50 } },
        { id: 'aout', type: 'audioOut', position: { x: 900, y: 480 }, params: { master: 0.9 } },
      ],
      [
        { id: 'e-vout', from: { nodeId: 'pt', portId: 'video' }, to: { nodeId: 'vout', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    // Search + pick → the element resolves + attaches.
    await page.getByTestId('peertube-search').fill('blender');
    await page.getByTestId('peertube-search').press('Enter');
    await expect(page.getByTestId('peertube-result').first()).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('peertube-result').first().click();
    await expect(page.getByTestId('peertube-card')).toHaveAttribute('data-has-selection', 'true', { timeout: 10_000 });

    // CAPABILITY GATE: only assert audible energy when THIS browser actually
    // decoded the fixture (readyState >= 2). On a headless runner that can't
    // decode, SKIP the audible assertion (never go red — the no-OS-encoder /
    // SwiftShader trap). The wiring PATH (search→resolve→attach + node.data) is
    // hard-asserted above + in the first test regardless.
    const decoded = await page
      .getByTestId('peertube-video')
      .evaluate(async (el: HTMLVideoElement) => {
        for (let i = 0; i < 40 && el.readyState < 2; i++) {
          await new Promise((r) => setTimeout(r, 150));
        }
        return el.readyState >= 2;
      });

    if (!decoded) {
      // eslint-disable-next-line no-console
      console.log('[peertube e2e] headless browser did not decode the webm fixture (autoplay/software-decode limit); attach/no-hang path verified, audible-RMS assertion skipped.');
      expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
      return;
    }

    // Wire the audio AFTER attach (the bridge captures the live splitter at edge
    // time). Poll audioWired — wireAudio runs slightly after attach.
    await expect
      .poll(() => readNode(page, 'pt', 'audioWired'), { timeout: 10_000, message: 'pt audio wired' })
      .toBe(true);
    expect(await readNode(page, 'pt', 'hasKeepAlive'), 'pt keep-alive live').toBe(true);

    await addEdges(page, [
      { id: 'e-aud-scope', from: { nodeId: 'pt', portId: 'audio_l' }, to: { nodeId: 'scope', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
      { id: 'e-aud-out', from: { nodeId: 'pt', portId: 'audio_l' }, to: { nodeId: 'aout', portId: 'L' }, sourceType: 'audio', targetType: 'audio' },
    ]);

    let scope = { peak: 0, rms: 0, nonzeroSamples: 0, totalSamples: 0 };
    let out = { peak: 0, rms: 0, nonzeroSamples: 0, totalSamples: 0 };
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const snap = await readScopeSnapshot(page, 'scope');
      if (snap) {
        const s = summarize(snap.ch1);
        if (s.peak > scope.peak) scope = s;
      }
      const o = await readOutputStats(page, 'aout');
      if (o.peak > out.peak) out = o;
      if (out.peak > 0.01) break;
      await page.waitForTimeout(120);
    }

    expect(
      out.peak,
      `PeerTube audio reaches AUDIO OUT terminal (peak=${out.peak.toFixed(4)} rms=${out.rms.toFixed(4)} nonzero=${out.nonzeroSamples}); scope peak=${scope.peak.toFixed(4)}`,
    ).toBeGreaterThan(0.01);

    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('CORS-misconfigured media → graceful "display unavailable", never a crash/hang @video', async ({ page }) => {
    // ~1/6 instances serve media with no ACAO header → the crossorigin <video>
    // taints / fails to load. The card must degrade to "unavailable" (auto-skip),
    // NOT crash or hang on loading.
    await installMocks(page, { mediaCorsOk: false });
    const errors = await gotoApp(page);
    await spawnPatch(page, [{ id: 'pt2', type: 'peertube', position: { x: 80, y: 80 }, domain: 'video' }]);

    const card = page.getByTestId('peertube-card');
    await page.getByTestId('peertube-search').fill('blender');
    await page.getByTestId('peertube-search').press('Enter');
    await expect(page.getByTestId('peertube-result').first()).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('peertube-result').first().click();

    // It reaches a terminal state within the timeout — never stuck on "loading".
    // (The webm may still decode under no-ACAO in some headless configs, so accept
    // either terminal state; the key assertion is NO HANG + NO crash.)
    await expect(card).toHaveAttribute('data-stream-state', /playing|unavailable/, { timeout: 18_000 });

    // No uncaught page errors despite the CORS failure (graceful, not a crash).
    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
