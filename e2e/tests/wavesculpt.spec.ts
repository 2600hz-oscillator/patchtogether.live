// e2e/tests/wavesculpt.spec.ts
//
// WAVESCULPT v2 (wavetable engine) smoke. Covers:
//   - module spawns; card + canvas + two joysticks mount.
//   - UNISON toggle flips the unison param.
//   - Camera XY pad updates pos_x / pos_y.
//   - NEW v2: zoom/rot pad updates zoom + rot params (X-axis = zoom).
//   - Ribbons render pre-ADSR (canvas non-empty without gates).
//   - NEW v2: changing morph1 changes the rendered ribbon shape (the
//     ribbon vertex shader now samples the live wavetable frame).
//   - alpha_in patch accepted + thickness param routes through store.
//   - Bentscreen knobs route through patch store (regression).
//
// No pixel-exact assertions — animated 3D render + CRT feedback is
// non-deterministic per the existing vrt-meta exempt entry.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('WAVESCULPT v2 — wavetable-engine 3D-camera video synth', () => {
  test('spawns + card + canvas + two joysticks mount, no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);

    await expect(page.locator('[data-testid="wavesculpt-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="wavesculpt-canvas"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="wavesculpt-pad"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="wavesculpt-pad-zoomrot"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="wavesculpt-unison"]')).toHaveCount(1);

    // All 4 per-osc strips present with WAV selector + LOAD button.
    for (let i = 1; i <= 4; i++) {
      await expect(page.locator(`[data-testid="wavesculpt-osc-${i}"]`)).toHaveCount(1);
      await expect(page.locator(`[data-testid="wavesculpt-osc-${i}-wav-select"]`)).toHaveCount(1);
      await expect(page.locator(`[data-testid="wavesculpt-osc-${i}-load"]`)).toHaveCount(1);
    }

    // Let the rAF render loop tick a few frames so any shader/init
    // failure surfaces as a console.error before we assert.
    await page.waitForTimeout(400);

    expect(errors, 'no console / page errors during WAVESCULPT render').toEqual([]);
  });

  test('UNISON toggle flips the unison param', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);

    const initialUnison = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      return w.__patch.nodes['ws']?.params.unison ?? 0;
    });
    expect(initialUnison).toBe(0);

    await page.locator('[data-testid="wavesculpt-unison"]').click();
    await page.waitForTimeout(80);

    const afterUnison = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      return w.__patch.nodes['ws']?.params.unison ?? 0;
    });
    expect(afterUnison, 'UNISON toggle on').toBe(1);

    await page.locator('[data-testid="wavesculpt-unison"]').click();
    await page.waitForTimeout(80);

    const afterUnison2 = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      return w.__patch.nodes['ws']?.params.unison ?? 0;
    });
    expect(afterUnison2, 'UNISON toggle off again').toBe(0);
  });

  test('camera XY pad drags update pos_x / pos_y in the patch store', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);

    const pad = page.locator('[data-testid="wavesculpt-pad"]');
    await expect(pad).toHaveCount(1);
    const box = await pad.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    const tx = box.x + box.width * 0.85;
    const ty = box.y + box.height * 0.15;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(tx, ty, { steps: 6 });
    await page.mouse.up();

    await page.waitForTimeout(80);

    const params = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      const n = w.__patch.nodes['ws'];
      return { pos_x: n?.params.pos_x ?? 0, pos_y: n?.params.pos_y ?? 0 };
    });
    expect(params.pos_x, 'pos_x positive after drag right').toBeGreaterThan(0.3);
    expect(params.pos_y, 'pos_y positive after drag up (Y flipped)').toBeGreaterThan(0.3);
  });

  test('zoom/rot pad: drag-right → zoom > 1; drag-up → rot > 0', async ({ page }) => {
    // The new second joystick. X = zoom (log-mapped to [0.3..3]); Y = rot
    // ([-1..+1]). At the pad center the dot sits at zoom=1, rot=0.
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);

    const pad = page.locator('[data-testid="wavesculpt-pad-zoomrot"]');
    await expect(pad).toHaveCount(1);
    const box = await pad.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    // Drag from center to upper-right corner: should bump both zoom AND
    // rot above their defaults.
    const tx = box.x + box.width * 0.9;
    const ty = box.y + box.height * 0.1;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(tx, ty, { steps: 6 });
    await page.mouse.up();

    await page.waitForTimeout(80);

    const params = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      const n = w.__patch.nodes['ws'];
      return { zoom: n?.params.zoom ?? 0, rot: n?.params.rot ?? 0 };
    });
    expect(params.zoom, 'zoom > 1 after drag right').toBeGreaterThan(1.2);
    expect(params.rot, 'rot > 0 after drag up').toBeGreaterThan(0.3);
  });

  test('ribbons render pre-ADSR — canvas is non-empty even without any gate', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);
    await expect(page.locator('[data-testid="wavesculpt-canvas"]')).toHaveCount(1);

    // Poll for ribbons rather than waitForTimeout(800) — same race the
    // morph test hit (PR #231). The fill-then-draw rAF loop has a
    // brief all-bg window; the canvas may be black on a single sample.
    // Poll up to 3 s for at least one non-bg pixel.
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const c = document.querySelector('[data-testid="wavesculpt-canvas"]') as HTMLCanvasElement | null;
          if (!c) return false;
          const ctx = c.getContext('2d');
          if (!ctx) return false;
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          for (let i = 0; i < data.length; i += 4 * 16) {
            const sum = (data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0);
            if (sum > 60) return true;
          }
          return false;
        });
      }, {
        message: 'ribbons never rendered (canvas stayed all-black for 3s)',
        timeout: 3_000,
        intervals: [100, 200, 400],
      })
      .toBe(true);
  });

  test('ALPHA layer (osc 3) stays visible under camera rotation — alpha-rotate bugfix', async ({ page }) => {
    // Regression for the alpha-rotate bug: the ALPHA ribbon (osc 3) used
    // to vanish the instant the camera rotated off-axis. Root cause: the
    // scene + alpha-mask passes primed the depth buffer with ALL FOUR
    // ribbons, so any RGB ribbon in FRONT of the ALPHA ribbon depth-culled
    // it. At rot=0 the ALPHA emitter (-Z wall) is nearest the camera so it
    // survived; ANY rotation brought an RGB ribbon forward and the ALPHA
    // layer disappeared. Fix: additive ribbons are order-independent, so
    // we dropped the inter-ribbon depth occlusion entirely.
    //
    // This test ISOLATES the ALPHA ribbon (thick/wide osc 3, thin RGB)
    // and rotates the camera to ~72° (rot=0.4). With the bug the ALPHA
    // region would be black; with the fix it renders. We count non-black
    // pixels and require a substantial population (not a stray AA pixel).
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // SHAPES → alpha_in supplies the ALPHA composite image (a bright
    // near-white shape). The BENT post-pass paints that image ONLY where
    // the ALPHA mask (osc 3) is non-zero. Counting near-WHITE pixels (all
    // channels bright + balanced) isolates the ALPHA composite — the RGB
    // ribbons are saturated single-channel colours and never read white.
    // All four ribbons are fat so the RGB ribbons are genuine depth
    // OCCLUDERS: pre-fix, the scene + mask passes primed depth with all
    // four ribbons, so an RGB ribbon in front depth-culled the ALPHA mask
    // under rotation → the composite collapsed. We keep zoom=1.0 + a small
    // rotation (rot=0.2) so the ALPHA ribbon stays centred (alpha_in is
    // sampled in screen space) — isolating the depth-occlusion regression
    // rather than mere projection. Empirically: fixed ≈25k white pixels at
    // rot=0.2, the buggy depth-prime ≈9.5k.
    const spawnAt = async (rot: number): Promise<void> => {
      await spawnPatch(page, [
        { id: 'src', type: 'shapes', position: { x: 60, y: 60 }, domain: 'video' },
        {
          id: 'ws', type: 'wavesculpt', position: { x: 400, y: 100 }, domain: 'audio',
          params: {
            rot, zoom: 1.0,
            thickness1: 0.8, thickness2: 0.8, thickness3: 0.8, thickness4: 0.9,
            alpha_brightness: 2, noise: 0,
          },
        },
      ], [
        { id: 'e_alpha', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'ws', portId: 'alpha_in' }, sourceType: 'video', targetType: 'video' },
      ]);
      await page.evaluate(() => { (globalThis as unknown as { __wavesculptVrtFreeze?: boolean }).__wavesculptVrtFreeze = true; });
    };

    const countAlphaWhite = (): Promise<number> =>
      page.evaluate(() => {
        const c = document.querySelector('[data-testid="wavesculpt-canvas"]') as HTMLCanvasElement | null;
        if (!c) return 0;
        const ctx = c.getContext('2d');
        if (!ctx) return 0;
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let white = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i] ?? 0, g = data[i + 1] ?? 0, b = data[i + 2] ?? 0;
          if (r > 110 && g > 110 && b > 110) white++;
        }
        return white;
      });

    // Baseline: head-on (rot=0) the ALPHA composite is clearly visible
    // (this worked even pre-fix).
    await spawnAt(0);
    await expect(page.locator('[data-testid="wavesculpt-canvas"]')).toHaveCount(1);
    let headOnWhite = 0;
    await expect.poll(async () => (headOnWhite = await countAlphaWhite()), {
      message: 'ALPHA composite never rendered head-on',
      timeout: 4_000,
      intervals: [150, 300, 500],
    }).toBeGreaterThan(2000);

    // Rotated: pre-fix the ALPHA mask was depth-culled by the (thick) RGB
    // ribbons in front, collapsing the composite (~38% of head-on). Post-
    // fix the ALPHA layer composites at any angle (~85% of head-on). The
    // 0.6 threshold sits cleanly between the two regimes.
    await spawnAt(0.2);
    await expect.poll(async () => countAlphaWhite(), {
      message: 'ALPHA composite collapsed under rotation (alpha-rotate regression)',
      timeout: 4_000,
      intervals: [150, 300, 500],
    }).toBeGreaterThan(headOnWhite * 0.6);
  });

  test('changing osc1 morph changes the rendered ribbon shape', async ({ page }) => {
    // NEW v2 contract: the ribbon vertex shader samples the live
    // wavetable frame texture. Different morph positions point at
    // different frames of the (basic-shapes default) wavetable, so the
    // resulting ribbon shape must visually change. We sample a top-row
    // pattern of the canvas before + after, and assert at least some
    // pixels differ — not pixel-exact, just non-equal.
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);
    await expect(page.locator('[data-testid="wavesculpt-canvas"]')).toHaveCount(1);

    async function setMorphAll(v: number): Promise<void> {
      // Set ALL FOUR osc morphs to v. BLUE + ALPHA osc displacements are
      // in the X axis (perpendicular to the camera look direction), which
      // gives the largest screen-space delta when the wavetable frame
      // changes. RED + GREEN's displacements are in Z, less visible.
      // Using all four maximizes the per-change signal at the camera POV
      // we ship.
      await page.evaluate((val) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          const n = w.__patch.nodes['ws'];
          if (!n) return;
          n.params.morph1 = val;
          n.params.morph2 = val;
          n.params.morph3 = val;
          n.params.morph4 = val;
        });
      }, v);
      await page.waitForTimeout(400);
    }

    async function singleHistogramSample(): Promise<number[]> {
      // Return a coarse intensity histogram so we can compare frame
      // shapes ignoring per-pixel timing noise. The histogram gives a
      // stronger signal than a raw lit-pixel count (which can match across
      // very different shapes if total coverage happens to balance out).
      return page.evaluate(() => {
        const c = document.querySelector('[data-testid="wavesculpt-canvas"]') as HTMLCanvasElement | null;
        if (!c) return [];
        const ctx = c.getContext('2d');
        if (!ctx) return [];
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        // 8-bin per-channel histogram of (R+G+B)/3.
        const bins = new Array(8).fill(0);
        for (let i = 0; i < data.length; i += 4) {
          const v = ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0)) / 3;
          const b = Math.min(7, Math.floor(v / 32));
          bins[b]++;
        }
        return bins;
      });
    }

    /** Sample 5 rAF-spaced histograms and return the one with the
     *  most non-bin-0 content. The WebGL rAF loop fills the canvas
     *  with the #050608 background BEFORE drawing ribbons each frame
     *  — a single-shot capture can land in the brief fill-but-pre-
     *  draw window and come back all-bin-0. Same pattern as the
     *  busiestHistogram() helper in wavesculpt-camera-cv.spec.ts (PR
     *  #232). 5 samples covers 5 rAF ticks; at least 3 will hit
     *  fully-rendered frames and we pick the strongest signal. */
    async function sampleScreenSignature(): Promise<number[]> {
      let best: number[] = [];
      let bestNonBg = -1;
      for (let i = 0; i < 5; i++) {
        const h = await singleHistogramSample();
        const nonBg = h.slice(1).reduce((a, b) => a + b, 0);
        if (nonBg > bestNonBg) {
          best = h;
          bestNonBg = nonBg;
        }
        if (i < 4) await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
      }
      return best;
    }

    function l1Diff(a: number[], b: number[]): number {
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
      return sum;
    }

    await setMorphAll(0);
    // Wait until the ribbons are actually on-screen. WebGL shader
    // compile + first FBO render takes a few rAFs after the WAVESCULPT
    // card mounts; the 400 ms wait inside setMorphAll isn't always
    // enough. If we sample too early we get all-black sigA and the
    // L1 distance ties at 0. Poll up to 3s for a frame with non-bin-0
    // content (any luminance ≥ 32).
    await expect
      .poll(async () => {
        const h = await sampleScreenSignature();
        return h.slice(1).reduce((a, b) => a + b, 0);
      }, {
        message: 'ribbons never rendered (canvas stayed all-black for 3s)',
        timeout: 3_000,
        intervals: [100, 200, 400],
      })
      .toBeGreaterThan(0);
    const sigA = await sampleScreenSignature();
    await setMorphAll(0.95);
    const sigB = await sampleScreenSignature();

    expect(sigA.length, 'sample signature came back').toBeGreaterThan(0);
    expect(sigB.length).toBeGreaterThan(0);
    const diff = l1Diff(sigA, sigB);
    // Histogram L1 distance — quiet morph change typically moves 10s of
    // pixels per bin × 8 bins = a few hundred. Threshold of 50 is well
    // above the per-frame CRT-noise jitter (which is bounded by the
    // bentbox uTime hash + Playwright's animation-freezing during
    // toHaveScreenshot — not active here, but rAF determinism still
    // bounds the noise floor).
    expect(
      diff,
      `morph change should perturb the screen histogram noticeably (L1=${diff})`,
    ).toBeGreaterThan(50);
  });

  test('alpha_in compositing — patch a PICTUREBOX into alpha_in, canvas stays alive', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'pb', type: 'picturebox', position: { x: 100, y: 100 }, domain: 'video' },
        { id: 'ws', type: 'wavesculpt', position: { x: 600, y: 100 }, domain: 'audio' },
      ],
      [
        {
          id: 'pb_to_ws_alpha',
          from: { nodeId: 'pb', portId: 'out' },
          to: { nodeId: 'ws', portId: 'alpha_in' },
          sourceType: 'image',
          targetType: 'video',
        },
      ],
    );
    await expect(page.locator('[data-testid="wavesculpt-card"]')).toHaveCount(1);

    await page.waitForTimeout(400);

    const edgeExists = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { edges: Record<string, { target?: { nodeId: string; portId: string } }> };
      };
      return Object.values(w.__patch.edges).some(
        (e) => e.target?.nodeId === 'ws' && e.target?.portId === 'alpha_in',
      );
    });
    expect(edgeExists, 'alpha_in edge present in patch graph').toBe(true);

    expect(errors, 'no errors with alpha_in patched').toEqual([]);
  });

  test('per-osc thickness param routes through the patch store', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);
    await expect(page.locator('[data-testid="wavesculpt-card"]')).toHaveCount(1);

    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['ws'];
        if (!n) return;
        n.params.thickness1 = 0.8;
        n.params.thickness3 = 0.1;
      });
    });
    await page.waitForTimeout(120);

    const params = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      const n = w.__patch.nodes['ws'];
      return { t1: n?.params.thickness1, t3: n?.params.thickness3 };
    });
    expect(params.t1).toBe(0.8);
    expect(params.t3).toBe(0.1);
  });

  test('video_mode=2 SPECTROGRAPH renders non-zero pixels (scrolling STFT)', async ({ page }) => {
    // Switching the discrete video_mode param to 2 should activate the
    // SPECTROGRAPH render path: a circular column buffer of FFT
    // magnitudes blitted to the canvas. We assert the canvas contains
    // non-bg pixels after a few rAF frames — the heatmap renders even
    // for silence (the -100dB floor lands in the bottom of the
    // [-90..-10] dB display range = dark blue, not pure black).
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);
    await expect(page.locator('[data-testid="wavesculpt-canvas"]')).toHaveCount(1);

    // Flip video_mode to 2 (SPECTROGRAPH) via the patch store directly
    // — cheaper than driving the view-toggle button through two clicks.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['ws'];
        if (n) n.params.video_mode = 2;
      });
    });

    // Poll for non-bg pixels (heatmap minimum is dark blue, well above
    // pure black). Same polling shape as the ribbons-render test.
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const c = document.querySelector('[data-testid="wavesculpt-canvas"]') as HTMLCanvasElement | null;
          if (!c) return false;
          const ctx = c.getContext('2d');
          if (!ctx) return false;
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          // Look for any pixel with B > 50 (the heatmap's silence floor
          // is dark blue, ~rgb(0,0,80..180)). Pure-bg pixels are
          // rgb(5,6,8) — B value of 8 — so the threshold cleanly
          // separates spectrograph paint from background fill.
          for (let i = 0; i < data.length; i += 4 * 16) {
            const b = data[i + 2] ?? 0;
            if (b > 50) return true;
          }
          return false;
        });
      }, {
        message: 'SPECTROGRAPH never rendered (canvas stayed bg-only for 3s)',
        timeout: 3_000,
        intervals: [100, 200, 400],
      })
      .toBe(true);

    // Sanity: the view-toggle button cycles into SPECTRO label when
    // video_mode = 2 (verifies the UI stays in sync with the param).
    const label = await page.locator('[data-testid="wavesculpt-view-toggle"]').textContent();
    expect(label?.trim()).toBe('SPECTRO');
  });

  test('view-toggle cycles 3D → BIRDSEYE → SPECTRO → 3D', async ({ page }) => {
    // The single VIEW button click-cycles through all three video
    // modes. Verify each click bumps the video_mode param and the
    // label updates accordingly.
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);

    const btn = page.locator('[data-testid="wavesculpt-view-toggle"]');
    await expect(btn).toHaveCount(1);

    const readMode = (): Promise<number> => page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      return w.__patch.nodes['ws']?.params.video_mode ?? 0;
    });

    expect(await readMode(), 'starts at PROXIMITY').toBe(0);
    expect((await btn.textContent())?.trim()).toBe('3D');

    await btn.click();
    await page.waitForTimeout(60);
    expect(await readMode(), 'after 1st click → BIRDSEYE').toBe(1);
    expect((await btn.textContent())?.trim()).toBe('BIRDSEYE');

    await btn.click();
    await page.waitForTimeout(60);
    expect(await readMode(), 'after 2nd click → SPECTROGRAPH').toBe(2);
    expect((await btn.textContent())?.trim()).toBe('SPECTRO');

    await btn.click();
    await page.waitForTimeout(60);
    expect(await readMode(), 'after 3rd click wraps back to PROXIMITY').toBe(0);
    expect((await btn.textContent())?.trim()).toBe('3D');
  });

  test('bentscreen wiggle knobs route through the patch store', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);
    await expect(page.locator('[data-testid="wavesculpt-card"]')).toHaveCount(1);

    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['ws'];
        if (!n) return;
        n.params.hsync_drift = 0.35;
        n.params.wavefold = 0.5;
        n.params.feedback_gain = 0.6;
      });
    });
    await page.waitForTimeout(120);

    const params = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      const n = w.__patch.nodes['ws'];
      return {
        hsync_drift: n?.params.hsync_drift,
        wavefold: n?.params.wavefold,
        feedback_gain: n?.params.feedback_gain,
      };
    });
    expect(params.hsync_drift).toBe(0.35);
    expect(params.wavefold).toBe(0.5);
    expect(params.feedback_gain).toBe(0.6);
  });
});
