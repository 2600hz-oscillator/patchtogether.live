// e2e/tests/video-preview-downscale.spec.ts
//
// #1846 — THE COMB, MEASURED AGAINST GROUND TRUTH.
//
// The owner's report is about pixels: on-card video previews paint heavy
// horizontal banding that is not in the source, and it strobes. #1802's gate
// spec proves the preview RUNS and is CHEAP; nothing proved it is CORRECT.
//
// ── THE INSTRUMENT, AND WHY IT IS NOT CIRCULAR ─────────────────────────────
//
// The tempting comparison is the card against a second `drawImage` downscale —
// which compares the browser's sampler with itself and passes whatever it did.
// Instead the reference is ARITHMETIC: read the engine's full-resolution frame
// with `getImageData` (a 1:1 copy, so no sampler runs) and average, by hand,
// every source pixel falling inside each destination pixel. That is the exact
// box filter a correct downscale approximates, and it cannot alias, because
// every source row is read.
//
// Two numbers come off it, and they say different things:
//
//   * RMS luma error vs the reference — "is this the right picture".
//   * VERTICAL HIGH-FREQUENCY ENERGY, mean |row(y) − row(y+1)| — "is it
//     manufacturing horizontal banding". This is the owner's artifact stated
//     as a quantity: a single tap builds each destination row from a different
//     SUBSET of source rows, so adjacent output rows disagree far more than the
//     correctly-filtered picture does. MEASURED at 6.19×: the reference has
//     29.8, the fixed card 7.8, and the single tap 91.7 — three times the
//     energy that is actually there. That excess IS the comb.
//
// ⚠ NEGATIVE-CONTROLLED IN BOTH DIRECTIONS, IN THE PAGE, ON EVERY RUN. The same
// comparator is also pointed at a deliberate single-tap downscale of the same
// frame, and that leg MUST score worse. Without it, a comparator measuring the
// wrong thing — wrong crop, stale frame, all-black readback — reports a perfect
// fix forever. That is this repo's documented failure mode ("a wrong metric
// reads exactly like a finding"), so the control is a PERMANENT leg.
//
// ── ⚠ THE SUBJECT HAS TO BE ABLE TO SHOW THE DEFECT ────────────────────────
//
// This is the part that cost the most and is the easiest to get wrong. Two
// earlier sources were tried and MEASURED, and both would have produced a
// green, vacuous spec:
//
//   * a frozen TOYBOX shader — 0.99 vs 1.01 RMS. No separation at all.
//   * a real decoded VIDEO frame (the lobby clip, seeked and paused) — 4.34 vs
//     4.55 RMS, a 5% difference.
//
// Neither is a bug in the fix. ALIASING ONLY EXISTS WHERE THERE IS CONTENT
// ABOVE NYQUIST: a smooth gradient has none, and a small clip upscaled into the
// 1024×768 engine buffer is band-limited by its own decode resolution, so
// throwing rows away costs almost nothing. The defect needs detail AT ENGINE
// RESOLUTION — which is exactly what the owner was looking at, procedural video
// modules rendering per-pixel structure.
//
// So the source here is SHAPES → RUTTETRA: dense one-pixel scatter lines
// (measured source row-to-row energy 95.5 vs the video clip's much smoother
// field), and the same chain the RUTTETRA VRT scene uses precisely because it
// is a pure function of a time-independent procedural source and therefore
// pixel-stable. `refStdDev` and the source's own vertical energy are asserted
// as PRECONDITIONS below, so if the source ever goes smooth this spec says so
// instead of quietly passing.
//
// ── DETERMINISM ────────────────────────────────────────────────────────────
//
// Nothing in the chain depends on wall-clock or audio time, so the frame the
// card painted and the frame the reference is computed from are the same
// picture. Waits are FRAME counts, never milliseconds.
//
// ⚠ DOOM is not spawned here and must not be added: its game clock is its frame
// clock, so anything that changes how many frames it renders changes how far
// the marine walks.

import { test, expect, type Page } from './_fixtures';
import { spawnPatch } from './_helpers';
import { waitFrames } from '../_helpers/frames';

/**
 * How much better than a single tap the card has to be for this spec to call it
 * fixed. A ratio on a measured quantity, not a count of anything; deliberately
 * loose, because the claim is "different, in the expected direction", not a
 * pinned score. Measured separation is 1.9× at the default card size and 4.3×
 * at the small one.
 */
const MIN_SEPARATION = 1.5;

/**
 * How much MORE vertical high-frequency energy than the reference counts as
 * "manufacturing banding". A policy threshold on a measured ratio. The single
 * tap lands at 1.8× and 3.1×; a correct filter is at or below the reference,
 * never above it.
 */
const COMB_EXCESS = 1.4;

