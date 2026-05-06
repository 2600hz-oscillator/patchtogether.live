// packages/web/src/lib/audio/faust-runtime.ts
//
// Minimal runtime helper for instantiating a pre-compiled Faust module
// (.wasm + metadata .json + pre-bundled .worklet.js from packages/dsp/dist/)
// as an AudioWorkletNode.

import { FaustMonoAudioWorkletNode, FaustWasmInstantiator } from '@grame/faustwasm';

export interface FaustModuleArtifact {
  /** DSP module name — matches the build output stem and the Faust processor name. */
  name: string;
  /** URL of the compiled .wasm (use Vite's `?url` import). */
  wasmUrl: string;
  /** URL of the metadata .json. */
  metaUrl: string;
  /** URL of the pre-bundled AudioWorklet processor. */
  workletUrl: string;
}

/** Track which (context, processorName) pairs we've already addModule'd. */
const loaded = new WeakMap<BaseAudioContext, Set<string>>();

/**
 * Load a pre-compiled Faust module's wasm + metadata + worklet, register the
 * processor (once per context), and instantiate a FaustMonoAudioWorkletNode.
 *
 * Why the explicit workletUrl: @grame/faustwasm normally builds the worklet
 * processor JS at runtime by concatenating `${SomeClass.name}` +
 * `${SomeClass.toString()}`. That breaks under Vite production minification
 * because Rollup renames the classes before the minifier sees them, and the
 * inlined .toString() bodies reference undefined identifiers inside
 * AudioWorkletGlobalScope. We sidestep the whole runtime-stitching path by
 * pre-bundling the worklet at DSP build time (see
 * packages/dsp/scripts/build-worklet.mjs) and addModule-ing the resulting
 * static .worklet.js here. The parent thread still uses Faust's
 * MonoAudioWorkletNode wrapper to talk to it via port — that wrapper doesn't
 * depend on .toString() and minifies cleanly.
 */
export async function instantiateFaustModule(
  audioContext: AudioContext,
  artifact: FaustModuleArtifact,
): Promise<AudioWorkletNode> {
  let registered = loaded.get(audioContext);
  if (!registered) {
    registered = new Set();
    loaded.set(audioContext, registered);
  }
  if (!registered.has(artifact.name)) {
    await audioContext.audioWorklet.addModule(artifact.workletUrl);
    registered.add(artifact.name);
  }

  const factory = await FaustWasmInstantiator.loadDSPFactory(artifact.wasmUrl, artifact.metaUrl);
  if (!factory) {
    throw new Error(`FaustWasmInstantiator.loadDSPFactory returned null for ${artifact.name}`);
  }

  // sampleSize: 4 = single-precision floats (matches the -single flag baked
  // into our DSP build's compile_options).
  const node = new FaustMonoAudioWorkletNode(audioContext, {
    processorOptions: {
      name: artifact.name,
      factory,
      sampleSize: 4,
    },
  });
  return node as unknown as AudioWorkletNode;
}
