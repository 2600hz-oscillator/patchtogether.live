// packages/web/vitest.setup.docs.ts
//
// Unit-lane EXISTENCE seam for `src/lib/docs/module-docs.generated.ts` — a
// gitignored BUILD ARTIFACT since the LoC campaign row-4 PR (it used to be
// committed). Several specs import it transitively (module-manifest,
// modules-card-map/Canvas), so on a fresh checkout the artifact must exist
// BEFORE those spec modules are imported or the run dies on a missing import
// with zero tests executed.
//
// Runs as a `setupFiles` entry in every fork BEFORE each test file is
// imported (vitest.config.ts). Fast path: one existsSync per test file —
// effectively free. Only when the artifact is MISSING does it import the
// emitter (which side-effect-imports the full module barrels — the same cost
// contract-lock/docs-lint already pay), so the price is paid once per clean
// checkout, not per run.
//
// NOTE this seam is deliberately presence-only; FRESHNESS is owned by
// module-docs-ensure.test.ts (which re-emits + gates determinism on every
// full sweep and on every `task docs:ensure` — the dep of
// build/build:web/dev/typecheck). This must live in the FORK pool, not
// vitest globalSetup: globalSetup's vite-node context denies the module
// barrels' external `?url` worklet imports (ERR_DENIED_ID), while the fork
// pool resolves them exactly like the tests themselves.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GENERATED = fileURLToPath(
  new URL('./src/lib/docs/module-docs.generated.ts', import.meta.url),
);

if (!existsSync(GENERATED)) {
  const { emitModuleDocsModule } = await import('./src/lib/docs/emit-module-docs');
  emitModuleDocsModule();
  // eslint-disable-next-line no-console
  console.log('[docs:ensure] generated missing src/lib/docs/module-docs.generated.ts');
}
