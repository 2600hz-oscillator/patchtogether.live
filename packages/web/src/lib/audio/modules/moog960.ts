// packages/web/src/lib/audio/modules/moog960.ts
//
// MOOG 960 SEQUENTIAL CONTROLLER — the Moog System 55 step sequencer. A
// 3-row × 8-step (column) analog sequencer: a single shared column pointer
// sweeps the 8 columns; on each advance, each of the 3 rows outputs its
// current column's knob value (scaled by that row's RANGE switch) on a
// ConstantSource CV output.
//
// PLAIN JS — NO AudioWorklet. Modeled EXACTLY on sequencer.ts (the canonical
// plain-JS sequencer): the shared scheduler-clock Worker tick drives the
// internal rate, ConstantSourceNodes carry the row CV + clock pulse, and the
// external `clock` input is edge-detected via a GainNode→AnalyserNode the tick
// polls — identical primitives to sequencer.ts, just 3 CV rows + start/stop
// gates instead of a pitch/gate/length sequencer. Column logic lives in the
// pure Seq960Stepper (packages/dsp/src/lib/seq960-dsp.ts).
//
// Inputs:
//   clock (gate): external clock — each rising edge advances ONE column. When
//                 unpatched, the internal `rate` (Hz) drives, exactly like
//                 sequencer.ts's clock-vs-BPM fallback.
//   start (gate): rising edge starts the sequencer running (column 0).
//   stop  (gate): rising edge halts (the pointer + CV hold their last column).
//
// Outputs:
//   row1 / row2 / row3 (cv): each row's current-column CV (pot × range mult).
//   clock_out (gate): a ~10 ms pulse at each column advance (chain-out), same
//                     shape as sequencer.ts's clock_out.
//
// Params:
//   r{1,2,3}s{1..8} (linear 0..1, default 0.5): the 24 step pots — row R,
//     column C's normalized CV level.
//   range1..range3 (discrete 0..2, default 0): per-row RANGE switch →
//     ×1 / ×2 / ×4 multiplier (see RANGE_MULTIPLIERS / rowOutput).
//   mode1..mode8 (discrete 0..2, default 0): per-COLUMN mode switch —
//     0 NORMAL, 1 SKIP, 2 STOP (see Seq960Stepper).
//   rate (log 0.1..20 Hz, default 2): internal clock speed when `clock` is
//     unpatched.
//
// CV SCALE: pots are 0..1; at RANGE ×1 a row emits 0..1 on its CV output (the
// project's unipolar CV magnitude); ×2 / ×4 widen to 0..2 / 0..4. Decision +
// rationale documented on RANGE_MULTIPLIERS in seq960-dsp.ts.
//
// V2 DEFERRALS (NOT built — see seq960-dsp.ts header): per-step trigger
// in/out jacks, the third-row-controls-timing switch, the ×2 parallel outputs
// per row, precise 1V/oct clock_cv, manual per-column trigger buttons, the
// 9th skip/stop position.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { isInputPortConnected } from './transport-helpers';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import { createPlayheadTracker } from './playhead-tracker';
import {
  Seq960Stepper,
  rowOutput,
  SEQ960_COLUMNS,
  SEQ960_ROWS,
} from '../../../../../dsp/src/lib/seq960-dsp';

/** Build the 24 step-pot param ids in row-major order: r1s1..r1s8, r2s1..r3s8. */
function stepPotId(row: number, col: number): string {
  return `r${row}s${col}`;
}

const STEP_POT_PARAMS = (() => {
  const out: AudioModuleDef['params'][number][] = [];
  for (let row = 1; row <= SEQ960_ROWS; row++) {
    for (let col = 1; col <= SEQ960_COLUMNS; col++) {
      out.push({
        id: stepPotId(row, col),
        label: `R${row}·${col}`,
        defaultValue: 0.5,
        min: 0,
        max: 1,
        curve: 'linear',
      });
    }
  }
  return out;
})();

