// packages/web/src/lib/audio/cv-shadow.test.ts
//
// The landing pad's own contract, at the level ART cannot reach: ART measures a
// real render, this pins the JS-side value semantics that decide what a card
// draws before, during and after a cable.

import { describe, expect, it } from 'vitest';
import { createCvShadow } from './cv-shadow';

/** A context stub with only what the pad touches. Deliberately has NO
 *  `createAnalyser` and no `createConstantSource`: if either ever comes back,
 *  this test fails to construct, which is the point — each AnalyserNode costs
 *  one permanently retained Blink AudioHandler (see the header of
 *  `cv-shadow.ts` for the measurement) and the pad must never own one. */
function fakeCtx(): { ctx: BaseAudioContext; disconnects: () => number } {
  let disconnects = 0;
  const ctx = {
    currentTime: 0,
    createGain: () => ({
      gain: {
        value: 0,
        setValueAtTime(v: number) { (this as { value: number }).value = v; },
      },
      connect() {},
      disconnect() { disconnects += 1; },
    }),
  } as unknown as BaseAudioContext;
  return { ctx, disconnects: () => disconnects };
}

describe('createCvShadow — the knob/CV landing pad for a JS-consumed param', () => {
  it('reports the KNOB until a consumer supplies the engine-combined value', () => {
    const { ctx } = fakeCtx();
    const s = createCvShadow(ctx, 20);
    // Nothing patched ⇒ the engine builds no tap ⇒ readParam returns the knob.
    // Reading the knob here is therefore the CORRECT answer, not a fallback.
    expect(s.read()).toBe(20);
    expect(s.knob()).toBe(20);
  });

  it('publishes the knob as the AudioParam INTRINSIC, which is what the engine sums into', () => {
    const { ctx } = fakeCtx();
    const s = createCvShadow(ctx, 20);
    s.set(120);
    expect(s.param.value, 'the engine sums each cable on top of this intrinsic').toBe(120);
    expect(s.read()).toBe(120);
  });

  it('draws with the COMBINED value once pushed, while readParam still sees only the knob', () => {
    const { ctx } = fakeCtx();
    const s = createCvShadow(ctx, 20);
    s.setCombined(95); // knob 20 + a cable contributing 75, per AudioEngine.readParam
    expect(s.read(), 'the draw path uses the combined value').toBe(95);
    expect(
      s.knob(),
      'readParam must report the knob alone — the engine adds the modulator tap on top, ' +
        'so returning the combined value would double-count the cable',
    ).toBe(20);
  });

  it('a knob move DROPS the stale combined sample rather than fighting it', () => {
    // Without this, dragging a fader would visibly snap back to the last pushed
    // value for one frame before the next push caught up.
    const { ctx } = fakeCtx();
    const s = createCvShadow(ctx, 20);
    s.setCombined(95);
    s.set(50);
    expect(s.read()).toBe(50);
    s.setCombined(130);
    expect(s.read()).toBe(130);
  });

  it('a STOPPED pump LATCHES the last combined value — it does NOT fall back to the knob', () => {
    // #1583 verify pass. `dom-source-modules.ts` used to tell readers that when
    // scope/rasterize lose their card the module "draws every display param at
    // its KNOB, ignoring any patched cv cable". It does not, and the difference
    // is the difference between a self-limiting degrade and a stuck value.
    //
    // The mechanism here is CORRECT and deliberate: `combined` is cleared only
    // by `set()` (a knob move), because clearing it on anything else would make
    // a dragged fader snap back for a frame (the test above). What makes it a
    // LATCH is the CONSUMER — the pushing pump lives on a card, so it can stop
    // while the value stays. This test pins the mechanism so the corrected
    // prose is anchored to an assertion rather than to a comment, and so that
    // whoever removes the card-owned pump has to come here and say so.
    const { ctx } = fakeCtx();
    const s = createCvShadow(ctx, 20);
    s.setCombined(95); // an LFO happens to be high when the card goes away…
    // …and now nobody pushes again, ever.
    expect(
      s.read(),
      'no further push: the draw path keeps reporting the last MODULATED value, ' +
        'not the knob (20) — a stuck value, not a graceful degrade',
    ).toBe(95);
    // NEGATIVE CONTROL, the other direction: the only thing that releases the
    // latch is a knob move, so the probe above is reading a real hold rather
    // than a value that was never going to change.
    s.set(20);
    expect(s.read(), 'a knob move is the ONLY release').toBe(20);
  });

  it('ignores a non-finite push instead of drawing NaN', () => {
    const { ctx } = fakeCtx();
    const s = createCvShadow(ctx, 20);
    s.setCombined(Number.NaN);
    expect(s.read()).toBe(20);
    s.setCombined(undefined);
    expect(s.read()).toBe(20);
  });

  it('gives every pad its OWN AudioParam — the #1664 aliasing class', () => {
    const { ctx } = fakeCtx();
    const a = createCvShadow(ctx, 1);
    const b = createCvShadow(ctx, 1);
    expect(a.param).not.toBe(b.param);
    expect(a.node).not.toBe(b.node);
  });

  it('disposes its one node', () => {
    const { ctx, disconnects } = fakeCtx();
    createCvShadow(ctx, 1).dispose();
    expect(disconnects()).toBe(1);
  });
});
