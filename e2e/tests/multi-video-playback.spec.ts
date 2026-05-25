// e2e/tests/multi-video-playback.spec.ts
//
// MULTI-VIDEO playback — the load-bearing regression guard for "only ONE
// video plays at a time" (operator report; PR #301 fixed it for VIDEOBOX but
// VIDEOVARISPEED / CAMERA never got the keep-alive).
//
// ROOT CAUSE (verified): each video-source module owns a <video> decoded into
// a GL texture. Chromium throttles a <video>'s decode to ~1 fps unless its
// audio is pulled by the AudioContext in real time (the element is offscreen /
// tiny and texture-sampling doesn't count as "rendered" for the heuristic).
// VIDEOBOX added a silent keep-alive (src -> gain(0) -> destination) so it
// decodes full-rate when unpatched; VIDEOVARISPEED created the
// MediaElementSource but never connected anything to the destination -> its
// element was never pulled -> with N sources, all but one throttle -> "only
// one plays". The fix gives all three the same keep-alive
// (video-audio-keepalive.ts).
//
// This spec spawns the operator's topology shape — 4x VIDEOVARISPEED -> 1
// VIDEOMIXER -> VIDEO-OUT — plus a per-source VIDEO-OUT so we can prove EACH
// source advances (the throttle bug shows up as only one per-source output
// changing). The operator's 4vids.imp.json references local files absent in
// CI, so we use it for TOPOLOGY only and load a committed fixture into each
// node.
//
// We use TWO committed fixtures:
//   - av-clip.webm   (VP8 + Opus): moving picture + audible 220 Hz tone. Used
//     to assert BOTH frame-to-frame change AND audio-produced-when-patched.
//   - lobby-clip.webm is video-only (no audio track) so can't exercise audio;
//     we standardize on av-clip here.
//
// Sampling is WINDOWED (never two fixed reads) — reuse of the
// videobox-output.spec.ts pattern — so a momentarily-stalled decode under CI
// load doesn't false-fail, while a genuinely frozen (throttled) source still
// fails (its per-source output never changes).
//
// REPRO NOTE: a fresh Playwright context is incognito-like, so the
// persisted-state reload regression (operator: "reload then load 1 video -> no
// playback, incognito fixes it") does NOT reproduce here — see PR notes. This
// spec deterministically reproduces + guards the multi-video THROTTLE: before
// the keep-alive fix only one per-source VIDEO-OUT advances.

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';
import { readScopeSnapshot, summarize } from './_module-coverage-helpers';

const AV_FIXTURE = fileURLToPath(new URL('../fixtures/av-clip.webm', import.meta.url));

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Coarse pixel signature for change detection over a VIDEO-OUT canvas,
 *  scoped to a specific node id (multiple VIDEO-OUTs on the rack). */
async function outSignature(page: Page, nodeId: string): Promise<number> {
  const handle = page.locator(`canvas[data-testid="video-out-canvas"][data-node-id="${nodeId}"]`);
  return await handle.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let sig = 0;
    for (let i = 0; i < data.length; i += 256) {
      sig += (data[i]! + data[i + 1]! * 2 + data[i + 2]! * 3) * ((i % 997) + 1);
    }
    return sig;
  });
}

/** Brightest sampled pixel over a node's VIDEO-OUT (non-idle => real frame). */
async function outMaxBrightness(page: Page, nodeId: string): Promise<number> {
  const handle = page.locator(`canvas[data-testid="video-out-canvas"][data-node-id="${nodeId}"]`);
  return await handle.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let max = 0;
    for (let i = 0; i < data.length; i += 4) {
      const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      if (v > max) max = v;
    }
    return max;
  });
}

/** Poll a node's VIDEO-OUT over a window; return whether it BOTH showed a real
 *  (non-idle) frame AND its signature changed (the source is advancing). */
async function outAdvances(
  page: Page,
  nodeId: string,
  windowMs = 6000,
): Promise<{ moved: boolean; maxBright: number; distinct: number }> {
  const sigs = new Set<number>();
  let maxBright = 0;
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const b = await outMaxBrightness(page, nodeId);
    if (b > maxBright) maxBright = b;
    sigs.add(await outSignature(page, nodeId));
    if (maxBright > 40 && sigs.size >= 2) break;
    await page.waitForTimeout(150);
  }
  return { moved: maxBright > 40 && sigs.size >= 2, maxBright, distinct: sigs.size };
}

/** Set data.isPlaying on a node via the Yjs doc (the card's $effect reacts +
 *  plays the element). We drive playback through the data layer rather than
 *  clicking the per-card play button because the N cards are laid out across a
 *  large canvas — Svelte Flow positions nodes via CSS transforms, so an
 *  offscreen card's button can't be scrolled into the viewport for a real
 *  click. setInputFiles + getImageData both work on offscreen nodes; only
 *  .click() needs visibility, so we avoid it. */
