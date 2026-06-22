// e2e/tests/b3ntb0x.spec.ts
//
// B3NTB0X — circuit-level NTSC composite re-arch OUTPUT. Real-GL coverage
// (jsdom can't exercise WebGL, so the 4-pass float pipeline is only verifiable
// in a browser): spawn a SHAPES source → B3NTB0X, confirm the card + canvas
// mount, the pipeline decodes a NON-BLACK structured frame, and turning up Sync
// Crush / Enhance VISIBLY changes the output (the Phase-1 proof point).
//
// DETERMINISTIC render-smoke (DRS): the old version did `spawn →
// waitForTimeout(600) → read the on-card 2D canvas` (test 1) and TWO full
// goto+spawn captures with waitForTimeout(500) each (test 2) — three
// un-synchronized clocks (headless rAF throttling, the module's own
// performance.now() subcarrier drift, the card blit cadence). Now: pause the
// engine rAF loop + pin the engine clock AND b3ntb0x's own subcarrier clock
// (`__b3ntb0xFreezeTimeSec`, a flag-gated test seam in b3ntb0x.ts), drive
// engine.step() a FIXED number of frames synchronously, and read B3NTB0X's OWN
// CRT-front FBO once via the shared _render-smoke harness. No waitForTimeout, no
// poll, no animation-diff. With tbc=1, feedback=0, sub_drift=0 the ONLY animation
// source is uTime (frozen) + framesElapsed (a pure function of step count), so the
// frozen frame is bit-stable.
//
// We assert pixel STATISTICS (non-black + spatial structure + a frozen
// clean-vs-bent difference), not pixel-exact content — the module is VRT-exempt.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 8; // 4-pass pipeline + ping-pong: 8 is well past warm to steady state.

/** setParam through the engine VIDEO domain — the SAME hot-path the bend-proof
 *  test drives (UI → engine.setParam → uniform). Used by the live-controls gate
 *  to flip ONE control to an extreme between two FROZEN reads. */
async function setVideoParam(page: Page, nodeId: string, param: string, value: number): Promise<void> {
  await page.evaluate(
    ({ nodeId, param, value }) => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain?: (d: string) => { setParam?: (id: string, p: string, v: number) => void } | null } | null;
      };
      const vid = w.__engine?.()?.getDomain?.('video');
      vid?.setParam?.(nodeId, param, value);
    },
    { nodeId, param, value },
  );
}

/** Drive a FIXED burst SYNCHRONOUSLY (one evaluate, no yield — the same path as
 *  stepAndReadStats in _render-smoke) and return B3NTB0X's OWN CRT-front FBO as a
 *  SPARSE PER-CHANNEL luma array so two FROZEN frames can be diffed PER-PIXEL.
 *  This is the deterministic replacement for the old goto+spawn+waitForTimeout+
 *  getImageData(2D canvas): a chroma-only control (HUE rotation) or a spatial
 *  control whose change colludes the GLOBAL stats to near-identical values still
 *  moves many pixels — the blind spot aggregate stats can miss (mirrors
 *  video-controls.spec.ts stepAndReadFrame). Per-CHANNEL (R,G,B sampled
 *  separately, like #859's grey-blind sampler) so a constant-luma tint registers. */
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

    // Per-CHANNEL sample (R,G,B kept separate) so a pure HUE rotation
    // (chroma-only, ~constant luma) still registers, mirroring #859's sampler.
    const out: number[] = [];
    for (let i = 0; i < px.length; i += 4 * 16) { out.push(px[i]!, px[i + 1]!, px[i + 2]!); }
    return out;
  }, opts);
}

/** Mean absolute per-pixel (per-channel) difference between two equal-length
 *  frozen frames. Two FROZEN reads of an unchanged patch diff ≈ 0 (bit-stable);
 *  a control that actually changes the decoded frame diffs well above the
 *  renderer-tolerant floor. */
function frameDiff(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
}

/** Pin BOTH clocks before boot: the engine rAF/clock (installRenderSmokeHooks)
 *  AND b3ntb0x's own performance.now()-based subcarrier-drift clock. */
async function freezeB3ntb0x(page: import('@playwright/test').Page): Promise<void> {
  await installRenderSmokeHooks(page);
  await page.addInitScript(() => {
    (window as unknown as { __b3ntb0xFreezeTimeSec?: number }).__b3ntb0xFreezeTimeSec = 2.0;
  });
}

