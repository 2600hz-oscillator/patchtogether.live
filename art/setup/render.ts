// art/setup/render.ts
//
// Helpers for ART scenarios:
//   - render({ moduleName, durationS, ... }) instantiates THAT module's
//     compiled DSP under an offline render context and returns the rendered
//     Float32Array. (It dispatches on artifact kind — see render() below.)
//   - compare(rendered, baselinePath) — RMS-threshold + perceptual-hash tiers.
//   - readBaseline / writeBaseline — .f32 binary I/O.

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const SAMPLE_RATE = 48000;
export const ART_DIR = new URL('../', import.meta.url).pathname;
export const DSP_DIST_DIR = new URL('../../packages/dsp/dist/', import.meta.url).pathname;
export const DSP_SRC_DIR = new URL('../../packages/dsp/src/', import.meta.url).pathname;

export interface RenderOptions {
  moduleName: string;
  durationS: number;
  sampleRate?: number;
  /** Params applied to the module: def param ids for worklet-backed modules,
   *  Faust UI shortnames for Faust modules. Omitted params keep their
   *  defaults (the def's `defaultValue` / the DSP's own initial value). */
  params?: Record<string, number>;
  /** Deterministic probe fed to the module's FIRST input.
   *
   *  Defaults to the canonical C4 saw (`drivers.vcoTestSignal`) so a PASSIVE
   *  module (a delay, a mixer, a filter) has something to process — driven
   *  with silence it would honestly render silence, and two silent modules
   *  are byte-identical, which is the very confusion this harness exists to
   *  avoid. Pass `null` for an explicitly undriven render. */
  input?: Float32Array | null;
  /** Which output to return: a def output PORT ID (worklet modules) or an
   *  output INDEX (either kind). Defaults to the module's first output. */
  output?: string | number;
}

export interface RenderResult {
  buffer: Float32Array;
  channels: number;
  sampleRate: number;
}

/** Shape of the fields we read off a module def (structurally typed so this
 *  file needs no value import from packages/web). */
interface DefLike {
  type: string;
  factory: unknown;
  inputs?: ReadonlyArray<{ id: string }>;
  outputs?: ReadonlyArray<{ id: string }>;
}

const isDefLike = (v: unknown): v is DefLike =>
  !!v && typeof v === 'object' && 'type' in v && 'factory' in v;

/** `charlottes-echos` (dist stem) and `charlottesEchos` (def type) are the
 *  same module — compare on alphanumerics only. */
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Locate the module def that OWNS a dist stem, by importing
 * `packages/web/src/lib/audio/modules/<stem>.ts` and picking the def-shaped
 * export. (A value import of the whole registry would need every module to be
 * side-effect registered; the per-file import keeps ART's graph small.)
 */
async function loadDef(moduleName: string): Promise<DefLike> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(
      `../../packages/web/src/lib/audio/modules/${moduleName}.ts`
    )) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(
      `render(${moduleName}): no module def at ` +
        `packages/web/src/lib/audio/modules/${moduleName}.ts — the ART render ` +
        `harness resolves a worklet module's I/O shape from its def. ` +
        `(${(cause as Error).message})`,
    );
  }
  const defs = Object.values(mod).filter(isDefLike);
  if (defs.length === 0) {
    throw new Error(
      `render(${moduleName}): ${moduleName}.ts exports no module def ` +
        `(an object with \`type\` and \`factory\`).`,
    );
  }
  return defs.find((d) => normalize(d.type) === normalize(moduleName)) ?? defs[0]!;
}

/**
 * Render a single DSP module offline and return one of its outputs.
 *
 * Dispatches on the ARTIFACT KIND the build produced, because the two kinds
 * cannot be rendered the same way in Node:
 *
 *   - **Faust** (`dist/<name>.wasm` + `.json`) → `renderFaustOffline`, the
 *     headless @grame/faustwasm processor. The def's own factory cannot be
 *     used here: it resolves the Faust runtime through a browser `fetch`,
 *     which fails in Node with `undefined … loadDSPFactory`.
 *   - **TS worklet** (`dist/<name>.js`) → the SHIPPING `def.factory()` under
 *     node-web-audio-api's OfflineAudioContext (`renderOfflineDef`). Going
 *     through the def — rather than pumping the processor class directly —
 *     is what makes the bus shape correct: a worklet is constructed with an
 *     explicit `numberOfOutputs` (timelorde declares 13) and at least one
 *     module reads `outputs.length`, so a harness that guessed the bus count
 *     would silently render nothing.
 *
 * Determinism: the default probe and every driver are pure functions of their
 * arguments, and the render is offline — two calls are bit-identical.
 */
