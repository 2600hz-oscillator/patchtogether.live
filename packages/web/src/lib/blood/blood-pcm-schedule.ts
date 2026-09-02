// packages/web/src/lib/blood/blood-pcm-schedule.ts
//
// HOW MANY FRAMES THE BLOOD PCM PUMP OWES THE WORKLET ON THIS TICK.
//
// ⚠ WHY THIS IS NOT `Math.round(44100 / 60)`, WHICH IS WHAT IT USED TO BE.
//
// BLOOD's engine is a single-threaded ASYNCIFY WASM build on the MAIN thread, so
// the mixer cannot be pulled from the audio thread. `blood.ts` instead runs a
// `setInterval(..., 16)` pump that calls `bpt_pump_audio(n)` — which MIXES `n`
// fresh frames on demand — and posts them to the `blood-pcm` worklet, whose ring
// the audio thread drains at the AudioContext's rate.
//
// The old pump asked for a FIXED 735 frames every tick. That number is 44100/60,
// and both halves of it are wrong here:
//
//   * The ring is drained at the CONTEXT's rate, and this app pins the context to
//     48 000 Hz (`Canvas.svelte`, so every ART baseline and worklet time-constant
//     is calibrated at one rate). 735 frames per tick is a 44.1 kHz budget being
//     spent against a 48 kHz drain.
//   * `setInterval(..., 16)` does not tick at 60 Hz, or at 62.5 Hz, or at any
//     rate the pump controls. It ticks whenever the main thread is free — and the
//     main thread is running the Build engine's `runFrame()` in rAF.
//
// So production was `735 × whatever-the-main-thread-allowed` and consumption was
// a flat 48 000/s. MEASURED on an IDLE 10-core dev box, in-game: the pump ticked
// every 24.8 ms and produced 29 846 frames/s against 48 000 consumed — **62 % of
// demand**. The ring is therefore empty BY CONSTRUCTION: it can never accumulate
// the cushion the worklet's own header claims it has ("generous headroom to ride
// out a long render frame"), because production never once exceeds consumption.
// 38 % of every output sample was a hard zero on a healthy machine.
//
// ⚠ AND IT DEGRADES TO TOTAL SILENCE, WHICH IS THE FLAKE. As the main thread
// starves, the tick rate falls and production falls with it — but consumption
// does not. Forced (a main-thread hog, `blood.ts`'s pump untouched):
//
//   hog        tick gap    produced/s    of demand    analyser reads with signal
//   none        24.8 ms      29 846         62 %          258 / 258
//   250 ms      28.3 ms       7 390         15 %           48 / 67
//   450 ms     459.7 ms       2 986        6.2 %           18 / 34
//   900 ms     924.5 ms         795        1.7 %            0 / 9   ← peak 0.0000
//
// At the bottom row the module emits 15.3 ms of audio per 924 ms and the SCOPE's
// 42.7 ms analyser window reads 0.0000 every single time — which is exactly the
// signature `blood-audio-output.spec.ts` reported from CI run 33593393587
// (`gamePeak=0.0000 menuPeak=0.0000 samples=30 reads=30 crossedAt=never`), on a
// shard whose sampler was starved to the same ~330 ms cadence. Menu AND game were
// silent because the deficit is upstream of everything the game does.
//
// ── WHAT THIS SCHEDULER DOES INSTEAD ───────────────────────────────────────
//
// Two independent properties, and the second is the one that survives a stall:
//
//  1. RATE-EXACT. Frames owed are derived from the CONTEXT CLOCK (`ac.currentTime`
//     × `ac.sampleRate`), not from a constant. A tick that arrives late owes the
//     whole gap, so production tracks consumption at whatever cadence the main
//     thread happens to allow. This alone closes the 62 %-of-demand deficit.
//
//  2. A CUSHION THAT COVERS THE OBSERVED STALL. Rate-exact delivery still leaves
//     the ring at zero the instant it is topped up, so it underruns for the whole
//     of the NEXT gap. The cushion is therefore the largest recent inter-tick gap
//     plus headroom — a decaying max over the main thread's own measured
//     scheduling, not a hand-picked latency. On a healthy machine it sits at the
//     {@link MIN_CUSHION_S} floor (80 ms, ~3 healthy ticks); under the forcing it
//     grows to cover a ~900 ms stall, because a 2 fps game with continuous audio
//     is strictly better than a 2 fps game with none.
//
// It is deliberately a PURE function over an explicit state record: the whole
// argument above is arithmetic, and arithmetic should be testable without a
// browser, an AudioContext or a 20 s WASM boot (`blood-pcm-schedule.test.ts`).

/** Ring depth to hold when the main thread is healthy, in seconds. Comfortably
 *  over the ~25 ms tick a quiet machine gives us, and low enough that a player's
 *  gunshot is not audibly late. */
export const MIN_CUSHION_S = 0.08;

