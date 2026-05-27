// e2e/tests/modules.spec.ts
//
// Per-module smoke check: spawn one instance of every registered module,
// assert the card renders with the right handle count, contains the
// module's label substring, and produces no console / page errors.
//
// Iterates the synthesised registry manifest (`e2e/.generated/
// registry-manifest.json`), so adding a new module auto-enrols it here —
// no edits required. Handle count is derived as `inputs.length +
// outputs.length` rather than hand-counted, and the label substring
// comes from the def's `label` field.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { REGISTRY } from './_registry';

// Modules whose card doesn't render under bare spawnPatch (needs
// `data.children`, depends on hardware, etc.) — skipped here with a
// reason and a pointer at the dedicated coverage. Separate from
// io-spec-consistency.SKIP_DEF_VS_UI because the failure mode each
// spec catches is different (handle-count vs def↔UI parity); the
// canonical list of "needs follow-up" modules lives in the
// io-spec spec.
const SKIP_RENDER: Record<string, string> = {
  // Bare spawnPatch({type:'group'}) doesn't render the Svelte Flow
  // node — the group card body lifts chrome from `data.children`
  // which we don't supply. Functional coverage:
  // e2e/tests/grouping-phase1.spec.ts.
  group: 'requires data.children; covered by e2e/tests/grouping-phase1.spec.ts',
  // HELM's gear-icon settings panel hides some inputs (MIDI). The
  // rendered handle count therefore < def.inputs.length + outputs.
  // Functional coverage: e2e/tests/helm.spec.ts.
  helm: 'gear-icon settings panel hides MIDI ports; covered by e2e/tests/helm.spec.ts',
};

test.describe.configure({ mode: 'parallel' });

for (const mod of REGISTRY) {
  const expectedHandleCount = mod.inputs.length + mod.outputs.length;
  const skipReason = SKIP_RENDER[mod.type];
  if (skipReason) {
    test.fixme(
      `module ${mod.type} renders [SKIPPED: ${skipReason}]`,
      () => { /* see SKIP_RENDER for the alternative coverage */ },
    );
    continue;
  }
  test(`module ${mod.type} renders + has ${expectedHandleCount} handles + no console errors`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      {
        id: 'm-1',
        type: mod.type,
        position: { x: 100, y: 100 },
        domain: mod.domain,
      },
    ]);

    const cardClass = `svelte-flow__node-${mod.type}`;
    const card = page.locator(`.${cardClass}`);
    await expect(card, `${mod.type} card visible`).toBeVisible();
    // Label substring — uppercased forms are common (e.g. "ANALOG VCO"
    // on the card vs the def's "Analog VCO" label). Match the label
    // case-insensitively so per-card styling doesn't bounce this test.
    await expect(card, `${mod.type} contains label`).toContainText(mod.label, {
      ignoreCase: true,
    });

    const handles = card.locator('.svelte-flow__handle');
    await expect(handles, `${mod.type} handle count`).toHaveCount(expectedHandleCount);

    // Card has non-zero rect (catches the silent-DOM-only failure mode).
    const box = await card.boundingBox();
    expect(box, `${mod.type} bounding box`).toBeTruthy();
    expect(box!.width).toBeGreaterThan(50);
    expect(box!.height).toBeGreaterThan(50);

    expect(
      errors,
      `console/page errors during ${mod.type} render: ${errors.join('; ')}`,
    ).toEqual([]);
  });
}
