// packages/web/src/lib/audio/modules/drumseqz.ts
//
// DRUMSEQZ — 4-channel x 16-step drum sequencer with Euclidean fills + per-track
// quantized CV. Sister module to RIOTGIRLS (the canonical pairing wires gate{N}
// + pitch{N} into RIOTGIRLS' four voices).
//
// No Faust / no AudioWorklet — this is a clock + CV module. The factory uses
// the shared scheduler-clock (Worker tick, jank-immune) to drive a 200 ms
// lookahead scheduler with eight ConstantSource outputs (4 gate + 4 pitch)
// plus a chained clock out.
//
// Per-step state shape: 4 tracks x 16 cells, each {on, midi: number | null}.
// midi === null means the track-root pitch falls through.
//
// schemaVersion: 1 — brand-new module, no migration.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { C3_MIDI, midiToVOct } from '$lib/audio/note-entry';
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
import { getSchedulerClock, SCHEDULER_TICK_MS } from '$lib/audio/scheduler-clock';

export const TRACK_COUNT = 4;
export const STEP_COUNT = 16;

export interface DrumseqzCell {
  on: boolean;
  /** Per-step pitch override (MIDI int 33..114) or null = use track root. */
  midi: number | null;
}

export type DrumseqzTrack = DrumseqzCell[]; // length 16

export interface DrumseqzData {
  tracks: DrumseqzTrack[]; // length 4
}

function defaultCell(): DrumseqzCell {
  return { on: false, midi: null };
}

export function defaultTrack(): DrumseqzTrack {
  return Array.from({ length: STEP_COUNT }, defaultCell);
}

export function defaultTracks(): DrumseqzTrack[] {
  return Array.from({ length: TRACK_COUNT }, defaultTrack);
}

/** Coerce arbitrary cell-shape input into a canonical DrumseqzCell. */
export function coerceCell(raw: unknown): DrumseqzCell {
  if (!raw || typeof raw !== 'object') return defaultCell();
  const r = raw as Record<string, unknown>;
  const on = !!r.on;
  let midi: number | null = null;
  if ('midi' in r) {
    const m = r.midi;
    if (m === null || m === undefined) midi = null;
    else if (typeof m === 'number' && Number.isFinite(m)) {
      const rounded = Math.round(m);
      if (rounded >= 33 && rounded <= 114) midi = rounded;
    }
  }
  return { on, midi };
}

export function coerceTracks(raw: unknown): DrumseqzTrack[] {
  if (!Array.isArray(raw)) return defaultTracks();
  const out: DrumseqzTrack[] = [];
  for (let t = 0; t < TRACK_COUNT; t++) {
    const tr = raw[t];
    if (Array.isArray(tr)) {
      const cells: DrumseqzTrack = [];
      for (let i = 0; i < STEP_COUNT; i++) {
        cells.push(coerceCell(tr[i]));
      }
      out.push(cells);
    } else {
      out.push(defaultTrack());
    }
  }
  return out;
}

/**
 * Bjorklund's algorithm: distribute k pulses as evenly as possible across n
 * steps. Returns a length-n array of 1 (pulse) / 0 (rest).
 *
 * Special cases:
 *   k <= 0          → all zeros
 *   k >= n          → all ones (clamped)
 *
 * The "even-as-possible" output for k pulses in n steps is: pulse on step i
 * iff floor(i * k / n) !== floor((i - 1) * k / n). This produces the same
 * distribution Bjorklund's recursive subtraction algorithm yields and matches
 * Pamela's-Workout-style hardware sequencers.
 *
 * Examples:
 *   bjorklund(4, 16)  -> [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0]
 *   bjorklund(3, 8)   -> [1,0,0, 1,0,0, 1,0]
 *   bjorklund(5, 16)  -> [1,0,0,0, 1,0,0,1, 0,0,1,0, 0,1,0,0]
 */
export function bjorklund(k: number, n: number): number[] {
  if (n <= 0) return [];
  if (k <= 0) return new Array<number>(n).fill(0);
  if (k >= n) return new Array<number>(n).fill(1);
  const out = new Array<number>(n).fill(0);
  // Pulse on step i iff (i * k) mod n < k. Anchors the first pulse on step
  // 0 and distributes the remaining k-1 pulses as evenly as possible across
  // [1..n-1]. Matches Bjorklund's recursive subtraction output up to
  // rotation; matches Pamela's-Workout hardware behavior.
  for (let i = 0; i < n; i++) {
    out[i] = (i * k) % n < k ? 1 : 0;
  }
  return out;
}

