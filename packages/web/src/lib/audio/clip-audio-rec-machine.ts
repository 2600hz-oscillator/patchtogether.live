// packages/web/src/lib/audio/clip-audio-rec-machine.ts
//
// THE ARM STATE MACHINE + THE FRAME MATHS — pure, so every §4.4 transition and
// every boundary derivation is testable with no audio context at all. The
// worklet (packages/dsp/src/clip-recorder.ts) is deliberately DUMB: it slices
// quanta against frame numbers it is handed; every decision about WHICH frame
// numbers lives here, where a unit test can hold it down.
//
// ⚠ EVERY BOUNDARY IS A FRAME COUNT, COMPUTED FROM THE ANCHOR. All three
// quantities (`unitFrames` / `startFrame` / `stopFrame`) are resolved ONCE, at
// the moment the phase changes, from the CONTEXT CLOCK
// (`ctx.currentTime × ctx.sampleRate`) — never from a tick count (the blood
// rate-exactness rule: a tick-shaped budget delivered 62 % of demand), and a
// later loop boundary is ALWAYS `startFrame + n × unitFrames` in integer
// arithmetic — NEVER seconds accumulated loop by loop and re-rounded, which
// drifts by the fractional part of the loop's frame length on every pass
// (hundreds of frames over a long endless take). `clipRecLoopFrame` is that
// closed form and the drift test holds it to zero over 1000 loops, with a
// positive control proving the accumulating spelling fails it.
//
// ⚠ THE MACHINE IS A PURE REDUCER. `clipRecTransition(state, event)` returns
// the next state plus the EFFECTS the caller owes (arm the worklet, stop it at
// a frame, begin a commit, keep the scratch as a recover candidate). Nothing
// here touches a node, a port, a Y.Doc or a store — slice 5's registry is the
// caller that spends the effects. Unlisted (state, event) pairs are EXPLICIT
// no-ops, so the transition matrix is total and the test enumerates it.
//
// The `data.audioRec` shape this machine's states project into is
// `AudioRecState` (clip-types.ts); its `phase` is the subset of these phases
// that peers need to see ('armed' | 'recording' | 'stopping') — 'committing'
// is a local-only moment between the last frame and the Y.Doc write.

import type { RecordingWindow } from './clip-media';
import { laneStepDur } from './modules/clip-clock';

// ---------------------------------------------------------------------------
// Frame maths
// ---------------------------------------------------------------------------

/** Fallback tempo when there is no TIMELORDE in the rack — the shipped
 *  clipplayer fallback (`transportBpm`), restated here so the recorder and the
 *  scheduler cannot disagree about what silence runs at. */
export const CLIP_REC_FALLBACK_BPM = 120;

/** Coerce a raw TIMELORDE `bpm` param read to a usable tempo: a finite
 *  positive number passes through, anything else (no TIMELORDE, junk sync
 *  payload) is the 120 free-run fallback. PURE — mirrors clipplayer's
 *  `transportBpm` coercion exactly. */
export function clipRecBpm(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : CLIP_REC_FALLBACK_BPM;
}

/** The unit loop in FRAMES: `round(lengthSteps × laneStepDur × sampleRate)`,
 *  never less than 1. This is the ONLY place seconds become frames for a loop
 *  length, and the ≤½-sample rounding it performs happens ONCE — every later
 *  boundary is integer multiples of this integer (see `clipRecLoopFrame`). */
export function clipRecUnitFrames(
  lengthSteps: number,
  baseStepDur: number,
  rateIndex: number,
  sampleRate: number,
): number {
  const steps = Math.max(1, Math.floor(lengthSteps));
  const frames = Math.round(steps * laneStepDur(baseStepDur, rateIndex) * sampleRate);
  return Math.max(1, frames);
}

/** The frame a boundary TIME (ctx seconds — `nextLaunchBoundary`'s shared
 *  reference bar, or the transport start) lands on. */
