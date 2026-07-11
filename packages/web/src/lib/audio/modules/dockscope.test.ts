// packages/web/src/lib/audio/modules/dockscope.test.ts
//
// DOCKSCOPE (workflow P2.5b) — def-contract + factory-seam + draw-math
// unit tests. Mirrors scope.test.ts's fake-AudioContext pattern (no Faust
// assets, def imports directly).
//
// The draw tests pin the SHARED math: drawDockscope must plot through
// scope-draw's pixelFromSample / RANGE_MAX conventions (import/share, not
// fork), and its pixelRatio knob must scale the non-proportional strokes —
// the mechanism that keeps the rail trace crisp across the dock's 50–150%
// scale ladder.

import { describe, expect, it } from 'vitest';
import { dockscopeDef, type DockscopeSnapshot } from './dockscope';
import { drawDockscope, DOCKSCOPE_BG } from './dockscope-draw';
import { RANGE_MAX_CV } from './scope-draw';

describe('DOCKSCOPE def contract', () => {
  it('is the slim 1u rail scope: ch1-only probe, NO outputs, display-only params', () => {
    expect(dockscopeDef.type).toBe('dockscope');
    expect(dockscopeDef.domain).toBe('audio');
    // Lowercase-label guard (registry-manifest.test.ts enforces globally).
    expect(dockscopeDef.label).toBe('dockscope');
    // 1u rail form factor, declared on the def (not the fallback map).
    expect(dockscopeDef.size).toBe('1u');
    expect(dockscopeDef.hp).toBe(2);
    // SCOPE's probe convention: audio-typed, accepts the CV family. SCOPE
    // has no sync-trigger convention, so DOCKSCOPE is ch1-ONLY by design.
    expect(dockscopeDef.inputs.map((p) => p.id)).toEqual(['ch1']);
    expect(dockscopeDef.inputs[0]!.type).toBe('audio');
    expect(dockscopeDef.inputs[0]!.accepts).toEqual(['cv', 'pitch', 'gate']);
    // Terminal visualiser: no outputs — this is what keeps it out of the
    // ART audio-profile gate (art/setup/profile-coverage.ts ART_EXCLUDED)
    // and out of the behavioral output-delta dimension BY SHAPE.
    expect(dockscopeDef.outputs).toEqual([]);
    expect(dockscopeDef.params.map((p) => p.id)).toEqual(['timeMs', 'scale', 'range']);
  });

  it('ships co-located docs covering every port + param (STRICT_DOCS bar)', () => {
    const docs = dockscopeDef.docs!;
    expect(docs.explanation?.length ?? 0).toBeGreaterThan(100);
    expect(Object.keys(docs.inputs ?? {})).toEqual(['ch1']);
    expect(Object.keys(docs.outputs ?? {})).toEqual([]);
    expect(Object.keys(docs.controls ?? {}).sort()).toEqual(['range', 'scale', 'timeMs']);
  });
});

// ---- factory seam: SCOPE's analyser plumbing, single channel -------------

function makeFakeCtx(tail: number): AudioContext {
  function gainNode(): unknown {
    return {
      gain: { value: 1, setValueAtTime() {} },
      connect() {},
      disconnect() {},
    };
  }
  const analyser = {
    fftSize: 2048,
    smoothingTimeConstant: 0,
    connect() {},
    disconnect() {},
    getFloatTimeDomainData(buf: Float32Array) {
      buf.fill(0);
      buf[buf.length - 1] = tail;
    },
  };
  return {
    sampleRate: 48000,
    currentTime: 0,
    createGain: () => gainNode(),
    createAnalyser: () => analyser,
  } as unknown as AudioContext;
}

const fakeNode = { id: 'ds1', type: 'dockscope', position: { x: 0, y: 0 }, params: {} };

describe('DOCKSCOPE factory (shared analyser plumbing)', () => {
  it('read("snapshot") returns the live analyser window; read("ch1_last_sample") the newest sample', async () => {
    const handle = await dockscopeDef.factory(makeFakeCtx(0.42), fakeNode as never);
    const snap = handle.read!('snapshot') as DockscopeSnapshot;
    expect(snap.sampleRate).toBe(48000);
    expect(snap.samples.length).toBe(2048);
    expect(snap.samples[snap.samples.length - 1]).toBeCloseTo(0.42, 6);
    expect(handle.read!('ch1_last_sample')).toBeCloseTo(0.42, 6);
    expect(handle.read!('nonsense')).toBeUndefined();
    // ch1 wired, zero outputs, dispose clean.
    expect([...handle.inputs.keys()]).toEqual(['ch1']);
    expect(handle.outputs.size).toBe(0);
    expect(() => handle.dispose()).not.toThrow();
  });

  it('setParam/readParam round-trip the display cache (engine handle contract)', async () => {
    const handle = await dockscopeDef.factory(makeFakeCtx(0), fakeNode as never);
    expect(handle.readParam('timeMs')).toBe(20);
    handle.setParam('timeMs', 50);
    handle.setParam('range', 1);
    expect(handle.readParam('timeMs')).toBe(50);
    expect(handle.readParam('range')).toBe(1);
    handle.setParam('unknown', 7); // ignored, never throws
    expect(handle.readParam('unknown')).toBeUndefined();
  });
});

// ---- drawDockscope: shared sample→pixel math + the pixelRatio knob -------

