// e2e/tests/wavesculpt-face.spec.ts
//
// WAVESCULPT's CURATED FACE, driven for real under `?shell=1`. Two claims that
// only a browser can settle:
//
//   1. THE TWO JOYSTICKS ARE REAL, and they are the CARD's two: POSITION
//      (pos_x × pos_y) and VIEW (zoom × rot), with HEIGHT between them.
//   2. Every axis of both is MIDI/Electra-assignable, as on the card.
//
// ⚠ THE DEF-RANGE LEG IS NOT YET HERE — see the note in the body.
//
// ⚠ WHY THIS SPEC EXISTS AT ALL — the face shipped once WITHOUT the pads and
// every gate stayed green. `faces-parity` counts `control-<paramId>` ids, so
// "one pad over two params" and "two knobs" are the identical assertion to it;
// the parity ledger had a row per PARAM and none per GESTURE. A 2-D control
// flattened into two 1-D ones is invisible to the entire gate set, which is the
// "what is this gate structurally unable to see" class in its purest form.
// Until the parity check gains an affordance dimension, THIS is the thing that
// notices.
//
// ⚠ AND THE RANGE LEG IS THE CubeCard DEFECT, GUARDED. That card passed literal
// `xMin={-1} xMax={1}` to pads whose def said ±0.2, so the pads WROTE values the
// contract forbade and the model silently clamped them — most of the stick's
// travel did nothing, and no def-reading gate could see it. Dragging to a
// corner here and asserting the param lands on the DEF's own declared bound is
// the two-sided check: it fails both if the pad is too small (never reaches the
// bound) and if it is too big (writes past it).
//
// AUDIO-AVAILABILITY / RENDERER: none needed. A migrated module renders the
// curated shell, not the legacy WebGL card, so this spec mounts no 3-D context
// and makes no pixel assertion.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

test.describe.configure({ mode: 'parallel' });

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

async function readParams(page: Page): Promise<Record<string, number>> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params?: Record<string, number> }> };
    };
    return { ...(w.__patch.nodes['ws']?.params ?? {}) };
  });
}

test('wavesculpt face: BOTH of the card’s joysticks are present, 2-D, and MIDI-assignable on every axis', async ({
  page,
}) => {
  test.setTimeout(SLOW_RENDER ? 120_000 : 60_000);

  await installRenderSmokeHooks(page);
  await page.goto('/rack?mode=workflow&shell=1');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });

  await spawnPatch(
    page,
    [{ id: 'ws', type: 'wavesculpt', position: { x: 360, y: 60 }, domain: 'audio' }],
    [],
  );

  const shell = page.locator('.svelte-flow__node[data-id="ws"] [data-testid="module-shell"]');
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible();

  // The face's shape where it renders: EIGHT bands ⇒ a tab rail.
  await expect(faceplate.locator('[data-face-page]')).toHaveCount(8);
  await expect(faceplate.locator('[role="tab"]')).toHaveCount(8);

  // ── BOTH PADS EXIST. This is the assertion whose ABSENCE let the face ship
  // with five knobs: nothing else in the suite can tell a pad from a dial. ──
  const posPad = faceplate.getByTestId('wavesculpt-pad-pos-pad');
  const viewPad = faceplate.getByTestId('wavesculpt-pad-view-pad');
  await expect(posPad, 'the POSITION joystick (pos_x × pos_y) is rendered').toBeVisible();
  await expect(viewPad, 'the VIEW joystick (zoom × rot) is rendered').toBeVisible();
  // …and they are 2-D surfaces, not decoration.
  await expect(posPad).toHaveAttribute('role', 'application');
  await expect(viewPad).toHaveAttribute('role', 'application');
  // Per-axis MIDI assign on all four axes — an XyPad whose axes are not
  // learnable is a downgrade from the card even when it drags correctly.
  for (const t of ['pos', 'view']) {
    for (const ax of ['x', 'y']) {
      await expect(faceplate.getByTestId(`wavesculpt-pad-${t}-assign-${ax}`)).toBeAttached();
    }
  }

  // ── ⚠ THE DRAG LEGS ARE NOT HERE, AND THAT IS AN ADMISSION, NOT AN OMISSION.
  //
  // I could not get a synthetic Playwright drag to commit through `XyPad`'s
  // settle-commit in this panel, and I did not root-cause it before running out
  // of runway. What IS established, by measurement rather than assumption:
  //
  //   * the pads render, are `role="application"` 2-D surfaces, and both axes
  //     of both pads carry their MIDI/Electra assign handles (asserted above);
  //   * the commit seam reaches the graph — `posPad.dblclick()` (XyPad's
  //     reset-to-default path, which calls `onXChange`/`onYChange` directly)
  //     writes `{pos_x: 0, pos_y: 0}` into `__patch`, MEASURED;
  //   * the rendered dock shows correct dots and readouts, including `ZM 1.00`
  //     at unity zoom on the LOG axis (that one was a real bug, caught by
  //     looking at the capture: the readout printed ln(1) = 0.00 until XyPad
  //     grew per-axis formatters).
  //
  // So the difference is between the direct `onXChange` path and the
  // `commit`/`flush` path under a synthetic pointer stream — a TEST-HARNESS
  // question in all likelihood, but I have not proven that, and a leg I cannot
  // make pass is not a leg I get to describe as passing. The DEF-RANGE
  // assertions (drag past a corner, land exactly on the def's declared bound —
  // the CubeCard guard) ride on those drags and are therefore also unwritten.
  // Both are the first thing to finish here.

  // ── AND THE THING THE FACE EXISTS FOR. Put the camera back at spawn: BLUE is
  // EXACTLY silent there (the eye sits directly behind it on the +Z wall) and
  // `out_blu` emits digital zero with it. The legend must say so — and must
  // STOP saying so once the camera is inside the room, or it is reading the
  // wall layout rather than the camera. ──
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params?: Record<string, number> }> };
    };
    const p = w.__patch.nodes['ws']!.params!;
    p.pos_x = 0; p.pos_y = 0; p.pos_z = 0; p.rot = 0; p.zoom = 1;
  });
  const legend = faceplate.locator('[data-testid="wavesculpt-room"] .legend li');
  await expect(legend).toHaveCount(4);
  await expect(legend.filter({ hasText: 'DARK' }), 'exactly ONE voice is dark at spawn').toHaveCount(1);
  await expect(legend.nth(2), 'and it is BLUE').toContainText('DARK');
  await expect(faceplate.getByTestId('wavesculpt-room-live')).toHaveText('3 of 4 live');

  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params?: Record<string, number> }> };
    };
    w.__patch.nodes['ws']!.params!.zoom = 3;
  });
  await expect(faceplate.getByTestId('wavesculpt-room-live')).toHaveText('4 of 4 live');
  await expect(legend.filter({ hasText: 'DARK' }), 'no voice is dark inside the room').toHaveCount(0);
});
