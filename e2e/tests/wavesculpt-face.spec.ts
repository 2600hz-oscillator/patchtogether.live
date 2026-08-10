// e2e/tests/wavesculpt-face.spec.ts
//
// WAVESCULPT's CURATED FACE, driven for real under `?shell=1`. One claim, and
// it is the one NOTHING else in the repo can settle:
//
//   THE HERO ROOM PLAN IS A JOYSTICK, AND IT LANDS WHERE YOU DROP IT.
//
// The platform has no XY-pad primitive, so the five camera axes would otherwise
// be five dials and the legacy card's defining affordance would be lost. The
// face answers that with a `panel` cell — "a picture you EDIT" — whose drag
// writes `pos_x` + `pos_z` through the exact inverse of `eyeFromCamera`.
//
// ⚠ WHY NO EXISTING GATE COVERS IT, stated rather than assumed:
//
//   * `faces-parity`'s panel arm drives the cell's DECLARED probe, and a panel
//     probe's effect kinds are `data` / `data-rev` / `text` — all of which read
//     `node.data` or DOM text. A camera drag writes `node.params`, which is
//     structurally invisible to every one of them. So this panel's probe is
//     (correctly) its output-TAP row, and the drag is unprobed there.
//   * `module-face-lint` and `contract-lock` read the DEF. A panel component
//     disagreeing with the def is exactly the class CLAUDE.md's "a CARD can
//     silently disagree with its DEF" section is about.
//   * `wavesculpt-face-model.test.ts` pins the ARITHMETIC (the drag inverts
//     `eyeFromCamera` exactly, and clamps to the declared ±1) — but a pure
//     function cannot see the DOM plumbing that feeds it.
//
// ⚠ AND IT IS A REAL REGRESSION TEST, not a hypothetical. The first
// implementation mapped the pointer straight off `getBoundingClientRect()`,
// which is WRONG: the viewBox is square and `preserveAspectRatio` defaults to
// `xMidYMid meet`, so in the wide hero bay the drawing occupies a ~196 px
// square in the MIDDLE of a ~780 px element and everything either side is
// letterbox. The camera did not follow the pointer. It was found by LOOKING at
// the rendered VRT baseline; no assertion anywhere would have caught it.
//
// ⚠ THE ORACLE IS THE BROWSER'S OWN `getScreenCTM()`, deliberately — NOT a
// re-derivation of the letterbox maths in this file. A test that recomputed
// "where the square is" the same way the component does would share the
// component's blind spot and pass a wrong implementation (the raw-write-guard
// self-test failure, in miniature). The SVG's screen CTM is the browser's
// answer to "where did you actually draw viewBox point (x, y)", which is a
// source of truth independent of both.
//
// AUDIO-AVAILABILITY / RENDERER: none needed. A migrated module renders the
// curated shell, NOT the legacy WebGL card, so this spec mounts no 3D context
// and makes no pixel assertion — nothing here is renderer-dependent.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

test.describe.configure({ mode: 'parallel' });

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

/** The camera the drag is exercised at. ZOOM 3 rather than the default 1 for a
 *  stated reason: `eyeFromCamera`'s rotational offset is `2.5 / zoom`, which at
 *  zoom 1 is 2.5 room units — further than `pos_z`'s whole ±1 range can undo,
 *  so every target CLAMPS and a broken mapping would clamp to the same answer
 *  as a correct one. At zoom 3 the offset is 0.8333 and the targets below are
 *  genuinely reachable, so the assertion discriminates. */
const ZOOM = 3;
const BASE_DIST = 2.5 / ZOOM;
/** The plan's half-extent in room units (ROOM_PLAN_EXTENT in the face model). */
const EXTENT = 3;

/** The camera the component must write for a drop at plan coord (px, py), from
 *  the module's own law: `eye = pos · 1.5 + rotationalOffset`, inverted. At
 *  rot 0 the offset is (0, +BASE_DIST). */
function expectedCamera(px: number, py: number): { pos_x: number; pos_z: number } {
  const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v));
  return {
    pos_x: clamp1((px * EXTENT - 0) / 1.5),
    pos_z: clamp1((py * EXTENT - BASE_DIST) / 1.5),
  };
}

