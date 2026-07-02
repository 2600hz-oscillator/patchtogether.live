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
import { visualChecksEnabled } from './_visual-checks';
import { readScopeSnapshot, summarize } from './_module-coverage-helpers';

/** Read AUDIO OUT's terminal tap (the limiter feeding ctx.destination) and
 *  summarize its energy. Unlike a SCOPE's ch1 analyser — which buffers samples
 *  whether or not the signal reaches the speakers — this proves the audio is
 *  AUDIBLE (it reached the terminal output stage). See audio-out.ts
 *  read('outputSnapshot'). */
async function readOutputStats(
  page: Page,
  outNodeId: string,
): Promise<{ peak: number; rms: number; nonzeroSamples: number; totalSamples: number }> {
  const samples = await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes[id];
    if (!node) return null;
    const snap = eng.read(node, 'outputSnapshot') as { samples: Float32Array; sampleRate: number } | undefined;
    if (!snap) return null;
    return Array.from(snap.samples) as unknown as Float32Array;
  }, outNodeId);
  if (!samples) return { peak: 0, rms: 0, nonzeroSamples: 0, totalSamples: 0 };
  return summarize(samples);
}

const AV_FIXTURE = fileURLToPath(new URL('../fixtures/av-clip.webm', import.meta.url));

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/rack');
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

/** Drive the video engine's render step() a bounded number of times with a
 *  macrotask gap between steps, so the <video> elements' rVFC decode callbacks
 *  can fire and mark frames dirty. Returns each source's uploadCount delta —
 *  an ENGINE-INTERNAL liveness signal that proves the decode->texImage2D path
 *  is alive WITHOUT sampling software-GL framebuffer pixels (which flake under
 *  CI's rAF throttling). This is the deterministic mirror of the pixel-based
 *  outAdvances() probe: a frozen/throttled source's uploadCount won't advance,
 *  exactly as its rendered pixels wouldn't change. */
