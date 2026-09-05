// e2e/tests/ringback-face.spec.ts
//
// THE RINGBACK FACE, driven for real.
//
// faces-parity already proves every ringback cell is present and operable, and
// the model unit test proves the readout arithmetic. Neither can prove the
// three things this face's promotion is FOR:
//
//   1. the declared vocabularies (`ParamDef.format`) follow the COMMITTED GRAPH
//      rather than a component-local value — the failure mode is a DOM that
//      re-labels itself while `__patch` never moved, so every assertion below
//      pins BOTH sides;
//   2. SIZE deliberately declares NO vocabulary, so it must read as the RAW
//      LADDER and never as a name — a rendered absence, and therefore invisible
//      to any test that only looks at what IS there;
//   3. the rear card's `~` ticks land on exactly the four CV holes — the face's
//      audio-rate CLAIM, drawn.
//
// ⚠ EVERY ASSERTION HERE USED TO READ A PAINTED `readout-<id>` LINE. The owner
// removed the resting number from every faceplate (2026-08-17); RATE, FEEDBACK
// and MIX declare a `format` and SIZE declares nothing, so NO ringback dial
// paints at any tier. Each string moved to `control-<id>`'s `aria-valuetext`
// (`knobValueReadout` — format, then roster, then the raw ladder), which is the
// identical resolution the line printed, so every expected literal is unchanged.
// ⚠ WATCH FOR VACUITY WHEN READING THIS FILE: "SIZE paints nothing" is no longer
// a statement ABOUT SIZE, because nothing on this face paints. The claim that
// still discriminates is that SIZE resolves to a NUMBER where its neighbours
// resolve to NAMES, and that is what is asserted.
//
// The drags overshoot the end of the arc on purpose (`knobFracToValue` clamps
// its fraction to [0,1]), so each gesture lands on an EXACT endpoint and the
// expected param value is a literal rather than an inequality. Renderer-
// independent by construction: no frame budget, no wall clock, no tuning.
//
// Runs on /rack (no DB, no relay) — the normal e2e lane.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch, waitForLaneTier } from './_helpers';
import { pressFlipKey } from './_flip-key';
import {
  RINGBACK_FEEDBACK,
  RINGBACK_RATE,
  formatRingbackFeedback,
  formatRingbackMix,
  formatRingbackRate,
} from '../../packages/web/src/lib/audio/ringback-crush-model';

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

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

/** The COMMITTED graph value of one param (null when nothing has written it —
 *  a fresh spawn only materialises a param once something does). */
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

/** Drag a dial VERTICALLY by `dy` px (negative = up = toward max). */
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

/** Set the viewport zoom and WAIT for every tile to settle on the expected LOD
 *  tier — renderer-independent, unlike a clock. */
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
  // ⚠ WAS A BARE `document.querySelectorAll('[data-shell-tier]')` + `.every()`.
  // That stopped meaning "the lane tiles" on 2026-08-24 without this spec
  // changing: promoting `audioOut` put a PINNED faceplate in the always-mounted
  // 🎧 topbar panel, whose tier is permanently `dock`, so `.every()` could never
  // become true and this call sat out its full 10 s timeout. Scoped to the main
  // canvas through the ONE export site — see `waitForLaneTier`.
  await waitForLaneTier(page, tier);
}

