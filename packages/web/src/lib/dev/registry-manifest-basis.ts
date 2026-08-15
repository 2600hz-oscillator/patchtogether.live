// packages/web/src/lib/dev/registry-manifest-basis.ts
//
// The SOURCE BASIS of `e2e/.generated/registry-manifest.json` — the set of
// files whose bytes decide what the manifest contains, plus a content
// fingerprint over them.
//
// WHY THIS FILE EXISTS (#1526). The manifest is a gitignored build artifact
// that decides the POPULATION of the registry-driven Playwright sweeps
// (per-module-per-port, behavioral, vrt.spec). Until now the ONLY producer was
// a side effect inside a unit test, and the only consumer check was "does the
// file exist / is schemaVersion 2". So a manifest emitted three branches ago
// was consumed silently, and WHICH LANE RAN LAST decided which e2e tests
// existed. The failure is invisible by construction: a missing module is a
// missing test, and a missing test is a green run.
//
// The fix has to work from the PLAYWRIGHT process, which CANNOT import the
// module registry (the def barrels resolve worklet `?url` / `.wasm` imports
// that only exist inside Vite — see scripts/propose-face.ts's header for the
// same constraint). So staleness cannot be decided by rebuilding the manifest
// and diffing. It is decided from SOURCE BYTES instead: the emitter records
// `sourceFingerprint`, `e2e/tests/_registry.ts` recomputes it with plain fs at
// spec-parse time, and a mismatch throws with the regen command.
//
// ⚠ SCOPE — what this fingerprint is structurally UNABLE to see (stated here
// per the CLAUDE.md "state the gate's scope inside the gate" rule):
//   * a def that imports a VALUE from outside the basis (e.g. a shared param
//     constant living in `$lib/audio/shared-ranges.ts`). Change that constant
//     alone and the fingerprint does not move, so a stale manifest is still
//     consumed. The mitigation is over-coverage, not completeness: the basis
//     deliberately includes whole directories rather than a curated file list,
//     and every lane that reads the manifest still runs `task test:emit-manifest`
//     as a task dep, so the fingerprint is a BACKSTOP for the hand-run case,
//     not the primary freshness mechanism.
//   * anything about the manifest's CONTENT. It answers "were these bytes the
//     inputs", never "is the output right". Output correctness is
//     registry-manifest.test.ts's job.
// The direction of the error matters: over-coverage costs a spurious re-emit
// (~2 s), under-coverage costs a silently-shrunk test population. Prefer
// over-coverage when in doubt.
//
// NODE-ONLY, and deliberately DEPENDENCY-FREE beyond node builtins: it is
// imported by `e2e/tests/_registry.ts`, which is parsed by the Playwright
// runner with no Vite in the loop, so it must not import `$lib/*` or anything
// that pulls in a def barrel.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

/** Repo root. Five hops: packages/web/src/lib/dev/ → repo root. */
export const REPO_ROOT: string = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../..',
);

/**
 * Directories every `*.ts` of which is a manifest input. Whole directories
 * (not a curated file list) so a NEW def is covered the moment it lands —
 * a curated list is the same "hand-maintained population" defect the manifest
 * itself exists to remove.
 *
 * These mirror the `import.meta.glob(['./*.ts', '!./*.test.ts', '!./index.ts'])`
 * in each barrel, EXCEPT that `index.ts` is kept (the barrel's registration
 * rules — `looksLikeAudioDef` and friends — decide membership, so its bytes
 * change the manifest). `*.test.ts` is excluded exactly as the glob excludes
 * it. NOT recursive: all three directories are flat, and the barrels' globs
 * are flat too, so a nested file could not register anyway.
 */
export const MANIFEST_BASIS_DIRS: readonly string[] = [
  'packages/web/src/lib/audio/modules',
  'packages/web/src/lib/video/modules',
  'packages/web/src/lib/meta/modules',
];

/**
 * Individual files the PROJECTION reads. `module-specs.ts` is the projection
 * itself; the three registries decide iteration order and dedupe; `strict-faces`
 * and `dock-faceplate-model` feed the schemaVersion-2 face fields
 * (`strictFace`, the annotation tally) that `getAllModuleSpecs` publishes;
 * `registry-manifest.ts` is the emitter (its envelope is part of the output).
 */
export const MANIFEST_BASIS_FILES: readonly string[] = [
  'packages/web/src/lib/dev/module-specs.ts',
  'packages/web/src/lib/dev/registry-manifest.ts',
  'packages/web/src/lib/dev/registry-manifest-basis.ts',
  'packages/web/src/lib/audio/module-registry.ts',
  'packages/web/src/lib/video/module-registry.ts',
  'packages/web/src/lib/meta/module-registry.ts',
  'packages/web/src/lib/ui/workflow/strict-faces.ts',
  'packages/web/src/lib/ui/workflow/dock-faceplate-model.ts',
];

/** Reads a repo-relative path's raw bytes. Injectable so the negative control
 *  can perturb ONE file without touching the working tree. */
export type BasisReader = (relPath: string) => Buffer;

const readFromRepo: BasisReader = (relPath) => readFileSync(join(REPO_ROOT, relPath));

/**
 * Every file in the basis, repo-relative, POSIX-separated, sorted by code unit
 * (NOT locale-collated — a locale-sensitive sort would make the fingerprint
 * machine-dependent, and this value is compared ACROSS processes and across
 * a dev machine vs a CI runner).
 */
export function manifestBasisFiles(root: string = REPO_ROOT): string[] {
  const out: string[] = [...MANIFEST_BASIS_FILES];
  for (const dir of MANIFEST_BASIS_DIRS) {
    for (const name of readdirSync(join(root, dir))) {
      if (!name.endsWith('.ts')) continue;
      if (name.endsWith('.test.ts')) continue;
      out.push(`${dir}/${name}`);
    }
  }
  // Dedupe: MANIFEST_BASIS_FILES may name a file that also lives in a basis dir.
  return [...new Set(out)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * sha256 over `<path>\0<sha256(bytes)>\n` per basis file, in sorted path order.
 *
 * Hashed as BYTES, never as a decoded+normalized string: a fingerprint that
 * silently normalizes line endings or BOMs would read the same on two trees
 * that are not the same tree, which is the exact class of blindness this is
 * supposed to close.
 */
export function manifestSourceFingerprint(
  read: BasisReader = readFromRepo,
  files: readonly string[] = manifestBasisFiles(),
): string {
  const top = createHash('sha256');
  for (const rel of files) {
    const inner = createHash('sha256').update(read(rel)).digest('hex');
    top.update(`${rel}\0${inner}\n`);
  }
  return top.digest('hex');
}
