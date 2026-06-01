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
    params: { rate: 36 },
    note: 'SYMBIOTE: bump rate to 36 semitones so t1/t2/t3/x1/x3 fire fast',
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
    // SCORE's score-sheet data is a notes[] array; seeding 4 notes at
    // midi=60 on consecutive ticks (bar 0..3) produces the same gate/pitch
    // emission shape the existing scoreboard test uses.
    data: {
      notes: [
        { tick: 0,   midi: 60, duration: 1, velocity: 1 },
        { tick: 1,   midi: 64, duration: 1, velocity: 1 },
        { tick: 2,   midi: 67, duration: 1, velocity: 1 },
        { tick: 3,   midi: 72, duration: 1, velocity: 1 },
      ],
    },
    note: 'SCORE: pre-seed 4 notes + isPlaying=1; gate/pitch/env/clock pulse',
  },
  drumseqz: {
    // Use trk1_euclid > 0 to make TRACK 1 fire on euclidean steps
    // without needing per-cell data.steps seeding.
    params: {
      isPlaying: 1, length: 16, bpm: 240, gateLength: 0.5,
      trk1_euclid: 4, trk2_euclid: 4, trk3_euclid: 4, trk4_euclid: 4,
    },
    note: 'DRUMSEQZ: enable euclidean rhythms on all 4 tracks + isPlaying=1; gates pulse',
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

  // ───── NUMPAD+ — dispatch synthetic numpad keydown ─────
  numpadPlus: {
    // Activate layer 1 (default) and keep transport stopped; the keydown
    // fires the live-play path immediately via the keydown listener.
    params: { activeLayer: 0, octave: 4 },
    postSpawn: async (page) => {
      // Hold Numpad2 (= C# in the keymap, semitone 1) so l1_gate stays
      // high when the test window samples. We deliberately use C#
      // (Numpad2) rather than C (Numpad1) because C4 = MIDI 60 = 0 V/oct
      // — the l1_pitch ConstantSource emits exactly 0.0 V, which is at/
      // below the scope peak floor (> 0.005). C#4 = MIDI 61 →
      // midiToVOct(61) = (61-60)/12 ≈ +0.083 V, safely above the floor.
      // The listener attaches in the factory; once the SUT mounts, the
      // keydown fires immediately on the document object regardless of
      // which element has focus.
      await page.evaluate(() => {
        const code = 'Numpad2';
        const ev = new KeyboardEvent('keydown', { code, key: '2', bubbles: true });
        document.dispatchEvent(ev);
        // Leave the key "held" — no keyup. The l1_gate output stays high.
      });
    },
    note: 'NUMPAD+: dispatch synthetic Numpad2 (C#4) keydown (held); l1_pitch ≈ +0.083 V/oct + l1_gate emit',
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
      //    messages so the divider counts down + emits a 1/4-note edge.
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
        // 30 clock ticks > divisor 24 (default = 1/4) → one clock edge.
        for (let i = 0; i < 30; i++) send([0xf8]);
        // Hold run high for the rest of the sample window.
      }, sutId);
    },
    note: 'MIDICLOCK: mock requestMIDIAccess + pump 0xFA + 30×0xF8; clock/run/midistart pulse',
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
};

/** Look up a driver for a module. Returns null when no override
 *  exists — the spec then falls through to the default driver path. */
export function perPortDriverFor(moduleType: string): PerPortDriver | null {
  return DRIVERS[moduleType] ?? null;
}
