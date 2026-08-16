// e2e/tests/featurecv-face.spec.ts
//
// THE FEATURECV FACE, driven for real — and specifically the SEAM the other
// three gates cannot see.
//
// `faces-parity` proves the six cells are present and operable.
// `featurecv-face-model.test.ts` proves the arithmetic. `analysis.test.ts`
// proves the arithmetic is what the shipping worklet does. None of them can see
// that the DOM PRINTS AND DRAWS what the model computes, for the live graph
// value, and keeps doing so when the value moves.
//
// ⚠ AND ONE CLAIM ON THIS FACE IS ONLY CHECKABLE HERE. The `featurecv-maps`
// sidebar picture asserts, in its own caption, that GAIN reaches LOUD and
// NOTHING ELSE — three rails, one of which moves with the trim and two of which
// must not. That is a NEGATIVE control on a PICTURE, and a picture is exactly
// where a wrong one is hardest to notice: a panel that redrew all three rails
// with GAIN would look more responsive, not more broken. The `noise-taps`
// precedent (noise-face.spec.ts) is the shape.
//
// Every expectation below is computed by `$lib/ui/modules/featurecv-face-model`
// — the SAME functions the readout registry and the panel call — so a change to
// the arithmetic moves the test and the product together, and the assertions
// that carry real information are the RELATIONS (distinct / invariant / moved),
// not the literals.
//
// Runs on /rack (no DB, no relay). The faceplate shell is the DEFAULT rack since
// #1459.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import {
  FEATURECV_FEATURES,
  FEATURECV_SOURCES,
  featurecvFaceParams,
  featurecvIdleText,
  featurecvMaxRateText,
  featurecvProbeText,
  featurecvSourceCv,
  featurecvThreshText,
  type FeaturecvFeature,
} from '../../packages/web/src/lib/ui/modules/featurecv-face-model';

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

/** The face's params at an explicit overlay, in the shape the model reads. */
const at = (over: Record<string, number> = {}) =>
  featurecvFaceParams((id) => over[id]);

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({
    timeout: SLOW_RENDER ? 30_000 : 15_000,
  });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

async function spawnFeaturecv(page: Page): Promise<string> {
  const id = 'featurecv-face-1';
  await spawnPatch(page, [{ id, type: 'featurecv', position: { x: 240, y: 200 } }]);
  return id;
}

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

/** Write a param straight into the graph. The point is to land on an EXACT
 *  value so the expectation is computable; the GESTURE is faces-parity's job. */
async function setParam(page: Page, nodeId: string, key: string, value: number): Promise<void> {
  await page.evaluate(
    ({ nodeId, key, value }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[nodeId];
        n.params = { ...(n.params ?? {}), [key]: value };
      });
    },
    { nodeId, key, value },
  );
}

/** One hero readout, by its registered `valueId`. */
const heroReadout = (dock: Locator, valueId: string): Locator =>
  dock.locator(`[data-hero-readout="${valueId}"] dd`);

/**
 * Every readout the hero ACTUALLY PAINTED, read off the rendered faceplate.
 *
 * ⚠ DERIVED FROM THE ARTIFACT, not from a list — so a fifth readout enrols
 * itself in the distinctness clause below and a readout that silently stopped
 * rendering shrinks the set rather than being skipped. (The def is deliberately
 * NOT imported here: `$lib/audio/modules/featurecv` pulls its worklet in through
 * a `?url` import that node cannot resolve outside vite, which is why every
 * other face spec imports the pure model and never the def.)
 */
async function paintedHeroReadouts(dock: Locator): Promise<string[]> {
  return dock.locator('[data-hero-readout]').evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-hero-readout') ?? '').filter(Boolean),
  );
}

/** The maps panel — rendered OUTSIDE the ModuleShell subtree (DockFullView owns
 *  the `.page.has-sidebar` grid), so it is scoped to the dock view. */
const mapsPanel = (page: Page): Locator =>
  page.getByTestId('dock-full-view').getByTestId('sidebar-panel-featurecv-maps');

/** The CV a marker claims, straight off the DOM. */
async function markerCv(page: Page, feature: FeaturecvFeature, srcId: string): Promise<number> {
  const v = await mapsPanel(page)
    .getByTestId(`featurecv-mark-${feature}-${srcId}`)
    .getAttribute('data-cv');
  return Number(v);
}

/** Every marker on the picture, as `feature/source -> cv`. */
async function allMarkers(page: Page): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const feature of FEATURECV_FEATURES) {
    for (const src of FEATURECV_SOURCES) {
      out[`${feature}/${src.id}`] = await markerCv(page, feature, src.id);
    }
  }
  return out;
}

