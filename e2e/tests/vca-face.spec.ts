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
// Runs on /rack?shell=legacy (no DB, no relay) — the normal e2e lane.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import {
  LANE_KCOL_MAX_PX,
  READOUT_CHAR_PX,
  READOUT_MAX_CHARS,
} from '../../packages/web/src/lib/ui/workflow/lane-readout-fit';
import { formatVcaBase } from '../../packages/web/src/lib/audio/vca-gain-model';

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

/** Boot the migrated shell (`?shell=1`) and wait for the workflow chrome. */
async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack');
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

/** Write one param straight into the graph. Used by the readout-FIT sweep,
 *  where the point is to land on an EXACT value (a drag lands "somewhere near"
 *  and the expected string would stop being a literal). The readout-follows-the-
 *  GRAPH claim is proved by the drag test above; this one is about layout. */
async function setParam(page: Page, nodeId: string, pid: string, value: number): Promise<void> {
  await page.evaluate(
    ({ nodeId, pid, value }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[nodeId];
        n.params = { ...(n.params ?? {}), [pid]: value };
      });
    },
    { nodeId, pid, value },
  );
}

/** Set the viewport zoom and WAIT for every tile to settle on the expected LOD
 *  tier. Programmatic setViewport publishes the zoom to the shared LOD store,
 *  so the tiles re-key their `data-shell-tier`. Waiting on the tier rather than
 *  on a clock keeps this renderer-independent. */
async function setLaneTier(page: Page, zoom: number, tier: string): Promise<void> {
  await page.evaluate((z) => {
    const f = (globalThis as unknown as { __flow: { getViewport: () => { x: number; y: number; zoom: number }; setViewport: (v: { x: number; y: number; zoom: number }, o?: unknown) => void } }).__flow;
    const vp = f.getViewport();
    f.setViewport({ x: vp.x, y: vp.y, zoom: z }, { duration: 0 });
  }, zoom);
  await page.waitForFunction(
    (t) => {
      const tiles = Array.from(document.querySelectorAll('[data-shell-tier]'));
      return tiles.length > 0 && tiles.every((el) => el.getAttribute('data-shell-tier') === t);
    },
    tier,
    { timeout: 10_000 },
  );
}

interface ReadoutFit {
  text: string;
  /** The readout's own laid-out width, in UNSCALED CSS px. */
  readoutWidthPx: number;
  /** The enclosing `.kcol`'s laid-out width, in UNSCALED CSS px. Fit-content,
   *  clamped by `--kcol-max`, so it is 40 (the knob) until a wide readout drags
   *  it up to the 46 cap and then stops. */
  columnWidthPx: number;
  /** The live `max-width` of that `.kcol`, in CSS px — the cap itself. */
  columnMaxWidthPx: number;
  /** True when Chromium is actually drawing the `…`. MEASURED AND REPORTED
   *  ONLY AS EVIDENCE, never as the gate: `.readout`'s `max-width:100%`
   *  resolves against `.knob-wrap` (`max-width:none`), which grows to the text,
   *  so this is ALWAYS false no matter how long the string is. A gate built on
   *  it would be invariant to the thing it claims to measure. */
  ellipsized: boolean;
  /** Sub-pixel advance of ONE `.readout` glyph on THIS runner's font stack,
   *  measured with a probe span that inherits the readout's computed type. */
  advancePx: number;
}

/**
 * Measure a live `.readout`: does it stay inside its column, and what is this
 * runner's real glyph advance?
 *
 * ⚠ UNITS. `getBoundingClientRect()` on a flow node is VIEWPORT-SCALED — xyflow
 * applies a CSS transform for zoom, the `measureOverflow` trap in CLAUDE.md.
 * `offsetWidth` is NOT (it is a layout box, immune to transforms), which is why
 * every width below is an `offsetWidth`. Confirmed on this very element: the
 * readout reads 48 at zoom 0.2 / 0.4 / 0.7 alike, while its client rect scales
 * 1 : 2 : 3.5 across the same three. The advance probe is additionally appended
 * to `document.body`, OUTSIDE the transformed subtree.
 */
