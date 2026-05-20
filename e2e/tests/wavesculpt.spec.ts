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

    await page.waitForTimeout(800);

    const hasNonBlackPixels = await page.evaluate(() => {
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
    expect(hasNonBlackPixels, 'ribbons visible without any gate fired').toBe(true);
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

    async function sampleScreenSignature(): Promise<number[]> {
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

    function l1Diff(a: number[], b: number[]): number {
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
      return sum;
    }

    await setMorphAll(0);
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
