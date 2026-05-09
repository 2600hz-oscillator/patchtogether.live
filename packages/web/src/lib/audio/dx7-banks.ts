// packages/web/src/lib/audio/dx7-banks.ts
//
// Hand-crafted DX7 patches inspired by famous ROM 1A factory voices. None of
// these are literal SYX bytes from a copyright-protected ROM — each is a new
// patch tuned to evoke the SOUND of its inspiration. The original Yamaha
// ROM 1A SYX (and its many archive copies) contain Yamaha's specific
// envelope/level numbers, which we deliberately don't ship.
//
// Each patch is built using the same `DX7Voice` shape parseSyxBank() returns,
// so the worklet's patch loader can consume them directly. The
// `dx7-banks.test.ts` ART scenarios verify each preset's spectral signature
// matches the named instrument family.
//
// Patch design philosophy:
//   - Algorithm choice matches the canonical DX7 factory voice for that
//     family (algorithm 5 for E.Piano-style FM Rhodes, etc.).
//   - Per-operator levels chosen by ear in iteration; final values committed
//     after listening to each patch with a sustained C3 chord.
//   - Envelopes simplified vs. the full DX7 (we use 4 levels but typically
//     only target the dominant ones — slow attacks, decay-to-sustain, fast
//     release — rather than the more nuanced 4-segment shapes Yamaha used).
//
// Adding new patches: copy a similar-family entry and tweak. Then run
// `flox activate -- task art` and inspect the new ART scenario's spectrum.

import type { DX7Voice, DX7OpData } from './dx7-syx';
import { dx7DetuneFactor } from './dx7-syx';

/**
 * Helper to build a DX7OpData. `r` and `l` are 0..99 envelope shorthand;
 * `coarse`/`fine` set the ratio (matches dx7-syx.ts indexing).
 */
function op(args: {
  r: [number, number, number, number];
  l: [number, number, number, number];
  coarse: number;
  fine?: number;
  detune?: number;
  level: number;
  velSens?: number;
  fixed?: boolean;
}): DX7OpData {
  const fine = args.fine ?? 0;
  const detune = args.detune ?? 7;
  const c = args.coarse;
  const base = c === 0 ? 0.5 : c;
  const ratio = base * (1 + fine / 100);
  return {
    r: args.r,
    l: args.l,
    ratio,
    level: args.level,
    detune,
    detuneFactor: dx7DetuneFactor(detune),
    velocitySens: args.velSens ?? 0,
    fixedMode: args.fixed ?? false,
  };
}

function emptyPitchEg(): DX7Voice['pitchEg'] {
  return { r: [99, 99, 99, 99], l: [50, 50, 50, 50] };
}
function emptyLfo(): DX7Voice['lfo'] {
  return { speed: 35, delay: 0, pmd: 0, amd: 0, sync: false, waveform: 0, pitchModSens: 0 };
}

// ---------------- E.PIANO 1 — the iconic FM Rhodes ----------------
//
// Inspired by ROM 1A "E.PIANO 1". Algorithm 5 (3 carriers, 3 modulators).
// The classic voicing pairs op1 (carrier, ratio 1) with op2 (modulator,
// ratio 14) — that high ratio gives the "bell" character. Op3+op4 give body,
// op5+op6 add a subtle high-end shimmer.
const E_PIANO_1: DX7Voice = {
  name: 'E.PIANO 1',
  algorithm: 5,
  feedback: 4,
  operators: [
    /* op1 = carrier (body) */ op({ r: [99, 30, 25, 60], l: [99, 80, 60, 0], coarse: 1, level: 99, velSens: 4 }),
    /* op2 = high modulator (FM bell) */ op({ r: [99, 50, 35, 70], l: [99, 60, 30, 0], coarse: 14, level: 78, velSens: 6 }),
    /* op3 = carrier (mid body) */ op({ r: [99, 35, 30, 60], l: [99, 75, 50, 0], coarse: 1, fine: 0, detune: 8, level: 90, velSens: 4 }),
    /* op4 = modulator */ op({ r: [99, 60, 40, 65], l: [99, 50, 25, 0], coarse: 1, level: 60, velSens: 5 }),
    /* op5 = carrier (low body) */ op({ r: [99, 35, 30, 60], l: [99, 70, 45, 0], coarse: 1, fine: 0, detune: 6, level: 78, velSens: 4 }),
    /* op6 = modulator (subtle harmonics) */ op({ r: [99, 50, 35, 65], l: [99, 50, 25, 0], coarse: 1, level: 50, velSens: 3 }),
  ],
  pitchEg: emptyPitchEg(),
  lfo: emptyLfo(),
  transpose: 24,
};

