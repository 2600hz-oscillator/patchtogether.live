// e2e/_helpers/glsl-claim.ts
//
// MEASURE A GLSL-DELIVERED VALUE AGAINST A DEF CLAIM.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// The audio side can verify a def's claims in node: a worklet ENTRY file is
// captured through a `registerProcessor` shim, driven with synthetic input, and
// the rendered samples are compared against the number the def or the docs
// promise. There has been no equivalent for anything a FRAGMENT SHADER
// delivers, and the gap is not cosmetic — #1896 audited four video readout
// claims and had to label every one of them "VERIFIED IN SOURCE … nothing was
// rendered", because measuring them needs a GL context and a browser.
//
// The worked case, and this file's acceptance test: `b3ntb0x` declares
// `HUE_MAX_RAD = 0.9 * Math.PI` and multiplies the Hue control by it
// (`b3ntb0x.ts:504`), so the control's FULL travel is a 162° chroma rotation and
// 180° is unreachable. Its sibling `bentbox` multiplies an identically-labelled
// control by `TWO_PI`, so ITS ends both equal its centre. Two controls, one
// label, opposite geometry — and reading the source is how you form that
// hypothesis, not how you confirm it.
//
// ── WHAT IT MEASURES ────────────────────────────────────────────────────────
//
// It reads a node's OUTPUT TEXTURE — the delivered pixels — and reduces them to
// a CIRCULAR MEAN HUE plus the saturation that says whether that hue means
// anything. Built ON TOP of the DRS determinism (`../tests/_render-smoke`):
// the engine's rAF loop is paused and its clock pinned, so a measurement is a
// fixed, owned number of frames rather than a race between three clocks. There
// is no `waitForTimeout` anywhere in this path and there must never be one:
// every wait here is a frame count the test itself drove.
//
// ── ⚠ WHAT IT IS STRUCTURALLY UNABLE TO SEE ─────────────────────────────────
//
// Stated inside the instrument, per CLAUDE.md, because a green measurement from
// a blind instrument reads exactly like a finding:
//
//  1. **The OUTPUT TEXTURE, not the screen.** Anything the compositor, the CSS
//     or the canvas presentation does after the node renders is invisible here.
//     A module that delivers correct pixels into a surface nobody paints
//     measures perfect.
//  2. **A STRIDE.** Pixels are sampled every `stride`th texel, so spatial detail
//     finer than the stride is not sampled at all. Fine for a field of one hue;
//     wrong for anything whose claim lives in a thin feature. `sampledPixels` is
//     always reported so a caller can see how much was actually looked at.
//  3. **HUE IS MEANINGLESS BELOW A SATURATION FLOOR**, and near-grey pixels
//     produce a uniformly distributed angle — i.e. NOISE that averages to a
//     confident-looking number. So pixels below `minSat` are EXCLUDED, and
//     `qualifying` (how many survived) is returned rather than folded away. A
//     caller that does not assert on `qualifying` can be reading an average of
//     nothing. `assertMeasurable` exists to make that the default.
//  4. **"THE SHADER IGNORES THE UNIFORM" AND "THE EFFECT IS GENUINELY ZERO"
//     ARE THE SAME READING HERE** — both are "the pixels did not move". Only a
//     POSITIVE CONTROL separates them: a second measurement, on the same
//     instrument, at a setting that MUST move. Every spec using this file owes
//     one, and the acceptance spec carries both directions.
//  5. **8-BIT QUANTISATION.** The framebuffer is RGBA8, so hue resolution
//     degrades as saturation falls; at `minSat = 0.15` expect a degree or two of
//     spread. Assert tolerances in DEGREES and say so in the message.
//  6. **IT DOES NOT KNOW WHY.** It reports a delivered angle. Attributing that
//     angle to one uniform is the caller's argument, made by holding everything
//     else still — which is why the sweep helper changes exactly one param.
//
// ── RENDERER INDEPENDENCE, WHICH IS WHY THIS CAN GATE ON CI ─────────────────
//
// CI runs SwiftShader. The quantity measured here is SHADER ARITHMETIC (a
// rotation angle), not filtering, resampling or text — so it is renderer-stable
// in a way a pixel comparison is not. That is the whole reason a hue ANGLE is
// the right observable and a screenshot is not.

import { type Page, expect } from '@playwright/test';

