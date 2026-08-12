// packages/web/src/lib/audio/modules/pentemelodica.ts
//
// PENTEMELODICA — 5-voice polyphonic analog-style synth (audio domain).
//
// ── Model ────────────────────────────────────────────────────────────────
// A complete polyphonic synth voice-card in one module. A POLY input (the
// 10-channel polyPitchGate chord bus emitted by MIDI LANE / POLYSEQZ /
// SEQUENCER-with-chords) drives five independent analog-style VCO voices. Lane
// i → voice i (fixed 1:1 mapping, no allocator). Each voice has:
//   * a band-limited oscillator (clean-room polyBLEP, anti-aliased) with a
//     continuous tri→saw→square WAVE morph,
//   * TUNE (coarse st) + FINE (cents),
//   * exponential FM and through-phase PM, both driven by the voice's own
//     audio-rate FM jack (fm1..fm5),
//   * a pulse-width control for the square end of the morph,
//   * its own gated amplitude envelope — but the A/D/S/R is SHARED across all
//     five voices (one device-level ADSR; poly-adsr alignment with CUBE /
//     WAVECEL / DX7). The gate edge comes from the poly lane.
//
// The five post-ADSR voices are summed through a stereo mixer (per-voice LEVEL
// + equal-power PAN), then through an embedded multimode filter — a continuous
// LP→BP→HP→Notch MODE dial on a TPT state-variable filter (CUTOFF / RESONANCE)
// with a WET/DRY bypass — and out the stereo OUT_L / OUT_R pair. Each voice's
// pre-mixer mono signal is also tapped to a VOICE1..VOICE5 output for
// per-voice processing / scoping.
//
// ── Inputs ───────────────────────────────────────────────────────────────
//   poly  (polyPitchGate): 5-lane pitch/gate chord bus. Lane i drives voice i.
//   fm1..fm5     (audio) : per-voice audio-rate FM/PM modulator. Voice n reads
//                          fm{n}; the FM (exponential) and PM (phase) depths
//                          are set by that voice's FM / PM faders. A shared
//                          jack drives both so one modulator gives either or
//                          both flavours of modulation.
//
// ── Outputs ──────────────────────────────────────────────────────────────
//   out_l, out_r (audio) : stereo mix, post-filter, post-master-gain.
//   voice1..voice5(audio): per-voice pre-mixer mono tap (post-ADSR, BEFORE
//                          level/pan) — patch into your own VCA / filter / FX.
//
// ── Params (48: 5 voices × 8 + 4 shared ADSR + 4 filter) ───────────────────
//   per voice vN_: tune(st) fine(¢) fm pm pw wave level pan
//   shared ADSR:   attack(s) decay(s) sustain release(s)   (feeds all voices)
//   filter:        cutoff(Hz) resonance mode wetdry
//
// ── CV / patching ──────────────────────────────────────────────────────────
//   This first slice exposes the poly chord bus + five per-voice FM jacks. The
//   48 voice/ADSR/filter params are panel controls (k-rate AudioParams);
//   LFO-able cutoff / per-voice CV jacks are a deliberate follow-up — keep the
//   v1 surface to the six declared input buses.
//
// ── Usage ────────────────────────────────────────────────────────────────
//   Patch MIDI LANE (mode=poly) or POLYSEQZ → poly to play chords; dial each
//   voice's TUNE/FINE for unison/detune/spread, set the shared ADSR + per-voice
//   WAVE for the timbre, then sculpt the whole stack with the embedded filter.
//   Tap a
//   voiceN out to send one voice somewhere else (e.g. a reverb on the top
//   voice only). The stereo OUT keeps the per-voice PAN spread.
//
// ── DSP ──────────────────────────────────────────────────────────────────
//   Worklet: packages/dsp/src/pentemelodica.ts + lib/pentemelodica-dsp.ts.
//   Own-code: polyBLEP oscillator (lib/moog-vco-dsp), TPT SVF
//   (lib/resofilter-dsp), a linear-ADSR Envelope. The pure-math mirror
//   (`pentemelodicaMath`, re-exported below) is what unit tests + ART exercise
//   under node where AudioWorkletGlobalScope is unavailable.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/pentemelodica.js?url';
import { createWorkletNode } from '$lib/audio/worklet-guard';
import {
  PENTE_VOICES,
  makePenteState,
  makeRenderOut,
  renderPentemelodica,
  type PenteParams,
  type PenteVoiceParams,
  type PenteFilterParams,
  type AdsrParams,
  // The shared DSP lib (node-importable IDENTICAL source the worklet bundles).
} from '../../../../../dsp/src/lib/pentemelodica-dsp';

const loadedContexts = new WeakSet<BaseAudioContext>();

export { PENTE_VOICES };

// ----------------------------------------------------------------------------
// Pure-math mirror — re-exported from the shared DSP lib so unit tests + ART
// can render PENTEMELODICA under node (worklets can't load without an
// AudioWorkletGlobalScope). This is the SAME source the worklet bundles, so
// there is no second copy to keep in sync.
// ----------------------------------------------------------------------------

