// packages/web/src/lib/audio/modules/clip-automation-controller.ts
//
// The per-clip-player AUTOMATION CONTROLLER: the stateful adapter that composes
// the pure engine cores (stepRampPoints / RecordGate / QuantizedRecordWindow)
// with INJECTED side effects, so it unit-tests without a real AudioContext or
// Yjs. The clipplayer factory owns one of these and drives it from tick(); the
// deps wire to `engine.scheduleParam`/`holdParam` (playback, zero-Yjs), the
// store-value tap, and the PER-KEY track commit into the sibling `auto` map.
//
// Semantics (owner-locked final model — MODULE assignment + PER-LANE arm):
//  - PLAYBACK: a playing NOTE clip drives its sibling `auto[k]` tracks' params
//    transiently via ramps, in the SAME per-lane step loop as the notes. A param
//    the user is touching is SUSPENDED until the physical RELEASE (live wins).
//  - RECORD is PER-LANE CONTINUOUS OVERDUB under a PER-LANE ARM (Deluge-like):
//    each ARMED lane with a playing note clip runs its OWN QuantizedRecordWindow
//    + pass map — punch-in at THAT clip's next wrap, commit each wrap, keep
//    going. A lane records any control the user TOUCHES (screen / MIDI /
//    Electra — the touch registry; NEVER CV, which fires no touch and never
//    reaches the store tap) on a MODULE ASSIGNED to that lane (data.autoAssign,
//    module→lane). Tracks are auto-created per touched param (targetKey
//    `nodeId::paramId`), capped at MAX_AUTOMATION_TRACKS.
//  - The commit target is LATCHED at pass start (the clip playing when the pass
//    began) and each wrap commits to THAT latched clip index BEFORE the pass
//    re-latches — so a queued launch landing on the wrap commits to the
//    OUTGOING clip, never the incoming one (the mid-record-switch race).
//  - DISARM (press that lane's ARM again) is the manual stop for THAT lane: its
//    in-flight pass commits PARTIAL (only up to its last captured step —
//    untouched tails preserved). Runs only on that lane's recorder client;
//    OTHER armed lanes keep recording (per-lane single-writer: peer A records
//    lane 1 while peer B records lane 2).
//  - Touch/override state is CLIENT-LOCAL (never the Y.Doc) — no per-tick sync.

