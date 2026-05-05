// packages/dsp/scripts/watch.mjs
//
// Watches src/ for changes and rebuilds individual modules. Per D17:
// hot-swap from day 1 — when a module rebuilds, dist/<name>.{js,wasm,sha}
// updates and the web app's Vite plugin picks it up.

import chokidar from 'chokidar';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join, basename, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const SRC_DIR = join(PKG_ROOT, 'src');
const DIST_DIR = join(PKG_ROOT, 'dist');

console.log(`👀 watching ${SRC_DIR}`);

const watcher = chokidar.watch(SRC_DIR, {
  ignored: /(^|[\/\\])\../,
  persistent: true,
  ignoreInitial: true,
});

let queue = Promise.resolve();
function rebuild(file) {
  const name = basename(file, extname(file));
  queue = queue.then(
    () =>
      new Promise((resolve) => {
        const t0 = Date.now();
        const child = spawn(process.execPath, [join(__dirname, 'build.mjs'), name], {
          cwd: PKG_ROOT,
          stdio: 'inherit',
        });
        child.on('close', (code) => {
          const dur = Date.now() - t0;
          if (code === 0) {
            console.log(`   rebuilt ${name} in ${dur}ms`);
          } else {
            console.error(`   ✗ ${name} failed (exit ${code})`);
          }
          resolve();
        });
      })
  );
}

watcher.on('change', rebuild);
watcher.on('add', rebuild);
watcher.on('unlink', async (file) => {
  // Source removed → clean up its dist/ artifacts so stale wasm/js doesn't
  // linger and trick the engine into loading a deleted module.
  const name = basename(file, extname(file));
  const targets = [`${name}.wasm`, `${name}.json`, `${name}.js`, `${name}.js.map`, `${name}.sha`];
  for (const t of targets) {
    await rm(join(DIST_DIR, t), { force: true });
  }
  console.log(`   removed dist/ artifacts for ${name}`);
});

// Initial full build
queue = queue.then(
  () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [join(__dirname, 'build.mjs')], {
        cwd: PKG_ROOT,
        stdio: 'inherit',
      });
      child.on('close', () => resolve());
    })
);
