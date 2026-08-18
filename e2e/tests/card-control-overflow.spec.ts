// e2e/tests/card-control-overflow.spec.ts
//
// SYSTEMIC control-overflow gate — the regression net for the class of bug
// where a module card's controls spill OFF the card (they run past the right
// edge / below the bottom, or the card develops horizontal content overflow).
//
// Motivation (GRAINS OF VISION): the granular-video card packed ~19 faders into
// a 258px card whose 4-column grid couldn't hold them, so the FEEDBACK / REVERB
// / COMPOSITE controls ran off the right edge — "controls go way off the card,
// which is something we should have OVERALL tests against" (owner). Nothing in
// the suite asserted card layout bounds, so any card could quietly overflow.
//
// ── WHAT LIVES WHERE NOW (#1861) ───────────────────────────────────────────
// The REGISTRY-WIDE sweep (one test per module, at DEFAULT params) moved into
// e2e/tests/io-spec-consistency.spec.ts, which already spawned every module and
// was paying a second full page load to read a different property of the same
// card. Nothing about the measurement changed: the instrument, the tolerance
// and EXEMPT_CONTROL_OVERFLOW all moved verbatim into e2e/tests/_card-overflow.ts
// and are imported by both files, and the exemption ANCHOR moved to the sweep's
// new home alongside the four other curated maps it now also anchors.
//
// WHAT STAYS HERE is the half the sweep is structurally blind to: BACKDRAFT's
// non-default TV MODES. That is not a filing decision — it is the reason this
// file still exists, and it is cited as coverage by e2e/vrt/vrt-exemptions.ts.
//
// ⚠ Both parts are needed. The sweep catches "this card overflows"; only the
// mode cases catch "this card overflows IN A MODE THE SWEEP NEVER ENTERS".

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { assertControlsFitCard } from './_card-overflow';

// Video card → freeze the per-frame GL draw so the layout-only check stays
// cheap on CI's SwiftShader software renderer (the card still mounts + lays out
// its chrome). Same lever the registry sweep uses.
async function freezeVideoRender(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    (globalThis as unknown as { __videoEngineFreezeRender?: boolean })
      .__videoEngineFreezeRender = true;
  });
}

test.describe.configure({ mode: 'parallel' });

