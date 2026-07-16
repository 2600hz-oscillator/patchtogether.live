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
  /** HOLD/PIN a param at a seam (engine.holdParam — transient, zero Yjs).
   *  `toValueNorm != null` ⇒ pin/glide to that value (the hold-last-value on
   *  stop, or the release-handoff pin — normalized 0..1, the dep denormalizes);
   *  `toValueNorm == null` ⇒ truncate-only (the touch punch-in — the hand is the
   *  new writer). `atTime` names the seam instant (a future loop boundary for a
   *  quantized switch); absent ⇒ the dep uses "now". The engine dispatches
   *  near-now (cancel-and-hold) vs future (pin-only, never cancel) itself.
   *  Optional so inert test harnesses can omit it. */
  hold?(target: AutomationTarget, toValueNorm: number | null, glideS: number, atTime?: number): void;
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

/** The canonical override/suspension key for a target — shared with the
 *  clipplayer's seam logic (skip/truncate sets on a clip switch). */
export function automationTargetKey(t: AutomationTarget): string {
  return t.nodeId + '::' + t.paramId;
}
const key = automationTargetKey;

/** Options for `holdLastValue` — how a specific stop seam applies the hold. */
export interface HoldLastValueOpts {
  /** The seam instant (a FUTURE loop boundary for a quantized switch). Absent ⇒
   *  the hold dep uses "now" (immediate stop / transport stop / dispose). */
  atTime?: number;
  /** Keys (automationTargetKey) to leave ENTIRELY alone — params the INCOMING
   *  clip drives from a BOUNDARY switch: nothing is scheduled past the boundary,
   *  and the incoming step-0 seam glide takes over exactly there, so any hold
   *  would fight it. */
  skipKeys?: ReadonlySet<string>;
  /** Keys to TRUNCATE-ONLY (cancel the outgoing ~200 ms tail at now, no resting
   *  pin) — params the incoming clip drives on an IMMEDIATE mid-clip switch: the
   *  outgoing tail must die NOW, and the incoming clip repossesses the param. */
  truncateKeys?: ReadonlySet<string>;
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
  /** The furthest step THIS track was actually sampled at this pass — the
   *  PER-TRACK overdub window end. A track released mid-pass merges only
   *  `[0, lastSampledStep]`, so the untouched remainder of the loop keeps its
   *  existing events (a gesture spanning a wrap must not erase the part of its
   *  OWN pass-1 recording it didn't re-cover in pass 2). */
  lastSampledStep: number;
}

