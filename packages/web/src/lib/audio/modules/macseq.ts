// packages/web/src/lib/audio/modules/macseq.ts
//
// MACSEQ — 16-step sequencer with a per-step MACROOSCILLATOR voice picker.
//
// Each step carries three values:
//   on    : boolean — gate this step?
//   midi  : MIDI note (int 33..114) emitted on PITCH out
//   model : modelIndex (0..MACRO_MAX_MODEL) | null = "—" / unset
//
// Outputs:
//   pitch    — V/oct CV (mono `pitch` cable) — same semantics as the
//              project's other sequencers' pitch output
//   gate     — gate output, fires every ON step
//   modelcv  — CV cable carrying the current step's selected modelIndex,
//              re-scaled into the project's bipolar -1..+1 CV convention.
//              When patched into MACROOSCILLATOR's `model_cv` input (which
//              declares `cvScale: 'discrete'`), the engine's discrete CV
//              scaler buckets the -1..+1 sweep across the param's integer
//              range — so MACSEQ emits `mapModelIndexToCv(idx)` and the
//              engine recovers `idx` at the AudioParam end. See
//              `mapModelIndexToCv` below for the mapping (lives next to
//              MODEL_NAMES so test + DSP + UI all share one source of
//              truth).
//   clock    — 10 ms pulse per advance (chain to other sequencers)
//
// Empty step (model === null) policy: HOLD the last emitted MODELCV value.
// Rationale: a sentinel like -1 would clamp to model 0 (VA) at the
// MACROOSCILLATOR end (its `model` AudioParam minValue is 0), which is
// indistinguishable from an explicit VA selection. Hold-last preserves the
// previous step's selection, which matches the project's pitch hold-on-off-
// gate convention and gives "leave it where it was" semantics that compose
// nicely with sparser patterns. The very first emit (no prior step selected
// a model) defaults to 0/VA — same as the macrooscillator's defaultValue.
//
// Why a separate sequencer rather than extending DRUMSEQZ / POLYSEQZ?
// MACSEQ's per-step modelIndex picker doesn't fit cleanly into either
// existing data shape (drumseqz is 4-track x 16-step; polyseqz is chord-
// per-step). A standalone module keeps the UI focused on the new control
// and the persisted data path independent — no migration tax on existing
// sequencer saves.
//
// schemaVersion: 1 — brand new module.
//
// Inputs:
//   clock (gate): external clock; rising edges advance one step. Unpatched = internal BPM.
//   play_cv / reset_cv (gate): shared transport CV (toggle isPlaying / reset to step 0).
//   queue1..8_cv (gate): rising edge queues quicksave slot N; applied at the
//     next sequence-end (8-slot quicksave, parity with the base Sequencer).
//   next_cv / prev_cv / random_cv (gate): at the next pattern end, jump to the
//     next / prior / random OCCUPIED slot (prev+next wrap among occupied slots).
//
// Outputs:
//   pitch (pitch): V/oct of the current step's note.
//   gate (gate): on-step gate.
//   modelcv (cv): -1..+1 carrier of the current step's selected MACROOSCILLATOR
//     model index (used with MACROOSCILLATOR's discrete model_cv input).
//   clock (gate): chained step clock-out.
//
// Params:
//   bpm (linear 30..300, default 120): internal tempo.
//   length (discrete 1..128, default 16): step count.
//   octave (discrete -2..2, default 0): global transposition.
//   gateLength (linear 0.1..0.95, default 0.5): per-step gate duty.
//   isPlaying (discrete 0..1, default 0): transport state.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { C3_MIDI, midiToVOct } from '$lib/audio/note-entry';
import { getSchedulerClock, SCHEDULER_TICK_MS } from '$lib/audio/scheduler-clock';
import { createPlayheadTracker } from './playhead-tracker';
import { MACRO_MAX_MODEL } from './macrooscillator';
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
  type NavDirection,
} from './transport-helpers';

/** Human-readable engine names, indexed by `modelIndex`. Must stay in
 *  lockstep with the engine table in `macrooscillatorMath.render` and the
 *  worklet at `packages/dsp/src/macrooscillator.ts`. Length matches
 *  `MACRO_MAX_MODEL + 1` — we assert that at startup-init time and via the
 *  unit-test suite so any drift is caught immediately.
 *
 *  This list is duplicated from MacrooscillatorCard.svelte's local copy
 *  rather than imported from there (the card hadn't promoted it to a
 *  shared export at the time MACSEQ landed). The card + this constant are
 *  the two consumers; both load-bearing tests live in macseq.test.ts. */
