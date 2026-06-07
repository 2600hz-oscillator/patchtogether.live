// packages/web/src/lib/audio/modules/grids.ts
//
// GRIDS — topographic drum pattern generator (Mutable Instruments Grids port,
// © 2011 Émilie Gillet, MIT-licensed; AGPL-compatible). Pattern DSP lives in
// the pure-math engine grids-engine.ts (mirror of packages/dsp/src/grids.ts).
//
// Grids walks a 32-step pattern at an internal tempo (or off an external
// clock); each step it asks the drum-map engine for BD / SD / HH trigger +
// accent bits, then emits gate pulses on the corresponding ConstantSource
// outputs. The (MAP-X, MAP-Y) coordinate selects the pattern character by
// interpolating the 5×5 drum map; per-channel DENSITY sets the fill; CHAOS
// adds per-pattern randomness; SWING shifts off-steps. An alternate EUCLIDEAN
// mode swaps the drum map for the 32×32 euclidean LUT.
//
// No AudioWorklet — like cartesian/drumseqz this is a scheduler-clock-driven
// clock + CV/gate module. CV inputs (mapX_cv, mapY_cv, bd/sd/hh density_cv,
// chaos_cv, swing_cv) are read via AnalyserNode most-recent-sample and SUM on
// top of the knob value. clock input is an external clock (rising edges
// advance one pattern step); when unpatched the internal tempo drives.
//
// schemaVersion: 1 — brand-new module, no migration.
//
// Inputs:
//   clock (gate): external clock; rising edges advance one step. Unpatched = internal tempo.
//   reset (gate): rising edge resets the pattern step index to 0.
//   mapX_cv / mapY_cv (cv): pad-coordinate CV (sums into mapX / mapY knobs).
//   bdDensity_cv / sdDensity_cv / hhDensity_cv (cv): per-channel density CV.
//   chaos_cv (cv): displaces the chaos knob (per-pattern randomness amount).
//   swing_cv (cv): displaces the swing offset.
//
// Outputs:
//   bd / sd / hh (gate): per-channel drum trigger gates.
//   accent (gate): accent gate (fires alongside the louder hits per the map).
//   clock (gate): chained step clock-out.
//
// Params:
//   tempo (linear 30..300, default 120): internal BPM.
//   mode (discrete 0..1, default DRUMS): DRUMS (drum-map) vs EUCLIDEAN.
//   mapX / mapY (linear 0..1, default 0.5): coordinate into the 5×5 drum map.
//   bdDensity / sdDensity / hhDensity (linear 0..1, default 0.5): per-channel fill.
//   chaos (linear 0..1, default 0): per-pattern randomness amount.
//   swing (linear 0..0.75, default 0): off-step time shift.
//   isPlaying (discrete 0..1, default 1): transport state.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { isInputPortConnected } from './transport-helpers';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import { createPlayheadTracker } from './playhead-tracker';
import {
  GRIDS_STEPS_PER_PATTERN,
  GRIDS_BIT_BD,
  GRIDS_BIT_SD,
  GRIDS_BIT_HH,
  GRIDS_BIT_BD_ACCENT,
  GRIDS_BIT_SD_ACCENT,
  GRIDS_BIT_HH_ACCENT,
  GRIDS_MODE_DRUMS,
  evaluateDrums,
  evaluateEuclidean,
  computePerturbation,
  makeByteRng,
  type GridsDrumSettings,
  type GridsEuclideanSettings,
} from './grids-engine';

const CLOCK_THRESHOLD = 0.5;

