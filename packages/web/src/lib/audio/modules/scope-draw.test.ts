// packages/web/src/lib/audio/modules/scope-draw.test.ts
//
// Unit tests for SCOPE's drawScope() phosphor-persistence behaviour. The
// web package's vitest runs in `node` (no real canvas), so we stub the 2D
// context with a recorder that captures every op (incl. globalAlpha at the
// time of each draw call). The tests pin three claims that the VRT + e2e
// suites also guard, but here deterministically + cheaply:
//
//   1. PIXEL-IDENTITY at 12:00: drawScope with intensity=0.5 (the default)
//      emits a byte-identical op-stream to drawScope with `intensity`
//      omitted entirely (the pre-PR call shape). Since the no-intensity
//      path is the UNCHANGED legacy render, this proves the default
//      preserves every committed scope/composite baseline.
//   2. INTENSITY 7:00 (min) collapses the trace to a DOT — far fewer lit
//      segments than 12:00.
//   3. INTENSITY 5:00 (max) extends the trail to ~2 screens — more lit
//      segments than 12:00, with brightness fading as the trail recedes.

import { describe, expect, it } from 'vitest';
import { drawScope, type ScopeSnapshot, type ScopeDrawParams } from './scope-draw';

type Op =
  | { op: 'clearRect' }
  | { op: 'fillRect' }
  | { op: 'fillStyle'; v: string }
  | { op: 'strokeStyle'; v: string }
  | { op: 'lineWidth'; v: number }
  | { op: 'lineCap'; v: string }
  | { op: 'globalAlpha'; v: number }
  | { op: 'beginPath' }
  | { op: 'moveTo'; x: number; y: number }
  | { op: 'lineTo'; x: number; y: number }
  | { op: 'stroke' }
  | { op: 'save' }
  | { op: 'restore' }
  | { op: 'setLineDash' }
  | { op: 'font'; v: string }
  | { op: 'fillText'; t: string };

function mockCtx(): { ops: Op[]; ctx: CanvasRenderingContext2D } {
  const ops: Op[] = [];
  const ctx = {
    get fillStyle(): string { return ''; },
    set fillStyle(v: string) { ops.push({ op: 'fillStyle', v }); },
    get strokeStyle(): string { return ''; },
    set strokeStyle(v: string) { ops.push({ op: 'strokeStyle', v }); },
    get lineWidth(): number { return 0; },
    set lineWidth(v: number) { ops.push({ op: 'lineWidth', v }); },
    get lineCap(): string { return ''; },
    set lineCap(v: string) { ops.push({ op: 'lineCap', v }); },
    get globalAlpha(): number { return 1; },
    set globalAlpha(v: number) { ops.push({ op: 'globalAlpha', v }); },
    get font(): string { return ''; },
    set font(v: string) { ops.push({ op: 'font', v }); },
    clearRect: () => ops.push({ op: 'clearRect' }),
    fillRect: () => ops.push({ op: 'fillRect' }),
    beginPath: () => ops.push({ op: 'beginPath' }),
    moveTo: (x: number, y: number) => ops.push({ op: 'moveTo', x, y }),
    lineTo: (x: number, y: number) => ops.push({ op: 'lineTo', x, y }),
    stroke: () => ops.push({ op: 'stroke' }),
    save: () => ops.push({ op: 'save' }),
    restore: () => ops.push({ op: 'restore' }),
    setLineDash: () => ops.push({ op: 'setLineDash' }),
    fillText: (t: string) => ops.push({ op: 'fillText', t }),
  };
  return { ops, ctx: ctx as unknown as CanvasRenderingContext2D };
}

/** Sine wave snapshot — enough cycles per screen to make a non-trivial
 *  trace. 2048 samples mirrors the real analyser fftSize. */
function sineSnap(freqHz = 220, sampleRate = 48000): ScopeSnapshot {
  const n = 2048;
  const ch1 = new Float32Array(n);
  const ch2 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    ch1[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
    // ch2 a different ratio so XY draws a real Lissajous, not a line.
    ch2[i] = Math.sin((2 * Math.PI * freqHz * 1.5 * i) / sampleRate + 0.7);
  }
  return { ch1, ch2, sampleRate };
}

const W = 280;
const H = 120;

function baseParams(over: Partial<ScopeDrawParams> = {}): ScopeDrawParams {
  return {
    timeMs: 20,
    ch1Scale: 1, ch1Offset: 0, ch1Range: 0,
    ch2Scale: 1, ch2Offset: 0, ch2Range: 0,
    mode: 0,
    ...over,
  };
}

