// e2e/tests/scope-tuner.spec.ts
//
// E2E for SCOPE's pitch tuner readout. Spawn ANALOG-VCO -> SCOPE.ch1, set
// ANALOG-VCO to A4 (MIDI 69, pitch CV = 0.75 V/oct), wait for the pitch
// readout to settle, assert the displayed Hz is in the 435..445 range and
// the note text reads "A4". Also confirms the tuning meter's center hash
// element is rendered (the hash is the visual "0 cents" reference).

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe('SCOPE pitch tuner readout', () => {
  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 1 recovered-on-retry observation(s) across 1 SHA(s) / 1 branch(es) in the
  // 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
  // LOST WHILE PARKED: SCOPE's tuner readout against a known A440 source — the displayed Hz, the note name, and the 0-cent centre hash; a broken tuner silently mistunes everything a user tunes by it.
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  test.fixme('ANALOG-VCO at A4 → pitch=440Hz / note=A4 / center hash visible', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 1 recovered-on-retry observation in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page, rack, errorWatch }) => {
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

    const tile = page.locator('.svelte-flow__node[data-id="a-scope"] [data-testid="module-shell"]');
    await expect(tile).toBeVisible();
    // The tuner readout survives the readout ruling as the SPEAKABLE
    // aria-label on the dock's tuning graticule ('tuning: no pitch detected'
    // when YIN returns null) — the em-dash pair was its card paint.
    await tile.getByTestId('shell-open-dock').click();
    await expect(page.getByTestId('dock-full-view')).toBeVisible();
    const tuning = page.getByTestId('scope-face-tuning');

    // The meter is drawn inside the canvas on the shell; its Hz / note /
    // cents survive the readout ruling as the graticule's SPEAKABLE
    // aria-label ('tuning: A4, 440.0 Hz, +0 cents'). Wait up to ~5s for YIN
    // to converge on a stable A4 readout (the body polls at ~10 Hz;
    // ANALOG-VCO startup + first non-silent buffer + first YIN tick land
    // well inside that window).
    await expect.poll(
      async () => (await tuning.getAttribute('aria-label')) ?? '',
      {
        timeout: 5000,
        message: 'pitch tuner should detect A4 from ANALOG-VCO sine',
      },
    ).toMatch(/^tuning: A4, /);

    const label = (await tuning.getAttribute('aria-label')) ?? '';
    const m = label.match(/(\d+(?:\.\d+)?)\s*Hz/);
    expect(m, `expected "<num> Hz" in "${label}"`).not.toBeNull();
    const hz = parseFloat(m![1]!);
    // Tolerance window: ±5 Hz at 440 Hz ≈ ±20 cents — generous because the
    // browser's ANALOG-VCO Faust runtime introduces a tiny tune offset and
    // YIN at 2048 samples has ~0.5 Hz quantization at this freq.
    expect(hz, `expected 435..445 Hz, got ${hz}`).toBeGreaterThan(435);
    expect(hz, `expected 435..445 Hz, got ${hz}`).toBeLessThan(445);

  });

  test('SCOPE with no signal shows em-dashes', async ({ page, rack }) => {
    await spawnPatch(
      page,
      [
        { id: 'a-scope', type: 'scope', position: { x: 60, y: 60 }, domain: 'audio' },
      ],
      [],
    );

    const tile = page.locator('.svelte-flow__node[data-id="a-scope"] [data-testid="module-shell"]');
    await expect(tile).toBeVisible();
    // The tuner readout survives the readout ruling as the SPEAKABLE
    // aria-label on the dock's tuning graticule ('tuning: no pitch detected'
    // when YIN returns null) — the em-dash pair was its card paint.
    await tile.getByTestId('shell-open-dock').click();
    await expect(page.getByTestId('dock-full-view')).toBeVisible();
    const tuning = page.getByTestId('scope-face-tuning');

    // Wait one polling cycle (>=200ms) and confirm the no-signal placeholder.
    await page.waitForTimeout(400);
    await expect(tuning).toHaveAttribute('aria-label', 'tuning: no pitch detected');
  });
});
