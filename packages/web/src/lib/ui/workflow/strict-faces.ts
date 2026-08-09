// packages/web/src/lib/ui/workflow/strict-faces.ts
//
// The RATCHET set for the workflow-mode UI-CURATION system — the face analog of
// STRICT_DOCS ($lib/docs/strict-docs). A module type in this set has been
// PROMOTED to the full curation bar: its co-located `face` MUST be COMPLETE —
// every param, every declared control family, and every numbered-legend control
// appears in `face.order` (the deny-missing-curation guarantee at the control
// surface), enforced by module-face-lint.test.ts.
//
// Modules NOT in this set are checked only for CONSISTENCY (no orphaned face
// keys) — they degrade gracefully while the ratchet rolls out. The set only
// grows:
//  - every NEW faced module ships into it,
//  - a module incidentally reskinned for a fix is brought up + added (boy-scout),
//  - background batches promote the tail.
//
// P1 BATCH 1 (2026-07-25): the first faced-module wave — six total reworks to
// the gallery spec (see .myrobots/plans, workflow-mode UI refactor §3.6 + §5).
// Each entry below carries a complete co-located `face` (order + pages + glyph)
// authored against its fullcard mock.
//
// P1 BATCH 2 (2026-07-26): the second wave — the two pitched voices (dx7,
// sixstrum), the two percussion voices (snaredrum, tomtom) and the two
// processors (shimmershine, qbrt). Same bar: a complete co-located `face`
// (order + pages + glyph + `rear`), authored from what each module ACTUALLY
// is rather than transcribed from its legacy card. The two pitched voices are
// additionally enrolled in default-pitch-accuracy (unit + e2e).
//
// P1 BATCH 3 (2026-07-26): the third wave — the plucked-string voice (karplus)
// and the four workhorse processors/utilities (filter, mixer, delay, reverb) a
// rack reaches for on every patch. Same bar: a complete co-located `face`
// (order + pages + glyph + `rear`).
//
// FACE BATCH B+ (2026-08-02): ringback — the first module PROMOTED from having
// no face at all in this wave (the batch-B reworks all rewrote existing ones).
// It ships the same bar plus the two things batch B established: the ranges
// live in ONE model module the def AND the card import
// ($lib/audio/ringback-crush-model), and its `glyph`/`order` are checked
// against measurements taken from the real DSP core rather than argued in a
// comment.
//
// FACE BATCH 3 (2026-08-03): the PF-20 wave — clap, drummergirl and
// pentemelodica, plus a RE-DO of sixstrum's shipped face. Faceplates authored
// against what each module IS rather than against its legacy card, each with a
// hero, a declared sidebar and DERIVED readouts registered in
// face-readout-values.ts (never a knob relabelled), negative-controlled
// PERMANENTLY in a per-module `*-face-model.test.ts`.
//
// sixstrum is a RE-DO rather than a promotion, and it is the entry that fixes a
// live defect: its shipped face ranked three next-STRIKE-only controls into the
// lane and had no strike key at all, so under `?shell=1` the dock offered
// twenty controls over an instrument that could not be sounded.
//
// meowbox (2026-08-08) joins that batch as a second promotion-from-nothing, and
// it is the entry that answers a wall drummergirl hit and worked around by
// DEFERRING: `module-face-lint` refuses a PANEL cell SELECTED at a lane tier and
// the 'full' lane cap is SIX, so a hero picture's first legal rank is 7 — which a
// module with four params and one audition can never reach. drummergirl dropped
// its picture and its audition together over this. meowbox ships both, because a
// `sidebar` `custom` block carries no `face.order` key and therefore no rank at
// all: the picture is `formant-bank` in the sidebar and the audition is a
// `mode:'gate'` action at rank 5. Its `gate` port is additionally the first on
// this module to DECLARE `edge` — the def's prose called it a trigger while the
// DSP's `en.adsr` sustains at 0.4, and module-docs-lint's vocabulary check does
// `if (!p.edge) continue`, so the one gate that owns that vocabulary was
// structurally unable to see it.
//
// ⚠ analogVco was authored, verified and then DROPPED from this batch. Its
// `face-analogVco-compact` VRT scene was NOT pixel-deterministic: unlike every
// other faced module, analogVco is a FREE-RUNNING oscillator, so its live
// `scope` glyph was drawing a genuinely moving saw rather than the flat
// centreline the spec header assumed (measured 254 / 154 / 315 px across three
// consecutive captures of the same tile). Its DOCK scene was stable, which
// confirmed the diagnosis — a `hero.cell` suppresses the glyph there.
// FACE BATCH 3 · analogVco (2026-08-08) — the RECOVERY of the face batch 3
// authored, verified and then dropped. Every unit gate passed at the time; the
// blocker was purely the pixel lane, and it is now fixed at the ROOT.
//
// THE BLOCKER WAS NOT WHERE THIS FACE'S OWN BRANCH THOUGHT IT WAS, and the
// correction is the interesting part. analogVco is a FREE-RUNNING oscillator —
// it sounds the instant it spawns — so the live `scope` glyph on its COMPACT
// lane tile drew a genuinely moving saw where every other face drew a flat
// centreline, and the tile could not baseline at all. The recovered branch
// concluded the fix was a `VRT_LIVE_SURFACES` mask plus a measured companion,
// and derived one honestly (1/10 unmasked vs 10/10 masked, 10 processes).
//
// It was treating a SYMPTOM. The cause was that `bootWithFace` never suspended
// the AudioContext, so EVERY face scene captured off a live graph; the roster
// got away with it because all 21 other faces are struck or silent and their
// analysers held zeros either way. #1420 freezes the graph in that ONE shared
// boot path, before the tile is framed, so a free-running voice's glyph tap is
// an analyser on a stopped graph and reads zeros like everyone else's. The mask
// this branch carried was therefore DELETED, not merged: the tile ships fully
// strict, glyph included.
//
// ⚠ AND THIS FACE IS THE FIRST REAL TEST OF THAT FIX. #1420 shipped covered
// only by a SYNTHETIC negative control, because — as its own author flagged —
// no module holding a face was free-running, so nothing in the roster could
// exercise the freeze. analogVco changes that. MEASURED 2026-08-08 (darwin,
// within-subject, vrt-face-audio-probe, 26/255 delta):
//
//   source: port=saw peak=0.999890 moving=1.953397   → genuinely free-running,
//                                                      read at the AnalyserNode
//   frozen pre-frame (shipping)          0 px, and 0 px across two INDEPENDENT
//                                        boots
//   freeze OFF                         394 px, entirely inside the glyph box
//   freeze LATE (wrong ordering)       337 px across independent boots
//
// All 21 other faces read 0 px in both perturbed configurations. So promoting
// this face converts #1420's synthetic-only coverage into REAL roster coverage,
// and it is the only entry that can catch a regression of either the freeze or
// its ORDERING. Gate derivation: 10/10 separate processes, unmasked.
//
// The face itself is unchanged from the verified batch-3 authoring, and its two
// live defects were fixed independently before it landed: the card/def bipolar
// range disagreement (#1311) and the impossible `pw`-with-an-LFO doc (897b6515).
//
// FACE BATCH 3 · macrooscillator (2026-08-09) — the SECOND free-running face,
// and the entry whose argument is that a faceplate must not paint a dead
// control as a working one. Six dials over FOURTEEN engines, three of which
// mean something different in each, so every readout is DERIVED from `model`
// plus the dial rather than read back off a knob.
//
// FOUR of them report a DEFECT rather than a feature (WAVETABLE's morph is
// dead over its bottom half, GRANULAR's is a 3-position switch, MODAL's timbre
// runs backwards, OUT spans 76.6 dB across engines). All four are worklet
// arithmetic, so they are documented rather than fixed — CLAUDE.md, and
// batch-3 INDEX rule 5.
//
// ⚠ THE MEASUREMENTS ARE DELIBERATELY NOT REPEATED HERE. Every number lives in
// `$lib/audio/modules/macro-engine-roster` and is RE-DERIVED from
// `macrooscillatorMath` on every run by `macrooscillator-face-model.test.ts` —
// so a copy in this comment could go stale while the gate stayed green, which
// is the drift this repo keeps re-learning. Freeze numbers likewise live once,
// in the FACES roster (`e2e/vrt/_shell-faces.ts`).

