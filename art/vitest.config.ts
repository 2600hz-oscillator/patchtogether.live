// art/vitest.config.ts
//
// Pinned-environment vitest config for Audio Regression Tests (D16).
// Runs in Node with node-web-audio-api shimming OfflineAudioContext.
// Baselines live in art/baselines/ tracked under git-lfs.

import { configDefaults, defineConfig, type Plugin } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FS_URL = '?url';

/**
 * Vite resolves a `?url` asset import to a BROWSER-facing `/@fs/…` path. ART
 * renders in Node with node-web-audio-api, whose `audioWorklet.addModule()`
 * takes a FILESYSTEM path — so a scenario that drives a real worklet-backed
 * module factory (audio-out's master limiter is the first) would otherwise get
 * `Cannot resolve module /@fs/…` and silently exercise the factory's fallback
 * path instead of the shipped one. Rewriting `?url` to the plain absolute path
 * lets ART drive the REAL worklet through the REAL factory.
 */
function workletFsUrl(): Plugin {
  const PREFIX = '\0art-fs-url:';
  return {
    name: 'art-worklet-fs-url',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!source.endsWith(FS_URL)) return null;
      const hit = await this.resolve(source.slice(0, -FS_URL.length), importer, {
        skipSelf: true,
      });
      // BASE64, not the raw path: a virtual id still ENDING in `.json` (several
      // scenarios import `dist/<name>.json?url`) is picked up by `vite:json`,
      // which then fails to parse this module's `export default`. Encoding the
      // path leaves the id extension-free, so no extension-matched plugin
      // claims it.
      return hit ? PREFIX + Buffer.from(hit.id, 'utf8').toString('base64') : null;
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null;
      const path = Buffer.from(id.slice(PREFIX.length), 'base64').toString('utf8');
      return `export default ${JSON.stringify(path)};`;
    },
  };
}

export default defineConfig({
  plugins: [workletFsUrl()],
  resolve: {
    // Mirror packages/web/vitest.config.ts so ART scenarios can import any
    // module under packages/web/src/lib that uses the SvelteKit `$lib/...`
    // alias (e.g., poly.ts imports note-entry via $lib/audio/note-entry).
    alias: {
      $lib: resolve(__dirname, '../packages/web/src/lib'),
    },
  },
  test: {
    include: ['scenarios/**/*.test.ts'],
    // ⚠ THE CV-REACH SWEEP IS NOT PART OF THE BASELINE LANE, and it is excluded
    // on a MEASUREMENT, not a preference. It builds and renders the real
    // factory once PER PORT across 340 paramTarget ports; measured 127 s on an
    // idle local box and >7 min on a CI runner, which took the `art` job from
    // its historical 3 min to a hard cancel at its 10 min timeout — i.e. it
    // more than doubled a REQUIRED lane on every PR.
    //
    // It still GATES, in its own parallel job (see ci.yml `cv-param-reach`), so
    // nothing is weakened: the critical path is the e2e shards at ~12 min, so a
    // parallel 8 min job costs no merge latency. Run it locally with
    // `npm run art:cv-reach -w art`.
    // ART_CV_REACH=1 opts the sweep IN (its own CI job, and `npm run
    // art:cv-reach -w art` locally). Default runs the baseline lane without it.
    exclude: process.env.ART_CV_REACH === '1'
      ? [...configDefaults.exclude]
      : [...configDefaults.exclude, 'scenarios/cv-param-reach/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } }, // determinism
    environment: 'node',
    globals: false,
    reporters: ['default'],
    // Browser AudioWorklet globals, so a scenario can drive a REAL module
    // factory (worklet and all) rather than rebuilding its graph by hand.
    setupFiles: ['./setup/node-audio-globals.ts'],
  },
});