test.describe('ringback face — the resolved values follow the graph', () => {
  test('RATE / FEEDBACK / MIX name what the module is doing, and SIZE deliberately does not', async ({
    page,
  }) => {
    test.setTimeout(SLOW_RENDER ? 60_000 : 30_000);
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'rb', type: 'ringback', position: { x: 460, y: 240 } }]);
    const dock = await openDock(page, 'rb');

    // ── The two bands are the signal flow, named by FUNCTION. ──
    await expect(dock.locator('[data-face-page="ring"] .page-label')).toHaveText('crush ring');
    await expect(dock.locator('[data-face-page="output"] .page-label')).toHaveText('output blend');

    // ── SPAWN STATE. The defaults are rate 0.5 / size 64 / feedback 0.3 /
    //    mix 1, and each dial must say what the number MEANS. `WET` is this
    //    module's spawn-time surprise: it is fully wet the instant you patch it.
    const rateDial = dock.locator('[data-testid="control-rate"]');
    const fbDial = dock.locator('[data-testid="control-feedback"]');
    const mixDial = dock.locator('[data-testid="control-mix"]');
    await expect(rateDial, 'half the input samples never reach the ring').toHaveAttribute(
      'aria-valuetext',
      'SR/2.0',
    );
    await expect(fbDial, 'the default tail is about six laps').toHaveAttribute(
      'aria-valuetext',
      '6 LAPS',
    );
    await expect(mixDial, 'a fresh RINGBACK is FULLY WET').toHaveAttribute(
      'aria-valuetext',
      'WET',
    );

    // ── THE DECLARED ABSENCE. SIZE declares NO vocabulary, and that is a
    //    decision: the quantity that matters is size/rate, which no per-param
    //    formatter can show. What keeps changing is WHERE that decision is
    //    visible.
    //
    //    ⚠ IT WAS `readout-size` COUNT 0, THEN `readout-size` TEXT, AND IS NOW
    //    NEITHER — and the reason to re-read it each time is that the obvious
    //    port is VACUOUS. PF-20 overturned "a readout is earned" at the dock
    //    (that was a LANE argument: a 46 px column cannot spend a text row on
    //    what hovering already shows) and made the dock print the raw number for
    //    an undeclared param. The 2026-08-17 ruling then removed the printed
    //    number outright, so "SIZE paints nothing" is true of every dial on this
    //    face and says nothing about SIZE at all.
    //
    //    What still discriminates — and would go red the moment someone quietly
    //    gave SIZE a roster — is the SHAPE of what it resolves to: the raw
    //    ladder plus its declared units, where its three neighbours resolve to
    //    names. Both halves are asserted, because the ladder alone would also be
    //    satisfied by a face that lost its formats entirely. ──
    await expect(dock.locator('[data-testid="control-size"]')).toBeVisible();
    const sizeDial = dock.locator('[data-testid="control-size"]');
    await expect(
      sizeDial,
      'SIZE resolves to the raw ladder + its declared units, because it declared no ' +
        'vocabulary (a NAME here would mean someone quietly gave it one)',
    ).toHaveAttribute('aria-valuetext', '64.0 smp');
    await expect(
      dock.locator('[data-testid^="readout-"]'),
      'and nothing on this face paints a resting value — three formats and one bare param, ' +
        'which is every case the ruling removed and none of the case it kept',
    ).toHaveCount(0);

    // ── PAST THE TOP OF RATE'S ARC → exactly max. Above 1 no input sample is
    //    discarded, so the dial stops counting divisors. ──
    await dragDial(page, rateDial, -260);
    await expect
      .poll(() => readParam(page, 'rb', 'rate'), {
        message: 'dragging the dial COMMITS the new rate into the graph',
      })
      .toBe(RINGBACK_RATE.max);
    await expect(rateDial).toHaveAttribute(
      'aria-valuetext',
      formatRingbackRate(RINGBACK_RATE.max),
    );
    await expect(rateDial).toHaveAttribute('aria-valuetext', 'FULL SR');

    // ── PAST THE TOP OF FEEDBACK'S ARC → 0.98, the ring's hard ceiling: the
    //    tail outlasts 100 laps and the dial names the regime instead. ──
    await dragDial(page, fbDial, -260);
    await expect
      .poll(() => readParam(page, 'rb', 'feedback'))
      .toBe(RINGBACK_FEEDBACK.max);
    await expect(fbDial).toHaveAttribute(
      'aria-valuetext',
      formatRingbackFeedback(RINGBACK_FEEDBACK.max),
    );
    await expect(fbDial).toHaveAttribute('aria-valuetext', 'RINGING');

    // ── AND THE BOTTOM OF MIX → 0, the one setting that makes the module
    //    inaudible rather than different. ──
    await dragDial(page, mixDial, 260);
    await expect.poll(() => readParam(page, 'rb', 'mix')).toBe(0);
    await expect(mixDial).toHaveAttribute('aria-valuetext', formatRingbackMix(0));
    await expect(mixDial).toHaveAttribute('aria-valuetext', 'DRY');

    // ── THE NEGATIVE CONTROL, INLINE. Move ONE knob back and confirm the other
    //    two values do NOT follow it, and their params did not move either.
    //    Without this, three dials hard-coded to their final strings would pass
    //    every assertion above. ──
    await dragDial(page, mixDial, -260);
    await expect.poll(() => readParam(page, 'rb', 'mix')).toBe(1);
    await expect(mixDial).toHaveAttribute('aria-valuetext', 'WET');
    await expect(
      rateDial,
      'rate’s value is bound to rate, not to whatever moved last',
    ).toHaveAttribute('aria-valuetext', 'FULL SR');
    await expect(fbDial).toHaveAttribute('aria-valuetext', 'RINGING');
    // …and SIZE, which nobody touched, still reads the raw ladder. The other
    // half of the same control: a face that lost its formats would print this
    // shape for ALL FOUR.
    await expect(sizeDial).toHaveAttribute('aria-valuetext', '64.0 smp');
    expect(await readParam(page, 'rb', 'rate')).toBe(RINGBACK_RATE.max);
    expect(await readParam(page, 'rb', 'feedback')).toBe(RINGBACK_FEEDBACK.max);
  });

  // ── THE `~` CLAIM, DRAWN ──────────────────────────────────────────────────
  //
  // `face.rear.audioRate` lists all four CV jacks, which is unusual (delay
  // ticks one, shimmershine and qbrt tick none) and is a CLAIM about the
  // worklet: a-rate descriptors READ PER FRAME through an unsmoothed CV path.
  // The unit test checks the claim against the worklet source; this checks that
  // the claim reaches the panel — and, just as importantly, that it does NOT
  // spill onto the audio pair or the outputs rail.
  test('the rear card ticks exactly the four CV holes', async ({ page }) => {
    test.setTimeout(SLOW_RENDER ? 60_000 : 30_000);
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'rb', type: 'ringback', position: { x: 460, y: 240 } }]);
    await openDock(page, 'rb');

    // The flip key flips the OPEN dock full-view to the rear face (dockStore.
    // fullViewFlipped — the one view-global flip seam).
    await pressFlipKey(page);
    const rear = page.getByTestId('rear-card');
    await expect(rear).toBeVisible();

    // #1800: input groups are SECTION COLUMNS, scoped by direction — the
    // OUTPUT rail is a section now too, so an unscoped selector would pick it
    // up and the count would silently be about a different set.
    // `toHaveText` with an ARRAY already pins both the exact headings and how
    // many there are, so the `toHaveCount(3)` that used to sit here was a
    // hand-typed population count (CLAUDE.md P0) that could only ever go stale
    // or agree with the line below it.
    const inSections = rear.locator('[data-testid="rear-section"][data-direction="input"]');
    await expect(inSections).toHaveText([/stereo in/i, /crush ring/i, /output blend/i]);

    // Every hole, and which of them draw the `~`.
    const ticked = await rear.evaluate((el) =>
      Array.from(el.querySelectorAll('[data-testid="back-jack"]'))
        .filter((j) => !!j.querySelector('.ar'))
        .map((j) => j.getAttribute('data-port-id')),
    );
    expect(ticked, 'the four CV jacks, and nothing else').toEqual([
      'rate',
      'size',
      'feedback',
      'mix',
    ]);

    // Cross-checked against the LIVE def rather than against this file's own
    // list: every ticked id must be a declared per-param CV INPUT, and the
    // ticked SET must be exactly those (a `~` on the audio pair would be a
    // different, and false, claim).
    const cvInputs = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __moduleSpecs: { type: string; inputs?: { id: string; paramTarget?: string }[] }[];
      };
      const spec = w.__moduleSpecs.find((s) => s.type === 'ringback');
      return (spec?.inputs ?? []).filter((p) => !!p.paramTarget).map((p) => p.id);
    });
    expect(cvInputs.length, 'the spec projection actually resolved').toBe(4);
    expect(ticked, 'the ticked set IS the per-param CV set, from the live def').toEqual(cvInputs);
  });

  // ── THE LANE, WHERE THE VOCABULARY HAS TO SURVIVE THE SMALLEST TIER ───────
  //
  // ⚠ THIS WAS A PIXEL MEASUREMENT AND ITS SUBJECT NO LONGER EXISTS. It laid out
  // `readout-rate` at the compact tier and required its width to stay inside the
  // 46 px `--kcol-max` column, because a readout that outgrows the cap does NOT
  // ellipsize — `.readout`'s `max-width:100%` resolves against `.knob-wrap`,
  // which is uncapped, so the text ESCAPES the column instead (measured; see
  // lane-readout-fit.ts). `FULL SR` was chosen as the case because it is 7
  // glyphs, the widest string this face can produce and exactly the budget. It
  // also cross-checked the live `--kcol-max` and this runner's real glyph
  // advance against the constants the unit guard is calibrated with.
  //
  // The owner removed the resting readout from every faceplate (2026-08-17), so
  // there is no `.readout` on this face at any tier and every one of those
  // measurements would now read zero elements and pass in silence. Deleted, not
  // re-pointed: ringback's fixture has no face that paints. `lane-readout-fit`'s
  // pure unit tests still bound the NAME readouts — the only strings a lane
  // column can still be asked to hold — and this file's own
  // `ringback-crush-model.test.ts` still walks the `READOUT_MAX_CHARS` boundary
  // in both directions. What is gone and named as gone: nothing re-measures
  // those constants against a live render any more.
  //
  // What survives is the claim the pixels were only ever the vehicle for — that
  // the LANE resolves each dial's vocabulary the same way the dock does, which
  // is a per-tier prop-threading question a dock-only assertion cannot answer.
  test('the LANE resolves the same vocabulary the dock does — a name, and a number', async ({ page }) => {
    test.setTimeout(SLOW_RENDER ? 60_000 : 30_000);
    await gotoShell(page);
    await spawnPatch(page, [
      { id: 'rb', type: 'ringback', position: { x: 460, y: 240 }, params: { rate: 1 } },
    ]);

    // COMPACT is the tier the deleted measurement ran at, and it stays the tier
    // here: it is the SMALLEST one that renders two cells, so it is where a
    // prop that stopped being threaded would show first.
    await setLaneTier(page, 0.45, 'compact');
    const laneShell = page.locator(
      '.svelte-flow__node[data-id="rb"] [data-testid="module-shell"][data-shell-tier="compact"]',
    );
    await expect(laneShell).toBeVisible();
    await expect(laneShell.locator('.tile-body .kcol')).not.toHaveCount(0);

    // ── THE PAIR, IN ONE PLACE, WHICH IS WHAT MAKES THIS A STATEMENT ABOUT THE
    //    RESOLVER RATHER THAN ABOUT ONE PARAM. SIZE is rank 2, so the compact
    //    tile renders it beside RATE. RATE declared a `format` and resolves to
    //    its NAME; SIZE declared nothing and resolves to the raw ladder. A face
    //    that dropped `format` on the way to this tier would collapse both to
    //    the ladder and only the first half would notice. ──
    await expect(laneShell.locator('[data-testid="control-size"]')).toBeVisible();
    await expect(
      laneShell.locator('[data-testid="control-rate"]'),
      'the LANE resolves RATE through the def’s formatter, exactly as the dock does',
    ).toHaveAttribute('aria-valuetext', 'FULL SR');
    await expect(
      laneShell.locator('[data-testid="control-size"]'),
      'and SIZE through the raw ladder, because it declared no vocabulary',
    ).toHaveAttribute('aria-valuetext', '64.0 smp');
  });
});
