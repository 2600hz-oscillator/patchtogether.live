// e2e/tests/stereo-autowire.spec.ts
//
// WORKSTREAM A item 6 — module-wide stereo L/R auto-wire.
//
// Behaviour: patching L (or R) of a stereo SOURCE into a stereo-accepting
// TARGET whose sibling input is currently UNPATCHED auto-wires the OTHER side
// too — in ONE action. Decided defaults exercised here:
//   * BOTH source + target must declare a matching stereoPairs sibling
//     (out_l→in_l implies out_r→in_r), else no auto-wire.
//   * a MONO source into a stereo target's L leaves the sibling UNPATCHED
//     (the engine normals R←L).
//   * skip if the sibling target input is already occupied (no overwrite).
//   * naming-agnostic — resolved via stereoPairs tuples, not name patterns
//     (rings odd/even, cofefve inL/inR, charlottes-echos L/R).
//
// These drive the REAL redesigned "patch to" commit path (open the source
// menu → drill OUTPUT → jack-click the source output ROW (carry) → "patch
// to" → pick the target module → pick the target INPUT port →
// pickPortMenuTarget → writeStereoSiblingEdge), so they assert the WIRED
// commit site through a real user gesture, not just the pure planner (which
// is unit-tested in stereo-autowire.test.ts).

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

interface PatchEdge {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
}

async function readEdges(page: Page): Promise<PatchEdge[]> {
  return await page.evaluate(() => {
    const w = window as unknown as { __patch: { edges: Record<string, PatchEdge> } };
    return Object.values(w.__patch.edges).filter(Boolean) as PatchEdge[];
  });
}

function hasEdge(edges: PatchEdge[], from: [string, string], to: [string, string]): boolean {
  return edges.some(
    (e) =>
      e.source.nodeId === from[0] &&
      e.source.portId === from[1] &&
      e.target.nodeId === to[0] &&
      e.target.portId === to[1],
  );
}

function chrome(page: Page, nodeId: string) {
  return page.locator(`[data-patch-panel-chrome="${nodeId}"]`);
}

async function openMenu(page: Page, nodeId: string) {
  await page
    .locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-trigger"]`)
    .click();
  await expect(chrome(page, nodeId)).toHaveAttribute('aria-hidden', 'false');
}

/** Drive the REAL redesigned commit: carry a SOURCE output port (jack-click
 *  the OUTPUT row), open the "patch to" picker, pick the target module + its
 *  INPUT port — committing via pickPortMenuTarget (the wired stereo-autowire
 *  commit site). */
async function cascadePatch(
  page: Page,
  src: { nodeId: string; portId: string },
  dst: { nodeId: string; portId: string },
) {
  await openMenu(page, src.nodeId);
  await chrome(page, src.nodeId)
    .locator('[data-testid="patch-panel-nav"][data-nav="outputs"]')
    .click();
  await chrome(page, src.nodeId)
    .locator(`[data-testid="patch-panel-port-row"][data-port-id="${src.portId}"]`)
    .click();
  await page.mouse.move(500, 320);
  await chrome(page, src.nodeId).locator('[data-testid="patch-panel-patch-to"]').click();
  const menu = page.locator('[data-testid="port-context-menu"]');
  await expect(menu).toBeVisible();

  await menu.locator(`[data-testid="patch-to-module"][data-node-id="${dst.nodeId}"]`).click();
  const portRow = menu.locator(`[data-testid="patch-to-port"][data-port-id="${dst.portId}"]`);
  await expect(portRow).toBeVisible();
  await portRow.click();
  await expect(menu).toHaveCount(0);
}

test.describe('stereo L/R auto-wire', () => {
  test('stereo source L → stereo target L auto-wires R too (rings odd/even → cofefve inL/inR)', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'rings', type: 'rings', position: { x: 80, y: 100 } },
      { id: 'coco', type: 'cofefve', position: { x: 760, y: 100 } },
    ]);

    // Patch the L side only: rings.odd → cofefve.inL.
    await cascadePatch(page, { nodeId: 'rings', portId: 'odd' }, { nodeId: 'coco', portId: 'inL' });

    // BOTH edges must materialize from the single action.
    await expect
      .poll(async () => {
        const edges = await readEdges(page);
        return hasEdge(edges, ['rings', 'odd'], ['coco', 'inL']) && hasEdge(edges, ['rings', 'even'], ['coco', 'inR']);
      }, { timeout: 2000 })
      .toBe(true);
  });

  test('occupied sibling target input is NOT overwritten', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'rings', type: 'rings', position: { x: 80, y: 100 } },
      { id: 'coco', type: 'cofefve', position: { x: 760, y: 100 } },
    ]);
    // Pre-occupy cofefve.inR with a manual edge from a different source port.
    await page.evaluate(() => {
      const w = window as unknown as {
        __patch: { edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.edges['manual-inR'] = {
          id: 'manual-inR',
          source: { nodeId: 'rings', portId: 'even' },
          target: { nodeId: 'coco', portId: 'inR' },
          sourceType: 'audio',
          targetType: 'audio',
        };
      });
    });

    // Now patch rings.odd → cofefve.inL. inR is occupied → no NEW auto-wire.
    await cascadePatch(page, { nodeId: 'rings', portId: 'odd' }, { nodeId: 'coco', portId: 'inL' });

    await expect
      .poll(async () => hasEdge(await readEdges(page), ['rings', 'odd'], ['coco', 'inL']), { timeout: 2000 })
      .toBe(true);
    const edges = await readEdges(page);
    // The pre-existing manual inR edge survives.
    expect(edges.some((e) => e.id === 'manual-inR')).toBe(true);
    // No duplicate canonical auto-wired edge id.
    expect(edges.some((e) => e.id === 'e-rings-even-coco-inR')).toBe(false);
  });

  test('MONO source into a stereo target L leaves the sibling UNPATCHED', async ({ page, rack }) => {
    // analogVco's `saw` is a mono audio output (no stereoPairs) → no auto-wire.
    await spawnPatch(page, [
      { id: 'vco', type: 'analogVco', position: { x: 80, y: 100 } },
      { id: 'coco', type: 'cofefve', position: { x: 760, y: 100 } },
    ]);

    await cascadePatch(page, { nodeId: 'vco', portId: 'saw' }, { nodeId: 'coco', portId: 'inL' });

    await expect
      .poll(async () => hasEdge(await readEdges(page), ['vco', 'saw'], ['coco', 'inL']), { timeout: 2000 })
      .toBe(true);
    // Sibling inR stays unpatched (engine normals R←L).
    const edges = await readEdges(page);
    expect(edges.some((e) => e.target.nodeId === 'coco' && e.target.portId === 'inR')).toBe(false);
  });

  test('naming-agnostic target (charlottes-echos L/R): clouds out_l → L auto-wires out_r → R', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'clouds', type: 'clouds', position: { x: 80, y: 100 } },
      { id: 'ce', type: 'charlottesEchos', position: { x: 760, y: 100 } },
    ]);

    // clouds.out_l → charlottes-echos.L (input) ⇒ out_r → R auto-wired.
    await cascadePatch(page, { nodeId: 'clouds', portId: 'out_l' }, { nodeId: 'ce', portId: 'L' });

    await expect
      .poll(async () => {
        const edges = await readEdges(page);
        return hasEdge(edges, ['clouds', 'out_l'], ['ce', 'L']) && hasEdge(edges, ['clouds', 'out_r'], ['ce', 'R']);
      }, { timeout: 2000 })
      .toBe(true);
  });
});