export interface PentemelodicaRenderInput {
  /** length 2*PENTE_VOICES: [pitchV0, gate0, …, pitchV4, gate4]. */
  polyPitchGate: number[];
  /** per-voice FM/PM modulator (constant). length PENTE_VOICES, default 0s. */
  fmInputs?: number[];
  voices: PenteVoiceParams[];
  /** ONE shared amplitude A/D/S/R fed into every voice envelope. Defaults to
   *  the param defaults (attack 0.001 / decay 0.1 / sustain 1 / release 0.005)
   *  when omitted. */
  adsr?: AdsrParams;
  filter: PenteFilterParams;
}

export const pentemelodicaMath = {
  PENTE_VOICES,
  /** Render `n` samples; returns stereo L/R + per-voice pre-mixer taps. */
  render(n: number, sr: number, input: PentemelodicaRenderInput) {
    const state = makePenteState();
    const out = makeRenderOut(n);
    const adsr: AdsrParams = input.adsr ?? {
      attack: 0.001, decay: 0.1, sustain: 1, release: 0.005,
    };
    const params: PenteParams = { voices: input.voices, adsr, filter: input.filter };
    const fm = input.fmInputs ?? new Array(PENTE_VOICES).fill(0);
    renderPentemelodica(params, input.polyPitchGate, fm, n, sr, state, out);
    return out;
  },
};

// ----------------------------------------------------------------------------
// Module def.
// ----------------------------------------------------------------------------

type ParamDef = AudioModuleDef['params'][number];

/** Build the per-voice param list (×5). The amplitude ADSR is NOT per-voice —
 *  one shared A/D/S/R (added separately below) feeds every voice envelope. */
function voiceParams(): ParamDef[] {
  const ps: ParamDef[] = [];
  for (let v = 1; v <= PENTE_VOICES; v++) {
    ps.push(
      { id: `v${v}_tune`,    label: 'Tune',    defaultValue: 0,     min: -36,  max: 36,  curve: 'linear', units: 'st' },
      { id: `v${v}_fine`,    label: 'Fine',    defaultValue: 0,     min: -100, max: 100, curve: 'linear', units: '¢' },
      { id: `v${v}_fm`,      label: 'FM',      defaultValue: 0,     min: -1,   max: 1,   curve: 'linear' },
      { id: `v${v}_pm`,      label: 'PM',      defaultValue: 0,     min: -1,   max: 1,   curve: 'linear' },
      { id: `v${v}_pw`,      label: 'PW',      defaultValue: 0.5,   min: 0.05, max: 0.95, curve: 'linear' },
      { id: `v${v}_wave`,    label: 'Wave',    defaultValue: 0,     min: 0,    max: 1,   curve: 'linear' },
      { id: `v${v}_level`,   label: 'Level',   defaultValue: 0.8,   min: 0,    max: 1,   curve: 'linear' },
      { id: `v${v}_pan`,     label: 'Pan',     defaultValue: 0,     min: -1,   max: 1,   curve: 'linear' },
    );
  }
  return ps;
}

