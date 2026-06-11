// packages/dsp/src/lib/twotracks-engine.ts
//
// Pure, unit-testable tape-transport core for the TWOTRACKS worklet.
//
// The AudioWorkletProcessor (../twotracks.ts) imports and RUNS this code, so the
// logic that ships is the logic the tests exercise — no mirror, no drift. (This
// file lives under src/lib/, which the dsp build's non-recursive readdir does
// NOT treat as a worklet entry; it's bundled into twotracks.js like the other
// src/lib/*-dsp cores.)
//
// This owns the tape MECHANICS: the record window, varispeed record-write,
// cursor advance + loop/stop boundaries, the reported playhead, and the
// ECHOES→decay mapping. EQ / filter / scrub / lofi stay in the worklet — they
// process the sample this engine reads.

export type TapeState = 'idle' | 'play' | 'armed' | 'rec' | 'overdub';

/** Fixed physical "blank tape" length in samples (≈20 s @ 48 kHz). Single
 *  source of truth — the worklet + web module reference this length. */
export const TWOTRACKS_TAPE_LEN = 960_000;

/**
 * Per-overdub-pass decay factor for an ECHOES count (1..5).
 *
 * ECHOES ≈ how many audible overdub repeats remain before the oldest layer
 * fades out. Target ~10% (−20 dB) residual after `echoes` passes →
 * factor = 0.1^(1/echoes): echoes=1 → 0.10 (one repeat then gone),
 * echoes=3 → ~0.46, echoes=5 → ~0.63 (long, lush feedback).
 */
export function echoesToDecay(echoes: number): number {
  const n = Math.max(1, Math.min(5, Math.round(echoes)));
  return Math.pow(0.1, 1 / n);
}

/**
 * Length of the transport window for the current state.
 *
 * While FRESH-recording ('rec') the window spans the WHOLE physical tape so the
 * cursor advances linearly to the end — recording runs until STOP or the tape
 * fills. Clamping to the still-growing bufLen (the original bug) collapses the
 * window to a few ms each block and the cursor loops over the last fragment
 * ("chopped" record). Playback / overdub loop over the recorded region (bufLen).
 */
export function recordWindowLen(
  state: TapeState,
  bufLen: number,
  tapeLen: number = TWOTRACKS_TAPE_LEN,
): number {
  if (state === 'rec') return tapeLen;
  return bufLen > 0 ? bufLen : tapeLen;
}

/** Linear-interpolated read from a channel buffer at a fractional position. */
export function readInterp(buf: Float32Array, pos: number): number {
  const len = buf.length;
  if (len === 0 || pos < 0) return 0;
  if (pos >= len - 1) return pos < len ? (buf[len - 1] ?? 0) : 0;
  const i = Math.floor(pos);
  const f = pos - i;
  const a = buf[i] ?? 0;
  const b = buf[i + 1] ?? 0;
  return a + (b - a) * f;
}

/**
 * Write one input sample across the integer cells the record head sweeps as the
 * tape moves from `from`→`to` (either direction). This is what makes varispeed
 * RECORD tape-accurate:
 *   - |rate| > 1: the input is smeared across several cells (recorded
 *     "stretched" → on 1× playback it sounds lower / longer),
 *   - |rate| < 1: successive inputs overwrite the same cell (recorded
 *     "compressed" → on 1× playback it sounds higher / shorter).
 * `overdub` adds onto existing content (layering) instead of overwriting.
 * Returns the (possibly grown) bufLen.
 */
export function recordSpan(
  bufL: Float32Array,
  bufR: Float32Array,
  from: number,
  to: number,
  srcL: number,
  srcR: number,
  overdub: boolean,
  tapeLen: number,
  bufLen: number,
): number {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  let p = Math.floor(lo);
  // Always write at least the starting cell (covers rate≈0 and sub-1 spans).
  const end = Math.max(Math.ceil(hi), p + 1);
  let newLen = bufLen;
  for (; p < end; p++) {
    if (p < 0 || p >= tapeLen) continue;
    if (overdub) {
      bufL[p] = (bufL[p] ?? 0) + srcL;
      bufR[p] = (bufR[p] ?? 0) + srcR;
    } else {
      bufL[p] = srcL;
      bufR[p] = srcR;
    }
    if (p >= newLen) newLen = p + 1;
  }
  return newLen;
}

export interface AdvanceResult {
  cursor: number;
  state: TapeState;
  /** True when an overdub loop wrapped — the worklet applies window decay. */
  decayPass: boolean;
}