/** Apply a Bjorklund pattern to an existing track: REWRITE the `on` flags
 *  while preserving each cell's `midi`. Length-stable (always 16 cells). */
export function applyEuclideanToTrack(
  track: DrumseqzTrack,
  k: number,
): DrumseqzTrack {
  const pattern = bjorklund(k, STEP_COUNT);
  const out: DrumseqzTrack = [];
  for (let i = 0; i < STEP_COUNT; i++) {
    const prev = track[i] ?? defaultCell();
    out.push({ on: pattern[i] === 1, midi: prev.midi });
  }
  return out;
}

/**
 * Resolve the V/oct that should be emitted for a given (track, step) at play
 * time. Pitch fall-through:
 *   1. Per-step `midi` override (if non-null).
 *   2. Else track-root param `trk{N}_root`.
 *
 * Plus per-track octave (`trk{N}_octave`) and global octave (`octave`) added
 * AFTER the V/oct conversion. midi=null with no track root falls back to C3.
 */
export function resolveStepVOct(
  cell: DrumseqzCell,
  trackRoot: number,
  trackOctave: number,
  globalOctave: number,
): number {
  const baseMidi = cell.midi ?? trackRoot;
  return midiToVOct(baseMidi) + trackOctave + globalOctave;
}

// Inputs/outputs/params are inlined as literals (rather than built via helpers)
// so the docs manifest's regex-based parser at packages/web/src/lib/docs/
// module-manifest.ts can pick them up automatically. See that file for the
// parser shape — it bails out if `outputs:` or `params:` aren't a literal `[`.