// ---------------- BASS 1 — punchy FM bass ----------------
//
// Inspired by ROM 1A "BASS 1". Algorithm 16 (1 carrier, all others modulate
// it via a mini stack). Quick attack, exponential decay, no sustain — like
// a plucked bass.
const BASS_1: DX7Voice = {
  name: 'BASS 1',
  algorithm: 16,
  feedback: 6,
  operators: [
    /* op1 = the only carrier */ op({ r: [99, 25, 15, 70], l: [99, 65, 0, 0], coarse: 1, level: 99 }),
    /* op2 = modulator (gives punch) */ op({ r: [99, 40, 30, 70], l: [99, 50, 0, 0], coarse: 1, level: 80 }),
    /* op3 = modulator (high harmonics) */ op({ r: [99, 50, 40, 70], l: [99, 45, 0, 0], coarse: 3, level: 65 }),
    /* op4 = modulator */ op({ r: [99, 35, 25, 70], l: [99, 60, 0, 0], coarse: 1, level: 50 }),
    /* op5 = modulator */ op({ r: [99, 50, 35, 70], l: [99, 40, 0, 0], coarse: 5, level: 55 }),
    /* op6 = self-feedback modulator */ op({ r: [99, 60, 45, 70], l: [99, 35, 0, 0], coarse: 2, level: 60 }),
  ],
  pitchEg: emptyPitchEg(),
  lfo: emptyLfo(),
  transpose: 12, // tuned an octave below middle C — bass register
};

// ---------------- HARMONICA — breathy reed timbre ----------------
//
// Inspired by ROM 1A "HARMONICA". Algorithm 19 (3 carriers, op4 stack on op3,
// op6 modulates op5). Slow attack to simulate "breath".
const HARMONICA: DX7Voice = {
  name: 'HARMONICA',
  algorithm: 19,
  feedback: 3,
  operators: [
    op({ r: [50, 30, 25, 60], l: [99, 85, 75, 0], coarse: 1, level: 99 }),
    op({ r: [60, 35, 25, 60], l: [99, 80, 70, 0], coarse: 1, fine: 5, detune: 9, level: 90 }),
    op({ r: [55, 30, 25, 60], l: [99, 80, 70, 0], coarse: 2, level: 70 }),
    op({ r: [80, 50, 35, 65], l: [99, 60, 40, 0], coarse: 4, level: 65 }),
    op({ r: [45, 30, 25, 60], l: [99, 75, 65, 0], coarse: 1, fine: 0, detune: 5, level: 85 }),
    op({ r: [70, 40, 30, 60], l: [99, 60, 45, 0], coarse: 5, level: 60 }),
  ],
  pitchEg: emptyPitchEg(),
  lfo: { ...emptyLfo(), pmd: 5, speed: 50 }, // slight vibrato
  transpose: 24,
};

// ---------------- STRINGS 1 — lush evolving pad ----------------
//
// Inspired by ROM 1A "STRINGS 1". Algorithm 22 (4 carriers feeding from
// modulator op5). Slow attack + slow release.
const STRINGS_1: DX7Voice = {
  name: 'STRINGS 1',
  algorithm: 22,
  feedback: 2,
  operators: [
    op({ r: [25, 20, 18, 30], l: [99, 90, 80, 0], coarse: 1, level: 95 }),
    op({ r: [25, 20, 18, 30], l: [99, 90, 80, 0], coarse: 1, fine: 5, detune: 9, level: 90 }),
    op({ r: [30, 25, 20, 35], l: [99, 85, 75, 0], coarse: 1, fine: 0, detune: 5, level: 85 }),
    op({ r: [25, 20, 18, 30], l: [99, 90, 80, 0], coarse: 1, fine: 3, detune: 6, level: 90 }),
    op({ r: [50, 30, 25, 40], l: [99, 70, 60, 0], coarse: 1, level: 75 }),
    op({ r: [30, 25, 20, 35], l: [99, 80, 70, 0], coarse: 2, level: 70 }),
  ],
  pitchEg: emptyPitchEg(),
  lfo: { ...emptyLfo(), pmd: 3, speed: 30 },
  transpose: 24,
};

// ---------------- MARIMBA — percussive mallet ----------------
//
// Inspired by ROM 1A "MARIMBA". Algorithm 7 — short percussive envelope.
const MARIMBA: DX7Voice = {
  name: 'MARIMBA',
  algorithm: 7,
  feedback: 0,
  operators: [
    op({ r: [99, 50, 40, 75], l: [99, 50, 0, 0], coarse: 1, level: 99 }),
    op({ r: [99, 60, 50, 80], l: [99, 35, 0, 0], coarse: 4, level: 70 }),
    op({ r: [99, 55, 45, 75], l: [99, 40, 0, 0], coarse: 1, fine: 5, level: 90 }),
    op({ r: [99, 70, 55, 80], l: [99, 25, 0, 0], coarse: 7, level: 60 }),
    op({ r: [99, 65, 50, 80], l: [99, 30, 0, 0], coarse: 9, level: 50 }),
    op({ r: [99, 75, 60, 80], l: [99, 25, 0, 0], coarse: 11, level: 45 }),
  ],
  pitchEg: emptyPitchEg(),
  lfo: emptyLfo(),
  transpose: 24,
};

