// e2e/tests/vca-face.spec.ts
//
// THE VCA FACE, driven for real: the two knob readouts must follow the GRAPH,
// not merely re-label themselves.
//
// faces-parity already proves every vca cell is present and operable. What it
// cannot prove is the thing this face's rework is FOR — that the persistent
// readouts (`ParamDef.format` → KnobConic's `.readout`) tell the truth about
// the module's mode. A readout is a string a component computes, so the failure
// mode is a DOM that re-labels itself while the graph never moved (or, worse,
// the graph moving while the readout stays put because it was wired to a stale
// local). Every assertion below therefore pins BOTH sides: the committed
// `__patch` param value AND the text the dial prints for it.
//
// The drags are deliberately PAST the end of the arc — `knobFracToValue` clamps
// its fraction to [0,1] — so each gesture lands on an EXACT endpoint (−1 / +1)
// rather than on "somewhere lower". That makes the expected param value a
// literal instead of an inequality, and it is renderer-independent: no frame
// budget, no wall-clock, no tuning.
//
// Runs on /rack?mode=workflow (no DB, no relay) — the normal e2e lane.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

/** Boot the migrated shell (`?shell=1`) and wait for the workflow chrome. */
async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack?mode=workflow&shell=1');
  // The BOOT wait: the first test of a run pays SvelteKit's on-demand /rack
  // compile. Same bound the sibling workflow specs carry.
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({
    timeout: SLOW_RENDER ? 30_000 : 15_000,
  });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Open the module's dock full-view and return the dock-tier shell. */
async function openDock(page: Page, nodeId: string): Promise<Locator> {
  const shell = page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const dockShell = page
    .getByTestId('dock-full-view')
    .locator('[data-testid="module-shell"][data-shell-tier="dock"]');
  await expect(dockShell).toBeVisible();
  return dockShell;
}

/** The COMMITTED graph value of one param (null when the node never stored it —
 *  a fresh spawn only materialises a param once something writes it). */
function readParam(page: Page, nodeId: string, pid: string): Promise<number | null> {
  return page.evaluate(
    ({ nodeId, pid }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> } | undefined> };
      };
      const v = w.__patch.nodes[nodeId]?.params?.[pid];
      return typeof v === 'number' ? v : null;
    },
    { nodeId, pid },
  );
}

/** Drag a dial VERTICALLY by `dy` px (negative = up = toward max). Overshooting
 *  the arc is intentional — see the header. */
async function dragDial(page: Page, dial: Locator, dy: number): Promise<void> {
  await dial.scrollIntoViewIfNeeded();
  const box = (await dial.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + dy, { steps: 8 });
  await page.mouse.up();
}

test.describe('vca face — the knob readouts follow the graph', () => {
  test('base and cvAmount name the module’s MODE, and each name is backed by a committed param', async ({
    page,
  }) => {
    test.setTimeout(SLOW_RENDER ? 60_000 : 30_000);
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'v', type: 'vca', position: { x: 460, y: 240 } }]);
    const dock = await openDock(page, 'v');

    // ── The band header IS the module: the gain law, not a house word. ──
    await expect(
      dock.locator('[data-face-page="gain"] .page-label'),
      'the single dock band states the gain law',
    ).toHaveText('gain = base + cv × amount');

    // ── SPAWN STATE. The defaults are base 0 / cvAmount 1, and the two
    //    readouts must say what those numbers MEAN — `CLOSED` is the module's
    //    whole spawn-time surprise (silent until CV arrives). ──
    const baseOut = dock.getByTestId('readout-base');
    const cvOut = dock.getByTestId('readout-cvAmount');
    await expect(baseOut, 'a fresh VCA announces that it is shut').toHaveText('CLOSED');
    await expect(cvOut, 'and that positive CV will open it').toHaveText('OPEN');

    const baseDial = dock.locator('[data-testid="control-base"]');
    const cvDial = dock.locator('[data-testid="control-cvAmount"]');

    // ── THE ATTENUVERTER FLIP. Drag cvAmount past the bottom of its arc: the
    //    fraction clamps, so this lands on exactly −1. The graph must carry it
    //    AND the dial must stop claiming the VCA opens. ──
    await dragDial(page, cvDial, 260);
    await expect
      .poll(() => readParam(page, 'v', 'cvAmount'), {
        message: 'dragging the dial COMMITS the new depth into the graph',
      })
      .toBe(-1);
    await expect(cvOut, 'a negative amount is a DUCKER, and the dial says so').toHaveText('DUCK');

    // ── THE FLOOR. Drag base past the top: exactly 1, i.e. unity passthrough
    //    with no CV at all. ──
    await dragDial(page, baseDial, -260);
    await expect
      .poll(() => readParam(page, 'v', 'base'), {
        message: 'the floor knob commits its value into the graph',
      })
      .toBe(1);
    await expect(baseOut, 'a floor of 1 is unity passthrough').toHaveText('UNITY');

    // ── THE NEGATIVE-CONTROL SHAPE, INLINE: move the OTHER knob and confirm
    //    this readout does NOT change. Without it, a readout hard-coded to
    //    'UNITY' would pass every assertion above.  ──
    await dragDial(page, cvDial, -260); // cvAmount back to +1
    await expect.poll(() => readParam(page, 'v', 'cvAmount')).toBe(1);
    await expect(cvOut).toHaveText('OPEN');
    await expect(baseOut, 'base’s readout is bound to base, not to whatever moved last').toHaveText(
      'UNITY',
    );
    expect(await readParam(page, 'v', 'base'), 'and base itself did not move').toBe(1);
  });
});
