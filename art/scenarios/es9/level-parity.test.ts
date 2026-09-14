// ES-9 LEVEL PARITY — the REAL `es9Def.factory` (the SHIPPED dist worklet,
// `packages/dsp/dist/es9-bridge.js`, through `ctx.audioWorklet.addModule`)
// under node-web-audio-api's OfflineAudioContext, with the SharedArrayBuffer
// rings injected through the factory's own `__es9Attach` seam and pre-filled
// with a known sine at the WIRE level. Asserted INLINE, no baseline: `es9` is
// in ART_EXCLUDED (its outputs are external rack signal) and the audio-profile
// gate reddens if an excluded module carries a `.f32`. So there is no
// fingerprint here and nothing to `task art:update`.
//
// WHY THIS LANE AND NOT ONLY THE DSP UNIT SUITE. es9-bridge-core.test.ts pins
// the scale FUNCTIONS and es9-bridge.test.ts pins the worklet SOURCE; neither
// sees the factory (the channel map from port id to worklet index, the
// keep-alive pin, the classes message built from params) or the BUILT bundle
// the browser actually loads. This scenario is the one place all three meet
// offline, and it measures the thing the owner reported — "es-9 is really
// really quiet" (2026-09-14) — against an internal VCO at its defaults.
//
// THE WIRE. The bridge app moves ±1.0 ≙ ±10 V (full scale), so a ±5 V
// Eurorack signal is 0.5 on the wire. Before ADR-019 the raw port passed it
// ×1 and this file's first assertion read 0.5 (−6.02 dBFS); it must read 1.0.
//
// THE REFERENCE TOGGLE (ADR-020, owner 2026-09-14: "add a toggle on the card
// to set it to line per jack"). +4 dBu line level is 1.736 V peak = 0.1736 on
// the wire, which the modular reference reads at 0.347 (−9.2 dBFS, the
// residual ADR-019 recorded). With `in{n}_ref = 1` (line) the same wire level
// must read 1.0 — and the output side is the symmetric reading: internal 1.0
// into an `out{n}_ref = 1` jack must land at 0.1736 on the wire (±1.736 V),
// not 0.5 (±5 V). The output tap below is what makes the graph → hardware
// half observable through the real factory: the worklet retains the first
// RING_FRAMES it wrote (the ring fills, later blocks drop), and the test reads
// them back through the same RingIO the bridge Worker would drain.
//
// The ring is pre-filled with exactly IN_SLIP_LIMIT (4096) frames, the most
// the worklet will hold without slipping, and the render is longer than that
// so the measured window is the streamed span (the tail is the underrun fade
// to 0, which is asserted too — presence is not liveness).

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import {
  ES9_REF_LINE,
  es9Def,
} from '../../../packages/web/src/lib/audio/modules/es9';
import { swolevcoDef } from '../../../packages/web/src/lib/audio/modules/swolevco';
import { createRingSpec, RingIO } from '../../../packages/web/src/lib/audio/es9/es9-ring';
import { SAMPLE_RATE } from '../../setup/capture';

const SR = SAMPLE_RATE;
const TONE_HZ = 1000;
/** == the worklet's IN_SLIP_LIMIT: fully pre-filled, never slipped. */
const RING_FRAMES = 4096;
/** Render past starvation so the fade is visible. */
const RENDER_FRAMES = 8192;
/** Skip the first quantum: node-web-audio-api's worklet comes up one block late. */
const SETTLE = 256;
/** +4 dBu peak on the WIRE (±1.0 ≙ ±10 V): sqrt(0.6) × 10^(4/20) × √2 / 10.
 *  DERIVED here from the same definition as the dsp constant rather than
 *  imported across packages (this package consumes dsp's BUILT dist only) —
 *  the dsp unit suite pins the constant itself to this value. */
const LINE_WIRE = (Math.sqrt(0.6) * 10 ** (4 / 20) * Math.SQRT2) / 10;
/** What a +4 dBu peak reads under the MODULAR reference: 1.736 / 5. */
const LINE_UNDER_MODULAR = (LINE_WIRE * 10) / 5;

function peakOf(buf: Float32Array, from: number, to: number): number {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(buf[i]!));
  return p;
}
function dbfs(x: number): number {
  return 20 * Math.log10(Math.max(x, 1e-12));
}

interface Es9Render {
  in1: Float32Array;
  in1_cv: Float32Array;
  spdif_l: Float32Array;
}

