// e2e/tests/xy-pad-cell.spec.ts
//
// DOM gate for the `xy` PARAM CELL — the 2-D pad, and the substitute
// `param-cell-coverage.test.ts` names for it.
//
// The cell kind lands one PR before its first consumer (no shipped def declares
// `face.xyPads`), so faces-parity NEVER ENTERS its `driveCell` arm — and for
// this kind that arm is the one that proves ONE DRAG MOVES BOTH AXES, i.e. the
// entire reason the kind exists. That gap is declared in the unit lane rather
// than discovered on the first face PR's red shard; this spec is what makes the
// declaration honest.
//
// FOUR properties, none of them visible to a unit test:
//
//  1. ONE DIAGONAL DRAG COMMITS BOTH AXES. Two knobs can reach every value this
//     pad can and cannot reach them TOGETHER. A pad wired to a single axis
//     passes every 1-D assertion in the suite and fails here.
//  2. THE PAD DECLARES WHAT IT COVERS (`data-control-params` = both axis ids).
//     That attribute is what lets faces-parity keep EXACT multiset equality
//     over a control that is one element for two params; without it a faced pad
//     reads as two LOST controls.
//  3. ⚠ THE WITNESS FOLLOWS THE COMMITTED VALUES, NOT THE DOT. XyPad owns the
//     dot during a gesture (its own synchronous live value, so a CV poll cannot
//     fight the drag), which means "the dot moved" is ALSO true of a pad whose
//     writes go nowhere. The showcase renders a deliberately SEVERED pad — same
//     component, both handlers discarded — so the distinction is negative-
//     controlled in a browser on every sweep rather than argued once.
//  4. PER-AXIS RANGES CLAMP INSIDE THE PRIMITIVE. This is the control the
//     backdraft regression is named after: the card passed literal ±1 against a
//     def declaring ±0.2, the pad wrote values the contract forbids, and the
//     model clamped them where nobody could see it.
//
// Runs against the dev-only showcase (the /dev/color-field + /dev/param-grid
// precedent), gated on testHooksEnabled() and so reachable in the `vite
// preview` bundle the CI shards use.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { idsCoveredBy, paramsCoveredByCell } from './support/cell-coverage';

async function gotoShowcase(page: Page): Promise<void> {
  await page.goto('/dev/xy-pad');
  // WAIT ON HYDRATION, NOT ON PAINT — the color-field precedent. The route is
  // server-rendered, so the pad is visible a beat before Svelte attaches its
  // pointer handlers, and a gesture in that window is silently swallowed. That
  // was a real `--repeat-each=3` flake on the sibling showcase.
  await expect(page.locator('[data-testid="xy-pad-page"][data-hydrated="true"]')).toBeVisible();
}

const host = (page: Page, which: string) => page.getByTestId(`${which}-host`);
const witness = (page: Page, which: string) => page.getByTestId(`${which}-witness`);
const padIn = (h: Locator) => h.locator('[data-control-params]');

/** Drag from the pad's centre to a fraction of its box — one gesture, both
 *  axes. Steps so the pointermove stream is real rather than a teleport. */
async function dragPad(page: Page, pad: Locator, fx: number, fy: number): Promise<void> {
  await pad.scrollIntoViewIfNeeded();
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 8 });
  await page.mouse.up();
}

