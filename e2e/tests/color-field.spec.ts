// e2e/tests/color-field.spec.ts
//
// DOM gate for <ColorField> — the packed-RGB colour cell, and the substitute
// `param-cell-coverage.test.ts` names for it.
//
// ColorField lands one PR before its first consumer (wavesculpt's face), so no
// `face.paramCells['x'] = 'color'` exists and faces-parity NEVER ENTERS its
// `color` branch. That gap is declared in the unit lane rather than discovered
// on the face PR's first red shard; this spec is what makes the declaration
// honest.
//
// FOUR properties, all invisible to a unit test:
//
//  1. The `<input type="color">` IS the visible swatch. The legacy
//     WavesculptCard hides a zero-opacity input under a decorative <span>,
//     which works for a human and makes the visible thing and the operable
//     thing two different elements — so `toBeVisible()` on one proves nothing
//     about the other, and a script can drive an input no player can reach.
//  2. The input carries `control-<paramId>` exactly once — the multiset
//     property faces-parity's dock assertion depends on.
//  3. ⚠ THE WITNESS FOLLOWS THE COMMITTED VALUE, NOT THE PICKER — the leg that
//     tells "changed the colour" apart from "rendered a swatch". A native
//     colour input shows whatever was picked regardless of whether anything
//     was written; only an element derived from the value coming BACK can
//     distinguish the two. The showcase renders a deliberately SEVERED cell
//     (same component, `onchange` discarded) so this is negative-controlled in
//     a browser on every sweep rather than argued once in a comment.
//  4. The RANGE comes from the props — i.e. from the def — so a pick past a
//     narrowed `max` clamps rather than writing through. No literal bound
//     lives inside the primitive.
//
// Runs against the dev-only showcase (the /dev/param-grid + /dev/glyphs
// precedent), gated on testHooksEnabled() and so reachable in the `vite
// preview` bundle the CI shards use.

import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  nextProbeColor,
  packedToHex,
} from '../../packages/web/src/lib/ui/controls/color-field-model';

async function gotoShowcase(page: Page): Promise<void> {
  await page.goto('/dev/color-field');
  // WAIT ON HYDRATION, NOT ON PAINT — the param-grid precedent. The route is
  // server-rendered, so the input is visible a beat before Svelte attaches its
  // handler and a gesture in that window is silently swallowed. That was a
  // real `--repeat-each=3` flake on the sibling showcase.
  await expect(page.locator('[data-testid="color-field-page"][data-hydrated="true"]')).toBeVisible();
  await expect(page.getByTestId('live-host')).toBeVisible();
}

const swatch = (page: Page, pid: string) => page.getByTestId(`control-${pid}`);
// ⚠ THE WITNESS IS `aria-valuetext` ON THE CONTROL, NOT A PAINTED SPAN.
// It was `colorhex-<pid>` until 2026-08-20, when that span was found printing a
// VALUE at rest on a faceplate (#2038's class, second instance). It moved to the
// accessible tree; the DISCIPLINE is unchanged — it still reads the `value` PROP
// rather than the input's own state, which is what makes the severed-cell test
// below possible at all.
const witness = (page: Page, pid: string) => page.getByTestId(`control-${pid}`);
/** The witness's text, wherever it lives. One helper so the two consumers of this
 *  contract cannot drift apart again. */
const witnessHex = (page: Page, pid: string) => witness(page, pid).getAttribute('aria-valuetext');

/** Set the picker to `hex` the way the browser does while a player drags
 *  inside the native dialog. A click would open an OS window Playwright cannot
 *  drive, which is why the parity probe does the same thing. */