/** Render the es9 module with `wireAmp` sine on hardware input channel `ch`. */
async function renderEs9(
  wireAmp: number,
  ch: number,
  params: Record<string, number>,
): Promise<Es9Render> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 3, length: RENDER_FRAMES, sampleRate: SR });
  const node = { id: 'es9-1', type: 'es9', domain: 'audio' as const, position: { x: 0, y: 0 }, params };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = await es9Def.factory(ctx as any, node);
  const inRing = createRingSpec(16, RING_FRAMES);
  const outRing = createRingSpec(16, RING_FRAMES);
  new RingIO(inRing).write(RING_FRAMES, (c, i) =>
    c === ch ? wireAmp * Math.sin((2 * Math.PI * TONE_HZ * i) / SR) : 0,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handle as any).__es9Attach({ inRing, outRing });
  const merger = ctx.createChannelMerger(3);
  const taps = ['in1', 'in1_cv', 'spdif_l'] as const;
  taps.forEach((id, k) => {
    const ref = handle.outputs.get(id);
    if (!ref) throw new Error(`es9: no output '${id}'`);
    ref.node.connect(merger, ref.output, k);
  });
  merger.connect(ctx.destination);
  const r = await ctx.startRendering();
  return {
    in1: r.getChannelData(0).slice(),
    in1_cv: r.getChannelData(1).slice(),
    spdif_l: r.getChannelData(2).slice(),
  };
}

/** Render the es9 module with a constant 1.0 driven into input port `portId`
 *  and return the WIRE planes the worklet wrote (graph → hardware). The
 *  hardware→graph ring is left empty on purpose: this tap observes the
 *  OUTPUT direction only. */
async function renderEs9Out(
  portId: string,
  params: Record<string, number>,
): Promise<Float32Array[]> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: RENDER_FRAMES, sampleRate: SR });
  const node = { id: 'es9-1', type: 'es9', domain: 'audio' as const, position: { x: 0, y: 0 }, params };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = await es9Def.factory(ctx as any, node);
  const inRing = createRingSpec(16, RING_FRAMES);
  const outRing = createRingSpec(16, RING_FRAMES);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (handle as any).__es9Attach({ inRing, outRing });
  const ref = handle.inputs.get(portId);
  if (!ref) throw new Error(`es9: no input '${portId}'`);
  const cs = ctx.createConstantSource();
  cs.offset.value = 1.0;
  cs.connect(ref.node, 0, ref.input);
  cs.start(0);
  await ctx.startRendering();
  const planes = Array.from({ length: 16 }, () => new Float32Array(RING_FRAMES));
  const got = new RingIO(outRing).read(RING_FRAMES, (c, i, v) => { planes[c]![i] = v; });
  if (got !== RING_FRAMES) throw new Error(`es9 out ring held ${got} frames, expected ${RING_FRAMES}`);
  return planes;
}

/** Steady-state level of a wire plane: the last block the ring holds. */
function steady(plane: Float32Array): number {
  return plane[RING_FRAMES - 1]!;
}

async function renderSwolevcoPeak(): Promise<number> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: RENDER_FRAMES, sampleRate: SR });
  const node = { id: 'vco-1', type: 'swolevco', domain: 'audio' as const, position: { x: 0, y: 0 }, params: {} };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = await swolevcoDef.factory(ctx as any, node);
  const out = handle.outputs.get('out');
  if (!out) throw new Error('swolevco: no output "out"');
  out.node.connect(ctx.destination, out.output, 0);
  const r = await ctx.startRendering();
  return peakOf(r.getChannelData(0), 1024, RENDER_FRAMES);
}

