// packages/web/src/lib/audio/modules/vca.ts
//
// VCA — voltage-controlled amplifier (mono).
//
// The standard Eurorack utility module: a single audio input multiplied by
// `base + cvAmount * cv`. With nothing patched into CV and base=0 the VCA
// is silent; with CV held at +1 and cvAmount=1 it passes the audio through
// at unity. Faust-compiled DSP (packages/dsp/src/vca.dsp): the summed gain
// runs through `si.smoo` (one-pole smoothing) before the multiply, so knob
// moves and stepped CV are de-clicked — the CV path responds at envelope/
// LFO rate, not audio rate. The gain total is NOT clamped: sums above 1
// boost past unity; sums below 0 pass the signal phase-inverted. A parallel
// phase-inverted output (`audio_inv`) is a GainNode(-1) tap of the same
// signal — useful for stereo widening, sidechain ducking, or mid/side
// processing without needing an extra inverter module.
//
// Inputs:
//   audio (audio): signal to be amplified / gated.
//   cv (cv): control voltage; combined with the base knob and scaled by cvAmount.
//
// Outputs:
//   audio (audio): the amplified output (audio * (base + cv * cvAmount)).
//   audio_inv (audio): sign-inverted copy of the output (phase-flipped).
//
// Params (RANGES live in $lib/audio/vca-gain-model — one place, imported here
// and by the card, so the two surfaces cannot drift):
//   base (linear 0..1, default 0): static gain floor added to the scaled CV
//     (silent-when-unpatched at 0; unity gain at 1). Reads CLOSED / dB / UNITY.
//   cvAmount (linear -1..1, default 1): depth + sign of the CV input; negative
//     subtracts the CV from base (ducking / inverted modulation). Reads
//     OPEN / CV OFF / DUCK — the sense, which the number does not carry.

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import {
  VCA_BASE,
  VCA_CV_AMOUNT,
  VCA_CV_AMOUNT_LANDMARKS,
  formatVcaBase,
  formatVcaCvAmount,
} from '$lib/audio/vca-gain-model';
import wasmUrl from '@patchtogether.live/dsp/dist/vca.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/vca.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/vca.worklet.js?url';

const PARAM_PREFIX = '/VCA';