export async function render(opts: RenderOptions): Promise<RenderResult> {
  const sampleRate = opts.sampleRate ?? SAMPLE_RATE;
  // Verify the build pipeline produced the expected artifacts.
  // Faust modules emit .wasm + .json + .sha; custom-JS worklets emit .js + .sha.
  const wasmPath = join(DSP_DIST_DIR, `${opts.moduleName}.wasm`);
  const jsPath = join(DSP_DIST_DIR, `${opts.moduleName}.js`);
  const shaPath = join(DSP_DIST_DIR, `${opts.moduleName}.sha`);
  if (!existsSync(shaPath)) {
    throw new Error(
      `Compiled artifact missing: ${shaPath}\nDid you run \`npm run build -w packages/dsp\`?`
    );
  }
  if (!existsSync(wasmPath) && !existsSync(jsPath)) {
    throw new Error(
      `Neither ${wasmPath} nor ${jsPath} exists for module ${opts.moduleName}.`
    );
  }

  const totalSamples = Math.round(sampleRate * opts.durationS);
  // Dynamic imports throughout: drivers/offline/faust-offline all import
  // SAMPLE_RATE from THIS file, so a static import would be a cycle.
  let probe: Float32Array | null;
  if (opts.input === null) probe = null;
  else if (opts.input) probe = opts.input;
  else {
    const { vcoTestSignal } = await import('./drivers');
    probe = vcoTestSignal({ totalS: opts.durationS, sampleRate });
  }
  if (probe && probe.length !== totalSamples) {
    throw new Error(
      `render(${opts.moduleName}): input probe length ${probe.length} != ` +
        `totalSamples ${totalSamples} (durationS ${opts.durationS} @ ${sampleRate} Hz).`,
    );
  }

  let buffer: Float32Array;
  if (existsSync(wasmPath)) {
    const { renderFaustOffline } = await import('./faust-offline');
    const index = typeof opts.output === 'number' ? opts.output : 0;
    if (typeof opts.output === 'string') {
      throw new Error(
        `render(${opts.moduleName}): '${opts.output}' — a Faust module's outputs ` +
          `are positional; pass an output INDEX.`,
      );
    }
    // Name outputs 0..index positionally and keep the requested one; Faust
    // output k is at position k, so a prefix is all we need.
    const names = Array.from({ length: index + 1 }, (_, k) => `out${k}`);
    const rendered = await renderFaustOffline({
      name: opts.moduleName,
      totalSamples,
      inputs: probe ? [probe] : [],
      params: opts.params,
      outputs: names,
      sampleRate,
    });
    buffer = rendered[names[index]!]!;
  } else {
    const { renderOfflineDef } = await import('./offline');
    const def = await loadDef(opts.moduleName);
    const outIds = (def.outputs ?? []).map((o) => o.id);
    if (outIds.length === 0) {
      throw new Error(`render(${opts.moduleName}): def '${def.type}' declares no outputs.`);
    }
    let outId: string;
    if (typeof opts.output === 'string') {
      if (!outIds.includes(opts.output)) {
        throw new Error(
          `render(${opts.moduleName}): no output port '${opts.output}'. ` +
            `Known: ${outIds.join(', ')}`,
        );
      }
      outId = opts.output;
    } else {
      const index = opts.output ?? 0;
      if (!outIds[index]) {
        throw new Error(
          `render(${opts.moduleName}): output index ${index} out of range ` +
            `(def '${def.type}' has ${outIds.length}).`,
        );
      }
      outId = outIds[index]!;
    }
    const firstIn = def.inputs?.[0]?.id;
    const rendered = await renderOfflineDef(def as never, {
      durationS: opts.durationS,
      params: opts.params,
      inputs: probe && firstIn ? { [firstIn]: probe } : {},
      outputs: [outId],
      sampleRate,
    });
    buffer = rendered[outId]!;
  }
  return { buffer, channels: 1, sampleRate };
}

