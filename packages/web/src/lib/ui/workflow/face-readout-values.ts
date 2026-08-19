// packages/web/src/lib/ui/workflow/face-readout-values.ts
//
// PF-20 — the REGISTRY for DERIVED face readouts (`FaceReadout.valueId`).
//
// WHY THIS EXISTS, stated as the bug it prevents. A faceplate readout is
// usually a param: the dial says `450 ms` and the caption beside it should say
// `450 ms`, so it reads the same param through the same ladder. But some of the
// numbers a mock prints are NOT any one knob, and printing the nearest knob
// instead is the "a wrong metric reads exactly like a finding" trap in
// CLAUDE.md, drawn on a faceplate:
//
//   kick drum's TAIL — how long the voice rings to −60 dB of its own peak.
//   The nearest knob is SUB DEC (450 ms). It moves when you turn SUB DEC. It
//   looks right. It is INVARIANT to SUB LEVEL, which genuinely shortens the
//   tail, and the true answer at the def's defaults is 398 ms, because the
//   envelope is a sum of three layers each scaled by its own mix. A reviewer
//   checking "does it move when I turn the decay knob" gets a green.
//
// So a readout may instead name a DERIVED value: a pure function of the live
// params, registered here, that computes the number the way the DSP does. The
// def declares a STRING id, never a function — exactly like `sidebar-panels.ts`
// — so `face` stays serialisable data and nothing in the shell imports a
// module. `module-face-lint` fails a `valueId` naming an unregistered id, so a
// typo is loud in the unit lane instead of silently printing `—`.
//
// THE BAR FOR ADDING ONE. A derived readout must be negative-controlled on the
// input a knob readback would be BLIND to, permanently — not once at authoring
// time. `kickdrum-face-model.test.ts` perturbs SUB LEVEL and asserts the
// printed tail moves; that assertion is what makes the difference between this
// registry and a relabelled knob observable at all.
//
// PURE: no DOM, no engine, no store. Each entry takes a param reader and
// returns the formatted string.

import { fmtDb, fmtHz, fmtMs, fmtSemitones } from '$lib/audio/modules/kickdrum-format';
import {
  fmtVcoHz,
  vcoFaceParams,
  vcoFirstAliasedHarmonic,
  vcoFmSpanCents,
  vcoFmSpanHz,
  vcoKnobHz,
  vcoPwAuthority,
} from '$lib/ui/modules/analog-vco-face-model';
import {
  fmtWtHz,
  wtFaceParams,
  wtFmSpanCents,
  wtFmSpanHz,
  wtKnobHz,
} from '$lib/ui/modules/wavetable-vco-face-model';
import {
  cloudsCoherenceText,
  cloudsFaceParams,
  cloudsFullLevelText,
  cloudsGrainCountText,
  cloudsGrainText,
  cloudsPositionText,
  cloudsSilenceText,
} from '$lib/ui/modules/clouds-face-model';
import { noiseFaceParams, noiseTapDbText } from '$lib/ui/modules/noise-face-model';
import {
  spirographsClipText,
  spirographsClosesText,
  spirographsFigureText,
  spirographsLiveText,
} from '$lib/ui/modules/spirographs-face-model';
import {
  moog923FaceParams,
  moog923MinusThreeDbText,
  moog923SplitText,
  moog923TapDbText,
} from '$lib/ui/modules/moog923-face-model';
import {
  fourplexerFanText,
  fourplexerIdleText,
  fourplexerMapText,
  fourplexerRouting,
} from '$lib/ui/modules/fourplexer-face-model';
import {
  swolevcoFaceParams,
  swolevcoLockText,
  swolevcoModHzText,
  swolevcoShapeText,
} from '$lib/ui/modules/swolevco-face-model';
import { moogCp3BusText, moogCp3FaceParams } from '$lib/ui/modules/moogcp3-face-model';
import { mirrorpoolEyePlaceText } from '$lib/ui/modules/mirrorpool-face-model';
import {
  moog911FaceParams,
  moog911FallText,
  moog911RiseText,
  moog911SettleText,
} from '$lib/ui/modules/moog911-face-model';
import {
  moog911aFaceParams,
  moog911aLastOutText,
  moog911aMaxRateText,
} from '$lib/ui/modules/moog911a-face-model';
import {
  NINELIVES_TAP_MULTIPLIERS,
  ninelivesFaceParams,
  ninelivesFastTapsText,
  ninelivesLadderSpanText,
  ninelivesTapPeriodText,
  ninelivesWaveText,
} from '$lib/ui/modules/ninelives-face-model';
import {
  marblesBpmText,
  marblesFaceParams,
  marblesGateWidthText,
  marblesGlideText,
  marblesLoopText,
  marblesModelText,
  marblesQuantiserText,
  marblesRandomText,
  marblesScaleLiveText,
  marblesSplitText,
  marblesStepText,
  marblesXShapeText,
} from '$lib/ui/modules/marbles-face-model';
import {
  asleepText,
  cofefveFaceParams,
  echoRepeatsText,
  echoSpacingText,
  enablerText,
} from '$lib/ui/modules/cofefve-face-model';
import {
  clapBandwidthHz,
  clapBurstMs,
  clapQ,
  clapRoomOnsetMs,
  clapVoiceMs,
  clapVoiceParams,
} from '$lib/ui/modules/clap-face-model';
import {
  drummergirlAttackMs,
  drummergirlHitText,
  drummergirlParams,
  drummergirlReleaseMs,
  drummergirlShapeIndexText,
  drummergirlStartHz,
  drummergirlSustainText,
  drummergirlSweepMs,
  drummergirlSweepSemitones,
} from '$lib/ui/modules/drummergirl-face-model';
import {
  cubeCrushLevelsText,
  cubeCutTiltText,
  cubeF0Text,
  cubeFaceParams,
  cubeFoldDriveText,
  cubeHarmonicsText,
  cubeSpreadDepthText,
  cubeYLiveText,
} from '$lib/ui/modules/cube-face-model';
import {
  filterCutoffReachText,
  filterFaceParams,
  filterPeakDbText,
  filterResReachText,
} from '$lib/ui/modules/filter-face-model';
import {
  kickdrumEnvelopeParams,
  kickdrumTailMs,
} from '$lib/ui/modules/kickdrum-face-model';
import {
  MACRO_LOUDEST_NAME,
  fmtMacroDb,
  fmtMacroDbfs,
  macroAliasText,
  macroAuxOffsetDb,
  macroAuxText,
  macroFaceParams,
  macroHarmonicsText,
  macroLevelVsLoudestDb,
  macroMorphText,
  macroOutLevelDb,
  macroStrikeText,
  macroTimbreText,
} from '$lib/ui/modules/macrooscillator-face-model';
import {
  meowboxCombNullText,
  meowboxFormantsText,
  meowboxParams,
  meowboxPeakGainText,
  meowboxSettledHz,
  meowboxTailText,
  meowboxTremoloText,
} from '$lib/ui/modules/meowbox-face-model';
import {
  resofilterCvReachText,
  resofilterFaceParams,
  resofilterPeakText,
  resofilterWidthText,
} from '$lib/ui/modules/resofilter-face-model';
import {
  ringsBodyText,
  ringsEvenTapText,
  ringsFaceParams,
  ringsSecondPartialText,
} from '$lib/ui/modules/rings-face-model';
import {
  penteDecayToSustainMs,
  penteModeGainAtCutoff,
  pentePeakLinear,
  penteReleaseTailMs,
  pentemelodicaFaceParams,
} from '$lib/ui/modules/pentemelodica-face-model';
import {
  fmtPartial,
  fmtSecondsOrMs,
  sixstrumBurstMs,
  sixstrumDampPartial,
  sixstrumFaceParams,
  sixstrumNoteName,
  sixstrumPickNotchPartial,
  sixstrumRingT60S,
  sixstrumRollMs,
  sixstrumStringHz,
} from '$lib/ui/modules/sixstrum-face-model';
import { formatVcaGainAtFullCv, vcaFaceParams } from '$lib/audio/vca-gain-model';
import {
  attenumixCvRoomText,
  attenumixDriveText,
  attenumixFaceParams,
  attenumixPeakText,
} from '$lib/ui/modules/attenumix-face-model';
import {
  sidecarDuckText,
  sidecarEnvText,
  sidecarFaceParams,
  sidecarOnsetText,
  sidecarScGainText,
} from '$lib/ui/modules/sidecar-face-model';
import {
  warrensspectrumFaceParams,
  wsFadeInText,
  wsOutText,
  wsResidualText,
  wsVoiceText,
} from '$lib/ui/modules/warrensspectrum-face-model';
import {
  ceClimbText,
  ceLoopText,
  ceMarginText,
  ceSpacingText,
  ceTailText,
  charlottesEchosFaceParams,
} from '$lib/ui/modules/charlottes-echos-face-model';
import {
  bugglesBurstText,
  bugglesFaceParams,
  bugglesRingText,
  bugglesSmoothGlideText,
  bugglesSteppedHoldText,
  bugglesWoggleText,
} from '$lib/ui/modules/buggles-face-model';
import {
  SLEW_PARAM_IDS,
  slewSwitchChannelSettleText,
  slewSwitchFaceParams,
  slewSwitchLapText,
  slewSwitchSettleText,
  slewSwitchSpreadText,
  slewSwitchStepIdxText,
  slewSwitchSwitchedText,
} from '$lib/ui/modules/slewswitch-face-model';
import {
  UNITYSCALE_SHAPED_SECTIONS,
  unityscaleFaceParams,
  unityscaleHalfText,
  unityscaleOverText,
} from '$lib/ui/modules/unityscalemathematik-face-model';
import {
  featurecvAtkRiseText,
  featurecvClipText,
  featurecvFaceParams,
  featurecvIdleText,
  featurecvMaxRateText,
  featurecvProbeText,
  featurecvRelFallText,
  featurecvThreshText,
} from '$lib/ui/modules/featurecv-face-model';
// ⚠ ITS OWN `import {` STATEMENT, deliberately. Concurrent face PRs collide on
// this file, and a conflict opened on a SHARED import line resolves "take both
// sides" into one member list with a dangling `from` — which is how #1675 bit
// twice with no conflict marker at all. One module, one import block.
import {
  illogicBusCeilingText,
  illogicDiffGainText,
  illogicLogicGainText,
  illogicSumGainText,
} from '$lib/ui/modules/illogic-face-model';
// ⚠ ITS OWN `import {` STATEMENT, deliberately — see the illogic note above.
import {
  destroyFaceParams,
  destroyFloorText,
  destroyMuteText,
  destroyRateText,
  destroyStreamText,
} from '$lib/ui/modules/destroy-face-model';
// ⚠ ITS OWN `import {` STATEMENT, deliberately — see the illogic note above.
import {
  almDiffGainText,
  almPeakText,
  almRingGainText,
  almSumGainText,
} from '$lib/ui/modules/analog-logic-maths-face-model';
import {
  MOOG907A_BANK,
  MOOG914_BANK,
  type MoogBank,
  moogBankLevels,
  moogBankNotchText,
  moogBankPeakText,
  moogBankSectionText,
  moogBankSections,
  moogBankTiltText,
} from '$lib/ui/modules/moog-filterbank-face-model';
import { MOOG921A_RANGE_OPTIONS } from '$lib/audio/modules/moog921a';
import {
  busCompassText,
  busPitchAtSpanText,
  busVoltsText,
  moog921aFaceParams,
  moog921bFaceParams,
  moog921VcoFaceParams,
  rangeOctSpan,
  slaveDutyText,
  slaveFmText,
  slaveOffsetText,
  slaveOutText,
  slavePitchText,
  slaveSyncText,
  vcoFmText,
  vcoOutText,
  vcoPitchText,
  vcoSyncText,
} from '$lib/ui/modules/moog921-face-model';

// ⚠ ITS OWN IMPORT BLOCK, per the note below: concurrent face PRs all append
// here, and two branches inserting into one multi-line block conflict on the
// shared `import {` / `} from` lines even when the additions are disjoint.
import {
  moog902CeilingText,
  moog902FaceParams,
  moog902GainDbText,
} from '$lib/ui/modules/moog902-face-model';

// (its own block, same reason)
import {
  moog904aCutoffText,
  moog904aFaceParams,
  moog904aStateText,
} from '$lib/ui/modules/moog904a-face-model';

// (its own block, same reason)
import {
  moog912FaceParams,
  moog912GateText,
  moog912ResponseText,
} from '$lib/ui/modules/moog912-face-model';

// ⚠ ITS OWN IMPORT BLOCK, deliberately. Concurrent face PRs all append here,
// and two branches inserting into the SAME multi-line block conflict on the
// shared `import {` / `} from` lines even though the additions are disjoint.
// A standalone block merges clean.
import {
  backdraftBandsText,
  backdraftFillText,
  backdraftTapText,
} from '$lib/ui/modules/backdraft-face-model';

