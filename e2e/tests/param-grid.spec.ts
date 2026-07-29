// e2e/tests/param-grid.spec.ts
//
// DOM gate for <ParamGrid> — the PF-15 chip + PORTALED grid popover, the
// primitive dx7's algorithm picker (PR 4) is built on.
//
// It lands a PR before its first consumer, so there is no `face.paramCells`
// anywhere to exercise it through a real face yet. Three properties are worth
// pinning now rather than discovering from a red faces-parity run later, and
// all three are invisible to a unit test:
//
//  1. The popover is genuinely PORTALED OUT of its host. An absolutely
//     positioned one is clipped to NOTHING by `.rl-tile { overflow: hidden }`
//     and mispositioned under SvelteFlow's transformed pane — the exact bug
//     that made Selector portal its menu in the first place.
//  2. The CHIP carries `control-<paramId>`, NOT the portaled radiogroup.
//     faces-parity asserts exact multiset equality between the DOCK SHELL's
//     `control-*` testids and the def's params; a portaled node is not a
//     descendant of that shell, so a testid there would drop the param out of
//     the multiset and read as a LOST control.
//  3. Picking a cell COMMITS and CLOSES — plus the keyboard path (the chart is
//     32 cells; arrowing through it is how you audition topologies).
//
// Runs against the dev-only showcase route (the /dev/glyphs + live-glyphs
// precedent), which is gated on testHooksEnabled() and so is reachable in the
// `vite preview` bundle the CI shards use.

import { test, expect, type Page } from '@playwright/test';

async function gotoShowcase(page: Page): Promise<void> {
  await page.goto('/dev/param-grid');
  // WAIT ON HYDRATION, NOT ON PAINT. The route is server-rendered, so the chip
  // is visible a beat before Svelte attaches its click handler; a click in that
  // window is silently swallowed and the popover never opens. That was a REAL
  // flake — `--repeat-each=3` went 8/8 on the cold first pass and lost a
  // different test on each warm repeat. `data-hydrated` is set from the page's
  // `onMount`, which runs after its children have mounted, so this is a
  // by-construction signal rather than a wall-clock budget.
  await expect(page.locator('[data-testid="param-grid-page"][data-hydrated="true"]')).toBeVisible();
  await expect(page.getByTestId('grid-host')).toBeVisible();
}

const chip = (page: Page, pid: string) => page.getByTestId(`control-${pid}`);
const grid = (page: Page, pid: string) =>
  page.locator(`[role="radiogroup"][data-grid-param="${pid}"]`);

test.describe('ParamGrid — the chip', () => {
  test('is the param’s ONE control-<paramId> element, and announces a picker', async ({ page }) => {
    await gotoShowcase(page);
    const c = chip(page, 'algorithm');
    await expect(c).toBeVisible();
    await expect(c, 'the chip opens a dialog, not a listbox').toHaveAttribute(
      'aria-haspopup',
      'dialog',
    );
    await expect(c, 'closed to start').toHaveAttribute('aria-expanded', 'false');
    // Exactly one — the multiset property faces-parity depends on.
    await expect(page.locator('[data-testid="control-algorithm"]')).toHaveCount(1);
    // …and it reads the DECLARED format, not a bare number.
    await expect(c.locator('.val')).toHaveText('ALG 05');
  });

  test('renders NO grid until it is opened', async ({ page }) => {
    await gotoShowcase(page);
    await expect(grid(page, 'algorithm')).toHaveCount(0);
  });
});

test.describe('ParamGrid — the popover is PORTALED out of its clipping host', () => {
  test('the grid is not a descendant of the overflow-hidden host, and is visible', async ({ page }) => {
    await gotoShowcase(page);
    const host = page.getByTestId('grid-host');
    await chip(page, 'algorithm').click();

    const g = grid(page, 'algorithm');
    await expect(g, 'the grid opens').toBeVisible();
    // THE ASSERTION THIS SPEC EXISTS FOR: inside the host it is clipped to
    // nothing; outside it, it paints. Counting it under the host is the only
    // way to tell those two apart from the outside.
    await expect(
      host.locator('[role="radiogroup"][data-grid-param="algorithm"]'),
      'the grid must NOT live inside the clipping host — it is portaled to <body>',
    ).toHaveCount(0);

    // A 1..32 discrete range derives 32 cells, and the current value is lit.
    const cells = g.locator('[role="radio"]');
    await expect(cells).toHaveCount(32);
    await expect(g.locator('[aria-checked="true"]')).toHaveCount(1);
    await expect(g.locator('[data-testid="grid-algorithm-5"]')).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // And it has REAL painted size — a clipped popover would measure ~0.
    const box = (await g.boundingBox())!;
    expect(box.width, 'the portaled grid has real width').toBeGreaterThan(100);
    expect(box.height, 'the portaled grid has real height').toBeGreaterThan(40);
  });

  test('an outside click closes it without committing', async ({ page }) => {
    await gotoShowcase(page);
    await chip(page, 'algorithm').click();
    await expect(grid(page, 'algorithm')).toBeVisible();
    await page.locator('.backdrop').click();
    await expect(grid(page, 'algorithm')).toHaveCount(0);
    await expect(page.getByTestId('algorithm-value')).toHaveText('5');
  });
});

test.describe('ParamGrid — picking a cell', () => {
  test('commits the value and closes the picker', async ({ page }) => {
    await gotoShowcase(page);
    await chip(page, 'algorithm').click();
    await page.getByTestId('grid-algorithm-17').click();

    await expect(page.getByTestId('algorithm-value'), 'the pick commits').toHaveText('17');
    await expect(grid(page, 'algorithm'), 'and closes the picker').toHaveCount(0);
    await expect(chip(page, 'algorithm').locator('.val'), 'the chip follows').toHaveText('ALG 17');
  });

  test('arrow keys walk the chart and Enter commits the focused cell', async ({ page }) => {
    await gotoShowcase(page);
    await chip(page, 'algorithm').click();
    const g = grid(page, 'algorithm');
    await expect(g).toBeVisible();

    // Focus opens ON the current value (index 4 = ALG 05); one step right and
    // one row down (8 wide) lands on index 13 = ALG 14.
    await expect(g).toHaveAttribute('aria-activedescendant', 'algorithm-grid-cell-4');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await expect(g).toHaveAttribute('aria-activedescendant', 'algorithm-grid-cell-13');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('algorithm-value')).toHaveText('14');
    await expect(g).toHaveCount(0);
  });

  test('Escape closes without committing', async ({ page }) => {
    await gotoShowcase(page);
    await chip(page, 'algorithm').click();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Escape');
    await expect(grid(page, 'algorithm')).toHaveCount(0);
    await expect(page.getByTestId('algorithm-value'), 'Escape is not a commit').toHaveText('5');
  });
});

test.describe('ParamGrid — a DECLARED options roster wins over the derived range', () => {
  test('shows the authored labels, not the raw step numbers', async ({ page }) => {
    await gotoShowcase(page);
    await chip(page, 'mode').click();
    const cells = grid(page, 'mode').locator('[role="radio"]');
    await expect(cells).toHaveCount(3);
    await expect(cells).toHaveText(['LP', 'HP', 'BP']);
    await cells.nth(2).click();
    await expect(page.getByTestId('mode-value')).toHaveText('2');
    await expect(chip(page, 'mode').locator('.val')).toHaveText('BP');
  });
});
