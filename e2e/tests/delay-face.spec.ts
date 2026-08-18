// e2e/tests/delay-face.spec.ts
//
// THE DELAY FACE, driven for real: the three knob values must follow the GRAPH,
// and the repeat count must be the one the pure model computes.
//
// faces-parity already proves every delay cell is present and operable, and the
// VRT pair pins the default state's pixels. What neither can prove is what this
// rework is FOR:
//
//   * `feedback` reads as a REPEAT COUNT rather than a ratio, and the count is
//     arithmetic — so the DOM must agree with `delay-echo-model`, not with a
//     string this spec re-types. Every expectation below is the model's own
//     output, so a re-tuned formatter moves the test and the module together
//     and a DIVERGENCE between them is the only thing that can fail.
//   * a rendered value is a string a component computes, so the failure mode is
//     a DOM that re-labels itself while the graph never moved (or the graph
//     moving while the value stays put, wired to a stale local). Every
//     assertion pins BOTH sides: the committed `__patch` value AND the string.
//   * `time` and `feedback` are the only two cells the COMPACT lane tile can
//     hold (the glyph takes the third column), which is the entire consequence
//     of `face.order` on this module — asserted here in the real DOM, not only
//     derived from `curatedFace` in the unit lane.
//
// ⚠ WHERE THE STRING IS READ CHANGED ON 2026-08-17, AND THE STRING DID NOT.
// All three delay params declare a `format`, and the owner removed the resting
// number from every faceplate — so no delay dial paints anything now. Each
// assertion moved from `readout-<id>`'s text to `control-<id>`'s
// `aria-valuetext`, which is `knobValueReadout`: the SAME formatter, the same
// expected literal, still the model's own output. Nothing here was weakened to
// survive the removal; what died is the PIXEL-FIT half, and it is buried with
// its reasons where it stood.
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
  test('one band, three live values, and every one of them is backed by a committed param', async ({
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
    //    agreeing with a stale string typed here. The dial IS the observable
    //    now — `aria-valuetext` carries what the readout line used to print. ──
    const fbDial = dock.locator('[data-testid="control-feedback"]');
    const mixDial = dock.locator('[data-testid="control-mix"]');
    const timeDial = dock.locator('[data-testid="control-time"]');
    await expect(timeDial).toHaveAttribute('aria-valuetext', formatDelayTime(0.25)); // 250 MS
    await expect(fbDial, 'the ratio 0.4 is EIGHT repeats, and the dial says so').toHaveAttribute(
      'aria-valuetext',
      formatDelayFeedback(0.4), // 8 REP
    );
    await expect(mixDial).toHaveAttribute('aria-valuetext', formatDelayMix(0.35)); // 35% WET

    // …and NOTHING is painted under any of them. A declared numeric `format` is
    // exactly the case the owner removed (2026-08-17), so this is the negative
    // control for the removal on the face that had three of them.
    await expect(
      dock.locator('[data-testid^="readout-"]'),
      'no delay dial paints a resting value — all three params declare a `format`',
    ).toHaveCount(0);

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
    await expect(fbDial, 'the ceiling is a very long but FINITE tail').toHaveAttribute(
      'aria-valuetext',
      formatDelayFeedback(0.95), // 135 REP
    );

    // ── THE OTHER END: no recirculation at all is still ONE echo. ──
    await dragDial(page, fbDial, 260);
    await expect.poll(() => readParam(page, 'd', 'feedback')).toBe(0);
    await expect(fbDial).toHaveAttribute('aria-valuetext', formatDelayFeedback(0)); // 1 REP

    // ── MIX names its ends. ──
    await dragDial(page, mixDial, -260);
    await expect.poll(() => readParam(page, 'd', 'mix')).toBe(1);
    await expect(mixDial, 'full wet is named, not read as 1.00').toHaveAttribute(
      'aria-valuetext',
      'WET',
    );

    // ── THE NEGATIVE-CONTROL SHAPE, INLINE: move a DIFFERENT knob and confirm
    //    these values do not follow it. Without this, a dial hard-coded to
    //    'WET' / '1 REP' would satisfy every assertion above. ──
    await dragDial(page, timeDial, -260);
    await expect.poll(() => readParam(page, 'd', 'time')).toBe(2);
    await expect(timeDial).toHaveAttribute('aria-valuetext', formatDelayTime(2)); // 2.00 S
    await expect(
      mixDial,
      'mix’s value is bound to mix, not to whatever moved last',
    ).toHaveAttribute('aria-valuetext', 'WET');
    await expect(fbDial).toHaveAttribute('aria-valuetext', formatDelayFeedback(0));
    expect(await readParam(page, 'd', 'mix'), 'and mix itself did not move').toBe(1);
    expect(await readParam(page, 'd', 'feedback')).toBe(0);
  });

  // ── THE LANE, where `face.order` bites. ──────────────────────────────────
  //
  // The claim the dock cannot make: the COMPACT tile holds exactly TWO cells
  // because the glyph takes the third column, so rank 3 (`mix`) is not on it —
  // the entire consequence of the ranking, and invisible at the dock tier,
  // which shows everything.
  //
  // ⚠ THIS TEST USED TO CARRY A SECOND CLAIM AND IT NO LONGER HAS A SUBJECT.
  // It measured each compact-tile readout's laid-out width against the 46 px
  // `--kcol-max` column, because a lane knob column does NOT ellipsize
  // (`.knob-wrap` is uncapped) so an over-long readout ESCAPED its cell rather
  // than being clipped — `999 MS` / `135 REP` were spawned deliberately as this
  // face's two widest strings. The owner removed the resting readout from every
  // faceplate on 2026-08-17 and all three delay params declare a `format`, so
  // there is no `.readout` element on this face at ANY tier: the measurement
  // would resolve zero elements and the loop would assert nothing, in silence.
  // Deleted rather than re-pointed — delay's fixture has no face that paints,
  // and re-pointing it at another module would make this delay spec a test of
  // that module. What still covers the remainder: `lane-readout-fit.ts`'s own
  // pure unit tests (`readoutFitsLane` + the `READOUT_MAX_CHARS` boundary pair)
  // still bound the NAME readouts, which are the only strings a lane column can
  // still be asked to hold, and the plate-overflow leg below still catches a
  // cell wider than its track.
  test('the compact tile drops mix, and nothing escapes the fixed lane tile', async ({ page }) => {
    test.setTimeout(SLOW_RENDER ? 60_000 : 30_000);
    await gotoShell(page);
    // Spawn AT the widest-string values rather than dragging to them: the value
    // must be exact for the expected text to be a literal. They are kept because
    // the strings are still ASSERTED (on `aria-valuetext`) even though nothing
    // measures their pixels any more — a face driven at its default values would
    // prove less, for no saving.
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

    // (1) COMPACT: two cells, ranks 1-2.
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

    // …and the LANE dial speaks the same string the dock one does. This is the
    // half of the deleted measurement that survived the removal: the value is
    // still asserted at this tier, it is simply no longer laid out here.
    for (const [pid, expected] of [
      ['time', formatDelayTime(0.999)], // 999 MS
      ['feedback', formatDelayFeedback(0.95)], // 135 REP (the widest this face makes)
    ] as const) {
      await expect(compact.locator(`[data-testid="control-${pid}"]`)).toHaveAttribute(
        'aria-valuetext',
        expected,
      );
    }

    // (2) FULL: the 3-cell plate — all three cells render in-lane, and NOTHING
    //     escapes the fixed 192 px tile. `scrollWidth > clientWidth` is the
    //     plate's real failure mode (its body is `overflow:hidden`, so an
    //     over-wide cell is CLIPPED rather than spilling visibly — which is
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
    await expect(lane.locator('[data-testid="control-mix"]')).toHaveAttribute(
      'aria-valuetext',
      formatDelayMix(0.99), // 99% WET
    );

    const plate = await lane.locator('.tile-body.plate').evaluate((el) => ({
      scrollWidth: (el as HTMLElement).scrollWidth,
      clientWidth: (el as HTMLElement).clientWidth,
      cellWidths: Array.from(el.querySelectorAll('.kcol')).map((k) => (k as HTMLElement).offsetWidth),
    }));
    expect(
      plate.scrollWidth,
      `the full-tier plate overflows its own body (${plate.scrollWidth} > ${plate.clientWidth} CSS px; ` +
        `cells ${plate.cellWidths.join('/')}) — a cell is wider than its grid track and the ` +
        `body's overflow:hidden is silently clipping it`,
    ).toBeLessThanOrEqual(plate.clientWidth);
  });
});
