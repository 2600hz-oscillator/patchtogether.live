// art/setup/worklet.ts
//
// Shared REAL-WORKLET capture path for ART audio profiles (backfill batch 3 —
// spec §4.3, .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md).
//
// Batches 1–2 proved the pattern per-scenario (bluebox / cocoadelay): when a
// worklet entry is SELF-CONTAINED PURE MATH (no WASM, no RNG or a fixed-seed
// PRNG, no async loads), the highest-fidelity render path is the SHIPPING
// AudioWorkletProcessor class itself — captured via a registerProcessor shim
// and pumped through process() in 128-sample blocks. Zero mirror, zero drift.
// This file lifts that loader + block pump into ONE helper so a profile
// scenario declares only its driver buffers, params and output names.
//
// The shim: worklet entries read three globals at import/construct time —
// `sampleRate`, `AudioWorkletProcessor`, `registerProcessor`. We install all
// three before the dynamic import (some entries carry their own fallback shim,
// some — e.g. ninelives — do not, so the loader must provide the full set).
// Captured constructors are cached by name: vitest caches the module, so a
// second import would not re-run the registerProcessor side-effect.

export interface WorkletProcessorLike {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

export type WorkletProcessorCtor = (new (opts?: unknown) => WorkletProcessorLike) & {
  parameterDescriptors?: ReadonlyArray<{ name: string; defaultValue: number }>;
};

const ctorCache = new Map<string, WorkletProcessorCtor>();

/**
 * Import a worklet entry under the registerProcessor shim and return the
 * Processor class it registers. `name` is the cache key (use the worklet's
 * registered name); `importWorklet` is a thunk so the import stays static
 * enough for vitest to resolve (e.g. `() => import('../../../packages/dsp/src/moog911')`).
 */
export async function captureWorkletProcessor(
  name: string,
  importWorklet: () => Promise<unknown>,
  sampleRate: number,
): Promise<WorkletProcessorCtor> {
  const hit = ctorCache.get(name);
  if (hit) return hit;
  const g = globalThis as unknown as {
    sampleRate?: number;
    AudioWorkletProcessor?: unknown;
    registerProcessor?: (n: string, c: WorkletProcessorCtor) => void;
  };
  g.sampleRate = sampleRate; // worklet ctors read the global sampleRate
  if (typeof g.AudioWorkletProcessor === 'undefined') {
    g.AudioWorkletProcessor = class {};
  }
  const prev = g.registerProcessor;
  let registered: WorkletProcessorCtor | null = null;
  g.registerProcessor = (_n, ctor) => {
    registered = ctor;
  };
  try {
    await importWorklet();
  } finally {
    g.registerProcessor = prev;
  }
  if (!registered) throw new Error(`${name}: worklet entry did not registerProcessor()`);
  ctorCache.set(name, registered);
  return registered;
}

export interface WorkletRenderOptions {
  /** Total samples to render. */
  totalSamples: number;
  /** Full-length driver buffers by WORKLET INPUT INDEX; null = unconnected
   *  (the worklet sees `inputs[k]` as `[]`, its unpatched shape). */
  inputs: ReadonlyArray<Float32Array | null>;
  /** AudioParams: a full-length Float32Array = an a-rate schedule (sliced
   *  per block, sample-exact edges); a number = a constant (the k-rate /
   *  "constant this block" single-element AudioParam shape). */
  params: Record<string, Float32Array | number>;
  /** Output names in WORKLET OUTPUT INDEX order. The returned record is keyed
   *  by these (ready for `pinAll`); every declared output is collected. */
  outputs: readonly string[];
  blockSize?: number;
}

/**
 * Pump a captured processor through `process()` in fixed-size blocks (the
 * real worklet cadence) and collect every declared mono output full-length.
 */
export function renderWorklet(
  proc: WorkletProcessorLike,
  opts: WorkletRenderOptions,
): Record<string, Float32Array> {
  const block = opts.blockSize ?? 128;
  const n = opts.totalSamples;

  const constParams: Record<string, Float32Array> = {};
  const arrayParams: Array<[string, Float32Array]> = [];
  for (const [name, v] of Object.entries(opts.params)) {
    if (typeof v === 'number') constParams[name] = new Float32Array([v]);
    else {
      if (v.length !== n) {
        throw new Error(`renderWorklet: a-rate param '${name}' length ${v.length} != totalSamples ${n}`);
      }
      arrayParams.push([name, v]);
    }
  }

  const outs = opts.outputs.map(() => new Float32Array(n));
  const outBlocks = opts.outputs.map(() => new Float32Array(block));

  for (let start = 0; start < n; start += block) {
    const len = Math.min(block, n - start);
    const inputs: Float32Array[][] = opts.inputs.map((buf) =>
      buf ? [buf.subarray(start, start + len)] : [],
    );
    const outputs: Float32Array[][] = outBlocks.map((b) => {
      b.fill(0);
      return [b.subarray(0, len)];
    });
    const params: Record<string, Float32Array> = { ...constParams };
    for (const [name, sched] of arrayParams) {
      params[name] = sched.subarray(start, start + len);
    }
    proc.process(inputs, outputs, params);
    for (let k = 0; k < outs.length; k++) {
      outs[k]!.set(outBlocks[k]!.subarray(0, len), start);
    }
  }

  const record: Record<string, Float32Array> = {};
  opts.outputs.forEach((name, k) => {
    record[name] = outs[k]!;
  });
  return record;
}