interface Result {
  /** RMS luma error (0-255) of the CARD's preview against the box reference. */
  cardRms: number;
  /** The same comparator against a deliberate one-tap downscale of the same frame. */
  singleTapRms: number;
  /** Mean |row(y) − row(y+1)| luma, the reference / the card / the single tap. */
  refVhf: number;
  cardVhf: number;
  singleTapVhf: number;
  /** The FULL-RESOLUTION source's own row-to-row energy. The precondition: no
   *  detail here means nothing can alias and the spec is vacuous. */
  sourceVhf: number;
  dest: { w: number; h: number };
  source: { w: number; h: number };
  /** Pixels compared. 0 means the readback failed and every number is meaningless. */
  pixels: number;
  /** Fraction of reference pixels above black. */
  nonZeroFrac: number;
  /** Spread of the reference itself. */
  refStdDev: number;
}

/** Measure the OUTPUT card's preview against a hand-computed box filter. */
async function measure(page: Page): Promise<Result> {
  return page.evaluate((): Result => {
    const w = globalThis as unknown as {
      __engine: () => {
        getDomain: (d: string) => {
          canvas: HTMLCanvasElement;
          blitOutputToDrawingBuffer: (id: string) => void;
        };
      };
    };
    const empty: Result = {
      cardRms: 0,
      singleTapRms: 0,
      refVhf: 0,
      cardVhf: 0,
      singleTapVhf: 0,
      sourceVhf: 0,
      dest: { w: 0, h: 0 },
      source: { w: 0, h: 0 },
      pixels: 0,
      nonZeroFrac: 0,
      refStdDev: 0,
    };
    const card = document.querySelector(
      '[data-testid="video-out-canvas"]',
    ) as HTMLCanvasElement | null;
    if (!card) return empty;
    const vid = w.__engine().getDomain('video');

    // Put THIS output's FBO into the drawing buffer, then take a 1:1 copy of
    // it. 1:1 means no sampler runs, so the readback cannot itself alias.
    vid.blitOutputToDrawingBuffer('out');
    const sw = vid.canvas.width;
    const sh = vid.canvas.height;
    const full = document.createElement('canvas');
    full.width = sw;
    full.height = sh;
    const fctx = full.getContext('2d', { alpha: false });
    if (!fctx) return empty;
    fctx.drawImage(vid.canvas, 0, 0);
    const srcData = fctx.getImageData(0, 0, sw, sh).data;

    // The card letterboxes, so recompute the same rect: compare the picture,
    // not the black bars (which match trivially and would dilute the error).
    const cw = card.width;
    const ch = card.height;
    const srcAspect = sw / sh;
    const dstAspect = cw / ch;
    let dw: number;
    let dh: number;
    let dx: number;
    let dy: number;
    if (dstAspect > srcAspect) {
      dh = ch;
      dw = Math.round(dh * srcAspect);
      dx = Math.round((cw - dw) / 2);
      dy = 0;
    } else {
      dw = cw;
      dh = Math.round(dw / srcAspect);
      dx = 0;
      dy = Math.round((ch - dh) / 2);
    }
    if (dw < 2 || dh < 2) return empty;

    const luma = (d: Uint8ClampedArray, i: number): number =>
      0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;

    // GROUND TRUTH: exact box average over every source pixel in each cell.
    const ref = new Float64Array(dw * dh);
    for (let y = 0; y < dh; y++) {
      const y0 = Math.floor((y * sh) / dh);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh));
      for (let x = 0; x < dw; x++) {
        const x0 = Math.floor((x * sw) / dw);
        const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw));
        let sum = 0;
        let n = 0;
        for (let sy = y0; sy < y1; sy++) {
          for (let sx = x0; sx < x1; sx++) {
            sum += luma(srcData, (sy * sw + sx) * 4);
            n++;
          }
        }
        ref[y * dw + x] = n ? sum / n : 0;
      }
    }

    const rmsAgainstRef = (d: Uint8ClampedArray): number => {
      let acc = 0;
      for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
          const e = luma(d, (y * dw + x) * 4) - ref[y * dw + x]!;
          acc += e * e;
        }
      }
      return Math.sqrt(acc / (dw * dh));
    };

    /** Mean absolute difference between vertically adjacent samples. */
    const vhf = (get: (x: number, y: number) => number): number => {
      let acc = 0;
      let n = 0;
      for (let y = 0; y + 1 < dh; y++) {
        for (let x = 0; x < dw; x++) {
          acc += Math.abs(get(x, y) - get(x, y + 1));
          n++;
        }
      }
      return n ? acc / n : 0;
    };

    // (a) WHAT THE CARD PAINTED.
    const cctx = card.getContext('2d');
    if (!cctx) return empty;
    const cardData = cctx.getImageData(dx, dy, dw, dh).data;

    // (b) THE PRE-FIX BEHAVIOUR, reproduced on purpose: one drawImage straight
    // from the full-res canvas to the destination size.
    const one = document.createElement('canvas');
    one.width = dw;
    one.height = dh;
    const octx = one.getContext('2d', { alpha: false });
    if (!octx) return empty;
    octx.drawImage(vid.canvas, 0, 0, dw, dh);
    const oneData = octx.getImageData(0, 0, dw, dh).data;

    // The source's own vertical energy, at an ODD column stride so the sampling
    // grid cannot align with a periodic pattern and alias to a constant.
    let sAcc = 0;
    let sN = 0;
    for (let y = 0; y + 1 < sh; y++) {
      for (let x = 0; x < sw; x += 7) {
        sAcc += Math.abs(
          luma(srcData, (y * sw + x) * 4) - luma(srcData, ((y + 1) * sw + x) * 4),
        );
        sN++;
      }
    }

    let nonZero = 0;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < ref.length; i++) {
      const v = ref[i]!;
      if (v > 8) nonZero++;
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / ref.length;

    return {
      cardRms: rmsAgainstRef(cardData),
      singleTapRms: rmsAgainstRef(oneData),
      refVhf: vhf((x, y) => ref[y * dw + x]!),
      cardVhf: vhf((x, y) => luma(cardData, (y * dw + x) * 4)),
      singleTapVhf: vhf((x, y) => luma(oneData, (y * dw + x) * 4)),
      sourceVhf: sN ? sAcc / sN : 0,
      dest: { w: dw, h: dh },
      source: { w: sw, h: sh },
      pixels: dw * dh,
      nonZeroFrac: nonZero / ref.length,
      refStdDev: Math.sqrt(Math.max(0, sumSq / ref.length - mean * mean)),
    };
  });
}