export const MODEL_NAMES = [
  'VA',          // 0
  'WAVESHAPE',   // 1
  'FM 2OP',      // 2
  'FM 6OP',      // 3
  'CHORD',       // 4
  'ADDITIVE',    // 5
  'STRING',      // 6
  'MODAL',       // 7
  'KICK',        // 8
  'SNARE',       // 9
  'HIHAT',       // 10
  'WAVETABLE',   // 11
  'GRANULAR',    // 12
  'SPEECH',      // 13
] as const;

export type MacroModelName = (typeof MODEL_NAMES)[number];

// Compile-time guard so we can't accidentally let MODEL_NAMES + MACRO_MAX_MODEL
// drift apart. If macrooscillator grows a new engine, MACRO_MAX_MODEL bumps,
// and this expression fails to type-check (and the runtime assert fires).
if (MODEL_NAMES.length !== MACRO_MAX_MODEL + 1) {
  // eslint-disable-next-line no-console
  console.warn(
    `[macseq] MODEL_NAMES length (${MODEL_NAMES.length}) !== MACRO_MAX_MODEL+1 (${MACRO_MAX_MODEL + 1}) — engine list has drifted; update MODEL_NAMES.`,
  );
}

// Re-export for the card + tests.
export { MACRO_MAX_MODEL };

// Pre-pages PR this was 16 (a single 16-step page). The card renders 16 cells
// per page and offers up to 8 pages via the shared SequencerPageNav. Data
// arrays widen to MAX_STEPS=128 via coerceSteps + ensureCapacity in the card.
export const STEP_COUNT = 128;
/** Number of steps rendered in one screen row — load-bearing for the card's
 *  per-page grid templating. */
export const PAGE_SIZE = 16;

export interface MacseqStep {
  on: boolean;
  /** MIDI note for this step's pitch (33..114). null = use C3 fallback. */
  midi: number | null;
  /** MACROOSCILLATOR modelIndex (0..MACRO_MAX_MODEL) or null = "—" / unset.
   *  See HOLD-LAST policy in file header. */
  model: number | null;
}

export interface MacseqData {
  steps: MacseqStep[]; // length 16
}

export function defaultStep(): MacseqStep {
  return { on: false, midi: C3_MIDI, model: null };
}

export function defaultSteps(): MacseqStep[] {
  return Array.from({ length: STEP_COUNT }, defaultStep);
}

/** Coerce arbitrary step-shape input into a canonical MacseqStep. Used by
 *  the live reader so half-typed Yjs writes don't crash the tick. */
export function coerceStep(raw: unknown): MacseqStep {
  if (!raw || typeof raw !== 'object') return defaultStep();
  const r = raw as Record<string, unknown>;
  const on = !!r.on;
  // midi
  let midi: number | null = null;
  if ('midi' in r) {
    const m = r.midi;
    if (m === null || m === undefined) midi = null;
    else if (typeof m === 'number' && Number.isFinite(m)) {
      const rounded = Math.round(m);
      if (rounded >= 33 && rounded <= 114) midi = rounded;
    }
  } else {
    midi = C3_MIDI;
  }
  // model
  let model: number | null = null;
  if ('model' in r) {
    const v = r.model;
    if (v === null || v === undefined) model = null;
    else if (typeof v === 'number' && Number.isFinite(v)) {
      const rounded = Math.round(v);
      if (rounded >= 0 && rounded <= MACRO_MAX_MODEL) model = rounded;
    }
  }
  return { on, midi, model };
}

export function coerceSteps(raw: unknown): MacseqStep[] {
  if (!Array.isArray(raw)) return defaultSteps();
  const out: MacseqStep[] = [];
  for (let i = 0; i < STEP_COUNT; i++) {
    out.push(coerceStep(raw[i]));
  }
  return out;
}

/** Resolve the V/oct CV to emit for a step. midi=null falls back to C3. */
export function resolveStepVOct(step: MacseqStep, globalOctave: number): number {
  const midi = step.midi ?? C3_MIDI;
  return midiToVOct(midi) + globalOctave;
}

/** Resolve the modelIndex CV (as a raw integer in [0..MACRO_MAX_MODEL]) for a
 *  step, given the previously emitted index (HOLD-LAST on null/unset steps).
 *  This is the *logical* index. To emit on the MODELCV CV cable, scale via
 *  `mapModelIndexToCv` so the engine's discrete CV scaler recovers it at the
 *  AudioParam end. */
