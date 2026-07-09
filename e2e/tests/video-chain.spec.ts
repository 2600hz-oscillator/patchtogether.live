// e2e/tests/video-chain.spec.ts
//
// DETERMINISTIC render-smoke (DRS) for the chainable video outputs + the VDELAY
// effect (plan §3/§5 Layer B). Converted IN-PLACE from the old wall-clock
// `spawn → waitForTimeout(800) → readCanvas once` shape (three un-synchronized
// clocks: rAF cadence, the engine clock, the 2D-canvas blit) to the shared
// _render-smoke harness: PAUSE the rAF loop + PIN the engine clock before boot,
// then drive engine.step() a FIXED number of frames synchronously and read the
// module's OWN output FBO once via gl.readPixels with renderer-tolerant floors.
//
// Two scenarios that exercise the chainable outputs + the VDELAY effect:
//
//   1. LINES → MONOGLITCH → RUTTETRA → OUTPUT chain
//      The three sink modules now publish their FBO textures via `out` ports and
//      downstream consumers sample them. DRS: freeze + pause, step a fixed burst,
//      read RUTTETRA's `out` texture (the terminal effect, fed all the way down
//      the chain) — non-black, structured, zero GL errors, and FRAME-STABLE on a
//      second burst (the whole chain is a pure function of the frozen clock:
//      LINES animates off frame.time only — see lines-render-smoke.spec.ts — and
//      MONOGLITCH/RUTTETRA are pure functions of their input + params with NO
//      accumulating state or frame.time read, so a pinned clock → identical frame
//      every step).
//
//   2. LINES → VDELAY → OUTPUT delay-effect render
//      VDELAY's ring buffer + feedback path produces blended/echoed content. Per
//      the plan §3 directive for this spec: DRS — freeze → step N (>=30 to fill
//      the vdelay ring past its delay tap + let feedback echoes accumulate) →
//      read nonZero/variance ONCE. VDELAY is a feedback RING that ACCUMULATES
//      across frames (head/framesElapsed/ring of FBOs — like BACKDRAFT), so it is
//      NOT a pure function of frame.time and a second equal burst would read a
//      DIFFERENT ring state and diverge. Unlike BACKDRAFT it ships no `freeze`
//      param to pin a settled frame, so we deliberately do NOT assert a second-
//      burst frame-stable read here — just the single floors after the fill. (A
//      module-source freeze hook would be needed for a stability assert; that is
//      out of scope for this test-only conversion.)
//
// No waitForTimeout, no poll, no animation-diff, no exact-pixel assert.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 6;
// VDELAY: enough frames to fill the ring past the 4-frame delay tap + let the
// 0.3-feedback echoes accumulate into structured content (VDELAY_BUFFER_FRAMES
// = 32; 30 settles it well past the cold-start tap distance).
const VDELAY_FILL_STEPS = 30;

