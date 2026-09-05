// e2e/tests/p1-batch2-faces.spec.ts
//
// P1 BATCH 2 — the MIGRATION sanity check for the newly promoted faces, on the
// three surfaces a migration actually has to land on. The registry-driven
// faces-parity sweep already proves the dock renders the def's FULL control
// surface for every STRICT_FACES module (and auto-enrolled all six of these);
// what it does NOT prove is that the bridge actually SWAPPED — a module can be
// in STRICT_FACES, render a perfect dock faceplate, and still show the uniform
// un-migrated PLACEHOLDER in its lane. That is the bug this spec exists for:
//
//   1. LANE — the curated ModuleShell renders in the lane under `?shell=1`,
//      NOT `module-shell-placeholder`, and the legacy card's controls are gone
//      from the lane (they live in the dock now).
//   2. DOCK — the full-view faceplate mounts at the 'dock' face tier and
//      renders exactly the module's declared `face.pages` as labeled section
//      bands, in order.
//   3. REAR — the flip key flips the faceplate and the rear jack field renders one
//      hole per declared port, with the front control face gone.
//
// TWO representative modules rather than all six (the sweep covers the rest):
//   dx7      — the batch's most complex FACE (4 pages, a control FAMILY in the
//              ranking: the preset selector) on the SIMPLEST rear (4 holes,
//              zero per-param CV).
//   sixstrum — the inverse: the batch's busiest REAR (23 holes, two curated
//              sub-header clusters) and its widest page set (6).
//
// Plus the NO-OP guarantee re-asserted for the newly migrated types: with the
// preview OFF (the default) a batch-2 module still renders its REAL legacy
// card in the lane. Promotion to STRICT_FACES must not leak out of `?shell=1`.
//
// Runs on /rack?shell=legacy (no DB/relay) — the normal e2e lane.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { pressFlipKey } from './_flip-key';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// ⚠ THE PER-TEST BUDGET IS A BOUND, AND IT WAS THE INVISIBLE 30 s DEFAULT.
//
// This file bounds its boot wait with `BOOT_MS` — 30 000 on CI, IDENTICAL to
// the 30 000 default budget it was running inside. 1 site, 1.00x.
//
// An inner bound at or above the budget that CONTAINS it can never come true:
// the outer clock kills the test first, so a legible `element not found` is
// converted into an illegible `Test timeout of 30000ms exceeded` — the class
// #2291 root-caused and #2293 repaired at its second call site. Nothing in this
// file said "30000"; `e2e/playwright.config.ts` never overrides Playwright's
// default, so there was nothing to grep for except the ABSENCE of a budget.
//
// The budget therefore comes from `boot-budget` (90 000 on CI/SwiftShader,
// 30 000 local) instead of the invisible default. A bound only costs wall-clock
// when it is EXCEEDED, so this adds exactly zero to a green run; lane cost stays
// gauged by `--global-timeout`, not by this.
//
// ⚠ BOUNDS ONLY. No assertion, subject or wait target changed here.
test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

/** The two representative migrations. `pages` = declared face.pages; `holes` =
 *  declared inputs + outputs (the rear renders exactly one hole per port). */
const BATCH2 = [
  {
    type: 'dx7',
    // ⚠ These are the page LABELS, not the ids — the dock band renders
    // `label`. dx7's first page is `{ id: 'patch', label: 'voice' }`: the ID was
    // deliberately moved off 'voice' because `rearFieldPlan` claims a curated
    // rear group per page id, and this module's rear curation already owns
    // `{ id: 'voice' }` — a collision renders that band TWICE and trips the
    // rear-totality gate. The user-facing word stayed in the label, which is
    // the half that renders and therefore the half this spec must expect.
    //
    // Reshaped by the voice-edit-buffer PR: 'cartridge' folded into the first
    // page (which now carries both the preset select and the .syx input), and
    // the new `feedback` param brought an 'algorithm · operators' page. Still
    // four pages, different set.
    pages: ['voice', 'algorithm · operators', 'performance', 'master adsr'],
    holes: 4,
    /** A param the lane face must NOT be showing as a legacy card control. */
    laneParam: 'algorithm',
  },
  {
    type: 'sixstrum',
    pages: [
      '1 · instrument · chord',
      '2 · the six strings',
      '3 · the strum hand',
      '4 · the pick',
      '5 · amp envelope · body · out',
    ],
    holes: 23,
    laneParam: 'ring',
  },
] as const;

const NODE = 'b2';

async function gotoWorkflow(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

test.describe('P1 batch 2 — the migrated faces land on lane + dock + rear', () => {
  for (const { type, pages, holes, laneParam } of BATCH2) {
    test(`${type}: curated shell in the lane, ${pages.length} dock pages, ${holes}-hole rear field`, async ({ page }) => {
      await gotoWorkflow(page);
      await spawnPatch(page, [{ id: NODE, type, position: { x: 460, y: 240 } }]);

      const laneNode = page.locator(`.svelte-flow__node[data-id="${NODE}"]`);
      await expect(laneNode).toHaveCount(1);

      // ── 1) LANE: the curated shell, NOT the un-migrated placeholder. ──
      const shell = laneNode.locator('[data-testid="module-shell"]');
      await expect(shell).toBeVisible();
      // The LEGACY CARD itself is gone from the lane — the shell replaced it,
      // it did not wrap it. (Scoped to the card ROOT, not `control-*`: the
      // shell's own curated cells carry the same `control-<paramId>` testids,
      // so a testid-based negative would be vacuous. The preview-OFF case
      // below asserts the positive on this exact selector, which is what keeps
      // this one honest.)
      await expect(laneNode.locator('.mod-card, .card, .moog-panel')).toHaveCount(0);
      // Cables stay attached through the swap.
      await expect(laneNode.locator('.svelte-flow__handle').first()).toHaveCount(1);

      // ── 2) DOCK: the faceplate mounts at the 'dock' tier with the declared
      //       pages as labeled section bands, in order. ──
      await shell.getByTestId('shell-open-dock').click();
      const faceplate = page.getByTestId('dock-full-view');
      await expect(faceplate).toBeVisible();
      await expect(
        faceplate.locator('[data-testid="module-shell"][data-shell-tier="dock"]'),
        `${type}: the dock mounts the CURATED shell (not the legacy card fallback)`,
      ).toBeVisible();
      const bands = faceplate.locator('[data-testid="face-page"]');
      await expect(bands).toHaveCount(pages.length);
      for (const [i, label] of pages.entries()) {
        await expect(
          bands.nth(i),
          `${type}: dock band ${i} is the declared page '${label}'`,
        ).toContainText(label, { ignoreCase: true });
      }
      // The curated control the lane face does not surface is reachable here.
      await expect(faceplate.locator(`[data-testid="control-${laneParam}"]`)).toHaveCount(1);

      // ── 3) REAR: the flip key flips to the jack field — one hole per port. ─
      await pressFlipKey(page);
      await expect(faceplate).toHaveAttribute('data-flipped', 'true');
      const rear = faceplate.getByTestId('rear-card');
      await expect(rear).toBeVisible();
      await expect(
        rear.locator('[data-testid="back-jack"]'),
        `${type}: the rear exposes EVERY declared patch point, exactly once`,
      ).toHaveCount(holes);
      // The front control face is gone while flipped.
      await expect(faceplate.getByTestId('faceplate-editor')).toBeHidden();

      // The flip key flips back to the control face.
      await pressFlipKey(page);
      await expect(faceplate).toHaveAttribute('data-flipped', 'false');
      await expect(faceplate.locator('[data-testid="face-page"]')).toHaveCount(pages.length);
    });
  }
});