function countLit(ops: Op[]): number {
  return ops.filter((o) => o.op === 'stroke').length;
}

/** Distinct integer scanline rows the TRACE touches (moveTo/lineTo Y coords).
 *  The trace geometry is what the e2e's "brightRows" / per-row signature
 *  observes on the rendered FBO; pinning it here (deterministically, GPU-free)
 *  is the DSP-correctness half of the SCOPE video-out DRS split — see
 *  e2e/tests/scope-video-out.spec.ts. We round to integer rows to mirror the
 *  scanline-quantized pixel read. */
function tracedRows(ops: Op[], h: number): Set<number> {
  const rows = new Set<number>();
  for (const o of ops) {
    if (o.op === 'moveTo' || o.op === 'lineTo') {
      const y = Math.round(o.y);
      if (y >= 0 && y < h) rows.add(y);
    }
  }
  return rows;
}

describe('drawScope phosphor: 12:00 default is PIXEL-IDENTICAL to the legacy render', () => {
  it('NORMAL mode: intensity=0.5 emits the same op-stream as intensity omitted', () => {
    const snap = sineSnap();
    const a = mockCtx();
    const b = mockCtx();
    // Pre-PR call shape: no `intensity` field at all → legacy path.
    drawScope(a.ctx, snap, baseParams({ intensity: undefined }), W, H);
    // 12:00 default → must route to the SAME legacy path.
    drawScope(b.ctx, snap, baseParams({ intensity: 0.5 }), W, H);
    expect(b.ops).toEqual(a.ops);
  });

  it('XY mode: intensity=0.5 emits the same op-stream as intensity omitted', () => {
    const snap = sineSnap();
    const a = mockCtx();
    const b = mockCtx();
    drawScope(a.ctx, snap, baseParams({ mode: 1, intensity: undefined }), W, H);
    drawScope(b.ctx, snap, baseParams({ mode: 1, intensity: 0.5 }), W, H);
    expect(b.ops).toEqual(a.ops);
  });

  it('a value within float epsilon of 12:00 still takes the legacy path', () => {
    const snap = sineSnap();
    const a = mockCtx();
    const b = mockCtx();
    drawScope(a.ctx, snap, baseParams({ intensity: undefined }), W, H);
    drawScope(b.ctx, snap, baseParams({ intensity: 0.5 + 1e-6 }), W, H);
    expect(b.ops).toEqual(a.ops);
  });
});

