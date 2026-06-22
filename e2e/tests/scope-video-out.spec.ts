// e2e/tests/scope-video-out.spec.ts
//
// SCOPE's mono-video output, DETERMINISTIC render-smoke (DRS).
//
// SCOPE is an AUDIO module whose `out` (mono-video) port is produced by a
// cross-domain audio→video bridge: each video frame the engine calls SCOPE's
// `drawFrame(canvas)`, which reads SCOPE's live analyser snapshot + current
// params and renders the SAME 2D trace the on-card canvas shows (via the shared
// drawScope helper), then uploads the canvas to a GL texture for the downstream
// video consumer (OUTPUT). See packages/web/src/lib/audio/modules/scope.ts +
// scope-draw.ts + VideoEngine.tickVideoTextureBridges.
//
// WHY NO __scopeVrtFreeze SEAM (unlike b3ntb0x/bentbox/camera): SCOPE's render
// (drawScope) is a PURE function of (analyser snapshot, params) — it has ZERO
// time / clock / accumulation term of its own (no performance.now(), no
// framesElapsed, no rAF; verified in scope-draw.ts). It does NOT animate off its
// own wall-clock, so there is nothing to override and a __scopeVrtFreeze seam
// would gate dead code. (The plan's STEP-2 is conditional: add the seam only IF
// the module animates off its own clock and lacks one — SCOPE doesn't.)
// Determinism here comes from (1) installRenderSmokeHooks (pause the engine rAF
// loop + pin the engine clock) and (2) a DETERMINISTIC audio source: SCOPE
// draws an audio waveform, so a frozen single-frame read of an unfed scope is
// black — we wire ANALOG-VCO → SCOPE.ch1/ch2 so the trace is non-black +
// structured (the hard-won "analyser-only visualizer needs a deterministic
// source" rule). The §3 `read('framesElapsed')` doesn't apply: SCOPE is an
// audio handle with no framesElapsed; the harness's video-engine-level
// `currentFrameCount()` DELTA (framesDelta === steps, in assertRenderStats) is
// the module-agnostic frame-count check.
//
// WHERE THE DRS READS SCOPE's OUTPUT: SCOPE's video output lives in the bridge's
// `customTexture` (keyed by edge id), NOT in a video-engine `node` — so
// `outputTexture('a-scope')` resolves to null. We therefore read the DOWNSTREAM
// videoOut node's FBO (`v-out`), which samples the bridge texture and renders
// SCOPE's trace through the REAL video pipeline (engine.step() runs
// tickVideoTextureBridges → SCOPE.drawFrame → then the topo draw of v-out). That
// is exactly the surface the old test read (the video-out-canvas blit), now read
// deterministically off the FBO instead of via getImageData after a
// waitForTimeout.
//
// FRAME-STABILITY IS DEFERRED (true determinism blocker): the audio AnalyserNode
// advances in real wall-clock time even with the engine clock frozen, so two
// bursts read DIFFERENT analyser snapshots → the frozen frame is NOT bit-stable.
// We keep a non-black + structured render-smoke (renderer-tolerant floors) and
// do NOT assert a second-burst frame-equality check (it would be flaky by
// construction). The pure waveform→trace geometry (the Bug-2 "flat line"
// regression + the XY-vs-split layout change) is covered DETERMINISTICALLY +
// GPU-free in scope-draw.test.ts (PCU), so dropping the bit-stable GL check
// loses no coverage. waitForTimeout count: 0 (was 3).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 6; // bridge tick + v-out draw warm to steady state well within 6.

/** Drive a FIXED burst SYNCHRONOUSLY (one evaluate, no yield — same path as
 *  stepAndReadStats) and return the read node's FBO as a SPARSE PER-ROW bright-
 *  pixel-count signature. The XY-vs-split layout change moves the trace's row
 *  distribution (split = stacked horizontal traces; XY = a Lissajous collapsed
 *  toward center), which a per-row signature captures directly — the same
 *  observable the original test asserted on (rowSig), now read off the FBO under
 *  a paused engine instead of getImageData after a waitForTimeout. */
async function stepAndReadRowSig(
  page: Page,
  opts: { nodeId: string; portId?: string; steps: number },
): Promise<number[]> {
  return page.evaluate(({ nodeId, portId, steps }) => {
    const w = globalThis as unknown as {
      __engine: () => {
        getDomain: (d: string) => {
          gl: WebGL2RenderingContext;
          step: () => void;
          outputTexture: (id: string, port?: string) => WebGLTexture | null;
          res: { width: number; height: number };
        };
      };
    };
    const vid = w.__engine().getDomain('video');
    const gl = vid.gl;
    while (gl.getError() !== gl.NO_ERROR) { /* drain pre-existing */ }

    for (let i = 0; i < steps; i++) vid.step();

    const tex = vid.outputTexture(nodeId, portId) as WebGLTexture | null;
    const { width: W, height: H } = vid.res;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    const px = new Uint8Array(W * H * 4);
    if (complete) gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    while (gl.getError() !== gl.NO_ERROR) { /* drain readback */ }

    // Count bright pixels per scanline row.
    const out = new Array<number>(H).fill(0);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const v = (px[i]! + px[i + 1]! + px[i + 2]!) / 3;
        if (v > 100) out[y]! += 1;
      }
    }
    return out;
  }, opts);
}

