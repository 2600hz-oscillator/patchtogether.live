// e2e/tests/wavecel-video-outs.spec.ts
//
// E2E for WAVECEL's two video output ports:
//   - scope_out (mono-video): waveform-trace view of the active frame.
//   - wave3d_out (video):     3D wavetable view with orange polylines +
//                              the active frame in white.
//
// Both ports are independent of the on-card scope/3D toggle (which drives the
// on-card preview only). The bridge uses AudioDomainNodeHandle.videoSources +
// drawFrame — same pattern as SCOPE's video out.
//
// DETERMINISTIC render-smoke (DRS). The old version did `spawn →
// waitForTimeout(900) → read the OUTPUT card's 2D <canvas> via getImageData` —
// three un-synchronized clocks (headless rAF throttling, the cross-domain
// bridge's draw cadence, the card blit) plus a fixed sleep that has to be long
// enough on the slowest CI box. Now: pause the engine rAF loop + pin the engine
// clock (installRenderSmokeHooks) BEFORE goto, then drive engine.step() a FIXED
// number of frames SYNCHRONOUSLY and read the rendered output texture once via
// the shared _render-smoke harness. No waitForTimeout, no poll.
//
// READ POINT — why the DOWNSTREAM videoOut FBO, not WAVECEL's own:
//   WAVECEL is an AUDIO module; its video comes out through the cross-domain
//   audio→video TEXTURE BRIDGE (videoSources + drawFrame), which is keyed in the
//   engine by EDGE id and is NOT a node in engine.nodes — so
//   outputTexture('a-wave', 'scope_out') can't find it (unlike b3ntb0x, a real
//   video node whose own FBO the DRS reads). engine.step() ticks the bridge
//   (WAVECEL.drawFrame → upload) and then renders the downstream videoOut, which
//   blits the bridge texture into its OWN FBO. So we read videoOut's FBO
//   (stepAndReadStats({ nodeId: 'v-out' })) — that IS WAVECEL's rendered frame
//   one pass downstream, and videoOut is in engine.nodes so the harness resolves
//   surface.texture cleanly.
//
// WHY NO __wavecelVrtFreeze SEAM: WAVECEL's video draw (wavecel-draw.ts
// drawWaveScope / drawWave3D) is a PURE function of the static factory wavetable
// + the `morph` param (activeFrame = round(morph·(frames-1))). It has NO
// performance.now(), NO accumulator, NO own clock — nothing to freeze. With the
// engine clock pinned (so any patched modulator can't drift) the frozen frame is
// already bit-stable, which the second-burst frame-stable check below proves. A
// deterministic source isn't needed for the frame to be non-black + structured
// either: the default factory table is a real, non-flat synth wavetable, and we
// pin `morph` to a fixed mid value so the active frame is a structured trace.
//
// We assert pixel STATISTICS (non-black + spatial structure + RGB content), not
// pixel-exact content — the module is VRT-exempt and SwiftShader ≠ real GPU.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 6; // bridge tick + videoOut blit: 6 is well past warm.

/** Read the videoOut FBO once after a FIXED synchronous burst, returning the
 *  decoded frame as a SPARSE PER-CHANNEL (R,G,B) array so the wave3d_out test
 *  can measure the orange (R≫B) content the way the old getImageData scan did,
 *  but on a frozen, deterministic frame. */
async function stepAndReadFrame(
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

    // Per-CHANNEL sample (R,G,B kept separate) so the orange (R≫B) content of
    // wave3d_out registers even when the aggregate luma is modest.
    const out: number[] = [];
    for (let i = 0; i < px.length; i += 4 * 16) { out.push(px[i]!, px[i + 1]!, px[i + 2]!); }
    return out;
  }, opts);
}

