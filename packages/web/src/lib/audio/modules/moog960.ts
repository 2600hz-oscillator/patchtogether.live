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

// ⚠ RANGE and MODE are `0..2 discrete` — THREE states across a whole dial, which
// is the moog962 SELECTABILITY TRAP: a knob quantises a drag back to where it
// started, so the control is inert in practice. An `options` roster makes
// `paramCellKind` derive a SEGMENTED cell instead, where every state is one
// click. The labels are the hardware's own names, taken from this def's
// `docs.explanation` and per-control text — nothing invented.
const RANGE_OPTIONS = [
  { value: 0, label: '×1', title: 'Row CV passes at unity — the pot value is the output' },
  { value: 1, label: '×2', title: 'Row CV doubled — the same pattern over twice the span' },
  { value: 2, label: '×4', title: 'Row CV quadrupled — the widest sweep this row can make' },
] as const;

const MODE_OPTIONS = [
  { value: 0, label: 'NORM', title: 'Normal — the pointer plays this column and moves on' },
  { value: 1, label: 'SKIP', title: 'Skip — the pointer jumps past this column without playing it' },
  { value: 2, label: 'STOP', title: 'Stop — the pointer halts here, holding this column on all three rows' },
] as const;

const RANGE_PARAMS = [1, 2, 3].map((row) => ({
  id: `range${row}`,
  label: `Range ${row}`,
  defaultValue: 0,
  min: 0,
  max: 2,
  curve: 'discrete' as const,
  options: RANGE_OPTIONS.map((o) => ({ ...o })),
}));

