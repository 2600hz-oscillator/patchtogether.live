// art/setup/render.ts
//
// Helpers for ART scenarios:
//   - render({ moduleName, durationS, sampleRate, configure })
//     instantiates a compiled DSP module under an offline render context
//     and returns the rendered Float32Array.
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
  // Optionally pre-render driver function: called per audio block to feed inputs.
  // For Phase 1 toolchain validation this is a placeholder; full implementation
  // pending node-web-audio-api integration.
  configure?: (node: unknown, ctx: unknown) => void | Promise<void>;
}

export interface RenderResult {
  buffer: Float32Array;
  channels: number;
  sampleRate: number;
}

/**
 * Render a single DSP module under OfflineAudioContext-equivalent.
 * Phase-1 stub: full integration with @grame/faustwasm runtime + node-web-audio-api
 * will land in days 4–7 alongside the AudioEngine. This stub asserts that the
 * compiled artifacts exist so the toolchain end-to-end is validated.
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
  // TODO (days 4–7): instantiate via node-web-audio-api OfflineAudioContext +
  //   @grame/faustwasm runtime; drive inputs from opts.configure; render durationS;
  //   return populated Float32Array.
  // For toolchain validation: return a deterministic synthetic buffer so the
  // baseline-comparison round-trip works end-to-end.
  const totalSamples = Math.round(sampleRate * opts.durationS);
  const buffer = new Float32Array(totalSamples);
  // Deterministic placeholder: 440 Hz sine. Replaced when real render lands.
  for (let i = 0; i < totalSamples; i++) {
    buffer[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.1;
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
  // Float32Array view over the buffer's bytes
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
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