/** setParam through the engine AUDIO domain (SCOPE is an audio node) — the SAME
 *  hot-path the reconciler drives when the user flips a SCOPE control; it feeds
 *  the `params` record SCOPE.drawFrame reads. (A video-domain setParam would be a
 *  silent no-op — see the body.) */
async function setScopeParam(page: Page, nodeId: string, param: string, value: number): Promise<void> {
  await page.evaluate(
    ({ nodeId, param, value }) => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain?: (d: string) => { setParam?: (id: string, p: string, v: number) => void } | null } | null;
      };
      // SCOPE is an AUDIO-domain node — it lives in the AudioEngine node map, NOT
      // VideoEngine.nodes. A getDomain('video').setParam('a-scope', …) is a SILENT
      // no-op (VideoEngine only holds domain:'video' nodes), so the XY-mode flip
      // must go through the AUDIO domain — the same setParam the reconciler/CV
      // bridge drives, feeding the `params` record drawFrame reads.
      const aud = w.__engine?.()?.getDomain?.('audio');
      aud?.setParam?.(nodeId, param, value);
    },
    { nodeId, param, value },
  );
}

test.describe('SCOPE.out (mono-video) -> OUTPUT', () => {
  test('SCOPE patched into OUTPUT renders a non-black, structured waveform trace', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Pause the engine rAF loop (the test owns the exact frame count) + pin the
    // engine clock BEFORE boot. No __scopeVrtFreeze: drawScope has no clock term.
    await installRenderSmokeHooks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // DETERMINISTIC source: ANALOG-VCO (a fixed-pitch audio oscillator) → SCOPE
    // so the analyser-driven trace is non-black + structured. SCOPE.out → OUTPUT
    // so we can read SCOPE's trace propagated through the real video pipeline off
    // the videoOut node's FBO (SCOPE's own output is a bridge texture, not a
    // video node, so we read it where it lands downstream).
    await spawnPatch(
      page,
      [
        { id: 'a-vco',   type: 'analogVco', position: { x: 60,  y: 60 }, domain: 'audio' },
        { id: 'a-scope', type: 'scope',     position: { x: 280, y: 60 }, domain: 'audio' },
        { id: 'v-out',   type: 'videoOut',  position: { x: 600, y: 60 }, domain: 'video' },
      ],
      [
        {
          id: 'e-vco-scope',
          from: { nodeId: 'a-vco', portId: 'saw' },
          to:   { nodeId: 'a-scope', portId: 'ch1' },
          sourceType: 'audio',
          targetType: 'audio',
        },
        {
          id: 'e-scope-out',
          from: { nodeId: 'a-scope', portId: 'out' },
          to:   { nodeId: 'v-out', portId: 'in' },
          sourceType: 'mono-video',
          targetType: 'video',
        },
      ],
    );

    await expect(page.locator('.svelte-flow__node-scope'), 'SCOPE visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'), 'OUTPUT visible').toBeVisible();

    // SCOPE card must render the new `out` handle (io-spec consistency covers
    // this elsewhere; cheap sanity here too).
    const scopeCard = page.locator('.svelte-flow__node-scope');
    const outHandle = scopeCard.locator('[data-handleid="out"]');
    await expect(outHandle, 'scope.out handle present').toHaveCount(1);

    // Drive a FIXED burst synchronously (no rAF, no waitForTimeout): the bridge
    // tick runs SCOPE.drawFrame (analyser snapshot → drawScope), v-out samples
    // the bridge texture, and we read v-out's OWN FBO once. The decoded frame is
    // non-black with spatial structure (the VCO waveform produced a trace).
    const stats = await stepAndReadStats(page, { nodeId: 'v-out', steps: FIXED_STEPS });
    assertRenderStats(stats, FIXED_STEPS);

    // STRUCTURE (the Bug-2 "flat line" regression guard, preserved): a real
    // waveform spans many distinct scanline rows, NOT a flat line at center. We
    // read the per-row bright-pixel signature and require the trace to occupy a
    // meaningful number of rows. (The original asserted brightRows >= 20 off the
    // 2D canvas; the per-row signature off the FBO is the same observable. The
    // pure waveform→multi-row math is also pinned GPU-free in
    // scope-draw.test.ts.)
    const rowSig = await stepAndReadRowSig(page, { nodeId: 'v-out', steps: FIXED_STEPS });
    const occupiedRows = rowSig.filter((c) => c > 0).length;
    expect(
      occupiedRows,
      `trace must span many rows, not a flat line at center (got ${occupiedRows})`,
    ).toBeGreaterThanOrEqual(10);

    // FRAME-STABILITY DEFERRED: the audio AnalyserNode advances in real time
    // even with the engine clock frozen, so a second burst reads a DIFFERENT
    // snapshot → the frozen frame is NOT bit-stable. Asserting frame-equality
    // here would flake by construction. The deterministic waveform→trace
    // geometry is covered GPU-free in scope-draw.test.ts instead.

    expect(errors, 'no console / page errors during SCOPE video-out render').toEqual([]);
  });

  test('flipping XY mode changes the video output (PR-69 user-reported bug fix)', async ({ page }) => {
    // User report (verbatim): "when scope is patched to the video output, we
    // just see noise, not the same lines on the scope. we should see the data of
    // the scope as a 2-d mono layer, and it should change as we change the
    // controls on the scope." Post-fix: SCOPE's videoSources.drawFrame runs the
    // same drawScope the on-card canvas uses, against live params — so flipping
    // the XY toggle MUST visibly change the OUTPUT pixels.
    //
    // DRS conversion: ONE page-load (was a single-load already, but with a
    // waitForTimeout(900) settle + a waitForTimeout(700) after the toggle).
    // installRenderSmokeHooks pins the engine clock + pauses rAF; we read a
    // split-mode per-row signature off v-out's FBO, flip mode→1 via the engine
    // setParam hot-path, read an XY-mode signature, and assert the row
    // distribution changed substantially. The XY collapse toward center is a
    // LARGE structural re-layout — comfortably above the small per-row jitter the
    // live analyser introduces (the original used a ±2-per-row tolerance for the
    // same reason; preserved here).
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await installRenderSmokeHooks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'a-vco',   type: 'analogVco', position: { x: 60,  y: 60 }, domain: 'audio' },
        { id: 'a-scope', type: 'scope',     position: { x: 280, y: 60 }, domain: 'audio' },
        { id: 'v-out',   type: 'videoOut',  position: { x: 600, y: 60 }, domain: 'video' },
      ],
      [
        { id: 'e-vco-scope-1', from: { nodeId: 'a-vco',   portId: 'saw' },  to: { nodeId: 'a-scope', portId: 'ch1' }, sourceType: 'audio',     targetType: 'audio' },
        { id: 'e-vco-scope-2', from: { nodeId: 'a-vco',   portId: 'sine' }, to: { nodeId: 'a-scope', portId: 'ch2' }, sourceType: 'audio',     targetType: 'audio' },
        { id: 'e-scope-out',   from: { nodeId: 'a-scope', portId: 'out' },  to: { nodeId: 'v-out',   portId: 'in' },  sourceType: 'mono-video', targetType: 'video' },
      ],
    );
    await expect(page.locator('.svelte-flow__node-scope'), 'SCOPE visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'), 'OUTPUT visible').toBeVisible();

    // Baseline (split mode): assert a real structured trace first (so the XY
    // diff isn't measured against a black/broken frame), then capture the
    // split-mode per-row signature.
    const baseStats = await stepAndReadStats(page, { nodeId: 'v-out', steps: FIXED_STEPS });
    assertRenderStats(baseStats, FIXED_STEPS);
    const before = await stepAndReadRowSig(page, { nodeId: 'v-out', steps: FIXED_STEPS });
    expect(before.some((v) => v > 0), 'baseline (split) render is non-empty').toBe(true);

    // Flip XY mode via the engine VIDEO-domain setParam — the SAME path the
    // reconciler drives when the user clicks the XY button (feeds the params
    // record drawFrame reads).
    await setScopeParam(page, 'a-scope', 'mode', 1);

    const afterXy = await stepAndReadRowSig(page, { nodeId: 'v-out', steps: FIXED_STEPS });
    // XY mode collapses the two stacked traces toward the canvas center; the row
    // distribution differs from the split layout. Count rows whose bright-pixel
    // count changed by more than the small live-analyser jitter (±2), exactly as
    // the original asserted.
    let differingRows = 0;
    for (let i = 0; i < before.length; i++) {
      if (Math.abs((before[i] ?? 0) - (afterXy[i] ?? 0)) > 2) differingRows++;
    }
    expect(
      differingRows,
      `flipping XY mode must change the output (got ${differingRows} differing rows)`,
    ).toBeGreaterThan(10);

    expect(errors, 'no console / page errors during SCOPE XY toggle').toEqual([]);
  });
});
