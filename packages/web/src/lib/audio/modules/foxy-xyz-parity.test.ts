// packages/web/src/lib/audio/modules/foxy-xyz-parity.test.ts
//
// THE XYZ-PARITY GATE. In GEN=XYZ, FOXY's two on-card pictures — the "xyz
// field" window and the "live wavetable" — must show THE SAME DATA, because
// the second is built from the first. Owner report, 2026-08-24: "the xyz field
// is much more varied in data / magnitude than the resulting wavetable".
//
// ⚠ THE SUBJECT IS THE AUDIO, NOT THE PICTURE. It would have been trivial to
// paint the field into the wavetable panel and call the two "the same"; that
// would have made the readout LIE about the sound, because the table the
// WAVECEL worklet plays is a separate artifact. So this gate drives the REAL
// renderers over the REAL table and asserts the pictures agree BECAUSE the
// table carries the field's relief — the parity is a consequence, not a paint.
//
// ⚠ AND IT DRIVES THE RENDERERS RATHER THAN RE-DERIVING THEM. Both panels'
// geometry is recovered by handing `drawFoxyXyz` and `drawWave3D` a recording
// 2D context and reading the polylines they actually stroke. A test that
// re-implemented their scale maths would agree with itself forever while the
// product drifted underneath it.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drawFoxyXyz } from './foxy-draw';
import { drawWave3D } from './wavecel-draw';
import { RasterPainter, type RasterizeDrawParams } from './rasterize-draw';
import {
  FOXY_FIELD_SIZE,
  FOXY_WT_FRAMES,
  FOXY_WT_SAMPLES,
  FOXY_XYZ_3D_DEFAULTS,
  boxHeightfield3d,
  boxToField3d,
  fieldToWavetable,
  type FoxyFieldRow,
  type FoxyXyz3dParams,
} from './foxy-map';

const SIZE = FOXY_FIELD_SIZE;

// jsdom/node have no ImageData; RasterPainter.imageData() constructs one.
class StubImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(d: Uint8ClampedArray, w: number, h: number) {
    this.data = d; this.width = w; this.height = h;
  }
}
if (typeof (globalThis as { ImageData?: unknown }).ImageData === 'undefined') {
  (globalThis as { ImageData?: unknown }).ImageData = StubImageData;
}

// ── the panel sizes are READ OFF THE COMPONENT, never re-typed ─────────────
//
// FoxyOutputBody.svelte hard-codes each preview canvas's width/height in
// markup. Re-typing them here would let the component be resized while this
// gate went on measuring the old geometry and passing — the exact
// anchored-to-the-list-instead-of-the-artifact failure. Parsing the source
// means a resize either flows through or fails loudly.
function panelSize(testid: string): { w: number; h: number } {
  const src = readFileSync(
    fileURLToPath(new URL('../../ui/modules/foxy/FoxyOutputBody.svelte', import.meta.url)),
    'utf8',
  );
  const re = new RegExp(`<canvas[^>]*data-testid="${testid}"[^>]*>`);
  const tag = src.match(re)?.[0] ?? src.match(
    new RegExp(`<canvas[^>]*width="(\\d+)"[^>]*height="(\\d+)"[^>]*data-testid="${testid}"`),
  )?.[0];
  if (!tag) throw new Error(`XYZ-parity gate cannot find the <canvas> for ${testid} in FoxyOutputBody.svelte`);
  const w = Number(tag.match(/width="(\d+)"/)?.[1]);
  const h = Number(tag.match(/height="(\d+)"/)?.[1]);
  if (!Number.isFinite(w) || !Number.isFinite(h)) {
    throw new Error(`XYZ-parity gate cannot read width/height for ${testid}: ${tag}`);
  }
  return { w, h };
}

// ── a 2D context that records the strokes ─────────────────────────────────
interface Pt { x: number; y: number }
class RecordingCtx {
  polylines: Pt[][] = [];
  private current: Pt[] = [];
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 0;
  clearRect(): void { /* no-op */ }
  fillRect(): void { /* no-op */ }
  beginPath(): void { this.current = []; }
  moveTo(x: number, y: number): void { this.current.push({ x, y }); }
  lineTo(x: number, y: number): void { this.current.push({ x, y }); }
  stroke(): void { if (this.current.length > 1) this.polylines.push(this.current); this.current = []; }
}

function std(v: number[]): number {
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length);
}
function mean(v: number[]): number { return v.reduce((a, b) => a + b, 0) / v.length; }

