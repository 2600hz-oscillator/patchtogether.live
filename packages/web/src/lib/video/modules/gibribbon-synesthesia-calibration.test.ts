// packages/web/src/lib/video/modules/gibribbon-synesthesia-calibration.test.ts
//
// REAL-CHAIN calibration guard for GIBRIBBON's four CV channels. This is the
// regression test the SYNESTHESIA #698 retune (PR #701) rests on.
//
// The chain under test is:
//   sequenced MACROOSCILLATOR voice → SYNESTHESIA(copy A) → GIBRIBBON
// The four SLOW SYNESTHESIA env-followers (a_band{1..4}_env_slow) become
// GIBRIBBON cv1..cv4 → loop/jump/imp/zombie events (via GIB_TUNING.cvEventMap).
//
// WHY a separate test from the "Phase-2 demo CV calibration" in
// gibribbon-events.test.ts: that one is PURELY SYNTHETIC — it hand-models four
// idealized raised-cosine envelopes and never touches renderSynesthesia or the
// real per-band gains, so it stayed green THROUGH the #698 refactor that killed
// jump+imp AND through the fix that revived them. It cannot guard the gains.
//
// THIS test drives an EXACT sequenced MACROOSCILLATOR voice (a 128-step
// kick/snare/melodic pattern) through the REAL renderSynesthesia DSP at the
// tuned gains, samples the slow-env CV per GIBRIBBON tick, and pushes it
// through the real clockTick→chooseSpawn pipeline. It asserts ALL FOUR event
// kinds spawn (none dead), none floods, and the total rate sits in a playable
// band. So the NEXT synesthesia band/attack/gain change that silently re-kills
// a channel fails CI.
//
// ── PROVENANCE (read this before touching the fixture) ──────────────────────
// Until the second-shell removal this test lived at
// `lib/ui/example-patches/gibribbon-demo-calibration.test.ts` and DECODED its
// voice out of the shipped `gibribbon-demo.imp.json` envelope (the "GIBRIBBON
// (game demo)" entry in the retired "Load example…" dropdown). That envelope
// and its generator (`scripts/build-gibribbon-demo-envelope.mjs`) were deleted
// with the dropdown, so the fixture is now declared HERE, inline.
//
// It is the SAME voice, not an approximation: `buildSteps()` below is the
// generator's step programmer verbatim (xorshift32, seed 0x61bb09), and it was
// cross-checked to reproduce the committed blob's `macseq.data.steps` array
// byte-for-byte before the blob was removed. MACRO_PARAMS / DEMO_MASTER /
// DEMO_GAINS are the blob's `macrooscillator.params` and `synesthesia`
// a_master/a_gain{1..4} values. Inlining also removes the old indirection where
// a DSP guard's subject was buried in a shipped product asset.
//
// macrooscillatorMath.render is the pure-math mirror of the worklet (same path
// the macrooscillator unit tests + ART use); renderSynesthesia is the same DSP
// the synesthesia unit tests import. No AudioWorklet / WebGL needed.

import { describe, it, expect, beforeAll } from 'vitest';
import { macrooscillatorMath, type MacroParams } from '$lib/audio/modules/macrooscillator';
import { renderSynesthesia } from '../../../../../dsp/src/lib/synesthesia-dsp';
import { midiToVOct } from '$lib/audio/note-entry';
import {
  newGame,
  clockTick,
  judgePress,
  EVENT_BUTTON,
  GIB_TUNING,
  type GibEventKind,
} from '$lib/video/modules/gibribbon-events';

// ── Transport math (TIMELORDE bpm=120, MACSEQ clocked from its 2× output).
//   2× (8th)     = 0.25 s clocks MACSEQ → 1 MACSEQ step = 0.25 s.
//   1× (quarter) = 0.50 s is GIBRIBBON's scroll clock → 1 GIB tick = 2 steps.
const SR = 48000;
const STEP_SECS = 0.25;
const GIB_TICK_SECS = 0.5;
const STEP_SAMPLES = Math.round(STEP_SECS * SR);
const GIB_TICK_SAMPLES = Math.round(GIB_TICK_SECS * SR);

