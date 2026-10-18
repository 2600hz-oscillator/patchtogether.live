// The shipping Phases worklet, driven through its real vertices message and
// Trigger input. Its untouched flat default is deliberately silent, so the
// signature profile edits three phases: linear rise, concave fall, convex rise.
// One second of playback plus a terminal hold captures the complete contour.
// This bypasses the factory; phases.spec.ts covers real factory/cable wiring.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { repoSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { heldGate } from '../../setup/drivers';
import { compareBuffers } from '../../setup/render';
import { captureWorkletProcessor, renderWorklet, type WorkletProcessorLike } from '../../setup/worklet';

const DURATION_S = 1.25;
const VERTICES = [
  { x: 0, y: 0, shape: 0 },
  { x: 0.25, y: 1, shape: 0.5 },
  { x: 0.75, y: 0.2, shape: 1 },
  { x: 1, y: 0.8, shape: 0 },
];
interface Processor extends WorkletProcessorLike {
  port: { onmessage: (event: { data: unknown }) => void };
}

beforeAll(() => {
  vi.stubGlobal('AudioWorkletProcessor', class {
    port = { onmessage: null, postMessage: () => {} };
  });
});
afterAll(() => vi.unstubAllGlobals());

async function renderProfile(options: { defaultVertices?: boolean; linear?: boolean; reverseBipolar?: boolean; trigger?: boolean } = {}): Promise<Float32Array> {
  const Proc = await captureWorkletProcessor('phases', () => import('../../../packages/dsp/src/phases'), SAMPLE_RATE);
  const proc = new Proc() as Processor;
  if (!options.defaultVertices) {
    proc.port.onmessage({ data: {
      type: 'vertices',
      vertices: options.linear ? VERTICES.map((v) => ({ ...v, shape: 0 })) : VERTICES,
    } });
  }
  return renderWorklet(proc, {
    totalSamples: Math.round(SAMPLE_RATE * DURATION_S),
    // A held gate starts once; the falling edge must not release/restart it.
    inputs: [options.trigger === false ? null : heldGate({ totalS: DURATION_S, onS: 0.6 })],
    params: { length: 1, loop: 0, polarity: options.reverseBipolar ? 1 : 0, reverse: options.reverseBipolar ? 1 : 0 },
    outputs: ['phase'],
  }).phase!;
}

const at = (s: number) => Math.round(s * SAMPLE_RATE);

function assertContour(env: Float32Array): void {
  expect(env.length).toBe(at(DURATION_S));
  expect(env.every(Number.isFinite)).toBe(true);
  expect(Math.min(...env)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...env)).toBeCloseTo(1, 6);
  // Independent points on each curve, not the DSP's evaluator as an oracle:
  // midpoint progress is 1/2 (linear), 3/4 (concave), and 1/4 (convex).
  expect(env[at(0.125)]).toBeCloseTo(0.5, 6);
  expect(env[at(0.5)]).toBeCloseTo(0.4, 6);
  expect(env[at(0.875)]).toBeCloseTo(0.35, 6);
  expect(env.subarray(at(1.01)).every((v) => Math.abs(v - 0.8) < 1e-6)).toBe(true);
}

describe('ART phases / edited three-phase contour', () => {
  it('renders the three shapes and terminal hold deterministically through the real worklet', async () => {
    const env = await renderProfile();
    assertContour(env);
    const again = await renderProfile();
    expect(env.every((v, i) => v === again[i])).toBe(true);
  });

  it('plays the same geometry backwards with bipolar voltage and holds the starting endpoint', async () => {
    const env = await renderProfile({ reverseBipolar: true });
    expect(env.every(Number.isFinite)).toBe(true);
    expect(env[0]).toBeCloseTo(0.6, 6);
    expect(env[at(0.125)]).toBeCloseTo(-0.3, 6);
    expect(env[at(0.5)]).toBeCloseTo(-0.2, 6);
    expect(env[at(0.875)]).toBeCloseTo(0, 6);
    expect(env.subarray(at(1.01)).every((v) => v === -1)).toBe(true);
  });

  it('rejects a silent/missing trigger and a lost shape setting with the same contour probe and comparator', async () => {
    const env = await renderProfile();
    const silent = await renderProfile({ trigger: false });
    const linear = await renderProfile({ linear: true });
    expect(silent.every((v) => v === 0)).toBe(true);
    expect(() => assertContour(silent)).toThrow();
    expect(() => assertContour(linear)).toThrow();
    expect(compareBuffers(env, silent, 'B', 1e-4).pass).toBe(false);
    expect(compareBuffers(env, linear, 'B', 1e-4).pass).toBe(false);
    const untouched = await renderProfile({ defaultVertices: true });
    expect(untouched.every((v) => v === 0)).toBe(true);
  });

  it('pins the Phase CV signature (worklet, core, and shared gate threshold source)', async () => {
    const sha = await repoSourceSha(
      'packages/dsp/src/phases.ts',
      'packages/dsp/src/lib/phases-dsp.ts',
      'packages/web/src/lib/audio/gate-trigger.ts',
    );
    const env = await renderProfile();
    assertContour(env);
    await pinAll('phases', sha, { phase: env });
  });
});