/**
 * Both Moog fixed filter banks' entries, GENERATED from the bank's own section
 * list rather than written out fourteen (and then ten) times.
 *
 * ⚠ THE POPULATION IS THE SHARED CENTRE GRID, in both directions. `moogBankSections`
 * derives the rows from `FILTERBANK_*_CENTERS` + the def's params; the def's
 * `face.sidebar` derives its entries from the same table; so a registration and
 * a row cannot go out of step, and neither place carries a count. Add a
 * thirteenth centre to the lib and both grow together.
 *
 * The three hero values (`peak`, `notch`, `tilt`) are each a JOIN over every
 * level — a coherent complex sum of fourteen overlapping sections — which no
 * single readback can perform. `tilt` reads only the two end centres so it is
 * EXACTLY invariant to a uniform level change, while `peak` and `notch` both
 * move by exactly the change; that is what makes them each other's negative
 * control on every run (moog-filterbank-face-model.test.ts).
 */
function moogBankReadouts(prefix: string, bank: MoogBank): Record<string, FaceReadoutValue> {
  const lv = (read: (paramId: string) => number | undefined) => moogBankLevels(bank, read);
  return {
    [`${prefix}-peak`]: (read) => moogBankPeakText(bank, lv(read)),
    [`${prefix}-notch`]: (read) => moogBankNotchText(bank, lv(read)),
    [`${prefix}-tilt`]: (read) => moogBankTiltText(bank, lv(read)),
    ...Object.fromEntries(
      moogBankSections(bank).map((s) => [
        `${prefix}-section-${s.id}`,
        (read: (paramId: string) => number | undefined) =>
          moogBankSectionText(bank, lv(read), s.id),
      ]),
    ),
  };
}

/** A derived readout: live params in (through the caller's reader, which
 *  already resolves def defaults for untouched params), formatted string out.
 *  TOTAL — it is called on every render, so a throw on a transient NaN would
 *  take the faceplate down mid-drag. */
export type FaceReadoutValue = (read: (paramId: string) => number | undefined) => string;