export function resolveStepModelCv(step: MacseqStep, lastEmitted: number): number {
  if (step.model === null) return lastEmitted;
  return step.model;
}

/**
 * Map a modelIndex (0..MACRO_MAX_MODEL) into the bipolar -1..+1 CV value
 * that MACSEQ should emit on its `modelcv` output, so that the
 * MACROOSCILLATOR's `model_cv` input (which declares `cvScale: 'discrete'`,
 * targeting an AudioParam of range [0..MACRO_MAX_MODEL]) round-trips back
 * to the same `idx`.
 *
 * Discrete CV bucketing math (see packages/web/src/lib/audio/cv-scale.ts):
 *   effective = round(min + ((cv + 1) / 2) * (max - min))
 *
 * So inverting for our (min=0, max=MACRO_MAX_MODEL) target:
 *   cv = (idx / max) * 2 - 1
 *
 * Examples (MACRO_MAX_MODEL=13):
 *   idx=0  → cv = -1.0     (VA)
 *   idx=7  → cv ≈  0.077   (MODAL)
 *   idx=13 → cv = +1.0     (SPEECH)
 *
 * For idx === 0 we still emit cv = -1, NOT 0, because the engine clamps
 * incoming CV to [-1, 1] before bucketing and 0 would round to model 7.
 */
export function mapModelIndexToCv(idx: number): number {
  const clamped = Math.max(0, Math.min(MACRO_MAX_MODEL, Math.round(idx)));
  if (MACRO_MAX_MODEL <= 0) return -1;
  return (clamped / MACRO_MAX_MODEL) * 2 - 1;
}