describe('drawScope phosphor: trail length tracks INTENSITY', () => {
  it('NORMAL: 7:00 (dot) lights far fewer segments than 5:00 (long trail)', () => {
    const snap = sineSnap();
    const dot = mockCtx();
    const longTrail = mockCtx();
    drawScope(dot.ctx, snap, baseParams({ intensity: 0 }), W, H);
    drawScope(longTrail.ctx, snap, baseParams({ intensity: 1 }), W, H);
    const dotLit = countLit(dot.ops);
    const longLit = countLit(longTrail.ops);
    // The dot draws essentially the single newest beam position; the long
    // trail draws ~2 screens worth → strictly, substantially more segments.
    expect(longLit).toBeGreaterThan(dotLit);
    expect(longLit).toBeGreaterThan(dotLit * 5);
  });

  it('XY: 5:00 trail lights more beam segments than 7:00 dot', () => {
    const snap = sineSnap();
    const dot = mockCtx();
    const longTrail = mockCtx();
    drawScope(dot.ctx, snap, baseParams({ mode: 1, intensity: 0 }), W, H);
    drawScope(longTrail.ctx, snap, baseParams({ mode: 1, intensity: 1 }), W, H);
    expect(countLit(longTrail.ops)).toBeGreaterThan(countLit(dot.ops));
  });

  it('the trail fades: later (older) segments draw at lower globalAlpha than the newest', () => {
    const snap = sineSnap();
    const { ops, ctx } = mockCtx();
    drawScope(ctx, snap, baseParams({ intensity: 1 }), W, H);
    // Collect the globalAlpha used for the FIRST stroke (newest beam) vs a
    // late stroke (old beam). Alphas are pushed immediately before each
    // per-segment stroke.
    const alphasBeforeStroke: number[] = [];
    let pending = 1;
    for (const o of ops) {
      if (o.op === 'globalAlpha') pending = o.v;
      else if (o.op === 'stroke') alphasBeforeStroke.push(pending);
    }
    expect(alphasBeforeStroke.length).toBeGreaterThan(3);
    const first = alphasBeforeStroke[0]!;
    const last = alphasBeforeStroke[alphasBeforeStroke.length - 1]!;
    expect(first, 'newest beam ~full brightness').toBeGreaterThan(0.5);
    expect(last, 'oldest beam dimmer than newest').toBeLessThan(first);
  });

  it('still clears + paints the background on the phosphor path', () => {
    const snap = sineSnap();
    const { ops, ctx } = mockCtx();
    drawScope(ctx, snap, baseParams({ intensity: 0.8 }), W, H);
    expect(ops.some((o) => o.op === 'clearRect')).toBe(true);
    expect(ops.some((o) => o.op === 'fillRect')).toBe(true);
    expect(countLit(ops)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// DSP CORRECTNESS: waveform → trace geometry. This is the deterministic,
// GPU-free half of SCOPE's video-out coverage split (see
// e2e/tests/scope-video-out.spec.ts). SCOPE's video output is drawScope run
// against the live analyser snapshot, so the trace's row distribution IS the
// "what the user sees on the OUTPUT" assertion — pinned here without WebGL /
// SwiftShader / live-audio-analyser timing, where the e2e can only afford a
// renderer-tolerant non-black + structured floor.
// ---------------------------------------------------------------------------
describe('drawScope geometry: a real waveform → a multi-row trace (the flat-line / Bug-2 guard)', () => {
  it('NORMAL mode: the waveform trace spans MANY distinct rows, not a flat center line', () => {
    // A flat trace (the Bug-2 regression: a LINEAR-filtered R32F texture
    // returning all-zeros silently produced a flat line at center) would touch
    // only the one center row. A real full-amplitude waveform spreads across
    // many rows. This is the deterministic source of the e2e's
    // brightRows / occupiedRows assertion.
    const snap = sineSnap();
    const { ops, ctx } = mockCtx();
    drawScope(ctx, snap, baseParams({ intensity: undefined }), W, H);
    const rows = tracedRows(ops, H);
    expect(
      rows.size,
      `trace must span many rows, not a flat line (got ${rows.size})`,
    ).toBeGreaterThanOrEqual(20);
  });

  it('a SILENT input collapses the trace toward the center row (proves the spread is the SIGNAL, not the grid)', () => {
    // Control: with an all-zero snapshot the channel traces sit on the center
    // line — so the multi-row spread above is genuinely the waveform, not
    // background grid/label ops. (Offset=0 → both channels at h/2.)
    const n = 2048;
    const silent: ScopeSnapshot = { ch1: new Float32Array(n), ch2: new Float32Array(n), sampleRate: 48000 };
    const { ops, ctx } = mockCtx();
    drawScope(ctx, silent, baseParams({ intensity: undefined }), W, H);
    const rows = tracedRows(ops, H);
    // The center line + flat traces all land within a couple of rows of h/2.
    const spread = rows.size === 0 ? 0 : Math.max(...rows) - Math.min(...rows);
    expect(spread, `silent trace stays near center (spread ${spread})`).toBeLessThanOrEqual(4);
  });
});

describe('drawScope geometry: XY mode changes the row distribution vs split (the PR-69 XY-toggle proof)', () => {
  it('flipping mode 0→1 substantially changes which rows the trace occupies', () => {
    // The e2e flips the XY toggle and asserts the OUTPUT row distribution
    // changes (split = two stacked horizontal traces; XY = a Lissajous collapsed
    // toward center). Pin that same observable here: the set of traced rows
    // differs substantially between the two modes.
    const snap = sineSnap();
    const split = mockCtx();
    const xy = mockCtx();
    drawScope(split.ctx, snap, baseParams({ mode: 0, intensity: undefined }), W, H);
    drawScope(xy.ctx, snap, baseParams({ mode: 1, intensity: undefined }), W, H);
    const splitRows = tracedRows(split.ops, H);
    const xyRows = tracedRows(xy.ops, H);

    // Rows occupied by exactly one of the two modes (symmetric difference).
    let differing = 0;
    for (const r of splitRows) if (!xyRows.has(r)) differing++;
    for (const r of xyRows) if (!splitRows.has(r)) differing++;
    expect(
      differing,
      `XY toggle must change the trace row distribution (got ${differing} differing rows)`,
    ).toBeGreaterThan(10);
  });
});
