// e2e/tests/peakstate-render-smoke.spec.ts
//
// DETERMINISTIC render-smoke (DRS) for PEAKSTATE — an animated mandala
// generator SOURCE (no video input; only cv inputs). Modeled EXACTLY on
// spirographs-render-smoke.spec.ts + the shared _render-smoke harness.
//
// WHY THIS MODULE WAS DEFERRED IN PHASE 1, AND THE UNBLOCK:
//   PEAKSTATE's visible content is a comet trail that ACCUMULATES into a
//   per-instance ring buffer one sample per frame, driven by the real-time
//   delta `dt = frame.time - lastTime` (see peakstate.ts draw()). With the
//   engine clock PINNED (__videoEngineFreezeTime), `dt` is ~0 after the first
//   step, so the pen never advances and the ring stays empty → the output
//   renders near-black under the frozen-clock template. That's the deferral.
//
//   The module ships a PURPOSE-BUILT determinism seam for exactly this: when
//   `globalThis.__peakstateVrtSeed` is truthy, the FIRST draw RESETS the ring
//   + t + 3D rotation to fixed values, then synchronously runs 120
//   `advancePen(pen, 1/60, 1)` steps to fill the ring with a deterministic
//   120-sample trail (penAtTime() is pure closed-form sin/cos of `t` — no
//   PRNG, no Date.now(), no frame.timeDelta), paints ONCE at those values,
//   sets `vrtSeeded = true`, and then BLOCKS all further pen/rotation advance
//   so the painted frame is HELD pixel-stable across every subsequent draw.
//   (Same pattern as FOXY's `__foxyVrtSeed`; this is the seam the VRT scene
//   already uses.) We set the flag via addInitScript BEFORE boot, so the very
//   first synchronous step() seeds the structured mandala and every later step
//   re-blits the identical held frame — independent of the frozen clock value.
//
// FRAME-STABILITY NOTE (why only a SHORT WARMUP burst now):
//   Even with the pen/ring/rotation FROZEN by the seed, PEAKSTATE re-paints
//   each frame onto an OffscreenCanvas that ACCUMULATES — every draw lays a
//   translucent black overlay (decayAlpha=0.05, the comet-trail burn-away)
//   then re-strokes the identical mandala at full alpha. So the lit strokes
//   are stable from frame 1, but the inter-stroke residue decays geometrically
//   toward a FIXED POINT, and the size of that transient depends ENTIRELY on
//   the canvas's starting state. Historically the seam left whatever happened
//   to be on the OffscreenCanvas at boot, so the residue had to settle from an
//   undefined start → this spec drove a 48-step warmup to wash it out, and that
//   48 × per-step (three canvas re-paints + three texSubImage2D uploads + three
//   GL blits) cost is the ONLY thing that made this spec slow on CI's
//   SwiftShader software renderer (the engine itself is paused/frozen — there
//   is no animation cost, just raw per-step draw work).
//
//   The seed branch now does a ONE-SHOT full-opaque-black clear of all three
//   OffscreenCanvases on the seeding frame (see peakstate.ts), so frame 1
//   starts from a DETERMINISTIC clean opaque-black base instead of boot
//   garbage. The lit strokes are full-alpha from frame 1, and the residue
//   transient now decays from a known, identical start on every run / renderer
//   — so a short 6-step warmup settles the two measured bursts to a frame-
//   stable result with the same enormous margin (Δmean ≪ 0.5, Δvar ≪ 1.0). We
//   cut WARMUP_STEPS 48 → 6: total driven steps drop 60 → 18, so this DRS now
//   runs in a few seconds on SwiftShader. This is pure synchronous stepping —
//   still no waitForTimeout/poll/animation-diff, and EVERY assertion below is
//   unchanged (same non-black floor, same variance floor, same frame-stable
//   mean/variance epsilons, same exact-frame-count + zero-GL-error checks).
//
// So combined with the paused rAF loop (__videoEnginePause → the test owns the
// exact frame count) and the pinned clock, the two measured step bursts produce
// a frame-stable, structured, non-black result with zero GL errors. We read
// PEAKSTATE's own canonical RGB output texture (port `rgb_out`).
//
// PEAKSTATE draws THIN (1.5px) kaleidoscope curves on black — legitimately
// sparse (like SPIROGRAPHS), so the default 2%-non-black floor is wrong here;
// we lower it to 0.001. The variance floor still rejects a flat/black frame
// (sparse bright lines on black have high luma variance).
//
// No waitForTimeout, no poll, no animation-diff, no exact-pixel assert.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 6;
// Settle the comet-trail decay transient before measuring. The seed branch now
// clears all three OffscreenCanvases to opaque black on the seeding frame, so
// the residue decays from a DETERMINISTIC clean start on every run / renderer —
// a short 6-step warmup leaves the two measured bursts frame-stable with the
// same margin the old 48-step warmup had (which only existed to wash out boot
// garbage). Pure synchronous stepping (loop paused). This is the whole reason
// the spec is now cheap on CI's SwiftShader software renderer.
const WARMUP_STEPS = 18;

