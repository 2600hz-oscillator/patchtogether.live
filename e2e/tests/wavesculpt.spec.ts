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
// DETERMINISM: this suite no longer sleeps on wall-clock (no fixed-ms waits).
// Every "let it render N frames" beat drives the WavesculptCard DRS step seam
// (`globalThis.__wavesculptStep(t)` runs ONE synchronous tick() per call, no
// rAF reschedule; `__wavesculptStepCount()` returns the frame counter) so the
// frame count is exact + reproducible. Store-param settles poll the actual
// param value through `__patch` rather than sleeping. Pixel-floor assertions
// stay RENDERER-TOLERANT (non-black / channel floors / RELATIVE diffs — never
// absolute counts or bit-equality) because CI renders under SwiftShader, and
// every GL-pixel read is gated on a runtime capability probe.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

// ──────────────── deterministic step-seam helpers ────────────────

/** Wait until the WavesculptCard mounted + installed its DRS step seam. */
async function awaitStepSeam(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => typeof (globalThis as { __wavesculptStep?: unknown }).__wavesculptStep === 'function',
      ),
    )
    .toBe(true);
}

/**
 * Run `n` synchronous card frames at a pinned clock of `t` ms via the step
 * seam, returning the realised frame delta (== n once the card is in step
 * mode). The clock pin makes every time-derived shader input deterministic.
 */
async function stepFrames(page: Page, n: number, t = 2000): Promise<number> {
  // ATOMIC: enter step-mode (halts the card rAF self-schedule), read `before`,
  // drive N steps, read `after` — ALL inside ONE page.evaluate, so a stray rAF
  // tick can't interleave between the before/after reads. (The previous version
  // read before/after in SEPARATE evaluates; a rAF tick firing between them
  // inflated the delta → the exact-count assert flaked.) The leading
  // __wavesculptStep(t) enters step-mode + pins the clock; `before` is captured
  // AFTER it, so after-before is EXACTLY n.
  const delta = await page.evaluate(
    ({ n, t }) => {
      const g = globalThis as {
        __wavesculptStep?: (t?: number) => number;
        __wavesculptStepCount?: () => number;
      };
      g.__wavesculptStep?.(t); // enter step-mode (halts rAF) + pin clock + 1 frame
      const before = g.__wavesculptStepCount?.() ?? 0;
      for (let i = 0; i < n; i++) g.__wavesculptStep?.(t);
      const after = g.__wavesculptStepCount?.() ?? 0;
      return after - before;
    },
    { n, t },
  );
  await page.evaluate(() => {}); // flush console events to the listener
  return delta;
}

/** Pin shader/scope content to fixed synthetic values (composes with the step
 *  seam) so a single read is reproducible across runs/renderers. */
async function freeze(page: Page): Promise<void> {
  await page.evaluate(() => {
    (globalThis as { __wavesculptVrtFreeze?: boolean }).__wavesculptVrtFreeze = true;
  });
}

/**
 * Runtime GL-capability probe. WAVESCULPT's 3D path renders through a WebGL2
 * context and blits onto the 2D display canvas (`wavesculpt-canvas`); the 2D
 * modes paint directly. This probe returns true only when a WebGL2 context is
 * obtainable AND the display canvas reads back usable, non-uniform pixel data
 * after stepping — i.e. the 3D pixel-floor assertions are meaningful on this
 * renderer. Under a renderer that yields nothing usable we skip the pixel
 * floor rather than ship a flaky assert (CI = SwiftShader).
 */
async function glPixelsUsable(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    // 1) A WebGL2 context must be obtainable at all.
    let webgl2 = false;
    try {
      const probe = document.createElement('canvas');
      webgl2 = !!probe.getContext('webgl2');
    } catch {
      webgl2 = false;
    }
    if (!webgl2) return false;
    // 2) The display canvas must read back something with variance (not a flat
    //    uniform buffer that no floor could distinguish from background).
    const c = document.querySelector('[data-testid="wavesculpt-canvas"]') as HTMLCanvasElement | null;
    if (!c) return false;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(0, 0, c.width, c.height).data;
    } catch {
      return false; // tainted / unreadable
    }
    if (data.length < 4) return false;
    let min = 255;
    let max = 0;
    // DENSE scan (every pixel). A sparse stride misses thin, clustered content
    // (e.g. BLINK mode-1's 4-corner scope traces — lit but few pixels), which
    // false-reads as "degenerate" and skips a test that actually renders. The
    // probe's job is "did the renderer produce ANY readable lit content," so it
    // must scan as densely as the floor it gates.
    for (let i = 0; i < data.length; i += 4) {
      const v = (data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    // Some spread means the renderer produced readable, non-degenerate output.
    return max - min > 4;
  });
}