function describeWhere(r: Result): string {
  return (
    `${r.source.w}x${r.source.h} -> ${r.dest.w}x${r.dest.h} ` +
    `(${(r.source.h / Math.max(1, r.dest.h)).toFixed(2)}x reduction), ` +
    `${r.pixels} px compared, reference stdDev ${r.refStdDev.toFixed(1)} luma`
  );
}

function assertPreviewIsBoxFiltered(r: Result, label: string): void {
  // ── PRECONDITIONS. Each of these, if false, makes every claim below pass
  // for the wrong reason.
  expect(
    r.pixels,
    `${label}: the readback produced pixels at all — 0 makes every number below vacuous`,
  ).toBeGreaterThan(1000);
  expect(
    r.nonZeroFrac,
    `${label}: the source frame has content (nonBlack ${r.nonZeroFrac.toFixed(3)})`,
  ).toBeGreaterThan(0.05);
  expect(
    r.sourceVhf,
    `${label}: the FULL-RES source has detail above the destination's Nyquist ` +
      `(row-to-row energy ${r.sourceVhf.toFixed(1)} luma). Aliasing only exists where such ` +
      `detail exists: a smooth TOYBOX gradient measured 0.99 vs 1.01 RMS and a band-limited ` +
      `video clip 4.34 vs 4.55 — both would make this spec green and meaningless.`,
  ).toBeGreaterThan(30);
  expect(
    r.refStdDev,
    `${label}: the reference frame has real contrast (stdDev ${r.refStdDev.toFixed(1)} luma)`,
  ).toBeGreaterThan(15);

  // ── NEGATIVE CONTROLS. The comparators must be able to SEE the bug.
  expect(
    r.singleTapRms,
    `${label} NEGATIVE CONTROL: a deliberate single-tap downscale must score WORSE than the ` +
      `card. singleTap=${r.singleTapRms.toFixed(2)} card=${r.cardRms.toFixed(2)} (RMS luma ` +
      `error, 0-255, vs an exact box filter) at ${describeWhere(r)}. Equal scores mean the ` +
      `comparator is measuring something both paths share, not the resampling.`,
  ).toBeGreaterThan(r.cardRms * MIN_SEPARATION);
  expect(
    r.singleTapVhf,
    `${label} NEGATIVE CONTROL: the single tap must MANUFACTURE vertical high-frequency energy ` +
      `— that excess is the comb. singleTap=${r.singleTapVhf.toFixed(2)} vs reference ` +
      `${r.refVhf.toFixed(2)} (mean |row(y)-row(y+1)| luma). If it does not exceed the ` +
      `reference here, this content cannot alias and the spec proves nothing.`,
  ).toBeGreaterThan(r.refVhf * COMB_EXCESS);

  // ── THE CLAIMS.
  expect(
    r.cardRms,
    `${label}: the OUTPUT card preview must resample like a box filter, not like one bilinear ` +
      `tap. RMS luma error ${r.cardRms.toFixed(2)} (0-255) vs reference at ${describeWhere(r)}; ` +
      `the single-tap path scores ${r.singleTapRms.toFixed(2)} on the same comparator.`,
  ).toBeLessThan(r.singleTapRms / MIN_SEPARATION);
  expect(
    r.cardVhf,
    `${label}: THE COMB. The card must not paint MORE row-to-row variation than the picture ` +
      `actually has. card=${r.cardVhf.toFixed(2)} reference=${r.refVhf.toFixed(2)} ` +
      `singleTap=${r.singleTapVhf.toFixed(2)} (mean |row(y)-row(y+1)| luma) at ` +
      `${describeWhere(r)}. Excess here is banding the source does not contain — which is ` +
      `exactly what the owner reported.`,
  ).toBeLessThan(r.refVhf * COMB_EXCESS);
}

