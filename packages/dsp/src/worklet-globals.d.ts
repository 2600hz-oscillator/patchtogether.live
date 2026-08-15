// AudioWorkletGlobalScope ambients — declared ONCE for the whole package (#1604).
//
// Every worklet source used to carry its own `declare class
// AudioWorkletProcessor` / `declare function registerProcessor` / `declare
// const sampleRate` block. Each file is a standalone compilation unit at BUILD
// time (esbuild bundles worklets separately), so the copies never met — but
// one tsc program merges global ambients across the non-module sources, and
// the per-file copies collided (TS2300/TS2451), burying the package's real
// type errors behind ~28 duplicates. One ambient file, zero collisions.
//
// TypeScript's lib.dom.d.ts deliberately omits these (they exist only inside
// AudioWorkletGlobalScope), so declaring them here conflicts with nothing.
// Worklet sources that are modules see these as globals exactly like the
// bundled runtime does; the vitest shims that assign onto `globalThis` keep
// working because ambients are erased at build time.

declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  ctor: typeof AudioWorkletProcessor,
): void;

/** Sample rate of the AudioContext that owns this worklet scope. */
declare const sampleRate: number;

/** Frame counter of the worklet scope (128-frame quanta). */
declare const currentFrame: number;

/** Context time, seconds, of the worklet scope. */
declare const currentTime: number;
