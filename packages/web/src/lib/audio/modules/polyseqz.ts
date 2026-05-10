// packages/web/src/lib/audio/modules/polyseqz.ts
//
// POLYSEQZ — polyphonic chord sequencer. Same step model as the Sequencer
// (32 steps, internal BPM or external clock) but every step holds a chord
// (root + quality + inversion + voicing) and the pitch output is a
// polyPitchGate cable carrying the full 5-voice chord per step.
//
// Why a separate module instead of expanding Sequencer? Sequencer's chord
// surface is intentionally minimal (mono | maj | min) so it stays a "pitch
// box" first. POLYSEQZ is built around chord-first thinking — the per-step UI
// shows note name + quality together, not as an afterthought. Persisted data
// shape is incompatible (chord lives at top of step, plus inversion + voicing)
// so a separate module + def avoids muddying the Sequencer's migration path.
//
// Output cable: polyPitchGate (5 lanes = root + 3rd + 5th + (octave or 7th) +
// (octave or 5th doubling)). Wires directly into RIOTGIRLS, DX7 (when it
// lands), or any module that consumes polyPitchGate. Backward-compat with
// mono pitch sinks: lane 0 (the root) is auto-routed by resolveConnection().
//
// HUMANIZE: each step's per-voice gate-on time gets a small random delay.
// Magnitude + distribution shape are functions of the humanize amount —
// pure math lives in $lib/audio/humanize.ts so the unit tests can exercise
// the distribution without spinning up an AudioContext.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import {
  coerceToNoteStep,
  C3_MIDI,
  midiToVOct,
} from '$lib/audio/note-entry';
import {
  POLY_CHANNEL_PAIRS,
  createPolySender,
} from '$lib/audio/poly';
import {
  type ChordQualityName,
  type ChordInversion,
  type ChordVoicingName,
  CHORD_QUALITY_NAMES,
  CHORD_VOICING_NAMES,
  chordToVoices,
  VOICE_LANES,
} from '$lib/audio/chord-tables';
import { sampleHumanizeOffsets } from '$lib/audio/humanize';
import {
  createTransportCv,
  pickQueuedSlotFromEvents,
  TRANSPORT_CV_PORT_DEFS,
} from './transport-cv';
import {
  coerceSlots,
  coerceSlotKey,
} from './transport-helpers';

// ---------------- Step schema ----------------

export interface ChordStep {
  on: boolean;
  /** Root MIDI int (a4=69, c3=48). null = empty step. */
  root: number | null;
  /** Chord quality (default 'maj'). */
  quality: ChordQualityName;
  /** Inversion 0|1|2 (default 0). */
  inversion: ChordInversion;
  /** Voicing strategy (default 'closed'). */
  voicing: ChordVoicingName;
}

export const STEP_COUNT = 32;

export function defaultChordSteps(): ChordStep[] {
  return Array.from({ length: STEP_COUNT }, () => ({
    on: false,
    root: C3_MIDI,
    quality: 'maj' as ChordQualityName,
    inversion: 0 as ChordInversion,
    voicing: 'closed' as ChordVoicingName,
  }));
}

/** Coerce an arbitrary step-shape blob into a ChordStep. Used by the live
 *  reader (so half-typed Yjs writes don't crash the tick) and by the def
 *  migration. */
export function coerceToChordStep(raw: unknown): ChordStep {
  const base = coerceToNoteStep(raw); // gives us {on, midi}
  let quality: ChordQualityName = 'maj';
  let inversion: ChordInversion = 0;
  let voicing: ChordVoicingName = 'closed';
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (typeof r.quality === 'string' && (CHORD_QUALITY_NAMES as readonly string[]).includes(r.quality)) {
      quality = r.quality as ChordQualityName;
    }
    if (typeof r.inversion === 'number' && [0, 1, 2].includes(r.inversion)) {
      inversion = r.inversion as ChordInversion;
    }
    if (typeof r.voicing === 'string' && (CHORD_VOICING_NAMES as readonly string[]).includes(r.voicing)) {
      voicing = r.voicing as ChordVoicingName;
    }
    // POLYSEQZ persists `root` rather than `midi`; accept either for
    // forward-compat with possible re-uses.
    if (typeof r.root === 'number' || r.root === null) {
      // root is already canonical; keep base.midi as fallback.
    }
  }
  let root: number | null = base.midi;
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (typeof r.root === 'number' && Number.isFinite(r.root)) {
      root = Math.round(r.root as number);
    } else if (r.root === null) {
      root = null;
    }
  }
  return { on: base.on, root, quality, inversion, voicing };
}

