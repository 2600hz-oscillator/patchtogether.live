// e2e/tests/hydrogen-kits.spec.ts
//
// HYDROGEN multi-kit E2E:
//   1. Module spawns with the default kit (TR-808) shown in the header.
//   2. Clicking the kit-toggle button cycles through all 8 kits and
//      wraps back to TR-808.
//   3. Each synth kit produces non-zero audio output when the pattern
//      grid is triggered — proves the synth voice factories actually
//      build voices that reach the per-instrument bus → master mix.
//   4. Per-instrument tuning (vol/pan/etc) persists across a kit swap
//      (matches a hardware drum machine where slot N's volume stays).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const KIT_NAMES = [
  'TR-808',
  'TR-909',
  'FM-PERC',
  '8BIT',
  'CR-78',
  'LINN',
  'GLITCH',
  'HARDCORE',
] as const;

async function spawnHydrogen(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'h', type: 'hydrogen', position: { x: 200, y: 200 } },
  ]);
  await expect(page.locator('[data-testid="hydrogen-card"]')).toBeVisible();
}

async function readKitParam(page: Page, nodeId: string): Promise<number> {
  // Patch-graph stores ONLY explicitly-set params — fresh spawn omits `kit`
  // and the engine reads the default (0 = TR-808). Treat missing as 0 so
  // assertions match the user-visible semantic.
  return await page.evaluate((nid) => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
    const v = w.__patch.nodes[nid]?.params?.kit;
    return typeof v === 'number' ? v : 0;
  }, nodeId);
}

async function clickKitToggle(page: Page): Promise<void> {
  await page.locator('[data-testid="hydrogen-kit-toggle"]').click();
}

test.describe('HYDROGEN: kit-toggle cycles all 8 kits and wraps', () => {
  test('default kit is TR-808 and clicking cycles through every kit before wrapping back to TR-808', async ({ page }) => {
    await spawnHydrogen(page);

    const btn = page.locator('[data-testid="hydrogen-kit-toggle"]');
    await expect(btn).toHaveText('TR-808');
    expect(await readKitParam(page, 'h')).toBe(0);

    for (let i = 0; i < KIT_NAMES.length; i++) {
      const next = KIT_NAMES[(i + 1) % KIT_NAMES.length]!;
      await clickKitToggle(page);
      await expect(btn, `step ${i}: button should show ${next}`).toHaveText(next);
      const expectedKitParam = (i + 1) % KIT_NAMES.length;
      expect(await readKitParam(page, 'h'), `step ${i}: param`).toBe(expectedKitParam);
    }
  });
});

test.describe('HYDROGEN: per-instrument tuning persists across kit swap', () => {
  test('changing vol5 + then cycling the kit keeps vol5 at the new value', async ({ page }) => {
    await spawnHydrogen(page);

    // Tweak vol5 to a non-default value.
    await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
      w.__patch.nodes.h!.params.vol5 = 1.75;
    });

    // Cycle to TR-909.
    await clickKitToggle(page);
    await expect(page.locator('[data-testid="hydrogen-kit-toggle"]')).toHaveText('TR-909');

    // vol5 should still be the user-set value, not the kit's default.
    const vol5 = await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
      return w.__patch.nodes.h!.params.vol5;
    });
    expect(vol5).toBeCloseTo(1.75, 3);
  });
});

test.describe('HYDROGEN: every synth kit produces audio on trigger', () => {
  for (const kitName of ['TR-909', 'FM-PERC', '8BIT', 'CR-78', 'LINN', 'GLITCH', 'HARDCORE'] as const) {
    test(`${kitName}: triggering instrument 0 produces non-zero audio at master out`, async ({ page }) => {
      // Spawn HYDROGEN + a SCOPE so we can tap audio_out via the engine.
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await spawnPatch(
        page,
        [
          { id: 'h',  type: 'hydrogen', position: { x: 200, y: 100 }, domain: 'audio' },
          { id: 'sc', type: 'scope',    position: { x: 700, y: 100 }, domain: 'audio' },
        ],
        [
          {
            id: 'e_h_sc',
            from: { nodeId: 'h',  portId: 'out_l' },
            to:   { nodeId: 'sc', portId: 'ch1' },
            sourceType: 'audio',
            targetType: 'audio',
          },
        ],
      );

      // Cycle to the target kit. (Start at TR-808 = index 0.)
      const kitIndex = KIT_NAMES.indexOf(kitName);
      for (let i = 0; i < kitIndex; i++) await clickKitToggle(page);
      await expect(page.locator('[data-testid="hydrogen-kit-toggle"]')).toHaveText(kitName);

      // Trigger instrument 0 directly via the engine's trig port. This
      // bypasses the pattern grid + scheduler and proves the synth fn
      // actually produces signal that reaches the per-instrument bus.
      // We sample the SCOPE input over ~800 ms and assert RMS > 0.
      const rms = await page.evaluate(async () => {
        const w = globalThis as unknown as {
          __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
          __patch: { nodes: Record<string, { id: string; type: string; domain: string; params: Record<string, number> }> };
        };
        const eng = w.__engine?.();
        if (!eng) return -1;
        const hyd = w.__patch.nodes.h;
        if (!hyd) return -1;
        // Toggle isPlaying so the scheduler ticks the (empty) pattern;
        // we'll fire instrument 0 directly so the pattern grid doesn't
        // matter. The factory's tick still runs so trigInputs poll.
        hyd.params.isPlaying = 1;
        // Drive the underlying scheduler by setting a cell on inst 0 step 0.
        const t = w.__patch.nodes.h as unknown as { data?: Record<string, unknown> };
        if (!t.data) t.data = {};
        const tracks = Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => ({ on: false })));
        tracks[0]![0]!.on = true;
        tracks[0]![4]!.on = true;
        tracks[0]![8]!.on = true;
        tracks[0]![12]!.on = true;
        (t.data as Record<string, unknown>).tracks = tracks;
        // Wait ~800ms for the scheduler to fire 4 voices.
        await new Promise((r) => setTimeout(r, 800));
        // Sample the scope's analyser snapshot — ch1 is a Float32Array
        // mirroring the LIVE master-out signal post-cable. RMS > 0 proves
        // the synth voices actually reached the bus.
        const sc = w.__patch.nodes.sc;
        if (!sc) return -2;
        const snap = eng.read(sc, 'snapshot') as { ch1?: Float32Array } | null;
        if (!snap || !snap.ch1) return -3;
        const arr = snap.ch1;
        let sumSq = 0;
        for (let i = 0; i < arr.length; i++) sumSq += arr[i]! * arr[i]!;
        return Math.sqrt(sumSq / Math.max(1, arr.length));
      });

      expect(rms, `${kitName}: master-out RMS over 800ms = ${rms}`).toBeGreaterThan(0.001);
    });
  }
});
