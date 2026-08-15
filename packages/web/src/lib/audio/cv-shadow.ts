// packages/web/src/lib/audio/cv-shadow.ts
//
// THE JUNCTION where a knob and a CV cable meet, for a param whose consumer is
// JAVASCRIPT — a card's draw code, a per-frame painter, a tick loop — rather
// than a Web Audio node.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
//
// `AudioEngine.addEdge` has exactly one way to deliver a same-domain CV cable
// to a `paramTarget` port: it connects the source to the AudioParam the module
// published for that port (engine.ts, the `din.param` branch). It never calls
// `setParam`. So a module whose param is applied in JS has a problem — there is
// no AudioParam that *is* the param — and the two ways of guessing around it
// both shipped as live defects:
//
//   #1661 (SWOLEVCO) published a GainNode's `.gain` whose node output went
//   NOWHERE. The engine's per-param tap saw the CV and animated the motorized
//   fader, so the UI said it was working, while the measured peak |Δsample| of
//   patching a cable into any of the four inputs was exactly 0.0000e+0.
//
//   #1664 (SCOPE, RASTERIZE) published the `.gain` of a GainNode sitting in the
//   LIVE AUDIO PASSTHROUGH, and shared ONE of them across up to nine ports. The
//   param still never moved — but now the cable MULTIPLIED the through-signal:
//   `rasterize.cursor` measured 3.146e+5 peak against a 5.0e-1 baseline, a
//   629 000× blow-up pointed straight at the speaker bus.
//
// Note the shape of the second one, because it is why this helper takes the
// node as well as the param: a naive "did patching a cable change the audio?"
// check calls #1664 a PASS. Only the KNOB leg reading 0.0000e+0 exposes it.
//
// ---------------------------------------------------------------------------
// WHAT A SHADOW IS
// ---------------------------------------------------------------------------
//
//     ConstantSource(offset = 1) ──► GainNode ──► AnalyserNode
//                                       ▲
//                                       │ .gain  ← published as the port's param
//                                       │          (knob intrinsic, + every CV
//                                       │           cable the engine sums in)
//
// The GainNode's OUTPUT is therefore `1 × (knob + CV)` — the combined value, at
// audio rate — and `read()` samples it off the analyser. `AudioParam.value`
// deliberately cannot be used for this: it reports the intrinsic ONLY, which is
// precisely the knob-without-the-cable that both defects reported.
//
// The GainNode is reachable from NOTHING but its own analyser, so it can never
// scale, sum into, or otherwise touch the module's signal path — which is the
// structural half of the #1664 fix. `node` is exported for the port map so that
// even the engine's `else` branch (a cable that lands on the node input because
// no param was published) lands on the shadow rather than on live audio.
//
// ONE SHADOW PER PORT, ALWAYS. Two ports sharing a shadow means at most one of
// them can be the real param — the aliasing leg of the `cv-param-reach` sweep
// asserts object identity for exactly this reason.

/** A knob+CV junction for a JS-consumed param. Create one PER PORT. */
export interface CvShadow {
  /** Publish as the port's `node`. Out of the audio path by construction. */
  readonly node: AudioNode;
  /** Publish as the port's `param`. The engine sums every CV cable into it. */
  readonly param: AudioParam;
  /** The latest COMBINED (knob + CV) value. This is the number to draw with. */
  read(): number;
  /** Apply a knob move. Call from the module's `setParam`. */
  set(value: number): void;
  /** The knob intrinsic alone, with no CV folded in — what `readParam` reports
   *  (the engine adds the modulator tap on top for motorized faders). */
  knob(): number;
  dispose(): void;
}

/**
 * Build a shadow whose knob starts at `initial`.
 *
 * `read()` returns the combined value sampled from the analyser — but ONLY
 * while the analyser can actually be fresh. It falls back to the knob when:
 *
 *   - `currentTime === 0` — a fresh or never-resumed context. Every card
 *     starts life here: a browser AudioContext does not advance until the
 *     user's first gesture, and until then the ring is all zeros, which is
 *     indistinguishable from a genuine zero.
 *   - `state === 'suspended'` — the clock is STOPPED, so the ring is frozen on
 *     whatever was last rendered and a knob move would never appear. Both the
 *     VRT harness (which suspends before snapshotting) and a paused rack live
 *     here, and reporting the knob there is EXACTLY the pre-shadow behaviour,
 *     so no frozen frame moves. An offline render is `suspended` before
 *     `startRendering()` and `closed` after it, so a completed offline render
 *     still reads its analyser.
 *
 * With no cable patched the analyser reads back `1 × knob` EXACTLY (a
 * ConstantSource at 1.0 through a GainNode is an exact float multiply), so
 * adopting a shadow does not move any render that has no CV on it.
 */
export function createCvShadow(ctx: BaseAudioContext, initial: number): CvShadow {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(initial, ctx.currentTime);

  const carrier = ctx.createConstantSource();
  // offset = 1 so the gain's OUTPUT is the combined value rather than a scaled
  // copy of some other signal. This is the one line that separated the working
  // WAVESCULPT camera shadows from the dead SWOLEVCO ones (#1661), which were
  // pinned at offset 0.
  carrier.offset.value = 1;
  carrier.start();
  carrier.connect(gain);

  const analyser = ctx.createAnalyser();
  // 32 samples — the same window the engine's own param taps use
  // (`paramTapBuf`). Only the most-recent sample is ever read.
  analyser.fftSize = 32;
  analyser.smoothingTimeConstant = 0;
  gain.connect(analyser);
  const buf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));

  let knobValue = initial;

  return {
    node: gain,
    param: gain.gain,
    read(): number {
      // A stopped clock cannot produce a fresh sample, and a stale one would
      // pin the display to whatever was rendered before the pause.
      if (ctx.currentTime <= 0 || ctx.state === 'suspended') return knobValue;
      analyser.getFloatTimeDomainData(buf);
      return buf[buf.length - 1] ?? knobValue;
    },
    set(value: number): void {
      knobValue = value;
      gain.gain.setValueAtTime(value, ctx.currentTime);
    },
    knob(): number {
      return knobValue;
    },
    dispose(): void {
      try { carrier.stop(); } catch { /* already stopped */ }
      try { carrier.disconnect(); } catch { /* */ }
      try { gain.disconnect(); } catch { /* */ }
      try { analyser.disconnect(); } catch { /* */ }
    },
  };
}