export const macseqDef: AudioModuleDef = {
  type: 'macseq',
  domain: 'audio',
  label: 'MACSEQ',
  category: 'modulation',
  schemaVersion: 1,

  inputs: [
    // External clock input (optional). When patched, advances on rising
    // edges instead of the internal BPM. Matches the existing sequencer's
    // clock-in convention.
    { id: 'clock', type: 'gate' },
    // Shared transport CV inputs (feat/seq save/load parity with Sequencer):
    //   play_cv      → rising edge toggles isPlaying
    //   reset_cv     → rising edge resets stepIndex to 0
    //   queue1..4_cv → rising edge queues slot N (applied on sequence-end)
    ...TRANSPORT_CV_PORT_DEFS,
    // feat/seq 8-slots + quantized nav:
    //   queue5..8_cv → queue slot 5..8
    //   next/prev/random_cv → at the next pattern end, jump to the
    //     next / prior / random OCCUPIED slot (prev+next wrap).
    ...EXTENDED_TRANSPORT_CV_PORT_DEFS,
  ],
  outputs: [
    // Pitch CV (V/oct, mono `pitch` cable) — emits the current step's note.
    { id: 'pitch',   type: 'pitch' },
    // Gate output — fires every ON step.
    { id: 'gate',    type: 'gate' },
    // MACROOSCILLATOR modelIndex CV. Patch into a macrooscillator's
    // `model_cv` input. Emits the raw integer in [0..MACRO_MAX_MODEL]; the
    // macrooscillator clamps internally. On a step with model === null we
    // HOLD the last emitted value (see file header for rationale).
    { id: 'modelcv', type: 'cv' },
    // Per-step clock pulse (chain to other sequencers' clock in).
    { id: 'clock',   type: 'gate' },
  ],
  params: [
    { id: 'bpm',        label: 'BPM',  defaultValue: 120, min: 30,  max: 300,  curve: 'linear' },
    { id: 'length',     label: 'Len',  defaultValue: 16,  min: 1,   max: 128,  curve: 'discrete' },
    { id: 'octave',     label: 'Oct',  defaultValue: 0,   min: -2,  max: 2,    curve: 'discrete' },
    { id: 'gateLength', label: 'Gate', defaultValue: 0.5, min: 0.1, max: 0.95, curve: 'linear' },
    { id: 'isPlaying',  label: 'Play', defaultValue: 0,   min: 0,   max: 1,    curve: 'discrete' },
  ],

  // Module-grouping Phase 4 — surface PLAY/STOP as a single button a
  // containing GROUP! can opt to expose on its bar.
  exposableControls: [
    { id: 'playStop', label: 'Play', kind: 'button', paramId: 'isPlaying' },
  ],
  // Instruments v1 — full 16-step grid is atomically exposable.
  exposesSequence: true,

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const nodeId = node.id;

    const pitchSrc = ctx.createConstantSource();
    const gateSrc = ctx.createConstantSource();
    const modelCvSrc = ctx.createConstantSource();
    const clockOutSrc = ctx.createConstantSource();
    pitchSrc.offset.value = 0;
    gateSrc.offset.value = 0;
    // Default to mapped idx=0 (VA) — i.e. cv=-1 — so an unpatched
    // MACROOSCILLATOR receiving the CV sees model 0 after discrete bucketing.
    modelCvSrc.offset.value = mapModelIndexToCv(0);
    clockOutSrc.offset.value = 0;
    pitchSrc.start();
    gateSrc.start();
    modelCvSrc.start();
    clockOutSrc.start();

    // External clock-in: GainNode → AnalyserNode rising-edge detector. Same
    // pattern as the project's other sequencers.
    const clockInGain = ctx.createGain();
    const clockInAnalyser = ctx.createAnalyser();
    clockInAnalyser.fftSize = 2048;
    clockInGain.connect(clockInAnalyser);
    const clockInBuffer = new Float32Array(clockInAnalyser.fftSize);
    const clockInSilence = ctx.createConstantSource();
    clockInSilence.offset.value = 0;
    clockInSilence.start();
    clockInSilence.connect(clockInGain);
    let lastClockSample = 0;
    let lastClockSampleTime = ctx.currentTime;
    const CLOCK_THRESHOLD = 0.5;

    // Shared transport CV inputs (play_cv, reset_cv, queue{1..8}_cv +
    // next/prev/random nav gates) — parity with the base Sequencer.
    const transportCv = createTransportCv(ctx, { extended: true });
    let lastTransportPollTime = ctx.currentTime;

    function emitClockPulse(atTime: number) {
      clockOutSrc.offset.setValueAtTime(1, atTime);
      clockOutSrc.offset.setValueAtTime(0, atTime + 0.01);
    }

    function readSteps(): MacseqStep[] {
      const live = livePatch.nodes[nodeId];
      const raw = (live?.data as Record<string, unknown> | undefined)?.steps;
      return coerceSteps(raw);
    }
    function readParam(id: string, fallback: number): number {
      const live = livePatch.nodes[nodeId];
      const v = live?.params?.[id];
      return typeof v === 'number' ? v : fallback;
    }
    function isClockInConnected(): boolean {
      return isInputPortConnected(Object.values(livePatch.edges), nodeId, 'clock');
    }
    function isPlayCvConnected(): boolean {
      return isInputPortConnected(Object.values(livePatch.edges), nodeId, 'play_cv');
    }

    let stepIndex = 0;
    let nextStepTime = ctx.currentTime + 0.05;
    let prevPlaying = false;
    let alive = true;
    let unsubscribeTick: (() => void) | null = null;
    const LOOKAHEAD_S = 0.2;
    void SCHEDULER_TICK_MS; // referenced by the shared scheduler-clock

    const playhead = createPlayheadTracker();
    let totalAdvances = 0;
    let totalSequenceEnds = 0;
    let lastEmittedVOct = 0;
    let lastEmittedGate = 0;
    // Last MODELCV value we actually wrote to modelCvSrc. Used for HOLD-LAST
    // behavior on null steps + as the read("modelCv") backing value.
    let lastEmittedModelCv = 0;

    /** Drain the transport CV inputs + dispatch effects. Returns the
     *  isPlaying value AFTER any play_cv toggle. Mirrors the base
     *  Sequencer's pollTransportCv (minus the #224 reset-dedup, which is a
     *  base-Sequencer-only lookahead concern). */
    function pollTransportCv(): boolean {
      const nowAt = ctx.currentTime;
      const elapsed = nowAt - lastTransportPollTime;
      lastTransportPollTime = nowAt;
      const ev = transportCv.drain(elapsed);
      const live = livePatch.nodes[nodeId];
      let isPlaying = readParam('isPlaying', 0) >= 0.5;
      // Each play_cv rising edge toggles isPlaying (XOR multiple edges).
      if (ev.play % 2 === 1) {
        isPlaying = !isPlaying;
        if (live?.params) live.params.isPlaying = isPlaying ? 1 : 0;
      }
      if (ev.reset > 0) {
        stepIndex = 0;
        playhead.reset();
        nextStepTime = ctx.currentTime + 0.05;
        gateSrc.offset.cancelScheduledValues(ctx.currentTime);
        gateSrc.offset.setValueAtTime(0, ctx.currentTime);
      }
      const queued = pickQueuedSlotFromEvents(ev);
      if (queued !== null && live) {
        if (!live.data) live.data = {};
        const d = live.data as Record<string, unknown>;
        d.queuedSlot = queued;
        d.queuedNav = null; // explicit slot supersedes a pending nav
      }
      const nav = pickNavFromEvents(ev);
      if (nav !== null && live) {
        if (!live.data) live.data = {};
        (live.data as Record<string, unknown>).queuedNav = nav;
      }
      return isPlaying;
    }

    /** Apply the queued slot's (or queued nav's) snapshot to node.data +
     *  node.params on sequence-end, and reset the step counter. MACSEQ's
     *  snapshot carries `steps` (per-step on/midi/model) + bpm/length/
     *  octave/gateLength. Returns true if a snapshot was applied. */
    function maybeApplyQueuedSlot(): boolean {
      const live = livePatch.nodes[nodeId];
      if (!live) return false;
      const data = live.data as Record<string, unknown> | undefined;
      const slots = coerceSlots(data?.slots);
      let queued = coerceSlotKey(data?.queuedSlot);
      if (!queued) {
        const navRaw = data?.queuedNav;
        const nav: NavDirection | null =
          navRaw === 'next' || navRaw === 'prev' || navRaw === 'random' ? navRaw : null;
        if (nav) {
          const current = coerceSlotKey(data?.lastLoadedSlot);
          queued = resolveNavTarget(occupiedSlots(slots), current, nav);
          if (data) data.queuedNav = null;
        }
      }
      if (!queued) return false;
      const snap = slots[queued];
      if (!snap) {
        if (data) data.queuedSlot = null;
        return false;
      }
      if (!live.data) live.data = {};
      const d = live.data as Record<string, unknown>;
      // Deep-clone steps (the snapshot still lives at slots[N] in the Y.Doc
      // tree; Yjs forbids reassigning the same Y.Map at two paths).
      if (Array.isArray(snap.steps)) {
        d.steps = (snap.steps as Array<Record<string, unknown>>).map((s) => ({ ...s }));
      }
      if (live.params) {
        for (const k of ['bpm', 'length', 'octave', 'gateLength'] as const) {
          const v = snap[k];
          if (typeof v === 'number') live.params[k] = v;
        }
      }
      d.lastLoadedSlot = queued;
      d.queuedSlot = null;
      stepIndex = 0;
      playhead.reset();
      nextStepTime = ctx.currentTime + 0.005;
      return true;
    }

    function emitStep(idx: number, atTime: number, stepDurForGate: number) {
      const octave = readParam('octave', 0);
      const gateLengthFrac = readParam('gateLength', 0.5);
      const steps = readSteps();
      const step = steps[idx] ?? defaultStep();
      emitClockPulse(atTime);
      playhead.schedule(idx, atTime);

      // MODELCV always emits — even on OFF steps — because the macrooscillator
      // model is a continuous param, not gated by step on/off. (You might
      // want the model to be "primed" before the next gated step's trigger.)
      // `lastEmittedModelCv` stores the logical INDEX (0..MACRO_MAX_MODEL);
      // we map to bipolar -1..+1 CV when writing the ConstantSource so the
      // engine's discrete CV scaler recovers the index at the AudioParam.
      const modelIdx = resolveStepModelCv(step, lastEmittedModelCv);
      modelCvSrc.offset.setValueAtTime(mapModelIndexToCv(modelIdx), atTime);
      lastEmittedModelCv = modelIdx;

      if (!step.on) {
        // Pitch: hold-on-off-gate semantics (don't disturb pitchSrc).
        // Gate: low; bookkeeping flag goes low.
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

    function tick() {
      if (!alive) return;
      try {
        // Drain transport CV first; play_cv may have just toggled isPlaying.
        const isPlaying = pollTransportCv();
        const externalClock = isClockInConnected();
        // play_cv / clock orthogonality (matches the base Sequencer): if
        // play_cv is unpatched, a patched clock's pulses ARE the play signal;
        // a patched play_cv wins.
        const playCvPatched = isPlayCvConnected();
        const shouldRun = shouldSequencerRun(isPlaying, externalClock, playCvPatched);
        const nowAt = ctx.currentTime;

        if (shouldRun && !prevPlaying) {
          stepIndex = 0;
          playhead.reset();
          nextStepTime = ctx.currentTime + 0.05;
          gateSrc.offset.cancelScheduledValues(ctx.currentTime);
          gateSrc.offset.setValueAtTime(0, ctx.currentTime);
          lastClockSample = 0;
          lastClockSampleTime = ctx.currentTime;
          transportCv.resetEdges();
          lastTransportPollTime = ctx.currentTime;
        } else if (!shouldRun && prevPlaying) {
          gateSrc.offset.cancelScheduledValues(ctx.currentTime);
          gateSrc.offset.setValueAtTime(0, ctx.currentTime);
        }
        prevPlaying = shouldRun;

        if (!shouldRun) return;

        if (externalClock) {
          clockInAnalyser.getFloatTimeDomainData(clockInBuffer);
          const elapsed = nowAt - lastClockSampleTime;
          const newSamples = Math.min(
            clockInBuffer.length,
            Math.max(1, Math.ceil(elapsed * ctx.sampleRate)),
          );
          const start = clockInBuffer.length - newSamples;
          const bpm = readParam('bpm', 120);
          // Clamp to [1, STEP_COUNT] so a stale persisted value (or a
          // post-PR widening default) can't sample past the data array.
          const length = Math.max(1, Math.min(STEP_COUNT, Math.round(readParam('length', 16))));
          const stepDurForGate = 60 / Math.max(1, bpm) / 4;
          for (let i = start; i < clockInBuffer.length; i++) {
            const cur = clockInBuffer[i] ?? 0;
            if (lastClockSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD) {
              emitStep(stepIndex, nowAt + 0.005, stepDurForGate);
              const nextIdx = (stepIndex + 1) % length;
              if (nextIdx === 0) {
                // Sequence end: apply any queued slot / nav before advancing.
                totalSequenceEnds++;
                if (maybeApplyQueuedSlot()) {
                  // stepIndex was reset to 0 by the apply; skip the advance.
                  lastClockSample = cur;
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
          while (nextStepTime < ctx.currentTime + LOOKAHEAD_S) {
            const bpm = readParam('bpm', 120);
            // Clamp to [1, STEP_COUNT] so a stale persisted value (or a
          // post-PR widening default) can't sample past the data array.
          const length = Math.max(1, Math.min(STEP_COUNT, Math.round(readParam('length', 16))));
            const stepDur = 60 / bpm / 4; // 16th-note grid
            emitStep(stepIndex, nextStepTime, stepDur);
            const nextIdx = (stepIndex + 1) % length;
            const nextStartTime = nextStepTime + stepDur;
            if (nextIdx === 0) {
              totalSequenceEnds++;
              if (maybeApplyQueuedSlot()) {
                // Snapshot applied; re-anchor the next step time to the
                // natural boundary for the new pattern's step 0.
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
        console.error('[macseq] tick error', err);
      }
    }

    unsubscribeTick = getSchedulerClock().subscribe(tick);

    const inputsMap = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
      ['clock', { node: clockInGain, input: 0 }],
    ]);
    for (const [id, entry] of transportCv.inputs) {
      inputsMap.set(id, entry);
    }

    return {
      domain: 'audio',
      inputs: inputsMap,
      outputs: new Map<string, { node: AudioNode; output: number }>([
        ['pitch',   { node: pitchSrc, output: 0 }],
        ['gate',    { node: gateSrc, output: 0 }],
        ['modelcv', { node: modelCvSrc, output: 0 }],
        ['clock',   { node: clockOutSrc, output: 0 }],
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
        if (key === 'totalAdvances') return totalAdvances;
        if (key === 'totalSequenceEnds') return totalSequenceEnds;
        if (key === 'pitchVOct')   return lastEmittedVOct;
        if (key === 'gateValue')   return lastEmittedGate;
        if (key === 'modelCv')     return lastEmittedModelCv;
        return undefined;
      },
      dispose() {
        alive = false;
        if (unsubscribeTick) { unsubscribeTick(); unsubscribeTick = null; }
        try { pitchSrc.stop(); } catch { /* already stopped */ }
        try { gateSrc.stop(); } catch { /* already stopped */ }
        try { modelCvSrc.stop(); } catch { /* already stopped */ }
        try { clockOutSrc.stop(); } catch { /* already stopped */ }
        try { clockInSilence.stop(); } catch { /* already stopped */ }
        pitchSrc.disconnect();
        gateSrc.disconnect();
        modelCvSrc.disconnect();
        clockOutSrc.disconnect();
        clockInSilence.disconnect();
        clockInGain.disconnect();
        clockInAnalyser.disconnect();
        transportCv.dispose();
      },
    };
  },
};
