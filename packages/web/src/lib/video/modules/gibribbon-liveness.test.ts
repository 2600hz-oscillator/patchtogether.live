// packages/web/src/lib/video/modules/gibribbon-liveness.test.ts
//
// GIBRIBBON — the SOURCE-CORPUS LIVENESS PROPERTY TEST (the F1/F5 gate).
//
// This test SUPERSEDES gibribbon-synesthesia-calibration.test.ts, retired with
// its subject: that guard protected a per-band GAIN CALIBRATION for a demo
// patch that no longer ships (#1421 deleted the patch, #2183 its sequencer),
// and the rewrite removes the calibration contract it guarded. What replaces
// it is stronger and patch-free: for a CORPUS of real and adversarial
// sources, the ADAPTIVE extractor must produce a playable, balanced course —
// so the gate watches the GAME, not one patch's gains.
//
// ⚠ THE FIRST CORPUS ENTRY IS THE #701 LESSON PRESERVED AS DATA. It is the
// retired guard's exact inline fixture voice — the sequenced MACROOSCILLATOR
// pattern rendered through the REAL synesthesia DSP — and it is measured at
// BOTH the tuned gains AND the flat unity gains that KILLED jump+imp under
// the old absolute-threshold engine (#698/#701: "half the game died silently
// from a change in ANOTHER module ... while EVERY TEST STAYED GREEN"). Under
// the rewrite the unity-gain run must keep ALL FOUR channels alive, which is
// the claim that the failure class is structurally closed, demonstrated on
// the very signal that exposed it.
//
// ── FIXTURE PROVENANCE (carried forward verbatim in spirit) ────────────────
// The voice below is the retired guard's inline fixture, which was itself the
// byte-for-byte reconstruction of the deleted gibribbon-demo.imp.json
// envelope generator: `buildSteps()` is the generator's step programmer
// (xorshift32, seed 0x61bb09), cross-checked against the committed blob's
// `macseq.data.steps` before the blob was removed. MACRO_PARAMS /
// DEMO_MASTER / DEMO_GAINS are the blob's macrooscillator params and
// synesthesia a_master / a_gain1..4 values. macrooscillatorMath.render is the
// pure-math mirror of the worklet; renderSynesthesia is the same DSP the
// synesthesia unit tests import. No AudioWorklet / WebGL needed.

import { describe, it, expect, beforeAll } from 'vitest';
import { macrooscillatorMath, type MacroParams } from '$lib/audio/modules/macrooscillator';
import { renderSynesthesia } from '../../../../../dsp/src/lib/synesthesia-dsp';
import { midiToVOct } from '$lib/audio/note-entry';
import {
  DEFAULT_STEP_PARAMS,
  EVENT_BUTTON,
  GIB_TUNING,
  IDLE_INPUTS,
  judgePhase,
  judgePress,
  newRun,
  step,
  upcomingLane,
  type GibEventKind,
  type GibStepParams,
} from './gibribbon-engine';

// ── Transport math (as the retired guard: TIMELORDE 120 BPM, MACSEQ on 2×).
const SR = 48000;
const STEP_SECS = 0.25;
const GIB_TICK_SECS = 0.5;
const STEP_SAMPLES = Math.round(STEP_SECS * SR);
const GIB_TICK_SAMPLES = Math.round(GIB_TICK_SECS * SR);

// The tuned calibration the OLD guard protected, and the flat unity
// calibration that KILLED jump+imp under the old engine.
const DEMO_MASTER = 1.2;
const DEMO_GAINS: [number, number, number, number] = [1.4, 2.35, 3.9, 1.9];
const UNITY_MASTER = 1.0;
const UNITY_GAINS: [number, number, number, number] = [1, 1, 1, 1];

const MACRO_PARAMS: MacroParams = {
  model: 2, // FM_2OP
  note: 0,
  harmonics: 0.4,
  timbre: 0.45,
  morph: 0.5,
  level: 0.85,
} as MacroParams;

