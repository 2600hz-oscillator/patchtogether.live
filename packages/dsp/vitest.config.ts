// packages/dsp/vitest.config.ts
//
// Vitest config for the DSP package's pure-lib unit tests. Historically the dsp
// workspace had NO test target, so DSP-lib math was tested from packages/web via
// relative imports (see the resofilter-dsp.test.ts / treeohvox-dsp.test.ts
// headers). CUBE (slice 1) introduces a co-located test target so the cube field
// math lives next to its source and runs via `npm test -w packages/dsp`.
//
// Pure node environment: lib/ files are plain TS with no AudioContext/WASM/DOM
// dependency (the worklet entries — which DO touch those — are tested via the
// vitest registerProcessor shim + ART, not here). Single-fork to match the
// repo's deterministic test posture.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
