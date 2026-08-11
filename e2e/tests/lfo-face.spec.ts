// e2e/tests/lfo-face.spec.ts
//
// The LFO's curated FACE — the three claims no other gate can make.
//
// What the existing gates DO cover: the face SHAPE (module-face-lint's
// dockFacePlan parity + the rear-card-model pin), the ARITHMETIC
// (lfo-face-model.test.ts, pure), the CONTRACT (contract-lock), and the
// DEFAULT-STATE PIXELS (the two `face-lfo-*` VRT baselines).
//
// What NOTHING covered before this spec:
//
//  1. THE PAGE COLLAPSE IS REAL IN THE DOM. The face merged two dock bands into
//     one. `dockFacePlan` is a pure function and the VRT baseline is one image
//     — neither of them says the SHELL actually renders one labeled band with
//     all three knobs inside it.
//
//  2. THE READOUTS TRACK THE GRAPH, NOT THEMSELVES. `format` is a pure function
//     the unit test already pins; the risk it cannot see is the WIRING — a
//     readout bound to a stale value, a default, or the wrong param prints a
//     perfectly plausible string forever. So each assertion here reads the LIVE
//     `__patch` value and requires the printed text to follow it. A DOM-only
//     "the label changed" assertion would pass on a control that never
//     committed anything, which is the failure this is written against.
//
//  3. THE UNIT SWITCH SURVIVES A REAL GESTURE. `lfoRateReadout` flips Hz→s at
//     1 Hz. The interesting case is a drag that CROSSES that boundary, because
//     that is the one moment the readout's units change under the user's hand.
//
// Runs on /rack (no DB/relay) — the normal e2e lane.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({
    timeout: SLOW_RENDER ? 30_000 : 15_000,
  });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Open the module's dock full-view and return the dock-tier shell locator. */
async function openDock(page: Page, nodeId: string): Promise<Locator> {
  const shell = page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible();
  const dockShell = faceplate.locator('[data-testid="module-shell"][data-shell-tier="dock"]');
  await expect(dockShell).toBeVisible();
  return dockShell;
}

/**
 * The EFFECTIVE live value of one param — the authority every assertion below
 * anchors on. A DOM read alone cannot tell a committed edit from a repaint.
 *
 * ⚠ A freshly spawned node writes NO params: `node.params` is empty until
 * something commits, so a raw read returns null and "the module boots at 1 Hz"
 * would be untestable. The fallback is the DEF's own defaultValue, taken from
 * the live registry projection (`__moduleSpecs`) rather than re-typed here —
 * the same single-source rule the face itself follows.
 */
function readParam(page: Page, nodeId: string, pid: string): Promise<number | null> {
  return page.evaluate(
    ({ nodeId, pid }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { type?: string; params?: Record<string, number> } | undefined> };
        __moduleSpecs?: { type: string; params?: { id: string; defaultValue: number }[] }[];
      };
      const node = w.__patch.nodes[nodeId];
      const committed = node?.params?.[pid];
      if (typeof committed === 'number') return committed;
      const spec = w.__moduleSpecs?.find((s) => s.type === node?.type);
      return spec?.params?.find((p) => p.id === pid)?.defaultValue ?? null;
    },
    { nodeId, pid },
  );
}

// ⚠ THE READOUT'S CASE IS CSS, NOT TEXT. `.readout` carries
// `text-transform: uppercase`, so the pixels say `SINE` while `textContent` —
// which is what `toHaveText` compares — still says `sine`. Asserting the SHOWN
// case is a guaranteed false failure; assert the authored string.

/** Drag a KnobConic vertically by `dy` px (negative = up = raise). The dial
 *  maps ~200 px to the whole arc, so the caller sizes the gesture in terms of
 *  the fraction of range it wants to cross. */
async function dragKnobBy(page: Page, knob: Locator, dy: number): Promise<void> {
  await knob.scrollIntoViewIfNeeded();
  const box = (await knob.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + dy, { steps: 8 });
  await page.mouse.up();
}

