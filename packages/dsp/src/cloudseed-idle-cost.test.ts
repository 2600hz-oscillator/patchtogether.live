// packages/dsp/src/cloudseed-idle-cost.test.ts
//
// AUDIO-THREAD COST for CLOUDSEED: an idle reverb must not re-derive itself.
//
// THE BUG THIS PINS. `CloudseedProcessor.process` pushes all seven k-rate
// macros into `ReverbController.setParameter` unconditionally on EVERY
// 128-sample block, and `setParameter` had no dedupe. `Param.EqCrossSeed` is
// the expensive one: per channel it re-runs `multitap.setCrossSeed`
// (768-value cross-seeded LCG buffer + a 256-iteration Math.pow loop),
// `diffuser.setCrossSeed`, `updateLines` and `updatePostDiffusion` (twelve
// lines × a full re-seed). At 48 kHz that is 375 blocks/s of BigInt LCG work
// and Float32Array allocation on the audio thread for a reverb sitting
// completely still — the output-underrun / GC-churn class.
//
// WHY A CALL COUNT AND NOT A TIMING. A wall-clock assertion is invariant to
// *why* the block was slow (a loaded CI runner reads exactly like a rebuild
// storm) and would have to be tuned per machine. `cloudseedRebuildStats`
// counts the rebuild primitive itself, so the number is renderer- and
// load-independent by construction — and it moves in the right direction
// under the negative controls below.
//
// THE INSTRUMENT IS NEGATIVE-CONTROLLED ON EVERY RUN, in both directions:
//   · a genuinely CHANGED macro must still rebuild (else "0 rebuilds" would
//     also be what a dead reverb reports), and
//   · the FIRST push of a value — including a legitimate first write of 0,
//     which is also the Float32Array's own initial content — must rebuild.
// Without those two legs a `setParameter` that simply returned early would
// pass the idle assertion while silently deafening every knob.

import { describe, it, expect, beforeAll } from 'vitest';
import type { Param as ParamT, ReverbChannel as ReverbChannelT, scaleParam as scaleParamT } from './cloudseed';

const SR = 48000;
const BLOCK = 128;

type ProcInstance = {
  process: (
    i: Float32Array[][],
    o: Float32Array[][],
    p: Record<string, Float32Array>,
  ) => boolean;
};
type ProcCtor = new (options?: { processorOptions?: { seed?: number } }) => ProcInstance;

let capturedProc: ProcCtor | null = null;
let stats: { buffers: number; lcgIterations: number };
let Param: typeof ParamT;
let ReverbChannel: typeof ReverbChannelT;
let scaleParam: typeof scaleParamT;

beforeAll(async () => {
  const g = globalThis as unknown as {
    sampleRate?: number;
    AudioWorkletProcessor?: unknown;
    registerProcessor?: (n: string, c: ProcCtor) => void;
  };
  g.sampleRate = SR;
  // Same port-having stub base as cloudseed-seed.test.ts — the dsp suite runs
  // single-fork, so a port-less stub from another worklet spec may already be
  // installed and cloudseed's ctor sets `this.port.onmessage`.
  g.AudioWorkletProcessor = class {
    port = { onmessage: null as unknown, postMessage: (): void => {} };
  };
  g.registerProcessor = (_n, ctor) => {
    capturedProc = ctor;
  };
  const mod = await import('./cloudseed');
  stats = mod.cloudseedRebuildStats;
  Param = mod.Param;
  ReverbChannel = mod.ReverbChannel;
  scaleParam = mod.scaleParam;
  if (!capturedProc) throw new Error('cloudseed processor did not register');
});

/** The seven k-rate macros CloudseedProcessor.process reads every block. */
const MACROS = ['dry_out', 'early_out', 'late_out', 'input_mix', 'low_cut', 'high_cut', 'cross_seed'] as const;

function makeParams(): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  for (const name of MACROS) out[name] = new Float32Array([0.5]);
  out['dry_out'] = new Float32Array([0]);
  out['late_out'] = new Float32Array([0.8]);
  return out;
}

/** Walk every own numeric/boolean field reachable from `o` into a flat map.
 *  The big audio ring buffers are skipped — they are STATE, not derived
 *  configuration, and they would drown the signal. */
function snapshot(o: unknown, path = 'ch', out = new Map<string, number>(), depth = 0): Map<string, number> {
  if (depth > 8 || o == null) return out;
  if (typeof o === 'number') { out.set(path, o); return out; }
  if (typeof o === 'boolean') { out.set(path, o ? 1 : 0); return out; }
  if (ArrayBuffer.isView(o)) {
    const a = o as unknown as Float32Array;
    if (a.length > 4096) return out;
    for (let i = 0; i < a.length; i++) out.set(`${path}[${i}]`, a[i]!);
    return out;
  }
  if (Array.isArray(o)) { o.forEach((v, i) => snapshot(v, `${path}[${i}]`, out, depth + 1)); return out; }
  if (typeof o === 'object') {
    for (const k of Object.keys(o as Record<string, unknown>)) {
      snapshot((o as Record<string, unknown>)[k], `${path}.${k}`, out, depth + 1);
    }
  }
  return out;
}

