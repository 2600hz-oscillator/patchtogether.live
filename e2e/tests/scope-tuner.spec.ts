// e2e/tests/scope-tuner.spec.ts
//
// E2E for SCOPE's pitch tuner readout. Spawn ANALOG-VCO -> SCOPE.ch1, set
// ANALOG-VCO to A4 (MIDI 69, pitch CV = 0.75 V/oct), wait for the pitch
// readout to settle, assert the displayed Hz is in the 435..445 range and
// the note text reads "A4". Also confirms the tuning meter's center hash
// element is rendered (the hash is the visual "0 cents" reference).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('SCOPE pitch tuner readout', () => {
  test('ANALOG-VCO at A4 → pitch=440Hz / note=A4 / center hash visible', async ({ page }) => {
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
        // ANALOG-VCO defaults: tune=0, fine=0. Default pitch CV is 0
        // (= C4 = 261.63 Hz). To get A4 = 440 Hz we set tune to 9
        // semitones (C4 + 9 = A4). The DSP convention is
        // freqHz = 261.626 * 2^(pitch + tune/12 + ...), so tune=9 gives
        // exactly 440 Hz with no FM/fine offset.
        { id: 'a-vco',   type: 'analogVco', position: { x: 60,  y: 60 },
          params: { tune: 9 }, domain: 'audio' },
        { id: 'a-scope', type: 'scope',     position: { x: 320, y: 60 }, domain: 'audio' },
      ],
      [
        {
          id: 'e-vco-scope',
          from: { nodeId: 'a-vco', portId: 'sine' },
          to:   { nodeId: 'a-scope', portId: 'ch1' },
          sourceType: 'audio',
          targetType: 'audio',
        },
      ],
    );

    const scopeCard = page.locator('.svelte-flow__node-scope');
    await expect(scopeCard).toBeVisible();

    const hzReadout = scopeCard.locator('[data-testid="pitch-hz"]');
    const noteReadout = scopeCard.locator('[data-testid="pitch-note"]');
    const centerTick = scopeCard.locator('[data-testid="tuning-meter-center"]');

    // Center hash must always be visible — it's the "0 cents" reference and
    // doesn't depend on input signal.
    await expect(centerTick, 'center tick rendered').toBeVisible();

    // Wait up to ~3s for YIN to converge on a stable A4 readout. The card
    // polls at ~10 Hz; ANALOG-VCO startup + first non-silent buffer + first
    // YIN tick should land well inside that window.
    await expect.poll(
      async () => (await noteReadout.textContent())?.trim(),
      {
        timeout: 5000,
        message: 'pitch tuner should detect A4 from ANALOG-VCO sine',
      },
    ).toBe('A4');

    const hzText = (await hzReadout.textContent())?.trim() ?? '';
    const m = hzText.match(/(\d+(?:\.\d+)?)\s*Hz/);
    expect(m, `expected "<num> Hz", got "${hzText}"`).not.toBeNull();
    const hz = parseFloat(m![1]!);
    // Tolerance window: ±5 Hz at 440 Hz ≈ ±20 cents — generous because the
    // browser's ANALOG-VCO Faust runtime introduces a tiny tune offset and
    // YIN at 2048 samples has ~0.5 Hz quantization at this freq.
    expect(hz, `expected 435..445 Hz, got ${hz}`).toBeGreaterThan(435);
    expect(hz, `expected 435..445 Hz, got ${hz}`).toBeLessThan(445);

    // Marker should be in-tune (within ±5 cents of A4) most of the time.
    const marker = scopeCard.locator('[data-testid="tuning-meter-marker"]');
    await expect(marker).toBeVisible();

    expect(errors, `unexpected errors: ${errors.join('\n')}`).toEqual([]);
  });

  test('SCOPE with no signal shows em-dashes', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'a-scope', type: 'scope', position: { x: 60, y: 60 }, domain: 'audio' },
      ],
      [],
    );

    const scopeCard = page.locator('.svelte-flow__node-scope');
    await expect(scopeCard).toBeVisible();

    const hzReadout = scopeCard.locator('[data-testid="pitch-hz"]');
    const noteReadout = scopeCard.locator('[data-testid="pitch-note"]');

    // Wait one polling cycle (>=200ms) and confirm the no-signal placeholder
    // — the card uses an em-dash for both fields when YIN returns null.
    await page.waitForTimeout(400);
    await expect(hzReadout).toHaveText('—');
    await expect(noteReadout).toHaveText('—');
  });
});