/**
 * Advance the cursor by `rate` and resolve the window boundary.
 *
 * - 'rec' running off either end of the tape STOPS recording → 'play' (the
 *   captured loop), reset to the window start. Recording otherwise runs until an
 *   external STOP.
 * - loop mode (modeVal=1): play / overdub wrap modulo the window (overdub flags
 *   a decay pass).
 * - one-shot (modeVal=0): overdub→play, play→idle at the boundary.
 */
export function advanceCursor(
  cursor: number,
  rate: number,
  state: TapeState,
  modeVal: 0 | 1,
  windowStart: number,
  windowEnd: number,
): AdvanceResult {
  const windowLen = Math.max(1, windowEnd - windowStart);
  let c = cursor + rate;
  let s = state;
  let decayPass = false;

  if (c >= windowEnd) {
    if (s === 'rec') {
      s = 'play';
      c = windowStart;
    } else if (modeVal === 1) {
      c = windowStart + ((c - windowStart) % windowLen);
      if (s === 'overdub') decayPass = true;
    } else {
      c = windowEnd;
      if (s === 'overdub') { s = 'play'; c = windowStart; }
      else if (s === 'play') { s = 'idle'; c = windowStart; }
    }
  } else if (c < windowStart) {
    if (s === 'rec') {
      s = 'play';
      c = windowStart;
    } else if (modeVal === 1) {
      c = windowEnd - ((windowStart - c) % windowLen);
    } else {
      c = windowStart;
      if (s === 'overdub') s = 'play';
      else if (s === 'play') s = 'idle';
    }
  }

  return { cursor: c, state: s, decayPass };
}

export interface TransportResult {
  /** New transport state. */
  state: TapeState;
  /** Whether the cursor should rewind to the window start (fresh record / play
   *  from the top). False = act at the current playhead (punch-in / punch-out). */
  seekToStart: boolean;
}

/**
 * Tape-deck transport-button state machine (REC / PLAY / STOP):
 *
 *  - REC when stopped → ARM (nothing records until PLAY).
 *  - PLAY when armed → roll + record from the top (overwrite, or overdub if the
 *    overdub flag is set).
 *  - PLAY when stopped/idle → play the tape from the top.
 *  - REC while playing → PUNCH IN at the current playhead (overwrite/overdub),
 *    no rewind.
 *  - REC while recording → PUNCH OUT back to play (keep rolling).
 *  - REC while armed → disarm.
 *  - STOP → idle.
 */
export function transportButton(
  action: 'rec' | 'play' | 'stop',
  state: TapeState,
  overdubFlag: boolean,
): TransportResult {
  const recState: TapeState = overdubFlag ? 'overdub' : 'rec';
  if (action === 'stop') return { state: 'idle', seekToStart: false };

  if (action === 'rec') {
    if (state === 'play') return { state: recState, seekToStart: false };   // punch in
    if (state === 'rec' || state === 'overdub') return { state: 'play', seekToStart: false }; // punch out
    if (state === 'armed') return { state: 'idle', seekToStart: false };     // disarm
    return { state: 'armed', seekToStart: false };                           // idle → arm
  }

  // action === 'play'
  if (state === 'armed') return { state: recState, seekToStart: true };      // engage armed record from top
  if (state === 'rec' || state === 'overdub') return { state, seekToStart: false }; // already rolling
  return { state: 'play', seekToStart: true };                              // (re)start playback from top
}

/** Reported playhead position 0..1 = cursor within the WHOLE tape (the card
 *  draws the full blank tape and fills the recorded region into it). */