/** id → derived value. Keys are the strings a `FaceReadout.valueId` declares. */
const FACE_READOUT_VALUES: Readonly<Record<string, FaceReadoutValue>> = {
  // KICK DRUM's TAIL. Computed through the WORKLET'S OWN decay law
  // (`decayCoeff`) over the three layer envelopes at their live mix levels —
  // see kickdrum-face-model. NOT `sub_decay`.
  'kickdrum-tail': (read) => fmtMs(kickdrumTailMs(kickdrumEnvelopeParams(read))),

  // ── ANALOG VCO ───────────────────────────────────────────────────────────
  // All four are derived because the nearest knob is BLIND to something that
  // genuinely changes the answer. `knob pitch` is TWO params (move FINE alone
  // and a `tune` readback does not budge while the pitch does). `fm span` is
  // invariant to the FM DIAL in one direction (its SIGN is a modulator
  // inversion, not a direction) and to TUNE in the other (the Hz deviation
  // scales with the fundamental). `pw on morph` prints the crossfade weight a
  // `paramId: 'pw'` readout cannot see — 0 % at the shipped defaults, which is
  // the single most useful sentence this faceplate says.
  'analogvco-knob-hz': (read) => fmtVcoHz(vcoKnobHz(vcoFaceParams(read))),
  'analogvco-fm-span': (read) => {
    const p = vcoFaceParams(read);
    if (Math.abs(p.fmAmount) < 1e-6) return 'off';
    const { up, down } = vcoFmSpanHz(p);
    return `±${Math.round(vcoFmSpanCents(p))} ¢ · +${fmtVcoHz(up)} / −${fmtVcoHz(down)}`;
  },
  'analogvco-pw-authority': (read) => `${Math.round(vcoPwAuthority(vcoFaceParams(read)) * 100)} %`,
  'analogvco-alias-harmonic': (read) => `h${vcoFirstAliasedHarmonic(vcoFaceParams(read))}`,

  // ── WAVETABLE VCO ────────────────────────────────────────────────────────
  // The same two QUESTIONS as analogVco's first two, deliberately NOT the same
  // FUNCTIONS: that module is compiled Faust and this one is a hand-written TS
  // worklet, authored independently and pinned by different source greps. They
  // agree on `261.626` today; sharing the model would make a change to
  // `analog-vco.dsp` silently move THIS module's printed numbers with no gate
  // joining the two. See the header of `wavetable-vco-face-model.ts`.
  //
  // `knob pitch` is TWO params: move FINE alone and a `tune` readback does not
  // budge while the pitch moves a full semitone (261.6 → 277.2 Hz), and neither
  // dial prints Hz or the C4 anchor. `fm span` is invariant to the FM DIAL in
  // one direction (its SIGN inverts the modulator, so the span must NOT move
  // through zero) and to TUNE in the other (the Hz swing DOUBLES per octave:
  // +260/−131 Hz at C4 becomes +520/−261 an octave up) — and it prints the
  // ASYMMETRY, the one fact about exponential FM a symmetric ± dial cannot say.
  'wavetablevco-knob-hz': (read) => fmtWtHz(wtKnobHz(wtFaceParams(read))),
  'wavetablevco-fm-span': (read) => {
    const p = wtFaceParams(read);
    // At depth 0 the FM input is ignored entirely (`fma * fm` is exactly 0), so
    // `±0 ¢ · +0.0 Hz / −0.0 Hz` would be four numbers dressing up one word.
    if (Math.abs(p.fmAmount) < 1e-6) return 'off';
    const { up, down } = wtFmSpanHz(p);
    return `±${Math.round(wtFmSpanCents(p))} ¢ · +${fmtWtHz(up)} / −${fmtWtHz(down)}`;
  },

  // ── MACROOSCILLATOR ──────────────────────────────────────────────────────
  // NINE derived values, and the reason is one sentence: three of this
  // module's six dials mean something DIFFERENT in each of fourteen engines,
  // so a `paramId` readout prints a number that is correct in all fourteen
  // states and informative in none. Six of the nine are a function of `model`
  // AND the dial; three are a function of `model` alone and MUST NOT move when
  // the dial they sit beside moves — which is the assertion, not an accident.
  //
  // ⚠ FOUR OF THEM REPORT A DEFECT (WAVETABLE's dead morph half, GRANULAR's
  // 3-position morph, MODAL's inverted timbre, the 76.6 dB level spread). Those
  // are worklet arithmetic and their fixes are separate owner-audition PRs; the
  // face's job is to refuse to paint a dead control as a working one. Every
  // claim is re-derived from `macrooscillatorMath` in the model test, so a DSP
  // FIX turns the stale claim RED rather than letting the faceplate keep
  // insisting a control is broken after it has been repaired.
  'macro-harmonics-here': (read) => macroHarmonicsText(macroFaceParams(read)),
  'macro-timbre-here': (read) => macroTimbreText(macroFaceParams(read)),
  'macro-morph-here': (read) => macroMorphText(macroFaceParams(read)),
  'macro-aux-tap': (read) => macroAuxText(macroFaceParams(read)),
  'macro-out-level': (read) => fmtMacroDbfs(macroOutLevelDb(macroFaceParams(read))),
  'macro-level-gap': (read) => {
    const d = macroLevelVsLoudestDb(macroFaceParams(read));
    return d >= -0.05 ? 'the loudest engine' : `${fmtMacroDb(d)} vs ${MACRO_LOUDEST_NAME}`;
  },
  'macro-aux-offset': (read) => fmtMacroDb(macroAuxOffsetDb(macroFaceParams(read))),
  'macro-strike-need': (read) => macroStrikeText(macroFaceParams(read)),
  'macro-alias': (read) => macroAliasText(macroFaceParams(read)),

  // ── COFEFVE ──────────────────────────────────────────────────────────────
  // EIGHT values, and they exist for a different reason from every other block
  // in this file. The others derive a NUMBER a knob readback would get wrong.
  // These derive whether a control DOES ANYTHING AT ALL: seven of cofefve's
  // twenty-three params do nothing at the factory default — five of them
  // bit-exactly — because each is the dependent half of an enabler pair whose
  // enabler ships closed, and no `paramId` readout can express "this dial is
  // asleep": the
  // dial's own value is perfectly valid and perfectly irrelevant.
  //
  //   `asleep`   counts them. A function of FIVE enablers at once, so no single
  //              param can stand in for it — and it must NOT move when a
  //              dependent moves, which is the leg that catches a counter that
  //              is counting the wrong set.
  //   `spacing`  is the EFFECTIVE echo period. A `delayTime` readback is not
  //              merely imprecise while SYNC is on, it is describing a delay
  //              the DSP has replaced.
  //   `repeats`  is a COUNT from the loop gain, so ±0.5 feedback must print the
  //              same answer (measured: the two tails are identical to the
  //              sample) and TIME must not move it at all.
  //   the five `wait-*` lines are the sidebar's per-pair state. `wait-pan` is
  //              the one that carries a correction: PING-PONG needs a left/
  //              right DIFFERENCE and is independent of PAN, so a line naming
  //              PAN alone would teach a dependency the DSP does not have.
  //
  // All eight are negative-controlled in BOTH directions, permanently, in
  // cofefve-face-model.test.ts — against the REAL worklet processor class for
  // the claims that are about audio.
  'cofefve-asleep': (read) => asleepText(cofefveFaceParams(read)),
  'cofefve-echo-spacing': (read) => echoSpacingText(cofefveFaceParams(read)),
  'cofefve-repeats': (read) => echoRepeatsText(cofefveFaceParams(read)),
  'cofefve-wait-wow': (read) => enablerText('wow', cofefveFaceParams(read)),
  'cofefve-wait-duck': (read) => enablerText('duck', cofefveFaceParams(read)),
  'cofefve-wait-sync': (read) => enablerText('sync', cofefveFaceParams(read)),
  'cofefve-wait-pan': (read) => enablerText('pan', cofefveFaceParams(read)),
  'cofefve-wait-drive': (read) => enablerText('drive', cofefveFaceParams(read)),

  // ── CLAP ─────────────────────────────────────────────────────────────────
  // Three envelope figures + the band-pass pair. NONE is a knob read back:
  // `voice` is 170 ms at SNAP 0.5 and 40 ms at SNAP 1 while TAIL reads 150 at
  // both, and Q is TONE-invariant while BANDWIDTH is not — the two negative
  // controls this registry exists for, both permanent in clap-face-model.test.
  'clap-burst-ms': (read) => fmtMs(clapBurstMs(clapVoiceParams(read))),
  'clap-room-onset-ms': (read) => fmtMs(clapRoomOnsetMs(clapVoiceParams(read))),
  'clap-voice-ms': (read) => fmtMs(clapVoiceMs(clapVoiceParams(read))),
  'clap-bandwidth-hz': (read) => fmtHz(clapBandwidthHz(clapVoiceParams(read))),
  'clap-q': (read) => clapQ(clapVoiceParams(read)).toFixed(2),

  // ── CLOUDS ───────────────────────────────────────────────────────────────
  // SIX numbers, and the module they describe has no dead controls and no clip
  // hazard — what it has is INVISIBILITY, which is a harder thing for a readout
  // to fix than a defect. Each one is blind-in-a-different-direction from its
  // nearest dial:
  //
  //   reads      a `paramId: 'position'` readout prints 0.50 at EVERY size,
  //              while the reachable span shrinks 1.94 s → 0.50 s and the read
  //              point moves 1.03 s → 1.75 s. POSITION is the strongest control
  //              on the module (max|Δ| 0.99 against a marked source) and the
  //              one no level metric can see (0.17 dB across its whole travel),
  //              so a number in the BUFFER'S OWN UNITS is the only readout that
  //              says anything true about it.
  //   grain      SIZE reads 0.50 for a 300 ms grain and cannot say that the law
  //              behind it runs 60…1500 ms exponentially. (It also could not say
  //              that the top 19.50 % of that dial was BIT-IDENTICAL to its
  //              maximum, which is what this readout printed as `CLAMPED` until
  //              #1456 raised the grain ceiling to meet the law.) It also names
  //              its FRAME: `g.age` counts output samples while `g.readPos` moves
  //              at `pitchRatio`, so a transposed grain sounds for one time and
  //              reads another, and the two differ by 2^(pitch/12).
  //   pitch      a semitone readback prints `0.50 st` — a musically negligible
  //              detune — for a change that costs the FULL ~10.6 dB, because
  //              grain coherence is a THRESHOLD at exactly zero and not a
  //              slope (−5.47 dB at 0 vs −17.60 at ±0.5 st).
  //   grain pool DENSITY's own value is blind to SIZE, and the two TOGETHER
  //              decide whether the pool of 24 is full. It is full from DENSITY
  //              0.49 at the shipped SIZE, which is why that dial's top half
  //              moves the level 0.07 dB while changing the sound completely.
  //   silent for / full level at
  //              NOT a function of any one knob and not a constant either: the
  //              silence at spawn is exactly ONE GRAIN LENGTH (measured 60.0 /
  //              134.1 / 300.0 / 670.8 / 1087.2 / 1500.0 ms at size 0 / .25 /
  //              .5 / .75 / .9 / 1) and full level lands one grain after the
  //              2.0 s ring fills. This is the module's single most confusing
  //              behaviour and no surface anywhere stated it before this face.
  //
  // Every claim is re-derived from `cloudsMath` — the pure-math mirror of the
  // worklet — by ORACLE legs in clouds-face-model.test.ts, so a DSP change
  // turns a stale sentence red rather than letting the faceplate keep insisting
  // on it. Negative controls in both directions, permanently, in the same file.
  // ⚠ AND THE MIRROR ITSELF IS PINNED to the shipping worklet, sample for
  // sample, in art/scenarios/clouds/size-travel.test.ts — without that leg
  // every oracle above would be measuring a reimplementation.
  'clouds-position-reach': (read) => cloudsPositionText(cloudsFaceParams(read)),
  'clouds-grain-ms': (read) => cloudsGrainText(cloudsFaceParams(read)),
  'clouds-coherence': (read) => cloudsCoherenceText(cloudsFaceParams(read)),
  'clouds-grain-count': (read) => cloudsGrainCountText(cloudsFaceParams(read)),
  'clouds-silence': (read) => cloudsSilenceText(cloudsFaceParams(read)),
  'clouds-full-level': (read) => cloudsFullLevelText(cloudsFaceParams(read)),

  // ── DRUMMERGIRL ──────────────────────────────────────────────────────────
  // The five quantities SHAPE moves, plus the three the hero prints. Every one
  // is a function of SHAPE through the preset tables, and SHAPE's own readback
  // (`0.30`) is blind to all of them: a `paramId: 'pitch'` "starts at" readout
  // prints `0 st` while the hit genuinely starts 48 semitones higher, and a
  // `paramId: 'decay'` "hit" readout prints 150 ms at both shape 0.30 (186 ms)
  // and shape 0.90 (601 ms). The `sweep` pair is the sharpest: line :69 of the
  // .dsp contains no `decayKnob` at all, so DECAY must move NEITHER of them.
  'drummergirl-sweep-depth': (read) => fmtSemitones(drummergirlSweepSemitones(drummergirlParams(read))),
  'drummergirl-start-hz': (read) => fmtHz(drummergirlStartHz(drummergirlParams(read))),
  'drummergirl-hit-ms': (read) => drummergirlHitText(drummergirlParams(read)),
  'drummergirl-shape-index': (read) => drummergirlShapeIndexText(drummergirlParams(read)),
  'drummergirl-attack-ms': (read) => fmtMs(drummergirlAttackMs(drummergirlParams(read))),
  'drummergirl-sustain-db': (read) => drummergirlSustainText(drummergirlParams(read)),
  'drummergirl-release-ms': (read) => fmtMs(drummergirlReleaseMs(drummergirlParams(read))),
  'drummergirl-sweep-ms': (read) => fmtMs(drummergirlSweepMs(drummergirlParams(read))),

  // ── FILTER ───────────────────────────────────────────────────────────────
  // NONE of the three is a knob on the panel, and each one is blind in a
  // different direction from its nearest dial:
  //   `peak`      is a function of MODE **and** RESONANCE — at resonance 0 the
  //               three modes are 5.2 dB apart (0.0 / +2.1 / −3.1) while a
  //               `resonance` readback prints 0.00 for all three; they CONVERGE
  //               above ≈ Q 5, which is the fact it teaches.
  //   `cv reach`  models the DSP's 20 kHz CLAMP, so moving CUTOFF collapses the
  //               reachable span from 9.32 to 6.32 octaves where an unclamped
  //               `cutoff × 2^±5` is invariant at ten octaves.
  //   `res reach` collapses to `… · muted` the moment its depth knob hits 0 —
  //               the ONE fact this faceplate most needs to say, since both
  //               depth knobs are engine gains ON THE JACK and do literally
  //               nothing until a cable lands.
  // All three negative-controlled, permanently, in filter-face-model.test.ts.
  'filter-peak-db': (read) => filterPeakDbText(filterFaceParams(read)),
  'filter-cutoff-reach': (read) => filterCutoffReachText(filterFaceParams(read)),
  'filter-res-reach': (read) => filterResReachText(filterFaceParams(read)),
  // ── MEOWBOX ──────────────────────────────────────────────────────────────
  // Six numbers, and MORPH is the input all but one of them turn on — because
  // MORPH indexes thirteen tables and its own readback is `0.25`, which is blind
  // to every one of them. Three of the six exist because a plausible WRONG
  // implementation reads exactly right at the shipped defaults:
  //
  //   `settled`  a `paramId: 'pitch'` readout prints `0 st` while the voice holds
  //              290.29 Hz against a notated 261.63 — the contour SUSTAINS sharp
  //              (`en.are` holds at 1.0), and moving MORPH 0.25 → 0.50 drops the
  //              sounding pitch 1.8 semitones with PITCH untouched.
  //   `tail`     a `paramId: 'decay'` readout prints `400 ms` at EVERY morph —
  //              and is right at the default, because decayScaleOf(0.25) is
  //              exactly 1. At yowl the real tail is 800 ms, at hiss 240 ms.
  //   `peak gain` a readout of the AMPLITUDE table is FLAT across morph
  //              0.5 → 0.75 (A1 is 1.0 at both ends and everywhere between)
  //              while band 1's real peak moves +7.36 dB, because the peak is
  //              a·Q and only Q is moving.
  //
  // `tremolo` is pinned as a DEFECT rather than approved: it must be MAXIMAL at
  // hiss and MINIMAL at kitten, the opposite of what meowbox.dsp:92-95 claims.
  // And `mono-sum null` is the one readout on this module that NO knob moves —
  // it tracks the envelope, so its negative control runs the other way (perturb
  // the envelope, watch it move; sweep every param, watch it not). All six are
  // negative-controlled in BOTH directions, permanently, in
  // meowbox-face-model.test.ts.
  'meowbox-formants': (read) => meowboxFormantsText(meowboxParams(read)),
  'meowbox-settled-hz': (read) => fmtHz(meowboxSettledHz(meowboxParams(read))),
  'meowbox-tail-s': (read) => meowboxTailText(meowboxParams(read)),
  'meowbox-formant-gain': (read) => meowboxPeakGainText(meowboxParams(read)),
  'meowbox-tremolo': (read) => meowboxTremoloText(meowboxParams(read)),
  // ⚠ TAKES NO `read`, AND THAT IS THE DECLARATION. The comb null is a function
  // of the amplitude envelope — `1 / (2·(1−ampEnv)·0.6 ms)` — and of nothing on
  // the panel, so a version that consulted a param would be measuring something
  // else. The model reads `MEOWBOX_SUSTAIN` for the "held" figure rather than
  // typing 0.4, so the printed number cannot drift from the envelope constant.
  'meowbox-comb-null': () => meowboxCombNullText(),

  // ── NOISE ────────────────────────────────────────────────────────────────
  // THREE readouts on a module with ONE param, and the arithmetic is the whole
  // argument for them. `level` is a single linear gain written to all three tap
  // gains in the same `setParam` call, so the obvious declaration —
  // `{ label: 'level', paramId: 'level' }` — prints ONE number, `0.50`, for
  // THREE outputs that leave the module 12.5 dB and 7.0 dB apart:
  //
  //   white  σ = 1/√3            = 0.5774   −4.77 dBFS at LEVEL 1
  //   pink   σ = 1/√(3·(ROWS+1)) = 0.1400  −17.08      (−12.3 dB vs white)
  //   brown  σ = NORM·√(¼⅓/(1−a²)) = 0.2558 −11.84      (−7.1 dB vs white)
  //
  // That spread is not a tolerance, it is a PROPERTY of three unmatched
  // generators sharing one fader, and the knob readback is INVARIANT to it —
  // the exact blindness this registry exists for. Patch WHITE and BROWN into a
  // two-channel mixer at identical LEVEL and the brown side is 7 dB quiet; no
  // surface in the repo said so before this face.
  //
  // ⚠ WHAT IS DELIBERATELY *NOT* HERE, and why. A `noise-brown-corner-hz`
  // readout would be the obvious fourth, and it cannot be honest through this
  // registry: `FaceReadoutValue` is `(read) => string` and receives no sample
  // rate, while brown's corner MOVES with the interface (70.5 Hz at 44.1 k,
  // 76.8 at 48 k, 153.6 at 96 k — `LEAK` carries no `sampleRate` term). A live
  // readout would print one of those three as if it were all of them. The
  // corner is therefore stated as fixed sidebar prose WITH its rate, and drawn
  // on the panel; the widened reader stays a platform follow-up.
  //
  // Every closed form above is re-derived from the SHIPPING generators on every
  // run by noise-face-model.test.ts (Welch PSD + measured RMS), with negative
  // controls in both directions — including the tolerance leg that proves a
  // 0.5 dB model error would redden it.
  'noise-white-db': (read) => noiseTapDbText('white', noiseFaceParams(read)),
  'noise-pink-db': (read) => noiseTapDbText('pink', noiseFaceParams(read)),
  'noise-brown-db': (read) => noiseTapDbText('brown', noiseFaceParams(read)),

  // ── SPIROGRAPHS ──────────────────────────────────────────────────────────
  // THE FIRST VIDEO FACE IN THIS REGISTRY, and its three readouts are all
  // JOINS gated on the SAME thing: `count`.
  //
  // ⚠ `count` SHIPS AT 1, SO TWENTY OF THE THIRTY-ONE PARAMS ARE BIT-EXACTLY
  // INERT AT SPAWN. Spiro 2 and spiro 3 carry full, plausible-looking banks
  // that draw nothing. Every readout here filters on `live`, which is what
  // makes them blind to a dial that is genuinely doing nothing and what a
  // per-knob readback structurally cannot be — the permanent control is that
  // perturbing spiro 3 at `count = 1` moves NONE of them, and raising `count`
  // makes the same perturbation visible.
  //
  //   `live`    how many spiros draw. The dial says `1`; it cannot say that
  //             twenty other dials are therefore doing nothing.
  //   `closes`  which live figures NEVER close. R and r are CONTINUOUS and a
  //             trochoid closes only on a RATIONAL ratio — at R = 5, r = 3
  //             closes in 3 revolutions while r = 2.4142 hits the module's own
  //             200-cap and never closes. A millimetre of dial travel apart.
  //   `clip`    which live figures reach past the frame. ⚠ SCALE-INVARIANT:
  //             only the FIXED circle is kept in frame (radius `R * scale`
  //             bounced off an inset of its own size), so the curve overflows
  //             exactly when `curveMaxReach > R` and `scale` cancels out of
  //             both sides. A zoom control that cannot change whether the
  //             picture clips is worth saying out loud.
  //
  // The arithmetic is the MODULE'S OWN — `revolutionsToClose` and
  // `curveMaxReach` from `spirographs-math`, the same functions the draw path
  // calls — so the faceplate cannot describe a curve the module stopped
  // drawing.
  'spirographs-live': (read) => spirographsLiveText(read),
  'spirographs-closes': (read) => spirographsClosesText(read),
  'spirographs-clip': (read) => spirographsClipText(read),
  'spirographs-figure-1': (read) => spirographsFigureText(1, read),
  'spirographs-figure-2': (read) => spirographsFigureText(2, read),
  'spirographs-figure-3': (read) => spirographsFigureText(3, read),
  // ── MIRRORPOOL ───────────────────────────────────────────────────────────
  // WHERE THE EYE IS STANDING — a JOIN over `orbit_el` and `orbit_dist`, since
  // the eye's horizontal radius is `dist·cos el` and a readback of either dial
  // is blind to the other. It asks `cameraBasis`, the renderer's OWN function,
  // so the faceplate cannot describe a camera the module stopped rendering.
  // ⚠ An ABOVE/BELOW readout was refused instead: `sign(eye.y)` is exactly
  // `sign(orbit_el)`, so it would be one dial's sign relabelled. See
  // mirrorpool-face-model.ts.
  'mirrorpool-eye-place': (read) => mirrorpoolEyePlaceText(read),
  // ── MOOG 923 ─────────────────────────────────────────────────────────────
  // TWO INSTRUMENTS ON ONE PANEL SHARING NO SIGNAL PATH, so the readouts split
  // the same way and each half is the other's negative control: `lpCutoff` /
  // `hpCutoff` move NEITHER tap level, and `level` moves NEITHER filter number
  // (measured on the shipping factory — a 200 Hz sine through `audio` gives a
  // bit-identical `lp`/`hp` RMS at LEVEL 1 and LEVEL 0).
  //
  //   `white-db` / `pink-db`
  //              the noise half's `noise` problem verbatim, because it IS the
  //              same generators: ONE gain writes both tap gains and the two
  //              tables leave 12.30 dB apart, so the dial prints `0.80` for
  //              two jacks that are not the same loudness. Reusing
  //              `NOISE_TAP_RMS` rather than restating it is what keeps the two
  //              modules from drifting to two answers for one table.
  //   `lp-hz` / `hp-hz`
  //              WHERE THE FILTER ACTUALLY TURNS OVER, which is NOT
  //              `cutoffToHz` of the dial. Web Audio reads `Q` in dB on a
  //              lowpass/highpass and defaults it to 1; `moog923.ts` never sets
  //              it, so the declared corner is a +1.00 dB point and the −3 dB
  //              point is 1.3293x it on `lp` and 0.7520x on `hp`. A relabelled
  //              dial would print the declared corner and be wrong by a third —
  //              the kick-drum TAIL shape, so the model test pins the printed
  //              value AGAINST that wrong answer rather than merely near the
  //              right one.
  //   `split`    the octaves between those two points, signed: the band that
  //              arrives at BOTH jacks (overlap) or NEITHER (gap). A join over
  //              both dials, and the only readout here that no single dial can
  //              approximate — at the shipped defaults BOTH read 0.50 and the
  //              naive answer is "aligned, 0 oct" while the truth is +0.82 oct,
  //              because the two points move as x and 1/x off the shared
  //              corner.
  //
  // Every closed form is re-derived from the SHIPPING factory on every ART run
  // by art/scenarios/moog923/face-audit.test.ts — the real biquads swept for
  // their real −3 dB points, the real tables measured for their real RMS.
  'moog923-white-db': (read) => moog923TapDbText('white', moog923FaceParams(read)),
  'moog923-pink-db': (read) => moog923TapDbText('pink', moog923FaceParams(read)),
  'moog923-lp-hz': (read) => moog923MinusThreeDbText('lp', moog923FaceParams(read)),
  'moog923-hp-hz': (read) => moog923MinusThreeDbText('hp', moog923FaceParams(read)),
  'moog923-split': (read) => moog923SplitText(moog923FaceParams(read)),
  // ── 4PLEXER ──────────────────────────────────────────────────────────────
  // FOUR IDENTICAL DIALS, and every question about a router is about the WHOLE
  // MAP. `sel2` reads `IN 1`; what it cannot say is that IN 2 now reaches
  // nothing and IN 1 now arrives three times over. Both change the moment ANY
  // selector moves, and neither is visible from any single readback.
  //
  // ⚠ THE CONTROL IS A PERMUTATION, not a knob wiggle. Any permutation of the
  // four selectors is a completely different patch with all four dials in new
  // positions, and it is still a bijection — so `fan` and `idle` must stay
  // `none` while `map` changes. A readout that merely tracked "did a knob move"
  // would fail that, which is exactly why it is the permanent leg in
  // fourplexer-face-model.test.ts.
  'fourplexer-map': (read) => fourplexerMapText(fourplexerRouting(read)),
  'fourplexer-fan': (read) => fourplexerFanText(fourplexerRouting(read)),
  'fourplexer-idle': (read) => fourplexerIdleText(fourplexerRouting(read)),

  // ── SWOLEVCO ─────────────────────────────────────────────────────────────
  // THREE values, and the pair `mod` / `lock` is its own instrument check.
  //
  //   `mod`    the modulator's REAL frequency. Derived because it is
  //            `primary x RATIO` in one mode and `M.TUNE / M.FINE` in the
  //            other, so the nearest dial is wrong half the time — and it is
  //            wrong in the mode the module SPAWNS in (`ratio = 1`), where
  //            M.TUNE is measured bit-exactly inert on all three outputs.
  //   `lock`   which of those two modes is live. A NAME, not a number: a dial
  //            reading `0.00` vs `1.00` distinguishes the positions but not
  //            what they MEAN, and "M.TUNE is asleep" is the meaning.
  //   `shape`  where SYMMETRY is, computed from the def's OWN `symmetryGains`
  //            crossfade helper so the caption cannot drift from the weights
  //            the graph applies. It exists because the measured centroid says
  //            `triangle` is a single POINT (637 Hz at exactly 0.5, 1986 Hz at
  //            0.4) and a linear fader offers no detent to find it by.
  //
  // The permanent negative controls live in swolevco-face-model.test.ts:
  // M.TUNE must move `mod` at `ratio = 0` and NEVER at `ratio = 1`, must never
  // move `lock` at all, and FOLD — which moves the measured centroid 5.12x —
  // must move NONE of the three.
  'swolevco-mod-hz': (read) => swolevcoModHzText(swolevcoFaceParams(read)),
  'swolevco-mod-lock': (read) => swolevcoLockText(swolevcoFaceParams(read)),
  'swolevco-shape': (read) => swolevcoShapeText(swolevcoFaceParams(read)),

  // ── MOOG 911 ─────────────────────────────────────────────────────────────
  // THREE DELIVERED DURATIONS, against three dials that print something else.
  // The 911's T knobs are exponential TIME CONSTANTS and each stage exits on
  // its own threshold, so a stage takes `T · ln(k)/5` and only the attack's `k`
  // is constant. At the shipped defaults the dials read 10 / 200 / 400 ms and
  // the module delivers 13.83 / 240 / 696 — a 949 ms contour against a dial sum
  // of 610 (×1.5565), measured on the shipping worklet.
  //
  //   `rise`   T1 × 1.38155. The ONE that is a pure function of its own dial,
  //            and therefore the instrument's own negative control: it is
  //            EXACTLY invariant to ESUS while the other two are not.
  //   `settle` set by ESUS as much as by T2 — 276 / 240 / 92 / 0 ms at ESUS
  //            0 / 0.6 / 0.99 / ≥0.999 with the T2 dial fixed at 200. The 0 is
  //            the bit-exact null region #1885 bisected, printed rather than
  //            hidden.
  //   `fall`   the release FROM THE SUSTAIN SHELF, so ESUS sets the height it
  //            falls from: 0 / 640 / 696 / 737 ms at ESUS 0 / 0.3 / 0.6 / 1
  //            with the T3 dial fixed at 400.
  //
  // This is the kick-drum TAIL trap with numbers on it: the nearest dial to
  // "decay" reads 200 ms at every ESUS position while the truth spans 276.313
  // to 0.021 ms, so a reviewer checking "does it move when I turn the decay
  // knob" gets a green from a readout blind to the input that swings it 13 800×.
  // The permanent negative controls live in moog911-face-model.test.ts (ESUS
  // moves `settle` and `fall` and NEVER `rise`); the closed forms are
  // re-derived from the shipping DSP in art/scenarios/moog911/face-audit.test.ts.
  'moog911-rise': (read) => moog911RiseText(moog911FaceParams(read)),
  'moog911-settle': (read) => moog911SettleText(moog911FaceParams(read)),
  'moog911-fall': (read) => moog911FallText(moog911FaceParams(read)),
  // ── MOOG 911A ────────────────────────────────────────────────────────────
  // A trigger delay whose most consequential number is not a knob: there is NO
  // QUEUE, so a rising edge inside a running countdown RE-ARMS it, and a clock
  // at or above `1/delay` never lets one finish. Measured on the shipping
  // worklet at the 0.1 s default over a 3.0 s render: 8 Hz -> 24 of 24 through,
  // 9.9 Hz -> 29 of 30, then 10 Hz -> 0 of 30 and 32 Hz -> 0 of 96. A CLIFF,
  // bisected to 9.998958 Hz. (#1886 — filed, not fixed here: adding a queue is
  // an audio-semantics change for the owner's ears.)
  //
  //   `max-rate`  1/delay1, the ceiling above which OUT 1 is silent. Invariant
  //               to DELAY 2 and to MODE, which is what makes it the other
  //               readout's negative control rather than a second copy of it.
  //   `last-out`  when the LAST output lands after one trigger on TRIG 1, which
  //               needs all THREE params because MODE decides which outputs
  //               fire: OFF -> delay1 (OUT 2 never fires from TRIG 1 there,
  //               measured), PARALLEL -> max, SERIES -> sum. With DELAY 2 at
  //               0.5 s the three modes read 100 / 500 / 600 ms while neither
  //               delay dial moves.
  //
  // Permanent negative controls: moog911a-face-model.test.ts. Re-derived from
  // the shipping worklet: art/scenarios/moog911a/face-audit.test.ts.
  'moog911a-max-rate': (read) => moog911aMaxRateText(moog911aFaceParams(read)),
  'moog911a-last-out': (read) => moog911aLastOutText(moog911aFaceParams(read)),
  // ── MOOG CP3 ─────────────────────────────────────────────────────────────
  // ONE number, and it is the whole argument for that face. `cp3ChannelGain` is
  // `knob·2`, so UNITY IS AT THE DIAL'S MIDPOINT and all five knobs SHIP AT
  // MAX: four correlated unity inputs at the shipped defaults sum to a bus peak
  // of 8.0000 — +18.062 dB over full scale, 10.0000 with EXT 4 also patched —
  // with NO clamp or saturator anywhere in the path (measured on the shipping
  // worklet; the derived figure and the measured worst-case peak AGREE at five
  // settings).
  //
  // The negative control a knob readback fails: sweep ATTENUATOR 4 from 1 to 0
  // and the bus moves +18.1 -> +15.6 dB while the CH 4 DIAL STAYS AT 1.00.
  // ⚠ CH 4 and ATT 4 are bit-exactly INTERCHANGEABLE in today's code (the bus
  // sees only their product), which is why the formula multiplies them; #1884
  // proposes changing that and is audible, so it is not in the face PR.
  'moogcp3-bus-db': (read) => moogCp3BusText(moogCp3FaceParams(read)),

  // ── MARBLES ──────────────────────────────────────────────────────────────
  // ELEVEN values, every one a BARE number or state — no sentence anywhere on
  // that faceplate (owner directive 2026-08-11). marbles is the module most
  // tempted to narrate, because randomness cannot be read off knob positions;
  // the answer taken here is to pick values that state the fact BY THEMSELVES.
  //
  //   `t-random` / `x-random`
  //              `p = (2·dv − 1)²`, the per-step chance a section departs from
  //              its loop. It is the reason this module needs a face at all:
  //              100 % at DÉJÀ VU 0, 0 % at 0.5, and back to 100 % at the top,
  //              so the number rises again exactly where a player expects it to
  //              keep falling. A `paramId: 'deja_vu'` readout prints `1.00` at
  //              the setting that repeats LEAST.
  //   `t-loop` / `x-loop`
  //              the length, or `free`. It must NOT print a length at DÉJÀ VU
  //              0, where LENGTH is bit-exactly inert (one distinct t1 stream
  //              across lengths 1…16, measured) — that is the negative control,
  //              and it is the module's shipped default.
  //   `bpm` / `step`
  //              `f = 2 Hz·2^(RATE/12)`. Derived because a clock module that
  //              prints `0 st` has said nothing, and JITTER-invariant because
  //              a readout of the last interval would not be.
  //   `model`    the model the DSP RUNS. CLUSTERS is an unimplemented stub that
  //              falls through to COIN (bit-identical t1 AND t2 at three
  //              biases, with DRUMS as the control), so this prints
  //              `CLUSTERS → COIN` rather than asserting a behaviour.
  //   `t-split`  exact for the two Bernoulli models (`P(t1) = 1 − BIAS`) and a
  //              bare `—` for the three that have no closed form.
  //   `gate-width`
  //              `5 % + 90 %·PW`, beside a fixed `clk 50 %` entry the face
  //              declares as `text`: two adjacent numbers that disagree say PW
  //              does not touch the clock without a word of explanation.
  //   `glide` / `quantiser` / `scales`
  //              the three that make STEPS legible. At the shipped 0.50 they
  //              read `0 %` / `off` / `1 of 6` — the portamento has ended at
  //              0.49, the quantiser starts at 0.536, and the module spawns in
  //              the gap. `scales` is `scale`-INVARIANT by construction, which
  //              is the point: it counts how many of the six DIFFER here.
  //   `x-shape`  both ends of SPREAD are degenerate and neither is a knob
  //              position: `DC 10·BIAS − 5 V` below 0.01, a two-level ±5 V coin
  //              flip above 0.99.
  //
  // Every one is re-derived from `marblesMath` — a real render of the engine
  // core the worklet shares — by ORACLE legs in marbles-face-model.test.ts,
  // with negative controls in both directions.
  'marbles-bpm': (read) => marblesBpmText(marblesFaceParams(read)),
  'marbles-step': (read) => marblesStepText(marblesFaceParams(read)),
  'marbles-t-random': (read) => marblesRandomText(marblesFaceParams(read).deja_vu),
  'marbles-x-random': (read) => marblesRandomText(marblesFaceParams(read).x_deja_vu),
  'marbles-t-loop': (read) => {
    const p = marblesFaceParams(read);
    return marblesLoopText(p.deja_vu, p.length);
  },
  'marbles-x-loop': (read) => {
    const p = marblesFaceParams(read);
    return marblesLoopText(p.x_deja_vu, p.x_length);
  },
  'marbles-model': (read) => marblesModelText(marblesFaceParams(read)),
  'marbles-t-split': (read) => marblesSplitText(marblesFaceParams(read)),
  'marbles-gate-width': (read) => marblesGateWidthText(marblesFaceParams(read)),
  'marbles-glide': (read) => marblesGlideText(marblesFaceParams(read)),
  'marbles-quantiser': (read) => marblesQuantiserText(marblesFaceParams(read)),
  'marbles-scales': (read) => marblesScaleLiveText(marblesFaceParams(read)),
  'marbles-x-shape': (read) => marblesXShapeText(marblesFaceParams(read)),
  // ── RINGS ────────────────────────────────────────────────────────────────
  // THREE, and what they have in common is the constraint that chose them:
  // every one is SAMPLE-RATE INDEPENDENT, verified against the shipping
  // worklet at 44.1 / 48 / 96 kHz. That is not a coincidence, it is what is
  // left after the obvious readout was ruled out — see the block below.
  //
  //   `body`       NAMES THE LIVE MODEL, which the MODEL control cannot do for
  //                itself: it is a 0..1 discrete param with no `options`
  //                roster, so the dock paints it as an anonymous <Toggle> — a
  //                two-state switch over two genuinely different instruments
  //                (a 24-partial band-pass bank against two Karplus-Strong
  //                loops) that additionally sit 5.37 dB apart at identical
  //                macros. It also carries STRUCTURE's meaning switch, the
  //                same class of fact: the slider stretches partial spacing in
  //                one model and detunes a string pair by up to 19 semitones
  //                in the other, and its own readback is `0.25` in both.
  //   `partial 2`  where the second thing IS — and in SYMPATHETIC there is no
  //                partial 2, there is a second STRING, so the readout SWITCHES
  //                ITS OWN MEANING with the model or it is lying at half the
  //                settings this module has. Pinned against the shipping
  //                worklet: measured ratio 2.0000 / 2.2500 / 2.5000 / 2.7500 /
  //                3.0000 at structure 0 / .25 / .5 / .75 / 1 against a
  //                prediction of exactly those. Labelled `knob partial 2` on
  //                the face for the `cube-f0-knobs` reason — a `valueId` is a
  //                pure function of PARAMS and can never see the pitch cable.
  //   `even tap`   THE ONE WITH NO KNOB TO READ. A `paramId: 'position'`
  //                readout prints `0.25` and `0.75` with no hint that one of
  //                the two outputs is at DIGITAL ZERO there (measured peak
  //                5.028e-16 and 1.302e-15 against an unaffected ODD), and
  //                prints two different numbers at 0.30 and 0.70 which are
  //                bit-identical settings (max|delta| exactly 0.000e+0).
  //
  // ⚠ WHAT IS DELIBERATELY *NOT* HERE, AND WHY — the same shape as `noise`'s
  // brown corner, an order of magnitude worse. RING TIME is the number this
  // faceplate most wants: TWO knobs set it and only one says so. It cannot be
  // printed honestly through this registry. `FaceReadoutValue` is
  // `(read) => string` and receives no sample rate, and MODAL's T60 depends on
  // it — measured 3889 / 7420 / 476 ms at 44.1 / 48 / 96 kHz for ONE fixed pair
  // of knob settings, because the decay constant is `q/(pi*sampleRate)` with no
  // compensating term. Nor is the ratio a way out: the BRIGHTNESS ring
  // multiplier measures 18.2x / 25.3x / 3.4x across the same three rates. So
  // the finding is carried by the band LABEL ("2 · ring time — BOTH set it",
  // which paints unconditionally where a hint does not) and the corrected
  // `docs.controls.brightness` — and the rate dependence is documented on the
  // def as the DSP defect it is. (An earlier draft also cited the sidebar; this
  // face no longer has one, per the signal-flow ruling.)
  'rings-body': (read) => ringsBodyText(ringsFaceParams(read)),
  'rings-partial2-hz': (read) => ringsSecondPartialText(ringsFaceParams(read)),
  'rings-even-tap-state': (read) => ringsEvenTapText(ringsFaceParams(read)),

  // ── PENTEMELODICA ────────────────────────────────────────────────────────
  // `at cutoff` is a function of MODE **and** RESONANCE — a MODE readout would
  // print "low-pass" identically at -6.0 dB (res 0) and +34.0 dB (res 0.99), a
  // 50x swing on the master bus. `5-note peak` is a function of every LEVEL
  // **and** every PAN; a level readback is pan-invariant. `tail` is release x
  // ln(sustain / 1e-5), and the RELEASE knob is SUSTAIN-invariant. `decay to S`
  // reads 0 ms at the shipped SUSTAIN of 1, because the Decay branch exits on
  // its FIRST tick.
  'pentemelodica-mode-gain': (read) => {
    const p = pentemelodicaFaceParams(read);
    // Floor: at MODE 1 the fourth tap is a TRUE null at EVERY resonance (it is
    // the real SVF notch, x - k*bp), so the honest dB is -inf there and a bare
    // log10 would print `-Infinity dB`.
    const g = Math.max(1e-6, penteModeGainAtCutoff(p.mode, p.resonance));
    return fmtDb(20 * Math.log10(g));
  },
  'pentemelodica-peak-dbfs': (read) => {
    const p = pentemelodicaFaceParams(read);
    const lin = Math.max(1e-6, pentePeakLinear(p.levels, p.pans));
    const db = 20 * Math.log10(lin);
    return `${db > 0 ? '+' : ''}${db.toFixed(1)} dBFS`;
  },
  'pentemelodica-release-tail': (read) => {
    const p = pentemelodicaFaceParams(read);
    return fmtMs(penteReleaseTailMs(p.release, p.sustain));
  },
  'pentemelodica-decay-to-sustain': (read) => {
    const p = pentemelodicaFaceParams(read);
    return fmtMs(penteDecayToSustainMs(p.decay, p.sustain));
  },

  // ── RESOFILTER ───────────────────────────────────────────────────────────
  // THREE readouts for FOUR controls, and the first two are each other's
  // negative control rather than each needing a separate one.
  //
  // RESONANCE is ONE dial setting ONE number (`k = 2 − 2·res`, floored at
  // 0.003) that becomes a different KIND of quantity in each mode, so the
  // obvious declaration — `{ label: 'reso', paramId: 'resonance' }` — prints
  // `0.30` in all five states while what the player hears changes category:
  //
  //   LP · HP   a PEAK at cutoff, exactly 1/k: −6.0 dB at res 0 → +50.5 at 1.0
  //   BP        that same peak AND the band's −3 dB width
  //   NT        WIDTH ONLY. The notch is a true zero at cutoff at EVERY
  //             resonance; the dial takes it 2.53 oct → 0.004 oct, which a
  //             broadband level metric reads as 0.55 dB of nothing.
  //   AP        NEITHER. Magnitude is exactly 1 at every frequency and every
  //             resonance (span 0.00 dB), and the dial is a phase angle.
  //
  // So `peak` is live in LP/HP/BP and `—` in NT/AP; `width` is live in BP/NT/AP
  // and `—` in LP/HP. Every mode has exactly one of them except BAND-PASS,
  // which has both — and a derivation that got the MODE partition wrong would
  // print a number where the other says `—`, which is what makes the pair
  // self-checking rather than two separate assertions.
  //
  // `cv reach` is the third because it is invariant to everything those two
  // move with and moves with the one thing they are both blind to. It also
  // reports a fact nothing else states: `cutoff_cv` declares `cvScale: linear`
  // on a LOG-tapered param, so the CV adds ±9990 **Hz** and clamps — from the
  // 1 kHz default that is 5.64 octaves down and 3.46 up, and at the bottom of
  // the dial it cannot travel down at all. Thirty-eight of the registry's
  // forty-four log-curve CV targets declare `log` instead, which is symmetric
  // at ±4.98 octaves everywhere; resofilter is one of six that do not.
  //
  // ⚠ THE SPEC'S OWN NUMBERS DID NOT ALL SURVIVE RE-MEASUREMENT, and two of its
  // errors were the same error — a high-Q filter read before it settled. See
  // the `resofilter-face-model` header. Every closed form here is re-derived
  // from the SHIPPING `renderResofilter` on every run by
  // resofilter-face-model.test.ts, with negative controls in both directions.
  'resofilter-peak-db': (read) => resofilterPeakText(resofilterFaceParams(read)),
  'resofilter-band-width': (read) => resofilterWidthText(resofilterFaceParams(read)),
  'resofilter-cv-reach': (read) => resofilterCvReachText(resofilterFaceParams(read)),

  // ── SIX STRUM ────────────────────────────────────────────────────────────
  // `rings for` is RING's and MATERIAL's JOINT answer through the worklet's own
  // loop-gain law: hold RING at 10 s, sweep MATERIAL to 0 and it collapses to
  // 775 ms while the dial still says 10. `damps above` is a PARTIAL INDEX
  // rather than Hz because the damping cutoff tracks the note, so REGISTER must
  // not move it. `burst` is measured in PERIODS, so its ms halves every octave
  // up while PICK GRAIN still reads 1.00. All negative-controlled, permanently,
  // in sixstrum-face-model.test.ts.
  'sixstrum-ring-t60': (read) => fmtSecondsOrMs(sixstrumRingT60S(sixstrumFaceParams(read))),
  'sixstrum-damp-partial': (read) => fmtPartial(sixstrumDampPartial(sixstrumFaceParams(read))),
  'sixstrum-roll-ms': (read) => {
    const { windowMs, perStringMs } = sixstrumRollMs(sixstrumFaceParams(read));
    if (!(windowMs > 0)) return 'block chord';
    return `${windowMs.toFixed(1)} ms · ${perStringMs.toFixed(1)} ms/string`;
  },
  'sixstrum-open-strings': (read) =>
    sixstrumStringHz(sixstrumFaceParams(read)).map(sixstrumNoteName).join(' '),
  'sixstrum-low-string-hz': (read) => {
    const hz = sixstrumStringHz(sixstrumFaceParams(read))[0];
    return fmtHz(typeof hz === 'number' ? hz : Number.NaN);
  },
  'sixstrum-pick-notch': (read) =>
    fmtPartial(sixstrumPickNotchPartial(sixstrumFaceParams(read))),
  'sixstrum-burst-ms': (read) => `${sixstrumBurstMs(sixstrumFaceParams(read)).toFixed(1)} ms`,

  // ── VCA ──────────────────────────────────────────────────────────────────
  // The gain at the TOP of a full-scale CV sweep, `base + cvAmount`. Each dial
  // is individually right and blind to the other, and the module's clip risk is
  // their SUM: at base 0.5 / cvAmount 1 the VCA reaches +3.5 dB past unity on an
  // UNCLAMPED gain while `base` prints `-6.0 dB` and `cvAmount` prints `OPEN`.
  // Both blindness legs are permanent in vca-gain-model.test.ts, together with
  // an ORACLE leg that re-derives the printed dB from `vcaGain` so the string is
  // pinned to the DSP's law rather than to its own table.
  'vca-gain-at-full-cv': (read) => {
    const { base, cvAmount } = vcaFaceParams(read);
    return formatVcaGainAtFullCv(base, cvAmount);
  },

  // ── CUBE ─────────────────────────────────────────────────────────────────
  // Seven, and the second one is the reason the other six exist. cube's
  // `slice_y` is a real control that is INERT IN EXACTLY ONE STATE — the state
  // the module spawns in — because the ray march integrates over a window
  // centred on the ray origin, so sliding the plane along its own normal is
  // nearly a no-op, and at spawn the normal IS the axis Y translates along.
  // Measured max rmsΔ over the whole of Y: 0.115 flat, 0.759 at ROT X 0.8. A
  // `paramId: 'slice_y'` readout prints 0.50 in both. Every one of these is
  // negative-controlled in cube-face-model.test.ts on the input a knob
  // readback would be blind to.
  'cube-cut-tilt': (read) => cubeCutTiltText(cubeFaceParams(read)),
  'cube-y-live': (read) => cubeYLiveText(cubeFaceParams(read)),
  'cube-crush-levels': (read) => cubeCrushLevelsText(cubeFaceParams(read)),
  // ⚠ IMPORTS `CUBE_SPREAD_DEPTH`. The def's own prose said ±5 % in five places
  // against a shipped 0.18 — which is what re-typing a DSP constant into prose
  // buys you, five times over.
  'cube-spread-depth': (read) => cubeSpreadDepthText(cubeFaceParams(read)),
  // ⚠ LABELLED "knobs" ON THE FACE. A `valueId` is a pure function of PARAMS
  // and can never see the V/oct cable, so printing this unqualified would be
  // the kick-drum-TAIL trap: right when you turn the knob, wrong when the
  // module is played.
  'cube-f0-knobs': (read) => cubeF0Text(cubeFaceParams(read)),
  // cube is a bare wavetable oscillator with NO band-limiting, so this is how
  // close the current tuning is to folding its partials back down. No knob.
  'cube-harmonics': (read) => cubeHarmonicsText(cubeFaceParams(read)),
  'cube-fold-drive': (read) => cubeFoldDriveText(cubeFaceParams(read)),

  // ── ATTENUMIX ────────────────────────────────────────────────────────────
  // Three, and all three are JOINS over five knobs no single readback can
  // perform. The one that settles the case for them existing: at the shipped
  // defaults every attenuator is 0, so the mix bus is BIT-EXACTLY SILENT while
  // the MASTER dial reads a confident `1.00` — unity — and there is no knob on
  // this module that can say otherwise. `peak` says `muted`.
  //
  // `drive` is the same scalar as `peak` seen through the tanh's other side
  // (peak = tanh(drive)), published as a PAIR on purpose: the soft-clip is
  // strictly monotone, so one moving while the other does not is a broken
  // model — the clap-q / clap-bandwidth-hz precedent, where publishing both
  // makes the instrument its own negative control. MASTER's readback is
  // INVARIANT to the channel count that decides both (`1.00x` at drive 1.0 and
  // at drive 4.0, i.e. at -2.2 dB and at -12.0 dB of squash).
  //
  // `cv room` is the orthogonal third — MASTER cannot move it at all. This
  // module's CV law is `att = clamp(knob + cv, 0, 1)`, so a knob parked at
  // unity is CV-DEAF while the jack still lights and the LFO still runs.
  // Every one of these blindness legs is permanent in
  // attenumix-face-model.test.ts.
  'attenumix-peak': (read) => attenumixPeakText(attenumixFaceParams(read)),
  'attenumix-drive': (read) => attenumixDriveText(attenumixFaceParams(read)),
  'attenumix-cv-room': (read) => attenumixCvRoomText(attenumixFaceParams(read)),
  // ── SIDECAR ──────────────────────────────────────────────────────────────
  // FOUR, on a nine-fader ducker whose every knob prints a number that is not
  // the answer. The first two are ALSO each other's negative control, which is
  // the strongest form available: `onset` moves with KNEE and `duck` provably
  // cannot (a detector at +6.02 dB is past the knee at every width), so a
  // change that collapsed them into one fact reddens.
  //
  // ⚠ `onset` IS NINE dB FROM WHAT THE THRESHOLD DIAL SAYS at the shipped
  // defaults, and the dial is invariant to BOTH terms: the detector is a
  // stereo-linked `|aL| + |aR|`, so a mono main reads exactly 20·log10(2)
  // above its own peak, and the soft knee opens `knee/2` below the threshold.
  'sidecar-onset': (read) => sidecarOnsetText(sidecarFaceParams(read)),
  // ⚠ RATIO IS BLIND TO THRESHOLD. `4.00` buys −18.0 dB at threshold −18 and a
  // different number everywhere else — and the dial's top 60 % buys under 2 dB.
  'sidecar-duck': (read) => sidecarDuckText(sidecarFaceParams(read)),
  // ⚠ INPUT LVL AND MAKEUP ARE ONE DIMENSION, measured bit-identical for four
  // equivalent pairs, so NEITHER readback can print the sidechain's gain — and
  // only this can print `silent`, the state where MAKEUP has no authority.
  'sidecar-sc-gain': (read) => sidecarScGainText(sidecarFaceParams(read)),
  // ⚠ ENVMAG PRINTS 1.00 WHETHER ENV IS A DEAD 0 OR AN UNCLAMPED 1.70. The
  // output is unclamped and overshoots past 1 whenever the reduction passes
  // 24 dB — at the DEFAULT envMag, which the def's own prose had wrong.
  'sidecar-env': (read) => sidecarEnvText(sidecarFaceParams(read)),

  // ── WARREN'S SPECTRUM ────────────────────────────────────────────────────
  // FOUR, on a module that is TWO DSP CLASSES behind one switch — so the
  // recurring blind input here is MODE, and three of the four are `none` in
  // the engine that does not implement them. That is not padding: a readout
  // that quietly printed a SPECTRAL number while MASSPASS was selected would
  // be the kickdrum-TAIL trap with a second engine attached.
  //
  // ⚠ PARTIALS PRINTS 64 IN A STATE WHERE 16 VOICES SOUND. In MASSPASS the
  // same knob is the ACTIVE-BAND limiter, re-clamped to 1..BANDS — so the
  // readback is blind to `engineMode` AND to `spectralBandCount`.
  'warrensspectrum-voices': (read) => wsVoiceText(warrensspectrumFaceParams(read)),
  // ⚠ RESIDUAL PRINTS 0.50 WHERE THE RESIDUAL IS BIT-EXACTLY ABSENT. The DSP
  // scales it by `cbrt((PARTIALS-1)/47)`, which is exactly 0 at PARTIALS 1 —
  // measured on the shipping worklet: sweeping the dial 0 → 2 there moves the
  // output by 0.0000e+0, against 1.4299e-3 at PARTIALS 64.
  'warrensspectrum-residual': (read) => wsResidualText(warrensspectrumFaceParams(read)),
  // ⚠ STABILITY PRINTS 3 WHETHER THAT COSTS 20 ms OR 400 ms. The birth ramp is
  // counted in analysis COMMITS, so its DURATION is SLICE-scaled — a 20×
  // spread across a dial that never moves.
  'warrensspectrum-fade-in': (read) => wsFadeInText(warrensspectrumFaceParams(read)),
  // ⚠ GAIN PRINTS 0.0 dB WHILE THE MODULE RUNS 6.02 dB HOT. INPUT MIX is an
  // un-normalised ADD, not a crossfade. And BANK WET moves the PATH half of
  // this readout while being structurally unable to move the number, which is
  // what makes the two halves each other's control.
  'warrensspectrum-out': (read) => wsOutText(warrensspectrumFaceParams(read)),

  // ── NINE LIVES ───────────────────────────────────────────────────────────
  // THREE hero values plus ONE ROW PER TAP, on a module with two params, and
  // the arithmetic is the whole argument. RATE is a single log fader printing
  // ONE frequency for NINE outputs whose rates are 6561× apart. `1.00 Hz` on
  // the dial means, measured through this module's own factory port by port
  // (art/scenarios/ninelives/ladder.test.ts):
  //
  //   out1 1.00 s · out2 3.00 s · out3 9.00 s · out4 27.0 s · out5 1.4 min
  //   out6 4.1 min · out7 12.2 min · out8 36.5 min · out9 1.8 h
  //
  // …and `0.01 Hz` on the same dial means out9 sweeps once every 7.6 DAYS. The
  // readback is not merely incomplete about that, it is INVARIANT to WHICH tap
  // is being asked about — the `noise` shape, one fader over unmatched taps.
  //
  // `ninelives-ladder-span` prints both ends at once (a span, which one number
  // cannot be). `ninelives-fast-taps` prints which taps still read as movement,
  // and it is the one that catches a dial step nobody would look twice at:
  // 0.02 → 0.016 Hz takes it from `out 1` to `none`. `ninelives-wave` NAMES the
  // 0..2 morph, and is RATE-invariant while the other two are WAVEFORM-
  // invariant — so each is the other's negative control on every run
  // (ninelives-face-model.test.ts).
  'ninelives-ladder-span': (read) => ninelivesLadderSpanText(ninelivesFaceParams(read)),
  'ninelives-fast-taps': (read) => ninelivesFastTapsText(ninelivesFaceParams(read)),
  'ninelives-wave': (read) => ninelivesWaveText(ninelivesFaceParams(read)),
  // THE TABLE — one entry per rung, GENERATED from the DSP core's own ladder
  // (`NINE_LIVES_RATE_MULTIPLIERS`), never nine typed lines. The def's sidebar
  // builds its rows from the same population, so a row and a registration
  // cannot go out of step and there is no count in either place.
  ...(Object.fromEntries(
    NINELIVES_TAP_MULTIPLIERS.map((_, n) => [
      `ninelives-tap-${n + 1}`,
      (read: (paramId: string) => number | undefined) =>
        ninelivesTapPeriodText(n, ninelivesFaceParams(read)),
    ]),
  ) as Record<string, FaceReadoutValue>),
  // ── CHARLOTTE'S ECHOS ────────────────────────────────────────────────────
  // FIVE, on a five-knob delay, and the reason is that TWO of those knobs are a
  // STABILITY BOUNDARY wearing the labels of taste controls. The four analog
  // stages are in SERIES and each carries an in-loop tanh drive whose
  // small-signal gain is a function of DECAY, so the quantity that decides what
  // the module does is FEEDBACK × 0.995 × (1 + DECAY × 4 × 0.8) — a PRODUCT. No
  // single readback can express it: a FEEDBACK readout is blind to DECAY and a
  // DECAY readout is blind to FEEDBACK, and either one alone prints a confident
  // number on a patch that will ring forever.
  //
  //   tail    the −60 dB tail, or NEVER DECAYS. It runs the actual four-stage
  //           recurrence rather than a dominant-pole estimate, because at DECAY 0
  //           the four gains are IDENTICAL and the repeated pole rings far
  //           longer than one stage would (measured −22.8 dBFS twelve seconds
  //           after a 60 ms hit at FEEDBACK 0.95, where the one-pole form says
  //           −156 dB). Its negative control is MIX: 9.8 dB of level, 0.00 s of
  //           tail — a tail derived from level would track the wrong column.
  //   climb   (1+PITCH)^6 at the last head, in CENTS. The dial reads `0.10`; the
  //           interval is +990 ¢. Invariant to every other param, which is what
  //           separates it from the level readouts either side.
  //   spacing the EFFECTIVE first echo, in MILLISECONDS (⚠ the param is in
  //           SECONDS — 1000×). It REFUSES to print a total once PITCH is
  //           engaged, because the grain offset is +45.000 ms in the limit and
  //           then anywhere in 16.6–25.2 ms depending on grain phase, which is
  //           not a function of any parameter.
  //   loop-gain / margin are the SAME LAW in two units, on purpose: the gain is
  //           the closed form, the margin is that form expressed in the units of
  //           the dials you turn. Both are exactly flat in MIX and in DELAY —
  //           the second one because the boundary is NOT delay-dependent, a
  //           spec claim this face refuted by measurement.
  //
  // All five are negative-controlled in BOTH directions, permanently, in
  // charlottes-echos-face-model.test.ts; the claims that are about AUDIO are
  // re-derived from the shipping worklet by
  // art/scenarios/charlottes-echos/face-law.test.ts.
  'ce-tail': (read) => ceTailText(charlottesEchosFaceParams(read)),
  'ce-climb': (read) => ceClimbText(charlottesEchosFaceParams(read)),
  'ce-spacing': (read) => ceSpacingText(charlottesEchosFaceParams(read)),
  'ce-loop-gain': (read) => ceLoopText(charlottesEchosFaceParams(read)),
  'ce-margin': (read) => ceMarginText(charlottesEchosFaceParams(read)),

  // ── BUGGLES ──────────────────────────────────────────────────────────────
  // FIVE — one per JACK — on a five-knob chaos source, and the reason is that
  // the map from knobs to holes is not one-to-one in EITHER direction. RATE
  // alone reaches all five outputs and prints none of them: it is a normalised
  // 0..1 dial over a LOG map spanning 500x, so it reads `0.40` while the clock
  // runs at 1.20 Hz. Three of the five jacks are then governed by a PRODUCT of
  // two knobs, and one of them by a product plus a term nothing on the panel
  // hints at.
  //
  //   smooth-glide  THE KICK-DRUM TAIL SHAPE, verbatim. The nearest knob is
  //                 SMOOTH and it DOES move when you turn SMOOTH — and it is
  //                 blind to RATE, which changes the answer 36.5x: at a
  //                 bit-identical SMOOTH 0.5 the glide is 2895 ms at RATE 0.2
  //                 and 79 ms at RATE 0.8. The `0.01 +` floor is why it is not
  //                 simply proportional: at SMOOTH 0 it is 10 ms at EVERY rate.
  //   stepped-hold  RATE *and* CHAOS. The hold is 1/rateHz and CHAOS widens it
  //                 by +/-50% x chaos — a term a `rate` readback cannot see at
  //                 all, and the difference between a metronome and a woggle.
  //   woggle-hz     the log map itself, which is also the CLOCK jack's row.
  //   burst-rate    RATE, BURST *and* TRUNCATION. `fireWoggleEvent` cancels the
  //                 burst schedule on every event, so a rolled cluster of 3-7
  //                 is CUT by the next tick: E[delivered] falls 5.00 -> 3.80 ->
  //                 2.00 -> 1.00 across the top of the RATE travel, and at
  //                 RATE 1 "a cluster of 3-7" delivers exactly ONE pulse. The
  //                 obvious `p x rate x 5` says 250/s there; the real answer is
  //                 50/s. That 5x is the whole argument for deriving it, and
  //                 the naive form is kept in the model ONLY so the test can
  //                 assert the gap rather than describe it.
  //   ring-hz       the carrier, rate/4, SUB-AUDIO at every knob position
  //                 (0.025 .. 12.5 Hz against a ~20 Hz floor of hearing). This
  //                 is the audit's finding put on the panel: four doc strings
  //                 called RING "audio-rate" for as long as the module existed.
  //
  // ⚠ LEVEL MOVES NONE OF THE FIVE, and that is asserted permanently rather
  // than left implicit — it is the table's own negative control on every run,
  // in the `clap-q` / `clap-bandwidth-hz` shape. Every OTHER param moves at
  // least one row, also asserted, so the pair is deny-by-default over the
  // module's whole param roster (buggles-face-model.test.ts).
  'buggles-woggle-hz': (read) => bugglesWoggleText(bugglesFaceParams(read)),
  'buggles-smooth-glide': (read) => bugglesSmoothGlideText(bugglesFaceParams(read)),
  'buggles-stepped-hold': (read) => bugglesSteppedHoldText(bugglesFaceParams(read)),
  'buggles-burst-rate': (read) => bugglesBurstText(bugglesFaceParams(read)),
  'buggles-ring-hz': (read) => bugglesRingText(bugglesFaceParams(read)),

  // ── SLEWSWITCH (queue Q14) ───────────────────────────────────────────────
  // Three hero rows plus a SEVEN-ROW output table, and the per-channel rows are
  // GENERATED from `SLEW_PARAM_IDS` — which is itself derived from the def's
  // `slew<N>` params — so the number of slew channels is never typed here. A
  // fifth channel registers its own row; a renamed one empties the roster and
  // reddens the model's non-vacuity leg rather than silently publishing three.
  //
  // ⚠ THE TWO SLEW ROWS ARE EACH OTHER'S NEGATIVE CONTROL. `settle` is the
  // SLOWEST channel's arrival and is invariant to lowering the fastest;
  // `spread` is the slowest/fastest ratio and is invariant to scaling all four
  // together. Either one alone would look correct while blind to a whole
  // dimension of the four dials — the `clap-q` / `clap-bandwidth-hz` shape.
  // And `xfadeTime` moves NEITHER, nor any out row: it reaches exactly one row
  // of the ten, which is the table's own negative control on every run
  // (slewswitch-face-model.test.ts asserts the whole reach matrix).
  'slewswitch-settle': (read) => slewSwitchSettleText(slewSwitchFaceParams(read)),
  'slewswitch-spread': (read) => slewSwitchSpreadText(slewSwitchFaceParams(read)),
  'slewswitch-lap': (read) => slewSwitchLapText(slewSwitchFaceParams(read)),
  'slewswitch-switched': (read) => slewSwitchSwitchedText(slewSwitchFaceParams(read)),
  'slewswitch-step-idx': (read) => slewSwitchStepIdxText(slewSwitchFaceParams(read)),
  ...Object.fromEntries(
    SLEW_PARAM_IDS.map((id, i) => [
      `slewswitch-${id}-settle`,
      (read: (paramId: string) => number | undefined) =>
        slewSwitchChannelSettleText(slewSwitchFaceParams(read), i),
    ]),
  ),

  // ── THE MOOG FIXED FILTER BANKS (907A + 914) ─────────────────────────────
  // ONE generator for TWO modules, because they are one design over two slices
  // of one grid. See `moogBankReadouts` above for why every id here is derived.
  ...moogBankReadouts('moog914', MOOG914_BANK),
  ...moogBankReadouts('moog907a', MOOG907A_BANK),

  // ── THE MOOG 921 OSCILLATOR (921A driver + 921B slave) ───────────────────
  // ONE model for TWO modules again, and this time because they are one
  // INSTRUMENT rather than one design: the 921A is a CV-only driver with no
  // audio anywhere and the 921B is the sound-making slave with no 1V/oct jack.
  //
  // ⚠ THE NUMBER THAT MATTERS IS NOT REGISTERED HERE, AND CANNOT BE. A
  // `FaceReadoutValue` receives a param reader and nothing else, so the 921B's
  // face is structurally unable to see `freq_bus` and therefore cannot print
  // the pitch it is actually playing. What the two faces publish instead are
  // the two TERMS that compose into it, in units that add: the driver's `bus`
  // volts and the slave's `offset` octaves. Stating that limit is the point of
  // the pair, not a workaround for it.
  //
  // Each id below is negative-controlled permanently in
  // `moog921-face-model.test.ts`, and the reach matrix is disjoint by design so
  // every readout is the others' control on every run:
  //   moog921a-bus     ← frequency, freqRange   (a FREQ readback is invariant
  //                                              to RANGE, which is ×6)
  //   moog921a-span    ← freqRange ONLY         (reads the dial's endpoints)
  //   moog921a-duty    ← width ONLY
  //   moog921b-pitch   ← range, fine
  //   moog921b-offset  ← range, fine
  //   moog921b-out     ← level ONLY
  //   moog921b-fm      ← modAmount ONLY
  //   moog921b-sync    ← syncMode ONLY
  'moog921a-bus': (read) => busVoltsText(moog921aFaceParams(read)),
  'moog921a-span': (read) => busCompassText(moog921aFaceParams(read)),
  // ⚠ PRINTS A LIVE DEFECT ON PURPOSE (#1791, filed not fixed): the 921A's
  // declared MINIMUM width lands on the MIDPOINT duty, so this says `norm 50 %`
  // there rather than a plausible `50 %` that reads like the dial working.
  'moog921a-duty': (read) => slaveDutyText(moog921aFaceParams(read).width),
  // The two-row sidebar comparison — the pitch this dial position encodes in
  // EACH range position, indexed off the def's own `options` roster so a third
  // switch position upstream could not leave a row behind.
  ...Object.fromEntries(
    MOOG921A_RANGE_OPTIONS.map((o) => [
      `moog921a-pitch-${o.value}`,
      (read: (paramId: string) => number | undefined) =>
        busPitchAtSpanText(moog921aFaceParams(read), rangeOctSpan(o.value)),
    ]),
  ),
  'moog921b-pitch': (read) => slavePitchText(moog921bFaceParams(read)),
  'moog921b-offset': (read) => slaveOffsetText(moog921bFaceParams(read)),
  'moog921b-out': (read) => slaveOutText(moog921bFaceParams(read)),
  'moog921b-fm': (read) => slaveFmText(moog921bFaceParams(read)),
  'moog921b-sync': (read) => slaveSyncText(moog921bFaceParams(read)),

  // THE MONOLITH — the standalone 921 VCO, the pair's third family member. Its
  // reach matrix is disjoint in the same way, and it has a FIFTH leg the pair
  // does not: `width` moves NONE of them, which is the assertion a knob
  // relabelled could not survive. Measured (steady state, real worklet): the
  // rectangular tap's RMS is invariant to WIDTH across the whole declared span,
  // so `out` genuinely must not track it.
  //   moog921vco-pitch  ← octave, tune  (each dial is blind to the other, and
  //                                      both read 0 where the answer is 261.63 Hz)
  //   moog921vco-out    ← level ONLY
  //   moog921vco-fm     ← linFmAmount ONLY
  //   moog921vco-sync   ← sync ONLY
  'moog921vco-pitch': (read) => vcoPitchText(moog921VcoFaceParams(read)),
  'moog921vco-out': (read) => vcoOutText(moog921VcoFaceParams(read)),
  'moog921vco-fm': (read) => vcoFmText(moog921VcoFaceParams(read)),
  'moog921vco-sync': (read) => vcoSyncText(moog921VcoFaceParams(read)),

  // THE 902 VCA — two readouts with DISJOINT reach, so each is the other's
  // control on every render:
  //   moog902-gain-db   ← gain AND mode   (what the amplifier is doing, in dB)
  //   moog902-ceiling   ← mode ONLY       (INVARIANT to the gain pot)
  // The load-bearing one is the RESPONSE switch. Measured on the shipping
  // worklet, flipping it costs −2.9841 dB at the shipped pot position and
  // −5.4525 dB near the bottom of the dial WITH NO DIAL MOVEMENT, so a knob
  // readback of `gain` reads the same 0.50 across a level change of up to 5.45
  // dB. `moog902-ceiling` is the other half: it names the control voltage where
  // the amplifier stops rising — 9.0 V LINEAR, 7.5 V EXPONENTIAL — which is
  // exactly the figure three doc sites stated unconditionally and wrongly
  // (#1912), and which no dial on the module prints in any unit.
  'moog902-gain-db': (read) => moog902GainDbText(moog902FaceParams(read)),
  'moog902-ceiling': (read) => moog902CeilingText(moog902FaceParams(read)),

  // THE 904A LADDER FILTER — again a disjoint pair:
  //   moog904a-cutoff-hz  ← cutoff AND range   (the frequency the dial lies about)
  //   moog904a-state      ← regeneration ONLY  (a NAME, at the class change)
  // `cutoff` declares `units: 'Hz'`, so its dial prints a number that reads like
  // an answer while RANGE multiplies it by ×1/×4/×16 first: dial 1000 places the
  // filter at 1000 / 4000 / 16000 Hz. And because the worklet's 20 kHz clamp
  // applies to the PRODUCT, the readout PINS at `20.0 kHz` across the top
  // 20.07 % (RANGE 2) and 40.14 % (RANGE 3) of the dial — which is measured to
  // be bit-exactly one filter, so the readout is showing a real dead zone
  // rather than rounding.
  'moog904a-cutoff-hz': (read) => moog904aCutoffText(moog904aFaceParams(read)),
  'moog904a-state': (read) => moog904aStateText(moog904aFaceParams(read)),

  // THE 912 ENVELOPE FOLLOWER — and here the readouts ARE the merit: moog912
  // has two params, no families and no node.data, so it clears STOP 1 on the
  // derived-quantity clause ALONE. Disjoint reach again:
  //   moog912-response-hz  ← smoothing ONLY
  //   moog912-gate-dbfs    ← sensitivity ONLY
  // `response` exists because the SMOOTH dial is a bare 0..1 over an INVERTED
  // logarithmic map (50 Hz at 0, 1 Hz at 1 — 5.64 octaves, and turning it up
  // lowers the number); 7.07 Hz at the shipped 0.5. `gate` prints how loud the
  // input must be to HOLD the gate open, confirmed on a rendered graph
  // (art/scenarios/moog912/face-audit.test.ts) rather than derived — and it
  // prints `—` below sens 0.157080, where the required level passes full scale
  // and the gate becomes unreachable on any signal (#1914). That dash is the
  // only place in the product where that dead zone is visible.
  'moog912-response-hz': (read) => moog912ResponseText(moog912FaceParams(read)),
  'moog912-gate-dbfs': (read) => moog912GateText(moog912FaceParams(read)),

  // ── MIXMSTRS — DELETED, with the computation, 2026-08-17 ─────────────────
  // Four derived values used to live here (`bus-gain`, `comp-asleep`, and one
  // per send bus), each a JOIN over controls no single readback can perform.
  // The owner removed the hero strip from the faceplate — *"these numbers and
  // text should go away"*, and generally *"we don't want text like that in our
  // faceplates"* — so the providers went WITH the display rather than being
  // left registered against a declaration nothing renders. The measurements
  // they carried are preserved in the def's own comment above `hero`.

  // ── UNITYSCALEMATHEMATIK ─────────────────────────────────────────────────
  // FOUR values that are ONE function read at TWO probe magnitudes on TWO
  // sections, and the arrangement is the whole argument.
  //
  // The dial under them is a bare 0..1 CURVE fader, and what it moves is an
  // EXPONENT (`k = 1 + 2·curve`). An exponent is not a gain: it PIVOTS the
  // response about an input magnitude of 1, so at full curve a 0.5 input leaves
  // at 0.125 (−12 dB) while a 2.0 input leaves at 8.0 (+12 dB) — one control,
  // two opposite effects, and no single number a dial COULD print says both.
  //
  //   `half` moves DOWN as CURVE rises; `2×` moves UP. Each is therefore the
  //   other's negative control on every render, which is what turns "the curve
  //   compresses" from an assertion into a measurement. The shipped docs
  //   asserted only the first half and were wrong about the second (#1715).
  //   Both are also a JOIN over ATT and CRV: an ATT readback is blind to CRV
  //   (0.500 → 0.125 with ATT untouched) and a CRV readback is blind to ATT.
  //
  //   A and B are the CROSS-SECTION control: the three channels do not
  //   cross-talk (measured bit-exactly), so moving A's dials must leave B's two
  //   numbers alone and vice versa. Asserted in both directions on every run.
  //
  // ⚠ UNITY GETS NO READOUT, deliberately. Its output is `in · unityAtten` and
  // any number derived from that is a function of ONE dial, i.e. that dial
  // relabelled — the exact thing `valueId` exists NOT to be.
  //
  // The section ids come from `UNITYSCALE_SHAPED_SECTIONS`, derived off the
  // def's own param roster (an `<x>Atten` that has a matching `<x>Curve`), so a
  // third shaped channel would register its two ids here without a list to
  // update — and a readout can never name a section the module does not have.
  ...(Object.fromEntries(
    UNITYSCALE_SHAPED_SECTIONS.flatMap((s) => [
      [
        `unityscale-${s}-half`,
        (read: (paramId: string) => number | undefined) =>
          unityscaleHalfText(s, unityscaleFaceParams(read)),
      ],
      [
        `unityscale-${s}-over`,
        (read: (paramId: string) => number | undefined) =>
          unityscaleOverText(s, unityscaleFaceParams(read)),
      ],
    ]),
  ) as Record<string, FaceReadoutValue>),

  // ── FEATURECV ────────────────────────────────────────────────────────────
  // SEVEN, on a six-dial analyser, and the reason is that not one of the six
  // dials prints the quantity it decides. featurecv's dials are all in the
  // WRONG UNITS for what they do: a multiplier where the answer is a level, a
  // 0..1 where the answer is a threshold factor, a lockout where the answer is
  // a rate, two time CONSTANTS where the answer is a rise time.
  //
  //   idle       WHERE THE THREE FEATURE CVs REST WITH NOTHING PATCHED. This is
  //              the one a patcher is most likely to be caught by: every target
  //              is 0 on silence, and BIPOLAR maps 0 to −1.00, so an idle
  //              featurecv holds three destinations at the BOTTOM rail while
  //              POLARITY prints `BI`. It is GAIN-INVARIANT (a trim on silence
  //              is silence) and `−12 dB` below is not, which makes each the
  //              other's negative control on every render — the unityscale
  //              two-probe arrangement, one module later.
  //   −12 dB     what a −12.04 dBFS-RMS source LEAVES AT THE LOUD JACK, a JOIN
  //              over GAIN and POLARITY that neither dial can perform: `0.00`
  //              at the shipped defaults, `+1.00` at GAIN 4 (where it is
  //              CLAMPED and has stopped modulating), `−0.75` at GAIN 0.25.
  //   fires at   the onset detector's adaptive-threshold MULTIPLIER, and the
  //              DIRECTION is the point: SENS maps onto it INVERTED, 4.00× at
  //              SENS 0 down to 1.20× at SENS 1. The dial prints `0.50`; the
  //              detector is firing at 2.60× the running mean flux.
  //   max rate   the fastest hit train ONSET passes intact — `1000/debounce`,
  //              i.e. 12.5 Hz at the shipped 80 ms lockout. Measured on the
  //              shipping worklet through the def's own factory: 36/36 pulses
  //              on a 3 s 12 Hz train, every OTHER hit at 16 Hz (24 of 48), and
  //              48/48 on that same 16 Hz train once DEBNCE drops to 40 ms — so
  //              the ceiling is a property of the dial rather than a bound
  //              nobody reaches. That is the number that decides whether
  //              16th-note hi-hats get through, and the dial prints `80 ms`.
  //   atk rise / rel fall
  //              the 10→90 % moves the two one-poles actually deliver. The
  //              dials print TIME CONSTANTS (`EnvFollower`'s coefficient is
  //              `exp(-1/(ms/1000·sr))`), which are `ln 9` ≈ 2.197× shorter, so
  //              the shipped 10 / 100 ms deliver 22 / 220 ms. Each is blind to
  //              the other, which is their cross-control.
  //   loud clip  the INPUT LEVEL at which LOUD pins at full scale and stops
  //              modulating — `20·log10(1/(2·gain))`, so −6.0 dBFS at unity and
  //              6.02 dB lower per doubling of the trim. It prints `never` when
  //              the trim puts the clamp out of reach of a bounded signal,
  //              which is the honest answer below GAIN 0.5 and not a number.
  //
  // ⚠ BRIGHT AND PUNCH GET NO READOUT, deliberately, and the reason is a
  // MEASUREMENT rather than a preference: ZCR counts sign changes and crest is
  // a peak-to-RMS ratio, so both are scale-invariant and GAIN is bit-exactly a
  // no-op on them. Every param-derived number about those two jacks would be a
  // constant. They are drawn instead, on the `featurecv-maps` sidebar picture,
  // where a constant is the correct shape.
  //
  // All seven are negative-controlled in both directions, permanently, in
  // featurecv-face-model.test.ts; every claim about AUDIO is re-derived from
  // the shipping worklet by art/scenarios/featurecv/analysis.test.ts.
  'featurecv-idle': (read) => featurecvIdleText(featurecvFaceParams(read)),
  'featurecv-probe': (read) => featurecvProbeText(featurecvFaceParams(read)),
  'featurecv-thresh': (read) => featurecvThreshText(featurecvFaceParams(read)),
  'featurecv-max-rate': (read) => featurecvMaxRateText(featurecvFaceParams(read)),
  'featurecv-atk-rise': (read) => featurecvAtkRiseText(featurecvFaceParams(read)),
  'featurecv-rel-fall': (read) => featurecvRelFallText(featurecvFaceParams(read)),
  'featurecv-loud-clip': (read) => featurecvClipText(featurecvFaceParams(read)),

  // ── ILLOGIC ──────────────────────────────────────────────────────────────
  // FOUR IDENTICAL DIALS, TEN JACKS, and not one of the four numbers below is
  // readable off a dial. Every one is a JOIN over all four attenuverters, and
  // the four are chosen so that each is BLIND to something the next one sees —
  // which is what makes them each other's negative control on every run rather
  // than four spellings of the same quantity (illogic-face-model.test.ts):
  //
  //   sum   = a1+a2+a3+a4         signed; CANCELS
  //   diff  = a1+a2−a3−a4         signed, OPPOSITE polarity split; ×0.00 at the
  //                               shipped defaults — the module leaves the
  //                               factory with one mix bus as a common-mode
  //                               NULL, beside four faders all sitting at max
  //   peak  = Σ|aN|               SIGN-BLIND; ×4.00 at the defaults on a bus
  //                               whose convention is ±1
  //   logic = 1                   INVARIANT to all four, because the boolean
  //                               jacks threshold the RAW inputs
  //
  // ⚠ `illogic-logic-gain` prints a constant, and that is the point rather than
  // an oversight — it sits in the same row and the same units as three numbers
  // that do move, so the module's biggest surprise is visible as a NUMBER
  // instead of a sentence nobody reads. Its authority is NOT this registration:
  // `art/scenarios/illogic/face-audit.test.ts` measures the claim against the
  // shipping factory and derives the affected port set from the def.
  'illogic-sum-gain': (read) => illogicSumGainText(read),
  'illogic-diff-gain': (read) => illogicDiffGainText(read),
  'illogic-bus-ceiling': (read) => illogicBusCeilingText(read),
  'illogic-logic-gain': (read) => illogicLogicGainText(read),

  // ── DESTROY ──────────────────────────────────────────────────────────────
  // THREE DIALS WHOSE UNITS ARE ALL WRONG FOR WHAT A PLAYER NEEDS. DECIMATE
  // prints a divisor where the useful number is a RATE; BITS prints a depth
  // where the useful numbers are two LEVELS in dBFS; and the two most useful
  // quantities are joins over two dials each. The four below are chosen so
  // every dial moves at least two and every readout is blind to at least one,
  // which is what makes them each other's controls on every run rather than
  // four spellings of one number (destroy-face-model.test.ts):
  //
  //           DECIMATE   BITS   WET
  //   rate       yes      —      —     48000 / round(d)
  //   stream     yes     yes     —     bits × rate, kbit/s — THE JOIN
  //   floor       —      yes    yes    20log10(wet · step/√12) dBFS
  //   mute        —      yes     —     −6.02 × bits dBFS — the dead zone
  //
  // ⚠ `floor` and `mute` ARE THE SAME STAGE'S TWO EDGES, deliberately. WET
  // moves the floor by exactly 20log10(wet) and moves the dead zone by
  // nothing, because WET decides how much of the crush reaches the output and
  // not where the quantiser's grid lands. Publishing both is the instrument's
  // own negative control (the clap-q / clap-bandwidth-hz pattern).
  //
  // ⚠ `floor` IS THE BIT STAGE'S FLOOR, NOT THE WHOLE CRUSH, and `rate` sitting
  // in the same row is how the face says so. A sample-and-hold error is a
  // function of the INPUT's slew, so no pure function of the params can print
  // the decimator's contribution — measured, it reaches −1.86 dBFS on
  // broadband at DECIMATE 64 while this readout correctly stays at −101 dBFS.
  //
  // Their authority is NOT this registration: `art/scenarios/destroy/
  // face-audit.test.ts` measures every one of these laws against the shipping
  // compiled Faust wasm, including the integer hold length #1716 was about.
  'destroy-rate': (read) => destroyRateText(destroyFaceParams(read)),
  'destroy-stream': (read) => destroyStreamText(destroyFaceParams(read)),
  'destroy-bit-floor': (read) => destroyFloorText(destroyFaceParams(read)),
  'destroy-mute': (read) => destroyMuteText(destroyFaceParams(read)),

  // ── ANALOGLOGICMATHS ─────────────────────────────────────────────────────
  // TWO DIALS, FIVE JACKS, and every jack is a DIFFERENT function of the SAME
  // two dials — which is precisely the shape a ranked list of controls cannot
  // express. All four below are stated at a full-scale ±1 common-mode probe,
  // in one unit, and they are chosen so each is blind to something the next one
  // sees (analog-logic-maths-face-model.test.ts asserts that as a matrix over
  // four structural perturbations, in both directions):
  //
  //   sum   = tanh(attA + attB)   ⚠ THE ONLY NON-LINEAR ROW. ×0.96 at the
  //                               shipped defaults against a nameplate ×2.00 —
  //                               a −6.34 dB compression that exists only when
  //                               BOTH dials are open, so neither can print it
  //   diff  = attA − attB         LINEAR; ×0.00 at the defaults — one of five
  //                               jacks ships as a common-mode NULL beneath two
  //                               faders both at maximum
  //   ring  = tanh(attA · attB)   the one law where the dials MULTIPLY: halve
  //                               both and this QUARTERS while `peak` halves
  //   peak  = Σ|attN|             SIGN-BLIND; ×2.00 on a ±1 bus, and DIFF's
  //                               ceiling alone — the sign flip that swaps
  //                               `sum` and `diff` leaves this one still
  //
  // ⚠ `sum` IS A GAIN THAT ONLY HOLDS AT THE PROBE, because tanh makes SUM's
  // gain a function of the drive as well as of the dials. It is honest in this
  // row precisely because `peak` sits beside it in the same units: the GAP
  // between ×2.00 and ×0.96 is the compression, and it is the module's whole
  // merit claim rendered as two numbers.
  //
  // Their authority is NOT this registration:
  // `art/scenarios/analog-logic-maths/face-audit.test.ts` measures every one of
  // these four laws at the JACK, through the def's own factory and the shipping
  // worklet, with the dB reference named in each assertion message.
  'alm-sum-gain': (read) => almSumGainText(read),
  'alm-diff-gain': (read) => almDiffGainText(read),
  'alm-ring-gain': (read) => almRingGainText(read),
  'alm-peak': (read) => almPeakText(read),

  // BACKDRAFT — the first VIDEO face's readouts. `backdraft-tv-fill` is a pure
  // function of ZOOM and `backdraft-tv-bands` is not; publishing the pair makes
  // each the other's negative control. `backdraft-delay-frames` is the whole-
  // frame quantisation the millisecond fader structurally cannot show.
  // All three are permanently controlled in backdraft-face-model.test.ts.
  'backdraft-tv-fill': (read) => backdraftFillText(read),
  'backdraft-tv-bands': (read) => backdraftBandsText(read),
  'backdraft-delay-frames': (read) => backdraftTapText(read),
};

/** The derived value for a declared id, or `null` (⇒ the readout prints `—`
 *  and the lint is red). */
export function faceReadoutValueFor(valueId: string): FaceReadoutValue | null {
  return FACE_READOUT_VALUES[valueId] ?? null;
}

/** Every registered id — the roster module-face-lint checks a declared
 *  `valueId` against. */
export function faceReadoutValueIds(): string[] {
  return Object.keys(FACE_READOUT_VALUES).sort();
}
