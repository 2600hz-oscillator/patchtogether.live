// scripts/webgl-attest-lib.ts
//
// Shared resolver + content-hash for the WebGL local-attestation "semaphore".
// See .myrobots/plans/webgl-attestation-semaphore.md (§3 hash basis, §-1 fixes
// V3/V4/V6). Imported by BOTH:
//   - scripts/webgl-attest-hash.ts        (the CLI that prints the hash)
//   - the §12 coverage guard unit test    (webgl-attest-coverage.test.ts)
// so the basis, the resolver, and the fail-CLOSED coverage check all agree.
//
// DESIGN RULES (load-bearing):
//   * Deterministic + content-keyed (NOT git HEAD): survives squash-merge /
//     rebase / amend. Same content → same hash, always.
//   * Coarse + fail-CLOSED directory hashing where cheap (like dsp-src-hash.sh):
//     a missed file causes OVER-invalidation (one extra re-attest, the SAFE
//     direction), never a missed re-attest.
//   * EXCLUDE **/*.test.ts under lib/video/** — those are node-env vitest unit
//     tests in the `unit` job; including them would force a 10-min real-GPU
//     re-attest on every node-only edit (fix V6).
//   * The heavy spec set is resolved from the EXPORTED e2e/webgl-heavy-globs.ts
//     with minimatch (the matcher Playwright uses) — no text-parsing (fix V4).

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import { minimatch } from 'minimatch';

import { WEBGL_HEAVY_GLOBS, WEBGL_HEAVY_EXCLUDE } from '../e2e/webgl-heavy-globs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');

/** Regex that identifies a source file that creates a real WebGL/WebGL2
 *  rendering context. This is the AUTHORITATIVE machine signal for "this file
 *  renders WebGL" used by both the basis derivation and the fail-closed
 *  coverage guard. Applied AFTER comment-stripping (see stripComments) so a
 *  doc mention of getContext('webgl') in a JSDoc / // comment doesn't register
 *  as a real render path. */
