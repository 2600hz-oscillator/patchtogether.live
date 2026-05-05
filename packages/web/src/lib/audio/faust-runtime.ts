// packages/web/src/lib/audio/faust-runtime.ts
//
// Minimal runtime helper for instantiating a pre-compiled Faust module
// (.wasm + metadata .json from packages/dsp/dist/) as an AudioWorkletNode.
//
// Day 5 scope: enough to play a single VCO. The full DomainEngine + module
// registry that consumes this lands in Days 6–7.

import { FaustMonoDspGenerator, FaustWasmInstantiator } from '@grame/faustwasm';

export interface FaustModuleArtifact {
  /** DSP module name — matches the build output stem and the Faust processor name. */
  name: string;
  /** URL of the compiled .wasm (use Vite's `?url` import). */
  wasmUrl: string;
  /** URL of the metadata .json. */
  metaUrl: string;
}

/**
 * Load a pre-compiled Faust module's wasm + metadata, build a factory, and
 * create an AudioWorkletNode under the given AudioContext.
 *
 * The returned node has `meta.inputs` audio inputs and `meta.outputs` audio
 * outputs as declared by the Faust source. Faust UI parameters (hslider/nentry)
 * are exposed as AudioParams accessible by their full path.
 */
export async function instantiateFaustModule(
  audioContext: AudioContext,
  artifact: FaustModuleArtifact
): Promise<AudioWorkletNode> {
  const factory = await FaustWasmInstantiator.loadDSPFactory(artifact.wasmUrl, artifact.metaUrl);
  if (!factory) {
    throw new Error(`FaustWasmInstantiator.loadDSPFactory returned null for ${artifact.name}`);
  }
  const generator = new FaustMonoDspGenerator();
  const node = await generator.createNode(audioContext, artifact.name, factory);
  if (!node) {
    throw new Error(`FaustMonoDspGenerator.createNode returned null for ${artifact.name}`);
  }
  return node as unknown as AudioWorkletNode;
}
