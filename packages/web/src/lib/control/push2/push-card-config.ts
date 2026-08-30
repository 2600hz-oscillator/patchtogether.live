// packages/web/src/lib/control/push2/push-card-config.ts
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │  THE PUSH CARD CONFIG — EDIT THIS FILE TO CHANGE WHAT THE PUSH SHOWS.     │
// └──────────────────────────────────────────────────────────────────────────┘
//
// Every module has a PUSH CARD: the view it shows on the Push 2's 960×160
// display. The card carries up to EIGHT controls — one per display encoder,
// left to right — and each one draws its name, a bar graph of its value and
// its formatted readout. Turning encoder N turns control N.
//
// This file is the TEXT SCHEMA for that choice. One line per module:
//
//     <moduleType>: ['<paramId>', '<paramId>', … up to 8],
//
// LEFT TO RIGHT = ENCODER 1 TO ENCODER 8. Fewer than 8 ids is fine — the
// remaining strips stay blank. More than 8 is a config error (the gate fails).
//
// ── HOW A CARD IS CHOSEN (three tiers, first match wins) ───────────────────
//
//   1. OVERRIDE  — an entry in this file. It REPLACES the ranking outright;
//                  it does not merge with anything. Three ids = three strips.
//   2. FACE      — no entry here → the first 8 turnable params of the module's
//                  curated `face.order` (the same priority ranking the lane
//                  tile and the dock faceplate use). Preset selectors, step
//                  grids and momentary press-pads are skipped — an encoder can
//                  only turn a value.
//   3. GENERIC   — an un-faced module → the params in the order the module
//                  DECLARES them, with plain on/off switches demoted to the
//                  end (a two-state switch is a poor use of a bar graph).
//                  This is the "general audio module" / "general video module"
//                  card: same rule, both domains.
//
// So: you only need an entry here when the default is WRONG for the hardware.
// Delete an entry and the module falls back to its face ranking.
//
// ── TYPO SAFETY ───────────────────────────────────────────────────────────
//
// `push-card-schema.test.ts` (plain unit lane, ~0 CI cost) reads the LIVE
// module registry and fails if any id here is not a real, turnable param of
// that module — naming the module, the bad id, and printing the valid ids:
//
//     push-card-config: dx7 → unknown control 'feedbck'
//       valid params: algorithm, feedback, voiceCount, level, transpose, …
//
// That gate is the whole reason this file is safe to hand-edit. At RUNTIME an
// unresolvable id is dropped with one console.warn and leaves a blank strip —
// never a blank screen.
//
// ⚠ Ids are PARAM IDS from the module def (`packages/web/src/lib/audio/modules/
// <module>.ts` → `params: [{ id: … }]`), not the labels printed on the card.

/**
 * Per-module push-card control order. Keys are module TYPES; values are up to
 * eight ParamDef ids, encoder 1 → 8. Absent module = the face/generic default.
 */
