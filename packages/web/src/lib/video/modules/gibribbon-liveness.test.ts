// packages/web/src/lib/video/modules/gibribbon-liveness.test.ts
//
// GIBRIBBON — the SOURCE-CORPUS LIVENESS PROPERTY TEST (the F1/F5 gate),
// AUDIO edition: the corpus is AUDIO, pushed through the module's REAL
// spectral fold (gibribbon-spectral.ts — the same pure code the factory runs
// on its AnalyserNode bins) into the REAL adaptive extractor and judge.
//
// This is the owner's audio redirect made falsifiable: "events should only
// happen based on audio". For a corpus of real and adversarial SOUNDS, the
// module must produce a playable, balanced course — with no gain knob and no
// upstream calibration anywhere in the path.
//
// ⚠ THE FIRST CORPUS ENTRY IS STILL THE #701 LESSON, PRESERVED AS DATA — one
// step closer to the source now. The retired calibration guard protected a
// per-band SYNESTHESIA GAIN calibration for this exact fixture voice; the
// audio redesign deletes synesthesia from the path entirely, so the corpus
// feeds the VOICE ITSELF (rendered audio → FFT → the module's own fold), at
// unity and deliberately mis-gained ±10 dB-ish (×0.3 / ×3-clipped). All four
// bands must stay alive in every variant — the class that killed the module
// twice (#698/#701: a foreign gain change silently starving two channels)
// cannot be expressed in this design, and this test is where that claim
// meets the killer signal.
//
// ── FIXTURE PROVENANCE (carried forward) ───────────────────────────────────
// `buildSteps()` is the deleted gibribbon-demo envelope generator's step
// programmer verbatim (xorshift32, seed 0x61bb09), cross-checked against the
// committed blob's `macseq.data.steps` byte-for-byte before the blob was
// removed (#1421). MACRO_PARAMS is the blob's macrooscillator params.
// macrooscillatorMath.render is the pure-math mirror of the worklet. The
// DEMO_GAINS / renderSynesthesia halves of the old fixture are GONE WITH
// THEIR SUBJECT: there is no synesthesia in the path to calibrate.

import { describe, it, expect, beforeAll } from 'vitest';
import { macrooscillatorMath, type MacroParams } from '$lib/audio/modules/macrooscillator';
import { midiToVOct } from '$lib/audio/note-entry';
import {
  DEFAULT_STEP_PARAMS,
  EVENT_BUTTON,
  GIB_TUNING,
  courseTick,
  judgePress,
  newRun,
  upcomingLane,
  type GibEventKind,
  type GibStepParams,
} from './gibribbon-engine';
import {
  GIB_FFT_SIZE,
  gibBandBinRanges,
  gibFoldBands,
  gibSpectralFlux,
  newOnsetState,
  pushFluxIsOnset,
} from './gibribbon-spectral';

// ── Transport math (as before: 1 course tick = 0.5 s of fixture audio). ────
const SR = 48000;
const STEP_SECS = 0.25;
const GIB_TICK_SECS = 0.5;
const STEP_SAMPLES = Math.round(STEP_SECS * SR);
const GIB_TICK_SAMPLES = Math.round(GIB_TICK_SECS * SR);
const N_TICKS = 64;

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

// ── The test-side analyser: samples → byte spectrum → THE MODULE'S FOLD ────
//
// A plain iterative radix-2 FFT + the WebAudio getByteFrequencyData dB
// mapping (defaults: minDecibels −100, maxDecibels −30), so the fold's input
// here matches the factory's within the approximation the design tolerates
// BY CONSTRUCTION — the extractor is relative to each band's own baseline,
// so absolute scaling differences between this path and a live AnalyserNode
// cancel out. Only the FOLD is the module's code; the FFT is a fixture.

function fftRadix2(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]!;
        const ui = im[i + k]!;
        const vr = re[i + k + len / 2]! * cwr - im[i + k + len / 2]! * cwi;
        const vi = re[i + k + len / 2]! * cwi + im[i + k + len / 2]! * cwr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

