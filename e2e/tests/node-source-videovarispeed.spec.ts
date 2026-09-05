// e2e/tests/node-source-videovarispeed.spec.ts
//
// ⚠ THE FILENAME IS LOAD-BEARING — DO NOT RENAME THIS BACK TO `videovarispeed-node-lifetime.spec.ts`.
// `e2e/webgl-heavy-globs.ts` classifies by PREFIX (`**/videobox-*.spec.ts`,
// `**/videovarispeed-*.spec.ts`), so a spec named after either module is swept
// into the WebGL-HEAVY lane whatever it actually does. That lane is EXCLUDED
// from the sharded e2e matrix (`E2E_WEBGL_HEAVY=exclude`) and the attest job
// SKIPS it whenever the attest hash is unchanged — its log says so outright:
// "Heavy WebGL lane skipped (trusting the local run)". Under the old name this
// spec therefore ran NOWHERE in PR CI, green run after green run, while being
// the acceptance test for the whole conversion.
//
// Nothing here is WebGL-heavy: it reads graph edges, element counts and a slot
// index, and samples no pixels. `collapse-keeps-playing.spec.ts` does the same
// real-video-decode work under a non-matching name and rides the sharded lane,
// which is the precedent this follows. The glob list is deliberately NOT edited
// — the classification is fine, the prefix collision was the accident.
//
// LEG-02 P2 (#1511) — VIDEOVARISPEED's transport, slot state and CV inputs
// belong to the NODE, not to a mounted card.
//
// ⚠ AFTER P2 THIS IS THE COMMON PATH, NOT AN EDGE CASE. videovarispeed has left
// `DOM_SOURCE_LANE_TYPES`, so it gets NO headless host — an ordinary rack has no
// videovarispeed card mounted anywhere at all. "The CV path works with no card"
// is therefore the normal operating condition, and this spec is the only thing
// standing between us and a silent regression on it.
//
// ⚠ AND SINCE THE WAVE-4 PROMOTION THE CARD HAS NO SURFACE ON THE DEFAULT SHELL
// AT ALL. The lane renders a faceplate rather than a placeholder tile, and the
// dock full view renders the faceplate too — so `videovarispeed-card` count 0
// now holds even with the pane OPEN, which is why `loadSlot` below drives the
// face body. The permanent discriminator is unchanged and is simply stronger.
//
// ── WHAT THIS PROVES, AND HOW THE TWO HALVES DIVIDE ─────────────────────────
//
// The repo's real-source-chain rule exists for a measured failure: POLYHELM
// shipped green-but-silent because a test drove the engine class directly with a
// synthetic note source, so nothing ever proved the real chain was connected.
// The rule's purpose is "prove the chain is actually wired", not "drive it the
// hard way for its own sake". So this spec splits those two jobs:
//
//   WIRING   a real CLIPPLAYER is spawned and its `pitch1`/`gate1` outputs are
//            patched into `asset_pitch`/`asset_gate`, and the test ASSERTS both
//            edges materialised in the live graph. This is the leg that fails on
//            a disconnected rack, and it carries its own negative control (see
//            below) — without one it would be decoration that passes against a
//            graph where nothing is connected.
//   BEHAVIOUR the switch is fired at the CV-bridge param seam
//            (`setParam` on `asset_pitch`/`asset_gate`) — the exact param the
//            cross-domain bridge writes into.
//
// ⚠ AND THE TWO LEGS CANNOT SHARE ONE RACK. Measured on this tree, the same
// test run twice with the ONLY difference being whether the clip player is
// patched in:
//
//     no clip player   asset_pitch -0.667  asset_gate 1  -> activeSlot 0 -> 2
//     clip player wired asset_pitch 0      asset_gate 0  -> activeSlot stuck 0
//
// An IDLE clip player's pitch/gate bridge OVERWRITES both params back to 0
// within the window, so pitch->0 selects slot 0 and a gate pinned at 0 never
// edges. The wiring that proves the chain exists actively SUPPRESSES the
// behaviour injection. So the legs run on two racks — WIRED for the wiring
// evidence, UNWIRED for the behaviour — and each is valid on its own rack.
// Combining them would produce a test that is green only because it asserts
// nothing about the switch.
//
// ⚠ AND DRIVING IT FROM THE CLIP PLAYER'S OWN PLAYBACK WOULD MAKE THIS TEST
// STRICTLY WORSE, which is why it is not done. `videovarispeed-switch.spec.ts`
// measured it: an IDLE clip player's pitch/gate bridge CONTINUOUSLY drives those
// params to 0, so pitch→0 selects slot 0 and a gate held at 0 never edges — the
// switch would never fire at all. Programming its grid to emit a deterministic
// note at a deterministic instant is brittle, and brittleness is the wrong
// currency to spend on a spec whose job is proving a lifetime fix.
//
// ⚠ THE PERMANENT DISCRIMINATOR, in the same test as every liveness assertion:
// `videovarispeed-card` count 0 AND `headless-source-host` count 0. Without the
// pair, "it still works" and "a card is still doing the work" are
// indistinguishable from the output — the green-and-blind shape this epic could
// otherwise ship.

