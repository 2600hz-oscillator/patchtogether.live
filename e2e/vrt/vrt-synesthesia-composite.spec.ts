// e2e/vrt/vrt-synesthesia-composite.spec.ts
//
// Composite-state VRT for SYNESTHESIA: a whole-patch screenshot showing the
// SCOPE trace of the source frequency next to SYNESTHESIA's band response —
// proving they're driven by the same signal (the user's "see the SCOPE
// frequency directly connected" requirement).
//
// Patch:  analogVco (261 Hz / C4) → vca (base=1, continuous) → SCOPE.ch1
//                                                            └→ SYNESTHESIA.a_in
// Copy A band 2 (200–500 Hz) lights; SCOPE shows the sine. The VCA is a
// continuous pass-through (base=1) so the meter holds a steady level; we then
// freeze the AudioContext so the trace + meter are pixel-stable across runs.
//
// Informational lane (`task vrt`, FULL_MATCH) — not the strict gate. Darwin
// baseline captured locally; linux pending a `task vrt:update` on CI.
//
// Output: e2e/vrt/__screenshots__/vrt-synesthesia-composite.spec.ts/{platform}/<id>.png

import { test, expect } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';

test.describe.configure({ mode: 'default' });

test.describe('VRT: SYNESTHESIA composite', () => {
  test('vco-261-band2 matches baseline', async ({ page }) => {
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
        // All four modules positioned to fit the pinned 1280×720 viewport so
        // the screenshot frames the whole signal path.
        { id: 'vco', type: 'analogVco', position: { x: 20, y: 430 }, domain: 'audio', params: { tune: 0 } },
        { id: 'vca', type: 'vca', position: { x: 280, y: 430 }, domain: 'audio', params: { base: 1, cvAmount: 0 } },
        { id: 'sc', type: 'scope', position: { x: 40, y: 30 }, domain: 'audio' },
        { id: 'syn', type: 'synesthesia', position: { x: 470, y: 30 }, domain: 'audio' },
      ],
      [
        { id: 'e_vco_vca', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'vca', portId: 'audio' }, sourceType: 'audio', targetType: 'audio' },
        { id: 'e_vca_sc', from: { nodeId: 'vca', portId: 'audio' }, to: { nodeId: 'sc', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
        { id: 'e_vca_syn', from: { nodeId: 'vca', portId: 'audio' }, to: { nodeId: 'syn', portId: 'a_in' }, sourceType: 'audio', targetType: 'audio' },
      ],
    );

    const synCard = page.locator('.svelte-flow__node-synesthesia').first();
    const scopeCard = page.locator('.svelte-flow__node-scope').first();
    await synCard.waitFor({ state: 'visible', timeout: 10_000 });
    await scopeCard.waitFor({ state: 'visible', timeout: 10_000 });

    // Settle: VU meter ballistics climb to the steady band-2 level + SCOPE's
    // analyser fills. Then freeze the AudioContext so the worklet stops
    // posting + the trace holds → pixel-stable.
    await page.waitForTimeout(800);
    await page.evaluate(async () => {
      const w = globalThis as unknown as { __engine?: () => { ctx: AudioContext } | null };
      const eng = w.__engine?.();
      if (eng) {
        try { await eng.ctx.suspend(); } catch { /* already suspended */ }
      }
    });
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

    await expect(page).toHaveScreenshot('vco-261-band2.png', {
      maskColor: '#ff00ff',
      fullPage: false,
    });

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors',
    ).toEqual([]);
  });
});