async function measureReadoutFit(readout: Locator): Promise<ReadoutFit> {
  return readout.evaluate((el) => {
    const cs = getComputedStyle(el);
    const kcol = el.closest('.kcol') as HTMLElement | null;
    if (!kcol) throw new Error('readout is not inside a .kcol — the 46px cap does not apply');

    // The advance probe: same computed type as the real readout, 32 identical
    // glyphs so a rounding error is divided by 32, laid out untransformed.
    const N = 32;
    const probe = document.createElement('span');
    probe.textContent = '0'.repeat(N);
    probe.style.cssText =
      `position:absolute;left:-9999px;top:0;white-space:nowrap;display:inline-block;` +
      `font-family:${cs.fontFamily};font-size:${cs.fontSize};font-weight:${cs.fontWeight};` +
      `letter-spacing:${cs.letterSpacing};text-transform:${cs.textTransform};`;
    document.body.appendChild(probe);
    const advancePx = probe.getBoundingClientRect().width / N;
    probe.remove();

    return {
      text: el.textContent ?? '',
      readoutWidthPx: el.offsetWidth,
      columnWidthPx: kcol.offsetWidth,
      columnMaxWidthPx: parseFloat(getComputedStyle(kcol).maxWidth),
      ellipsized: el.scrollWidth > el.clientWidth,
      advancePx,
    };
  });
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

  // ── THE dB BRANCH, RENDERED. ─────────────────────────────────────────────
  //
  // Everything above lands on an ENDPOINT (CLOSED / UNITY / OPEN / DUCK), and
  // both face VRT scenes capture the DEFAULT state (`base = 0` → CLOSED). So
  // before this test the dB branch of `formatVcaBase` — the entire reason the
  // readout exists — had never been rendered in a browser ANYWHERE, and the
  // unit guard that was supposed to bound its width counted GLYPHS while the
  // constraint is in PIXELS: `-12.0 dB` is 8 glyphs ≈ 47.8 px against a 46 px
  // column cap, and the guard's budget was "≤ 8 chars".
  //
  // ⚠ WHAT THE OVERFLOW ACTUALLY DOES, because the obvious guess is wrong and
  // this test was written on the wrong instrument first. `.readout` carries
  // `overflow:hidden; text-overflow:ellipsis`, so "it ellipsizes" is the
  // natural assumption — and it is FALSE. Its `max-width:100%` resolves against
  // `.knob-wrap`, which has `max-width:none` and grows to the text, so
  // `scrollWidth === clientWidth` at every string length ever tried (36/48/66/95
  // px for 6/8/11/16 glyphs). An ellipsis probe is invariant to the very thing
  // under test and would have passed on the broken build. What actually happens
  // is that the readout ESCAPES the column and drags `.kcol` from its natural
  // 40 px up to the 46 px cap — so the gate is the readout's own width against
  // that column, and `ellipsized` is carried along only as evidence.
  //
  // Both constants the UNIT guard is calibrated with are cross-checked against
  // this same live render, so neither is a number asserted from a comment.
  test('the dB readout STAYS INSIDE the 46px lane column', async ({ page }) => {
    test.setTimeout(SLOW_RENDER ? 60_000 : 30_000);
    await gotoShell(page);

    // Spawn AT an intermediate base rather than dragging to one: the value has
    // to be exact for the expected string to be a literal, and a drag lands
    // "somewhere near". 0.25 is −12.04 dB — the review's own case, and the
    // widest class of string the formatter can produce.
    await spawnPatch(page, [
      { id: 'v', type: 'vca', position: { x: 460, y: 240 }, params: { base: 0.25 } },
    ]);

    // The 46px cap is scoped to `.rl-tile .tile-body .kcol` — the LANE body.
    // The dock's band is `.page-controls` and is UNCAPPED, which is exactly why
    // the dock VRT baseline looks fine and hides this. So force a LANE tier and
    // assert we got one before measuring anything.
    await setLaneTier(page, 0.7, 'full');
    const laneShell = page.locator(
      '.svelte-flow__node[data-id="v"] [data-testid="module-shell"][data-shell-tier="full"]',
    );
    await expect(laneShell, 'the measurement only means anything in the LANE body').toBeVisible();
    await expect(laneShell.locator('.tile-body .kcol')).not.toHaveCount(0);

    const readout = laneShell.getByTestId('readout-base');
    await expect(readout, 'base = 0.25 puts the readout on its dB branch').toHaveText(
      formatVcaBase(0.25),
    );

    // ── THE MEASUREMENT. ──
    const fit = await measureReadoutFit(readout);

    expect(
      fit.columnMaxWidthPx,
      `the lane knob column's live --kcol-max is ${fit.columnMaxWidthPx} CSS px, but the unit ` +
        `guard (lane-readout-fit.ts) is calibrated against ${LANE_KCOL_MAX_PX}. One of them moved.`,
    ).toBe(LANE_KCOL_MAX_PX);

    // Does the unit guard's VERDICT still hold under this runner's real font?
    // Gate on the invariant that matters — "the longest string the unit guard
    // permits still fits here" — rather than on `advancePx <= READOUT_CHAR_PX`
    // itself. The runner's mono is platform-dependent (SF Mono on darwin,
    // DejaVu/Liberation on the linux lane, all ≈0.6 em), and a hundredth of a
    // px either way is noise, not a defect; what would be a defect is 7 glyphs
    // no longer fitting. The literal comparison is printed for diagnosis.
    expect(
      READOUT_MAX_CHARS * fit.advancePx,
      `one .readout glyph measures ${fit.advancePx.toFixed(4)} CSS px on this runner ` +
        `(lane-readout-fit.ts assumes ≤ ${READOUT_CHAR_PX}), so the ${READOUT_MAX_CHARS}-glyph ` +
        `budget the unit guard permits is ${(READOUT_MAX_CHARS * fit.advancePx).toFixed(2)} px ` +
        `against a ${LANE_KCOL_MAX_PX} px column — the unit guard is now OPTIMISTIC here and can ` +
        `pass a string that overflows. Re-measure and raise READOUT_CHAR_PX.`,
    ).toBeLessThanOrEqual(LANE_KCOL_MAX_PX);

    // THE GATE. Both halves are UNSCALED offsetWidths, so this is CSS px on
    // both sides and the xyflow zoom cancels out of the comparison anyway.
    expect(
      fit.readoutWidthPx,
      `the readout ${JSON.stringify(fit.text)} (${fit.text.length} glyphs) lays out at ` +
        `${fit.readoutWidthPx} CSS px inside a column capped at ${fit.columnMaxWidthPx} px. It ` +
        `does NOT ellipsize (measured: ellipsized=${fit.ellipsized}) — .knob-wrap has ` +
        `max-width:none, so the text escapes the column instead, and pins .kcol to its cap with ` +
        `no margin left for the fit plan. Shorten the format.`,
    ).toBeLessThanOrEqual(LANE_KCOL_MAX_PX);

    expect(
      fit.readoutWidthPx,
      `and it must not be WIDER than the column it sits in (col=${fit.columnWidthPx} px)`,
    ).toBeLessThanOrEqual(fit.columnWidthPx);
  });

  // ── THE SWEEP. One value proves one value; the format changes PRECISION at
  //    −10 dB, so the band on each side of that boundary is checked too. Cheap:
  //    it re-uses the one spawned node and only rewrites a param. ──
  test('every dB the base knob can reach stays inside its column', async ({ page }) => {
    test.setTimeout(SLOW_RENDER ? 60_000 : 30_000);
    await gotoShell(page);
    await spawnPatch(page, [
      { id: 'v', type: 'vca', position: { x: 460, y: 240 }, params: { base: 0.5 } },
    ]);
    await setLaneTier(page, 0.7, 'full');
    const laneShell = page.locator(
      '.svelte-flow__node[data-id="v"] [data-testid="module-shell"][data-shell-tier="full"]',
    );
    const readout = laneShell.getByTestId('readout-base');

    // 0.005 is the CLOSED edge (−46 dB, the widest magnitude); 0.3162 is the
    // −10 dB boundary the precision switch sits on; 0.9 and 0.5 are the fine
    // band; 0.994 is the `-0.0 dB` sign trap just under UNITY.
    for (const base of [0.005, 0.0501, 0.25, 0.3162, 0.3163, 0.5, 0.9, 0.994]) {
      await setParam(page, 'v', 'base', base);
      await expect(readout).toHaveText(formatVcaBase(base));
      const fit = await measureReadoutFit(readout);
      expect(
        fit.readoutWidthPx,
        `base=${base} → ${JSON.stringify(fit.text)} (${fit.text.length} glyphs) lays out at ` +
          `${fit.readoutWidthPx} CSS px and ESCAPES its ${fit.columnMaxWidthPx} px column.`,
      ).toBeLessThanOrEqual(LANE_KCOL_MAX_PX);
    }
  });
});

