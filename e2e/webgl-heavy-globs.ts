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
  // VIDEOCUBE (#1136): a heavy 3-input WebGL e2e (3 video rings + a volumetric
  // ray-march + the audio reduce). The broad `video-*` glob does NOT match
  // `videocube` (no dash), so it was mis-binned onto the sharded SwiftShader
  // matrix — the toybox/video contention-timeout class. Enroll it explicitly in
  // the serialized e2e-video lane. e2e/webgl-heavy-globs.ts is in the WebGL hash
  // basis (STANDALONE_BASIS_FILES) → folds into the same one-time re-attest.
  '**/videocube.spec.ts',
  '**/multi-video-playback.spec.ts',
  // GPU-attest rebuild WAVESCULPT wave: narrowed `wavesculpt*` → `wavesculpt`
  // (exact). The 3 satellite specs (camera-cv/state-unity/spatial-audio) were
  // converted to PCU pure-core unit tests in wavesculpt.test.ts and deleted.
  // Fail-closed: a future wavesculpt-*.spec won't silently re-enter the heavy
  // lane — it must be added here deliberately (with a fresh attest + count bump).
  '**/wavesculpt.spec.ts',
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
  // COLOUR OF MAGIC (#1016): 8-FBO multi-colorspace processor — the bespoke
  // spec patches Lines→module and readPixels()es all 8 output textures. Proven
  // correct under SwiftShader in isolation (4 tests, ~2-4s each), but at 1024×768
  // it co-tenanted a sharded SwiftShader shard and blew its 120s budget under
  // contention (shard-1 red). Same GPU-bound class as the mixers above — isolate
  // it in the serialized e2e-video lane.
  '**/colourofmagic.spec.ts', // 8-FBO colorspace processor — heavy WebGL evaluate
  // SOURCERY: 2-input region shape-match recolor. The bespoke spec wires two
  // real video sources → SOURCERY → readPixels()es the output FBO (non-black +
  // structured + param response). Full-res dependent-texelFetch fill; keep it
  // off the sharded matrix so it never co-tenants a SwiftShader shard.
  // e2e/webgl-heavy-globs.ts is in the WebGL hash basis → re-attested.
  '**/sourcery.spec.ts', // 2-input region-transplant recolor — heavy WebGL pixel read
  // CELLSHADE rebuild (§12 R7): both cellshade specs readPixels() real FBOs —
  // the functional spec probes exact texels off the module's own output FBO
  // (DRS-frozen fixtures), and the bespoke spec samples the OUTPUT canvas.
  // Neither matched a heavy glob, so they ran in the SHARDED matrix doing
  // GPU-timing-sensitive pixel reads (the picturebox-gif false-red-under-
  // contention class; this file's own rule: "a file that reads a canvas must
  // stay in the lane"). Isolate both in the serialized e2e-video lane.
  '**/cellshade-functional.spec.ts', // theory-derived exact-texel probes — heavy WebGL pixel read
  '**/cellshade.spec.ts', // ACIDWARP→cellshade live-render stats — heavy WebGL pixel read
  // picturebox-gif (#1016 boy-scout): unlike picturebox-limits/picturebox-sync
  // (re-binned OUT for doing NO pixel work — see the EXCLUDE note below), the
  // GIF spec's `ANIMATES` test samples the video output's LUMA OVER TIME to
  // prove the animated frames advance — a GPU-timing-sensitive pixel read.
  // Mis-binned into the sharded matrix by #1010 (the broad `picturebox-*` glob
  // was already dropped), it co-tenanted a SwiftShader shard and read a
  // non-advancing (min=max=1.0) frame under contention → false red (passes in
  // isolation ~2.8s). Isolate the whole file in the serialized lane.
  '**/picturebox-gif.spec.ts', // animated-gif luma-over-time — heavy WebGL pixel read
  // KEYER FRAMEWORK (§11 change 6): the keyer functional-validation spec is a
  // DRS readPixels suite (frozen clock, gl.readPixels off module FBOs) that
  // matched NO heavy glob — it ran on the sharded SwiftShader matrix, the
  // documented contention-flake class (#621/#1016). Enroll it in the
  // serialized heavy lane. e2e/webgl-heavy-globs.ts is in the WebGL hash
  // basis → batched into the keyer-framework PR's single re-attest.
  '**/keyer-functional.spec.ts', // keyer family theory-derived pixel asserts — DRS readPixels
  // POSTERBOX (2026-07-11): the theory-derived functional spec readPixels()es
  // the module's own output FBO (continuity anchors / hue-order / dither
  // checker-block / mix sweep) under the DRS pause+step pattern. Real-GPU
  // pixel reads → serialized heavy lane, never a sharded SwiftShader shard.
  // e2e/webgl-heavy-globs.ts is in the WebGL hash basis → re-attested (the
  // new video module def moves the hash this PR anyway).
  '**/posterbox-functional.spec.ts', // retro palette-crush probes — heavy WebGL pixel read
  // (mandleblot.spec.ts was deleted — its waitForTimeout pixel gate was fully
  //  redundant with the deterministic mandleblot-render-smoke.spec.ts, which the
  //  `**/*-render-smoke.spec.ts` glob below already enrolls in this heavy lane.)
  // Phase 2 GLOB hygiene (webgl-suite-optimization §7-1): the render-worker
  // specs are worker-WebGL2 (OffscreenCanvas) shader-heavies that were
  // MIS-BINNED into the sharded matrix — they only matched `render-worker-*`,
  // which no heavy glob covered, so they co-tenanted SwiftShader shards and hit
  // their 60-90s budgets exactly like the toybox/video heavies the lane
  // isolates. Phase 1 confirmed they pass on the real GPU; move them INTO the
  // serialized heavy lane. (Their `@webgl-smoke` tests still also run in the
  // SwiftShader smoke floor.)
  '**/render-worker-*.spec.ts',
  // GPU-attest rebuild (plan §5 Layer B): the deterministic render-smoke (DRS)
  // specs — freeze the engine clock + pause its rAF loop, drive step() a fixed
  // count synchronously, readPixels the node FBO once. Real-GPU pixel reads, so
  // they belong in the serialized heavy lane. This glob auto-enrolls every
  // `<module>-render-smoke.spec.ts` as Phase 1+ migrates modules onto the DRS.
  '**/*-render-smoke.spec.ts',
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
  '**/videovarispeed-switch.spec.ts', // 7-slot switch-path regression: asserts engine uploadCount / keepAliveCount hooks + <video> currentTime + play/pause DOM state across A→B→A — NO canvas pixel read (renderer-independent by construction), so it runs in the parallel matrix
  // GPU-attest rebuild 2026-06-23 (glsmoke-floor-expansion roadmap): these
  // matched a broad heavy glob (toybox-*/videobox-*) but read NO pixels — they
  // assert DOM / Y.Doc state. They only TIMED OUT on SwiftShader because the live
  // render loop ran UNPAUSED underneath; each now calls installRenderSmokeHooks(
  // page) before goto to idle the render, so they run cheap in the parallel matrix
  // (3× SwiftShader-clean) and no longer need the real-GPU attest lane.
  // (toybox-node-menu + video-audio-cvgate-coverage were assessed in the same wave
  //  but DEFERRED: node-menu's "Clear node map" test has an independent flake, and
  //  cvgate's nibbles-pellet gate-poll is contention-borderline — both stay on the
  //  attest until hardened.)
  '**/toybox-node-controls.spec.ts', // control-pane DOM/Y.Doc — no pixel read (render paused)
  '**/toybox-presets.spec.ts', // manifest + preset dropdown + node.data — no pixel read
  '**/videobox-performance-bundle.spec.ts', // perf-zip data round-trip — DOM/Y.Doc only, no canvas read
  // glsmoke-floor-expansion wave 3 (2026-06-23): same render-pause re-bin — DOM/data
  // specs that timed out only under the live render loop. Validated 3× SwiftShader-clean.
  '**/toybox-disk-loading.spec.ts', // disk OBJ/shader load → node.data asserts — no worker-pixel read
  '**/toybox-video-projection.spec.ts', // UV/projective projection-config DOM/state — no pixel read
  '**/video-audio-cvgate-coverage.spec.ts', // #414 audio bridge: SCOPE analyser peak/rms + hardened pellet poll — never reads a canvas
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