interface Op {
  kind: 'moveTo' | 'lineTo' | 'stroke' | 'fillRect' | 'fillText';
  x?: number;
  y?: number;
  lineWidth?: number;
  fillStyle?: string;
  text?: string;
  font?: string;
}

function makeRecordingCtx() {
  const ops: Op[] = [];
  const ctx = {
    lineWidth: 0,
    strokeStyle: '',
    fillStyle: '',
    globalAlpha: 1,
    font: '',
    clearRect() {},
    fillRect(x: number, y: number) {
      ops.push({ kind: 'fillRect', x, y, fillStyle: String(this.fillStyle) });
    },
    beginPath() {},
    moveTo(x: number, y: number) {
      ops.push({ kind: 'moveTo', x, y });
    },
    lineTo(x: number, y: number) {
      ops.push({ kind: 'lineTo', x, y });
    },
    stroke() {
      ops.push({ kind: 'stroke', lineWidth: this.lineWidth });
    },
    fillText(text: string, x: number, y: number) {
      ops.push({ kind: 'fillText', text, x, y, font: String(this.font) });
    },
    save() {},
    restore() {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops };
}

function dcSamples(v: number, n = 2048): Float32Array {
  const s = new Float32Array(n);
  s.fill(v);
  return s;
}

describe('drawDockscope (vector trace, shared scope-draw math)', () => {
  const W = 200;
  const H = 100;

  it('paints the BG + a 0V midline at h/2', () => {
    const { ctx, ops } = makeRecordingCtx();
    drawDockscope(ctx, dcSamples(0), 48000, { timeMs: 20, scale: 1, range: 0 }, W, H);
    expect(ops.find((o) => o.kind === 'fillRect')?.fillStyle).toBe(DOCKSCOPE_BG);
    const midline = ops.find((o) => o.kind === 'moveTo' && o.x === 0 && o.y === H / 2);
    expect(midline).toBeDefined();
  });

  it('AUDIO range: a +0.5 DC sample plots at h/2 − 0.5·(h/2) (pixelFromSample convention)', () => {
    const { ctx, ops } = makeRecordingCtx();
    drawDockscope(ctx, dcSamples(0.5), 48000, { timeMs: 20, scale: 1, range: 0 }, W, H);
    const trace = ops.filter((o) => o.kind === 'lineTo' && o.y !== H / 2);
    expect(trace.length).toBeGreaterThan(10);
    for (const p of trace) expect(p.y).toBeCloseTo(H / 2 - 0.5 * (H / 2), 6);
  });

  it('CV range: a +5V DC sample fills the half-height (±5V convention) and labels ±5V', () => {
    const { ctx, ops } = makeRecordingCtx();
    drawDockscope(ctx, dcSamples(RANGE_MAX_CV), 48000, { timeMs: 20, scale: 1, range: 1 }, W, H);
    const trace = ops.filter((o) => o.kind === 'lineTo' && o.y !== H / 2);
    for (const p of trace) expect(p.y).toBeCloseTo(0, 6); // h/2 − halfH
    expect(ops.find((o) => o.kind === 'fillText')?.text).toBe('±5V');
  });

  it('scale multiplies the vertical deflection on top of the range normalisation', () => {
    const { ctx, ops } = makeRecordingCtx();
    drawDockscope(ctx, dcSamples(0.25), 48000, { timeMs: 20, scale: 2, range: 0 }, W, H);
    const trace = ops.filter((o) => o.kind === 'lineTo' && o.y !== H / 2);
    for (const p of trace) expect(p.y).toBeCloseTo(H / 2 - 0.25 * 2 * (H / 2), 6);
  });

  it('pixelRatio scales stroke widths + label font (the dock-zoom crispness knob)', () => {
    const one = makeRecordingCtx();
    drawDockscope(one.ctx, dcSamples(0.5), 48000, { timeMs: 20, scale: 1, range: 0, pixelRatio: 1 }, W, H);
    const three = makeRecordingCtx();
    drawDockscope(three.ctx, dcSamples(0.5), 48000, { timeMs: 20, scale: 1, range: 0, pixelRatio: 3 }, W, H);
    const traceStrokeAt = (ops: Op[]) =>
      ops.filter((o) => o.kind === 'stroke').map((o) => o.lineWidth);
    // [midline, trace] stroke widths — both ×3 under pixelRatio 3.
    expect(traceStrokeAt(one.ops)).toEqual([1, 1.5]);
    expect(traceStrokeAt(three.ops)).toEqual([3, 4.5]);
    expect(three.ops.find((o) => o.kind === 'fillText')?.font).toContain('27px');
  });

  it('timeMs windows the newest samples: a shorter window reads from later in the buffer', () => {
    // Ramp buffer: sample i = i/n. With timeMs=1ms @48k → 48-sample window
    // (the NEWEST 48) → first plotted value ≈ (2048−48)/2048.
    const n = 2048;
    const ramp = new Float32Array(n);
    for (let i = 0; i < n; i++) ramp[i] = i / n;
    const { ctx, ops } = makeRecordingCtx();
    drawDockscope(ctx, ramp, 48000, { timeMs: 1, scale: 1, range: 0 }, W, H);
    const first = ops.filter((o) => o.kind === 'moveTo').at(-1)!; // trace start (after midline)
    const expected = H / 2 - ((n - 48) / n) * (H / 2);
    expect(first.y).toBeCloseTo(expected, 1);
  });
});