/** The OUTPUT canvas's current drawing-buffer height. */
async function bufferHeight(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector(
      '[data-testid="video-out-canvas"]',
    ) as HTMLCanvasElement | null;
    return c?.height ?? 0;
  });
}

/**
 * Resize the OUTPUT card through the patch store (the same field the corner
 * drag writes), so the preview is measured at a SECOND, harder reduction.
 *
 * ⚠ Only HEIGHT is worth shrinking: the card clamps `innerWidth` at
 * `MIN_WIDTH - PAD_PX`, so a narrower `width` changes nothing. Height drives
 * the letterbox fit at these proportions, and the comb is a VERTICAL aliasing
 * artifact anyway.
 */
async function resizeOutput(page: Page, width: number, height: number): Promise<void> {
  const before = await bufferHeight(page);
  await page.evaluate(
    ({ width, height }) => {
      const w = globalThis as unknown as {
        __ydoc: { transact: (fn: () => void) => void };
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['out'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.width = width;
        n.data.height = height;
      });
    },
    { width, height },
  );
  // Wait on the OBSERVABLE — the drawing buffer actually shrinking — not on a
  // budget. The card re-derives its buffer dims from node.data.
  await expect
    .poll(() => bufferHeight(page), {
      message: `the OUTPUT canvas drawing buffer followed the resize (was ${before} px)`,
      timeout: 15_000,
    })
    .toBeLessThan(before);
}

test.describe('#1846 on-card preview downscale', () => {
  test('the OUTPUT preview matches a box filter; a single tap does NOT @webgl-smoke', async ({
    page,
    errorWatch,
  }) => {
    test.setTimeout(180_000);
    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');

    // SHAPES → RUTTETRA → OUTPUT. RUTTETRA scatters the shape into dense
    // one-pixel lines at engine resolution — content above the preview's
    // Nyquist, which is the condition the defect needs. Pure function of a
    // time-independent procedural source, so the render is pixel-stable (the
    // same reasoning the RUTTETRA VRT scene records).
    await spawnPatch(
      page,
      [
        {
          id: 'src',
          type: 'shapes',
          position: { x: 40, y: 60 },
          domain: 'video',
          params: { shape: 2, zoom: 2.2 },
        },
        { id: 'rt', type: 'ruttetra', position: { x: 420, y: 60 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 900, y: 60 }, domain: 'video' },
      ],
      [
        {
          id: 'e1',
          from: { nodeId: 'src', portId: 'out' },
          to: { nodeId: 'rt', portId: 'z' },
          sourceType: 'video',
          targetType: 'video',
        },
        {
          id: 'e2',
          from: { nodeId: 'rt', portId: 'out' },
          to: { nodeId: 'out', portId: 'in' },
          sourceType: 'video',
          targetType: 'video',
        },
      ],
    );
    await expect(page.locator('[data-testid="video-out-canvas"]')).toHaveCount(1);
    // Frames, not milliseconds: enough for the chain to settle and for the
    // 30 fps-capped preview to have repainted from it several times.
    await waitFrames(page, 40);

    // ── LEG 1: the card at its SHIPPED default size (~3x reduction) ─────────
    const shipped = await measure(page);
    console.log(`[preview-downscale] default size ${JSON.stringify(shipped)}`);
    assertPreviewIsBoxFiltered(shipped, 'default OUTPUT card');

    // ── LEG 2: a SHORT card — the thumbnail regime (~6x), where a single tap
    // discards the most rows and the comb is worst. Same code path and same
    // order of reduction as the RACKLINE lane thumb, which is 160x120 off the
    // same 1024x768 buffer.
    await resizeOutput(page, 360, 180);
    await waitFrames(page, 40);
    const small = await measure(page);
    console.log(`[preview-downscale] small card ${JSON.stringify(small)}`);
    assertPreviewIsBoxFiltered(small, 'small OUTPUT card (thumbnail regime)');

    expect(
      small.source.h / small.dest.h,
      'LEG 2 really is a harder reduction than LEG 1 — otherwise it is the same test twice',
    ).toBeGreaterThan(shipped.source.h / shipped.dest.h);
  });
});
