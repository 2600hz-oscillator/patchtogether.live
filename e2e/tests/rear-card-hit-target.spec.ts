// e2e/tests/rear-card-hit-target.spec.ts
//
// REAR CARD — the WHOLE CELL is the patch control, not the hole.
//
// Owner 2026-08-11: "the whole text area should be clickable, no reason to
// force it to just be the jack."
//
// MEASURED FIRST, and the answer was half good news: the cell has always BEEN
// one <button> (the hole is a decorative <span> inside it), so a click on the
// label already reached the carry seam. What did NOT read as a control was the
// AFFORDANCE — the only conspicuous hover cue was the hole scaling 12%, over a
// 3%-white cell wash nobody can see, so a control that accepts a click
// anywhere LOOKED like a 26px circle. The same PR shrinks that circle to
// 15.6px, which makes the gap worse, so the cue moved onto the row.
//
// This spec pins BOTH halves against regression, because neither is visible
// from a screenshot:
//
//   1) BEHAVIOUR — clicking the LABEL (never the hole) starts the carry, and
//      clicking a second cell's LABEL commits the SAME validated edge. Both
//      directions: an input cell (label above hole) and an OUTPUTS-rail tile
//      (hole beside label). Every click point is asserted to lie OUTSIDE the
//      hole's box first, so the test cannot pass by accidentally hitting the
//      jack — that guard is the whole reason the assertion means anything.
//   2) AFFORDANCE — hovering the LABEL lights the CELL, not just the hole.
//      Negative-controlled in the same test: the same cell, unhovered, must
//      read as un-lit, so a rule that painted every cell always would fail.
//
// Runs on /rack, same recipe as workflow-rear-card.spec.ts.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

// Serial: drives the shared connect-drag singleton through real clicks.
test.describe.configure({ mode: 'serial' });

