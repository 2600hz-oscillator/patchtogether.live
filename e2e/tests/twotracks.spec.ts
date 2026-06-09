// e2e/tests/twotracks.spec.ts
//
// TWOTRACKS end-to-end coverage (Phase 1 + Phase 2 + Phase 3 + Phase 4).
//
// Phase 1 tests:
//   1. Module spawns with no console errors — card renders with correct
//      data-testid elements, LEDs and mode toggle visible.
//   2. Wire OSCILLATOR → twotracks → SCOPE: module is wired and alive.
//   3. Mode toggle: clicking the mode-toggle button changes the label.
//   4. Overdub toggle: button toggles the OVERDUB LED active state.
//   5. Decay slider: moving the decay input changes the displayed value.
//
// Phase 2 tests:
//   6. Reel B card elements exist (mirror of reel A structure).
//   7. A/B knob strip visible with both reel labels.
//   8. A/B law: at ab=0 gainA=100% gainB=0%; at ab=1 gainA=0% gainB=100%.
//   9. Both reels independently record/play.
//
// Phase 3 tests:
//   10. Lofi strip visible and cycles through OFF/LOW/HIGH/ERROR.
//   11. Lofi ERROR button shows active/error highlight.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { runFor } from './_module-coverage-helpers';

// xyflow keeps the node wrapper visibility:hidden until ResizeObserver fires.
// On CI's production preview bundle TwotracksCard (580px wide, complex layout
// with dual-reel structure + RAF waveform polling) can take longer than
// Playwright's default 5s — wait explicitly before making visibility assertions.
const CARD_VISIBLE_MS = 15_000;

async function waitForCard(page: Page) {
  await page.locator('[data-testid="twotracks-card"]').waitFor({
    state: 'visible',
    timeout: CARD_VISIBLE_MS,
  });
}

async function setupPage(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return errors;
}

