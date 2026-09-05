// packages/web/src/lib/audio/modules/tidy-vco.ts
//
// TIDY VCO — flagship virtual-analog SUBTRACTIVE SYNTH VOICE (audio domain).
//
// ── Model ────────────────────────────────────────────────────────────────
// A complete 2-oscillator VA voice in one card: OSC1 + OSC2 (polyBLEP
// saw↔pulse SHAPE morph, shared PW/PWM, OSC2 octave + detune) + a −1-oct
// SUB square → a nonlinear zero-delay-feedback DIODE LADDER filter (the
// EMS VCS3 / TB-303 lineage — bidirectionally-coupled stages, per-stage
// saturation, a feedback squelch limiter, 2× oversampled; CUTOFF is
// calibrated to the RESONANT pitch so keytracked self-oscillation plays
// in tune) → dual RC-curve "punch" ADSRs (CEM3310-style exponential
// segments: filter EG + amp EG) → an OTA-flavored soft-knee VCA →
// equal-power stereo bus. 5-voice poly (the polyPitchGate chord bus,
// lane i → voice i) AND mono pitch/gate with a REAL 2-voice unison
// spread. All-new DSP — no shared filter/EG/VCA code with the catalog's
// transistor-ladder clones or SVF (owner directive: a distinct corner).
//
// ── Poly / mono / stereo ─────────────────────────────────────────────────
//   POLY: while any poly lane is gated the chord bus drives the voices
//   (fixed lane→voice, no allocator; a releasing voice HOLDS its pitch).
//   MONO: with no lane gated, the mono PITCH/GATE pair drives a 2-voice
//   unison — ±(7 ¢ · WIDTH) drift, panned ∓WIDTH, each side its OWN
//   filter + EGs + VCA (true stereo beating, not dual-mono). WIDTH also
//   fans the five poly voices across the field (root stays centered).
//
// ── DSP ──────────────────────────────────────────────────────────────────
//   Worklet: packages/dsp/src/tidy-vco.ts + lib/tidy-vco-dsp.ts. The
//   pure-math mirror (`tidyVcoMath`, re-exported below) is what unit
//   tests + ART exercise under node where AudioWorkletGlobalScope is
//   unavailable.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/tidy-vco.js?url';
import { createWorkletNode } from '$lib/audio/worklet-guard';
import {
  TIDY_VOICES,
  TIDY_VCO_DEFAULTS,
  makeTidyVcoState,
  renderTidyVco,
  type TidyVcoBus,
  type TidyVcoParams,
  // The shared DSP lib (node-importable IDENTICAL source the worklet bundles).
} from '../../../../../dsp/src/lib/tidy-vco-dsp';

const loadedContexts = new WeakSet<BaseAudioContext>();
const PROCESSOR_NAME = 'tidy-vco';

export { TIDY_VOICES };

// ----------------------------------------------------------------------------
// Pure-math mirror — re-exported from the shared DSP lib so unit tests + ART
// can render TIDY VCO under node (worklets can't load without an
// AudioWorkletGlobalScope). This is the SAME source the worklet bundles, so
// there is no second copy to keep in sync.
// ----------------------------------------------------------------------------

export const tidyVcoMath = {
  TIDY_VOICES,
  defaults(): TidyVcoParams {
    return { ...TIDY_VCO_DEFAULTS };
  },
  makeState: makeTidyVcoState,
  render: renderTidyVco,
};
export type { TidyVcoBus, TidyVcoParams };

// ----------------------------------------------------------------------------
// Module def.
// ----------------------------------------------------------------------------

