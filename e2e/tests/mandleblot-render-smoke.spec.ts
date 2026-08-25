// e2e/tests/mandleblot-render-smoke.spec.ts
//
// DETERMINISTIC render-smoke (DRS) for MANDLEBLOT — a pure-GL Mandelbrot
// fractal VIDEO SOURCE (no video input; its only input is `zoom_cv`). Modeled
// EXACTLY on spirographs-render-smoke.spec.ts + the shared _render-smoke harness
// (installRenderSmokeHooks / stepAndReadStats / assertRenderStats).
//
// WHY THIS WAS DEFERRED IN PHASE 1 (rendered fully black, nonZeroFrac=0):
//   MANDLEBLOT's DEFAULTS are zoom=0.2 (→ ~10× via jsZoomFromKnob) centred at
//   (-0.7, 0) — that's deep inside the main cardioid, so most of the visible
//   frame is IN-SET. The COLOUR pass renders in-set points as PURE BLACK
//   (`if (iter >= uIterations) col = vec3(0.0)`), so at the default ~10× cardioid
//   view the lit fraction collapses toward zero and the generic DRS template
//   (which spawns with no params) fell under the non-black floor → "all black".
//   Nothing about the module is non-deterministic; the default *view* was the
//   problem.
//
// THE UNBLOCK — set a view that renders structured, non-black fractal content:
//   zoom=0 → 1× (full Mandelbrot set in view), center_x=-0.5, center_y=0,
//   iterations=100. At full zoom-out the boundary fills the frame, so the
//   escape-count distribution is rich and the COLOUR hue ramp lights up a large
//   fraction of the canvas (this is the SAME view mandleblot.spec.ts already
//   proves paints >10% bright pixels, variance in the thousands).
//   color_cycle=0 additionally drops the uTime + log(uZoom) terms out of the hue
//   entirely, so the painted colour does not depend on the clock value AT ALL —
//   belt-and-suspenders determinism on top of the frozen-clock template.
//
// WHY DETERMINISTIC WHEN FROZEN: draw(frame) reads ONLY `frame.time` (→ uTime)
// plus the static params. There is NO frame.timeDelta, NO Math.random()/RNG, NO
// own Date.now()/performance.now(), and NO accumulating per-frame state. Pinning
// the engine clock (__videoEngineFreezeTime) makes uTime identical on every step
// → the shader renders a bit-stable frame; with color_cycle=0 even uTime drops
// out of the output. Combined with the paused rAF loop (__videoEnginePause →
// the test owns the exact frame count), two independent step bursts produce a
// frame-stable result.
//
// PORT: MANDLEBLOT has TWO outputs — `mono_out` (mono-video) and `color_out`
// (the canonical COLOUR surface). We wire + read the COLOUR output (`color_out`).

import { test, expect, type Page } from './_fixtures';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats, type RenderStats } from './_render-smoke';

const FIXED_STEPS = 6;

// ── The clock values the pin test steps through ─────────────────────────────
//
// The hue is `mod(mu*0.05 + uTime*0.1*uColorCycle + log(uZoom)*0.1*uColorCycle, 1)`.
// The view below sets `zoom = 0` → uZoom = 1 → log(uZoom) = 0, so the zoom term
// drops out exactly and uTime is the ONLY thing moving the picture. At the
// SHIPPED `color_cycle` of 1 the uTime coefficient is 0.1/s, so the palette has
// a period of 10 s.
//
// ⚠ AND THAT PERIOD IS A TRAP THIS TEST HAD TO BE WRITTEN AROUND, which is why
// the values are spelled out rather than picked. The first draft probed t = 2.0
// against t = 12.0 — a lag of exactly one period, so the renderer returns a
// BIT-IDENTICAL frame (measured: mean 28.984890407986203 and variance
// 3184.528634547505 at both). A clock pin that did nothing at all would have
// passed that comparison. It is precisely the "sample at co-prime / irregular
// offsets when probing anything periodic" case, and it is worth recording
// because the whole reason this test exists is that a stillness check went
// green for a reason unrelated to the mechanism it was supposed to be proving.
//
// T_A → T_B is HALF a period (the largest possible move). T_D is deliberately
// neither a whole nor a half multiple.
const T_A = 2.0;
const T_B = 7.0;
const T_D = 4.5;

/** Move the engine's pinned clock. `VideoEngine.step()` re-reads
 *  `__videoEngineFreezeTime` every frame, so this takes effect on the next
 *  burst without a reboot. */
async function setEngineClock(page: Page, seconds: number): Promise<void> {
  await page.evaluate((t) => {
    (globalThis as unknown as { __videoEngineFreezeTime?: number }).__videoEngineFreezeTime = t;
  }, seconds);
}

