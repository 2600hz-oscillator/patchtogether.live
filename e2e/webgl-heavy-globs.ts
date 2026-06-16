// e2e/webgl-heavy-globs.ts
//
// THE single source of truth for "what is a heavy WebGL spec".
//
// NB: this module is imported in BOTH an ESM context (playwright.config.ts, and
// scripts/webgl-attest-lib.ts via tsx ESM) — so it must use ESM `import`, never
// `require` (a bare require() throws "require is not defined in ES module scope"
// when Playwright loads the config as ESM).
//
// This list was inlined in playwright.config.ts (a non-exported `const`). It is
// now an exported module so BOTH consumers read the SAME literal:
//   1. e2e/playwright.config.ts  — partitions the sharded `e2e` matrix
//      (E2E_WEBGL_HEAVY=exclude) from the dedicated serialized `e2e-video` lane
//      (E2E_WEBGL_HEAVY=only).
//   2. scripts/webgl-attest-hash.mjs + the §12 coverage guard — resolve the
//      heavy spec FILE set with the SAME minimatch matcher Playwright uses, so
//      the WebGL content-hash basis can't parse-drift from what actually runs
//      (adversarial-review fix V4: a bash/regex text-parse of a TS literal is
//      brittle and fails OPEN). See .myrobots/plans/webgl-attestation-semaphore.md.
//
// Playwright's default shard splitter sorts SPEC FILES alphabetically then
// round-robins, so the alphabetically-late, heavy cross-domain WebGL specs
// (toybox-*, video-*, wavesculpt*, multi-video, …) all cluster onto the
// high-numbered shards. On CI's SwiftShader (software WebGL) those co-tenant
// heavies starve the single GL context / main thread and overrun their
// per-test budgets — the toybox-node-menu / presets-io SAVE / video-projection
// / combine-editor timeout class (#621/#629/#625). FIX (#68): pull every
// WebGL-heavy spec OUT of the sharded matrix and run them on their own
// dedicated, NON-sharded, serialized job (--workers=1, so no two heavies ever
// co-tenant a SwiftShader context).
//
// To re-classify a spec, edit THIS list only. The §12 coverage guard asserts
// the resolved count + that no WebGL-rendering source escapes the hash basis.

import { readdirSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimatch } from 'minimatch';

const posix = (p: string): string => p.split(sep).join('/');

export const WEBGL_HEAVY_GLOBS = [
  '**/toybox-*.spec.ts',
  '**/video-*.spec.ts',
  '**/videobox-*.spec.ts',
  '**/videovarispeed-*.spec.ts',
  '**/multi-video-playback.spec.ts',
  '**/wavesculpt*.spec.ts',
  '**/wavecel-video-outs.spec.ts',
  '**/scope-video-out.spec.ts',
  '**/synesthesia-video-mode.spec.ts',
  '**/freezeframe.spec.ts',
  '**/b3ntb0x.spec.ts',
  // 1024×768 bump (#662): these three are GPU-fractal / multi-input video
  // mixers + routers whose page.screenshot/evaluate budgets blow on CI's
  // SwiftShader at 2.56× the old pixel count (they pass on a real GPU). Same
  // class as the toybox/video heavies above — run them in the serialized
  // e2e-video lane, not the sharded matrix.
  '**/4plexvid.spec.ts', // 4×4 video router — heavy WebGL screenshot
  '**/quadralogical.spec.ts', // 4-input video mixer — heavy WebGL evaluate
  '**/mandleblot.spec.ts', // GPU Mandelbrot fractal
  // Phase 2 GLOB hygiene (webgl-suite-optimization §7-1): the render-worker
  // specs are worker-WebGL2 (OffscreenCanvas) shader-heavies that were
  // MIS-BINNED into the sharded matrix — they only matched `render-worker-*`,
  // which no heavy glob covered, so they co-tenanted SwiftShader shards and hit
  // their 60-90s budgets exactly like the toybox/video heavies the lane
  // isolates. Phase 1 confirmed they pass on the real GPU; move them INTO the
  // serialized heavy lane. (Their `@webgl-smoke` tests still also run in the
  // SwiftShader smoke floor.)
  '**/render-worker-*.spec.ts',
] as const;

// Phase 2 RE-BIN (webgl-suite-optimization §2/§7-1): these spec files match a
// BROAD heavy glob above (`toybox-*` / `video-*`) but do NO pixel/canvas work —
// they assert DOM / Y.Doc / engine-hook / audio-RMS state. They sit on the
// serialized single-GPU lane for zero GPU reason, displacing genuinely
// GPU-bound specs. RE-BIN them OUT of the heavy lane (back into the parallel
// sharded matrix) by subtracting them after the glob match. Keep this list
// MINIMAL and TRUE to "no pixel read" — a file that reads a canvas must stay in
// the lane. (picturebox-limits/picturebox-sync were re-binned by dropping the
// `picturebox-*` glob entirely; these need an explicit subtraction because
// their broad glob also covers in-lane pixel specs.)
export const WEBGL_HEAVY_EXCLUDE = [
  '**/toybox-presets-io.spec.ts', // zip round-trip / import-file / dropdown — no pixels
  '**/video-audio-output.spec.ts', // AnalyserNode RMS on the audio terminal — never reads a canvas
  '**/video-aspect-switch.spec.ts', // engine resolution + routing-survival via __engine hooks; pixel probe omitted on CI by its own header
  '**/videovarispeed-perfzip.spec.ts', // perf-zip round-trip: asserts data-has-local-file / imageBytes / zip bytes / node count — DOM+Y.Doc only, no canvas read (VideoVarispeedCard renders a plain <video>, no WebGL context)
] as const;

/** Resolve the EFFECTIVE heavy spec FILES (concrete repo-relative paths) =
 *  every `e2e/tests/*.spec.ts` that matches a heavy glob and NOT an exclude.
 *
 *  Why concrete files instead of the globs directly: Playwright's
 *  testMatch/testIgnore have no native "match A but not B" — a spec runs iff
 *  (matches testMatch) AND NOT (matches testIgnore). In `only` mode the
 *  exclusions can simply be added to testIgnore (heavy ∩ ¬exclude). But in
 *  `exclude` mode (the sharded matrix) testIgnore is the ONLY filter; using the
 *  broad globs there would also ignore the RE-BINned files, keeping them off the
 *  matrix too (so they'd run nowhere). Resolving concrete file paths lets the
 *  config ignore EXACTLY the in-lane heavy files in `exclude` mode, leaving the
 *  re-binned ones to run in the matrix.
 *
 *  This walks e2e/tests at config-load (node context) with the same minimatch
 *  matcher the attest tooling uses, so the two stay in lock-step. */
export function resolveEffectiveHeavySpecGlobs(): string[] {
  const here = dirname(fileURLToPath(import.meta.url)); // e2e/
  const testsDir = join(here, 'tests');
  const files: string[] = [];
  for (const entry of readdirSync(testsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.spec.ts')) continue;
    const rel = posix(`e2e/tests/${entry.name}`);
    const isHeavy = WEBGL_HEAVY_GLOBS.some((g) => minimatch(rel, g));
    const isExcluded = WEBGL_HEAVY_EXCLUDE.some((g) => minimatch(rel, g));
    if (isHeavy && !isExcluded) files.push(`**/${entry.name}`);
  }
  return files.sort();
}
