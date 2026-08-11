// e2e/tests/delay-face.spec.ts
//
// THE DELAY FACE, driven for real: the three knob readouts must follow the
// GRAPH, and the repeat count must be the one the pure model computes.
//
// faces-parity already proves every delay cell is present and operable, and the
// VRT pair pins the default state's pixels. What neither can prove is what this
// rework is FOR:
//
//   * `feedback` prints a REPEAT COUNT rather than a ratio, and the count is
//     arithmetic — so the DOM must agree with `delay-echo-model`, not with a
//     string this spec re-types. Every expectation below is the model's own
//     output, so a re-tuned formatter moves the test and the module together
//     and a DIVERGENCE between them is the only thing that can fail.
//   * a readout is a string a component computes, so the failure mode is a DOM
//     that re-labels itself while the graph never moved (or the graph moving
//     while the readout stays put, wired to a stale local). Every assertion
//     pins BOTH sides: the committed `__patch` value AND the printed text.
//   * `time` and `feedback` are the only two cells the COMPACT lane tile can
//     hold (the glyph takes the third column), which is the entire consequence
//     of `face.order` on this module — asserted here in the real DOM, not only
//     derived from `curatedFace` in the unit lane.
//
// The drags are deliberately PAST the end of the arc — `knobFracToValue` clamps
// its fraction to [0,1] — so each gesture lands on an EXACT endpoint rather
// than "somewhere near". That makes every expected value a literal instead of
// an inequality, and it is renderer-independent: no frame budget, no
// wall-clock, no tuning.
//
// Runs on /rack?shell=legacy (no DB, no relay) — the normal e2e lane.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { LANE_KCOL_MAX_PX, READOUT_MAX_CHARS } from '../../packages/web/src/lib/ui/workflow/lane-readout-fit';
import {
  formatDelayFeedback,
  formatDelayMix,
  formatDelayTime,
} from '../../packages/web/src/lib/audio/delay-echo-model';

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({
    timeout: SLOW_RENDER ? 30_000 : 15_000,
  });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
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

/** Set the viewport zoom and WAIT for every tile to settle on the expected LOD
 *  tier — renderer-independent by construction (no clock anywhere). */
