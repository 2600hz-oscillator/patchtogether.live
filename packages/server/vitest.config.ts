// packages/server/vitest.config.ts
//
// Explicit vitest config for the relay workspace. The tests always ran fine
// via bare `vitest run` discovery (`npm test -w packages/server`), but the
// repo-wide single-test loop — `task test:one PKG=server -- <filter>` —
// passes `--config vitest.config.ts` for every workspace, and this package
// never had one, so that target exited "Cannot find config". This file
// restates the defaults the bare run already used, unbreaking `test:one`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