export const pentemelodicaDef: AudioModuleDef = {
  type: 'pentemelodica',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'pentemelodica',
  category: 'sources',
  stereoPairs: [['out_l', 'out_r']],

  // Chain-role (Design-D declarative override): a DECLARED source. Its audio
  // inputs (fm1..fm5) are MODULATION, not a signal-chain insert, so the workflow
  // column classifier must treat it as a head-eligible SOURCE, not FX (it takes
  // a poly input for clip note control).
  chainWiring: { role: 'source' },

  inputs: [
    // 5-lane poly chord bus → voices. NOT a paramTarget (poly is a direct
    // node connection, never a CV→AudioParam target).
    { id: 'poly', type: 'polyPitchGate' },
    // Per-voice audio-rate FM/PM modulator jacks.
    { id: 'fm1', type: 'audio' },
    { id: 'fm2', type: 'audio' },
    { id: 'fm3', type: 'audio' },
    { id: 'fm4', type: 'audio' },
    { id: 'fm5', type: 'audio' },
  ],
  outputs: [
    { id: 'out_l',  type: 'audio' },
    { id: 'out_r',  type: 'audio' },
    { id: 'voice1', type: 'audio' },
    { id: 'voice2', type: 'audio' },
    { id: 'voice3', type: 'audio' },
    { id: 'voice4', type: 'audio' },
    { id: 'voice5', type: 'audio' },
  ],
  params: [
    ...voiceParams(),
    // ONE shared amplitude ADSR (poly-adsr alignment) — same ids/ranges/curves/
    // defaults as CUBE's. Every voice envelope reads these (gated per-lane).
    { id: 'attack',  label: 'A', defaultValue: 0.001, min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'decay',   label: 'D', defaultValue: 0.1,   min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'sustain', label: 'S', defaultValue: 1,     min: 0,     max: 1, curve: 'linear' },
    { id: 'release', label: 'R', defaultValue: 0.005, min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'cutoff',    label: 'Cutoff', defaultValue: 1000, min: 20, max: 20000, curve: 'log', units: 'Hz' },
    { id: 'resonance', label: 'Reso',   defaultValue: 0.2,  min: 0,  max: 0.99,  curve: 'linear' },
    { id: 'mode',      label: 'Mode',   defaultValue: 0,    min: 0,  max: 1,     curve: 'linear' },
    { id: 'wetdry',    label: 'Wet',    defaultValue: 1,    min: 0,  max: 1,     curve: 'linear' },
  ],

  // ── PF-20 FACEPLATE ───────────────────────────────────────────────────────
  //
  // ⚠ EIGHT BANDS — AND THE TAB RAIL THEY BUY — ARE THE DESIGN, NOT AN
  // OVERFLOW. `DOCK_TAB_MIN_BANDS = 7`, so this face renders as a RAIL, and
  // that is the only shape this module has: FORTY of its forty-eight params are
  // FIVE IDENTICAL STRIPS OF EIGHT, and neither `face.order` (a flat priority
  // list) nor `face.pages` (a flat band list) can say "this group, five times".
  // Both alternatives are worse — one 40-cell band fuses five different ideas
  // into one header, and promoting `v1_*` into the six-cell lane budget would
  // claim voice 1 matters more than voice 4, which the DSP flatly does not
  // (lane i → voice i, fixed 1:1, no allocator, no stealing). So the LANE ranks
  // the six GLOBAL controls and the rail owns the strips. Do NOT "fix" this
  // back under seven.
  //
  // ⚠ THE LABELS ARE THE RAIL. On a tabbed face `bandHeaderPlan` suppresses the
  // band label (the rail already says it) and EVERY hint is annotation-only, so
  // at rest a band's tab caption is the only word naming it. That is why the
  // two shared sections read `shared filter` / `shared adsr` and not `filter` /
  // `adsr`: the single most misread fact about this module is that five voices
  // run through ONE envelope and ONE filter, and the caption has to carry it
  // with the prose hidden. Eight captions share one rail, so they also stay
  // SHORT.
  face: {
    order: [
      // ── the LANE budget: ranks 1-6, and it ends HERE (faceTierCap). Every
      // one of them acts on ALL FIVE VOICES AT ONCE, which is the only
      // non-arbitrary way to pick six out of forty-eight.
      'cutoff',      // 1  the module's principal timbre, on the summed mix
      'resonance',   // 2  and it is two controls: it also sets the MODE-1 depth
      'mode',        // 3  which of four responses the whole instrument has
      'wetdry',      // 4  the filter's authority; ships at 1.0 = no dry path
      'attack',      // 5  the shared amp attack — a real duration
      'release',     // 6  the shared tail — a TIME CONSTANT, not a duration
      // ── dock-only from here down ──
      // THE HERO PICTURE — five voice lanes at a glance. Rank 7 is a panel's
      // first LEGAL rank (module-face-lint fails a panel SELECTED at any lane
      // tier: a 420 px picture cannot live in a 46 px knob column), and it is
      // also its right one — on a tabbed face four of the five voices are
      // hidden at any moment, so the picture is what keeps the instrument
      // legible while you edit one strip.
      'pentemelodica-voices-{n}',   // 7
      'sustain',                    // 8  ships at 1, which is what makes 9 inert
      'decay',                      // 9  ZERO samples of decay run while S = 1
      // the mixer: all five levels, then all five pans, because balance is
      // comparative and you cannot set it a voice at a time.
      'v1_level', 'v2_level', 'v3_level', 'v4_level', 'v5_level',
      'v1_pan',   'v2_pan',   'v3_pan',   'v4_pan',   'v5_pan',
      // the five oscillator strips, in lane order. Within a strip: pitch, then
      // shape, then the two modulation depths (inert until that voice's own
      // fmN jack is patched).
      'v1_tune', 'v1_fine', 'v1_wave', 'v1_pw', 'v1_fm', 'v1_pm',
      'v2_tune', 'v2_fine', 'v2_wave', 'v2_pw', 'v2_fm', 'v2_pm',
      'v3_tune', 'v3_fine', 'v3_wave', 'v3_pw', 'v3_fm', 'v3_pm',
      'v4_tune', 'v4_fine', 'v4_wave', 'v4_pw', 'v4_fm', 'v4_pm',
      'v5_tune', 'v5_fine', 'v5_wave', 'v5_pw', 'v5_fm', 'v5_pm',
    ],
    // ⚠ `cutoff` AND the voices cell are LISTED here even though the hero
    // promotes them: `face.hero` MOVES a key, it does not ADD one, and
    // `heroFacePlan` can only move a key some band already claims. Leaving them
    // off would drop them into the defensive `__unpaged` "more" band instead —
    // a ninth band, and a different (wrong) faceplate.
    pages: [
      {
        id: 'filter',
        label: 'shared filter',
        hint:
          'ONE filter on the summed five-voice mix. The MODE dial ends on a true notch ' +
          '(lp + hp = x − k·bp), so that end nulls at the cutoff at every RESONANCE. ' +
          'Everywhere below it the level at cutoff is 1/k — from −6.0 dB at resonance 0 ' +
          'to +34.0 dB at 0.99, which nothing on the MODE knob shows you.',
        controls: ['cutoff', 'resonance', 'mode', 'wetdry'],
      },
      {
        id: 'amp',
        label: 'shared adsr',
        hint:
          'ONE A/D/S/R, gated per lane, feeding all five voice envelopes. ATTACK is a real ' +
          'duration; DECAY and RELEASE are TIME CONSTANTS — at the shipped SUSTAIN of 1 the ' +
          'decay never runs at all, and a 5 ms release rings for 58.',
        controls: ['attack', 'decay', 'sustain', 'release'],
      },
      {
        id: 'mix',
        label: 'mix · pan',
        hint:
          'Level and pan for all five voices in one place, because balance is comparative — you ' +
          'cannot set it a voice at a time. The stereo sum is then scaled by a CONSTANT 0.6, ' +
          'never 1/√N, so nothing here protects the headroom for you.',
        controls: [
          'pentemelodica-voices-{n}',
          'v1_level', 'v2_level', 'v3_level', 'v4_level', 'v5_level',
          'v1_pan',   'v2_pan',   'v3_pan',   'v4_pan',   'v5_pan',
        ],
        // Two sub-headers rather than two more bands: ten knobs in one flat row
        // is a wall, and loudness and position are different questions asked of
        // the same five voices. A cluster costs ~14 px; a band costs ~81 and a
        // ninth tab.
        clusters: [
          { label: 'level', controls: ['v1_level', 'v2_level', 'v3_level', 'v4_level', 'v5_level'] },
          { label: 'pan',   controls: ['v1_pan',   'v2_pan',   'v3_pan',   'v4_pan',   'v5_pan'] },
        ],
      },
      {
        id: 'v1',
        label: 'voice 1',
        hint:
          'Lane 1 of the poly bus — and the pitch every voice that is neither gated nor still ' +
          'ringing falls back to, which is the least visible behaviour in the module.',
        controls: ['v1_tune', 'v1_fine', 'v1_wave', 'v1_pw', 'v1_fm', 'v1_pm'],
      },
      {
        id: 'v2',
        label: 'voice 2',
        hint:
          'Lane 2. Lane i drives voice i, fixed 1:1 — there is no allocator and no note ' +
          'stealing, so a chord on lanes 1-3 leaves voices 4 and 5 silent.',
        controls: ['v2_tune', 'v2_fine', 'v2_wave', 'v2_pw', 'v2_fm', 'v2_pm'],
      },
      {
        id: 'v3',
        label: 'voice 3',
        hint:
          'Lane 3. PW is silent until WAVE passes halfway: below that the rectangular tap ' +
          'carries no weight in the morph, and WAVE ships at 0.',
        controls: ['v3_tune', 'v3_fine', 'v3_wave', 'v3_pw', 'v3_fm', 'v3_pm'],
      },
      {
        id: 'v4',
        label: 'voice 4',
        hint:
          "Lane 4. FM and PM both read this voice's OWN fm jack — exponential into the " +
          'frequency, through-phase into the read — so with nothing patched there both faders ' +
          'do nothing at all.',
        controls: ['v4_tune', 'v4_fine', 'v4_wave', 'v4_pw', 'v4_fm', 'v4_pm'],
      },
      {
        id: 'v5',
        label: 'voice 5',
        hint:
          'Lane 5. Every voice also leaves on its own output, tapped after the envelope but ' +
          'BEFORE level and pan — so a voice muted in the mix is still live on its own jack.',
        controls: ['v5_tune', 'v5_fine', 'v5_wave', 'v5_pw', 'v5_fm', 'v5_pm'],
      },
    ],
    glyph: 'scope',

    // Both strings are ANNOTATION (facePageHeader gates the whole header, TITLE
    // included) — at rest the faceplate carries no category word and no
    // description, and the module's name stays the dock title bar's job.
    title: 'Poly voice',
    hint:
      'Five band-limited oscillators driven lane-for-lane by a poly chord bus, through ONE ' +
      'shared ADSR and ONE shared filter. It makes NO sound on its own: patch a real poly ' +
      'source into POLY (MIDI LANE in poly mode, or POLYSEQZ) — a mono pitch cable lands on ' +
      'lane 1 PITCH and never opens a gate, which is silence, not one voice. The stereo sum is ' +
      'scaled by a CONSTANT 0.6 and never by 1/√N, so one note peaks at −9.4 dBFS and five ' +
      'peak at +4.6.',

    // THE HERO. `cutoff` and the voices picture are PROMOTED out of their bands
    // (heroFacePlan removes them), so the control multiset faces-parity asserts
    // is unchanged. CUTOFF leads because it is the one dial that moves all five
    // voices at once; the picture is beside it because on a tabbed face four of
    // the five strips are hidden and a live `scope` glyph on a module that is
    // SILENT until something gates it is an empty black rectangle.
    hero: {
      cell: 'pentemelodica-voices-{n}',
      control: 'cutoff',
      // ⚠ NO `action`. There is no audition seam for this module: it is driven
      // by a 10-channel poly bus, not by a `manualTrigger` read key, so there
      // is nothing for `fireManualStrike` to reach. A chord audition is a
      // FACTORY change (a host-side ConstantSource pair per lane), not a face
      // change.
      //
      // ⚠ ALL THREE READOUTS ARE DERIVED, and each is derived for the reason
      // the FaceReadout doc gives rather than as a habit:
      //   * `at cutoff` is a function of MODE **and** RESONANCE. A readout of
      //     MODE alone is INVARIANT to resonance and would print "low-pass"
      //     identically at −6.0 dB (res 0) and +34.0 dB (res 0.99) — a 50×
      //     swing on the master bus. That is the blind-metric trap, on the
      //     control that hides it.
      //   * `5-note peak` is a function of every LEVEL **and** every PAN. A
      //     level readback is invariant to pan; spreading the pans genuinely
      //     lowers the per-channel peak (1.697 → 1.534 at ±0.8).
      //   * `tail` is release × ln(sustain / 1e-5). The RELEASE knob is
      //     invariant to SUSTAIN, and sustain moves the answer 58 → 46 ms
      //     without the knob twitching. At the shipped 0.005 s the real tail is
      //     11.5× the label.
      // All three read PARAMS only, which is the whole of what a registered
      // readout can see.
      readouts: [
        { label: 'at cutoff',   valueId: 'pentemelodica-mode-gain' },
        { label: '5-note peak', valueId: 'pentemelodica-peak-dbfs' },
        { label: 'tail',        valueId: 'pentemelodica-release-tail' },
      ],
    },

    sidebar: [
      {
        kind: 'presets',
        // ⚠ VOICE LAYOUTS, AND THE NAME IS THE CONTRACT. Each entry is a
        // COMPLETE recall of all FORTY per-voice params — tune, fine, wave, pw,
        // fm, pm, level and pan, on every one of the five strips — and
        // deliberately touches NEITHER the shared ADSR nor the filter, which
        // are the player's. A partial recall whose omissions are undocumented
        // is worse than either honest option, so the scope is stated in the
        // block's own label and the omissions are exactly the two shared
        // sections the rail names. FM and PM are written to 0 on purpose: they
        // are part of a voice's identity, and leaving them alone would let a
        // stale depth survive a recall that claims to be complete.
        label: 'voice layouts',
        entries: [
          {
            id: 'unison',
            label: 'UNISON',
            note: '±9 ¢ spread',
            values: {
              v1_tune: 0, v1_fine: -9, v1_wave: 0.5, v1_pw: 0.5, v1_fm: 0, v1_pm: 0, v1_level: 0.7, v1_pan: -0.8,
              v2_tune: 0, v2_fine: -4, v2_wave: 0.5, v2_pw: 0.5, v2_fm: 0, v2_pm: 0, v2_level: 0.7, v2_pan: -0.4,
              v3_tune: 0, v3_fine:  0, v3_wave: 0.5, v3_pw: 0.5, v3_fm: 0, v3_pm: 0, v3_level: 0.7, v3_pan:  0,
              v4_tune: 0, v4_fine:  4, v4_wave: 0.5, v4_pw: 0.5, v4_fm: 0, v4_pm: 0, v4_level: 0.7, v4_pan:  0.4,
              v5_tune: 0, v5_fine:  9, v5_wave: 0.5, v5_pw: 0.5, v5_fm: 0, v5_pm: 0, v5_level: 0.7, v5_pan:  0.8,
            },
          },
          {
            id: 'octaves',
            label: 'OCTAVES',
            note: '−2 … +2 oct',
            values: {
              v1_tune: -24, v1_fine:  0, v1_wave: 0.25, v1_pw: 0.5, v1_fm: 0, v1_pm: 0, v1_level: 0.9,  v1_pan:  0,
              v2_tune: -12, v2_fine: -3, v2_wave: 0.35, v2_pw: 0.5, v2_fm: 0, v2_pm: 0, v2_level: 0.8,  v2_pan: -0.35,
              v3_tune:   0, v3_fine:  0, v3_wave: 0.5,  v3_pw: 0.5, v3_fm: 0, v3_pm: 0, v3_level: 0.75, v3_pan:  0.35,
              v4_tune:  12, v4_fine:  3, v4_wave: 0.6,  v4_pw: 0.5, v4_fm: 0, v4_pm: 0, v4_level: 0.5,  v4_pan: -0.6,
              v5_tune:  24, v5_fine:  0, v5_wave: 0.7,  v5_pw: 0.4, v5_fm: 0, v5_pm: 0, v5_level: 0.3,  v5_pan:  0.6,
            },
          },
          {
            id: 'fifths',
            label: 'STACKED 5THS',
            note: '0 · 7 · 12 · 19 · 24 st',
            values: {
              v1_tune:  0, v1_fine:  0, v1_wave: 0.8,  v1_pw: 0.35, v1_fm: 0, v1_pm: 0, v1_level: 0.8,  v1_pan: -0.5,
              v2_tune:  7, v2_fine: -2, v2_wave: 0.8,  v2_pw: 0.4,  v2_fm: 0, v2_pm: 0, v2_level: 0.7,  v2_pan:  0.5,
              v3_tune: 12, v3_fine:  2, v3_wave: 0.85, v3_pw: 0.45, v3_fm: 0, v3_pm: 0, v3_level: 0.6,  v3_pan: -0.2,
              v4_tune: 19, v4_fine:  0, v4_wave: 0.9,  v4_pw: 0.5,  v4_fm: 0, v4_pm: 0, v4_level: 0.45, v4_pan:  0.2,
              v5_tune: 24, v5_fine:  4, v5_wave: 0.95, v5_pw: 0.55, v5_fm: 0, v5_pm: 0, v5_level: 0.3,  v5_pan:  0,
            },
          },
        ],
      },
      {
        kind: 'readouts',
        label: 'the envelope, measured',
        // The three numbers side by side, because the middle one only makes
        // sense next to the other two: SUSTAIN at 1 is WHY the decay reads
        // 0 ms. ATTACK is a plain param readback and that is not laziness —
        // the attack really is a linear ramp of that length, so deriving it
        // would be an alias with an extra failure mode. DECAY is not.
        entries: [
          { label: 'attack',     paramId: 'attack' },
          { label: 'decay to S', valueId: 'pentemelodica-decay-to-sustain' },
          { label: 'sustain',    paramId: 'sustain' },
        ],
      },
    ],

    // REAR CARD curation (rear-card-model). Derivation would file all six
    // inputs into one generic 'voice' band; they are two different things.
    //  * No group id collides with a page id, so the leading band is claimed
    //    exactly once — the dx7 double-render shape does not apply here.
    //  * `~` on fm1..fm5 ONLY, and the citation is the worklet: the gate-edge
    //    loop reads the poly bus ONCE per render block, while the FM jacks are
    //    read per SAMPLE inside the inner loop. So the chord bus is block-rate
    //    by construction and the five modulator jacks genuinely are audio-rate
    //    destinations.
    //  ⚠ ONE leading group with a CLUSTER, not two groups. The authored draft
    //    declared a second `{ id: 'fm' }` group; module-face-lint rejects it,
    //    correctly — a curated group must claim the leading slot ('voice' /
    //    'signal') or name a real page id, and 'fm' does neither, so it would
    //    APPEND as a stray band after every page where the totality gate cannot
    //    see it. The five modulator jacks are a sub-header inside the leading
    //    band instead (the sixstrum per-string precedent), which is also the
    //    honest shape: they are all note-inputs of one instrument.
    rear: {
      groups: [
        { id: 'voice', label: 'note in · per-voice fm', ports: ['poly', 'fm1', 'fm2', 'fm3', 'fm4', 'fm5'] },
      ],
      clusters: [
        { group: 'voice', label: 'fm · one jack per voice', ports: ['fm1', 'fm2', 'fm3', 'fm4', 'fm5'] },
      ],
      audioRate: ['fm1', 'fm2', 'fm3', 'fm4', 'fm5'],
    },
  },

  controlFamilies: [
    // The HERO PICTURE, declared as a one-member family so the face can rank
    // it, the docs can key prose to it, and the RACKLINE shell can paint it as
    // a PANEL cell (shell-cells.ts). `testidPrefix` is grep-verified against
    // PentemelodicaCard's per-voice strips, which emit `pentemelodica-voice1`…
    // `pentemelodica-voice5` today.
    { id: 'pentemelodica-voices', label: 'Five-voice picture', kind: 'cell', testidPrefix: 'pentemelodica-voice' },
  ],

  docs: {
    explanation:
      "A complete five-voice polyphonic analog-style synth in one card. A poly chord bus drives five independent VCO voices (lane i → voice i, a fixed 1:1 mapping with no allocator), each a band-limited oscillator with a continuous triangle→saw→square WAVE morph, coarse Tune + Fine detune, exponential FM and through-phase PM (from that voice's own FM jack), and a pulse-width control. The five voices share ONE amplitude ADSR (the gate edge comes from each poly lane), get summed through a per-voice level + pan stereo mixer, then pass through an embedded multimode filter (LP→BP→HP→Notch MODE dial, Cutoff/Resonance, Wet/Dry) to the stereo OUT. Each voice is also tapped pre-mixer to its own VOICE output for separate processing. To play chords you must feed the POLY input from a real poly source — patch MIDI LANE (in poly mode) or POLYSEQZ (or a SEQUENCER set to chord steps) into POLY; a single mono note source only lights one voice.",
    inputs: {
      poly: "The 5-lane poly pitch/gate chord bus that plays the voices: lane i drives voice i (fixed mapping). Patch a real poly source here — MIDI LANE in poly mode, POLYSEQZ, or SEQUENCER with chord steps — so each held note opens a voice's shared ADSR; a mono pitch source only plays voice 1.",
      fm1: "Voice 1's audio-rate modulator jack: it feeds both that voice's exponential FM and its phase modulation, with the depths set by voice 1's FM and PM faders — so one patched modulator gives either or both flavours.",
      fm2: "Voice 2's audio-rate FM/PM modulator jack (depths set by voice 2's FM/PM faders).",
      fm3: "Voice 3's audio-rate FM/PM modulator jack (depths set by voice 3's FM/PM faders).",
      fm4: "Voice 4's audio-rate FM/PM modulator jack (depths set by voice 4's FM/PM faders).",
      fm5: "Voice 5's audio-rate FM/PM modulator jack (depths set by voice 5's FM/PM faders).",
    },
    outputs: {
      out_l: "Left channel of the stereo mix: all five voices, post-ADSR, through the per-voice level/pan mixer and the embedded filter, at master level. (Pairs with out_r as the main stereo output.)",
      out_r: "Right channel of the stereo mix (the partner of out_l, carrying the per-voice pan spread).",
      voice1: "Voice 1's individual signal, tapped post-ADSR but BEFORE the mixer's level/pan and the shared filter — patch it to send just this voice to its own VCA/filter/FX.",
      voice2: "Voice 2's pre-mixer mono tap (post-ADSR, before level/pan/filter).",
      voice3: "Voice 3's pre-mixer mono tap (post-ADSR, before level/pan/filter).",
      voice4: "Voice 4's pre-mixer mono tap (post-ADSR, before level/pan/filter).",
      voice5: "Voice 5's pre-mixer mono tap (post-ADSR, before level/pan/filter).",
    },
    controls: {
      // Per-voice oscillator strip (×5). Same control on each voice; {N} is the
      // voice number 1..5.
      v1_tune: "Voice 1 coarse tune in semitones (-36 to +36) — set per voice for unison, octaves, or chord-spread detuning.",
      v2_tune: "Voice 2 coarse tune in semitones (-36 to +36).",
      v3_tune: "Voice 3 coarse tune in semitones (-36 to +36).",
      v4_tune: "Voice 4 coarse tune in semitones (-36 to +36).",
      v5_tune: "Voice 5 coarse tune in semitones (-36 to +36).",
      v1_fine: "Voice 1 fine tune in cents (-100 to +100) — for subtle detune/beating against the other voices.",
      v2_fine: "Voice 2 fine tune in cents (-100 to +100).",
      v3_fine: "Voice 3 fine tune in cents (-100 to +100).",
      v4_fine: "Voice 4 fine tune in cents (-100 to +100).",
      v5_fine: "Voice 5 fine tune in cents (-100 to +100).",
      v1_fm: "Voice 1 exponential-FM depth (-1..+1) from its FM 1 jack — adds inharmonic/clangy modulation.",
      v2_fm: "Voice 2 exponential-FM depth (-1..+1) from its FM 2 jack.",
      v3_fm: "Voice 3 exponential-FM depth (-1..+1) from its FM 3 jack.",
      v4_fm: "Voice 4 exponential-FM depth (-1..+1) from its FM 4 jack.",
      v5_fm: "Voice 5 exponential-FM depth (-1..+1) from its FM 5 jack.",
      v1_pm: "Voice 1 phase-modulation depth (-1..+1) from its FM 1 jack — the DX-style PM flavour of the same modulator.",
      v2_pm: "Voice 2 phase-modulation depth (-1..+1) from its FM 2 jack.",
      v3_pm: "Voice 3 phase-modulation depth (-1..+1) from its FM 3 jack.",
      v4_pm: "Voice 4 phase-modulation depth (-1..+1) from its FM 4 jack.",
      v5_pm: "Voice 5 phase-modulation depth (-1..+1) from its FM 5 jack.",
      v1_pw: "Voice 1 pulse width (0.05–0.95) — shapes the square end of the WAVE morph (50% is a true square).",
      v2_pw: "Voice 2 pulse width (0.05–0.95).",
      v3_pw: "Voice 3 pulse width (0.05–0.95).",
      v4_pw: "Voice 4 pulse width (0.05–0.95).",
      v5_pw: "Voice 5 pulse width (0.05–0.95).",
      v1_wave: "Voice 1 waveform morph (0..1): continuously blends triangle → saw → square; the per-voice scope shows the resulting shape.",
      v2_wave: "Voice 2 waveform morph (triangle → saw → square).",
      v3_wave: "Voice 3 waveform morph (triangle → saw → square).",
      v4_wave: "Voice 4 waveform morph (triangle → saw → square).",
      v5_wave: "Voice 5 waveform morph (triangle → saw → square).",
      v1_level: "Voice 1 mixer level (0..1) into the stereo bus.",
      v2_level: "Voice 2 mixer level (0..1) into the stereo bus.",
      v3_level: "Voice 3 mixer level (0..1) into the stereo bus.",
      v4_level: "Voice 4 mixer level (0..1) into the stereo bus.",
      v5_level: "Voice 5 mixer level (0..1) into the stereo bus.",
      v1_pan: "Voice 1 stereo pan (-1 = left … +1 = right), equal-power, placing the voice in the OUT image.",
      v2_pan: "Voice 2 stereo pan (-1 left … +1 right).",
      v3_pan: "Voice 3 stereo pan (-1 left … +1 right).",
      v4_pan: "Voice 4 stereo pan (-1 left … +1 right).",
      v5_pan: "Voice 5 stereo pan (-1 left … +1 right).",
      // Shared amplitude ADSR (feeds every voice envelope; gated per lane).
      attack: "Shared amplitude-envelope attack time (0.001–5 s, log): how fast each voice fades in when its poly lane's gate opens. One ADSR feeds all five voices.",
      decay: "Shared amplitude-envelope decay time (0.001–5 s, log): the fall from the attack peak down to the sustain level.",
      sustain: "Shared amplitude-envelope sustain level (0..1): the held level while a note's gate stays open.",
      release: "Shared amplitude-envelope release time (0.001–5 s, log): how long each voice takes to fade out after its gate closes.",
      // Embedded multimode filter (on the summed mix).
      cutoff: "Embedded filter cutoff frequency (20 Hz–20 kHz, log) applied to the summed five-voice mix.",
      resonance: "Embedded filter resonance (0–0.99): emphasis at the cutoff, up to near self-oscillation.",
      mode: "Embedded filter MODE dial (0..1): continuously morphs the SVF response low-pass → band-pass → high-pass → notch. The notch end is the true SVF identity (lp + hp = x − k·bp), so it nulls at the cutoff whatever the resonance; below it the level at cutoff rises with RESONANCE as 1/k.",
      wetdry: "Embedded filter wet/dry mix (0 = dry/bypassed … 1 = fully filtered).",
      "pentemelodica-voices-{n}":
        "The five-voice picture in the faceplate's hero slot: one lane per voice, each drawing a single cycle of that voice's own morphed waveform from the same band-limited oscillator the audio uses, with its coarse and fine offset, its mixer level and its pan position beside it. It is a picture of the PATCH, not a trace of the output \u2014 this module makes no sound until a poly source gates it, so a live scope would be a flat line most of the time you are looking at it. Click a lane to read that voice's exact resolved tuning underneath; the selection is yours alone (it is not saved with the rack and no collaborator sees it), and it changes no sound. It is the one place all five voices are visible at once, which matters because the eight-band faceplate shows only one voice strip at a time.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = createWorkletNode(node, ctx, 'pentemelodica', {
      // 6 inputs: poly (10-ch) + fm1..fm5 (mono). 7 outputs: out_l, out_r +
      // voice1..voice5, all mono. channelCountMode defaults to 'max' so the
      // 10-channel poly source passes through input 0 cleanly (same as DX7 /
      // CUBE).
      numberOfInputs: 6,
      numberOfOutputs: 7,
      outputChannelCount: [1, 1, 1, 1, 1, 1, 1],
    } as AudioWorkletNodeOptions);

    // Silence keep-alive: feed a 0-offset ConstantSource into every input bus
    // so the node stays in the active processing graph even when nothing is
    // patched (mirrors moog921-vco / analogVco).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    for (let k = 0; k < 6; k++) silence.connect(workletNode, 0, k);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of pentemelodicaDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['poly', { node: workletNode, input: 0 }],
        ['fm1',  { node: workletNode, input: 1 }],
        ['fm2',  { node: workletNode, input: 2 }],
        ['fm3',  { node: workletNode, input: 3 }],
        ['fm4',  { node: workletNode, input: 4 }],
        ['fm5',  { node: workletNode, input: 5 }],
      ]),
      outputs: new Map([
        ['out_l',  { node: workletNode, output: 0 }],
        ['out_r',  { node: workletNode, output: 1 }],
        ['voice1', { node: workletNode, output: 2 }],
        ['voice2', { node: workletNode, output: 3 }],
        ['voice3', { node: workletNode, output: 4 }],
        ['voice4', { node: workletNode, output: 5 }],
        ['voice5', { node: workletNode, output: 6 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        try { silence.disconnect(); } catch { /* */ }
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};
