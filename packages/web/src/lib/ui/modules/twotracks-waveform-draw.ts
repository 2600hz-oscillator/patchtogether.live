// packages/web/src/lib/ui/modules/twotracks-waveform-draw.ts
//
// THE ONE TWOTRACKS REEL PICTURE — shared by `TwotracksCard.svelte` (the legacy
// card, two reels side by side) and `twotracks/TwotracksReelBody.svelte` (the
// faceplate's dock body, one reel at a time).
//
// ⚠ WHY SHARED RATHER THAN COPIED, and it is a stronger reason here than the
// usual one. This picture is not decoration beside the controls: START and END
// are POSITIONS IN IT. The player drags the loop window on this canvas, and the
// hit-test that decides "you grabbed the START marker" versus "you are scrubbing
// the playhead" is the same arithmetic that decides where the marker is PAINTED.
// If the draw and the hit-test ever disagree by a pixel, the module develops a
// dead zone the user experiences as the handle not responding — and a copy in a
// second file is exactly how that drift starts. One fold, one geometry, one
// hit-test, two callers.
//
// ⚠ PURE, AND 2D ON PURPOSE. No Svelte, no store, no engine — the caller
// resolves the peaks and the transport state, this paints them. That makes the
// geometry unit-testable with no browser (`twotracks-waveform-draw.test.ts`).
// It must also stay a 2D canvas: `twotracks` is absent from the WebGL attest
// basis (measured — `scripts/webgl-attest-hash.sh --list` names none of its
// files), and the basis is derived from CONTENT, so a WebGL reel picture would
// enrol the module and make every later edit cost a GPU re-attest.

/** What to paint. Everything is resolved by the caller. */
export interface TwotracksReelView {
  /**
   * The worklet's peak envelope for this reel, or null when the reel has never
   * recorded. Read per frame off `engine.read(node,'peaksA'|'peaksB')`.
   */
  peaks: Float32Array | null;
  /** Recorded length in samples. 0 means BLANK TAPE — see the note below. */
  bufLen: number;
  /** Live read position as a fraction of the whole tape (0..1). */
  playheadFrac: number;
  /** Loop window START as a fraction of the whole tape (0..1). */
  startFrac: number;
  /** Loop window END as a fraction of the whole tape (0..1). */
  endFrac: number;
}

const BG = '#0a0c11';
const TRACE = 'rgb(255, 140, 40)';
const OUT_OF_LOOP = 'rgba(6, 8, 12, 0.62)';
const PLAYHEAD = 'rgba(80, 160, 255, 0.85)';
const HANDLE_START = 'rgba(120, 230, 140, 0.95)';
const HANDLE_END = 'rgba(255, 150, 80, 0.95)';
const EMPTY_TEXT = '#5a6275';

/**
 * THE EMPTY-TAPE STRING, and it is named here because this is the only place
 * that can see it.
 *
 * A blank reel paints this rather than nothing. "No tape has been recorded yet"
 * and "the body failed to mount" are different facts and they must be different
 * pictures — a body that painted an empty rectangle would make a broken mount
 * look exactly like a fresh spawn, which is the state a VRT baseline captures.
 *
 * ⚠ It is TEXT DRAWN INTO A CANVAS, so `face-resting-text-source.test.ts`
 * structurally cannot see it (that gate reads `ModuleFace` fields and says so).
 * It is legitimate under the resting-text ruling for the same reason samsloop's
 * `NO SAMPLE LOADED` is: it names the surface's OWN condition and is replaced by
 * the waveform the moment a tape exists — it is not a measurement of any
 * control, and there is no number in it.
 */
export const TWOTRACKS_EMPTY_TAPE_TEXT = 'NO TAPE';

/** px hit radius around a loop handle. Shared so the draw and the hit-test
 *  cannot disagree about how big the grab target is. */
export const TWOTRACKS_HANDLE_HIT_PX = 8;

/** Does this reel have anything recorded on it? The one predicate both the
 *  draw and the callers branch on, so "blank" means one thing. */
export function twotracksHasTape(view: Pick<TwotracksReelView, 'peaks' | 'bufLen'>): boolean {
  return view.peaks !== null && view.bufLen > 0;
}

/**
 * Convert a pointer offset in CSS pixels to a tape fraction.
 *
 * ⚠ DIVIDE BY THE DISPLAYED WIDTH, NOT THE BUFFER WIDTH. `offsetX` is in CSS
 * pixels while the canvas's drawing buffer may be a different size; dividing by
 * `canvas.width` makes the rightmost reachable fraction less than 1, and the END
 * handle — which sits at exactly 1 by default — becomes ungrabbable. That was a
 * real defect on the card and the comment is carried here with the code.
 */
