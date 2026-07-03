// art/setup/faust-offline.ts
//
// Shared FAUST-IN-NODE offline capture path for ART audio profiles (backfill
// batch 6 — spec §5 "Faust-only modules" / §7 Q3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md).
//
// THE PROBLEM this solves. Most of the remaining audio backlog is Faust: the
// module's shipping DSP is a `.dsp` compiled to a `.wasm` and hosted in the
// browser as an AudioWorklet (packages/dsp/dist/<name>.{wasm,json,worklet.js},
// instantiated by faust-runtime.ts's instantiateFaustModule). The ART node
// lane had NO way to render those offline: node-web-audio-api cannot host a
// custom AudioWorklet, so the pattern-3 renderOfflineDef (native nodes) and
// the pattern-2 renderWorklet (self-contained TS process()) both dead-end on
// a Faust module — and there is no pure-TS core to mirror (pattern-1) either.
//
// THE APPROACH that works (proven on vca/reverb/mixmstrs before pinning). The
// SAME @grame/faustwasm package the browser runtime uses ships a HEADLESS
// offline renderer — FaustMonoOfflineProcessor — that pumps the compiled wasm
// through the DSP's `compute()` in fixed blocks with NO AudioContext at all.
// We load the module's already-committed dist artifacts directly from disk
// (the exact bytes the browser ships), build the DSP factory in-process
// (bypassing faust-runtime's browser `fetch`), set the Faust UI params, drive
// the audio inputs, and collect every output. It renders the ACTUAL shipped
// Faust DSP — zero mirror, zero drift — and is byte-deterministic in-process
// AND across processes (verified before pinning, the pattern-3 discipline).
//
// A scenario declares: the dist stem `name`, a driver buffer per FAUST AUDIO
// INPUT index (see ./drivers), the Faust params by shortname (e.g. `base`,
// `cutoff` — resolved to the full `/VCA/base` address internally), and the
// output NAMES in FAUST OUTPUT INDEX order (the returned record is keyed by
// these, ready for pinAll). This mirrors renderWorklet's index-based contract.
//
// The .sha pins the `.dsp` source (dspSourceSha('<name>.dsp')) — the same hash
// the build writes to dist/<name>.sha — so a recompiled DSP invalidates the
// baseline. We ALSO guard that the committed dist is FRESH (dist .sha ===
// source .sha) so a stale local build can't silently render old audio (the
// CLAUDE.md `rm -rf dist` / clean-state concern, enforced in-process).

// Import the ESM build entry EXPLICITLY: @grame/faustwasm's package.json `main`
// is an IIFE bundle (dist/cjs/index.js) whose named exports vitest/vite resolve
// to `undefined`; the `module` entry (dist/esm/index.js) is real ESM. The pkg
// has no `exports` map, so this subpath resolves in both Node and Vite.
import { FaustWasmInstantiator, FaustMonoWebAudioDsp, FaustMonoOfflineProcessor } from '@grame/faustwasm/dist/esm/index.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { SAMPLE_RATE, DSP_DIST_DIR, DSP_SRC_DIR, builtSha } from './render';

/** The real worklet cadence: Faust computes in 128-sample control blocks. */
const DEFAULT_BLOCK = 128;

/** Build the in-process DSP factory from the committed dist bytes.
 *  Mirrors FaustWasmInstantiator.loadDSPFactory but reads from disk instead of
 *  `fetch` (which does not do file:// URLs in Node). */
async function loadFactoryFromDist(name: string): Promise<{ factory: any; meta: any }> {
  const wasm = await readFile(join(DSP_DIST_DIR, `${name}.wasm`));
  const module = await WebAssembly.compile(wasm);
  const json = await readFile(join(DSP_DIST_DIR, `${name}.json`), 'utf8');
  const meta = JSON.parse(json);
  const poly = String(meta.compile_options).indexOf('wasm-e') !== -1;
  const factory = { cfactory: 0, code: new Uint8Array(wasm), module, json, poly };
  return { factory, meta };
}

/** Short sha256 of a `.dsp` source (matches build.mjs / moduleSourceSha). */
async function dspFileSha(name: string): Promise<string> {
  const src = await readFile(join(DSP_SRC_DIR, `${name}.dsp`), 'utf8');
  return createHash('sha256').update(src).digest('hex').slice(0, 16);
}