async function gotoWorkflow(page: Page): Promise<void> {
  await page.goto('/rack');
  // 15s FIRST-LOAD budget — the CI-validated number this route already uses
  // (SvelteKit dev compiles /rack on demand; only the first nav pays it).
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 15_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

async function openFullView(page: Page, nodeId: string): Promise<void> {
  await page.waitForFunction(
    () => typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView === 'function',
  );
  await page.evaluate(
    (id) => (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView(id),
    nodeId,
  );
  await expect(page.locator(`[data-testid="dock-full-view"][data-fullview-node="${nodeId}"]`)).toBeVisible();
}

function rearCard(page: Page) {
  return page.getByTestId('dock-full-view').getByTestId('rear-card');
}
function rearJack(page: Page, portId: string, direction: 'input' | 'output') {
  return rearCard(page).locator(
    `[data-testid="back-jack"][data-port-id="${portId}"][data-direction="${direction}"]`,
  );
}

async function pickupMode(page: Page): Promise<{ mode: string; portId: string | null }> {
  return page.evaluate(() => {
    const s = (window as unknown as {
      __connectDragState: { mode: string; pickupSource: { portId: string } | null };
    }).__connectDragState;
    return { mode: s.mode, portId: s.pickupSource?.portId ?? null };
  });
}

/**
 * Click a cell's LABEL and PROVE the click point missed the hole.
 *
 * Without the guard this whole spec is decoration: Playwright clicks an
 * element's centre, the label sits directly above/beside the hole, and a
 * layout change that put them on top of each other would leave every
 * assertion below passing for the wrong reason.
 */
async function clickLabelOffHole(page: Page, portId: string, direction: 'input' | 'output') {
  const cell = rearJack(page, portId, direction);
  const label = cell.getByTestId('jack-label');
  const geom = await cell.evaluate((el) => {
    const lab = el.querySelector('[data-testid="jack-label"]')!.getBoundingClientRect();
    const hole = el.querySelector('.hole')!.getBoundingClientRect();
    return {
      point: { x: lab.left + lab.width / 2, y: lab.top + lab.height / 2 },
      hole: { l: hole.left, t: hole.top, r: hole.right, b: hole.bottom },
      holeDia: hole.width,
    };
  });
  const { point, hole } = geom;
  const insideHole =
    point.x >= hole.l && point.x <= hole.r && point.y >= hole.t && point.y <= hole.b;
  expect(
    insideHole,
    `${portId}: the label click point (${point.x.toFixed(1)}, ${point.y.toFixed(1)}) CSS px must fall ` +
      `outside the ${geom.holeDia.toFixed(1)} px hole [${hole.l.toFixed(1)}–${hole.r.toFixed(1)} x ` +
      `${hole.t.toFixed(1)}–${hole.b.toFixed(1)}] — otherwise this test is clicking the jack`,
  ).toBe(false);
  await label.click();
  return geom;
}

// ── 1. the label is the control: carry starts and commits from the TEXT ─────

test('the whole cell is the patch control: clicking the LABEL (never the hole) carries and commits', async ({
  page,
}) => {
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: 'env', type: 'adsr', position: { x: 460, y: 240 } }]);
  await openFullView(page, 'env');
  await page.keyboard.press('Tab');
  await expect(rearCard(page)).toBeVisible();

  const readEdges = () =>
    page.evaluate(() => {
      const w = window as unknown as {
        __patch: {
          edges: Record<string, { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } } | undefined>;
        };
      };
      return Object.values(w.__patch.edges)
        .filter(Boolean)
        .map((e) => `${e!.source.nodeId}.${e!.source.portId}→${e!.target.nodeId}.${e!.target.portId}`)
        .sort();
    });
  const baseline = await readEdges();
  expect(baseline.filter((e) => e.includes('env.')), 'no edge touches the spawned adsr yet').toEqual([]);

  // PICK UP from the OUTPUTS-rail tile's TEXT. That tile lays the hole BESIDE
  // the label, so it exercises the row-shaped cell; the input cells below
  // exercise the column-shaped one.
  await clickLabelOffHole(page, 'env', 'output');
  expect(await pickupMode(page), 'clicking the output tile TEXT began the carry').toEqual({
    mode: 'pickup',
    portId: 'env',
  });

  // COMMIT on an INPUT cell's TEXT (label above hole).
  await clickLabelOffHole(page, 'attack', 'input');
  await expect.poll(readEdges, { message: 'the label-to-label patch wrote the same validated edge a hole-to-hole patch does' })
    .toEqual([...baseline, 'env.env→env.attack'].sort());
  expect((await pickupMode(page)).mode, 'carry ended on commit').toBe('idle');
  await expect(rearJack(page, 'attack', 'input')).toHaveAttribute('data-patched', 'true');

  // And the label is not a one-way door: a label click on an UNPATCHED input
  // starts a carry that ESC drops without writing.
  await clickLabelOffHole(page, 'sustain', 'input');
  expect((await pickupMode(page)).mode).toBe('pickup');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await pickupMode(page)).mode).toBe('idle');
  expect(await readEdges(), 'Esc discarded — exactly one edge was ever added').toEqual(
    [...baseline, 'env.env→env.attack'].sort(),
  );
});

// ── 2. the affordance sits on the ROW, not on the hole ──────────────────────

test('hovering the LABEL lights the whole cell (and an unhovered cell stays un-lit)', async ({
  page,
}) => {
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: 'env2', type: 'adsr', position: { x: 460, y: 240 } }]);
  await openFullView(page, 'env2');
  await page.keyboard.press('Tab');
  await expect(rearCard(page)).toBeVisible();

  const cell = rearJack(page, 'attack', 'input');
  const other = rearJack(page, 'decay', 'input');
  const paint = (loc: ReturnType<typeof rearJack>) =>
    loc.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { background: cs.backgroundColor, shadow: cs.boxShadow };
    });

  // NEGATIVE CONTROL, taken first and re-taken at the end: with the pointer
  // parked away from the field, the cell is a bare transparent box. A rule
  // that lit every cell unconditionally would fail here, so the positive leg
  // below cannot pass vacuously.
  await page.mouse.move(4, 4);
  const idle = await paint(cell);
  expect(idle.background, 'idle cell has no fill').toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  expect(idle.shadow, 'idle cell has no ring').toMatch(/none/);

  // Hover the LABEL — the point that is NOT the hole.
  await cell.getByTestId('jack-label').hover();
  const hovered = await paint(cell);
  expect(hovered.background, 'hovering the label fills the WHOLE cell').not.toBe(idle.background);
  expect(hovered.shadow, 'hovering the label rings the WHOLE cell').not.toMatch(/^none$/);

  // …and only that cell. A sibling stays idle, so the cue localises the
  // control instead of washing the band.
  expect(await paint(other), 'the sibling cell is untouched').toEqual(idle);

  await page.mouse.move(4, 4);
  await expect.poll(async () => (await paint(cell)).background).toBe(idle.background);
});