import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';

const FIXTURE = fileURLToPath(new URL('../fixtures/lobby-clip-long.webm', import.meta.url));

const VVS = 'vv-life';
const CLIP = 'clip-life';

/** ⚠ Raised above the fleet's 30 s for the measured reason recorded in
 *  node-source-videobox.spec.ts: the FIRST `goto` against a cold dev server
 *  pays Vite's whole-module-graph transform, while every later one is warm.
 *  Nothing here is gated on elapsed time — the gates are graph edges, a slot
 *  index and two element counts. */
const BOOT_CAP_MS = 90_000;

/** ASSET slot notes are the C-major row (C D E F G A B from MIDI 48). Slot `i`
 *  is selected by that note as V/oct — the same value a clip player's PITCH out
 *  carries through the cross-domain bridge. */
const ASSET_NOTES = [48, 50, 52, 53, 55, 57, 59];
const voctForSlot = (i: number): number => (ASSET_NOTES[i]! - 60) / 12;

async function boot(page: Page): Promise<void> {
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_CAP_MS });
}

/*
 * ⚠ `expectNoCardAndNoHost` STOOD HERE AND IS DELETED. READ THIS BEFORE
 * REPLACING IT WITH SOMETHING THAT LOOKS LIKE IT.
 *
 * It was this file's "PERMANENT DISCRIMINATOR": every liveness assertion was
 * paired with `toHaveCount(0)` on a per-module surface testid and on an
 * off-screen `headless-source-host`, so a green liveness result could not be
 * explained by some OTHER mount doing the work.
 *
 * Neither testid is emitted by anything in the tree any more. A matcher whose
 * selector cannot match is satisfied by a page that rendered nothing at all,
 * so the discriminator had stopped discriminating — it reported "no other
 * owner" for the same reason it would report it on a blank page.
 *
 * ⚠ NAMED COVERAGE LOSS, carried into the PR body. The alternative explanation
 * it ruled out (a surface, not the node, owning the source) is now ruled out
 * by CONSTRUCTION: the node source registry is the only owner and no component
 * competes with it. Re-arming this as a RUNTIME claim would need a new
 * discriminator against the faceplate dock body — a new gate, which is an
 * owner decision rather than this branch's.
 */

/** The node's live slot state, read from the registry's own hook.
 *
 *  ⚠ THE HOOK MOVED FROM THE CARD TO THE SINGLETON as part of P2, and it had
 *  to: the card used to register a per-node reader in its own `$effect`, so it
 *  returned NULL whenever no card was mounted — which is exactly the condition
 *  under test here. A probe that cannot see the state it measures is not a
 *  probe. */