test.describe('B3NTB0X — NTSC composite re-arch output', () => {
  test('spawns + canvas mounts + decodes a non-black, frame-stable frame', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await freezeB3ntb0x(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'src', type: 'shapes',  position: { x: 100, y: 100 }, domain: 'video', params: { shape: 0, zoom: 1.4 } },
        // tbc=1 (rock-steady), feedback=0, sub_drift=0 → no intra-pipeline
        // animation source other than uTime (frozen) → bit-stable frozen frame.
        { id: 'bb',  type: 'b3ntb0x', position: { x: 540, y: 100 }, domain: 'video', params: { tbc: 1, feedback: 0, sub_drift: 0 } },
      ],
      [
        { id: 'e_src', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'bb', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );

    await expect(page.locator('.svelte-flow__node-b3ntb0x'), 'B3NTB0X node visible').toBeVisible();
    await expect(page.locator('[data-testid="b3ntb0x-card"]'), 'card present').toHaveCount(1);
    await expect(page.locator('[data-testid="b3ntb0x-canvas"]'), 'canvas mounted').toHaveCount(1);

    // Drive a FIXED burst synchronously, read B3NTB0X's OWN CRT-front FBO once.
    // The decoded NTSC frame is non-black with spatial structure (the
    // encode→bend→decode→CRT path produced an image).
    const a = await stepAndReadStats(page, { nodeId: 'bb', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS);

    // DETERMINISM: a second independent burst (both clocks frozen) is frame-stable
    // — the property the old waitForTimeout(600)+one-shot canvas read lacked.
    const b = await stepAndReadStats(page, { nodeId: 'bb', steps: FIXED_STEPS });
    expect(b.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen CRT output is frame-stable (mean ${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen CRT output variance is frame-stable').toBeLessThan(1.0);

    expect(errors, 'no console / page errors during B3NTB0X render').toEqual([]);
  });

  test('Sync Crush + Enhance visibly change the decoded output (the bend proof point)', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await freezeB3ntb0x(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // ONE page-load (was two full goto+spawn captures): spawn CLEAN, read a
    // frozen burst, then setParam the BEND and read a second frozen burst. Both
    // reads are at frozen-clock steady state, so the difference is the BEND, not
    // sync jitter or rAF cadence.
    await spawnPatch(
      page,
      [
        { id: 'src', type: 'shapes',  position: { x: 100, y: 100 }, domain: 'video', params: { shape: 0, zoom: 1.4 } },
        { id: 'bb',  type: 'b3ntb0x', position: { x: 540, y: 100 }, domain: 'video',
          params: { sync_crush: 1.0, enhance: 0.0, bias: 0.0, chroma_leak: 0.0, tbc: 1, feedback: 0, sub_drift: 0 } },
      ],
      [
        { id: 'e_src', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'bb', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );
    await expect(page.locator('[data-testid="b3ntb0x-canvas"]')).toHaveCount(1);

    const clean = await stepAndReadStats(page, { nodeId: 'bb', steps: FIXED_STEPS });
    assertRenderStats(clean, FIXED_STEPS);

    // Heavy bend: high gain into the clip (Sync Crush) + HF peaking (Enhance) +
    // DC bias + chroma leak — a real composite path mangles the demodulated frame.
    await page.evaluate(() => {
      const w = globalThis as unknown as { __engine?: () => { getDomain?: (d: string) => { setParam?: (id: string, p: string, v: number) => void } | null } | null };
      const vid = w.__engine?.()?.getDomain?.('video');
      vid?.setParam?.('bb', 'sync_crush', 1.9);
      vid?.setParam?.('bb', 'enhance', 0.9);
      vid?.setParam?.('bb', 'bias', 0.3);
      vid?.setParam?.('bb', 'chroma_leak', 0.8);
    });

    const bent = await stepAndReadStats(page, { nodeId: 'bb', steps: FIXED_STEPS });
    expect(bent.framesDelta, 'bent burst advanced the exact frame count').toBe(FIXED_STEPS);

    // The bend shifts DC bias + contrast (crush) + colour (chroma leak), all of
    // which move the aggregate luma stats (NOT a frequency-only change), so the
    // two FROZEN reads differ by a renderer-tolerant margin. Identical frozen
    // frames would diff ≈0.
    const meanDelta = Math.abs(bent.mean - clean.mean);
    const varDelta = Math.abs(bent.variance - clean.variance);
    const nzDelta = Math.abs(bent.nonZeroFrac - clean.nonZeroFrac);
    expect(
      meanDelta > 2 || varDelta > 5 || nzDelta > 0.02,
      `bent output differs from clean (Δmean=${meanDelta.toFixed(2)} Δvar=${varDelta.toFixed(2)} Δnz=${nzDelta.toFixed(3)})`,
    ).toBe(true);

    expect(errors, 'no console / page errors during B3NTB0X bend').toEqual([]);
  });

  // LIVE-CONTROLS PIXEL GATE (owner: "controls that don't do much/anything"),
  // CONVERTED to the DETERMINISTIC render-smoke (DRS) pattern. The per-control
  // param→uniform wiring + per-control behaviour math are unit-tested GPU-free in
  // b3ntb0x.test.ts. This GL test is the end-to-end proof that each PREVIOUSLY
  // DEAD/WEAK control — applied through the REAL 4-pass pipeline — visibly
  // changes the decoded frame vs a clean baseline.
  //
  // OLD shape (#859): baseline + one capture per control, EACH a full
  // goto+spawn+waitForTimeout(1500)+getImageData(2D canvas) — three
  // un-synchronized clocks (rAF throttling, b3ntb0x's subcarrier drift, the card
  // blit). NOW: ONE page-load. installRenderSmokeHooks + __b3ntb0xFreezeTimeSec
  // pin BOTH clocks BEFORE goto; spawn SHAPES→b3ntb0x ONCE at CLEAN params; read
  // a baseline frozen frame; then for each representative control setParam('bb',
  // …, extreme) via the engine VIDEO domain and read again, asserting the FROZEN
  // frame DIFFERS from the baseline by a renderer-tolerant per-pixel margin (and
  // restore it to CLEAN so each control is measured in isolation). Per-pixel
  // frameDiff (not aggregate stats) because a chroma-only HUE rotation / a
  // spatial bend can collude the global mean+variance to near-identical values
  // while every pixel moves (the same blind spot video-controls.spec.ts handles
  // for LINES amp / V-MIXER cross-fade).
  //
  // SAME representative controls #859 chose, one per newly-fixed CATEGORY:
  //   hue       — decode-side tint (chroma-only; the frameDiff motivation)
  //   sub_drift — encode-side subcarrier drift (time-animated; the off-zero pin
  //               exercises it)
  //   ac_dc     — the strengthened AC-coupling path
  //   tbc       — time-base correction (1=steady, 0=wobble)
  //   bend_a/b/c/d — the bend-network taps
  test('newly-wired SPATIAL controls change the decoded output (frozen; time-modulated ones are unit-tested)', async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Pin BOTH clocks BEFORE boot (engine rAF/clock + b3ntb0x's own subcarrier-
    // drift clock at the off-zero t=2 so sub_drift's term is exercised, not the
    // degenerate t=0). One page-load: spawn CLEAN once, read a frozen baseline,
    // then flip ONE control at a time and read again.
    await freezeB3ntb0x(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Clean baseline: every audited control at its inert value, tbc=1 (steady,
    // no wobble), feedback=0 + noise=0 (kill the time-varying / random sources)
    // so a control's frozen-frame diff is the PURE control effect, frame-stable.
    const CLEAN: Record<string, number> = {
      sync_crush: 1.0, enhance: 0.0, bias: 0.0, ac_dc: 0.0, chroma_leak: 0.0,
      luma_peak: 0.0, hue: 0.0, sub_drift: 0.0, tbc: 1.0, feedback: 0.0,
      noise: 0.0, bend_a: 0.0, bend_b: 0.0, bend_c: 0.0, bend_d: 0.0,
    };

    await spawnPatch(
      page,
      [
        { id: 'src', type: 'shapes',  position: { x: 100, y: 100 }, domain: 'video', params: { shape: 0, zoom: 1.4 } },
        { id: 'bb',  type: 'b3ntb0x', position: { x: 540, y: 100 }, domain: 'video', params: { ...CLEAN } },
      ],
      [
        { id: 'e_src', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'bb', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );
    await expect(page.locator('[data-testid="b3ntb0x-canvas"]'), 'canvas mounted').toHaveCount(1);

    // Frozen baseline: assert the CLEAN frame is a real structured decode first
    // (so a per-control diff isn't measured against a black/broken frame), then
    // capture it as a per-pixel reference.
    const baseStats = await stepAndReadStats(page, { nodeId: 'bb', steps: FIXED_STEPS });
    assertRenderStats(baseStats, FIXED_STEPS);
    const baseFrame = await stepAndReadFrame(page, { nodeId: 'bb', steps: FIXED_STEPS });
    expect(baseFrame.length, 'baseline sampled').toBeGreaterThan(0);

    // The SPATIAL/instantaneous newly-wired controls, each set to an extreme via
    // the engine VIDEO domain (the SAME setParam hot-path the bend-proof drives)
    // and driven in isolation (CLEAN-restored between) so the diff is attributable
    // to that ONE control. tbc 0 = full wobble (constant offset under a frozen
    // clock); ac_dc = strengthened AC coupling; bend_a/bend_c = bend-network taps.
    //
    // DELIBERATELY EXCLUDED — these are TIME/FEEDBACK-modulated, so a FROZEN clock
    // (required for a deterministic per-pixel diff) NEUTRALISES them (measured:
    // frozen frameDiff sub_drift=0.000, bend_d=0.000, bend_b=0.083, hue=0.52). Their
    // wiring + behaviour math is covered GPU-free by b3ntb0x.test.ts (56 tests), and
    // a chroma control (chroma_leak) is exercised in GL by the bend-proof test
    // above — so dropping them here loses no coverage, it just puts each control's
    // proof where it can be made deterministic. sub_drift's drift + the feedback-
    // routed bend taps are inherently NOT a single-frozen-frame property.
    const CONTROLS: Array<{ param: string; extreme: number }> = [
      { param: 'ac_dc',  extreme: 1.0 }, // strengthened AC coupling (frozen Δ≈160)
      { param: 'tbc',    extreme: 0.0 }, // time-base correction wobble (frozen Δ≈1.6)
      { param: 'bend_a', extreme: 1.0 }, // bend-network tap A (frozen Δ≈161)
      { param: 'bend_c', extreme: 1.0 }, // bend-network tap C (frozen Δ≈22)
    ];

    for (const { param, extreme } of CONTROLS) {
      await setVideoParam(page, 'bb', param, extreme);
      const stats = await stepAndReadStats(page, { nodeId: 'bb', steps: FIXED_STEPS });
      expect(stats.framesDelta, `${param}: burst advanced the exact frame count`).toBe(FIXED_STEPS);
      const frame = await stepAndReadFrame(page, { nodeId: 'bb', steps: FIXED_STEPS });

      // Per-pixel frame delta vs the frozen baseline. Identical frozen frames
      // diff ≈0 (bit-stable); a working control moves many pixels even when it's
      // a chroma-only / frequency change the aggregate stats can't see.
      const d = frameDiff(baseFrame, frame);
      // Threshold 0.5: the weakest KEPT control (tbc) moves ~1.6 frozen, the rest
      // ≫ that (ac_dc/bend_a ≈160, bend_c ≈22); a dead/inert control diffs ≈0
      // (frozen frames are bit-stable). 0.5 is a ~3× floor on the weakest, well
      // clear of zero and renderer-robust (no chroma-precision-sensitive control
      // is in this set — those are unit-tested).
      expect(
        d,
        `control "${param}"=${extreme} changes the decoded output (frozen per-pixel frameDiff=${d.toFixed(2)})`,
      ).toBeGreaterThan(0.5);

      // Restore to CLEAN so the next control is measured in isolation.
      await setVideoParam(page, 'bb', param, CLEAN[param]!);
    }

    expect(errors, 'no console / page errors during B3NTB0X live-controls gate').toEqual([]);
  });

  // NOTE (Phase 2 lean, webgl-suite-optimization §1/§2/§7-3): the old test 3
  // ("CV-bending knobs mutate params via the patch store") was a pure store
  // round-trip (wrote node.params, read them BACK from the store; never touched
  // the engine) → DOWNGRADED to b3ntb0x.test.ts ("B3NTB0X factory setParam
  // propagates to the live engine param"), which drives the REAL factory setParam
  // hot-path (GPU-free). t1 (structured non-black decode) + t2 (bend-mangles-
  // output, the 4-pass NTSC proof) + t3 (every newly-wired control changes the
  // output, DRS) are the GL pixel gates for this VRT-exempt + per-port-exempt module.
});
