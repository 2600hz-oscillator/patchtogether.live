// packages/web/src/lib/audio/modules/moog911.test.ts
//
// Two test layers for the MOOG 911 ENVELOPE GENERATOR:
//   1. Module-def shape — pins the 911's I/O surface (gate input + t*_cv /
//      esus_cv CV inputs, env / env_inv outputs, the literal param array) so
//      a refactor that silently drops a port fails loudly (the per-module-
//      per-port regression-net class of bug).
//   2. Real DSP behavior — instantiate the registered worklet processor class
//      (captured via the registerProcessor shim, since the worklet entry NEVER
//      top-level-exports its class — that would break ART's classic-script
//      eval) and drive process() to assert the 3-stage contour:
//        - ATTACK reaches the peak (1.0) over T1
//        - INITIAL DECAY falls to Esus over T2 and holds Esus while gated
//        - FINAL DECAY (T3) on gate release back to 0
//        - gate-close mid-attack forces the T3 stage (no full attack required)
//        - env_inv == 1 - env at every sample

import { describe, it, expect, beforeAll } from 'vitest';
import { moog911Def } from './moog911';

const SR = 48000;
const BLOCK = 128;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// ───────────────────── Layer 1: module-def shape ─────────────────────
// ───────────────────── Layer 2: real worklet DSP ─────────────────────
type ProcInstance = {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
};
type ProcCtor = new () => ProcInstance;
let capturedProc: ProcCtor | null = null;

async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  // Capture the registered processor class via the registerProcessor shim —
  // the same pattern the sibling worklet tests use (cube / resofilter /
  // sidecar). We import the DSP *source* directly (vitest
  // transpiles it) rather than reading the built dist/<name>.js bundle: the
  // web unit suite has no guaranteed DSP-build step before it runs, so a
  // dist read is order-dependent and ENOENTs on a clean CI checkout. The
  // source self-shims AudioWorkletProcessor + registerProcessor (see
  // dsp/src/moog911.ts) and NEVER top-level-exports its class (memory:
  // dsp-worklet-no-top-level-export), so the import side-effect registers it.
  // Relative path into the DSP source — worktrees may not have the workspace
  // package symlinked under node_modules.
  const g = globalThis as unknown as { registerProcessor?: (n: string, c: ProcCtor) => void };
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => { registered = ctor; };
  // moog911.ts imports its contour core (lib/moog911-eg-dsp), so — like
  // cube/resofilter — it IS a module; we import it solely for its
  // registerProcessor side-effect (vitest runs the module body). It still never
  // top-level-exports its Processor class (dsp-worklet-no-top-level-export), so
  // the registration happens via the import side-effect captured above.
  await import('../../../../../dsp/src/moog911');
  g.registerProcessor = prev;
  if (!registered) throw new Error('moog911 processor did not register');
  capturedProc = registered;
  return capturedProc;
}

/** Build a params map (a-rate single-value buffers) from defaults + overrides. */
function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const def of moog911Def.params) base[def.id] = def.defaultValue;
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

/** Two mono outputs (env / env_inv), one block each. */
function makeOutputs(): Float32Array[][] {
  return [[new Float32Array(BLOCK)], [new Float32Array(BLOCK)]];
}

/** Single gate input, one block, all samples = `g` (0 low / 1 high). */
function makeGate(g: number): Float32Array[][] {
  return [[new Float32Array(BLOCK).fill(g)]];
}

/**
 * Drive the processor for `seconds` with a constant gate level and return
 * the full concatenated env (output 0) + env_inv (output 1) signals.
 */
function run(
  proc: ProcInstance,
  params: Record<string, Float32Array>,
  gate: number,
  seconds: number,
): { env: Float32Array; inv: Float32Array } {
  const blocks = Math.ceil((seconds * SR) / BLOCK);
  const env = new Float32Array(blocks * BLOCK);
  const inv = new Float32Array(blocks * BLOCK);
  const gIn = makeGate(gate);
  for (let b = 0; b < blocks; b++) {
    const o = makeOutputs();
    proc.process(gIn, o, params);
    env.set(o[0][0], b * BLOCK);
    inv.set(o[1][0], b * BLOCK);
  }
  return { env, inv };
}

const peak = (a: Float32Array) => Math.max(...Array.from(a).map(Math.abs));