test.describe('lfo curated face', () => {
  test('the dock renders ONE band holding all three knobs, in signal order', async ({ page }) => {
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'lf', type: 'lfo', position: { x: 460, y: 240 } }]);
    const dockShell = await openDock(page, 'lf');

    // ONE section band. The face merged `shape` (which held a single knob) into
    // `engine`: rate → shape → depth is one oscillator with three stages, not
    // two blocks. `dockFacePlan` says so purely; this says the shell agrees.
    const bands = dockShell.getByTestId('face-page');
    await expect(bands, 'the face declares exactly one dock page').toHaveCount(1);
    await expect(bands.first()).toHaveAttribute('data-face-page', 'engine');

    // …and the band CONTAINS the whole control surface, in the page's declared
    // SIGNAL order — which is deliberately NOT face.order's priority ranking
    // (rate, depth, shape). If those two ever got "reconciled", this flips.
    const keys = await bands
      .first()
      .locator('[data-cell-key]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-cell-key')));
    expect(keys, 'signal chain: phase advances at RATE, maps through SHAPE, scales by DEPTH').toEqual(
      ['rate', 'shape', 'depth'],
    );

    // The band header teaches the fact the three captions underneath it do not.
    await expect(bands.first()).toContainText('one oscillator');
  });

  test('RATE: a drag commits into the graph and the readout follows it across the Hz→s switch', async ({
    page,
  }) => {
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'lf', type: 'lfo', position: { x: 460, y: 240 } }]);
    const dockShell = await openDock(page, 'lf');

    const knob = dockShell.locator('[data-testid="control-rate"]');
    const readout = dockShell.locator('[data-testid="readout-rate"]');

    // Boot state: 1 Hz is exactly the crossover, and it reads as a FREQUENCY.
    expect(await readParam(page, 'lf', 'rate')).toBe(1);
    await expect(readout, 'the default sits on the crossover and reads in Hz').toHaveText('1.00 Hz');

    // Drag DOWN ~30 % of the arc. On the log 0.01..100 curve that lands well
    // under 1 Hz — into the region where a frequency readout stops helping.
    await dragKnobBy(page, knob, +60);

    // THE GRAPH MOVED. This is the assertion that matters: a DOM-only check
    // would pass on a knob that repainted without committing anything.
    await expect
      .poll(() => readParam(page, 'lf', 'rate'), {
        message: 'dragging RATE commits a smaller rate into the graph',
      })
      .toBeLessThan(1);
    const committed = (await readParam(page, 'lf', 'rate'))!;
    expect(committed, 'still inside the def range').toBeGreaterThanOrEqual(0.01);

    // …and the readout switched UNITS and agrees with that exact value: it now
    // prints the PERIOD, 1/rate seconds, to the formatter's own precision.
    const period = 1 / committed;
    const expected = period >= 100 ? period.toFixed(0) : period >= 10 ? period.toFixed(1) : period.toFixed(2);
    await expect(readout, 'below 1 Hz the readout is the PERIOD of the committed rate').toHaveText(
      `${expected} s`,
    );
  });

  test('SHAPE: a drag commits the morph and the readout names the NEAREST anchor', async ({ page }) => {
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'lf', type: 'lfo', position: { x: 460, y: 240 } }]);
    const dockShell = await openDock(page, 'lf');

    const knob = dockShell.locator('[data-testid="control-shape"]');
    const readout = dockShell.locator('[data-testid="readout-shape"]');

    expect(await readParam(page, 'lf', 'shape')).toBe(0);
    await expect(readout, 'shape 0 is the SINE anchor').toHaveText('sine');

    // Up ~30 % of a 0..2 linear range ≈ 0.6 — past the midpoint between the
    // SINE and SAW anchors, so the nearest-landmark readout must flip. It is
    // NOT a detent: the committed value is a real blend, not a snap to 1.
    await dragKnobBy(page, knob, -60);

    await expect
      .poll(() => readParam(page, 'lf', 'shape'), {
        message: 'dragging SHAPE commits the morph into the graph',
      })
      .toBeGreaterThan(0.5);
    const committed = (await readParam(page, 'lf', 'shape'))!;
    await expect(readout, 'the readout names the nearest anchor').toHaveText('saw');
    expect(
      committed,
      'landmarks DECORATE a continuous morph — they must not quantize it to the anchor',
    ).not.toBe(1);
    expect(committed).toBeLessThanOrEqual(2);
  });

  test('DEPTH: the readout prints the SWING the module emits, not the knob position', async ({
    page,
  }) => {
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'lf', type: 'lfo', position: { x: 460, y: 240 } }]);
    const dockShell = await openDock(page, 'lf');

    const knob = dockShell.locator('[data-testid="control-depth"]');
    const readout = dockShell.locator('[data-testid="readout-depth"]');

    // The whole reason this readout exists: the graph holds 0.5 and the module
    // swings ±1. Printing "0.50" is what made depth the most misread control
    // on the face.
    expect(await readParam(page, 'lf', 'depth')).toBe(0.5);
    await expect(readout, 'the default is UNITY, not "half"').toHaveText('±1.00');

    // Down to the floor: gain = max(0, depth) * 2 is exactly 0 there, all four
    // taps go flat, and that is a MODE rather than a level.
    await dragKnobBy(page, knob, +200);
    await expect
      .poll(() => readParam(page, 'lf', 'depth'), { message: 'DEPTH commits into the graph' })
      .toBe(0);
    await expect(readout, 'zero swing reads as a state, not ±0.00').toHaveText('still');
  });
});