// The tuned SYNESTHESIA copy-A calibration this test exists to protect.
const DEMO_MASTER = 1.2;
const DEMO_GAINS: [number, number, number, number] = [1.4, 2.35, 3.9, 1.9];
// A KNOWN-BAD calibration that leaves jump+imp dead — used by the negative-guard
// test below to prove this calibration test really would catch a regression.
//
// The env CV carries a per-band MAKEUP gain (CV_MAKEUP in synesthesia-dsp), so
// every band's slow env reaches full scale on energetic steps — which is what
// revived all four channels at the tuned gains. That makeup also lifted the
// PRE-#698 gains [1.5,1.6,1.7,1.8] enough that they no longer kill a channel,
// so they are no longer a valid negative case. The flat UNITY calibration
// (master 1, all band gains 1 — i.e. NO per-band balancing at all) is the
// known-bad: the voice's mid bands (band2=jump, band3=imp) carry too little
// energy to cross cvSpawnThreshold without per-band makeup gain, so both stay
// dead while the energetic bass (loop) + treble (zombie) still fire. If a
// future edit reverts to a flat / unbalanced calibration, the "ALL FOUR"
// assertion fails the same way.
const OLD_MASTER = 1.0;
const OLD_GAINS: [number, number, number, number] = [1, 1, 1, 1];

// The MACROOSCILLATOR voice MACSEQ plays. `model` is driven live per step (see
// renderDemoVoice); the value here is the idle default the patch carried.
const MACRO_PARAMS: MacroParams = {
  model: 2, // FM_2OP
  note: 0,
  harmonics: 0.4,
  timbre: 0.45,
  morph: 0.5,
  level: 0.85,
} as MacroParams;

// ── The 128-step pattern (generator-verbatim; see PROVENANCE above). ─────────
//   - KICK (model 8) on every 8th step (0, 8, 16, …) — pitch forced to c2.
//   - SNARE (model 9) on the ALTERNATING 8s (the back-beat: 4, 12, 20, …) —
//     pitch forced to c3.
//   - ~40% of the REMAINING steps left EMPTY (off).
//   - the rest cycle 2OP / STRING / WAVESHAPE voices with notes drawn from the
//     melodic pool.
// A fixed-seed xorshift32 drives the empty/voice/note choices, so the pattern
// is deterministic (no Math.random) and identical on every run and platform.
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
    // xorshift32 — deterministic 0..1.
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return (s >>> 0) / 0xffffffff;
  };
}

function buildSteps(): DemoStep[] {
  const rng = makeRng(0x61bb09); // fixed "GIBB" seed → stable pattern
  const steps: DemoStep[] = [];
  let voiceCursor = 0;
  let noteCursor = 0;
  for (let i = 0; i < STEP_COUNT; i++) {
    if (i % 8 === 0) {
      steps.push({ on: true, midi: N.c2, model: MODEL.KICK });
      continue;
    }
    if (i % 8 === 4) {
      steps.push({ on: true, midi: N.c3, model: MODEL.SNARE });
      continue;
    }
    if (rng() < 0.4) {
      steps.push({ on: false, midi: N.c3, model: null });
      continue;
    }
    const model = VOICE_CYCLE[voiceCursor % VOICE_CYCLE.length]!;
    voiceCursor++;
    const midi = NOTE_POOL[noteCursor % NOTE_POOL.length]!;
    noteCursor++;
    steps.push({ on: true, midi, model });
  }
  return steps;
}

// ── Render the sequenced MACROOSCILLATOR voice. ──────────────────────────────
// Each step drives the macro voice for STEP_SAMPLES with the step's model
// (MACSEQ.modelcv → MACROOSCILLATOR.model_cv, a discrete CV that round-trips to
// the same integer) at the step's pitch (MACSEQ.pitch → V/oct). A gated-OFF step
// is silence (the macro voice is un-triggered). macrooscillatorMath.render
// re-seeds the drum/string excitation each call, mirroring the per-step gate
// rising edge that retriggers KICK/SNARE/STRING in the real worklet.
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

