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
  SEAM_GLIDE_S,
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
  /** CANCEL-AND-HOLD a param at a seam (engine.holdParam — transient, zero Yjs).
   *  Truncates the scheduled ramp tail so the ghost lookahead stops driving,
   *  then: `toValueNorm != null` ⇒ pin/glide to that DETERMINISTIC value (the
   *  hold-last-value on stop — normalized 0..1, the dep denormalizes);
   *  `toValueNorm == null` ⇒ only truncate (the touch punch-in — the hand is
   *  the new writer). Optional so inert test harnesses can omit it. */
  hold?(target: AutomationTarget, toValueNorm: number | null, glideS: number): void;
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
  private readonly suspended = new Set<string>(); // targets overriding automation (LOCAL)
  // GRABBED = physically held right now (pointer down / MIDI-CC hot / Electra
  // twist), from a touch-DOWN until its RELEASE. A grabbed param stays suspended
  // ACROSS a loop wrap (the wrap no longer yanks a param out from under a hand
  // mid-gesture) — the release seam, not the wrap, ends an override. Client-local.
  private readonly grabbed = new Set<string>();
  // Keys this player is CURRENTLY driving via automation playback (refreshed as
  // playbackStep drives, cleared on stop). Scopes the touch-truncate so grabbing
  // a param only cancels THIS player's scheduled tail, not another writer's.
  private readonly drivenKeys = new Set<string>();
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
  /** A live grab (screen pointer-DOWN / MIDI-CC / Electra twist) of `target` —
   *  suspend its automation (live wins) and mark it GRABBED until its physical
   *  RELEASE, so a wrap can't clear the override mid-gesture. Client-local.
   *  TRUNCATE: on the first grab of a param THIS player is driving, cancel-and-
   *  hold the scheduled ramp tail at its current value so the ~200 ms lookahead
   *  ghost stops fighting the hand. AUTO-CAPTURE: if we're recording and `target`
   *  is NOT already an automation track, queue it to be added + captured. */
  notifyTouch(target: AutomationTarget): void {
    const k = key(target);
    const firstGrab = !this.grabbed.has(k);
    this.suspended.add(k);
    this.grabbed.add(k);
    if (firstGrab && this.drivenKeys.has(k)) this.deps.hold?.(target, null, 0);
    if (this.recording && !this.currentTrackKeys.has(k)) {
      this.pendingAuto.set(k, target);
    }
  }
  /** Physical RELEASE (pointer-up / CC-idle timeout / Electra release) of a
   *  grabbed control — end the override so automation playback resumes. Playback
   *  glides back to the envelope on its next step (the drive path de-zippers). */
  notifyRelease(target: AutomationTarget): void {
    const k = key(target);
    this.grabbed.delete(k);
    this.suspended.delete(k);
  }
  /** Manually re-enable a suspended param (the "re-enable automation" affordance). */
  reEnable(target: AutomationTarget): void {
    this.suspended.delete(key(target));
    this.grabbed.delete(key(target));
  }
  /** Re-enable ALL suspended params at once (the card's override-indicator
   *  click clears every live override in one gesture). */
  reEnableAll(): void {
    this.suspended.clear();
    this.grabbed.clear();
  }
  /** Is `target`'s automation currently overridden — actively suspended OR held
   *  by a hand that hasn't released? Both suppress playback + gate record capture. */
  isSuspended(target: AutomationTarget): boolean {
    return this.isHeld(key(target));
  }
  private isHeld(k: string): boolean {
    return this.suspended.has(k) || this.grabbed.has(k);
  }
  /** Targets currently overriding automation (for the card's indicator) — the
   *  union of suspended + grabbed. */
  overriddenKeys(): string[] {
    return [...new Set([...this.suspended, ...this.grabbed])];
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
    this.grabbed.clear();
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
    seamGlideS = 0,
  ): void {
    if (this.isSuspended(track.target)) return; // being touched → live wins (also the record gate)
    const interp = trackInterp(track, this.deps.curve(track.target));
    // De-zipper an unavoidable SEAM (loop-wrap / clip-switch INTO): the caller
    // passes seamGlideS so the step-0 anchor glides instead of hard-stepping.
    const pts = stepRampPoints(track.events, stepIndex, laneDur, emitAt, interp, seamGlideS);
    if (pts.length) {
      this.drivenKeys.add(key(track.target));
      this.deps.drive(track.target, pts);
    }
  }

  // --------------------------------------------------------- hold-last-value
  /**
   * HOLD-LAST-VALUE on automation stop (a lane stops, or its active clip switches
   * away from `clip`). For each track NOT under a live hand, compute the
   * DETERMINISTIC resting value at `stopFrac` — a PURE recompute of the clip data
   * (`automationLinearAt` for continuous, `automationValueAt` for hold/discrete),
   * so every collaborating peer converges to the SAME value — and hand it to
   * `deps.hold`, which cancels the ghost tail and de-zipper-glides the param to
   * that value. NEVER snaps to zero/default. A track with no value yet at
   * `stopFrac` (before its first breakpoint) is left at its live value.
   * Playback has ended, so clear the driven-key set. PURE read of the clip.
   */
  holdLastValue(clip: AutomationClipRecord, stopFrac: number, glideS = SEAM_GLIDE_S): void {
    if (this.deps.hold) {
      for (const tr of clip.tracks) {
        if (this.isSuspended(tr.target)) continue; // a hand owns it → leave it
        const interp = trackInterp(tr, this.deps.curve(tr.target));
        const read = interp === 'hold' ? automationValueAt : automationLinearAt;
        const v = read(tr.events, stopFrac);
        if (v == null) continue; // no value yet → leave the live value
        this.deps.hold(tr.target, v, glideS);
      }
    }
    this.drivenKeys.clear();
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
        if (!this.isHeld(key(st.target))) continue; // not being touched/held → keep playback
        const v = this.deps.readNorm(st.target);
        if (v == null) continue;
        st.gate.sample(fracStep, v);
        st.maxDev = Math.max(st.maxDev, Math.abs(v - st.startVal));
      }
    }

    if (transition === 'punch-in' || transition === 'wrap') {
      // Loop wrap → re-enable overridden params, EXCEPT ones a hand is still
      // physically holding (grabbed): a gesture spanning the wrap keeps its
      // suspension so the param isn't yanked to the envelope mid-drag, and its
      // capture continues into the next pass. The release seam clears it.
      for (const k of [...this.suspended]) if (!this.grabbed.has(k)) this.suspended.delete(k);
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