/** getByteFrequencyData-shaped spectrum of a 2048-sample window at `at`. */
function byteSpectrumAt(samples: Float32Array, at: number): Uint8Array {
  const n = GIB_FFT_SIZE;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let windowSum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1))); // Hann
    windowSum += w;
    re[i] = (samples[at + i] ?? 0) * w;
  }
  fftRadix2(re, im);
  const bins = new Uint8Array(n / 2);
  const minDb = -100;
  const maxDb = -30;
  for (let k = 0; k < n / 2; k++) {
    const mag = (2 * Math.hypot(re[k]!, im[k]!)) / windowSum;
    const db = 20 * Math.log10(mag + 1e-12);
    bins[k] = Math.max(0, Math.min(255, Math.round(((db - minDb) / (maxDb - minDb)) * 255)));
  }
  return bins;
}

/** The module-fold band rows, one per course tick, from raw audio. */
function bandRowsFromAudio(samples: Float32Array): number[][] {
  const ranges = gibBandBinRanges(SR, GIB_FFT_SIZE);
  const rows: number[][] = [];
  for (let t = 0; t < N_TICKS; t++) {
    const at = Math.min(samples.length - GIB_FFT_SIZE - 1, t * GIB_TICK_SAMPLES);
    rows.push(gibFoldBands(byteSpectrumAt(samples, Math.max(0, at)), ranges));
  }
  return rows;
}

// ── The corpus runner: band rows → the REAL course + a competent player ────

interface CorpusResult {
  counts: Record<GibEventKind, number>;
  total: number;
  nTicks: number;
  laneEverPopulated: boolean;
}

const PLAY: GibStepParams = { ...DEFAULT_STEP_PARAMS, attract: 0 };

function runCorpus(rows: readonly (readonly number[])[]): CorpusResult {
  const s = newRun(0xc0de, 'play');
  const counts: Record<GibEventKind, number> = { loop: 0, jump: 0, imp: 0, zombie: 0 };
  let lastId = s.nextEventId;
  let laneEverPopulated = false;
  const onset = newOnsetState();
  let prev: readonly number[] = [0, 0, 0, 0];
  for (const row of rows) {
    const isOnset = pushFluxIsOnset(onset, gibSpectralFlux(prev, row));
    prev = row;
    courseTick(s, row, isOnset, PLAY);
    while (lastId < s.nextEventId) {
      const ev = s.events.find((e) => e.id === lastId);
      if (ev) counts[ev.kind] += 1;
      lastId += 1;
    }
    if (upcomingLane(s, 0).length > 0) laneEverPopulated = true;
    for (const ev of [...s.events]) {
      if (!ev.resolved && Math.abs(ev.pos) <= GIB_TUNING.hitWindow) {
        judgePress(s, EVENT_BUTTON[ev.kind], 0);
      }
    }
  }
  const total = counts.loop + counts.jump + counts.imp + counts.zombie;
  return { counts, total, nTicks: rows.length, laneEverPopulated };
}

/** The playable-density band asserted for every LIVE corpus entry. */
function expectPlayable(name: string, r: CorpusResult): void {
  const perTick = r.total / r.nTicks;
  expect(perTick, `${name}: spawns/tick ${perTick.toFixed(3)}`).toBeGreaterThanOrEqual(0.15);
  expect(perTick, `${name}: spawns/tick ${perTick.toFixed(3)}`).toBeLessThanOrEqual(0.55);
  for (const kind of ['loop', 'jump', 'imp', 'zombie'] as GibEventKind[]) {
    expect(r.counts[kind], `${name}: ${kind} must spawn (no dead band)`).toBeGreaterThanOrEqual(1);
    expect(
      r.counts[kind] / r.total,
      `${name}: ${kind} share (no flooded band)`,
    ).toBeLessThanOrEqual(0.6);
  }
  expect(r.laneEverPopulated, `${name}: the lookahead lane must be readable`).toBe(true);
}

