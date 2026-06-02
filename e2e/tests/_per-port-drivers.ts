// e2e/tests/_per-port-drivers.ts
//
// Per-module test-driver registry for the per-port output-emit sweep.
//
// This file replaces the old `EXEMPT_OUTPUT_EMIT_MODULES` quasi-exemption
// list with ACTIVE drivers — category-appropriate setup that synthesizes
// the trigger each module needs to produce output, so the per-port sweep
// can run its signal-flow assertion instead of giving up.
//
// Categories handled here:
//
//   * Hardware-input modules (GAMEPAD, JOYSTICK, NUMPAD+):
//       Inject `navigator.getGamepads()` polyfill via addInitScript;
//       set joystick `pos_x` / `pos_y` to nonzero; dispatch synthetic
//       numpad keydown events.
//
//   * MIDI-driven modules (MIDICLOCK, MIDICVBUDDY):
//       Mock `navigator.requestMIDIAccess` with a synthetic input device,
//       then dispatch 0xFA (start) / 0xF8 (clock) / 0x90 (note-on) into
//       the device's onmidimessage handler via a queued sender.
//
//   * Clock / divider / sequencer-like modules with internal self-running
//     state (TIMELORDE, MARBLES, SYMBIOTE, GRIDS, STAGES, TIDES2):
//       Seed isPlaying-equivalent params or trig pulse via SEQUENCER, and
//       lean on the module's internal RNG / clock to produce edges.
//
//   * Step-sequencers needing pre-toggled steps (SEQUENCER, SCORE,
//     DRUMSEQZ, POLYSEQZ, MACSEQ, HYDROGEN):
//       Seed node.data.steps (or .tracks) with on=true entries and set
//       isPlaying=1. The internal scheduler picks them up.
//
//   * Pure CV/gate utility (ILLOGIC, SLEWSWITCH):
//       Wire upstream BUGGLES.smooth into in1/in2 + SEQUENCER.gate into
//       step_clock so the outputs become non-trivial functions of live
//       inputs.
//
//   * Modulators (ADSR): drive `gate` from SEQUENCER.gate.
//
//   * VIDEOOUT (passthrough sink): wire upstream ACIDWARP.out into `in`
//     so the `out` passthrough port emits a non-blank frame.
//
// Anything NOT here uses the default driver path (the module must self-
// run from defaults).
//
// What stays exempt (re-stated comments in the spec):
//   * Game modules whose outputs ONLY fire on in-game events that take
//     many cycles to reach (MODTRIS line clears; PONG scores). These
//     get a clearer cross-reference to their dedicated specs.
//   * File-input modules (VIDEOBOX, VIDEOVARISPEED, SAMSLOOP) — a
//     synthetic blob does work for the unit-test infra but the e2e path
//     decoder pipeline is too heavyweight to seed inline; covered by the
//     module-dedicated specs that already build a small fixture file.

import type { Page } from '@playwright/test';
import type { SpawnNode, SpawnEdge } from './_helpers';

// ────────── Driver shape ──────────

export interface ExtraGraph {
  /** Extra nodes to spawn alongside the SUT. Wired up via extraEdges. */
  nodes: SpawnNode[];
  /** Extra edges. The sut→sink edge is supplied by the spec; these are
   *  upstream-source → SUT edges. */
  edges: SpawnEdge[];
}

export interface PerPortDriver {
  /** Initial params written into the SUT node. Examples: `isPlaying: 1`,
   *  `pos_x: 0.7` (joystick), `running: 1` (timelorde). */
  params?: Record<string, number>;
  /** Initial `node.data` written into the SUT node. Used to seed
   *  sequencer steps, hydrogen tracks, etc. */
  data?: Record<string, unknown>;
  /** Extra upstream-source nodes + edges to drive an input the SUT
   *  needs. Spec adds these to the SUT-and-sink graph. */
  upstream?: (sutId: string) => ExtraGraph;
  /** Page-side initialization to run BEFORE `page.goto('/')` — mocks
   *  for navigator.getGamepads, navigator.requestMIDIAccess, etc.
   *  Receives the page so it can call addInitScript(). */
  pageSetup?: (page: Page) => Promise<void>;
  /** Post-spawn driver: runs AFTER spawnPatch + before the wait window.
   *  Useful for dispatching synthetic key/MIDI events that the engine
   *  picks up. Receives the page + SUT id. */
  postSpawn?: (page: Page, sutId: string) => Promise<void>;
  /** Cross-reference for the exemption-replaced-with-driver comment. */
  note?: string;
}

// ────────── Helpers shared by drivers ──────────

/** A self-running gate source: SEQUENCER with isPlaying=1 + steps on. */
function sequencerGate(seqId = 'drv-seq'): { node: SpawnNode; data: Record<string, unknown> } {
  return {
    node: {
      id: seqId,
      type: 'sequencer',
      position: { x: 60, y: 60 },
      domain: 'audio',
      params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 },
    },
    data: {
      steps: [
        { on: true, midi: 60 },
        { on: true, midi: 64 },
        { on: true, midi: 67 },
        { on: true, midi: 72 },
      ],
    },
  };
}

