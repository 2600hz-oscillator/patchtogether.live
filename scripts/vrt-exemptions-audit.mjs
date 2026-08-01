#!/usr/bin/env node
// scripts/vrt-exemptions-audit.mjs
//
// Read-only hygiene report for e2e/vrt/vrt-exemptions.ts:EXEMPT_BASELINE_PAIRS.
//
// A `<platform>/<type>` pair tells vrt.spec.ts to SKIP that card on that
// platform ("baseline pending"). Over time these rot: a baseline lands (via the
// vrt-update.yml CI job) but the pair is never removed, so the card is skipped
// on that platform DESPITE a committed baseline — silent coverage loss. This
// script cross-checks each pair against the baseline PNG on disk:
//
//   STALE   — a baseline EXISTS → the pair is dead weight; the scene is skipped
//             though it has a committed baseline. DROP the pair (restores
//             coverage). This is the actionable list.
//   PENDING — no baseline anywhere → genuinely pending. Land it via
//             `task vrt:commit` / a vrt-update.yml dispatch.
//
// ⚠ 2026-08-01: this audit used to resolve ONLY
// `__screenshots__/vrt.spec.ts/<platform>/<id>.png`, so a composite/scene pair
// whose PNG lives under its own spec dir was reported as PENDING even when the
// baseline was sitting right there — it under-reported STALE by 3 (the
// darwin/wavesculpt-blink-* quarantines). It now indexes EVERY spec dir. Same
// blindness class as the linux-deficit ratchet fixed in the same commit: a
// checker that looks in one directory cannot speak for the tree.
//
// ⚠ This script reports on ONE of the FOUR mechanisms that take a scene dark on
// a platform (the shared EXEMPT_BASELINE_PAIRS Set). For the full picture —
// spec-local pair sets, blanket `VRT_PLATFORM === 'linux'` skips and the
// `darwinOnly` scene flag — see e2e/vrt/vrt-platform-gaps.ts, which is what the
// vrt-meta linux-deficit ratchet reads.
//
// The vrt-meta.test.ts "STALE EXEMPT_BASELINE_PAIRS ratchet" enforces the STALE
// count toward zero so new rot can't accrue. This command just lists the
// offenders for the cleanup pass. Exit 0 always (read-only).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'e2e/vrt/vrt-exemptions.ts'), 'utf8');

// Isolate the EXEMPT_BASELINE_PAIRS Set literal, then pull every quoted
// `<platform>/<id>` string out of it (comments in the block are ignored — they
// don't contain the quoted pair form).
const block = src.slice(src.indexOf('EXEMPT_BASELINE_PAIRS = new Set'));
const pairs = [
  ...new Set([...block.matchAll(/['"]((?:linux|darwin)\/[^'"]+)['"]/g)].map((m) => m[1])),
].sort();

// Index EVERY committed baseline as `<platform>/<id>`, across every spec dir —
// NOT just vrt.spec.ts. `stalePair -> which spec dir holds its PNG` is reported
// so the reader can go straight to it.
const shotRoot = resolve(root, 'e2e/vrt/__screenshots__');
const committed = new Map(); // `<platform>/<id>` -> spec dir
if (existsSync(shotRoot)) {
  for (const spec of readdirSync(shotRoot).sort()) {
    for (const platform of ['linux', 'darwin']) {
      const dir = join(shotRoot, spec, platform);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.png')) committed.set(`${platform}/${f.slice(0, -4)}`, spec);
      }
    }
  }
}

const stale = [];
const pending = [];
for (const p of pairs) (committed.has(p) ? stale : pending).push(p);

const linux = (xs) => xs.filter((p) => p.startsWith('linux/')).length;

console.log(`VRT exemption audit — EXEMPT_BASELINE_PAIRS: ${pairs.length} total`);
console.log(`  linux pairs: ${linux(pairs)}   darwin pairs: ${pairs.length - linux(pairs)}\n`);

console.log(`STALE — baseline already committed, scene needlessly skipped (DROP the pair): ${stale.length}`);
for (const p of stale) console.log(`  ✗ ${p}   (PNG under __screenshots__/${committed.get(p)}/)`);

console.log(`\nPENDING — no baseline on that platform in ANY spec dir (land via \`task vrt:commit\`): ${pending.length}`);
for (const p of pending) console.log(`  · ${p}`);

if (stale.length) {
  console.log(
    `\n→ ${stale.length} stale pair(s) are pure coverage loss. Remove them from ` +
      `EXEMPT_BASELINE_PAIRS in e2e/vrt/vrt-exemptions.ts (and lower the vrt-meta ` +
      `STALE ratchet ceiling). Confirm the committed baseline still matches the ` +
      `current render first — if not, regenerate via \`task vrt:commit\` then drop the pair.`,
  );
}
