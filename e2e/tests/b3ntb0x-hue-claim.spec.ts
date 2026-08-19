// e2e/tests/b3ntb0x-hue-claim.spec.ts
//
// THE ACCEPTANCE TEST FOR `_helpers/glsl-claim.ts` — the first time a video
// module's readout claim is checked against DELIVERED PIXELS rather than read
// off the shader source.
//
// ── THE CLAIM, AND HOW MEASURING IT CHANGED IT ──────────────────────────────
//
// #1896 verified IN SOURCE that `b3ntb0x.ts:504` is
// `float theta = clamp(uHue, -1.0, 1.0) * HUE_MAX_RAD` with
// `HUE_MAX_RAD = 0.9 * Math.PI` (`b3ntb0x-dsp.ts`), and concluded "b3ntb0x's Hue
// tops out at 162° and never wraps" — while `bentbox` multiplies an
// identically-labelled control by `TWO_PI`, so ITS ends both land back on its
// centre. That issue was explicit that nothing had been rendered.
//
// ⚠ RENDERED, THE 162 IS A SHADER CONSTANT AND NOT A DELIVERED ONE. `theta`
// rotates the recovered (I, Q) vector, and the YIQ basis is NOT isotropic — I and
// Q carry different scales, so a circle in IQ space is an ELLIPSE in the RGB
// chroma plane and a rigid 162° rotation there arrives WARPED here. Measured
// through this harness at three input hues, full Hue travel delivers:
//
//     input hue ~15°   ->  172.2°        input hue ~102°  ->  157.7°
//     input hue ~216°  ->  162.2°
//
// It CLUSTERS around 162 and is not equal to it, and WHICH value you get depends
// on the colour you fed in. So a face readout printing "162°" would be printing
// the uniform's argument, not the rotation the viewer receives. What IS
// input-independent, and what this spec gates, is the half that mattered to
// #1896's comparison: **it never reaches 180°.**
//
// ⚠ AND THE NAIVE MEASUREMENT GETS IT BACKWARDS. Comparing hue at 0 against hue
// at 1 directly returns 187.8° — the shortest-arc ALIAS of −172.2°, i.e. a
// rotation reported in the wrong direction and over-large, from an instrument
// showing no sign of trouble. Only walking the sweep finely enough that no
// single step is ambiguous recovers the true figure, which is why this spec
// sweeps and calls `assertUnambiguousSteps` rather than reading two endpoints.
//
// ── THE RIG ─────────────────────────────────────────────────────────────────
//
//   shapes (mono, zoomed to fill) → colorizer (tint) → b3ntb0x
//
// `colorizer` emits `(mono·R, mono·G, mono·B)`, so every lit pixel carries the
// SAME hue and only intensity varies — the one input for which a frame's mean
// hue is an honest summary. Verified as such: at the tint below the colorizer's
// own output measures hue 12.00°, saturation 1.000, circular spread 0.0000.
// Feeding `shapes` straight in (as b3ntb0x.spec.ts does) gives spread 0.99 —
// a mono source has no chroma to rotate, so it cannot test this claim at all.
//
// BOTH CLOCKS ARE PINNED — the engine's (`installRenderSmokeHooks`) and
// b3ntb0x's own subcarrier clock (`__b3ntb0xFreezeTimeSec`) — and every wait is
// a frame count this test drove. No `waitForTimeout`.
//
// ── ⚠ THE CONTROL THIS SPEC DOES NOT HAVE, NAMED RATHER THAN LEFT IMPLICIT ──
//
// The assertions below have a positive control (half travel moves, and by
// roughly half) and a negative control (a LUMA-only param moves the hue not at
// all). They do NOT have a GEOMETRY-level control: nothing here demonstrates
// that this instrument would report a WRAP if one happened. `bentbox` is the
// case that would — `bentbox.ts:324` is
// `float ang = (uChromaPhase + phaseNoise) * TWO_PI` over a −1..1 param
// (verified in source), so its cumulative rotation should climb through 360 and
// RETURN TO 0, with its maximum shift at HALF travel. Adding that leg would
// make "under 180" a measured discrimination rather than a measured bound.
// It is deliberately NOT built here — it is a second module rig and a second
// browser test's CI time, beyond this harness's acceptance criterion — but the
// gap is real and this is where a reader should learn about it.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';
import {
  readDeliveredColour,
  setVideoParam,
  assertMeasurable,
  hueDeltaDeg,
  cumulativeRotationDeg,
  assertUnambiguousSteps,
} from '../_helpers/glsl-claim';

/** 4-pass pipeline + ping-pong. 8 is the figure b3ntb0x.spec.ts established as
 *  "well past warm to steady state" — and it is load-bearing, not padding: at 4
 *  steps this module's output is still bit-exactly BLACK, which reads as "the
 *  module is broken" rather than "you did not wait". */