describe('GIBRIBBON — audio-corpus liveness (the F1 property on the REAL spectral path)', () => {
  const steps = buildSteps();
  let voice: Float32Array;
  let voiceRows: number[][];

  beforeAll(() => {
    voice = renderDemoVoice(steps, MACRO_PARAMS);
    expect(Math.floor(voice.length / GIB_TICK_SAMPLES)).toBe(N_TICKS);
    voiceRows = bandRowsFromAudio(voice);
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

  it('CORPUS 1 — the #701 fixture voice, AS AUDIO, is playable on all four bands', () => {
    expectPlayable('fixture voice', runCorpus(voiceRows));
  });

  it('CORPUS 2 — ⚠ mis-gained variants stay playable: the calibration class is unexpressible', () => {
    // ×0.3 (a timid gain stage) and ×3 hard-clipped (a hot bus) — the exact
    // family of foreign gain changes that killed jump+imp under the old
    // absolute-threshold design. There is no gain anywhere in this path to
    // mis-calibrate, and prominence is per-band-relative, so both play.
    const scaled = (k: number) => {
      const out = new Float32Array(voice.length);
      for (let i = 0; i < voice.length; i++) {
        out[i] = Math.max(-1, Math.min(1, voice[i]! * k));
      }
      return out;
    };
    expectPlayable('fixture ×0.3', runCorpus(bandRowsFromAudio(scaled(0.3))));
    expectPlayable('fixture ×3 clipped', runCorpus(bandRowsFromAudio(scaled(3))));
  });

  it('CORPUS 3 — a QUIET synthetic source (band rows peaking at 0.08) is playable', () => {
    // Extractor-level entries (band rows, not audio): the fold is covered by
    // the audio entries above and its own unit suite; these pin the
    // extractor's own floor/ceiling behaviour.
    const rows: number[][] = [];
    for (let t = 0; t < N_TICKS; t++) {
      rows.push([
        t % 4 === 0 ? 0.08 : 0.01,
        t % 4 === 2 ? 0.06 : 0.01,
        t % 8 === 1 ? 0.07 : 0.008,
        t % 8 === 5 ? 0.05 : 0.01,
      ]);
    }
    expectPlayable('quiet rows', runCorpus(rows));
  });

  it('CORPUS 4 — a HOT clipping source (floor 0.7, peaks pinned at 1.0) is playable', () => {
    const rows: number[][] = [];
    for (let t = 0; t < N_TICKS; t++) {
      rows.push([
        t % 4 === 0 ? 1.0 : 0.7,
        t % 4 === 2 ? 1.0 : 0.75,
        t % 8 === 1 ? 1.0 : 0.72,
        t % 8 === 5 ? 1.0 : 0.7,
      ]);
    }
    expectPlayable('hot rows', runCorpus(rows));
  });

  it('CORPUS 5 — SILENCE and a STATIONARY TONE spawn NOTHING (the resting floor, on audio)', () => {
    // Through the FULL audio path: digital silence, and an unchanging 440 Hz
    // sine (music that never changes is not "interesting frequency changes").
    const silence = new Float32Array(N_TICKS * GIB_TICK_SAMPLES);
    expect(runCorpus(bandRowsFromAudio(silence)).total, 'silence').toBe(0);
    const tone = new Float32Array(N_TICKS * GIB_TICK_SAMPLES);
    for (let i = 0; i < tone.length; i++) tone[i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / SR);
    expect(runCorpus(bandRowsFromAudio(tone)).total, 'stationary tone').toBe(0);
  });

  it('NEGATIVE GUARD — a BASS-ONLY source spawns loops and NOTHING ELSE (band identity holds)', () => {
    // A smoothly gated 60 Hz sine: energy stays in the bass band (the
    // raised-cosine envelope keeps the gating clickless), so the property
    // can FAIL — three bands report dead, exactly as they should.
    const smp = new Float32Array(N_TICKS * GIB_TICK_SAMPLES);
    for (let i = 0; i < smp.length; i++) {
      const tickPos = (i % GIB_TICK_SAMPLES) / GIB_TICK_SAMPLES;
      const beatOn = Math.floor(i / GIB_TICK_SAMPLES) % 2 === 0;
      const env = beatOn ? 0.5 * (1 - Math.cos(2 * Math.PI * Math.min(1, tickPos * 2))) : 0;
      smp[i] = 0.8 * env * Math.sin((2 * Math.PI * 60 * i) / SR);
    }
    const r = runCorpus(bandRowsFromAudio(smp));
    expect(r.counts.loop, 'bass → LOOP').toBeGreaterThan(0);
    expect(r.counts.imp + r.counts.zombie, 'no monsters without highs').toBe(0);
  });

  it('determinism: the corpus run is identical across invocations (same seed)', () => {
    const a = runCorpus(voiceRows);
    const b = runCorpus(voiceRows);
    expect(a).toEqual(b);
  });
});
