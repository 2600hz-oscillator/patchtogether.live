// e2e/tests/mobile-synth.spec.ts
//
// POCKET MODULAR (/m/synth) — the real-chain audibility spec (spec §7).
//
// FIRST BLEEP must produce AUDIBLE RMS at AUDIO OUT's TERMINAL tap through
// the REAL chain (sequencer → vco → adsr/vca → delay → mixmstrs → audioOut)
// — the real-source-chain doctrine; DOM presence does NOT count. Then one
// matrix patch (add reverb, fan delay.audio into it) must not kill the
// audio, a MIX mute must drop the lane's post-fader level, and UNDO must
// restore it.
//
// Mobile emulation is per-spec (MOBILE_USE) — never a new Playwright
// project. Runs on desktop-Chromium CI, so the crossOriginIsolated assert
// is valid here (iOS runs un-isolated; nothing in the app assumes SAB).

import { test, expect } from '@playwright/test';
import { MOBILE_USE, dragSliderBy, edgeCount, readMixLevels, readOutputRms } from './_mobile-helpers';

test.use(MOBILE_USE);

// Audibility floor at the terminal tap. The template's saw→vca(env)→delay
// line meters well above this; 0 (silent chain) fails it.
const AUDIBLE_RMS = 0.01;

test.describe('pocket modular — FIRST BLEEP real chain', () => {
  test('boots, bleeps audibly, patches via the matrix, mutes + undoes', async ({ page }) => {
    // Engine boot + Faust worklet fetches on a cold server take a while.
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    const resp = await page.goto('/m/synth');
    expect(resp?.status()).toBe(200);
    await page.waitForLoadState('networkidle');

    // Isolation headers reached the route (ISOLATED_EXACT parity with /rack).
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

    // The desktop canvas must NOT be mounted on the mobile route.
    await expect(page.getByTestId('canvas-root')).toHaveCount(0);

    // ── FIRST BLEEP: one tap = gesture + engine boot + template spawn ──
    await expect(page.getByTestId('m-first-bleep')).toBeVisible();
    await page.getByTestId('m-first-bleep').tap();
    await expect(page.getByTestId('m-tabbar')).toBeVisible({ timeout: 15_000 });
    // The RACK pager lands on a card (the chip strip is populated).
    await expect(page.getByTestId('m-chip-sequencer')).toBeVisible();

    // ── AUDIBLE RMS through the REAL chain at the terminal tap ──
    await expect
      .poll(() => readOutputRms(page), {
        timeout: 60_000,
        message: 'FIRST BLEEP produces audible RMS at AUDIO OUT',
      })
      .toBeGreaterThan(AUDIBLE_RMS);

    // ── One matrix action: add a reverb, fan delay.audio into it ──
    const edgesBefore = await edgeCount(page);
    await page.getByTestId('m-add-fab').tap();
    await expect(page.getByTestId('m-add-sheet')).toBeVisible();
    await page.getByTestId('m-add-reverb').tap();
    await expect(page.getByTestId('m-pager-title')).toHaveText('reverb');

    await page.getByTestId('m-tab-patch').tap();
    await expect(page.getByTestId('m-patch-tab')).toBeVisible();
    // FROM = delay (picker sheet), TO = reverb.
    await page.getByTestId('m-rail-from').tap();
    await page.getByTestId('m-pick-delay').tap();
    await page.getByTestId('m-rail-to').tap();
    await page.getByTestId('m-pick-reverb').tap();
    // delay.audio already feeds mixmstrs → this cell is outputFanout →
    // tap patches immediately (non-destructive), no confirm.
    const cell = page.getByTestId('m-cell-audio-audio');
    await expect(cell).toBeVisible();
    await expect(cell).toHaveAttribute('data-kind', 'outputFanout');
    await cell.tap();
    await expect.poll(() => edgeCount(page)).toBe(edgesBefore + 1);

    // The original chain survived the fanout patch — still audible.
    await expect
      .poll(() => readOutputRms(page), { timeout: 15_000, message: 'RMS persists after the patch' })
      .toBeGreaterThan(AUDIBLE_RMS);

    // ── MIX: mute ch1 → post-fader lane level collapses ──
    await page.getByTestId('m-tab-mix').tap();
    await expect(page.getByTestId('m-mix-lane-1')).toBeVisible();
    await expect
      .poll(async () => (await readMixLevels(page))[0] ?? 0, {
        timeout: 15_000,
        message: 'ch1 meters before the mute',
      })
      .toBeGreaterThan(0.005);

    // Capture-boundary: the UndoManager's captureTimeout (500ms) collapses
    // edit BURSTS into one undo unit by design — and Playwright chains taps
    // faster than any human, so without an explicit boundary the mute can
    // merge into the previous edits' unit and UNDO would revert far more
    // than the mute (verified against a live probe). stopCapturing() is the
    // documented Yjs seam for delimiting units; a human's tap cadence
    // (>500ms) gets the same boundary implicitly.
    await page.evaluate(() =>
      (
        globalThis as { __undoManager?: { stopCapturing: () => void } }
      ).__undoManager?.stopCapturing(),
    );
    await page.getByTestId('m-mix-mute-1').tap();
    await expect(page.getByTestId('m-mix-mute-1')).toHaveAttribute('data-muted', 'true');
    await expect
      .poll(async () => (await readMixLevels(page))[0] ?? 0, {
        timeout: 15_000,
        message: 'ch1 post-fader level collapses when muted',
      })
      .toBeLessThan(0.002);

    // ── UNDO restores the lane ──
    await page.getByTestId('m-undo').tap();
    await expect(page.getByTestId('m-mix-mute-1')).toHaveAttribute('data-muted', 'false');
    await expect
      .poll(async () => (await readMixLevels(page))[0] ?? 0, {
        timeout: 15_000,
        message: 'undo restores the ch1 level',
      })
      .toBeGreaterThan(0.005);

    // ── A mobile fader drag writes through drag-commit (no crash, value moves) ──
    const volBefore = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { type: string; params: Record<string, number> } | undefined> };
      };
      const mx = Object.values(w.__patch?.nodes ?? {}).find((n) => n?.type === 'mixmstrs');
      return mx?.params.ch1_volume ?? 0.8;
    });
    await dragSliderBy(page, '[data-testid="m-mix-fader-1"]', -0.3);
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const w = globalThis as unknown as {
            __patch?: {
              nodes: Record<string, { type: string; params: Record<string, number> } | undefined>;
            };
          };
          const mx = Object.values(w.__patch?.nodes ?? {}).find((n) => n?.type === 'mixmstrs');
          return mx?.params.ch1_volume ?? -1;
        }),
      )
      .toBeLessThan(volBefore - 0.05);

    expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
  });
});
