// packages/web/src/lib/audio/cv-shadow.ts
//
// THE LANDING PAD where a knob and a CV cable meet, for a param whose consumer
// is JAVASCRIPT — a card's draw code, a per-frame painter — rather than a Web
// Audio node.
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
// Note the shape of the second one: a naive "did patching a cable change the
// audio?" check calls it a PASS. Only the KNOB leg reading 0.0000e+0 exposes it.
//
// ---------------------------------------------------------------------------
// WHAT A LANDING PAD IS — AND WHY IT READS NOTHING ITSELF
// ---------------------------------------------------------------------------
//
//     GainNode  ← `.gain` is published as the port's param, and is reachable
//                 from NOTHING. The knob lives in its intrinsic; the engine
//                 sums every connected CV cable into it.
//
// One per port, always: two ports sharing an AudioParam means at most one of
// them can be the real param, which is the #1664 aliasing class.
//
// ⚠ It does NOT read its own value back. The obvious way to do that — pin a
// `ConstantSource(1)` into the gain and tap its output with an `AnalyserNode`,
// the WAVESCULPT camera-shadow shape — costs ONE PERMANENTLY RETAINED Blink
// AudioHandler PER PORT. Measured on the production build via CDP
// `Performance.getMetrics`, 20 chains per variant, GC forced twice per reading:
//
//     carrier + gain + analyser, stopped and disconnected  → 1.00 retained/chain
//     gain + analyser (no carrier)                         → 1.00 retained/chain
//     carrier + gain (NO ANALYSER)                         → 0.00 retained/chain
//     carrier left un-stopped                              → 2.00 retained/chain
//
// The AnalyserNode is the one that never comes back, however it is torn down —
// which is also the exact explanation of the per-module table in
// `e2e/tests/patch-load-leak.spec.ts` (`scope 2` = its two signal analysers;
// `delay 0` = it has none). Nine shadows with analysers took SCOPE's retention
// from 2 to a measured 11 per card, patched and unpatched alike.
//
// So the combined value is NOT read here. It is read from the tap the ENGINE
// already builds: `addEdge` creates one `AnalyserNode` per (node, port) that
// actually has a cable, and `AudioEngine.readParam(nodeId, paramId)` returns
// `knob intrinsic + tap sample` — the combined value, for free, with nothing new
// retained and with teardown the engine already owns (`removeNode`). A consumer
// holding the engine pushes it back in via `setCombined`; see `ScopeCard` /
// `RasterizeCard`. Nothing patched ⇒ no tap ⇒ `readParam` returns the knob, so
// the pushed value and the knob agree and no render moves.

/** A knob+CV landing pad for a JS-consumed param. Create one PER PORT. */
export interface CvShadow {
  /** Publish as the port's `node`. Out of the audio path by construction, so
   *  even the engine's no-param fallback branch cannot land a cable on live
   *  audio. */
  readonly node: AudioNode;
  /** Publish as the port's `param`. The engine sums every CV cable into it —
   *  and, because a param IS published, also builds the tap that `readParam`
   *  reads. Both halves of the fix depend on this being here. */
  readonly param: AudioParam;
  /** The value to DRAW with: the pushed combined (knob + CV) value when a
   *  consumer with engine access has supplied one, else the knob. */
  read(): number;
  /** Apply a knob move. Call from the module's `setParam`. */
  set(value: number): void;
  /** Supply `AudioEngine.readParam`'s combined value. Pass `undefined` to fall
   *  back to the knob. */
  setCombined(value: number | undefined): void;
  /** The knob intrinsic alone — what `readParam` reports (the engine adds the
   *  modulator tap on top of it for the motorized fader, so returning the
   *  combined value there would double-count the cable). */
  knob(): number;
  dispose(): void;
}

export function createCvShadow(ctx: BaseAudioContext, initial: number): CvShadow {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(initial, ctx.currentTime);

  let knobValue = initial;
  let combined: number | undefined;

  return {
    node: gain,
    param: gain.gain,
    read(): number {
      return combined ?? knobValue;
    },
    set(value: number): void {
      knobValue = value;
      // The knob is the AudioParam's INTRINSIC, so a cable summed in by the
      // engine and a knob move land on one junction instead of racing.
      gain.gain.setValueAtTime(value, ctx.currentTime);
      // A knob move invalidates any stale combined sample: the next push will
      // carry the new intrinsic, and until then the knob is the honest answer.
      combined = undefined;
    },
    setCombined(value: number | undefined): void {
      combined = Number.isFinite(value as number) ? value : undefined;
    },
    knob(): number {
      return knobValue;
    },
    dispose(): void {
      try { gain.disconnect(); } catch { /* */ }
    },
  };
}