/**
 * ONE scalar distance between two reads, used by every leg below so that
 * "these frames are the same" and "these frames are different" are the same
 * measurement in both directions rather than two thresholds that could drift
 * apart.
 *
 * ⚠ IT COMBINES BOTH STATISTICS BECAUSE NEITHER IS INJECTIVE IN THE HUE. The
 * mean luma of a full-saturation hue ramp is not monotonic in the rotation, so
 * two genuinely different frames can land on nearly the same mean — measured on
 * this exact view, t = 2.0 s and t = 4.5 s differ by only 0.70 in mean while
 * their variances differ by 169. A mean-only distance would have called those
 * two frames identical, which is the same shape of mistake as the defect this
 * file records.
 *
 * Variance is a squared quantity on the same 0..255 luma scale, so /100 puts a
 * variance move of ~100 on a par with a mean move of ~1. The floor below is
 * measured against the combined number, not reasoned into it.
 */
function frameDistance(x: RenderStats, y: RenderStats): number {
  return Math.abs(x.mean - y.mean) + Math.abs(x.variance - y.variance) / 100;
}

/** How far two reads must be apart for "these are different frames" to be a
 *  real observation rather than readback noise. MEASURED on this view:
 *  t=2.0s→7.0s (half a hue period) = 8.68, and the closest pair this test
 *  compares, t=2.0s→4.5s = 2.39. A floor of 1.0 sits below both with margin and
 *  leaves room for SwiftShader and a real GPU to disagree on exact pixels —
 *  they disagree about ANTI-ALIASING, not about whether the hue rotated. */
const MIN_CLOCK_RESPONSE = 1.0;

/** Two reads at the SAME pinned clock return the same bytes, so the same
 *  doubles. This is an equality check with a floating-point apology, not a
 *  tolerance — anything above zero here means something other than the pinned
 *  clock is moving the picture. */
const PURE_FUNCTION_EPSILON = 1e-9;

