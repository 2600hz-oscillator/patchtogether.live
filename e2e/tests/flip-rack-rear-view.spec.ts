// e2e/tests/flip-rack-rear-view.spec.ts
//
// Rack Phase 3 — "Flip rack" (rear view), ON BOTH RENDERERS.
//
// The Flip rack toggle (top of the SvelteFlow Controls panel) and the `F`
// shortcut flip EVERY card over its own Y axis IN PLACE to reveal a back panel
// of patch jacks, so the user can trace wiring from behind. It's LOCAL view
// state (a $state boolean in Canvas) — not synced, not per-node, one global
// toggle.
//
// ⚠ WHY THIS SPEC IS PARAMETRIZED OVER THE RENDERER (#1605).
//
// It used to run only through the `rack` fixture, i.e. only against the
// PRE-INVERSION renderer. The rack every user on dev and prod actually gets
// renders each module as a
// RACKLINE TILE (ModuleShell / ModuleShellPlaceholder), and on that rack the
// flip was a total visual NO-OP for months: one line of CSS
// (`.rl-tile .card-back-panel{display:none!important}`, written when the shell
// was an opt-in second renderer) suppressed the tile's rear face. Pressing F
// set `rearView`, added `.rear-view` to the flow container and moved the
// control to `aria-pressed=true` — and nothing on screen changed. The suite was
// green the whole time, because it was green about a renderer the product had
// stopped using.
//
// So the contract below is asserted against BOTH racks from one body. The two
// renderers share PatchPanel — hence the same rear face and the same locators —
// which is exactly why running one and inferring the other was so easy to do
// and so wrong.
//
// ⚠ AND WHY IT ASSERTS PIXELS-ON-SCREEN, NEVER THE CLASS. `.rear-view` was
// present on the flow container for the entire life of the defect. A spec that
// gates on the class (or on `aria-pressed`) is structurally blind to the whole
// failure: it re-reads the state we already know changed. The load-bearing
// assertions here are (a) the back panel is VISIBLE and (b) `elementFromPoint`
// over a jack resolves THAT JACK — i.e. the rear face is both rendered and
// hit-testable, the two things a user needs to trace and re-patch from behind.

import { test, expect, type Page } from './_fixtures';
import { spawnPatch } from './_helpers';
import { pressFlipKey } from './_flip-key';

test.describe.configure({ mode: 'parallel' });

/** The rack renderers this spec runs the flip against.
 *
 *  Since the S2 inversion there is ONE — the shipping shell. The second arm was
 *  DELETED with the fixture flip: its subject was the opt-out renderer itself,
 *  which left the product in S4. A renderer that cannot satisfy the body below
 *  is a renderer whose flip is broken. */
const RENDERERS = [
  { name: 'shell (default rack)', url: '/rack?seed=none' },
] as const;

/** What `elementFromPoint` resolves at the CENTRE of `selector`, described as
 *  the nearest interesting ancestor. Reported as a string so a failure message
 *  says what was actually on top, not just "expected true". */
async function hitTestCentre(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return `MISSING ${sel}`;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return `ZERO-BOX ${sel}`;
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top) return 'NOTHING';
    if (top.closest('[data-testid="back-jack"]')) return 'back-jack';
    if (top.closest('[data-testid="card-back-panel"]')) return 'card-back-panel (chrome)';
    return top.tagName.toLowerCase();
  }, selector);
}

/**
 * How many elements of the node's FRONT face are actually painted — laid out,
 * `visibility: visible`, and not part of the rear face.
 *
 * ⚠ THE INSTRUMENT IS THE POINT. The defect this spec exists for was a rear
 * view where every piece of STATE said "flipped" and every pixel said "not
 * flipped", so anything derived from the state is blind to it by construction.
 * This counts paint.
 *
 * It is also deliberately RENDERER-NEUTRAL, which is what lets one body assert
 * both racks: the two renderers put different things on a card front (measured:
 * 47 elements for the shell's ADSR tile, 41 for the legacy ADSR card) but the
 * flip's contract is identical and is expressed as a RATIO to the test's own
 * baseline, never as a typed number — in rear view exactly ONE element of the
 * front survives, the card root itself, which is the surface the rear face is
 * painted onto. Both racks measured 1.
 */
async function visibleFrontElements(page: Page, nodeId: string): Promise<number> {
  return page.evaluate((id) => {
    const node = document.querySelector(`.svelte-flow__node[data-id="${id}"]`);
    if (!node) return -1;
    return Array.from(node.querySelectorAll('*')).filter((el) => {
      if (el.closest('[data-testid="card-back-panel"]')) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return false;
      return getComputedStyle(el).visibility === 'visible';
    }).length;
  }, nodeId);
}