import {
  mergeAutomationOverdub,
  automationValueAt,
  automationLinearAt,
  automationTargetKey,
  parseAutomationTargetKey,
  MAX_AUTOMATION_TRACKS,
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

/** One committed track update: the merged, PLAIN, step-sorted events for a
 *  single `auto[clipIndex].tracks[key]` entry. The commit dep writes ONLY these
 *  keys (one Y.Doc transaction) — never a whole-record reassign. */
export interface AutoTrackUpdate {
  key: string;
  target: AutomationTarget;
  events: AutomationEvent[];
}

export interface AutomationControllerDeps {
  /** Current NORMALIZED (0..1) value of the target's param — the store tap
   *  (mount-independent, modulation-free), or null if unresolvable. */
  readNorm(target: AutomationTarget): number | null;
  /** The target param's curve id ('discrete' ⇒ hold interpolation). */
  curve(target: AutomationTarget): string | undefined;
  /** Normalized size of ONE unit for a discrete param (so the record gate
   *  doesn't swallow single-unit steps); undefined for continuous params. */
  unitNorm(target: AutomationTarget): number | undefined;
  /** Schedule ramp points on the engine (TRANSIENT — engine.scheduleParam,
   *  never the Y.Doc). `points` values are normalized 0..1; the dep denormalizes. */
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
  /** The CURRENT coerced track views of `auto[clipIndex]` (the engine's cached
   *  read view) — the MERGE BASE a commit overdubs against, read at commit time
   *  so successive wrap commits stack correctly. */
  readAutoTracks(clipIndex: number): readonly AutomationTrack[];
  /** Commit ONE finished pass: write ONLY the updated track keys into
   *  `auto[clipIndex].tracks` (plain objects, one Y.Doc transaction — a peer's
   *  note edit at `clips[clipIndex]` is a DISJOINT key and can never collide). */
  commit(clipIndex: number, updates: AutoTrackUpdate[]): void;
}

// Re-export the canonical key helper (historically lived here; the model owns
// it now so `autoAssign` / `auto[k].tracks` / the override sets share one form).
export { automationTargetKey };
const key = automationTargetKey;

/** Options for `holdLastValue` — how a specific stop seam applies the hold. */
export interface HoldLastValueOpts {
  /** The seam instant (a FUTURE loop boundary for a quantized switch). Absent ⇒
   *  the hold dep uses "now" (immediate stop / transport stop / dispose). */
  atTime?: number;
  /** Keys (automationTargetKey) to leave ENTIRELY alone — params the INCOMING
   *  clip's automation drives from a BOUNDARY switch: nothing is scheduled past
   *  the boundary, and the incoming step-0 seam glide takes over exactly there,
   *  so any hold would fight it. */
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
  /** The control this pass-state records. */
  target: AutomationTarget;
  /** The step this track was FIRST sampled at this pass — the PER-TRACK overdub
   *  window START. Entries are TOUCH-CREATED (module-level assignment has no
   *  fixed param list to pre-seed), so a grab at step 5 merges only from step 5
   *  on: the existing envelope BEFORE the touch survives (never the "one-beat
   *  spot-fix flattens the untouched bars" failure). A gesture already held at
   *  pass start seeds at 0 — identical to the old pre-seeded window. */
  firstSampledStep: number;
  /** The furthest step THIS track was actually sampled at this pass — the
   *  PER-TRACK overdub window end. A track released mid-pass merges only
   *  `[firstSampledStep, lastSampledStep]`, so the untouched remainder of the
   *  loop keeps its existing events (a gesture spanning a wrap must not erase
   *  the part of its OWN pass-1 recording it didn't re-cover in pass 2). */
  lastSampledStep: number;
  /** The hand LIFTED after this entry sampled (window frozen). A RE-GRAB of
   *  the same param later in the SAME pass must NOT reuse this entry — its
   *  window would then span the untouched gap and the merge would wipe the
   *  existing envelope between the two touches. Instead the frozen SEGMENT is
   *  punch-committed and a FRESH entry (a new segment window) starts at the
   *  re-grab position — per-SEGMENT windows, mirroring the mid-pass
   *  moved-away punch-out. */
  released?: boolean;
}

/** One lane's record state under the global arm: its own quantized window +
 *  pass map + the LATCHED commit target (the clip playing at pass start). */
interface LaneRecordState {
  window: QuantizedRecordWindow;
  pass: Map<string, PassState> | null;
  /** Flat clip index the IN-FLIGHT pass commits into — latched at pass START,
   *  so a queued launch swapping the lane's active clip at the wrap commits to
   *  the OUTGOING clip (the mid-record-switch race fix). */
  latchedClipIndex: number;
  passLen: number;
  passLastStep: number;
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
  // PER-LANE record state: each ARMED lane with a playing note clip runs its
  // own window/pass. `armedLanes` mirrors the synced per-lane arm flags for
  // the lanes THIS client is the recorder of.
  private readonly laneRec = new Map<number, LaneRecordState>();
  private readonly armedLanes = new Set<number>();

  constructor(private readonly deps: AutomationControllerDeps) {}

  // ------------------------------------------------------------------ touch
  /** A live grab (screen pointer-DOWN / MIDI-CC / Electra twist) of `target` by
   *  `holder` (the surface gripping it) — suspend its automation (live wins) and
   *  mark it GRABBED until that holder's physical RELEASE, so a wrap can't clear
   *  the override mid-gesture. Client-local. TRUNCATE: on the first grab of a
   *  param THIS player is driving, cancel-and-hold the scheduled ramp tail at its
   *  current value so the ~200 ms lookahead ghost stops fighting the hand. */
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
  /** PER-LANE record-arm (the synced `automation.lanes[L].arm`, mirrored by
   *  that lane's recorder client). The lane arms its window lazily on its next
   *  record tick. */
  armLane(lane: number): void {
    this.armedLanes.add(lane);
  }
  /** Manual STOP for ONE lane (press that lane's ARM again) — its in-flight
   *  pass commits PARTIAL (merge only up to its last captured step so untouched
   *  tails are preserved), into its LATCHED clip. OTHER armed lanes keep
   *  recording untouched. */
  disarmLane(lane: number): void {
    const lr = this.laneRec.get(lane);
    if (lr) {
      if (lr.window.disarm() && lr.pass) this.commitLanePass(lr, lr.passLastStep);
      this.laneRec.delete(lane);
    }
    this.armedLanes.delete(lane);
    // Manual stop → that lane's take is done, so its just-recorded automation
    // should PLAY BACK: clear lingering SUSPENDED-only entries so no param
    // stays frozen at the value it was released on (the "I stopped and it's
    // stuck" confusion), each resuming with a glide. A param a hand is STILL
    // PHYSICALLY HOLDING (grabbed) keeps its override — per the
    // release-on-touch-END policy, disarm must not yank a live gesture; its own
    // pointer-up/CC-idle release ends it. (Lane-scoping the clear would need
    // the assignment map here; clearing every suspended-only key is safe — an
    // override with no live hand has nothing keeping it, and other RECORDING
    // lanes' live gestures are all `grabbed`, so they are untouched.)
    for (const k of this.suspended) {
      if (!this.grabbed.has(k)) {
        this.suspended.delete(k);
        this.resumeGlide.add(k);
      }
    }
  }
  /** Disarm EVERY lane (dispose / factory teardown) — each lane's in-flight
   *  pass commits PARTIAL into its latched clip. */
  disarmAll(): void {
    for (const lane of [...this.armedLanes]) this.disarmLane(lane);
    // Belt-and-suspenders: lanes with record state but no arm entry.
    for (const lane of [...this.laneRec.keys()]) this.disarmLane(lane);
  }
  /** Whether lane L is armed on THIS controller (this client records it). */
  laneArmed(lane: number): boolean {
    return this.armedLanes.has(lane);
  }
  get armed(): boolean {
    return this.armedLanes.size > 0;
  }
  /** True while ANY lane is past its punch-in (actively recording). */
  get recording(): boolean {
    for (const lr of this.laneRec.values()) if (lr.window.state === 'recording') return true;
    return false;
  }
  /** Lane L's record phase ('idle' before its first tick under arm). */
  laneRecording(lane: number): boolean {
    return this.laneRec.get(lane)?.window.state === 'recording';
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
   * HOLD-LAST-VALUE on automation stop (a lane stops, or its active clip
   * switches away from the note clip whose sibling automation is `tracks`). For
   * each track NOT under a live hand, compute the resting value at `stopFrac` —
   * a PURE recompute of the clip data (`automationLinearAt` for continuous,
   * `automationValueAt` for hold/discrete). The caller QUANTIZES `stopFrac` to
   * the integer step grid (`quantizeStopStep`), so collaborating peers — whose
   * audible playheads are peer-local — CONVERGE on the same step and hence the
   * same resting value in all but knife-edge stops. The value goes to
   * `deps.hold`, which truncates any ghost tail (near-now seams) or pins at the
   * boundary (future seams) and de-zipper-glides. NEVER snaps to zero/default.
   * A track with no value yet at `stopFrac` (before its first breakpoint) is
   * left at its live value.
   *
   * `opts` scopes the seam (see HoldLastValueOpts): `skipKeys` leaves params the
   * INCOMING clip's automation takes over at a boundary switch; `truncateKeys`
   * cancel-only params the incoming clip repossesses on an IMMEDIATE switch;
   * `atTime` names a future boundary. Only these tracks leave the driven-key
   * set — other clips this player drives (other lanes) keep their scoping.
   */
  holdLastValue(
    tracks: readonly AutomationTrack[],
    stopFrac: number,
    glideS = SEAM_GLIDE_S,
    opts?: HoldLastValueOpts,
  ): void {
    if (this.deps.hold) {
      for (const tr of tracks) {
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
    for (const tr of tracks) this.drivenKeys.delete(key(tr.target));
  }

  // ------------------------------------------------------------- display
  /**
   * VISUAL SMOOTHING (P3): the CURRENT interpolated value (normalized 0..1) of
   * each track that is PLAYING BACK at `fracStep`, for the on-screen knob.
   * Automation schedules smooth AUDIO ramps but only refreshes the knob cache at
   * step boundaries, so a slow clip looks jumpy; the tick feeds these to
   * engine.setDisplayParam every tick (~40fps) so the knob follows the envelope.
   * A TOUCHED track is skipped (its live value already drives the knob).
   * CPU-bounded to the clip's tracks (≤ MAX_AUTOMATION_TRACKS). PURE read.
   */
  displayValues(
    tracks: readonly AutomationTrack[],
    fracStep: number,
  ): { target: AutomationTarget; value: number }[] {
    const out: { target: AutomationTarget; value: number }[] = [];
    for (const tr of tracks) {
      if (this.isSuspended(tr.target)) continue; // being touched → live value shows
      const interp = trackInterp(tr, this.deps.curve(tr.target));
      const read = interp === 'hold' ? automationValueAt : automationLinearAt;
      const v = read(tr.events, fracStep);
      if (v != null) out.push({ target: tr.target, value: v });
    }
    return out;
  }

  // --------------------------------------------------------------- record
  /** Every targetKey currently under a live override (grabbed by a hand OR
   *  suspended) — the touch-created record candidates. */
  private heldKeys(): string[] {
    return [...new Set([...this.grabbed.keys(), ...this.suspended])];
  }

  /**
   * PER-LANE RECORD — called once per tick per ARMED lane with a PLAYING note
   * clip and ≥1 ASSIGNED module, ONLY on that lane's recorder client, with the
   * lane's fractional-step playhead. Each lane independently runs continuous
   * overdub: punch-in at ITS clip's own next wrap, capture each tick, and at
   * EVERY wrap commit the just-finished pass — into the LATCHED clip index,
   * BEFORE the pass re-latches to `clipIdx` (which a queued launch may just
   * have swapped) — then start a fresh one. Recording continues until that
   * lane's disarm.
   *
   * `assignedModules` = the MODULE node ids autoAssign maps to THIS lane (the
   * record scope): a control records IFF the user is TOUCHING it (screen /
   * MIDI / Electra — never CV, which fires no touch) AND its module is in this
   * set. Tracks are TOUCH-CREATED — a pass entry appears the first tick a
   * matching control is held, seeded at that position (window start), so an
   * untouched region of the loop is never rewritten. Entries are capped at
   * MAX_AUTOMATION_TRACKS per pass (the commit-side cap holds the durable
   * line; `capHit` lets the surface say so politely).
   */
  recordLaneTick(
    lane: number,
    clipIdx: number,
    assignedModules: ReadonlySet<string>,
    fracStep: number,
    len: number,
  ): void {
    if (!this.armedLanes.has(lane)) return;
    let lr = this.laneRec.get(lane);
    if (!lr) {
      lr = { window: new QuantizedRecordWindow(), pass: null, latchedClipIndex: clipIdx, passLen: len, passLastStep: 0 };
      this.laneRec.set(lane, lr);
    }

    // PUNCH OUT AT THE SWAP: the lane's active clip changed mid-pass (a queued
    // launch applied — possibly to a SHORTER clip, whose clamped playhead would
    // otherwise read as a spurious early wrap and commit a garbage full-window
    // pass). Commit the in-flight pass PARTIAL (each entry bounded to its own
    // sampled window) into the LATCHED outgoing clip NOW, and reset the window
    // so the next pass punches in cleanly at the INCOMING clip's first real wrap.
    if (lr.pass && clipIdx !== lr.latchedClipIndex) {
      this.commitLanePass(lr, lr.passLastStep);
      lr.window.disarm();
    }
    if (lr.window.state === 'idle') lr.window.arm();

    const transition = lr.window.advance(fracStep);

    // WRAP (continuous overdub): commit the pass that just ended — full loop
    // window, into the clip LATCHED at ITS start — then open a new one (latched
    // to the clip playing NOW) so recording keeps going with no gap.
    if (transition === 'wrap') {
      this.commitLanePass(lr, lr.passLen);
      this.beginLanePass(lr, clipIdx, assignedModules, len);
    } else if (transition === 'punch-in') {
      this.beginLanePass(lr, clipIdx, assignedModules, len);
    }

    if (lr.window.state === 'recording' && lr.pass) {
      lr.passLen = len;
      lr.passLastStep = Math.max(lr.passLastStep, fracStep);
      // A param whose MODULE left this lane's assignment mid-pass (unassigned /
      // moved to another lane) punches its OWN entry out: commit what it
      // captured so far (bounded to ITS sampled window) into the latched clip
      // and stop sampling it here — the old lane must not keep capturing it.
      for (const [k, st] of [...lr.pass]) {
        if (assignedModules.has(st.target.nodeId)) continue;
        lr.pass.delete(k);
        this.commitEntries(lr.latchedClipIndex, lr.passLen, [st], st.lastSampledStep);
      }
      // TOUCH-CREATED entries: a control grabbed THIS tick (screen / MIDI /
      // Electra) whose module is assigned to this lane joins the pass seeded at
      // the CURRENT position (its window starts here — the loop before the
      // touch is preserved). CV modulation can never appear here: it fires no
      // notifyAutomationTouch, so it is never in the held set.
      //
      // PER-SEGMENT WINDOWS (re-grab in the same pass): if the key already has
      // an entry whose hand RELEASED earlier this pass, that frozen SEGMENT is
      // punch-committed NOW ([first, last] of the FIRST touch only) and a
      // FRESH entry starts at the re-grab position — one merge window per
      // touch, so the existing envelope BETWEEN two disjoint touches of the
      // SAME param in one pass is never wiped (mirrors the mid-pass
      // moved-away punch-out above).
      for (const k of this.heldKeys()) {
        const prev = lr.pass.get(k);
        if (prev && !prev.released) continue; // still held — same segment
        if (prev && prev.released) {
          lr.pass.delete(k);
          this.commitEntries(lr.latchedClipIndex, lr.passLen, [prev], prev.lastSampledStep);
        }
        const target = parseAutomationTargetKey(k);
        if (!target || !assignedModules.has(target.nodeId)) continue;
        if (lr.pass.size >= MAX_AUTOMATION_TRACKS) {
          this.capHit = true; // surfaced politely (card badge); durable cap holds
          continue;
        }
        const v = this.deps.readNorm(target);
        if (v == null) continue; // unresolvable control (no ParamDef) → skip
        const unit = this.deps.unitNorm(target);
        const gate = new RecordGate(unit != null ? { unitDelta: unit } : {});
        gate.sample(fracStep, v);
        lr.pass.set(k, {
          gate,
          startVal: v,
          maxDev: 0,
          target,
          firstSampledStep: fracStep,
          lastSampledStep: fracStep,
        });
      }
      // TOUCH-GATED capture: sample ONLY the tracks the user is ACTIVELY TOUCHING
      // (in `suspended`/`grabbed`). A released track is NOT sampled further —
      // its window FREEZES (marked `released` so a later re-grab starts a new
      // segment) and the un-recovered remainder of the loop keeps its existing
      // events and resumes PLAYING BACK next loop.
      for (const st of lr.pass.values()) {
        if (!this.isHeld(key(st.target))) {
          st.released = true; // window frozen — a re-grab opens a NEW segment
          continue;
        }
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
      // capture continues into the next pass. Scoped to THIS lane's assigned
      // MODULES — another recording lane's wrap must not clear this lane's state.
      for (const k of [...this.suspended]) {
        if (this.grabbed.has(k)) continue;
        const target = parseAutomationTargetKey(k);
        if (target && assignedModules.has(target.nodeId)) this.suspended.delete(k);
      }
    }
  }

  /** Sticky "track cap reached" flag — set when a touch could not open a new
   *  track (MAX_AUTOMATION_TRACKS). The card polls + clears it (polite surface,
   *  client-local — never the Y.Doc). */
  capHit = false;

  /** Lane L STOPPED playing (or switched to a non-note clip) while armed —
   *  punch out: commit the in-flight PARTIAL pass (bounded to its last captured
   *  step) into the LATCHED clip, then reset the lane's window so a later
   *  launch re-punches at the new clip's wrap. Cheap no-op when the lane has no
   *  record state. */
  laneStopped(lane: number): void {
    const lr = this.laneRec.get(lane);
    if (!lr) return;
    if (lr.window.disarm() && lr.pass) this.commitLanePass(lr, lr.passLastStep);
    this.laneRec.delete(lane);
  }

  private beginLanePass(
    lr: LaneRecordState,
    clipIdx: number,
    assignedModules: ReadonlySet<string>,
    len: number,
  ): void {
    lr.pass = new Map();
    lr.latchedClipIndex = clipIdx; // LATCH the commit target at pass start
    lr.passLen = len;
    lr.passLastStep = 0;
    // Seed entries for the controls a hand is ALREADY HOLDING at pass start
    // (a gesture spanning the wrap keeps recording seamlessly) — seeded at
    // step 0, so their window covers the loop start exactly like the old
    // pre-seeded model. New touches mid-pass join in recordLaneTick.
    for (const k of this.heldKeys()) {
      const target = parseAutomationTargetKey(k);
      if (!target || !assignedModules.has(target.nodeId)) continue;
      if (lr.pass.size >= MAX_AUTOMATION_TRACKS) {
        this.capHit = true;
        continue;
      }
      const v = this.deps.readNorm(target);
      if (v == null) continue;
      const unit = this.deps.unitNorm(target);
      const gate = new RecordGate(unit != null ? { unitDelta: unit } : {});
      gate.sample(0, v); // seed the loop start so the pre-move hold is captured
      lr.pass.set(k, {
        gate,
        startVal: v,
        maxDev: 0,
        target,
        firstSampledStep: 0,
        lastSampledStep: 0,
      });
    }
  }

  /**
   * Merge the lane's current pass into its LATCHED clip's existing tracks and
   * commit ONCE — per-key writes only (deps.commit). Only tracks that MOVED
   * (maxDev ≥ MOVE_EPS) are merged; the rest keep their existing automation.
   * Each track's overdub window is
   * `[firstSampledStep, min(windowEnd, its OWN lastSampledStep)]` — PER-TRACK,
   * not one global window: a track grabbed at step F and released at step R
   * replaces only what it actually covered, so existing events BEFORE the
   * touch and in `(R, len)` — including a PREVIOUS pass's recording by the
   * same wrap-spanning gesture — survive. `windowEnd` is the global clamp:
   * `passLen` at a wrap commit, the last captured step on a PARTIAL pass
   * (manual disarm / lane stop mid-loop).
   */
  private commitLanePass(lr: LaneRecordState, windowEnd: number): void {
    const pass = lr.pass;
    lr.pass = null;
    if (!pass) return;
    this.commitEntries(lr.latchedClipIndex, lr.passLen, pass.values(), windowEnd);
  }

  /** Merge + commit a SET of pass entries into `clipIdx` (the whole pass at a
   *  wrap/stop, or a single moved-away entry mid-pass). Per-track window:
   *  `[entry.firstSampledStep, min(passLen, windowEnd, entry.lastSampledStep)]`. */
  private commitEntries(
    clipIdx: number,
    passLen: number,
    entries: Iterable<PassState>,
    windowEnd: number,
  ): void {
    const globalEnd = Math.max(0, Math.min(passLen, windowEnd));
    const existing = this.deps.readAutoTracks(clipIdx);
    const byKey = new Map(existing.map((t) => [key(t.target), t]));
    const updates: AutoTrackUpdate[] = [];
    for (const st of entries) {
      if (st.maxDev < MOVE_EPS) continue; // untouched/unmoved → keep existing automation
      const k = key(st.target);
      const incoming: AutomationEvent[] = st.gate.close();
      const end = Math.max(0, Math.min(globalEnd, st.lastSampledStep));
      const start = Math.max(0, Math.min(st.firstSampledStep, end));
      const events = mergeAutomationOverdub(byKey.get(k)?.events ?? [], incoming, start, end);
      updates.push({ key: k, target: st.target, events });
    }
    if (updates.length) this.deps.commit(clipIdx, updates);
  }
}