export const vcaDef: AudioModuleDef = {
  type: 'vca',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'vca',
  category: 'utilities',
  inputs: [
    { id: 'audio', type: 'audio' },
    { id: 'cv', type: 'cv' },
  ],
  outputs: [
    // PF-4 jack labels, authored HERE so every surface that draws them (the
    // rear rail, the front PatchPanel, the lane drill-down) reads the same
    // string. Two reasons they are worth authoring on this module:
    //   * derivation gave the OUTPUT `AUDIO` — the same word the INPUT hole
    //     already carries, so the rear card printed `AUDIO` on both rails;
    //   * `AUDIO` / `AUDIO INV` read as two unrelated ports. `OUT` / `OUT INV`
    //     shares a stem, which is the actual relationship: one signal and its
    //     sign flip. (`markStereoPairs` will not pair them — the stems do not
    //     match `_l`/`_r`.)
    // The plan's `OUT ⌀ (phase flip)` was deliberately NOT taken: the label is
    // uppercased and drawn at 9–10 px, so a glyph outside the pinned VRT font
    // subset is a text-metric risk on a scene whose baseline this PR re-pins.
    { id: 'audio',     type: 'audio', label: 'out' },
    // Sign-inverted (phase-flipped) audio. Standard "phase invert" semantic
    // for stereo widening, side-chain feedback prevention, mid/side
    // processing. Implemented as a parallel GainNode(-1) tap.
    { id: 'audio_inv', type: 'audio', label: 'out inv' },
  ],
  // RANGES COME FROM ONE PLACE ($lib/audio/vca-gain-model). The card imports
  // the same consts, so a card can no longer disagree with this def about what
  // a knob's travel means — the failure class every def-reading gate is blind
  // to (CLAUDE.md, the BACKDRAFT ±1-vs-±0.2 XyPads).
  //
  // `format` / `landmarks` are UI VOCABULARY and contract-transparent
  // (contract-signature reads only id/min/max/curve/defaultValue/units), so
  // this whole block is a 0-line move in contract-lock.txt.
  params: [
    {
      id: 'base',
      label: 'Base',
      defaultValue: VCA_BASE.default,
      min: VCA_BASE.min,
      max: VCA_BASE.max,
      curve: 'linear',
      // Earns a persistent readout because `0.00` does not say the thing a
      // patcher needs at spawn: the VCA is CLOSED and will stay silent until
      // CV arrives. In between the two named ends it prints dB, because a
      // linear gain number is the one thing that does not say how loud it is.
      format: formatVcaBase,
    },
    {
      id: 'cvAmount',
      label: 'CV amt',
      defaultValue: VCA_CV_AMOUNT.default,
      min: VCA_CV_AMOUNT.min,
      max: VCA_CV_AMOUNT.max,
      curve: 'linear',
      // An ATTENUVERTER: the SIGN decides whether the module is an amplifier or
      // a ducker, and sign is a boundary — NOT a nearest-waypoint question. So
      // the readout comes from `format` (which outranks `landmarks` in
      // knobReadout) and the landmark roster is reduced to the one detent worth
      // marking, the null point. See vca-gain-model's header for the −0.4 case
      // a landmark-sourced readout gets wrong.
      landmarks: VCA_CV_AMOUNT_LANDMARKS,
      format: formatVcaCvAmount,
    },
  ],

  // RACKLINE curation (gallery mock: fullcard-mocks/vca.html; batch B of the
  // face program, .myrobots/plans/dx7-and-faces-design-program-2026-07-27.md
  // §4). `order` is a PRIORITY ranking for the tiers that show a SUBSET;
  // `pages` is FUNCTION order for the tier that shows everything. They are
  // allowed to disagree, and here they do — do not "fix" one to match the
  // other.
  //
  // THE TIER LADDER, read back as a sentence. With 2 params and a glyph the
  // caps are mini 1 / compact 2 / full 2 (laneBodyPlan keeps the ROW: 2 md
  // cells + the glyph) / dock 2. So `order` decides exactly ONE thing: which
  // knob sits on the mini tile beside the meter.
  //
  // `cvAmount` takes it, and the GLYPH is the argument. The `meter` glyph
  // already reports the live OUTPUT LEVEL — which is most of what `base` sets
  // when nothing is patched — so ranking `base` first would spend the tile's
  // one cell restating what the glyph is already showing. `cvAmount` is the
  // one thing a meter cannot show: the SENSE of the modulation. Its sign is
  // this module's mode switch (positive amplifies, negative ducks, and because
  // the gain is unclamped a sum below 0 comes out phase-inverted rather than
  // muted). The correct use of a glyph is to BUY a rank.
  //
  // THE COUNTER-ARGUMENT, stated because it is real: with nothing patched into
  // `cv` the whole `cvAmount * cv` term is zero, so on a bare spawn the mini
  // tile's one knob does nothing — the inertness-at-spawn check the program's
  // §7 step 3 demands of every hero candidate. Priced and taken: a VCA with an
  // empty CV jack is not a VCA, it is a volume knob, and the readout makes the
  // inertness legible (the dial says CV OFF / OPEN / DUCK, so it announces that
  // it is about the CV path). IF YOU DISAGREE: swap the two entries in `order`
  // and nothing else in this file moves.
  face: {
    order: ['cvAmount', 'base'],
    // ONE page, and its header is the module: the gain LAW in eight characters,
    // which is also where "why does a negative amount invert the phase" comes
    // from. Membership is in FUNCTION order — the band reads left to right in
    // the same order as the law printed above it — while `order` leads with
    // cvAmount. That disagreement is the point of having both.
    //
    // ⚠ The page id `gain` COLLIDES with the curated rear group id `gain`
    // below, and the collision is LOAD-BEARING: rear-card-model's page loop
    // lets a curated group claim the page's slot and its label wins, which is
    // why the rear band reads `gain cv` and not this header. Renaming either
    // one alone desyncs the band. It is NOT the dx7 double-render bug — that
    // fires only when the colliding id is `voice`/`signal`, because the
    // voice-slot claim runs BEFORE the page loop and both push a band
    // (rear-card-model.ts:262-284). Verified by the totality gate: 4 holes for
    // 4 declared ports.
    pages: [{ id: 'gain', label: 'gain = base + cv × amount', controls: ['base', 'cvAmount'] }],
    glyph: 'meter',
    // REAR CARD curation: neither input is a per-param CV (the worklet owns
    // the gain law), so derivation would fold both into one 'signal' band —
    // the spec's vca table reads better as signal → gain stage.
    //
    // AUDIT (P1 batch-2 rear sweep): re-checked against the DSP and left as
    // authored. No `~` tick is correct here — the Faust gain sum runs through
    // si.smoo BEFORE the multiply, so CV tracks at envelope/LFO rate, not
    // audio rate (patching audio in is filtered, not ring-modulated); and the
    // `audio` hole is the signal itself, where a rate tick would be noise.
    rear: {
      groups: [
        { id: 'signal', label: 'signal', ports: ['audio'] },
        // `gain stage` → `gain cv`: the band holds the CV hole, and its job is
        // to say what patching there DOES rather than to re-name the module.
        // This id claims the `gain` page's rear slot (see the page comment).
        { id: 'gain', label: 'gain cv', ports: ['cv'] },
      ],
    },
  },

  docs: {
    explanation:
      "A voltage-controlled amplifier — the elementary 'how loud right now' utility. It multiplies the audio input by a gain of base + cv × cvAmount: patch an envelope or LFO into cv and shape the response with the two knobs. The summed gain is smoothed by a one-pole filter (Faust si.smoo) before the multiply, so knob moves and stepped CV open the VCA click-free — which also means the cv path tracks at envelope/LFO rate, not audio rate (a clean utility VCA, not a ring modulator). The gain total is not clamped: sums above 1 boost past unity, and sums below 0 pass the signal phase-inverted. A sign-flipped copy of the output is always available on the audio_inv port for stereo widening, sidechain tricks, or mid/side processing without a separate inverter module.",
    inputs: {
      audio:
        "The signal to be amplified or gated — an oscillator voice, sampler, or any audio source. It is multiplied sample-by-sample by the smoothed gain (base + cv × cvAmount).",
      cv: "Control voltage for the gain: scaled by cvAmount, added to base, then smoothed. Typical sources are an ADSR for note shaping, an LFO for tremolo, or a sequencer CV lane for per-step level. The smoothing de-zips abrupt gate-shaped CV so it opens the VCA click-free; audio-rate signals patched here are largely filtered out rather than ring-modulated.",
    },
    outputs: {
      audio:
        "The amplified signal: audio × (base + cv × cvAmount), with the summed gain smoothed. Silent when base is 0 and nothing drives cv; unity passthrough at base 1 with no CV. The gain is unclamped — sums above 1 amplify beyond unity, and sums below 0 emerge phase-inverted.",
      audio_inv:
        "A sample-accurate phase-inverted (×−1) copy of the audio output, implemented as a parallel inverting gain tap. Always live — patch it for stereo width, mid/side processing, or cancellation/sidechain tricks without adding an inverter module.",
    },
    controls: {
      base: "The static gain floor (linear 0 to 1, default 0), added to the scaled CV. At 0 the VCA is fully closed — silent until CV opens it; at 1 it passes unity with no CV. Raise it to leave some dry signal under modulation, or use it alone as a plain volume knob. The knob reads CLOSED at 0 and UNITY at 1, and prints the floor's gain in dB in between (that dB is the gain with NO CV present; once CV arrives the resolved gain is base + cv × amount).",
      cvAmount:
        "Depth and sign of the cv input (linear −1 to +1, default +1). At +1 the full CV adds to base; smaller values shallow the modulation. Negative values subtract the CV from base — with base raised, rising CV ducks the output (sidechain-style); and because the gain is unclamped, a sum below 0 passes the signal phase-inverted rather than muting. The knob reads the SENSE of that modulation — OPEN while positive, DUCK while negative, CV OFF at the centre detent where the cv input stops reaching the gain at all — and shows the numeric depth on hover.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'vca', wasmUrl, metaUrl, workletUrl });
    const merger = ctx.createChannelMerger(2);
    merger.connect(f);
    // Keep the merger in the active graph (see analog-vco for why).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(merger, 0, 0);
    silence.connect(merger, 0, 1);
    const params = f.parameters as unknown as Map<string, AudioParam>;
    for (const def of vcaDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }

    // ----- audio_inv: -audio -----
    // Parallel tap of the VCA's main output through a GainNode(-1). The
    // inverted output is sample-accurate sign-flipped relative to `audio`.
    const inverter = ctx.createGain();
    inverter.gain.value = -1;
    f.connect(inverter);

    return {
      domain: 'audio',
      inputs: new Map([
        ['audio', { node: merger, input: 0 }],
        ['cv',    { node: merger, input: 1 }],
      ]),
      outputs: new Map([
        ['audio',     { node: f,        output: 0 }],
        ['audio_inv', { node: inverter, output: 0 }],
      ]),
      setParam(paramId, value) {
        params.get(`${PARAM_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(`${PARAM_PREFIX}/${paramId}`)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        silence.disconnect();
        merger.disconnect();
        inverter.disconnect();
        f.disconnect();
      },
    };
  },
};