/** Continuous CV source — BUGGLES.smooth, self-running random walk. */
function bugglesCv(bId = 'drv-bug'): SpawnNode {
  return { id: bId, type: 'buggles', position: { x: 60, y: 60 }, domain: 'audio' };
}

/** Continuous audio source — NOISE.white, self-running broadband signal. */
function noiseAudio(nId = 'drv-noise'): SpawnNode {
  return { id: nId, type: 'noise', position: { x: 60, y: 60 }, domain: 'audio', params: { level: 0.6 } };
}

// ────────── Per-module drivers ──────────
//
// Use sparse keys — modules not listed fall through to the default
// (no extra params/data, no upstream, no setup). Each entry's `note`
// is what the spec logs when the driver runs (debug-time breadcrumb).

const DRIVERS: Record<string, PerPortDriver> = {
  // ───── Self-running modules whose old exemption was wrong ─────
  //
  // TIMELORDE: default `running=1` already spins the internal clock; the
  // 1x/2x/4x/etc gate outputs pulse without any input. The 1/2..1/64
  // outputs are SLOW (1/8 = 8 beats = 4 seconds at default BPM 120) so
  // we crank BPM to 300 to fit at least one pulse from every output
  // inside the poll budget. At 300 BPM, 1/64 still has a 12.8 s period
  // — see comment below; we accept the trade-off and pin 1/64 as a
  // sub-port exemption inline (the poll budget covers up to 1/16 ≈ 3.2 s).
  timelorde: {
    params: { bpm: 300, running: 1, muteOutputs: 0 },
    note: 'TIMELORDE: bump bpm to 300; fits up to 1/16 inside poll budget',
  },
  //
  // MARBLES: worklet with internal RNG → t1/t2 pulse + x1/x2/x3 walk
  // even with no input edges. Default rate=0 = ~1 Hz click; bump rate to
  // get a faster pulse train.
  marbles: {
    params: { rate: 36, t_bias: 0.5, t_jitter: 0 },
    note: 'MARBLES: bump rate to 36 semitones (~8x default) so t1/t2 fire ≥10 Hz',
  },
  //
  // SYMBIOTE: same shape as MARBLES — self-running worklet.
  symbiote: {
    // rate=36: master clock at ~8× default so t/x outputs fire many times per
    // second. bd_density/sd_density/hh_density at max so every step fires
    // (t1/t2/t3 are probabilistic at default 0.5 densities). acid_density=1
    // keeps the TB-3PO gate always open (needed for x3 + y). transpose=7
    // semitones ensures x2 (pitch) is offset from 0V → passes scope floor.
    params: {
      rate: 36,
      bd_density: 1, sd_density: 1, hh_density: 1,
      acid_density: 1, transpose: 7,
    },
    note: 'SYMBIOTE: rate=36 + max densities + transpose=7; t1/t2/t3/x1/x2/x3/y all emit',
  },
  //
  // GRIDS: isPlaying default 1 + internal tempo. Crank tempo to fit
  // all 5 outputs into the poll budget.
  grids: {
    params: { tempo: 300, isPlaying: 1, bdDensity: 1, sdDensity: 1, hhDensity: 1 },
    note: 'GRIDS: tempo 300 + max densities; bd/sd/hh fire ~5x per second',
  },
  //
  // TIDES2: rampMode default + range=0 LFO → outputs sweep. Crank
  // frequency.
  tides2: {
    params: { frequency: 0.9, rampMode: 1 /* LOOP */, outputMode: 2 /* PHASE */ },
    note: 'TIDES2: high freq + LOOP mode + PHASE output; out0..3 sweep',
  },

  // STAGES: needs a TRIG pulse to start a segment. Use SEQUENCER.gate
  // → STAGES.trig (the global TRIG fires every chain group's leader).
  // primary0..5 default 0.3 makes the rampers actually move.
  stages: {
    upstream: () => ({
      nodes: [sequencerGate('drv-seq').node],
      edges: [
        {
          id: 'e-drv-trig',
          from: { nodeId: 'drv-seq', portId: 'gate' },
          to:   { nodeId: 'sut',     portId: 'trig' },
          sourceType: 'gate',
          targetType: 'gate',
        },
      ],
    }),
    postSpawn: async (page) => {
      // Seed sequencer steps so it actually fires (default steps are all off).
      const seed = sequencerGate('drv-seq');
      await page.evaluate((d) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          const n = w.__patch.nodes['drv-seq'];
          if (!n) return;
          if (!n.data) n.data = {};
          n.data.steps = d.steps;
        });
      }, seed.data);
    },
    note: 'STAGES: drive .trig with SEQUENCER.gate; segment outputs ramp to default primary',
  },

  // ───── Step sequencers — seed steps + isPlaying ─────
  sequencer: {
    params: { isPlaying: 1, length: 4, bpm: 240, gateLength: 0.5 },
    data: { steps: [
      { on: true, midi: 60, chord: 'mono' },
      { on: true, midi: 64, chord: 'mono' },
      { on: true, midi: 67, chord: 'mono' },
      { on: true, midi: 72, chord: 'mono' },
    ] },
    note: 'SEQUENCER: pre-toggle 4 steps on + isPlaying=1; gate/pitch/clock pulse',
  },
  score: {
    params: { isPlaying: 1, bpm: 240 },
    // SCORE's score-sheet data is a notes[] array of ScoreNote objects.
    // ScoreNote shape: { id, bar, tick, duration (NoteDuration string),
    // midi, staffStep, accidental }.
    //
    // Pitfall 1: midi=60 (C4) maps to midiToVOct(60)=0 V/oct — the scope
    // peak floor is >0.005, so C4 FAILS. Use midi=72 (C5 = +1.0 V/oct).
    //
    // Pitfall 2: the old driver used { tick: 0..3 } without a `bar` field.
    // noteStartingAt() checks n.bar===bar && n.tick===tick — with bar
    // missing (undefined), the note is NEVER found. Provide bar: 0.
    //
    // Pitfall 3: duration must be a NoteDuration string ('quarter'), not 1.
    // tickWidth() would return undefined for an unknown duration and the
    // gate-off schedule would be NaN → silent.
    //
    // Use loop=true so the sequence repeats and the scope catches the pitch/gate
    // pulse within the 1.2s budget even with scheduler startup latency.
    data: {
      loop: true,
      notes: [
        { id: 'n1', bar: 0, tick: 0,  duration: 'quarter', midi: 72, staffStep: 0, accidental: null },
        { id: 'n2', bar: 0, tick: 12, duration: 'quarter', midi: 76, staffStep: 2, accidental: null },
        { id: 'n3', bar: 0, tick: 24, duration: 'quarter', midi: 79, staffStep: 4, accidental: null },
        { id: 'n4', bar: 0, tick: 36, duration: 'quarter', midi: 81, staffStep: 5, accidental: null },
      ],
    },
    note: 'SCORE: seed proper ScoreNote objects (midi=72+, bar=0, duration=quarter, loop=true) + isPlaying=1; pitch/gate/env/clock emit',
  },
  drumseqz: {
    // trk{N}_euclid params are only applied to data.tracks by the card UI
    // (DrumseqzCard.applyEuclidean) — setting them in params alone does not
    // populate data.tracks, which remains all-off. Seed data.tracks directly:
    // each track has every 4th step on (steps 0, 4, 8, …, 124 across 128 steps)
    // so gate{1..4} fire on the first step and pitch{1..4} emit the track-root
    // fallthrough (trk{N}_root default C3 = MIDI 48 = -1.0 V/oct, |abs| > 0.005).
    params: {
      isPlaying: 1, length: 16, bpm: 240, gateLength: 0.5,
    },
    data: {
      tracks: (() => {
        const ON: { on: boolean; midi: null } = { on: true, midi: null };
        const OFF: { on: boolean; midi: null } = { on: false, midi: null };
        // 4 tracks × 128 steps (STEP_COUNT). Steps 0, 4, 8, 12 on — Bjorklund
        // 4/16 pattern, repeated across all 8 pages. At bpm=240 these fire
        // within the first 200ms lookahead, well inside the 1.2s gate budget.
        return Array.from({ length: 4 }, () =>
          Array.from({ length: 128 }, (_, i) => (i % 4 === 0 ? ON : OFF))
        );
      })(),
    },
    note: 'DRUMSEQZ: seed data.tracks with 4-of-16 pattern on all 4 tracks + isPlaying=1; gate{1..4} pulse',
  },
  polyseqz: {
    params: { isPlaying: 1, length: 4, bpm: 240, gateLength: 0.6 },
    data: { steps: [
      { on: true, root: 60, quality: 'maj', inversion: 0, voicing: 'closed' },
      { on: true, root: 65, quality: 'maj', inversion: 0, voicing: 'closed' },
      { on: true, root: 67, quality: 'maj', inversion: 0, voicing: 'closed' },
      { on: true, root: 72, quality: 'maj', inversion: 0, voicing: 'closed' },
    ] },
    note: 'POLYSEQZ: 4 chord steps on + isPlaying=1; poly/gate/clock pulse',
  },
  macseq: {
    params: { isPlaying: 1, length: 4, bpm: 240, gateLength: 0.5 },
    data: { steps: [
      { on: true, midi: 60, model: 0 },
      { on: true, midi: 64, model: 1 },
      { on: true, midi: 67, model: 0 },
      { on: true, midi: 72, model: 1 },
    ] },
    note: 'MACSEQ: 4 steps on + isPlaying=1; pitch/gate/modelcv/clock pulse',
  },
  hydrogen: {
    // Toggle every cell on track 0 (BD) so the kick fires on every step.
    params: { isPlaying: 1, bpm: 240, gain: 1 },
    data: {
      tracks: (() => {
        // 16 instruments × 16 steps; instruments 0 (kick) and 1 (snare)
        // both fire on every step.
        const ON = { on: true };
        const OFF = { on: false };
        return Array.from({ length: 16 }, (_, i) => {
          const cells = i < 2
            ? Array.from({ length: 16 }, () => ON)
            : Array.from({ length: 16 }, () => OFF);
          return cells;
        });
      })(),
    },
    note: 'HYDROGEN: enable kick+snare on every step + isPlaying=1; out_l/out_r emit',
  },

  // ───── Pure CV/gate utilities ─────
  // Driving with BUGGLES.smooth into in1/in2 makes sum/diff/att1/att2
  // emit signal; AND/NAND/OR/NOT need binary inputs (use SEQUENCER.gate).
  illogic: {
    // Drive all 4 inputs so att1/att2/att3/att4 + sum/diff + and/nand/or/not
    // all evaluate against non-zero signals. Two BUGGLES (smooth + stepped)
    // cover in1+in3; two SEQUENCER ports (gate + pitch lane-0) cover in2+in4.
    upstream: () => ({
      nodes: [bugglesCv('drv-bug'), sequencerGate('drv-seq').node],
      edges: [
        { id: 'e-drv-in1',
          from: { nodeId: 'drv-bug', portId: 'smooth' },
          to:   { nodeId: 'sut',     portId: 'in1' },
          sourceType: 'cv', targetType: 'cv' },
        { id: 'e-drv-in2',
          from: { nodeId: 'drv-seq', portId: 'gate' },
          to:   { nodeId: 'sut',     portId: 'in2' },
          sourceType: 'gate', targetType: 'cv' },
        { id: 'e-drv-in3',
          from: { nodeId: 'drv-bug', portId: 'stepped' },
          to:   { nodeId: 'sut',     portId: 'in3' },
          sourceType: 'cv', targetType: 'cv' },
        { id: 'e-drv-in4',
          from: { nodeId: 'drv-seq', portId: 'pitch' },
          to:   { nodeId: 'sut',     portId: 'in4' },
          sourceType: 'pitch', targetType: 'cv' },
      ],
    }),
    postSpawn: async (page) => {
      const seed = sequencerGate('drv-seq');
      await page.evaluate((d) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          const n = w.__patch.nodes['drv-seq'];
          if (!n) return;
          if (!n.data) n.data = {};
          n.data.steps = d.steps;
        });
      }, seed.data);
    },
    note: 'ILLOGIC: drive all 4 inputs (BUGGLES smooth+stepped, SEQ gate+pitch); outs are f(inputs)',
  },
  slewSwitch: {
    // Drive all 4 inputs + step_clock so out1/out2/out3/out4 all flow,
    // switched cycles the 4 sources, step_idx counts up, eoc fires.
    upstream: () => ({
      nodes: [bugglesCv('drv-bug'), sequencerGate('drv-seq').node],
      edges: [
        { id: 'e-drv-in1',
          from: { nodeId: 'drv-bug', portId: 'smooth' },
          to:   { nodeId: 'sut',     portId: 'in1' },
          sourceType: 'cv', targetType: 'cv' },
        { id: 'e-drv-in2',
          from: { nodeId: 'drv-bug', portId: 'stepped' },
          to:   { nodeId: 'sut',     portId: 'in2' },
          sourceType: 'cv', targetType: 'cv' },
        { id: 'e-drv-in3',
          from: { nodeId: 'drv-bug', portId: 'smooth' },
          to:   { nodeId: 'sut',     portId: 'in3' },
          sourceType: 'cv', targetType: 'cv' },
        { id: 'e-drv-in4',
          from: { nodeId: 'drv-bug', portId: 'stepped' },
          to:   { nodeId: 'sut',     portId: 'in4' },
          sourceType: 'cv', targetType: 'cv' },
        { id: 'e-drv-clk',
          from: { nodeId: 'drv-seq', portId: 'gate' },
          to:   { nodeId: 'sut',     portId: 'step_clock' },
          sourceType: 'gate', targetType: 'gate' },
      ],
    }),
    postSpawn: async (page) => {
      const seed = sequencerGate('drv-seq');
      await page.evaluate((d) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          const n = w.__patch.nodes['drv-seq'];
          if (!n) return;
          if (!n.data) n.data = {};
          n.data.steps = d.steps;
        });
      }, seed.data);
    },
    note: 'SLEWSWITCH: drive in1/in2 + step_clock from SEQUENCER; outs slew between inputs',
  },

  // ───── ADSR — needs a gate to fire env ─────
  adsr: {
    upstream: () => ({
      nodes: [sequencerGate('drv-seq').node],
      edges: [
        {
          id: 'e-drv-gate',
          from: { nodeId: 'drv-seq', portId: 'gate' },
          to:   { nodeId: 'sut',     portId: 'gate' },
          sourceType: 'gate', targetType: 'gate',
        },
      ],
    }),
    postSpawn: async (page) => {
      const seed = sequencerGate('drv-seq');
      await page.evaluate((d) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          const n = w.__patch.nodes['drv-seq'];
          if (!n) return;
          if (!n.data) n.data = {};
          n.data.steps = d.steps;
        });
      }, seed.data);
    },
    note: 'ADSR: drive .gate from SEQUENCER.gate; env / env_inv ramp on each note-on',
  },

  // ───── MOOG CP3 console mixer — drive in1 from NOISE.white ─────
  // CP3 is effect-shaped (audio inputs → audio out), so the sweep would
  // normally skip its output-emit. Drive in1 with a self-running NOISE.white
  // source: the summed (+) bus + its (−) inverse + the MULTIPLE (in1 fanned
  // to mult1/mult2/mult3) all carry signal at default unity knobs. The
  // ±reference outs (plus_twelve / minus_six) are constant DC and stay
  // EXEMPT_OUTPUT_EMIT (static refs — handle-presence still pins them).
  moogCp3: {
    upstream: () => ({
      nodes: [noiseAudio('drv-noise')],
      edges: [
        {
          id: 'e-drv-in1',
          from: { nodeId: 'drv-noise', portId: 'white' },
          to:   { nodeId: 'sut',       portId: 'in1' },
          sourceType: 'audio', targetType: 'audio',
        },
      ],
    }),
    note: 'MOOG CP3: drive in1 from NOISE.white; out_positive/out_negative + multiple_one/two/three emit (ref outs stay EXEMPT static refs)',
  },
  // ───── MOOG 911 EG — gate-driven contour generator (mirror ADSR) ─────
  // The 911 is a CV/gate modulator: its env / env_inv outputs only move on
  // a gate. Drive .gate from SEQUENCER.gate so the T1→peak / T2→Esus / T3
  // contour runs and both outputs emit. ESUS defaults > 0 so the sustain
  // hold keeps env nonzero across the poll window.
  moog911: {
    upstream: () => ({
      nodes: [sequencerGate('drv-seq').node],
      edges: [
        {
          id: 'e-drv-gate',
          from: { nodeId: 'drv-seq', portId: 'gate' },
          to:   { nodeId: 'sut',     portId: 'gate' },
          sourceType: 'gate', targetType: 'gate',
        },
      ],
    }),
    postSpawn: async (page) => {
      const seed = sequencerGate('drv-seq');
      await page.evaluate((d) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          const n = w.__patch.nodes['drv-seq'];
          if (!n) return;
          if (!n.data) n.data = {};
          n.data.steps = d.steps;
        });
      }, seed.data);
    },
    note: 'MOOG 911: drive .gate from SEQUENCER.gate; env / env_inv ramp on each note-on (T1→peak / T2→Esus / T3)',
  },

  // ───── SAMPLE & HOLD — drive cv_in with a moving CV + gate_in with a clock ─────
  //
  // Both outputs (cv_out / cv_quant) are HELD/STEADY CV: a constant value
  // reads as ~0 on the AC-style scope-peak floor, and with NO input cv_in
  // sits at 0 V → cv_out = 0, cv_quant = quantize(0) = 0 (the maxPeak=0.0000
  // failure). Fix by making the sampled value actually MOVE:
  //   * cv_in   ← BUGGLES.smooth  — a slow ±CV random walk (the same source
  //                                 the dedicated sample-hold.spec.ts uses).
  //   * gate_in ← SEQUENCER.gate  — a 240-BPM clock so each rising edge
  //                                 latches a NEW BUGGLES value.
  // → cv_out becomes a staircase of nonzero held DC levels that step across
  //   the poll window, and cv_quant snaps each held level to a scale note
  //   (1 V/oct, away from 0 V since BUGGLES drifts off C). The peak-hold poll
  //   loop catches the moving held value on both outputs. Mirrors the
  //   ILLOGIC / SLEWSWITCH (BUGGLES + SEQUENCER upstream) driver shape.
  sampleHold: {
    upstream: () => ({
      nodes: [bugglesCv('drv-bug'), sequencerGate('drv-seq').node],
      edges: [
        { id: 'e-drv-cvin',
          from: { nodeId: 'drv-bug', portId: 'smooth' },
          to:   { nodeId: 'sut',     portId: 'cv_in' },
          sourceType: 'cv', targetType: 'cv' },
        { id: 'e-drv-gate',
          from: { nodeId: 'drv-seq', portId: 'gate' },
          to:   { nodeId: 'sut',     portId: 'gate_in' },
          sourceType: 'gate', targetType: 'gate' },
      ],
    }),
    postSpawn: async (page) => {
      // Seed sequencer steps so it actually fires (default steps are all off).
      const seed = sequencerGate('drv-seq');
      await page.evaluate((d) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          const n = w.__patch.nodes['drv-seq'];
          if (!n) return;
          if (!n.data) n.data = {};
          n.data.steps = d.steps;
        });
      }, seed.data);
    },
    note: 'SAMPLE & HOLD: drive cv_in from BUGGLES.smooth + gate_in from SEQUENCER.gate; cv_out/cv_quant latch moving nonzero held values',
  },

  // ───── JOYSTICK — set pos_x/pos_y to nonzero ─────
  joystick: {
    params: { pos_x: 0.7, pos_y: 0.5 },
    note: 'JOYSTICK: seed pos_x=0.7, pos_y=0.5; x/y/nx/ny emit constant CV',
  },

  // ───── GAMEPAD — inject a fake getGamepads() shim ─────
  gamepad: {
    pageSetup: async (page) => {
      // Polyfill navigator.getGamepads() to return a synthetic standard-mapped
      // pad with axes + a few buttons held. GAMEPAD's rAF poll picks this up
      // every frame and pushes values into its ConstantSourceNodes.
      await page.addInitScript(() => {
        const pad = {
          id: 'Synthetic Gamepad (Playwright)',
          index: 0,
          connected: true,
          mapping: 'standard',
          timestamp: 0,
          // Stick axes: lx=+0.6, ly=-0.7 (will invert to +0.7 after the
          // module's Y-flip), rx=-0.5, ry=+0.4.
          axes: [0.6, -0.7, -0.5, 0.4],
          // 18 buttons in the standard layout; we hold A, B, X, Y, LB, RB,
          // LT (analog 0.8), RT (analog 0.3), DU, DD, DL, DR, START, BACK.
          buttons: Array.from({ length: 18 }, (_, i) => {
            const pressed = i <= 5 || (i >= 12 && i <= 15) || i === 8 || i === 9;
            const value = i === 6 ? 0.8 : i === 7 ? 0.3 : pressed ? 1 : 0;
            return { pressed, touched: pressed, value };
          }),
          vibrationActuator: null,
        };
        const orig = (navigator as unknown as { getGamepads?: () => unknown }).getGamepads;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (navigator as any).getGamepads = function getGamepadsShim() {
          // Pad in slot 0; slots 1..3 empty (null). Some browsers return
          // a fixed-length 4 array, mirror that contract.
          return [pad, null, null, null];
        };
        // Preserve original for cleanup (not used here; addInitScript runs
        // every navigation so the shim is re-installed on each goto).
        void orig;
      });
    },
    note: 'GAMEPAD: inject navigator.getGamepads() shim with sticks + buttons held; CV/gate outs emit',
  },

  // ───── NUMPAD+ — seed all 4 layers via sequencer + keydown ─────
  numpadPlus: {
    // Seed all 4 layers with on=true steps at midi=72 (C5 = +1.0 V/oct)
    // and start the sequencer. The tick loop calls applyOutputs() which
    // updates ALL 4 layers' pitch + gate outputs simultaneously based on
    // the seeded step data — so l1_pitch/gate through l4_pitch/gate all
    // emit without needing layer-specific keydowns.
    //
    // The postSpawn also dispatches Numpad2 (C#4, activeLayer=0) as
    // belt-and-suspenders for l1_pitch/gate, in case the sequencer hasn't
    // ticked yet when the scope window opens.
    //
    // Why midi=72 (C5) not midi=60 (C4): midiToVOct(60)=0 V, which fails
    // the scope peak floor (>0.005). midiToVOct(72)=+1.0 V passes cleanly.
    params: { activeLayer: 0, octave: 4, isPlaying: 1, bpm: 240 },
    data: {
      layers: (() => {
        // 4 layers × 16 steps. Step 0 on=true + midi=72 on every layer so
        // applyOutputs() sets pitch=+1.0 V/oct + gate=1 for each layer
        // on the very first tick advance.
        const ON = { on: true, midi: 72 };
        const OFF = { on: false, midi: null };
        return Array.from({ length: 4 }, () => [
          ON,
          ...Array.from({ length: 15 }, () => OFF),
        ]);
      })(),
    },
    postSpawn: async (page) => {
      // Belt-and-suspenders: also drive l1_pitch/gate via a held keydown so
      // the output is non-zero even if the sequencer tick hasn't fired yet.
      // Numpad2 = C# (semitone 1), octave 4 → MIDI 61 → +0.083 V/oct.
      await page.evaluate(() => {
        const code = 'Numpad2';
        const ev = new KeyboardEvent('keydown', { code, key: '2', bubbles: true });
        document.dispatchEvent(ev);
        // Leave the key "held" — no keyup. The l1_gate output stays high.
      });
    },
    note: 'NUMPAD+: seed all 4 layers (midi=72) + isPlaying=1 + Numpad2 held; l{1..4}_pitch/gate all emit',
  },

  // ───── QBERT — forcePulse the evt_die/evt_move/evt_level gates ─────
  qbert: {
    // QBERT's evt_die/evt_move/evt_level are gameplay-conditional gates:
    // they only fire on in-game events (die, hop, level-up). The runtime
    // exposes forcePulse() so the test can trigger them deterministically
    // without the ROM or game state. We pulse each gate twice, spaced
    // 200ms apart so the scope's 43ms analyser window catches the 10ms
    // pulse with high probability. The video  passes without a driver
    // (the test-pattern framebuffer renders even without the ROM).
    postSpawn: async (page, sutId) => {
      await page.evaluate(async (id) => {
        const w = globalThis as unknown as {
          __engine?: () => {
            getDomain?: (d: string) => {
              read?: (id: string, k: string) => unknown;
            } | null;
          } | null;
        };
        const ve = w.__engine?.()?.getDomain?.('video');
        const extras = ve?.read?.(id, 'extras') as
          | { forcePulse?: (port: 'evt_die' | 'evt_move' | 'evt_level') => void }
          | undefined;
        if (!extras?.forcePulse) return;
        // Fire each evt port once immediately so the scope window catches
        // at least one pulse regardless of which port is under test.
        extras.forcePulse('evt_die');
        extras.forcePulse('evt_move');
        extras.forcePulse('evt_level');
        // Second burst at +300ms for more coverage.
        setTimeout(() => {
          extras.forcePulse?.('evt_die');
          extras.forcePulse?.('evt_move');
          extras.forcePulse?.('evt_level');
        }, 300);
      }, sutId);
    },
    note: 'QBERT: forcePulse evt_die/evt_move/evt_level via extras; video out from test-pattern',
  },

  // ───── MIDICLOCK — mock requestMIDIAccess + post clock messages ─────
  midiclock: {
    pageSetup: async (page) => {
      await page.addInitScript(() => {
        // Build a minimal MIDIAccess + MIDIInput pair. The module's
        // factory subscribes to onmidimessage; we expose a global
        // __fakeMidiSend so the postSpawn hook can pump events.
        const handlers: Array<(ev: { data: Uint8Array; timeStamp: number }) => void> = [];
        const input = {
          id: 'fake-midi-input-0',
          name: 'Synthetic MIDI (Playwright)',
          state: 'connected',
          set onmidimessage(fn: ((ev: { data: Uint8Array; timeStamp: number }) => void) | null) {
            // Replace handler array (factory binds one per connect).
            handlers.length = 0;
            if (fn) handlers.push(fn);
          },
          get onmidimessage() { return handlers[0] ?? null; },
        };
        const inputsMap = new Map([[input.id, input]]);
        const access = {
          inputs: inputsMap,
          outputs: new Map(),
          onstatechange: null as (() => void) | null,
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (navigator as any).requestMIDIAccess = async () => access;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).__fakeMidiSend = (bytes: number[]) => {
          const ev = {
            data: new Uint8Array(bytes),
            timeStamp: performance.now(),
          };
          for (const h of handlers) h(ev);
        };
      });
    },
    postSpawn: async (page, sutId) => {
      // 1. Reach into the engine and call cardApi.connect() to wire the
      //    handler. Then pump 0xFA (start) + a burst of 0xF8 (clock)
      //    messages so the divider counts down + emits multiple 1/4-note
      //    edges across the full 1.2s gate-poll budget.
      //
      // Why 120 ticks (was 30): default divisor=24, so 24 ticks = 1 edge.
      // 120 ticks = 5 clock edges. The scope analyser covers only ~43ms
      // per read (fftSize=2048 / 48kHz); with gate pulses spaced ~104ms
      // apart at the timestamp lookahead, 5 pulses give the gate-poll loop
      // many more chances to catch a hot sample and clear the 0.005 floor.
      //
      // We also fire a second burst 400ms later via setTimeout so the
      // pulses spread across the 1.2s window instead of landing in a
      // tight cluster at t0.
      await page.evaluate(async (id) => {
        const w = globalThis as unknown as {
          __engine?: () => {
            read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
          } | null;
          __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
          __fakeMidiSend?: (bytes: number[]) => void;
        };
        const eng = w.__engine?.();
        const node = w.__patch.nodes[id];
        if (!eng || !node) return;
        const api = eng.read(node, 'card-api') as
          | { connect: () => Promise<boolean> }
          | undefined;
        if (api) await api.connect();
        const send = w.__fakeMidiSend;
        if (!send) return;
        // Start transport (raises run + emits midistart pulse).
        send([0xfa]);
        // First burst: 5 clock edges (120 ticks ÷ divisor 24 = 5 edges).
        for (let i = 0; i < 120; i++) send([0xf8]);
        // Second burst at +300ms so the gate-poll loop catches pulses
        // spread across the test window, not crammed at t=0.
        setTimeout(() => {
          if (!send) return;
          for (let i = 0; i < 120; i++) send([0xf8]);
        }, 300);
        // Third burst at +700ms for more coverage.
        setTimeout(() => {
          if (!send) return;
          for (let i = 0; i < 120; i++) send([0xf8]);
        }, 700);
      }, sutId);
    },
    note: 'MIDICLOCK: mock requestMIDIAccess + pump 0xFA + 360×0xF8 spread over 700ms; clock/run/midistart pulse',
  },

  // ───── MIDICVBUDDY — mock requestMIDIAccess + post note-on ─────
  midiCvBuddy: {
    pageSetup: async (page) => {
      await page.addInitScript(() => {
        const handlers: Array<(ev: { data: Uint8Array; timeStamp: number }) => void> = [];
        const input = {
          id: 'fake-midi-input-0',
          name: 'Synthetic MIDI (Playwright)',
          state: 'connected',
          set onmidimessage(fn: ((ev: { data: Uint8Array; timeStamp: number }) => void) | null) {
            handlers.length = 0;
            if (fn) handlers.push(fn);
          },
          get onmidimessage() { return handlers[0] ?? null; },
        };
        const inputsMap = new Map([[input.id, input]]);
        const access = {
          inputs: inputsMap,
          outputs: new Map(),
          onstatechange: null as (() => void) | null,
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (navigator as any).requestMIDIAccess = async () => access;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).__fakeMidiSend = (bytes: number[]) => {
          const ev = {
            data: new Uint8Array(bytes),
            timeStamp: performance.now(),
          };
          for (const h of handlers) h(ev);
        };
      });
    },
    postSpawn: async (page, sutId) => {
      await page.evaluate(async (id) => {
        const w = globalThis as unknown as {
          __engine?: () => {
            read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
          } | null;
          __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
          __fakeMidiSend?: (bytes: number[]) => void;
        };
        const eng = w.__engine?.();
        const node = w.__patch.nodes[id];
        if (!eng || !node) return;
        const api = eng.read(node, 'card-api') as
          | { connect: () => Promise<boolean> }
          | undefined;
        if (api) await api.connect();
        const send = w.__fakeMidiSend;
        if (!send) return;
        // Note-on, channel 1, MIDI 72 (C5 = +1.0 V/oct), velocity 100. Use
        // MIDI 72 rather than 60 (C4) because midiToVOct(60) = 0 V — the
        // same value pitch_cv starts at — so a C4 note-on produces no
        // measurable delta on the scope. C5 maps to +1.0 V/oct which
        // clears the 0.005 signal-floor check. Held for the sample window
        // so gate stays high + pitch_cv + velocity_cv latch their values.
        send([0x90, 72, 100]);
      }, sutId);
    },
    note: 'MIDICVBUDDY: mock requestMIDIAccess + send note-on; pitch_cv/gate/velocity_cv emit',
  },

  // ───── VIDEOOUT — wire ACIDWARP.out into .in so .out passes through ─────
  videoOut: {
    upstream: () => ({
      nodes: [
        { id: 'drv-acid', type: 'acidwarp', position: { x: 60, y: 60 }, domain: 'video' },
      ],
      edges: [
        {
          id: 'e-drv-acid',
          from: { nodeId: 'drv-acid', portId: 'out' },
          to:   { nodeId: 'sut',      portId: 'in' },
          sourceType: 'video', targetType: 'video',
        },
      ],
    }),
    note: 'VIDEOOUT: drive .in with ACIDWARP.out; .out passes through with non-blank frames',
  },

  // ───── MOOG 904A VCF — self-oscillate so the audio out is driven ─────
  //
  // The 904A is an effect (audio in → low-pass out), but at REGENERATION=1
  // the transistor ladder self-oscillates into a sustained VC sine at the
  // cutoff frequency — no upstream source needed. Seed regeneration=1 +
  // range=2 (mid band, audible) so the `audio` output rings on its own and
  // the per-port outputs-emit check sees a real signal (slice-1-style
  // driven-signal check). Without this it would be silent at the default
  // regeneration=0 and need an upstream source like any other filter.
  moog904a: {
    params: { regeneration: 1, range: 2, cutoff: 800 },
    note: 'MOOG 904A: regeneration=1 → ladder self-oscillates; audio out is a driven sine',
  },
  // ───── FREEZEFRAME — drive video_in so all 5 video outs emit ─────
  //
  // FREEZEFRAME is an effect (video in → posterized/S&H out), so it needs
  // an upstream source. Wire ACIDWARP.out into video_in; with gate_in
  // UNPATCHED the module passes the frame through LIVE, so all five video
  // outs (video_out + r/g/b/luma_out) ring with non-blank frames. The
  // driver's presence bypasses the effect-shape skip (hasDriverSetup) so
  // the module goes through the normal per-output emit path (each out
  // routed to VIDEOOUT.in by the sweep).
  freezeframe: {
    upstream: () => ({
      nodes: [
        { id: 'drv-acid', type: 'acidwarp', position: { x: 60, y: 60 }, domain: 'video' },
      ],
      edges: [
        {
          id: 'e-drv-acid',
          from: { nodeId: 'drv-acid', portId: 'out' },
          to:   { nodeId: 'sut',      portId: 'video_in' },
          sourceType: 'video', targetType: 'video',
        },
      ],
    }),
    note: 'FREEZEFRAME: drive video_in with ACIDWARP.out (gate unpatched = live passthrough); all 5 video outs ring',
  },

  // ───── MOOG 902 VCA — drive the SIGNAL input so both outs emit ─────
  //
  // The 902 is an effect (signal in → amplified out), so it needs an
  // upstream source to produce output. Wire an ANALOGVCO saw into the
  // `audio` SIGNAL input; the GAIN pot's default (0.5 → 3 V control →
  // ×1.0 in LINEAR mode) already passes the signal at unity, so both the
  // `audio` (OUT) and `audio_inv` (OUT−, the differential − twin) outputs
  // ring with no extra CV needed. The driver's presence also bypasses the
  // effect-shape skip in the spec (hasDriverSetup), so the 902 goes through
  // the normal output-emit path (slice-1/2-style driven-signal check).
  moog902: {
    upstream: () => ({
      nodes: [
        { id: 'drv-vco', type: 'analogVco', position: { x: 60, y: 60 }, domain: 'audio' },
      ],
      edges: [
        {
          id: 'e-drv-vco',
          from: { nodeId: 'drv-vco', portId: 'saw' },
          to:   { nodeId: 'sut',     portId: 'audio' },
          sourceType: 'audio', targetType: 'audio',
        },
      ],
    }),
    note: 'MOOG 902: drive SIGNAL with ANALOGVCO.saw; OUT + OUT− both pass the amplified signal (gain default ×1)',
  },
};

/** Look up a driver for a module. Returns null when no override
 *  exists — the spec then falls through to the default driver path. */
export function perPortDriverFor(moduleType: string): PerPortDriver | null {
  return DRIVERS[moduleType] ?? null;
}