const STEPS = 8;

/** Held OFF so the only thing moving across a sweep is the uniform under test.
 *  tbc=1 is the shipped rock-steady setting; feedback and sub_drift are the two
 *  intra-pipeline animation sources. */
const STILL = { tbc: 1, feedback: 0, sub_drift: 0, hue: 0 };

/** An OFF-AXIS saturated tint — not a primary, so the measurement does not sit
 *  on a degenerate point of the I/Q plane. */
const TINT = { tintR: 1, tintG: 0.2, tintB: 0 };

async function bootRig(page: Page): Promise<void> {
  await installRenderSmokeHooks(page);
  await page.addInitScript(() => {
    (window as unknown as { __b3ntb0xFreezeTimeSec?: number }).__b3ntb0xFreezeTimeSec = 2.0;
  });
  await page.goto('/rack?shell=legacy&seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      // zoom past the cell so the shape overflows it — a solid lit field rather
      // than a small blob on black.
      { id: 'src', type: 'shapes', position: { x: 60, y: 100 }, domain: 'video',
        params: { shape: 1, tile: 0, tileN: 1, rotate: 0, zoom: 10 } },
      { id: 'col', type: 'colorizer', position: { x: 280, y: 100 }, domain: 'video', params: { ...TINT } },
      { id: 'b', type: 'b3ntb0x', position: { x: 500, y: 100 }, domain: 'video', params: { ...STILL } },
    ],
    [
      { id: 'e1', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'col', portId: 'in' }, sourceType: 'mono-video', targetType: 'mono-video' },
      { id: 'e2', from: { nodeId: 'col', portId: 'out' }, to: { nodeId: 'b', portId: 'in' }, sourceType: 'video', targetType: 'video' },
    ],
  );
}

/**
 * Sweep `hue` across `values`, returning the measured hue at each.
 *
 * `maxSpread` is the coherence bar each read must clear. The default is right
 * for the primary tint, where the decoded field is one hue and the mean is an
 * honest summary. ⚠ It is RELAXED for the multi-tint comparison below, on
 * purpose and with a reason: NTSC does not carry every hue with equal
 * coherence — chroma near the I/Q axes survives the encode/decode round trip
 * more cleanly than chroma between them — so a bar tuned to the best case would
 * be rejecting real signal rather than noise. The tight bar still applies where
 * coherence is the thing being claimed (test 1); the looser one applies where
 * the claim is about the ROTATION and coherence is only a precondition.
 */
async function sweepHue(
  page: Page,
  values: readonly number[],
  maxSpread?: number,
): Promise<number[]> {
  const hues: number[] = [];
  for (const v of values) {
    await setVideoParam(page, 'b', 'hue', v);
    const c = await readDeliveredColour(page, { nodeId: 'b', portId: 'out', steps: STEPS });
    assertMeasurable(c, STEPS, maxSpread === undefined ? {} : { maxSpread });
    hues.push(c.hueDeg);
  }
  return hues;
}

