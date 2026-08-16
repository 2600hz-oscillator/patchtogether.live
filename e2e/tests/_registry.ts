// e2e/tests/_registry.ts
//
// Playwright fixture that loads the synthesized module manifest.
//
// Why this exists: Playwright resolves `for (const x of X) test(...)`
// loops at file-parse time, BEFORE the browser is up. We can't
// `await page.evaluate()` at module load. So an explicit generate step
// (`task test:emit-manifest` → `packages/web/src/lib/dev/registry-manifest.ts`)
// emits a JSON snapshot of every registered module def to
// `e2e/.generated/registry-manifest.json`, and every Playwright spec
// that wants to iterate the registry reads that JSON synchronously at
// file-parse time via this helper.
//
// ORDERING: every lane that reads the manifest declares
// `test:emit-manifest` as a task dep (`task e2e`, `task vrt`, …), and the CI
// jobs that call playwright directly run it as an explicit step. `task test`
// deliberately does NOT emit it any more (#1526) — a unit suite that mutates
// the tree as a side effect made "which lane ran last" decide what e2e tests
// exist.
//
// If the manifest is missing, its schemaVersion is unrecognised, or its
// recorded source fingerprint does not match this checkout, the fixture
// THROWS — the per-spec error message names the command to run.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// fs-only, no `$lib` and no def barrel — importable from the Playwright runner.
import { manifestSourceFingerprint } from '../../packages/web/src/lib/dev/registry-manifest-basis';

export interface RegistryPort {
  id: string;
  type: string;
  // schemaVersion-2 enrichment (all optional). E2E specs that only need
  // {id,type} keep working; the docs-overhaul I/O surface reads these.
  paramTarget?: string;
  cvScale?: { mode: string; depth?: number };
  accepts?: string[];
  edge?: 'trigger' | 'gate';
  adoptsUpstreamFrom?: string;
}

export interface RegistryParam {
  id: string;
  label: string;
  defaultValue: number;
  min: number;
  max: number;
  curve: string;
  units?: string;
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
  // schemaVersion-2 enrichment — full ParamDef surface + stereo pairs.
  params: RegistryParam[];
  stereoPairs?: [string, string][];
  /** The def declares a curated `face` and is therefore MIGRATED — its lane
   *  renders `<ModuleShell>` rather than the uniform `<ModuleShellPlaceholder>`.
   *  Emitted only when true, so read it as `=== true`.
   *
   *  ⚠ This file IS in the @collab attest basis (`scripts/collab-attest-hash.sh
   *  --list`), so adding to it looks like it costs a re-attest. MEASURED, all
   *  four corners in one controlled run (#1724): this field is HASH-TRANSPARENT
   *  — an optional TYPE-ONLY interface member emits no runtime code, and
   *  `scripts/attest-code-basis.ts` parses with the real TypeScript compiler
   *  rather than diffing bytes. origin/main hashed c62605e4…; with this member
   *  added and nothing else changed it hashed c62605e4… again. Adding a
   *  RUNTIME member here would not be free. */
  strictFace?: boolean;
  hasAudioOutput: boolean;
  hasCvOutput: boolean;
  hasGateOutput: boolean;
  hasVideoOutput: boolean;
}

interface ManifestFile {
  schemaVersion: number;
  /** sha256 over the module-def SOURCE bytes the manifest was built from.
   *  Recomputed here from disk — see the staleness check in loadManifest. */
  sourceFingerprint?: string;
  modules: RegistryModule[];
}

const EXPECTED_SCHEMA = 2;

/** The one command that refreshes the artifact. Named in every failure below
 *  so the reader never has to guess. */
const REGEN = 'flox activate -- task test:emit-manifest';

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
      `Registry manifest missing at ${path}. Run \`${REGEN}\` to emit it. ` +
      `CI's task chain runs this automatically before \`task e2e\` / \`task vrt\`.`,
    );
  }
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as ManifestFile;
  if (parsed.schemaVersion !== EXPECTED_SCHEMA) {
    throw new Error(
      `Registry manifest schema mismatch at ${path}: got ${parsed.schemaVersion}, ` +
      `expected ${EXPECTED_SCHEMA}. Run \`${REGEN}\` to regenerate.`,
    );
  }
  if (!Array.isArray(parsed.modules) || parsed.modules.length === 0) {
    throw new Error(`Registry manifest at ${path} has no modules — emitter is broken`);
  }
  // STALENESS (#1526). Until this existed, the ONLY checks were "does the file
  // exist" and "is it schema 2" — so a manifest emitted on another branch was
  // consumed silently, and WHICH LANE RAN LAST decided which e2e tests existed.
  // A missing module is a missing test and a missing test is a green run, so
  // the failure was invisible by construction.
  //
  // We cannot rebuild the manifest here to compare — the Playwright process
  // cannot import the def barrels (worklet `?url` / `.wasm` resolve only inside
  // Vite). So the check is over SOURCE BYTES: the emitter recorded the
  // fingerprint of its inputs, and we recompute it with plain fs.
  const expected = manifestSourceFingerprint();
  if (parsed.sourceFingerprint !== expected) {
    throw new Error(
      `Registry manifest at ${path} is STALE: it was built from module sources ` +
      `whose fingerprint was ${parsed.sourceFingerprint ?? '(absent — pre-#1526 manifest)'}, ` +
      `but this checkout's sources fingerprint to ${expected}. Consuming it would ` +
      `silently run the wrong set of registry-driven tests (a module missing from ` +
      `the manifest is a test that never runs, which looks exactly like a pass). ` +
      `Run \`${REGEN}\`.`,
    );
  }
  return parsed;
}

const _manifest = loadManifest();

/** Every registered module, sorted by type. The single source of truth
 *  for any Playwright spec that wants to iterate every module — drop
 *  hardcoded MODULES arrays in favour of this. */
export const REGISTRY: readonly RegistryModule[] = _manifest.modules;

// (The former subset helpers — modulesByDomain / audioOutputProducers /
// cvOutputProducers / videoOutputProducers / moduleByType — were pruned as
// unreferenced exports in the LoC campaign, row 16. Filter REGISTRY inline.)