test.describe('TWOTRACKS module', () => {
  // ═══════════════════════════ Phase 1 ═══════════════════════════

  test('spawns with no console errors and card elements visible', async ({ page }) => {
    const errors = await setupPage(page);

    await spawnPatch(page, [
      { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
    ]);
    await waitForCard(page);

    const card = page.locator('[data-testid="twotracks-card"]');
    await expect(card).toBeVisible();

    // Card should have correct label (TWOTRACKS).
    await expect(card).toContainText('TWOTRACKS');

    // Reel A block present.
    await expect(card.locator('[data-testid="twotracks-reel-a"]')).toBeVisible();

    // Reel A waveform canvas present.
    await expect(card.locator('[data-testid="twotracks-waveform"]')).toHaveCount(1);

    // LED elements present.
    await expect(card.locator('[data-testid="led-arm"]')).toBeVisible();
    await expect(card.locator('[data-testid="led-rec"]')).toBeVisible();
    await expect(card.locator('[data-testid="led-play"]')).toBeVisible();
    await expect(card.locator('[data-testid="led-overdub"]')).toBeVisible();

    // Mode toggle present.
    await expect(card.locator('[data-testid="twotracks-mode-toggle"]')).toBeVisible();

    // Overdub toggle present.
    await expect(card.locator('[data-testid="twotracks-overdub-toggle"]')).toBeVisible();

    // Decay slider present.
    await expect(card.locator('[data-testid="twotracks-decay"]')).toBeVisible();

    // Save button present.
    await expect(card.locator('[data-testid="twotracks-save"]')).toBeVisible();

    // No console errors on spawn.
    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('wires OSCILLATOR → twotracks → SCOPE and asserts module is alive', async ({ page }) => {
    const errors = await setupPage(page);

    await spawnPatch(page, [
      { id: 'vco',   type: 'analogVco',  position: { x: 50,  y: 200 }, params: { freq: 440, level: 1 } },
      { id: 'tt',    type: 'twotracks',  position: { x: 300, y: 200 } },
      { id: 'scope', type: 'scope',      position: { x: 550, y: 200 } },
    ], [
      { id: 'e1', from: { nodeId: 'vco', portId: 'saw' }, to: { nodeId: 'tt', portId: 'audio_l_in_a' } },
      { id: 'e2', from: { nodeId: 'tt', portId: 'out_l' }, to: { nodeId: 'scope', portId: 'ch1' } },
    ]);
    await waitForCard(page);

    await runFor(page, 600);

    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __ydoc: { transact: (fn: () => void) => void };
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      w.__ydoc.transact(() => {
        const tt = w.__patch.nodes['tt'];
        if (tt) {
          tt.params['rate_a'] = 1;
          tt.params['mode_a'] = 1;
        }
      });
    });

    await runFor(page, 400);

    const scopeCard = page.locator('.svelte-flow__node-scope');
    await expect(scopeCard).toBeVisible();

    const twoTracksCard = page.locator('[data-testid="twotracks-card"]');
    await expect(twoTracksCard).toBeVisible();

    const filtered = errors.filter((e) => !e.includes('ResizeObserver') && !e.includes('vite'));
    expect(filtered, filtered.join('; ')).toEqual([]);
  });

  test('mode toggle alternates between "tape" and "loop tape"', async ({ page }) => {
    await setupPage(page);

    await spawnPatch(page, [
      { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
    ]);
    await waitForCard(page);

    const card = page.locator('[data-testid="twotracks-card"]');
    const modeBtn = card.locator('[data-testid="twotracks-mode-toggle"]');

    await expect(modeBtn).toBeVisible();
    await expect(modeBtn).toHaveText(/loop tape/i);

    await modeBtn.evaluate((el: HTMLElement) => el.click());
    await expect(modeBtn).toHaveText(/^tape$/i);

    await modeBtn.evaluate((el: HTMLElement) => el.click());
    await expect(modeBtn).toHaveText(/loop tape/i);
  });

  test('overdub toggle button activates and deactivates', async ({ page }) => {
    await setupPage(page);

    await spawnPatch(page, [
      { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
    ]);
    await waitForCard(page);

    const card = page.locator('[data-testid="twotracks-card"]');
    const overdubBtn = card.locator('[data-testid="twotracks-overdub-toggle"]');

    await expect(overdubBtn).toBeVisible();
    await expect(overdubBtn).not.toHaveClass(/active/);

    await overdubBtn.evaluate((el: HTMLElement) => el.click());
    await expect(overdubBtn).toHaveClass(/active/);

    await overdubBtn.evaluate((el: HTMLElement) => el.click());
    await expect(overdubBtn).not.toHaveClass(/active/);
  });

  test('decay slider updates displayed percentage', async ({ page }) => {
    await setupPage(page);

    await spawnPatch(page, [
      { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
    ]);
    await waitForCard(page);

    const card = page.locator('[data-testid="twotracks-card"]');
    const decaySlider = card.locator('[data-testid="twotracks-decay"]');

    await expect(decaySlider).toBeVisible();

    const initial = await decaySlider.inputValue();
    expect(parseFloat(initial)).toBeCloseTo(0, 1);

    await decaySlider.fill('0.5');
    await decaySlider.dispatchEvent('input');

    const paramVal = card.locator('.param-val').first();
    await expect(paramVal).toHaveText(/4[0-9]%|5[0-9]%/);
  });

  // ═══════════════════════════ Phase 2 ═══════════════════════════

  test('P2: reel B card elements exist and mirror reel A', async ({ page }) => {
    const errors = await setupPage(page);

    await spawnPatch(page, [
      { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
    ]);
    await waitForCard(page);

    const card = page.locator('[data-testid="twotracks-card"]');

    // Reel B block present
    const reelB = card.locator('[data-testid="twotracks-reel-b"]');
    await expect(reelB).toBeVisible();

    // Reel B waveform canvas
    await expect(card.locator('[data-testid="twotracks-waveform-b"]')).toBeVisible();

    // Reel B EQ section
    await expect(card.locator('[data-testid="twotracks-eq-b"]')).toBeVisible();

    // Reel B filter section
    await expect(card.locator('[data-testid="twotracks-filter-b"]')).toBeVisible();

    // Reel B transport LEDs
    await expect(reelB.locator('[data-testid="led-arm-b"]')).toBeVisible();
    await expect(reelB.locator('[data-testid="led-rec-b"]')).toBeVisible();
    await expect(reelB.locator('[data-testid="led-play-b"]')).toBeVisible();
    await expect(reelB.locator('[data-testid="led-overdub-b"]')).toBeVisible();

    // Reel B mode toggle
    await expect(card.locator('[data-testid="twotracks-mode-toggle-b"]')).toBeVisible();

    // Reel B overdub toggle
    await expect(card.locator('[data-testid="twotracks-overdub-toggle-b"]')).toBeVisible();

    // Reel B decay slider
    await expect(card.locator('[data-testid="twotracks-decay-b"]')).toBeVisible();

    // Reel B save button
    await expect(card.locator('[data-testid="twotracks-save-b"]')).toBeVisible();

    // No errors
    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('P2: A/B knob strip is visible with A and B labels', async ({ page }) => {
    await setupPage(page);

    await spawnPatch(page, [
      { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
    ]);
    await waitForCard(page);

    const card = page.locator('[data-testid="twotracks-card"]');
    const abStrip = card.locator('[data-testid="twotracks-ab-knob"]');

    await expect(abStrip).toBeVisible();

    // Strip should contain "A" and "B" labels
    await expect(abStrip).toContainText('A');
    await expect(abStrip).toContainText('B');

    // The A/B slider should be present inside the strip
    const abSlider = abStrip.locator('input[type="range"]');
    await expect(abSlider).toBeVisible();

    // Default ab=0: percentage display should show A:100% B:0%
    await expect(abStrip).toContainText('A:100%');
    await expect(abStrip).toContainText('B:0%');
  });

  test('P2: A/B law: ab=0 shows A only; ab=1 shows B only; center shows both', async ({ page }) => {
    await setupPage(page);

    await spawnPatch(page, [
      { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
    ]);
    await waitForCard(page);

    const card = page.locator('[data-testid="twotracks-card"]');
    const abStrip = card.locator('[data-testid="twotracks-ab-knob"]');
    const abSlider = abStrip.locator('input[type="range"]');

    // Default ab=0: A:100% B:0%
    await expect(abStrip).toContainText('A:100%');
    await expect(abStrip).toContainText('B:0%');

    // Set ab=0.5 (center): A:100% B:100%
    await abSlider.fill('0.5');
    await abSlider.dispatchEvent('input');
    await expect(abStrip).toContainText('A:100%');
    await expect(abStrip).toContainText('B:100%');

    // Set ab=1.0 (full B): A:0% B:100%
    await abSlider.fill('1');
    await abSlider.dispatchEvent('input');
    await expect(abStrip).toContainText('A:0%');
    await expect(abStrip).toContainText('B:100%');

    // Restore to ab=0: A:100% B:0%
    await abSlider.fill('0');
    await abSlider.dispatchEvent('input');
    await expect(abStrip).toContainText('A:100%');
    await expect(abStrip).toContainText('B:0%');
  });

  test('P2: reel B mode toggle alternates between tape and loop tape', async ({ page }) => {
    await setupPage(page);

    await spawnPatch(page, [
      { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
    ]);
    await waitForCard(page);

    const card = page.locator('[data-testid="twotracks-card"]');
    const modeBtn = card.locator('[data-testid="twotracks-mode-toggle-b"]');

    await expect(modeBtn).toBeVisible();
    await expect(modeBtn).toHaveText(/loop tape/i);

    await modeBtn.evaluate((el: HTMLElement) => el.click());
    await expect(modeBtn).toHaveText(/^tape$/i);

    await modeBtn.evaluate((el: HTMLElement) => el.click());
    await expect(modeBtn).toHaveText(/loop tape/i);
  });

  test('P2: reel B overdub toggle activates and deactivates independently', async ({ page }) => {
    await setupPage(page);

    await spawnPatch(page, [
      { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
    ]);
    await waitForCard(page);

    const card = page.locator('[data-testid="twotracks-card"]');
    const overdubBtnA = card.locator('[data-testid="twotracks-overdub-toggle"]');
    const overdubBtnB = card.locator('[data-testid="twotracks-overdub-toggle-b"]');

    // Both start off
    await expect(overdubBtnA).not.toHaveClass(/active/);
    await expect(overdubBtnB).not.toHaveClass(/active/);

    // Enable reel B overdub only
    await overdubBtnB.evaluate((el: HTMLElement) => el.click());
    await expect(overdubBtnB).toHaveClass(/active/);
    // Reel A should remain off
    await expect(overdubBtnA).not.toHaveClass(/active/);

    // Disable reel B, enable reel A
    await overdubBtnB.evaluate((el: HTMLElement) => el.click());
    await overdubBtnA.evaluate((el: HTMLElement) => el.click());
    await expect(overdubBtnA).toHaveClass(/active/);
    await expect(overdubBtnB).not.toHaveClass(/active/);
  });

  test('P2: EQ sections present on both reels', async ({ page }) => {
    await setupPage(page);

    await spawnPatch(page, [
      { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
    ]);
    await waitForCard(page);

    const card = page.locator('[data-testid="twotracks-card"]');

    // Reel A EQ section
    const eqA = card.locator('[data-testid="twotracks-eq-a"]');
    await expect(eqA).toBeVisible();
    // Three EQ sliders in reel A
    const eqSlidersA = eqA.locator('input[type="range"]');
    await expect(eqSlidersA).toHaveCount(3);

    // Reel B EQ section
    const eqB = card.locator('[data-testid="twotracks-eq-b"]');
    await expect(eqB).toBeVisible();
    const eqSlidersB = eqB.locator('input[type="range"]');
    await expect(eqSlidersB).toHaveCount(3);
  });

  test('P2: filter sections present on both reels with mode toggle buttons', async ({ page }) => {
    await setupPage(page);

    await spawnPatch(page, [
      { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
    ]);
    await waitForCard(page);

    const card = page.locator('[data-testid="twotracks-card"]');

    // Reel A filter
    const filterA = card.locator('[data-testid="twotracks-filter-a"]');
    await expect(filterA).toBeVisible();
    // Mode button starts at "OFF"
    const filterBtnA = filterA.locator('button');
    await expect(filterBtnA).toHaveText('OFF');
    // Cycle through modes
    await filterBtnA.evaluate((el: HTMLElement) => el.click());
    await expect(filterBtnA).toHaveText('HP');
    await filterBtnA.evaluate((el: HTMLElement) => el.click());
    await expect(filterBtnA).toHaveText('LP');
    await filterBtnA.evaluate((el: HTMLElement) => el.click());
    await expect(filterBtnA).toHaveText('BP');
    await filterBtnA.evaluate((el: HTMLElement) => el.click());
    await expect(filterBtnA).toHaveText('OFF');

    // Reel B filter
    const filterB = card.locator('[data-testid="twotracks-filter-b"]');
    await expect(filterB).toBeVisible();
    const filterBtnB = filterB.locator('button');
    await expect(filterBtnB).toHaveText('OFF');
  });

  // ═══════════════════════════ Phase 3 ═══════════════════════════

  test.describe('TWOTRACKS P3', () => {
    test('lofi strip is visible and contains all four mode buttons', async ({ page }) => {
      const errors = await setupPage(page);

      await spawnPatch(page, [
        { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
      ]);
      await waitForCard(page);

      const card = page.locator('[data-testid="twotracks-card"]');
      const lofiStrip = card.locator('[data-testid="twotracks-lofi"]');

      await expect(lofiStrip).toBeVisible();

      // All four labels should be present as buttons
      const buttons = lofiStrip.locator('button');
      await expect(buttons).toHaveCount(4);
      await expect(buttons.nth(0)).toHaveText('OFF');
      await expect(buttons.nth(1)).toHaveText('LOW');
      await expect(buttons.nth(2)).toHaveText('HIGH');
      await expect(buttons.nth(3)).toHaveText('ERROR');

      // Default: OFF button is active
      await expect(buttons.nth(0)).toHaveClass(/active/);
      await expect(buttons.nth(1)).not.toHaveClass(/active/);
      await expect(buttons.nth(2)).not.toHaveClass(/active/);
      await expect(buttons.nth(3)).not.toHaveClass(/active/);

      const filtered = errors.filter((e) => !e.includes('ResizeObserver') && !e.includes('vite'));
      expect(filtered, filtered.join('; ')).toEqual([]);
    });

    test('lofi switch cycles through OFF → LOW → HIGH → ERROR and back to OFF', async ({ page }) => {
      await setupPage(page);

      await spawnPatch(page, [
        { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
      ]);
      await waitForCard(page);

      const card = page.locator('[data-testid="twotracks-card"]');
      const lofiStrip = card.locator('[data-testid="twotracks-lofi"]');
      const buttons = lofiStrip.locator('button');

      // Start: OFF active
      await expect(buttons.nth(0)).toHaveClass(/active/);

      // Click LOW
      await buttons.nth(1).evaluate((el: HTMLElement) => el.click());
      await expect(buttons.nth(1)).toHaveClass(/active/);
      await expect(buttons.nth(0)).not.toHaveClass(/active/);

      // Click HIGH
      await buttons.nth(2).evaluate((el: HTMLElement) => el.click());
      await expect(buttons.nth(2)).toHaveClass(/active/);
      await expect(buttons.nth(1)).not.toHaveClass(/active/);

      // Click ERROR
      await buttons.nth(3).evaluate((el: HTMLElement) => el.click());
      await expect(buttons.nth(3)).toHaveClass(/active/);
      await expect(buttons.nth(2)).not.toHaveClass(/active/);

      // Click OFF to reset
      await buttons.nth(0).evaluate((el: HTMLElement) => el.click());
      await expect(buttons.nth(0)).toHaveClass(/active/);
      await expect(buttons.nth(3)).not.toHaveClass(/active/);
    });

    test('lofi ERROR button shows error highlight class when active', async ({ page }) => {
      await setupPage(page);

      await spawnPatch(page, [
        { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
      ]);
      await waitForCard(page);

      const card = page.locator('[data-testid="twotracks-card"]');
      const lofiStrip = card.locator('[data-testid="twotracks-lofi"]');
      const errorBtn = lofiStrip.locator('button').nth(3);

      // Initially not in error state
      await expect(errorBtn).not.toHaveClass(/error/);

      // Activate ERROR mode
      await errorBtn.evaluate((el: HTMLElement) => el.click());
      await expect(errorBtn).toHaveClass(/active/);
      await expect(errorBtn).toHaveClass(/error/);

      // Back to OFF — error class should clear
      await lofiStrip.locator('button').nth(0).evaluate((el: HTMLElement) => el.click());
      await expect(errorBtn).not.toHaveClass(/error/);
    });
  });

  // ═══════════════════════════ Phase 4 ═══════════════════════════

  test.describe('TWOTRACKS P4', () => {
    test('P4: waveform canvas elements present on both reels', async ({ page }) => {
      await setupPage(page);

      await spawnPatch(page, [
        { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
      ]);
      await waitForCard(page);

      const card = page.locator('[data-testid="twotracks-card"]');

      // Both waveform canvases should be present and visible
      await expect(card.locator('[data-testid="twotracks-waveform"]')).toBeVisible();
      await expect(card.locator('[data-testid="twotracks-waveform-b"]')).toBeVisible();

      // Both SAVE TAPE buttons present
      await expect(card.locator('[data-testid="twotracks-save"]')).toBeVisible();
      await expect(card.locator('[data-testid="twotracks-save-b"]')).toBeVisible();
    });

    test('P4: SAVE TAPE disabled initially and shows "no tape" info', async ({ page }) => {
      await setupPage(page);

      await spawnPatch(page, [
        { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
      ]);
      await waitForCard(page);

      const card = page.locator('[data-testid="twotracks-card"]');

      // SAVE TAPE buttons should be disabled when no tape recorded
      const saveA = card.locator('[data-testid="twotracks-save"]');
      const saveB = card.locator('[data-testid="twotracks-save-b"]');
      await expect(saveA).toBeDisabled();
      await expect(saveB).toBeDisabled();

      // tape-info should show "no tape" for both reels
      const reelA = card.locator('[data-testid="twotracks-reel-a"]');
      const reelB = card.locator('[data-testid="twotracks-reel-b"]');
      await expect(reelA.locator('.tape-info')).toHaveText(/no tape/i);
      await expect(reelB.locator('.tape-info')).toHaveText(/no tape/i);
    });

    test('P4: SAVE TAPE becomes enabled and shows duration when bufLen is set', async ({ page }) => {
      await setupPage(page);

      await spawnPatch(page, [
        { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
      ]);
      await waitForCard(page);

      const card = page.locator('[data-testid="twotracks-card"]');
      const saveA = card.locator('[data-testid="twotracks-save"]');
      const reelA = card.locator('[data-testid="twotracks-reel-a"]');

      // Simulate 1 second of recorded tape by setting bufLenA in node.data via Y.Doc.
      // bufLenA is a plain number stored in Y.Doc (not Float32Array) so this works.
      await page.evaluate(() => {
        const w = globalThis as unknown as {
          __ydoc: { transact: (fn: () => void) => void };
          __patch: { nodes: Record<string, { data: Record<string, unknown> }> };
        };
        w.__ydoc.transact(() => {
          const tt = w.__patch.nodes['tt'];
          if (tt) {
            if (!tt.data) tt.data = {};
            tt.data['bufLenA'] = 48000; // 1 second at 48 kHz
          }
        });
      });

      // SAVE TAPE should become enabled
      await expect(saveA).not.toBeDisabled();

      // tape-info should show duration (1.0s)
      await expect(reelA.locator('.tape-info')).toContainText('1.0s');
    });
  });
});