export const tidyVcoDef: AudioModuleDef = {
  type: 'tidyVco',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'tidy vco',
  category: 'sources',
  size: '3u', // natural box ≈ 527×720px (two full fader bands) → 3u × 4hp measured
  hp: 4,
  stereoPairs: [['out_l', 'out_r']],

  inputs: [
    // 5-lane poly chord bus → voices. NOT a paramTarget (poly is a direct
    // node connection, never a CV→AudioParam target). No `edge` on the
    // poly port — the per-lane gate edges are consumed inside the worklet.
    { id: 'poly', type: 'polyPitchGate' },
    // Mono pair (the fallback path when no poly lane is gated).
    { id: 'pitch', type: 'cv' },
    { id: 'gate', type: 'gate', edge: 'gate' },
    // Per-knob CV jacks, consumed DIRECTLY by the worklet (octave/full-swing
    // laws applied inside the core — kickdrum/clap convention). Pattern B: a
    // plain cv port per knob, NO paramTarget/cvScale — the core does the
    // scaling. Every continuous control now has one (27 inputs total): the six
    // original (audio-rate) CVs, then a GLOBAL block-rate CV for each of the
    // remaining OSC / FILTER / EG / OUT knobs.
    { id: 'cutoff_cv', type: 'cv' },
    { id: 'res_cv', type: 'cv' },
    { id: 'pwm_cv', type: 'cv' },
    { id: 'drive_cv', type: 'cv' },
    { id: 'fold_cv', type: 'cv' },
    { id: 'sym_cv', type: 'cv' },
    // OSC section.
    { id: 'shape1_cv', type: 'cv' },
    { id: 'shape2_cv', type: 'cv' },
    { id: 'detune_cv', type: 'cv' },
    { id: 'oct2_cv', type: 'cv' },
    { id: 'mix_cv', type: 'cv' },
    { id: 'sub_cv', type: 'cv' },
    // FILTER section (cutoff/res/drive already above).
    { id: 'env_cv', type: 'cv' },
    { id: 'track_cv', type: 'cv' },
    // FILTER EG section.
    { id: 'fatk_cv', type: 'cv' },
    { id: 'fdec_cv', type: 'cv' },
    { id: 'fsus_cv', type: 'cv' },
    { id: 'frel_cv', type: 'cv' },
    // AMP EG section.
    { id: 'atk_cv', type: 'cv' },
    { id: 'dec_cv', type: 'cv' },
    { id: 'sus_cv', type: 'cv' },
    { id: 'rel_cv', type: 'cv' },
    // OUT section.
    { id: 'width_cv', type: 'cv' },
    { id: 'level_cv', type: 'cv' },
  ],
  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
  ],

  params: [
    // ── Oscillators ──
    { id: 'shape1', label: 'Shape 1', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'shape2', label: 'Shape 2', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'pw', label: 'PW', defaultValue: 0.5, min: 0.05, max: 0.5, curve: 'linear' },
    { id: 'detune', label: 'Detune', defaultValue: 6, min: -50, max: 50, curve: 'linear', units: '¢' },
    // `options` NAMES the three octave states (PF-1). This param is `-1..1
    // discrete`, so `looksLikeSwitch` (0..1-at-0) never sees it and it fell
    // through to a bare rotary printing `0.00` — and the Fader it replaces was
    // exactly as uninformative, so the face INHERITS this weakness rather than
    // causing it. Contract-transparent: contract-signature projects only
    // id/min/max/curve/default/units, so naming a value cannot move
    // contract-lock.txt (the `delay.ts` label precedent, stated verbatim there).
    {
      id: 'oct2',
      label: 'Oct 2',
      defaultValue: 0,
      min: -1,
      max: 1,
      curve: 'discrete',
      options: [
        { value: -1, label: '-1', title: 'OSC2 one octave BELOW OSC1' },
        { value: 0, label: '0', title: 'OSC2 in OSC1’s octave — DETUNE alone separates them' },
        { value: 1, label: '+1', title: 'OSC2 one octave ABOVE OSC1' },
      ],
    },
    { id: 'mix', label: 'Mix', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'sub', label: 'Sub', defaultValue: 0.15, min: 0, max: 1, curve: 'linear' },
    // ── Wavefolder (stereo, before the filter) ──
    { id: 'fold', label: 'Fold', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'sym', label: 'Sym', defaultValue: 0, min: -1, max: 1, curve: 'linear' },
    // ── Filter ──
    { id: 'cutoff', label: 'Cutoff', defaultValue: 900, min: 40, max: 14000, curve: 'log', units: 'Hz' },
    { id: 'res', label: 'Res', defaultValue: 0.35, min: 0, max: 1, curve: 'linear' },
    { id: 'drive', label: 'Drive', defaultValue: 0.25, min: 0, max: 1, curve: 'linear' },
    { id: 'env', label: 'Env', defaultValue: 0.45, min: -1, max: 1, curve: 'linear' },
    { id: 'track', label: 'Track', defaultValue: 0.4, min: 0, max: 1, curve: 'linear' },
    // ── Filter EG ──
    { id: 'fatk', label: 'F.A', defaultValue: 0.005, min: 0.0005, max: 5, curve: 'log', units: 's' },
    { id: 'fdec', label: 'F.D', defaultValue: 0.35, min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'fsus', label: 'F.S', defaultValue: 0.2, min: 0, max: 1, curve: 'linear' },
    { id: 'frel', label: 'F.R', defaultValue: 0.3, min: 0.001, max: 5, curve: 'log', units: 's' },
    // ── Amp EG ──
    { id: 'atk', label: 'A', defaultValue: 0.003, min: 0.0005, max: 5, curve: 'log', units: 's' },
    { id: 'dec', label: 'D', defaultValue: 0.25, min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'sus', label: 'S', defaultValue: 0.75, min: 0, max: 1, curve: 'linear' },
    { id: 'rel', label: 'R', defaultValue: 0.25, min: 0.001, max: 5, curve: 'log', units: 's' },
    // ── Global ──
    { id: 'width', label: 'Width', defaultValue: 0.4, min: 0, max: 1, curve: 'linear' },
    { id: 'level', label: 'Level', defaultValue: 0, min: -24, max: 12, curve: 'linear', units: 'dB' },
    // The card's manual gate pad (drone/audition — OR-ed with the gate input).
    { id: 'hold', label: 'Hold', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
  ],

  // ── FACE — workflow-mode UI curation (RACKLINE ModuleShell, batch F) ──
  //
  // THE RANKING QUESTION for a complete VA voice is not "what is this module
  // ABOUT" — it is "what does the player's hand ride?". Batch F re-orders the
  // SAME six lane controls the P1 face already had; nothing leaves the plate.
  //
  //   1 CUTOFF  the only control that is hot in EVERY patch state. A 303/VCS3
  //             player literally rides it, and on this filter it is calibrated
  //             to the RESONANT pitch, so it is also the self-osc tuning knob.
  //             It outranks SHAPE because SHAPE is a setting and CUTOFF is a
  //             gesture. (This is the mini tile's one cell.)
  //   2 SHAPE 1 the oscillator identity, and the param the 'waveform' glyph
  //             DRAWS — so at 'compact' the knob and its picture sit together.
  //   3 RES     on a diode ladder resonance is a TIMBRE control, not a trim: it
  //             compresses through the feedback squelch limiter and drops the
  //             passband ~10 dB on the way up. That is the 303 squelch, and it
  //             is half of what CUTOFF sounds like.
  //   4 DETUNE  ┐ THE TUNE CLUSTER. These stay INSIDE the 6-cell plate on
  //   5 OCT 2   ┘ purpose: faces-parity carries a dedicated regression block
  //             ('tidyVco tune-cluster regression') asserting control-detune +
  //             control-oct2 visible in the LANE full face AND in the dock
  //             `oscillator` band, after an owner control-loss report. Moving
  //             them to 7-8 would MANUFACTURE the invisibility it guards.
  //
  //             ⚠ KNOWN, MEASURED, UNGATED — OWNER CALL (see the PR body).
  //             OCT 2's `options` roster earns a PERSISTENT readout under the
  //             dial (KnobConic renders `.readout` only for a param that
  //             declared a vocabulary), and that readout is IN FLOW, not
  //             overlaid. The arithmetic, from the CSS rather than from taste:
  //               .knob.sm --kb          26 px   (_rackline-tile plate cells)
  //               .knob-wrap gap          5 px
  //               .label 9 px @ normal  ≈11 px
  //               ────────────────────── 42 px = --plate-row-h exactly
  //               + .knob-wrap gap        5 px
  //               + .readout 9 px @ lh:1  9 px
  //               ────────────────────── 56 px in a 42 px row
  //             `.tile-body.plate` is `overflow: hidden`, and OCT 2 is rank 5 —
  //             the LAST plate row — so the overflow has nowhere to go.
  //             NOTHING SEES THIS: `module-face-lint` is pure-model,
  //             faces-parity asserts `control-oct2` VISIBLE (a clipped-but-
  //             present knob still is), `card-control-overflow` measures LEGACY
  //             cards not `module-shell`, and `workflow-shell-faces.spec.ts`
  //             captures only `-compact` and `-dock` — the `full` LANE plate is
  //             the one tier where this renders and the one tier no scene
  //             covers. The two candidate fixes (a taller `--plate-row-h`, or
  //             suppressing the persistent readout at `size:'sm'`) both move
  //             OTHER faces' baselines — filter's `mode` roster is rank 3 and
  //             DOES land in a captured tier — so this is not a change to make
  //             inside a per-module face PR. Reported, not silently absorbed.
  //   6 PW      DEMOTED from rank 2, on the DSP rather than on taste: the pulse
  //             leg carries ZERO WEIGHT in the mix at the SHAPE default, so PW
  //             is PROVABLY INERT AT SPAWN.
  //             ⚠ THE MECHANISM IS THE CROSSFADE, NOT THE TERNARY. An earlier
  //             draft cited `const pul = s > 0 ? tidyPulse(…) : 0` as "gating"
  //             the pulse leg. It is not load-bearing: the next line is
  //             `(1 - s) * saw + s * pul`, whose `s * pul` term is already 0 at
  //             s === 0, so DELETING the ternary is BIT-IDENTICAL — it is a
  //             short-circuit optimization. Pointing a future author at that
  //             line would let them change the morph to a non-normalized form
  //             (`saw + s * pul`, or a pulse floor) while leaving the cited
  //             ternary visibly intact and concluding the invariant still
  //             holds. The invariant is the WEIGHT; the test below measures it.
  //             ⚠ COMPOSITION WITH `feat/tidyvco-sine-tri-square` (unmerged),
  //             checked with `git merge-tree` rather than asserted: the two
  //             branches have ZERO source conflicts — `tidy-vco.ts` and
  //             `ModuleShell.svelte` auto-merge, and this face PR touches not
  //             one `docs` string, which is all that PR rewrites here. They
  //             conflict on exactly SIX darwin VRT baselines (vrt.spec
  //             tidyVco, the three vrt-tidy-vco scenes, and both
  //             face-tidyVco-*), so WHICHEVER MERGES SECOND MUST RE-CAPTURE
  //             THOSE SIX — they are the same pixels changed for two different
  //             reasons, not a mergeable text conflict.
  //             The PW premise SURVIVES that rework and is if anything
  //             stronger: its `tidyOscSample` takes the `s <= 0.5` (sine→tri)
  //             branch at the SHAPE default with m = 0, and `pw` appears
  //             ONLY in the `s > 0.5` branch's square leg — so at spawn the
  //             pulse leg is not merely zero-weighted, it is never evaluated.
  //             PW's 0.5 default is also the TRUE square there rather than a
  //             midpoint. Section B measures the OUTPUT, so it re-proves the
  //             inertness against whichever oscillator is in the tree.
  //             Rank 2 shipped the compact tile a knob that does nothing until
  //             you move the knob beside it. ⚠ This is CHECKED, not asserted —
  //             tidy-vco-face.test.ts renders the def's own pure-math mirror at
  //             the defaults across PW's whole declared travel and requires a
  //             bit-identical result, with the inverse (SHAPE at the pulse end)
  //             as its negative control. The premise SURVIVES the in-flight
  //             sine→tri→square SHAPE rework (feat/tidyvco-sine-tri-square):
  //             there the square leg only enters at the TOP of the morph, and
  //             PW's 0.5 default IS the true square, so PW is if anything MORE
  //             inert at spawn. The test re-proves it either way.
  //
  //   ranks 7+ are DOCK-ONLY (LANE_PLATE_MAX_CELLS = PLATE_COLS × PLATE_MAX_ROWS
  //             = 6): FOLD (the West-Coast hero — but a true bypass at its 0
  //             default, so it cannot earn a lane cell it would spend doing
  //             nothing) and ENV (the filter-EG sweep depth). The dock faceplate
  //             always renders EVERY control, so nothing here is lost.
  //
  // ⚠ SIX cells = TWO plate rows, and `laneBodyPlan` drops the glyph whenever
  // the cells need both rows (`glyph: hasGlyph && rows <= 1`). So the wave
  // screen is a mini/compact affordance by construction; that is priced in, not
  // discovered — a 5th cell would not buy the glyph back either (2 rows at 3
  // cols starts at 4).
  //
  // The tail stays grouped by section so the flat dock roster still reads as
  // signal flow (level sits with the output cluster at the end). Pages mirror
  // the mock's section bands (oscillator → wavefolder → diode filter →
  // envelopes → output), lowercase labels.
  face: {
    order: [
      // the hero ladder (mini = 1 / compact = 2 + glyph / full-in-lane plate = 6)
      'cutoff',
      'shape1',
      'res',
      'detune',
      'oct2',
      'pw',
      'fold',
      'env',
      // dock tail — grouped by section, signal-flow order
      'shape2',
      'mix',
      'sub',
      'sym',
      'drive',
      'track',
      'fatk',
      'fdec',
      'fsus',
      'frel',
      'atk',
      'dec',
      'sus',
      'rel',
      'width',
      'level',
      'hold',
    ],
    // FIVE pages, ids UNCHANGED. ⚠ `oscillator` is BOTH a page id and the id of
    // the pinned rear group below — and that is REQUIRED, not a collision:
    // `rearFieldPlan` walks `face.pages` and lets a curated group with the
    // page's id CLAIM that page's band slot. Rename one without the other and
    // the rear grows a stray appended 7-hole band while the totality gate stays
    // green (every port still renders exactly once, just in a wrecked order).
    // The collision that DOES bite is a page id equal to the LEADING group's id
    // — see the `voice` group's note below, and dx7's `id:'patch'` scar.
    pages: [
      {
        id: 'oscillator',
        label: 'oscillator',
        controls: ['shape1', 'shape2', 'pw', 'detune', 'oct2', 'mix', 'sub'],
      },
      { id: 'wavefolder', label: 'wavefolder', controls: ['fold', 'sym'] },
      {
        id: 'filter',
        label: 'diode filter',
        controls: ['cutoff', 'res', 'drive', 'env', 'track'],
      },
      {
        id: 'envelopes',
        label: 'envelopes',
        controls: ['fatk', 'fdec', 'fsus', 'frel', 'atk', 'dec', 'sus', 'rel'],
        // PF-9 — this band is ONE IDEA TWICE (an ADSR for the filter, an ADSR
        // for the amp), which is precisely the cluster case rather than the
        // page case. The REAR already teaches the split; the front hid it
        // behind eight unlabeled A/D/S/R knobs whose only distinguishing mark
        // was the `F.` prefix. A sub-header costs ~14 px, a second page ~81.
        clusters: [
          { label: 'filter eg', controls: ['fatk', 'fdec', 'fsus', 'frel'] },
          { label: 'amp eg', controls: ['atk', 'dec', 'sus', 'rel'] },
        ],
      },
      { id: 'output', label: 'output', controls: ['width', 'level', 'hold'] },
    ],
    glyph: 'waveform',
    // MOMENTARY: `hold` is a PRESS-PAD, not a latching switch. Everything that
    // touches it agrees and always has — a `hold-pad` drove it with
    // pointerdown/pointerup, the worklet ORs it into
    // the mono gate exactly like tomtom's declared-momentary `strike`
    // (packages/dsp/src/tidy-vco.ts: `monoGate = max(gateIn, hold)`), and the
    // authored doc below says "released = note-off (no latch)". Only the shell
    // disagreed: with no declaration it painted a LATCHING KnobConic, so
    // dragging it to 1 held the voice open forever AND persisted a stuck 1 into
    // the Y.Doc for every rack-mate. Same class as the tomtom STRIKE bug this
    // field was added for.
    momentary: ['hold'],
    // REAR CARD curation (rear-card-model). Only the exceptions: pwm_cv's
    // stem ('pwm') doesn't match its param id ('pw'), so the oscillator band
    // is pinned explicitly; the envelopes band splits into the two EG
    // clusters; the worklet's audio-rate CVs get the `~` tick.
    //
    // AUDIT (P1 batch-2 rear sweep): the tick list said SIX, but the worklet
    // reads only FOUR of them per sample — `this.bus.cutoffCv/pwmCv/foldCv/
    // symCv = inputs[i]?.[0]` (whole block) vs `resCv/driveCv =
    // inputs[i]?.[0]?.[0]` (first sample only, "they re-derive solver
    // coefficients"; packages/dsp/src/tidy-vco.ts). The authored docs agree —
    // cutoff/pwm/fold/sym say "audio-rate", res/drive do not. RES + DRIVE
    // dropped: a `~` promising per-sample FM on a block-rate hole is a lie
    // that sends a patcher hunting growl that cannot exist.
    rear: {
      groups: [
        // THE LEADING BAND. Derivation heads it `voice`, which says nothing a
        // player can act on. The most consequential patch-time fact about this
        // module is the ARBITRATION: while ANY poly lane is gated the chord bus
        // drives the voices and the mono PITCH/GATE pair goes DEAD
        // (tidy-vco-dsp.ts, the poly-wins branch). So the band is named by what
        // you DO at it — `play` — and split into the two mutually-exclusive
        // sources, which is a fact no amount of hole-labelling can convey.
        //
        // ⚠ The group id stays `voice` (the leading-slot claim key) while the
        // LABEL carries the word. Giving it id `play` would append it AFTER the
        // page bands instead — and none of the five page ids is `voice`, so
        // there is no double-render here (the dx7 `patch`/`voice` scar).
        { id: 'voice', label: 'play', ports: ['poly', 'pitch', 'gate'] },
        {
          id: 'oscillator',
          label: 'oscillator',
          ports: ['shape1_cv', 'shape2_cv', 'pwm_cv', 'detune_cv', 'oct2_cv', 'mix_cv', 'sub_cv'],
        },
      ],
      clusters: [
        { group: 'voice', label: 'poly bus', ports: ['poly'] },
        { group: 'voice', label: 'mono (fallback)', ports: ['pitch', 'gate'] },
        { group: 'envelopes', label: 'filter eg', ports: ['fatk_cv', 'fdec_cv', 'fsus_cv', 'frel_cv'] },
        { group: 'envelopes', label: 'amp eg', ports: ['atk_cv', 'dec_cv', 'sus_cv', 'rel_cv'] },
      ],
      audioRate: ['cutoff_cv', 'pwm_cv', 'fold_cv', 'sym_cv'],
    },
  },

  docs: {
    explanation:
      'A flagship two-oscillator virtual-analog subtractive voice: OSC1 and OSC2 each morph continuously from sawtooth to pulse (band-limited polyBLEP), share one pulse-width control with a PWM CV jack, and OSC2 adds an octave switch plus cents detune; a sub square one octave under OSC1 fattens the bottom. The mix then passes through a STEREO WAVEFOLDER placed BEFORE the filter — the West-Coast Serge/Buchla move of folding timbre INTO a lowpass: a reflecting triangle folder (antialiased with antiderivative antialiasing over 2× oversampling) that grows a thicket of harmonics as FOLD climbs, with a SYMMETRY bias that blooms even harmonics off-center, and a genuine stereo image (L and R fold at antiphase points scaled by WIDTH, so the folder itself widens the field). FOLD 0 is a true bypass — every existing patch is unchanged. The folded mix feeds an all-new nonlinear zero-delay-feedback DIODE LADDER filter — the EMS VCS3 / TB-303 circuit family, deliberately distinct from a Moog-style transistor ladder: bidirectionally coupled stages give a softer, warmer knee into a 24 dB/oct slope, the resonance return passes through a squelch limiter so high RES compresses into a bounded, CLEAN self-oscillation whistle, and the CUTOFF knob is calibrated to the resonant pitch itself (keytracked self-osc plays in tune; the zero-res brightness knee sits well below the knob — the diode pole spread, part of the sound). DRIVE saturates into the filter for harmonic warmth (2× oversampled, loudness-compensated), and the diode ladder’s natural bass-loss at high resonance is deliberately only part-compensated — a musical squelch dip instead of a vanished low end. Two RC-curve ADSRs shape the note: real one-pole exponential segments in the CEM3310 lineage, whose attack charges toward an overshoot target and cuts over at full level — a convex, punchy front — with analog retrigger (a re-struck note resumes from its current level, never a click). The filter EG sweeps cutoff by up to ±4 octaves via ENV; the amp EG drives an OTA-flavored VCA whose tanh knee blooms gentle even harmonics as notes get louder. The voice is 5-voice polyphonic on the POLY chord bus (lane i drives voice i; a releasing voice holds its pitch), falls back to the mono PITCH/GATE pair when no lane is gated — where it plays a REAL two-voice unison, detuned ±7 cents times WIDTH and panned to opposite sides, each side with its own filter and envelopes — and WIDTH also fans the five poly voices across the stereo field with the root note anchored center. A momentary HOLD pad on the panel gates the voice by hand — the fastest way to audition or drone it while you shape the sound.',
    inputs: {
      poly: 'The 5-lane poly pitch/gate chord bus: lane i drives voice i (fixed mapping, no allocator). Patch a real poly source — MIDI LANE, POLYSEQZ, or a SEQUENCER with chords — and each gated lane opens that voice’s own filter + amp envelopes; a releasing voice keeps sounding at its held pitch. While ANY lane is gated this bus wins over the mono pitch/gate pair.',
      pitch: 'Mono pitch CV, 1 V/oct with 0 V = C4. When no poly lane is gated, this drives the 2-voice unison pair (both voices track it, split by WIDTH’s detune drift).',
      gate: 'Mono gate (level-sensitive, not edge-only): high opens the unison pair’s envelopes, low releases them — note-off matters, an ADSR sustain lives while this is held. The panel HOLD pad ORs into this gate, and poly lanes take precedence the moment any lane goes high.',
      cutoff_cv: 'Filter cutoff CV at 4 octaves per volt — a ±1 V full swing covers ±4 octaves around the CUTOFF knob. Audio-rate (per-sample) for filter FM growl.',
      res_cv: 'Resonance CV: ±1 V spans the whole RES range on top of the knob — sequence the squelch, or push a moderate knob setting over the self-osc threshold.',
      pwm_cv: 'Pulse-width modulation CV: ±0.45 duty per volt on the shared PW, audio-rate. The effective width is clamped 0.05–0.95, so CV reaches wide duties past the knob’s 0.5 (square) ceiling. Classic PWM strings come from an LFO here with SHAPE at pulse.',
      drive_cv: 'Drive CV: ±1 V spans the whole DRIVE range on top of the knob — automate the filter’s input saturation for building intensity.',
      fold_cv: 'Wavefolder FOLD CV: ±1 V spans the whole FOLD range on top of the knob, audio-rate. The folder is very modulation-hungry — an envelope or LFO here sweeps timbre from clean to fully folded (classic West-Coast dynamic-fold gestures).',
      sym_cv: 'Wavefolder SYMMETRY CV: ±1 V spans the whole asymmetry range each way, audio-rate. Modulate the fold’s bias to make the even-harmonic content breathe (only audible while FOLD is up).',
      shape1_cv: 'OSC1 SHAPE CV: ±1 V sweeps the full saw↔pulse morph (0..1) on top of the knob. GLOBAL (all 5 voices), block-rate; cv = 0 is a no-op.',
      shape2_cv: 'OSC2 SHAPE CV: ±1 V sweeps the full saw↔pulse morph (0..1) on top of the knob. GLOBAL (all voices), block-rate.',
      detune_cv: 'OSC2 DETUNE CV (cents, linear): ±1 V sweeps ±50 ¢ — the full detune range centered on the knob. GLOBAL (all voices), block-rate; feed a slow LFO for a drifting chorus.',
      oct2_cv: 'OSC2 OCTAVE CV (discrete): 1 octave step per volt, summed with the knob, rounded and clamped to −1 / 0 / +1. GLOBAL (all voices), block-rate.',
      mix_cv: 'OSC1↔OSC2 MIX CV: ±1 V sweeps the full equal-power balance (0..1) on top of the knob. GLOBAL (all voices), block-rate.',
      sub_cv: 'SUB-oscillator level CV: ±1 V sweeps the full sub-square level (0..1) on top of the knob. GLOBAL (all voices), block-rate.',
      env_cv: 'Filter-EG AMOUNT CV (bipolar): ±1 V sweeps the full ±1 ENV depth (±4 octaves of cutoff sweep) centered on the knob. GLOBAL (all voices), block-rate.',
      track_cv: 'Cutoff KEYTRACKING CV: ±1 V sweeps the full 0–100 % TRACK amount on top of the knob. GLOBAL (all voices), block-rate.',
      fatk_cv: 'Filter-EG ATTACK-time CV: 4 octaves of time per volt (+1 V = ×16, −1 V = ×1⁄16) multiplying the knob time. GLOBAL (all voices), block-rate; cv = 0 = ×1, a no-op.',
      fdec_cv: 'Filter-EG DECAY-time CV: 4 octaves of time per volt on top of the knob. GLOBAL (all voices), block-rate.',
      fsus_cv: 'Filter-EG SUSTAIN CV: ±1 V sweeps the full 0–1 sustain level on top of the knob. GLOBAL (all voices), block-rate.',
      frel_cv: 'Filter-EG RELEASE-time CV: 4 octaves of time per volt on top of the knob. GLOBAL (all voices), block-rate.',
      atk_cv: 'Amp-EG ATTACK-time CV: 4 octaves of time per volt (+1 V = ×16) multiplying the knob time. GLOBAL (all voices), block-rate.',
      dec_cv: 'Amp-EG DECAY-time CV: 4 octaves of time per volt on top of the knob. GLOBAL (all voices), block-rate.',
      sus_cv: 'Amp-EG SUSTAIN CV: ±1 V sweeps the full 0–1 sustain level on top of the knob. GLOBAL (all voices), block-rate.',
      rel_cv: 'Amp-EG RELEASE-time CV: 4 octaves of time per volt on top of the knob. GLOBAL (all voices), block-rate.',
      width_cv: 'Stereo WIDTH CV: ±1 V sweeps the full 0–1 width — the poly pan fan / mono unison spread AND the wavefolder’s stereo decorrelation. GLOBAL, block-rate.',
      level_cv: 'Output LEVEL CV (dB): ±1 V sweeps ±18 dB — the full 36 dB level range centered on the knob (clamped −24..+12 dB into the true-peak bound). GLOBAL, block-rate; cv = 0 is a no-op.',
    },
    outputs: {
      out_l: 'Left output of the stereo voice bus (equal-power voice pans, 1/√n normalization, dB LEVEL, DC-blocked, true-peak bounded). Pairs with out_r — patching L into a stereo target auto-wires R.',
      out_r: 'Right output — the partner of out_l, carrying the WIDTH pan fan (poly) or the opposite unison voice (mono).',
    },
    controls: {
      shape1: 'OSC1 waveform morph: 0 = sawtooth, 1 = pulse, continuous crossfade between (both legs band-limited; the even harmonics drain out as it approaches the square).',
      shape2: 'OSC2 waveform morph, same law as SHAPE 1 (0 = saw, 1 = pulse).',
      pw: 'Shared pulse width for both oscillators’ pulse legs: 0.5 = square (even harmonics nulled) down to 0.05 = a thin reedy sliver. The PWM CV jack modulates around this — and can push the effective width past the knob’s square ceiling, up to 0.95.',
      detune: 'OSC2 detune in cents (±50): a few cents gives the classic two-osc VA shimmer — the pair beats at a rate proportional to the note’s frequency, so high notes shimmer faster — while large values approach quarter-tone clash.',
      oct2: 'OSC2 octave switch — three states, not a sweep: −1 (an octave below OSC1), 0 (OSC1’s own octave, where DETUNE alone separates the pair into the classic two-osc shimmer) and +1 (an octave above). At ±1 the DETUNE beat rides on top of the interval rather than replacing it.',
      mix: 'Equal-power OSC1↔OSC2 balance: 0 = OSC1 only, 1 = OSC2 only.',
      sub: 'Sub-oscillator level: a band-limited square one octave below OSC1, mixed under the pair for floor weight.',
      fold: 'Stereo WAVEFOLDER amount, placed BEFORE the filter (the West-Coast timbre-into-lowpass voice): 0 is a true bypass (the voice sounds exactly as it did without the folder), and turning it up drives the osc bus into a reflecting triangle folder that reflects more times as you climb — a rising thicket of harmonics the diode ladder then shapes. The fold is antialiased (ADAA + 2× oversampling) and GENUINELY stereo: L and R fold at antiphase points (scaled by WIDTH) so the folder itself widens the image, more as FOLD rises. Very modulation-hungry — patch an envelope or LFO into the FOLD CV.',
      sym: 'Wavefolder SYMMETRY: a bipolar DC bias on the fold input (only active while FOLD is up). At center the fold is symmetric (odd harmonics only); pushed either way it folds asymmetrically, blooming EVEN harmonics for a hollow, brassy, or reedy character. Modulate it with the SYM CV.',
      cutoff: 'Filter cutoff, 40 Hz–14 kHz — calibrated to the RESONANT pitch: at full RES the filter whistles AT this frequency (and tracks it to under 3 cents). The zero-res brightness knee sits a few octaves below the knob — the diode ladder’s soft spread knee, part of its warmth.',
      res: 'Resonance: squelchy diode-ladder emphasis that compresses through the feedback limiter as it rises; self-oscillation starts near 0.89 and the whistle stays bounded and near-sinusoidal. High RES also drops the passband by design — up to ~10 dB near full resonance, part-compensated from the raw diode ladder’s −25 dB collapse: the 303 body-drop squelch dip.',
      drive: 'Input saturation into the ladder (2× oversampled tanh with loudness makeup): grows odd harmonics by tens of dB across the travel without acting as a volume knob.',
      env: 'Filter-EG amount, bipolar: up to ±4 octaves of cutoff sweep from the filter ADSR. Negative values pull the attack DARK and open into the sustain.',
      track: 'Cutoff keytracking, 0–100 %: at 100 % the filter (and its self-osc whistle) follows the keyboard exactly — play the resonance as a voice.',
      fatk: 'Filter EG attack time (RC-curve: exponential charge toward an overshoot target — front-loaded, punchy).',
      fdec: 'Filter EG decay time to the filter sustain level (−60 dB RC convention).',
      fsus: 'Filter EG sustain level — the settled brightness while a note is held.',
      frel: 'Filter EG release time after note-off (the brightness falls at its own rate, independent of the amp tail).',
      atk: 'Amp attack time — the same convex RC punch: a re-struck note resumes from its current level (analog retrigger, no reset click).',
      dec: 'Amp decay time to SUSTAIN while the note is held.',
      sus: 'Amp sustain level (read live — sweeping it during a held note tracks).',
      rel: 'Amp release time after note-off.',
      width: 'Stereo width: in poly it fans the five voices across the field (root anchored center); in mono it engages the 2-voice unison — ±(7 ¢ × WIDTH) drift panned to opposite sides. It also scales the wavefolder’s L/R decorrelation, so the folder widens with it. 0 = center mono, 1 = full field.',
      level: 'Output level in dB (−24…+12) into the true-peak bound.',
      hold: 'Momentary drone pad: pressed = the mono gate held high, released = note-off (no latch). OR-ed with the GATE jack — an external gate keeps working — and poly lanes still win while any lane is gated. The fastest way to audition the voice as you shape it.',
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 27 audio-rate node inputs: poly (0, 10-ch), pitch (1), gate (2),
    // cutoff_cv (3), res_cv (4), pwm_cv (5), drive_cv (6), fold_cv (7),
    // sym_cv (8), then a per-knob CV for the remaining controls (9..26):
    // shape1, shape2, detune, oct2, mix, sub, env, track, fatk, fdec, fsus,
    // frel, atk, dec, sus, rel, width, level. TWO mono outputs (out_l, out_r).
    const worklet = createWorkletNode(node, ctx, PROCESSOR_NAME, {
      numberOfInputs: 27,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    // Keep the worklet alive with a single 0-offset silence source on EVERY
    // input, so it processes blocks (and the HOLD pad can drone immediately)
    // even when nothing is patched yet. The 0-offset fan is ALSO what makes an
    // unpatched CV a no-op (cv = 0 → the core's scaling laws are identities),
    // keeping the ART render byte-identical. One ConstantSource, 27 connections.
    // The poly input relies on channelCountMode 'max' — a real 10-channel
    // cable fans it out when patched.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    for (let i = 0; i < 27; i++) silence.connect(worklet, 0, i);

    // Set initial params from the persisted node state (or defaults).
    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of tidyVcoDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    const inputsMap = new Map<string, { node: AudioNode; input: number }>();
    inputsMap.set('poly', { node: worklet, input: 0 });
    inputsMap.set('pitch', { node: worklet, input: 1 });
    inputsMap.set('gate', { node: worklet, input: 2 });
    inputsMap.set('cutoff_cv', { node: worklet, input: 3 });
    inputsMap.set('res_cv', { node: worklet, input: 4 });
    inputsMap.set('pwm_cv', { node: worklet, input: 5 });
    inputsMap.set('drive_cv', { node: worklet, input: 6 });
    inputsMap.set('fold_cv', { node: worklet, input: 7 });
    inputsMap.set('sym_cv', { node: worklet, input: 8 });
    inputsMap.set('shape1_cv', { node: worklet, input: 9 });
    inputsMap.set('shape2_cv', { node: worklet, input: 10 });
    inputsMap.set('detune_cv', { node: worklet, input: 11 });
    inputsMap.set('oct2_cv', { node: worklet, input: 12 });
    inputsMap.set('mix_cv', { node: worklet, input: 13 });
    inputsMap.set('sub_cv', { node: worklet, input: 14 });
    inputsMap.set('env_cv', { node: worklet, input: 15 });
    inputsMap.set('track_cv', { node: worklet, input: 16 });
    inputsMap.set('fatk_cv', { node: worklet, input: 17 });
    inputsMap.set('fdec_cv', { node: worklet, input: 18 });
    inputsMap.set('fsus_cv', { node: worklet, input: 19 });
    inputsMap.set('frel_cv', { node: worklet, input: 20 });
    inputsMap.set('atk_cv', { node: worklet, input: 21 });
    inputsMap.set('dec_cv', { node: worklet, input: 22 });
    inputsMap.set('sus_cv', { node: worklet, input: 23 });
    inputsMap.set('rel_cv', { node: worklet, input: 24 });
    inputsMap.set('width_cv', { node: worklet, input: 25 });
    inputsMap.set('level_cv', { node: worklet, input: 26 });

    return {
      domain: 'audio',
      inputs: inputsMap,
      outputs: new Map([
        ['out_l', { node: worklet, output: 0 }],
        ['out_r', { node: worklet, output: 1 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try {
          silence.stop();
        } catch {
          /* already stopped */
        }
        try {
          silence.disconnect();
        } catch {
          /* */
        }
        try {
          worklet.disconnect();
        } catch {
          /* */
        }
      },
    };
  },
};
