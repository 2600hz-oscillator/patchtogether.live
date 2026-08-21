#!/usr/bin/env node
// packages/web/scripts/measure-worker-bundle.mjs
//
// Measure the Cloudflare Pages Worker the way Cloudflare does, and attribute
// its weight to individual source files.
//
// WHY THIS EXISTS. The Worker's ceiling is 3 MiB **gzipped** (free plan;
// 10 MiB paid), and nothing in the repo could see the number. Three separate
// diagnoses of "why is the Worker over 3 MiB" were confidently wrong before
// anyone bundled the thing and looked — including a 4.07 MiB figure obtained
// by summing the gzipped sizes of the server chunks that *looked* reachable.
// That method over-counts twice over: it skips esbuild's tree-shaking, it
// loses gzip's cross-file redundancy, and — the part that actually misled —
// it counted `module-manifest.js` (1.75 MiB gzipped), which is NOT in the
// Worker at all. SvelteKit omits fully-prerendered routes' nodes from the
// server manifest, so all four `buildModuleManifest()` importers are already
// unreachable at runtime. Only 12 of 29 nodes ship.
//
// WHAT IS AUTHORITATIVE. `wrangler deploy --dry-run` prints exactly the
// "Total Upload: X KiB / gzip: Y KiB" that Cloudflare enforces, so `--check`
// shells out to wrangler and ratchets THAT number. The esbuild pass below is
// for ATTRIBUTION only (which input contributes how many bytes); it lands
// within ~1 % of wrangler and is not what the gate reads.
//
// Usage, from packages/web (after a build):
//   node scripts/measure-worker-bundle.mjs            # table + wrangler's number
//   node scripts/measure-worker-bundle.mjs --check    # + fail if over the ceiling
//   node scripts/measure-worker-bundle.mjs --json out.json
//
// ⚠ `--check` IS NOW WIRED INTO CI (#2088) — this comment used to say it was
// not, and that gap is exactly what let a Worker 177 KiB over the ceiling reach
// `main`. It runs in the REQUIRED `build` job in ci.yml, as
// `task worker:size:check`, straight after `task build`.
//
// It lives in `build` and not `build-web` on purpose: `build-web` emits the
// PREVIEW bundle with VITE_E2E_HOOKS=1 baked in, which never deploys, so
// ratcheting it would gauge an artifact nothing is subject to. `build` runs the
// production bundler — the same path deploy.yml takes.
//
// It needs no Cloudflare token (`--dry-run` bundles locally) and no network
// (wrangler is already a transitive dep of @sveltejs/adapter-cloudflare), which
// is what makes it safe to run in that deliberately token-free job. ~1.3 s.

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = path.join(WEB, '.svelte-kit/cloudflare/_worker.js');
const KiB = 1024;

// Cloudflare's free-plan Worker ceiling, gzipped.
//
// ⚠ THIS COMMENT USED TO READ "the project is on paid, so this is a self-imposed
// budget, not a hard blocker." THAT IS FALSE AND IT MATTERED (#2088). Cloudflare
// enforced 3 MiB against this project on 2026-08-21 and took `main`'s deploys
// down with it:
//
//   Failed to publish your Function. Got error: Your Worker exceeded the size
//   limit of 3 MiB. Please upgrade to a paid plan to deploy Workers up to 10 MiB.
//
// So whatever the account's Workers plan says, the number the deploy path
// applies to THIS project is 3 MiB. Treat the ceiling as HARD until a green
// deploy proves otherwise — a comment asserting an entitlement is not the same
// as the platform granting it, and believing this line is part of why the
// overshoot was a surprise.
const CEILING_KIB = 3 * 1024;
// The headroom the diet bought (see perf/ssr-worker-diet). Ratcheted DOWNWARD
// only: if a change needs more than this, that is a decision to make out loud,
// not a number to bump quietly.
const BUDGET_KIB = 2700;

if (!fs.existsSync(ENTRY)) {
  console.error(`no _worker.js at ${ENTRY} — run \`task build:web\` first`);
  process.exit(2);
}

