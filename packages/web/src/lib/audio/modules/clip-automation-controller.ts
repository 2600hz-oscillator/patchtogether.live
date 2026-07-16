// packages/web/src/lib/audio/modules/clip-automation-controller.ts
//
// The per-clip-player AUTOMATION CONTROLLER (task #183): the stateful adapter
// that composes the pure engine cores (stepRampPoints / RecordGate /
// QuantizedRecordWindow) with INJECTED side effects, so it unit-tests without a
// real AudioContext or Yjs. The clipplayer factory owns one of these and drives
// it from tick(); the deps wire to `engine.setParam` (playback, zero-Yjs), the
// store-value tap, and the whole-clip plain commit.
//
// Semantics (owner's CONTINUOUS-OVERDUB model, 2026-07-15):
//  - PLAYBACK drives each track's param transiently via ramps; a param the user
//    is touching is SUSPENDED until the loop wrap (live wins), and while the clip
//    is RECORDING its own tracks aren't played back (no self-capture).
//  - RECORD is CONTINUOUS OVERDUB: arm → punch-in at the automation clip's OWN
//    next loop wrap (clean first pass) → then EVERY loop is a pass. At each wrap
//    it commits ONCE (the tracks that MOVED that pass merge into the clip; the
//    rest keep their events) and immediately starts a fresh pass — no auto-stop.
//  - DISARM (press ARM again) is the manual stop: commit the in-flight pass too,
//    but a PARTIAL pass replaces only up to the last captured step (untouched tail
//    preserved). Only tracks whose value MOVED are committed (source-agnostic —
//    screen / MIDI / Electra all change the store value). Runs only on the single
//    recorder client.
//  - Touch/override state is CLIENT-LOCAL (never the Y.Doc) — no per-tick sync.

import {
  mergeAutomationOverdub,
  type AutomationClipRecord,
  type AutomationEvent,
  type AutomationTarget,
  type AutomationTrack,
} from './clip-types';
import {
  RecordGate,
  QuantizedRecordWindow,
  stepRampPoints,
  trackInterp,
  type RampPoint,
} from './clip-automation-engine';

/** A value moved "enough" to count as a recorded edit (below 7-bit MIDI 1/127). */
const MOVE_EPS = 0.005;

export interface AutomationControllerDeps {
  /** Current NORMALIZED (0..1) value of the target's param — the store tap
   *  (mount-independent, modulation-free), or null if unresolvable. */
  readNorm(target: AutomationTarget): number | null;
  /** The target param's curve id ('discrete' ⇒ hold interpolation). */
  curve(target: AutomationTarget): string | undefined;
  /** Normalized size of ONE unit for a discrete param (so the record gate
   *  doesn't swallow single-unit steps); undefined for continuous params. */
  unitNorm(target: AutomationTarget): number | undefined;
  /** Schedule ramp points on the engine (TRANSIENT — engine.setParam, never the
   *  Y.Doc). `points` values are normalized 0..1; the dep denormalizes. */
  drive(target: AutomationTarget, points: RampPoint[]): void;
  /** Commit a completed pass: the merged tracks for the whole automation clip
   *  (whole-clip PLAIN reassign in one Y.Doc transaction — never a live splice). */
  commit(tracks: AutomationTrack[]): void;
}

function key(t: AutomationTarget): string {
  return t.nodeId + '::' + t.paramId;
}

interface PassState {
  gate: RecordGate;
  startVal: number;
  maxDev: number;
}

export class AutomationController {
  private readonly suspended = new Set<string>(); // targets touched this loop (LOCAL)
  private readonly window = new QuantizedRecordWindow();
  private pass: Map<string, PassState> | null = null;
  // The clip + loop length + last captured step of the IN-FLIGHT pass, so a
  // manual disarm can commit a PARTIAL pass (preserving the untouched tail)
  // without the caller re-supplying the clip.
  private passClip: AutomationClipRecord | null = null;
  private passLen = 0;
  private passLastStep = 0;

  constructor(private readonly deps: AutomationControllerDeps) {}

  // ------------------------------------------------------------------ touch
  /** A live grab (screen/MIDI/Electra) of `target` — suspend its automation
   *  until the loop wrap (live wins). Client-local. */
  notifyTouch(target: AutomationTarget): void {
    this.suspended.add(key(target));
  }
  /** Manually re-enable a suspended param (the "re-enable automation" affordance). */
  reEnable(target: AutomationTarget): void {
    this.suspended.delete(key(target));
  }
  /** Re-enable ALL suspended params at once (the card's override-indicator
   *  click clears every live override in one gesture). */
  reEnableAll(): void {
    this.suspended.clear();
  }
  isSuspended(target: AutomationTarget): boolean {
    return this.suspended.has(key(target));
  }
  /** Targets currently overriding automation (for the card's indicator). */
  overriddenKeys(): string[] {
    return [...this.suspended];
  }

