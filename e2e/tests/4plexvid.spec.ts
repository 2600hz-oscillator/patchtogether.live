// e2e/tests/4plexvid.spec.ts
//
// 4PLEXVID — 4-in / 4-out video router. DETERMINISTIC render-smoke (DRS),
// converted IN-PLACE from the old wall-clock / animation-diff shape (plan §3 +
// §5 Layer B). The old test routed each router output into a VIDEO-OUT sink and
// then POLLED that 2D-canvas blit's mean luma until a bright/black threshold was
// seen or a 6s deadline passed (`waitForLuma`), firing gates and hoping enough
// rAF frames + canvas blits happened in between — three un-synchronized clocks
// (rAF cadence, the engine clock, the 2D blit), the classic flake.
//
// DRS conversion (mirrors acidwarp-render-smoke / camera-input / video-chain):
//   1. installRenderSmokeHooks(page) BEFORE page.goto — PAUSE the engine rAF
//      loop (the test owns the exact frame count) + PIN the engine clock. SHAPES
//      (the bright source) reads NO frame.time / RNG / accumulator (verified in
//      shapes.ts), so frozen → it renders an identical frame every step; the
//      4PLEXVID copy shader is a pure passthrough of the selected input texture
//      (no frame.time / RNG / accumulator either — verified in 4plexvid.ts), so
//      the whole graph is a pure function of the frozen clock + the selector
//      params.
//   2. Read each router output's OWN FBO directly via the multi-output escape
//      hatch `outputTexture(nodeId, 'outN')` (engine.outputTexture →
//      read('outputTexture:outN')) — NOT downstream of a VIDEO-OUT 2D blit. We
//      no longer need the sinks at all; the FBO IS the real downstream signal.
//   3. Fire the advance gate via the video engine's setParam — a clean rising
//      edge (set 1) then a release (set 0) — the SAME CV-bridge entry point the
//      old test used, but now followed by a FIXED synchronous step burst so the
//      advance index is a PURE FUNCTION of the gate/step sequence (plan §3),
//      never wall-clock. This is the root-cause fix for the prior Phase-2a
//      failure (the gate-advance routing was being read through a polled blit on
//      an un-owned frame clock); here the gate fires deterministically and the
//      next FROZEN read reflects the new routing exactly.
//
// Distinguishable inputs (unchanged intent): in1 = SHAPES (a bright tiled shape
// on black → high luma + spatial structure). in2/in3/in4 = UNPATCHED → the
// router copies its 1×1 black sentinel → that output FBO is FLAT BLACK. So as a
// selector rotates in1→in2→in3→in4→in1 the routed OUTPUT FBO swings
// BRIGHT/structured → black → black → black → BRIGHT/structured. The
// bright/black swing is unambiguous under software-GL on CI.
//
// "param changes the frame" assertions (the gate advances) use TWO FROZEN READS:
// read(before) → fire gate via the engine domain → step a FIXED burst →
// read(after) → assert the two FROZEN stats DIFFER by a renderer-tolerant margin
// (bright→black: nonZeroFrac + variance collapse).
//
// Renderer-tolerant floors only (SwiftShader vs real GPU disagree on exact
// pixels but both clear the floors). No waitForTimeout, no poll, no
// animation-diff, no exact-pixel equality.
//
// NO DEFERRALS: every original assertion is fully DRS-able. 4PLEXVID's draw is a
// pure passthrough and its selector advance is a pure hysteresis edge detector
// (plex-select.gateEdge — no clock), so there is no determinism blocker
// (frame.timeDelta / Math.random / performance.now / unbounded accumulator) to
// defer.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import {
  installRenderSmokeHooks,
  stepAndReadStats,
  type RenderStats,
} from './_render-smoke';

const FIXED_STEPS = 6;

