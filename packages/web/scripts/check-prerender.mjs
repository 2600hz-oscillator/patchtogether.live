// packages/web/scripts/check-prerender.mjs
//
// POSTBUILD GUARD: the landing (`/`, prerender=true) must actually be baked
// into the build output. On 2026-07-11 a build intermittently emitted the
// empty SPA shell for index.html instead of the prerendered landing — the
// prerenderer skipped `/` SILENTLY (no build error), and the failure only
// surfaced later as a baffling e2e red (landing-routing's raw-HTML assert,
// #1059 shard 4) where both Playwright attempts reuse the same bad artifact.
//
// A silent prerender skip is a build failure. This check makes it LOUD and
// contemporaneous: the build that produced the bad artifact fails with its
// own logs attached, instead of an e2e shard failing an hour later with no
// trail. Sentinels are the lowercase tile labels (CSS uppercases them) and
// the static sign-in link — content that only exists in a real prerender.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../.svelte-kit/cloudflare/index.html');

const SENTINELS = ['new dawless rack', 'sign in', 'landing-tiles'];

let html;
try {
  html = readFileSync(OUT, 'utf8');
} catch (err) {
  console.error(`[check-prerender] FAIL: cannot read ${OUT}: ${err.message}`);
  process.exit(1);
}

const missing = SENTINELS.filter((s) => !html.includes(s));
if (missing.length > 0) {
  console.error(
    `[check-prerender] FAIL: the landing did NOT prerender — index.html is ` +
      `${html.length} bytes and is missing: ${missing.map((m) => JSON.stringify(m)).join(', ')}. ` +
      `The prerenderer silently skipped '/'. Inspect this build's own log — do not let this ` +
      `surface as a downstream e2e failure (landing-routing raw-HTML assert).`,
  );
  process.exit(1);
}
console.log(`[check-prerender] ok — landing prerendered (${html.length} bytes, ${SENTINELS.length} sentinels)`);
