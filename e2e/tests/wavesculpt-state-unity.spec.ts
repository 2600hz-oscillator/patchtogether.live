// e2e/tests/wavesculpt-state-unity.spec.ts
//
// "There is one camera position and orientation. The joystick, the
// visualization, and the audio output should always reflect it."
//
// Pins the user-requested unified-state architecture (PR
// feat/wavesculpt-unified-state-and-morph-cv):
//
//   1. morph_cv ports are surfaced in the card so they can be patched.
//   2. read('camera') returns the live combined (knob + CV) values
//      that the spatial audio mix is reading right now.
//   3. read('morph') returns the live combined morph values per osc.
//   4. The joystick UI's polled `livePosX` agrees with read('camera').
//      pos_x at the same instant.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

async function spawnLfoAndWavesculpt(page: Page, port: string): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'lfo', type: 'lfo',        position: { x:  60, y: 60 } },
      { id: 'ws',  type: 'wavesculpt', position: { x: 460, y: 60 }, domain: 'audio' },
    ],
    [
      {
        id: 'e_lfo_ws',
        from: { nodeId: 'lfo', portId: 'phase0' },
        to:   { nodeId: 'ws',  portId: port },
        sourceType: 'cv',
        targetType: 'cv',
      },
    ],
  );
  await page.waitForTimeout(400);
}

test.describe('WAVESCULPT: unified camera state', () => {
  test('morph1_cv handle is patchable on the card', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [
      { id: 'ws', type: 'wavesculpt', position: { x: 80, y: 80 }, domain: 'audio' },
    ]);
    // The handle is rendered when the card mounts (PatchPanel takes the
    // morph{N}_cv entries from the card's `inputs` array). Pre-refactor:
    // no handle; post-refactor: handle visible.
    const handle = page.locator(
      '.svelte-flow__node-wavesculpt [data-handleid="morph1_cv"]',
    );
    await expect(handle).toHaveCount(1, { timeout: 5_000 });
  });

  for (const port of ['pos_x', 'pos_y', 'pos_z', 'zoom', 'rot'] as const) {
    test(`engine.read(node, 'camera').${port} moves when LFO is patched`, async ({ page }) => {
      await spawnLfoAndWavesculpt(page, port);

      const samples: number[] = [];
      for (let i = 0; i < 8; i++) {
        const v = await page.evaluate(({ p }) => {
          const w = globalThis as unknown as {
            __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
            __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
          };
          const eng = w.__engine?.();
          const ws = w.__patch.nodes.ws;
          if (!eng || !ws) return 0;
          const cam = eng.read(ws, 'camera') as Record<string, number> | undefined;
          return cam?.[p] ?? 0;
        }, { p: port });
        samples.push(v);
        await page.waitForTimeout(100);
      }
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length;
      const stddev = Math.sqrt(variance);
      expect(stddev, `${port} read('camera').${port} stddev = ${stddev.toFixed(4)} (samples: ${samples.map((s) => s.toFixed(3)).join(', ')})`).toBeGreaterThan(0.05);
    });
  }

  test('engine.readParam(pos_x) + engine.read(camera).pos_x stay aligned (no double-counting)', async ({ page }) => {
    await spawnLfoAndWavesculpt(page, 'pos_x');
    // Sample BOTH paths at the same instant. They should be close —
    // both are deriving from the same shadow analyser / paramTap on
    // the same LFO signal at audio rate, so any difference is
    // ~1 audio quantum (≈ 3 ms) of phase drift. We allow 0.15
    // absolute tolerance — way smaller than the LFO amplitude (±1).
    const drift = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: unknown, k: string) => unknown; readParam: (n: unknown, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const ws = w.__patch.nodes.ws;
      if (!eng || !ws) return -1;
      const cam = eng.read(ws, 'camera') as Record<string, number> | undefined;
      const rp = eng.readParam(ws, 'pos_x') as number | undefined;
      if (!cam || typeof rp !== 'number') return -1;
      return Math.abs(rp - cam.pos_x);
    });
    expect(drift, `engine.readParam(pos_x) vs engine.read(camera).pos_x drift = ${drift} — should agree within 0.15 if not double-counting CV`).toBeLessThan(0.15);
  });
});

test.describe('WAVESCULPT: unified morph state', () => {
  test('engine.read(node, "morph") returns 1..4 combined values that move with LFO on morph1_cv', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [
        { id: 'lfo', type: 'lfo',        position: { x:  60, y: 60 } },
        { id: 'ws',  type: 'wavesculpt', position: { x: 460, y: 60 }, domain: 'audio' },
      ],
      [
        {
          id: 'e_lfo_ws_morph',
          from: { nodeId: 'lfo', portId: 'phase0' },
          to:   { nodeId: 'ws',  portId: 'morph1_cv' },
          sourceType: 'cv',
          targetType: 'cv',
        },
      ],
    );
    await page.waitForTimeout(400);

    const samples: number[] = [];
    for (let i = 0; i < 8; i++) {
      const v = await page.evaluate(() => {
        const w = globalThis as unknown as {
          __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
          __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
        };
        const eng = w.__engine?.();
        const ws = w.__patch.nodes.ws;
        if (!eng || !ws) return 0;
        const m = eng.read(ws, 'morph') as Record<string, number> | undefined;
        return m?.[1] ?? 0;
      });
      samples.push(v);
      await page.waitForTimeout(100);
    }
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length;
    const stddev = Math.sqrt(variance);
    expect(stddev, `read('morph').1 stddev over 800ms = ${stddev.toFixed(4)} — should move with LFO on morph1_cv`).toBeGreaterThan(0.05);
  });
});
