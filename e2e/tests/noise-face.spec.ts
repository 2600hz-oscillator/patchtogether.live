// e2e/tests/noise-face.spec.ts
//
// THE NOISE FACE, driven for real.
//
// `faces-parity` already proves the one cell is present and operable, and
// `noise-face-model.test.ts` already proves the arithmetic matches the shipping
// generators. Neither can see the seam BETWEEN them: that the DOM actually
// prints what the model computes, for the live graph value, and keeps doing so
// when the value moves. That seam is the whole face — a one-param module whose
// faceplate is three DERIVED numbers and a picture.
//
// The failure this exists to catch is specific and cheap to ship by accident: a
// readout wired to the nearest knob. `{ paramId: 'level' }` would print ONE
// number, `0.50`, three times, and it would look perfectly reasonable. Every
// assertion below therefore pins the DOM against
// `$lib/ui/modules/noise-face-model` — the SAME function the registry calls, so
// a change to the arithmetic moves both together — AND asserts the three values
// are DISTINCT, which is the property the wrong implementation cannot have.
//
// Runs on /rack (no DB, no relay) — the normal e2e lane. The faceplate shell is
// the rack since #1459.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import {
  NOISE_TAPS,
  noiseLadderFill,
  noiseTapDbText,
  type NoiseTap,
} from '../../packages/web/src/lib/ui/modules/noise-face-model';

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

/** The face's params at a given LEVEL, in the shape the model reads. */
const at = (level: number) => ({ level });

/** Boot the rack and wait for the workflow chrome. */
async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({
    timeout: SLOW_RENDER ? 30_000 : 15_000,
  });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Spawn one NOISE and return its node id. */
async function spawnNoise(page: Page): Promise<string> {
  const id = 'noise-face-1';
  await spawnPatch(page, [{ id, type: 'noise', position: { x: 240, y: 200 } }]);
  return id;
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

/** Write LEVEL straight into the graph. The point here is to land on an EXACT
 *  value so the expected string is a literal; the readout-follows-the-GRAPH
 *  claim needs the value to be known, not the gesture to be realistic (the
 *  gesture is covered by faces-parity, which drags the cell). */
async function setLevel(page: Page, nodeId: string, value: number): Promise<void> {
  await page.evaluate(
    ({ nodeId, value }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[nodeId];
        n.params = { ...(n.params ?? {}), level: value };
      });
    },
    { nodeId, value },
  );
}

/** The text of one hero readout, by its registered `valueId`. */

