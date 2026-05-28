#!/usr/bin/env node
// scripts/extract-sm64-idb.mjs
//
// Drive the upstream sm64js bundle once with a real US sm64.z64 ROM and
// dump the resulting IDB('assets') blob to e2e/fixtures/sm64-idb.bin
// — the artifact the SM64 e2e spec seeds to boot the engine without an
// interactive upload step.
//
// USAGE:
//   flox activate -- node scripts/extract-sm64-idb.mjs /path/to/your/sm64.z64
//
// The script:
//   1. Spawns the dev server (`flox activate -- npm --workspace @patchtogether/web run dev`)
//      on a free port + waits for it to be ready.
//   2. Launches a headed Chromium via Playwright.
//   3. Spawns an SM64 module.
//   4. Programmatically sets the #romFile input + submits the form.
//   5. Polls `idb-keyval.get('assets')` until the extracted blob arrives.
//   6. Reads the raw bytes out of IndexedDB + writes to
//      e2e/fixtures/sm64-idb.bin.
//
// Prerequisites:
//   - flox env active (Playwright + Chromium are managed there).
//   - A US sm64.z64 ROM (the bundle rejects EU/JP ROMs at the header
//     check — see romTextureLoader.js).
//
// The fixture is LFS-tracked; the committed bytes are a derivative of the
// Nintendo-owned game data + only useful in combination with the upstream
// sm64js bundle. Per the owner's clearance memo, distribution under the
// repo's terms is acceptable.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_PATH = path.join(REPO_ROOT, 'e2e', 'fixtures', 'sm64-idb.bin');

function die(msg) {
  console.error(`[extract-sm64-idb] ${msg}`);
  process.exit(1);
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const port = /** @type {{ port: number }} */ (srv.address()).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForReady(url, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 304) return;
    } catch (_e) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  die(`dev server didn't come up at ${url} within ${deadlineMs}ms`);
}

const romArg = process.argv[2];
if (!romArg) {
  die(
    `usage: node scripts/extract-sm64-idb.mjs <path-to-sm64.z64>\n` +
    `(see packages/web/native/sm64js/README.md for the full recipe)`,
  );
}
const romPath = path.resolve(romArg);
if (!fs.existsSync(romPath)) die(`ROM file not found: ${romPath}`);

const port = await pickFreePort();
const url = `http://localhost:${port}/`;

console.log(`[extract-sm64-idb] starting dev server on :${port}`);
const dev = spawn(
  'flox',
  ['activate', '--', 'npm', '--workspace', '@patchtogether/web', 'run', 'dev', '--', `--port=${port}`, '--strictPort'],
  { cwd: REPO_ROOT, stdio: ['ignore', 'inherit', 'inherit'], detached: false },
);
process.on('exit', () => { try { process.kill(-dev.pid); } catch (_e) { /* */ } });

await waitForReady(url, 60_000);

// Lazy-import playwright; the script fails fast if it's not in the flox env.
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();

console.log(`[extract-sm64-idb] navigating to ${url}`);
await page.goto(url);
await page.waitForLoadState('networkidle');

// Use the same dev test hook the e2e specs use (Canvas.svelte exposes
// __patch + __ydoc + the engine in dev).
await page.waitForFunction(() => (globalThis).__patch !== undefined, { timeout: 30_000 });

console.log(`[extract-sm64-idb] spawning sm64 module`);
await page.evaluate(() => {
  const w = /** @type {any} */ (globalThis);
  const id = 'extract-sm64';
  w.__ydoc.transact(() => {
    w.__patch.nodes[id] = {
      id, type: 'sm64', domain: 'audio',
      position: { x: 100, y: 100 },
      params: {},
      data: {},
    };
  });
  return id;
});

// Wait for the card to mount + the bundle to be loaded + the upload form
// to appear (the upstream's `#rom` div unhides only when checkForRom()
// resolves null — which it will, since we haven't seeded anything yet).
console.log(`[extract-sm64-idb] waiting for #rom upload form to appear`);
await page.waitForSelector('#rom', { state: 'attached', timeout: 30_000 });
// The upstream toggles the `hidden` attr on the #rom div from JS; wait
// for it to be unhidden too (means the bundle's checkForRom().then ran).
await page.waitForFunction(() => {
  const el = document.getElementById('rom');
  return el && el.hidden === false;
}, { timeout: 30_000 });

console.log(`[extract-sm64-idb] uploading ${romPath}`);
const fileInput = await page.$('#romFile');
if (!fileInput) die('#romFile input not found');
await fileInput.setInputFiles(romPath);
// Submit the form. The upstream's romSelect.addEventListener('submit') calls
// extractAssetsFromRom().
await page.evaluate(() => {
  const form = /** @type {HTMLFormElement | null} */ (document.getElementById('romSelect'));
  if (!form) throw new Error('#romSelect form missing');
  form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
});

console.log(`[extract-sm64-idb] waiting for IDB('assets') to populate (~10-30 s)`);
const assetsAsArray = await page.waitForFunction(async () => {
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('keyval-store', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const v = await new Promise((resolve, reject) => {
      const tx = /** @type {any} */ (db).transaction('keyval', 'readonly');
      const store = tx.objectStore('keyval');
      const req = store.get('assets');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    /** @type {any} */ (db).close();
    return v ? Array.from(/** @type {Uint8Array} */ (v)) : null;
  } catch (_e) { return null; }
}, undefined, { timeout: 120_000 });

const bytes = Buffer.from(await assetsAsArray.jsonValue());

console.log(`[extract-sm64-idb] writing ${bytes.length.toLocaleString()} bytes → ${FIXTURE_PATH}`);
fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
fs.writeFileSync(FIXTURE_PATH, bytes);

await browser.close();
try { process.kill(-dev.pid); } catch (_e) { /* */ }
console.log(`[extract-sm64-idb] done. Add the fixture to git via:`);
console.log(`    flox activate -- git add ${path.relative(REPO_ROOT, FIXTURE_PATH)}`);
process.exit(0);
