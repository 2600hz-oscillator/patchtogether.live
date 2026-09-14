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
// The ring is pre-filled with exactly IN_SLIP_LIMIT (4096) frames, the most
// the worklet will hold without slipping, and the render is longer than that
// so the measured window is the streamed span (the tail is the underrun fade
// to 0, which is asserted too — presence is not liveness).

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { es9Def } from '../../../packages/web/src/lib/audio/modules/es9';
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
});
