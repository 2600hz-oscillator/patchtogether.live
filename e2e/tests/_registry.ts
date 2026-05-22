// e2e/tests/_registry.ts
//
// Playwright fixture that loads the synthesized module manifest.
//
// Why this exists: Playwright resolves `for (const x of X) test(...)`
// loops at file-parse time, BEFORE the browser is up. We can't
// `await page.evaluate()` at module load. So the unit-test pass
// (`packages/web/src/lib/dev/registry-manifest.test.ts`) emits a JSON
// snapshot of every registered module def to
// `e2e/.generated/registry-manifest.json`, and every Playwright spec
// that wants to iterate the registry reads that JSON synchronously at
// file-parse time via this helper.
//
// CI ordering: `task ci` chains `task test` (which emits the manifest)
// before `task e2e` and `task vrt`. Locally, `task test:emit-manifest`
// runs the same emitter standalone. If the manifest is missing or its
// schemaVersion is unrecognised, the fixture throws — the per-spec
// error message tells the developer which command to run.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RegistryPort {
  id: string;
  type: string;
}

export interface RegistryModule {
  type: string;
  label: string;
  /** 'audio' | 'video' | 'meta'. Pass through to spawnPatch as the
   *  node's domain field so the right per-domain engine adopts it. */
  domain: 'audio' | 'video' | 'meta';
  category: string;
  inputs: RegistryPort[];
  outputs: RegistryPort[];
  hasAudioOutput: boolean;
  hasCvOutput: boolean;
  hasGateOutput: boolean;
  hasVideoOutput: boolean;
}

interface ManifestFile {
  schemaVersion: number;
  generatedAt: string;
  modules: RegistryModule[];
}

const EXPECTED_SCHEMA = 1;

function manifestPath(): string {
  // This file lives at e2e/tests/_registry.ts; the manifest lives at
  // e2e/.generated/registry-manifest.json. Two `..` hops:
  // e2e/tests/ → e2e/ → e2e/.generated/.
  return resolve(import.meta.dirname, '..', '.generated', 'registry-manifest.json');
}

/** Read + validate the manifest. Cached at module load. Throws with a
 *  developer-actionable message when the file is missing or stale. */
function loadManifest(): ManifestFile {
  const path = manifestPath();
  if (!existsSync(path)) {
    throw new Error(
      `Registry manifest missing at ${path}. Run \`flox activate -- task test:emit-manifest\` ` +
      `(or \`flox activate -- task test\`, which includes the emitter) to refresh it. ` +
      `CI's task chain runs this automatically before \`task e2e\` / \`task vrt\`.`,
    );
  }
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as ManifestFile;
  if (parsed.schemaVersion !== EXPECTED_SCHEMA) {
    throw new Error(
      `Registry manifest schema mismatch at ${path}: got ${parsed.schemaVersion}, ` +
      `expected ${EXPECTED_SCHEMA}. Re-run the manifest emitter to regenerate.`,
    );
  }
  if (!Array.isArray(parsed.modules) || parsed.modules.length === 0) {
    throw new Error(`Registry manifest at ${path} has no modules — emitter is broken`);
  }
  return parsed;
}

const _manifest = loadManifest();

/** Every registered module, sorted by type. The single source of truth
 *  for any Playwright spec that wants to iterate every module — drop
 *  hardcoded MODULES arrays in favour of this. */
export const REGISTRY: readonly RegistryModule[] = _manifest.modules;

/** Subset helpers — convenience predicates so spec files stay terse.
 *  All return a *new* array each call so callers can mutate without
 *  surprising sibling specs. */
export function modulesByDomain(domain: 'audio' | 'video' | 'meta'): RegistryModule[] {
  return REGISTRY.filter((m) => m.domain === domain);
}

export function audioOutputProducers(): RegistryModule[] {
  return REGISTRY.filter((m) => m.hasAudioOutput);
}

export function cvOutputProducers(): RegistryModule[] {
  return REGISTRY.filter((m) => m.hasCvOutput);
}

export function videoOutputProducers(): RegistryModule[] {
  return REGISTRY.filter((m) => m.hasVideoOutput);
}

/** Look up one module's spec by type. Returns `undefined` if the type
 *  isn't in the manifest (typo in a test fixture). */
export function moduleByType(type: string): RegistryModule | undefined {
  return REGISTRY.find((m) => m.type === type);
}