export function twotracksPosToFrac(offsetX: number, displayedWidthPx: number): number {
  const w = displayedWidthPx || 1;
  const f = offsetX / w;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/**
 * Which loop element a pointer at `frac` is grabbing: the closer of the two
 * handles when within the hit radius, else the playhead (a scrub).
 *
 * ⚠ THE TWO ANSWERS GO TO DIFFERENT SEAMS AND THAT IS THE WHOLE POINT.
 * `'start'` / `'end'` are a DURABLE SETTING — they write `start_a` / `end_a`
 * through `setNodeParam`, so they are undoable and synced. `'playhead'` is a
 * TRANSIENT PERFORMANCE GESTURE — it posts `{type:'seek'}` to the worklet and
 * touches neither the Y.Doc nor the undo stack. Collapsing them would put a
 * frame-rate cursor into the document, which is the CV write-storm class this
 * repo has a standing rule against.
 */
export function twotracksHandleHit(
  frac: number,
  startFrac: number,
  endFrac: number,
  widthPx: number,
): 'start' | 'end' | 'playhead' {
  const t = TWOTRACKS_HANDLE_HIT_PX / Math.max(1, widthPx);
  const dStart = Math.abs(frac - startFrac);
  const dEnd = Math.abs(frac - endFrac);
  if (dStart <= t && dStart <= dEnd) return 'start';
  if (dEnd <= t) return 'end';
  return 'playhead';
}

/** Where the three movable marks land, in device pixels, for a canvas `w` wide.
 *  Exported for its test — this is the arithmetic the hit-test must agree with. */
export function twotracksMarkPositions(
  view: Pick<TwotracksReelView, 'startFrac' | 'endFrac' | 'playheadFrac'>,
  w: number,
): { startX: number; endX: number; playheadX: number } {
  return {
    startX: Math.round(view.startFrac * w),
    endX: Math.round(view.endFrac * w),
    playheadX: Math.round(view.playheadFrac * w),
  };
}

/**
 * Paint one reel. Draws the peak envelope, dims the tape outside the loop
 * window, marks the playhead, and draws both draggable loop handles.
 *
 * A reel with no tape paints `TWOTRACKS_EMPTY_TAPE_TEXT` and NO playhead — a
 * stationary cursor on a blank reel would suggest a position on a tape that does
 * not exist. The handles are drawn either way, because they stay grabbable: you
 * set a loop window before you record into it.
 */
export function drawTwotracksReel(
  canvasEl: HTMLCanvasElement | null,
  view: TwotracksReelView,
): void {
  if (!canvasEl) return;
  const ctx2d = canvasEl.getContext('2d');
  if (!ctx2d) return;
  const w = canvasEl.width;
  const h = canvasEl.height;

  ctx2d.clearRect(0, 0, w, h);
  ctx2d.fillStyle = BG;
  ctx2d.fillRect(0, 0, w, h);

  const hasTape = twotracksHasTape(view);
  const peaks = view.peaks;

  if (!hasTape || !peaks) {
    ctx2d.fillStyle = EMPTY_TEXT;
    ctx2d.font = '9px ui-monospace, monospace';
    ctx2d.textAlign = 'center';
    ctx2d.fillText(TWOTRACKS_EMPTY_TAPE_TEXT, w / 2, h / 2);
  } else {
    const pts = peaks.length;
    ctx2d.strokeStyle = TRACE;
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    for (let x = 0; x < w; x++) {
      const pi = Math.floor((x / w) * pts);
      const peak = peaks[pi] ?? 0;
      ctx2d.moveTo(x + 0.5, (0.5 - peak * 0.5) * h);
      ctx2d.lineTo(x + 0.5, (0.5 + peak * 0.5) * h);
    }
    ctx2d.stroke();
  }

  const { startX, endX, playheadX } = twotracksMarkPositions(view, w);

  // Dim the tape outside [start,end] so the span that actually plays is
  // obvious. Only when there IS tape — a blank reel stays a clean empty state.
  if (hasTape) {
    ctx2d.fillStyle = OUT_OF_LOOP;
    if (startX > 0) ctx2d.fillRect(0, 0, startX, h);
    if (endX < w) ctx2d.fillRect(endX, 0, w - endX, h);

    ctx2d.strokeStyle = PLAYHEAD;
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    ctx2d.moveTo(playheadX + 0.5, 0);
    ctx2d.lineTo(playheadX + 0.5, h);
    ctx2d.stroke();
  }

  // Loop handles — always grabbable, clamped 1 px inside the edge so a handle
  // parked at 0 or 1 is still visible and still has something to grab.
  const drawHandle = (x: number, color: string) => {
    const cx = Math.max(1, Math.min(w - 1, x));
    ctx2d.strokeStyle = color;
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    ctx2d.moveTo(cx + 0.5, 0);
    ctx2d.lineTo(cx + 0.5, h);
    ctx2d.stroke();
    ctx2d.fillStyle = color;
    ctx2d.fillRect(cx - 2, 0, 4, 4);
    ctx2d.fillRect(cx - 2, h - 4, 4, 4);
  };
  drawHandle(startX, HANDLE_START);
  drawHandle(endX, HANDLE_END);
}
