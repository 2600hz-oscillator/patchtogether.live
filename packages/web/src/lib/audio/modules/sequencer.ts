// packages/web/src/lib/audio/modules/sequencer.ts
//
// 32-step sequencer. Plain JS — internal clock + ConstantSourceNodes for
// pitch/gate outputs. The "two clocks" lookahead scheduler runs off the
// shared scheduler-clock (a Worker tick, isolated from main-thread jank) and
// queues sample-accurate AudioParam writes ~200 ms ahead. The Worker timer
// keeps firing even when the main thread is busy (drag, render, Y.Doc
// rebroadcast); the bumped lookahead absorbs any remaining backlog.
//
// Per-step state lives in node.data.steps as an array of {on, pitch}. Knob
// params live in node.params.
//
// Inputs:
//   clock (gate): external clock; rising edges advance one step. When unpatched the internal BPM drives.
//
// Outputs:
//   pitch (polyPitchGate): per-step pitch (root + chord lanes). A mono pitch sink auto-receives lane 0.
//   gate (gate): main gate per on-step (gateLength shapes the pulse width).
//   clock (gate): chained clock-out: rising edge at the start of each step. Useful for driving downstream sequencers.
//
// Params:
//   bpm (linear 30..300, default 120): internal tempo when clock is unpatched.
//   length (discrete 1..128, default 16): number of active steps.
//   octave (discrete -2..2, default 0): octave transposition applied to all pitches.
//   gateLength (linear 0.1..0.95, default 0.5): per-step gate duty cycle.
//   swing (linear 0..0.75, default 0): off-step time shift.
//   isPlaying (discrete 0..1, default 0): transport state (1 = running).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import {
  coerceToNoteStep,
  migrateStepArrayV1ToV2,
  C3_MIDI,
} from '$lib/audio/note-entry';
import {
  type ChordQuality,
  POLY_CHANNEL_PAIRS,
  chordVoicing,
  createPolySender,
  voicingToVOct,
} from '$lib/audio/poly';
import {
  createTransportCv,
  pickQueuedSlotFromEvents,
  pickNavFromEvents,
  TRANSPORT_CV_PORT_DEFS,
  EXTENDED_TRANSPORT_CV_PORT_DEFS,
} from './transport-cv';
import {
  coerceSlots,
  coerceSlotKey,
  isInputPortConnected,
  shouldSequencerRun,
  occupiedSlots,
  resolveNavTarget,
  type SlotKey,
  type NavDirection,
} from './transport-helpers';
import { getSchedulerClock, SCHEDULER_TICK_MS } from '$lib/audio/scheduler-clock';
import { createPlayheadTracker } from './playhead-tracker';

export interface Step {
  on: boolean;
  /** MIDI int (a4 = 69) for this step's pitch, or null = no note. v1 of this
   *  module used `pitch: <semitones from C4>`; the runtime accepts both shapes
   *  via coerceToNoteStep, and persisted patches migrate via the def.migrate
   *  callback. */
  midi: number | null;
  /** Stage-1 polyphony (v3). Defaults to 'mono' = legacy single-note behavior.
   *  'maj' / 'min' broadcast a triad (root/3rd/5th/octave) on the polyPitchGate
   *  output. See packages/web/src/lib/audio/poly.ts. */
  chord?: ChordQuality;
}

/** Normalize an arbitrary step-like object to a v3 Step (with chord). The
 *  base coerceToNoteStep handles {on, midi}; we layer the chord field on top. */
export function coerceToSequencerStep(raw: unknown): Step {
  const base = coerceToNoteStep(raw);
  let chord: ChordQuality = 'mono';
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (r.chord === 'maj' || r.chord === 'min' || r.chord === 'mono') {
      chord = r.chord;
    }
  }
  return { on: base.on, midi: base.midi, chord };
}

export interface SequencerData {
  steps: Step[]; // length MAX_STEPS (128) — was 32 pre-pages PR.
}

// Visible capacity per page UI render = 16 (kept under PAGE_SIZE in
// sequencer-pages.ts). STEP_COUNT is the data array capacity: 128 across
// 8 pages of 16. Old saves with shorter steps[] arrays are widened on read
// via coerceToSequencerStep + ensureCapacity in the card path.
export const STEP_COUNT = 128;

export function defaultSteps(): Step[] {
  return Array.from({ length: STEP_COUNT }, () => ({ on: false, midi: C3_MIDI, chord: 'mono' }));
}