async function pick(input: Locator, hex: string): Promise<void> {
  await input.scrollIntoViewIfNeeded();
  await input.evaluate((el, h) => {
    (el as HTMLInputElement).value = h;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, hex);
}

test.describe('ColorField — the swatch IS the control', () => {
  test('is a real, visible, hit-targetable <input type="color">', async ({ page }) => {
    await gotoShowcase(page);
    const input = swatch(page, 'red_color');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('type', 'color');
    await expect(input).toBeEnabled();

    // THE ASSERTION THIS CASE EXISTS FOR. A hidden input behind a decorative
    // swatch satisfies every `getByTestId` in this file and is unreachable by
    // a player; only its painted box tells them apart.
    const box = (await input.boundingBox())!;
    expect(box.width, 'the input has real painted width').toBeGreaterThan(20);
    expect(box.height, 'the input has real painted height').toBeGreaterThan(10);

    // Exactly one — the multiset property faces-parity depends on.
    await expect(page.locator('[data-testid="control-red_color"]')).toHaveCount(1);
  });

  test('starts on the committed value, in the browser’s own hex normalisation', async ({ page }) => {
    await gotoShowcase(page);
    // `packedToHex` emits lowercase `#rrggbb` because that is what Chromium
    // normalises an input's `value` to; an uppercase emitter would make every
    // comparison in this file a coin flip on that normalisation.
    await expect(swatch(page, 'red_color')).toHaveValue('#ff3333');
    await expect.poll(() => witnessHex(page, 'red_color')).toBe('#ff3333');
    await expect(page.getByTestId('live-packed')).toHaveText('16724787'); // 0xff3333
  });
});

test.describe('ColorField — picking a colour COMMITS it', () => {
  test('the graph value, the witness and the picker all reach the picked colour', async ({ page }) => {
    await gotoShowcase(page);
    const before = 0xff3333;
    const want = nextProbeColor(before);
    const wantHex = packedToHex(want);
    expect(want, 'the probe must ask for a DIFFERENT colour').not.toBe(before);

    await pick(swatch(page, 'red_color'), wantHex);

    await expect(page.getByTestId('live-packed'), 'the EXACT packed value commits').toHaveText(
      String(want),
    );
    await expect.poll(() => witnessHex(page, 'red_color'), 'the witness follows').toBe(wantHex);
    await expect(swatch(page, 'red_color')).toHaveValue(wantHex);
  });

  test('all THREE channels survive the round trip', async ({ page }) => {
    await gotoShowcase(page);
    // A component that dropped or aliased a channel would still "change the
    // colour" and still move the witness. Only an exact asymmetric value
    // catches it — `#123456` has three distinct channels, none of them 0 or
    // 255, so a shift, a mask or a swap all show.
    await pick(swatch(page, 'red_color'), '#123456');
    await expect(page.getByTestId('live-packed')).toHaveText(String(0x123456));
    await expect.poll(() => witnessHex(page, 'red_color')).toBe('#123456');
  });
});

test.describe('ColorField — ⚠ THE NEGATIVE CONTROL: a swatch that writes nothing', () => {
  test('the witness does NOT follow a severed cell, though the picker does', async ({ page }) => {
    await gotoShowcase(page);
    const input = swatch(page, 'grn_color');
    await expect.poll(() => witnessHex(page, 'grn_color')).toBe('#33ff4d');

    await pick(input, '#123456');

    // The handler DID fire — so this is "the write was dropped", not "the
    // gesture never landed". Without this leg a spec that failed to reach the
    // input at all would satisfy every assertion below it.
    await expect(page.getByTestId('severed-attempts'), 'the gesture reached the cell').toHaveText('1');

    // The native picker shows the chosen colour. It ALWAYS does — the browser
    // owns that element's display, and this is precisely why a screenshot, a
    // VRT baseline, or `toBeVisible()` cannot tell a live colour control from
    // a decorative one.
    await expect(input, 'the picker shows the pick regardless').toHaveValue('#123456');

    // …and the witness does not move, because it reads the value that came
    // BACK. This is the assertion the parity probe's third leg is made of.
    await expect
      .poll(
        () => witnessHex(page, 'grn_color'),
        'a severed colour cell must be DISTINGUISHABLE from a live one — if this followed the ' +
          'picker, faces-parity could not tell a decorative swatch from a working control',
      )
      .toBe('#33ff4d');
    await expect(page.getByTestId('severed-packed')).toHaveText(String(0x33ff4d));
  });
});

test.describe('ColorField — the RANGE comes from the def, not from the primitive', () => {
  test('a pick above the declared max CLAMPS instead of writing through', async ({ page }) => {
    await gotoShowcase(page);
    // The clamped host declares 0..0x0000ff. `#ffffff` is far outside it.
    await pick(swatch(page, 'blu_color'), '#ffffff');
    await expect(page.getByTestId('clamped-packed'), 'clamped to the declared max').toHaveText(
      String(0x0000ff),
    );
    await expect.poll(() => witnessHex(page, 'blu_color')).toBe('#0000ff');
  });

  test('a pick INSIDE the declared span is untouched', async ({ page }) => {
    // The other direction, so the clamp above cannot be a constant.
    await gotoShowcase(page);
    await pick(swatch(page, 'blu_color'), '#00007f');
    await expect(page.getByTestId('clamped-packed')).toHaveText(String(0x00007f));
    await expect.poll(() => witnessHex(page, 'blu_color')).toBe('#00007f');
  });
});
