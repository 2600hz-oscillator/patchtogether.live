// packages/server/vitest.config.ts
//
// Vitest config for the Hocuspocus server package. Until this file landed
// the server used the framework default — fine for run-the-tests, but
// `--coverage` needs explicit include/exclude globs (otherwise the V8
// provider walks node_modules + .ts→.js dist output and the numerator
// becomes meaningless).
//
// Coverage is wired via `@vitest/coverage-v8` (V8 provider — faster than
// Istanbul + no Babel-instrument step). Reporters: `text` for the terminal
// summary, `json-summary` for downstream tooling (PR comments / CI
// annotations), `html` for the local artifact (`packages/server/coverage/`).
//
// Thresholds are set 5-10% BELOW the realized numbers when this was wired,
// so per-PR drift doesn't break green CI on day 1. Ratchet upward over time
// (see "Coverage" in the root README + `feedback_no_flake_tolerance` in
// user memory).

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      // Realized at wire-time (2026-05-30): lines 88.88, branches 76.25,
      // functions 82.25, statements 86.07. Thresholds 5-10% below so a
      // single uncovered branch-add doesn't break the build.
      thresholds: {
        lines: 80,
        branches: 70,
        functions: 75,
        statements: 78,
      },
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/*.d.ts',
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/test-helpers/**',
        '**/__fixtures__/**',
        // Bootstrap entrypoint — runs net.createServer + Hocuspocus.listen
        // at import time. Not coverable from a node-env unit test.
        'src/index.ts',
      ],
    },
  },
});