// Sample each of the 4 slow envelopes at every GIBRIBBON clock tick.
function cvPerTick(envSlow: Float32Array[], nTicks: number): number[][] {
  const rows: number[][] = [];
  for (let t = 0; t < nTicks; t++) {
    const i = Math.min(envSlow[0]!.length - 1, t * GIB_TICK_SAMPLES);
    rows.push([envSlow[0]![i]!, envSlow[1]![i]!, envSlow[2]![i]!, envSlow[3]![i]!]);
  }
  return rows;
}

// MACSEQ.gate → GIBRIBBON.gate. A GIB tick covers MACSEQ steps 2t, 2t+1; the
// gate reads HIGH if either step is gated on (kick/snare/voice) — the on-beat
// bias that lets the strongest channel spawn.
function gatePerTick(steps: DemoStep[], nTicks: number): boolean[] {
  const g: boolean[] = [];
  for (let t = 0; t < nTicks; t++) g.push(!!steps[2 * t]?.on || !!steps[2 * t + 1]?.on);
  return g;
}

interface PipelineResult {
  spawned: GibEventKind[];
  counts: Record<GibEventKind, number>;
  nTicks: number;
}

// Push the per-tick CV + gate through the REAL gibribbon pipeline. Simulates a
// competent player (clears in-window events) so the marine survives and we
// measure the full-window spawn rate, not a truncated up-to-gameover rate.
function runDemoPipeline(
  steps: DemoStep[],
  macro: MacroParams,
  master: number,
  gains: [number, number, number, number],
): PipelineResult {
  const voice = renderDemoVoice(steps, macro);
  const rendered = renderSynesthesia(voice, { sr: SR, master, gains });
  const nTicks = Math.floor(voice.length / GIB_TICK_SAMPLES);
  const cv = cvPerTick(rendered.envSlow, nTicks);
  const gate = gatePerTick(steps, nTicks);

  const s = newGame(0xc0de);
  const spawned: GibEventKind[] = [];
  let prevId = s.nextEventId;
  for (let t = 0; t < nTicks; t++) {
    clockTick(s, cv[t]!, gate[t]!);
    if (s.nextEventId > prevId) {
      const just = s.events.find((e) => e.id === s.nextEventId - 1);
      if (just) spawned.push(just.kind);
      prevId = s.nextEventId;
    }
    for (const ev of [...s.events]) {
      if (!ev.resolved && Math.abs(ev.pos) <= GIB_TUNING.hitWindow) {
        judgePress(s, EVENT_BUTTON[ev.kind]);
      }
    }
  }
  const counts: Record<GibEventKind, number> = { loop: 0, jump: 0, imp: 0, zombie: 0 };
  for (const k of spawned) counts[k] += 1;
  return { spawned, counts, nTicks };
}

