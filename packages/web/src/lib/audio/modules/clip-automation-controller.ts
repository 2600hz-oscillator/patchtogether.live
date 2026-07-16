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
  automationValueAt,
  automationLinearAt,
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
  /** AUTO-CAPTURE: add an EMPTY track for `target` to the stored automation clip,
   *  respecting MAX_AUTOMATION_TRACKS + skipping the clip-player's OWN params (no
   *  self-capture). Returns true iff the target is now a track (added, or already
   *  present). Called when the user MOVES an un-assigned control while recording —
   *  the "just move knobs and it records" workflow. */
  addTrack(target: AutomationTarget): boolean;
}

function key(t: AutomationTarget): string {
  return t.nodeId + '::' + t.paramId;
}

interface PassState {
  gate: RecordGate;
  startVal: number;
  maxDev: number;
  /** The control this pass-state records (so the capture loop can sample tracks
   *  that were AUTO-ADDED mid-pass, not only the clip's pre-existing tracks). */
  target: AutomationTarget;
  /** AUTO-CAPTURED this pass (the user moved an un-assigned control): commit it
   *  even if the net motion is tiny — a deliberate set-and-hold IS the automation
   *  the user intends. A pre-existing track only commits when it actually MOVED. */
  auto: boolean;
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
  // AUTO-CAPTURE: the keys of the stored clip's tracks (refreshed each recordTick)
  // + un-assigned controls the user TOUCHED while recording, queued to be added
  // as tracks + captured on the next tick.
  private currentTrackKeys = new Set<string>();
  private readonly pendingAuto = new Map<string, AutomationTarget>();

  constructor(private readonly deps: AutomationControllerDeps) {}

  // ------------------------------------------------------------------ touch
  /** A live grab (screen/MIDI/Electra) of `target` — suspend its automation
   *  until the loop wrap (live wins). Client-local. AUTO-CAPTURE: if we're
   *  recording and `target` is NOT already an automation track, queue it to be
   *  added as a track + captured this pass (no mandatory pre-assign). */
  notifyTouch(target: AutomationTarget): void {
    this.suspended.add(key(target));
    if (this.recording && !this.currentTrackKeys.has(key(target))) {
      this.pendingAuto.set(key(target), target);
    }
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
    this.pendingAuto.clear();
    // Manual stop → the take is done, so the just-recorded automation should PLAY
    // BACK: clear any lingering touch-suspensions so no param stays frozen at the
    // value you released it on (the "I stopped and it's stuck" confusion).
    this.suspended.clear();
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
   * while-loop). TOUCH-GATED OVERDUB: a track plays back UNLESS the user is
   * actively TOUCHING it (`isSuspended`) — even WHILE recording. So while armed,
   * every track the user is NOT touching keeps looping (visible/audible — the fix
   * for "it looks like it recorded one pass then stopped"), and only the touched
   * param is live (record wins). No self-capture: playback drives the engine
   * (scheduleParam) but never the STORE, and record reads the store, so a
   * played-back move is never re-recorded.
   */
  playbackStep(
    track: AutomationTrack,
    stepIndex: number,
    laneDur: number,
    emitAt: number,
  ): void {
    if (this.isSuspended(track.target)) return; // being touched → live wins (also the record gate)
    const interp = trackInterp(track, this.deps.curve(track.target));
    const pts = stepRampPoints(track.events, stepIndex, laneDur, emitAt, interp);
    if (pts.length) this.deps.drive(track.target, pts);
  }

  // ------------------------------------------------------------- display
  /**
   * VISUAL SMOOTHING (P3): the CURRENT interpolated value (normalized 0..1) of each
   * track that is PLAYING BACK at `fracStep`, for the on-screen knob. Automation
   * schedules smooth AUDIO ramps but only refreshes the knob cache at step
   * boundaries, so a slow clip looks jumpy; the tick feeds these to
   * engine.setDisplayParam every tick (~40fps) so the knob follows the envelope.
   * A TOUCHED track is skipped (its live value already drives the knob). CPU-bounded
   * to the clip's tracks (≤ MAX_AUTOMATION_TRACKS). PURE read (no state change).
   */
  displayValues(
    clip: AutomationClipRecord,
    fracStep: number,
  ): { target: AutomationTarget; value: number }[] {
    const out: { target: AutomationTarget; value: number }[] = [];
    for (const tr of clip.tracks) {
      if (this.isSuspended(tr.target)) continue; // being touched → live value shows
      const interp = trackInterp(tr, this.deps.curve(tr.target));
      const read = interp === 'hold' ? automationValueAt : automationLinearAt;
      const v = read(tr.events, fracStep);
      if (v != null) out.push({ target: tr.target, value: v });
    }
    return out;
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

    // Refresh which params are already tracks (the auto-capture guard reads this).
    this.currentTrackKeys = new Set(clip.tracks.map((t) => key(t.target)));

    if (this.window.state === 'recording' && this.pass) {
      // AUTO-CAPTURE drain: every un-assigned control the user TOUCHED since the
      // last tick becomes a track (store write via deps.addTrack) + a fresh
      // pass-state seeded AT THE TOUCH POINT (current frac + value), so its move
      // records from here and commits at the wrap. Capped by addTrack (MAX /
      // own-param → skip).
      if (this.pendingAuto.size) {
        for (const [k, target] of this.pendingAuto) {
          if (this.pass.has(k) || this.currentTrackKeys.has(k)) continue; // already capturing/stored
          if (!this.deps.addTrack(target)) continue; // MAX reached or own param
          const v = this.deps.readNorm(target) ?? 0;
          const unit = this.deps.unitNorm(target);
          const gate = new RecordGate(unit != null ? { unitDelta: unit } : {});
          gate.sample(fracStep, v); // seed from the touch point (not step 0)
          this.pass.set(k, { gate, startVal: v, maxDev: 0, target, auto: true });
        }
        this.pendingAuto.clear();
      }

      // Remember the in-flight pass so a manual disarm can commit it partial.
      this.passClip = clip;
      this.passLen = len;
      this.passLastStep = Math.max(this.passLastStep, fracStep);
      // TOUCH-GATED capture: sample ONLY the tracks the user is ACTIVELY TOUCHING
      // this pass (in `suspended`). Untouched tracks are NOT sampled → their gate
      // stays at its seed → not committed → their existing automation is preserved
      // and keeps PLAYING BACK. So moving param A re-records A while B/C keep
      // looping; releasing A reverts it to playback next loop.
      for (const st of this.pass.values()) {
        if (!this.suspended.has(key(st.target))) continue; // not being touched → keep playback
        const v = this.deps.readNorm(st.target);
        if (v == null) continue;
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
      this.pass.set(key(tr.target), { gate, startVal, maxDev: 0, target: tr.target, auto: false });
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
      // Untouched pre-existing track → keep its automation. An AUTO-CAPTURED track
      // always commits (the user deliberately moved it — even a set-and-hold is
      // the automation they intend), so a single move isn't lost as "no motion".
      if (!st || (st.maxDev < MOVE_EPS && !st.auto)) return tr;
      anyMoved = true;
      const incoming: AutomationEvent[] = st.gate.close();
      const events = mergeAutomationOverdub(tr.events, incoming, 0, end);
      return { ...tr, events };
    });
    if (anyMoved) this.deps.commit(merged);
  }
}
