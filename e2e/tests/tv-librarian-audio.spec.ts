// e2e/tests/tv-librarian-audio.spec.ts
//
// TV LIBRARIAN — AUDIBILITY of the tuned stream (the real-chain regression
// guard for the operator-reported "video module = no audio out" bug).
//
// THE BUG: TV LIBRARIAN's card creates its <video crossorigin muted> so the
// programmatic play() on channel-select satisfies the autoplay policy. But it
// NEVER un-muted the element, and a MUTED media element feeds SILENCE into its
// MediaElementAudioSourceNode (the mute gates the audio AT THE SOURCE, upstream
// of the Web Audio tap). So audio_l / audio_r carried zero even with the
// splitter correctly wired — VIDEOBOX's `videoEl.muted = false` step was
// missing. Proven empirically through the real hls.js path: a muted element →
// MediaElementSource peak 0.00; un-muting on `playing` → peak 0.61.
//
// THE TEST drives the REAL default source chain: mock famelack dataset → pick a
// country → pick a channel → hls.js attaches a mock `.m3u8` whose single fMP4
// segment is a committed AVC+AAC clip with a 440 Hz tone → the card reaches
// `playing` → wireAudio() swaps audio_l/audio_r to the live splitter AND
// un-mutes → we patch audio_l/audio_r into AUDIO OUT and assert energy at AUDIO
// OUT's TERMINAL tap (the limiter feeding ctx.destination = genuine audibility,
// not just "the bridge delivered a node to a scope").
//
// CI never contacts a live TV CDN (every request is route-fulfilled) and never
// runs an encoder (the segment is committed bytes). The RMS assertion is gated
// on the renderer actually DECODING the clip (it reaches `playing`); if a
// headless build can't decode AVC/AAC the test skips rather than flake.
//
// Per-port "edge materializes" assertions do NOT count for this module — this
// is the real source→module→audible-output chain the repo standard requires.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';
import { readScopeSnapshot, summarize } from './_module-coverage-helpers';

// Committed AVC+AAC MP4 (≈13 KB) with a 440 Hz tone. See
// e2e/fixtures/generate-hls-clip.mjs for how it's produced.
const HLS_CLIP = readFileSync(fileURLToPath(new URL('../fixtures/hls-clip.mp4', import.meta.url)));

// Mock famelack dataset — one US channel whose stream is our mock HLS.
const META = { US: { country: 'United States', capital: 'Washington', hasChannels: true, channelCount: 1 } };
const US_CHANNELS = [
  {
    nanoid: 'tone1', name: 'Tone Channel',
    stream_urls: ['https://mock.tv/tone/playlist.m3u8'], youtube_urls: [],
    languages: ['eng'], country: 'us', isGeoBlocked: false,
  },
];

// A one-segment fMP4 playlist: EXT-X-MAP init + the same clip as the single
// media segment (hls.js 1.6 plays a plain AVC+AAC MP4 in both roles).
const SEG_URL = 'https://mock.tv/tone/seg0.mp4';
const HLS_PLAYLIST =
  '#EXTM3U\n' +
  '#EXT-X-VERSION:7\n' +
  '#EXT-X-TARGETDURATION:2\n' +
  '#EXT-X-PLAYLIST-TYPE:VOD\n' +
  `#EXT-X-MAP:URI="${SEG_URL}"\n` +
  '#EXTINF:1.6,\n' +
  `${SEG_URL}\n` +
  '#EXT-X-ENDLIST\n';

async function installMocks(page: Page): Promise<void> {
  await page.route('**/famelack-data/**/countries_metadata.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META) }),
  );
  await page.route('**/famelack-data/**/countries/us.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(US_CHANNELS) }),
  );
  // The mock HLS manifest → our one-segment fMP4 playlist.
  await page.route('https://mock.tv/tone/playlist.m3u8', (route) =>
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: HLS_PLAYLIST }),
  );
  // The init + media segment → the committed AVC+AAC clip bytes.
  await page.route(SEG_URL, (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: HLS_CLIP }),
  );
}

/** Add edges into the live patch in a single transact (post-tune). The
 *  video→audio bridge captures the source AudioNode at edge-add time, so this
 *  runs AFTER wireAudio() swapped audio_l/audio_r from the silent placeholder
 *  to the live splitter — the real session order. */
async function addEdges(page: Page, edges: Parameters<typeof spawnPatch>[2]): Promise<void> {
  await page.evaluate((edges) => {
    const w = globalThis as unknown as {
      __patch: { edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      for (const e of edges) {
        w.__patch.edges[e.id] = {
          id: e.id,
          source: e.from,
          target: e.to,
          sourceType: e.sourceType ?? 'audio',
          targetType: e.targetType ?? 'audio',
        };
      }
    });
  }, edges);
}

/** Read a module instrumentation key via __engine (audio + video). */
async function readNode(page: Page, nodeId: string, key: string): Promise<unknown> {
  return await page.evaluate(
    ({ nodeId, key }) => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      if (!eng) return null;
      const node = w.__patch.nodes[nodeId];
      if (!node) return null;
      return eng.read(node, key);
    },
    { nodeId, key },
  );
}

/** Read AUDIO OUT's terminal output tap (the limiter feeding ctx.destination)
 *  and summarize its energy — the genuine audibility probe. */
