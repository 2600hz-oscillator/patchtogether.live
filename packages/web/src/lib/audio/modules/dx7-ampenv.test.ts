// packages/web/src/lib/audio/modules/dx7-ampenv.test.ts
//
// Worklet-unit tests for the DX7 per-voice master OUTPUT-VCA ADSR
// (per-voice-ADSR feature). Captures the registered Dx7Processor class via the
// registerProcessor shim (the worklet entry never top-level-exports) and drives
// process() with a hand-built 10-channel poly bus. Pins:
//   * a master-ADSR swell: with a slow attack, the output ramps in over time.
//   * deactivate guard (CRITIQUE C3): a long master release keeps the voice
//     active past operator-EG silence, AND a fully-faded voice DOES free (so a
//     freed slot is reclaimable + CPU is bounded).
//
// The DX7 ART mirror (dx7-render.ts) is single-note and intentionally NOT touched
// — the master ADSR is validated here + by e2e only, so DX7 ART baselines stay
// byte-identical.

import { describe, it, expect, beforeAll } from 'vitest';

const SR = 48000;
const BLOCK = 128;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

type ProcInstance = {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
  port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void };
  voices: Array<{ active: boolean; laneOwner: number; ampEnv: { value: number; state: number } }>;
};
type ProcCtor = new () => ProcInstance;
let capturedProc: ProcCtor | null = null;
async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  const g = globalThis as unknown as {
    registerProcessor?: (n: string, c: ProcCtor) => void;
    AudioWorkletProcessor?: unknown;
  };
  // The dx7 worklet entry uses a type-only `declare class AudioWorkletProcessor`
  // (no globalThis shim of its own) + accesses `this.port` in its constructor.
  // Provide a base class with a stub MessagePort so node can construct it.
  const prevAWP = g.AudioWorkletProcessor;
  g.AudioWorkletProcessor = class {
    port = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: () => {} };
  };
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => { registered = ctor; };
  await import('../../../../../dsp/src/dx7');
  g.registerProcessor = prev;
  g.AudioWorkletProcessor = prevAWP;
  if (!registered) throw new Error('dx7 processor did not register');
  capturedProc = registered;
  return capturedProc;
}

function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {
    voiceCount: 5, level: 0.7, transpose: 0,
    attack: 0.001, decay: 0.1, sustain: 1, release: 0.005,
  };
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

/** Build a 10-channel poly bus block — lane 0 gated at the given pitch. */
function polyBlock(len: number, gate: 0 | 1, voct = 0): Float32Array[] {
  const ch: Float32Array[] = [];
  for (let lane = 0; lane < 5; lane++) {
    ch.push(new Float32Array(len).fill(lane === 0 ? voct : 0));
    ch.push(new Float32Array(len).fill(lane === 0 ? gate : 0));
  }
  return ch;
}

function peak(b: Float32Array): number { let m = 0; for (let i = 0; i < b.length; i++) m = Math.max(m, Math.abs(b[i] ?? 0)); return m; }

/** Run `blocks` blocks with lane-0 gated (or not), returning the concatenated out. */
function run(proc: ProcInstance, params: Record<string, Float32Array>, blocks: number, gate: 0 | 1): Float32Array {
  const out = new Float32Array(blocks * BLOCK);
  for (let b = 0; b < blocks; b++) {
    const poly = polyBlock(BLOCK, gate);
    const o = new Float32Array(BLOCK);
    proc.process([poly], [[o]], params);
    out.set(o, b * BLOCK);
  }
  return out;
}

describe('DX7 master-ADSR (worklet)', () => {
  it('a slow master attack ramps the output in over time (swell)', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    // Slow 0.2 s master attack; gate lane 0.
    const params = makeParams({ attack: 0.2, sustain: 1, release: 0.5 });
    // Early window (first ~10 ms) vs settled window (~150 ms in).
    const early = run(p, params, 4, 1);   // ~10.7 ms
    const later = run(p, params, 60, 1);  // continues from the same instance
    expect(peak(later)).toBeGreaterThan(peak(early) + 1e-3);
  });

  it('a long master release keeps the voice ACTIVE past operator-EG silence', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    // Very long master release so the master VCA outlives the op EGs.
    const params = makeParams({ attack: 0.001, sustain: 1, release: 2.0 });
    // Gate on, hold ~50 ms.
    run(p, params, 20, 1);
    // Gate off → release. Run ~100 ms of release.
    run(p, params, 40, 0);
    // The voice owned by lane 0 must still be active (master release hasn't
    // finished even if the operator EGs decayed).
    const v = p.voices.find((x) => x.laneOwner === 0);
    expect(v, 'lane-0 voice should still be allocated mid-release').toBeTruthy();
    expect(v!.active, 'long master release must keep the voice active').toBe(true);
    expect(v!.ampEnv.value).toBeGreaterThan(1e-4);
  });

  it('a fully-faded voice DOES free (deactivate once ampEnv.value < ε)', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    // Fast master release so it fully fades quickly.
    const params = makeParams({ attack: 0.001, sustain: 1, release: 0.005 });
    run(p, params, 10, 1);  // gate on
    run(p, params, 200, 0); // gate off, run ~0.5 s of release — well past 5×release
    // The voice must have freed (active=false, laneOwner cleared) so the slot is
    // reclaimable and silent FM isn't rendered forever (CPU bound).
    const stillActive = p.voices.filter((x) => x.active).length;
    expect(stillActive, 'a fully-faded voice must free').toBe(0);
  });
});
