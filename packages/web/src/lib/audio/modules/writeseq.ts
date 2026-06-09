// packages/web/src/lib/audio/modules/writeseq.ts
//
// WRITESEQ — a RECORDING step-sequencer. It is the app's usual step
// sequencer PLUS live recording from a CV/gate source (e.g. MIDICVBUDDY /
// a mini-keyboard via MIDI→CV). No DSP / no AudioWorklet — a plain-JS
// clock + CV module riding the shared scheduler-clock (the macseq.ts base)
// with the record semantics lifted from numpad-plus.ts.
//
// schemaVersion: 1 — brand new module, no migration.
//
// ────────── IO ──────────
//
// Inputs (declaration order — load-bearing for the gate-edge handling +
// the per-port sweep):
//   cv    (pitch): pitch CV in. 0V = C4 = MIDI 60. Sampled on each gate
//                  rising edge while recording, AND passed through live to
//                  the pitch out whenever a live gate is held.
//   gate  (gate):  gate in. Each rising edge while recording writes the
//                  sampled pitch+gate to the nearest step (snap-to-nearest
//                  quantization). A rising edge while STOPPED + armed starts
//                  the sequencer + record (internal clock, or external clock
//                  that is currently pulsing).
//   clock (gate):  external step clock (e.g. from TIMELORDE). When patched,
//                  the step clock = the external pulses (one step per rising
//                  edge); when unpatched, WRITESEQ runs its own internal BPM.
//   rec   (gate):  record start/stop gate. A rising edge TOGGLES recArm.
//   ...TRANSPORT_CV_PORT_DEFS (play_cv / reset_cv / queue1..4_cv) — the
//                  shared transport-CV inputs (base spread, NOT the extended
//                  nav set). Kept literal-inline so the module-manifest regex
//                  inlines the spread.
//
// Outputs:
//   pitch (pitch): sequenced V/oct out. Live pass-through WINS while a live
//                  gate is held.
//   gate  (gate):  sequenced gate out. Live pass-through WINS while held.
//   clock (gate):  10 ms pulse per advance (chain to other sequencers).
//
// ────────── PASS-THROUGH (always on) ──────────
//
// The cv/gate inputs are each a GainNode→AnalyserNode tap (+ a silent
// ConstantSource to keep the graph alive). Per tick we sample the latest
// gate (last sample ≥ 0.5 ⇒ held) and the latest cv. A held live gate
// drives pitch.offset = liveCv + gate.offset = 1 (pass-through wins over
// the sequenced step). Pass-through is independent of record/transport, so
// the module works as a pure live monitor even when stopped + record off.
//
// ────────── TRANSPORT (two orthogonal axes) ──────────
//
// (A) STEP-CLOCK SELECTION per tick:
//   external patched  → step clock = external pulses; advance EXACTLY one
//                       step per rising edge in the clock-in analyser ring,
//                       scanning ONLY samples since last poll (verbatim
//                       sequencer.ts / macseq.ts external scan). NO internal
//                       pulses are generated in this mode. fftSize=16384
//                       (the #229 widening) so a fast clock isn't aliased.
//   external unpatched → own internal step clock: two-clocks lookahead
//                       scheduler (LOOKAHEAD_S = 0.2), stepDur = 60/bpm/4.
//
// (B) RUN/RECORD LATCH INDEPENDENT OF TIMELORDE:
//   WRITESEQ never reads TIMELORDE's `running` flag and never auto-starts /
//   stops with it. It is armed/started ONLY by the user (RECORD button, rec
//   gate, gate-when-armed, PLAY, play_cv). The only coupling to an external
//   clock is emergent: a stopped TIMELORDE emits no pulses, so via axis (A)
//   no steps advance — not a state read. Playback-run uses the shared
//   shouldSequencerRun() (clock-only branch lets a patched clock with no
//   play_cv play); the record latch is layered on top as its OWN latch.
//
// ────────── RECORD MODEL ──────────
//
//   - RECORD START → jump to step 1 IMMEDIATELY (stepIndex=0). NOT overdub:
//     clear the sequence + set a one-shot window of `length` steps. Overdub:
//     no clear, recording loops across boundaries layering new events.
//   - ONE-SHOT-to-128: when not overdubbing, record forward; each advance
//     decrements the one-shot counter; at 0 (recorded `length` steps, capped
//     at 128 = STEP_COUNT) STOP recording (auto-clear recArm) and return to
//     step 1 to PLAY through. `length` IS the loop window.
//   - GATE-START-WHEN-ARMED: stopped + recArm/overdub + an incoming gate
//     rising edge starts the seq + record from step 1 ON INTERNAL CLOCK
//     (pulses always available). On EXTERNAL clock it only starts if a clock
//     pulse was seen recently (a stopped external clock yields no pulse ⇒ no
//     start; the gate still passes through).
//
// ────────── NO-OFF-BY-ONE (the DRUMMERGIRL alignment guarantee) ──────────
//
//   WRITESEQ rides the SAME getSchedulerClock tick + runs the IDENTICAL
//   external-clock scan over the SAME shared clock buffer as the drum DRIVER
//   (DRUMSEQZ / Sequencer), so a pulse that advances the driver to step 0
//   advances WRITESEQ to step 0 on the same tick. Tick ordering forces
//   record-start jump-to-step-1 + the pulse advance to resolve BEFORE the
//   incoming gate is quantized (a→b→c below), and the midpoint rounding is
//   anchored to the same stepStartCtxTime the pulse set — so a key in time
//   with the beat records onto the SAME step the drum hits, no off-by-one in
//   either direction.
//
// ────────── FUTURE (do NOT build now — leave room) ──────────
//
//   WriteseqStep carries an optional `shift?: number` in [-0.5, +0.5]
//   (fraction-of-step) for per-step micro-shift / swing-to-1/4-step. The
//   field is PRESENT (coerceStep preserves a finite shift, else undefined)
//   but NOT consumed by the engine in v1.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { C4_MIDI, midiToVOct, vOctToMidi } from '$lib/audio/note-entry';
import { getSchedulerClock, SCHEDULER_TICK_MS } from '$lib/audio/scheduler-clock';
import { createPlayheadTracker } from './playhead-tracker';
import {
  createTransportCv,
  pickQueuedSlotFromEvents,
  TRANSPORT_CV_PORT_DEFS,
} from './transport-cv';
import {
  coerceSlots,
  coerceSlotKey,
  isInputPortConnected,
  shouldSequencerRun,
} from './transport-helpers';