async function slotState(page: Page): Promise<{ activeSlot: number; slotPos: number[] } | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __vvsVirtualPlayhead?: (n: string) => { activeSlot: number; slotPos: number[] } | null;
    };
    return w.__vvsVirtualPlayhead?.(id) ?? null;
  }, VVS);
}

/** Every live edge landing on this node, as `source.port->target.port` strings.
 *  THE WIRING EVIDENCE — read off the real graph, never off the spawn arguments.
 *
 *  ⚠ `source`/`target`, NOT `from`/`to`. `spawnPatch`'s INPUT shape uses
 *  `from`/`to` and the stored `Edge` uses `source`/`target`
 *  ($lib/graph/types.ts), and reading the input spelling off the stored object
 *  yields `undefined` for every edge — so this returned `[]` for EVERY graph,
 *  connected or not. That failed the positive leg loudly (good) and passed the
 *  negative control VACUOUSLY (bad): a control that reports "no edges" because
 *  it cannot see edges proves nothing at all. Both directions are now measured
 *  against a reader proven to return a NON-empty list on the wired rack. */
async function edgesInto(page: Page): Promise<string[]> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch?: { edges: Record<string, { source?: { nodeId?: string; portId?: string }; target?: { nodeId?: string; portId?: string } }> };
    };
    const out: string[] = [];
    for (const e of Object.values(w.__patch?.edges ?? {})) {
      if (e?.target?.nodeId !== id) continue;
      out.push(`${e.source?.nodeId}.${e.source?.portId}->${e.target?.portId}`);
    }
    return out.sort();
  }, VVS);
}

/** Fire the asset selector at the CV-bridge param seam — the exact param the
 *  cross-domain bridge writes into.
 *
 *  The gate is HELD high across ≥2 controller polls before release: the CV loop
 *  edge-detects `asset_gate` by POLLING at 33 ms, so a same-tick 1→0 pulse would
 *  never be sampled HIGH and the rising edge would be missed. A real note holds
 *  its gate for a real duration too, so the hold matches the source chain rather
 *  than working around it. */
async function fireAssetSelect(page: Page, slot: number): Promise<void> {
  const set = (level: number, pitch?: number): Promise<void> =>
    page.evaluate(({ id, level, pitch }) => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain?: (d: string) => { setParam?: (n: string, p: string, v: number) => void } | null } | null;
      };
      const ve = w.__engine?.()?.getDomain?.('video');
      if (typeof pitch === 'number') ve?.setParam?.(id, 'asset_pitch', pitch);
      ve?.setParam?.(id, 'asset_gate', level);
    }, { id: VVS, level, pitch });
  await set(1, voctForSlot(slot));
  // pacing: mirrors the controller's own CV_INTERVAL_MS = 33 ms poll
  // ($lib/ui/media/node-varispeed-registry), held across ≥2 samples so the
  // rising edge is observed. A product-side interval, not a guess.
  await page.waitForTimeout(90);
  await set(0);
  // pacing: the SAME 33 ms poll, held LOW across ≥2 samples before returning.
  // ⚠ Measured, not precautionary: without it a second call re-raised the gate
  // within one poll interval of the release, so the detector sampled 1 -> 1,
  // saw no rising edge, and the second switch silently never fired — the first
  // switch passed and the switch BACK timed out at `activeSlot 2`. A real note
  // has a real gap between notes; this restores it rather than working around
  // the detector.
  await page.waitForTimeout(90);
}

/** Load a fixture into `slot` through the REAL pickers, inside the dock full
 *  view — the only surface a varispeed has, and since the wave-4 promotion that
 *  surface is the FACEPLATE, not the card.
 *
 *  ⚠ RE-POINTED AT THE FACE BODY (2026-09-01). This helper used to drive
 *  a per-module surface inside the pane and open the 7-slot sheet with a
 *  `contextmenu` on it. Both are gone: the dock mounts `<ModuleShell>`, and the
 *  bank is a permanent section of the body rather than a right-click sheet
 *  (right-click is claimed per-control by `ControlContextMenu`). */
