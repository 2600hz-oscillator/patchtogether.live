// vitest.config.ts (repo-root)
//
// Root vitest config for tests that live OUTSIDE the workspace packages.
// Today that's just `scripts/*.test.ts` — covers the new-module scaffolder
// and any future repo-wide tooling. Workspace-internal tests still run
// via each package's own vitest config (packages/web/vitest.config.ts).
//
// We don't pull in svelte / SvelteKit aliases here because the scripts
// tests only need plain node fs / child_process to drive the scaffolder.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // The scaffolder mutates real files; force a single fork so two
    // tests don't trample each other's edits to module-categories.ts.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