// BRIGHT input (SHAPES) vs BLACK input (unpatched) floors, on the same sparse
// luma stats the harness computes. SHAPES is a tiled shape on black — sparse but
// clearly structured — so we use a sparse non-black floor (like RUTTETRA/LINES
// in video-chain) and lean on the variance floor to reject a flat fill. A
// FLAT-BLACK output (unpatched input copied through) reads ~0 on both.
const BRIGHT_MIN_NONZERO = 0.005; // floor: "showing the bright SHAPES input"
const BRIGHT_MIN_VARIANCE = 15; // floor: structured (not a flat fill)
const DARK_MAX_NONZERO = 0.002; // ceiling: "showing an unpatched (black) input"
const DARK_MAX_VARIANCE = 4; // ceiling: flat black, no structure

function expectBright(s: RenderStats, label: string): void {
  expect(s.fbComplete, `${label}: FBO readable`).toBe(true);
  expect(s.glErrors, `${label}: no GL errors [${s.glErrors.join(',')}]`).toEqual([]);
  expect(
    s.nonZeroFrac,
    `${label}: shows the bright SHAPES input (nonZeroFrac=${s.nonZeroFrac.toFixed(4)})`,
  ).toBeGreaterThan(BRIGHT_MIN_NONZERO);
  expect(
    s.variance,
    `${label}: bright input is spatially structured (variance=${s.variance.toFixed(2)})`,
  ).toBeGreaterThan(BRIGHT_MIN_VARIANCE);
}

function expectDark(s: RenderStats, label: string): void {
  expect(s.fbComplete, `${label}: FBO readable`).toBe(true);
  expect(s.glErrors, `${label}: no GL errors [${s.glErrors.join(',')}]`).toEqual([]);
  expect(
    s.nonZeroFrac,
    `${label}: shows the unpatched (black) input (nonZeroFrac=${s.nonZeroFrac.toFixed(4)})`,
  ).toBeLessThan(DARK_MAX_NONZERO);
  expect(
    s.variance,
    `${label}: black input is flat (variance=${s.variance.toFixed(2)})`,
  ).toBeLessThan(DARK_MAX_VARIANCE);
}

/**
 * Fire a deterministic gate RISING EDGE on a 4PLEXVID node's gate input via the
 * video engine's setParam (the CV-bridge entry point: set 1 = rising edge →
 * advance, set 0 = release → re-arm for the next pulse), then drive a FIXED
 * synchronous step burst so the new routing renders. The advance is a PURE
 * FUNCTION of this call sequence (plex-select.gateEdge is a clockless hysteresis
 * detector), so the next FROZEN read reflects the advanced selector exactly.
 * Returns nothing — the caller reads the affected output FBO afterwards.
 */
async function fireGateAndStep(
  page: Page,
  opts: { nodeId: string; gateId: string; steps: number },
): Promise<void> {
  await page.evaluate(({ nodeId, gateId, steps }) => {
    const w = globalThis as unknown as {
      __engine: () => {
        getDomain: (d: string) => {
          step: () => void;
          setParam: (nodeId: string, paramId: string, value: number) => void;
        };
      };
    };
    const vid = w.__engine().getDomain('video');
    vid.setParam(nodeId, gateId, 1); // rising edge → advance the matching selector
    vid.setParam(nodeId, gateId, 0); // release → re-arm for the next pulse
    for (let i = 0; i < steps; i++) vid.step(); // render the new routing (paused rAF → we own the count)
  }, opts);
}

