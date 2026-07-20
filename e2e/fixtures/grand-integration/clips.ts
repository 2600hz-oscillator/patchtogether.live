// e2e/fixtures/grand-integration/clips.ts
//
// THE shared clip + automation fixture for the GRAND-INTEGRATION scenario
// (.myrobots/plans/grand-integration-e2e-art-2026-07-19.md). It is imported by
// BOTH:
//   - the heavy browser attest spec (e2e/tests/grand-integration.attest.spec.ts)
//     — seeds these exact clips into the pinned clip player, and
//   - the OFFLINE combined-master ART (art/scenarios/grand-integration/…) via the
//     pure clip driver (art/setup/clip-driver.ts).
// Sharing ONE fixture is the whole point: the pinned audio (offline ART) and the
// live browser assertions replay the SAME note/automation schedule, so they
// cannot silently drift. The fixture is therefore IN the grand-attest hash basis
// (scripts/grand-attest-lib.ts).
//
// IMPORT-SAFETY (load-bearing): this module is pure DATA with a single
// `import type` (fully erased by esbuild at build time). It must NOT gain any
// RUNTIME import — the Playwright/e2e runner does not resolve the SvelteKit
// `$lib/…` alias, and `clip-types.ts` imports `$lib/…`. Keeping the clip indices
// as literal numbers (documented against `clipIndex(slot, lane) = lane*64 + slot`)
// lets the same file load in the e2e runner AND the ART node env with zero
// runtime dependencies.
//
// COARSE ON PURPOSE: whole-step (1/16), integer-midi notes, short 4-step loops.
// The in-flight clip-player live-record redesign (a HELD PR, not on main) may
// shift note-recorder timing later; a coarse fixture keeps the offline↔browser
// step→sound alignment robust across that change (see the plan's risk note).

import type { NoteClipRecord, AutoClipRecord } from '../../../packages/web/src/lib/audio/modules/clip-types';

// ---------------------------------------------------------------------------
// Transport / grid
// ---------------------------------------------------------------------------

/** Transport tempo. Fast + short so the whole scenario is a few seconds of
 *  audio (deterministic-speed constraint — the plan §5). */
export const GRAND_BPM = 200;

/** TIMELORDE `stepDiv` param INDEX (clipplayer STEP_DIV_SPB = [1,2,4,8]).
 *  Index 2 → 4 steps/beat = 1/16 notes → baseStepDur = 60/bpm/4 = 0.075 s @ 200. */
export const GRAND_STEP_DIV_INDEX = 2;
const STEP_DIV_SPB = [1, 2, 4, 8] as const;

/** Base step duration (s) at the fixture's bpm + stepDiv — the clip player's
 *  `60/bpm/STEP_DIV_SPB[stepDiv]` (clipplayer.ts). All lanes run at rate '1'. */
export const GRAND_BASE_STEP_DUR = 60 / GRAND_BPM / STEP_DIV_SPB[GRAND_STEP_DIV_INDEX];

/** Uniform clip length — every lane's clips are 4-step loops (~0.3 s @ 200 bpm). */
export const GRAND_CLIP_STEPS = 4;

// ---------------------------------------------------------------------------
// Lane → module + clip-index map (clipIndex(slot, lane) = lane*64 + slot)
// ---------------------------------------------------------------------------

/** The four instrument lanes, in channel order (ch = lane+1 on the master mixer). */
export const GRAND_LANES = {
  kick: 0, // ch1 — kickdrum, gate1 → trigger_in
  snare: 1, // ch2 — snaredrum, gate2 → trigger_in
  tidy: 2, // ch3 — tidyVco (MONO): pitch3 → pitch, gate3 → gate
  sixstrum: 3, // ch4 — sixstrum, pitch4 → poly
} as const;

/** Flat clip indices per lane for slot 0 and slot 1 (lane*64 + slot). Two clips
 *  per lane so the scenario proves "notes in MULTIPLE clips and are playing." */
export const GRAND_CLIP_IDX = {
  kick: [0, 1],
  snare: [64, 65],
  tidy: [128, 129],
  sixstrum: [192, 193],
} as const;

// ---------------------------------------------------------------------------
// The note clips (keyed by the flat clip-index STRING, the `data.clips` shape)
// ---------------------------------------------------------------------------

function noteClip(
  steps: { step: number; midi: number; velocity?: number; lengthSteps?: number }[],
  root = 48, // C3 editor root — playback pitch comes from each event's absolute midi
): NoteClipRecord {
  return { kind: 'note', steps, lengthSteps: GRAND_CLIP_STEPS, root, loop: true };
}

/** MIDI note constants used below (kept explicit — no Math, no derivation). */
const KICK_MIDI = 36; // C1 — a kick is trigger-driven; midi is irrelevant to the voice
const SNARE_MIDI = 38; // D1 — likewise trigger-driven

