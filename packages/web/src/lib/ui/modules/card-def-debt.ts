// packages/web/src/lib/ui/modules/card-def-debt.ts
//
// THE OPT-OUT LEDGERS for the tree-wide card↔def agreement gate
// (`card-def-agreement.test.ts`). Every card control that restates a def fact
// and DISAGREES with it, named `<paramId>.<field>`, counted, and ratcheted in
// both directions.
//
// The gate these belong to is deny-by-default across all 193 cards. These lists
// are the inherited backlog, not a policy: a NEW disagreement on any card is
// RED whether or not that card already appears here, because the ledger keys on
// the exact `(card, param, field)` triple rather than on the filename.
//
// ── OPERATIONAL vs VOCABULARY ───────────────────────────────────────────────
// See `card-def-agreement.ts` for the argument. Short version: OPERATIONAL
// decides what a control can WRITE and how its travel MAPS; VOCABULARY decides
// what it is CALLED. Operational debt is 6 entries and each is a live defect.
// Vocabulary debt is 242 entries and is overwhelmingly deliberate abbreviation
// for a 46 px lane knob column — a real two-sided-contract hazard (the card, the
// rear jack and the doc page name one control several ways), but not a bug you
// can hear, and every fix repaints a card and moves a VRT baseline.

/** `cardBasename` → `<paramId>.<field>` pairs that disagree with the def on an
 *  OPERATIONAL field (`min` / `max` / `defaultValue` / `curve`). */
export const OPERATIONAL_DEBT: Readonly<Record<string, readonly string[]>> = {
  // ── The four `curve="linear"` on a def-declared `discrete` param ───────────
  // ⚠ FIXING THE CARD PROP ALONE WOULD BE A GREEN GATE OVER A LIVE BUG, and
  // that is the whole reason these are deferred rather than corrected with the
  // sibling MarblesCard pair in the same PR.
  //
  // MEASURED: `Fader.svelte` implements `curve === 'discrete'` (fracToValue →
  // `Math.round`), and so does the SHELL knob (`knob-conic-model.ts:71`). The
  // LEGACY `Knob.svelte` has **no discrete branch at all** — log and exp only.
  // So all four of these controls are `<Knob>`, and writing `curve="discrete"`
  // on them would change nothing except the colour of this test. The real fix
  // is to teach `Knob.svelte` the branch its two sibling primitives already
  // have, which changes the drag feel of every discrete knob in the rack and is
  // therefore its own reviewed PR.
  //
  // ⚠ `ResofilterCard.svelte: mode.curve` WAS THE FOURTH AND IS NOW BOUND
  // (2026-08-11, the resofilter face). NOT because the reasoning above was
  // wrong — it is exactly right, and binding the prop changed nothing that
  // renders — but because the card entered `RANGE_BOUND_CARDS` in that PR, and
  // `card-range-source`'s curve-AGREEMENT clause refuses a range-bound card
  // that still hand-types a curve its def disagrees with. That refusal is
  // correct: a card in the certified def-bound set cannot also be carrying a
  // known disagreement, however harmless, because "harmless" is a property of
  // today's `Knob.svelte` and not of the declaration.
  //
  // THE REAL DEFECT SURVIVES AND IS NOT TRACKED BY THIS ENTRY ANY MORE — it is
  // the three cards below plus every other discrete `<Knob>`: the primitive has
  // no `discrete` branch while `Fader.svelte` and `knob-conic-model.ts` both
  // do. Teaching it one changes the drag feel of every discrete knob in the
  // rack, so it stays its own reviewed PR.
  'FoxyCard.svelte': ['gen_mode.curve'],
  'Moog921bCard.svelte': ['range.curve'],
  'PeakstateCard.svelte': ['complexity.curve'],

  // ── The analogVco bug, on its twin ────────────────────────────────────────
  // Identical to the `AnalogVcoCard` defect fixed in the PR that added this
  // gate: the def declares `fmAmount`/`pmAmount` as `min: -1`, the card passes
  // `min={0}`, so the knob reaches half the contract while the def-driven dock
  // face reaches all of it. The FIX IS THE SAME ONE LINE.
  //
  // It is deferred because `wavetableVco` is in `STRICT_VRT_MODULES` and
  // `analogVco` is not: binding `min` to the def moves the fader handle for
  // value 0 from the bottom of the track to its middle, which re-captures a
  // REQUIRED baseline on BOTH platforms. Per CLAUDE.md a drain without its
  // re-capture ships a red lane, so this rides a PR that also carries the
  // `vrt-update.yml` dispatch.
  'WavetableVcoCard.svelte': ['fmAmount.min', 'pmAmount.min'],
};