export const WEBGL_CONTEXT_RE = /getContext\(\s*['"`]webgl2?['"`]/;

/** Strip block comments, line comments, and HTML comments so a doc-mention of
 *  `getContext('webgl')` (e.g. in this very file's JSDoc, or a card's header)
 *  isn't mistaken for a real WebGL context creation. Mirrors the comment-strip
 *  in midi-learn-wiring-audit.test.ts. Good enough for source scanning (we are
 *  not parsing — false negatives only arise from string-literal `getContext`
 *  mentions, which don't exist in this codebase). */
export function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '') // HTML comments (.svelte)
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (avoid http://)
}

/** True iff the file's source (comments stripped) creates a real WebGL context. */
export function sourceCreatesWebglContext(absOrSrc: string, isPath = false): boolean {
  const src = isPath ? readFileSync(absOrSrc, 'utf8') : absOrSrc;
  return WEBGL_CONTEXT_RE.test(stripComments(src));
}

/** Audio-domain modules whose CARD renders WebGL (so they live in the audio
 *  registry but their card is a GPU render path). The module def carries a
 *  machine-checkable `rendersWebGL: true` marker; this list mirrors that marker
 *  for the coverage guard's cross-check (it asserts the def files ARE flagged
 *  AND in-basis). Derived from: cards under lib/ui/modules matching
 *  WEBGL_CONTEXT_RE whose module is domain:'audio'. */
export const AUDIO_WEBGL_MODULE_DEFS = [
  'packages/web/src/lib/audio/modules/cube.ts',
  'packages/web/src/lib/audio/modules/hypercube.ts',
  'packages/web/src/lib/audio/modules/wavesculpt.ts',
];

/** Pass B — the WebGL-exercising e2e specs that are NOT matched by the heavy
 *  globs (so they run on the SwiftShader shards today, untrusted for WebGL)
 *  and the camera spec lives in Pass C. The attest runner runs these explicitly
 *  in a SEPARATE pass (E2E_WEBGL_HEAVY unset) because `=only` mode structurally
 *  cannot reach them (fix V5). These are spec basenames (matched as test files);
 *  the runner measures the actual count and refuses to write on a shortfall.
 *
 *  Membership criterion: the spec spawns a module/path that creates a real
 *  WebGL context (CUBE/HYPERCUBE/FOXY cards, the render-worker OffscreenCanvas
 *  proxy, or canvas-pixel asserts on a video card not in the heavy set). Edit
 *  here when such a spec is added; the runner's count-gate flags drift. */
export const WEBGL_LEAKER_SPECS = [
  // NOTE: render-worker-acidwarp/render-worker-toybox were Pass-B leakers but
  // Phase 2 (webgl-suite-optimization §7-1) added `**/render-worker-*.spec.ts`
  // to WEBGL_HEAVY_GLOBS, so they now run in Pass A (the heavy lane). They are
  // intentionally NOT listed here to avoid double-running them in two passes.
  // Audio-domain WebGL module specs not in the heavy globs.
  'cube.spec.ts',
  'foxy.spec.ts',
  // Multi-input mix / viz WebGL specs not in the heavy globs.
  'quadralogical-assign.spec.ts',
  // synesthesia-composite.spec.ts deleted in the GPU-attest rebuild — its band
  // claims are covered deterministically by synesthesia-dsp.test.ts, and its
  // live a_in path by synesthesia-video-mode.spec.ts + the per-port behavioral
  // sweep. (resolveWebglBasis guards each entry with existsSync, but keep the
  // list truthful.)
  'wavecel-viz.spec.ts',
];

/** Pass C — camera spec(s). Run via --project chromium-camera (the only project
 *  whose testMatch includes camera-input under `=only` mode it would be []). */
export const WEBGL_CAMERA_SPECS = ['camera-input.spec.ts'];

/** Toolchain pins that can change bundled/rendered WebGL output (a bundler or
 *  Playwright/renderer bump can move shader-string emission — the Clerk #464
 *  bundler class). Hashed wholesale; they rarely churn, so over-coverage is the
 *  safe direction. */
export const TOOLCHAIN_PIN_FILES = [
  'e2e/package.json', // pins @playwright/test — the renderer/engine version
  'packages/web/package.json', // pins Vite / Svelte / esbuild
  '.flox/env/manifest.toml', // pins the Chromium / Node toolchain
];

/** Standalone files that are always in-basis. */
export const STANDALONE_BASIS_FILES = [
  'e2e/playwright.config.ts',
  'e2e/webgl-heavy-globs.ts',
];

// -------------------------------------------------------------------------
// File-walk helpers
// -------------------------------------------------------------------------

/** Recursively list every file under `dir` (relative to REPO_ROOT), POSIX
 *  paths, optionally excluding a predicate. Returns repo-relative paths. */
function walk(dirRel: string, exclude?: (relPath: string) => boolean): string[] {
  const abs = join(REPO_ROOT, dirRel);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const childRel = posix(join(dirRel, entry.name));
    if (entry.isDirectory()) {
      out.push(...walk(childRel, exclude));
    } else if (entry.isFile()) {
      if (exclude && exclude(childRel)) continue;
      out.push(childRel);
    }
  }
  return out;
}

/** Normalize OS path separators to POSIX so hashes are identical on macOS/Linux. */
function posix(p: string): string {
  return p.split(sep).join('/');
}

// -------------------------------------------------------------------------
// Spec-set resolution (from the EXPORTED glob — fix V4)
// -------------------------------------------------------------------------

/** Resolve the heavy-WebGL spec FILE set by matching e2e/tests against
 *  WEBGL_HEAVY_GLOBS with minimatch (the matcher Playwright uses). Returns
 *  repo-relative, sorted paths. */
export function resolveHeavyWebglSpecs(): string[] {
  const all = walk('e2e/tests').filter((p) => p.endsWith('.spec.ts'));
  // The globs are anchored `**/<name>.spec.ts`; repo-relative paths look like
  // `e2e/tests/<name>.spec.ts`, so a plain minimatch matches directly (the `**`
  // absorbs the leading `e2e/tests/`). This is the exact semantics Playwright's
  // testMatch/testIgnore use against these globs.
  const matched = all.filter(
    (p) =>
      WEBGL_HEAVY_GLOBS.some((g) => minimatch(p, g)) &&
      !WEBGL_HEAVY_EXCLUDE.some((g) => minimatch(p, g)),
  );
  return matched.sort();
}