export const GRAND_CLIPS: Record<string, NoteClipRecord> = {
  // ── lane 0 · KICK (trigger-struck) ──
  // slot 0: four-on-the-floor-ish — hits on steps 0 and 2.
  '0': noteClip([
    { step: 0, midi: KICK_MIDI, velocity: 120 },
    { step: 2, midi: KICK_MIDI, velocity: 110 },
  ]),
  // slot 1: busier variation — every step.
  '1': noteClip([
    { step: 0, midi: KICK_MIDI, velocity: 120 },
    { step: 1, midi: KICK_MIDI, velocity: 90 },
    { step: 2, midi: KICK_MIDI, velocity: 110 },
    { step: 3, midi: KICK_MIDI, velocity: 90 },
  ]),

  // ── lane 1 · SNARE (trigger-struck) ──
  // slot 0: backbeat — steps 1 and 3.
  '64': noteClip([
    { step: 1, midi: SNARE_MIDI, velocity: 115 },
    { step: 3, midi: SNARE_MIDI, velocity: 115 },
  ]),
  // slot 1: variation — steps 1, 2, 3 (a little roll on the back half).
  '65': noteClip([
    { step: 1, midi: SNARE_MIDI, velocity: 115 },
    { step: 2, midi: SNARE_MIDI, velocity: 80 },
    { step: 3, midi: SNARE_MIDI, velocity: 115 },
  ]),

  // ── lane 2 · TIDY VCO (MONO melody: one note per step) ──
  // slot 0: C4 · E4 · G4 · E4 — a simple arpeggio.
  '128': noteClip([
    { step: 0, midi: 60, velocity: 100 },
    { step: 1, midi: 64, velocity: 100 },
    { step: 2, midi: 67, velocity: 100 },
    { step: 3, midi: 64, velocity: 100 },
  ]),
  // slot 1: transposed up a fourth — F4 · A4 · C5 · A4.
  '129': noteClip([
    { step: 0, midi: 65, velocity: 100 },
    { step: 1, midi: 69, velocity: 100 },
    { step: 2, midi: 72, velocity: 100 },
    { step: 3, midi: 69, velocity: 100 },
  ]),

  // ── lane 3 · SIX STRUM (poly chords: stacked midis on one step) ──
  // slot 0: C major on step 0, F major on step 2 (held 2 steps each).
  '192': noteClip([
    { step: 0, midi: 60, velocity: 100, lengthSteps: 2 },
    { step: 0, midi: 64, velocity: 100, lengthSteps: 2 },
    { step: 0, midi: 67, velocity: 100, lengthSteps: 2 },
    { step: 2, midi: 65, velocity: 100, lengthSteps: 2 },
    { step: 2, midi: 69, velocity: 100, lengthSteps: 2 },
    { step: 2, midi: 72, velocity: 100, lengthSteps: 2 },
  ]),
  // slot 1: A minor on step 0, G major on step 2.
  '193': noteClip([
    { step: 0, midi: 57, velocity: 100, lengthSteps: 2 },
    { step: 0, midi: 60, velocity: 100, lengthSteps: 2 },
    { step: 0, midi: 64, velocity: 100, lengthSteps: 2 },
    { step: 2, midi: 55, velocity: 100, lengthSteps: 2 },
    { step: 2, midi: 59, velocity: 100, lengthSteps: 2 },
    { step: 2, midi: 62, velocity: 100, lengthSteps: 2 },
  ]),
};

// ---------------------------------------------------------------------------
// The SEEDED automation envelope — tidy-vco CUTOFF on the tidy lane's slot-0
// clip. Used by BOTH:
//   - the OFFLINE ART: the pure driver reads this envelope and drives the tidy
//     core's `cutoff` param (so the pinned audio genuinely carries "automation
//     played back"), and
//   - the BROWSER exact-value assertion: it seeds this envelope, freezes at a
//     known step, and asserts engine.readParam('t','cutoff') ≈ the expected
//     denormalized value.
//
// The browser's LIVE automation RECORD proof runs on a DIFFERENT lane (sixstrum,
// which starts with NO automation) so `readAutoEvents(...).length > 1` is a true
// record signal, not the seed leaking in.
// ---------------------------------------------------------------------------

/** Node id the browser scenario gives the tidy-vco instrument (see the spec). */
export const GRAND_TIDY_NODE_ID = 't';
export const GRAND_TIDY_CUTOFF_PARAM = 'cutoff';

/** `automationTargetKey(t.cutoff)` — the `data.auto[idx].tracks` key. */
export const GRAND_TIDY_CUTOFF_KEY = `${GRAND_TIDY_NODE_ID}::${GRAND_TIDY_CUTOFF_PARAM}`;

/** tidy-vco `cutoff` ParamDef domain (min/max/curve) — pinned here so the ART
 *  driver's normalized→Hz denormalization and the browser's exact-value check
 *  use the SAME mapping. (tidy-vco.ts: min 40, max 14000, curve 'log'.) */
export const GRAND_TIDY_CUTOFF_MIN = 40;
export const GRAND_TIDY_CUTOFF_MAX = 14000;

/** Denormalize a 0..1 automation value to Hz on the log cutoff curve
 *  (value = min·(max/min)^norm) — the conventional log-param mapping. */
export function grandDenormCutoff(norm: number): number {
  const n = norm < 0 ? 0 : norm > 1 ? 1 : norm;
  return GRAND_TIDY_CUTOFF_MIN * Math.pow(GRAND_TIDY_CUTOFF_MAX / GRAND_TIDY_CUTOFF_MIN, n);
}

/** The seeded cutoff envelope: a bright-open sweep across the 4-step loop
 *  (breakpoints at whole steps; the offline driver LINEAR-interpolates them and
 *  loops the position, so the cutoff opens and closes each loop). Normalized
 *  0..1 in param space (the same 0..1 a knob reports). */
export const GRAND_TIDY_CUTOFF_EVENTS = [
  { step: 0, value: 0.2 },
  { step: 1, value: 0.85 },
  { step: 2, value: 0.55 },
  { step: 3, value: 0.35 },
] as const;

/** The seeded `data.auto` map — the tidy lane's slot-0 clip (idx 128) carries the
 *  cutoff envelope; every other clip starts clean. */
export const GRAND_AUTO: Record<string, AutoClipRecord> = {
  '128': {
    tracks: {
      [GRAND_TIDY_CUTOFF_KEY]: {
        events: GRAND_TIDY_CUTOFF_EVENTS.map((e) => ({ step: e.step, value: e.value })),
        interp: 'linear',
      },
    },
  },
};