/** Convert a knob value in [0,1] + bipolar CV (-1..+1) into a 0..255 byte. */
export function unitToByte(knob: number, cv: number): number {
  const v = knob + cv; // CV sums on top of the knob
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

export const gridsDef: AudioModuleDef = {
  type: 'grids',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'grids',
  category: 'modulation',
  schemaVersion: 1,
  ossAttribution: { author: 'Émilie Gillet' },

  inputs: [
    { id: 'clock',       type: 'gate' },
    { id: 'reset',       type: 'gate' },
    { id: 'mapX_cv',     type: 'cv' },
    { id: 'mapY_cv',     type: 'cv' },
    { id: 'bdDensity_cv', type: 'cv' },
    { id: 'sdDensity_cv', type: 'cv' },
    { id: 'hhDensity_cv', type: 'cv' },
    { id: 'chaos_cv',    type: 'cv' },
    { id: 'swing_cv',    type: 'cv' },
  ],
  outputs: [
    { id: 'bd',     type: 'gate' },
    { id: 'sd',     type: 'gate' },
    { id: 'hh',     type: 'gate' },
    { id: 'accent', type: 'gate' },
    { id: 'clock',  type: 'gate' },
  ],
  params: [
    { id: 'tempo',     label: 'BPM',   defaultValue: 120, min: 30,  max: 300, curve: 'linear' },
    // 0 = EUCLIDEAN, 1 = DRUMS (default).
    { id: 'mode',      label: 'Mode',  defaultValue: GRIDS_MODE_DRUMS, min: 0, max: 1, curve: 'discrete' },
    { id: 'mapX',      label: 'X',     defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'mapY',      label: 'Y',     defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'bdDensity', label: 'BD',    defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'sdDensity', label: 'SD',    defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'hhDensity', label: 'HH',    defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'chaos',     label: 'Chaos', defaultValue: 0,   min: 0, max: 1, curve: 'linear' },
    { id: 'swing',     label: 'Swing', defaultValue: 0,   min: 0, max: 0.75, curve: 'linear' },
    { id: 'isPlaying', label: 'Run',   defaultValue: 1,   min: 0, max: 1, curve: 'discrete' },
  ],

  exposableControls: [
    { id: 'playStop', label: 'Run', kind: 'button', paramId: 'isPlaying' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const nodeId = node.id;

    // ---- Gate outputs (BD/SD/HH + accent) + chained clock out. ----
    const bdSrc = ctx.createConstantSource();
    const sdSrc = ctx.createConstantSource();
    const hhSrc = ctx.createConstantSource();
    const accentSrc = ctx.createConstantSource();
    const clockOutSrc = ctx.createConstantSource();
    for (const s of [bdSrc, sdSrc, hhSrc, accentSrc, clockOutSrc]) {
      s.offset.value = 0;
      s.start();
    }

    // ---- CV / clock inputs read via AnalyserNode (most-recent sample). ----
    function makeAnalyserPort() {
      const gain = ctx.createGain();
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0;
      gain.connect(an);
      const buf = new Float32Array(an.fftSize);
      const sil = ctx.createConstantSource();
      sil.offset.value = 0;
      sil.start();
      sil.connect(gain);
      return { gain, an, buf, sil };
    }
    const clockIn = makeAnalyserPort();
    const resetIn = makeAnalyserPort();
    const mapXIn = makeAnalyserPort();
    const mapYIn = makeAnalyserPort();
    const bdIn = makeAnalyserPort();
    const sdIn = makeAnalyserPort();
    const hhIn = makeAnalyserPort();
    const chaosIn = makeAnalyserPort();
    const swingIn = makeAnalyserPort();

    function readParam(id: string, fallback: number): number {
      const live = livePatch.nodes[nodeId];
      const v = live?.params?.[id];
      return typeof v === 'number' ? v : fallback;
    }
    function readMostRecent(buf: Float32Array): number {
      return buf[buf.length - 1] ?? 0;
    }

    // Pattern walk state.
    let step = 0;
    // Per-instrument euclidean step counters (advance on even pattern steps).
    const euclideanStep = [0, 0, 0];
    // CHAOS perturbation, recomputed at the top of each pattern (step 0).
    let perturbation: [number, number, number] = [0, 0, 0];
    const rng = makeByteRng(0x9e3779b1);

    let lastClockSample = 0;
    let lastClockSampleTime = ctx.currentTime;
    let lastResetSample = 0;

    let nextStepTime = ctx.currentTime + 0.05;
    let prevPlaying = false;
    let alive = true;
    let unsubscribeTick: (() => void) | null = null;
    const LOOKAHEAD_S = 0.2;

    const playhead = createPlayheadTracker();
    let totalAdvances = 0;
    let lastState = 0;

    function emitClockPulse(atTime: number) {
      clockOutSrc.offset.setValueAtTime(1, atTime);
      clockOutSrc.offset.setValueAtTime(0, atTime + 0.005);
    }

    function fireGate(src: ConstantSourceNode, atTime: number, gateDur: number, level: number) {
      src.offset.setValueAtTime(level, atTime);
      src.offset.setValueAtTime(0, atTime + gateDur);
    }

    /** Read all knobs+CV into the current pattern settings. */
    function readDrumSettings(): GridsDrumSettings {
      const x = unitToByte(readParam('mapX', 0.5), readMostRecent(mapXIn.buf));
      const y = unitToByte(readParam('mapY', 0.5), readMostRecent(mapYIn.buf));
      const randomness = unitToByte(readParam('chaos', 0), readMostRecent(chaosIn.buf));
      return {
        x, y, randomness,
        density: [
          unitToByte(readParam('bdDensity', 0.5), readMostRecent(bdIn.buf)),
          unitToByte(readParam('sdDensity', 0.5), readMostRecent(sdIn.buf)),
          unitToByte(readParam('hhDensity', 0.5), readMostRecent(hhIn.buf)),
        ],
      };
    }
    function readEuclideanSettings(): GridsEuclideanSettings {
      // In euclidean mode, MAP-X / MAP-Y repurpose as per-channel length;
      // density knobs map to euclidean density. Length0 = BD uses mapX, etc.
      const len = unitToByte(readParam('mapX', 0.5), readMostRecent(mapXIn.buf));
      const len2 = unitToByte(readParam('mapY', 0.5), readMostRecent(mapYIn.buf));
      return {
        length: [len, len2, len],
        density: [
          unitToByte(readParam('bdDensity', 0.5), readMostRecent(bdIn.buf)),
          unitToByte(readParam('sdDensity', 0.5), readMostRecent(sdIn.buf)),
          unitToByte(readParam('hhDensity', 0.5), readMostRecent(hhIn.buf)),
        ],
      };
    }

    /** Evaluate the pattern at `step` and emit the gate pulses at `atTime`. */
    function emitStep(s: number, atTime: number, stepDur: number) {
      const mode = Math.round(readParam('mode', GRIDS_MODE_DRUMS));
      emitClockPulse(atTime);
      playhead.schedule(s, atTime);

      let state = 0;
      if (mode === GRIDS_MODE_DRUMS) {
        if (s === 0) {
          perturbation = computePerturbation(readParam('chaos', 0) * 255, rng);
        }
        state = evaluateDrums(s, readDrumSettings(), perturbation);
      } else {
        // Euclidean: per-instrument counters advance on even steps (upstream
        // increments euclidean_step on even pattern steps; here we evaluate
        // every step but only re-read on even, mirroring `if (step_ & 1) return`).
        if ((s & 1) === 0) {
          const es = readEuclideanSettings();
          let bits = 0;
          for (let i = 0; i < 3; i++) {
            const r = evaluateEuclidean(i, es, euclideanStep[i]!);
            if (r.fire) bits |= 1 << i;
            euclideanStep[i] = (euclideanStep[i]! + 1);
          }
          state = bits;
        } else {
          state = 0;
        }
      }
      lastState = state;

      const gateDur = Math.min(stepDur * 0.5, 0.02);
      if (state & GRIDS_BIT_BD) fireGate(bdSrc, atTime, gateDur, 1);
      if (state & GRIDS_BIT_SD) fireGate(sdSrc, atTime, gateDur, 1);
      if (state & GRIDS_BIT_HH) fireGate(hhSrc, atTime, gateDur, 1);
      // Accent: high if ANY instrument accent bit is set this step.
      const accent = (state & (GRIDS_BIT_BD_ACCENT | GRIDS_BIT_SD_ACCENT | GRIDS_BIT_HH_ACCENT)) !== 0;
      if (accent) fireGate(accentSrc, atTime, gateDur, 1);
    }

    /** Pattern-step duration in seconds for a given tempo. Grids runs 8 steps
     *  per quarter note (32nd-note resolution). */
    function stepDurSec(bpm: number, s: number): number {
      const base = 60 / Math.max(1, bpm) / 8;
      const swing = readParam('swing', 0) + readMostRecent(swingIn.buf);
      const sw = Math.max(0, Math.min(0.75, swing));
      // Swing pushes the odd 16th (every other pair) later, mirroring upstream
      // swing_amount which alternates sign on `step & 2`.
      if (sw <= 0) return base;
      return (s & 2) === 0 ? base * (1 + sw * 0.5) : base * (1 - sw * 0.5);
    }

    function advance() {
      step = (step + 1) % GRIDS_STEPS_PER_PATTERN;
      totalAdvances++;
    }

    function resetPattern() {
      step = 0;
      euclideanStep[0] = 0; euclideanStep[1] = 0; euclideanStep[2] = 0;
      playhead.reset();
    }

    function tick() {
      if (!alive) return;
      try {
        // Refresh CV analyser buffers.
        for (const p of [mapXIn, mapYIn, bdIn, sdIn, hhIn, chaosIn, swingIn]) {
          p.an.getFloatTimeDomainData(p.buf);
        }

        const edges = Object.values(livePatch.edges);
        const externalClock = isInputPortConnected(edges, nodeId, 'clock');
        const resetPatched = isInputPortConnected(edges, nodeId, 'reset');
        const isPlaying = readParam('isPlaying', 1) >= 0.5;
        const shouldRun = isPlaying;

        const nowAt = ctx.currentTime;

        // RESET input — rising edge restarts the pattern.
        if (resetPatched) {
          resetIn.an.getFloatTimeDomainData(resetIn.buf);
          const elapsed = nowAt - lastClockSampleTime;
          const newSamples = Math.min(
            resetIn.buf.length,
            Math.max(1, Math.ceil(elapsed * ctx.sampleRate)),
          );
          const start = resetIn.buf.length - newSamples;
          for (let i = start; i < resetIn.buf.length; i++) {
            const cur = resetIn.buf[i] ?? 0;
            if (lastResetSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD) {
              resetPattern();
              nextStepTime = nowAt + 0.005;
            }
            lastResetSample = cur;
          }
        }

        if (shouldRun && !prevPlaying) {
          resetPattern();
          nextStepTime = nowAt + 0.05;
          lastClockSample = 0;
          lastClockSampleTime = nowAt;
        } else if (!shouldRun && prevPlaying) {
          for (const s of [bdSrc, sdSrc, hhSrc, accentSrc]) {
            s.offset.cancelScheduledValues(nowAt);
            s.offset.setValueAtTime(0, nowAt);
          }
        }
        prevPlaying = shouldRun;

        if (!shouldRun) return;

        if (externalClock) {
          clockIn.an.getFloatTimeDomainData(clockIn.buf);
          const elapsed = nowAt - lastClockSampleTime;
          const newSamples = Math.min(
            clockIn.buf.length,
            Math.max(1, Math.ceil(elapsed * ctx.sampleRate)),
          );
          const startI = clockIn.buf.length - newSamples;
          const bpm = readParam('tempo', 120);
          const stepDur = stepDurSec(bpm, step);
          for (let i = startI; i < clockIn.buf.length; i++) {
            const cur = clockIn.buf[i] ?? 0;
            if (lastClockSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD) {
              emitStep(step, nowAt + 0.005, stepDur);
              advance();
            }
            lastClockSample = cur;
          }
          lastClockSampleTime = nowAt;
        } else {
          while (nextStepTime < nowAt + LOOKAHEAD_S) {
            const bpm = readParam('tempo', 120);
            const stepDur = stepDurSec(bpm, step);
            emitStep(step, nextStepTime, stepDur);
            nextStepTime += stepDur;
            advance();
          }
        }
      } catch (err) {
        console.error('[grids] tick error', err);
      }
    }

    unsubscribeTick = getSchedulerClock().subscribe(tick);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['clock',        { node: clockIn.gain, input: 0 }],
        ['reset',        { node: resetIn.gain, input: 0 }],
        ['mapX_cv',      { node: mapXIn.gain,  input: 0 }],
        ['mapY_cv',      { node: mapYIn.gain,  input: 0 }],
        ['bdDensity_cv', { node: bdIn.gain,    input: 0 }],
        ['sdDensity_cv', { node: sdIn.gain,    input: 0 }],
        ['hhDensity_cv', { node: hhIn.gain,    input: 0 }],
        ['chaos_cv',     { node: chaosIn.gain, input: 0 }],
        ['swing_cv',     { node: swingIn.gain, input: 0 }],
      ]),
      outputs: new Map<string, { node: AudioNode; output: number }>([
        ['bd',     { node: bdSrc,       output: 0 }],
        ['sd',     { node: sdSrc,       output: 0 }],
        ['hh',     { node: hhSrc,       output: 0 }],
        ['accent', { node: accentSrc,   output: 0 }],
        ['clock',  { node: clockOutSrc, output: 0 }],
      ]),
      setParam(_paramId, _value) {
        // Live-read node.params each tick; nothing to write.
      },
      readParam(paramId) {
        const live = livePatch.nodes[nodeId];
        const v = live?.params?.[paramId];
        return typeof v === 'number' ? v : undefined;
      },
      read(key) {
        if (key === 'currentStep') return playhead.currentAt(ctx.currentTime);
        if (key === 'totalAdvances') return totalAdvances;
        if (key === 'lastState') return lastState;
        return undefined;
      },
      dispose() {
        alive = false;
        if (unsubscribeTick) { unsubscribeTick(); unsubscribeTick = null; }
        for (const s of [bdSrc, sdSrc, hhSrc, accentSrc, clockOutSrc]) {
          try { s.stop(); } catch { /* already stopped */ }
          s.disconnect();
        }
        for (const p of [clockIn, resetIn, mapXIn, mapYIn, bdIn, sdIn, hhIn, chaosIn, swingIn]) {
          try { p.sil.stop(); } catch { /* */ }
          p.sil.disconnect();
          p.gain.disconnect();
          p.an.disconnect();
        }
      },
    };
  },
};