async function readOutputStats(page: Page, outNodeId: string) {
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
    return Array.from(snap.samples) as unknown as number[];
  }, outNodeId);
  if (!samples) return { peak: 0, rms: 0, nonzeroSamples: 0, totalSamples: 0 };
  return summarize(samples);
}

test.describe('TV LIBRARIAN — tuned-stream audio reaches the destination @video', () => {
  test('audio_l/audio_r → AUDIO OUT: real energy reaches the terminal output', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);

    await installMocks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // TV LIBRARIAN → AUDIO OUT (the audibility probe) + a SCOPE (the weak probe,
    // kept for diagnostic contrast). audio_l → AUDIO OUT.L + SCOPE.ch1;
    // audio_r → AUDIO OUT.R.
    await spawnPatch(
      page,
      [
        { id: 'tv', type: 'tvLibrarian', position: { x: 40, y: 40 }, domain: 'video' },
        { id: 'scope', type: 'scope', position: { x: 520, y: 40 }, params: { timeMs: 50 } },
        { id: 'aout', type: 'audioOut', position: { x: 960, y: 40 }, params: { master: 0.9 } },
      ],
      [],
    );

    const card = page.getByTestId('tv-librarian-card');
    await expect(card).toBeVisible();

    // Tune the deterministic LIST path: US → the one tone channel.
    await page.getByTestId('tv-view-list').click();
    await page.getByTestId('tv-country-select').selectOption('US');
    await expect(page.getByTestId('tv-channel')).toHaveCount(1);
    await page.getByTestId('tv-channel').first().click();
    await expect(page.getByTestId('tv-now-playing')).toContainText('Tone Channel');

    // The committed clip is a short (~1.6s) VOD, whereas a real TV stream never
    // ends. Loop it so there's CONTINUOUS audio across the measurement window
    // (a real live stream produces a steady signal). This only sets DOM props on
    // the card-owned element; the card's own wireAudio/unmute path is unchanged.
    await page.evaluate(() => {
      const v = document.querySelector('[data-testid="tv-video"]') as HTMLVideoElement | null;
      if (v) v.loop = true;
    });

    // The stream must actually DECODE (reach `playing`) for there to be audio.
    // If a headless build can't decode AVC/AAC it lands on `unavailable` — skip
    // rather than flake (capability-gated, per the recorderbox/edges CI lesson).
    await expect(card).toHaveAttribute('data-stream-state', /playing|unavailable/, { timeout: 20_000 });
    const state = await card.getAttribute('data-stream-state');
    test.skip(state !== 'playing', `renderer could not decode the AVC/AAC HLS clip (state=${state})`);

    // wireAudio() must have run (audio_l/audio_r are now the live splitter, not
    // the silent placeholder) before we patch audio downstream. Poll — the wire
    // runs slightly after `playing`, and the card retries until it sticks.
    await expect
      .poll(() => readNode(page, 'tv', 'audioWired'), { timeout: 10_000, message: 'tv audio wired' })
      .toBe(true);
    expect(await readNode(page, 'tv', 'hasKeepAlive'), 'tv keep-alive live').toBe(true);

    // Patch audio_l/audio_r downstream (post-tune, so the bridge captures the
    // live splitter).
    await addEdges(page, [
      { id: 'e-l-scope', from: { nodeId: 'tv', portId: 'audio_l' }, to: { nodeId: 'scope', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
      { id: 'e-l-out', from: { nodeId: 'tv', portId: 'audio_l' }, to: { nodeId: 'aout', portId: 'L' }, sourceType: 'audio', targetType: 'audio' },
      { id: 'e-r-out', from: { nodeId: 'tv', portId: 'audio_r' }, to: { nodeId: 'aout', portId: 'R' }, sourceType: 'audio', targetType: 'audio' },
    ]);

    // Poll both probes over a window. The clip is short, so it loops or replays;
    // any window where the tone is decoding catches non-zero energy.
    let scope = { peak: 0, rms: 0, nonzeroSamples: 0, totalSamples: 0 };
    let out = { peak: 0, rms: 0, nonzeroSamples: 0, totalSamples: 0 };
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      // Keep the looped clip playing — if it paused at the boundary before loop
      // re-engaged, kick it back into play so the tone keeps decoding.
      await page.evaluate(() => {
        const v = document.querySelector('[data-testid="tv-video"]') as HTMLVideoElement | null;
        if (v && v.paused) void v.play().catch(() => {});
      });
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

    // THE audibility assertion: the tuned stream's audio reached the limiter
    // feeding ctx.destination. This is what was BROKEN (silent, because the
    // <video> stayed muted) and is the real fix.
    expect(
      out.peak,
      `tuned-stream audio reaches AUDIO OUT terminal (peak=${out.peak.toFixed(4)} rms=${out.rms.toFixed(4)} nonzero=${out.nonzeroSamples}); scope peak=${scope.peak.toFixed(4)} — if both are 0, the element is still muted / audio never wired`,
    ).toBeGreaterThan(0.01);

    // Direct corroboration of the fix: the element must be un-muted once audio
    // is wired (a muted element feeds silence into the MediaElementSource).
    const muted = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="tv-video"]') as HTMLVideoElement | null;
      return v?.muted ?? true;
    });
    expect(muted, 'the <video> is un-muted after audio wiring (else the MediaElementSource is silent)').toBe(false);

  });
});