// ---------------- TUB BELLS — hammered bell tone ----------------
//
// Algorithm 8 — short attack + long bell-like decay with inharmonic ratios.
const TUB_BELLS: DX7Voice = {
  name: 'TUB BELLS',
  algorithm: 8,
  feedback: 4,
  operators: [
    op({ r: [99, 18, 12, 60], l: [99, 70, 30, 0], coarse: 1, level: 99 }),
    op({ r: [99, 22, 15, 60], l: [99, 60, 25, 0], coarse: 3, fine: 50, level: 75 }),
    op({ r: [99, 20, 14, 60], l: [99, 65, 28, 0], coarse: 1, fine: 30, detune: 9, level: 90 }),
    op({ r: [99, 28, 18, 65], l: [99, 50, 20, 0], coarse: 7, level: 60 }),
    op({ r: [99, 25, 16, 60], l: [99, 55, 24, 0], coarse: 5, fine: 40, level: 65 }),
    op({ r: [99, 35, 22, 65], l: [99, 40, 15, 0], coarse: 14, level: 50 }),
  ],
  pitchEg: emptyPitchEg(),
  lfo: emptyLfo(),
  transpose: 24,
};

// ---------------- BRASS 1 — punchy FM brass ----------------
//
// Inspired by ROM 1A "BRASS 1". Algorithm 22 with strong attack on the
// modulators (the "brass swell" comes from envelope-shaped FM index).
const BRASS_1: DX7Voice = {
  name: 'BRASS 1',
  algorithm: 22,
  feedback: 6,
  operators: [
    op({ r: [80, 40, 25, 60], l: [99, 85, 75, 0], coarse: 1, level: 99 }),
    op({ r: [80, 40, 25, 60], l: [99, 80, 70, 0], coarse: 1, detune: 9, level: 90 }),
    op({ r: [80, 40, 25, 60], l: [99, 80, 70, 0], coarse: 1, fine: 0, detune: 5, level: 85 }),
    op({ r: [85, 45, 30, 65], l: [99, 75, 65, 0], coarse: 1, fine: 5, detune: 6, level: 80 }),
    op({ r: [70, 35, 22, 60], l: [99, 90, 80, 0], coarse: 1, level: 90 }),
    op({ r: [85, 45, 30, 65], l: [99, 70, 60, 0], coarse: 2, level: 75 }),
  ],
  pitchEg: emptyPitchEg(),
  lfo: emptyLfo(),
  transpose: 24,
};

// ---------------- CALLIOPE — flutey lead ----------------
//
// Algorithm 32 — all 6 operators are carriers (organ-style additive). Each
// op runs on its own harmonic.
const CALLIOPE: DX7Voice = {
  name: 'CALLIOPE',
  algorithm: 32,
  feedback: 0,
  operators: [
    op({ r: [70, 30, 25, 50], l: [99, 90, 80, 0], coarse: 1, level: 99 }),
    op({ r: [70, 30, 25, 50], l: [99, 75, 65, 0], coarse: 2, level: 80 }),
    op({ r: [70, 30, 25, 50], l: [99, 65, 55, 0], coarse: 3, level: 70 }),
    op({ r: [70, 30, 25, 50], l: [99, 55, 45, 0], coarse: 4, level: 60 }),
    op({ r: [70, 30, 25, 50], l: [99, 45, 35, 0], coarse: 5, level: 50 }),
    op({ r: [70, 30, 25, 50], l: [99, 35, 25, 0], coarse: 6, level: 40 }),
  ],
  pitchEg: emptyPitchEg(),
  lfo: { ...emptyLfo(), pmd: 4, speed: 45 },
  transpose: 24,
};

// ---------------- WIRE LEAD — synth-lead "DX7 lead" ----------------
//
// Algorithm 1 — classic 3+3 stack. Feedback on op6 gives the buzz/edge.
const WIRE_LEAD: DX7Voice = {
  name: 'WIRE LEAD',
  algorithm: 1,
  feedback: 7,
  operators: [
    op({ r: [99, 35, 30, 60], l: [99, 85, 75, 0], coarse: 1, level: 99 }),
    op({ r: [99, 40, 30, 60], l: [99, 65, 50, 0], coarse: 4, level: 80 }),
    op({ r: [99, 35, 30, 60], l: [99, 80, 70, 0], coarse: 1, fine: 5, detune: 9, level: 90 }),
    op({ r: [99, 45, 35, 65], l: [99, 60, 45, 0], coarse: 7, level: 70 }),
    op({ r: [99, 35, 30, 60], l: [99, 75, 65, 0], coarse: 1, level: 85 }),
    op({ r: [99, 50, 40, 65], l: [99, 55, 40, 0], coarse: 11, level: 65 }),
  ],
  pitchEg: emptyPitchEg(),
  lfo: emptyLfo(),
  transpose: 24,
};

// ---------------- The bank ----------------

export const DX7_BUILTIN_BANK: DX7Voice[] = [
  E_PIANO_1,
  BASS_1,
  HARMONICA,
  STRINGS_1,
  MARIMBA,
  TUB_BELLS,
  BRASS_1,
  CALLIOPE,
  WIRE_LEAD,
];

/** Look up a builtin patch by name. Case-insensitive. */
export function findBuiltinPatch(name: string): DX7Voice | undefined {
  const target = name.trim().toLowerCase();
  return DX7_BUILTIN_BANK.find((p) => p.name.toLowerCase() === target);
}