/** Compute the SHA-pin for a module's source file (matches build.mjs). */
export async function moduleSourceSha(moduleName: string): Promise<string> {
  const dspPath = join(DSP_SRC_DIR, `${moduleName}.dsp`);
  const tsPath = join(DSP_SRC_DIR, `${moduleName}.ts`);
  const path = existsSync(dspPath) ? dspPath : tsPath;
  const source = await readFile(path, 'utf8');
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

/** Read .sha companion file produced by the build. */
export async function builtSha(moduleName: string): Promise<string> {
  const shaPath = join(DSP_DIST_DIR, `${moduleName}.sha`);
  return (await readFile(shaPath, 'utf8')).trim();
}

/** Read a baseline .f32 file from art/baselines/. */
export async function readBaseline(scenario: string): Promise<Float32Array | null> {
  const path = join(ART_DIR, 'baselines', `${scenario}.f32`);
  if (!existsSync(path)) return null;
  const buf = await readFile(path);
  if (buf.byteLength % 4 !== 0) {
    throw new Error(
      `[ART] Baseline ${path} is ${buf.byteLength} bytes, not a multiple of 4 — file is truncated or corrupt.`,
    );
  }
  // Copy the bytes into a fresh ArrayBuffer to sidestep any byteOffset/alignment
  // weirdness from Buffer pooling. Length is bytes/4 since each float is 4 bytes.
  const copy = new ArrayBuffer(buf.byteLength);
  new Uint8Array(copy).set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  return new Float32Array(copy, 0, buf.byteLength / 4);
}

/** Write a baseline .f32 file (used by `npm run art:update`). */
export async function writeBaseline(scenario: string, data: Float32Array): Promise<void> {
  const path = join(ART_DIR, 'baselines', `${scenario}.f32`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
}

/** Read companion .sha file for a baseline (or null if missing). */
export async function readBaselineSha(scenario: string): Promise<string | null> {
  const path = join(ART_DIR, 'baselines', `${scenario}.sha`);
  if (!existsSync(path)) return null;
  return (await readFile(path, 'utf8')).trim();
}

/** Write companion .sha file alongside a baseline. */
export async function writeBaselineSha(scenario: string, sha: string): Promise<void> {
  const path = join(ART_DIR, 'baselines', `${scenario}.sha`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, sha);
}

export type ComparisonTier = 'A' | 'B' | 'C';
export interface CompareResult {
  pass: boolean;
  tier: ComparisonTier;
  rms: number;
  detail: string;
}

/** Compare rendered buffer to baseline using the requested tier (B by default). */
export function compareBuffers(
  rendered: Float32Array,
  baseline: Float32Array,
  tier: ComparisonTier = 'B',
  threshold = 1e-4
): CompareResult {
  if (rendered.length !== baseline.length) {
    return {
      pass: false,
      tier,
      rms: NaN,
      detail: `length mismatch: rendered ${rendered.length}, baseline ${baseline.length}`,
    };
  }
  let sumSq = 0;
  for (let i = 0; i < rendered.length; i++) {
    const d = rendered[i] - baseline[i];
    sumSq += d * d;
  }
  const rms = Math.sqrt(sumSq / rendered.length);
  switch (tier) {
    case 'A':
      return {
        pass: rms === 0,
        tier,
        rms,
        detail: rms === 0 ? 'bit-identical' : `non-zero rms ${rms}`,
      };
    case 'B':
      return {
        pass: rms < threshold,
        tier,
        rms,
        detail: `rms diff ${rms.toExponential(3)} (threshold ${threshold.toExponential(3)})`,
      };
    case 'C':
      // TODO: mel-spectrogram cosine similarity. Phase 1 stub returns RMS-tiered pass.
      return {
        pass: rms < threshold * 100,
        tier,
        rms,
        detail: `tier C stub (RMS ${rms.toExponential(3)}); mel-spectrogram pending`,
      };
  }
}

export const SHOULD_UPDATE_BASELINES = process.env.UPDATE_BASELINES === '1';