export function clipRecStartFrame(boundaryTime: number, sampleRate: number): number {
  return Math.round(boundaryTime * sampleRate);
}

/** Loop boundary `n` of a take — THE ANCHOR CLOSED FORM. Integer arithmetic
 *  from `startFrame`, so boundary(k) − boundary(k−1) === unitFrames EXACTLY
 *  for every k: the rounding error of one loop is paid once inside
 *  `unitFrames` and never accumulates. (The accumulating alternative —
 *  seconds += loopSeconds, re-round each pass — is the drift the test's
 *  positive control demonstrates.) */
export function clipRecLoopFrame(startFrame: number, unitFrames: number, n: number): number {
  return startFrame + unitFrames * n;
}

/** Where an ENDLESS take's STOP request lands: the NEXT whole multiple of
 *  `unitFrames` at or after `stopReqFrame`, computed from the anchor — never
 *  fewer than one whole unit (a STOP the instant recording starts still
 *  yields one full loop; a partial loop is the outcome this mode forbids). */
export function clipRecEndlessStopFrame(
  startFrame: number,
  unitFrames: number,
  stopReqFrame: number,
): number {
  const n = Math.max(1, Math.ceil((stopReqFrame - startFrame) / unitFrames));
  return clipRecLoopFrame(startFrame, unitFrames, n);
}

/** How many WHOLE units fit between `startFrame` and `frame` — the
 *  transport-stop / budget-ceiling truncation count. Never negative. */
