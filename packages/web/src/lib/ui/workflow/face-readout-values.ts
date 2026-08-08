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
  kickdrumEnvelopeParams,
  kickdrumTailMs,
} from '$lib/ui/modules/kickdrum-face-model';
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
