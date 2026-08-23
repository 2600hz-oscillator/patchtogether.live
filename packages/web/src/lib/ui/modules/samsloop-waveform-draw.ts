// packages/web/src/lib/ui/modules/samsloop-waveform-draw.ts
//
// THE ONE SAMSLOOP WAVEFORM DRAW — shared by `SamsloopCard.svelte` (the legacy
// card) and `samsloop/SamsloopOutputBody.svelte` (the faceplate's dock body).
//
// ⚠ WHY IT IS SHARED RATHER THAN COPIED. Promotion stops both surfaces rendering
// the card, but until the legacy shell is gone BOTH exist, and they must show the
// same picture of the same sample: this is the peak-per-pixel fold, the START..END
// window wash and the playhead, and every one of those is arithmetic that can
// drift. The repo has already paid for this exact shape twice on this module — a
// second hand-rolled PCM decode beside the playback path is how the recording came
// to draw correctly while making no sound.
//
// ⚠ PURE, AND THAT IS THE POINT. No Svelte, no store, no engine: the caller
// resolves the samples and the state, this paints them. That makes the fold and
// the window geometry unit-testable with no browser and no AudioContext, which is
// where `samsloop-waveform-draw.test.ts` lives.

/** What to paint. Everything is resolved by the caller. */
export interface SamsloopWaveformView {
  /** Decoded mono PCM to draw, or null when there is no sample yet. */
  samples: Float32Array | null;
  /** Window START as a FRACTION of the sample (0..1). */
  startFrac: number;
  /** Window END as a FRACTION of the sample (0..1). */
  endFrac: number;
  /**
   * Live play position as a FRACTION, or -1 for "nothing is sounding".
   *
   * ⚠ -1 IS NOT 0. A playhead parked at the sample's start and no playhead at
   * all are different facts, and a consumer that collapsed them would paint a
   * stationary line at the left edge of every idle module in the rack.
   */
  playheadFrac: number;
  /** Live-record view: the running peak bar, or null when not recording. */
  recordPeaks: Float32Array | null;
  /** How full the record bar is (0..1). Only read while `recordPeaks` is set. */
  recordFilledFrac: number;
}

const BG = '#0a0c11';
const TRACE = 'rgb(255, 150, 40)';
const WINDOW_WASH = 'rgba(80, 160, 220, 0.18)';
const PLAYHEAD = 'rgb(120, 255, 170)';
const REC_TRACE = 'rgb(255, 80, 60)';
const REC_FILL = 'rgba(255, 60, 60, 0.18)';
const REC_CAP = 'rgba(255, 200, 60, 0.5)';
const EMPTY_TEXT = '#5a6275';

/**
 * Fold `samples` to one min/max pair per pixel column.
 *
 * ⚠ EXPORTED FOR ITS TEST rather than for reuse. The fold is the part of this
 * file with an off-by-one worth pinning: a column reads `[x*n, (x+1)*n)` and the
 * LAST column must not run past the buffer.
 */
export function foldWaveformColumns(
  samples: Float32Array,
  width: number,
): { min: Float32Array; max: Float32Array } {
  const w = Math.max(1, Math.floor(width));
  const min = new Float32Array(w);
  const max = new Float32Array(w);
  const per = Math.max(1, Math.floor(samples.length / w));
  for (let x = 0; x < w; x++) {
    const i0 = x * per;
    const i1 = Math.min(samples.length, i0 + per);
    let mn = 0;
    let mx = 0;
    for (let i = i0; i < i1; i++) {
      const s = samples[i] ?? 0;
      if (s < mn) mn = s;
      if (s > mx) mx = s;
    }
    min[x] = mn;
    max[x] = mx;
  }
  return { min, max };
}

/** Paint the whole surface. Safe to call every frame. */
export function drawSamsloopWaveform(
  ctx2d: CanvasRenderingContext2D,
  width: number,
  height: number,
  view: SamsloopWaveformView,
): void {
  const w = width;
  const h = height;
  ctx2d.clearRect(0, 0, w, h);
  ctx2d.fillStyle = BG;
  ctx2d.fillRect(0, 0, w, h);

  // ── LIVE RECORD VIEW ──────────────────────────────────────────────────────
  // ⚠ THIS BRANCH IS WHY THE FACEPLATE SURFACE IS A `fullViewBody` AND NOT A
  // PANEL. A panel's picture must be DERIVABLE from params + node.data; the
  // running peak bar is neither — it lives in the node-keyed record registry's
  // closure and is published on its own clock, exactly the "per-frame live read"
  // the panel-vs-body discriminator names.
  if (view.recordPeaks) {
    const peaks = view.recordPeaks;
    const cols = Math.min(w, peaks.length);
    ctx2d.fillStyle = REC_FILL;
    ctx2d.fillRect(0, 0, Math.max(0, Math.min(1, view.recordFilledFrac)) * w, h);
    ctx2d.strokeStyle = REC_TRACE;
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    for (let x = 0; x < cols; x++) {
      const peak = peaks[x] ?? 0;
      if (peak === 0) continue;
      ctx2d.moveTo(x + 0.5, (1 - peak * 0.5 - 0.5) * h);
      ctx2d.lineTo(x + 0.5, (1 - -peak * 0.5 - 0.5) * h);
    }
    ctx2d.stroke();
    // Right edge: a thin vertical showing the length cap.
    ctx2d.strokeStyle = REC_CAP;
    ctx2d.beginPath();
    ctx2d.moveTo(w - 0.5, 0);
    ctx2d.lineTo(w - 0.5, h);
    ctx2d.stroke();
    return;
  }

  // ── IDLE / PLAYBACK VIEW ──────────────────────────────────────────────────
  const samples = view.samples;
  if (!samples || samples.length === 0) {
    ctx2d.fillStyle = EMPTY_TEXT;
    ctx2d.font = '10px ui-monospace, monospace';
    ctx2d.textAlign = 'center';
    ctx2d.fillText('NO SAMPLE LOADED', w / 2, h / 2);
    return;
  }

  // The START..END wash — the slice the worklet actually loops. Both bounds are
  // already fractions, so there is no division by the buffer length here; that
  // arithmetic is exactly where the re-decode boundary bug used to live.
  const s = Math.max(0, Math.min(1, view.startFrac));
  const e = Math.max(s, Math.min(1, view.endFrac));
  ctx2d.fillStyle = WINDOW_WASH;
  ctx2d.fillRect(s * w, 0, (e - s) * w, h);

  const { min, max } = foldWaveformColumns(samples, w);
  ctx2d.strokeStyle = TRACE;
  ctx2d.lineWidth = 1;
  ctx2d.beginPath();
  for (let x = 0; x < w; x++) {
    ctx2d.moveTo(x + 0.5, (1 - ((max[x] ?? 0) * 0.5 + 0.5)) * h);
    ctx2d.lineTo(x + 0.5, (1 - ((min[x] ?? 0) * 0.5 + 0.5)) * h);
  }
  ctx2d.stroke();

  // The PLAYHEAD, last so it sits over the trace. Suppressed entirely when
  // nothing is sounding — see the -1 note on the interface.
  if (view.playheadFrac >= 0) {
    const px = Math.max(0, Math.min(1, view.playheadFrac)) * w;
    ctx2d.strokeStyle = PLAYHEAD;
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(px + 0.5, 0);
    ctx2d.lineTo(px + 0.5, h);
    ctx2d.stroke();
  }
}