// Pre-pages the grid was 16 (a single page). The card renders PAGE_SIZE
// cells per page and offers up to 8 pages via the shared SequencerPageNav.
export const STEP_COUNT = 128;
/** Cells rendered per page (one screen row). */
export const PAGE_SIZE = 16;

export interface WriteseqStep {
  on: boolean;
  /** MIDI note for this step's pitch. null = use C4 fallback. */
  midi: number | null;
  /** FUTURE-ROOM (spec point 6): per-step micro-shift / swing as a fraction
   *  of one step in [-0.5, +0.5]. Field is present + persisted but NOT yet
   *  consumed by the engine. coerceStep preserves a finite value, else
   *  leaves it undefined. */
  shift?: number;
}

export interface WriteseqData {
  steps: WriteseqStep[]; // length STEP_COUNT
}

export function defaultStep(): WriteseqStep {
  return { on: false, midi: C4_MIDI };
}

export function defaultSteps(): WriteseqStep[] {
  return Array.from({ length: STEP_COUNT }, defaultStep);
}

/** Coerce arbitrary step-shape input into a canonical WriteseqStep. Used by
 *  the live reader so half-typed Yjs writes don't crash the tick. Mirrors
 *  macseq.ts coerceStep, plus the FUTURE-ROOM `shift` preservation. */
export function coerceStep(raw: unknown): WriteseqStep {
  if (!raw || typeof raw !== 'object') return defaultStep();
  const r = raw as Record<string, unknown>;
  const on = !!r.on;
  // midi (default to C4 when the field is absent; explicit null stays null).
  let midi: number | null = null;
  if ('midi' in r) {
    const m = r.midi;
    if (m === null || m === undefined) midi = null;
    else if (typeof m === 'number' && Number.isFinite(m)) {
      const rounded = Math.round(m);
      if (rounded >= 0 && rounded <= 127) midi = rounded;
    }
  } else {
    midi = C4_MIDI;
  }
  const step: WriteseqStep = { on, midi };
  // FUTURE-ROOM: preserve a finite shift only; never coerce a bogus value
  // into a number (that would silently mask data bugs). Clamp to [-0.5,+0.5]
  // (the spec's documented swing-to-1/4-step range) so a stale persisted
  // value can't push a step out of band when the engine eventually reads it.
  if ('shift' in r) {
    const s = r.shift;
    if (typeof s === 'number' && Number.isFinite(s)) {
      step.shift = Math.max(-0.5, Math.min(0.5, s));
    }
  }
  return step;
}

export function coerceSteps(raw: unknown): WriteseqStep[] {
  if (!Array.isArray(raw)) return defaultSteps();
  const out: WriteseqStep[] = [];
  for (let i = 0; i < STEP_COUNT; i++) {
    out.push(coerceStep(raw[i]));
  }
  return out;
}

/** Resolve the V/oct CV to emit for a step. midi=null falls back to C4
 *  (0V). Adds the global octave. */
export function resolveStepVOct(step: WriteseqStep, globalOctave: number): number {
  const midi = step.midi ?? C4_MIDI;
  return midiToVOct(midi) + globalOctave;
}

/**
 * Pure snap-to-nearest quantizer (lifted verbatim from numpad-plus.ts:122,
 * changing the wrap from %16 to %length). Given a key-press timestamp + the
 * clock's step grid, return the step index the press should record to:
 *   midpoint = currentStepStartSec + stepDurationSec / 2
 *   pressTime < midpoint  → currentStepIndex
 *   else                  → (currentStepIndex + 1) % length
 *   stepDur <= 0          → currentStepIndex
 * length is clamped to [1, STEP_COUNT].
 */