export class AutomationController {
  private readonly suspended = new Set<string>(); // targets overriding automation (LOCAL)
  // GRABBED = physically held right now, keyed target → the set of HOLDER
  // SURFACES currently gripping it ('pointer' / 'wheel' / 'midi' / 'electra').
  // A grab lasts from a surface's touch-DOWN until ITS release, and the param
  // stays suspended ACROSS a loop wrap (the wrap no longer yanks a param out
  // from under a hand mid-gesture). Per-surface ownership: grabbing one param
  // with two surfaces at once (screen drag + a MIDI twist) ends the override
  // only when the LAST holder releases — the first release must not clear the
  // other surface's still-live grip. Client-local.
  private readonly grabbed = new Map<string, Set<string>>();
  // Targets released mid-loop whose NEXT driven step should DE-ZIPPER back to
  // the envelope (a short seam glide) instead of hard-stepping — the documented
  // release-glide. Consumed on the first post-release drive.
  private readonly resumeGlide = new Set<string>();
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
  /** A live grab (screen pointer-DOWN / MIDI-CC / Electra twist) of `target` by
   *  `holder` (the surface gripping it) — suspend its automation (live wins) and
   *  mark it GRABBED until that holder's physical RELEASE, so a wrap can't clear
   *  the override mid-gesture. Client-local. TRUNCATE: on the first grab of a
   *  param THIS player is driving, cancel-and-hold the scheduled ramp tail at its
   *  current value so the ~200 ms lookahead ghost stops fighting the hand.
   *  AUTO-CAPTURE: if we're recording and `target` is NOT already an automation
   *  track, queue it to be added + captured. */
  notifyTouch(target: AutomationTarget, holder = 'default'): void {
    const k = key(target);
    let holders = this.grabbed.get(k);
    const firstGrab = !holders || holders.size === 0;
    if (!holders) {
      holders = new Set();
      this.grabbed.set(k, holders);
    }
    holders.add(holder);
    this.suspended.add(k);
    if (firstGrab && this.drivenKeys.has(k)) this.deps.hold?.(target, null, 0);
    if (this.recording && !this.currentTrackKeys.has(k)) {
      this.pendingAuto.set(k, target);
    }
  }
  /** Physical RELEASE (pointer-up / CC-idle timeout / Electra release) of
   *  `holder`'s grab — end the override so automation playback resumes, but ONLY
   *  when this was the LAST holder (another surface's still-live grip keeps the
   *  suspension; see `grabbed`). On the real release: pin the user's final value
   *  as a REAL event (via the store tap — a handle whose setParam writes no
   *  AudioParam event would otherwise leave the resume ramp interpolating from
   *  the stale grab-time pin), and flag the target so its next driven step
   *  DE-ZIPPER-glides back to the envelope instead of hard-stepping. */
  notifyRelease(target: AutomationTarget, holder = 'default'): void {
    const k = key(target);
    const holders = this.grabbed.get(k);
    if (holders) {
      holders.delete(holder);
      if (holders.size > 0) return; // another surface still holds it → keep the override
      this.grabbed.delete(k);
    }
    const wasSuspended = this.suspended.delete(k);
    if (!holders && !wasSuspended) return; // double-release / never grabbed → no-op
    if (this.deps.hold && this.drivenKeys.has(k)) {
      // Hand-off pin: the user's final value at the release instant.
      this.deps.hold(target, this.deps.readNorm(target), 0);
    }
    this.resumeGlide.add(k);
  }
  /** Manually re-enable a suspended param (the "re-enable automation"
   *  affordance) — clears EVERY surface's grip. Resumes with a glide. */
  reEnable(target: AutomationTarget): void {
    const k = key(target);
    this.suspended.delete(k);
    if (this.grabbed.delete(k)) this.resumeGlide.add(k);
  }
  /** Re-enable ALL suspended params at once (the card's override-indicator
   *  click clears every live override in one gesture). Each resumes with a glide. */
  reEnableAll(): void {
    for (const k of this.suspended) this.resumeGlide.add(k);
    for (const k of this.grabbed.keys()) this.resumeGlide.add(k);
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
    return [...new Set([...this.suspended, ...this.grabbed.keys()])];
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
    // value you released it on (the "I stopped and it's stuck" confusion). Each
    // resumes with a glide (the release-resume de-zipper), not a hard step.
    for (const k of this.suspended) this.resumeGlide.add(k);
    for (const k of this.grabbed.keys()) this.resumeGlide.add(k);
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
    const k = key(track.target);
    // RELEASE-RESUME glide: the first driven step after a grab's release
    // de-zippers back to the envelope (a short seam ramp from the release-pinned
    // value) instead of hard-stepping — the documented release glide. The flag
    // is consumed only when this step actually drives (an envelope with no value
    // yet at this step keeps it for the next).
    const resume = this.resumeGlide.has(k);
    const interp = trackInterp(track, this.deps.curve(track.target));
    // De-zipper an unavoidable SEAM (loop-wrap / clip-switch INTO / release-
    // resume): the step-0 anchor glides instead of hard-stepping.
    const seam = resume ? Math.max(seamGlideS, SEAM_GLIDE_S) : seamGlideS;
    const pts = stepRampPoints(track.events, stepIndex, laneDur, emitAt, interp, seam);
    if (pts.length) {
      if (resume) this.resumeGlide.delete(k);
      this.drivenKeys.add(k);
      this.deps.drive(track.target, pts);
    }
  }

