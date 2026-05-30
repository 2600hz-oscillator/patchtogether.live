// packages/web/vitest.config.ts
//
// Vitest config for unit tests in the web package. Pure-data tests live next
// to their source as `*.test.ts`. Audio-context-dependent code is covered by
// the e2e Playwright suite (real browser, real AudioContext) and the ART
// scenarios (offline render); this config intentionally runs in `node` and
// does NOT pull in the audio module factories (which import WASM/worklet
// `?url` assets that only Vite can resolve).
//
// Tests can resolve the SvelteKit `$lib/...` alias via the `resolve.alias`
// entry below, mirroring what svelte-kit/vite does at runtime.
//
// Svelte plugin is loaded so .svelte.ts rune stores (e.g. audio-gate) can
// be unit-tested. The plugin compiles `$state`/`$derived` into the Svelte 5
// runtime calls; without it, the raw `$state(...)` source would fail at
// import time in vitest.

import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [svelte({ hot: false })],
  resolve: {
    alias: {
      $lib: resolve(__dirname, 'src/lib'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