export interface FaustOfflineOptions {
  /** dist stem — matches packages/dsp/dist/<name>.{wasm,json} AND the
   *  packages/dsp/src/<name>.dsp source. */
  name: string;
  /** Total samples to render. */
  totalSamples: number;
  /** Driver buffer per FAUST AUDIO INPUT index (the same order the module's
   *  factory wires its input ports onto the ChannelMerger). `null`/omitted =
   *  silence on that input. Shorter arrays are padded with silence. */
  inputs?: ReadonlyArray<Float32Array | null>;
  /** Faust UI params by SHORTNAME (the trailing path segment — `base`,
   *  `cutoff`, `ch1_volume`). Resolved to the full `/Label/name` address via
   *  the DSP's own getParams(). A full `/…` address is also accepted. */
  params?: Record<string, number>;
  /** Output NAMES in FAUST OUTPUT INDEX order (position k = Faust output k).
   *  The returned record is keyed by these — ready for pinAll. Capture a
   *  PREFIX of the outputs to keep just the signature ports (e.g. mixmstrs'
   *  first 6 patchable outs, dropping the 6 trailing meter taps). */
  outputs: readonly string[];
  sampleRate?: number;
  blockSize?: number;
}

/**
 * Render a compiled Faust module offline (headless, no AudioContext) and
 * capture the declared outputs. Returns `Record<outputName, Float32Array>`
 * ready for `pinAll` / assertions.
 */
export async function renderFaustOffline(
  opts: FaustOfflineOptions,
): Promise<Record<string, Float32Array>> {
  // Stale-dist guard: the committed wasm MUST have been built from the current
  // .dsp, else we'd profile audio the source no longer produces.
  const srcSha = await dspFileSha(opts.name);
  const distSha = await builtSha(opts.name);
  if (distSha !== srcSha) {
    throw new Error(
      `renderFaustOffline(${opts.name}): dist is STALE (dist .sha ${distSha} != ` +
        `source ${srcSha}). Rebuild it (\`flox activate -- task dsp:build\`, or ` +
        `\`node packages/dsp/scripts/build.mjs ${opts.name}\`) before profiling.`,
    );
  }

  const sr = opts.sampleRate ?? SAMPLE_RATE;
  const block = opts.blockSize ?? DEFAULT_BLOCK;
  const { factory, meta } = await loadFactoryFromDist(opts.name);

  const instance = await FaustWasmInstantiator.createAsyncMonoDSPInstance(factory);
  const sampleSize = String(meta.compile_options).match('-double') ? 8 : 4;
  const dsp = new FaustMonoWebAudioDsp(instance, sr, sampleSize, block, factory.soundfiles);
  const proc = new FaustMonoOfflineProcessor(dsp, block);

  const numIn = proc.getNumInputs();
  const numOut = proc.getNumOutputs();
  if (opts.outputs.length > numOut) {
    throw new Error(
      `renderFaustOffline(${opts.name}): declared ${opts.outputs.length} outputs but the DSP has only ${numOut}`,
    );
  }
  if ((opts.inputs?.length ?? 0) > numIn) {
    throw new Error(
      `renderFaustOffline(${opts.name}): declared ${opts.inputs!.length} inputs but the DSP has only ${numIn}`,
    );
  }

  // Params by shortname → full address.
  if (opts.params) {
    const addrByShort = new Map<string, string>();
    for (const addr of proc.getParams()) addrByShort.set(addr.split('/').pop()!, addr);
    for (const [key, value] of Object.entries(opts.params)) {
      const addr = key.startsWith('/') ? key : addrByShort.get(key);
      if (!addr) {
        throw new Error(
          `renderFaustOffline(${opts.name}): unknown param '${key}'. ` +
            `Known: ${[...addrByShort.keys()].join(', ')}`,
        );
      }
      proc.setParamValue(addr, value);
    }
  }

  // Build the full input set by index, padding unpatched/short inputs with
  // silence (Faust's compute() reads every declared input each block).
  const inputs: Float32Array[] = [];
  for (let i = 0; i < numIn; i++) {
    const buf = opts.inputs?.[i] ?? null;
    if (buf && buf.length !== opts.totalSamples) {
      throw new Error(
        `renderFaustOffline(${opts.name}): input ${i} length ${buf.length} != totalSamples ${opts.totalSamples}`,
      );
    }
    inputs.push(buf ?? new Float32Array(opts.totalSamples));
  }

  const rendered = proc.render(inputs, opts.totalSamples);
  const record: Record<string, Float32Array> = {};
  opts.outputs.forEach((name, k) => {
    record[name] = rendered[k]!;
  });
  return record;
}
