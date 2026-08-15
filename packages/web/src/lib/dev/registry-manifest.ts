// packages/web/src/lib/dev/registry-manifest.ts
//
// NODE-ONLY builder + writer for `e2e/.generated/registry-manifest.json` — the
// registry projection every registry-driven Playwright sweep iterates
// (`e2e/tests/_registry.ts`). Sibling of `$lib/docs/emit-module-docs.ts`, and
// deliberately the same shape: a plain module that OWNS the generation, called
// by an explicit seam.
//
// WHY IT IS NOT IN THE TEST ANY MORE (#1526). This code used to live inside
// `it('emits the manifest JSON to disk')`. A test that generates an artifact as
// a side effect is not a test: it makes the suite order-dependent, it hides the
// generation step from anyone reading the task graph, and it means the unit
// lane mutates the tree. The write now happens ONLY under `MANIFEST_EMIT=1`
// (the `task test:emit-manifest` seam, alias `manifest:emit`), so a plain
// `task test` leaves the tree alone; the spec keeps the registry-wide
// invariants and gates the builder's determinism.
//
// MUST stay importable only from vitest FORK-POOL contexts: it uses node:fs AND
// side-effect-imports the three def barrels, whose external `?url` worklet
// imports resolve in the fork pool but are DENIED in vitest globalSetup's
// vite-node context (the same constraint `emit-module-docs.ts` documents). The
// Playwright process must NOT import this file — it imports
// `registry-manifest-basis.ts` instead, which is fs-only.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pull every barrel — the side-effect import is what triggers the per-domain
// registerModule() calls. Without these the projection would be empty.
import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { getAllModuleSpecs, type ModuleSpec } from './module-specs';
import { manifestSourceFingerprint } from './registry-manifest-basis';

/** Bump when the ENTRY shape changes. `e2e/tests/_registry.ts` refuses a
 *  manifest whose version it doesn't recognise (fail-fast over silent skew). */
export const MANIFEST_SCHEMA_VERSION = 2 as const;

export interface RegistryManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  /**
   * Content fingerprint of the SOURCE files this manifest was built from
   * (`registry-manifest-basis.ts`). The consumer recomputes it from disk and
   * refuses a mismatch — the staleness gate.
   *
   * This REPLACED a `generatedAt` ISO timestamp. The timestamp made the
   * artifact non-deterministic (every emit rewrote the file even when nothing
   * changed) and answered a question nobody asks; the fingerprint answers the
   * one that matters, and makes the emit write-if-changed.
   */
  sourceFingerprint: string;
  /** Sorted by module type — `getAllModuleSpecs()` guarantees the order. */
  modules: ModuleSpec[];
}

/** Absolute path of the emitted manifest. Five `..` hops:
 *  packages/web/src/lib/dev/ → repo root, then `e2e/.generated/`. */
export const REGISTRY_MANIFEST_PATH: string = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../..',
  'e2e/.generated/registry-manifest.json',
);

/** PURE over the live registry (no fs, no clock). */
export function buildRegistryManifest(
  fingerprint: string = manifestSourceFingerprint(),
): RegistryManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    sourceFingerprint: fingerprint,
    modules: getAllModuleSpecs(),
  };
}

/** Deterministic bytes. Pretty-printed so a diff is reviewable if anyone ever
 *  checks the artifact in (the .gitignore entry should prevent that). */
export function serializeRegistryManifest(manifest: RegistryManifest): string {
  return JSON.stringify(manifest, null, 2) + '\n';
}

/**
 * Write the manifest. WRITE-IF-CHANGED, via a same-dir temp + rename: an
 * unchanged emit leaves the mtime alone, and a parallel Playwright reader can
 * never observe a half-written JSON file (a real hazard — CI emits the manifest
 * per shard while other shards are already running).
 */
export function emitRegistryManifest(
  path: string = REGISTRY_MANIFEST_PATH,
  manifest: RegistryManifest = buildRegistryManifest(),
): { path: string; changed: boolean; modules: number } {
  const content = serializeRegistryManifest(manifest);
  let existing: string | null = null;
  try {
    existing = readFileSync(path, 'utf8');
  } catch {
    existing = null;
  }
  if (existing === content) {
    return { path, changed: false, modules: manifest.modules.length };
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* the temp was never created — nothing to clean up */
    }
    throw err;
  }
  return { path, changed: true, modules: manifest.modules.length };
}
