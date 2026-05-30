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
  // CADILLAC renders as a roaming overlay sprite, NOT as a SvelteFlow
  // card — Canvas.svelte filters the type out of flowNodes so xyflow
  // doesn't paint a fallback box at the spawn point. There is no
  // `.svelte-flow__node-cadillac` to assert against. Functional coverage:
  // e2e/tests/cadillac.spec.ts (drive + delete + self-destruct).
  cadillac: 'overlay sprite, not a flow card; covered by e2e/tests/cadillac.spec.ts',
  // QBERT fetches a user-provided ROM zip from /roms/qbert/qbert.zip at
  // spawn time. On a clean checkout (no ROM installed) this 404s by
  // design — the card surfaces the "ROM MISSING" overlay. The 404
  // surfaces as a Chromium console error which this strict spec rejects.
  // Dedicated coverage: e2e/tests/qbert-rom-missing.spec.ts (asserts
  // overlay + handle count, filtering the expected 404). The handle
  // count + CV path are also covered by per-module-per-port specs.
  qbert: 'fetches user-provided ROM (404s on clean checkout); covered by e2e/tests/qbert-rom-missing.spec.ts',
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
    // Title-text assertion: nearly every card now hosts the editable
    // name button (see ModuleNameLabel.svelte). The default auto-assigned
    // name for the first instance is the BARE uppercased type prefix
    // (e.g. "WAVESCULPT"); subsequent instances get "<TYPE>2", "<TYPE>3",
    // ... — see the bare-prefix policy in $lib/multiplayer/module-naming.ts.
    // Use a regex so the test stays valid regardless of how many instances
    // spawned earlier in the same browser context, AND so per-card chrome
    // (punctuation in `mod.label` like "MIDI-CV-BUDDY" or "NUMPAD+") doesn't
    // drift this.
    //
    // A couple of meta-domain cards (sticky, group) intentionally render
    // their own chrome without ModuleTitle (sticky has a static "STICKY"
    // badge + freeform textarea; group has its own rename UX via
    // `data.label`). For those, fall back to the legacy `mod.label`
    // substring check — the same assertion the test made before the
    // in-card-title sweep.
    const nameButton = card.locator('[data-testid="name-label-button"]');
    if (await nameButton.count() > 0) {
      const prefix = mod.type.toUpperCase();
      const namePattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)?$`);
      await expect(nameButton, `${mod.type} name matches /<TYPE>(\\d+)?/`).toHaveText(namePattern);
    } else {
      // Cards without the editable name button (sticky/group) still
      // surface SOME identifying text — the def's label.
      await expect(card, `${mod.type} contains def label`).toContainText(mod.label, {
        ignoreCase: true,
      });
    }

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
