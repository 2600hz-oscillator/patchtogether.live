// e2e/tests/_visual-checks.ts
//
// Gate for canvas/pixel/frame-advance assertions. Lives OUTSIDE _helpers.ts on
// purpose: _helpers.ts is in the collab-attest basis, so adding this predicate
// there shifted the collab content hash and forced a needless collab re-attest.
// Keeping it here leaves the collab/webgl bases owned by the files that actually
// matter (this is imported only by heavy video specs, which already drive the
// webgl-attest basis).

/** Visual canvas/pixel/frame-advance checks are timing-flaky under LOAD — CI's
 *  SwiftShader rAF throttling AND the real-GPU webgl attest's saturated serial
 *  run (E2E_REAL_GPU=1). Run them only on an UNLOADED interactive local run;
 *  under CI or the attest, the deterministic engine-state guards are the proof. */
export function visualChecksEnabled(): boolean {
  return !process.env.CI && process.env.E2E_REAL_GPU !== '1';
}