/** True iff EVERY test in the spec is gated behind a top-level
 *  `test.describe('…@collab…' | '…@capacity…')` (with no un-tagged top-level
 *  `test(`), so the attest's Pass-A `--grep-invert "@collab|@capacity"` filters
 *  the WHOLE FILE out — it then runs ZERO tests and Playwright never registers it
 *  as a spec file. Such a spec is matched by the heavy glob but is NOT attestable
 *  (it belongs to the @collab lane), so it must be subtracted from Pass A's
 *  expected spec-file count or the count-gate sees a false shortfall (48/49).
 *  Sound for this repo's structure (tags live on the outermost describe). */
export function isFullyCollabCapacityGated(absPath: string): boolean {
  const src = stripComments(readFileSync(absPath, 'utf8'));
  // No tag anywhere → definitely attestable.
  if (!/@collab|@capacity/.test(src)) return false;
  // A top-level (un-indented) `test(` / `test.only(` with no tag in its own title
  // would survive the grep-invert → the spec IS attestable.
  const bareTopLevelTest = /^test(\.only)?\(\s*(['"`])((?!.*@(?:collab|capacity)).)*\2/m;
  if (bareTopLevelTest.test(src)) return false;
  // Every top-level `test.describe(` must carry a tag for the file to be fully
  // gated. If any top-level describe lacks the tag, surviving tests remain.
  const topDescribes = [...src.matchAll(/^test\.describe(\.\w+)?\(\s*(['"`])(.*?)\2/gm)];
  if (topDescribes.length === 0) return false; // tag present but not structuring describes → be safe, count it
  return topDescribes.every((m) => /@collab|@capacity/.test(m[3] ?? ''));
}

/** The heavy specs that Pass A ACTUALLY runs: the glob set minus any spec that
 *  is fully @collab/@capacity-gated (grep-inverted out). This is the correct
 *  EXPECTED count for Pass A's measured-spec-file gate. */
export function resolveAttestableHeavyWebglSpecs(): string[] {
  return resolveHeavyWebglSpecs().filter(
    (p) => !isFullyCollabCapacityGated(join(REPO_ROOT, p)),
  );
}

// -------------------------------------------------------------------------
// The WEBGL_PATHS basis (mechanical + fail-closed — §3.3)
// -------------------------------------------------------------------------

/** Returns the FULL, sorted, repo-relative list of files in the WebGL content
 *  hash basis. Every file here, by content, feeds the hash. Mechanical: no
 *  hand-listed card allowlist; cards/specs are derived. */
export function resolveWebglBasis(): string[] {
  const files = new Set<string>();

  // (1) Video engine + shared GL libs + every video module def — WHOLE DIR,
  //     fail-closed, EXCLUDING node-env unit tests (fix V6).
  for (const f of walk('packages/web/src/lib/video', (p) => p.endsWith('.test.ts'))) {
    files.add(f);
  }

  // (2) WebGL CARDS — derived mechanically: any card whose source creates a
  //     WebGL context. (Plus their audio-domain module defs, below.)
  for (const f of walk('packages/web/src/lib/ui/modules')) {
    if (!f.endsWith('.svelte')) continue;
    if (sourceCreatesWebglContext(join(REPO_ROOT, f), true)) {
      files.add(f);
    }
  }

  // (3) Audio-domain WebGL module sources (rendersWebGL-flagged defs).
  for (const f of AUDIO_WEBGL_MODULE_DEFS) {
    if (existsSync(join(REPO_ROOT, f))) files.add(f);
  }

  // (4) The heavy WebGL specs (resolved from the exported glob), the Pass-B
  //     leaker specs + the Pass-C camera spec (so editing any attested spec
  //     forces a re-attest), and the shared e2e helpers/registry (small, rarely
  //     churns; over-cover is safe).
  for (const f of resolveHeavyWebglSpecs()) files.add(f);
  for (const base of [...WEBGL_LEAKER_SPECS, ...WEBGL_CAMERA_SPECS]) {
    const p = `e2e/tests/${base}`;
    if (existsSync(join(REPO_ROOT, p))) files.add(p);
  }
  for (const f of walk('e2e/tests/_helpers')) files.add(f);
  if (existsSync(join(REPO_ROOT, 'e2e/tests/_registry.ts'))) {
    files.add('e2e/tests/_registry.ts');
  }

  // (5) Standalone basis files + toolchain pins.
  for (const f of [...STANDALONE_BASIS_FILES, ...TOOLCHAIN_PIN_FILES]) {
    if (existsSync(join(REPO_ROOT, f))) files.add(f);
  }

  return [...files].sort();
}

// -------------------------------------------------------------------------
// The hash
// -------------------------------------------------------------------------

/** Living-docs is hash-TRANSPARENT: co-located `docs`/`controlFamilies` and
 *  their type imports are pure DOCUMENTATION (they don't affect GPU rendering),
 *  so authoring them on a video module must NOT churn the WebGL attest hash and
 *  force a re-attest. Each such addition is wrapped in
 *  `// docs-hash-ignore:start … // docs-hash-ignore:end` markers, and the hash
 *  is computed over content with those regions removed. A file with no markers
 *  is unaffected. (Owner directive 2026-06-24: "docs must not change attest
 *  hashes"; see .myrobots/plans/living-docs-drift-2026-06-24.md.) */
const DOCS_IGNORE_RE = /^[ \t]*\/\/ docs-hash-ignore:start[\s\S]*?^[ \t]*\/\/ docs-hash-ignore:end[ \t]*\r?\n/gm;
export function stripDocsForHash(src: string): string {
  return src.replace(DOCS_IGNORE_RE, '');
}

/** Deterministic content-hash over the basis: for each file in sorted order,
 *  feed `<repo-relative-path>\0<docs-stripped-bytes>` into one sha256. Mirrors
 *  scripts/dsp-src-hash.sh exactly (path + content, LC_ALL=C sort order), except
 *  living-docs regions are stripped first so doc authoring is hash-neutral. */
export function computeWebglHash(): string {
  const h = createHash('sha256');
  for (const rel of resolveWebglBasis()) {
    h.update(rel);
    h.update('\0');
    h.update(stripDocsForHash(readFileSync(join(REPO_ROOT, rel), 'utf8')));
  }
  return h.digest('hex');
}

// -------------------------------------------------------------------------
// Coverage-guard support (§12 — fail CLOSED)
// -------------------------------------------------------------------------

/** Every source file under packages/web/src whose content creates a real WebGL
 *  context. The fail-closed coverage guard asserts ALL of these are in-basis. */
export function findAllWebglSourceFiles(): string[] {
  // CRITICAL: scan the WHOLE web source tree, NOT just the roots the basis
  // auto-sweeps. The basis derivation auto-includes lib/video/** and any
  // ui/modules card with a WebGL context, so scanning only those roots would
  // make the guard VACUOUS (every found file is covered by construction → the
  // guard can never go red, defeating its fail-closed purpose). By scanning the
  // entire tree, a WebGL context that appears anywhere the basis does NOT cover
  // (a new audio module's own component, a graph/util/worker file, a different
  // component dir, …) is caught and forces a coverage decision: either add the
  // file to WEBGL_PATHS, or (for an audio module) flag rendersWebGL + list it.
  const out: string[] = [];
  for (const f of walk('packages/web/src')) {
    if (!/\.(svelte|ts)$/.test(f)) continue;
    // exclude node-env unit tests from the SOURCE scan too (engine.test.ts
    // legitimately spins a context for a unit test; it is excluded from the
    // basis by design — fix V6 — and is not a render-path regression surface).
    if (f.endsWith('.test.ts')) continue;
    if (sourceCreatesWebglContext(join(REPO_ROOT, f), true)) {
      out.push(f);
    }
  }
  return out.sort();
}

/** True iff a repo-relative file is covered by the basis. */
export function isInBasis(relPath: string, basis = resolveWebglBasis()): boolean {
  return basis.includes(relPath);
}
