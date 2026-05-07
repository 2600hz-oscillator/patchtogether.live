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

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
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
