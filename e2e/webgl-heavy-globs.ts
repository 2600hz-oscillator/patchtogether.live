// e2e/webgl-heavy-globs.ts
//
// THE single source of truth for "what is a heavy WebGL spec".
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
  '**/picturebox-*.spec.ts',
  '**/b3ntb0x.spec.ts',
  // 1024×768 bump (#662): these three are GPU-fractal / multi-input video
  // mixers + routers whose page.screenshot/evaluate budgets blow on CI's
  // SwiftShader at 2.56× the old pixel count (they pass on a real GPU). Same
  // class as the toybox/video heavies above — run them in the serialized
  // e2e-video lane, not the sharded matrix.
  '**/4plexvid.spec.ts', // 4×4 video router — heavy WebGL screenshot
  '**/quadralogical.spec.ts', // 4-input video mixer — heavy WebGL evaluate
  '**/mandleblot.spec.ts', // GPU Mandelbrot fractal
] as const;
