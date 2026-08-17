// e2e/tests/ringback-face.spec.ts
//
// THE RINGBACK FACE, driven for real.
//
// faces-parity already proves every ringback cell is present and operable, and
// the model unit test proves the readout arithmetic. Neither can prove the
// three things this face's promotion is FOR:
//
//   1. the persistent readouts (`ParamDef.format` → KnobConic's `.readout`)
//      follow the COMMITTED GRAPH rather than a component-local value — the
//      failure mode is a DOM that re-labels itself while `__patch` never moved,
//      so every assertion below pins BOTH sides;
//   2. SIZE deliberately has NO readout, which is a rendered absence and
//      therefore invisible to any test that only looks at what IS there;
//   3. the rear card's `~` ticks land on exactly the four CV holes — the face's
//      audio-rate CLAIM, drawn.
//
// The drags overshoot the end of the arc on purpose (`knobFracToValue` clamps
// its fraction to [0,1]), so each gesture lands on an EXACT endpoint and the
// expected param value is a literal rather than an inequality. Renderer-
// independent by construction: no frame budget, no wall clock, no tuning.
//
// Runs on /rack?shell=legacy (no DB, no relay) — the normal e2e lane.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { pressFlipKey } from './_flip-key';
import {
  LANE_KCOL_MAX_PX,
  READOUT_MAX_CHARS,
} from '../../packages/web/src/lib/ui/workflow/lane-readout-fit';
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
  // The BOOT wait: the first test of a run pays SvelteKit's on-demand /rack?shell=legacy&seed=none
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
  await page.waitForFunction(
    (t) => {
      const tiles = Array.from(document.querySelectorAll('[data-shell-tier]'));
      return tiles.length > 0 && tiles.every((el) => el.getAttribute('data-shell-tier') === t);
    },
    tier,
    { timeout: 10_000 },
  );
}

