// packages/web/src/lib/audio/cv-shadow.test.ts
//
// The one branch `art/scenarios/cv-display-param-reach` structurally cannot
// reach. That sweep always renders, so `ctx.currentTime` is always > 0 there
// and the analyser is always authoritative. The BEFORE-ANY-RENDER branch is
// the one every card actually starts life in: a browser AudioContext sits at
// currentTime 0 until the user's first gesture resumes it, and until then the
// shadow's analyser ring is all zeros — indistinguishable from a genuine zero.
// If that fallback were wrong, every SCOPE and RASTERIZE would draw with 0 for
// every parameter until the user clicked something.

import { describe, expect, it } from 'vitest';
import { createCvShadow } from './cv-shadow';

/** A context whose analysers report a settable tail sample, and whose clock we
 *  can move across the `currentTime <= 0` boundary by hand. */
function fakeCtx(): {
  ctx: BaseAudioContext;
  advance: (t: number) => void;
  setTail: (v: number) => void;
  setState: (s: AudioContextState) => void;
} {
  let now = 0;
  let tail = 0;
  let state: AudioContextState = 'running';
  const ctx = {
    get currentTime() { return now; },
    get state() { return state; },
    createGain: () => ({
      gain: { value: 0, setValueAtTime(v: number) { (this as { value: number }).value = v; } },
      connect() {}, disconnect() {},
    }),
    createConstantSource: () => ({
      offset: { value: 0 }, start() {}, stop() {}, connect() {}, disconnect() {},
    }),
    createAnalyser: () => ({
      fftSize: 32,
      smoothingTimeConstant: 0,
      connect() {}, disconnect() {},
      getFloatTimeDomainData(buf: Float32Array) {
        buf.fill(0);
        buf[buf.length - 1] = tail;
      },
    }),
  } as unknown as BaseAudioContext;
  return {
    ctx,
    advance: (t) => { now = t; },
    setTail: (v) => { tail = v; },
    setState: (s) => { state = s; },
  };
}

describe('createCvShadow — the knob/CV junction for a JS-consumed param', () => {
  it('reports the KNOB before the context has rendered anything', () => {
    const { ctx } = fakeCtx();
    const s = createCvShadow(ctx, 20);
    // currentTime is 0: a fresh or never-resumed context. The analyser ring is
    // all zeros, so trusting it here would draw a timebase of 0 ms.
    expect(s.read(), 'a never-resumed context must report the knob, not the empty analyser').toBe(20);
  });

  it('follows a knob move before any render', () => {
    const { ctx } = fakeCtx();
    const s = createCvShadow(ctx, 20);
    s.set(120);
    expect(s.read()).toBe(120);
    expect(s.knob()).toBe(120);
  });

  it('switches to the ANALYSER — the combined knob + CV value — once the clock has advanced', () => {
    const { ctx, advance, setTail } = fakeCtx();
    const s = createCvShadow(ctx, 20);
    // The engine has summed a cable into `.gain`, so the shadow's output (and
    // therefore its analyser) reads knob + cable while `.gain.value` still
    // reads only the knob. That difference IS the fix for #1664.
    setTail(95);
    advance(0.01);
    expect(s.read(), 'once rendering has happened the analyser is authoritative').toBe(95);
    expect(s.knob(), 'the knob leg is unchanged — readParam must not double-count the cable').toBe(20);
  });

  it('reports a genuine ZERO rather than falling back to a non-zero knob', () => {
    // The failure mode of the obvious `tail || knob` shorthand: a cable that
    // drives the value to exactly 0 would read as the knob instead.
    const { ctx, advance, setTail } = fakeCtx();
    const s = createCvShadow(ctx, 20);
    setTail(0);
    advance(0.01);
    expect(s.read(), 'a rendered zero is a real value, not a missing one').toBe(0);
  });

  it('reports the KNOB while the clock is SUSPENDED, so a fader still moves the picture', () => {
    // The regression this guards: with the context paused (a VRT freeze, a
    // rack the user has not started) the analyser ring is stuck on whatever
    // was last rendered. Trusting it would mean a knob move never reaches the
    // card at all — and would move every frozen VRT baseline, since those are
    // captured with the context suspended and drawn from the knob today.
    const { ctx, advance, setTail, setState } = fakeCtx();
    const s = createCvShadow(ctx, 20);
    setTail(95);
    advance(0.01);
    expect(s.read(), 'running: the analyser wins').toBe(95);
    setState('suspended');
    expect(s.read(), 'suspended: a frozen ring cannot answer, so report the knob').toBe(20);
    s.set(120);
    expect(s.read(), 'and a fader move while suspended must still be visible').toBe(120);
    setState('running');
    expect(s.read(), 'resumed: back to the live combined value').toBe(95);
  });

  it('still reads the analyser after an offline render, which reports state CLOSED', () => {
    // OfflineAudioContext is `suspended` before startRendering() and `closed`
    // after — measured against node-web-audio-api. The suspended guard must
    // not swallow a completed render, or every ART assertion built on
    // read('drawParams') would silently read the knob back to itself.
    const { ctx, advance, setTail, setState } = fakeCtx();
    const s = createCvShadow(ctx, 20);
    setTail(95);
    advance(0.05);
    setState('closed');
    expect(s.read()).toBe(95);
  });

  it('gives every shadow its OWN AudioParam — the #1664 aliasing class', () => {
    const { ctx } = fakeCtx();
    const a = createCvShadow(ctx, 1);
    const b = createCvShadow(ctx, 1);
    expect(a.param).not.toBe(b.param);
    expect(a.node).not.toBe(b.node);
  });
});