const MODEL = { WAVESHAPE: 1, FM_2OP: 2, STRING: 6, KICK: 8, SNARE: 9 } as const;
const N = { c2: 36, e2: 40, c3: 48, f3: 53, a3: 57, d2: 38, d3: 50, e3: 52 } as const;
const NOTE_POOL = [N.c2, N.e2, N.c3, N.f3, N.a3, N.d2, N.d3, N.e3];
const VOICE_CYCLE = [MODEL.FM_2OP, MODEL.STRING, MODEL.WAVESHAPE];
const STEP_COUNT = 128;

interface DemoStep {
  on: boolean;
  midi: number | null;
  model: number | null;
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 0xffffffff;
  };
}

function buildSteps(): DemoStep[] {
  const rng = makeRng(0x61bb09); // the generator's "GIBB" seed → stable pattern
  const steps: DemoStep[] = [];
  let voiceCursor = 0;
  let noteCursor = 0;
  for (let i = 0; i < STEP_COUNT; i++) {
    if (i % 8 === 0) { steps.push({ on: true, midi: N.c2, model: MODEL.KICK }); continue; }
    if (i % 8 === 4) { steps.push({ on: true, midi: N.c3, model: MODEL.SNARE }); continue; }
    if (rng() < 0.4) { steps.push({ on: false, midi: N.c3, model: null }); continue; }
    const model = VOICE_CYCLE[voiceCursor % VOICE_CYCLE.length]!;
    voiceCursor++;
    const midi = NOTE_POOL[noteCursor % NOTE_POOL.length]!;
    noteCursor++;
    steps.push({ on: true, midi, model });
  }
  return steps;
}

function renderDemoVoice(steps: DemoStep[], macro: MacroParams): Float32Array {
  const out = new Float32Array(steps.length * STEP_SAMPLES);
  let off = 0;
  for (const s of steps) {
    if (s.on && s.model != null) {
      const pitchV = midiToVOct(s.midi ?? 48);
      const { main } = macrooscillatorMath.render(STEP_SAMPLES, SR, pitchV, {
        ...macro,
        model: s.model,
        note: 0,
      });
      out.set(main, off);
    }
    off += STEP_SAMPLES;
  }
  return out;
}

function cvPerTick(envSlow: Float32Array[], nTicks: number): number[][] {
  const rows: number[][] = [];
  for (let t = 0; t < nTicks; t++) {
    const i = Math.min(envSlow[0]!.length - 1, t * GIB_TICK_SAMPLES);
    rows.push([envSlow[0]![i]!, envSlow[1]![i]!, envSlow[2]![i]!, envSlow[3]![i]!]);
  }
  return rows;
}

function gatePerTick(steps: DemoStep[], nTicks: number): boolean[] {
  const g: boolean[] = [];
  for (let t = 0; t < nTicks; t++) g.push(!!steps[2 * t]?.on || !!steps[2 * t + 1]?.on);
  return g;
}

// ── The corpus runner: any per-tick CV/gate stream → the REAL stepper ──────

interface CorpusResult {
  counts: Record<GibEventKind, number>;
  total: number;
  nTicks: number;
  laneEverPopulated: boolean;
}

const PLAY: GibStepParams = { ...DEFAULT_STEP_PARAMS, attract: 0 };

/**
 * Push a per-course-tick CV/gate stream through the real one-clock stepper
 * (external clock edges — the same path a patched clock takes), with a
 * competent simulated player clearing in-window events through the REAL
 * judge so the run measures the full-window spawn rate rather than a
 * truncated up-to-gameover rate.
 */