export function quantizeToNearestStep(
  pressTimeSec: number,
  currentStepIndex: number,
  currentStepStartSec: number,
  stepDurationSec: number,
  length: number,
): number {
  const len = Math.max(1, Math.min(STEP_COUNT, Math.round(length)));
  if (stepDurationSec <= 0) return currentStepIndex % len;
  const midpoint = currentStepStartSec + stepDurationSec / 2;
  if (pressTimeSec < midpoint) return currentStepIndex % len;
  return (currentStepIndex + 1) % len;
}

// Inputs/outputs/params are inlined as object literals (rather than built via
// helpers) so the docs manifest's regex parser at packages/web/src/lib/docs/
// module-manifest.ts can pick them up — it bails if `inputs:` / `outputs:` /
// `params:` aren't a literal `[`. The TRANSPORT_CV_PORT_DEFS spread is
// inlined by the manifest's parsePortList; keep it a single spread.
export const writeseqDef: AudioModuleDef = {
  type: 'writeseq',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'writeseq',
  category: 'modulation',
  schemaVersion: 1,

  inputs: [
    // Pitch CV in (sampled on gate edges while recording; passed through
    // live). 0V = C4 = MIDI 60.
    { id: 'cv',    type: 'pitch' },
    // Gate in (writes nearest step while recording; starts seq+record when
    // stopped+armed; passes through live).
    { id: 'gate',  type: 'gate' },
    // External step clock (rising edges advance one step). Unpatched =
    // internal BPM.
    { id: 'clock', type: 'gate' },
    // Record start/stop gate — rising edge TOGGLES recArm.
    { id: 'rec',   type: 'gate' },
    // Shared transport CV (play_cv / reset_cv / queue1..4_cv) — base spread.
    ...TRANSPORT_CV_PORT_DEFS,
  ],
  outputs: [
    { id: 'pitch', type: 'pitch' },
    { id: 'gate',  type: 'gate' },
    { id: 'clock', type: 'gate' },
  ],
  params: [
    { id: 'bpm',        label: 'BPM',  defaultValue: 120, min: 30,  max: 300,  curve: 'linear' },
    { id: 'length',     label: 'Len',  defaultValue: 16,  min: 1,   max: 128,  curve: 'discrete' },
    { id: 'octave',     label: 'Oct',  defaultValue: 0,   min: -2,  max: 2,    curve: 'discrete' },
    { id: 'gateLength', label: 'Gate', defaultValue: 0.5, min: 0.1, max: 0.95, curve: 'linear' },
    { id: 'isPlaying',  label: 'Play', defaultValue: 0,   min: 0,   max: 1,    curve: 'discrete' },
    { id: 'recArm',     label: 'Rec',  defaultValue: 0,   min: 0,   max: 1,    curve: 'discrete' },
    { id: 'overdub',    label: 'Ovd',  defaultValue: 0,   min: 0,   max: 1,    curve: 'discrete' },
  ],

  // Module-grouping Phase 4 — surface PLAY/STOP as a single button a
  // containing GROUP! can opt to expose on its bar.
  exposableControls: [
    { id: 'playStop', label: 'Play', kind: 'button', paramId: 'isPlaying' },
  ],
  // Instruments v1 — the full step grid is atomically exposable.
  exposesSequence: true,

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const nodeId = node.id;
    const CLOCK_THRESHOLD = 0.5;

    // ─── Output ConstantSources ──────────────────────────────────────
    const pitchSrc = ctx.createConstantSource();
    const gateSrc = ctx.createConstantSource();
    const clockOutSrc = ctx.createConstantSource();
    pitchSrc.offset.value = 0;
    gateSrc.offset.value = 0;
    clockOutSrc.offset.value = 0;
    pitchSrc.start();
    gateSrc.start();
    clockOutSrc.start();

    // ─── External clock-in tap (rising-edge detector) ────────────────
    // fftSize 16384 = the #229 widening so a fast external clock isn't
    // aliased between ticks (matches the base Sequencer's clock-in).
    const clockInGain = ctx.createGain();
    const clockInAnalyser = ctx.createAnalyser();
    clockInAnalyser.fftSize = 16384;
    clockInGain.connect(clockInAnalyser);
    const clockInBuffer: Float32Array<ArrayBuffer> = new Float32Array(clockInAnalyser.fftSize);
    const clockInSilence = ctx.createConstantSource();
    clockInSilence.offset.value = 0;
    clockInSilence.start();
    clockInSilence.connect(clockInGain);
    let lastClockSample = 0;
    let lastClockSampleTime = ctx.currentTime;
    // Track the ctx time of the most recent observed clock rising edge so a
    // gate-start can ask "did a clock pulse arrive recently?" (external mode).
    let lastClockEdgeTime = -Infinity;

    // ─── cv / gate / rec pass-through taps ───────────────────────────
    function makeTap(): {
      gain: GainNode;
      analyser: AnalyserNode;
      // Tightly-typed Float32Array<ArrayBuffer> so getFloatTimeDomainData accepts
      // it under the recent TS lib defs (Float32Array became generic over
      // ArrayBuffer | SharedArrayBuffer; the WebAudio API only takes the
      // ArrayBuffer arm). Same pattern as transport-cv.ts.
      buf: Float32Array<ArrayBuffer>;
      silence: ConstantSourceNode;
    } {
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      gain.connect(analyser);
      const silence = ctx.createConstantSource();
      silence.offset.value = 0;
      silence.start();
      silence.connect(gain);
      return { gain, analyser, buf: new Float32Array(analyser.fftSize), silence };
    }
    const cvTap = makeTap();
    const gateTap = makeTap();
    const recTap = makeTap();

    // ─── Shared transport CV (play_cv / reset_cv / queue1..4_cv) ─────
    const transportCv = createTransportCv(ctx);
    let lastTransportPollTime = ctx.currentTime;
    // Rec-gate rising-edge detector (separate from the transport set).
    let lastRecSample = 0;
    let lastRecPollTime = ctx.currentTime;
    // Gate-in rising-edge detector for the record-write + gate-start path.
    let lastGateEdgeSample = 0;
    let lastGatePollTime = ctx.currentTime;

    function readParam(id: string, fallback: number): number {
      const live = livePatch.nodes[nodeId];
      const v = live?.params?.[id];
      return typeof v === 'number' ? v : fallback;
    }
    function readSteps(): WriteseqStep[] {
      const live = livePatch.nodes[nodeId];
      const raw = (live?.data as Record<string, unknown> | undefined)?.steps;
      return coerceSteps(raw);
    }
    function effectiveLength(): number {
      return Math.max(1, Math.min(STEP_COUNT, Math.round(readParam('length', 16))));
    }
    function isClockInConnected(): boolean {
      return isInputPortConnected(Object.values(livePatch.edges), nodeId, 'clock');
    }
    function isPlayCvConnected(): boolean {
      return isInputPortConnected(Object.values(livePatch.edges), nodeId, 'play_cv');
    }

    /** Write a recorded note onto a step, then deep-clone the array back so
     *  Yjs doesn't throw "already integrated". Overdub merges; one-shot
     *  overwrites — both just set the target step on. (numpad-plus.ts:281.) */
    function writeStep(stepIdx: number, midi: number): void {
      const live = livePatch.nodes[nodeId];
      if (!live) return;
      if (!live.data) live.data = {};
      const data = live.data as Record<string, unknown>;
      const steps = coerceSteps(data.steps);
      if (stepIdx < 0 || stepIdx >= steps.length) return;
      const prev = steps[stepIdx]!;
      steps[stepIdx] = prev.shift !== undefined
        ? { on: true, midi, shift: prev.shift }
        : { on: true, midi };
      data.steps = steps.map((s) => ({ ...s }));
    }
    function clearSequence(): void {
      const live = livePatch.nodes[nodeId];
      if (!live) return;
      if (!live.data) live.data = {};
      (live.data as Record<string, unknown>).steps = defaultSteps().map((s) => ({ ...s }));
    }

    function emitClockPulse(atTime: number): void {
      clockOutSrc.offset.setValueAtTime(1, atTime);
      clockOutSrc.offset.setValueAtTime(0, atTime + 0.01);
    }

    // ─── Engine state (factory-closure-local, NEVER persisted) ───────
    let stepIndex = 0;
    let stepStartCtxTime = ctx.currentTime;
    let nextStepTime = ctx.currentTime + 0.05;
    let prevRunning = false;
    let recordingActive = false;
    let oneShotStepsRemaining = 0;
    let lastEmittedVOct = 0;
    let lastEmittedGate = 0;
    let lastRecordedStep = -1;
    let totalAdvances = 0;
    let totalSequenceEnds = 0;
    // Recording anchor: the (idx, atTime) of the step the gate-press should
    // quantize against — i.e. the step the audio thread is SOUNDING / the drum
    // DRIVER hits on the shared pulse — NOT the post-advance `stepIndex` (which
    // already points at the NEXT step) and NOT a future lookahead-scheduled
    // step. This is the structural anchor for the no-off-by-one guarantee.
    //
    // EXTERNAL clock: at most one emit per tick (per pulse), and the just-
    //   emitted step IS the current beat. So `pulseAnchorThisTick` captures it
    //   and the quantizer prefers it: a key in time with that pulse rounds to
    //   the SAME step S the driver hit (gateTime ≈ atTime ≪ midpoint → S).
    // INTERNAL clock: the lookahead schedules FUTURE steps, so the just-emitted
    //   step can be up to LOOKAHEAD_S ahead. The currently-sounding step is the
    //   latest STARTED anchor (atTime <= now). `startedAnchors` (a bounded ring)
    //   tracks those and `soundingAnchor` returns it.
    // Both reset to (0, now) on run-start / record-start / reset / quicksave so
    // a gate before the first pulse records to step 0.
    const RECORD_ANCHOR_MAX = 64;
    let startedAnchors: { idx: number; atTime: number }[] = [{ idx: 0, atTime: ctx.currentTime }];
    let pulseAnchorThisTick: { idx: number; atTime: number } | null = null;
    function pushRecordAnchor(idx: number, atTime: number): void {
      startedAnchors.push({ idx, atTime });
      if (startedAnchors.length > RECORD_ANCHOR_MAX) {
        startedAnchors = startedAnchors.slice(startedAnchors.length - RECORD_ANCHOR_MAX);
      }
    }
    function resetRecordAnchors(idx: number, atTime: number): void {
      startedAnchors = [{ idx, atTime }];
      // NOTE: pulseAnchorThisTick is a per-tick value (cleared at tick top), so
      // we DON'T clear it here — a record-begin that runs AFTER the pulse on the
      // same tick must keep the pulse's step as the quantize anchor.
    }
    /** The step sounding at `now` for INTERNAL clock = the latest STARTED anchor
     *  (atTime <= now). Falls back to the seed / earliest anchor. */
    function soundingAnchor(now: number): { idx: number; atTime: number } {
      let best: { idx: number; atTime: number } | null = null;
      for (const a of startedAnchors) {
        if (a.atTime <= now + 1e-9) best = a;
      }
      return best ?? startedAnchors[0] ?? { idx: 0, atTime: now };
    }
    let alive = true;
    let unsubscribeTick: (() => void) | null = null;
    const LOOKAHEAD_S = 0.2;
    void SCHEDULER_TICK_MS; // referenced by the shared scheduler-clock

    const playhead = createPlayheadTracker();

    /** Sample the latest value in an analyser tap (the most recent sample). */
    function latestSample(tap: { analyser: AnalyserNode; buf: Float32Array<ArrayBuffer> }): number {
      tap.analyser.getFloatTimeDomainData(tap.buf);
      return tap.buf[tap.buf.length - 1] ?? 0;
    }

    /** Generic rising-edge count for a tap over the samples since the last
     *  poll. Updates `last` via the returned next-last. */
    function countEdges(
      tap: { analyser: AnalyserNode; buf: Float32Array<ArrayBuffer> },
      last: number,
      elapsed: number,
    ): { edges: number; last: number } {
      tap.analyser.getFloatTimeDomainData(tap.buf);
      const buf = tap.buf;
      const newSamples = Math.min(buf.length, Math.max(1, Math.ceil(elapsed * ctx.sampleRate)));
      const start = buf.length - newSamples;
      let edges = 0;
      let prev = last;
      for (let i = start; i < buf.length; i++) {
        const cur = buf[i] ?? 0;
        if (prev < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD) edges++;
        prev = cur;
      }
      return { edges, last: prev };
    }

    /** Drain the rec-gate input → return # rising edges since last poll. */
    function pollRecEdges(): number {
      const nowAt = ctx.currentTime;
      const elapsed = nowAt - lastRecPollTime;
      lastRecPollTime = nowAt;
      const { edges, last } = countEdges(recTap, lastRecSample, elapsed);
      lastRecSample = last;
      return edges;
    }

    /** Drain the gate input → return # rising edges since last poll. We treat
     *  all edges in a tick as landing at nowAt for quantization (one tick is
     *  ≤ 25 ms ≪ a step), matching numpad-plus' press-time = ctx.currentTime. */
    function pollGateEdges(): number {
      const nowAt = ctx.currentTime;
      const elapsed = nowAt - lastGatePollTime;
      lastGatePollTime = nowAt;
      const { edges, last } = countEdges(gateTap, lastGateEdgeSample, elapsed);
      lastGateEdgeSample = last;
      return edges;
    }

    /** Drain the transport CV inputs (play_cv toggles isPlaying; reset → step
     *  0; queue → queuedSlot). Returns isPlaying AFTER any play_cv toggle. */
    function pollTransportCv(): boolean {
      const nowAt = ctx.currentTime;
      const elapsed = nowAt - lastTransportPollTime;
      lastTransportPollTime = nowAt;
      const ev = transportCv.drain(elapsed);
      const live = livePatch.nodes[nodeId];
      let isPlaying = readParam('isPlaying', 0) >= 0.5;
      if (ev.play % 2 === 1) {
        isPlaying = !isPlaying;
        if (live?.params) live.params.isPlaying = isPlaying ? 1 : 0;
      }
      if (ev.reset > 0) {
        stepIndex = 0;
        stepStartCtxTime = ctx.currentTime;
        playhead.reset();
        resetRecordAnchors(0, ctx.currentTime);
        nextStepTime = ctx.currentTime + 0.05;
        gateSrc.offset.cancelScheduledValues(ctx.currentTime);
        gateSrc.offset.setValueAtTime(0, ctx.currentTime);
      }
      const queued = pickQueuedSlotFromEvents(ev);
      if (queued !== null && live) {
        if (!live.data) live.data = {};
        (live.data as Record<string, unknown>).queuedSlot = queued;
      }
      return isPlaying;
    }

    /** Apply a queued quicksave slot's snapshot on sequence-end. WRITESEQ's
     *  snapshot carries `steps` + bpm/length/octave/gateLength. */
    function maybeApplyQueuedSlot(): boolean {
      const live = livePatch.nodes[nodeId];
      if (!live) return false;
      const data = live.data as Record<string, unknown> | undefined;
      const queued = coerceSlotKey(data?.queuedSlot);
      if (!queued) return false;
      const slots = coerceSlots(data?.slots);
      const snap = slots[queued];
      if (!snap) {
        if (data) data.queuedSlot = null;
        return false;
      }
      if (!live.data) live.data = {};
      const d = live.data as Record<string, unknown>;
      if (Array.isArray(snap.steps)) {
        d.steps = (snap.steps as Array<Record<string, unknown>>).map((s) => ({ ...s }));
      }
      if (live.params) {
        for (const k of ['bpm', 'length', 'octave', 'gateLength'] as const) {
          const v = snap[k];
          if (typeof v === 'number') live.params[k] = v; // guard:allow-raw-write — sequencer slot-restore during the playback tick, not a user edit
        }
      }
      d.lastLoadedSlot = queued;
      d.queuedSlot = null;
      stepIndex = 0;
      stepStartCtxTime = ctx.currentTime;
      playhead.reset();
      resetRecordAnchors(0, ctx.currentTime);
      nextStepTime = ctx.currentTime + 0.005;
      return true;
    }

    /** Begin a recording pass. Jump to step 1 immediately. NOT overdub →
     *  clear the sequence + arm the one-shot window. (T4 / T5 in the design.) */
    function startRecording(overdub: boolean): void {
      recordingActive = true;
      stepIndex = 0;
      stepStartCtxTime = ctx.currentTime;
      // Jump-to-step-1: a gate arriving before the first pulse lands records to
      // step 0 (the anchor we seed here).
      resetRecordAnchors(0, ctx.currentTime);
      if (!overdub) {
        clearSequence();
        oneShotStepsRemaining = effectiveLength();
      } else {
        oneShotStepsRemaining = 0; // unused while overdubbing
      }
    }

    function stopRecording(autoClearArm: boolean): void {
      recordingActive = false;
      if (autoClearArm) {
        const live = livePatch.nodes[nodeId];
        if (live?.params) live.params.recArm = 0;
      }
    }

    /** Emit the sequenced step at `idx` at `atTime`. Drives the clock pulse +
     *  playhead. ON steps schedule pitch + gate; OFF steps hold pitch + drop
     *  the gate-bookkeeping flag. (Pass-through can later override per tick.) */
    function emitStep(idx: number, atTime: number, stepDurForGate: number): void {
      const octave = readParam('octave', 0);
      const gateLengthFrac = readParam('gateLength', 0.5);
      const steps = readSteps();
      const step = steps[idx] ?? defaultStep();
      emitClockPulse(atTime);
      playhead.schedule(idx, atTime);
      // Anchor the quantizer to the step + start time of THIS emit. atTime is
      // the audio-thread schedule instant; it doubles as the step's nominal
      // start so the midpoint math is symmetric around the same instant the
      // driver schedules its hit.
      pushRecordAnchor(idx, atTime);
      if (!step.on) {
        lastEmittedGate = 0;
        return;
      }
      const vOct = resolveStepVOct(step, octave);
      pitchSrc.offset.setValueAtTime(vOct, atTime);
      gateSrc.offset.setValueAtTime(1, atTime);
      gateSrc.offset.setValueAtTime(0, atTime + stepDurForGate * gateLengthFrac);
      lastEmittedVOct = vOct;
      lastEmittedGate = 1;
    }

    /** Advance the step counter by one, applying the one-shot record window +
     *  sequence-end quicksave. Used by BOTH clock sources right after emit. */
    function advanceAfterEmit(): void {
      const length = effectiveLength();
      // One-shot record window: count down per advance; at 0 stop + auto-clear
      // recArm + return to step 1 to play through. (T5.)
      if (recordingActive && readParam('overdub', 0) < 0.5) {
        oneShotStepsRemaining -= 1;
        if (oneShotStepsRemaining <= 0) {
          stopRecording(true);
          stepIndex = 0;
          stepStartCtxTime = ctx.currentTime;
          playhead.reset();
          resetRecordAnchors(0, ctx.currentTime);
          nextStepTime = ctx.currentTime + 0.005;
          totalSequenceEnds++;
          return;
        }
      }
      const nextIdx = (stepIndex + 1) % length;
      if (nextIdx === 0) {
        totalSequenceEnds++;
        if (maybeApplyQueuedSlot()) return; // stepIndex reset; skip advance
      }
      stepIndex = nextIdx;
      totalAdvances++;
    }

    /** Process the step clock: advance + emit. Returns whether ≥1 rising edge
     *  fired this tick (external mode) / a step was emitted (internal mode) —
     *  the caller uses it as the "clock is active" signal that gates record. */
    function processClock(externalClock: boolean, nowAt: number): boolean {
      let fired = false;
      if (externalClock) {
        clockInAnalyser.getFloatTimeDomainData(clockInBuffer);
        const elapsed = nowAt - lastClockSampleTime;
        const newSamples = Math.min(
          clockInBuffer.length,
          Math.max(1, Math.ceil(elapsed * ctx.sampleRate)),
        );
        const start = clockInBuffer.length - newSamples;
        const bpm = readParam('bpm', 120);
        const stepDurForGate = 60 / Math.max(1, bpm) / 4;
        for (let i = start; i < clockInBuffer.length; i++) {
          const cur = clockInBuffer[i] ?? 0;
          if (lastClockSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD) {
            lastClockEdgeTime = nowAt;
            fired = true;
            // Capture the EMITTED step as this tick's pulse anchor BEFORE the
            // advance bumps stepIndex — the quantizer rounds against it.
            pulseAnchorThisTick = { idx: stepIndex, atTime: nowAt + 0.005 };
            emitStep(stepIndex, nowAt + 0.005, stepDurForGate);
            stepStartCtxTime = nowAt;
            advanceAfterEmit();
          }
          lastClockSample = cur;
        }
        lastClockSampleTime = nowAt;
      } else {
        while (nextStepTime < ctx.currentTime + LOOKAHEAD_S) {
          const bpm = readParam('bpm', 120);
          const stepDur = 60 / bpm / 4; // 16th-note grid
          emitStep(stepIndex, nextStepTime, stepDur);
          stepStartCtxTime = nextStepTime;
          advanceAfterEmit();
          nextStepTime = nextStepTime + stepDur;
          fired = true;
        }
      }
      return fired;
    }

    function tick(): void {
      if (!alive) return;
      try {
        const nowAt = ctx.currentTime;
        pulseAnchorThisTick = null;

        // ── T1: rec-gate / RECORD button arm-disarm. Each rec rising edge
        //    toggles recArm (the button writes the param directly). ──
        const recEdges = pollRecEdges();
        const live = livePatch.nodes[nodeId];
        if (recEdges % 2 === 1) {
          const cur = readParam('recArm', 0) >= 0.5;
          if (live?.params) live.params.recArm = cur ? 0 : 1;
        }

        // ── Transport CV (play_cv / reset_cv / queue) ──
        const isPlaying = pollTransportCv();
        const externalClock = isClockInConnected();
        const playCvPatched = isPlayCvConnected();
        // Playback-run decision (shared predicate). The record latch is layered
        // on top — record-arm is its OWN latch, NOT shouldSequencerRun's branch.
        let running = shouldSequencerRun(isPlaying, externalClock, playCvPatched);
        const recArm = readParam('recArm', 0) >= 0.5;
        const overdub = readParam('overdub', 0) >= 0.5;

        // ── (a) Drain the gate-in edges ONCE this tick. We need the count
        //    BEFORE the clock advance for gate-start, and the SAME edges feed
        //    the quantize-record (c). ──
        const gateEdges = pollGateEdges();
        const liveGateHeld = latestSample(gateTap) >= CLOCK_THRESHOLD;
        const liveCv = latestSample(cvTap);

        // CLOCK-ACTIVE (recent): was a step-clock pulse seen within the last
        // tick? Internal clock always has pulses; a STOPPED external clock has
        // none. `lastClockEdgeTime` reflects the PREVIOUS tick's pulse here
        // (it's updated inside processClock below). Used by the gate-start
        // decision — a stopped external clock yields no recent pulse → no start.
        const clockSeenRecently = nowAt - lastClockEdgeTime <= 0.05;

        // ── T3: GATE-START-WHEN-ARMED (the STOPPED case). Not running + armed +
        //    an incoming gate rising edge → start the sequencer. Internal clock:
        //    always (pulses always available). External clock: only if a pulse
        //    was seen recently (a stopped external clock → no start; the gate
        //    still passes through). When already running-by-clock there's
        //    nothing to start (playback is the clock-only branch). ──
        if (!running && gateEdges > 0 && (recArm || overdub) && (!externalClock || clockSeenRecently)) {
          running = true;
          if (live?.params) live.params.isPlaying = 1;
        }

        // ── T2 / T6: run start / stop transitions (playback). ──
        if (running && !prevRunning) {
          stepIndex = 0;
          stepStartCtxTime = ctx.currentTime;
          playhead.reset();
          resetRecordAnchors(0, ctx.currentTime);
          nextStepTime = ctx.currentTime + 0.05;
          gateSrc.offset.cancelScheduledValues(ctx.currentTime);
          gateSrc.offset.setValueAtTime(0, ctx.currentTime);
          lastClockSample = 0;
          lastClockSampleTime = ctx.currentTime;
          transportCv.resetEdges();
          lastTransportPollTime = ctx.currentTime;
        } else if (!running && prevRunning) {
          gateSrc.offset.cancelScheduledValues(ctx.currentTime);
          gateSrc.offset.setValueAtTime(0, ctx.currentTime);
          recordingActive = false; // recArm left as user set (persists)
        }
        prevRunning = running;

        // ── (b) Process the step clock (advance + emit). Returns whether a
        //    pulse / step fired THIS tick. ──
        const clockFiredThisTick = running ? processClock(externalClock, nowAt) : false;

        // CLOCK-ACTIVE (now): pulses exist this tick OR were seen recently.
        const clockActive = !externalClock || clockFiredThisTick || clockSeenRecently;

        // ── RECORD-BEGIN latch (T4/T5). A record pass begins when armed/overdub
        //    + running + the step clock is actually active + not already
        //    recording. Layered ON TOP of shouldSequencerRun: a STOPPED external
        //    clock makes `running` true (clock-only branch) but clockActive
        //    false, so NO record pass starts there (the design's "external-
        //    clock-stopped ⇒ no record"). Runs AFTER processClock so this tick's
        //    pulse step is captured as the quantize anchor; startRecording jumps
        //    to step 1 + (one-shot) clears + arms the window BEFORE the quantize
        //    write below — so the on-beat gate still records onto step 0. ──
        if (!recordingActive && running && clockActive && (recArm || overdub)) {
          startRecording(overdub);
        } else if (recordingActive && !running) {
          recordingActive = false;
        }

        // ── (c) Quantize each incoming gate edge against the step the audio
        //    thread is SOUNDING now (the latest emit anchor), sampling the
        //    latest cv → MIDI. Using soundingAnchor (not the post-advance
        //    stepIndex) is what keeps WRITESEQ on the SAME step the shared-clock
        //    driver hits — no off-by-one in either direction. ──
        if (recordingActive && gateEdges > 0) {
          const bpm = readParam('bpm', 120);
          const stepDur = 60 / Math.max(1, bpm) / 4;
          const length = effectiveLength();
          // External clock: prefer THIS tick's pulse step (the current beat).
          // Otherwise (internal clock / between pulses): the sounding step.
          const anchor = pulseAnchorThisTick ?? soundingAnchor(nowAt);
          const recStep = quantizeToNearestStep(nowAt, anchor.idx, anchor.atTime, stepDur, length);
          const midi = vOctToMidi(liveCv);
          writeStep(recStep, midi);
          lastRecordedStep = recStep;
        }

        // ── PASS-THROUGH (always on). A held live gate wins over the
        //    sequenced output. Else the sequenced step's last values stand. ──
        if (liveGateHeld) {
          pitchSrc.offset.setTargetAtTime(liveCv, ctx.currentTime, 0.001);
          gateSrc.offset.setTargetAtTime(1, ctx.currentTime, 0.001);
        }
      } catch (err) {
        console.error('[writeseq] tick error', err);
      }
    }

    unsubscribeTick = getSchedulerClock().subscribe(tick);

    // ─── Engine handle ───────────────────────────────────────────────
    const inputsMap = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
      ['cv',    { node: cvTap.gain, input: 0 }],
      ['gate',  { node: gateTap.gain, input: 0 }],
      ['clock', { node: clockInGain, input: 0 }],
      ['rec',   { node: recTap.gain, input: 0 }],
    ]);
    for (const [id, entry] of transportCv.inputs) {
      inputsMap.set(id, entry);
    }

    return {
      domain: 'audio',
      inputs: inputsMap,
      outputs: new Map<string, { node: AudioNode; output: number }>([
        ['pitch', { node: pitchSrc, output: 0 }],
        ['gate',  { node: gateSrc, output: 0 }],
        ['clock', { node: clockOutSrc, output: 0 }],
      ]),
      setParam(_paramId, _value) {
        // No AudioParam to write — the tick re-reads node.params each iteration.
      },
      readParam(paramId) {
        const live = livePatch.nodes[nodeId];
        const v = live?.params?.[paramId];
        return typeof v === 'number' ? v : undefined;
      },
      read(key) {
        if (key === 'currentStep') return playhead.currentAt(ctx.currentTime);
        if (key === 'stepIndex') return stepIndex;
        if (key === 'lastRecordedStep') return lastRecordedStep;
        if (key === 'recordingActive') return recordingActive ? 1 : 0;
        if (key === 'totalAdvances') return totalAdvances;
        if (key === 'totalSequenceEnds') return totalSequenceEnds;
        if (key === 'pitchVOct') return lastEmittedVOct;
        if (key === 'gateValue') return lastEmittedGate;
        return undefined;
      },
      dispose() {
        alive = false;
        if (unsubscribeTick) { unsubscribeTick(); unsubscribeTick = null; }
        try { pitchSrc.stop(); } catch { /* already stopped */ }
        try { gateSrc.stop(); } catch { /* already stopped */ }
        try { clockOutSrc.stop(); } catch { /* already stopped */ }
        try { clockInSilence.stop(); } catch { /* already stopped */ }
        try { cvTap.silence.stop(); } catch { /* already stopped */ }
        try { gateTap.silence.stop(); } catch { /* already stopped */ }
        try { recTap.silence.stop(); } catch { /* already stopped */ }
        pitchSrc.disconnect();
        gateSrc.disconnect();
        clockOutSrc.disconnect();
        clockInSilence.disconnect();
        clockInGain.disconnect();
        clockInAnalyser.disconnect();
        cvTap.silence.disconnect(); cvTap.gain.disconnect(); cvTap.analyser.disconnect();
        gateTap.silence.disconnect(); gateTap.gain.disconnect(); gateTap.analyser.disconnect();
        recTap.silence.disconnect(); recTap.gain.disconnect(); recTap.analyser.disconnect();
        transportCv.dispose();
      },
    };
  },
};
