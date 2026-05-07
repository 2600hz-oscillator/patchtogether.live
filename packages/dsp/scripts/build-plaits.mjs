// packages/dsp/scripts/build-plaits.mjs
//
// Build the vendored Mutable Instruments Plaits engine subset to
// dist/plaits.wasm (raw wasm — no Emscripten JS glue), then esbuild the
// worklet processor TS to dist/plaits.worklet.js with the wasm inlined as
// base64.  Inlining avoids the cross-thread fetch dance you'd otherwise
// need to load wasm inside an AudioWorkletGlobalScope on Cloudflare Workers
// / Pages where relative URLs from the worklet aren't always resolvable.
//
// We emit a *standalone* wasm (no Emscripten env imports) by linking with
// `-s STANDALONE_WASM=1` and `-s ENVIRONMENT=worker -s MINIMAL_RUNTIME=2`.
// In practice we need a few imports anyway (libc memcpy/memset go through
// the wasm builtin) — Emscripten resolves those internally.
//
// Composite SHA: SHA256 of the worklet TS source XOR'd with a list of all
// vendored .cc/.h SHAs.  Drives ART baseline pinning per D17.

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuildBuild } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const VENDOR_DIR = join(PKG_ROOT, 'vendor', 'plaits');
const GLUE_DIR = join(PKG_ROOT, 'src', 'plaits-glue');
const DIST_DIR = join(PKG_ROOT, 'dist');

async function emccAvailable() {
  return new Promise((resolve) => {
    const c = spawn('emcc', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    c.on('error', () => resolve(false));
    c.on('close', (code) => resolve(code === 0));
  });
}

async function findCcSources() {
  const cc = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.name.endsWith('.cc')) cc.push(p);
    }
  }
  await walk(VENDOR_DIR);
  cc.push(join(GLUE_DIR, 'worklet.cc'));
  return cc;
}

async function shaOfFile(p) {
  const h = createHash('sha256');
  h.update(await readFile(p));
  return h.digest('hex');
}

async function vendorShaSet() {
  const all = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else all.push(p);
    }
  }
  await walk(VENDOR_DIR);
  all.sort();
  const h = createHash('sha256');
  for (const p of all) {
    h.update(relative(VENDOR_DIR, p));
    h.update('\0');
    h.update(await readFile(p));
  }
  return h.digest('hex').slice(0, 16);
}

function runEmcc(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('emcc', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`emcc exited ${code}\nstderr:\n${stderr}\nstdout:\n${stdout}`));
    });
  });
}

async function buildWasm() {
  const cc = await findCcSources();
  await mkdir(DIST_DIR, { recursive: true });
  const wasmOut = join(DIST_DIR, 'plaits.wasm');

  const exports = [
    '_plaits_create',
    '_plaits_destroy',
    '_plaits_render',
    '_plaits_reset',
    '_malloc',
    '_free',
  ];

  const args = [
    '-O2',
    '-DNDEBUG',
    // stmlib's dsp.h has Cortex-M-specific inline asm (`ssat`/`vsqrt.f32`)
    // gated by `#ifndef TEST`. Defining TEST gives us the portable C
    // fallbacks instead of the ARM intrinsics that don't compile under
    // wasm32 LLVM.
    '-DTEST',
    '-fno-exceptions',
    '-fno-rtti',
    '-std=c++17',
    `-I`, VENDOR_DIR,
    ...cc,
    '-s', 'WASM=1',
    '-s', 'STANDALONE_WASM=0',
    '-s', 'SIDE_MODULE=0',
    '-s', 'EXPORTED_FUNCTIONS=' + JSON.stringify(exports),
    '-s', 'EXPORTED_RUNTIME_METHODS=[]',
    '-s', 'INITIAL_MEMORY=4194304',
    '-s', 'ALLOW_MEMORY_GROWTH=1',
    '-s', 'MALLOC=emmalloc',
    '-s', 'ENVIRONMENT=worker',
    '-s', 'FILESYSTEM=0',
    '-s', 'ASSERTIONS=0',
    '-s', 'STRICT=1',
    '-s', 'MINIMAL_RUNTIME=0',
    // Don't link a `main()` — we drive the wasm explicitly. But DO export
    // `__wasm_call_ctors` so JS can run global C++ constructors before the
    // first plaits_* call. Without this, static const arrays in
    // resources.cc get zero-initialized memory access patterns wrong and
    // we hit "memory access out of bounds" on first render.
    '-Wl,--no-entry',
    '-Wl,--export=__wasm_call_ctors',
    '-o', wasmOut,
  ];

  console.log(`emcc: ${cc.length} C++ source(s) → ${wasmOut}`);
  await runEmcc(args);

  if (!existsSync(wasmOut)) {
    throw new Error(`emcc did not produce ${wasmOut}`);
  }
  const sz = (await stat(wasmOut)).size;
  console.log(`  wasm size: ${(sz / 1024).toFixed(1)} KiB`);
  return wasmOut;
}

async function buildWorklet(wasmPath) {
  const tsEntry = join(GLUE_DIR, 'processor.ts');
  if (!existsSync(tsEntry)) {
    throw new Error(`Missing TS entry: ${tsEntry}`);
  }
  // Inline the wasm bytes as a base64 string the worklet decodes at boot.
  const wasmBytes = await readFile(wasmPath);
  const b64 = wasmBytes.toString('base64');
  const tmp = join(DIST_DIR, '__plaits-wasm-b64.ts');
  await writeFile(tmp, `export const PLAITS_WASM_B64: string = ${JSON.stringify(b64)};\n`);

  await esbuildBuild({
    entryPoints: [tsEntry],
    outfile: join(DIST_DIR, 'plaits.worklet.js'),
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    sourcemap: false,
    logLevel: 'silent',
    alias: {
      // processor.ts imports from '@plaits-wasm-bytes' so this build script
      // can swap in the freshly-built wasm without polluting the TS source
      // tree.
      '@plaits-wasm-bytes': tmp,
    },
  });
}

async function main() {
  const haveEmcc = await emccAvailable();
  if (!haveEmcc) {
    console.warn(
      '[build-plaits] emcc not found on PATH. Skipping plaits wasm build.\n' +
        '  Add emscripten to flox manifest or install via package manager,\n' +
        '  then re-run `flox activate -- task dsp:build:plaits`.',
    );
    return;
  }
  if (!existsSync(VENDOR_DIR)) {
    console.warn(
      '[build-plaits] vendor/plaits not found.\n' +
        '  Run `flox activate -- task dsp:vendor:plaits` first (with PLAITS_SRC pointing\n' +
        '  at your eurorack checkout).',
    );
    return;
  }

  const wasmPath = await buildWasm();
  await buildWorklet(wasmPath);

  // SHA-pin the artifact for ART (D17). Composite over the worklet TS plus
  // every vendored file — any of those changing should flag a baseline
  // refresh.
  const tsSha = await shaOfFile(join(GLUE_DIR, 'processor.ts'));
  const vendorSha = await vendorShaSet();
  const composite = createHash('sha256')
    .update(tsSha + ':' + vendorSha)
    .digest('hex')
    .slice(0, 16);
  await writeFile(join(DIST_DIR, 'plaits.sha'), composite);
  console.log(`✓ plaits        sha=${composite}`);
}

main().catch((err) => {
  console.error('\n✗ build-plaits failed:');
  console.error(err.message || err);
  process.exit(1);
});