test.describe('featurecv face — the numbers no dial prints, and the picture that must not lie', () => {
  test('the hero prints four DERIVED values, and each follows the graph on its own dial', async ({
    page,
  }) => {
    await gotoShell(page);
    const id = await spawnFeaturecv(page);
    const dock = await openDock(page, id);

    // 1 · AT THE DEFAULTS. A fresh spawn has NO stored params — `node.params`
    // is a sparse overlay — so this also proves the def-default fallback in
    // `featurecvFaceParams` is wired, not merely the live read.
    await expect(heroReadout(dock, 'featurecv-idle')).toHaveText(featurecvIdleText(at()));
    await expect(heroReadout(dock, 'featurecv-probe')).toHaveText(featurecvProbeText(at()));
    await expect(heroReadout(dock, 'featurecv-thresh')).toHaveText(featurecvThreshText(at()));
    await expect(heroReadout(dock, 'featurecv-max-rate')).toHaveText(featurecvMaxRateText(at()));

    // 2 · THE PROPERTY A KNOB-RELABELLED READOUT CANNOT HAVE: every hero
    // readout prints a DIFFERENT string, and none of them is any dial's printed
    // value. The roster is read off the RENDERED faceplate, so a fifth readout
    // enrols itself here and a readout that stopped painting shrinks the set
    // rather than being skipped.
    const painted = await paintedHeroReadouts(dock);
    expect(painted, 'the hero paints its declared readouts').toEqual(
      expect.arrayContaining([
        'featurecv-idle',
        'featurecv-probe',
        'featurecv-thresh',
        'featurecv-max-rate',
      ]),
    );
    const texts = await Promise.all(painted.map((v) => heroReadout(dock, v).textContent()));
    expect(
      new Set(texts).size,
      `every hero readout must be distinct, got ${texts.join(' / ')}`,
    ).toBe(painted.length);

    // 3 · GAIN MOVES THE PROBE AND NOT THE IDLE LEVEL. This is the two-probe
    // pair's whole argument, at the DOM: a trim on silence is silence.
    await setParam(page, id, 'gain', 4);
    await expect(heroReadout(dock, 'featurecv-probe')).toHaveText(featurecvProbeText(at({ gain: 4 })));
    await expect(
      heroReadout(dock, 'featurecv-idle'),
      'GAIN must not move the resting level',
    ).toHaveText(featurecvIdleText(at()));

    // 4 · POLARITY MOVES BOTH — the rank-1 claim, and the only control that
    // does anything to an un-driven module.
    await setParam(page, id, 'bipolar', 0);
    await expect(heroReadout(dock, 'featurecv-idle')).toHaveText(
      featurecvIdleText(at({ bipolar: 0 })),
    );
    await expect(heroReadout(dock, 'featurecv-probe')).toHaveText(
      featurecvProbeText(at({ gain: 4, bipolar: 0 })),
    );

    // 5 · SENS RUNS BACKWARDS, and the DOM is where that becomes visible.
    // Turning the dial UP must LOWER the printed multiplier.
    await setParam(page, id, 'onset_sens', 0);
    await expect(heroReadout(dock, 'featurecv-thresh')).toHaveText(
      featurecvThreshText(at({ onset_sens: 0 })),
    );
    await setParam(page, id, 'onset_sens', 1);
    await expect(heroReadout(dock, 'featurecv-thresh')).toHaveText(
      featurecvThreshText(at({ onset_sens: 1 })),
    );
    // …and the onset pair does not disturb the feature half.
    await expect(heroReadout(dock, 'featurecv-idle')).toHaveText(
      featurecvIdleText(at({ bipolar: 0 })),
    );
  });

  test('the MAPS panel draws every source on every rail, and GAIN moves exactly ONE rail', async ({
    page,
  }) => {
    await gotoShell(page);
    const id = await spawnFeaturecv(page);
    await openDock(page, id);
    await expect(mapsPanel(page)).toBeVisible();

    // 1 · EVERY MARKER PAINTS, and every one matches the model at the def
    // defaults. A panel that dropped a rail or a source would still satisfy the
    // sidebar sweep's "the block renders a BODY" clause.
    const base = at();
    for (const feature of FEATURECV_FEATURES) {
      for (const src of FEATURECV_SOURCES) {
        expect(
          await markerCv(page, feature, src.id),
          `${feature}/${src.id} at the def defaults`,
        ).toBeCloseTo(featurecvSourceCv(feature, src, base), 3);
      }
    }

    // 2 · THE PICTURE SAYS SOMETHING. If every marker sat at the same place the
    // rails would be decoration; the sources genuinely land apart.
    const before = await allMarkers(page);
    expect(
      new Set(FEATURECV_SOURCES.map((s) => before[`punch/${s.id}`])).size,
      `the four sources must land at different PUNCH levels: ${JSON.stringify(before)}`,
    ).toBeGreaterThan(1);

    // 3 · THE POSITIVE CONTROL: GAIN moves the LOUD rail.
    await setParam(page, id, 'gain', 0.25);
    await expect
      .poll(() => markerCv(page, 'loud', 'white'), {
        message: 'the LOUD rail must follow GAIN',
      })
      .toBeCloseTo(
        featurecvSourceCv('loud', FEATURECV_SOURCES.find((s) => s.id === 'white')!, at({ gain: 0.25 })),
        3,
      );

    // 4 · THE NEGATIVE CONTROL, WHICH IS THE POINT OF THIS TEST. The SAME trim
    // must leave BRIGHT and PUNCH exactly where they were — ZCR counts sign
    // changes and crest is a peak-to-RMS ratio, so a trim in front of the
    // analyser genuinely cannot move them, and the panel says `no gain` on
    // those two rails. A picture that redrew all three would look MORE
    // responsive and be wrong.
    const after = await allMarkers(page);
    for (const feature of ['bright', 'punch'] as const) {
      for (const src of FEATURECV_SOURCES) {
        const k = `${feature}/${src.id}`;
        expect(after[k], `GAIN moved '${k}' — it must not`).toBe(before[k]);
      }
    }
    // …and it really did move the one it is allowed to.
    expect(after['loud/white'], 'GAIN must move the LOUD rail').not.toBe(before['loud/white']);

    // 5 · POLARITY MOVES ALL THREE, because it changes the rail itself. The
    // other direction of the same pair: a panel invariant to POLARITY would
    // draw a bipolar patch on a unipolar ruler.
    await setParam(page, id, 'bipolar', 0);
    const uni = await allMarkers(page);
    for (const feature of FEATURECV_FEATURES) {
      for (const src of FEATURECV_SOURCES) {
        const k = `${feature}/${src.id}`;
        expect(uni[k], `POLARITY must move '${k}'`).not.toBe(after[k]);
      }
    }
  });
});