export function clipRecWholeUnits(startFrame: number, unitFrames: number, frame: number): number {
  return Math.max(0, Math.floor((frame - startFrame) / unitFrames));
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

export type ClipRecMode = 'single' | 'endless';

export type ClipRecState =
  | { phase: 'idle' }
  | { phase: 'armed'; mode: ClipRecMode; window: RecordingWindow }
  | { phase: 'recording'; mode: ClipRecMode; window: RecordingWindow }
  /** Endless-only: STOP has resolved a stopFrame and the pad counts down. */
  | { phase: 'stopping'; mode: 'endless'; window: RecordingWindow & { stopFrame: number } }
  /** The take's frames are decided; the caller encodes + writes the clip. */
  | { phase: 'committing'; mode: ClipRecMode; window: RecordingWindow; frames: number };

export type ClipRecEvent =
  /** The arm gesture. `window` is resolved by the caller via the frame maths
   *  above; the machine NORMALIZES its stopFrame (single → anchor + unit,
   *  endless → null) so the anchor derivation is enforced, not trusted. */
  | { type: 'arm'; mode: ClipRecMode; window: RecordingWindow }
  /** Clock advance: the latest observed context frame. */
  | { type: 'frame'; frame: number }
  /** The STOP gesture (meaningful for endless; a no-op elsewhere). */
  | { type: 'stop'; frame: number }
  /** The CANCEL gesture — the escape from any live phase. */
  | { type: 'cancel' }
  | { type: 'transportStop'; frame: number }
  | { type: 'budgetCeiling'; frame: number }
  | { type: 'commitOk' }
  | { type: 'commitFail' };

export type ClipRecEffect =
  /** (Re)send `arm` to the worklet with this window. */
  | { kind: 'armWorklet'; window: RecordingWindow }
  /** Send `stopAt` — the endless STOP landing on a whole-unit boundary. */
  | { kind: 'stopWorklet'; stopFrame: number }
  /** Send `cancel` — the worklet discards its lane silently. */
  | { kind: 'cancelWorklet' }
  /** Free the take's OPFS scratch — nothing worth keeping was captured. */
  | { kind: 'discardScratch' }
  /** Encode + commit exactly `frames` frames (truncating any surplus the
   *  worklet captured past a transport-stop / cap boundary). */
  | { kind: 'beginCommit'; frames: number }
  /** The commit failed: keep scratch + manifest as a recover candidate. */
  | { kind: 'keepRecoverScratch' };

export const CLIP_REC_IDLE: ClipRecState = { phase: 'idle' };

export interface ClipRecTransitionResult {
  state: ClipRecState;
  effects: readonly ClipRecEffect[];
}

const NONE: readonly ClipRecEffect[] = [];

/** No-op: same state, no effects. */
function stay(state: ClipRecState): ClipRecTransitionResult {
  return { state, effects: NONE };
}

/** Normalize an arm window for a mode — the anchor rule, enforced. */
function armWindow(mode: ClipRecMode, w: RecordingWindow): RecordingWindow {
  return {
    startFrame: w.startFrame,
    unitFrames: w.unitFrames,
    stopFrame: mode === 'single' ? clipRecLoopFrame(w.startFrame, w.unitFrames, 1) : null,
  };
}

/** Truncate a live endless take at `frame`: whole loops commit, less than one
 *  whole loop discards. (A single take never commits a partial — its contract
 *  is exactly one loop or nothing.)
 *
 *  ⚠ THIS USED TO EMIT `[cancelWorklet, beginCommit]` AND IT LOST THE TAKE.
 *  The worklet's `cancel` discards a lane **silently** — no final chunk, no
 *  `done` (clip-recorder.ts: "Discard silently"). But `beginCommit` waits for
 *  `done` before it will encode, so the commit sat on a dead promise, timed out
 *  after CLIP_REC_DONE_TIMEOUT_MS, threw, and every endless take truncated by
 *  a transport stop landed in the RECOVERY pile instead of the clip. The pair
 *  was self-contradicting: you cannot ask a lane to report and to vanish.
 *
 *  The fix is TRUNCATE-AND-REPORT, and it needed no new message type — the
 *  graceful STOP path already does exactly this and works. Emit `stopWorklet`
 *  at the whole-loop boundary and enter `stopping`; the worklet clamps its
 *  capture at that frame and calls `finish()`, which flushes the partial chunk
 *  and posts `done`. The `stopping` + `frame` transition below then commits
 *  through the same path a graceful stop uses.
 *
 *  The one asymmetry, handled on the main thread: a graceful stop resolves a
 *  stopFrame in the FUTURE, so the worklet reports exactly the frames asked
 *  for. A transport stop resolves one in the PAST (the last completed loop),
 *  and the worklet has already captured past it — so it reports MORE than the
 *  commit wants. The commit truncates that surplus, which is what `beginCommit`
 *  always promised ("truncating any surplus the worklet captured past a
 *  transport-stop / cap boundary") and never did. */
function truncateEndless(
  state: Extract<ClipRecState, { phase: 'recording' | 'stopping' }>,
  frame: number,
): ClipRecTransitionResult {
  const { startFrame, unitFrames } = state.window;
  const whole = clipRecWholeUnits(startFrame, unitFrames, frame);
  if (state.mode === 'endless' && whole >= 1) {
    const stopFrame = startFrame + whole * unitFrames;
    return {
      state: {
        phase: 'stopping',
        mode: 'endless',
        window: { ...state.window, stopFrame },
      },
      effects: [{ kind: 'stopWorklet', stopFrame }],
    };
  }
  return {
    state: CLIP_REC_IDLE,
    effects: [{ kind: 'cancelWorklet' }, { kind: 'discardScratch' }],
  };
}

/**
 * The §4.4 transition table, total over (state, event). Everything not listed
 * in the spec's matrix is an explicit no-op — including the two the spec calls
 * out by name: re-STOP during STOPPING (stopping sooner would produce a
 * partial loop; CANCEL is the escape) and any gesture during COMMITTING (the
 * frames are decided; only the commit outcome moves the machine). PURE.
 */
export function clipRecTransition(
  state: ClipRecState,
  event: ClipRecEvent,
): ClipRecTransitionResult {
  switch (state.phase) {
    case 'idle': {
      if (event.type === 'arm') {
        const window = armWindow(event.mode, event.window);
        return {
          state: { phase: 'armed', mode: event.mode, window },
          effects: [{ kind: 'armWorklet', window }],
        };
      }
      return stay(state);
    }

    case 'armed': {
      switch (event.type) {
        case 'arm': {
          // Re-tap the SAME mode = cancel (armTransition's shipped meaning);
          // the OTHER mode switches in place, re-resolving stopFrame from the
          // machine's own anchor — the event's window is deliberately ignored.
          if (event.mode === state.mode) {
            return {
              state: CLIP_REC_IDLE,
              effects: [{ kind: 'cancelWorklet' }, { kind: 'discardScratch' }],
            };
          }
          const window = armWindow(event.mode, state.window);
          return {
            state: { phase: 'armed', mode: event.mode, window },
            effects: [{ kind: 'armWorklet', window }],
          };
        }
        case 'frame': {
          if (event.frame < state.window.startFrame) return stay(state);
          // Punched in. A degenerate jump past the whole window commits it —
          // the worklet has already finished by construction.
          const stop = state.window.stopFrame;
          if (stop !== null && event.frame >= stop) {
            const frames = stop - state.window.startFrame;
            return {
              state: { phase: 'committing', mode: state.mode, window: state.window, frames },
              effects: [{ kind: 'beginCommit', frames }],
            };
          }
          return { state: { phase: 'recording', mode: state.mode, window: state.window }, effects: NONE };
        }
        case 'cancel':
        case 'transportStop':
          // Nothing captured yet — discard.
          return {
            state: CLIP_REC_IDLE,
            effects: [{ kind: 'cancelWorklet' }, { kind: 'discardScratch' }],
          };
        default:
          return stay(state);
      }
    }

    case 'recording': {
      switch (event.type) {
        case 'frame': {
          const stop = state.window.stopFrame;
          if (stop === null || event.frame < stop) return stay(state);
          const frames = stop - state.window.startFrame;
          return {
            state: { phase: 'committing', mode: state.mode, window: state.window, frames },
            effects: [{ kind: 'beginCommit', frames }],
          };
        }
        case 'stop': {
          if (state.mode !== 'endless') return stay(state); // single stops itself
          const stopFrame = clipRecEndlessStopFrame(
            state.window.startFrame,
            state.window.unitFrames,
            event.frame,
          );
          return {
            state: {
              phase: 'stopping',
              mode: 'endless',
              window: { ...state.window, stopFrame },
            },
            effects: [{ kind: 'stopWorklet', stopFrame }],
          };
        }
        case 'cancel':
          return {
            state: CLIP_REC_IDLE,
            effects: [{ kind: 'cancelWorklet' }, { kind: 'discardScratch' }],
          };
        case 'transportStop':
        case 'budgetCeiling':
          return truncateEndless(state, event.frame);
        default:
          return stay(state);
      }
    }

    case 'stopping': {
      switch (event.type) {
        case 'frame': {
          if (event.frame < state.window.stopFrame) return stay(state);
          const frames = state.window.stopFrame - state.window.startFrame;
          return {
            state: { phase: 'committing', mode: state.mode, window: state.window, frames },
            effects: [{ kind: 'beginCommit', frames }],
          };
        }
        case 'stop':
          // ⚠ DELIBERATE NO-OP. "Stop sooner" would be a partial loop.
          return stay(state);
        case 'cancel':
          return {
            state: CLIP_REC_IDLE,
            effects: [{ kind: 'cancelWorklet' }, { kind: 'discardScratch' }],
          };
        case 'transportStop':
        case 'budgetCeiling':
          return truncateEndless(state, Math.min(event.frame, state.window.stopFrame));
        default:
          return stay(state);
      }
    }

    case 'committing': {
      if (event.type === 'commitOk') return { state: CLIP_REC_IDLE, effects: NONE };
      if (event.type === 'commitFail') {
        return { state: CLIP_REC_IDLE, effects: [{ kind: 'keepRecoverScratch' }] };
      }
      return stay(state);
    }
  }
}
