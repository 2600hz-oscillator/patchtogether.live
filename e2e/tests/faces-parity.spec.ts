// e2e/tests/faces-parity.spec.ts
//
// FACES RENDER-PARITY — the authoritative DOM gate for the workflow-mode
// UI-curation system: A REDESIGN MUST NEVER LOSE A CONTROL. Born from the
// tidyVco tune/fine loss (the face ranked `detune`/`oct2` below the lane
// fit-plan's whole-cell cap, so the redesigned face surfaced ZERO tuning
// controls in-lane and the schema-level face-lint gate never noticed —
// schema coverage ≠ rendered coverage).
//
// REGISTRY-DRIVEN: enumerates STRICT_FACES (imported straight from the web
// source — the same set the lint gate and the migration bridge read), so
// every FUTURE promoted face auto-enrolls in this sweep with zero test
// edits. For each migrated module, the dock full-view (`?shell=1` →
// EXPAND) must render:
//
//   1. EXACTLY one interactive control per def PARAM id — matched by the
//      card-kit's `control-<paramId>` testid binding, asserted as full
//      id-multiset equality against the LIVE def (window.__moduleSpecs):
//      a dropped control fails, a duplicated control fails, and an extra
//      control with no def backing fails.
//   2. one family cell per DECLARED control family, and ZERO dead 'static'
//      cells (batch 1 declares none; a future legend-backed static must
//      revisit this line deliberately).
//   3. OPERABILITY: the first continuous param control actually DRIVES the
//      graph param (pointer-drag → __patch write) — presence without
//      function is still a loss.
//
// The browser-free pre-gate twin is module-face-lint's dockFacePlan parity
// test (packages/web/src/lib/ui/workflow/module-face-lint.test.ts); the
// deliberate in-lane top-N curation is covered by workflow-shell-faces.
// Runs on /rack?mode=workflow (no DB/relay) — the normal e2e lane.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { STRICT_FACES } from '../../packages/web/src/lib/ui/workflow/strict-faces';

interface SpecShape {
  type: string;
  params: { id: string; curve: string; defaultValue: number }[];
  controlFamilies?: string[];
  strictFace?: boolean;
}

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack?mode=workflow&shell=1');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible();
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

async function readSpec(page: Page, type: string): Promise<SpecShape> {
  const spec = await page.evaluate((t) => {
    const w = globalThis as unknown as { __moduleSpecs?: SpecShape[] };
    return w.__moduleSpecs?.find((s) => s.type === t) ?? null;
  }, type);
  expect(spec, `${type}: registered in the live registry (__moduleSpecs)`).toBeTruthy();
  return spec!;
}

/** Open the module's dock full-view and return the dock-tier shell locator. */
async function openDock(page: Page, nodeId: string) {
  const shell = page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible();
  const dockShell = faceplate.locator('[data-testid="module-shell"][data-shell-tier="dock"]');
  await expect(dockShell).toBeVisible();
  return dockShell;
}

test.describe('faces render-parity: every STRICT_FACES dock full-view carries the def’s FULL control surface', () => {
  for (const type of [...STRICT_FACES].sort()) {
    test(`${type}: dock control set === def param set (+families, no extras) and controls operate`, async ({ page }) => {
      await gotoShell(page);
      await spawnPatch(page, [{ id: 'm', type, position: { x: 460, y: 240 } }]);

      const spec = await readSpec(page, type);
      // The imported STRICT_FACES set and the live registry agree this module
      // is migrated (guards a stale import path / set drift).
      expect(spec.strictFace, `${type}: __moduleSpecs agrees it is STRICT_FACES-migrated`).toBe(true);

      const dockShell = await openDock(page, 'm');

      // ── 1. PARAM PARITY: exact id-multiset equality, DOM vs live def. ──
      const domIds = await dockShell
        .locator('[data-testid^="control-"]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')!.slice('control-'.length)));
      const defIds = spec.params.map((p) => p.id);
      expect(
        [...domIds].sort(),
        `${type}: dock full-view renders EXACTLY one interactive control per def param ` +
          `(missing = a lost control, duplicate/unknown = an unbacked extra)`,
      ).toEqual([...defIds].sort());

      // ── 2. FAMILY CELLS + no dead statics. ──
      await expect(
        dockShell.locator('[data-cell-kind="family"]'),
        `${type}: one rendered cell per declared control family`,
      ).toHaveCount(spec.controlFamilies?.length ?? 0);
      await expect(
        dockShell.locator('[data-cell-kind="static"]'),
        `${type}: no dead static cells — every rendered control is def-backed`,
      ).toHaveCount(0);

      // ── 3. OPERABILITY: drag the first continuous param, assert the graph
      //      param moves (presence without function is still a loss). ──
      const target = spec.params.find((p) => p.curve !== 'discrete') ?? spec.params[0];
      expect(target, `${type}: has at least one param to drive`).toBeTruthy();
      const knob = dockShell.locator(`[data-testid="control-${target!.id}"]`);
      await knob.scrollIntoViewIfNeeded();
      const before = await page.evaluate(
        ({ pid }) => {
          const w = globalThis as unknown as { __patch: { nodes: Record<string, { params?: Record<string, number> }> } };
          return w.__patch.nodes['m']?.params?.[pid] ?? null;
        },
        { pid: target!.id },
      );
      const box = (await knob.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 48, { steps: 6 });
      await page.mouse.up();
      await expect
        .poll(
          async () =>
            page.evaluate(
              ({ pid }) => {
                const w = globalThis as unknown as { __patch: { nodes: Record<string, { params?: Record<string, number> }> } };
                return w.__patch.nodes['m']?.params?.[pid] ?? null;
              },
              { pid: target!.id },
            ),
          { message: `${type}: dragging '${target!.id}' commits a param change into the graph` },
        )
        .not.toBe(before);
    });
  }
});

test.describe('tidyVco tune-cluster regression (the owner control-loss report)', () => {
  test('the tune cluster (detune + oct2) renders in the LANE full face AND the dock oscillator band', async ({ page }) => {
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'tv', type: 'tidyVco', position: { x: 460, y: 240 } }]);

    const shell = page.locator('.svelte-flow__node[data-id="tv"] [data-testid="module-shell"]');
    await expect(shell).toBeVisible();
    // The spawn reveal parks the zoom at 0.6 — the LOD 'full' band: the
    // richest IN-LANE face. The redesign must keep the tuning controls
    // visible here (the loss: detune ranked below the 6-cell plate cap and
    // oct2 outside the top-8 left the lane with ZERO tuning controls).
    await expect(shell).toHaveAttribute('data-shell-tier', 'full');
    await expect(shell.locator('[data-testid="control-detune"]'), 'lane full face: FINE (detune ¢)').toBeVisible();
    await expect(shell.locator('[data-testid="control-oct2"]'), 'lane full face: TUNE (oct2)').toBeVisible();

    // And the dock full-view keeps them in the OSCILLATOR section band (the
    // gallery-mock tune cluster placement).
    const dockShell = await openDock(page, 'tv');
    const oscBand = dockShell.locator('[data-face-page="oscillator"]');
    await expect(oscBand.locator('[data-testid="control-detune"]'), 'dock oscillator band: detune').toBeVisible();
    await expect(oscBand.locator('[data-testid="control-oct2"]'), 'dock oscillator band: oct2').toBeVisible();
  });
});