/** `cardBasename` → `<paramId>.<field>` pairs that disagree on a VOCABULARY
 *  field (`label` / `units`). Generated from the tree on 2026-08-02. */
export const VOCABULARY_DEBT: Readonly<Record<string, readonly string[]>> = {
  'AcidwarpCard.svelte': ['speed.label'],
  'AdsrCard.svelte': ['attack.label', 'decay.label', 'release.label', 'sustain.label'],
  'AnalogVcoCard.svelte': ['fine.units', 'tune.units'],
  'B3ntb0xCard.svelte': ['burst_starve.label', 'chroma_leak.label'],
  'BackdraftCard.svelte': ['bezel.label', 'chroma.label', 'darken.label', 'feedback.label', 'lighten.label', 'offsetX.label', 'offsetY.label', 'pixelate.label', 'rotate.label'],
  'CharlottesEchosCard.svelte': ['feedback.label', 'pitchUp.label'],
  'ClapCard.svelte': ['color.label', 'drive.label', 'level.label', 'pulses.label', 'spread.label', 'width.label'],
  'ClipplayerCard.svelte': ['gateLength.label', 'octave.label'],
  'CloudseedCard.svelte': ['cross_seed.label', 'early_diffuse_count.label', 'early_diffuse_delay.label', 'early_diffuse_feedback.label', 'early_diffuse_mod_amt.label', 'early_diffuse_mod_rate.label', 'eq_cutoff.label', 'high_cut.label', 'input_mix.label', 'late_diffuse_delay.label', 'late_diffuse_feedback.label', 'late_diffuse_mod_amt.label', 'late_diffuse_mod_rate.label', 'late_line_mod_amt.label', 'late_line_mod_rate.label', 'low_cut.label', 'tap_count.label', 'tap_decay.label', 'tap_length.label'],
  'CofefveCard.svelte': ['driftAmount.label', 'driftSpeed.label', 'driveCutoff.label', 'driveMix.label', 'duckAmount.label', 'feedback.label', 'highCut.label', 'lfoAmount.label', 'lfoFrequency.label', 'lowCut.label'],
  'DestroyCard.svelte': ['decimate.label'],
  'DoomCard.svelte': ['audioGain.label'],
  'DrummergirlCard.svelte': ['pitch.units'],
  'Dx7Card.svelte': ['algorithm.label', 'transpose.label'],
  'FeaturecvCard.svelte': ['attack.label', 'gain.label', 'onset_debounce.label', 'onset_sens.label', 'release.label'],
  'FoxyCard.svelte': ['src2_fine.label', 'src2_fold.label', 'src2_symmetry.label', 'src2_timbre.label', 'src2_tune.label', 'src3_fine.label', 'src3_fold.label', 'src3_symmetry.label', 'src3_timbre.label', 'src3_tune.label', 'src_fine.label', 'src_fold.label', 'src_symmetry.label', 'src_timbre.label', 'src_tune.label', 'xyz_smooth.label', 'xyz_zoom.label'],
  'FrametableCard.svelte': ['morph.label', 'shimmer.label', 'spread.label', 'waveShapeX.label', 'waveShapeY.label', 'weightShape.label'],
  'FroggerCard.svelte': ['initialTime.label'],
  'GraphicEqCard.svelte': ['gain.label', 'hue.label', 'peak.label'],
  'KarplusCard.svelte': ['brightness.label', 'burst.label', 'color.label', 'decay.label', 'level.label', 'stiffness.label'],
  'KickdrumCard.svelte': ['attack.label', 'attack_eq.label', 'body_decay.label', 'body_eq.label', 'body_shape.label', 'ceiling.label', 'click_len.label', 'click_level.label', 'click_tone.label', 'drive.label', 'level.label', 'pitch_amt.label', 'pitch_time.label', 'sub_decay.label', 'sub_eq.label', 'sustain.label', 'tension.label', 'translate.label', 'width.label'],
  'LushGardenCard.svelte': ['fov.label', 'horizon.label', 'rate.label', 'view.label'],
  'MandleblotCard.svelte': ['color_cycle.label', 'iterations.label', 'rotation.label', 'zoom.label'],
  'MeowboxCard.svelte': ['decay.label', 'level.label', 'pitch.label', 'pitch.units'],
  'MilkdropCard.svelte': ['morph.label', 'presetSelect.label', 'reactivity.label', 'speed.label'],
  // The RETURN strips (pre-fader-sends PR). The def label is the SELF-
  // IDENTIFYING short name a hardware surface needs with no column context
  // ('R1V' on an Electra/Push display); the card sits the knob under a 'RET 1'
  // header and so just says 'Vol'. Same abbreviation convention the eight
  // CHANNEL strips already use ('1V' → 'Vol') — the difference is that these
  // eight are LEDGERED, because they were written with literal paramIds so the
  // gate can actually compare them. The channel equivalents are invisible to it
  // (templated `ch${n}_volume` reads as no paramId at all), which is the more
  // interesting debt and is not made worse here.
  'MixmstrsCard.svelte': [
    'master_volume.label',
    'ret1_volume.label', 'ret1_low.label', 'ret1_mid.label', 'ret1_high.label',
    'ret2_volume.label', 'ret2_low.label', 'ret2_mid.label', 'ret2_high.label',
  ],
  'Moog923Card.svelte': ['hpCutoff.label', 'level.label', 'lpCutoff.label'],
  'Moog960Card.svelte': ['rate.label'],
  'Moog961Card.svelte': ['sensitivity.label', 'switchOnTime.label'],
  'NibblesCard.svelte': ['tick_ms.label'],
  'OutToLaunchCard.svelte': ['bright.label', 'gamma.label'],
  'OutlinesCard.svelte': ['decay.label', 'rate.label', 'rotation.label', 'shape.label', 'spd.label'],
  'PeakstateCard.svelte': ['color_speed.label', 'complexity.label', 'move.label', 'oblong.label', 'speed.label'],
  'PentemelodicaCard.svelte': ['cutoff.label', 'mode.label', 'resonance.label', 'wetdry.label'],
  'QbrtCard.svelte': ['pingDecay.label', 'resonance.label'],
  'QuadralogicalCard.svelte': ['keyB.label', 'keyG.label', 'keyR.label'],
  'RuttetraCard.svelte': ['intensity.label', 'tintB.label', 'tintG.label', 'tintR.label', 'xDisp.label', 'xFreq.label', 'xPhase.label', 'xShape.label', 'yDisp.label', 'yFreq.label', 'yPhase.label', 'yShape.label'],
  'ScopeCard.svelte': ['ch1Offset.label', 'ch1Scale.label', 'ch2Offset.label', 'ch2Scale.label'],
  'ScoreboardCard.svelte': ['color.label'],
  'SequencerCard.svelte': ['swing.label'],
  'ShapegenCard.svelte': ['rotate.label', 'size.label'],
  'SidecarCard.svelte': ['attack.label', 'envMag.label', 'inputLevel.label', 'release.label', 'threshold.label'],
  'SixstrumCard.svelte': ['attack.label', 'envDecay.label', 'level.label', 'material.label', 'pickGrain.label', 'pickPos.label', 'pickTone.label', 'register.label', 'release.label', 'spread.label', 'stiffness.label', 'strumSpread.label', 'sustain.label', 'tuning.label'],
  'SourceryCard.svelte': ['colorSkew.label', 'rotate.label'],
  'SpectrographCard.svelte': ['gain.label'],
  'SwolevcoCard.svelte': ['timbre.label'],
  'SynesthesiaCard.svelte': ['a_master.label', 'b_master.label'],
  'TempestCard.svelte': ['rim.label'],
  'TextmarqueeCard.svelte': ['posX.label', 'posY.label', 'scrollX.label', 'scrollY.label'],
  'TidyVcoCard.svelte': ['cutoff.label', 'detune.label', 'drive.label', 'fatk.label', 'fdec.label', 'frel.label', 'fsus.label', 'level.label', 'oct2.label', 'shape1.label', 'shape2.label', 'track.label', 'width.label'],
  'TomtomCard.svelte': ['bend_time.label', 'decay.label', 'drive.label', 'level.label', 'noise.label'],
  'UnityscalemathematikCard.svelte': ['aAtten.label', 'aCurve.label', 'bAtten.label', 'bCurve.label', 'unityAtten.label'],
  'VideoVarispeedCard.svelte': ['speed.label'],
  'WavesculptCard.svelte': ['alpha_brightness.label', 'pos_z.label'],
};