// @webgl-serial — the output-FBO readback races other GL workers under the
// attest's parallel Pass A-heavy; this spec is green in isolation
// (E2E_REAL_GPU=1 REPEAT=3 task e2e:one -- wavecel-video-outs), so the attest
// runs it in the SERIAL bucket (workers=1) instead. See WEBGL_SERIAL_SPECS.
test.describe('WAVECEL video outputs (cross-domain bridge) @webgl-serial', () => {
  test('WAVECEL.scope_out -> OUTPUT renders a structured, frame-stable waveform trace', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);

    // Pin the engine clock + pause the rAF loop BEFORE boot so the test owns the
    // exact frame count and any patched modulator can't drift the frame.
    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        // No audio source is wired: WAVECEL's video draw ignores audio entirely
        // (it renders the static factory wavetable at the active frame). morph is
        // pinned to a fixed mid value so the active frame is a structured trace.
        { id: 'a-wave', type: 'wavecel',  position: { x: 280, y: 60 }, domain: 'audio', params: { morph: 0.5 } },
        { id: 'v-out',  type: 'videoOut', position: { x: 600, y: 60 }, domain: 'video' },
      ],
      [
        {
          id: 'e-wave-out',
          from: { nodeId: 'a-wave', portId: 'scope_out' },
          to:   { nodeId: 'v-out',  portId: 'in' },
          sourceType: 'mono-video',
          targetType: 'video',
        },
      ],
    );

    await expect(page.locator('.svelte-flow__node-wavecel'), 'WAVECEL visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'), 'OUTPUT visible').toBeVisible();

    const wavecelCard = page.locator('.svelte-flow__node-wavecel');
    await expect(
      wavecelCard.locator('[data-handleid="scope_out"]'),
      'scope_out handle present',
    ).toHaveCount(1);
    await expect(
      wavecelCard.locator('[data-handleid="wave3d_out"]'),
      'wave3d_out handle present',
    ).toHaveCount(1);

    // Drive a FIXED burst synchronously; read the downstream videoOut FBO (==
    // WAVECEL's rendered scope frame one pass downstream). Non-black + spatial
    // structure = a real waveform trace decoded onto the active frame.
    const a = await stepAndReadStats(page, { nodeId: 'v-out', steps: FIXED_STEPS });
    // minVariance default is for a busy GL shader; the scope trace is a single
    // thin line on a dark field, so a modest spatial-structure floor is correct.
    assertRenderStats(a, FIXED_STEPS, { minNonZeroFrac: 0.005, minVariance: 5 });

    // DETERMINISM: a second independent burst (clock frozen, no own-clock in the
    // WAVECEL draw) is frame-stable — the property the old waitForTimeout(900)+
    // one-shot canvas read lacked.
    const b = await stepAndReadStats(page, { nodeId: 'v-out', steps: FIXED_STEPS });
    expect(b.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen scope output is frame-stable (mean ${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen scope output variance is frame-stable').toBeLessThan(1.0);

  });

  test('WAVECEL.wave3d_out -> OUTPUT renders the 3D wavetable view (red-dominant orange content)', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);

    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'a-wave', type: 'wavecel',  position: { x: 280, y: 60 }, domain: 'audio', params: { morph: 0.5 } },
        { id: 'v-out',  type: 'videoOut', position: { x: 600, y: 60 }, domain: 'video' },
      ],
      [
        {
          id: 'e-wave-out',
          from: { nodeId: 'a-wave', portId: 'wave3d_out' },
          to:   { nodeId: 'v-out',  portId: 'in' },
          sourceType: 'video',
          targetType: 'video',
        },
      ],
    );

    await expect(page.locator('.svelte-flow__node-wavecel'), 'WAVECEL visible').toBeVisible();
    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(canvas).toHaveCount(1);

    // First confirm the decode is a real structured non-black frame...
    const stats = await stepAndReadStats(page, { nodeId: 'v-out', steps: FIXED_STEPS });
    assertRenderStats(stats, FIXED_STEPS, { minNonZeroFrac: 0.005, minVariance: 5 });

    // ...then read the frozen frame per-channel and assert the defining property
    // of the 3D view vs scope_out: the RGB cable type (`video`) preserves the
    // orange (R≫G>B) polylines + white-highlighted active frame, so the red
    // channel meaningfully dominates blue across the lit region.
    const frame = await stepAndReadFrame(page, { nodeId: 'v-out', steps: FIXED_STEPS });
    expect(frame.length, 'frame sampled').toBeGreaterThan(0);
    let rSum = 0, gSum = 0, bSum = 0, lit = 0;
    let hasOrange = false, hasWhite = false;
    for (let i = 0; i + 2 < frame.length; i += 3) {
      const r = frame[i]!, g = frame[i + 1]!, b = frame[i + 2]!;
      const v = (r + g + b) / 3;
      if (v > 40) {
        rSum += r; gSum += g; bSum += b; lit++;
        // Orange = R >> G > B. Active-frame white = R ~= G ~= B all high.
        if (r > 150 && g > 70 && g < 200 && b < 120) hasOrange = true;
        if (r > 200 && g > 200 && b > 200) hasWhite = true;
      }
    }
    const rAvg = rSum / Math.max(1, lit);
    const bAvg = bSum / Math.max(1, lit);
    void gSum;
    // RGB content: avg red noticeably > avg blue across lit pixels.
    expect(
      rAvg - bAvg,
      `red-vs-blue separation (rAvg ${rAvg.toFixed(0)} - bAvg ${bAvg.toFixed(0)}) > 20`,
    ).toBeGreaterThan(20);
    // Either orange OR white should be visible — orange is the bulk, white is the
    // active-frame highlight. Asserting at least one tolerates color-channel
    // variance from the GL upload pipeline + SwiftShader.
    expect(hasOrange || hasWhite, 'orange or white pixels present').toBe(true);

  });

  // NOTE (consolidation §2): the third test "on-card scope/3D toggle is
  // independent of the video outputs" was DROPPED. Its only assertion was that
  // scope_out renders non-zero pixels before AND after clicking the viz-toggle —
  // a strictly WEAKER re-assertion of the first test's render. The REAL
  // independence claim — that the scope view and the 3D view are distinct draws —
  // is owned by the unit test wavecel-draw.test.ts (drawWaveScope vs drawWave3D),
  // where it is asserted deterministically without a GPU boot.
  //
  // NOTE (DRS, §3 framesElapsed/data-frames-elapsed DEFERRED): the b3ntb0x DRS
  // template also reads the module's own read('framesElapsed') / a
  // data-frames-elapsed attribute as a second determinism signal. WAVECEL is an
  // audio module rendering through the cross-domain bridge — it has no
  // video-domain handle and exposes no framesElapsed counter (the bridge surface
  // isn't an engine node). The engine-level framesDelta (asserted == FIXED_STEPS
  // above via the paused rAF loop) is the equivalent module-agnostic frame-count
  // determinism check, so no per-module framesElapsed read is added here.
});