test.describe('Video chain — chainable outputs on RUTTETRA / MONOGLITCH / OUTPUT', () => {
  // @webgl-smoke — REQUIRED on-CI WebGL floor: a multi-module video chain
  // (LINES → MONOGLITCH → RUTTETRA → OUTPUT) composes through the WebGL engine
  // and paints visible content under CI's SwiftShader. Renderer-tolerant
  // (visible content + frame-stable under the frozen clock, NOT exact pixels).
  test('LINES → MONOGLITCH → RUTTETRA → OUTPUT renders something visible @webgl-smoke', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);

    // Pause the engine rAF loop (the test owns the exact frame count) + pin the
    // engine clock (LINES renders an identical frame every step) BEFORE boot.
    await installRenderSmokeHooks(page);

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'v-lines', type: 'lines',      position: { x: 40,   y: 40 }, domain: 'video', params: { orient: 0.4, amp: 10, thickness: 0.45 } },
        { id: 'v-mono',  type: 'monoglitch', position: { x: 360,  y: 40 }, domain: 'video', params: { intensity: 0.7, lines: 96 } },
        { id: 'v-rutt',  type: 'ruttetra',   position: { x: 720,  y: 40 }, domain: 'video', params: { intensity: 1.2, xDisp: 0.3, yDisp: 0.3 } },
        { id: 'v-out',   type: 'videoOut',   position: { x: 1080, y: 40 }, domain: 'video' },
      ],
      [
        { id: 'e-lines-mono', from: { nodeId: 'v-lines', portId: 'out' }, to: { nodeId: 'v-mono', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-mono-rutt',  from: { nodeId: 'v-mono',  portId: 'out' }, to: { nodeId: 'v-rutt', portId: 'z' },  sourceType: 'video',      targetType: 'video' },
        { id: 'e-rutt-out',   from: { nodeId: 'v-rutt',  portId: 'out' }, to: { nodeId: 'v-out',  portId: 'in' }, sourceType: 'video',      targetType: 'video' },
      ],
    );

    // Structural (non-fragile): every module in the chain mounted in the DOM.
    await expect(page.locator('.svelte-flow__node-lines'),      'LINES visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-monoglitch'), 'MONOGLITCH visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-ruttetra'),   'RUTTETRA visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'),   'OUTPUT visible').toBeVisible();

    // Drive a FIXED burst synchronously (no rAF, no waitForTimeout) so the whole
    // chain renders, then read RUTTETRA's OWN `out` texture — the terminal effect
    // the entire LINES→MONOGLITCH→RUTTETRA chain has flowed into. RUTTETRA draws
    // ADDITIVE thin scanlines on a black phosphor backdrop, legitimately sparse,
    // so lower the non-black floor (like SPIROGRAPHS); the variance floor still
    // rejects a flat/black frame (sparse bright lines on black = high luma
    // variance).
    const a = await stepAndReadStats(page, { nodeId: 'v-rutt', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS, { minNonZeroFrac: 0.001 });

    // DETERMINISM: a second independent burst (clock still frozen, no accumulating
    // state anywhere in the chain) must produce a frame-stable result — same mean
    // + variance to a tight epsilon. This replaces the old flaky one-shot pixel
    // read with a stability proof that a genuine black/flat regression still
    // fails while driver pixel divergence never trips it.
    const b = await stepAndReadStats(page, { nodeId: 'v-rutt', steps: FIXED_STEPS });
    expect(b.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen chain output is frame-stable (mean ${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen chain output variance is frame-stable').toBeLessThan(1.0);

  });

  test('LINES → VDELAY → OUTPUT produces echoed/blended content', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    // Pause the rAF loop + pin the clock BEFORE boot — LINES (the source) renders
    // an identical frame every step, so the ONLY thing evolving across the fill
    // burst is VDELAY's own ring (exactly what we want to exercise).
    await installRenderSmokeHooks(page);

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'v-lines',  type: 'lines',    position: { x: 40,  y: 40  }, domain: 'video', params: { orient: 0, amp: 12, thickness: 0.4 } },
        { id: 'v-delay',  type: 'vdelay',   position: { x: 360, y: 40  }, domain: 'video', params: { delayTime: 4, feedback: 0.3, mix: 0.5 } },
        { id: 'v-out',    type: 'videoOut', position: { x: 720, y: 40  }, domain: 'video' },
      ],
      [
        { id: 'e-lines-delay', from: { nodeId: 'v-lines', portId: 'out' }, to: { nodeId: 'v-delay', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-delay-out',   from: { nodeId: 'v-delay', portId: 'out' }, to: { nodeId: 'v-out',   portId: 'in' }, sourceType: 'video',      targetType: 'video' },
      ],
    );

    // Structural (non-fragile): VDELAY + OUTPUT mounted.
    await expect(page.locator('.svelte-flow__node-vdelay'),   'VDELAY visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'), 'OUTPUT visible').toBeVisible();

    // Plan §3 directive: freeze → step N (>=30) to fill the ring past the 4-frame
    // delay tap + accumulate feedback echoes → read VDELAY's OWN `out` texture
    // ONCE. The fixed synchronous burst replaces the old waitForTimeout(800) (whose
    // "~48 frames at 60fps" was a rAF-cadence GUESS); now we drive the exact frame
    // count and the harness asserts the frame delta is exactly what we drove.
    const out = await stepAndReadStats(page, { nodeId: 'v-delay', steps: VDELAY_FILL_STEPS });

    // VDELAY at mix=0.5 + LINES driving in: after the fill the output has visible,
    // structured content. Renderer-tolerant floors (non-black + spatial structure
    // + FBO readable + exact frame count + zero GL errors). LINES is a sparse
    // line pattern → lower the non-black floor; the variance floor rejects a
    // flat/black frame. No second-burst stability assert: VDELAY's ring keeps
    // ACCUMULATING (no frame.time-purity, no module `freeze` pin), so a second
    // equal burst legitimately reads a different ring state — see header.
    assertRenderStats(out, VDELAY_FILL_STEPS, { minNonZeroFrac: 0.001 });

    expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });
});