function runCorpus(cv: readonly (readonly number[])[], gate: readonly boolean[]): CorpusResult {
  const s = newRun(0xc0de, 'play');
  const counts: Record<GibEventKind, number> = { loop: 0, jump: 0, imp: 0, zombie: 0 };
  let lastId = s.nextEventId;
  let laneEverPopulated = false;
  for (let t = 0; t < cv.length; t++) {
    step(s, {
      ...IDLE_INPUTS,
      cv: cv[t]!,
      gate: gate[t] ? 1 : 0,
      clockEdges: 1,
      activity: true,
    }, PLAY);
    while (lastId < s.nextEventId) {
      const ev = s.events.find((e) => e.id === lastId);
      if (ev) counts[ev.kind] += 1;
      lastId += 1;
    }
    const phase = judgePhase(s, PLAY);
    if (upcomingLane(s, phase).length > 0) laneEverPopulated = true;
    for (const ev of [...s.events]) {
      if (!ev.resolved && Math.abs(ev.pos - phase * GIB_TUNING.scrollPerTick) <= GIB_TUNING.hitWindow) {
        judgePress(s, EVENT_BUTTON[ev.kind], phase);
      }
    }
  }
  const total = counts.loop + counts.jump + counts.imp + counts.zombie;
  return { counts, total, nTicks: cv.length, laneEverPopulated };
}

/** The playable-density band asserted for every LIVE corpus entry. The floor
 *  is "the ribbon is not half-empty"; the ceiling is the rate limiter's own
 *  max at default difficulty (one spawn per two course ticks). */
function expectPlayable(name: string, r: CorpusResult): void {
  const perTick = r.total / r.nTicks;
  expect(perTick, `${name}: spawns/tick ${perTick.toFixed(3)}`).toBeGreaterThanOrEqual(0.15);
  expect(perTick, `${name}: spawns/tick ${perTick.toFixed(3)}`).toBeLessThanOrEqual(0.55);
  for (const kind of ['loop', 'jump', 'imp', 'zombie'] as GibEventKind[]) {
    expect(r.counts[kind], `${name}: ${kind} must spawn (no dead channel)`).toBeGreaterThanOrEqual(1);
    expect(
      r.counts[kind] / r.total,
      `${name}: ${kind} share (no flooded channel)`,
    ).toBeLessThanOrEqual(0.6);
  }
  expect(r.laneEverPopulated, `${name}: the lookahead lane must be readable`).toBe(true);
}