  // --------------------------------------------------------- hold-last-value
  /**
   * HOLD-LAST-VALUE on automation stop (a lane stops, or its active clip switches
   * away from `clip`). For each track NOT under a live hand, compute the resting
   * value at `stopFrac` — a PURE recompute of the clip data (`automationLinearAt`
   * for continuous, `automationValueAt` for hold/discrete). The caller QUANTIZES
   * `stopFrac` to the integer step grid (`quantizeStopStep`), so collaborating
   * peers — whose audible playheads are peer-local — CONVERGE on the same step
   * and hence the same resting value in all but knife-edge stops. The value goes
   * to `deps.hold`, which truncates any ghost tail (near-now seams) or pins at
   * the boundary (future seams) and de-zipper-glides. NEVER snaps to
   * zero/default. A track with no value yet at `stopFrac` (before its first
   * breakpoint) is left at its live value.
   *
   * `opts` scopes the seam (see HoldLastValueOpts): `skipKeys` leaves params the
   * INCOMING clip takes over at a boundary switch; `truncateKeys` cancel-only
   * params the incoming clip repossesses on an IMMEDIATE switch; `atTime` names
   * a future boundary. Only this clip's tracks leave the driven-key set — other
   * clips this player drives (other lanes) keep their touch-truncate scoping.
   */
  holdLastValue(
    clip: AutomationClipRecord,
    stopFrac: number,
    glideS = SEAM_GLIDE_S,
    opts?: HoldLastValueOpts,
  ): void {
    if (this.deps.hold) {
      for (const tr of clip.tracks) {
        const k = key(tr.target);
        if (opts?.skipKeys?.has(k)) continue; // boundary switch → incoming takes over
        if (this.isSuspended(tr.target)) continue; // a hand owns it → leave it
        if (opts?.truncateKeys?.has(k)) {
          // Immediate switch on a shared param: kill the outgoing tail NOW; the
          // incoming clip's own anchor+glide repossesses it. No resting pin.
          this.deps.hold(tr.target, null, 0, opts?.atTime);
          continue;
        }
        const interp = trackInterp(tr, this.deps.curve(tr.target));
        const read = interp === 'hold' ? automationValueAt : automationLinearAt;
        const v = read(tr.events, stopFrac);
        if (v == null) continue; // no value yet → leave the live value
        this.deps.hold(tr.target, v, glideS, opts?.atTime);
      }
    }
    for (const tr of clip.tracks) this.drivenKeys.delete(key(tr.target));
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
          this.pass.set(k, {
            gate, startVal: v, maxDev: 0, target, auto: true, lastSampledStep: fracStep,
          });
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
        // Per-track overdub window end (a released track stops extending its
        // window, so the un-recovered remainder of the loop is preserved).
        st.lastSampledStep = Math.max(st.lastSampledStep, fracStep);
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
      this.pass.set(key(tr.target), {
        gate, startVal, maxDev: 0, target: tr.target, auto: false, lastSampledStep: 0,
      });
    }
  }

  /**
   * Merge the current pass's captured tracks into `clip` and commit ONCE (whole-
   * clip plain reassign). Only tracks that MOVED (maxDev ≥ MOVE_EPS) are merged;
   * the rest keep their existing automation. Each track's overdub window is
   * `[0, min(windowEnd, its OWN lastSampledStep)]` — PER-TRACK, not one global
   * window: a track released mid-pass (its grab ended at step R) replaces only
   * what it actually re-covered, so existing events in `(R, len)` — including a
   * PREVIOUS pass's recording by the same wrap-spanning gesture — survive.
   * `windowEnd` is the global clamp: `len` at a wrap commit, the last captured
   * step on a PARTIAL pass (manual disarm mid-loop).
   */
  private commitPass(clip: AutomationClipRecord, len: number, windowEnd: number): void {
    const pass = this.pass;
    this.pass = null;
    if (!pass) return;
    const globalEnd = Math.max(0, Math.min(len, windowEnd));
    let anyMoved = false;
    const merged: AutomationTrack[] = clip.tracks.map((tr) => {
      const st = pass.get(key(tr.target));
      // Untouched pre-existing track → keep its automation. An AUTO-CAPTURED track
      // always commits (the user deliberately moved it — even a set-and-hold is
      // the automation they intend), so a single move isn't lost as "no motion".
      if (!st || (st.maxDev < MOVE_EPS && !st.auto)) return tr;
      anyMoved = true;
      const incoming: AutomationEvent[] = st.gate.close();
      const end = Math.max(0, Math.min(globalEnd, st.lastSampledStep));
      const events = mergeAutomationOverdub(tr.events, incoming, 0, end);
      return { ...tr, events };
    });
    if (anyMoved) this.deps.commit(merged);
  }
}
