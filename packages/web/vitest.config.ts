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
    // ---------------- Coverage ----------------
    // Wired via `@vitest/coverage-v8` (V8 provider — faster than Istanbul +
    // no Babel-instrument step). Reporters: `text` for the terminal summary,
    // `json-summary` for downstream tooling (PR comments / CI annotations),
    // `html` for the local artifact (`packages/web/coverage/index.html`).
    //
    // Thresholds: set 5-10% BELOW the realized numbers when this was wired,
    // so per-PR drift doesn't break green CI on day 1. Ratchet upward over
    // time — see "Coverage" in the root README. NOT day-1-tight on purpose
    // (see `feedback_no_flake_tolerance` in user memory).
    //
    // Excludes: tests + type-only files + worklets (worklets run in the
    // AudioWorklet context, not coverable from the main thread — they're
    // exercised by ART instead) + generated/vendored blobs (DOOM WASM,
    // doomgeneric C source, faust-compiled JS). The `.svelte-kit/` cache
    // also has to be excluded so generated route stubs don't drag the
    // numerator down.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      // Realized at wire-time (2026-05-30): lines 63.19, branches 83.01,
      // functions 73.29, statements 63.19. Thresholds set 5-10% below so
      // a single small untested addition doesn't break the build.
      thresholds: {
        lines: 55,
        branches: 75,
        functions: 65,
        statements: 55,
      },
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/*.d.ts',
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/.svelte-kit/**',
        '**/test-helpers/**',
        '**/__fixtures__/**',
        // Worklets run in the AudioWorklet context — not coverable from
        // the main thread. They're exercised by the ART harness instead.
        'packages/dsp/src/**',
        // Generated / vendored
        'native/**',
        'static/**',
      ],
    },
  },
});