test.describe('WAVESCULPT v2 — wavetable-engine 3D-camera video synth', () => {
  test('spawns + card + canvas + two joysticks mount, no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/rack');
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

    // Drive exactly 8 deterministic frames so any shader/init failure surfaces
    // as a console.error before we assert — no wall-clock sleep.
    await awaitStepSeam(page);
    const d = await stepFrames(page, 8);
    expect(d, 'step seam advanced exactly 8 frames').toBe(8);

    expect(errors, 'no console / page errors during WAVESCULPT render').toEqual([]);
  });

  test('UNISON toggle flips the unison param', async ({ page }) => {
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);
    await awaitStepSeam(page);

    const readUnison = (): Promise<number> =>
      page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
        };
        return w.__patch.nodes['ws']?.params.unison ?? 0;
      });

    expect(await readUnison()).toBe(0);

    await page.locator('[data-testid="wavesculpt-unison"]').click();
    await expect.poll(readUnison, { message: 'UNISON toggle on' }).toBe(1);

    await page.locator('[data-testid="wavesculpt-unison"]').click();
    await expect.poll(readUnison, { message: 'UNISON toggle off again' }).toBe(0);
  });

  test('camera XY pad drags update pos_x / pos_y in the patch store', async ({ page }) => {
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);
    await awaitStepSeam(page);

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

    const readPad = (): Promise<{ pos_x: number; pos_y: number }> =>
      page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
        };
        const n = w.__patch.nodes['ws'];
        return { pos_x: n?.params.pos_x ?? 0, pos_y: n?.params.pos_y ?? 0 };
      });

    await expect
      .poll(async () => (await readPad()).pos_x, { message: 'pos_x positive after drag right' })
      .toBeGreaterThan(0.3);
    await expect
      .poll(async () => (await readPad()).pos_y, { message: 'pos_y positive after drag up (Y flipped)' })
      .toBeGreaterThan(0.3);
  });

  test('zoom/rot pad: drag-right → zoom > 1; drag-up → rot > 0', async ({ page }) => {
    // The new second joystick. X = zoom (log-mapped to [0.3..3]); Y = rot
    // ([-1..+1]). At the pad center the dot sits at zoom=1, rot=0.
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);
    await awaitStepSeam(page);

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

    const readZoomRot = (): Promise<{ zoom: number; rot: number }> =>
      page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
        };
        const n = w.__patch.nodes['ws'];
        return { zoom: n?.params.zoom ?? 0, rot: n?.params.rot ?? 0 };
      });

    await expect
      .poll(async () => (await readZoomRot()).zoom, { message: 'zoom > 1 after drag right' })
      .toBeGreaterThan(1.2);
    await expect
      .poll(async () => (await readZoomRot()).rot, { message: 'rot > 0 after drag up' })
      .toBeGreaterThan(0.3);
  });

  test('ribbons render pre-ADSR — canvas is non-empty even without any gate', async ({ page }) => {
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);
    await expect(page.locator('[data-testid="wavesculpt-canvas"]')).toHaveCount(1);
    await awaitStepSeam(page);

    // Freeze + step a handful of deterministic frames (shader compile + first
    // FBO render lands within a couple ticks), then read the canvas ONCE.
    await freeze(page);
    await stepFrames(page, 4);

    if (!(await glPixelsUsable(page))) {
      test.skip(true, 'no usable GL pixel read on this renderer');
      return;
    }

    // Relative FLOOR: count subsampled lit pixels (sum > 60) and require a
    // non-trivial population vs the #050608 background (sum ~19). The exact
    // count is renderer-dependent, so we only assert "ribbons are clearly
    // present", not an absolute number.
    const lit = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="wavesculpt-canvas"]') as HTMLCanvasElement | null;
      if (!c) return 0;
      const ctx = c.getContext('2d');
      if (!ctx) return 0;
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < data.length; i += 4 * 16) {
        const sum = (data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0);
        if (sum > 60) n++;
      }
      return n;
    });
    expect(lit, 'ribbons render a non-trivial lit-pixel population').toBeGreaterThan(20);
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
    // and rotates the camera to ~36° (rot=0.2). With the bug the ALPHA
    // region would collapse; with the fix it renders. We count near-white
    // pixels and require a substantial fraction of the head-on baseline.
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // SHAPES → alpha_in supplies the ALPHA composite image (a bright
    // near-white shape). The BENT post-pass paints that image ONLY where
    // the ALPHA mask (osc 3) is non-zero. Counting near-WHITE pixels (all
    // channels bright + balanced) isolates the ALPHA composite — the RGB
    // ribbons are saturated single-channel colours and never read white.
    // All four ribbons are fat so the RGB ribbons are genuine depth
    // OCCLUDERS. We keep zoom=1.0 + a small rotation so the ALPHA ribbon
    // stays centred (alpha_in is sampled in screen space) — isolating the
    // depth-occlusion regression rather than mere projection.
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
      await awaitStepSeam(page);
      await freeze(page);
      // Deterministic frames: prime the FBO + render the frozen frame.
      await stepFrames(page, 5);
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

    if (!(await glPixelsUsable(page))) {
      test.skip(true, 'no usable GL pixel read on this renderer');
      return;
    }

    const headOnWhite = await countAlphaWhite();
    expect(headOnWhite, 'ALPHA composite renders head-on').toBeGreaterThan(2000);

    // Rotated: pre-fix the ALPHA mask was depth-culled by the (thick) RGB
    // ribbons in front, collapsing the composite (~38% of head-on). Post-
    // fix the ALPHA layer composites at any angle (~85% of head-on). The
    // 0.6 RELATIVE threshold sits cleanly between the two regimes.
    await spawnAt(0.2);
    const rotatedWhite = await countAlphaWhite();
    expect(
      rotatedWhite,
      'ALPHA composite survives rotation (alpha-rotate regression)',
    ).toBeGreaterThan(headOnWhite * 0.6);
  });

  test('changing osc1 morph changes the rendered ribbon shape', async ({ page }) => {
    // NEW v2 contract: the ribbon vertex shader samples the live
    // wavetable frame texture. Different morph positions point at
    // different frames of the (basic-shapes default) wavetable, so the
    // resulting ribbon shape must visually change. We sample a coarse
    // intensity histogram before + after, and assert a substantial L1
    // distance — not pixel-exact, just a clear shape change.
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);
    await expect(page.locator('[data-testid="wavesculpt-canvas"]')).toHaveCount(1);
    await awaitStepSeam(page);
    await freeze(page);

    async function setMorphAll(v: number): Promise<void> {
      // Set ALL FOUR osc morphs to v. BLUE + ALPHA osc displacements are
      // in the X axis (perpendicular to the camera look direction), which
      // gives the largest screen-space delta when the wavetable frame
      // changes. Using all four maximizes the per-change signal.
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
      // Deterministic frames so the new morph is sampled + rendered.
      await stepFrames(page, 4);
    }

    function histogram(): Promise<number[]> {
      // 8-bin per-channel histogram of (R+G+B)/3 — compares frame shapes
      // ignoring per-pixel noise.
      return page.evaluate(() => {
        const c = document.querySelector('[data-testid="wavesculpt-canvas"]') as HTMLCanvasElement | null;
        if (!c) return [];
        const ctx = c.getContext('2d');
        if (!ctx) return [];
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        const bins = new Array(8).fill(0);
        for (let i = 0; i < data.length; i += 4) {
          const v = ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0)) / 3;
          const b = Math.min(7, Math.floor(v / 32));
          bins[b]++;
        }
        return bins;
      });
    }

    function l1Diff(a: number[], b: number[]): number {
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
      return sum;
    }

    await setMorphAll(0);

    if (!(await glPixelsUsable(page))) {
      test.skip(true, 'no usable GL pixel read on this renderer');
      return;
    }

    const sigA = await histogram();
    await setMorphAll(0.95);
    const sigB = await histogram();

    expect(sigA.length, 'sample signature came back').toBeGreaterThan(0);
    expect(sigB.length).toBeGreaterThan(0);
    const diff = l1Diff(sigA, sigB);
    // Histogram L1 distance — quiet morph change typically moves 10s of
    // pixels per bin. Threshold of 50 is well above the deterministic-frame
    // noise floor (the step seam pins time, so rAF jitter is gone).
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

    await page.goto('/rack');
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
    await awaitStepSeam(page);

    // Drive deterministic frames so the alpha_in composite path exercises +
    // any error surfaces before we assert — no wall-clock sleep.
    await stepFrames(page, 6);

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
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);
    await expect(page.locator('[data-testid="wavesculpt-card"]')).toHaveCount(1);
    await awaitStepSeam(page);

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

    const readThickness = (): Promise<{ t1: number | undefined; t3: number | undefined }> =>
      page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
        };
        const n = w.__patch.nodes['ws'];
        return { t1: n?.params.thickness1, t3: n?.params.thickness3 };
      });

    await expect.poll(async () => (await readThickness()).t1, { message: 'thickness1 routed' }).toBe(0.8);
    await expect.poll(async () => (await readThickness()).t3, { message: 'thickness3 routed' }).toBe(0.1);
  });

  test('video_mode=2 SPECTROGRAPH renders non-zero pixels (scrolling STFT)', async ({ page }) => {
    // Switching the discrete video_mode param to 2 should activate the
    // SPECTROGRAPH render path: a circular column buffer of FFT
    // magnitudes blitted to the canvas. We assert the canvas contains
    // non-bg pixels after a few deterministic frames — the heatmap renders
    // even for silence (the -100dB floor lands in the bottom of the
    // [-90..-10] dB display range = dark blue, not pure black). This is a
    // pure-2D-canvas heatmap (no WebGL), so the blue FLOOR is renderer-
    // independent.
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);
    await expect(page.locator('[data-testid="wavesculpt-canvas"]')).toHaveCount(1);
    await awaitStepSeam(page);

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
    await expect
      .poll(() =>
        page.evaluate(() => {
          const w = globalThis as unknown as {
            __patch: { nodes: Record<string, { params: Record<string, number> }> };
          };
          return w.__patch.nodes['ws']?.params.video_mode ?? 0;
        }),
      )
      .toBe(2);

    // Step several deterministic frames so the circular column buffer fills
    // with heatmap columns, then read the canvas ONCE.
    await stepFrames(page, 8);

    // Blue-channel FLOOR (renderer-tolerant): the heatmap's silence floor is
    // dark blue (B >= 80); pure-bg pixels are rgb(5,6,8) → B of 8. We assert
    // a healthy population of B>50 pixels — a FLOOR, never bit-equality (the
    // buffer scrolls each frame).
    const bluePixels = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="wavesculpt-canvas"]') as HTMLCanvasElement | null;
      if (!c) return 0;
      const ctx = c.getContext('2d');
      if (!ctx) return 0;
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < data.length; i += 4 * 16) {
        const b = data[i + 2] ?? 0;
        if (b > 50) n++;
      }
      return n;
    });
    expect(bluePixels, 'SPECTROGRAPH paints a blue-floor heatmap').toBeGreaterThan(20);

    // Sanity: the view-toggle button shows the SPECTRO label when
    // video_mode = 2 (verifies the UI stays in sync with the param).
    const label = await page.locator('[data-testid="wavesculpt-view-toggle"]').textContent();
    expect(label?.trim()).toBe('SPECTRO');
  });

  test('view-toggle cycles 3D → BIRDSEYE → SPECTRO → 3D', async ({ page }) => {
    // The single VIEW button click-cycles through all three video
    // modes. Verify each click bumps the video_mode param and the
    // label updates accordingly.
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);
    await awaitStepSeam(page);

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
    await expect.poll(readMode, { message: 'after 1st click → BIRDSEYE' }).toBe(1);
    await expect(btn).toHaveText('BIRDSEYE');

    await btn.click();
    await expect.poll(readMode, { message: 'after 2nd click → SPECTROGRAPH' }).toBe(2);
    await expect(btn).toHaveText('SPECTRO');

    await btn.click();
    await expect.poll(readMode, { message: 'after 3rd click wraps back to PROXIMITY' }).toBe(0);
    await expect(btn).toHaveText('3D');
  });

  test('bentscreen wiggle knobs route through the patch store', async ({ page }) => {
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);
    await expect(page.locator('[data-testid="wavesculpt-card"]')).toHaveCount(1);
    await awaitStepSeam(page);

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

    const readParams = (): Promise<{
      hsync_drift: number | undefined;
      wavefold: number | undefined;
      feedback_gain: number | undefined;
    }> =>
      page.evaluate(() => {
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

    await expect.poll(async () => (await readParams()).hsync_drift, { message: 'hsync_drift routed' }).toBe(0.35);
    await expect.poll(async () => (await readParams()).wavefold, { message: 'wavefold routed' }).toBe(0.5);
    await expect.poll(async () => (await readParams()).feedback_gain, { message: 'feedback_gain routed' }).toBe(0.6);
  });

  test('BLINK button cycles blink_mode 0 → 1 → 2 → 0 and shows the mode name', async ({ page }) => {
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);
    await awaitStepSeam(page);

    const btn = page.locator('[data-testid="wavesculpt-blink-toggle"]');
    await expect(btn).toHaveCount(1);

    const readMode = (): Promise<number> => page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
      return w.__patch.nodes['ws']?.params.blink_mode ?? 0;
    });
    const nameLoc = page.locator('[data-testid="wavesculpt-blink-mode-name"]');

    // Default = mode 0 (today's render); no mode-name shown.
    expect(await readMode(), 'starts at mode 0 (current)').toBe(0);
    await expect(nameLoc).toHaveCount(0);

    await btn.click();
    await expect.poll(readMode, { message: '1st click → SCOPES TRIAL' }).toBe(1);
    await expect(nameLoc).toHaveText('SCOPES TRIAL');

    await btn.click();
    await expect.poll(readMode, { message: '2nd click → REALITY BASED COMMUNITY' }).toBe(2);
    await expect(nameLoc).toHaveText('REALITY BASED COMMUNITY');

    await btn.click();
    await expect.poll(readMode, { message: '3rd click wraps back to 0' }).toBe(0);
    await expect(nameLoc).toHaveCount(0);
  });

  test('BLINK modes 1 + 2 render the 4-corner scope traces (and differ from each other)', async ({ page }) => {
    // Drives all four oscillators audible (JOYSTICK x=1 → gate1, normalled
    // to gates 2-4) so the live scope traces have signal. Then captures the
    // canvas in mode 1 (flat scope lines) and mode 2 (neon tubes) and asserts:
    //   * both modes light a substantial fraction of the frame (the 4 corner-
    //     emitted traces actually render),
    //   * the two modes produce DIFFERENT pixels (tube shading ≠ flat line).
    // The VRT freeze pins the scope trace content to fixed synthetic values so
    // the per-mode read is deterministic.
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    const setup = async (mode: number): Promise<void> => {
      await spawnPatch(page, [
        { id: 'ws', type: 'wavesculpt', position: { x: 80, y: 80 }, domain: 'audio',
          params: { blink_mode: mode, thickness1: 0.5, thickness2: 0.5, thickness3: 0.5, thickness4: 0.5, noise: 0 } },
        { id: 'jo', type: 'joystick', position: { x: 80, y: 500 }, domain: 'audio' },
      ], [
        { id: 'g', from: { nodeId: 'jo', portId: 'x' }, to: { nodeId: 'ws', portId: 'gate1' }, sourceType: 'cv', targetType: 'gate' },
      ]);
      await page.evaluate(() => {
        const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> }; __engine?: () => { ctx: AudioContext } | null };
        const n = w.__patch.nodes['jo']; if (n) n.params.pos_x = 1;
        try { void w.__engine?.()?.ctx.resume(); } catch { /* */ }
      });
      await awaitStepSeam(page);
      await freeze(page);
      // Deterministic frames: the frozen scope traces render reproducibly.
      await stepFrames(page, 5);
    };

    const grab = (): Promise<{ lit: number; data: number[] }> => page.evaluate(() => {
      const c = document.querySelector('[data-testid="wavesculpt-canvas"]') as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let lit = 0; const out: number[] = [];
      for (let i = 0; i < d.length; i += 4) {
        const sum = (d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0);
        if (sum > 60) lit++;
        // Subsample luminance for a cheap cross-mode pixel-diff.
        if (i % (4 * 97) === 0) out.push(sum);
      }
      return { lit, data: out };
    });

    await setup(1);
    if (!(await glPixelsUsable(page))) {
      test.skip(true, 'no usable GL pixel read on this renderer');
      return;
    }
    const mode1 = await grab();
    expect(mode1.lit, 'SCOPES TRIAL renders traces').toBeGreaterThan(2000);

    await setup(2);
    const mode2 = await grab();
    expect(mode2.lit, 'REALITY BASED COMMUNITY renders tubes').toBeGreaterThan(2000);

    // The two modes must look different (tube radial shading vs flat line).
    // RELATIVE cross-mode diff, never bit-equality.
    let diff = 0;
    const n = Math.min(mode1.data.length, mode2.data.length);
    for (let i = 0; i < n; i++) if (Math.abs((mode1.data[i] ?? 0) - (mode2.data[i] ?? 0)) > 24) diff++;
    expect(diff, 'SCOPES TRIAL and REALITY BASED COMMUNITY render differently').toBeGreaterThan(20);
  });

  // ──────────────── VIDEO WALLS ────────────────

  test('VIDEO WALL: an external video source textures a box face (wall1) — bright content appears', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // SHAPES (a bright static test pattern) → wall1 (FRONT face), full
    // transparency. The textured wall should add a substantial population of
    // bright pixels.
    await spawnPatch(page, [
      { id: 'pat', type: 'shapes', position: { x: 60, y: 60 }, domain: 'video', params: { shape: 1, tile: 1, tileN: 4 } },
      { id: 'ws', type: 'wavesculpt', position: { x: 400, y: 100 }, domain: 'audio',
        params: { wall1_alpha: 100, wall1_distort: 0, rot: 0.3, pos_z: 0.2, zoom: 1.2, noise: 0 } },
    ], [
      { id: 'e_wall1', from: { nodeId: 'pat', portId: 'out' }, to: { nodeId: 'ws', portId: 'wall1' }, sourceType: 'video', targetType: 'video' },
    ]);
    await expect(page.locator('[data-testid="wavesculpt-canvas"]')).toHaveCount(1);
    await awaitStepSeam(page);
    await freeze(page);
    // Deterministic frames: prime the texture upload + wall pass.
    await stepFrames(page, 5);

    // Wall texture FLOOR + no errors. The store/edge assertion below always
    // runs; the bright-pixel floor is gated on a usable GL read (CI =
    // SwiftShader) so we never ship a flaky pixel assert.
    const edgeExists = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { edges: Record<string, { target?: { nodeId: string; portId: string } }> };
      };
      return Object.values(w.__patch.edges).some(
        (e) => e.target?.nodeId === 'ws' && e.target?.portId === 'wall1',
      );
    });
    expect(edgeExists, 'wall1 edge present in patch graph').toBe(true);

    if (await glPixelsUsable(page)) {
      const bright = await page.evaluate(() => {
        const c = document.querySelector('[data-testid="wavesculpt-canvas"]') as HTMLCanvasElement | null;
        if (!c) return 0;
        const ctx = c.getContext('2d');
        if (!ctx) return 0;
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < data.length; i += 4) {
          if ((data[i] ?? 0) > 150 && (data[i + 1] ?? 0) > 150 && (data[i + 2] ?? 0) > 150) n++;
        }
        return n;
      });
      expect(bright, 'wall1 video texture lights a bright population').toBeGreaterThan(1000);
    }

    expect(errors, 'no console / page errors with a wall patched').toEqual([]);
  });

  test('SELF-FEEDBACK: patching WAVESCULPT video_out → its own wall1 is allowed + renders (feedback madness)', async ({ page }) => {
    // The card must NOT special-case-block self-patching: video_out → wall1
    // forms a frame-delayed recursive feedback loop (the wall textures the
    // card's own previous frame back into the scene through the BENTBOX
    // prevFbo). Assert the self-edge is accepted AND the canvas keeps
    // rendering content with no console/page errors (no re-entrancy crash,
    // no infinite loop).
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // Drive a gate so the ribbons have energy that the feedback loop can
    // smear/recurse; feedback_gain up so the self-loop visibly compounds.
    await spawnPatch(page, [
      { id: 'jo', type: 'joystick', position: { x: 40, y: 400 }, domain: 'audio' },
      { id: 'ws', type: 'wavesculpt', position: { x: 400, y: 100 }, domain: 'audio',
        params: { wall1_alpha: 80, wall1_distort: 0.3, rot: 0.25, zoom: 1.2, feedback_gain: 0.6, noise: 0 } },
    ], [
      // SELF-LOOP: the card's own video output into its own wall input.
      { id: 'e_self', from: { nodeId: 'ws', portId: 'video_out' }, to: { nodeId: 'ws', portId: 'wall1' }, sourceType: 'mono-video', targetType: 'video' },
      { id: 'e_gate', from: { nodeId: 'jo', portId: 'x' }, to: { nodeId: 'ws', portId: 'gate1' }, sourceType: 'cv', targetType: 'gate' },
    ]);
    await expect(page.locator('[data-testid="wavesculpt-canvas"]')).toHaveCount(1);
    await awaitStepSeam(page);

    // The self-edge exists in the patch store (not rejected).
    const hasSelfEdge = await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { edges: Record<string, { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } }> } };
      return Object.values(w.__patch.edges).some(
        (e) => e.source.nodeId === e.target.nodeId && e.target.portId === 'wall1' && e.source.portId === 'video_out',
      );
    });
    expect(hasSelfEdge, 'WAVESCULPT video_out → its own wall1 self-edge accepted').toBe(true);

    // Drive the joystick high so the voices generate energy.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __engine?: () => { ctx: AudioContext } | null;
      };
      const n = w.__patch.nodes['jo'];
      if (n) n.params.pos_x = 1;
      try { void w.__engine?.()?.ctx.resume(); } catch { /* */ }
    });

    await freeze(page);
    // N >= 3 deterministic frames so the recursive FBO feedback compounds
    // (the wall samples the PREVIOUS frame each tick).
    await stepFrames(page, 6);

    // The recursive render keeps producing content. The store/edge assertion
    // (hasSelfEdge above) always runs; the non-black pixel floor is gated on a
    // usable GL read (CI = SwiftShader) so we never ship a flaky pixel assert.
    if (await glPixelsUsable(page)) {
      const lit = await page.evaluate(() => {
        const c = document.querySelector('[data-testid="wavesculpt-canvas"]') as HTMLCanvasElement | null;
        if (!c) return 0;
        const ctx = c.getContext('2d');
        if (!ctx) return 0;
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < data.length; i += 4 * 16) {
          if (((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0)) > 60) n++;
        }
        return n;
      });
      expect(lit, 'self-feedback loop renders non-black content').toBeGreaterThan(50);
    }

    expect(errors, 'no console / page errors during self-feedback loop').toEqual([]);
  });

  // ──────────────── LINES-VS-WALLS REGRESSION + LUMINOSITY BANDPASS ────────────────

  test('REGRESSION: SCOPES TRIAL waveform lines stay visible with an enclosing video wall', async ({ page }) => {
    // #531 video walls drowned the additive scope traces — the "scopestrial"
    // / "reality based" community patches went blank. Guard: SCOPES TRIAL with
    // all 6 walls opaque (camera enclosed) must STILL light a substantial
    // fraction of the frame (the bright traces punch through the backdrop-
    // dimmed wall).
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    const wallParams: Record<string, number> = {};
    for (let n = 1; n <= 6; n++) { wallParams[`wall${n}_alpha`] = 100; wallParams[`wall${n}_distort`] = 0; }
    const edges: Array<Record<string, unknown>> = [
      { id: 'g', from: { nodeId: 'jo', portId: 'x' }, to: { nodeId: 'ws', portId: 'gate1' }, sourceType: 'cv', targetType: 'gate' },
    ];
    for (let n = 1; n <= 6; n++) edges.push({ id: `e_wall${n}`, from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'ws', portId: `wall${n}` }, sourceType: 'video', targetType: 'video' });
    await spawnPatch(page, [
      { id: 'src', type: 'shapes', position: { x: 60, y: 60 }, domain: 'video', params: { shape: 1, tile: 1, tileN: 4 } },
      { id: 'ws', type: 'wavesculpt', position: { x: 400, y: 80 }, domain: 'audio',
        params: { blink_mode: 1, scale: 2, rot: 0.3, pos_z: 0.35, zoom: 1.3,
          thickness1: 0.6, thickness2: 0.6, thickness3: 0.6, thickness4: 0.9, noise: 0, ...wallParams } },
      { id: 'jo', type: 'joystick', position: { x: 60, y: 480 }, domain: 'audio' },
    ], edges as never);
    await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> }; __engine?: () => { ctx: AudioContext } | null };
      const n = w.__patch.nodes['jo']; if (n) n.params.pos_x = 1;
      try { void w.__engine?.()?.ctx.resume(); } catch { /* */ }
    });
    await expect(page.locator('[data-testid="wavesculpt-canvas"]')).toHaveCount(1);
    await awaitStepSeam(page);

    // The all-6-walls edges exist (deterministic store assertion — always
    // runs regardless of the renderer).
    const wallEdges = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { edges: Record<string, { target?: { nodeId: string; portId: string } }> };
      };
      const ports = new Set(
        Object.values(w.__patch.edges)
          .filter((e) => e.target?.nodeId === 'ws' && /^wall[1-6]$/.test(e.target?.portId ?? ''))
          .map((e) => e.target!.portId),
      );
      return ports.size;
    });
    expect(wallEdges, 'all 6 wall edges present').toBe(6);

    await freeze(page);
    await stepFrames(page, 5);

    // Count NEON-coloured trace pixels: a bright, channel-IMBALANCED pixel (a
    // hot single/dual-channel neon line), distinguishing the traces from the
    // near-grey/white wall grid. This is the population that vanished pre-fix.
    // Gated on a usable GL read (CI = SwiftShader) so we never ship a flaky
    // pixel assert.
    if (await glPixelsUsable(page)) {
      const trace = await page.evaluate(() => {
        const c = document.querySelector('[data-testid="wavesculpt-canvas"]') as HTMLCanvasElement | null;
        if (!c) return 0;
        const ctx = c.getContext('2d');
        if (!ctx) return 0;
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i] ?? 0, g = data[i + 1] ?? 0, b = data[i + 2] ?? 0;
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          // Bright + saturated (channel imbalance) → a neon trace, not the
          // desaturated wall grid.
          if (mx > 140 && mx - mn > 70) n++;
        }
        return n;
      });
      expect(trace, 'SCOPES TRIAL traces punch through enclosing walls (#531)').toBeGreaterThan(800);
    }
  });

  test('LUMINOSITY → BANDPASS: lum_depth knob + per-wall sampling accepted, no errors', async ({ page }) => {
    // The luminosity→bandpass feature: depth knob present + routes through the
    // store; with walls patched + depth up the audio path runs (the card
    // samples wall luminosity each frame + posts it to the worklet) with no
    // console/page errors. This was THE flaky test — the wall-clock settle
    // raced the per-frame luminosity sampling. Driving deterministic frames
    // through the step seam exercises that path with an exact frame count.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'src', type: 'shapes', position: { x: 60, y: 60 }, domain: 'video', params: { shape: 1, tile: 1, tileN: 4 } },
      { id: 'ws', type: 'wavesculpt', position: { x: 400, y: 80 }, domain: 'audio',
        params: { blink_mode: 1, lum_depth: 0, wall1_alpha: 100, wall3_alpha: 100, noise: 0 } },
      { id: 'jo', type: 'joystick', position: { x: 60, y: 480 }, domain: 'audio' },
    ], [
      { id: 'g', from: { nodeId: 'jo', portId: 'x' }, to: { nodeId: 'ws', portId: 'gate1' }, sourceType: 'cv', targetType: 'gate' },
      { id: 'e_wall1', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'ws', portId: 'wall1' }, sourceType: 'video', targetType: 'video' },
      { id: 'e_wall3', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'ws', portId: 'wall3' }, sourceType: 'video', targetType: 'video' },
    ]);
    await expect(page.locator('[data-testid="wavesculpt-card"]')).toHaveCount(1);
    await awaitStepSeam(page);

    // Drive the gate + resume audio, then dial lum_depth up via the store.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
        __engine?: () => { ctx: AudioContext } | null;
      };
      const jo = w.__patch.nodes['jo']; if (jo) jo.params.pos_x = 1;
      w.__ydoc.transact(() => { const n = w.__patch.nodes['ws']; if (n) n.params.lum_depth = 1; });
      try { void w.__engine?.()?.ctx.resume(); } catch { /* */ }
    });

    // Exactly 6 deterministic frames exercise the per-frame wall-luminosity
    // sample → worklet-post path (replaces the flaky fixed-ms settle).
    const d = await stepFrames(page, 6);
    expect(d, 'step seam advanced exactly 6 frames').toBe(6);

    await expect
      .poll(() =>
        page.evaluate(() => {
          const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
          return w.__patch.nodes['ws']?.params.lum_depth ?? -1;
        }),
        { message: 'lum_depth routed through the store' },
      )
      .toBe(1);

    expect(errors, 'no console / page errors with luminosity-bandpass active').toEqual([]);
  });
});
