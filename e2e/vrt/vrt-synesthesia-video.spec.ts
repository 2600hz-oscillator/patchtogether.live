// e2e/vrt/vrt-synesthesia-video.spec.ts
//
// VRT for SYNESTHESIA's VIDEO mode: copy A switched to VIDEO, driven with a
// SOLID RED frame so the R channel meter redlines (and the L/luma meter reads
// the BT.601 luma of red, ≈0.30). Copy B stays in AUDIO mode (dark) — proving
// the per-block mode badge + the R/G/B/L relabel render distinctly.
//
// Determinism: rather than depend on a live, animating video source's pixels
// (which fluctuate frame to frame), we push a FIXED [R,G,B,Luma] level through
// the same engine.write() path the card uses, simulating a steady solid-colour
// source. The VU ballistics settle to that level; we then suspend the
// AudioContext so the worklet stops posting + the meters hold → pixel-stable.
//
// Informational lane (`task vrt`, FULL_MATCH) — not the strict gate. Darwin
// baseline captured locally; linux pending a `task vrt:update` on CI.
//
// Output: e2e/vrt/__screenshots__/vrt-synesthesia-video.spec.ts/{platform}/<id>.png

import { test, expect } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';

test.describe.configure({ mode: 'default' });

test.describe('VRT: SYNESTHESIA video mode', () => {
  test('copy-A solid-red levels redline the R meter', async ({ page }) => {
    test.skip(VRT_PLATFORM === 'linux', 'darwin baseline only; linux pending a vrt:update on CI');

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
        // Copy A in VIDEO mode (the badge reads VIDEO + columns relabel R/G/B/L);
        // copy B stays AUDIO (badge reads AUDIO + columns read 0–200 / … / 2k+).
        { id: 'syn', type: 'synesthesia', position: { x: 80, y: 40 }, domain: 'audio',
          params: { a_mode: 1, b_mode: 0 } },
      ],
      [],
    );

    const synCard = page.locator('.svelte-flow__node-synesthesia').first();
    await synCard.waitFor({ state: 'visible', timeout: 10_000 });

    // Push a steady SOLID RED level into copy A repeatedly while the meter
    // ballistics climb. No video source is patched, so the card's frame reader
    // is a no-op and our injected levels persist into the worklet.
    const pushRed = async (): Promise<void> => {
      await page.evaluate(() => {
        const w = globalThis as unknown as {
          __engine?: () => { write?: (n: unknown, k: string, v: unknown) => void } | null;
          __patch: { nodes: Record<string, unknown> };
        };
        const eng = w.__engine?.();
        const node = w.__patch.nodes['syn'];
        // Solid red: R=1, G=B=0, luma = 0.299 (BT.601).
        eng?.write?.(node, 'video_levels_a', [1, 0, 0, 0.299]);
      });
    };
    for (let i = 0; i < 20; i++) {
      await pushRed();
      await page.waitForTimeout(40);
    }

    // Freeze: suspend the AudioContext so the worklet stops posting snapshots +
    // the meters hold their settled levels → pixel-stable.
    await page.evaluate(async () => {
      const w = globalThis as unknown as { __engine?: () => { ctx: AudioContext } | null };
      const eng = w.__engine?.();
      if (eng) { try { await eng.ctx.suspend(); } catch { /* already suspended */ } }
    });
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

    await expect(synCard).toHaveScreenshot('copy-a-solid-red.png', {
      maskColor: '#ff00ff',
    });

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors',
    ).toEqual([]);
  });
});