/** One delivered-colour measurement, with its own receipts attached. */
export interface DeliveredColour {
  /** Circular mean hue of the qualifying pixels, DEGREES in [0, 360). */
  hueDeg: number;
  /** Mean saturation of the qualifying pixels, 0..1. */
  sat: number;
  /** Mean value/brightness of the qualifying pixels, 0..1. */
  val: number;
  /** Circular spread (0 = all identical, 1 = uniformly scattered) — a HIGH
   *  value means `hueDeg` is an average over disagreeing pixels and should not
   *  be trusted to a degree. */
  spread: number;
  /** Pixels that cleared `minSat`. ⚠ Assert on this: an average of zero
   *  qualifying pixels is not a measurement. */
  qualifying: number;
  /** Pixels looked at (before the saturation filter). */
  sampledPixels: number;
  /** Engine frames advanced — must equal the steps the caller drove. */
  framesDelta: number;
  glErrors: number[];
  fbComplete: boolean;
}

export interface ReadDeliveredOpts {
  nodeId: string;
  portId?: string;
  /** Frames to drive before reading. The loop is paused, so this is exact. */
  steps: number;
  /**
   * Sample every Nth pixel within the box (default **17**).
   *
   * ⚠ PRIME, AND DELIBERATELY CO-PRIME WITH THE ROW WIDTH — CLAUDE.md's
   * "sample at co-prime / irregular offsets when probing anything periodic".
   * The first subject of this harness is an NTSC simulator whose whole output
   * carries a SUBCARRIER: a stride that divides the row width (16, 32, 64 …)
   * samples the same phase of that carrier on every row and aliases the dot
   * crawl to a constant, which reads as a beautifully coherent field that is
   * partly an artefact of where we looked. 17 divides neither 256 nor the
   * frame width.
   */
  stride?: number;
  /** Saturation floor below which a pixel's hue is noise (default 0.15). */
  minSat?: number;
  /**
   * Read a CENTRED square of this many pixels a side (default 256), instead of
   * the whole frame.
   *
   * ⚠ TWO reasons, and the second is about correctness, not speed. (1) A full
   * 1280×720 `readPixels` moves 3.7 MB per measurement and a sweep does dozens.
   * (2) The EDGES ARE NOT THE PICTURE: b3ntb0x's overscan and barrel leave a
   * BLACK BORDER, and black pixels carry no hue at all. Measured on the same
   * input: reading the full frame qualifies 2274 of 3072 sampled pixels (74 % —
   * the rest are the unlit border), while the centred box qualifies 3856 of 3856
   * (100 %). Reading the centre is the more honest sample AND the cheaper one.
   * Pass a number ≥ the frame size to read everything.
   *
   * ⚠ WHAT IT DOES **NOT** DO, because the first draft of this comment claimed
   * it did and the measurement refuted it: cropping does NOT materially improve
   * the circular SPREAD. Same input, full frame vs centred box — 0.142 → 0.141
   * (red-ish) and 0.366 → 0.361 (green-ish). The large spread differences are
   * BETWEEN INPUT HUES, not between sampling regions: NTSC carries chroma near
   * the I/Q axes more coherently than chroma between them. Cropping buys
   * qualifying pixels and bytes, not coherence.
   */
  box?: number;
}

/**
 * Advance the video engine by exactly `n` frames, ONE PER JS TURN.
 *
 * ⚠ THE YIELD IS LOAD-BEARING AND THIS IS THE OPPOSITE OF WHAT DRS DOES.
 * `_render-smoke.ts` drives its whole burst inside a single `page.evaluate`
 * with no await, deliberately, so rAF/decode/blit cannot interleave. That is
 * right for its subjects and WRONG for a multi-pass float pipeline:
 *
 * MEASURED, b3ntb0x under `E2E_SWIFTSHADER=1` — 8 `step()` calls in ONE turn
 * leave the output BIT-EXACTLY BLACK (0 of 3856 sampled pixels above the
 * saturation floor), while the SAME 8 steps taken one per turn render a clean
 * field (3856 of 3856, hue 15.01°, spread 0.0178 — identical to the real GPU).
 * On a real GPU the single-turn form happens to work, so this is invisible
 * until something runs under software rendering.
 *
 * ⚠ CONSEQUENCE FOR THE EXISTING HARNESS, worth knowing before you copy it:
 * `b3ntb0x.spec.ts` uses the DRS single-turn form and therefore FAILS under
 * `E2E_SWIFTSHADER=1` today. It does not run there — `webgl-smoke` is
 * `--grep "@webgl-smoke"` and that spec carries no such tag — so nothing has
 * ever reported it.
 *
 * ⚠ AND IT COSTS NO DETERMINISM. Yielding would matter if the frame content
 * depended on elapsed time, but both clocks are PINNED (the engine's and the
 * module's own), so a frame is a pure function of the step index. What the
 * single turn actually bought was "no rAF frames sneak in" — and the rAF loop
 * is PAUSED, so there are none to sneak. The read itself stays atomic, which
 * is the part that has to be.
 */
async function stepFrames(page: Page, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine: () => { getDomain: (d: string) => { step: () => void } };
      };
      w.__engine().getDomain('video').step();
    });
  }
}