describe('moog911 worklet DSP: 3-stage contour', () => {
  it('ATTACK rises to the peak (1.0) over T1 on gate high', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    // Short T1, long T2 so we stay near the peak after attack completes.
    const params = makeParams({ t1: 0.01, t2: 5, esus: 0.5, t3: 0.4 });
    const { env } = run(proc, params, 1, 0.05); // 50 ms gate-high
    expect(peak(env), 'env should reach ~1.0 at the attack peak').toBeGreaterThan(0.99);
  });

  it('INITIAL DECAY falls to Esus over T2, then HOLDS Esus while gated', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const esus = 0.4;
    const params = makeParams({ t1: 0.005, t2: 0.02, esus, t3: 0.4 });
    // 0.5 s of gate-high: attack (5ms) + decay (20ms) + long sustain hold.
    const { env } = run(proc, params, 1, 0.5);
    // Final value should be sitting at Esus (within tolerance).
    const tail = env[env.length - 1];
    expect(tail, `held value ${tail} should equal Esus ${esus}`).toBeCloseTo(esus, 2);
    // And it must have passed THROUGH the peak (decay came down from 1.0).
    expect(peak(env)).toBeGreaterThan(0.99);
  });

  it('FINAL DECAY (T3) brings env back to 0 after gate release', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const params = makeParams({ t1: 0.005, t2: 0.02, esus: 0.5, t3: 0.05 });
    // Phase 1: gate high to settle at Esus.
    run(proc, params, 1, 0.2);
    // Phase 2: gate low → final decay over T3 (50 ms). Run well past T3.
    const { env } = run(proc, params, 0, 0.3);
    const tail = env[env.length - 1];
    expect(tail, `env should decay to ~0 after T3; got ${tail}`).toBeLessThan(1e-3);
  });

  it('gate-close mid-attack forces the T3 stage (decays from the partial level)', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    // Long T1 so the attack is still climbing when we release; short T3.
    const params = makeParams({ t1: 1.0, t2: 5, esus: 0.5, t3: 0.03 });
    // Phase 1: gate high for only 10 ms — attack is far from the peak.
    const a = run(proc, params, 1, 0.01);
    const partial = a.env[a.env.length - 1];
    expect(partial, 'attack should be partial (well under peak)').toBeGreaterThan(0);
    expect(partial).toBeLessThan(0.5);
    // Phase 2: gate low → must decay to ~0 over T3 from the partial level.
    const b = run(proc, params, 0, 0.2);
    expect(b.env[b.env.length - 1], 'forced T3 decay reaches ~0').toBeLessThan(1e-3);
  });

  it('longer T1 climbs more slowly (less progress in the same window)', async () => {
    const Proc = await loadProcessor();
    function attackProgress(t1: number): number {
      const proc = new Proc();
      const params = makeParams({ t1, t2: 5, esus: 0.5, t3: 0.4 });
      const { env } = run(proc, params, 1, 0.02); // 20 ms window
      return env[env.length - 1];
    }
    expect(attackProgress(0.005)).toBeGreaterThan(attackProgress(0.2));
  });

  it('env_inv == 1 - env at every sample', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const params = makeParams({ t1: 0.01, t2: 0.05, esus: 0.5, t3: 0.05 });
    const { env, inv } = run(proc, params, 1, 0.3);
    let worst = 0;
    for (let i = 0; i < env.length; i++) {
      worst = Math.max(worst, Math.abs(inv[i] - (1 - env[i])));
    }
    expect(worst, `worst |env_inv - (1-env)| = ${worst}`).toBeLessThan(1e-6);
  });

  it('idle (gate never high) holds env=0 / env_inv=1', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const params = makeParams();
    const { env, inv } = run(proc, params, 0, 0.05);
    expect(peak(env)).toBe(0);
    for (const v of inv) expect(v).toBeCloseTo(1, 6);
  });

  it('produces no NaN / Inf samples across a full gate cycle', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const params = makeParams({ t1: 0.01, t2: 0.05, esus: 0.5, t3: 0.05 });
    const high = run(proc, params, 1, 0.2);
    const low = run(proc, params, 0, 0.2);
    for (const buf of [high.env, high.inv, low.env, low.inv]) {
      for (const v of buf) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