describe('GIBRIBBON — real-chain SYNESTHESIA calibration (#698 retune guard)', () => {
  const steps = buildSteps();
  const macro = MACRO_PARAMS;

  // The real-chain renders (renderDemoVoice over 128 steps → renderSynesthesia
  // over 32 s of audio) cost ~2 s EACH and are IDENTICAL across the tests below
  // (same fixture, same params). Compute them ONCE here — re-rendering per
  // `it()` blew vitest's 5 s per-test timeout under flake-check/CI load. The
  // assertions are now near-instant reads over the precomputed results.
  let voice: Float32Array;
  let demoRun: PipelineResult; // tuned gains
  let oldRun: PipelineResult; // flat unity gains (negative guard)
  beforeAll(() => {
    voice = renderDemoVoice(steps, macro);
    demoRun = runDemoPipeline(steps, macro, DEMO_MASTER, DEMO_GAINS);
    oldRun = runDemoPipeline(steps, macro, OLD_MASTER, OLD_GAINS);
  }, 60_000);

  it('the inlined fixture is the 128-step pattern it claims to be', () => {
    // Anchors the fixture itself: a silent edit to buildSteps() (a changed
    // seed, a dropped kick row) would otherwise re-tune the whole guard
    // underneath the assertions below and still look green.
    expect(steps).toHaveLength(STEP_COUNT);
    // KICK on every down-beat 8, SNARE on every back-beat 8 — the spine of the
    // pattern the band gains were balanced against.
    for (let i = 0; i < STEP_COUNT; i += 8) {
      expect(steps[i], `step ${i} is the KICK`).toEqual({
        on: true,
        midi: N.c2,
        model: MODEL.KICK,
      });
      expect(steps[i + 4], `step ${i + 4} is the SNARE`).toEqual({
        on: true,
        midi: N.c3,
        model: MODEL.SNARE,
      });
    }
    // ~40% of the non-drum steps are rests — a fully-dense or fully-empty
    // pattern would change the spectral balance the gains target.
    const nonDrum = steps.filter((_, i) => i % 8 !== 0 && i % 8 !== 4);
    const rests = nonDrum.filter((s) => !s.on).length;
    expect(rests / nonDrum.length).toBeGreaterThan(0.25);
    expect(rests / nonDrum.length).toBeLessThan(0.55);
  });

  it('renders a non-silent sequenced voice and a non-trivial number of ticks', () => {
    expect(voice.length).toBe(steps.length * STEP_SAMPLES);
    // The voice carries real energy (not all-zero) so renderSynesthesia has
    // something to analyse.
    let peak = 0;
    for (let i = 0; i < voice.length; i++) {
      const a = Math.abs(voice[i]!);
      if (a > peak) peak = a;
    }
    expect(peak).toBeGreaterThan(0.05);
    // 128 steps × 0.25 s = 32 s = 64 GIBRIBBON ticks.
    expect(Math.floor(voice.length / GIB_TICK_SAMPLES)).toBe(64);
  });

  it('ALL FOUR event kinds spawn at the tuned gains — none dead', () => {
    const { counts } = demoRun;
    expect(counts.loop, 'loop (cv1) must spawn').toBeGreaterThanOrEqual(1);
    expect(counts.jump, 'jump (cv2) must spawn').toBeGreaterThanOrEqual(1);
    expect(counts.imp, 'imp (cv3) must spawn').toBeGreaterThanOrEqual(1);
    expect(counts.zombie, 'zombie (cv4) must spawn').toBeGreaterThanOrEqual(1);
  });

  it('no single channel floods (per-kind spawn share is bounded)', () => {
    const { counts, spawned } = demoRun;
    const total = spawned.length;
    expect(total).toBeGreaterThan(0);
    // No one kind may own more than half the spawns (a flooded channel starves
    // the others even if they technically fire ≥1).
    for (const kind of ['loop', 'jump', 'imp', 'zombie'] as GibEventKind[]) {
      expect(counts[kind] / total, `${kind} share`).toBeLessThanOrEqual(0.5);
    }
  });

  it('the total spawn rate is playable (~0.39 spawns/tick, band 0.3–0.5)', () => {
    const { spawned, nTicks } = demoRun;
    const perTick = spawned.length / nTicks;
    expect(perTick).toBeGreaterThanOrEqual(0.3);
    expect(perTick).toBeLessThanOrEqual(0.5);
  });

  // NEGATIVE GUARD: prove this test really catches a band/gain regression. With
  // a FLAT/unbalanced calibration (unity master + unity band gains, no per-band
  // makeup) the same real chain leaves jump+imp DEAD — the mid bands never cross
  // cvSpawnThreshold. If a future edit reverts to a calibration that kills a
  // channel, the "ALL FOUR" assertion above fails the same way.
  it('FAILS-SAFE: a flat unity calibration leaves jump + imp dead (the bug)', () => {
    const { counts } = oldRun;
    // Demonstrates the regression the balanced gains fix: at least one mid band dead.
    expect(counts.jump + counts.imp).toBe(0);
    // loop + zombie still fired under the flat gains (only the mids died).
    expect(counts.loop).toBeGreaterThanOrEqual(1);
    expect(counts.zombie).toBeGreaterThanOrEqual(1);
  });
});
