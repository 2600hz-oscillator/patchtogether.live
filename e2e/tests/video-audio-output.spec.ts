// e2e/tests/video-audio-output.spec.ts
//
// VIDEO-SOURCE AUDIBILITY — the load-bearing regression guard for "video
// modules produce NO audio downstream" (operator report).
//
// The thing under test is END-TO-END AUDIBILITY: a video source's audio_l /
// audio_r, when the operator patches it into AUDIO OUT, must reach
// AudioContext.destination (the speakers). This is the assertion the
// multi-video spec's SCOPE check could NOT make: a SCOPE's ch1 input feeds a
// terminal AnalyserNode that buffers samples whether or not ANYTHING reaches
// the destination (it is never connected onward — see scope.ts). So a SCOPE
// reading energy proves only that the cross-domain bridge delivered the
// splitter to the scope's analyser — NOT that the user can hear it.
//
// To prove audibility we read AUDIO OUT's TERMINAL tap (`read('outputSnapshot')`
// in audio-out.ts): an AnalyserNode hung off the SAME limiter node that feeds
// ctx.destination. Energy there == signal reached the audible terminal stage.
//
// We deliberately patch BOTH a SCOPE *and* AUDIO OUT off the same audio_l so
// this spec documents the gap: the SCOPE seeing energy while AUDIO OUT sees
// silence is exactly the false-confidence failure mode of the old assertion.
//
// Fixture: av-clip.webm (VP8 + Opus 220 Hz tone) — committed, has an audio
// track. Order mirrors a real session: spawn, load the file (wireAudio swaps
// audio_l from the silent placeholder to the live splitter), THEN patch audio
// downstream so the video->audio bridge captures the live splitter.

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

/** Set data.isPlaying on a node via the Yjs doc (the card's $effect reacts +
 *  plays the element). Offscreen-safe (no .click()). */
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

/** Add edges into the live patch in a single transact (post-load). The
 *  video->audio bridge captures the source AudioNode at edge-add time, so this
 *  must run AFTER wireAudio() has swapped audio_l from the silent placeholder
 *  to the live splitter — exactly the real session order. */
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

/** Read a module instrumentation key via __engine (works for audio + video). */
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
 *  and summarize its energy. This is the genuine audibility probe. */
async function readOutputStats(page: Page, outNodeId: string): Promise<{ peak: number; rms: number; nonzeroSamples: number; totalSamples: number }> {
  const samples = await page.evaluate(
    (id) => {
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
    },
    outNodeId,
  );
  if (!samples) return { peak: 0, rms: 0, nonzeroSamples: 0, totalSamples: 0 };
  return summarize(samples);
}

/** Load + play the AV fixture into a VIDEOVARISPEED card (scoped by id). */
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