describe('GIBRIBBON — source-corpus liveness (the F1 property, #701 preserved as data)', () => {
  const steps = buildSteps();
  let tunedCv: number[][];
  let unityCv: number[][];
  let gates: boolean[];
  const N_TICKS = 64;

  beforeAll(() => {
    // The renders cost ~2 s each — computed once, shared by every case.
    const voice = renderDemoVoice(steps, MACRO_PARAMS);
    expect(Math.floor(voice.length / GIB_TICK_SAMPLES)).toBe(N_TICKS);
    const tuned = renderSynesthesia(voice, { sr: SR, master: DEMO_MASTER, gains: DEMO_GAINS });
    const unity = renderSynesthesia(voice, { sr: SR, master: UNITY_MASTER, gains: UNITY_GAINS });
    tunedCv = cvPerTick(tuned.envSlow, N_TICKS);
    unityCv = cvPerTick(unity.envSlow, N_TICKS);
    gates = gatePerTick(steps, N_TICKS);
  }, 60_000);

  it('the inlined fixture is the 128-step pattern it claims to be (anchor)', () => {
    expect(steps).toHaveLength(STEP_COUNT);
    for (let i = 0; i < STEP_COUNT; i += 8) {
      expect(steps[i]).toEqual({ on: true, midi: N.c2, model: MODEL.KICK });
      expect(steps[i + 4]).toEqual({ on: true, midi: N.c3, model: MODEL.SNARE });
    }
    const nonDrum = steps.filter((_, i) => i % 8 !== 0 && i % 8 !== 4);
    const rests = nonDrum.filter((s) => !s.on).length;
    expect(rests / nonDrum.length).toBeGreaterThan(0.25);
    expect(rests / nonDrum.length).toBeLessThan(0.55);
  });

  it('CORPUS 1 — the fixture voice at the TUNED gains is playable on all four channels', () => {
    expectPlayable('tuned', runCorpus(tunedCv, gates));
  });

  it('CORPUS 2 — ⚠ THE #698 KILLER: flat UNITY gains keep ALL FOUR channels ALIVE now', () => {
    // Under the old absolute-threshold engine this exact signal left jump+imp
    // DEAD (the retired guard's negative control proved it: counts.jump +
    // counts.imp === 0). The adaptive extractor measures each channel against
    // its own recent range, so the same signal now plays on every channel —
    // the #698/#701 failure class, closed on the signal that exposed it.
    expectPlayable('unity (the #698 killer)', runCorpus(unityCv, gates));
  });

  it('CORPUS 3 — mis-gained variants (×0.3 and ×3, clamped) stay playable (the M1 bar)', () => {
    const scaled = (rows: number[][], k: number) =>
      rows.map((r) => r.map((v) => Math.max(0, Math.min(1, v * k))));
    expectPlayable('tuned ×0.3', runCorpus(scaled(tunedCv, 0.3), gates));
    expectPlayable('tuned ×3', runCorpus(scaled(tunedCv, 3), gates));
  });

  it('CORPUS 4 — a QUIET synthetic source (peaks at 0.08) is playable', () => {
    const cv: number[][] = [];
    const gate: boolean[] = [];
    for (let t = 0; t < N_TICKS; t++) {
      cv.push([
        t % 4 === 0 ? 0.08 : 0.01,
        t % 4 === 2 ? 0.06 : 0.01,
        t % 8 === 1 ? 0.07 : 0.008,
        t % 8 === 5 ? 0.05 : 0.01,
      ]);
      gate.push(t % 2 === 0);
    }
    expectPlayable('quiet', runCorpus(cv, gate));
  });

  it('CORPUS 5 — a HOT clipping source (floor 0.7, peaks pinned at 1.0) is playable', () => {
    const cv: number[][] = [];
    const gate: boolean[] = [];
    for (let t = 0; t < N_TICKS; t++) {
      cv.push([
        t % 4 === 0 ? 1.0 : 0.7,
        t % 4 === 2 ? 1.0 : 0.75,
        t % 8 === 1 ? 1.0 : 0.72,
        t % 8 === 5 ? 1.0 : 0.7,
      ]);
      gate.push(true);
    }
    expectPlayable('hot', runCorpus(cv, gate));
  });

  it('CORPUS 6 — dead-flat sources spawn NOTHING (the resting-floor guard survives)', () => {
    for (const level of [0, 0.5, 1.0]) {
      const cv = Array.from({ length: N_TICKS }, () => [level, level, level, level]);
      const gate = Array.from({ length: N_TICKS }, () => true);
      const r = runCorpus(cv, gate);
      expect(r.total, `flat at ${level} must spawn nothing`).toBe(0);
    }
  });

  it('NEGATIVE GUARD: the property can fail — a single-channel source reports its dead channels', () => {
    // Prove expectPlayable is not vacuous: a source with three silent channels
    // fails the all-four-alive claim (we assert the failure shape directly
    // rather than wrapping expect() in a try).
    const cv: number[][] = [];
    const gate: boolean[] = [];
    for (let t = 0; t < N_TICKS; t++) {
      cv.push([t % 3 === 0 ? 0.9 : 0.1, 0, 0, 0]);
      gate.push(true);
    }
    const r = runCorpus(cv, gate);
    expect(r.counts.loop).toBeGreaterThan(0);
    expect(r.counts.jump + r.counts.imp + r.counts.zombie).toBe(0);
  });

  it('determinism: the corpus run is identical across invocations (same seed)', () => {
    const a = runCorpus(tunedCv, gates);
    const b = runCorpus(tunedCv, gates);
    expect(a).toEqual(b);
  });
});