/**
 * Drive `steps` frames and reduce `nodeId`'s output texture to a circular mean
 * hue. The frames are driven one per turn (see `stepFrames`); the READ is a
 * single `page.evaluate` with no await inside, so nothing interleaves between
 * binding the framebuffer and reading the pixels back.
 */
export async function readDeliveredColour(
  page: Page,
  opts: ReadDeliveredOpts,
): Promise<DeliveredColour> {
  const before = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (d: string) => { currentFrameCount: () => number } };
    };
    return w.__engine().getDomain('video').currentFrameCount();
  });
  await stepFrames(page, opts.steps);

  return page.evaluate(
    ({ nodeId, portId, framesBefore, stride, minSat, box }) => {
      const w = globalThis as unknown as {
        __engine: () => {
          getDomain: (d: string) => {
            gl: WebGL2RenderingContext;
            step: () => void;
            currentFrameCount: () => number;
            outputTexture: (id: string, port?: string) => WebGLTexture | null;
            res: { width: number; height: number };
          };
        };
      };
      const vid = w.__engine().getDomain('video');
      const gl = vid.gl;
      while (gl.getError() !== gl.NO_ERROR) { /* drain pre-existing */ }

      // The frames were driven by stepFrames() before this evaluate; the delta
      // is still asserted, so a step that silently did not advance the engine
      // reddens exactly as it did when the loop lived in here.
      const framesDelta = vid.currentFrameCount() - framesBefore;

      const glErrors: number[] = [];
      let e: number;
      while ((e = gl.getError()) !== gl.NO_ERROR) glErrors.push(e);

      const tex = vid.outputTexture(nodeId, portId) as WebGLTexture | null;
      const { width: W, height: H } = vid.res;
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const fbComplete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      // Centred box — see `box` on the opts for why this is the honest sample
      // and not merely the cheap one.
      const bw = Math.max(1, Math.min(box, W));
      const bh = Math.max(1, Math.min(box, H));
      const bx = Math.floor((W - bw) / 2);
      const by = Math.floor((H - bh) / 2);
      const px = new Uint8Array(bw * bh * 4);
      if (fbComplete) gl.readPixels(bx, by, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      while (gl.getError() !== gl.NO_ERROR) { /* drain readback (already captured) */ }

      // Circular mean: sum unit vectors at each hue angle. Averaging the ANGLES
      // themselves would put the mean of 359° and 1° at 180°, which is the
      // wrong answer by half a turn — the classic way to make this instrument
      // lie without it looking broken.
      let sumX = 0, sumY = 0, sumSat = 0, sumVal = 0;
      let qualifying = 0, sampledPixels = 0;
      const step4 = 4 * stride;
      for (let i = 0; i + 2 < px.length; i += step4) {
        sampledPixels++;
        const r = px[i]! / 255, g = px[i + 1]! / 255, b = px[i + 2]! / 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const d = max - min;
        const sat = max === 0 ? 0 : d / max;
        if (sat < minSat) continue;
        let h: number;
        if (d === 0) h = 0;
        else if (max === r) h = 60 * (((g - b) / d) % 6);
        else if (max === g) h = 60 * ((b - r) / d + 2);
        else h = 60 * ((r - g) / d + 4);
        if (h < 0) h += 360;
        const rad = (h * Math.PI) / 180;
        sumX += Math.cos(rad);
        sumY += Math.sin(rad);
        sumSat += sat;
        sumVal += max;
        qualifying++;
      }

      if (qualifying === 0) {
        return { hueDeg: NaN, sat: 0, val: 0, spread: 1, qualifying, sampledPixels, framesDelta, glErrors, fbComplete };
      }
      const mx = sumX / qualifying, my = sumY / qualifying;
      let hueDeg = (Math.atan2(my, mx) * 180) / Math.PI;
      if (hueDeg < 0) hueDeg += 360;
      // Resultant length R: 1 when every pixel agrees, →0 when scattered.
      const R = Math.sqrt(mx * mx + my * my);
      return {
        hueDeg,
        sat: sumSat / qualifying,
        val: sumVal / qualifying,
        spread: 1 - R,
        qualifying,
        sampledPixels,
        framesDelta,
        glErrors,
        fbComplete,
      };
    },
    {
      nodeId: opts.nodeId,
      portId: opts.portId,
      framesBefore: before,
      box: opts.box ?? 256,
      stride: opts.stride ?? 17,
      minSat: opts.minSat ?? 0.15,
    },
  );
}