test.describe('4PLEXVID — gate-advanced 4x4 video router (DRS)', () => {
  test('each output shows its selected input; gate advances + wraps; outputs are independent', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    // Pause the engine rAF loop (the test owns the exact frame count) + pin the
    // engine clock (SHAPES + the 4PLEXVID copy shader render an identical frame
    // every step) BEFORE boot.
    await installRenderSmokeHooks(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // SHAPES into in1 (bright, structured). in2/in3/in4 left UNPATCHED (the
    // router copies its 1×1 black sentinel → flat black). We read each router
    // output's OWN FBO directly (the multi-output escape hatch), so no VIDEO-OUT
    // sink is needed — the FBO is the real downstream signal.
    await spawnPatch(
      page,
      [
        { id: 'src', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video', params: { shape: 1, tile: 1, tileN: 4, zoom: 0.6 } },
        { id: 'plex', type: '4plexvid', position: { x: 360, y: 40 }, domain: 'video' },
      ],
      [
        { id: 'e_src', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'plex', portId: 'in1' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );

    // Structural (non-fragile): both modules mounted.
    await expect(page.locator('.svelte-flow__node-shapes'), 'SHAPES visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-4plexvid'), '4PLEXVID visible').toBeVisible();

    // ---- 1. Default selectors = 0 (in1). out1 AND out2 both select in1 by
    //         default → both show the bright, structured SHAPES input. We read
    //         each output's OWN FBO via outputTexture(nodeId, 'outN'). ----
    {
      const o1 = await stepAndReadStats(page, { nodeId: 'plex', portId: 'out1', steps: FIXED_STEPS });
      expect(o1.framesDelta, 'engine advanced exactly the fixed frame count (loop paused)').toBe(FIXED_STEPS);
      expectBright(o1, 'out1 at start (default sel1=in1)');

      const o2 = await stepAndReadStats(page, { nodeId: 'plex', portId: 'out2', steps: FIXED_STEPS });
      expect(o2.framesDelta, 'engine advanced exactly the fixed frame count (loop paused)').toBe(FIXED_STEPS);
      expectBright(o2, 'out2 at start (default sel2=in1)');
    }

    // ---- 2. "param changes the frame" via TWO FROZEN READS: read out1 BRIGHT
    //         (before), fire ONE gate1 rising edge through the engine domain +
    //         step a FIXED burst, read out1 AFTER. sel1 advanced in1→in2
    //         (unpatched → black), so the two FROZEN stats DIFFER: the after
    //         read is flat black (nonZeroFrac + variance collapsed). The advance
    //         index is a pure function of this gate/step sequence, not wall
    //         clock — the root-cause fix for the prior Phase-2a failure. ----
    const o1Before = await stepAndReadStats(page, { nodeId: 'plex', portId: 'out1', steps: FIXED_STEPS });
    expectBright(o1Before, 'out1 before gate (in1)');

    await fireGateAndStep(page, { nodeId: 'plex', gateId: 'gate1', steps: FIXED_STEPS });

    const o1After = await stepAndReadStats(page, { nodeId: 'plex', portId: 'out1', steps: FIXED_STEPS });
    expectDark(o1After, 'out1 after 1 gate (advanced to unpatched in2)');
    // The two FROZEN reads DIFFER by a renderer-tolerant margin (bright→black).
    expect(
      o1Before.nonZeroFrac - o1After.nonZeroFrac,
      `gate measurably changed out1 (nonZeroFrac ${o1Before.nonZeroFrac.toFixed(4)} → ${o1After.nonZeroFrac.toFixed(4)})`,
    ).toBeGreaterThan(BRIGHT_MIN_NONZERO);

    // ---- 3. INDEPENDENCE: out2's selector was NEVER gated → still in1 → still
    //         bright + structured, even though out1 moved off in1. Read out2's
    //         OWN FBO (frozen, fixed burst). ----
    {
      const o2 = await stepAndReadStats(page, { nodeId: 'plex', portId: 'out2', steps: FIXED_STEPS });
      expectBright(o2, 'out2 still in1 (independent of out1 gate)');
    }

    // ---- 4. WRAP (1→2→3→4→1 modulo): three MORE gate1 rising edges take sel1
    //         in2→in3→in4→in1. Back at in1 the out1 FBO must be bright +
    //         structured again — proving the modulo rotate. Each gate is a clean
    //         rising edge + release + fixed step burst, so the wrap is a pure
    //         function of the gate count. ----
    await fireGateAndStep(page, { nodeId: 'plex', gateId: 'gate1', steps: FIXED_STEPS }); // sel1 → in3 (black)
    await fireGateAndStep(page, { nodeId: 'plex', gateId: 'gate1', steps: FIXED_STEPS }); // sel1 → in4 (black)
    await fireGateAndStep(page, { nodeId: 'plex', gateId: 'gate1', steps: FIXED_STEPS }); // sel1 → in1 (bright, wrapped)
    {
      const o1 = await stepAndReadStats(page, { nodeId: 'plex', portId: 'out1', steps: FIXED_STEPS });
      expectBright(o1, 'out1 bright again after wrap (4 gates → back to in1)');
    }

    expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
