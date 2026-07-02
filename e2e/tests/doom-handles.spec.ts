// e2e/tests/doom-handles.spec.ts
//
// LIVE regression coverage that DoomCard renders the FULL set of output
// handles declared on doomDef. The card grew from 3 outputs (OUT + audio
// stereo) in slice 1 to 9 outputs (added 6 SP event gates) at slice 8;
// each handle must (a) exist in the DOM with a stable id Svelte Flow can
// resolve, and (b) be reachable for patching once visible.
//
// Why pin this: the user reported "no longer shows input gates at all" /
// "9 outputs cramped". This spec asserts the OUTPUT-SIDE invariant — all
// 9 outputs are in the DOM and each one is a real <Handle> with
// data-handleid matching its def id. If a future card refactor (e.g. a
// PatchPanel migration that collapses handles into a panel) regresses
// this contract, the test fails with a clear per-port message naming
// the missing id.
//
// Input handles (28: 4 slots × 7 gates) are NOT pinned here because
// they're already covered by doom-keyboard-routing.spec.ts (which drives
// CV into them) and by the per-slot UI test in DoomCard's own assertions.
// This spec stays output-focused so it doesn't double-up with those.
//
// No WASM dependency: the def's output set + DoomCard's handle declarations
// are static (they don't change with runtime state), so this spec runs
// without DOOM1.WAD or the WASM bundle.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

const EXPECTED_OUTPUTS = [
  'out',          // video framebuffer
  'audio_l',      // stereo PCM left
  'audio_r',      // stereo PCM right
  'evt_kill',     // gate: monster kill
  'evt_door',     // gate: door opened
  'evt_gun_p1',   // gate: weapon fire per slot
  'evt_gun_p2',
  'evt_gun_p3',
  'evt_gun_p4',
] as const;

test('DoomCard renders all 9 declared output handles with the expected ids', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  const doomId = 'doom-handle-audit';
  await spawnPatch(
    page,
    [{ id: doomId, type: 'doom', position: { x: 120, y: 80 }, domain: 'video' }],
    [],
  );

  // Wait for the DoomCard to render. The card is gated on owner-only
  // semantics (ownerOnly: true), so a non-host viewer wouldn't see this
  // affordance; here we're the lone host (single-user rack) so it's
  // always present.
  const card = page.locator('[data-card-type="doom"]').first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });

  // Resolve each expected handle by id. Svelte Flow sets
  // data-handleid="<port id>" on every <Handle>; we use the standard
  // attribute selector to find them regardless of position (closed
  // PatchPanel-style stacking or open expanded layout both keep the
  // attribute attached — it's how the engine routes edges).
  //
  // We scope inside the DoomCard so a stray Handle from another card
  // (an upstream patched source) doesn't satisfy the assertion.
  for (const portId of EXPECTED_OUTPUTS) {
    const handle = card.locator(`[data-handleid="${portId}"]`);
    await expect(
      handle,
      `DoomCard must render an output handle for "${portId}" `
        + `(declared on doomDef.outputs). Missing means a cable patched `
        + `to this port would have no anchor + Svelte Flow would silently `
        + `drop the edge.`,
    ).toHaveCount(1);
  }

  // Sanity: at least one of the per-slot input handles is also rendered.
  // We don't enumerate all 28 here (covered by doom-keyboard-routing
  // + the per-slot UI test) — just floor-guard the "no longer shows
  // input gates at all" failure mode. p1 is the canonical first slot
  // and is what a fresh single-player DOOM seats the local viewer at.
  const p1Up = card.locator('[data-handleid="p1_up"]');
  await expect(
    p1Up,
    'DoomCard must render p1_up (the local player\'s first gate input). '
      + 'Missing means the entire input-handle set is gone — see '
      + 'DoomCard.svelte\'s {#each DOOM_MP_SLOTS}{#each CV_GATE_PORT_IDS} loop.',
  ).toHaveCount(1);

  expect(errors, 'no page errors during the handle audit').toEqual([]);
});