/**
 * Write one param on a spawned node through the VIDEO DOMAIN's `setParam` — the
 * same hot path the UI drives (control → `engine.setParam` → uniform).
 *
 * ⚠ NOT the `__patch` store. Writing `__patch.nodes[id].params[p]` looks
 * equivalent and is not: it updates the graph the UI renders from, and the
 * uniform the shader samples does not follow in time for a synchronous
 * step-and-read. That mistake is silent — the read succeeds, the pixels simply
 * never move, and the result is indistinguishable from "this param does
 * nothing", which is precisely the conclusion this file exists to prevent
 * someone drawing by accident.
 *
 * ⚠ And it is NOT a UI gesture either. A spec proving a CONTROL reaches the
 * shader must still drive the control; this reaches past it, deliberately, so
 * that a claim about the SHADER is not also a claim about the card.
 */
export async function setVideoParam(
  page: Page,
  nodeId: string,
  paramId: string,
  value: number,
): Promise<void> {
  const ok = await page.evaluate(
    ({ nodeId, paramId, value }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain?: (d: string) => { setParam?: (id: string, p: string, v: number) => void } | null;
        } | null;
      };
      const vid = w.__engine?.()?.getDomain?.('video');
      if (!vid?.setParam) return false;
      vid.setParam(nodeId, paramId, value);
      return true;
    },
    { nodeId, paramId, value },
  );
  // Fail LOUDLY rather than leaving the caller measuring an unchanged frame.
  expect(ok, `setVideoParam: video domain setParam unavailable for '${nodeId}.${paramId}'`).toBe(true);
}

/**
 * The assertion every caller owes before believing a `DeliveredColour`: the
 * frame really advanced, the FBO was readable, GL was clean, and — the one that
 * actually bites — enough pixels cleared the saturation floor for the mean to
 * mean anything.
 */
export function assertMeasurable(
  c: DeliveredColour,
  steps: number,
  opts: { minQualifying?: number; maxSpread?: number } = {},
): void {
  expect(c.framesDelta, 'engine advanced exactly the frames the test drove (loop paused)').toBe(steps);
  expect(c.fbComplete, 'output FBO readable').toBe(true);
  expect(c.glErrors, `GL errors during render: [${c.glErrors.join(',')}]`).toEqual([]);
  expect(
    c.qualifying,
    `pixels above the saturation floor (of ${c.sampledPixels} sampled) — an average of too few is NOT a measurement`,
  ).toBeGreaterThan(opts.minQualifying ?? Math.max(8, c.sampledPixels * 0.02));
  expect(
    c.spread,
    `circular spread ${c.spread.toFixed(4)} — HIGH means the mean hue ${c.hueDeg.toFixed(2)}° averages over pixels that disagree`,
  ).toBeLessThan(opts.maxSpread ?? 0.25);
}

/**
 * Signed shortest-arc hue difference `to − from`, DEGREES in (−180, 180].
 *
 * ⚠ IT CANNOT REPRESENT A ROTATION PAST HALF A TURN — 200° reads as −160°. That
 * is a property of any single hue comparison, not a bug, and it is exactly why
 * `cumulativeRotationDeg` exists: to prove a claim about a rotation's SIZE you
 * must walk it in steps small enough that no single step is ambiguous.
 */
export function hueDeltaDeg(from: number, to: number): number {
  let d = ((to - from) % 360 + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/**
 * Walk a series of measured hues and return the UNWRAPPED cumulative rotation
 * at each point, in degrees, relative to the first.
 *
 * This is the instrument that separates the two geometries #1896 named. Fed a
 * fine sweep of `b3ntb0x.hue` from 0 to 1 it should climb monotonically to about
 * 162 and stop; fed the same sweep of `bentbox.chroma_phase` it should climb
 * through 360 and RETURN TO 0, because that control's ends both equal its
 * centre. A single from/to comparison cannot tell those apart — both would read
 * as some angle under 180.
 *
 * ⚠ Each consecutive pair must rotate by LESS THAN 180°, or the unwrap picks
 * the wrong branch silently. `assertUnambiguousSteps` enforces it.
 */
export function cumulativeRotationDeg(hues: readonly number[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < hues.length; i++) {
    if (i > 0) acc += hueDeltaDeg(hues[i - 1]!, hues[i]!);
    out.push(acc);
  }
  return out;
}

/**
 * Guard the unwrap's precondition: no single step may approach half a turn, or
 * `cumulativeRotationDeg` is choosing a branch rather than measuring one. Fail
 * LOUDLY here instead of returning a confident wrong total.
 */
export function assertUnambiguousSteps(hues: readonly number[], maxStepDeg = 90): void {
  const steps = hues.slice(1).map((h, i) => Math.abs(hueDeltaDeg(hues[i]!, h)));
  const worst = Math.max(...steps);
  expect(
    worst,
    `largest single step ${worst.toFixed(1)}° — the unwrap needs every step well under 180°, ` +
      `so sweep more finely (steps: ${steps.map((s) => s.toFixed(1)).join(', ')})`,
  ).toBeLessThan(maxStepDeg);
}