/**
 * The one number both panels are compared on: how far a single stroked line
 * WIGGLES, measured in units of the GAP to its neighbour.
 *
 * This is what the eye actually reads on a stack of scanlines — a 5 px wiggle
 * on lines 1 px apart interleaves and reads as terrain; the same 5 px wiggle on
 * lines 40 px apart reads as five separate flat rules. Being a ratio, it is
 * invariant to each panel's own canvas size and to its own vertical scale,
 * which is exactly what lets two differently-sized, differently-projected
 * pictures be compared at all.
 */
function wiggleOverSpacing(polylines: Pt[][]): number {
  const wiggles = polylines.map((p) => std(p.map((q) => q.y)));
  const centres = polylines.map((p) => mean(p.map((q) => q.y)));
  const gaps: number[] = [];
  for (let i = 1; i < centres.length; i++) gaps.push(Math.abs(centres[i]! - centres[i - 1]!));
  return mean(wiggles) / Math.max(1e-9, mean(gaps));
}

/** Paint one raster the way the live bridge does: audio-rate tone → analyser
 *  window → RasterPainter, repeated past the ~32 ticks a 256×256 buffer needs
 *  to fill. An UNDER-filled raster is black, and black is a full-scale
 *  displacement rather than a neutral one, so a cold painter yields a
 *  saturated constant and would make every assertion below vacuous. */
function livePaint(hz: number, samplesPerFrame: number): RasterPainter {
  const p = new RasterPainter(SIZE, SIZE);
  const buf = new Float32Array(2048);
  const rp: RasterizeDrawParams = { cursor: 0, samplesPerFrame, gain: 1, wrap: 0 };
  let phase = 0;
  for (let t = 0; t < 60; t++) {
    for (let i = 0; i < buf.length; i++) {
      const ph = phase + (i / 48000) * hz;
      buf[i] = Math.tanh((2 * (ph - Math.floor(ph)) - 1) * 1.8) * 0.9;
    }
    phase += 0.042 * hz; // one BRIDGE_MS of audio between ticks
    p.paint(buf.subarray(buf.length - Math.min(buf.length, samplesPerFrame)), rp);
  }
  return p;
}

/** The live GEN=XYZ chain, at whatever XYZ params the caller passes. */
function buildField(overrides: Partial<FoxyXyz3dParams> = {}): FoxyFieldRow[] {
  const a = livePaint(261.63, 6000).imageData();
  const b = livePaint(392.0, 4500).imageData();
  const c = livePaint(130.81, 5200).imageData();
  // The module's own shipped defaults (foxy.ts overrides zoom/smooth to the
  // headline 4 / 0.5 — the patch the owner was looking at).
  const params: FoxyXyz3dParams = {
    ...FOXY_XYZ_3D_DEFAULTS, zoom: 4, smooth: 0.5, ...overrides,
  };
  const box = boxHeightfield3d(a.data, b.data, c.data, SIZE, SIZE);
  return boxToField3d(box, a.data, SIZE, SIZE, params);
}

function xyzPanelRatio(field: FoxyFieldRow[]): number {
  const { w, h } = panelSize('foxy-face-xyz');
  const ctx = new RecordingCtx();
  drawFoxyXyz(ctx as unknown as CanvasRenderingContext2D, field, w, h);
  return wiggleOverSpacing(ctx.polylines);
}

function wavetablePanelRatio(frames: number[][]): number {
  const { w, h } = panelSize('foxy-face-wavetable');
  const ctx = new RecordingCtx();
  drawWave3D(
    ctx as unknown as CanvasRenderingContext2D,
    frames.map((f) => new Float32Array(f)),
    w, h,
    { activeFrame: 0 },
  );
  return wiggleOverSpacing(ctx.polylines);
}