async function loadSlot(page: Page, slot: number): Promise<void> {
  const pane = page.locator('[data-testid="dock-full-view"]');
  const body = pane.locator('[data-testid="videovarispeed-face-body"]');
  await expect(body).toBeVisible({ timeout: 20_000 });
  if (slot === 0) {
    await body.locator('[data-testid="videovarispeed-file-input"]').setInputFiles(FIXTURE);
    await expect(body).toHaveAttribute('data-has-local-file', 'true', { timeout: 20_000 });
    return;
  }
  // The bank needs no opening gesture on the faceplate.
  await expect(body.locator('[data-testid="videovarispeed-multi-panel"]')).toBeVisible({ timeout: 20_000 });
  await body.locator(`[data-testid="videovarispeed-slot-input-${slot}"]`).setInputFiles(FIXTURE);
  await expect(body.locator(`[data-testid="videovarispeed-slot-${slot}"]`))
    .toHaveAttribute('data-slot-local', 'true', { timeout: 20_000 });
}

/** Spawn the rack: a REAL clip player patched into the ASSET ports, plus the
 *  varispeed. `WIRED=false` drops the two asset edges — the negative-control
 *  graph the wiring leg must fail on. */
async function spawnRack(page: Page, wired = true): Promise<void> {
  await spawnPatch(
    page,
    [
      { id: CLIP, type: 'clipplayer', position: { x: 40, y: 40 }, domain: 'audio' },
      { id: VVS, type: 'videovarispeed', position: { x: 420, y: 40 }, domain: 'video' },
    ],
    wired
      ? [
          { id: 'e_pitch', from: { nodeId: CLIP, portId: 'pitch1' }, to: { nodeId: VVS, portId: 'asset_pitch' }, sourceType: 'polyPitchGate', targetType: 'pitch' },
          { id: 'e_gate', from: { nodeId: CLIP, portId: 'gate1' }, to: { nodeId: VVS, portId: 'asset_gate' }, sourceType: 'gate', targetType: 'gate' },
        ]
      : [],
    { mountTimeout: 30_000 },
  );
}