interface Harness {
  proc: ProcInstance;
  params: Record<string, Float32Array>;
  /** Run n blocks of silence and return the rebuild count they cost. */
  idleBlocks: (n: number) => { buffers: number; lcgIterations: number };
  /** Run one block, returning its output for byte comparisons. */
  block: (impulse?: boolean) => Float32Array;
}

function harness(seed = 1234): Harness {
  const proc = new capturedProc!({ processorOptions: { seed } });
  const params = makeParams();
  const inL = new Float32Array(BLOCK);
  const inR = new Float32Array(BLOCK);
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  const block = (impulse = false): Float32Array => {
    inL.fill(0);
    inR.fill(0);
    if (impulse) {
      inL[0] = 1;
      inR[0] = 1;
    }
    proc.process([[inL], [inR]], [[outL], [outR]], params);
    const both = new Float32Array(BLOCK * 2);
    both.set(outL, 0);
    both.set(outR, BLOCK);
    return both;
  };
  const idleBlocks = (n: number): { buffers: number; lcgIterations: number } => {
    const b0 = stats.buffers;
    const l0 = stats.lcgIterations;
    for (let i = 0; i < n; i++) block();
    return { buffers: stats.buffers - b0, lcgIterations: stats.lcgIterations - l0 };
  };
  return { proc, params, idleBlocks, block };
}

