// packages/web/src/lib/audio/modules/cartesian.ts
//
// 4×4 grid sequencer. The X and Y CV inputs select
// column/row when patched (each split into four 25% bands across -1..+1).
// Per-axis behavior depends on what's patched into `clock`, `x_cv`, `y_cv`:
//   - clock unpatched: selected pad tracks X/Y instantly. Gate fires when the
//     selected pad changes.
//   - clock patched: pad updates only on each clock rising edge. If an axis
//     is unpatched, that axis advances by 1 each clock tick (wrap at 4).
// CV pitch output holds the last gated note (implicit sample-and-hold).
//
// Embedded LFO (v3): a clock-locked LFO with two phase-quadrature outputs
// (lfo_x, lfo_y). Patch them into x_cv + y_cv to draw circles, lissajous, etc.
// Rate is derived from the lfo_clock input (Hz between rising edges) times
// the lfoDiv multiplier. No auto-normaling — the user explicitly patches.
//
// Inputs:
//   clock (gate): pad-advance clock; rising edges step the selected pad. Unpatched = X/Y instantly tracks.
//   x_cv (cv): bipolar -1..+1 selecting column (4 bands across the range).
//   y_cv (cv): bipolar -1..+1 selecting row.
//   lfo_clock (gate): clock input for the embedded quadrature LFO; rate = measured Hz × lfoDiv.
//
// Outputs:
//   pitch (polyPitchGate): selected-pad note as a poly pitch lane (mono sinks get lane 0).
//   gate (gate): fires when the selected pad changes (or on clock tick when patched).
//   clock (gate): chained clock-out (1 pulse / step) for daisy-chaining sequencers.
//   lfo_x (cv): embedded LFO output, in-phase.
//   lfo_y (cv): embedded LFO output, 90° quadrature.
//
// Params:
//   mode (discrete 0..1, default 0): pad-advance mode (0 = freeform, 1 = clocked).
//   octave (discrete -2..2, default 0): octave transposition.
//   gateLength (linear 0.1..0.95, default 0.5): per-step gate duty.
//   lfoDiv (discrete 0..7, default 3): clock-divider for the embedded LFO.
//   lfoShape (linear 0..3, default 0): LFO waveform morph (sine/tri/saw/square).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { isInputPortConnected } from './transport-helpers';
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
  LFO_DIVISIONS as _LFO_DIVISIONS,
  LFO_DEFAULT_RATE_HZ as _LFO_DEFAULT_RATE_HZ,
  lfoMorph,
} from '$lib/audio/lfo-divisions';
import { getSchedulerClock, SCHEDULER_TICK_MS } from '$lib/audio/scheduler-clock';
import { createPlayheadTracker } from './playhead-tracker';

// Re-export for downstream consumers that already imported from here.
export const LFO_DIVISIONS = _LFO_DIVISIONS;
export const LFO_DEFAULT_RATE_HZ = _LFO_DEFAULT_RATE_HZ;

export interface Cell {
  on: boolean;
  /** MIDI int (a4 = 69) for this cell's pitch, or null = no note. v1 of this
   *  module used `pitch: <semitones from C4>`. */
  midi: number | null;
  /** Stage-1 polyphony (v3). Defaults to 'mono' = legacy single-note behavior. */
  chord?: ChordQuality;
}