export const PUSH_CARD_CONTROLS: Readonly<Record<string, readonly string[]>> = {
  // CHROMACONSOLE — the override is the COMPLETE slot list, so this cannot
  // drift. The module declares exactly 8 params and the Push card shows
  // exactly 8 controls, which means there is no ranking left to do and no
  // future param addition that could walk one off the card. That is a
  // stronger property than a pinned override: correct by construction
  // rather than correct because somebody remembered to pin it.
  chromaconsole: ['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7', 'slot8'],
  // ── ptzcam ───────────────────────────────────────────────────────────────
  // Four params, four encoders, pinned so a future param addition cannot
  // silently re-rank a card that may be driven live on stage.
  ptzcam: ['pan', 'tilt', 'zoom', 'slew'],
  // ── dx7 ──────────────────────────────────────────────────────────────────
  // The face ranks the PRESET SELECTOR first, but that is a control FAMILY
  // (node.data-backed picker), not a turnable param, so it can never be an
  // encoder strip. Ranking FEEDBACK first puts the one knob you actually ride
  // under encoder 1, and ALGORITHM — the module's whole character — next to it.
  // The tail is the amp envelope in A-D-S-R order so the four encoders read
  // like the envelope's shape; that drops `voiceCount` (a setup value, not a
  // performance one) which the face window would otherwise have kept.
  dx7: ['feedback', 'algorithm', 'level', 'transpose', 'attack', 'decay', 'sustain', 'release'],

  // ── adsr ─────────────────────────────────────────────────────────────────
  // Four params, so nothing is lost either way — but the face ranks them by
  // IMPORTANCE (attack, release, sustain, decay) and on a hardware surface an
  // envelope wants its four encoders in ENVELOPE order, left to right, so the
  // knobs trace the shape you are drawing.
  adsr: ['attack', 'decay', 'sustain', 'release'],

  // ── vca ──────────────────────────────────────────────────────────────────
  // Only two params. Listed explicitly so the card is stated rather than
  // inferred: the offset you set by hand, then how much CV rides on top.
  // `cvAmount` is bipolar (−1..1) — its bar is anchored at CENTRE.
  vca: ['base', 'cvAmount'],

  // ── lfo ──────────────────────────────────────────────────────────────────
  // Three params, in the order you reach for them: how fast, what shape,
  // how much.
  lfo: ['rate', 'shape', 'depth'],

  // ── tidyVco ──────────────────────────────────────────────────────────────
  // A whole voice with 25 params, so the window is a real curation. Grouped by
  // SECTION so the encoder row reads as a signal path: encoders 1-3 are the two
  // oscillators and their blend, 4-5 the tuning between them, 6-8 the filter.
  // The face window instead led with shape1/pw/cutoff/detune/oct2/res/fold/env,
  // which interleaves osc and filter; this keeps a hand on one section at a
  // time. `oct2` (−1..1 discrete) and `env` (−1..1) are both centre-anchored.
  tidyVco: ['shape1', 'shape2', 'mix', 'detune', 'oct2', 'cutoff', 'res', 'env'],

  // ── kickdrum ─────────────────────────────────────────────────────────────
  // 25 params. The pitch envelope is the whole instrument, so TUNE / AMOUNT /
  // TIME sit together under encoders 1-3 where you can sweep them as a unit;
  // then the three body levels, then drive and output. The face window split
  // pitch_amt (4) from pitch_time (7) with the level knobs in between.
  kickdrum: ['tune', 'pitch_amt', 'pitch_time', 'sub_decay', 'body_level', 'click_level', 'drive', 'level'],

  // ── cloudseed ────────────────────────────────────────────────────────────
  // 46 params — by far the widest face. The card is the classic reverb layout:
  // the preset macro first (it moves everything else), then SIZE and DECAY,
  // then the three-way dry / early / late balance, then the two cuts. The face
  // window led with the output mix and buried preset_index at rank 8.
  cloudseed: [
    'preset_index',
    'late_line_size',
    'late_line_decay',
    'dry_out',
    'early_out',
    'late_out',
    'low_cut',
    'high_cut',
  ],

  // ── warren's spectrum ────────────────────────────────────────────────────
  // 11 params. The generic tier would currently pick the same eight off param
  // order, but an EXPLICIT entry is the point: a push card is resolved from
  // the LIVE def, so adding or renaming a param on this module (phases 2-5 add
  // ~90 of them) would silently re-rank the card and walk the 8th control off
  // the display. An override REPLACES, so it cannot drift.
  //
  // Encoders 1-4 are what the module IS — density, harmonicity, the noise/sine
  // balance, and the analysis rate. 5 is the one PERFORMATIVE control (FREEZE
  // is a gesture, not a setting, so it sits under a thumb rather than at the
  // end). 6-8 are the peak gate + the voice colour. GAIN, SLEW and CENTER are
  // deliberately off: every module has a gain, and SLEW/CENTER are set-and-
  // leave rather than played.
  warrensspectrum: [
    'spectralPartials',
    'spectralLock',
    'spectralResidual',
    'spectralSlice',
    'engineFreeze',
    'spectralFloor',
    'spectralStab',
    'spectralShape',
  ],

  // ── mixmstrs ─────────────────────────────────────────────────────────────
  // EIGHT CHANNELS, EIGHT ENCODERS. This is the one module in the fleet where
  // the hardware's arity and the module's arity are the same number, so the
  // card is not a curation at all — it is the console, one strip per encoder,
  // left to right.
  //
  // ⚠ AND THE FACE TIER WOULD GET IT WRONG, which is why the override exists.
  // mixmstrs' `face.order` deliberately ranks the ELEVEN BUS-SCOPED controls
  // first (master, the two return levels, the two PRE/POST switches, the six
  // return EQ bands) so that no LANE tier ever privileges one interchangeable
  // channel over another. That is the right answer for a 46 px knob column and
  // the wrong one for eight encoders: taking the first 8 turnable ranks would
  // put the master and a reverb return's EQ under your hands and leave every
  // channel fader off the display.
  //
  // An override REPLACES rather than merges, so this also pins the card against
  // the drift CLAUDE.md warns about — `.myrobots/stereo-audio-plan/plan.md`
  // PR-6 adds eight `pan{N}` params to this module, which would otherwise
  // re-rank the generic tier underneath it.
  //
  // Spelled out rather than generated from `MIXMSTRS_CHANNELS`: this file is a
  // deliberately dependency-free text schema (its header says so), and
  // `push-card-schema.test.ts` reads the LIVE registry and fails on any id that
  // is not a real turnable param — so a renamed or removed channel is RED here,
  // anchored to the artifact rather than to a count.
  mixmstrs: [
    'ch1_volume', 'ch2_volume', 'ch3_volume', 'ch4_volume',
    'ch5_volume', 'ch6_volume', 'ch7_volume', 'ch8_volume',
  ],
};