describe('FOXY XYZ parity: the wavetable shows what the xyz field shows', () => {
  it('both panels read at the same wiggle-to-spacing ratio on the default patch', () => {
    const field = buildField();
    const xyz = xyzPanelRatio(field);
    const wt = wavetablePanelRatio(fieldToWavetable(field, FOXY_WT_FRAMES, FOXY_WT_SAMPLES));

    // Sanity: neither picture is flat, so "they agree" is not "both are zero".
    expect(xyz, 'the xyz field paints real relief').toBeGreaterThan(1);
    expect(wt, 'the live wavetable paints real relief').toBeGreaterThan(1);

    // The panels project differently (scanlines vs a perspective stack), so
    // exact equality is not the claim — being in the SAME REGIME is. Before the
    // fix these read 3.15 vs 1.56: the wavetable showed half the variation of
    // the field it was built from.
    const ratio = wt / xyz;
    expect(
      ratio,
      `wavetable/xyz wiggle-ratio ${ratio.toFixed(2)} (xyz ${xyz.toFixed(2)}, wt ${wt.toFixed(2)}) ` +
      'must be within 1.5x either way — the two panels show the same data',
    ).toBeGreaterThan(1 / 1.5);
    expect(ratio).toBeLessThan(1.5);
  });

  it('NEGATIVE CONTROL: the pre-fix ramp-carrying table FAILS the same assertion', () => {
    // A PERMANENT leg, and it is the one that proves the gate can see the
    // defect it was written for. This re-creates the old `(y - 0.5) * 2` —
    // subtracting the ramp's MIDPOINT instead of the ramp — and shows the
    // wavetable panel drops out of the band while the xyz panel is untouched.
    // Without this, "the two ratios are close" could be an artifact of the
    // renderers rather than of the data reaching the table.
    const field = buildField();
    const xyz = xyzPanelRatio(field);

    const srcRows = field.length;
    const srcCols = field[0]!.y.length;
    const preFix: number[][] = [];
    for (let f = 0; f < FOXY_WT_FRAMES; f++) {
      const r0 = Math.floor((f / FOXY_WT_FRAMES) * srcRows);
      const r1 = Math.max(r0 + 1, Math.floor(((f + 1) / FOXY_WT_FRAMES) * srcRows));
      const frame = new Array<number>(FOXY_WT_SAMPLES);
      for (let s = 0; s < FOXY_WT_SAMPLES; s++) {
        const col = Math.round((s / (FOXY_WT_SAMPLES - 1)) * (srcCols - 1));
        let acc = 0, n = 0;
        for (let r = r0; r < r1 && r < srcRows; r++) { acc += ((field[r]!.y[col] ?? 0.5) - 0.5) * 2; n++; }
        const v = n > 0 ? acc / n : 0;
        frame[s] = v < -1 ? -1 : v > 1 ? 1 : v;
      }
      preFix.push(frame);
    }
    const wtOld = wavetablePanelRatio(preFix);
    const oldRatio = wtOld / xyz;
    expect(
      oldRatio,
      `the pre-fix table read ${wtOld.toFixed(2)} against the field's ${xyz.toFixed(2)} ` +
      `(${oldRatio.toFixed(2)}x) — if this is now INSIDE the band, the gate above has ` +
      'stopped being able to fail and something re-flattened or re-scaled the panels',
    ).toBeLessThan(1 / 1.5);
  });

  it('the two panels FLATTEN TOGETHER as the depth control comes down', () => {
    // The other half of "the same": not just that they agree at one setting,
    // but that they TRACK. This is what rules out a fixed auto-normalisation
    // in the table — that would hold the wavetable's amplitude up while the
    // field went flat, which is the owner's complaint mirrored.
    const depths = [-1, -0.5, -0.25];
    const seen = depths.map((yDisp) => {
      const field = buildField({ yDisp });
      return {
        yDisp,
        xyz: xyzPanelRatio(field),
        wt: wavetablePanelRatio(fieldToWavetable(field, FOXY_WT_FRAMES, FOXY_WT_SAMPLES)),
      };
    });
    for (let i = 1; i < seen.length; i++) {
      const prev = seen[i - 1]!, cur = seen[i]!;
      expect(cur.xyz, `xyz field flattens from yDisp ${prev.yDisp} to ${cur.yDisp}`).toBeLessThan(prev.xyz);
      expect(cur.wt, `live wavetable flattens from yDisp ${prev.yDisp} to ${cur.yDisp}`).toBeLessThan(prev.wt);
    }

    // ...and at zero depth the field IS its own ramp, so BOTH go silent-flat.
    const flat = buildField({ yDisp: 0 });
    expect(xyzPanelRatio(flat), 'yDisp 0 ⇒ the xyz field is flat').toBeLessThan(0.05);
    const flatTable = fieldToWavetable(flat, FOXY_WT_FRAMES, FOXY_WT_SAMPLES);
    for (const frame of flatTable) {
      for (const v of frame) {
        expect(Math.abs(v), 'yDisp 0 ⇒ the wavetable is silent, not merely quiet').toBeLessThan(0.05);
      }
    }
  });
});