/** Normalize an arbitrary cell-like object to a v3 Cell (with chord). */
export function coerceToCartesianCell(raw: unknown): Cell {
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

export const CELL_COUNT = 16;
export const GRID_DIM = 4;


export function defaultCells(): Cell[] {
  return Array.from({ length: CELL_COUNT }, () => ({ on: false, midi: C3_MIDI, chord: 'mono' }));
}

export const cartesianDef: AudioModuleDef = {
  type: 'cartesian',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'Cartesian',
  category: 'modulation',
  // v2: per-cell pitch encoding changed from `pitch: semitones` to `midi: int|null`.
  //     See sequencer.ts for the matching change.
  // v3: PR-31 — added lfo_clock input + lfo_x/lfo_y outputs + lfoDiv/lfoShape
  //     params. Defaults for lfoDiv + lfoShape are applied lazily from
  //     node.params at runtime; no persisted-data shape change.
  // v4: PR-34 — per-cell optional `chord: 'mono' | 'maj' | 'min'` for Stage-1
  //     polyphony. Pitch output port type changed to `polyPitchGate`.
  //     Backward-compat resolved by engine.addEdge → resolveConnection().
  schemaVersion: 4,
  migrate(data, fromVersion) {
    // v1 -> v2: per-cell pitch encoding (semitones-from-C4) -> midi int.
    let migrated: Record<string, unknown> | undefined;
    if (fromVersion < 2) {
      migrated = migrateStepArrayV1ToV2(data, 'cells');
    } else if (data && typeof data === 'object') {
      migrated = { ...(data as Record<string, unknown>) };
    } else {
      migrated = undefined;
    }
    // v2 -> v3: lfoDiv/lfoShape defaults applied lazily from node.params at
    // runtime; nothing to do for the persisted shape.
    // v3 -> v4: ensure each cell carries a `chord` field; missing -> 'mono'.
    if (fromVersion < 4 && migrated && Array.isArray(migrated.cells)) {
      migrated.cells = (migrated.cells as unknown[]).map((c) => {
        const ns = coerceToCartesianCell(c);
        return { on: ns.on, midi: ns.midi, chord: ns.chord ?? 'mono' };
      });
    }
    return migrated;
  },

  inputs: [
    { id: 'clock', type: 'gate' },
    { id: 'x_cv', type: 'cv' },
    { id: 'y_cv', type: 'cv' },
    { id: 'lfo_clock', type: 'gate' },
  ],
  outputs: [
    { id: 'pitch', type: 'polyPitchGate' },
    { id: 'gate',  type: 'gate' },
    { id: 'clock', type: 'gate' },
    { id: 'lfo_x', type: 'cv' },
    { id: 'lfo_y', type: 'cv' },
  ],
  params: [
    { id: 'mode',       label: 'Mode', defaultValue: 0,   min: 0,   max: 1,    curve: 'discrete' },
    { id: 'octave',     label: 'Oct',  defaultValue: 0,   min: -2,  max: 2,    curve: 'discrete' },
    { id: 'gateLength', label: 'Gate', defaultValue: 0.5, min: 0.1, max: 0.95, curve: 'linear' },
    // LFO division: index 0..7 into LFO_DIVISIONS. Default = 1/1.
    { id: 'lfoDiv',     label: 'Div',  defaultValue: 3,   min: 0,   max: 7,    curve: 'discrete' },
    // LFO waveform morph: 0=sine, 1=tri, 2=saw, 3=square. Continuous between.
    { id: 'lfoShape',   label: 'Wave', defaultValue: 0,   min: 0,   max: 3,    curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // Stage-1 polyphony: pitch port is polyPitchGate (5 voice pairs).
    const polyPitch = createPolySender(ctx);
    const gateSrc      = ctx.createConstantSource();
    const clockOutSrc  = ctx.createConstantSource();
    gateSrc.offset.value = 0;
    clockOutSrc.offset.value = 0;
    gateSrc.start();
    clockOutSrc.start();

    function makeAnalyserPort() {
      const gain = ctx.createGain();
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      gain.connect(an);
      const buf = new Float32Array(an.fftSize);
      const sil = ctx.createConstantSource();
      sil.offset.value = 0;
      sil.start();
      sil.connect(gain);
      return { gain, an, buf, sil };
    }

    const clockIn = makeAnalyserPort();
    const xIn     = makeAnalyserPort();
    const yIn     = makeAnalyserPort();
    const lfoClockIn = makeAnalyserPort();

    // LFO outputs: two phase-quadrature ConstantSources we drive at high
    // resolution from the JS tick. Quadrature so X→x_cv + Y→y_cv draws a
    // circular path, which is the obvious self-modulation use.
    const lfoXSrc = ctx.createConstantSource();
    const lfoYSrc = ctx.createConstantSource();
    lfoXSrc.offset.value = 0;
    lfoYSrc.offset.value = 0;
    lfoXSrc.start();
    lfoYSrc.start();

    const nodeId = node.id;
    let lastClockSample = 0;
    let lastClockSampleTime = ctx.currentTime;
    const CLOCK_THRESHOLD = 0.5;

    let stepIndex = 0;
    // X/Y advance counters used when clock is patched but the corresponding
    // axis CV is not (clock ticks then advance that axis modulo GRID_DIM).
    let xStep = 0;
    let yStep = 0;
    // Last pad selected — used in clock-unpatched mode to detect pad changes
    // and fire a gate exactly when the selection moves.
    let lastSelectedIdx = -1;
    let alive = true;
    let unsubscribeTick: (() => void) | null = null;
    const TICK_MS = SCHEDULER_TICK_MS;

    // ---------------- LFO state ----------------
    // Phase: 0..1 (one cycle = 0 -> 1). Updated each tick from the measured
    // clock rate * division. Falls back to LFO_DEFAULT_RATE_HZ when no clock.
    let lfoPhase = 0;
    let lfoLastClockSample = 0;
    /** Inferred rate of the lfo_clock input: Hz between rising edges. */
    let lfoMeasuredHz = LFO_DEFAULT_RATE_HZ;
    /** Time of most recent lfo_clock rising edge (audio-time seconds). */
    let lfoLastEdgeTime = -1;
    /** Audio-time at which we've already scheduled LFO output samples up to.
     *  The next tick picks up from here. */
    let lfoScheduledThrough = ctx.currentTime;
    const LFO_LOOKAHEAD_S = 0.06;
    /** Sample period for the lookahead schedule, in seconds. ~1ms is enough
     *  for a smooth low-frequency LFO; 250 setValueAtTime calls/sec/output. */
    const LFO_DT_S = 0.002;

    function readCells(): Cell[] {
      const live = livePatch.nodes[nodeId];
      const cells = (live?.data as Record<string, unknown> | undefined)?.cells;
      if (Array.isArray(cells)) {
        return (cells as unknown[]).map(coerceToCartesianCell);
      }
      return defaultCells();
    }
    function readParam(id: string, fallback: number): number {
      const live = livePatch.nodes[nodeId];
      const v = live?.params?.[id];
      return typeof v === 'number' ? v : fallback;
    }

    function readMostRecent(buf: Float32Array): number {
      return buf[buf.length - 1] ?? 0;
    }

    function emitClockPulse(atTime: number) {
      clockOutSrc.offset.setValueAtTime(1, atTime);
      clockOutSrc.offset.setValueAtTime(0, atTime + 0.01);
    }

    let lastEmittedVOct = 0;
    let lastEmittedGate = 0;
    const lastEmittedLaneVOct = new Array<number>(POLY_CHANNEL_PAIRS).fill(0);
    const lastEmittedLaneGate = new Array<number>(POLY_CHANNEL_PAIRS).fill(0);

    /** Sample the lfo_clock analyser buffer for rising edges and update the
     *  measured Hz from the time between consecutive edges. */
    function updateLfoClock(nowAt: number, elapsed: number) {
      lfoClockIn.an.getFloatTimeDomainData(lfoClockIn.buf);
      const newSamples = Math.min(
        lfoClockIn.buf.length,
        Math.max(1, Math.ceil(elapsed * ctx.sampleRate)),
      );
      const start = lfoClockIn.buf.length - newSamples;
      const sr = ctx.sampleRate;
      for (let i = start; i < lfoClockIn.buf.length; i++) {
        const cur = lfoClockIn.buf[i] ?? 0;
        if (lfoLastClockSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD) {
          // Approximate audio-time of this sample: nowAt minus the offset of
          // sample i back from the end of the analyser buffer.
          const tHere = nowAt - (lfoClockIn.buf.length - 1 - i) / sr;
          if (lfoLastEdgeTime > 0) {
            const dt = Math.max(1e-6, tHere - lfoLastEdgeTime);
            lfoMeasuredHz = 1 / dt;
          }
          lfoLastEdgeTime = tHere;
        }
        lfoLastClockSample = cur;
      }
    }

    /** Schedule LFO output samples from `from` audio-time up through
     *  `nowAt + LFO_LOOKAHEAD_S`. */
    function scheduleLfo(nowAt: number) {
      const targetEnd = nowAt + LFO_LOOKAHEAD_S;
      // If the schedule pointer fell behind real time, snap it forward.
      if (lfoScheduledThrough < nowAt) lfoScheduledThrough = nowAt;
      const divIdx = Math.max(0, Math.min(LFO_DIVISIONS.length - 1, Math.round(readParam('lfoDiv', 3))));
      const mult = LFO_DIVISIONS[divIdx]?.mult ?? 1;
      const shape = readParam('lfoShape', 0);
      // Effective LFO frequency.
      const baseHz = lfoMeasuredHz > 0 ? lfoMeasuredHz : LFO_DEFAULT_RATE_HZ;
      const hz = Math.max(0.01, Math.min(200, baseHz * mult));
      let t = lfoScheduledThrough;
      while (t < targetEnd) {
        const x = lfoMorph(lfoPhase, shape);
        const y = lfoMorph((lfoPhase + 0.25) % 1, shape);
        try {
          lfoXSrc.offset.setValueAtTime(x, t);
          lfoYSrc.offset.setValueAtTime(y, t);
        } catch { /* time may be in the past on audio thread; ignore */ }
        lfoLastX = x;
        lfoLastY = y;
        lfoPhase += hz * LFO_DT_S;
        if (lfoPhase >= 1) lfoPhase -= Math.floor(lfoPhase);
        if (lfoPhase < 0) lfoPhase = 0;
        t += LFO_DT_S;
      }
      lfoScheduledThrough = t;
    }

    let lfoLastX = 0;
    let lfoLastY = 0;

    function emitStep(idx: number, atTime: number, gateDur: number) {
      const octave = readParam('octave', 0);
      const gateLengthFrac = readParam('gateLength', 0.5);
      const cells = readCells();
      const cell = cells[idx];
      emitClockPulse(atTime);

      const baseMidi = cell && cell.on && cell.midi !== null ? cell.midi : null;
      const quality: ChordQuality = cell?.chord ?? 'mono';
      const voicing = chordVoicing(baseMidi, quality);
      const lanes = voicingToVOct(voicing).map((l) =>
        l.gate === 1 ? { pitch: l.pitch + octave, gate: 1 as const } : l,
      );
      const gateOff = gateDur * gateLengthFrac;
      polyPitch.scheduleStep(atTime, lanes, gateOff);

      for (let i = 0; i < POLY_CHANNEL_PAIRS; i++) {
        const l = lanes[i] ?? { pitch: 0, gate: 0 };
        lastEmittedLaneVOct[i] = l.pitch;
        lastEmittedLaneGate[i] = l.gate;
      }
      const anyGate = lanes.some((l) => l.gate === 1);
      if (anyGate) {
        gateSrc.offset.setValueAtTime(1, atTime);
        gateSrc.offset.setValueAtTime(0, atTime + gateOff);
        lastEmittedVOct = lanes[0]?.pitch ?? 0;
        lastEmittedGate = 1;
      } else {
        // Hold-on-off-gate CV: skip the pitch write so the port retains its
        // last gated value through silent cells. Only the gate goes low.
        lastEmittedGate = 0;
      }
    }

    function cvToCell(buf: Float32Array): number {
      const v = readMostRecent(buf);
      // CV is conventionally -1..+1; clamp + quantize into 4 equal bands.
      return Math.max(0, Math.min(GRID_DIM - 1, Math.floor((v + 1) / 2 * GRID_DIM)));
    }

    function tick() {
      if (!alive) return;
      try {
        clockIn.an.getFloatTimeDomainData(clockIn.buf);
        xIn.an.getFloatTimeDomainData(xIn.buf);
        yIn.an.getFloatTimeDomainData(yIn.buf);

        const nowAt = ctx.currentTime;
        const elapsed = nowAt - lastClockSampleTime;

        // LFO: detect rising edges on lfo_clock + roll out lookahead samples.
        updateLfoClock(nowAt, elapsed);
        scheduleLfo(nowAt);

        const edges = Object.values(livePatch.edges);
        const clockPatched = isInputPortConnected(edges, nodeId, 'clock');
        const xPatched     = isInputPortConnected(edges, nodeId, 'x_cv');
        const yPatched     = isInputPortConnected(edges, nodeId, 'y_cv');
        const gateDur = Math.max(0.01, elapsed);

        if (clockPatched) {
          const newSamples = Math.min(
            clockIn.buf.length,
            Math.max(1, Math.ceil(elapsed * ctx.sampleRate)),
          );
          const start = clockIn.buf.length - newSamples;
          for (let i = start; i < clockIn.buf.length; i++) {
            const cur = clockIn.buf[i] ?? 0;
            if (lastClockSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD) {
              const col = xPatched ? cvToCell(xIn.buf) : xStep;
              const row = yPatched ? cvToCell(yIn.buf) : yStep;
              if (!xPatched) xStep = (xStep + 1) % GRID_DIM;
              if (!yPatched) yStep = (yStep + 1) % GRID_DIM;
              const idx = row * GRID_DIM + col;
              playhead.schedule(idx, nowAt + 0.005);
              emitStep(idx, nowAt + 0.005, gateDur);
              lastSelectedIdx = idx;
              totalAdvances++;
            }
            lastClockSample = cur;
          }
        } else if (xPatched || yPatched) {
          // Clock unpatched: pad tracks X/Y CV continuously. Fire when the
          // selected pad changes. Unpatched axis stays on its current step.
          const col = xPatched ? cvToCell(xIn.buf) : xStep;
          const row = yPatched ? cvToCell(yIn.buf) : yStep;
          const idx = row * GRID_DIM + col;
          if (idx !== lastSelectedIdx) {
            playhead.schedule(idx, nowAt + 0.005);
            emitStep(idx, nowAt + 0.005, gateDur);
            lastSelectedIdx = idx;
            totalAdvances++;
          }
          // Keep lastClockSample synced so a later patched-clock doesn't see
          // a stale prev value and mis-detect the first edge.
          lastClockSample = readMostRecent(clockIn.buf);
        } else {
          lastClockSample = readMostRecent(clockIn.buf);
        }
        lastClockSampleTime = nowAt;
      } catch (err) {
        console.error('[cartesian] tick error', err);
      }
    }

    const playhead = createPlayheadTracker();
    let totalAdvances = 0;
    // Worker-driven tick (jank-immune); see scheduler-clock.ts.
    unsubscribeTick = getSchedulerClock().subscribe(tick);

    return {
      domain: 'audio',
      inputs: new Map([
        ['clock',     { node: clockIn.gain,    input: 0 }],
        ['x_cv',      { node: xIn.gain,        input: 0 }],
        ['y_cv',      { node: yIn.gain,        input: 0 }],
        ['lfo_clock', { node: lfoClockIn.gain, input: 0 }],
      ]),
      outputs: new Map([
        ['pitch', { node: polyPitch.output, output: 0 }],
        ['gate',  { node: gateSrc,  output: 0 }],
        ['clock', { node: clockOutSrc, output: 0 }],
        ['lfo_x', { node: lfoXSrc,  output: 0 }],
        ['lfo_y', { node: lfoYSrc,  output: 0 }],
      ]),
      setParam(_paramId, _value) {
        // Live-read from node.params each tick.
      },
      readParam(paramId) {
        const live = livePatch.nodes[nodeId];
        const v = live?.params?.[paramId];
        return typeof v === 'number' ? v : undefined;
      },
      read(key) {
        if (key === 'currentStep')   return playhead.currentAt(ctx.currentTime);
        if (key === 'totalAdvances') return totalAdvances;
        if (key === 'pitchVOct')     return lastEmittedVOct;
        if (key === 'gateValue')     return lastEmittedGate;
        if (key === 'lfoX')          return lfoLastX;
        if (key === 'lfoY')          return lfoLastY;
        if (key === 'lfoMeasuredHz') return lfoMeasuredHz;
        if (key === 'lfoPhase')      return lfoPhase;
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
        try { gateSrc.stop(); } catch { /* */ }
        try { clockOutSrc.stop(); } catch { /* */ }
        try { lfoXSrc.stop(); } catch { /* */ }
        try { lfoYSrc.stop(); } catch { /* */ }
        try { clockIn.sil.stop(); } catch { /* */ }
        try { xIn.sil.stop(); } catch { /* */ }
        try { yIn.sil.stop(); } catch { /* */ }
        try { lfoClockIn.sil.stop(); } catch { /* */ }
        polyPitch.dispose();
        gateSrc.disconnect();
        clockOutSrc.disconnect();
        lfoXSrc.disconnect();
        lfoYSrc.disconnect();
        clockIn.sil.disconnect();    clockIn.gain.disconnect();    clockIn.an.disconnect();
        xIn.sil.disconnect();        xIn.gain.disconnect();        xIn.an.disconnect();
        yIn.sil.disconnect();        yIn.gain.disconnect();        yIn.an.disconnect();
        lfoClockIn.sil.disconnect(); lfoClockIn.gain.disconnect(); lfoClockIn.an.disconnect();
      },
    };
  },
};