// ── THE OTHER SURFACE: the LEGACY CARD, and the seam that feeds it. ─────────
//
// Everything above renders the CURATED FACE, which reads the def DIRECTLY
// (`ModuleShell` passes `units={pd.units}` / `format={pd.format}` off the
// ParamDef). The legacy card reaches the same def through `paramProps(def, id)`
// — a SECOND route to the same vocabulary, and until now an unwitnessed one.
//
// The gap that motivated this: `paramProps` did not forward `format`, so the
// face printed `CLOSED` / `-12 dB` / `UNITY` while the card's value tag on the
// SAME param still printed `0.00`. One param, two vocabularies. Nothing could
// see it — `card-def-ranges` only forbids a card from RE-TYPING a def claim and
// is textually blind to one being DROPPED, and the tag renders on HOVER, so no
// VRT baseline contains it either.
//
// `card-kit.test.ts` pins what the seam must forward; this pins that the
// forwarded value reaches a REAL rendered control. (`units` is proved at the
// unit tier only — VCA declares none, and inventing one to make a browser
// assertion possible would be a contract change written for a test.)
// ─────────────────────────────────────────────────────────────────────────────
// PF-20 — THE DERIVED HERO READOUT, ON THE SHIPPED SURFACE.
//
// `vca-gain-model.test.ts` carries the permanent negative controls for the
// FUNCTION. This is the leg the unit lane structurally cannot supply: that the
// registered `valueId` actually resolves through the dock, paints, and moves
// when the graph moves. A derived readout has two ways to be dead that a pure
// test cannot see — an id nothing renders, and a rail wired to a stale local
// that never re-projects — and both print a plausible string forever.
//
// The perturbation is the SAME blindness leg as unit LEG 1: hold `base` and
// move `cvAmount`. The dials must not move (they are each blind to the other),
// the strip must. Values are written straight into the graph so the expected
// strings stay literals — the "readout follows the GRAPH" claim is proved by
// the drag tests above; this one is about REACHABILITY and re-projection.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('vca face — the DERIVED hero readout reaches the dock and moves there', () => {
  test('`at cv 1` paints the summed gain, and follows cvAmount while both dials sit still', async ({
    page,
  }) => {
    await gotoShell(page);
    await spawnPatch(page, [
      { id: 'v', type: 'vca', position: { x: 460, y: 240 }, params: { base: 0.5, cvAmount: 1 } },
    ]);

    const dockShell = await openDock(page, 'v');
    const strip = dockShell.getByTestId('face-hero-readouts');
    await expect(strip, 'the readouts-only hero paints its strip').toBeVisible();

    const entry = strip.locator('[data-hero-readout="vca-gain-at-full-cv"]');
    await expect(
      entry,
      'the DECLARED valueId must be the one the dock renders — a stale/unregistered id ' +
        'prints an em dash and every other assertion here would still pass',
    ).toBeVisible();

    // base 0.5 + cvAmount 1 = 1.5 → +3.5 dB PAST UNITY on an unclamped gain.
    // This is the number the def's own docs.controls.base advice walks a user
    // into, and no other surface states it.
    await expect(entry).toContainText('+3.5 dB');

    // The two dials, BEFORE.
    const baseRo = dockShell.getByTestId('readout-base');
    const amtRo = dockShell.getByTestId('readout-cvAmount');
    await expect(baseRo).toHaveText('-6.0 dB');
    await expect(amtRo).toHaveText('OPEN');

    // PERTURB the input the dials are blind to.
    await setParam(page, 'v', 'cvAmount', 0.5);

    // The strip MOVED: 0.5 + 0.5 = 1.0 exactly.
    await expect(
      entry,
      'the derived readout must re-project when cvAmount moves — if it does not, the rail ' +
        'is reading a stale local and the whole valueId is decoration',
    ).toContainText('UNITY');

    // …and the two dials did NOT, which is the entire reason this readout is
    // derived rather than a `paramId`.
    await expect(baseRo, 'base is blind to cvAmount').toHaveText('-6.0 dB');
    await expect(amtRo, 'cvAmount prints its SENSE, which is OPEN at +0.5 too').toHaveText('OPEN');

    // The other direction, and the module's most surprising state: a sum below
    // zero passes PHASE-INVERTED, and the ` INV` suffix is the face's only
    // statement of it.
    await setParam(page, 'v', 'base', 0);
    await setParam(page, 'v', 'cvAmount', -1);
    await expect(entry, 'a negative summed gain is flagged INV').toContainText('INV');
    await expect(amtRo, 'and the dial now names the sense').toHaveText('DUCK');
  });
});