test.describe('video source audio reaches the destination through a user patch', () => {
  test('VIDEOVARISPEED audio_l -> AUDIO OUT: real energy reaches the terminal output', async ({ page }) => {
    test.setTimeout(60_000);
    const errors = await setup(page);

    // VIDEOVARISPEED -> (video) VIDEO-OUT, plus audio_l fanned to BOTH a SCOPE
    // (the weak probe) and AUDIO OUT (the audibility probe).
    await spawnPatch(
      page,
      [
        { id: 'vv', type: 'videovarispeed', position: { x: 40, y: 40 }, domain: 'video' },
        { id: 'vout', type: 'videoOut', position: { x: 480, y: 40 }, domain: 'video' },
        { id: 'scope', type: 'scope', position: { x: 480, y: 480 }, params: { timeMs: 50 } },
        { id: 'aout', type: 'audioOut', position: { x: 900, y: 480 }, params: { master: 0.9 } },
      ],
      [
        { id: 'e-vout', from: { nodeId: 'vv', portId: 'video' }, to: { nodeId: 'vout', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    await loadAndPlay(page, 'vv');

    // wireAudio must have run (audio_l is now the live splitter, not the silent
    // placeholder) before we patch audio downstream. POLL, don't single-read:
    // wireAudio runs slightly AFTER data-is-playing flips (loadAndPlay's gate),
    // so a one-shot read races it (flaked on both Metal + SwiftShader). The
    // keep-alive is set in the same wireAudio() call.
    await expect
      .poll(() => readNode(page, 'vv', 'audioWired'), { timeout: 8000, message: 'vv audio wired' })
      .toBe(true);
    expect(await readNode(page, 'vv', 'hasKeepAlive'), 'vv keep-alive live').toBe(true);

    // Patch audio_l into BOTH the scope and AUDIO OUT (post-load, so the bridge
    // captures the live splitter). The scope is the historical false-confidence
    // probe; AUDIO OUT is the real audibility probe.
    await addEdges(page, [
      { id: 'e-aud-scope', from: { nodeId: 'vv', portId: 'audio_l' }, to: { nodeId: 'scope', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
      { id: 'e-aud-out', from: { nodeId: 'vv', portId: 'audio_l' }, to: { nodeId: 'aout', portId: 'L' }, sourceType: 'audio', targetType: 'audio' },
    ]);

    // Poll both probes over a window (analyser holds ~43ms; the av-clip tone is
    // continuous so any window catches it once audio actually flows).
    let scope = { peak: 0, rms: 0, nonzeroSamples: 0, totalSamples: 0 };
    let out = { peak: 0, rms: 0, nonzeroSamples: 0, totalSamples: 0 };
    const deadline = Date.now() + 8000;
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

    // The audibility assertion: signal reached the limiter feeding
    // ctx.destination. This is what was BROKEN (silent) and is the real fix.
    expect(
      out.peak,
      `audio reaches AUDIO OUT terminal (peak=${out.peak.toFixed(4)} rms=${out.rms.toFixed(4)} nonzero=${out.nonzeroSamples}); scope peak=${scope.peak.toFixed(4)} — if scope>0 but out==0 the signal stopped before the destination`,
    ).toBeGreaterThan(0.01);

    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  // REGRESSION: the audio edge already exists when the file loads. This is the
  // saved-patch / reload order (operator: "load patch, then drop a file in") and
  // the order that BROKE: at edge-add time audio_l is still the silent
  // ConstantSource placeholder; the video->audio bridge captures THAT node; then
  // wireAudio() swaps audio_l in the module's map to the live splitter — but the
  // bridge's already-made connection still points at the dead placeholder, so no
  // signal ever reaches the destination. The fix re-resolves the bridge when the
  // source's audio node is published (audioSources mutated). We assert the AUDIO
  // OUT terminal sees energy and capture the SCOPE too: pre-fix the scope ALSO
  // reads silence here (the placeholder is a 0-offset CSN), which is why the old
  // assertion only "passed" in the load-then-patch order — it never exercised
  // this path.
  test('audio edge patched BEFORE the file loads still reaches the destination (saved-patch order)', async ({ page }) => {
    test.setTimeout(60_000);
    const errors = await setup(page);

    // Spawn with the audio edge ALREADY present (mirrors a restored patch where
    // audio_l -> AUDIO OUT was saved, then the operator loads the file).
    await spawnPatch(
      page,
      [
        { id: 'vv', type: 'videovarispeed', position: { x: 40, y: 40 }, domain: 'video' },
        { id: 'vout', type: 'videoOut', position: { x: 480, y: 40 }, domain: 'video' },
        { id: 'scope', type: 'scope', position: { x: 480, y: 480 }, params: { timeMs: 50 } },
        { id: 'aout', type: 'audioOut', position: { x: 900, y: 480 }, params: { master: 0.9 } },
      ],
      [
        { id: 'e-vout', from: { nodeId: 'vv', portId: 'video' }, to: { nodeId: 'vout', portId: 'in' }, sourceType: 'video', targetType: 'video' },
        { id: 'e-aud-scope', from: { nodeId: 'vv', portId: 'audio_l' }, to: { nodeId: 'scope', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
        { id: 'e-aud-out', from: { nodeId: 'vv', portId: 'audio_l' }, to: { nodeId: 'aout', portId: 'L' }, sourceType: 'audio', targetType: 'audio' },
      ],
    );

    // NOW load the file. wireAudio swaps audio_l from the silent placeholder to
    // the live splitter; the card retries wireAudio until it sticks (the handle
    // / element may not be ready the instant loadFile runs), and the swap fires
    // notifyAudioSourcesChanged so the engine re-resolves the pre-existing
    // bridge from the dead placeholder to the live splitter. We don't assert
    // audioWired synchronously here — the retry is async — the energy poll below
    // is the end-to-end proof, and we poll audioWired alongside it for context.
    await loadAndPlay(page, 'vv');

    let scope = { peak: 0, rms: 0, nonzeroSamples: 0, totalSamples: 0 };
    let out = { peak: 0, rms: 0, nonzeroSamples: 0, totalSamples: 0 };
    const deadline = Date.now() + 8000;
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
      `audio reaches AUDIO OUT terminal when edge predates the file load (peak=${out.peak.toFixed(4)} rms=${out.rms.toFixed(4)} nonzero=${out.nonzeroSamples}); scope peak=${scope.peak.toFixed(4)}`,
    ).toBeGreaterThan(0.01);

    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