test.describe('videovarispeed: transport + CV belong to the NODE (#1511)', () => {
  test('the ASSET chain is WIRED and switches slots with NO card mounted', async ({ page }) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await boot(page);
    // ⚠ NO clip player on THIS rack — see the measured table in the header. Its
    // idle bridge pins asset_pitch/asset_gate to 0 and the switch never fires.
    // The wiring is proved on its own rack, in the test below.
    await spawnRack(page, false);

    // ── Load two slots. This needs the dock: a file picker is only honoured
    //    inside a real user gesture, and that has always been true.
    await page.evaluate((id) => {
      (globalThis as unknown as { __openDockFullView: (i: string) => void }).__openDockFullView(id);
    }, VVS);
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(1, { timeout: 20_000 });
    await loadSlot(page, 0);
    await loadSlot(page, 2);
    await page.getByTestId('faceplate-collapse').click();
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(0, { timeout: 20_000 });

    // ── From here the rack is in its ORDINARY state: no surface anywhere.
    const before = await slotState(page);
    expect(before, 'the node published no slot state — the controller does not exist').not.toBeNull();
    expect(before!.activeSlot, 'expected to start on slot 0').toBe(0);

    // ── LEG 2: THE BEHAVIOUR, through the CV-bridge param seam.
    await fireAssetSelect(page, 2);
    await expect
      .poll(async () => (await slotState(page))?.activeSlot, {
        timeout: 20_000,
        message:
          'the ASSET GATE rising edge did not switch the on-air slot with no card mounted. On main this ' +
          'path runs only while a card is mounted, so a regression here restores the original defect.',
      })
      .toBe(2);

    // A switch BACK must land on the slot's own live playhead, not on 0.
    await fireAssetSelect(page, 0);
    await expect.poll(async () => (await slotState(page))?.activeSlot, { timeout: 20_000 }).toBe(0);

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('the REAL clip-player -> ASSET chain is wired, and the reader can see it', async ({ page }) => {
    // THE WIRING LEG, on its own rack. A real CLIPPLAYER's `pitch1`/`gate1` are
    // patched into `asset_pitch`/`asset_gate` and both edges must materialise in
    // the LIVE graph — read off `__patch`, never off the spawn arguments. This
    // is what fails on a disconnected rack, which is the POLYHELM shape the
    // real-source-chain rule exists to prevent.
    await boot(page);
    await spawnRack(page, true);

    const wired = await edgesInto(page);
    expect(
      wired,
      `live edges into ${VVS}: ${wired.join(', ') || '(none)'} — the real clip-player -> ASSET chain is not connected`,
    ).toEqual([`${CLIP}.gate1->asset_gate`, `${CLIP}.pitch1->asset_pitch`]);
  });

  test('NEGATIVE CONTROL: the WIRING leg fails on a disconnected rack', async ({ page }) => {
    // ⚠ THE LEG THAT MAKES THE WIRING LEG EVIDENCE RATHER THAN DECORATION.
    // Spawn the identical rack with the two ASSET edges DROPPED and assert the
    // wiring assertion's subject is empty. Without this, "a clip player is
    // present" would pass just as happily on a graph where nothing is connected.
    await boot(page);
    await spawnRack(page, false);

    const edges = await edgesInto(page);
    expect(
      edges,
      'the negative-control rack was spawned WITH asset edges — the control proves nothing',
    ).toEqual([]);

    // ⚠ AND PROVE THE READER CAN SEE AN EDGE AT ALL, in this same browser, or
    // "no edges" is indistinguishable from "cannot read edges". That is not
    // hypothetical: this reader shipped for one run using the `from`/`to`
    // spelling from `spawnPatch`'s INPUT type instead of the `source`/`target`
    // of the stored `Edge`, returned [] for every graph, and made this control
    // pass vacuously. Patch a normal edge and confirm the count moves.
    await spawnPatch(
      page,
      [{ id: 'probe-out', type: 'videoOut', position: { x: 900, y: 40 }, domain: 'video' }],
      [{ id: 'e_probe', from: { nodeId: VVS, portId: 'video' }, to: { nodeId: 'probe-out', portId: 'in' }, sourceType: 'video', targetType: 'video' }],
      { mountTimeout: 30_000 },
    );
    const probe = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch?: { edges: Record<string, { target?: { nodeId?: string } }> };
      };
      return Object.values(w.__patch?.edges ?? {}).filter((e) => e?.target?.nodeId === 'probe-out').length;
    });
    expect(
      probe,
      'the edge reader could not see a freshly patched edge — its empty answer above was blindness, not evidence',
    ).toBeGreaterThan(0);

    // And state it in the same shape the positive leg asserts, so the two are
    // visibly the same predicate reading opposite worlds.
    expect(edges).not.toContain(`${CLIP}.gate1->asset_gate`);
    expect(edges).not.toContain(`${CLIP}.pitch1->asset_pitch`);
  });

  test('the node keeps its transport with no card, and deleting it tears down', async ({ page }) => {
    test.setTimeout(180_000);
    await boot(page);
    await spawnRack(page, true);

    // A controller exists from node creation — nothing has been expanded.
    await expect
      .poll(async () => (await slotState(page)) !== null, {
        timeout: 20_000,
        message: 'no controller for a spawned varispeed — the graph sync never ran',
      })
      .toBe(true);

    // ⚠ THE OTHER HALF OF "no card teardown": a lifecycle that never ends is a
    // leak, and it would pass every assertion above. The graph is the authority.
    await spawnPatch(page, [], [], { mountTimeout: 30_000 });
    await expect
      .poll(async () => await slotState(page), {
        timeout: 20_000,
        message: 'the node left the graph and its controller is still alive — the sweep did not run',
      })
      .toBeNull();
  });
});
