// packages/dsp/scripts/build-worklet.mjs
//
// Pre-bundle a Faust AudioWorklet processor at build time.
//
// @grame/faustwasm normally builds the processor JS at runtime by stitching
// `${SomeClass.name}` + `${SomeClass.toString()}` into a string and shipping
// it via URL.createObjectURL → addModule. That breaks under Vite's prod
// minification: Rollup renames the classes (FaustDspInstance → `xs`/`ks`/etc.)
// before any minifier sees them; the inlined .toString() bodies then
// reference renamed identifiers that Faust's template doesn't redeclare,
// and the worklet throws `xs is not defined` inside AudioWorkletGlobalScope.
// (See .myrobots/plans/minification-fix.md for the long story — esbuild
// keepNames and terser keep_classnames both proved insufficient because
// the rename happens in Rollup's bundling step.)
//
// Workaround: invoke Faust's own template HERE in Node where the classes
// are not minified. Capture the resulting source by monkey-patching Blob and
// stubbing AudioWorkletNode so `createNode` reaches the string-build step
// and then exits cleanly. Write the captured source to dist/<name>.worklet.js.
//
// At runtime the browser does:
//   await ctx.audioWorklet.addModule('<name>.worklet.js')
//   new AudioWorkletNode(ctx, processorName, { processorOptions: { factory, ... } })
// — no .toString()-stitching path involved, so minification is a non-issue.
//
// Note the deep import path. @grame/faustwasm's package.json sets `main` to
// the CJS bundle and `type: module`; without that explicit `dist/esm/...`
// path, Node loads the CJS-as-ESM and the named exports don't surface.

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Stub AudioWorkletNode BEFORE importing @grame/faustwasm so the package's
// `class FaustAudioWorkletNode extends AudioWorkletNode {}` declaration
// resolves the parent class against our stub. (Faust does the lookup at
// module load via top-level scope, not lazily — without this stub we get
// "Super constructor null" before reaching the createNode call.)
globalThis.AudioWorkletNode = class StubAudioWorkletNode {
  constructor() {
    throw new Error('STUB_AUDIO_WORKLET_NODE');
  }
};

const { FaustMonoDspGenerator } = await import('@grame/faustwasm/dist/esm/index.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const DIST_DIR = join(PKG_ROOT, 'dist');

/**
 * Build a self-contained worklet processor JS file for a single Faust module.
 * `name` matches the dist/<name>.{wasm,json} stem.
 */
export async function buildWorkletForModule(name) {
  const wasmPath = join(DIST_DIR, `${name}.wasm`);
  const metaPath = join(DIST_DIR, `${name}.json`);

  // Capture the processorCode that FaustMonoDspGenerator.createNode would
  // build by intercepting the Blob constructor. Faust calls it as
  // `new Blob([processorCode], { type: 'text/javascript' })`.
  let captured = null;
  const originalBlob = globalThis.Blob;
  globalThis.Blob = class CapturingBlob extends originalBlob {
    constructor(parts, options) {
      super(parts, options);
      if (Array.isArray(parts) && typeof parts[0] === 'string') {
        captured = parts[0];
      }
    }
  };

  // AudioWorkletNode is already stubbed at module-load (see top of file).
  // Just provide a minimal AudioContext for createNode to walk through.
  const stubContext = {
    sampleRate: 48000,
    audioWorklet: { addModule: async () => {} },
  };

  try {
    // FaustWasmInstantiator.loadDSPFactory uses fetch() which Node doesn't
    // support for file:// URLs. Replicate its body inline using Node's fs +
    // WebAssembly.compile (the structure is { cfactory, code, module, json,
    // poly } — match exactly).
    const wasmBytes = await readFile(wasmPath);
    const json = await readFile(metaPath, 'utf8');
    const module = await WebAssembly.compile(wasmBytes);
    const meta = JSON.parse(json);
    const factory = {
      cfactory: 0,
      code: new Uint8Array(wasmBytes.buffer, wasmBytes.byteOffset, wasmBytes.byteLength),
      module,
      json,
      poly: meta.compile_options.indexOf('wasm-e') !== -1,
    };
    const generator = new FaustMonoDspGenerator();
    await generator.createNode(stubContext, name, factory);
  } catch (e) {
    if (e?.message !== 'STUB_AUDIO_WORKLET_NODE') {
      throw e;
    }
  } finally {
    globalThis.Blob = originalBlob;
  }

  if (!captured) {
    throw new Error(
      `Failed to capture worklet code for ${name}: Blob constructor was never called. ` +
        `Faust's template path may have changed.`,
    );
  }

  const workletPath = join(DIST_DIR, `${name}.worklet.js`);
  await writeFile(workletPath, captured);
  return { name, workletPath, bytes: captured.length };
}

// CLI mode: `node build-worklet.mjs <name1> [name2...]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const names = process.argv.slice(2);
  if (names.length === 0) {
    console.error('usage: build-worklet.mjs <module-name> [module-name...]');
    process.exit(1);
  }
  for (const name of names) {
    const result = await buildWorkletForModule(name);
    console.log(`✓ worklet ${result.name.padEnd(20)} ${result.bytes} bytes`);
  }
}