const MODE_PARAMS = Array.from({ length: SEQ960_COLUMNS }, (_, i) => ({
  id: `mode${i + 1}`,
  label: `Mode ${i + 1}`,
  defaultValue: 0,
  min: 0,
  max: 2,
  curve: 'discrete' as const,
  options: MODE_OPTIONS.map((o) => ({ ...o })),
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

  inputs: [
    // External clock: rising edge advances one column. Unpatched → internal
    // `rate` drives (sequencer.ts's clock-vs-internal fallback).
    { id: 'clock', type: 'gate', edge: 'trigger' },
    // Transport gates: rising edge starts / halts the run.
    { id: 'start', type: 'gate', edge: 'trigger' },
    { id: 'stop', type: 'gate', edge: 'trigger' },
  ],
  outputs: [
    // The three row CV outputs (pot × range multiplier).
    { id: 'row1', type: 'cv' },
    { id: 'row2', type: 'cv' },
    { id: 'row3', type: 'cv' },
    // Clock pulse per column advance (~10 ms high), for chaining.
    { id: 'clock_out', type: 'gate', edge: 'trigger' },
  ],
  params: [
    ...STEP_POT_PARAMS,
    ...RANGE_PARAMS,
    ...MODE_PARAMS,
    { id: 'rate', label: 'Rate', defaultValue: 2, min: 0.1, max: 20, curve: 'log', units: 'Hz' },
  ],

  docs: {
    explanation:
      "A clean-room recreation of the Moog 960 Sequential Controller — the System 55's analog step sequencer. It's a 3-row × 8-column grid of knobs: a single shared column pointer sweeps the 8 columns (steps), and on each advance every row outputs its current column's knob value as a held control voltage on ROW 1/2/3 OUT. So one pass of the sequence produces three parallel CV streams (e.g. ROW 1 → oscillator pitch, ROW 2 → filter cutoff, ROW 3 → VCA level), all stepping in lockstep. The pointer advances on each rising edge of an external CLOCK, or, when CLOCK is unpatched, at the internal RATE. Per-row RANGE switches scale that row's CV (×1/×2/×4), and a per-COLUMN MODE switch can make a step SKIP (jump past it) or STOP (halt holding that column) for non-linear patterns. A clock pulse is emitted on CLOCK OUT each advance for chaining. It auto-runs on placement. Mental model: three knob-banks read out a column at a time, like three sequencers sharing one playhead. Drive it from a clock (or its own internal rate) and patch the row outputs as stepped modulation/pitch.",
    inputs: {
      clock:
        "External clock: each rising edge advances the column pointer exactly one step. While anything is patched here the internal RATE is ignored and the incoming pulses set the pace; unpatch to fall back to the RATE knob.",
      start: "A rising edge starts the sequencer running from column 1 (re-zeros the pointer and resumes advancing).",
      stop: "A rising edge halts the sequencer; the pointer and the three row CVs hold their last column's values (an analog hold, not a reset).",
    },
    outputs: {
      row1: "Row 1's stepped control voltage: the current column's ROW 1 knob value, scaled by RANGE 1, held until the next advance. Patch it as pitch CV or any per-step modulation.",
      row2: "Row 2's stepped control voltage: the current column's ROW 2 knob value × RANGE 2, held between steps.",
      row3: "Row 3's stepped control voltage: the current column's ROW 3 knob value × RANGE 3, held between steps.",
      clock_out: "A short (~10 ms) pulse fired on every column advance — the 'I just stepped' signal. Patch it into another sequencer's clock to chain them in lockstep.",
    },
    controls: {
      // Step pots: 3 rows × 8 columns. Each holds that step's level for its row.
      r1s1: "Row 1, step 1 level: the CV row 1 outputs when the pointer is on column 1 (0..1, before the RANGE 1 multiplier).",
      r1s2: "Row 1, step 2 level — row 1's output on column 2.",
      r1s3: "Row 1, step 3 level — row 1's output on column 3.",
      r1s4: "Row 1, step 4 level — row 1's output on column 4.",
      r1s5: "Row 1, step 5 level — row 1's output on column 5.",
      r1s6: "Row 1, step 6 level — row 1's output on column 6.",
      r1s7: "Row 1, step 7 level — row 1's output on column 7.",
      r1s8: "Row 1, step 8 level — row 1's output on column 8.",
      r2s1: "Row 2, step 1 level: the CV row 2 outputs on column 1 (0..1, before RANGE 2).",
      r2s2: "Row 2, step 2 level — row 2's output on column 2.",
      r2s3: "Row 2, step 3 level — row 2's output on column 3.",
      r2s4: "Row 2, step 4 level — row 2's output on column 4.",
      r2s5: "Row 2, step 5 level — row 2's output on column 5.",
      r2s6: "Row 2, step 6 level — row 2's output on column 6.",
      r2s7: "Row 2, step 7 level — row 2's output on column 7.",
      r2s8: "Row 2, step 8 level — row 2's output on column 8.",
      r3s1: "Row 3, step 1 level: the CV row 3 outputs on column 1 (0..1, before RANGE 3).",
      r3s2: "Row 3, step 2 level — row 3's output on column 2.",
      r3s3: "Row 3, step 3 level — row 3's output on column 3.",
      r3s4: "Row 3, step 4 level — row 3's output on column 4.",
      r3s5: "Row 3, step 5 level — row 3's output on column 5.",
      r3s6: "Row 3, step 6 level — row 3's output on column 6.",
      r3s7: "Row 3, step 7 level — row 3's output on column 7.",
      r3s8: "Row 3, step 8 level — row 3's output on column 8.",
      // Per-row range switches.
      range1: "Row 1 RANGE: scales row 1's whole output — ×1 (0..1), ×2 (0..2), or ×4 (0..4). Use it to widen ROW 1's CV span (e.g. more octaves of pitch).",
      range2: "Row 2 RANGE: ×1 / ×2 / ×4 multiplier on row 2's output span.",
      range3: "Row 3 RANGE: ×1 / ×2 / ×4 multiplier on row 3's output span.",
      // Per-column mode switches.
      mode1: "Column 1 MODE: NORMAL (play this step), SKIP (jump straight past it), or STOP (halt holding this column when the pointer lands here).",
      mode2: "Column 2 MODE: NORMAL / SKIP / STOP.",
      mode3: "Column 3 MODE: NORMAL / SKIP / STOP.",
      mode4: "Column 4 MODE: NORMAL / SKIP / STOP.",
      mode5: "Column 5 MODE: NORMAL / SKIP / STOP.",
      mode6: "Column 6 MODE: NORMAL / SKIP / STOP.",
      mode7: "Column 7 MODE: NORMAL / SKIP / STOP.",
      mode8: "Column 8 MODE: NORMAL / SKIP / STOP — set this to make column 8 the loop's last step (STOP) or to shorten the run (earlier STOP/SKIP columns).",
      rate: "Internal clock speed in Hz (steps per second), used only when nothing is patched into CLOCK IN; an external clock overrides it.",
    },
  },

  // ── PF-20 — THE FACEPLATE ────────────────────────────────────────────────
  // DECLARATION ONLY: `face` is not projected by contract-signature.ts, so none
  // of this moves the contract golden.
  //
  // Every key below is DERIVED from the same builders that produce the params,
  // so the face cannot drift out of sync with SEQ960_ROWS / SEQ960_COLUMNS and
  // there is no hand-typed population anywhere in it. Changing the DSP's grid
  // size re-shapes the faceplate for free.
  face: {
    // RANK ORDER. Ranks 1-6 are the entire LANE budget (mini 1 · compact 3
    // without a glyph · plate 6); rank 7+ is dock-only. RATE then the three
    // RANGE switches is the honest six: RATE is the only param that is not part
    // of the grid, and RANGE is what decides how far each row's pattern
    // actually travels. A lane tile showing two arbitrary step pots out of 24
    // would say nothing about the sequence.
    order: [
      'rate',
      ...RANGE_PARAMS.map((p) => p.id),
      ...STEP_POT_PARAMS.map((p) => p.id),
      ...MODE_PARAMS.map((p) => p.id),
    ],

    // SIX BANDS — one per IDEA, and deliberately UNDER `DOCK_TAB_MIN_BANDS = 7`,
    // so this face renders as one column and NOT as a tab rail. That is the
    // correct outcome, not a near miss: the three row banks are the same idea
    // three times over and a player reads them together, so splitting them
    // across tabs would hide two thirds of the sequence at all times. Do not
    // add a seventh page to force the rail.
    pages: [
      {
        id: 'clock',
        label: 'clock',
        hint:
          'RATE is the internal clock in steps per second, and it is used ONLY while nothing is '
          + 'patched into CLOCK IN — an external clock overrides it completely. The module '
          + 'auto-runs on placement.',
        controls: ['rate'],
      },
      {
        id: 'ranges',
        label: 'row range',
        hint:
          'Per-row output scaling: each row CV is its current step pot × this multiplier. It sets '
          + 'how far that row travels, not its shape — the pattern is unchanged, the span is not.',
        controls: RANGE_PARAMS.map((p) => p.id),
      },
      ...Array.from({ length: SEQ960_ROWS }, (_, r) => ({
        id: `bank${r + 1}`,
        label: `row ${r + 1}`,
        hint:
          `Row ${r + 1}'s eight step levels. On each advance this row outputs its current column's `
          + `value on ROW ${r + 1} OUT and HOLDS it until the next step — an analog sample-and-hold, `
          + 'not a ramp. All three rows share one column pointer, so they step in lockstep.',
        controls: STEP_POT_PARAMS.slice(r * SEQ960_COLUMNS, (r + 1) * SEQ960_COLUMNS).map((p) => p.id),
      })),
      {
        id: 'stepmode',
        label: 'step mode',
        hint:
          'Per-COLUMN behaviour, applied to all three rows at once because they share the pointer. '
          + 'SKIP jumps past a column; STOP halts on it. An early STOP is how you shorten the run '
          + 'to fewer than eight steps.',
        controls: MODE_PARAMS.map((p) => p.id),
        // CLUSTERED INTO HALVES — this band, not the knob rows, is what
        // overflowed the plate. These are SEGMENTED cells: each one paints
        // three option labels (NORM/SKIP/STOP), so a mode cell is far wider
        // than a knob cell, and eight of them in one row is the widest thing on
        // the face. Splitting them into two rows of four is the moog984
        // `clusters` mechanism doing exactly what it exists for, and the labels
        // name real columns rather than inventing a grouping.
        clusters: [
          { label: 'cols 1-4', controls: MODE_PARAMS.slice(0, 4).map((p) => p.id) },
          { label: 'cols 5-8', controls: MODE_PARAMS.slice(4).map((p) => p.id) },
        ],
      },
    ],

    // BARE STEP POTS — the caption is redundant TWICE OVER, and dropping it is
    // what makes this plate fit. Measured: with `R1·1`..`R3·8` captioned, the
    // dock faceplate is 1336 CSS px of content against a 1220 px capture box —
    // 116 px hanging off the right, which the per-face width measurement in
    // `workflow-shell-faces.spec.ts` correctly refused.
    //
    // The right response is to remove the redundancy, NOT to claim an exemption:
    // a knob grid is not one of the things that EARNS width (a live picture, a
    // scope trace, a video preview, an XY pad, a mode-exclusive control), and a
    // default that needs a new exemption per wide face is the wrong default.
    //
    // This is the mixmstrs case exactly — `1LO…8LO` under a `LOW` heading said
    // nothing the grid had not already said twice. Here the band heading says
    // `row 1`, so the `R1` half is already on screen, and the cell's POSITION in
    // a left-to-right row of eight says which step it is, which is precisely how
    // the hardware is read. ⚠ Only the TEXT goes: `label` stays on every param,
    // so the accessible name and `aria-valuetext` are untouched and no spec had
    // to be weakened.
    //
    // RANGE, MODE and RATE keep their captions — `Range 2` vs `Range 3` and
    // `Mode 5` vs `Mode 6` are the ONLY thing distinguishing otherwise identical
    // segmented cells, which is the side of the ruling that KEEPS a label.
    bareCells: STEP_POT_PARAMS.map((p) => p.id),

    // NO GLYPH, and it is a MEASURED refusal rather than an omission.
    // `glyphBinding` resolves 'scope'/'meter'/'waveform' through
    // `primaryAudioOutPortId`, and this module's outputs are `cv` + `gate` only;
    // 'envelope' needs attack/decay/sustain/release; 'algorithm' needs an
    // `algorithm` param or an extension. This def matches none of them, so ANY
    // glyph here would fall through to `{ kind: 'static' }` — a deterministic
    // trace that is the same picture on every sequencer and tracks nothing this
    // module does. Declaring 'none' says that on purpose AND buys the compact
    // tier a third control (2 with a glyph, 3 without).
    glyph: 'none',

    title: 'Sequencer',
    hint:
      'Three knob banks reading out ONE column at a time — the System 55 step sequencer. A single '
      + 'shared pointer sweeps eight columns and every row emits its current column as a held CV, '
      + 'so one pass produces three parallel stepped modulations from one playhead.',

    // NO HERO, AND THE LINT IS WHY — this is a corrected design, not an
    // omission. `hero: { control: 'rate' }` was the obvious choice (RATE is the
    // one knob a hand rides on a running sequencer) and it is WRONG here:
    // `heroFacePlan` MOVES the promoted key out of its band, RATE was the only
    // control in the `clock` band, so the band emptied, `heroFacePlan` dropped
    // it, and the band hint authored above it rendered NOWHERE. The lint caught
    // exactly that ("authored, reviewed and rendered nowhere").
    //
    // Promoting it would need RATE to share a band with something it is not
    // related to, purely to survive its own promotion. A grid sequencer's
    // identity is the GRID, not one dial, so the honest face has no hero and
    // RATE keeps its own band and its own explanation.

    // REAR CARD. Three groups, and the ids are load-bearing: a curated rear
    // group must claim the LEADING slot ('voice'/'signal') or name a DECLARED
    // PAGE ID, or it appends as a stray band that the totality gate cannot see.
    // The two non-leading groups therefore name real pages, and the pairing is
    // meaningful rather than a formality — RANGE is precisely what scales the
    // three row outputs, and RATE is what CLOCK OUT pulses at when nothing is
    // driving CLOCK IN.
    //
    // ⚠ `direction` defaults to 'input'; every output group must say so
    // explicitly or it resolves to no port and the section never renders.
    // ⚠ No page here is named 'signal' or 'voice', so the leading slot cannot
    // collide with a page and render that band twice (the dx7 scar).
    rear: {
      groups: [
        { id: 'signal', label: 'transport', ports: ['clock', 'start', 'stop'] },
        { id: 'ranges', label: 'row outs', ports: ['row1', 'row2', 'row3'], direction: 'output' },
        { id: 'clock', label: 'clock out', ports: ['clock_out'], direction: 'output' },
      ],
    },
  },

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