test.describe('MANDLEBLOT — deterministic render smoke', () => {
  test('freeze + pause + synchronous step → non-black, structured, frame-stable, zero GL errors', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);

    // Pause the engine rAF loop + pin the clock BEFORE boot.
    await installRenderSmokeHooks(page);

    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');

    // MANDLEBLOT is a pure generated SOURCE (no decode/getUserMedia/asset) →
    // OUTPUT so it definitely renders. Spawn with the proven non-black view
    // (zoom=0 full set, centred on the boundary-rich -0.5 framing, color_cycle=0
    // so the painted colour is clock-independent) and read its COLOUR output.
    await spawnPatch(
      page,
      [
        { id: 'm',   type: 'mandleblot', position: { x: 100, y: 100 }, domain: 'video',
          params: { zoom: 0, center_x: -0.5, center_y: 0, iterations: 100, color_cycle: 0, rotation: 0 } },
        { id: 'out', type: 'videoOut',   position: { x: 540, y: 100 }, domain: 'video' },
      ],
      [
        { id: 'e', from: { nodeId: 'm', portId: 'color_out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    // First burst: drive a FIXED number of frames synchronously + read once.
    const a = await stepAndReadStats(page, { nodeId: 'm', portId: 'color_out', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS);

    // DETERMINISM: a second independent burst (clock still frozen) must produce a
    // frame-stable result — same mean + variance to a tight epsilon.
    const b = await stepAndReadStats(page, { nodeId: 'm', portId: 'color_out', steps: FIXED_STEPS });
    expect(b.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen output is frame-stable (mean ${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen output variance is frame-stable').toBeLessThan(1.0);

  });

  // ── THE CLOCK PIN THE VRT FACE SCENE RELIES ON ────────────────────────────
  //
  // ⚠ THIS IS A POSITIVE CONTROL FOR `__videoEngineFreezeTime`, AND IT EXISTS
  // BECAUSE THE FACE SCENE'S OWN STILLNESS CHECK CANNOT BE ONE.
  //
  // mandleblot's `FACES` entry (e2e/vrt/_shell-faces.ts) declares
  // `simPin: __videoEngineFreezeTime` and argues, in its `videoFaceWhy`, that
  // pinning that global is what makes the capture still — the `inwards`
  // argument: a stateless renderer whose only moving term is `frame.time`
  // becomes a pure function of its params the moment the clock stops.
  //
  // ⚠ NOTHING IN THE FACE LANE CAN FALSIFY THAT. `freezeFaceVideo` asserts the
  // captured surface is byte-identical across a second read, and on that scene
  // it is — but not because anything held it. At the SHIPPED DEFAULTS the whole
  // visible window is inside the main cardioid, every point is in-set, and
  // `if (iter >= uIterations) col = vec3(0.0)` paints the colour pass uniformly
  // black. Measured through THIS harness at the default view, engine clock
  // 2.0 s and 7.0 s: nonZeroFrac 0, variance 0, mean 0 at BOTH. The surface is
  // byte-identical because it holds NO DATA — the exact hole `freezeFaceVideo`'s
  // own doc-comment names ("a scene whose video never rendered at all ...
  // satisfies it VACUOUSLY"), on a scene nobody was looking at for it.
  //
  // So the proof that the pin is load-bearing has to live HERE, on a view that
  // DOES paint, and it is written in both directions:
  //
  //   A → B  moving the pinned clock MOVES the picture      (28.98 → 26.09 mean)
  //   B → C  putting it back reproduces A BIT-EXACTLY       (no hidden state)
  //
  // The second leg is the one the roster's `why` actually claims, and it is the
  // stronger claim: a renderer with an accumulator could never return to an
  // identical frame after being driven away from it. Together they say the
  // frame is a pure function of (params, pinned clock) — which is what makes
  // pinning the clock TOTAL determinism rather than a partial settle.
  //
  // ⚠ AND THE FIRST LEG IS NOT DECORATION. Without it the second passes
  // trivially on a picture that never responded to the clock at all — which is
  // precisely the state the face scene is in, and precisely how the missing pin
  // survived. A test that only checks "same clock, same frame" would have been
  // green on a module where the clock reached nothing.
  test('the engine clock pin is LOAD-BEARING — the picture tracks it, and returns to the same frame bit-exactly', async ({ page }) => {
    test.setTimeout(60_000);

    await installRenderSmokeHooks(page, T_A);

    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');

    // The same painting view as the test above, but with `color_cycle` at the
    // SHIPPED default of 1 rather than 0. That difference is the whole point:
    // the test above sets it to 0 precisely so uTime drops out of the hue, so
    // its frame-stability holds whether or not the clock pin works. This one
    // needs uTime to REACH the output, or there is no pin to be load-bearing
    // about.
    await spawnPatch(
      page,
      [
        { id: 'm',   type: 'mandleblot', position: { x: 100, y: 100 }, domain: 'video',
          params: { zoom: 0, center_x: -0.5, center_y: 0, iterations: 100, color_cycle: 1, rotation: 0 } },
        { id: 'out', type: 'videoOut',   position: { x: 540, y: 100 }, domain: 'video' },
      ],
      [
        { id: 'e', from: { nodeId: 'm', portId: 'color_out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    const burst = () => stepAndReadStats(page, { nodeId: 'm', portId: 'color_out', steps: FIXED_STEPS });

    // ── A: the clock pinned at T_A. Structured and non-black, or nothing below
    //       means anything (the "the subject exists" leg).
    const a = await burst();
    assertRenderStats(a, FIXED_STEPS);

    // ── B: half a hue period later. THE PIN REACHES THE SHADER — without this
    //       leg every equality below is satisfied by a picture that ignores the
    //       clock entirely, which is the bug this file now records.
    await setEngineClock(page, T_B);
    const b = await burst();
    expect(
      frameDistance(a, b),
      `POSITIVE CONTROL: moving the pinned clock must move the picture. t=${T_A}s read mean `
        + `${a.mean.toFixed(4)} / variance ${a.variance.toFixed(1)}; t=${T_B}s read mean `
        + `${b.mean.toFixed(4)} / variance ${b.variance.toFixed(1)}. If this is flat, either the `
        + `view stopped painting or __videoEngineFreezeTime is not reaching frame.time — and `
        + `every assertion below then passes for free.`,
    ).toBeGreaterThan(MIN_CLOCK_RESPONSE);

    // ── C: wind the pin BACK to T_A. The frame must be bit-identical to A. This
    //       is the roster's actual claim — no accumulator, no ping-pong, no RNG
    //       — and a renderer carrying any of those cannot satisfy it.
    await setEngineClock(page, T_A);
    const c = await burst();
    expect(
      frameDistance(a, c),
      `the frame must be a PURE FUNCTION of (params, pinned clock): back at t=${T_A}s the `
        + `surface read mean ${c.mean} / variance ${c.variance} against the first read at that `
        + `same clock, mean ${a.mean} / variance ${a.variance}. A difference here means state `
        + `survived the excursion to t=${T_B}s, and a clock pin alone would NOT make the face `
        + `scene deterministic — it would need the mirrorpool treatment.`,
    ).toBeLessThan(PURE_FUNCTION_EPSILON);

    // ── D: an IRREGULAR pin value — neither a whole nor a half period from
    //       either of the two above, so the equalities cannot be an aliasing
    //       artefact of the 10 s palette cycle. It must differ from BOTH.
    await setEngineClock(page, T_D);
    const d = await burst();
    expect(
      Math.min(frameDistance(a, d), frameDistance(b, d)),
      `an irregular pin (t=${T_D}s) must land on its own frame rather than alias onto one `
        + `already seen: mean ${d.mean.toFixed(4)} / variance ${d.variance.toFixed(1)} against `
        + `t=${T_A}s (${a.mean.toFixed(4)} / ${a.variance.toFixed(1)}) and t=${T_B}s `
        + `(${b.mean.toFixed(4)} / ${b.variance.toFixed(1)}).`,
    ).toBeGreaterThan(MIN_CLOCK_RESPONSE);

    expect(d.glErrors, `GL errors across the clock sweep: [${d.glErrors.join(',')}]`).toEqual([]);
  });
});