test.describe('b3ntb0x HUE — the delivered rotation, measured in pixels', () => {
  test('the full Hue travel delivers a rotation near 0.9pi and NEVER reaches half a turn', async ({ page, errorWatch }) => {
    test.setTimeout(180_000);
    await bootRig(page);

    // Fine enough that no single step approaches 180deg, so the unwrap below is
    // measuring a branch rather than choosing one.
    const values = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    const hues = await sweepHue(page, values);
    assertUnambiguousSteps(hues);

    const cum = cumulativeRotationDeg(hues);
    const trace = cum.map((d) => d.toFixed(1)).join(', ');
    const total = Math.abs(cum[cum.length - 1]!);

    // THE HEADLINE, and the one claim that is input-INDEPENDENT: the control
    // cannot express the half-turn its label invites you to expect.
    expect(
      total,
      `delivered rotation over FULL Hue travel, DEGREES (cumulative: ${trace}) — ` +
        `the control must NOT reach 180, which is the whole of #1896's comparison against bentbox`,
    ).toBeLessThan(180);

    // AND it lands in the neighbourhood of the shader's 0.9pi = 162deg. The band
    // is wide ON PURPOSE: the YIQ basis warps the delivered angle by roughly
    // +/-8deg depending on the input hue (see the header), so a tight pin here
    // would be pinning THIS TINT rather than the module.
    expect(total, `delivered rotation, DEGREES (cumulative: ${trace})`).toBeGreaterThan(148);
    expect(total, `delivered rotation, DEGREES (cumulative: ${trace})`).toBeLessThan(178);

    // MONOTONIC — it climbs and stops. bentbox's equivalent would climb through
    // 360 and come back, and that difference is invisible to any endpoint
    // comparison.
    const signs = new Set(
      cum.slice(1).map((d, i) => Math.sign(d - cum[i]!)).filter((s) => s !== 0),
    );
    expect([...signs], `the rotation must travel in ONE direction (cumulative: ${trace})`).toHaveLength(1);

    // POSITIVE CONTROL, taken from the same sweep so it costs no extra frames:
    // half the travel moves the picture, and moves it by roughly half. NOT
    // exactly half — the warp again — so this asserts a band, and a band that
    // EXCLUDES both 0 (dead control) and 1 (the instrument saturating).
    const half = Math.abs(cum[5]!) / total;
    expect(
      half,
      `fraction of the full rotation delivered at HALF travel (cumulative: ${trace}) — ` +
        `must be near 0.5; 0 would mean a dead control and 1 a saturated instrument`,
    ).toBeGreaterThan(0.3);
    expect(half, 'fraction of the full rotation delivered at HALF travel').toBeLessThan(0.75);
  });

  test('the delivered rotation is INPUT-DEPENDENT (so 162 is the uniform, not the readout), and a LUMA param moves it not at all', async ({ page, errorWatch }) => {
    test.setTimeout(180_000);
    await bootRig(page);

    // ── NEGATIVE CONTROL, first and cheapest ────────────────────────────────
    // `luma_peak` is a decode-side unsharp on Y. It touches LUMA and never the
    // (I,Q) rotation, so if it moved the hue this instrument would be reporting
    // something other than the chroma phase and every number here would be void.
    await setVideoParam(page, 'b', 'hue', 0);
    const base = await readDeliveredColour(page, { nodeId: 'b', portId: 'out', steps: STEPS });
    assertMeasurable(base, STEPS);

    await setVideoParam(page, 'b', 'luma_peak', 1);
    const luma = await readDeliveredColour(page, { nodeId: 'b', portId: 'out', steps: STEPS });
    assertMeasurable(luma, STEPS);
    expect(
      Math.abs(hueDeltaDeg(base.hueDeg, luma.hueDeg)),
      `hue movement from a LUMA-only param, DEGREES (${base.hueDeg.toFixed(2)} -> ${luma.hueDeg.toFixed(2)}) — ` +
        `must be ~0, or this instrument is not measuring the chroma phase`,
    ).toBeLessThan(8);
    await setVideoParam(page, 'b', 'luma_peak', 0);

    // ── THE FINDING: the same control, different inputs, different rotations ─
    // Coarse sweep (quarter steps) — enough to unwrap safely, a third of the
    // frames of the fine one.
    const values = [0, 0.25, 0.5, 0.75, 1.0];
    const totals: Array<{ name: string; inHue: number; total: number }> = [];
    for (const [name, r, g, b] of [
      ['red-ish', 1, 0.2, 0],
      ['green-ish', 0.2, 1, 0],
      ['blue-ish', 0, 0.3, 1],
    ] as const) {
      await setVideoParam(page, 'col', 'tintR', r);
      await setVideoParam(page, 'col', 'tintG', g);
      await setVideoParam(page, 'col', 'tintB', b);
      // Relaxed coherence bar — see sweepHue's doc. Still far below the 0.99 a
      // genuinely incoherent field (a mono source) produces, so it cannot pass
      // on noise.
      const hues = await sweepHue(page, values, 0.55);
      assertUnambiguousSteps(hues);
      const cum = cumulativeRotationDeg(hues);
      totals.push({ name, inHue: hues[0]!, total: Math.abs(cum[cum.length - 1]!) });
    }

    const report = totals
      .map((t) => `${t.name} (in ${t.inHue.toFixed(0)}deg) -> ${t.total.toFixed(1)}deg`)
      .join(' | ');

    // EVERY input stays under half a turn. This is the claim a readout could
    // honestly make, and it is the one #1896 needed.
    for (const t of totals) {
      expect(t.total, `full-travel rotation must stay under 180 DEGREES for every input hue — ${report}`).toBeLessThan(180);
      expect(t.total, `and must be a real rotation, not a stuck control — ${report}`).toBeGreaterThan(120);
    }

    // AND THEY GENUINELY DIFFER — the delivered angle is a function of the input
    // colour, which is why "162" cannot be printed as the delivered figure. If
    // this ever collapses to ~0 the YIQ basis has become isotropic and the
    // header's whole argument needs re-deriving.
    const spread = Math.max(...totals.map((t) => t.total)) - Math.min(...totals.map((t) => t.total));
    expect(
      spread,
      `spread of full-travel rotation across input hues, DEGREES — ${report}. ` +
        `A non-trivial spread IS the finding: the shader rotates (I,Q) rigidly, the eye receives it warped`,
    ).toBeGreaterThan(2);
    expect(
      spread,
      `spread across input hues, DEGREES — ${report}. Too wide and the values no longer cluster on 0.9pi at all`,
    ).toBeLessThan(40);
  });
});