export const STRICT_FACES: ReadonlySet<string> = new Set<string>([
  // P1 batch 1 — first 6 module faces
  'adsr',
  'cloudseed',
  'kickdrum',
  'lfo',
  'tidyVco',
  'vca',
  // P1 batch 2 — 6 more faces (2 pitched voices, 2 drums, 2 processors)
  'dx7',
  'qbrt',
  'shimmershine',
  'sixstrum',
  'snaredrum',
  'tomtom',
  // P1 batch 3 — 5 more faces (1 voice, 4 processors/utility)
  'delay',
  'filter',
  'karplus',
  'mixer',
  'reverb',
  // face batch B+ — the stereo crush (first promotion from no face at all)
  'ringback',
  // FACE BATCH 3 (2026-08-03) — see the header note above.
  'clap',
  'drummergirl',
  'pentemelodica',
  // FACE BATCH 3, cont. (2026-08-08) — see the header note above.
  'meowbox',
  // FACE BATCH 3 · the recovered free-running oscillator (2026-08-08).
  'analogVco',
  // FACE BATCH 3 · the fourteen-engine macro voice (2026-08-09).
  'macrooscillator',
]);

/**
 * The legacy-fallback MIGRATION derivation: is this module type MIGRATED to a
 * curated ModuleShell face? Drives the workflow `flowNodes` swap (migrated →
 * ModuleShell curated face; un-migrated → styled placeholder + legacy card in
 * the dock). The bridge and the face-lint gate read the SAME set, so a module is
 * "migrated" exactly when it's on the curation bar.
 *
 * A module is only truly migrated once it is BOTH faced AND promoted, so this
 * keys off STRICT_FACES membership (an authored-but-unpromoted `face` is a
 * draft-in-progress, not a shipped face). Pure — no registry read; the caller
 * already has the type. The bridge itself is wired in a later phase (P0.3 / P1).
 */
export function migrated(type: string): boolean {
  return STRICT_FACES.has(type);
}