async function writePlaying(page: Page, nodeId: string, next: boolean): Promise<void> {
  await page.evaluate(
    ({ nodeId, next }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const t = w.__patch.nodes[nodeId];
        if (!t) return;
        if (!t.data) t.data = {};
        t.data.isPlaying = next;
      });
    },
    { nodeId, next },
  );
}

/** Load the AV fixture into a specific VIDEOVARISPEED card (scoped by node id)
 *  and start playback via the data layer. */
async function loadAndPlay(page: Page, nodeId: string): Promise<void> {
  const card = page.locator(`.svelte-flow__node[data-id="${nodeId}"]`);
  await card.locator('[data-testid="videovarispeed-file-input"]').setInputFiles(AV_FIXTURE);
  await expect(card.locator('[data-testid="videovarispeed-card"]')).toHaveAttribute(
    'data-has-local-file', 'true', { timeout: 8000 },
  );
  await writePlaying(page, nodeId, true);
  await expect(card.locator('[data-testid="videovarispeed-card"]')).toHaveAttribute(
    'data-is-playing', 'true', { timeout: 4000 },
  );
}

/** Read a video-module instrumentation key (e.g. hasKeepAlive) via __engine. */
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

/** Add edges into the live patch in a single transact (post-spawn). Used to
 *  wire the cross-domain audio edges AFTER each source's file is loaded — the
 *  video→audio bridge captures the source AudioNode at edge-add time, so it
 *  must be added once wireAudio() has swapped the source's audio_l from the
 *  silent placeholder to the live MediaElementSource splitter (this mirrors the
 *  real session order: load the file, THEN patch its audio downstream). */
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

/** Build the N-source topology: N VIDEOVARISPEED, each -> its own VIDEO-OUT
 *  (per-source proof) + -> a VIDEOMIXER (in1..in4) -> a shared VIDEO-OUT. A
 *  scope receives every source's audio_l so we can assert audio-when-patched.
 *  N is clamped to the mixer's 4 inputs for the mixer wiring; per-source outs
 *  scale freely (used by the scale test). The AUDIO edges are returned
 *  SEPARATELY so the caller adds them after loading files (see addEdges). */