describe('cloudseed: an idle reverb re-derives NOTHING on the audio thread', () => {
  it('100 unchanged blocks cost ZERO seeded rebuilds', () => {
    const h = harness();
    h.block(true); // strike it once so there is a live tail to render
    h.idleBlocks(5); // let the first push of each macro land
    const cost = h.idleBlocks(100);
    expect(
      cost.buffers,
      `100 idle blocks cost ${cost.buffers} seeded-buffer rebuilds ` +
        `(${cost.lcgIterations} BigInt LCG iterations). At 48 kHz that is ` +
        `${((cost.lcgIterations / 100) * (SR / BLOCK)).toFixed(0)} LCG iterations/s ` +
        `on the audio thread for a reverb nobody is touching.`,
    ).toBe(0);
    expect(cost.lcgIterations).toBe(0);
  });

  // ── NEGATIVE CONTROL A — the counter is not stuck at zero. ───────────────
  // Move a macro that really does force a re-seed and the number must jump.
  // Without this leg, deleting the whole seeding system would pass the test
  // above.
  it('NEGATIVE CONTROL: moving CROSS SEED still rebuilds (the counter can rise)', () => {
    const h = harness();
    h.idleBlocks(5);
    const before = h.idleBlocks(1);
    expect(before.buffers).toBe(0);

    h.params['cross_seed']![0] = 0.9;
    const after = h.idleBlocks(1);
    expect(
      after.buffers,
      `a genuinely changed CROSS SEED must re-derive: got ${after.buffers} ` +
        `buffers / ${after.lcgIterations} LCG iterations`,
    ).toBeGreaterThan(20);
    // …and only ONCE: the block after it is idle again.
    expect(h.idleBlocks(1).buffers).toBe(0);
  });

  // ── NEGATIVE CONTROL B — a FIRST write of 0 is not a duplicate. ──────────
  // `ReverbController.parameters` is a zero-filled Float32Array, so a naive
  // `if (this.parameters[id] === value) return` would swallow the very first
  // push of any macro whose value is 0 (dry_out's own default is 0). This leg
  // is what forces the "seen" bookkeeping to exist.
  it('NEGATIVE CONTROL: the FIRST push of a 0-valued macro is not deduped away', () => {
    // DRY OUT's own default is 0 and it is the FIRST macro the processor
    // pushes, so a naive value-only dedupe swallows it. DRY is the input tap,
    // so the difference is only visible on a block that HAS input — measure on
    // the impulse block itself, not on the tail.
    const h = harness();
    const dryOff = h.block(true);

    const h2 = harness();
    h2.params['dry_out']![0] = 1;
    const dryOn = h2.block(true);

    let diff = 0;
    for (let i = 0; i < dryOff.length; i++) diff += Math.abs(dryOff[i]! - dryOn[i]!);
    expect(diff, 'DRY OUT 0 vs 1 must produce different audio').toBeGreaterThan(1e-6);
    // The 0 leg really is the quiet one — a swallowed first write would leave
    // the shipped default in place, which is what this distinguishes.
    let e0 = 0;
    let e1 = 0;
    for (let i = 0; i < dryOff.length; i++) {
      e0 += dryOff[i]! * dryOff[i]!;
      e1 += dryOn[i]! * dryOn[i]!;
    }
    expect(e1, `dry=1 energy ${e1} must exceed dry=0 energy ${e0}`).toBeGreaterThan(e0);
  });

  // ── THE PROPERTY THE DEDUPE RESTS ON ────────────────────────────────────
  // Skipping an unchanged write is only sound-transparent if a repeated
  // IDENTICAL write is a no-op. Two places in ReverbChannel made it one that
  // was NOT: AllpassDiffuser.updateSeeds() regenerated the seed buffer without
  // re-deriving the seed-SCALED mod depth/rate, and the EqCrossSeed case
  // re-seeded the line diffusers AFTER updateLines() had already read them —
  // so a single push landed at a state a second identical push moved away
  // from, and the shipped worklet only looked stable because it re-pushed
  // every block. This walks the WHOLE channel object graph rather than the
  // fields we happen to suspect, which is what makes it able to catch the
  // next one.
  it('a repeated IDENTICAL push moves NOTHING in the channel state', () => {
    const ch = new ReverbChannel(SR, 'L');
    // A realistic late-field configuration: the modulated stages are what the
    // seed scaling reaches, so leaving them at 0 would make this vacuous.
    const config: Array<[number, number]> = [
      [Param.LateDiffuseEnabled, 1], [Param.LateLineCount, 0.9],
      [Param.LateLineSize, 0.6], [Param.LateLineDecay, 0.7],
      [Param.LateLineModAmount, 0.5], [Param.LateLineModRate, 0.4],
      [Param.LateDiffuseCount, 0.8], [Param.LateDiffuseDelay, 0.5],
      [Param.LateDiffuseFeedback, 0.6],
      [Param.LateDiffuseModAmount, 0.7], [Param.LateDiffuseModRate, 0.5],
      [Param.EarlyDiffuseEnabled, 1], [Param.EarlyDiffuseCount, 0.7],
      [Param.EarlyDiffuseDelay, 0.5], [Param.EarlyDiffuseModAmount, 0.8],
      [Param.EarlyDiffuseModRate, 0.4],
      [Param.TapEnabled, 1], [Param.TapCount, 0.4], [Param.TapLength, 0.6],
      // Seeds LAST — the order that exposed the staleness.
      [Param.EqCrossSeed, 0.35], [Param.SeedTap, 0.11], [Param.SeedDiffusion, 0.22],
      [Param.SeedDelay, 0.2181], [Param.SeedPostDiffusion, 0.3653],
    ];
    for (const [id, v] of config) ch.setParameter(id, scaleParam(v, id));

    const before = snapshot(ch);
    // Re-push everything, in the same order, with the same values.
    for (const [id, v] of config) ch.setParameter(id, scaleParam(v, id));
    const after = snapshot(ch);

    const moved: string[] = [];
    for (const [k, v] of before) if (after.get(k) !== v) moved.push(`${k}: ${v} → ${after.get(k)}`);
    expect(
      moved.length,
      `a repeat of the same parameter values moved ${moved.length} derived fields — ` +
        `ReverbChannel.setParameter is not idempotent, so the dedupe in ` +
        `ReverbController.setParameter is NOT sound-transparent. First few:\n  ` +
        moved.slice(0, 8).join('\n  '),
    ).toBe(0);
    // NEGATIVE CONTROL on the instrument: the snapshot must be able to SEE a
    // change. A walker that silently returned nothing would pass the above.
    expect(before.size).toBeGreaterThan(500);
    ch.setParameter(Param.EqCrossSeed, scaleParam(0.9, Param.EqCrossSeed));
    const perturbed = snapshot(ch);
    let changed = 0;
    for (const [k, v] of before) if (perturbed.get(k) !== v) changed++;
    expect(changed, 'moving CROSS SEED must move derived state the walker can see').toBeGreaterThan(50);
  });

  it('NEGATIVE CONTROL: a macro pushed for the first time AT 0 still reaches the DSP', () => {
    // late_out is 0.8 in makeParams(); drop it to 0 on a fresh processor so
    // the very first push of late_out IS 0 and must silence the late field.
    const h = harness();
    h.params['late_out']![0] = 0;
    h.params['early_out']![0] = 0;
    h.params['dry_out']![0] = 0;
    h.block(true);
    let energy = 0;
    for (let i = 0; i < 40; i++) {
      const b = h.block();
      for (const v of b) energy += v * v;
    }
    expect(energy, 'all three output taps first-pushed at 0 must render silence').toBeLessThan(1e-12);
  });
});