  // ------------------------------------------------------------------ arm
  arm(): void {
    this.window.arm();
  }
  /** Manual STOP (press ARM again). If a pass was IN FLIGHT, commit it as a
   *  PARTIAL pass — merge only up to the last captured step so the untouched TAIL
   *  of each track is preserved (not clobbered). Then clear the pass. */
  disarm(): void {
    const wasRecording = this.window.disarm();
    if (wasRecording && this.pass && this.passClip) {
      this.commitPass(this.passClip, this.passLen, this.passLastStep);
    }
    this.pass = null;
    this.passClip = null;
  }
  get recording(): boolean {
    return this.window.state === 'recording';
  }
  get armed(): boolean {
    return this.window.state === 'armed';
  }

  // ------------------------------------------------------------- playback
  /**
   * PLAYBACK for one track within an integer step (called from the lane
   * while-loop). No-op while this clip is recording (self-capture) or while the
   * param is suspended by a live grab.
   */
  playbackStep(
    track: AutomationTrack,
    stepIndex: number,
    laneDur: number,
    emitAt: number,
  ): void {
    if (this.recording) return;
    if (this.isSuspended(track.target)) return;
    const interp = trackInterp(track, this.deps.curve(track.target));
    const pts = stepRampPoints(track.events, stepIndex, laneDur, emitAt, interp);
    if (pts.length) this.deps.drive(track.target, pts);
  }

  // --------------------------------------------------------------- record
  /**
   * RECORD — called ONCE per tick, ONLY on the recorder client, with the clip's
   * current fractional-step playhead. Drives the CONTINUOUS-OVERDUB window:
   * punch-in at the clip's own next wrap, capture each tick, and at EVERY wrap
   * commit the just-finished pass (full loop) then immediately start a fresh one
   * — recording continues until disarm. Clears the touch suspensions at each wrap
   * (the loop-boundary re-enable).
   */
  recordTick(clip: AutomationClipRecord, fracStep: number, len: number): void {
    const transition = this.window.advance(fracStep);

    // WRAP (continuous overdub): commit the pass that just ended (full loop
    // window), then open a new one so recording keeps going with no gap.
    if (transition === 'wrap') {
      if (this.pass && this.passClip) this.commitPass(this.passClip, this.passLen, this.passLen);
      this.beginPass(clip);
    }
    if (transition === 'punch-in') {
      this.beginPass(clip);
    }

    if (this.window.state === 'recording' && this.pass) {
      // Remember the in-flight pass so a manual disarm can commit it partial.
      this.passClip = clip;
      this.passLen = len;
      this.passLastStep = Math.max(this.passLastStep, fracStep);
      for (const tr of clip.tracks) {
        const v = this.deps.readNorm(tr.target);
        if (v == null) continue;
        const st = this.pass.get(key(tr.target));
        if (!st) continue;
        st.gate.sample(fracStep, v);
        st.maxDev = Math.max(st.maxDev, Math.abs(v - st.startVal));
      }
    }

    if (transition === 'punch-in' || transition === 'wrap') {
      this.suspended.clear(); // loop wrap → re-enable overridden params
    }
  }

  private beginPass(clip: AutomationClipRecord): void {
    this.pass = new Map();
    this.passClip = clip;
    this.passLastStep = 0;
    for (const tr of clip.tracks) {
      const unit = this.deps.unitNorm(tr.target);
      const startVal = this.deps.readNorm(tr.target) ?? 0;
      const gate = new RecordGate(unit != null ? { unitDelta: unit } : {});
      gate.sample(0, startVal); // seed the loop start so the pre-move hold is captured
      this.pass.set(key(tr.target), { gate, startVal, maxDev: 0 });
    }
  }

  /**
   * Merge the current pass's captured tracks into `clip` and commit ONCE (whole-
   * clip plain reassign). Only tracks that MOVED (maxDev ≥ MOVE_EPS) are merged;
   * the rest keep their existing automation. `windowEnd` bounds the overdub
   * window `[0, windowEnd)`:
   *   - a FULL loop pass passes `len` (replace the whole track loop);
   *   - a PARTIAL pass (manual disarm mid-loop) passes the last captured step, so
   *     existing events in the untouched TAIL `[windowEnd, len)` are preserved.
   */
  private commitPass(clip: AutomationClipRecord, len: number, windowEnd: number): void {
    const pass = this.pass;
    this.pass = null;
    if (!pass) return;
    const end = Math.max(0, Math.min(len, windowEnd));
    let anyMoved = false;
    const merged: AutomationTrack[] = clip.tracks.map((tr) => {
      const st = pass.get(key(tr.target));
      if (!st || st.maxDev < MOVE_EPS) return tr; // untouched → keep existing automation
      anyMoved = true;
      const incoming: AutomationEvent[] = st.gate.close();
      const events = mergeAutomationOverdub(tr.events, incoming, 0, end);
      return { ...tr, events };
    });
    if (anyMoved) this.deps.commit(merged);
  }
}