function buildTopology(n: number) {
  const nodes: Parameters<typeof spawnPatch>[1] = [];
  const edges: Parameters<typeof spawnPatch>[2] = [];
  const audioEdges: Parameters<typeof spawnPatch>[2] = [];

  // Cards are 320x420; lay them out on a wide grid with generous gaps so no
  // node overlaps another (overlap makes Svelte Flow intercept clicks on the
  // covered card's controls).
  const ROW = 520;
  // Mixer + its dedicated output (only for n <= 4 inputs).
  const mixInputs = Math.min(n, 4);
  nodes.push({ id: 'mix', type: 'videoMixer', position: { x: 1080, y: 40 }, domain: 'video' });
  nodes.push({ id: 'mixout', type: 'videoOut', position: { x: 1500, y: 40 }, domain: 'video' });
  edges.push({ id: 'e-mixout', from: { nodeId: 'mix', portId: 'out' }, to: { nodeId: 'mixout', portId: 'in' }, sourceType: 'video', targetType: 'video' });

  // Scope for audio assertion.
  nodes.push({ id: 'scope', type: 'scope', position: { x: 1080, y: 560 }, params: { timeMs: 50 } });

  for (let i = 0; i < n; i++) {
    const vv = `vv${i}`;
    const out = `out${i}`;
    nodes.push({ id: vv, type: 'videovarispeed', position: { x: 40, y: 40 + i * ROW }, domain: 'video' });
    nodes.push({ id: out, type: 'videoOut', position: { x: 560, y: 40 + i * ROW }, domain: 'video' });
    edges.push({ id: `e-vvout-${i}`, from: { nodeId: vv, portId: 'video' }, to: { nodeId: out, portId: 'in' }, sourceType: 'video', targetType: 'video' });
    if (i < mixInputs) {
      edges.push({ id: `e-mix-${i}`, from: { nodeId: vv, portId: 'video' }, to: { nodeId: 'mix', portId: `in${i + 1}` }, sourceType: 'video', targetType: 'video' });
    }
    // Audio: each source's audio_l -> scope ch1 (they sum). Proves audio is
    // produced through the cross-domain bridge when the user patches it.
    audioEdges.push({ id: `e-aud-${i}`, from: { nodeId: vv, portId: 'audio_l' }, to: { nodeId: 'scope', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' });
  }
  return { nodes, edges, audioEdges };
}

test.describe('multi-video playback — N sources all decode at once', () => {
  test('4x VIDEOVARISPEED -> MIXER: every source advances + mixer shows moving video + audio is produced', async ({ page }) => {
    const errors = await setup(page);
    const { nodes, edges, audioEdges } = buildTopology(4);
    await spawnPatch(page, nodes, edges);

    // Load + play the fixture into all four sources. NOTE: at this point the
    // sources are UNPATCHED (no audio downstream) — this is exactly the
    // scenario the throttle bug bites: nothing is pulling the elements except
    // each module's OWN silent keep-alive. (If we patched audio_l -> scope
    // first, the scope's analyser would pull the element and mask the bug.)
    for (let i = 0; i < 4; i++) await loadAndPlay(page, `vv${i}`);

    // Each source's keep-alive must be live — this is the throttle fix. A null
    // keep-alive is exactly the pre-fix state where, unpatched, the
    // MediaElementSource has no path to the destination and Chromium throttles
    // all but one element's decode.
    for (let i = 0; i < 4; i++) {
      expect(await readNode(page, `vv${i}`, 'hasKeepAlive'), `vv${i} keep-alive live`).toBe(true);
      expect(await readNode(page, `vv${i}`, 'audioWired'), `vv${i} audio wired`).toBe(true);
    }

    await page.waitForTimeout(600);

    // PER-SOURCE (UNPATCHED): every VIDEO-OUT must show real, moving video while
    // the sources have NO audio patched downstream. Pre-fix, with no keep-alive,
    // only ONE of these advances (the rest are throttled to ~1 fps and read as a
    // frozen frame). We assert ALL FOUR move. This is the visual repro of "only
    // one plays at a time".
    const results: Array<{ i: number; moved: boolean; maxBright: number; distinct: number }> = [];
    for (let i = 0; i < 4; i++) {
      const r = await outAdvances(page, `out${i}`);
      results.push({ i, ...r });
    }
    await page.screenshot({ path: 'test-results/multi-video-4src.png' });

    const stalled = results.filter((r) => !r.moved);
    expect(
      stalled.length,
      `all 4 sources advance while unpatched — stalled: ${JSON.stringify(stalled)} (full: ${JSON.stringify(results)})`,
    ).toBe(0);

    // Now patch each source's audio_l -> scope. The video→audio bridge captures
    // the live splitter at this point (vs. the silent placeholder if we'd
    // patched pre-load), mirroring the real session order: load, then patch.
    await addEdges(page, audioEdges);

    // MIXER OUTPUT: the combined output must also show moving video.
    const mix = await outAdvances(page, 'mixout');
    expect(
      mix.moved,
      `mixer output moving (maxBright=${mix.maxBright} distinct=${mix.distinct})`,
    ).toBe(true);

    // AUDIO: with all four sources' audio_l patched into the scope, the scope
    // must see real audio energy (the av-clip carries a 220 Hz tone). Poll a
    // short window so the analyser fills.
    let audio = { peak: 0, rms: 0, nonzeroSamples: 0, totalSamples: 0 };
    const audioDeadline = Date.now() + 4000;
    while (Date.now() < audioDeadline) {
      const snap = await readScopeSnapshot(page, 'scope');
      if (snap) {
        const s = summarize(snap.ch1);
        if (s.peak > audio.peak) audio = s;
        if (audio.peak > 0.01) break;
      }
      await page.waitForTimeout(150);
    }
    expect(
      audio.peak,
      `audio produced when patched (peak=${audio.peak.toFixed(4)} rms=${audio.rms.toFixed(4)} nonzero=${audio.nonzeroSamples})`,
    ).toBeGreaterThan(0.01);

    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  // SCALE: spawn ~10 sources and require they ALL advance. Gated !CI — ten
  // simultaneous decodes + ten VIDEO-OUTs is heavy for a shared CI runner with
  // software GL; the 4-source case above is the CI guard. Documents the Chrome
  // simultaneous-decode ceiling if fewer than N advance.
  test('scale: 10x VIDEOVARISPEED all advance (local only)', async ({ page }) => {
    test.skip(!!process.env.CI, 'scale run is heavy for CI software-GL runners; 4-source case is the CI guard');
    const N = 10;
    const errors = await setup(page);
    const { nodes, edges, audioEdges } = buildTopology(N);
    await spawnPatch(page, nodes, edges);

    for (let i = 0; i < N; i++) await loadAndPlay(page, `vv${i}`);
    await addEdges(page, audioEdges);
    await page.waitForTimeout(800);

    const results: Array<{ i: number; moved: boolean; maxBright: number; distinct: number }> = [];
    for (let i = 0; i < N; i++) {
      const r = await outAdvances(page, `out${i}`, 8000);
      results.push({ i, ...r });
    }
    const advancing = results.filter((r) => r.moved).length;
    // Report the ceiling explicitly. We require ALL to advance; if Chrome caps
    // simultaneous decodes below N this fails with a precise count so the
    // ceiling is documented in the run output.
    expect(
      advancing,
      `all ${N} sources advance — ${advancing}/${N} moved (Chrome simultaneous-decode ceiling if < ${N}): ${JSON.stringify(results)}`,
    ).toBe(N);

    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