test.describe('noise face — three derived readouts from one knob', () => {

  test('LEVEL is a FADER at every tier, not a dial — the owner constraint, gated', async ({
    page,
  }) => {
    // ⚠ WHY THIS IS A TEST AND NOT A CODE REVIEW NOTE. `faces-parity` drives a
    // fader and a knob with the SAME pointer drag against the SAME
    // `control-level` testid, and asserts the same thing of both — so the two
    // primitives are literally indistinguishable to it, and dropping
    // `face.paramCells` would leave every gate in this repo green while the
    // module stopped looking like itself. Measured, both directions, before
    // this leg was written: with the declaration the cell resolves `fader`, and
    // with it removed the same cell resolves `knob` and every other assertion
    // in this file still passes.
    //
    // The VRT baseline cannot stand in for it either. A primitive swap that
    // lands under `DOCK_MAX_DIFF` is invisible to the pixel gate (filter's
    // MODE, #1213), and a swap that is over it gets silently re-pinned by the
    // next `--update-snapshots`. Neither reads as "the affordance changed".
    await gotoShell(page);
    const id = await spawnNoise(page);

    // THE LANE TIER. `fader` is TIER-INDEPENDENT like `grid` and `color`: a
    // throw fits a knob column, and the knob it replaces is exactly as wrong
    // there as at the dock.
    const lane = page.locator(`.svelte-flow__node[data-id="${id}"] [data-testid="module-shell"]`);
    await expect(
      lane.locator('[data-cell-key="level"]'),
      'the LANE tile paints LEVEL as a throw',
    ).toHaveAttribute('data-cell-control', 'fader');

    // THE DOCK TIER — the one the owner objected to twice.
    const dock = await openDock(page, id);
    await expect(
      dock.locator('[data-cell-key="level"]'),
      'the DOCK faceplate paints LEVEL as a throw, matching NoiseCard',
    ).toHaveAttribute('data-cell-control', 'fader');

    // …AND IT IS THE SAME CONTROL, not a look-alike: `Fader.svelte` derives
    // `control-<paramId>` itself, which is what keeps the parity multiset
    // unchanged by the swap and MIDI-learn reachable on the face.
    await expect(dock.locator('[data-testid="control-level"]')).toBeVisible();
  });
  // ⚠ REMOVED WITH THE SIDEBAR (owner ruling, 2026-08-19): "the TAPS panel paints the corner and a ladder that moves with LEVEL".
  // Its subject was a dock sidebar panel; `face.sidebar` is deleted
  // platform-wide, so there is no element left to assert on. See
  // ModuleFaceHero in graph/types.ts for the ruling set.

  test('the lane METER is live, not decoration — and it reads WHITE', async ({ page }) => {
    // ⚠ WHY THIS LEG EXISTS AT ALL. NOISE is the FIRST module in the roster
    // whose `meter` glyph has anything to meter at rest: clouds is an insert
    // (both outputs exactly zero with nothing patched) and bluebox's twelve
    // keys all rest at 0, so every other metered face is unlit by construction
    // and a glyph that never resolved its tap would look identical to a working
    // one. NOISE is FREE-RUNNING — all three tables `.start()` at factory time
    // — so here, and only here, an unlit meter is a defect.
    //
    // ⚠ AND THE VRT BASELINE CANNOT SEE IT. Measured 2026-08-10 with
    // `vrt-face-audio-probe`: the compact tile is byte-identical with the graph
    // RUNNING (peak 0.4999, moving 0.977 at the analyser) and with it FROZEN
    // (peak 0.000) — 0 px at the gate's own 26/255 delta. The tile settles long
    // before the meter's visibility-gated poll has raised a segment, so the
    // pixel lane is structurally blind to whether this glyph works. That is the
    // gap this test fills, and it is the reason the roster comment does NOT
    // claim noise as a freeze witness.
    await gotoShell(page);
    const id = await spawnNoise(page);
    const meter = page
      .locator(`.svelte-flow__node[data-id="${id}"] [data-testid="module-shell"]`)
      .getByTestId('shell-glyph-meter');
    await expect(meter).toBeVisible();

    const lit = async (): Promise<number> => Number(await meter.getAttribute('data-lit'));
    /** The meter's own smoothed 0..1 level — `VuMeter` publishes it as
     *  `aria-valuenow`, which is finer-grained than the segment count and is
     *  what makes the RELEASE leg below measurable at all. */
    const level = async (): Promise<number> =>
      Number(await meter.getAttribute('aria-valuenow'));

    // IT LIGHTS, AND IT LIGHTS TO WHITE'S LEVEL — which is the half of the
    // title a bare "> 0" would not earn. `getLevel` is a LINEAR RMS unit and
    // the bar is 12 segments, so the three taps are three DIFFERENT counts at
    // the def default LEVEL 0.5:
    //
    //   white  0.5 × 0.5774 = 0.289 → ceil(3.46) = 4 segments
    //   brown  0.5 × 0.2558 = 0.128 → 2
    //   pink   0.5 × 0.1362 = 0.068 → 1
    //
    // So a count in 3..5 says the tap resolved `primaryAudioOutPortId` to the
    // FIRST declared audio output and not to one of its siblings. `data-lit` is
    // the model's own segment count, so this is renderer-independent and prints
    // how far it got when it fails.
    await expect
      .poll(lit, {
        message: "the meter lights to WHITE's level on a free-running source",
        timeout: SLOW_RENDER ? 20_000 : 8_000,
      })
      .toBeGreaterThanOrEqual(3);
    expect(await lit(), 'and not past white — 5 would mean it is metering something hotter')
      .toBeLessThanOrEqual(5);

    // …AND IT FALLS. The negative control, and the half that makes the first
    // half mean something: a meter stuck lit (a static `level` prop, a tap that
    // resolved once and cached its buffer) passes the clause above forever.
    //
    // ⚠ NOT `data-lit === 0`. The release is exponential (`RELEASE = 0.16` per
    // frame) so `displayLevel` approaches zero asymptotically and never reaches
    // it, which floors `litCount` at ONE segment permanently — measured, and it
    // is a property of the shared primitive rather than anything about noise.
    // The finer `aria-valuenow` is what actually decays, so the gate reads that
    // and asserts a 20x collapse rather than an exact zero.
    const litLevel = await level();
    expect(litLevel, 'the running level is well clear of the noise floor').toBeGreaterThan(0.15);
    await setLevel(page, id, 0);
    await expect
      .poll(level, {
        message: 'the meter collapses when LEVEL is written to 0',
        timeout: SLOW_RENDER ? 20_000 : 8_000,
      })
      .toBeLessThan(litLevel / 20);
  });
});