export const drumseqzDef: AudioModuleDef = {
  type: 'drumseqz',
  domain: 'audio',
  label: 'DRUMSEQZ',
  category: 'modulation',
  schemaVersion: 1,

  inputs: [
    { id: 'clock', type: 'gate' },
    // Shared transport CV inputs (PR feat/sequencer-transport-quicksave):
    //   play_cv      → toggles isPlaying on rising edge
    //   reset_cv     → resets stepIndex to 0 on rising edge
    //   queue1..4_cv → queues slot N on rising edge
    ...TRANSPORT_CV_PORT_DEFS,
  ],
  outputs: [
    { id: 'gate1',  type: 'gate' },
    { id: 'pitch1', type: 'pitch' },
    { id: 'gate2',  type: 'gate' },
    { id: 'pitch2', type: 'pitch' },
    { id: 'gate3',  type: 'gate' },
    { id: 'pitch3', type: 'pitch' },
    { id: 'gate4',  type: 'gate' },
    { id: 'pitch4', type: 'pitch' },
    { id: 'clock',  type: 'gate' },
  ],
  params: [
    { id: 'bpm',         label: 'BPM',  defaultValue: 120,      min: 30,  max: 300,  curve: 'linear' },
    { id: 'length',      label: 'Len',  defaultValue: 16,       min: 1,   max: 16,   curve: 'discrete' },
    { id: 'octave',      label: 'Oct',  defaultValue: 0,        min: -2,  max: 2,    curve: 'discrete' },
    { id: 'gateLength',  label: 'Gate', defaultValue: 0.5,      min: 0.1, max: 0.95, curve: 'linear' },
    { id: 'swing',       label: 'Sw',   defaultValue: 0,        min: 0,   max: 0.75, curve: 'linear' },
    { id: 'isPlaying',   label: 'Play', defaultValue: 0,        min: 0,   max: 1,    curve: 'discrete' },
    { id: 'trk1_euclid', label: 'T1E',  defaultValue: 0,        min: 0,   max: 16,   curve: 'discrete' },
    { id: 'trk1_root',   label: 'T1R',  defaultValue: C3_MIDI,  min: 33,  max: 114,  curve: 'discrete' },
    { id: 'trk1_octave', label: 'T1O',  defaultValue: 0,        min: -2,  max: 2,    curve: 'discrete' },
    { id: 'trk2_euclid', label: 'T2E',  defaultValue: 0,        min: 0,   max: 16,   curve: 'discrete' },
    { id: 'trk2_root',   label: 'T2R',  defaultValue: C3_MIDI,  min: 33,  max: 114,  curve: 'discrete' },
    { id: 'trk2_octave', label: 'T2O',  defaultValue: 0,        min: -2,  max: 2,    curve: 'discrete' },
    { id: 'trk3_euclid', label: 'T3E',  defaultValue: 0,        min: 0,   max: 16,   curve: 'discrete' },
    { id: 'trk3_root',   label: 'T3R',  defaultValue: C3_MIDI,  min: 33,  max: 114,  curve: 'discrete' },
    { id: 'trk3_octave', label: 'T3O',  defaultValue: 0,        min: -2,  max: 2,    curve: 'discrete' },
    { id: 'trk4_euclid', label: 'T4E',  defaultValue: 0,        min: 0,   max: 16,   curve: 'discrete' },
    { id: 'trk4_root',   label: 'T4R',  defaultValue: C3_MIDI,  min: 33,  max: 114,  curve: 'discrete' },
    { id: 'trk4_octave', label: 'T4O',  defaultValue: 0,        min: -2,  max: 2,    curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const nodeId = node.id;

    const gateSrcs: ConstantSourceNode[] = [];
    const pitchSrcs: ConstantSourceNode[] = [];
    // One AnalyserNode per gate src so `read('gateValue:N')` returns the
    // ACTUAL audio-rate gate value over a recent window — not the JS
    // bookkeeping flag from the most-recent emitStep call. Without this
    // tap, polling `lastEmittedGate[t]` is racy: with a 4-of-16 Bjorklund
    // pattern, the most-recent emitStep call is an OFF-step ~75% of the
    // time, even though the gate is actively firing in audio every 4 steps.
    // fftSize=2048 at 44.1kHz covers ~46ms of recent audio — long enough
    // to catch a gate-on at any reasonable BPM. The read() path takes the
    // peak across that window; any sample >= 0.5 == "gate fired recently".
    // We keep `lastEmittedGate[t]` as a fallback for tests that poll before
    // the audio thread has rendered the first quantum of gate samples.
    const gateAnalysers: AnalyserNode[] = [];
    const gateAnalyserBuf = new Float32Array(2048);
    for (let t = 0; t < TRACK_COUNT; t++) {
      const g = ctx.createConstantSource();
      g.offset.value = 0;
      g.start();
      gateSrcs.push(g);
      const ga = ctx.createAnalyser();
      ga.fftSize = 2048;
      ga.smoothingTimeConstant = 0;
      g.connect(ga);
      gateAnalysers.push(ga);
      const p = ctx.createConstantSource();
      p.offset.value = 0;
      p.start();
      pitchSrcs.push(p);
    }
    const clockOutSrc = ctx.createConstantSource();
    clockOutSrc.offset.value = 0;
    clockOutSrc.start();

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

    // Shared transport CV inputs (play_cv, reset_cv, queue{1..4}_cv).
    const transportCv = createTransportCv(ctx);
    let lastTransportPollTime = ctx.currentTime;
    let totalSequenceEnds = 0;

    function emitClockPulse(atTime: number) {
      clockOutSrc.offset.setValueAtTime(1, atTime);
      clockOutSrc.offset.setValueAtTime(0, atTime + 0.01);
    }

    function isClockInConnected(): boolean {
      return isInputPortConnected(Object.values(livePatch.edges), nodeId, 'clock');
    }
    function isPlayCvConnected(): boolean {
      return isInputPortConnected(Object.values(livePatch.edges), nodeId, 'play_cv');
    }

    function readTracks(): DrumseqzTrack[] {
      const live = livePatch.nodes[nodeId];
      const raw = (live?.data as Record<string, unknown> | undefined)?.tracks;
      return coerceTracks(raw);
    }
    function readParam(id: string, fallback: number): number {
      const live = livePatch.nodes[nodeId];
      const v = live?.params?.[id];
      return typeof v === 'number' ? v : fallback;
    }

    let stepIndex = 0;
    let nextStepTime = ctx.currentTime + 0.05;
    let prevPlaying = false;
    let alive = true;
    let unsubscribeTick: (() => void) | null = null;
    // 200 ms lookahead (was 100 ms). See sequencer.ts comment + the
    // PR description — a wider window absorbs main-thread jank without
    // glitching the audio thread.
    const LOOKAHEAD_S = 0.2;
    const TICK_MS = SCHEDULER_TICK_MS;

    let currentStep = 0;
    let totalAdvances = 0;
    const lastEmittedVOct = new Array<number>(TRACK_COUNT).fill(0);
    const lastEmittedGate = new Array<number>(TRACK_COUNT).fill(0);

    function emitStep(idx: number, atTime: number, stepDurForGate: number) {
      const globalOct = readParam('octave', 0);
      const gateLengthFrac = readParam('gateLength', 0.5);
      const tracks = readTracks();
      emitClockPulse(atTime);
      for (let t = 0; t < TRACK_COUNT; t++) {
        const cell = tracks[t]?.[idx] ?? defaultCell();
        if (!cell.on) {
          // Hold-CV semantics: don't touch pitchSrc on suppressed steps;
          // keep its last gated value. Mirror bookkeeping: gate flips low.
          lastEmittedGate[t] = 0;
          continue;
        }
        const root = readParam(`trk${t + 1}_root`, C3_MIDI);
        const trkOct = readParam(`trk${t + 1}_octave`, 0);
        const vOct = resolveStepVOct(cell, root, trkOct, globalOct);
        pitchSrcs[t].offset.setValueAtTime(vOct, atTime);
        gateSrcs[t].offset.setValueAtTime(1, atTime);
        gateSrcs[t].offset.setValueAtTime(0, atTime + stepDurForGate * gateLengthFrac);
        lastEmittedVOct[t] = vOct;
        lastEmittedGate[t] = 1;
      }
    }

    /** Drain transport CV inputs and dispatch effects. */
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
        currentStep = 0;
        nextStepTime = ctx.currentTime + 0.05;
      }
      const queued = pickQueuedSlotFromEvents(ev);
      if (queued !== null && live) {
        if (!live.data) live.data = {};
        (live.data as Record<string, unknown>).queuedSlot = queued;
      }
      return isPlaying;
    }

    /** Apply queued slot's snapshot. Snapshot shape (DRUMSEQZ):
     *  { tracks: DrumseqzTrack[], bpm, length, octave, gateLength, swing,
     *    trk{1..4}_euclid, trk{N}_root, trk{N}_octave }. */
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
      // Deep-clone the tracks array (and each track's cells) so we don't
      // reassign Y-tree-resident objects from slots[N] into data.tracks.
      if (Array.isArray(snap.tracks)) {
        d.tracks = (snap.tracks as Array<Array<Record<string, unknown>>>).map((tr) =>
          (Array.isArray(tr) ? tr : []).map((c) => ({ ...c })),
        );
      }
      if (live.params) {
        for (const k of ['bpm', 'length', 'octave', 'gateLength', 'swing'] as const) {
          const v = snap[k];
          if (typeof v === 'number') live.params[k] = v;
        }
        for (let t = 1; t <= TRACK_COUNT; t++) {
          for (const suffix of ['_euclid', '_root', '_octave'] as const) {
            const k = `trk${t}${suffix}`;
            const v = snap[k];
            if (typeof v === 'number') live.params[k] = v;
          }
        }
      }
      d.lastLoadedSlot = queued;
      d.queuedSlot = null;
      stepIndex = 0;
      currentStep = 0;
      nextStepTime = ctx.currentTime + 0.005;
      return true;
    }

    function tick() {
      if (!alive) return;
      try {
        const isPlaying = pollTransportCv();
        const externalClock = isClockInConnected();
        // Orthogonality fix: clock-only mode (clock patched, play_cv not)
        // treats incoming pulses as the play signal even when isPlaying=false.
        const playCvPatched = isPlayCvConnected();
        const shouldRun = shouldSequencerRun(isPlaying, externalClock, playCvPatched);

        if (shouldRun && !prevPlaying) {
          stepIndex = 0;
          currentStep = 0;
          nextStepTime = ctx.currentTime + 0.05;
          for (let t = 0; t < TRACK_COUNT; t++) {
            gateSrcs[t].offset.cancelScheduledValues(ctx.currentTime);
            gateSrcs[t].offset.setValueAtTime(0, ctx.currentTime);
          }
          lastClockSample = 0;
          lastClockSampleTime = ctx.currentTime;
          transportCv.resetEdges();
          lastTransportPollTime = ctx.currentTime;
        } else if (!shouldRun && prevPlaying) {
          for (let t = 0; t < TRACK_COUNT; t++) {
            gateSrcs[t].offset.cancelScheduledValues(ctx.currentTime);
            gateSrcs[t].offset.setValueAtTime(0, ctx.currentTime);
          }
        }
        prevPlaying = shouldRun;

        if (!shouldRun) {
          // Worker-driven scheduler-clock owns re-tick scheduling — see the
          // getSchedulerClock().subscribe(tick) below — so no timeoutId
          // self-loop is needed when we early-return.
          return;
        }

        if (externalClock) {
          clockInAnalyser.getFloatTimeDomainData(clockInBuffer);
          const nowAt = ctx.currentTime;
          const elapsed = nowAt - lastClockSampleTime;
          const newSamples = Math.min(
            clockInBuffer.length,
            Math.max(1, Math.ceil(elapsed * ctx.sampleRate)),
          );
          const start = clockInBuffer.length - newSamples;
          const bpm = readParam('bpm', 120);
          const length = Math.max(1, Math.round(readParam('length', STEP_COUNT)));
          const stepDurForGate = 60 / Math.max(1, bpm) / 4;
          for (let i = start; i < clockInBuffer.length; i++) {
            const cur = clockInBuffer[i] ?? 0;
            if (lastClockSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD) {
              emitStep(stepIndex, nowAt + 0.005, stepDurForGate);
              const nextIdx = (stepIndex + 1) % length;
              if (nextIdx === 0) {
                totalSequenceEnds++;
                if (maybeApplyQueuedSlot()) {
                  // stepIndex/currentStep reset; skip the natural advance.
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
            const bpm = readParam('bpm', 120);
            const length = Math.max(1, Math.round(readParam('length', STEP_COUNT)));
            const swing = readParam('swing', 0);

            const stepDurBase = 60 / bpm / 4;
            const isOddStep = stepIndex % 2 === 1;
            const stepDur = isOddStep
              ? stepDurBase * (1 - swing * 0.5)
              : stepDurBase * (1 + swing * 0.5);

            emitStep(stepIndex, nextStepTime, stepDur);

            const nextIdx = (stepIndex + 1) % length;
            const nextStartTime = nextStepTime + stepDur;
            if (nextIdx === 0) {
              totalSequenceEnds++;
              if (maybeApplyQueuedSlot()) {
                nextStepTime = nextStartTime;
                continue;
              }
            }
            nextStepTime = nextStartTime;
            stepIndex = nextIdx;
            currentStep = stepIndex;
            totalAdvances++;
          }
        }
      } catch (err) {
        console.error('[drumseqz] tick error', err);
      }
    }

    // Worker-driven tick (jank-immune); replaces self-rescheduling setTimeout.
    unsubscribeTick = getSchedulerClock().subscribe(tick);

    const inputs = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
      ['clock', { node: clockInGain, input: 0 }],
    ]);
    for (const [id, entry] of transportCv.inputs) {
      inputs.set(id, entry);
    }
    const outputs = new Map<string, { node: AudioNode; output: number }>();
    for (let t = 0; t < TRACK_COUNT; t++) {
      outputs.set(`gate${t + 1}`, { node: gateSrcs[t], output: 0 });
      outputs.set(`pitch${t + 1}`, { node: pitchSrcs[t], output: 0 });
    }
    outputs.set('clock', { node: clockOutSrc, output: 0 });

    return {
      domain: 'audio',
      inputs,
      outputs,
      setParam(_paramId, _value) {
        // No AudioParam to write — tick re-reads node.params each iteration.
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
        if (typeof key === 'string' && key.startsWith('pitchVOct:')) {
          const i = Number.parseInt(key.slice('pitchVOct:'.length), 10);
          return Number.isFinite(i) && i >= 0 && i < TRACK_COUNT
            ? lastEmittedVOct[i]
            : undefined;
        }
        if (typeof key === 'string' && key.startsWith('gateValue:')) {
          const i = Number.parseInt(key.slice('gateValue:'.length), 10);
          if (!Number.isFinite(i) || i < 0 || i >= TRACK_COUNT) return undefined;
          // Sample the actual audio-rate gate signal. The analyser's recent
          // buffer covers ~46ms at 44.1kHz; any sample at-or-above 0.5
          // means the gate was high during that window. Falls back to the
          // JS bookkeeping flag if the analyser hasn't been ticked yet
          // (very early in the lifecycle, before audio has rendered).
          gateAnalysers[i].getFloatTimeDomainData(gateAnalyserBuf);
          let peak = 0;
          for (let j = 0; j < gateAnalyserBuf.length; j++) {
            const v = gateAnalyserBuf[j];
            if (v > peak) peak = v;
          }
          return peak >= 0.5 ? peak : lastEmittedGate[i];
        }
        return undefined;
      },
      dispose() {
        alive = false;
        if (unsubscribeTick) { unsubscribeTick(); unsubscribeTick = null; }
        for (const g of gateSrcs) {
          try { g.stop(); } catch { /* already stopped */ }
          g.disconnect();
        }
        for (const ga of gateAnalysers) {
          ga.disconnect();
        }
        for (const p of pitchSrcs) {
          try { p.stop(); } catch { /* already stopped */ }
          p.disconnect();
        }
        try { clockOutSrc.stop(); } catch { /* already stopped */ }
        try { clockInSilence.stop(); } catch { /* already stopped */ }
        clockOutSrc.disconnect();
        clockInSilence.disconnect();
        clockInGain.disconnect();
        clockInAnalyser.disconnect();
        transportCv.dispose();
      },
    };
  },
};