describe('ART es9 / level parity (real factory + shipped dist worklet, inline)', () => {
  it('a ±5 V modular sine (0.5 on the wire) reads 1.00 at the audio port in1, for the default cv class AND the audio class', async () => {
    const cases: ReadonlyArray<Record<string, number>> = [{}, { in1_class: 0 }];
    for (const params of cases) {
      const r = await renderEs9(0.5, 0, params);
      const p = peakOf(r.in1, SETTLE, RING_FRAMES);
      // Old constant: 0.5 (−6.02 dBFS). ±1 % is the sine's sampling error.
      expect(p, `in1 peak (${JSON.stringify(params)}) = ${p.toFixed(4)} (${dbfs(p).toFixed(2)} dBFS)`).toBeGreaterThan(0.99);
      expect(p, `in1 peak (${JSON.stringify(params)})`).toBeLessThan(1.01);
      // The twin at class cv or audio is the SAME scale as the audio port.
      const t = peakOf(r.in1_cv, SETTLE, RING_FRAMES);
      expect(t, `in1_cv peak (${JSON.stringify(params)})`).toBeGreaterThan(0.99);
      expect(t, `in1_cv peak (${JSON.stringify(params)})`).toBeLessThan(1.01);
    }
  });

  it('parity: the ES-9 return of a ±5 V sine sits within 0.5 dB of an internal VCO (swolevco at defaults)', async () => {
    const es9 = peakOf((await renderEs9(0.5, 0, {})).in1, SETTLE, RING_FRAMES);
    const vco = await renderSwolevcoPeak();
    const gapDb = dbfs(es9) - dbfs(vco);
    // Before the fix this gap measured −6.0 dB (es9 0.500 vs vco 0.999).
    expect(
      Math.abs(gapDb),
      `es9 in1 ${es9.toFixed(4)} (${dbfs(es9).toFixed(2)} dBFS) vs swolevco ${vco.toFixed(4)} (${dbfs(vco).toFixed(2)} dBFS): gap ${gapDb.toFixed(2)} dB`,
    ).toBeLessThan(0.5);
  });

  it('the S/PDIF return is digital: 0.5 on the wire reads 0.50 at spdif_l, not 1.0', async () => {
    const r = await renderEs9(0.5, 14, {});
    const p = peakOf(r.spdif_l, SETTLE, RING_FRAMES);
    expect(p, `spdif_l peak = ${p.toFixed(4)}`).toBeGreaterThan(0.495);
    expect(p, `spdif_l peak = ${p.toFixed(4)}`).toBeLessThan(0.505);
    // And nothing leaked onto the DC jack.
    expect(peakOf(r.in1, SETTLE, RING_FRAMES)).toBe(0);
  });

  it('negative controls: a silent wire reads 0, and after the ring starves the audio port fades to exactly 0', async () => {
    const silent = await renderEs9(0, 0, {});
    expect(peakOf(silent.in1, 0, RENDER_FRAMES)).toBe(0);
    expect(peakOf(silent.in1_cv, 0, RENDER_FRAMES)).toBe(0);
    const live = await renderEs9(0.5, 0, {});
    // Streamed span was hot; the tail (ring exhausted + a 64-frame fade) is 0.
    expect(peakOf(live.in1, SETTLE, RING_FRAMES)).toBeGreaterThan(0.99);
    expect(peakOf(live.in1, RING_FRAMES + SETTLE + 64, RENDER_FRAMES)).toBe(0);
  });

  it('REF LINE (ADR-020): a +4 dBu sine (0.1736 on the wire) reads 1.00 at in1 with in1_ref=line, and 0.347 without it', async () => {
    // The feature: line-level gear reaches the same unity as a modular signal.
    const line = await renderEs9(LINE_WIRE, 0, { in1_ref: ES9_REF_LINE });
    const p = peakOf(line.in1, SETTLE, RING_FRAMES);
    expect(p, `in1 peak (line) = ${p.toFixed(4)} (${dbfs(p).toFixed(2)} dBFS)`).toBeGreaterThan(0.99);
    expect(p, `in1 peak (line)`).toBeLessThan(1.01);
    // The twin at its DEFAULT (cv) class carries volts: the ref must not leak.
    const tCv = peakOf(line.in1_cv, SETTLE, RING_FRAMES);
    expect(tCv, `in1_cv peak (line, class cv) = ${tCv.toFixed(4)}`).toBeGreaterThan(LINE_UNDER_MODULAR * 0.99);
    expect(tCv, `in1_cv peak (line, class cv)`).toBeLessThan(LINE_UNDER_MODULAR * 1.01);
    // …and follows the ref once its class is audio.
    const lineAudio = await renderEs9(LINE_WIRE, 0, { in1_ref: ES9_REF_LINE, in1_class: 0 });
    const tAudio = peakOf(lineAudio.in1_cv, SETTLE, RING_FRAMES);
    expect(tAudio, `in1_cv peak (line, class audio) = ${tAudio.toFixed(4)}`).toBeGreaterThan(0.99);
    expect(tAudio, `in1_cv peak (line, class audio)`).toBeLessThan(1.01);
    // NEGATIVE CONTROL — the residual ADR-019 recorded: without the toggle
    // the same line signal is 9.2 dB down. This is the leg that is red on the
    // feature's absence in BOTH directions (a toggle that did nothing would
    // fail the first assertion; a default that re-interpreted would fail this).
    const modular = await renderEs9(LINE_WIRE, 0, {});
    const q = peakOf(modular.in1, SETTLE, RING_FRAMES);
    expect(q, `in1 peak (modular) = ${q.toFixed(4)} (${dbfs(q).toFixed(2)} dBFS)`).toBeGreaterThan(LINE_UNDER_MODULAR * 0.99);
    expect(q, `in1 peak (modular)`).toBeLessThan(LINE_UNDER_MODULAR * 1.01);
    expect(dbfs(q)).toBeLessThan(-9.0);
  });

  it('OUTPUT side (the symmetric reading): internal 1.0 into out1 lands at 0.5 on the wire (±5 V), 0.1736 (±1.736 V) with out1_ref=line; cv ignores the ref; usb1 is ×1', async () => {
    // Jack 1 rides USB channel 9 = plane index 8; usb1 is plane 0.
    expect(steady((await renderEs9Out('out1', {}))[8]!)).toBeCloseTo(0.5, 4);
    const lineOut = steady((await renderEs9Out('out1', { out1_ref: ES9_REF_LINE }))[8]!);
    expect(lineOut, `out1 wire (line) = ${lineOut.toFixed(4)}`).toBeCloseTo(LINE_WIRE, 4);
    expect(lineOut).toBeCloseTo(0.1736, 3);
    // cv class carries volts: ±1 → ±5 V whatever the ref says.
    expect(steady((await renderEs9Out('out1', { out1_ref: ES9_REF_LINE, out1_class: 1 }))[8]!)).toBeCloseTo(0.5, 4);
    // The USB feed is digital and passes ×1 (its channel has no ref at all).
    const usb = await renderEs9Out('usb1', { out1_ref: ES9_REF_LINE });
    expect(steady(usb[0]!)).toBeCloseTo(1.0, 4);
    expect(steady(usb[8]!), 'nothing leaked onto jack 1').toBe(0);
  });
});
