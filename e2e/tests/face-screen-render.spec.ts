// e2e/tests/face-screen-render.spec.ts
//
// PARTITION 1 OF 4 of the SCREEN ON / OFF render sweep.
//
// ⚠ THERE IS NOTHING MODULE-SPECIFIC IN THIS FILE AND THERE MUST NOT BE. It
// declares WHICH partition it runs and nothing else; the roster, the batching
// and the slice arithmetic all live in `support/face-screen-render-suite.ts`.
//
// ⚠ A NEW SUBJECT IS ADDED TO THE `SUBJECTS` TABLE IN THE SUITE MODULE, never
// here — it then lands in exactly one partition on its own, with no file to
// edit and no list to forget. The suite's coverage gate asserts that in both
// directions, so a subject that landed in none would go RED rather than
// silently stop being driven.
//
// The split's whole argument — why the sweep could not stay one file, why the
// partition slices BATCHES rather than subjects, and why by index rather than
// by the name-hash `faces-parity-suite.ts` uses — lives in the suite module
// beside the code that implements it, so it cannot drift from 4 copies of a
// comment.
//
// ⚠ DO NOT add a test here. Anything added would run ONCE for this partition
// and silently not at all for the others. A one-off belongs in the suite's
// `registerFaceScreenRenderOneOffs()`, which this file calls.
//
// ⚠ THIS FILE ALSO CARRIES THE ONE-OFFS — the partition coverage gate and the
// `videoMixer` SCREEN-state PERSISTENCE leg. They are NOT per-batch rows, so
// they must run exactly once rather than once per partition.

import {
  registerFaceScreenRenderOneOffs,
  registerFaceScreenRenderTests,
} from './support/face-screen-render-suite';

registerFaceScreenRenderOneOffs();
registerFaceScreenRenderTests(0);