async function setLaneTier(page: Page, zoom: number, tier: string): Promise<void> {
  await page.evaluate((z) => {
    const f = (
      globalThis as unknown as {
        __flow: {
          getViewport: () => { x: number; y: number; zoom: number };
          setViewport: (v: { x: number; y: number; zoom: number }, o?: unknown) => void;
        };
      }
    ).__flow;
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

test.describe('delay face — the repeat count follows the graph', () => {
  test('one band, three readouts, and every one of them is backed by a committed param', async ({
    page,
  }) => {
    test.setTimeout(SLOW_RENDER ? 60_000 : 30_000);
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'd', type: 'delay', position: { x: 460, y: 240 } }]);
    const dock = await openDock(page, 'd');

    // ── ONE band, and its header states the topology the old two-band split
    //    was only implying: time and feedback recirculate, mix does not. ──
    await expect(dock.getByTestId('face-page'), 'the 2 → 1 page collapse').toHaveCount(1);
    await expect(dock.locator('[data-face-page="echo"] .page-label')).toHaveText(
      'one line, fed back · mix is outside the loop',
    );

    // ── SPAWN STATE. Expectations come from the MODEL, so this cannot pass by
    //    agreeing with a stale string typed here. ──
    const timeOut = dock.getByTestId('readout-time');
    const fbOut = dock.getByTestId('readout-feedback');
    const mixOut = dock.getByTestId('readout-mix');
    await expect(timeOut).toHaveText(formatDelayTime(0.25)); // 250 MS
    await expect(fbOut, 'the ratio 0.4 is EIGHT repeats, and the dial says so').toHaveText(
      formatDelayFeedback(0.4), // 8 REP
    );
    await expect(mixOut).toHaveText(formatDelayMix(0.35)); // 35% WET

    const fbDial = dock.locator('[data-testid="control-feedback"]');
    const mixDial = dock.locator('[data-testid="control-mix"]');
    const timeDial = dock.locator('[data-testid="control-time"]');

    // ── THE CEILING. Drag feedback past the top of its arc: the fraction
    //    clamps, so this lands on exactly 0.95 — the hard clamp that keeps the
    //    loop below self-oscillation. The dial must then print a FINITE count,
    //    which is the whole visible difference between this module and one that
    //    can run away. ──
    await dragDial(page, fbDial, -260);
    await expect
      .poll(() => readParam(page, 'd', 'feedback'), {
        message: 'dragging the dial COMMITS the new ratio into the graph',
      })
      .toBe(0.95);
    await expect(fbOut, 'the ceiling is a very long but FINITE tail').toHaveText(
      formatDelayFeedback(0.95), // 135 REP
    );

    // ── THE OTHER END: no recirculation at all is still ONE echo. ──
    await dragDial(page, fbDial, 260);
    await expect.poll(() => readParam(page, 'd', 'feedback')).toBe(0);
    await expect(fbOut).toHaveText(formatDelayFeedback(0)); // 1 REP

    // ── MIX names its ends. ──
    await dragDial(page, mixDial, -260);
    await expect.poll(() => readParam(page, 'd', 'mix')).toBe(1);
    await expect(mixOut, 'full wet is named, not printed as 1.00').toHaveText('WET');

    // ── THE NEGATIVE-CONTROL SHAPE, INLINE: move a DIFFERENT knob and confirm
    //    these readouts do not follow it. Without this, a readout hard-coded to
    //    'WET' / '1 REP' would satisfy every assertion above. ──
    await dragDial(page, timeDial, -260);
    await expect.poll(() => readParam(page, 'd', 'time')).toBe(2);
    await expect(timeOut).toHaveText(formatDelayTime(2)); // 2.00 S
    await expect(mixOut, 'mix’s readout is bound to mix, not to whatever moved last').toHaveText(
      'WET',
    );
    await expect(fbOut).toHaveText(formatDelayFeedback(0));
    expect(await readParam(page, 'd', 'mix'), 'and mix itself did not move').toBe(1);
    expect(await readParam(page, 'd', 'feedback')).toBe(0);
  });

  // ── THE LANE, where `face.order` and the column caps both bite. ───────────
  //
  // Two claims the dock cannot make. (1) The COMPACT tile holds exactly TWO
  // cells because the glyph takes the third column, so rank 3 (`mix`) is not on
  // it — the entire consequence of the ranking, and invisible at the dock tier,
  // which shows everything. (2) A lane knob column does NOT ellipsize
  // (`.knob-wrap` is uncapped), so an over-long readout ESCAPES its cell —
  // measured, not assumed; see lane-readout-fit.ts.
  //
  // ⚠ THE CAP IS TIER-DEPENDENT AND THE FIRST DRAFT OF THIS TEST MEASURED THE
  // WRONG ONE. `--kcol-max: 46px` is scoped to `.rl-tile .tile-body .kcol` —
  // the ROW body (mini / compact). The `full` tier's PLATE grid overrides it
  // with `max-width: 100%` of a ~53 px grid track, and `getComputedStyle`
  // returns the computed *percentage*, so a naive `parseFloat(maxWidth)` reads
  // `100` and a "≤ 46" assertion against it passes for a reason unrelated to
  // layout. (`vca-face.spec.ts` measures 46 at `full` only because vca has TWO
  // controls, so its full tier is still a ROW.) Each tier is therefore checked
  // in the units of ITS OWN constraint: the 46 px cap where it exists, and
  // "nothing escapes the fixed 192 px tile" on the plate.
  test('the compact tile drops mix, and no readout escapes its lane cell', async ({ page }) => {
    test.setTimeout(SLOW_RENDER ? 60_000 : 30_000);
    await gotoShell(page);
    // Spawn AT the widest-string values rather than dragging to them: the value
    // must be exact for the expected text to be a literal.
    //   time 0.999 → `999 MS` (6) · feedback 0.95 → `135 REP` (7)
    //   mix  0.99  → `99% WET` (7 — the widest the format can ever produce)
    await spawnPatch(page, [
      {
        id: 'd',
        type: 'delay',
        position: { x: 460, y: 240 },
        params: { time: 0.999, feedback: 0.95, mix: 0.99 },
      },
    ]);

    // (1) COMPACT: two cells, ranks 1-2, in the 46 px ROW column.
    await setLaneTier(page, 0.45, 'compact');
    const compact = page.locator(
      '.svelte-flow__node[data-id="d"] [data-testid="module-shell"][data-shell-tier="compact"]',
    );
    await expect(compact).toBeVisible();
    expect(
      await compact
        .locator('.tile-body [data-cell-key]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-cell-key'))),
      'the compact tile holds the top TWO ranks; the glyph takes the third column',
    ).toEqual(['time', 'feedback']);

    for (const [pid, expected] of [
      ['time', formatDelayTime(0.999)], // 999 MS  (6 glyphs)
      ['feedback', formatDelayFeedback(0.95)], // 135 REP (7 — the widest this face makes)
    ] as const) {
      const readout = compact.getByTestId(`readout-${pid}`);
      await expect(readout).toHaveText(expected);
      // ⚠ UNITS. `offsetWidth` is a LAYOUT box and is immune to xyflow's zoom
      // transform; `getBoundingClientRect()` is not (the CLAUDE.md
      // measureOverflow trap). Every number below is an offsetWidth.
      const fit = await readout.evaluate((el) => {
        const kcol = el.closest('.kcol') as HTMLElement | null;
        if (!kcol) throw new Error('readout is not inside a .kcol');
        return {
          readoutWidthPx: (el as HTMLElement).offsetWidth,
          columnMaxWidthPx: parseFloat(getComputedStyle(kcol).maxWidth),
        };
      });
      expect(
        fit.columnMaxWidthPx,
        'the ROW-body column cap the unit guard is calibrated against, read off a live render',
      ).toBe(LANE_KCOL_MAX_PX);
      expect(
        fit.readoutWidthPx,
        `${pid}: "${expected}" (${expected.length} glyphs, budget ${READOUT_MAX_CHARS}) lays out ` +
          `at ${fit.readoutWidthPx} CSS px against a ${fit.columnMaxWidthPx} px column cap — it ` +
          `ESCAPES the cell (it does NOT ellipsize; lane-readout-fit.ts). Shorten the format.`,
      ).toBeLessThanOrEqual(fit.columnMaxWidthPx);
    }

    // (2) FULL: the 3-cell plate — all three readouts render in-lane, and
    //     NOTHING escapes the fixed 192 px tile. `scrollWidth > clientWidth` is
    //     the plate's real failure mode (its body is `overflow:hidden`, so an
    //     over-wide readout is CLIPPED rather than spilling visibly — which is
    //     precisely why an eyeball on a screenshot would not catch it).
    await setLaneTier(page, 0.7, 'full');
    const lane = page.locator(
      '.svelte-flow__node[data-id="d"] [data-testid="module-shell"][data-shell-tier="full"]',
    );
    await expect(lane).toBeVisible();
    expect(
      await lane
        .locator('.tile-body [data-cell-key]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-cell-key'))),
      'three cells fit ONE plate row, so all three render in-lane',
    ).toEqual(['time', 'feedback', 'mix']);
    await expect(lane.getByTestId('readout-mix')).toHaveText(formatDelayMix(0.99)); // 99% WET

    const plate = await lane.locator('.tile-body.plate').evaluate((el) => ({
      scrollWidth: (el as HTMLElement).scrollWidth,
      clientWidth: (el as HTMLElement).clientWidth,
      cellWidths: Array.from(el.querySelectorAll('.kcol')).map((k) => (k as HTMLElement).offsetWidth),
    }));
    expect(
      plate.scrollWidth,
      `the full-tier plate overflows its own body (${plate.scrollWidth} > ${plate.clientWidth} CSS px; ` +
        `cells ${plate.cellWidths.join('/')}) — a readout is wider than its grid track and the ` +
        `body's overflow:hidden is silently clipping it`,
    ).toBeLessThanOrEqual(plate.clientWidth);
  });
});