// ─── BACKDRAFT TV MODES — controls that only EXIST in a non-default mode ─────
//
// The registry sweep spawns every module at its DEFAULT params, which for
// BACKDRAFT means TV MODE = OFF — and a chunk of the card's chrome (the TV
// readout today; the VIRTUAL CAMERA ORIENTATION row on the branch that
// followed) only mounts when the mode is ON. So the sweep structurally CANNOT
// see those controls: it reports a clean card while the newest controls go
// unmeasured.
//
// That is not hypothetical. A ~310 CSS px bottom overflow sat on this card for
// hours precisely because the gate only ever ran it with TV MODE off. A gate
// with a real catch that cannot see the newest controls is a hole, so the modes
// are measured EXPLICITLY here.
//
// THE GUARD IS THE POINT: each case asserts the mode actually APPLIED
// (data-tv-mode on the card root) AND that mode-conditional chrome is mounted
// (the TV readout). Without that a param that silently failed to land would
// leave this measuring the OFF layout again and proving nothing.
//
// ALL THREE modes are measured, including the default OFF — and the OFF case
// carries an extra job. BACKDRAFT's rule is that a control which is inert in
// the MODEL is DIMMED, never `disabled` and never `{#if}`-ed away, because both
// of those make it unreachable while the gate CV path keeps writing the param.
// The OFF case is where that rule is observable: the TV SCREEN faders are inert
// there, so it asserts they are still VISIBLE and still ENABLED. That is also
// what keeps the card's height mode-INVARIANT, which is the property the three
// measurements below jointly pin.
//
// (The label list is the REAL mode vocabulary — BACKDRAFT_TV_MODE_LABELS in
// backdraft.ts is ['OFF','PURE TV','CRITICAL']. Mode 1 was long mislabelled
// 'VIRTUAL CAMERA' here, so every failure message named a mode that does not
// exist.)
test.describe('backdraft: controls fit in EVERY TV MODE, not just the default', () => {
  for (const [label, tvMode] of [['OFF', 0], ['PURE TV', 1], ['CRITICAL', 2]] as const) {
    test(`backdraft: controls fit within the card in TV MODE = ${label}`, async ({ page }) => {
      // Video card → freeze the per-frame GL draw + take the SwiftShader budget,
      // same levers as the registry sweep.
      await freezeVideoRender(page);
      test.setTimeout(60_000);

      await page.goto('/rack?shell=legacy&seed=none');
      await spawnPatch(
        page,
        [{
          id: 'sut', type: 'backdraft', position: { x: 400, y: 60 },
          domain: 'video', params: { tvMode },
        }],
        [],
      );

      const card = page.locator('.svelte-flow__node-backdraft');
      await expect(card, 'backdraft card visible').toBeVisible();

      // (1) the mode actually landed on the card…
      await expect(
        page.locator('[data-testid="backdraft-card"]'),
        `backdraft card is in TV MODE ${label}`,
      ).toHaveAttribute('data-tv-mode', String(tvMode));
      // (2) …and the mode-CONDITIONAL chrome agrees with the mode. If this is
      //     missing we are measuring some other layout and proving nothing.
      if (tvMode === 0) {
        // OFF: the readout is the ONLY mode-conditional chrome, and it is gone.
        await expect(
          page.locator('[data-testid="backdraft-tv-readout"]'),
          'the TV readout is absent in OFF',
        ).toHaveCount(0);
        // ALL CONTROLS REMAIN USABLE. The TV SCREEN faders do nothing in OFF —
        // they are dimmed, and that is ALL they are. Still rendered (so the
        // card's height does not move with the mode) and still enabled (so drag
        // / dbl-click-reset / wheel / right-click MIDI-Learn all keep working,
        // and the UI cannot disagree with what the gate CV path is writing).
        const tvFaders = page.locator('.tv-bank [data-testid="backdraft-tv-screen-hint"], .tv-bank .bank-faders');
        await expect(
          page.locator('.tv-bank .bank-faders'),
          'TV SCREEN faders stay MOUNTED + VISIBLE while inert (dimmed, not hidden)',
        ).toBeVisible();
        await expect(tvFaders.first()).toBeVisible();
        // The VIRTUAL CAMERA bank is the SAME rule, and it is the one that got
        // it wrong first: it originally shipped behind `{#if tvOn}`, which is
        // precisely the unmount the registry sweep cannot see — that sweep
        // spawns at DEFAULT params (tvMode 0), so a control that only mounts in
        // a non-default mode goes unmeasured, which is how a ~310 CSS px
        // overflow sat on this card for hours. Asserting it VISIBLE here is
        // what proves the camera controls are reachable in the mode the sweep
        // actually runs.
        await expect(
          page.locator('[data-testid="backdraft-cam-row"]'),
          'VIRTUAL CAMERA controls stay MOUNTED + VISIBLE in OFF (dimmed, never {#if}-ed away)',
        ).toBeVisible();
        await expect(
          page.locator('[data-testid="backdraft-cam-tilt-pad"]'),
          'the TILT joystick is reachable in the default mode',
        ).toBeVisible();
        await expect(
          page.locator('[data-testid="backdraft-cam-pos-pad"]'),
          'the POSITION joystick is reachable in the default mode',
        ).toBeVisible();
        const lockedOut = await page.locator('[data-testid="backdraft-card"]')
          .locator('button[disabled], input[disabled]')
          .count();
        expect(lockedOut, 'NO control on the card is disabled in the default mode').toBe(0);
      } else {
        await expect(
          page.locator('[data-testid="backdraft-tv-readout"]'),
          `TV-mode-only chrome is mounted in ${label}`,
        ).toBeVisible();
      }

      await assertControlsFitCard(page, 'backdraft', 'backdraft', `TV MODE ${label} · `);
    });
  }
});