/** Hard ceiling on the cushion, in seconds. Bounds both the latency and the
 *  worklet ring this has to fit inside (see `blood-pcm-worklet.js`). */
export const MAX_CUSHION_S = 1.0;

/** Cover a gap this much worse than the worst one recently observed. */
export const CUSHION_HEADROOM = 1.75;

/** Per-tick decay of the cushion back toward {@link MIN_CUSHION_S}, so a single
 *  transient stall does not pin the latency high for the rest of the session.
 *  At a healthy ~40 ticks/s this halves the excess in ~3.5 s. */
export const CUSHION_DECAY = 0.995;

/** Hard ceiling on one tick's production, in seconds of audio, so the mixer can
 *  never itself become the stall. The underrun rule below already bounds a tick
 *  at {@link MAX_CUSHION_S}; this is the belt to that braces. */
export const MAX_PER_TICK_S = 1.25;

/** `bpt_pump_audio` clamps to its own `BPT_PCM_FRAMES` scratch (8192 frames), so
 *  a tick that owes more than this has to make several calls. */
export const PCM_MAX_CHUNK_FRAMES = 8192;

/** The pump's accounting between ticks. All frame counts are per-channel. */
export interface PcmPumpState {
  /** Context time the delivery accounting is anchored to; < 0 before the first tick. */
  anchor: number;
  /** Context time of the previous tick; < 0 before the first tick. */
  last: number;
  /** Frames handed to the worklet since {@link anchor}. */
  delivered: number;
  /** Current target ring depth, in frames. */
  cushion: number;
}

export function makePcmPumpState(): PcmPumpState {
  return { anchor: -1, last: -1, delivered: 0, cushion: 0 };
}

export interface PcmPumpPlan {
  /** Frames this tick should mix and post. 0 means the ring is already stocked. */
  frames: number;
  /** The state to carry into the next tick, assuming `frames` are delivered. */
  next: PcmPumpState;
  /** True when the ring had run dry before this tick — diagnostic only; the plan
   *  already accounts for it. */
  underran: boolean;
}

/**
 * Plan one pump tick.
 *
 * @param state  accounting carried from the previous tick
 * @param now    the AudioContext's current time, in seconds
 * @param rate   the AudioContext's sample rate — the rate the ring is DRAINED at,
 *               which is the only rate that matters here. (MultiVoc mixes at
 *               44.1 kHz and the resulting 8.8 % pitch shift is a known, separate
 *               defect; a resampler is the fix for THAT, and it is not this one.)
 */
export function planPcmPump(state: PcmPumpState, now: number, rate: number): PcmPumpPlan {
  const minCushion = MIN_CUSHION_S * rate;
  const maxCushion = MAX_CUSHION_S * rate;
  const maxPerTick = MAX_PER_TICK_S * rate;

  // First tick: anchor the clock and prime the ring to the floor cushion.
  if (state.anchor < 0 || state.last < 0) {
    return {
      frames: Math.ceil(minCushion),
      next: { anchor: now, last: now, delivered: Math.ceil(minCushion), cushion: minCushion },
      underran: false,
    };
  }

  // The cushion tracks the main thread's OWN measured scheduling: grow at once to
  // cover the gap just observed, decay slowly back toward the floor.
  const gapFrames = Math.max(0, now - state.last) * rate;
  const wanted = gapFrames * CUSHION_HEADROOM;
  let cushion = wanted > state.cushion ? wanted : state.cushion * CUSHION_DECAY;
  if (cushion < minCushion) cushion = minCushion;
  if (cushion > maxCushion) cushion = maxCushion;

  // Ring depth = what we handed over, minus what the context has drained.
  let anchor = state.anchor;
  let delivered = state.delivered;
  let depth = delivered - (now - anchor) * rate;

  // ⚠ A NEGATIVE DEPTH IS NOT A DEBT TO REPAY, AND TREATING IT AS ONE IS A
  // SECOND BUG WITH THE SAME SHAPE AS THE FIRST. If the ring ran dry the audio
  // thread did not wait for us — it emitted silence for the shortfall and moved
  // on, so those frames are GONE, not pending. Re-delivering them would push
  // audio nobody can hear into the ring and leave every later frame permanently
  // that much late: the module would trade silence for unbounded latency. So an
  // underrun re-anchors the accounting HERE and we simply re-stock the cushion.
  // (This also bounds a tick at `cushion`, which is why MAX_PER_TICK_S is only a
  // backstop rather than the thing doing the work.)
  const underran = depth < 0;
  if (underran) {
    anchor = now;
    delivered = 0;
    depth = 0;
  }

  let frames = Math.ceil(cushion - depth);
  if (frames < 0) frames = 0;
  if (frames > maxPerTick) frames = Math.ceil(maxPerTick);

  return { frames, next: { anchor, last: now, delivered: delivered + frames, cushion }, underran };
}