export function playheadNorm(cursor: number, tapeLen: number = TWOTRACKS_TAPE_LEN): number {
  if (tapeLen <= 0) return 0;
  const n = cursor / tapeLen;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Minimum loop-window width as a fraction of the tape (handles can't cross /
 *  collapse the window). */
export const MIN_LOOP_GAP = 0.01;

/**
 * Resolve the absolute loop window [windowStart, windowEnd) in samples from the
 * normalized start/end (fractions of the WHOLE tape, matching the card's
 * waveform which is drawn over the whole tape) — clamped to the playable extent
 * (the recorded region during playback, the whole tape while recording). So the
 * default 0..1 still loops just the recording, and the scrubbers narrow within
 * it. Mirrored by processReel.
 */
export function loopWindow(
  startNorm: number,
  endNorm: number,
  state: TapeState,
  bufLen: number,
  tapeLen: number = TWOTRACKS_TAPE_LEN,
): { windowStart: number; windowEnd: number } {
  const playable = recordWindowLen(state, bufLen, tapeLen);
  const windowStart = Math.max(0, Math.min(playable - 1, startNorm * tapeLen));
  const windowEnd = Math.max(windowStart + 1, Math.min(playable, endNorm * tapeLen));
  return { windowStart, windowEnd };
}

/**
 * Clamp a dragged loop START (0..1) so it can't cross the END and — while the
 * transport is rolling (playheadNorm non-null) — can't be dragged PAST the
 * playhead (the playhead must stay inside the window). When stopped, pass null.
 */
export function clampLoopStart(value: number, endNorm: number, playheadNorm: number | null): number {
  let hi = endNorm - MIN_LOOP_GAP;
  if (playheadNorm !== null) hi = Math.min(hi, playheadNorm);
  return Math.max(0, Math.min(value, hi));
}

/** Clamp a dragged loop END — can't cross START, and can't be dragged below the
 *  playhead while rolling. */
export function clampLoopEnd(value: number, startNorm: number, playheadNorm: number | null): number {
  let lo = startNorm + MIN_LOOP_GAP;
  if (playheadNorm !== null) lo = Math.max(lo, playheadNorm);
  return Math.min(1, Math.max(value, lo));
}

// ─── Signal path: cross-feed + output mix ──────────────────────────────────
//
// The per-reel signal path (mirrored sample-by-sample in processReel):
//   inputPath = crossfeedInput(dryIn, crossGain, otherReelPlayback)
//   if recording → the tape RECORDS inputPath (cross-feed captured to tape)
//   output       = reelOutSample(tapePlayback, inputPath, monitorOn, freshRec)
// so the cross-feed behaves EXACTLY like the live input — recorded when this
// reel records, heard when it monitors, silent (live) on pure playback.
//
// FRESH-RECORD MONITOR CRUSH (fixed):
//   While FRESH-recording ('rec', i.e. NOT overdub) the record head is writing
//   the live input into the SAME integer cells it then reads back the next sample
//   for playback. The write is sample-quantized (integer cells via recordSpan)
//   while the read is fractional/interpolated (readInterp at a varispeed cursor),
//   so the tape read-back of the region under the head is a DECIMATED, aliased
//   copy of the live input. With MONITOR on, the old mix `tape + input` summed
//   that decimated read-back ONTO the clean live input → a comb/aliasing
//   artifact the owner heard as "bitcrushed" the instant RECORD engaged — even
//   though the tape itself (and therefore the recording) is clean.
//   Fix: during fresh 'rec' the monitor must NOT mix the tape read-back of the
//   head you're actively writing. The monitor outputs the clean input path (what
//   you heard while just monitoring); the recording is unaffected. Overdub and
//   plain playback still mix the existing tape content normally.

/**
 * Cross-feed: blend a fraction of the OTHER reel's playback into THIS reel's
 * input path. `crossGain` 0 = OFF (identity → byte-for-byte today's behavior);
 * 1 = the other reel's playback at full level summed onto the input. The result
 * is treated like the live input: captured to tape while recording and audible
 * while monitoring (that's why A→B is "heard in the B stream, or in what B is
 * recording"). Used for A→B (crossGain=a2b, other=A) and B→A (crossGain=b2a).
 */
export function crossfeedInput(dryIn: number, crossGain: number, otherPlay: number): number {
  return dryIn + crossGain * otherPlay;
}

/**
 * One reel's audible output sample (BEFORE the A/B crossfade gain):
 *   tape playback (what's under the head; pass 0 when not rolling)
 *   + the input path (dry + cross-feed) ONLY when monitoring.
 *
 * With monitor OFF you hear ONLY the tape under the head — no dry signal and no
 * live cross-feed bleed (the cross-feed is still captured to tape while
 * recording, via the record source = inputPath). With monitor ON the input is
 * mixed INTO the play/record mix (input + tape), not instead of it.
 *
 * `freshRec` true = this reel is FRESH-recording (state 'rec', NOT overdub). In
 * that case the tape read-back of the head being written is a decimated copy of
 * the live input (see the FRESH-RECORD MONITOR CRUSH note above), so it is NOT
 * mixed into the monitor output — the monitor passes the clean input path,
 * matching what you hear while merely monitoring. The recording is independent
 * (the worklet writes the input to tape regardless), so the captured take stays
 * clean. Overdub (freshRec=false) keeps mixing the existing tape so you can hear
 * the layers you're playing over.
 */
export function reelOutSample(
  tapePlay: number,
  inputPath: number,
  monitorOn: boolean,
  freshRec: boolean = false,
): number {
  const tape = freshRec ? 0 : tapePlay;
  return tape + (monitorOn ? inputPath : 0);
}