async function uploadDeltasOverSteps(
  page: Page,
  nodeIds: string[],
  windowMs = 4000,
): Promise<Record<string, number>> {
  return await page.evaluate(
    async ({ nodeIds, windowMs }) => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain: (d: string) => { step: () => void; read: (id: string, k: string) => unknown } } | null;
      };
      const eng = w.__engine?.();
      if (!eng) return {};
      const vid = eng.getDomain('video');
      const start: Record<string, number> = {};
      for (const id of nodeIds) start[id] = (vid.read(id, 'uploadCount') as number) ?? 0;
      const t0 = performance.now();
      while (performance.now() - t0 < windowMs) {
        vid.step();
        // Macrotask gap so the event loop can service rVFC decode callbacks
        // (which set frameDirty -> the next step() does a real upload).
        await new Promise<void>((res) => setTimeout(res, 16));
      }
      const out: Record<string, number> = {};
      for (const id of nodeIds) out[id] = ((vid.read(id, 'uploadCount') as number) ?? 0) - start[id];
      return out;
    },
    { nodeIds, windowMs },
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

  // Scope for a visual audio read AND an AUDIO OUT for the real audibility
  // assertion. The scope's ch1 analyser buffers samples regardless of whether
  // they reach the speakers, so a scope-only check can't tell "signal reached
  // an analyser" apart from "signal reached the destination" — that gap is
  // exactly how a video-source-audio regression hid. AUDIO OUT's terminal tap
  // (read('outputSnapshot')) proves audibility: it samples the limiter that
  // feeds ctx.destination.
  nodes.push({ id: 'scope', type: 'scope', position: { x: 1080, y: 560 }, params: { timeMs: 50 } });
  nodes.push({ id: 'aout', type: 'audioOut', position: { x: 1500, y: 560 }, params: { master: 0.9 } });

  for (let i = 0; i < n; i++) {
    const vv = `vv${i}`;
    const out = `out${i}`;
    nodes.push({ id: vv, type: 'videovarispeed', position: { x: 40, y: 40 + i * ROW }, domain: 'video' });
    nodes.push({ id: out, type: 'videoOut', position: { x: 560, y: 40 + i * ROW }, domain: 'video' });
    edges.push({ id: `e-vvout-${i}`, from: { nodeId: vv, portId: 'video' }, to: { nodeId: out, portId: 'in' }, sourceType: 'video', targetType: 'video' });
    if (i < mixInputs) {
      edges.push({ id: `e-mix-${i}`, from: { nodeId: vv, portId: 'video' }, to: { nodeId: 'mix', portId: `in${i + 1}` }, sourceType: 'video', targetType: 'video' });
    }
    // Audio: each source's audio_l -> scope ch1 AND -> AUDIO OUT L (they sum).
    // The AUDIO OUT edge is the one that proves AUDIBILITY (signal reaches
    // ctx.destination through the user's patch); the scope edge is kept as the
    // visual read. Both are added AFTER each file loads (see addEdges) so the
    // bridge captures the live splitter, mirroring the real session order.
    audioEdges.push({ id: `e-aud-${i}`, from: { nodeId: vv, portId: 'audio_l' }, to: { nodeId: 'scope', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' });
    audioEdges.push({ id: `e-aout-${i}`, from: { nodeId: vv, portId: 'audio_l' }, to: { nodeId: 'aout', portId: 'L' }, sourceType: 'audio', targetType: 'audio' });
  }
  return { nodes, edges, audioEdges };
}

test.describe('multi-video playback — N sources all decode at once', () => {
  test('4x VIDEOVARISPEED -> MIXER: every source advances + mixer shows moving video + audio is produced', async ({ page }) => {
    // 4 sequential video loads (each waits up to 12s) + per-source windowed
    // polling + audio polling blows the 30s default on a loaded CI runner.
    test.setTimeout(120_000);
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

    // PER-SOURCE (UNPATCHED) — DETERMINISTIC CI GUARD: every source's
    // decode->upload path must be live while the sources have NO audio patched
    // downstream. We drive the engine's step() ourselves with a macrotask gap
    // (so rVFC decode callbacks fire) and assert each source's ENGINE-INTERNAL
    // uploadCount advances. Pre-fix, with no keep-alive, the unpatched elements
    // (all but one) are throttled to ~1 fps so their uploadCount barely moves;
    // post-fix every source's keep-alive pulls its element at full decode rate
    // so all four advance. This replaces the old sampled-pixel "all 4 move"
    // check, which read software-GL framebuffer content and flaked under CI's
    // background-rAF throttling (a momentarily-starved decode read as a frozen
    // frame). uploadCount is the same liveness fact, read from engine state.
    const deltas = await uploadDeltasOverSteps(page, ['vv0', 'vv1', 'vv2', 'vv3']);
    const stalledUploads = Object.entries(deltas).filter(([, d]) => d < 2);
    expect(
      stalledUploads.length,
      `all 4 sources' uploadCount advances while unpatched — deltas: ${JSON.stringify(deltas)}`,
    ).toBe(0);

    // VISUAL repro (LOCAL ONLY): on a real GPU + foreground tab, prove every
    // per-source VIDEO-OUT actually renders moving frames (the operator-facing
    // symptom). CI-skipped: this samples software-GL framebuffer pixels, which
    // flakes under parallel-worker rAF throttling — the uploadCount guard above
    // is the deterministic CI proof of the same fix.
    if (visualChecksEnabled()) {
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
    }

    // Now patch each source's audio_l -> scope AND -> AUDIO OUT. The video→audio
    // bridge captures the live splitter at this point (vs. the silent
    // placeholder if we'd patched pre-load), mirroring the real session order:
    // load, then patch.
    await addEdges(page, audioEdges);

    // MIXER OUTPUT: the combined output must also show moving video. LOCAL
    // ONLY — sampled-pixel check on software GL flakes under CI rAF throttling;
    // the per-source uploadCount liveness above + the audibility assertion
    // below are the deterministic CI guards.
    if (visualChecksEnabled()) {
      const mix = await outAdvances(page, 'mixout');
      expect(
        mix.moved,
        `mixer output moving (maxBright=${mix.maxBright} distinct=${mix.distinct})`,
      ).toBe(true);
    }

    // AUDIO — AUDIBILITY: with all four sources' audio_l patched into AUDIO OUT,
    // the terminal output (the limiter feeding ctx.destination) must see real
    // energy (the av-clip carries a 220 Hz tone). This is the assertion that
    // matters: it proves the operator HEARS the audio. The scope read is kept
    // alongside purely as context — previously the test asserted ONLY the scope,
    // which buffers samples whether or not anything reaches the destination, so
    // it passed even while real output was silent (the regression we're guarding).
    let out = { peak: 0, rms: 0, nonzeroSamples: 0, totalSamples: 0 };
    let scope = { peak: 0, rms: 0, nonzeroSamples: 0, totalSamples: 0 };
    const audioDeadline = Date.now() + 6000;
    while (Date.now() < audioDeadline) {
      const o = await readOutputStats(page, 'aout');
      if (o.peak > out.peak) out = o;
      const snap = await readScopeSnapshot(page, 'scope');
      if (snap) {
        const s = summarize(snap.ch1);
        if (s.peak > scope.peak) scope = s;
      }
      if (out.peak > 0.01) break;
      await page.waitForTimeout(150);
    }
    expect(
      out.peak,
      `audio AUDIBLE at AUDIO OUT (terminal peak=${out.peak.toFixed(4)} rms=${out.rms.toFixed(4)} nonzero=${out.nonzeroSamples}); scope peak=${scope.peak.toFixed(4)} — scope>0 with out==0 means signal stalled before the destination`,
    ).toBeGreaterThan(0.01);

    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  // SCALE: spawn ~10 sources and require they ALL advance. Gated !CI — ten
  // simultaneous decodes + ten VIDEO-OUTs is heavy for a shared CI runner with
  // software GL; the 4-source case above is the CI guard. Documents the Chrome
  // simultaneous-decode ceiling if fewer than N advance.
  test('scale: 10x VIDEOVARISPEED all advance (local only)', async ({ page }) => {
    test.skip(!!process.env.CI, 'scale run is heavy for CI software-GL runners; 4-source case is the CI guard');
    // Keep this DECODE-CAPACITY probe (10 concurrent 1080p H.264 decoders) OUT of
    // the heavy WebGL attest's Pass A (E2E_WEBGL_HEAVY=only): it sits right at
    // Chrome's simultaneous-decode ceiling, so under the attest's cumulative
    // 2-min marathon the machine occasionally drops 1 of 10 → a false attest
    // refusal (it passes 10/10 in isolation). It is NOT a render-correctness
    // check — the 4× case (above) is the deterministic in-attest guard. Still
    // runs on a direct local spec run. (Deliberately gated by env, NOT by a
    // collab/capacity test tag: the collab attest resolves its basis by grepping
    // spec files for those tag strings, so tagging — or even NAMING the literal
    // tag here — would wrongly pull this spec into the collab gate.)
    test.skip(process.env.E2E_WEBGL_HEAVY === 'only', 'decode-capacity probe — excluded from the heavy WebGL attest gate (ceiling-marginal); runs on a direct local spec run');
    test.setTimeout(180_000);
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
