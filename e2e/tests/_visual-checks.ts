// e2e/tests/_visual-checks.ts
//
// Gate for canvas/pixel/frame-advance assertions. Lives OUTSIDE _helpers.ts:
// this is imported only by heavy video specs, which already drive the
// webgl-attest basis, and the shared multi-context helper file should not own
// it. (The original reason was mechanical — _helpers.ts was in the collab-attest
// basis, so adding this predicate there shifted the collab content hash and
// forced a needless re-attest. collab-attest was deleted 2026-08-17.)

/** Visual canvas/pixel/frame-advance checks are timing-flaky under LOAD — CI's
 *  SwiftShader rAF throttling AND the real-GPU webgl attest's saturated serial
 *  run (E2E_REAL_GPU=1). Run them only on an UNLOADED interactive local run;
 *  under CI or the attest, the deterministic engine-state guards are the proof. */
export function visualChecksEnabled(): boolean {
  return !process.env.CI && process.env.E2E_REAL_GPU !== '1';
}
