// packages/web/src/lib/docs/module-docs-ensure.test.ts
//
// The BUILD-TIME-GENERATED render module's seam + gate (LoC campaign row 4).
// Before this, `module-docs.generated.ts` was COMMITTED and
// contract-lock.test.ts held a freshness assertion over the committed copy
// (stale ⇒ red until `task docs:accept` re-emitted it). Now the file is a
// gitignored build artifact, so "stale committed copy" is no longer a failure
// mode — this spec IS the generator's seam: it re-emits from the live
// registry (write-if-changed) every time it runs, which is every full unit
// sweep AND every `task docs:ensure` (the dep of build/build:web/dev/
// typecheck). The missing-file-at-collection case for OTHER specs is handled
// by vitest.setup.docs.ts; direct `vite dev`/`vite build` boots by the
// ensureModuleDocs plugin in vite.config.ts.
//
// What replaced the freshness gate — three checks, none vacuous:
//   1. EMIT ROUND-TRIP — emitting writes exactly the live serialization to
//      exactly the canonical path, and a second emit is a no-op
//      (write-if-changed holds, so a watching `vite dev` never reload-loops).
//   2. DETERMINISM — two independent registry reads serialize identically
//      (no timestamps, no iteration-order leakage), so the build-time emit
//      can never make two builds differ.
//   3. RATCHET — the artifact stays gitignored and `contract-lock.txt` stays
//      the ONLY pinned/committed living-docs artifact (someone un-ignoring +
//      re-committing the render module re-creates the documented
//      merge-conflict file the row-4 PR deleted).

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { serializeModuleDocsModule, getDocsByType } from './contract-signature';
// emit-module-docs side-effect-imports the module barrels, so the registry is
// populated for getDocsByType/serializeModuleDocsModule below too.
import { emitModuleDocsModule, MODULE_DOCS_GENERATED_PATH } from './emit-module-docs';

const WEB_GITIGNORE_PATH = fileURLToPath(new URL('../../../.gitignore', import.meta.url));

describe('module-docs.generated.ts (build-time artifact seam)', () => {
  beforeAll(() => {
    // THE seam: regenerate from the live registry (write-if-changed). After
    // this, the artifact is guaranteed fresh for the rest of the lane and for
    // whatever build/dev boot listed `docs:ensure` as its dep.
    emitModuleDocsModule();
  });

  it('emit round-trips: on-disk artifact byte-equals the live serialization, and re-emit is a no-op', () => {
    const onDisk = readFileSync(MODULE_DOCS_GENERATED_PATH, 'utf8');
    expect(
      onDisk === serializeModuleDocsModule(),
      'module-docs.generated.ts on disk does not match the live registry right after an ' +
        'emit — the write path of emit-module-docs.ts is broken (wrong path, half-write, ' +
        'or a serializer that reads mutable state).',
    ).toBe(true);
    // Write-if-changed must hold or every dev boot / test run would touch the
    // file's mtime and a watching `vite dev` would reload in a loop.
    expect(emitModuleDocsModule().changed).toBe(false);
  });

  it('the generator is deterministic (two independent registry reads emit identical modules)', () => {
    const first = serializeModuleDocsModule(getDocsByType());
    const second = serializeModuleDocsModule(getDocsByType());
    expect(second).toBe(first);
    // No wall-clock leakage: a timestamp is the classic way a "deterministic"
    // emitter starts flaking the round-trip assertion above.
    expect(first).not.toMatch(/\b20\d{2}-\d{2}-\d{2}/);
  });

  it('the artifact stays gitignored; contract-lock.txt stays the only pinned living-docs artifact', () => {
    const ignore = readFileSync(WEB_GITIGNORE_PATH, 'utf8');
    const lines = ignore.split('\n').map((l) => l.trim());
    expect(
      lines.includes('src/lib/docs/module-docs.generated.ts'),
      'packages/web/.gitignore must ignore src/lib/docs/module-docs.generated.ts — ' +
        'it is a build artifact; re-committing it re-creates a known merge-conflict file.',
    ).toBe(true);
    expect(
      lines.some((l) => !l.startsWith('!') && !l.startsWith('#') && l.includes('contract-lock.txt')),
      'contract-lock.txt must NOT be gitignored — it is the committed PINNED golden ' +
        'of the living-docs drift gate (contract-lock.test.ts).',
    ).toBe(false);
  });
});
