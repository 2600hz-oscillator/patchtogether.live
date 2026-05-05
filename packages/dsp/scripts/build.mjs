// packages/dsp/scripts/build.mjs
//
// Build pipeline for DSP modules.
//   *.dsp → dist/<name>.wasm + dist/<name>.json (via @grame/faustwasm CLI)
//   *.ts  → dist/<name>.js (via esbuild, ESM bundle for AudioWorkletProcessor)
//
// Each output is paired with dist/<name>.sha — the SHA-256 of the source file
// truncated to 16 hex chars — for ART baseline pinning per D17 / D19.
//
// Usage:
//   node scripts/build.mjs               # full build
//   node scripts/build.mjs <name>        # rebuild one module by name

import { mkdir, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join, basename, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuildBuild } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const SRC_DIR = join(PKG_ROOT, 'src');
const DIST_DIR = join(PKG_ROOT, 'dist');
const FAUST2WASM = join(
  PKG_ROOT,
  '..',
  '..',
  'node_modules',
  '@grame',
  'faustwasm',
  'scripts',
  'faust2wasm.js'
);

const onlyName = process.argv[2];

await mkdir(DIST_DIR, { recursive: true });

function shortSha(str) {
  return createHash('sha256').update(str).digest('hex').slice(0, 16);
}

function runFaust2Wasm(dspPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [FAUST2WASM, dspPath, DIST_DIR, '-no-template'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stderr = '';
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`faust2wasm exited ${code}\n${stderr}`));
    });
  });
}

async function buildDsp(filePath) {
  const name = basename(filePath, '.dsp');
  if (onlyName && onlyName !== name) return null;
  const source = await readFile(filePath, 'utf8');
  const sha = shortSha(source);
  // faust2wasm emits fixed filenames (dsp-module.wasm / dsp-meta.json);
  // rename them per-module so multiple modules can coexist in dist/.
  await runFaust2Wasm(filePath);
  const fixedWasm = join(DIST_DIR, 'dsp-module.wasm');
  const fixedMeta = join(DIST_DIR, 'dsp-meta.json');
  if (existsSync(fixedWasm)) {
    const target = join(DIST_DIR, `${name}.wasm`);
    if (existsSync(target)) await rm(target);
    await rename(fixedWasm, target);
  } else {
    throw new Error(`faust2wasm did not produce dsp-module.wasm for ${name}`);
  }
  if (existsSync(fixedMeta)) {
    const target = join(DIST_DIR, `${name}.json`);
    if (existsSync(target)) await rm(target);
    await rename(fixedMeta, target);
  }
  await writeFile(join(DIST_DIR, `${name}.sha`), sha);
  return { name, kind: 'faust', sha };
}

async function buildTs(filePath) {
  const name = basename(filePath, '.ts');
  if (onlyName && onlyName !== name) return null;
  const source = await readFile(filePath, 'utf8');
  const sha = shortSha(source);
  await esbuildBuild({
    entryPoints: [filePath],
    outfile: join(DIST_DIR, `${name}.js`),
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    sourcemap: true,
    logLevel: 'silent',
  });
  await writeFile(join(DIST_DIR, `${name}.sha`), sha);
  return { name, kind: 'worklet', sha };
}

async function main() {
  const entries = await readdir(SRC_DIR);
  const dspFiles = entries.filter((f) => f.endsWith('.dsp')).map((f) => join(SRC_DIR, f));
  const tsFiles = entries.filter((f) => f.endsWith('.ts')).map((f) => join(SRC_DIR, f));

  const built = [];
  for (const f of dspFiles) {
    const r = await buildDsp(f);
    if (r) built.push(r);
  }
  for (const f of tsFiles) {
    const r = await buildTs(f);
    if (r) built.push(r);
  }

  for (const b of built) {
    console.log(`✓ ${b.kind.padEnd(7)} ${b.name.padEnd(20)} sha=${b.sha}`);
  }
  console.log(`\nBuilt ${built.length} module(s) → ${DIST_DIR}`);
}

main().catch((err) => {
  console.error('\n✗ Build failed:');
  console.error(err.message || err);
  process.exit(1);
});
