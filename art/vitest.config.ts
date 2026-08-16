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
    alias: [
      { find: '$lib', replacement: resolve(__dirname, '../packages/web/src/lib') },
      // `faust-runtime.ts` imports `@grame/faustwasm` bare → the package `main`,
      // a CJS IIFE bundle whose named exports resolve to `undefined` under vite
      // (faust-offline.ts documents the same trap and sidesteps it by importing
      // the `dist/esm` subpath explicitly). Point the BARE specifier at the real
      // ESM entry so a scenario can drive a Faust def's SHIPPED factory without a
      // test-only branch in packages/web. See setup/faust-fetch-fs.ts.
      //
      // ⚠ ANCHORED (`^…$`), and it must stay that way. A plain string alias is a
      // PREFIX rewrite, so it also captures faust-offline.ts's explicit
      // `@grame/faustwasm/dist/esm/index.js` and doubles the tail into
      // `…/dist/esm/index.js/dist/esm/index.js`. That took out all 14 scenarios
      // that render through `renderFaustOffline` — as SUITE-level import errors,
      // which report as "14 failed test FILES / 0 failed tests".
      {
        find: /^@grame\/faustwasm$/,
        replacement: resolve(__dirname, '../node_modules/@grame/faustwasm/dist/esm/index.js'),
      },
    ],
  },
  test: {
    include: ['scenarios/**/*.test.ts'],
    // ⚠ THE CV-REACH SWEEPS ARE NOT PART OF THE BASELINE LANE, and they are
    // excluded on a MEASUREMENT, not a preference. Each builds and renders the
    // real factory once per port across every declared paramTarget port in the
    // registry, plus a baseline PAIR per module for its reproducibility leg;
    // measured 127 s on an idle local box and ~15 min on a CI runner, which
    // took the `art` job from its historical 3 min to a hard cancel at its
    // 10 min timeout — i.e. it more than doubled a REQUIRED lane on every PR.
    //
    // ⚠ THIS LIST IS THE OPT-IN'S WHOLE SUBJECT, so a sweep that is not named
    // here silently rides the REQUIRED lane and re-creates the cancel. That is
    // not hypothetical: `cv-display-param-reach` landed while only
    // `cv-param-reach` was listed, and cancelled the `art` job at 10m21s.
    // Adding a sweep directory means adding it HERE and to the `art:cv-reach`
    // script in package.json, together — the script is what the CI job runs, so
    // a sweep excluded here but absent there is excluded EVERYWHERE and gates
    // nothing at all.
    //
    // They still gate, in ci.yml's `cv-param-reach` job — which is MAIN-ONLY as
    // of the 2026-08-15 owner ruling (#1669): its measured cost had made it the
    // critical path at ≈ +4m45s per PR. A failure there reddens the main run (a
    // P0) and blocks the nightly prod deploy via daily-prod-deploy's find-green,
    // which scans every job's conclusion. Enforcement is post-merge, by choice.
    //
    // ART_CV_REACH=1 opts them IN (that CI job, and `npm run art:cv-reach -w art`
    // locally). Default runs the baseline lane without them.
    exclude: process.env.ART_CV_REACH === '1'
      ? [...configDefaults.exclude]
      : [
          ...configDefaults.exclude,
          'scenarios/cv-param-reach/**',
          'scenarios/cv-display-param-reach/**',
        ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } }, // determinism
    environment: 'node',
    globals: false,
    reporters: ['default'],
    // Browser AudioWorklet globals, so a scenario can drive a REAL module
    // factory (worklet and all) rather than rebuilding its graph by hand.
    setupFiles: ['./setup/node-audio-globals.ts', './setup/faust-fetch-fs.ts'],
  },
});
