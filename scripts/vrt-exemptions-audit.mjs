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
//   STALE   — vrt.spec.ts baseline EXISTS → the pair is dead weight; the card is
//             skipped though it has a committed baseline. DROP the pair (restores
//             coverage). This is the actionable list.
//   PENDING — no vrt.spec.ts baseline → genuinely pending (or a composite/scope
//             SCENE pair whose baseline lives under a different spec dir; this
//             audit only resolves plain module-card pairs). Land it via
//             `task vrt:commit`.
//
// The vrt-meta.test.ts "STALE EXEMPT_BASELINE_PAIRS ratchet" enforces the STALE
// count toward zero so new rot can't accrue. This command just lists the
// offenders for the cleanup pass. Exit 0 always (read-only).

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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

const baselinePath = (type, platform) =>
  resolve(root, `e2e/vrt/__screenshots__/vrt.spec.ts/${platform}/${type}.png`);

const stale = [];
const pending = [];
for (const p of pairs) {
  const [platform, type] = p.split('/');
  (existsSync(baselinePath(type, platform)) ? stale : pending).push(p);
}

const linux = (xs) => xs.filter((p) => p.startsWith('linux/')).length;

console.log(`VRT exemption audit — EXEMPT_BASELINE_PAIRS: ${pairs.length} total`);
console.log(`  linux pairs: ${linux(pairs)}   darwin pairs: ${pairs.length - linux(pairs)}\n`);

console.log(`STALE — baseline already committed, card needlessly skipped (DROP the pair): ${stale.length}`);
for (const p of stale) console.log(`  ✗ ${p}`);

console.log(`\nPENDING/scene — no vrt.spec.ts baseline yet (land via \`task vrt:commit\`): ${pending.length}`);
for (const p of pending) console.log(`  · ${p}`);

if (stale.length) {
  console.log(
    `\n→ ${stale.length} stale pair(s) are pure coverage loss. Remove them from ` +
      `EXEMPT_BASELINE_PAIRS in e2e/vrt/vrt-exemptions.ts (and lower the vrt-meta ` +
      `STALE ratchet ceiling). Confirm the committed baseline still matches the ` +
      `current render first — if not, regenerate via \`task vrt:commit\` then drop the pair.`,
  );
}
