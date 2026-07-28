// packages/web/src/lib/video/modules/backdraft-tv.test.ts
//
// BACKDRAFT PURE TV + CRITICAL — the bounded-screen (Crutchfield) mode.
//
// The whole feature is a GEOMETRIC claim ("each recursing image is shown only
// inside the boundaries of the interior box"), and a shader cannot be
// unit-tested — so the claim is proven HERE, in the GL-free CPU mirror, and the
// e2e only has to show that the GPU renders the same thing.
// `toybox-feedback.ts` (tunnelTap / simulateTunnel) is the precedent.

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
  BACKDRAFT_TV_GAIN_MAX,
  BACKDRAFT_TV_FILL_MIN,
  BACKDRAFT_TV_FILL_DEFAULT,
  BACKDRAFT_TV_FILL_MAX,
  BACKDRAFT_TV_BEZEL_MIN,
  BACKDRAFT_TV_BEZEL_MAX,
  BACKDRAFT_TV_MODE_COUNT,
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
    const r = simulateBackdraftTv({ size: 384, frames: 90, quantize: true });
    const bands = tvBands(r);
    // A real nest, not a smeared grey field: several resolved frames-in-frames.
    expect(bands.length).toBeGreaterThanOrEqual(6);
    const s = backdraftTvFill(1);
    for (let i = 1; i < Math.min(bands.length, 7); i++) {
      expect(bands[i - 1]! / bands[i]!).toBeGreaterThan(s - 0.05);
      expect(bands[i - 1]! / bands[i]!).toBeLessThan(s + 0.05);
    }
  });

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
  });

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
    for (const room of [1.0, 0.5, 0.3, 0.15]) {
      const r = simulateBackdraftTv({ size: 384, frames: 90, room });
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
  });

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
  });

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
                  expect(t.tapU).toBeGreaterThanOrEqual(0);
                  expect(t.tapU).toBeLessThanOrEqual(1);
                  expect(t.tapV).toBeGreaterThanOrEqual(0);
                  expect(t.tapV).toBeLessThanOrEqual(1);
                  inside++;
                }
              }
            }
          }
        }
      }
    }
    expect(inside).toBeGreaterThan(5000);
  });
});

describe('BACKDRAFT PURE TV — the contraction contract', () => {
  it('N7 — opNorm * gEff never exceeds the ceiling, over the FULL knob product', () => {
    // The colour chain multiplies the tap BEFORE the gain and every one of its
    // knobs reaches 2.0, so clamping g alone lets LUMA >= 1.18 pin the interior
    // to white and delete the nest. Clamping the OPERATOR NORM is what makes
    // the map a strict contraction for every reachable combination.
    for (const luma of [-1, 0, 1, 1.2, 2]) {
      for (const ch of [-1, 1, 1.3, 2]) {
        for (const chroma of [-1, 0, 1, 2]) {
          for (const feedback of [0, 0.85, 2]) {
            for (const effectScale of [0, 1, BACKDRAFT_MAX_EFFECT_SCALE]) {
              const opNorm = backdraftTvOpNorm({ r: ch, g: ch, b: ch, luma, chroma });
              const gEff = backdraftTvGain(opNorm, feedback, effectScale);
              expect(opNorm * gEff).toBeLessThanOrEqual(BACKDRAFT_TV_GAIN_MAX + 1e-6);
            }
          }
        }
      }
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

  it('N7c — PURE TV converges to a STILL image even at maximum FEEDBACK', () => {
    const r = simulateBackdraftTv({
      size: 96, frames: 260, feedback: BACKDRAFT_MAX_FEEDBACK, luma: 2, chroma: 2,
    });
    expect(r.lastDelta).toBeLessThan(1e-6);
    expect(tvFrameMean(r.frame)).toBeLessThan(0.99);   // and does not pin white
  });

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

  it('N-BEZEL — the BEZEL fader is FLOORED so its minimum cannot delete the nest', () => {
    expect(backdraftTvBezel(0)).toBe(BACKDRAFT_TV_BEZEL_MIN);
    expect(backdraftTvBezel(1)).toBeCloseTo(BACKDRAFT_TV_BEZEL_MAX, 9);
    expect(BACKDRAFT_TV_BEZEL_MIN).toBeGreaterThan(0);
    // A fader whose minimum deletes the feature would be a bug: bezel = 0 must
    // still resolve a real nest rather than collapsing to one band.
    const r = simulateBackdraftTv({ size: 384, frames: 90, bezel: 0 });
    expect(tvBands(r).length).toBeGreaterThanOrEqual(4);
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
  });

  it('C2 — NEGATIVE CONTROL: below the midpoint, and in PURE TV, it is DEAD STILL', () => {
    // If any of these ever goes non-zero then C1 is measuring something other
    // than the servo's limit cycle and proves nothing. Below the bifurcation
    // both metrics are EXACTLY zero, so the separation is not a ratio over a
    // noise floor — there is no floor.
    for (const o of [
      { critical: true, drive: 0.25 },                        // servo present, under the Hopf point
      { critical: true, drive: 0.0 },
      { critical: false },                                    // servo absent entirely
      { critical: false, feedback: BACKDRAFT_MAX_FEEDBACK },  // contraction holds at max FB
    ]) {
      const r = critProbe(o);
      expect(r.swing).toBeLessThan(1e-4);
      expect(r.d1).toBeLessThan(1e-4);
    }
  });

  it('C3 — the swing DEEPENS monotonically with DRIVE (it is rideable)', () => {
    const a = critProbe({ critical: true, drive: 0.6 });
    const b = critProbe({ critical: true, drive: 1.0 });
    expect(b.swing).toBeGreaterThan(a.swing);
  });

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
  });

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
  });

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
  });
});
