// e2e/tests/gl-feedback-loop.spec.ts
//
// AN UNPATCHED VIDEO SINK MUST NOT SPAM GL_INVALID_OPERATION.
//
// Owner report (twice — 2026-08-06, then again 2026-08-07 after the first fix
// was written but never merged): "load a new rack and whoosh tons of GL errors",
// ~250 of them in a few seconds on the DEFAULT workflow rack.
//
// THE BUG. `uniform1f(uHasInput, 0)` only gates whether the SHADER reads the
// sampler; the sampler is still statically present in the program, so GL
// validates the binding on every draw regardless of the branch taken. Skipping
// the bind therefore left texture unit 0 holding whatever the previous node
// bound — which can be THIS node's own FBO colour attachment — i.e. a
// framebuffer/texture feedback loop, which GL rejects per draw call.
//
// WHY THIS SPEC EXISTS AT ALL: the first fix was verified by hand and then lost,
// because nothing in the suite could tell whether it was present. A console
// flood is invisible to every existing gate — pixels still render (GL drops the
// offending draw, the idle pattern is unaffected), so VRT is green, and no unit
// test sees a WebGL warning. This is the cheapest possible guard for a class
// that is otherwise only findable by a human opening DevTools.

import { test, expect } from './_fixtures';

test.describe.configure({ mode: 'parallel' });

/** How long to let the render loop run. Deliberately a WALL-CLOCK bound and not
 *  a frame count, because the assertion is "ZERO errors", which is
 *  renderer-independent: a slower renderer emits FEWER of them, never more, so
 *  this cannot become a different assertion on a different machine (the usual
 *  frames-not-milliseconds hazard does not apply to a zero-check). */
const OBSERVE_MS = 3500;

test('the default workflow rack emits ZERO GL feedback-loop errors', async ({ page, rack }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (/Feedback loop formed between Framebuffer and active Texture/.test(m.text())) {
      errors.push(m.text());
    }
  });

  // The owner's exact repro: just open a fresh workflow rack. Its auto-spawned
  // video zone (videoOut + recorderbox + synesthesia) has nothing patched in,
  // which is the state that used to flood.
  await page.goto('/rack?shell=legacy');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(OBSERVE_MS);

  expect(
    errors.length,
    `an unpatched default rack must emit no GL feedback-loop errors; saw ${errors.length} in ${OBSERVE_MS}ms`,
  ).toBe(0);
});

// RENDER-INTACT CONTROL — deliberately NOT re-implemented here.
//
// Binding `null` to unit 0 is what silences the error, but "bound null" and
// "deleted the draw" are indistinguishable from a zero-error count alone, so
// this fix needs a paired assertion that the video path still produces pixels.
// That assertion ALREADY EXISTS and is stronger than anything this spec would
// add: `video-pull-eval.spec.ts` reads the real OUTPUT framebuffer and asserts
// it is NON-BLACK. A bespoke re-implementation here went through three broken
// probes (engine getter null before start, then the wrong path into the video
// domain) before I stopped — the existing spec was right there and is the
// honest coverage claim. It is run alongside this one in the PR's verification.
