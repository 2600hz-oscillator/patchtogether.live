// packages/web/src/lib/video/modules/backdraft-tv.test.ts
//
// BACKDRAFT PURE TV + CRITICAL — the bounded-screen (Crutchfield) mode.
//
// The whole feature is a GEOMETRIC claim ("each recursing image is shown only
// inside the boundaries of the interior box"), and a shader cannot be
// unit-tested — so the claim is proven HERE, in the GL-free CPU mirror, and the
// e2e only has to show that the GPU renders the same thing.
// `toybox-feedback.ts` (tunnelTap / simulateTunnel) is the precedent.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  BACKDRAFT_FLICKER_COUNT,
  BACKDRAFT_FLICKER_KNEE,
  BACKDRAFT_MAX_EFFECT_SCALE,
  BACKDRAFT_MAX_FEEDBACK,
  BACKDRAFT_ZOOM_MIN,
  BACKDRAFT_ZOOM_MAX,
  BACKDRAFT_TV_GLASS,
  BACKDRAFT_TV_WHITE,
  BACKDRAFT_TV_GAIN_MARGINAL,
  BACKDRAFT_TV_FILL_MIN,
  BACKDRAFT_TV_FILL_DEFAULT,
  BACKDRAFT_TV_FILL_MAX,
  BACKDRAFT_TV_BEZEL_MIN,
  BACKDRAFT_TV_BEZEL_MAX,
  BACKDRAFT_TV_MODE_COUNT,
  BACKDRAFT_TV_MODE_LABELS,
  BACKDRAFT_TEXTURE_UNITS,
  BACKDRAFT_FPS,
  BACKDRAFT_TV_BEAM_SOFT,
  BACKDRAFT_CAM_TILT_MAX_DEG,
  BACKDRAFT_CAM_TILT_RANGE,
  BACKDRAFT_CAM_POS_RANGE,
  BACKDRAFT_CAM_DIST_MIN,
  BACKDRAFT_CAM_DIST_MAX,
  backdraftCamDistance,
  backdraftCamInverseHomography,
  backdraftTvBeam,
  backdraftTvRefreshMix,
  BACKDRAFT_TV_AGC_MIN,
  BACKDRAFT_TV_AGC_MAX,
  BACKDRAFT_TV_AGC_RATE_MIN,
  BACKDRAFT_TV_AGC_RATE_MAX,
  backdraftDef,
  backdraftShoulder,
  backdraftNextTvMode,
  backdraftTvFill,
  backdraftTvBezel,
  backdraftTvGain,
  backdraftTvOpNorm,
  backdraftTvFlickerMult,
  backdraftTvLevelBrightness,
  backdraftTvTap,
  backdraftTvAgcRate,
  backdraftTvAgcStep,
  simulateBackdraftTv,
} from './backdraft';

/** Dark-bezel band positions along the centre row, walking OUT from centre.
 *  A band is a local minimum dipping >= 40 % below the mean of its two flanking
 *  local maxima — a LOCAL-contrast test, so unlike a "< 0.4 x row median"
 *  threshold it does not depend on the source's absolute brightness. */
function tvBands(r: { frame: Float32Array; width: number; height: number }): number[] {
  const { frame, width: W, height: H } = r;
  const y = Math.floor(H / 2);
  const half: number[] = [];
  for (let x = Math.floor(W / 2); x < W; x++) half.push(frame[(y * W + x) * 3]!);
  const out: number[] = [];
  for (let i = 1; i < half.length - 1; i++) {
    if (!(half[i]! <= half[i - 1]! && half[i]! < half[i + 1]!)) continue;
    let l = i; while (l > 0 && half[l - 1]! >= half[l]!) l--;
    let rr = i; while (rr < half.length - 1 && half[rr + 1]! >= half[rr]!) rr++;
    const flank = (half[l]! + half[rr]!) / 2;
    if (flank > 1e-6 && half[i]! <= 0.6 * flank) out.push(i);
  }
  return out;
}

/** Pearson correlation of the red channel between two frames. */
function tvCorr(a: Float32Array, b: Float32Array): number {
  let ma = 0, mb = 0, n = 0;
  for (let i = 0; i < a.length; i += 3) { ma += a[i]!; mb += b[i]!; n++; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i += 3) {
    const da = a[i]! - ma, db = b[i]! - mb;
    sab += da * db; saa += da * da; sbb += db * db;
  }
  return sab / Math.sqrt(Math.max(1e-12, saa * sbb));
}

function tvFrameMean(f: Float32Array): number {
  let s = 0, n = 0;
  for (let i = 0; i < f.length; i += 3) { s += f[i]!; n++; }
  return s / n;
}