const RANGE_PARAMS = [1, 2, 3].map((row) => ({
  id: `range${row}`,
  label: `Range ${row}`,
  defaultValue: 0,
  min: 0,
  max: 2,
  curve: 'discrete' as const,
}));

const MODE_PARAMS = Array.from({ length: SEQ960_COLUMNS }, (_, i) => ({
  id: `mode${i + 1}`,
  label: `Mode ${i + 1}`,
  defaultValue: 0,
  min: 0,
  max: 2,
  curve: 'discrete' as const,
}));

export const moog960Def: AudioModuleDef = {
  type: 'moog960',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  card: 'Moog960Card',
  domain: 'audio',
  label: '960 sequencer',
  // Matches the existing `sequencer` module's category (no dedicated
  // 'sequencers' category exists in the registry).
  category: 'modulation',
  schemaVersion: 1,

  inputs: [
    // External clock: rising edge advances one column. Unpatched → internal
    // `rate` drives (sequencer.ts's clock-vs-internal fallback).
    { id: 'clock', type: 'gate' },
    // Transport gates: rising edge starts / halts the run.
    { id: 'start', type: 'gate' },
    { id: 'stop', type: 'gate' },
  ],
  outputs: [
    // The three row CV outputs (pot × range multiplier).
    { id: 'row1', type: 'cv' },
    { id: 'row2', type: 'cv' },
    { id: 'row3', type: 'cv' },
    // Clock pulse per column advance (~10 ms high), for chaining.
    { id: 'clock_out', type: 'gate' },
  ],
  params: [
    ...STEP_POT_PARAMS,
    ...RANGE_PARAMS,
    ...MODE_PARAMS,
    { id: 'rate', label: 'Rate', defaultValue: 2, min: 0.1, max: 20, curve: 'log', units: 'Hz' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const nodeId = node.id;

    // --- Row CV + clock-out ConstantSources (sequencer.ts output pattern) ---
    const row1Src = ctx.createConstantSource();
    const row2Src = ctx.createConstantSource();
    const row3Src = ctx.createConstantSource();
    const clockOutSrc = ctx.createConstantSource();
    const rowSrcs = [row1Src, row2Src, row3Src];
    for (const s of rowSrcs) s.offset.value = 0;
    clockOutSrc.offset.value = 0;
    row1Src.start();
    row2Src.start();
    row3Src.start();
    clockOutSrc.start();

    // --- Gate-input edge detectors (clock / start / stop) -------------------
    // Each gate input is a GainNode patch port feeding an AnalyserNode the tick
    // polls for rising edges. A silent ConstantSource keeps each port live in
    // the graph even when nothing is patched in (sequencer.ts's clockInSilence
    // trick). The analyser ring is widened to 16384 (~341 ms @ 48 kHz) so main-
    // thread stalls don't drop edges — same headroom sequencer.ts uses.
    const GATE_THRESHOLD = 0.5;
    interface GatePort {
      gain: GainNode;
      analyser: AnalyserNode;
      buffer: Float32Array<ArrayBuffer>;
      silence: ConstantSourceNode;
      lastSample: number;
      lastTime: number;
    }
    function makeGatePort(): GatePort {
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 16384;
      gain.connect(analyser);
      const silence = ctx.createConstantSource();
      silence.offset.value = 0;
      silence.start();
      silence.connect(gain);
      return {
        gain,
        analyser,
        buffer: new Float32Array(analyser.fftSize),
        silence,
        lastSample: 0,
        lastTime: ctx.currentTime,
      };
    }
    const clockPort = makeGatePort();
    const startPort = makeGatePort();
    const stopPort = makeGatePort();

    /** Count rising edges that arrived on a gate port since the last tick.
     *  Mirrors sequencer.ts's external-clock edge scan (inspect only the
     *  samples that landed since the last read to avoid double-counting). */
    function countRisingEdges(port: GatePort): number {
      port.analyser.getFloatTimeDomainData(port.buffer);
      const nowAt = ctx.currentTime;
      const elapsed = nowAt - port.lastTime;
      const newSamples = Math.min(
        port.buffer.length,
        Math.max(1, Math.ceil(elapsed * ctx.sampleRate)),
      );
      const start = port.buffer.length - newSamples;
      let edges = 0;
      let prev = port.lastSample;
      for (let i = start; i < port.buffer.length; i++) {
        const cur = port.buffer[i] ?? 0;
        if (prev < GATE_THRESHOLD && cur >= GATE_THRESHOLD) edges++;
        prev = cur;
      }
      port.lastSample = prev;
      port.lastTime = nowAt;
      return edges;
    }

    // --- Stepper + transport state -----------------------------------------
    const stepper = new Seq960Stepper();
    const playhead = createPlayheadTracker();
    let running = false;
    let nextStepTime = ctx.currentTime + 0.05;
    let alive = true;
    let unsubscribeTick: (() => void) | null = null;
    let totalAdvances = 0;
    // Mirror of the most-recently-written row CV (for tests / introspection,
    // since AudioParam.value isn't reliably observable right after a
    // setValueAtTime from the JS thread).
    const lastRowCv = new Array<number>(SEQ960_ROWS).fill(0);

    function readParam(id: string, fallback: number): number {
      const live = livePatch.nodes[nodeId];
      const v = live?.params?.[id];
      return typeof v === 'number' ? v : fallback;
    }
    function readModes(): number[] {
      return MODE_PARAMS.map((p) => readParam(p.id, 0));
    }
    function isClockConnected(): boolean {
      return isInputPortConnected(Object.values(livePatch.edges), nodeId, 'clock');
    }

    function emitClockPulse(atTime: number): void {
      clockOutSrc.offset.setValueAtTime(1, atTime);
      clockOutSrc.offset.setValueAtTime(0, atTime + 0.01);
    }

    /** Write the three rows' CV for column `col` at `atTime`, emit the clock
     *  pulse, and record the playhead position. */
    function emitColumn(col: number, atTime: number): void {
      emitClockPulse(atTime);
      playhead.schedule(col, atTime);
      for (let r = 0; r < SEQ960_ROWS; r++) {
        const pot = readParam(stepPotId(r + 1, col + 1), 0.5);
        const range = readParam(`range${r + 1}`, 0);
        const cv = rowOutput(pot, range);
        rowSrcs[r]!.offset.setValueAtTime(cv, atTime);
        lastRowCv[r] = cv;
      }
    }

    /** (Re)start the transport at column 0 and immediately present column 0's
     *  CV. */
    function startTransport(): void {
      stepper.reset();
      playhead.reset();
      running = true;
      nextStepTime = ctx.currentTime + 0.05;
      // Present column 0 right away so the rows hold the first column's CV.
      emitColumn(stepper.column, ctx.currentTime + 0.005);
    }

    function stopTransport(): void {
      running = false;
      // Hold the current CV (analog 960 holds its last column). Just stop
      // advancing; cancel any queued clock pulse so a downstream chain isn't
      // nudged after we halt.
      clockOutSrc.offset.cancelScheduledValues(ctx.currentTime);
      clockOutSrc.offset.setValueAtTime(0, ctx.currentTime);
    }

    /** Advance one column (honoring modes); halt if it lands on STOP. */
    function advanceOne(atTime: number): void {
      const res = stepper.advance(readModes());
      emitColumn(res.column, atTime);
      totalAdvances++;
      if (res.stopped) {
        // Landed on a STOP column: hold here. We've already presented its CV;
        // just stop running so no further advances happen until restart.
        running = false;
      }
    }

    function tick(): void {
      if (!alive) return;
      try {
        // Transport gates: a rising edge on start runs; on stop halts. Drained
        // every tick regardless of running state so a start gate can wake a
        // halted sequencer.
        const startEdges = countRisingEdges(startPort);
        const stopEdges = countRisingEdges(stopPort);
        if (stopEdges > 0) stopTransport();
        if (startEdges > 0) startTransport();

        // Clock edges are always consumed (so the detector's lastSample stays
        // current even when not running); they only advance while running.
        const externalClock = isClockConnected();
        const clockEdges = countRisingEdges(clockPort);

        if (!running) return;

        if (externalClock) {
          // External-clock mode: one column per observed rising edge (the
          // sequencer.ts external-clock contract). Each advance is scheduled a
          // render-quantum into the future for audio-thread headroom.
          for (let i = 0; i < clockEdges && running; i++) {
            advanceOne(ctx.currentTime + 0.005);
          }
        } else {
          // Internal-rate mode: a simple periodic scheduler off the shared
          // tick. `rate` is in Hz (steps per second). No lookahead queue (one
          // advance per period is plenty for a CV sequencer; the row CV is a
          // held level, not a sample-accurate gate), but we advance for every
          // period elapsed since the last tick so we don't lose tempo under
          // main-thread stalls.
          const rate = Math.max(0.01, readParam('rate', 2));
          const period = 1 / rate;
          // Guard against a pathological burst if the tab was backgrounded for
          // a long time: cap catch-up advances per tick.
          let guard = 0;
          while (running && nextStepTime <= ctx.currentTime && guard < 64) {
            advanceOne(Math.max(nextStepTime, ctx.currentTime));
            nextStepTime += period;
            guard++;
          }
          // If we fell far behind (or rate just changed), re-anchor.
          if (nextStepTime < ctx.currentTime) nextStepTime = ctx.currentTime + period;
        }
      } catch (err) {
        console.error('[moog960] tick error', err);
      }
    }

    unsubscribeTick = getSchedulerClock().subscribe(tick);

    // Auto-run on spawn (like the repo `sequencer`): present column 0 and start
    // the internal-rate transport immediately, so a freshly-added 960 outputs
    // stepped CV without needing an external START gate. A patched `start`
    // re-zeros + restarts; `stop` (or a STOP column) halts holding the last CV.
    startTransport();

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['clock', { node: clockPort.gain, input: 0 }],
        ['start', { node: startPort.gain, input: 0 }],
        ['stop', { node: stopPort.gain, input: 0 }],
      ]),
      outputs: new Map([
        ['row1', { node: row1Src, output: 0 }],
        ['row2', { node: row2Src, output: 0 }],
        ['row3', { node: row3Src, output: 0 }],
        ['clock_out', { node: clockOutSrc, output: 0 }],
      ]),
      setParam(_paramId, _value) {
        // No AudioParam to write — the tick reads node.params each iteration,
        // so knob changes (pots / ranges / modes / rate) are picked up live.
      },
      readParam(paramId) {
        const live = livePatch.nodes[nodeId];
        const v = live?.params?.[paramId];
        return typeof v === 'number' ? v : undefined;
      },
      read(key) {
        // The raw pointer position (where the playhead actually is right now).
        if (key === 'currentColumn') return stepper.column;
        // Lag-compensated "sounding now" column for the visual indicator: the
        // most recent column whose scheduled CV-write time has passed. Cards
        // poll this so a fast internal rate doesn't show the next column early.
        if (key === 'soundingColumn') return playhead.currentAt(ctx.currentTime);
        if (key === 'isRunning') return running;
        if (key === 'totalAdvances') return totalAdvances;
        if (typeof key === 'string' && key.startsWith('rowCv:')) {
          const i = Number.parseInt(key.slice('rowCv:'.length), 10);
          return Number.isFinite(i) && i >= 0 && i < SEQ960_ROWS ? lastRowCv[i] : undefined;
        }
        return undefined;
      },
      dispose() {
        alive = false;
        if (unsubscribeTick) { unsubscribeTick(); unsubscribeTick = null; }
        for (const s of rowSrcs) {
          try { s.stop(); } catch { /* already stopped */ }
        }
        try { clockOutSrc.stop(); } catch { /* already stopped */ }
        for (const port of [clockPort, startPort, stopPort]) {
          try { port.silence.stop(); } catch { /* already stopped */ }
          port.silence.disconnect();
          port.gain.disconnect();
          port.analyser.disconnect();
        }
        for (const s of rowSrcs) s.disconnect();
        clockOutSrc.disconnect();
      },
    };
  },
};