for (const renderer of RENDERERS) {
  test.describe(`flip-rack — ${renderer.name}`, () => {
    test('the Flip control reveals a LIVE rear face in place, then hides it', async ({ page }) => {
      await page.goto(renderer.url);
      await page.waitForLoadState('networkidle');
      // A tiny 2-card patch is enough — the toggle is global.
      await spawnPatch(
        page,
        [
          { id: 'adsr', type: 'adsr', position: { x: 120, y: 120 } },
          { id: 'vca', type: 'vca', position: { x: 460, y: 120 } },
        ],
        [],
      );
      await expect(page.locator('.svelte-flow__node')).toHaveCount(2);

      const flow = page.locator('.flow');
      const flipBtn = page.getByRole('button', { name: 'Flip rack (rear view)' });
      await expect(flipBtn).toBeVisible();
      await expect(flipBtn).toHaveAttribute('aria-pressed', 'false');

      const adsr = page.locator('.svelte-flow__node[data-id="adsr"]');
      const adsrBack = adsr.getByTestId('card-back-panel');
      const firstJack = adsr.getByTestId('back-jack').first();

      // Back panels exist in the DOM at all times (so the reveal needs no mount)
      // but are display:none until rear view → not visible yet.
      await expect(adsrBack).toHaveCount(1);
      await expect(adsrBack).toBeHidden();

      // Record the node's canvas position before flipping — "in place" means it
      // must not change when we flip — and the FRONT PAINT baseline this test
      // measures its own before/after against.
      const beforeBox = await adsr.boundingBox();
      expect(beforeBox).not.toBeNull();
      const frontPaint = await visibleFrontElements(page, 'adsr');
      expect(
        frontPaint,
        `${renderer.name}: the card front is not painted before the flip — the baseline is bad, not the flip`,
      ).toBeGreaterThan(1);

      // ── ON ────────────────────────────────────────────────────────────────
      await flipBtn.click();
      await expect(flipBtn).toHaveAttribute('aria-pressed', 'true');
      await expect(flow).toHaveClass(/rear-view/);

      // THE ASSERTION THE OLD SPEC WAS MISSING ON THIS RENDERER: the rear face
      // is actually on screen, with the module name and its declared jacks.
      await expect(adsrBack).toBeVisible();
      await expect(adsr.getByTestId('card-back-title')).toBeVisible();
      // ADSR declares a GATE input + ENV output → jack holes render, labelled.
      await expect(adsrBack.locator('.back-jack .jack-hole').first()).toBeVisible();
      await expect(adsrBack.getByText('GATE', { exact: true })).toBeVisible();

      // …and it is REACHABLE: rear-view jacks are live patch points, so the
      // topmost element over a jack must BE that jack. (A rear face painted
      // under an inert-but-still-hit-testable front is the same defect wearing
      // a different mask — this is what proves you can re-patch from behind.)
      await expect
        .poll(() => hitTestCentre(page, '.svelte-flow__node[data-id="adsr"] [data-testid="back-jack"]'), {
          message: `${renderer.name}: rear view is painted but the jack is not hit-testable`,
        })
        .toBe('back-jack');
      await expect(firstJack).toBeVisible();

      // PERMANENT NEGATIVE CONTROL (the other half of the flip): the FRONT must
      // now be GONE, not merely covered. A rear face painted over a live front
      // is the same defect wearing a different mask. Exactly the card root
      // survives — it is the surface the rear face is painted onto.
      await expect
        .poll(() => visibleFrontElements(page, 'adsr'), {
          message: `${renderer.name}: the card front is still painted in rear view (baseline ${frontPaint} elements)`,
        })
        .toBe(1);

      // The node did NOT move (flip is in place, not a whole-rack mirror).
      // Sub-pixel tolerance for layout rounding.
      const afterBox = await adsr.boundingBox();
      expect(afterBox).not.toBeNull();
      expect(Math.abs(afterBox!.x - beforeBox!.x)).toBeLessThan(2);
      expect(Math.abs(afterBox!.y - beforeBox!.y)).toBeLessThan(2);

      // Both cards flip (global toggle) — the VCA rear face is visible too.
      await expect(
        page.locator('.svelte-flow__node[data-id="vca"]').getByTestId('card-back-panel'),
      ).toBeVisible();

      // ── OFF ───────────────────────────────────────────────────────────────
      await flipBtn.click();
      await expect(flipBtn).toHaveAttribute('aria-pressed', 'false');
      await expect(flow).not.toHaveClass(/rear-view/);
      await expect(adsrBack).toBeHidden();
      // …and the front is PAINTED again — the return leg, measured against this
      // test's own baseline rather than any typed number.
      await expect
        .poll(() => visibleFrontElements(page, 'adsr'), {
          message: `${renderer.name}: the card front did not come back after flipping to front`,
        })
        .toBe(frontPaint);
    });

    test('the flip key flips the rack front↔rear', async ({ page }) => {
      await page.goto(renderer.url);
      await page.waitForLoadState('networkidle');
      await spawnPatch(page, [{ id: 'adsr', type: 'adsr', position: { x: 120, y: 120 } }], []);
      await expect(page.locator('.svelte-flow__node')).toHaveCount(1);

      const flow = page.locator('.flow');
      const flipBtn = page.getByRole('button', { name: 'Flip rack (rear view)' });
      const adsrBack = page.locator('.svelte-flow__node[data-id="adsr"]').getByTestId('card-back-panel');
      await expect(flow).not.toHaveClass(/rear-view/);
      await expect(adsrBack).toBeHidden();

      // The flip key on the canvas (nothing text-editable focused) → rear view.
      await page.locator('body').click({ position: { x: 5, y: 300 } });
      await pressFlipKey(page);
      await expect(flow).toHaveClass(/rear-view/);
      await expect(flipBtn).toHaveAttribute('aria-pressed', 'true');
      // The state moved AND the face did — the pair, never the state alone.
      await expect(adsrBack).toBeVisible();

      // Press again → back to front.
      await pressFlipKey(page);
      await expect(flow).not.toHaveClass(/rear-view/);
      await expect(flipBtn).toHaveAttribute('aria-pressed', 'false');
      await expect(adsrBack).toBeHidden();
    });
  });
}