// ---------------------------------------------------------------- wrangler
/** The number Cloudflare enforces. */
function wranglerGzipKiB() {
  const cfg = path.join(os.tmpdir(), `pt-worker-size-${process.pid}.json`);
  fs.writeFileSync(
    cfg,
    JSON.stringify({
      name: 'size-probe',
      main: ENTRY,
      compatibility_date: '2024-11-06',
      compatibility_flags: ['nodejs_compat'],
    }),
  );
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-worker-dry-'));
  try {
    const out = execFileSync(
      'npx',
      ['wrangler', 'deploy', '--dry-run', '--outdir', outdir, '--config', cfg],
      { cwd: WEB, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const m = out.match(/Total Upload:\s*([\d.]+)\s*KiB\s*\/\s*gzip:\s*([\d.]+)\s*KiB/);
    if (!m) throw new Error(`could not parse wrangler output:\n${out}`);
    return { raw: Number(m[1]), gzip: Number(m[2]) };
  } finally {
    fs.rmSync(cfg, { force: true });
    fs.rmSync(outdir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------- esbuild
/** Per-input attribution. Mirrors wrangler's advanced-mode bundling: one output
 *  file, no code splitting — so a `await import()` is INLINED, which is why
 *  "make it a dynamic import" does not shrink a Worker. */
async function attribute() {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-worker-attr-'));
  try {
    const r = await build({
      entryPoints: [ENTRY],
      bundle: true,
      format: 'esm',
      target: 'es2022',
      platform: 'neutral',
      mainFields: ['module', 'main'],
      conditions: ['workerd', 'worker', 'browser', 'import', 'default'],
      outfile: path.join(outdir, 'worker.js'),
      metafile: true,
      write: false,
      logLevel: 'error',
      external: [
        'cloudflare:*', '__STATIC_CONTENT_MANIFEST', 'node:*',
        // Bare node builtins, reachable through @grame/faustwasm's lazy node
        // branch. nodejs_compat supplies them at runtime.
        'fs', 'url', 'path', 'crypto', 'os', 'util', 'stream', 'buffer', 'events',
        'child_process', 'worker_threads', 'module', 'assert', 'zlib',
        'http', 'https', 'net', 'tls',
      ],
      loader: { '.wasm': 'binary', '.bin': 'binary', '.txt': 'text', '.html': 'text', '.md': 'text' },
    });
    const key = Object.keys(r.metafile.outputs).find((k) => k.endsWith('worker.js'));
    return Object.entries(r.metafile.outputs[key].inputs)
      .map(([file, v]) => ({ file, bytes: v.bytesInOutput }))
      .filter((e) => e.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes);
  } finally {
    fs.rmSync(outdir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------- main
const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json') >= 0 ? args[args.indexOf('--json') + 1] : null;

const inputs = await attribute();
const { raw, gzip } = wranglerGzipKiB();

console.log('\nCloudflare Pages Worker (wrangler deploy --dry-run):');
console.log(`  raw   ${raw.toFixed(2).padStart(10)} KiB`);
console.log(`  gzip  ${gzip.toFixed(2).padStart(10)} KiB`);
console.log(`  free-plan ceiling ${CEILING_KIB} KiB → margin ${(CEILING_KIB - gzip).toFixed(2)} KiB`);
console.log(`  self-imposed budget ${BUDGET_KIB} KiB → margin ${(BUDGET_KIB - gzip).toFixed(2)} KiB`);
console.log(`\n${inputs.length} inputs reach the Worker. Top 20 by raw bytes-in-bundle:`);
for (const { file, bytes } of inputs.slice(0, 20)) {
  console.log(`  ${(bytes / KiB).toFixed(1).padStart(9)} KiB  ${file}`);
}

if (jsonAt) {
  fs.writeFileSync(jsonAt, JSON.stringify({ raw, gzip, inputs }, null, 2));
  console.log(`\nwrote ${jsonAt}`);
}

if (args.includes('--check')) {
  if (gzip > BUDGET_KIB) {
    console.error(
      `\nFAIL — Worker is ${gzip.toFixed(2)} KiB gzipped, over the ${BUDGET_KIB} KiB budget ` +
        `(${CEILING_KIB} KiB is Cloudflare's free-plan hard ceiling).\n` +
        `The single biggest lever is what the /r/[id] server node can reach: see ` +
        `vite.config.ts ssrDropCardComponents(). Do NOT raise the budget without ` +
        `saying why in the PR.`,
    );
    process.exit(1);
  }
  // Ratchet the other way too: slack nobody claimed is slack that silently
  // absorbs the next regression.
  const slack = BUDGET_KIB - gzip;
  if (slack > 400) {
    console.error(
      `\nFAIL — ${slack.toFixed(2)} KiB of unclaimed slack under the ${BUDGET_KIB} KiB budget. ` +
        `Something got much smaller: lower BUDGET_KIB to about ${Math.ceil((gzip + 150) / 10) * 10} ` +
        `in this same commit so the budget keeps meaning something.`,
    );
    process.exit(1);
  }
  console.log(`\nPASS — ${gzip.toFixed(2)} KiB gzipped, ${slack.toFixed(2)} KiB under budget.`);
}