export const sequencerDef: AudioModuleDef = {
  type: 'sequencer',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'sequencer',
  category: 'modulation',
  // v2: each step's pitch encoding changed from `pitch: <semitones from C4>`
  //     (free-running ±24 slider) to `midi: <int 33..114> | null` (text-entry).
  // v3: PR-31 — keyboard-nav + hold-CV-on-off-gate + C3 default for new
  //     sequencers. No data shape change; existing v2 saves load unchanged.
  // v4: PR-34 — per-step optional `chord: 'mono' | 'maj' | 'min'` for Stage-1
  //     polyphony. Missing chord defaults to 'mono' so old saves load
  //     unchanged. The pitch output port type changed from 'pitch' to
  //     'polyPitchGate'; the engine's resolveConnection() routes lane 0 to
  //     mono pitch sinks so existing patches keep working.
  schemaVersion: 4,
  migrate(data, fromVersion) {
    // v1 -> v2: per-step pitch encoding (semitones-from-C4) -> midi int.
    let migrated: Record<string, unknown> | undefined;
    if (fromVersion < 2) {
      migrated = migrateStepArrayV1ToV2(data, 'steps');
    } else if (data && typeof data === 'object') {
      migrated = { ...(data as Record<string, unknown>) };
    } else {
      migrated = undefined;
    }
    // v2 -> v3: PR-31's behavioral changes (keyboard-nav, hold-CV, C3 default
    // for fresh instances). No persisted-data shape change; saved patches
    // pass through untouched.
    // v3 -> v4: ensure each step carries a `chord` field; missing -> 'mono'.
    if (fromVersion < 4 && migrated && Array.isArray(migrated.steps)) {
      migrated.steps = (migrated.steps as unknown[]).map((s) => {
        const ns = coerceToSequencerStep(s);
        return { on: ns.on, midi: ns.midi, chord: ns.chord ?? 'mono' };
      });
    }
    return migrated;
  },

  inputs: [
    // External clock: when patched, the sequencer advances on incoming rising
    // edges instead of its internal BPM. Disconnect to fall back to BPM.
    { id: 'clock', type: 'gate' },
    // Shared transport CV inputs (PR feat/sequencer-transport-quicksave):
    //   play_cv      → rising edge toggles isPlaying
    //   reset_cv     → rising edge resets stepIndex to 0
    //   queue1..4_cv → rising edge sets node.data.queuedSlot to N
    ...TRANSPORT_CV_PORT_DEFS,
    // feat/seq 8-slots + quantized nav:
    //   queue5..8_cv → rising edge queues slot 5..8 (applied on sequence-end)
    //   next_cv      → at next pattern end, jump to the next OCCUPIED slot
    //   prev_cv      → ... prior occupied slot (wraps)
    //   random_cv    → ... a random occupied slot
    ...EXTENDED_TRANSPORT_CV_PORT_DEFS,
  ],
  outputs: [
    // Stage-1 polyphony: pitch is a 10-channel polyPitchGate cable. When a
    // step's chord is 'mono', only lane 0 carries a non-zero gate, so a
    // mono `pitch` sink (via the engine's backward-compat resolver) sees the
    // same root-note V/oct as before. 'maj'/'min' broadcast a triad on
    // lanes 0..3 with lane 4 reserved for future 7ths/9ths.
    { id: 'pitch', type: 'polyPitchGate' },
    { id: 'gate', type: 'gate' },
    // Clock pulse per step advance (10 ms high). Fires on every advance,
    // regardless of step on/off — it's the "I just stepped" signal. Patch
    // into another sequencer's clock_in to chain.
    { id: 'clock', type: 'gate' },
  ],
  params: [
    { id: 'bpm',        label: 'BPM',  defaultValue: 120, min: 30,  max: 300,  curve: 'linear' },
    { id: 'length',     label: 'Len',  defaultValue: 16,  min: 1,   max: 128,  curve: 'discrete' },
    { id: 'octave',     label: 'Oct',  defaultValue: 0,   min: -2,  max: 2,    curve: 'discrete' },
    { id: 'gateLength', label: 'Gate', defaultValue: 0.5, min: 0.1, max: 0.95, curve: 'linear' },
    { id: 'swing',      label: 'Sw',   defaultValue: 0,   min: 0,   max: 0.75, curve: 'linear' },
    // 0 = stopped, 1 = playing. Default stopped — explicit play.
    { id: 'isPlaying',  label: 'Play', defaultValue: 0,   min: 0,   max: 1,    curve: 'discrete' },
  ],

  // Module-grouping Phase 4 — surface PLAY/STOP as a single button a
  // containing GROUP! can opt to expose on its bar.
  exposableControls: [
    { id: 'playStop', label: 'Play', kind: 'button', paramId: 'isPlaying' },
  ],
  // Instruments v1 — full step grid is atomically exposable.
  exposesSequence: true,

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // Stage-1 polyphony: the pitch port is a polyPitchGate cable carrying 5
    // voice pairs (10 channels). The mono gate port stays a single ConstantSource
    // that goes high on any chord step (so the existing ADSR/VCA chain still
    // triggers on every step regardless of chord quality). The polySender owns
    // the per-lane pitch + gate ConstantSources for the cable.
    const polyPitch = createPolySender(ctx);
    const gateSrc = ctx.createConstantSource();
    const clockOutSrc = ctx.createConstantSource();
    gateSrc.offset.value = 0;
    clockOutSrc.offset.value = 0;
    gateSrc.start();
    clockOutSrc.start();

    // Clock input: a GainNode acts as the patch port. Anything routed in flows
    // through to an AnalyserNode that the tick polls for rising edges.
    // Latency budget: ~TICK_MS (25 ms) from upstream pulse to step advance.
    const clockInGain = ctx.createGain();
    const clockInAnalyser = ctx.createAnalyser();
    // #229: the external-clock edge detector scans the analyser ring buffer
    // for the samples that arrived since the last tick. At fftSize=2048 the
    // ring only holds ~42 ms — so when the main thread stalls longer than that
    // (a canvas pan/drag event-storm can block for 80–150 ms), clock edges
    // that arrived during the stall are OVERWRITTEN before the tick gets to
    // read them. Those edges are lost ⇒ dropped/late steps ⇒ tempo jitter on
    // EXTERNAL clock, which is exactly #229's "drag disturbs tempo even on
    // MIDI clock". Widen the ring to 16384 samples (~341 ms at 48 kHz) so it
    // comfortably outlasts any plausible main-thread stall — matching the
    // headroom the internal-clock path already gets from the Worker tick +
    // 200 ms lookahead. fftSize must be a power of two ≤ 32768.
    clockInAnalyser.fftSize = 16384;
    clockInGain.connect(clockInAnalyser);
    const clockInBuffer = new Float32Array(clockInAnalyser.fftSize);

    // Silence keeps the gain + analyser in the active graph even with nothing
    // patched in (same trick the Faust modules use for their merger inputs).
    const clockInSilence = ctx.createConstantSource();
    clockInSilence.offset.value = 0;
    clockInSilence.start();
    clockInSilence.connect(clockInGain);

    let lastClockSample = 0;
    let lastClockSampleTime = ctx.currentTime;
    const CLOCK_THRESHOLD = 0.5;

    // Shared transport CV inputs (play_cv, reset_cv, queue{1..8}_cv +
    // next/prev/random nav gates — opted in via { extended: true }).
    const transportCv = createTransportCv(ctx, { extended: true });
    let lastTransportPollTime = ctx.currentTime;
    let totalSequenceEnds = 0;

    function emitClockPulse(atTime: number) {
      clockOutSrc.offset.setValueAtTime(1, atTime);
      clockOutSrc.offset.setValueAtTime(0, atTime + 0.01);
    }

    // #224 reset-dedup helper ----------------------------------------------
    // Cancel the gate / pitch / clock-out events the lookahead already queued
    // into the audio thread's future, so a reset doesn't leave a stale step-0
    // gate sounding ALONGSIDE the post-reset re-fire (the double-hit). This
    // reuses the EXACT primitives the stop-transition path already ships with
    // (gateSrc cancel+zero + polyPitch.silence), plus a clock-out cancel so a
    // chained downstream sequencer isn't double-advanced by the same reset.
    function clearPendingScheduledEvents(): void {
      const now = ctx.currentTime;
      gateSrc.offset.cancelScheduledValues(now);
      gateSrc.offset.setValueAtTime(0, now);
      clockOutSrc.offset.cancelScheduledValues(now);
      clockOutSrc.offset.setValueAtTime(0, now);
      polyPitch.silence(now);
      // We just cancelled the (possibly future) onset that lastScheduledGateOnTime
      // pointed at, so forget it — otherwise the #224 dedup would suppress the
      // re-anchored step-0 of a genuine reset. After a clear, the next gate-high
      // always sounds.
      lastScheduledGateOnTime = -Infinity;
    }
    // ----------------------------------------------------------------------

    function isClockInConnected(): boolean {
      return isInputPortConnected(Object.values(livePatch.edges), nodeId, 'clock');
    }
    function isPlayCvConnected(): boolean {
      return isInputPortConnected(Object.values(livePatch.edges), nodeId, 'play_cv');
    }

    // The reconciler passes a snapshot of the node, but the Sequencer needs
    // LIVE access to per-tick state (steps + params change while running).
    // Read from the live patch by node id; if the node has been deleted,
    // the dispose() path will set alive=false and the tick stops.
    const nodeId = node.id;

    // Live state read from node.params + node.data each tick.
    let stepIndex = 0;
    let nextStepTime = ctx.currentTime + 0.05;
    let prevPlaying = false;
    // #224: audio-time of the most-recent gate-high we scheduled. emitStep
    // drops any gate-high scheduled within half a step of this, killing the
    // clock-divided-reset double-hit at the scheduling layer (grid-independent).
    let lastScheduledGateOnTime = -Infinity;
    let alive = true;
    let unsubscribeTick: (() => void) | null = null;
    // Lookahead 200 ms (was 100 ms) — gives the audio thread a 4x cushion
    // when the main thread is briefly blocked by drag/render. Combined with
    // the scheduler-clock Worker (which keeps emitting tick events even
    // while main-thread JS is starving), this is the difference between
    // "audible tempo jitter when dragging" and "stable tempo".
    const LOOKAHEAD_S = 0.2;
    const TICK_MS = SCHEDULER_TICK_MS;
    // #229: if a main-thread stall outlasts the lookahead, the scheduler
    // resumes with `nextStepTime` already behind `ctx.currentTime`. Steps
    // more than this tolerance in the past are DROPPED (gate skipped, phase
    // still advances) rather than scheduled — Web Audio would clamp a past
    // time to "now" and bunch the whole backlog onto the present (the
    // audible double-hit + tempo lurch when dragging, #224/#229). 5 ms of
    // slack means ordinary near-now scheduling jitter still sounds (a hair
    // late) instead of being dropped.
    const LATE_DROP_EPS = 0.005;

    function readSteps(): Step[] {
      const live = livePatch.nodes[nodeId];
      const steps = (live?.data as Record<string, unknown> | undefined)?.steps;
      if (Array.isArray(steps)) {
        // Coerce each step shape so legacy {on, pitch} entries still drive
        // audio while in-memory until a save+load triggers the def.migrate.
        return (steps as unknown[]).map(coerceToSequencerStep);
      }
      return defaultSteps();
    }
    function readParam(id: string, fallback: number): number {
      const live = livePatch.nodes[nodeId];
      const v = live?.params?.[id];
      return typeof v === 'number' ? v : fallback;
    }

    /** Schedule one step's pitch + gate + clock-out events at the given audio
     * time. Used by both the internal-BPM scheduler and the external-clock
     * advance path. `stepDurForGate` is how long the gate stays high relative
     * to the step (passed as duration so external-clock mode can derive it
     * from observed inter-pulse spacing instead of from BPM). */
    // Last V/oct written to pitchSrc + last gate emitted. Tracked here because
    // AudioParam.value is the *intrinsic* value (subject to audio-thread
    // scheduling) and not always observable from the JS thread immediately
    // after setValueAtTime. Tests that need ground truth read these via
    // engine.read(node, 'pitchVOct' | 'gateValue').
    let lastEmittedVOct = 0;
    let lastEmittedGate = 0;
    // Per-lane mirrors of the most-recently-scheduled values, for tests and
    // motorized-fader-style introspection without reading the AudioParam.
    const lastEmittedLaneVOct = new Array<number>(POLY_CHANNEL_PAIRS).fill(0);
    const lastEmittedLaneGate = new Array<number>(POLY_CHANNEL_PAIRS).fill(0);

    function emitStep(idx: number, atTime: number, stepDurForGate: number) {
      // #229 regression canary: emitStep invoked with a timestamp already in
      // the past means the catch-up drop guard failed and Web Audio is about
      // to clamp this (gate + clock pulse) onto "now" → bunching. Counted at
      // the entry (gate-agnostic) so it trips even on all-off default steps.
      // The drop guard keeps it at 0; the tempo-stability spec asserts that.
      if (atTime < ctx.currentTime - LATE_DROP_EPS) pastDueEmits++;
      const octave = readParam('octave', 0);
      const gateLengthFrac = readParam('gateLength', 0.5);
      const steps = readSteps();
      const step = steps[idx];
      // Always emit a clock pulse on advance — that's the chain-out signal
      // and it fires regardless of step on/off.
      emitClockPulse(atTime);
      // Scheduler lookahead vs sounding-now: queue the (idx, atTime) entry so
      // the visual playhead derives "which step is the audio thread playing
      // right now" instead of "which step is about to be scheduled".
      playhead.schedule(idx, atTime);

      // Compute the chord voicing. If the step is off / has no pitch, every
      // lane's gate is 0 and the mono `gate` output stays low.
      const baseMidi = step && step.on && step.midi !== null ? step.midi : null;
      const quality: ChordQuality = step?.chord ?? 'mono';
      const voicing = chordVoicing(baseMidi, quality);
      // Apply the octave param after chord math so the whole chord transposes
      // together (octave shifts every gated lane by the same V/oct amount).
      const lanes = voicingToVOct(voicing).map((l) =>
        l.gate === 1 ? { pitch: l.pitch + octave, gate: 1 as const } : l,
      );
      const gateOff = stepDurForGate * gateLengthFrac;
      polyPitch.scheduleStep(atTime, lanes, gateOff);

      // Mirror per-lane values for tests / debugging.
      for (let i = 0; i < POLY_CHANNEL_PAIRS; i++) {
        const l = lanes[i] ?? { pitch: 0, gate: 0 };
        lastEmittedLaneVOct[i] = l.pitch;
        lastEmittedLaneGate[i] = l.gate;
      }
      // The mono gate output goes high if ANY lane is gated this step.
      const anyGate = lanes.some((l) => l.gate === 1);
      // RESET-DEDUP (#224): refuse to schedule a gate-high closer than half a
      // step to the previous one. A clock-divided reset coincident with the
      // natural wrap makes BOTH the lookahead and the post-reset re-anchor try
      // to schedule step 0 within the same beat — the audible double-hit. The
      // 25 ms scheduler-tick grid means we can't reliably detect that case from
      // stepIndex alone (the lookahead may have advanced between the wrap and
      // the reset's detection), so we dedup at the SCHEDULING layer where it's
      // grid-independent: the second near-coincident onset is dropped. A
      // genuine mid-bar reset re-anchors far from the previous onset and still
      // fires. -Infinity = none scheduled yet (first gate always sounds).
      const minGapSec = (stepDurForGate || 0.001) * 0.5;
      const tooClose = atTime - lastScheduledGateOnTime < minGapSec;
      if (anyGate && !tooClose) {
        lastScheduledGateOnTime = atTime;
        gateSrc.offset.setValueAtTime(1, atTime);
        gateSrc.offset.setValueAtTime(0, atTime + gateOff);
        // Backward-compat tracking: lastEmittedVOct mirrors lane 0 (root).
        lastEmittedVOct = lanes[0]?.pitch ?? 0;
        lastEmittedGate = 1;
      } else if (anyGate && tooClose) {
        // Duplicate near-coincident onset suppressed (#224). Treat as gated for
        // JS observers so the playhead/voicing still reflect this step.
        lastEmittedVOct = lanes[0]?.pitch ?? 0;
        lastEmittedGate = 1;
      } else {
        // Gate suppressed (off or invalid pitch). Hold-on-off-gate CV: we do
        // NOT call polyPitch.scheduleStep() on suppressed steps — the pitch
        // port keeps its last gated lane values for the duration of the
        // silent step. lastEmittedVOct + lastEmittedLaneVOct are left alone
        // for the same reason; lastEmittedGate flips to 0 so JS observers
        // see the gate go low.
        lastEmittedGate = 0;
      }
    }

    /** Drain the transport CV inputs + dispatch effects. Returns the
     *  isPlaying value AFTER any play_cv toggle (so the caller's
     *  subsequent prev/cur transition logic stays correct). */
    function pollTransportCv(): boolean {
      const nowAt = ctx.currentTime;
      const elapsed = nowAt - lastTransportPollTime;
      lastTransportPollTime = nowAt;
      const ev = transportCv.drain(elapsed);
      const live = livePatch.nodes[nodeId];
      let isPlaying = readParam('isPlaying', 0) >= 0.5;
      // Each play_cv rising edge toggles isPlaying. In practice you'd see
      // one edge per gate pulse; multiple edges in one tick collapse to
      // an overall toggle (XOR).
      if (ev.play % 2 === 1) {
        isPlaying = !isPlaying;
        if (live?.params) live.params.isPlaying = isPlaying ? 1 : 0;
      }
      if (ev.reset > 0) {
        // #224 (cross-module reset double-hit), snap-to-boundary dedup.
        //
        // In internal-BPM mode the lookahead loop has ALREADY scheduled step
        // gates up to LOOKAHEAD_S (200 ms) into the audio thread's future. A
        // naive reset forces stepIndex=0 and re-anchors `nextStepTime` to
        // "now" — but when the reset is a perfect integer division of the run
        // clock, it lands right as the sequence is ALSO naturally wrapping to
        // step 0. The lookahead already queued step 0's gate at the natural
        // boundary; the re-anchor then queues a SECOND step-0 gate one beat
        // later → the audible double-hit.
        //
        // We make the reset a true no-op WHEN it's redundant: if step 0 was
        // scheduled within one step-duration of "now" (the sequence just
        // wrapped to the downbeat on its own), the natural lookahead schedule
        // is already exactly what the reset wants, so we leave stepIndex,
        // nextStepTime, and the queued events untouched. A genuine mid-bar
        // reset (its last step 0 is far from now) falls through to the real
        // reset, which cancels the not-yet-sounded lookahead events and
        // re-anchors so exactly one step-0 gate fires.
        const stepDurNow = 60 / Math.max(1, readParam('bpm', 120)) / 4;
        // lastScheduledGateOnTime is the (future) audio-time of the most-recent
        // gate-high the lookahead queued; it can sit slightly ahead of or behind
        // ctx.currentTime when the reset is detected. Seeded to -Infinity, so
        // Number.isFinite() screens out the "nothing scheduled yet / just
        // stopped" case. Redundant ⇔ within one step-duration of "now" on
        // either side.
        const nearWrap =
          Number.isFinite(lastScheduledGateOnTime) &&
          Math.abs(ctx.currentTime - lastScheduledGateOnTime) < stepDurNow;
        if (!nearWrap) {
          // Genuine reset: drop the pending lookahead events so the re-anchored
          // step 0 is the only one that sounds, then restart at step 0.
          clearPendingScheduledEvents();
          stepIndex = 0;
          playhead.reset();
          nextStepTime = ctx.currentTime + 0.05;
        }
      }
      const queued = pickQueuedSlotFromEvents(ev);
      if (queued !== null && live) {
        if (!live.data) live.data = {};
        const d = live.data as Record<string, unknown>;
        d.queuedSlot = queued;
        // An explicit slot queue supersedes a pending NEXT/PREV/RANDOM nav.
        d.queuedNav = null;
      }
      // NEXT / PREV / RANDOM nav gates: latch the direction to apply at the
      // next sequence-end (quantized, NOT immediate). A later explicit slot
      // queue (above) clears it; a later nav overwrites the prior nav.
      const nav = pickNavFromEvents(ev);
      if (nav !== null && live) {
        if (!live.data) live.data = {};
        (live.data as Record<string, unknown>).queuedNav = nav;
      }
      return isPlaying;
    }

    /** Apply the queued slot's snapshot to node.data + node.params, and
     *  reset the step counter. Called on sequence-end when queuedSlot is
     *  set. The snapshot shape is module-specific; for the Sequencer it
     *  carries `steps` + a few params. */
    function maybeApplyQueuedSlot(): boolean {
      const live = livePatch.nodes[nodeId];
      if (!live) return false;
      const data = live.data as Record<string, unknown> | undefined;
      const slots = coerceSlots(data?.slots);
      // An explicit queued slot wins; otherwise resolve a pending NEXT/PREV/
      // RANDOM nav into a concrete OCCUPIED slot. Both are quantized to here
      // (sequence-end). Nav over no/one occupied slot degrades per
      // resolveNavTarget's contract.
      let queued = coerceSlotKey(data?.queuedSlot);
      if (!queued) {
        const navRaw = data?.queuedNav;
        const nav: NavDirection | null =
          navRaw === 'next' || navRaw === 'prev' || navRaw === 'random' ? navRaw : null;
        if (nav) {
          const current = coerceSlotKey(data?.lastLoadedSlot);
          queued = resolveNavTarget(occupiedSlots(slots), current, nav);
          // Consume the nav regardless of whether it resolved (no occupied
          // slots → null → drop it so it doesn't re-fire every loop).
          if (data) data.queuedNav = null;
        }
      }
      if (!queued) return false;
      const snap = slots[queued];
      if (!snap) {
        // Slot is empty — drop the queue.
        if (data) data.queuedSlot = null;
        return false;
      }
      if (!live.data) live.data = {};
      const d = live.data as Record<string, unknown>;
      // Snapshot's `steps` flow into data.steps; module-specific param
      // keys flow into params. Deep-clone steps because the snapshot is
      // still a Y-tree resident at slots[N] and Yjs forbids reassigning
      // the same Y.Map at two paths.
      if (Array.isArray(snap.steps)) {
        d.steps = (snap.steps as Array<Record<string, unknown>>).map((s) => ({ ...s }));
      }
      if (live.params) {
        for (const k of ['bpm', 'length', 'octave', 'gateLength', 'swing'] as const) {
          const v = snap[k];
          if (typeof v === 'number') live.params[k] = v;
        }
      }
      d.lastLoadedSlot = queued;
      d.queuedSlot = null;
      // Reset position so the next emit starts at step 0 of the new pattern.
      stepIndex = 0;
      playhead.reset();
      nextStepTime = ctx.currentTime + 0.005;
      return true;
    }

    function tick() {
      if (!alive) return;
      try {
        // Drain transport CV first; play_cv may have just toggled isPlaying.
        const isPlaying = pollTransportCv();
        const externalClock = isClockInConnected();
        // Orthogonality fix: when clock is patched but play_cv isn't, the
        // clock pulses ARE the play signal — sequencer should advance even
        // if isPlaying is false. play_cv (when patched) still wins.
        const playCvPatched = isPlayCvConnected();
        const shouldRun = shouldSequencerRun(isPlaying, externalClock, playCvPatched);

        if (shouldRun && !prevPlaying) {
          // Transitioned to playing: reset position + cancel any stale future events
          stepIndex = 0;
          playhead.reset();
          nextStepTime = ctx.currentTime + 0.05;
          gateSrc.offset.cancelScheduledValues(ctx.currentTime);
          gateSrc.offset.setValueAtTime(0, ctx.currentTime);
          polyPitch.silence(ctx.currentTime);
          // Fresh play: the first step-0 gate must always sound (#224 dedup
          // must not suppress it).
          lastScheduledGateOnTime = -Infinity;
          // Reset clock-in detector so the first observed pulse counts.
          lastClockSample = 0;
          lastClockSampleTime = ctx.currentTime;
          transportCv.resetEdges();
          lastTransportPollTime = ctx.currentTime;
        } else if (!shouldRun && prevPlaying) {
          // Transitioned to stopped: cancel pending events, force gate low
          gateSrc.offset.cancelScheduledValues(ctx.currentTime);
          gateSrc.offset.setValueAtTime(0, ctx.currentTime);
          polyPitch.silence(ctx.currentTime);
        }
        prevPlaying = shouldRun;

        if (!shouldRun) {
          // No timeoutId self-loop here: HEAD switched the sequencer over to
          // getSchedulerClock().subscribe(tick) (Worker tick, immune to main-
          // thread jank), so simply returning leaves the next invocation to
          // the shared scheduler.
          return;
        }

        if (externalClock) {
          // External-clock mode: advance one step per rising edge observed in
          // the analyser's recent samples. We only inspect samples that arrived
          // SINCE the last tick to avoid double-counting the overlap window.
          clockInAnalyser.getFloatTimeDomainData(clockInBuffer);
          const nowAt = ctx.currentTime;
          const elapsed = nowAt - lastClockSampleTime;
          const newSamples = Math.min(
            clockInBuffer.length,
            Math.max(1, Math.ceil(elapsed * ctx.sampleRate)),
          );
          const start = clockInBuffer.length - newSamples;
          // Estimate inter-step duration from BPM (used only for gate length).
          const bpm = readParam('bpm', 120);
          const length = Math.max(1, Math.round(readParam('length', 16)));
          const stepDurForGate = 60 / Math.max(1, bpm) / 4;
          for (let i = start; i < clockInBuffer.length; i++) {
            const cur = clockInBuffer[i] ?? 0;
            if (lastClockSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD) {
              // Rising edge — schedule the step a hair in the future to give
              // the audio thread a render quantum of headroom.
              emitStep(stepIndex, nowAt + 0.005, stepDurForGate);
              const nextIdx = (stepIndex + 1) % length;
              if (nextIdx === 0) {
                // Wrap: sequence end. Try to apply any queued slot before
                // advancing — the new pattern's step 0 will fire on the
                // next clock pulse.
                totalSequenceEnds++;
                if (maybeApplyQueuedSlot()) {
                  // stepIndex was reset to 0 by the apply; skip the
                  // normal advance.
                  continue;
                }
              }
              stepIndex = nextIdx;
              totalAdvances++;
            }
            lastClockSample = cur;
          }
          lastClockSampleTime = nowAt;
        } else {
          // Internal-BPM mode: classic two-clocks lookahead scheduler.
          while (nextStepTime < ctx.currentTime + LOOKAHEAD_S) {
            const bpm = readParam('bpm', 120);
            // Clamp to [1, STEP_COUNT] so a stale or out-of-range param
            // never makes stepIndex sample past the data array.
            const length = Math.max(1, Math.min(STEP_COUNT, Math.round(readParam('length', 16))));
            const swing = readParam('swing', 0);

            const stepDurBase = 60 / bpm / 4; // 16th-note step
            const isOddStep = stepIndex % 2 === 1;
            const stepDur = isOddStep ? stepDurBase * (1 - swing * 0.5) : stepDurBase * (1 + swing * 0.5);

            // #229: drop, don't pile up. If the main thread stalled longer
            // than the lookahead, nextStepTime is already in the past; emitting
            // it would clamp to "now" and bunch the backlog into an audible
            // double-hit + tempo lurch. Skip the gate (and clock pulse) for
            // past-due steps while still advancing phase/index below, so the
            // sequencer resumes in-tempo from the present.
            if (nextStepTime < ctx.currentTime - LATE_DROP_EPS) {
              lateStepsDropped++;
            } else {
              emitStep(stepIndex, nextStepTime, stepDur);
            }

            const nextIdx = (stepIndex + 1) % length;
            const nextStartTime = nextStepTime + stepDur;
            if (nextIdx === 0) {
              totalSequenceEnds++;
              if (maybeApplyQueuedSlot()) {
                // Snapshot was applied; the next step time we want to
                // schedule is the same boundary, but for the new pattern's
                // step 0. maybeApplyQueuedSlot resets nextStepTime to
                // ctx.currentTime + tiny, so re-anchor it to the natural
                // step boundary instead.
                nextStepTime = nextStartTime;
                continue;
              }
            }
            nextStepTime = nextStartTime;
            stepIndex = nextIdx;
            totalAdvances++;
          }
        }
      } catch (err) {
        console.error('[sequencer] tick error', err);
      }
    }

    // Scheduler lookahead vs sounding-now: stepIndex is the NEXT step the
    // lookahead loop will queue; the tracker derives the playhead from the
    // (idx, atTime) entries pushed inside emitStep so the visual highlight
    // matches what the audio thread is playing right now. Fixes the off-by-one
    // playhead lag.
    const playhead = createPlayheadTracker();
    let totalAdvances = 0; // monotonic — useful for tests asserting "did we step N times"
    // #229 instrumentation (catch-up correctness under main-thread stalls):
    //   lateStepsDropped — steps whose scheduled time fell > LATE_DROP_EPS
    //     behind ctx.currentTime (stall > lookahead) whose gate we dropped to
    //     avoid bunching. Phase still advances, so tempo stays correct.
    //   pastDueEmits — emitStep calls with a past timestamp (the BUG symptom:
    //     Web Audio would clamp+bunch them onto "now"). The drop guard keeps
    //     it at 0. Read by tempo-stability spec as a #224/#229 regression
    //     canary (gate-agnostic, so it trips even on all-off default steps).
    let lateStepsDropped = 0;
    let pastDueEmits = 0;
    // Subscribe to the shared scheduler-clock — a Worker tick that's
    // immune to main-thread blocking. Replaces the legacy
    // `setTimeout(tick, TICK_MS)` self-loop, which would queue up behind
    // drag/render jank and starve the audio thread's lookahead window.
    unsubscribeTick = getSchedulerClock().subscribe(tick);

    const inputsMap = new Map<string, { node: AudioNode; input: number }>([
      ['clock', { node: clockInGain, input: 0 }],
    ]);
    for (const [id, entry] of transportCv.inputs) {
      inputsMap.set(id, entry);
    }

    return {
      domain: 'audio',
      inputs: inputsMap,
      outputs: new Map([
        // Pitch is now a 10-channel polyPitchGate. Backward-compat with mono
        // pitch sinks is handled in engine.addEdge via resolveConnection().
        ['pitch', { node: polyPitch.output, output: 0 }],
        ['gate', { node: gateSrc, output: 0 }],
        ['clock', { node: clockOutSrc, output: 0 }],
      ]),
      setParam(_paramId, _value) {
        // No AudioParam to write — the tick reads node.params each iteration.
        // Keeps the sequencer reactive to fader changes in real time.
      },
      readParam(paramId) {
        const live = livePatch.nodes[nodeId];
        const v = live?.params?.[paramId];
        return typeof v === 'number' ? v : undefined;
      },
      read(key) {
        if (key === 'currentStep') return playhead.currentAt(ctx.currentTime);
        if (key === 'totalAdvances') return totalAdvances;
        if (key === 'totalSequenceEnds') return totalSequenceEnds;
        if (key === 'lateStepsDropped') return lateStepsDropped;
        if (key === 'pastDueEmits') return pastDueEmits;
        // V/oct currently emitted on the pitch port (lane 0) — kept for
        // backward compat with existing tests / UI that didn't know about
        // polyphony.
        if (key === 'pitchVOct')  return lastEmittedVOct;
        if (key === 'gateValue')  return lastEmittedGate;
        // Per-lane reads for poly tests.
        if (typeof key === 'string' && key.startsWith('pitchVOctLane:')) {
          const i = Number.parseInt(key.slice('pitchVOctLane:'.length), 10);
          return Number.isFinite(i) && i >= 0 && i < POLY_CHANNEL_PAIRS
            ? lastEmittedLaneVOct[i]
            : undefined;
        }
        if (typeof key === 'string' && key.startsWith('gateLane:')) {
          const i = Number.parseInt(key.slice('gateLane:'.length), 10);
          return Number.isFinite(i) && i >= 0 && i < POLY_CHANNEL_PAIRS
            ? lastEmittedLaneGate[i]
            : undefined;
        }
        return undefined;
      },
      dispose() {
        alive = false;
        if (unsubscribeTick) { unsubscribeTick(); unsubscribeTick = null; }
        try { gateSrc.stop(); } catch { /* already stopped */ }
        try { clockOutSrc.stop(); } catch { /* already stopped */ }
        try { clockInSilence.stop(); } catch { /* already stopped */ }
        polyPitch.dispose();
        gateSrc.disconnect();
        clockOutSrc.disconnect();
        clockInSilence.disconnect();
        clockInGain.disconnect();
        clockInAnalyser.disconnect();
        transportCv.dispose();
      },
    };
  },
};