describe('BACKDRAFT PURE TV — geometry (the nest is real)', () => {
  it('N1 — the nest is a GEOMETRIC SERIES with ratio = the screen fill', () => {
    const r = simulateBackdraftTv({ size: 320, frames: 80, quantize: true });
    const bands = tvBands(r);
    // A real nest, not a smeared grey field: several resolved frames-in-frames.
    expect(bands.length).toBeGreaterThanOrEqual(6);
    const s = backdraftTvFill(1);
    for (let i = 1; i < Math.min(bands.length, 7); i++) {
      expect(bands[i - 1]! / bands[i]!).toBeGreaterThan(s - 0.05);
      expect(bands[i - 1]! / bands[i]!).toBeLessThan(s + 0.05);
    }
  }, 30_000);

  it('N2 — the SELF-SIMILARITY identity: out(x) == gEff*W*out(Mx) + lift', () => {
    // The owner's sentence — "each loop iteration completely constrains the
    // visual field of the succeeding iterations" — as an executable assertion.
    // The strongest single test of the feature; it fails on the legacy additive
    // composite at every parameter setting.
    const r = simulateBackdraftTv({ size: 256, frames: 140 });
    const { width: W, height: H, fill, bezelTb, gain, aspect } = r;
    const geo = { aspect, fill, rotateDeg: 0, offX: 0, offY: 0, bezelTb, shape: 0 };
    // Evaluate at exact PIXEL CENTRES and sample the tap BILINEARLY — the same
    // two things the mirror itself does. A nearest-neighbour tap lookup lands
    // on a deeper level's bezel every so often and reports a spurious residual
    // of ~0.37 that is pure sampling misalignment, not a broken identity.
    const bilinear = (u: number, v: number): number => {
      const fx = Math.min(W - 1, Math.max(0, u * W - 0.5));
      const fy = Math.min(H - 1, Math.max(0, v * H - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
      const ax = fx - x0, ay = fy - y0;
      const p = (x: number, y: number): number => r.frame[(y * W + x) * 3]!;
      return (p(x0, y0) * (1 - ax) + p(x1, y0) * ax) * (1 - ay)
        + (p(x0, y1) * (1 - ax) + p(x1, y1) * ax) * ay;
    };
    let checked = 0;
    let seed = 12345;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let k = 0; k < 40000 && checked < 400; k++) {
      const px = Math.floor(rnd() * W), py = Math.floor(rnd() * H);
      const u = (px + 0.5) / W, v = (py + 0.5) / H;
      const t = backdraftTvTap(u, v, geo);
      if (t.region !== 'screen') continue;
      // Stay clear of the bezel edge (the resampling ring) and of the innermost
      // levels, where the band is sub-pixel and bilinear mixing dominates.
      if (t.d > -3 * bezelTb) continue;
      if (Math.hypot((u - 0.5) * aspect, v - 0.5) < 0.08) continue;
      // The tap passes through the ALWAYS-ON capture shoulder before the colour
      // chain and the gain, so the identity carries it too. (Dropping it is
      // exactly what the design plan's §1.9 table does — the contradiction N4b
      // pins.)
      const predicted =
        gain * BACKDRAFT_TV_WHITE[0]!
          * backdraftShoulder(bilinear(t.tapU, t.tapV), BACKDRAFT_FLICKER_KNEE)
        + BACKDRAFT_TV_GLASS * (1 - gain);
      expect(Math.abs(r.frame[(py * W + px) * 3]! - predicted)).toBeLessThan(0.02);
      checked++;
    }
    expect(checked).toBeGreaterThan(200);
  }, 30_000);

  it('N3 — no clamp-smear: the ROOM is independent of the previous frame', () => {
    // The legacy CLAMP_TO_EDGE path fails this by construction: a tap that
    // leaves the frame returns a smeared copy of the border pixel, so the
    // "outside" carries the previous frame's content and nothing can nest.
    const a = simulateBackdraftTv({ size: 128, frames: 40, seed: 0 });
    const b = simulateBackdraftTv({ size: 128, frames: 40, seed: 0.9 });
    const geo = {
      aspect: a.aspect, fill: a.fill, rotateDeg: 0, offX: 0, offY: 0,
      bezelTb: a.bezelTb, shape: 0,
    };
    let roomPixels = 0;
    for (let y = 0; y < a.height; y += 3) {
      for (let x = 0; x < a.width; x += 3) {
        const t = backdraftTvTap((x + 0.5) / a.width, (y + 0.5) / a.height, geo);
        if (t.region !== 'room') continue;
        const i = (y * a.width + x) * 3;
        expect(a.frame[i]!).toBe(b.frame[i]!);
        roomPixels++;
      }
    }
    expect(roomPixels).toBeGreaterThan(200);
  });

  it('N4 — the brightness cascade is MONOTONE at every room level', () => {
    // The original ABSOLUTE lift flattened the cascade at room 0.20 and
    // INVERTED it (brightening inward) below that — the smeared grey field this
    // mode exists to remove. The room-proportional glass lift fixes it, so this
    // deliberately sweeps the dim cases the first design never tested.
    // 1.0 / 0.3 / 0.15 spans bright, mid, and the DIM end where the original
    // absolute lift inverted the cascade — which is the case this test exists
    // for. 256px still resolves the 5 levels the ladder needs.
    for (const room of [1.0, 0.3, 0.15]) {
      const r = simulateBackdraftTv({ size: 256, frames: 80, room });
      const cx = r.width / 2, y = Math.floor(r.height / 2);
      const s = r.fill;
      const pic = (k: number): number => Math.pow(s, k + 1) * (r.width / 2);
      const bez = (k: number): number =>
        Math.pow(s, k + 1) * (r.width / 2 + (r.bezelTb * r.width) / r.aspect);
      const ladder: number[] = [];
      for (let k = 1; k <= 5; k++) {
        let sum = 0, n = 0;
        for (let x = Math.ceil(cx + bez(k) + 1); x <= Math.floor(cx + pic(k - 1) - 1); x++) {
          sum += r.frame[(y * r.width + x) * 3]!; n++;
        }
        if (n > 0) ladder.push(sum / n);
      }
      expect(ladder.length).toBeGreaterThanOrEqual(4);
      for (let i = 1; i < ladder.length; i++) {
        expect(ladder[i]!).toBeLessThan(ladder[i - 1]!);
      }
      // …and it matches the closed form WITH the always-on shoulder folded in.
      for (let i = 0; i < ladder.length; i++) {
        const want = backdraftTvLevelBrightness(
          i + 1, r.gain, BACKDRAFT_TV_GLASS * room, room, BACKDRAFT_FLICKER_KNEE,
        );
        expect(Math.abs(ladder[i]! - want)).toBeLessThan(0.03);
      }
    }
  }, 30_000);

  it('N4b — the SHOULDERED ladder, pinned (the design table assumed NO shoulder)', () => {
    // The design plan's §1.9 published 1.000/0.880/0.778/0.691/0.618/0.555 —
    // which is the NO-SHOULDER cascade. But its own §1.5 mandates an always-on
    // shoulder inside the screen, and with that the real ladder is the second
    // list. Both adversarial review passes missed the contradiction. Pinning
    // BOTH is what identifies the shoulder as the cause rather than a bug.
    const g = backdraftTvGain(backdraftTvOpNorm({ r: 1, g: 1, b: 1, luma: 1, chroma: 1 }), 0.85, 1);
    const noShoulder = [0, 1, 2, 3, 4, 5].map((k) =>
      +backdraftTvLevelBrightness(k, g, BACKDRAFT_TV_GLASS, 1, 1).toFixed(3));
    expect(noShoulder).toEqual([1, 0.88, 0.778, 0.691, 0.618, 0.555]);
    const shouldered = [0, 1, 2, 3, 4, 5].map((k) =>
      +backdraftTvLevelBrightness(k, g, BACKDRAFT_TV_GLASS, 1, BACKDRAFT_FLICKER_KNEE).toFixed(3));
    expect(shouldered).toEqual([1, 0.739, 0.629, 0.559, 0.505, 0.459]);
  });

  it('N5 — PHOSPHOR changes only the temporal smear, never the converged image', () => {
    // Unit DC gain is a STABILITY requirement, not a nicety: the fixed point
    // satisfies I* = C(I*), so rho drops out of the steady state entirely.
    const base = simulateBackdraftTv({ size: 96, frames: 200, phosphor: 0 });
    for (const phosphor of [0.3, 0.9]) {
      const r = simulateBackdraftTv({ size: 96, frames: 200, phosphor });
      let maxDiff = 0;
      for (let i = 0; i < base.frame.length; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(base.frame[i]! - r.frame[i]!));
      }
      expect(maxDiff).toBeLessThan(0.01);
    }
    // …and it really does slow the approach down.
    const fast = simulateBackdraftTv({ size: 96, frames: 12, phosphor: 0 });
    const slow = simulateBackdraftTv({ size: 96, frames: 12, phosphor: 0.9 });
    expect(tvFrameMean(slow.frame)).toBeLessThan(tvFrameMean(fast.frame));
  }, 30_000);

  it('N6 — ROTATE is aspect-RIGID: a rolled screen stays rectangular', () => {
    // Rotating in raw UV space shears a 4:3 rectangle into a parallelogram —
    // acceptable for a tunnel, wrong for a television.
    const aspect = 4 / 3, fill = 0.75, phi = (25 * Math.PI) / 180;
    const c = Math.cos(phi), s = Math.sin(phi);
    const base: [number, number][] = [
      [-aspect / 2, -0.5], [aspect / 2, -0.5], [aspect / 2, 0.5], [-aspect / 2, 0.5],
    ];
    const corners = base.map(([x, y]) =>
      [fill * (x * c - y * s), fill * (x * s + y * c)] as [number, number]);
    const side = (i: number, j: number): number =>
      Math.hypot(corners[i]![0] - corners[j]![0], corners[i]![1] - corners[j]![1]);
    expect(side(0, 1)).toBeCloseTo(side(2, 3), 9);   // opposite sides equal
    expect(side(1, 2)).toBeCloseTo(side(3, 0), 9);
    expect(side(0, 2)).toBeCloseTo(side(1, 3), 9);   // diagonals equal
  });

  it('N-INV — the BOUNDARY INVARIANT: d < 0 implies the tap is inside [0,1]^2', () => {
    // This is the load-bearing reason NO GL state changes: CLAMP_TO_EDGE is not
    // reached by the sample centre, so every OTHER backdraft mode keeps its
    // documented clamp behaviour. The invariant silently depends on aspect >= 1
    // and on BACKDRAFT_SHAPE_RADIUS <= 0.5, so a radius bump must break this
    // LOUDLY rather than quietly re-opening the clamp path.
    // Collect violations rather than calling expect() at every sample: the
    // sweep visits ~750k points and vitest's expect() is what actually costs
    // the time (this test TIMED OUT on CI at 6.3 s while passing in 2.3 s
    // locally — CI is ~2.5x slower, so anything near the 5 s default is a
    // latent flake). A plain comparison plus one assertion at the end is ~20x
    // faster AND gives a far better failure message.
    const bad: string[] = [];
    let inside = 0;
    for (const aspect of [4 / 3, 16 / 9, 1]) {
      for (const shape of [0, 1, 2, 3, 4]) {
        for (const fill of [0.35, 0.5, 0.75, 0.95]) {
          for (const rotateDeg of [-180, -30, 0, 25, 180]) {
            for (const off of [[0, 0], [0.1, 0.1], [-0.1, 0.1], [0.1, -0.1]]) {
              const geo = {
                aspect, fill, rotateDeg, offX: off[0]!, offY: off[1]!,
                bezelTb: backdraftTvBezel(0.4), shape,
              };
              for (let i = 0; i <= 24; i++) {
                for (let j = 0; j <= 24; j++) {
                  const t = backdraftTvTap(i / 24, j / 24, geo);
                  if (t.d >= 0) continue;
                  inside++;
                  if (t.tapU < 0 || t.tapU > 1 || t.tapV < 0 || t.tapV > 1) {
                    if (bad.length < 8) {
                      bad.push(
                        `aspect=${aspect.toFixed(3)} shape=${shape} fill=${fill} `
                        + `rot=${rotateDeg} off=(${off[0]},${off[1]}) uv=(${(i / 24).toFixed(3)},`
                        + `${(j / 24).toFixed(3)}) d=${t.d.toFixed(4)} `
                        + `tap=(${t.tapU.toFixed(4)},${t.tapV.toFixed(4)})`,
                      );
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(bad, `boundary invariant violated at ${bad.length} sample(s)`).toEqual([]);
    expect(inside).toBeGreaterThan(5000);
  }, 30_000);
});

describe('BACKDRAFT PURE TV — the contraction contract', () => {
  it('N7 — the DEFAULTS are contractive, but the knobs REACH past marginal', () => {
    // There is deliberately no operator-norm ceiling. At the defaults the loop
    // is comfortably contractive (so the shipped look is a stable nest), and
    // the colour chain rides ON TOP of FEEDBACK so that cranking LUMA, or
    // pushing FEEDBACK to max with LUMA positive, crosses 1 and reaches
    // white-out. A loop that cannot be over-driven is not an instrument.
    const unity = backdraftTvOpNorm({ r: 1, g: 1, b: 1, luma: 1, chroma: 1 });
    const atDefault = unity * backdraftTvGain(unity, 0.85, 1);
    expect(atDefault).toBeLessThan(BACKDRAFT_TV_GAIN_MARGINAL);

    // Each of these ALONE must be able to push the per-pass gain past marginal.
    const overdriven: [string, number][] = [
      ['LUMA 2 at default FEEDBACK', (() => {
        const o = backdraftTvOpNorm({ r: 1, g: 1, b: 1, luma: 2, chroma: 1 });
        return o * backdraftTvGain(o, 0.85, 1);
      })()],
      ['FEEDBACK max, LUMA 1', (() => {
        const o = backdraftTvOpNorm({ r: 1, g: 1, b: 1, luma: 1, chroma: 1 });
        return o * backdraftTvGain(o, BACKDRAFT_MAX_FEEDBACK, 1);
      })()],
      ['FEEDBACK max, LUMA 2', (() => {
        const o = backdraftTvOpNorm({ r: 1, g: 1, b: 1, luma: 2, chroma: 1 });
        return o * backdraftTvGain(o, BACKDRAFT_MAX_FEEDBACK, 1);
      })()],
    ];
    for (const [label, gain] of overdriven) {
      expect(gain, `${label} must reach past marginal`).toBeGreaterThan(BACKDRAFT_TV_GAIN_MARGINAL);
    }
  });

  it('N7b — the peak-normalised FLICKER multiplier never exceeds 1', () => {
    // The shipped normaliser holds the GEOMETRIC MEAN at unity, and its per-row
    // PEAK reaches 1.88 at the 60 position — above 1, so in a bounded loop with
    // no source anchor inside the screen the nest goes FLAT. A pulsed emitter
    // attenuates; it cannot boost.
    for (let flicker = 0; flicker < BACKDRAFT_FLICKER_COUNT; flicker++) {
      for (let t = 0; t < 4; t += 0.037) {
        for (const v of [0, 0.25, 0.5, 0.75, 1]) {
          expect(backdraftTvFlickerMult(flicker, t, v)).toBeLessThanOrEqual(1 + 1e-6);
        }
      }
    }
  });

  it('N7c — at the DEFAULTS PURE TV converges to a still, un-pinned nest', () => {
    const r = simulateBackdraftTv({ size: 96, frames: 260 });
    expect(r.lastDelta).toBeLessThan(1e-6);
    expect(tvFrameMean(r.frame)).toBeLessThan(0.9);
  }, 30_000);

  it('N7d — WHITE-OUT is REACHABLE by LUMA / FEEDBACK, and RECOVERABLE', () => {
    // The owner's requirement: "cranking luma value, or increasing feedback to
    // max while luma is positive, should eventually create whiteout" — you
    // cannot have feedback worth riding without an uncontrollable zone to ride
    // toward. What must NOT happen is that the white-out is terminal.
    // Measure the BLOWN-OUT FRACTION, not the frame mean: the dark bezel bands
    // survive a white-out (they are drawn, not fed back) and drag the mean down
    // to ~0.83 even when every scrap of PICTURE is pinned at 1.0.
    const whiteFrac = (f: Float32Array): number => {
      let hot = 0, n = 0;
      for (let i = 0; i < f.length; i += 3) { if (f[i]! >= 0.9) hot++; n++; }
      return hot / n;
    };
    const nest = simulateBackdraftTv({ size: 96, frames: 200 });
    const nestMean = tvFrameMean(nest.frame);
    const nestWhite = whiteFrac(nest.frame);
    // At the defaults most of the picture is NOT blown out.
    expect(nestWhite).toBeLessThan(0.55);

    for (const hot of [
      { luma: 2 },
      { feedback: BACKDRAFT_MAX_FEEDBACK },
      { feedback: BACKDRAFT_MAX_FEEDBACK, luma: 2 },
    ]) {
      const r = simulateBackdraftTv({ size: 96, frames: 200, ...hot });
      expect(whiteFrac(r.frame), `${JSON.stringify(hot)} whites out`)
        .toBeGreaterThan(0.7);
      expect(tvFrameMean(r.frame)).toBeGreaterThan(nestMean);
    }

    // RECOVERABLE: starting from a fully white frame, the DEFAULT settings
    // return to the ordinary nest — the shoulder + bounded room mean an
    // over-drive is a place you can come back from, not a wedge.
    const back = simulateBackdraftTv({ size: 96, frames: 260, seed: 1 });
    expect(back.lastDelta).toBeLessThan(1e-6);
    expect(Math.abs(tvFrameMean(back.frame) - nestMean)).toBeLessThan(0.02);
  }, 30_000);

  it('N10 — the contract: new params + ports exist with the documented shape', () => {
    const p = (id: string) => backdraftDef.params.find((q) => q.id === id);
    expect(p('tvMode')?.curve).toBe('discrete');
    expect(p('tvMode')?.max).toBe(BACKDRAFT_TV_MODE_COUNT - 1);
    // tvMode + phosphor default to the EXACT-ZERO no-op.
    expect(p('tvMode')?.defaultValue).toBe(0);
    expect(p('phosphor')?.defaultValue).toBe(0);
    expect(p('room')?.defaultValue).toBe(1);
    expect(p('drive')?.defaultValue).toBe(0.5);
    const i = (id: string) => backdraftDef.inputs.find((q) => q.id === id);
    // The gate is RAW passthrough; the three continuous inputs carry cvScale.
    expect(i('tv_gate')?.cvScale).toBeUndefined();
    expect(i('tv_gate')?.paramTarget).toBe('tvGate');
    for (const id of ['room', 'phosphor', 'drive']) {
      expect(i(id)?.cvScale?.mode).toBe('linear');
    }
    // STRICT_DOCS: every new port and param documented, incl. the hidden gate.
    for (const id of ['tvMode', 'tvGate', 'room', 'bezel', 'phosphor', 'drive']) {
      expect(backdraftDef.docs?.controls?.[id]).toBeTruthy();
    }
    for (const id of ['tv_gate', 'room', 'phosphor', 'drive']) {
      expect(backdraftDef.docs?.inputs?.[id]).toBeTruthy();
    }
  });

  it('N10b — the TV MODE gate CYCLES off -> PURE TV -> CRITICAL -> off', () => {
    expect(backdraftNextTvMode(0)).toBe(1);
    expect(backdraftNextTvMode(1)).toBe(2);
    expect(backdraftNextTvMode(2)).toBe(0);
  });

  it('N-ZOOM — the fill remap is monotone and hits its documented anchors', () => {
    expect(backdraftTvFill(1)).toBeCloseTo(BACKDRAFT_TV_FILL_DEFAULT, 9);
    expect(backdraftTvFill(BACKDRAFT_ZOOM_MIN)).toBeCloseTo(BACKDRAFT_TV_FILL_MIN, 9);
    expect(backdraftTvFill(BACKDRAFT_ZOOM_MAX)).toBeCloseTo(BACKDRAFT_TV_FILL_MAX, 9);
    let prev = -1;
    for (let z = BACKDRAFT_ZOOM_MIN; z <= BACKDRAFT_ZOOM_MAX + 1e-9; z += 0.02) {
      const f = backdraftTvFill(z);
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
  });

  it('N-BEZEL — the border fader reaches 0 px, with the shipped look mid-travel', () => {
    // The set's border is a real thickness control: exactly 0 at the bottom (a
    // borderless screen) and the shipped appearance at the CENTRE of travel, so
    // it opens both thinner and thicker than the default.
    expect(backdraftTvBezel(0)).toBe(0);
    expect(backdraftTvBezel(1)).toBeCloseTo(BACKDRAFT_TV_BEZEL_MAX, 9);
    expect(BACKDRAFT_TV_BEZEL_MIN).toBe(0);
    const mid = backdraftTvBezel(0.5);
    expect(mid).toBeGreaterThan(backdraftTvBezel(0.25));
    expect(mid).toBeLessThan(backdraftTvBezel(0.75));
    // The default sits at that centre.
    expect(backdraftDef.params.find((p) => p.id === 'bezel')?.defaultValue).toBe(0.5);

    // And state the TRADE rather than hiding it: the bezel is the only
    // high-contrast boundary between level k and level k+1, so at 0 the nest
    // stops reading as frames-within-frames and becomes a smooth zoom. That is
    // now reachable ON PURPOSE, so it is asserted rather than prevented.
    const bare = simulateBackdraftTv({ size: 320, frames: 80, bezel: 0 });
    const framed = simulateBackdraftTv({ size: 320, frames: 80, bezel: 0.5 });
    expect(tvBands(bare).length).toBeLessThan(tvBands(framed).length);
    expect(tvBands(framed).length).toBeGreaterThanOrEqual(5);
  }, 30_000);
});

describe('BACKDRAFT — the VIRTUAL REFRESH (the seam that cascades)', () => {
  it('R1 — FLICKER OFF is the exact no-op: no beam, no seam, nothing changes', () => {
    // The refresh must be gated as hard as FLICKER itself. At OFF the shader
    // skips the branch entirely and the tap is bit-identical.
    expect(backdraftTvBeam(0, 0)).toBe(1);
    expect(backdraftTvRefreshMix(0.5, 1)).toBe(1);   // every row is the new field
    const a = simulateBackdraftTv({ size: 96, frames: 60, flicker: 0 });
    const b = simulateBackdraftTv({ size: 96, frames: 60 });
    for (let i = 0; i < a.frame.length; i++) expect(a.frame[i]).toBe(b.frame[i]);
  }, 30_000);

  it('R2 — the beam SWEEPS, and its crawl rate is FLICKER\'s beat', () => {
    // The beam position is the fractional part of the emission phase, so it
    // inherits the beat for free: 59.94 Hz creeps (the classic slow hum bar),
    // 6 Hz races down the frame several times a second.
    for (let f = 1; f < BACKDRAFT_FLICKER_COUNT; f++) {
      const seen = new Set<string>();
      for (let n = 0; n < 60; n++) {
        const b = backdraftTvBeam(f, n / BACKDRAFT_FPS);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThan(1.0000001);
        seen.add(b.toFixed(3));
      }
      // It must actually MOVE — a static beam is a static seam, which is the
      // whole defect this replaces.
      expect(seen.size, `FLICKER position ${f} beam must sweep`).toBeGreaterThan(3);
    }
    // The 60 position is the NTSC field rate, so its beam crawls far more
    // slowly than the 6 Hz one over the same window.
    const spread = (f: number): number => {
      const v: number[] = [];
      for (let n = 0; n < 30; n++) v.push(backdraftTvBeam(f, n / BACKDRAFT_FPS));
      let d = 0;
      for (let i = 1; i < v.length; i++) d += Math.abs(v[i]! - v[i - 1]!);
      return d;
    };
    expect(spread(4)).toBeLessThan(spread(1));
  });

  it('R3 — the row mix is a real SEAM: new above the beam, old below', () => {
    const beam = 0.5;
    expect(backdraftTvRefreshMix(0.1, beam)).toBeGreaterThan(0.99);   // above → new
    expect(backdraftTvRefreshMix(0.9, beam)).toBeLessThan(0.01);      // below → old
    expect(backdraftTvRefreshMix(beam, beam)).toBeCloseTo(0.5, 3);    // on the beam
    // Monotone, and soft over a few lines rather than a hard cut.
    let prev = 2;
    for (let y = 0; y <= 1; y += 0.01) {
      const m = backdraftTvRefreshMix(y, beam);
      expect(m).toBeLessThanOrEqual(prev + 1e-9);
      prev = m;
    }
    expect(backdraftTvRefreshMix(beam - 2 * BACKDRAFT_TV_BEAM_SOFT, beam)).toBeGreaterThan(0.99);
    expect(backdraftTvRefreshMix(beam + 2 * BACKDRAFT_TV_BEAM_SOFT, beam)).toBeLessThan(0.01);
  });

  it('R4 — the refresh makes rows carry DIFFERENT AGES, not just different gain', () => {
    // THE distinction from FLICKER. Flicker scales a row's BRIGHTNESS; the
    // refresh makes the row come from a different FRAME. Isolated with the
    // `refresh` control so flicker's gain band is identical on both sides —
    // comparing flicker-on against flicker-off could attribute nothing, because
    // flicker changes brightness everywhere.
    //
    // Causal test: drive a MOVING room, so successive frames genuinely differ.
    // With the seam, rows below the beam show an OLDER field, so the output
    // differs from the no-seam run in a ROW-DEPENDENT way.
    const moving = (u: number, v: number): [number, number, number] => {
      const t = v > 0.5 ? 0.9 : 0.2;
      return [t, t, t];
    };
    const on = simulateBackdraftTv({ size: 96, frames: 45, flicker: 1, refresh: true, source: moving });
    const off = simulateBackdraftTv({ size: 96, frames: 45, flicker: 1, refresh: false, source: moving });
    const { width: W, height: H } = on;
    const rowDiff = (y: number): number => {
      let d = 0;
      for (let x = 0; x < W; x++) d += Math.abs(on.frame[(y * W + x) * 3]! - off.frame[(y * W + x) * 3]!);
      return d / W;
    };
    const per: number[] = [];
    for (let y = 2; y < H - 2; y++) per.push(rowDiff(y));
    // The refresh must actually change the picture…
    expect(Math.max(...per)).toBeGreaterThan(0.01);
    // …and it must do so UNEVENLY down the frame — that unevenness IS the seam.
    // A gain band would scale rows smoothly; a seam concentrates the change.
    const mean = per.reduce((a, b) => a + b, 0) / per.length;
    expect(Math.max(...per)).toBeGreaterThan(3 * mean);
  }, 60_000);

  it('R5 — the seam CASCADES: the change lands in SEVERAL bands, not one cut', () => {
    // The reason the seam is positioned in the MONITOR's raster and not in
    // screen space. A screen-space seam is ONE straight line across the whole
    // frame; a raster-space seam is re-imaged by every pass, so level k inherits
    // the seams of every shallower level at s^k spacing and the nest fills with
    // them.
    //
    // Isolate the refresh, then count DISJOINT BANDS of change down the centre
    // column. One band = a single cut (no cascade). Several = the cascade.
    const opts = { size: 192, frames: 70, flicker: 1, room: 1 } as const;
    const on = simulateBackdraftTv({ ...opts, refresh: true });
    const off = simulateBackdraftTv({ ...opts, refresh: false });
    const { width: W, height: H } = on;
    const col = Math.floor(W / 2);
    const d: number[] = [];
    for (let y = 0; y < H; y++) {
      d.push(Math.abs(on.frame[(y * W + col) * 3]! - off.frame[(y * W + col) * 3]!));
    }
    const thresh = Math.max(...d) * 0.25;
    expect(Math.max(...d)).toBeGreaterThan(0.01);
    let bands = 0, inBand = false;
    for (const v of d) {
      if (v > thresh && !inBand) { bands++; inBand = true; }
      else if (v <= thresh) inBand = false;
    }
    expect(bands, `disjoint seam bands down the centre column (got ${bands})`)
      .toBeGreaterThanOrEqual(2);
  }, 60_000);
});

describe('BACKDRAFT — VIRTUAL CAMERA ORIENTATION', () => {
  /** Apply a row-major inverse homography to a camera-frame point. */
  function apply(H: number[], qx: number, qy: number): { x: number; y: number; z: number } {
    const z = H[6]! * qx + H[7]! * qy + H[8]!;
    return { x: (H[0]! * qx + H[1]! * qy + H[2]!) / z, y: (H[3]! * qx + H[4]! * qy + H[5]!) / z, z };
  }

  it('V1 — DEAD-ON is EXACTLY the old affine map, at every distance', () => {
    // The whole default path depends on this: if the homography does not
    // degenerate algebraically, every N-series assertion about the shipped look
    // is quietly measuring a different map. Distance must drop out entirely
    // when the camera is square-on.
    for (const fill of [0.35, 0.75, 0.95]) {
      for (const rotateDeg of [0, 25, -140]) {
        for (const dist of [0, 0.5, 1]) {
          const H = backdraftCamInverseHomography({ dist }, fill, rotateDeg);
          const th = (rotateDeg * Math.PI) / 180;
          const cs = Math.cos(th), sn = Math.sin(th);
          for (const [qx, qy] of [[0, 0], [0.3, -0.2], [-0.45, 0.5], [0.6, 0.6]]) {
            const got = apply(H, qx!, qy!);
            // The old inverse: p = R(-phi) * q / s
            const wantX = (qx! * cs + qy! * sn) / fill;
            const wantY = (-qx! * sn + qy! * cs) / fill;
            expect(got.x).toBeCloseTo(wantX, 9);
            expect(got.y).toBeCloseTo(wantY, 9);
          }
        }
      }
    }
  });

  it('V2 — tilt KEYSTONES: a rectangle images as a trapezoid', () => {
    // Off-axis, the two vertical edges of the screen subtend different heights.
    // That difference IS the keystone, and it is what makes the nest curl.
    const H = backdraftCamInverseHomography({ tiltX: BACKDRAFT_CAM_TILT_RANGE, dist: 0 }, 0.75, 0);
    // Walk the left and right thirds of the frame and compare how much screen
    // plane each unit of camera frame covers.
    const spanAt = (qx: number): number =>
      Math.abs(apply(H, qx, 0.4).y - apply(H, qx, -0.4).y);
    const left = spanAt(-0.4), right = spanAt(0.4);
    expect(Math.abs(left - right) / Math.max(left, right)).toBeGreaterThan(0.05);
    // …and with NO tilt the same measurement is symmetric.
    const flat = backdraftCamInverseHomography({ dist: 0.2 }, 0.75, 0);
    const fl = Math.abs(apply(flat, -0.4, 0.4).y - apply(flat, -0.4, -0.4).y);
    const fr = Math.abs(apply(flat, 0.4, 0.4).y - apply(flat, 0.4, -0.4).y);
    expect(Math.abs(fl - fr)).toBeLessThan(1e-9);
  });

  it('V3 — DIST sets how hard a given tilt keystones', () => {
    // The fader's whole job. Short distance = wide angle = violent keystone;
    // long = telephoto = gentle. Same tilt on both sides.
    const asym = (dist: number): number => {
      const H = backdraftCamInverseHomography({ tiltX: BACKDRAFT_CAM_TILT_RANGE, dist }, 0.75, 0);
      const span = (qx: number): number => Math.abs(apply(H, qx, 0.4).y - apply(H, qx, -0.4).y);
      const l = span(-0.4), r = span(0.4);
      return Math.abs(l - r) / Math.max(l, r);
    };
    expect(asym(0)).toBeGreaterThan(asym(1));
  });

  it('V4 — camera POSITION moves the view without bending it', () => {
    // Translation alone is a shift, not a keystone — the bend comes from TILT.
    // Combining them is how you look at the set from above and off to one side.
    const H = backdraftCamInverseHomography({ posX: BACKDRAFT_CAM_POS_RANGE, posY: -BACKDRAFT_CAM_POS_RANGE, dist: 0.5 }, 0.75, 0);
    const centre = apply(H, 0, 0);
    expect(Math.hypot(centre.x, centre.y)).toBeGreaterThan(0.1);
    const span = (qx: number): number => Math.abs(apply(H, qx, 0.4).y - apply(H, qx, -0.4).y);
    expect(Math.abs(span(-0.4) - span(0.4))).toBeLessThan(1e-9);
  });

  it('V5 — the DIST law is geometric and monotone', () => {
    expect(backdraftCamDistance(0)).toBeCloseTo(BACKDRAFT_CAM_DIST_MIN, 9);
    expect(backdraftCamDistance(1)).toBeCloseTo(BACKDRAFT_CAM_DIST_MAX, 9);
    expect(backdraftCamDistance(0.5))
      .toBeCloseTo(Math.sqrt(BACKDRAFT_CAM_DIST_MIN * BACKDRAFT_CAM_DIST_MAX), 9);
    let prev = -1;
    for (let d = 0; d <= 1 + 1e-9; d += 0.02) {
      const v = backdraftCamDistance(d);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it('V6 — never returns a non-finite map, over the whole reachable product', () => {
    // Edge-on is singular; the model must fall back to the dead-on affine
    // inverse rather than emitting NaNs into the shader.
    for (const tiltX of [-1, -0.5, 0, 0.5, 1]) {
      for (const tiltY of [-1, 0, 1]) {
        for (const posX of [-1, 0, 1]) {
          for (const posY of [-1, 1]) {
            for (const dist of [0, 1]) {
              for (const fill of [0.35, 0.95]) {
                const H = backdraftCamInverseHomography(
                  { tiltX, tiltY, posX, posY, dist }, fill, 0,
                );
                expect(H).toHaveLength(9);
                for (const v of H) expect(Number.isFinite(v)).toBe(true);
              }
            }
          }
        }
      }
    }
    expect(BACKDRAFT_CAM_TILT_MAX_DEG).toBeLessThan(90);
  });

  it('V9 — moving the camera MOVES the nest\'s vanishing point', () => {
    // The accumulation point of the frame-in-frame-in-frame IS the fixed point
    // of the map, so re-aiming the camera re-composes the whole nest rather
    // than just sliding the picture — and because the map is ITERATED, that
    // move then recurses through the network one level per DELAY, exactly as
    // room motion and the refresh seam do.
    //
    // Fixed points of a projective map are its eigenvectors; power-iterating
    // the inverse homography converges to the dominant one, which is the point
    // the nest accumulates on.
    const vanishing = (o: Parameters<typeof backdraftCamInverseHomography>[0]): { x: number; y: number } => {
      // Hi is the INVERSE map, which EXPANDS away from the accumulation point,
      // so power-iterating it converges to the vanishing DIRECTION (z -> 0)
      // rather than the point we want. Invert it to get the forward map, which
      // contracts onto the accumulation point, and iterate that instead.
      const M = backdraftCamInverseHomography(o, 0.75, 0);
      const [a, b, c, d, e, f, g, h, i2] = M as unknown as number[];
      const A = e! * i2! - f! * h!, B = -(d! * i2! - f! * g!), C = d! * h! - e! * g!;
      const det = a! * A + b! * B + c! * C;
      const iv = 1 / det;
      const H = [
        A * iv, (c! * h! - b! * i2!) * iv, (b! * f! - c! * e!) * iv,
        B * iv, (a! * i2! - c! * g!) * iv, (c! * d! - a! * f!) * iv,
        C * iv, (b! * g! - a! * h!) * iv, (a! * e! - b! * d!) * iv,
      ];
      let v = [0.37, 0.21, 1];
      for (let i = 0; i < 400; i++) {
        const n = [
          H[0]! * v[0]! + H[1]! * v[1]! + H[2]! * v[2]!,
          H[3]! * v[0]! + H[4]! * v[1]! + H[5]! * v[2]!,
          H[6]! * v[0]! + H[7]! * v[1]! + H[8]! * v[2]!,
        ];
        const m = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
        v = [n[0]! / m, n[1]! / m, n[2]! / m];
      }
      return { x: v[0]! / v[2]!, y: v[1]! / v[2]! };
    };

    // Dead-on, the nest accumulates dead centre.
    const centre = vanishing({});
    expect(Math.hypot(centre.x, centre.y)).toBeLessThan(1e-6);

    // Re-aiming moves it — that is the re-composition.
    const tilted = vanishing({ tiltX: BACKDRAFT_CAM_TILT_RANGE, dist: 0 });
    expect(Math.hypot(tilted.x - centre.x, tilted.y - centre.y)).toBeGreaterThan(0.05);
    const shifted = vanishing({ posX: BACKDRAFT_CAM_POS_RANGE, posY: -BACKDRAFT_CAM_POS_RANGE });
    expect(Math.hypot(shifted.x - centre.x, shifted.y - centre.y)).toBeGreaterThan(0.05);

    // …and it TRACKS the control: every tilt gives its own framing, so a CV
    // ramp sweeps the composition instead of snapping between a few of them.
    // NOT asserted as monotone in distance — at short camera distances the
    // vanishing point starts far off-frame and comes CLOSER as tilt grows,
    // which is correct and was worth measuring rather than assuming.
    const seen: { x: number; y: number }[] = [];
    // Inside the joystick's own (constrained) travel — beyond +-0.2 the model
    // clamps, so sampling past it would compare identical framings.
    for (const t of [0.04, 0.08, 0.12, 0.16, 0.2]) {
      seen.push(vanishing({ tiltX: t, dist: 0.5 }));
    }
    for (let i = 1; i < seen.length; i++) {
      const d = Math.hypot(seen[i]!.x - seen[i - 1]!.x, seen[i]!.y - seen[i - 1]!.y);
      expect(d, `tilt step ${i} re-composes the nest`).toBeGreaterThan(1e-3);
    }
  });

  it('V7 — the contract: 5 params + 5 CV ports, all neutral by default', () => {
    const p = (id: string) => backdraftDef.params.find((q) => q.id === id);
    // Constrained travel: the keystone compounds, so the joysticks stop where
    // the nest is still readable.
    for (const id of ['camTiltX', 'camTiltY']) {
      expect(p(id)?.min).toBe(-BACKDRAFT_CAM_TILT_RANGE);
      expect(p(id)?.max).toBe(BACKDRAFT_CAM_TILT_RANGE);
      expect(p(id)?.defaultValue, `${id} is neutral by default`).toBe(0);
    }
    for (const id of ['camPosX', 'camPosY']) {
      expect(p(id)?.min).toBe(-BACKDRAFT_CAM_POS_RANGE);
      expect(p(id)?.max).toBe(BACKDRAFT_CAM_POS_RANGE);
      expect(p(id)?.defaultValue, `${id} is neutral by default`).toBe(0);
    }
    expect(p('camDist')?.defaultValue).toBe(0.5);
    for (const id of ['cam_tilt_x', 'cam_tilt_y', 'cam_pos_x', 'cam_pos_y', 'cam_dist']) {
      const i = backdraftDef.inputs.find((q) => q.id === id);
      expect(i?.cvScale?.mode, `${id} is CV-able`).toBe('linear');
      expect(backdraftDef.docs?.inputs?.[id]).toBeTruthy();
    }
    for (const id of ['camTiltX', 'camTiltY', 'camPosX', 'camPosY', 'camDist']) {
      expect(backdraftDef.docs?.controls?.[id]).toBeTruthy();
    }
  });

  it('V10 — the joystick BOUNDS live on the DEF, so a pad cannot widen them', () => {
    // ⚠ THIS READ THE CARD SOURCE, and the bug it was written for is worth
    // keeping in front of a reader: the def was constrained to +-0.2 / +-0.5
    // while the card still passed `xMin={-1} xMax={1}` to both XyPads, so the
    // UI showed — and WROTE — values the contract forbids. Nothing caught it,
    // because the def tests read the def and the e2e never touched the pads.
    //
    // The surviving pad is the shell's ONE `xy` cell, which takes its bounds
    // from the ParamDef, so a re-typed literal has nowhere to live. What is
    // asserted instead is the half that made the card's literals wrong: the
    // params really are constrained to the exported constants, so any renderer
    // reading the def is inside the contract by construction.
    for (const id of ['camTiltX', 'camTiltY'] as const) {
      const p = backdraftDef.params.find((q) => q.id === id)!;
      expect(p.min, `${id} min`).toBe(-BACKDRAFT_CAM_TILT_RANGE);
      expect(p.max, `${id} max`).toBe(BACKDRAFT_CAM_TILT_RANGE);
    }
    for (const id of ['camPosX', 'camPosY'] as const) {
      const p = backdraftDef.params.find((q) => q.id === id)!;
      expect(p.min, `${id} min`).toBe(-BACKDRAFT_CAM_POS_RANGE);
      expect(p.max, `${id} max`).toBe(BACKDRAFT_CAM_POS_RANGE);
    }
    // …and the constants really are narrower than the unit range the card used
    // to pass, so this is a bound and not a restatement of +-1.
    expect(BACKDRAFT_CAM_TILT_RANGE).toBeLessThan(1);
    expect(BACKDRAFT_CAM_POS_RANGE).toBeLessThan(1);
  });

  it('V8 — the faceplate calls mode 1 VIRTUAL CAMERA', () => {
    expect(BACKDRAFT_TV_MODE_LABELS[1]).toBe('VIRTUAL CAMERA');
  });
});

describe('BACKDRAFT — GL resource discipline', () => {
  it('N11 — the texture-unit map is DISJOINT (a collision here is silent)', () => {
    // The servo's two passes run in the MIDDLE of the main composite's draw,
    // after its sampler uniforms are bound and before its drawFullscreenQuad.
    // Any unit they share with the main program is silently swapped out from
    // under it — which really happened: the servo first used units 0/1 and
    // quietly replaced the live IN A / IN B source with the reduce input. That
    // presents as a wrong-looking ROOM, never as an error, so it needs a gate.
    const units = Object.values(BACKDRAFT_TEXTURE_UNITS);
    expect(new Set(units).size, 'every texture unit is used exactly once').toBe(units.length);
    for (const u of units) {
      expect(Number.isInteger(u)).toBe(true);
      // WebGL2 guarantees at least 16 combined units; stay well inside that.
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(16);
    }
    // The servo passes must sit ABOVE everything the main composite binds.
    const mainMax = Math.max(
      BACKDRAFT_TEXTURE_UNITS.a, BACKDRAFT_TEXTURE_UNITS.b, BACKDRAFT_TEXTURE_UNITS.fb,
      BACKDRAFT_TEXTURE_UNITS.lighten, BACKDRAFT_TEXTURE_UNITS.darken,
      BACKDRAFT_TEXTURE_UNITS.persist, BACKDRAFT_TEXTURE_UNITS.agcState,
      BACKDRAFT_TEXTURE_UNITS.fbPrev,
    );
    expect(BACKDRAFT_TEXTURE_UNITS.agcReduceSrc).toBeGreaterThan(mainMax);
    expect(BACKDRAFT_TEXTURE_UNITS.agcPrevState).toBeGreaterThan(mainMax);
  });
});

describe('BACKDRAFT CRITICAL — the auto-exposure servo', () => {
  /** Late-window frame-mean swing, and the worst ODD-lag decorrelation.
   *
   *  The lag MUST be odd. Pearson correlation is invariant to a global affine
   *  change, so a period-2 limit cycle sampled at an EVEN lag reads as
   *  corr = 1.0 exactly and the assertion would silently measure nothing —
   *  which is precisely how an earlier pass of this work concluded, wrongly,
   *  that the servo did not oscillate.
   *
   *  The window is LATE (frames 390-420) so a still-BUILDING nest cannot be
   *  mistaken for an evolving one, and the noise floor is OFF so nothing here
   *  can be manufactured by noise. */
  function critProbe(o: Record<string, unknown>): { swing: number; d1: number } {
    const means: number[] = [];
    const frames: Float32Array[] = [];
    simulateBackdraftTv({
      size: 64, frames: 420, noise: 0,
      onFrame: (n: number, f: Float32Array) => {
        if (n < 390) return;
        means.push(tvFrameMean(f));
        frames.push(f.slice());
      },
      ...o,
    } as never);
    let d1 = 0;
    for (let i = 1; i < frames.length; i++) {
      d1 = Math.max(d1, 1 - tvCorr(frames[i - 1]!, frames[i]!));
    }
    return { swing: Math.max(...means) - Math.min(...means), d1 };
  }

  it('C1 — past the DRIVE midpoint the picture EVOLVES, with the noise floor OFF', () => {
    const hot = critProbe({ critical: true, drive: 0.75 });
    expect(hot.swing).toBeGreaterThan(0.05);
    expect(hot.d1).toBeGreaterThan(0.05);
  }, 30_000);

  it('C2 — NEGATIVE CONTROL: below the midpoint, and in PURE TV, it is DEAD STILL', () => {
    // If any of these ever goes non-zero then C1 is measuring something other
    // than the servo's limit cycle and proves nothing. Below the bifurcation
    // both metrics are EXACTLY zero, so the separation is not a ratio over a
    // noise floor — there is no floor.
    for (const o of [
      { critical: true, drive: 0.25 },                        // servo present, under the Hopf point
      { critical: true, drive: 0.0 },
      { critical: false },                                    // servo absent entirely
      { critical: false },
    ]) {
      const r = critProbe(o);
      expect(r.swing).toBeLessThan(1e-4);
      expect(r.d1).toBeLessThan(1e-4);
    }
  }, 30_000);

  it('C3 — the swing DEEPENS monotonically with DRIVE (it is rideable)', () => {
    const a = critProbe({ critical: true, drive: 0.6 });
    const b = critProbe({ critical: true, drive: 1.0 });
    expect(b.swing).toBeGreaterThan(a.swing);
  }, 30_000);

  it('C4 — RECOVERABILITY: driven to FULL WHITE it returns to the same attractor', () => {
    // The safety property that REPLACES stability in CRITICAL. A white-out must
    // never wedge the module, need a reload, or persist a broken state.
    for (const o of [{ critical: true, drive: 0.1 }, {}]) {
      const cold = simulateBackdraftTv({ size: 64, frames: 400, noise: 0, ...o } as never);
      const white = simulateBackdraftTv({ size: 64, frames: 400, noise: 0, seed: 1, ...o } as never);
      expect(white.lastDelta).toBeLessThan(1e-6);
      expect(tvCorr(white.frame, cold.frame)).toBeGreaterThan(0.999);
      expect(Number.isFinite(white.agc)).toBe(true);
    }
  }, 30_000);

  it('C5 — the servo state is BOUNDED, which is what makes C4 true', () => {
    for (const drive of [0, 0.5, 1]) {
      for (const room of [1, 0.15]) {
        const r = simulateBackdraftTv({
          size: 48, frames: 200, critical: true, drive, room, noise: 0,
        });
        expect(r.agc).toBeGreaterThanOrEqual(BACKDRAFT_TV_AGC_MIN - 1e-9);
        expect(r.agc).toBeLessThanOrEqual(BACKDRAFT_TV_AGC_MAX + 1e-9);
      }
    }
    // A single step cannot escape the clamp either, however wild the input —
    // including a NaN frame mean, which must not be able to poison the state.
    for (const mean of [0, 1e-9, 1e9, Number.NaN]) {
      const a = backdraftTvAgcStep(1, mean, 49);
      expect(a).toBeGreaterThanOrEqual(BACKDRAFT_TV_AGC_MIN);
      expect(a).toBeLessThanOrEqual(BACKDRAFT_TV_AGC_MAX);
    }
  }, 30_000);

  it('C6 — the DRIVE law is geometric, monotone, and centred on the Hopf point', () => {
    expect(backdraftTvAgcRate(0)).toBeCloseTo(BACKDRAFT_TV_AGC_RATE_MIN, 9);
    expect(backdraftTvAgcRate(1)).toBeCloseTo(BACKDRAFT_TV_AGC_RATE_MAX, 9);
    // Geometric => the midpoint is the GEOMETRIC mean, which is the measured
    // bifurcation (rate ~7). Equal knob steps are equal FACTORS, which is the
    // right shape for a scale-free time constant and makes a linear CV ramp
    // read as a smooth accelerando into instability rather than a cliff.
    const mid = backdraftTvAgcRate(0.5);
    expect(mid).toBeCloseTo(Math.sqrt(BACKDRAFT_TV_AGC_RATE_MIN * BACKDRAFT_TV_AGC_RATE_MAX), 9);
    const q = backdraftTvAgcRate(0.25), t = backdraftTvAgcRate(0.75);
    expect(mid / q).toBeCloseTo(t / mid, 6);
    let prev = -1;
    for (let d = 0; d <= 1 + 1e-9; d += 0.01) {
      const r = backdraftTvAgcRate(d);
      expect(r).toBeGreaterThan(prev);
      prev = r;
    }
  });

  it('C7 — the servo keeps authority at LOW ROOM (the set point is room-relative)', () => {
    // With an ABSOLUTE set point the servo cannot reach target in a dim room,
    // rails at AGC_MAX and the limit cycle dies — measured, room 0.4 killed it
    // stone dead. A real auto-exposure meters the scene it is actually in.
    const dim = critProbe({ critical: true, drive: 0.8, room: 0.4 });
    expect(dim.swing).toBeGreaterThan(0.02);
  }, 30_000);
});
