// packages/web/src/lib/audio/level-meter.ts
//
// A tiny reusable OUTPUT-LEVEL tap for the module-faceplate refactor: hang a
// passive AnalyserNode off a module's output node and expose a `getLevel()`
// that returns the current RMS as a 0..1 fraction. This is the LIVE source the
// VuMeter glyph renders (via the card's `engine.read(node, 'level')` handle +
// the shared onMeterFrame ticker) — a thin tap over the SAME AnalyserNode seam
// the scope / waveform glyphs already use, not a new metering stack.
//
// The pure `rmsUnit` is unit-testable in isolation; `createLevelTap` is the
// Web Audio glue.

/** Root-mean-square of a time-domain buffer, as a 0..1 fraction (a full-scale
 *  ±1 sine reads ~0.707; a ±1 square reads ~1). Clamped to [0,1]. Pure. */
export function rmsUnit(buf: ArrayLike<number>): number {
  const n = buf.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = buf[i] ?? 0;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / n);
  return rms < 0 ? 0 : rms > 1 ? 1 : rms;
}

export interface LevelTap {
  /** The current output RMS as a 0..1 fraction. Cheap — reads the analyser. */
  getLevel(): number;
  /** Disconnect the tap. Call from the handle's dispose(). */
  dispose(): void;
}

/**
 * Attach a passive analyser to `source` and return a level getter. The analyser
 * is a pure SINK (never connected onward), so it adds no load to the audio path
 * — identical to the scope's on-card waveform tap. `fftSize` sets the RMS
 * window (default 1024 ≈ 21 ms at 48 kHz — a smooth, responsive meter).
 */
export function createLevelTap(
  ctx: BaseAudioContext,
  source: AudioNode,
  fftSize = 1024,
): LevelTap {
  // Degrade gracefully where AnalyserNode is unavailable (mock AudioContexts in
  // unit tests, SSR): a no-op tap that always reads silence. The card's VuMeter
  // then simply stays dark — no throw, no metering.
  if (typeof ctx.createAnalyser !== 'function') {
    return { getLevel: () => 0, dispose: () => {} };
  }
  const analyser = ctx.createAnalyser();
  analyser.fftSize = fftSize;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  return {
    getLevel() {
      analyser.getFloatTimeDomainData(buf);
      return rmsUnit(buf);
    },
    dispose() {
      try {
        analyser.disconnect();
      } catch {
        /* already gone */
      }
    },
  };
}