test('wavesculpt face: the hero ROOM PLAN is a joystick — a drag writes the camera the drop point implies', async ({
  page,
}) => {
  // SIZED, NOT FLAT (ci-swiftshader-video-e2e-timeouts) — a failure bound only.
  test.setTimeout(SLOW_RENDER ? 120_000 : 60_000);

  // `?shell=1` mounts the video-zone defaults, software-rasterized on CI on the
  // same main thread this spec does its round-trips against. Nothing here
  // asserts a rendered frame, so the render loop is pure contention.
  await installRenderSmokeHooks(page);
  await page.goto('/rack?mode=workflow&shell=1');
  // 30 s is a FAILURE BOUND, not the gate: the first navigation to /rack on a
  // cold dev server compiles the whole route graph on demand.
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });

  await spawnPatch(
    page,
    [{ id: 'ws', type: 'wavesculpt', position: { x: 360, y: 60 }, domain: 'audio', params: { zoom: ZOOM } }],
    [],
  );

  const shell = page.locator('.svelte-flow__node[data-id="ws"] [data-testid="module-shell"]');
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible();

  // The face's shape where it is actually rendered: EIGHT bands, which is what
  // puts it over DOCK_TAB_MIN_BANDS and gives it a rail.
  await expect(faceplate.locator('[data-face-page]')).toHaveCount(8);
  await expect(
    faceplate.locator('[role="tab"]'),
    'eight bands ⇒ a tab rail (DOCK_TAB_MIN_BANDS is 7)',
  ).toHaveCount(8);

  const stage = faceplate.getByTestId('wavesculpt-room-stage');
  await expect(stage).toBeVisible();

  /**
   * The rendered width, in CSS px, of the 100-unit viewBox — read off the
   * browser's own CTM, so it is the plan's REAL scale rather than an assumed
   * one.
   *
   * ⚠ THE TOLERANCE IS DERIVED FROM IT, NOT GUESSED. `page.mouse` dispatches at
   * integer device pixels, so a drop lands within half a pixel of the intended
   * point and the resulting param is quantised by `(EXTENT / 1.5) · (2 / side)`
   * per pixel — 0.0204 at a 196 px plan. A hand-picked `toBeCloseTo(x, 2)`
   * (±0.005) is FOUR TIMES tighter than the instrument can resolve and failed
   * on its first run by 0.0061, which is a measurement artefact wearing the
   * costume of a bug. Two pixels of slack; the defect this test exists for (a
   * letterboxed mapping) is a ~4× error, roughly 15 px, so nothing is masked.
   */
  const sidePx = await stage.evaluate((el) => {
    const m = (el as unknown as SVGSVGElement).getScreenCTM();
    return m ? m.a * 100 : 0;
  });
  expect(sidePx, 'the plan has a real rendered scale (units: CSS px per 100 viewBox units)').toBeGreaterThan(80);
  const TOL = (EXTENT / 1.5) * (2 / sidePx) * 2;

  /** viewBox point → screen point, THROUGH THE BROWSER's own transform. */
  async function screenOf(vx: number, vy: number): Promise<{ x: number; y: number }> {
    const pt = await stage.evaluate(
      (el, p) => {
        const svg = el as unknown as SVGSVGElement;
        const m = svg.getScreenCTM();
        if (!m) return null;
        return { x: m.a * p.vx + m.c * p.vy + m.e, y: m.b * p.vx + m.d * p.vy + m.f };
      },
      { vx, vy },
    );
    expect(pt, 'the SVG reports a screen CTM (it is laid out and visible)').not.toBeNull();
    return pt!;
  }

  async function readCamera(): Promise<{ pos_x: number; pos_z: number }> {
    return await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> }> };
      };
      const p = w.__patch.nodes['ws']?.params ?? {};
      return { pos_x: p.pos_x ?? 0, pos_z: p.pos_z ?? 0 };
    });
  }

  // ── NEGATIVE CONTROL, FIRST: nothing has been dragged, so the camera is
  // untouched. A "moved after" assertion alone would pass against a graph that
  // was already there. ──
  const before = await readCamera();
  expect(before, 'the camera is at its spawn default before any drag').toEqual({ pos_x: 0, pos_z: 0 });

  // ── LEG 1 — a drop LEFT OF CENTRE. plan (−0.2, 0) is viewBox (40, 50).
  // ⚠ THIS IS THE LETTERBOX LEG. Under the old element-rect mapping this exact
  // screen point reads as plan x ≈ −0.05 rather than −0.2 — a 4× error — so a
  // regression fails here by a wide margin rather than by a rounding hair. ──
  const p1 = await screenOf(40, 50);
  await page.mouse.move(p1.x, p1.y);
  await page.mouse.down();
  await page.mouse.move(p1.x, p1.y, { steps: 3 });
  await page.mouse.up();

  const want1 = expectedCamera(-0.2, 0);
  await expect
    .poll(async () => (await readCamera()).pos_x !== before.pos_x, {
      message: 'the drag reached the graph at all (units: BOOLEAN — a write happened)',
    })
    .toBe(true);
  const got1 = await readCamera();
  expect(
    Math.abs(got1.pos_x - want1.pos_x),
    `pos_x for plan x −0.2: wanted ${want1.pos_x.toFixed(4)}, got ${got1.pos_x.toFixed(4)} ` +
      `(units: PARAM; tolerance ${TOL.toFixed(4)} = 2 device px at the plan's ${sidePx.toFixed(1)} px scale)`,
  ).toBeLessThanOrEqual(TOL);
  expect(
    Math.abs(got1.pos_z - want1.pos_z),
    `pos_z for plan y 0 at zoom ${ZOOM}: wanted ${want1.pos_z.toFixed(4)}, got ${got1.pos_z.toFixed(4)} (units: PARAM)`,
  ).toBeLessThanOrEqual(TOL);

  // ── LEG 2 — a DIFFERENT drop must write a DIFFERENT camera. A handler that
  // wrote one constant would pass leg 1 alone if that constant happened to
  // match; it cannot pass both. plan (+0.3, −0.25) is viewBox (65, 37.5). ──
  const p2 = await screenOf(65, 37.5);
  await page.mouse.move(p2.x, p2.y);
  await page.mouse.down();
  await page.mouse.move(p2.x, p2.y, { steps: 3 });
  await page.mouse.up();

  const want2 = expectedCamera(0.3, -0.25);
  await expect
    .poll(async () => (await readCamera()).pos_x !== got1.pos_x, {
      message: 'the second drop moved the camera off the first (units: BOOLEAN)',
    })
    .toBe(true);
  const got2 = await readCamera();
  expect(
    Math.abs(got2.pos_x - want2.pos_x),
    `pos_x for plan x +0.3: wanted ${want2.pos_x.toFixed(4)}, got ${got2.pos_x.toFixed(4)} ` +
      `(units: PARAM; tolerance ${TOL.toFixed(4)})`,
  ).toBeLessThanOrEqual(TOL);
  expect(
    Math.abs(got2.pos_z - want2.pos_z),
    `pos_z for plan y −0.25: wanted ${want2.pos_z.toFixed(4)}, got ${got2.pos_z.toFixed(4)} (units: PARAM)`,
  ).toBeLessThanOrEqual(TOL);
  expect(
    Math.abs(got2.pos_x - got1.pos_x),
    'the two drops are genuinely different cameras, by far more than the pixel tolerance (units: PARAM)',
  ).toBeGreaterThan(10 * TOL);

  // ── LEG 3 — THE LETTERBOX LEG, and it exists because the OTHER two do not
  // catch that bug and a negative control proved it.
  //
  // The shipped CSS sizes the SVG as a 196 × 196 SQUARE, so element rect and
  // drawn square coincide and the `min(w, h)` centring in `planFromEvent` is
  // the identity. MEASURED: reintroducing the original element-rect mapping and
  // re-running legs 1-2 came back GREEN. A guard whose subject has been removed
  // by a layout choice is a guard nobody is watching — and the layout can come
  // back (a responsive hero bay, a wider panel, `width: 100%`).
  //
  // So this leg RESTORES the condition: it stretches the element to 420 × 196
  // and repeats the drop. The browser letterboxes the square into the middle,
  // `getScreenCTM()` still reports where the drawing really is, and the naive
  // mapping now reads plan x ≈ −0.09 for a point the CTM puts at −0.2 — a
  // ~0.21 PARAM error against a ~0.03 tolerance. Re-verified in both
  // directions: red with the old mapping, green with the shipped one.
  await page.addStyleTag({
    content: '[data-testid="wavesculpt-room-stage"] { width: 420px !important; }',
  });
  await expect
    .poll(async () => Math.round(await stage.evaluate((el) => el.getBoundingClientRect().width)), {
      message: 'the stretched element took (units: CSS px)',
    })
    .toBe(420);
  const sideAfter = await stage.evaluate((el) => {
    const m = (el as unknown as SVGSVGElement).getScreenCTM();
    return m ? m.a * 100 : 0;
  });
  expect(
    sideAfter,
    'the drawing is LETTERBOXED, not stretched — the square stays 196 px in a 420 px box ' +
      '(units: CSS px). If this ever equals the element width the leg is measuring nothing.',
  ).toBeLessThan(300);

  const p3 = await screenOf(40, 50);
  await page.mouse.move(p3.x, p3.y);
  await page.mouse.down();
  await page.mouse.move(p3.x, p3.y, { steps: 3 });
  await page.mouse.up();

  const want3 = expectedCamera(-0.2, 0);
  await expect
    .poll(async () => (await readCamera()).pos_x !== got2.pos_x, {
      message: 'the drag still reaches the graph in a letterboxed element (units: BOOLEAN)',
    })
    .toBe(true);
  const got3 = await readCamera();
  expect(
    Math.abs(got3.pos_x - want3.pos_x),
    `LETTERBOXED pos_x for plan x −0.2: wanted ${want3.pos_x.toFixed(4)}, got ${got3.pos_x.toFixed(4)} ` +
      `(units: PARAM; tolerance ${TOL.toFixed(4)}). A mapping that read the ELEMENT rect instead ` +
      `of the drawn square lands near −0.19 here.`,
  ).toBeLessThanOrEqual(TOL);

  // ── LEG 4 — THE THING THE WHOLE FACE EXISTS FOR. At the SHIPPED DEFAULT
  // camera the BLUE voice is EXACTLY silent (the eye sits directly behind it on
  // the +Z wall) and `out_blu` emits digital zero with it. The legend must SAY
  // so, and must stop saying so at a camera where all four are live — a legend
  // stuck on DARK would be reading the wall layout, not the camera. ──
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params?: Record<string, number> }> };
    };
    const p = w.__patch.nodes['ws']!.params!;
    p.pos_x = 0;
    p.pos_z = 0;
    p.zoom = 1; // the spawn camera — eye [0, 0, 2.5], directly behind BLUE
  });
  const legend = faceplate.locator('[data-testid="wavesculpt-room"] .legend li');
  await expect(legend).toHaveCount(4);
  await expect(
    legend.nth(2),
    'BLUE is DARK at the default camera — not quiet, zero',
  ).toContainText('DARK');
  await expect(
    legend.filter({ hasText: 'DARK' }),
    'exactly ONE voice is dark at the spawn camera',
  ).toHaveCount(1);
  await expect(faceplate.getByTestId('wavesculpt-room-live')).toHaveText('3 of 4 live');

  // …and at zoom 3, rot 0 every voice is audible (measured: BLUE 0.973).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params?: Record<string, number> }> };
    };
    w.__patch.nodes['ws']!.params!.zoom = 3;
  });
  await expect(faceplate.getByTestId('wavesculpt-room-live')).toHaveText('4 of 4 live');
  await expect(
    legend.filter({ hasText: 'DARK' }),
    'NO voice reads DARK once the camera is inside the room — a legend stuck on ' +
      'BLUE would be reading the wall layout, not the camera',
  ).toHaveCount(0);
});