test.describe('VCA legacy card — the def-owned readout reaches the card too', () => {
  test('the base fader prints the DEF formatter, not the raw number', async ({ page }) => {
    test.setTimeout(SLOW_RENDER ? 60_000 : 30_000);
    // NO `shell=1`: this is the legacy card path, the one `paramProps` feeds.
    await page.goto('/rack?shell=legacy');
    await page.locator('.svelte-flow__pane:visible').first().waitFor({
      state: 'visible',
      timeout: SLOW_RENDER ? 30_000 : 15_000,
    });
    await spawnPatch(page, [
      { id: 'v', type: 'vca', position: { x: 460, y: 240 }, params: { base: 0.25 } },
    ]);

    const card = page.locator('.svelte-flow__node[data-id="v"]');
    const baseFader = card.getByTestId('control-base');
    await expect(baseFader).toBeVisible();

    // The tag exists only while hovering/dragging — which is exactly why no
    // screenshot gate could ever have caught the divergence.
    await baseFader.hover();
    const tag = card.locator('.value-tag').first();
    await expect(tag).toBeVisible();
    await expect(
      tag,
      `the card's value tag must speak the DEF's vocabulary (ParamDef.format via ` +
        `paramProps), not a bare number — the curated face already prints ` +
        `${JSON.stringify(formatVcaBase(0.25))} for this same param.`,
    ).toHaveText(formatVcaBase(0.25));
  });
});