test.describe('xy pad cell — the 2-D param cell', () => {
  test('ONE drag commits BOTH axes (the property two knobs cannot have)', async ({ page }) => {
    await gotoShowcase(page);
    const h = host(page, 'live');
    await expect(witness(page, 'live')).toHaveText('0.0000 / 0.0000');

    await dragPad(page, padIn(h), 0.15, 0.85);

    const text = (await witness(page, 'live').textContent()) ?? '';
    const [x, y] = text.split('/').map((s) => Number(s.trim()));
    // Direction is asserted, not just movement: dragging LEFT and DOWN must
    // lower x and lower y (drag UP = larger y, the joystick convention the
    // primitive implements). A pad that moved both axes the wrong way would
    // satisfy a bare "it changed" check.
    expect(x, `x must fall when dragging left (got ${text})`).toBeLessThan(0);
    expect(y, `y must fall when dragging down (got ${text})`).toBeLessThan(0);
  });

  test('the pad DECLARES both axis ids, so a face keeps its exact param multiset', async ({
    page,
  }) => {
    await gotoShowcase(page);
    const pad = padIn(host(page, 'live'));
    await expect(pad).toHaveAttribute('data-control-params', 'liveX,liveY');
    // …and it is ONE element, not two. The whole reason the attribute exists is
    // that the `control-<paramId>` convention assumes one element per param.
    await expect(pad).toHaveCount(1);
    await expect(pad).toHaveAttribute('data-testid', 'control-liveX');
  });

  test('faces-parity’s OWN coverage functions read this pad as TWO params', async ({ page }) => {
    // ⚠ THE LEG THAT MAKES THE PARITY REWORK MORE THAN A REFACTOR. faces-parity
    // now counts params COVERED rather than cells rendered, and reads a
    // declared set in preference to the testid — but NO SHIPPED FACE DECLARES A
    // PAD, so on every green run over there the two-param branch of both
    // functions is DEAD CODE. Its first execution would otherwise be the first
    // face PR to adopt `face.xyPads`, i.e. a red shard with the platform author
    // gone.
    //
    // So this drives the REAL exported functions — the same ones imported by
    // faces-parity, not a copy of the rule — against a REAL pad's attributes.
    const pad = padIn(host(page, 'live'));
    await gotoShowcase(page);
    const attrs = {
      testid: await pad.getAttribute('data-testid'),
      covered: await pad.getAttribute('data-control-params'),
    };

    // The multiset reader: a declared set WINS over the anchor testid. Reading
    // the testid alone is what would report `liveY` as a LOST control.
    expect(idsCoveredBy(attrs)).toEqual(['liveX', 'liveY']);
    // The cell counter, for the wrapper kind the shell emits for an xy cell.
    expect(paramsCoveredByCell('param', attrs.covered)).toBe(2);

    // And both must still be right for the 1-D case every other primitive is —
    // the direction that would turn all 33 shipped faces red if the fallback
    // were dropped.
    expect(idsCoveredBy({ testid: 'control-cutoff', covered: null })).toEqual(['cutoff']);
    expect(paramsCoveredByCell('param', null)).toBe(1);
    expect(paramsCoveredByCell('family', null)).toBe(0);
  });

  test('NEGATIVE CONTROL: a SEVERED pad tracks the cursor and commits nothing', async ({
    page,
  }) => {
    await gotoShowcase(page);
    const h = host(page, 'severed');
    await dragPad(page, padIn(h), 0.15, 0.85);

    // The handlers DID fire — so this is "severed", not "never driven". Without
    // this leg a spec that failed to reach the pad at all would pass the next
    // assertion perfectly.
    await expect(
      page.getByTestId('severed-attempts'),
      'the drag must have reached the pad at all',
    ).not.toHaveText('0');
    await expect(
      witness(page, 'severed'),
      'a pad whose writes go nowhere still moves its own dot — the witness must not follow it',
    ).toHaveText('0.0000 / 0.0000');
  });

  test('per-axis ranges CLAMP inside the primitive (the backdraft shape)', async ({ page }) => {
    await gotoShowcase(page);
    const h = host(page, 'clamped');
    const bounds = ((await page.getByTestId('clamped-bounds').textContent()) ?? '')
      .split('/')
      .map((s) => Number(s.trim()));

    // Drag hard past the corner: the gesture asks for the full ±1 travel.
    await dragPad(page, padIn(h), -0.5, 1.5);

    const text = (await witness(page, 'clamped').textContent()) ?? '';
    const [x, y] = text.split('/').map((s) => Number(s.trim()));
    expect(Math.abs(x), `x must clamp to the declared ±${bounds[0]} (got ${text})`).toBeLessThanOrEqual(
      bounds[0]! + 1e-6,
    );
    expect(Math.abs(y), `y must clamp to the declared ±${bounds[1]} (got ${text})`).toBeLessThanOrEqual(
      bounds[1]! + 1e-6,
    );
    // …and it actually TRAVELLED, so "clamped" is not "inert". The two axes have
    // DIFFERENT bounds, so a primitive that ignored per-axis ranges and used one
    // span for both would fail one of these.
    expect(Math.abs(x), `x must have moved (got ${text})`).toBeGreaterThan(0);
    expect(Math.abs(y), `y must have moved (got ${text})`).toBeGreaterThan(0);
    expect(bounds[0], 'the two axes must have DIFFERENT bounds or this proves nothing').not.toBe(
      bounds[1],
    );
  });
});