// ---------------- Module def ----------------

export const polyseqzDef: AudioModuleDef = {
  type: 'polyseqz',
  domain: 'audio',
  label: 'POLYSEQZ',
  category: 'modulation',
  schemaVersion: 1,

  inputs: [
    // External clock (optional). When patched, advances on rising edges.
    { id: 'clock', type: 'gate' },
    // Shared transport CV inputs (PR feat/sequencer-transport-quicksave):
    //   play_cv      → toggles isPlaying on rising edge
    //   reset_cv     → resets stepIndex to 0 on rising edge
    //   queue1..4_cv → queues slot N on rising edge (loaded at sequence-end)
    // These replace the original POLYSEQZ play_cv (cv→param) + reset_cv (gate);
    // both behaviors fold into the shared edge-detect-and-dispatch path so the
    // transport surface matches Sequencer / DRUMSEQZ / SCORE 1:1.
    ...TRANSPORT_CV_PORT_DEFS,
    // CV → humanize amount (0..1).
    { id: 'humanize_cv', type: 'cv', paramTarget: 'humanize' },
  ],
  outputs: [
    { id: 'poly',  type: 'polyPitchGate' },
    // Convenience mono gate (high while ANY voice's gate is high). Lets
    // POLYSEQZ trigger per-step ADSR / scope-trigger / etc. without
    // unwrapping the polyPitchGate cable.
    { id: 'gate',  type: 'gate' },
    // Per-step clock pulse (10ms high) emitted on every advance.
    { id: 'clock', type: 'gate' },
  ],

  params: [
    { id: 'bpm',        label: 'BPM',  defaultValue: 90,  min: 30,  max: 300,  curve: 'linear' },
    { id: 'length',     label: 'Len',  defaultValue: 8,   min: 1,   max: 32,   curve: 'discrete' },
    { id: 'octave',     label: 'Oct',  defaultValue: 0,   min: -2,  max: 2,    curve: 'discrete' },
    { id: 'gateLength', label: 'Gate', defaultValue: 0.6, min: 0.1, max: 0.95, curve: 'linear' },
    { id: 'humanize',   label: 'Hum',  defaultValue: 0,   min: 0,   max: 1,    curve: 'linear' },
    { id: 'isPlaying',  label: 'Play', defaultValue: 0,   min: 0,   max: 1,    curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const polyPitch = createPolySender(ctx);
    const gateSrc = ctx.createConstantSource();
    const clockOutSrc = ctx.createConstantSource();
    gateSrc.offset.value = 0;
    clockOutSrc.offset.value = 0;
    gateSrc.start();
    clockOutSrc.start();

    // External-clock input.
    const clockInGain = ctx.createGain();
    const clockInAnalyser = ctx.createAnalyser();
    clockInAnalyser.fftSize = 2048;
    clockInGain.connect(clockInAnalyser);
    const clockInBuffer = new Float32Array(clockInAnalyser.fftSize);
    const clockInSilence = ctx.createConstantSource();
    clockInSilence.offset.value = 0;
    clockInSilence.start();
    clockInSilence.connect(clockInGain);

    // humanize_cv: declared as paramTarget input. The engine connects an
    // external CV signal into the AudioParam target. We back the target with
    // an internal ConstantSource — its offset receives the CV sum and the
    // tick polls the offset value via an analyser tap each iteration. (We
    // don't have a real AudioParam for `humanize` because the param store is
    // JS-side; this constant-source-as-AudioParam gives the engine something
    // to connect to and lets us read the live CV value with an AnalyserNode.)
    function makeParamCV(initial: number): {
      param: AudioParam;
      pollValue: () => number;
      dispose: () => void;
    } {
      const target = ctx.createConstantSource();
      target.offset.value = initial;
      target.start();
      const ana = ctx.createAnalyser();
      ana.fftSize = 256;
      target.connect(ana);
      const buf = new Float32Array(ana.fftSize);
      return {
        param: target.offset,
        pollValue() {
          ana.getFloatTimeDomainData(buf);
          // Average the most recent samples for a stable read — anything
          // higher-rate happens at audio thread anyway, and downstream uses
          // (humanize amount, isPlaying threshold) are coarse-grained.
          let sum = 0;
          const N = Math.min(buf.length, 64);
          for (let i = buf.length - N; i < buf.length; i++) sum += buf[i] ?? 0;
          return sum / N;
        },
        dispose() {
          try { target.stop(); } catch { /* */ }
          try { target.disconnect(); } catch { /* */ }
          try { ana.disconnect(); } catch { /* */ }
        },
      };
    }
    const humanizeCV = makeParamCV(0);

    // Shared transport CV inputs (play_cv, reset_cv, queue{1..4}_cv). Each
    // input is a GainNode → AnalyserNode tap whose recent samples we scan for
    // rising edges every tick. play_cv toggles isPlaying, reset_cv resets the
    // step counter, queue{N}_cv writes node.data.queuedSlot = N for the
    // sequence-end swap.
    const transportCv = createTransportCv(ctx);
    let lastTransportPollTime = ctx.currentTime;
    let totalSequenceEnds = 0;

    let lastClockSample = 0;
    let lastClockSampleTime = ctx.currentTime;
    const CLOCK_THRESHOLD = 0.5;

    const nodeId = node.id;

    function emitClockPulse(atTime: number) {
      clockOutSrc.offset.setValueAtTime(1, atTime);
      clockOutSrc.offset.setValueAtTime(0, atTime + 0.01);
    }

    function isClockInConnected(): boolean {
      for (const edge of Object.values(livePatch.edges)) {
        if (!edge) continue;
        if (edge.target.nodeId === nodeId && edge.target.portId === 'clock') return true;
      }
      return false;
    }

    function readSteps(): ChordStep[] {
      const live = livePatch.nodes[nodeId];
      const steps = (live?.data as Record<string, unknown> | undefined)?.steps;
      if (Array.isArray(steps)) {
        return (steps as unknown[]).map(coerceToChordStep);
      }
      return defaultChordSteps();
    }
    function readParam(id: string, fallback: number): number {
      const live = livePatch.nodes[nodeId];
      const v = live?.params?.[id];
      const base = typeof v === 'number' ? v : fallback;
      // Fold in CV-modulated params: if a connection is driving humanize_cv,
      // the constant-source offset's signal sums on top of the base value.
      // We only fold on params we actually publish as paramTargets —
      // everything else returns `base` verbatim. (play_cv used to fold here
      // too, but PR feat/polyseqz-transport-parity migrated it to the shared
      // edge-detect transport CV — toggles isPlaying instead of additively
      // modulating it.)
      if (id === 'humanize') {
        const cv = humanizeCV.pollValue();
        const sum = base + cv;
        return sum < 0 ? 0 : sum > 1 ? 1 : sum;
      }
      return base;
    }

    // Live state
    let stepIndex = 0;
    let nextStepTime = ctx.currentTime + 0.05;
    let prevPlaying = false;
    let alive = true;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const LOOKAHEAD_S = 0.1;
    const TICK_MS = 25;

    // Tracking for tests / introspection.
    let lastEmittedVOct = 0;
    let lastEmittedGate = 0;
    const lastEmittedLaneVOct = new Array<number>(POLY_CHANNEL_PAIRS).fill(0);
    const lastEmittedLaneGate = new Array<number>(POLY_CHANNEL_PAIRS).fill(0);
    const lastHumanizeOffsets = new Array<number>(POLY_CHANNEL_PAIRS).fill(0);
    let currentStep = 0;
    let totalAdvances = 0;

    /** Schedule one step's chord at the given audio time. Per-voice gate-on
     *  is offset by an independent random sample from the humanize
     *  distribution (clamped so it never tries to schedule in the past). */
    function emitStep(idx: number, atTime: number, stepDurForGate: number) {
      const octave = readParam('octave', 0);
      const gateLengthFrac = readParam('gateLength', 0.5);
      const humanize = readParam('humanize', 0);
      const steps = readSteps();
      const step = steps[idx];
      // Step clock pulse (chain-out signal) always fires on advance.
      emitClockPulse(atTime);

      const root = step && step.on && step.root !== null ? step.root : null;
      const voices = chordToVoices(
        root,
        step?.quality ?? 'maj',
        step?.inversion ?? 0,
        step?.voicing ?? 'closed',
      );

      const gateOffWindow = stepDurForGate * gateLengthFrac;

      const offsets = sampleHumanizeOffsets(humanize, POLY_CHANNEL_PAIRS);
      // Mirror for tests/UI.
      for (let i = 0; i < POLY_CHANNEL_PAIRS; i++) {
        lastHumanizeOffsets[i] = offsets[i] ?? 0;
      }

      let anyGate = false;
      for (let i = 0; i < POLY_CHANNEL_PAIRS; i++) {
        const lane = voices[i] ?? { midi: null, gate: 0 as 0 | 1 };
        const polyVoice = polyPitch.voices[i]!;
        if (lane.gate === 1 && lane.midi !== null) {
          // Apply octave param after chord math.
          const vOct = midiToVOct(lane.midi) + octave;
          // Clamp the per-voice fire time to "now or future" — Web Audio
          // accepts setValueAtTime in the near past silently but anything
          // earlier than ctx.currentTime - 0.1s can drop the event.
          const offset = offsets[i] ?? 0;
          const fireAt = Math.max(ctx.currentTime + 0.001, atTime + offset);
          // Set pitch slightly BEFORE the gate-on so the receiver sees a
          // stable V/oct at the moment the gate rises — matters for
          // single-cycle envelope triggers.
          polyVoice.pitchSrc.offset.setValueAtTime(vOct, fireAt - 0.001 < ctx.currentTime ? ctx.currentTime : fireAt - 0.001);
          polyVoice.gateSrc.offset.setValueAtTime(1, fireAt);
          polyVoice.gateSrc.offset.setValueAtTime(0, fireAt + gateOffWindow);
          lastEmittedLaneVOct[i] = vOct;
          lastEmittedLaneGate[i] = 1;
          anyGate = true;
          if (i === 0) lastEmittedVOct = vOct;
        } else {
          // Hold the lane silent. We do NOT touch pitchSrc — the previous
          // step's pitch lingers harmlessly behind a closed gate.
          polyVoice.gateSrc.offset.setValueAtTime(0, atTime);
          lastEmittedLaneGate[i] = 0;
        }
      }

      if (anyGate) {
        gateSrc.offset.setValueAtTime(1, atTime);
        gateSrc.offset.setValueAtTime(0, atTime + gateOffWindow);
        lastEmittedGate = 1;
      } else {
        // Empty step — leave gates low.
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
      // Each play_cv rising edge toggles isPlaying. Multiple edges in one
      // tick collapse to an XOR-style overall toggle.
      if (ev.play % 2 === 1) {
        isPlaying = !isPlaying;
        if (live?.params) live.params.isPlaying = isPlaying ? 1 : 0;
      }
      if (ev.reset > 0) {
        // Reset the step counter; next clock tick starts at step 0. Reset is
        // honored even when stopped (debounce-style) — same semantics as the
        // pre-shared-transport behavior in checkResetEdge.
        stepIndex = 0;
        currentStep = 0;
        nextStepTime = ctx.currentTime + 0.005;
      }
      const queued = pickQueuedSlotFromEvents(ev);
      if (queued !== null && live) {
        if (!live.data) live.data = {};
        (live.data as Record<string, unknown>).queuedSlot = queued;
      }
      return isPlaying;
    }

    /** Apply queued slot's snapshot. Snapshot shape (POLYSEQZ):
     *  { steps: ChordStep[], bpm, length, octave, gateLength, humanize }.
     *  Each ChordStep carries {on, root, quality, inversion, voicing}; we
     *  deep-clone every entry so the same Y-Map doesn't end up at two paths
     *  (slots[N] AND data.steps) — Yjs throws "reassigning object that
     *  already occurs in the tree" otherwise. */
    function maybeApplyQueuedSlot(): boolean {
      const live = livePatch.nodes[nodeId];
      if (!live) return false;
      const data = live.data as Record<string, unknown> | undefined;
      const queuedRaw = data?.queuedSlot;
      const queued = coerceSlotKey(queuedRaw);
      if (!queued) return false;
      const slots = coerceSlots(data?.slots);
      const snap = slots[queued];
      if (!snap) {
        // Slot is empty — drop the queue.
        if (data) data.queuedSlot = null;
        return false;
      }
      if (!live.data) live.data = {};
      const d = live.data as Record<string, unknown>;
      // Deep-clone steps before reassigning. Each ChordStep is a plain object
      // (no nested arrays) so a single spread suffices per step.
      if (Array.isArray(snap.steps)) {
        d.steps = (snap.steps as Array<Record<string, unknown>>).map((s) => ({ ...s }));
      }
      if (live.params) {
        for (const k of ['bpm', 'length', 'octave', 'gateLength', 'humanize'] as const) {
          const v = snap[k];
          if (typeof v === 'number') live.params[k] = v;
        }
      }
      d.lastLoadedSlot = queued;
      d.queuedSlot = null;
      // Reset position so the next emit starts at step 0 of the new pattern.
      stepIndex = 0;
      currentStep = 0;
      nextStepTime = ctx.currentTime + 0.005;
      return true;
    }

    function tick() {
      if (!alive) return;
      try {
        // Drain transport CV first; play_cv may have just toggled isPlaying
        // and reset_cv may have just bumped stepIndex.
        const isPlaying = pollTransportCv();
        const externalClock = isClockInConnected();
        const nowAt = ctx.currentTime;

        if (isPlaying && !prevPlaying) {
          stepIndex = 0;
          currentStep = 0;
          nextStepTime = ctx.currentTime + 0.05;
          gateSrc.offset.cancelScheduledValues(ctx.currentTime);
          gateSrc.offset.setValueAtTime(0, ctx.currentTime);
          polyPitch.silence(ctx.currentTime);
          lastClockSample = 0;
          lastClockSampleTime = ctx.currentTime;
          transportCv.resetEdges();
          lastTransportPollTime = ctx.currentTime;
        } else if (!isPlaying && prevPlaying) {
          gateSrc.offset.cancelScheduledValues(ctx.currentTime);
          gateSrc.offset.setValueAtTime(0, ctx.currentTime);
          polyPitch.silence(ctx.currentTime);
        }
        prevPlaying = isPlaying;

        if (!isPlaying) {
          timeoutId = setTimeout(tick, TICK_MS);
          return;
        }

        if (externalClock) {
          clockInAnalyser.getFloatTimeDomainData(clockInBuffer);
          const elapsed = nowAt - lastClockSampleTime;
          const newSamples = Math.min(
            clockInBuffer.length,
            Math.max(1, Math.ceil(elapsed * ctx.sampleRate)),
          );
          const start = clockInBuffer.length - newSamples;
          const bpm = readParam('bpm', 90);
          const length = Math.max(1, Math.round(readParam('length', 8)));
          const stepDurForGate = 60 / Math.max(1, bpm) / 2; // 8th-note feel
          for (let i = start; i < clockInBuffer.length; i++) {
            const cur = clockInBuffer[i] ?? 0;
            if (lastClockSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD) {
              emitStep(stepIndex, nowAt + 0.005, stepDurForGate);
              const nextIdx = (stepIndex + 1) % length;
              if (nextIdx === 0) {
                // Wrap: sequence end. Try to apply any queued slot before
                // advancing — the new pattern's step 0 will fire on the next
                // clock pulse.
                totalSequenceEnds++;
                if (maybeApplyQueuedSlot()) {
                  // stepIndex/currentStep reset by the apply; skip the
                  // natural advance.
                  continue;
                }
              }
              stepIndex = nextIdx;
              currentStep = stepIndex;
              totalAdvances++;
            }
            lastClockSample = cur;
          }
          lastClockSampleTime = nowAt;
        } else {
          while (nextStepTime < ctx.currentTime + LOOKAHEAD_S) {
            const bpm = readParam('bpm', 90);
            const length = Math.max(1, Math.round(readParam('length', 8)));
            // POLYSEQZ defaults to 8th-note step grid — chords feel slower
            // than the Sequencer's 16th default, which is more musically
            // appropriate for chord changes.
            const stepDur = 60 / bpm / 2;
            emitStep(stepIndex, nextStepTime, stepDur);
            const nextIdx = (stepIndex + 1) % length;
            const nextStartTime = nextStepTime + stepDur;
            if (nextIdx === 0) {
              totalSequenceEnds++;
              if (maybeApplyQueuedSlot()) {
                // Snapshot was applied; the next step time we want to
                // schedule is the natural step boundary, but for the new
                // pattern's step 0. maybeApplyQueuedSlot() resets nextStepTime
                // to ctx.currentTime + tiny, so re-anchor it here.
                nextStepTime = nextStartTime;
                continue;
              }
            }
            nextStepTime = nextStartTime;
            stepIndex = nextIdx;
            currentStep = stepIndex;
            totalAdvances++;
          }
          lastClockSampleTime = nowAt;
        }
      } catch (err) {
        console.error('[polyseqz] tick error', err);
      }
      if (alive) timeoutId = setTimeout(tick, TICK_MS);
    }

    timeoutId = setTimeout(tick, TICK_MS);

    const inputs = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
      ['clock', { node: clockInGain, input: 0 }],
      // humanize_cv is a paramTarget input — the engine routes the CV signal
      // directly into the AudioParam. .node is unused when .param is set; we
      // point at the closest in-graph node to keep the type happy.
      ['humanize_cv', { node: clockInGain, input: 0, param: humanizeCV.param }],
    ]);
    // Shared transport CV inputs (play_cv, reset_cv, queue1..4_cv).
    for (const [id, entry] of transportCv.inputs) {
      inputs.set(id, entry);
    }

    return {
      domain: 'audio',
      inputs,
      outputs: new Map([
        ['poly',  { node: polyPitch.output, output: 0 }],
        ['gate',  { node: gateSrc, output: 0 }],
        ['clock', { node: clockOutSrc, output: 0 }],
      ]),
      setParam(_paramId, _value) {
        // No AudioParam to write — the tick reads node.params each iteration.
      },
      readParam(paramId) {
        const live = livePatch.nodes[nodeId];
        const v = live?.params?.[paramId];
        return typeof v === 'number' ? v : undefined;
      },
      read(key) {
        if (key === 'currentStep') return currentStep;
        if (key === 'totalAdvances') return totalAdvances;
        if (key === 'totalSequenceEnds') return totalSequenceEnds;
        if (key === 'pitchVOct')  return lastEmittedVOct;
        if (key === 'gateValue')  return lastEmittedGate;
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
        if (typeof key === 'string' && key.startsWith('humanizeOffset:')) {
          const i = Number.parseInt(key.slice('humanizeOffset:'.length), 10);
          return Number.isFinite(i) && i >= 0 && i < POLY_CHANNEL_PAIRS
            ? lastHumanizeOffsets[i]
            : undefined;
        }
        return undefined;
      },
      dispose() {
        alive = false;
        if (timeoutId !== null) clearTimeout(timeoutId);
        try { gateSrc.stop(); } catch { /* */ }
        try { clockOutSrc.stop(); } catch { /* */ }
        try { clockInSilence.stop(); } catch { /* */ }
        polyPitch.dispose();
        gateSrc.disconnect();
        clockOutSrc.disconnect();
        clockInSilence.disconnect();
        clockInGain.disconnect();
        clockInAnalyser.disconnect();
        humanizeCV.dispose();
        transportCv.dispose();
      },
    };
  },
};

// Re-export the lane count so tests / UI stay in sync without duplicating it.
export { VOICE_LANES as POLYSEQZ_VOICE_LANES };
