// scripts/webgl-attest-lib.ts
//
// Shared resolver + content-hash for the WebGL local-attestation "semaphore".
// See .claude/skills/webgl-attest.md (§3 hash basis, §-1 fixes
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
import { normalizeForHash, type BasisReader } from './attest-code-basis';

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
 *  WebGL context (CUBE/FOXY cards, the render-worker OffscreenCanvas
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

/** Pass A-SERIAL — heavy WebGL specs that are CORRECT + deterministic in
 *  ISOLATION but flake ONLY under Pass A-heavy's parallel GPU load (N workers
 *  racing the FBO readback). They run in a dedicated SERIAL pass (--workers=1)
 *  on a quiet GPU instead of being absorbed by retries — which would mask a real
 *  regression. Tag the spec's `test.describe` title with `@webgl-serial` so the
 *  grep matches (A-heavy `--grep-invert`s it; A-serial `--grep`s it).
 *
 *  ENTRY CRITERIA — keep this list STRICT; serial wall-time is ADDITIVE:
 *    1. The spec is in the heavy attestable set (runs in Pass A today).
 *    2. It is PROVEN green in isolation on the real GPU — e.g.
 *       `E2E_REAL_GPU=1 REPEAT=3 flox activate -- task e2e:one -- <spec>`.
 *    3. It only flakes under Pass A-heavy's parallel load (an FBO-readback /
 *       GPU-contention race), NOT a real bug.
 *  A spec that fails in isolation is BROKEN — fix it, don't park it here.
 *  Basenames (like the other lists). The runner logs this bucket's wall-time
 *  each run so growth stays visible. */
export const WEBGL_SERIAL_SPECS = [
  'scope-video-out.spec.ts',
  'wavecel-video-outs.spec.ts',
  // #1826 — same output-FBO readback race, MEASURED under the real Pass A
  // filter on clean main; green 20/20 in isolation on the same tree. Not a
  // frame-count issue: picturebox's upload is a synchronous texImage2D and a
  // 15 s re-stepping poll still reads zero bright pixels. See the rationale
  // block above the first describe in the spec.
  'video-orientation.spec.ts',
  // #1836 — the SAME output-FBO readback race, MEASURED under the real Pass A
  // filter (E2E_WEBGL_HEAVY=only, --workers=5) and green in isolation on the
  // same tree: REPEAT=3 on the real GPU, `3 passed` / `30 passed` / `6 passed`
  // respectively, --retries=0. They are NOT the #1836 preview-gate regression —
  // that one reproduced at --workers=1 and is fixed in the product (a one-shot
  // present is no longer eaten by the preview cadence cap); these three only
  // ever failed under parallel GPU load.
  //
  // ⚠ `toybox-layer-input.spec.ts` is deliberately NOT here. It failed at
  // workers=1 in isolation, which is entry-criterion 3's exact disqualifier: a
  // spec that fails in isolation is BROKEN, and parking it here would have
  // hidden a live regression behind a quiet GPU.
  'toybox-layer-selector.spec.ts',
  'toybox-node-batch.spec.ts',
  'toybox-shadertoy.spec.ts',
];

/** Toolchain pins that can change bundled/rendered WebGL output (a bundler or
 *  Playwright/renderer bump can move shader-string emission — the Clerk #464
 *  bundler class).
 *
 *  ⚠ package.json pins are hashed by their DEPENDENCY/CONFIG surface only (the
 *  shared `packageJsonCodeDigest`), not wholesale: an npm-SCRIPT string cannot
 *  move a rendered pixel, and hashing it wholesale demanded a trusted-machine
 *  GPU re-attest for a one-word CLI flag (#1425, `620fa1b3…` → `ad300c3e…`).
 *  `.flox/env/manifest.toml` IS still hashed wholesale — it rarely churns and
 *  TOML comments are outside the normalizer's scope. */
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

  // (4) E2E TEST FILES ARE DELIBERATELY EXCLUDED from the hash (owner directive
  //     2026-06-26: "changing tests should not change our attest hashes").
  //     The attest is a SEMAPHORE certifying that the GL *content* (module /
  //     shader / engine source, swept in (1)-(3)) renders correctly on a real
  //     GPU — the e2e spec is only the DRIVER. Editing a spec (adding a test,
  //     fixing a flake, a comment) changes ZERO rendered pixels, so it must NOT
  //     churn the hash and force a 10-min GPU re-attest. (The camera-recovery
  //     fix burned a re-attest precisely because camera-input.spec.ts used to be
  //     hashed here.) What a spec change could LEGITIMATELY invalidate is still
  //     tracked WITHOUT the spec bytes:
  //       - the attested SET (add/remove a heavy spec) → e2e/webgl-heavy-globs.ts
  //         (STANDALONE_BASIS_FILES) moves the hash;
  //       - the renderer/engine version → the toolchain pins + playwright.config.
  //     The §12 coverage guard still RUNS every heavy spec and asserts every
  //     WebGL module HAS one — that lives in the test runner, not the hash.
  //     This mirrors the docs rule: documentation AND test edits are
  //     hash-transparent. (Guarded by webgl-attest-coverage.test.ts: the basis
  //     contains NO file under e2e/tests/.)

  // (5) Standalone basis files + toolchain pins.
  for (const f of [...STANDALONE_BASIS_FILES, ...TOOLCHAIN_PIN_FILES]) {
    if (existsSync(join(REPO_ROOT, f))) files.add(f);
  }

  return [...files].sort();
}

// -------------------------------------------------------------------------
// The hash
// -------------------------------------------------------------------------

/** Deterministic content-hash over the basis: for each file in sorted order,
 *  feed `<repo-relative-path>\0<CODE>` into one sha256, where CODE is the file
 *  reduced to what can actually change GPU rendering by the SHARED normalizer
 *  (`scripts/attest-code-basis.ts`): comments, living-docs `docs`/
 *  `controlFamilies`/`face` def properties and type-only imports are removed by
 *  a TypeScript AST re-emit; a package.json keeps only its dependency/config
 *  surface. Mirrors scripts/dsp-src-hash.sh (path + content, LC_ALL=C sort
 *  order) otherwise.
 *
 *  The hash is DOCS-BLIND BY CONSTRUCTION — there is no marker to remember and
 *  no lint to catch a forgotten one (owner directive 2026-08-09: "docs should
 *  not need explicit ignore, they should be ignored by design; only code that
 *  is, you know, code, should be considered"). The normalizer lives in its own
 *  module (scripts/attest-code-basis.ts) rather than here: it backed three
 *  attests until collab and grand were deleted on 2026-08-17, and it stays
 *  shared so the next one cannot drift from this one. */
export function computeWebglHash(read: BasisReader = readBasisFile): string {
  const h = createHash('sha256');
  for (const rel of resolveWebglBasis()) {
    h.update(rel);
    h.update('\0');
    h.update(normalizeForHash(rel, read(rel)));
  }
  return h.digest('hex');
}

/** The default basis reader: repo-relative path → file text. */
export function readBasisFile(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
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