test.describe('PEAKSTATE — deterministic render smoke', () => {
  test('seed + freeze + pause + synchronous step → non-black, structured, frame-stable, zero GL errors', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);

    // Pause the engine rAF loop + pin the clock BEFORE boot.
    await installRenderSmokeHooks(page);

    // UNBLOCK: arm PEAKSTATE's deterministic seed BEFORE boot so the first
    // synchronous step() fills the ring with the fixed 120-sample trail +
    // paints a structured mandala, then holds it frozen across later steps.
    await page.addInitScript(() => {
      (globalThis as unknown as { __peakstateVrtSeed?: boolean }).__peakstateVrtSeed = true;
    });

    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');

    // PEAKSTATE is a pure generated SOURCE (no video input) → OUTPUT so it
    // definitely renders. We read PEAKSTATE's OWN canonical RGB output texture
    // (port `rgb_out`).
    await spawnPatch(
      page,
      [
        { id: 'm',   type: 'peakstate', position: { x: 100, y: 100 }, domain: 'video' },
        { id: 'out', type: 'videoOut',  position: { x: 540, y: 100 }, domain: 'video' },
      ],
      [
        { id: 'e', from: { nodeId: 'm', portId: 'rgb_out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    // WARMUP: settle the accumulating OffscreenCanvas to its decay fixed point
    // so the two measured bursts below are frame-stable (see header note). The
    // pen/ring stay frozen by the seed — only the comet-trail residue decays,
    // and now from a deterministic opaque-black start so a short burst suffices.
    await stepAndReadStats(page, { nodeId: 'm', portId: 'rgb_out', steps: WARMUP_STEPS });

    // First measured burst: drive a FIXED number of frames synchronously + read
    // once. PEAKSTATE draws THIN kaleidoscope curves on black — legitimately
    // sparse, so the default 2%-non-black floor is wrong here. Lower the
    // non-black floor; the variance floor still rejects a flat/black frame
    // (sparse bright lines on black have high luma variance).
    const a = await stepAndReadStats(page, { nodeId: 'm', portId: 'rgb_out', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS, { minNonZeroFrac: 0.001 });

    // DETERMINISM: a second independent burst (clock still frozen + frame still
    // held by the seed) must produce a frame-stable result — same mean +
    // variance to a tight epsilon.
    const b = await stepAndReadStats(page, { nodeId: 'm', portId: 'rgb_out', steps: FIXED_STEPS });
    expect(b.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen output is frame-stable (mean ${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen output variance is frame-stable').toBeLessThan(1.0);

  });

  // ─────────────────────────────────────────────────────────────────────────
  // PER-PORT RENDER GATE — the REAL engine, not a mock.
  //
  // PEAKSTATE rasterizes ~57,600 stroked segments per frame across its three
  // outputs and almost every patch consumes ONE, so `mono_out` / `out_3d` now
  // render only while the engine reports them CONSUMED
  // (VideoFrameContext.connectedOutputPorts). The unit suite
  // (peakstate.test.ts) pins the decision itself against a fake canvas; this
  // proves it end-to-end through the real VideoEngine + real GL, in BOTH
  // directions, in ONE page:
  //
  //   (1) NEGATIVE CONTROL — with only rgb_out patched, the mono/3D FBOs must
  //       stay BLACK. Nothing ever blitted into them, so the "optimisation did
  //       nothing" outcome is distinguishable from the "optimisation worked"
  //       outcome rather than assumed.
  //   (2) POSITIVE — patch mono_out and out_3d for real and both must light up
  //       to the SAME non-black/structured floors rgb_out clears. This is the
  //       whole risk of the change ("the output goes black when someone
  //       actually uses it"), asserted rather than trusted.
  //
  // Deterministic: same seed + frozen clock + paused loop as the smoke above,
  // no waitForTimeout, no animation-diff. One extra page nav on top of the
  // existing spec.
  // ─────────────────────────────────────────────────────────────────────────
  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 3 recovered-on-retry observation(s) across 3 SHA(s) / 3 branch(es) in the
  // 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
  // LOST WHILE PARKED: PEAKSTATE's per-port render gate — unconsumed video outputs must stay dark and only patched ones render, the contract that keeps an idle mandala generator off the GPU.
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  test.fixme('per-port gate: unconsumed outputs stay dark, patched outputs render', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 3 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page }) => {
    test.setTimeout(60_000);

    await installRenderSmokeHooks(page);
    await page.addInitScript(() => {
      (globalThis as unknown as { __peakstateVrtSeed?: boolean }).__peakstateVrtSeed = true;
    });
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');

    // Spawn all three sinks up front but wire ONLY rgb_out, so phase 2 is a
    // pure edge addition (no re-mount, no second page nav).
    await spawnPatch(
      page,
      [
        { id: 'm',    type: 'peakstate', position: { x: 100, y: 100 }, domain: 'video' },
        { id: 'out',  type: 'videoOut',  position: { x: 540, y: 100 }, domain: 'video' },
        { id: 'out2', type: 'videoOut',  position: { x: 540, y: 340 }, domain: 'video' },
        { id: 'out3', type: 'videoOut',  position: { x: 540, y: 580 }, domain: 'video' },
      ],
      [
        { id: 'e', from: { nodeId: 'm', portId: 'rgb_out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    // ---- (1) NEGATIVE CONTROL: only rgb_out is consumed ----
    const rgbGated = await stepAndReadStats(page, { nodeId: 'm', portId: 'rgb_out', steps: WARMUP_STEPS + FIXED_STEPS });
    assertRenderStats(rgbGated, WARMUP_STEPS + FIXED_STEPS, { minNonZeroFrac: 0.001 });

    const monoGated = await stepAndReadStats(page, { nodeId: 'm', portId: 'mono_out', steps: FIXED_STEPS });
    const tubeGated = await stepAndReadStats(page, { nodeId: 'm', portId: 'out_3d', steps: FIXED_STEPS });
    // An FBO that was never blitted into is still its zero-initialised texture.
    // (`outputTexture()` marks the NODE watched but does not register a per-port
    // preview request, so reading it cannot itself un-gate the port.)
    expect(monoGated.fbComplete, 'mono_out FBO is still readable while gated off').toBe(true);
    expect(tubeGated.fbComplete, 'out_3d FBO is still readable while gated off').toBe(true);
    expect(monoGated.nonZeroFrac, `unpatched mono_out is not rasterized (nonZeroFrac ${monoGated.nonZeroFrac})`).toBe(0);
    expect(tubeGated.nonZeroFrac, `unpatched out_3d is not rasterized (nonZeroFrac ${tubeGated.nonZeroFrac})`).toBe(0);
    expect(monoGated.glErrors, 'no GL errors while gated').toEqual([]);
    expect(tubeGated.glErrors, 'no GL errors while gated').toEqual([]);

    // ---- (2) POSITIVE: patch mono_out + out_3d for real ----
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.edges['e_mono'] = {
          id: 'e_mono',
          source: { nodeId: 'm', portId: 'mono_out' },
          target: { nodeId: 'out2', portId: 'in' },
          sourceType: 'mono-video', targetType: 'video',
        };
        w.__patch.edges['e_3d'] = {
          id: 'e_3d',
          source: { nodeId: 'm', portId: 'out_3d' },
          target: { nodeId: 'out3', portId: 'in' },
          sourceType: 'video', targetType: 'video',
        };
      });
    });
    // The graph→engine reconciler runs off the store, so wait for the two new
    // cables to actually MATERIALIZE (the rendered edge is the observable both
    // the UI and the engine reconcile from) before stepping. A state predicate,
    // not a wall-clock budget.
    await expect(page.locator('.svelte-flow__edge[data-id="e_mono"]')).toHaveCount(1);
    await expect(page.locator('.svelte-flow__edge[data-id="e_3d"]')).toHaveCount(1);

    const monoOn = await stepAndReadStats(page, { nodeId: 'm', portId: 'mono_out', steps: WARMUP_STEPS + FIXED_STEPS });
    const tubeOn = await stepAndReadStats(page, { nodeId: 'm', portId: 'out_3d', steps: FIXED_STEPS });

    assertRenderStats(monoOn, WARMUP_STEPS + FIXED_STEPS, { minNonZeroFrac: 0.001 });
    assertRenderStats(tubeOn, FIXED_STEPS, { minNonZeroFrac: 0.001 });

    // The instrument moved in the direction under test: the SAME read on the
    // SAME port went from exactly-zero lit pixels to a structured frame.
    expect(monoOn.nonZeroFrac, 'patching mono_out turns it on').toBeGreaterThan(monoGated.nonZeroFrac);
    expect(tubeOn.nonZeroFrac, 'patching out_3d turns it on').toBeGreaterThan(tubeGated.nonZeroFrac);
    // …and rgb_out — never gated — is unaffected by any of it.
    const rgbAfter = await stepAndReadStats(page, { nodeId: 'm', portId: 'rgb_out', steps: FIXED_STEPS });
    assertRenderStats(rgbAfter, FIXED_STEPS, { minNonZeroFrac: 0.001 });
  });
});