test.describe('ringback face — the readouts follow the graph', () => {
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
    //    mix 1, and each readout must say what the number MEANS. `WET` is this
    //    module's spawn-time surprise: it is fully wet the instant you patch it.
    const rateOut = dock.getByTestId('readout-rate');
    const fbOut = dock.getByTestId('readout-feedback');
    const mixOut = dock.getByTestId('readout-mix');
    await expect(rateOut, 'half the input samples never reach the ring').toHaveText('SR/2.0');
    await expect(fbOut, 'the default tail is about six laps').toHaveText('6 LAPS');
    await expect(mixOut, 'a fresh RINGBACK is FULLY WET').toHaveText('WET');

    // ── THE DECLARED ABSENCE. SIZE declares NO vocabulary, and that is a
    //    decision: the quantity that matters is size/rate, which no per-param
    //    formatter can show. What changed in PF-20 is WHERE that decision is
    //    visible.
    //
    //    ⚠ THIS ASSERTION USED TO READ `readout-size` COUNT 0 AT THE DOCK, and
    //    PF-20 deliberately overturned the argument under it. "A readout is
    //    earned" was a LANE argument — a 46px knob column cannot spend a text
    //    row on what hovering already shows — and it was silently applied to
    //    the dock too. On a faceplate it was simply wrong: every mocked panel
    //    prints a value under every knob, and bare labels were the single
    //    largest share of the shell-vs-mock drift the owner reported. So the
    //    dock now prints the NUMBER for an undeclared param, and the "earned"
    //    rule survives where it was always true — the lane.
    //
    //    The absence is still asserted, and still where the regression would
    //    be silent: SIZE must print the raw ladder here (never a NAME, which
    //    would mean someone quietly gave it a vocabulary), and print NOTHING
    //    in the lane. ──
    await expect(dock.locator('[data-testid="control-size"]')).toBeVisible();
    await expect(
      dock.getByTestId('readout-size'),
      'the DOCK prints SIZE’s value — the raw ladder + its declared units, because it ' +
        'declared no vocabulary (a NAME here would mean someone quietly gave it one)',
    ).toHaveText('64.0 smp');

    const rateDial = dock.locator('[data-testid="control-rate"]');
    const fbDial = dock.locator('[data-testid="control-feedback"]');
    const mixDial = dock.locator('[data-testid="control-mix"]');

    // ── PAST THE TOP OF RATE'S ARC → exactly max. Above 1 no input sample is
    //    discarded, so the readout stops counting divisors. ──
    await dragDial(page, rateDial, -260);
    await expect
      .poll(() => readParam(page, 'rb', 'rate'), {
        message: 'dragging the dial COMMITS the new rate into the graph',
      })
      .toBe(RINGBACK_RATE.max);
    await expect(rateOut).toHaveText(formatRingbackRate(RINGBACK_RATE.max));
    await expect(rateOut).toHaveText('FULL SR');

    // ── PAST THE TOP OF FEEDBACK'S ARC → 0.98, the ring's hard ceiling: the
    //    tail outlasts 100 laps and the dial names the regime instead. ──
    await dragDial(page, fbDial, -260);
    await expect
      .poll(() => readParam(page, 'rb', 'feedback'))
      .toBe(RINGBACK_FEEDBACK.max);
    await expect(fbOut).toHaveText(formatRingbackFeedback(RINGBACK_FEEDBACK.max));
    await expect(fbOut).toHaveText('RINGING');

    // ── AND THE BOTTOM OF MIX → 0, the one setting that makes the module
    //    inaudible rather than different. ──
    await dragDial(page, mixDial, 260);
    await expect.poll(() => readParam(page, 'rb', 'mix')).toBe(0);
    await expect(mixOut).toHaveText(formatRingbackMix(0));
    await expect(mixOut).toHaveText('DRY');

    // ── THE NEGATIVE CONTROL, INLINE. Move ONE knob back and confirm the other
    //    two readouts do NOT follow it, and their params did not move either.
    //    Without this, three readouts hard-coded to their final strings would
    //    pass every assertion above. ──
    await dragDial(page, mixDial, -260);
    await expect.poll(() => readParam(page, 'rb', 'mix')).toBe(1);
    await expect(mixOut).toHaveText('WET');
    await expect(rateOut, 'rate’s readout is bound to rate, not to whatever moved last').toHaveText(
      'FULL SR',
    );
    await expect(fbOut).toHaveText('RINGING');
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
    const inSections = rear.locator('[data-testid="rear-section"][data-direction="input"]');
    await expect(inSections).toHaveCount(3);
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

  // ── THE LANE FIT, MEASURED ────────────────────────────────────────────────
  //
  // A readout that outgrows `--kcol-max` does NOT ellipsize: `.readout`'s
  // `max-width:100%` resolves against `.knob-wrap`, which is uncapped, so the
  // text ESCAPES the column (measured — see lane-readout-fit.ts). `FULL SR` is
  // 7 glyphs, the widest string this face can produce and exactly the budget,
  // so it is the case worth rendering rather than reasoning about.
  test('the widest readout STAYS INSIDE the 46px lane column', async ({ page }) => {
    test.setTimeout(SLOW_RENDER ? 60_000 : 30_000);
    await gotoShell(page);
    await spawnPatch(page, [
      { id: 'rb', type: 'ringback', position: { x: 460, y: 240 }, params: { rate: 1 } },
    ]);

    // The 46px cap is scoped to `.rl-tile .tile-body .kcol` — the LANE body.
    // The dock's band is uncapped, which is why a dock screenshot hides this.
    await setLaneTier(page, 0.45, 'compact');
    const laneShell = page.locator(
      '.svelte-flow__node[data-id="rb"] [data-testid="module-shell"][data-shell-tier="compact"]',
    );
    await expect(laneShell).toBeVisible();
    await expect(laneShell.locator('.tile-body .kcol')).not.toHaveCount(0);

    const readout = laneShell.getByTestId('readout-rate');
    await expect(readout).toHaveText('FULL SR');

    // ── THE SURVIVING HALF OF "A READOUT IS EARNED" (PF-20). The rule moved
    //    to the LANE, where its argument was always true: a 46px column cannot
    //    spend a text row on what hovering already shows. SIZE is rank 2, so
    //    the compact tile RENDERS it beside RATE — and prints nothing under it,
    //    because it declared no vocabulary. RATE, which declared one, prints.
    //    Asserting both in one place is what makes this a statement about the
    //    GATE rather than about one param. ──
    await expect(laneShell.locator('[data-testid="control-size"]')).toBeVisible();
    await expect(
      laneShell.getByTestId('readout-size'),
      'the LANE still earns its readouts — SIZE declared no vocabulary, so it prints none',
    ).toHaveCount(0);

    // ⚠ UNITS. `getBoundingClientRect()` on a flow node is VIEWPORT-SCALED
    // (xyflow applies a CSS transform for zoom — the measureOverflow trap in
    // CLAUDE.md). `offsetWidth` is a layout box and is immune to transforms,
    // so every width below is an offsetWidth, and the glyph probe is appended
    // to document.body, OUTSIDE the transformed subtree.
    const fit = await readout.evaluate((el) => {
      // Locator.evaluate hands us HTMLElement | SVGElement; offsetWidth (a
      // layout-px box) only exists on HTMLElement — assert it, don't cast.
      if (!(el instanceof HTMLElement)) throw new Error('readout is not an HTMLElement — offsetWidth (layout px) requires one');
      const cs = getComputedStyle(el);
      const kcol = el.closest('.kcol') as HTMLElement | null;
      if (!kcol) throw new Error('readout is not inside a .kcol — the cap does not apply');
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
        columnMaxWidthPx: parseFloat(getComputedStyle(kcol).maxWidth),
        advancePx,
      };
    });

    // The CSS cap the unit guard mirrors, read off a live column.
    expect(
      fit.columnMaxWidthPx,
      `--kcol-max drifted from LANE_KCOL_MAX_PX (${LANE_KCOL_MAX_PX})`,
    ).toBe(LANE_KCOL_MAX_PX);
    // The VERDICT, not the constant: this runner's `monospace` resolution is
    // platform-dependent and a hundredth of a px is noise; 7 glyphs no longer
    // fitting is not.
    expect(
      READOUT_MAX_CHARS * fit.advancePx,
      `${READOUT_MAX_CHARS} glyphs at this runner's ${fit.advancePx.toFixed(3)} px/glyph`,
    ).toBeLessThanOrEqual(LANE_KCOL_MAX_PX);
    expect(
      fit.readoutWidthPx,
      `'${fit.text}' laid out at ${fit.readoutWidthPx} px against a ${fit.columnMaxWidthPx} px column`,
    ).toBeLessThanOrEqual(fit.columnMaxWidthPx);
  });
});