// ⚠ THE TWO CEILINGS THAT USED TO LIVE HERE ARE DELETED (2026-08-11), under
// CLAUDE.md's standing "NEVER hand-type a population count" directive, which
// names this file in the surviving legacy tail and says to remove the counter
// when you touch it. `OPERATIONAL_DEBT_CEILING` was 6 and
// `VOCABULARY_DEBT_CEILING` 250, with `card-def-agreement.test.ts` asserting
// `actual <= CEILING` AND `CEILING - actual === 0`.
//
// WHAT THEY PROTECTED, CHECKED BEFORE REMOVING THEM (the #1458 rule — two of
// Phase 1's three "this is redundant" claims turned out to be wrong on
// measurement, so the trace stays where the constant stood):
//
//   · `actual <= CEILING` caught the debt GROWING. That is already caught,
//     strictly earlier and with a better message, by the two deny-by-default
//     clauses above it: a card control that disagrees with its def is RED
//     unless its exact `<param>.<field>` triple is added to one of these
//     ledgers. The ceiling only added "…and also bump a number", which is not
//     a second check, it is a second edit.
//   · `CEILING - actual === 0` caught a drain that forgot to lower the number.
//     Vacuous once there is no number — and the drain itself is still caught,
//     by the STALE-ENTRY anchor, which is the real mechanism: a ledger entry
//     naming a divergence that no longer exists in the source is RED.
//
// So the surviving set is deny-by-default + a NAMED entry per instance +
// an anchor to the artifact, which is precisely the shape the directive
// prescribes as the replacement. No successor counter.
//
// ⚠ AND THE REMOVAL IS NOT ONLY HYGIENE HERE. This file is a shared registry
// edited by every card conversion, and CLAUDE.md's measured example of a count
// auto-merging WRONG is three concurrent FACE branches doing exactly that
// (`9/7` → `10/8`, `11/9`, `11/9`, truth `12/10`, one of them merging cleanly
// and wrongly). A deleted constant cannot merge wrong; a decremented one can.
//
// ⚠ AND IT HAPPENED WHILE THIS BRANCH WAS OPEN, which is as good a proof as the
// argument is going to get. `marbles` (#1467) landed on main the same day and
// lowered `VOCABULARY_DEBT_CEILING` 250 → 248 for its two drained label
// entries, concurrently with this branch deleting both constants. Git surfaced
// it as a conflict ONLY because the two edits happened to touch adjacent lines;
// had the resofilter drain been to the VOCABULARY ledger instead of the
// OPERATIONAL one, both branches would have written a correct-for-their-own-tree
// number and the union would have merged cleanly and WRONG. The ledger LISTS
// merged with no help at all, because a named entry carries its own identity.

/** Flatten a ledger to `card:param.field` triples (the countable form). */
export function debtTriples(ledger: Readonly<Record<string, readonly string[]>>): string[] {
  const out: string[] = [];
  for (const [card, entries] of Object.entries(ledger)) {
    for (const e of entries) out.push(`${card}:${e}`);
  }
  return out.sort();
}
