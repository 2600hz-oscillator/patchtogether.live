// packages/web/src/lib/audio/modules/vca.ts
//
// VCA — voltage-controlled amplifier (mono).
//
// The standard Eurorack utility module: a single audio input multiplied by
// `base + cvAmount * cv`. With nothing patched into CV and base=0 the VCA
// is silent; with CV held at +1 and cvAmount=1 it passes the audio through
// at unity. Faust-compiled DSP (packages/dsp/src/vca.dsp):
//
//   gain = (base : si.smoo) + (cvAmount : si.smoo) * cv
//
// ⚠ THE DE-ZIP IS ON THE TWO KNOBS, NOT ON THE SUM — changed in #1313
// (`290dcdb5`), and this header said the opposite until this PR. The old
// line smoothed the whole sum, which put a 7 Hz one-pole in front of the
// CONTROL VOLTAGE and made the module deaf to the envelopes it exists to
// follow: a 1 ms and a 5 ms ADSR attack both produced a 49.79 ms rise, so no
// percussive envelope survived the VCA. Smoothed per-slider the knobs still
// step click-free while the `cv` input reaches the multiply at FULL
// BANDWIDTH (1 ms → 1.02 ms, 5 ms → 4.02 ms). Two consequences the surfaces
// now have to state rather than deny: an ADSR's attack is passed intact, and
// an AUDIO-RATE signal patched into `cv` genuinely RING-MODULATES.
//
// The gain total is NOT clamped: sums above 1 boost past unity; sums below 0
// pass the signal phase-inverted. A parallel phase-inverted output
// (`audio_inv`) is a GainNode(-1) tap of the same signal — useful for
// sidechain ducking, cancellation tricks, or mid/side processing without
// needing an extra inverter module. It is a VARIANT of the main output, not
// the other half of a stereo pair (the dual-mono ledger's GROUP D), and
// `markStereoPairs` will not pair the two.
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
    // for side-chain feedback prevention, cancellation, and mid/side
    // processing. Implemented as a parallel GainNode(-1) tap.
    // ⚠ NOT the right-hand half of a stereo pair — dual-mono ledger GROUP D:
    // `audio` and `audio_inv` are VARIANTS of one mono signal, so patching
    // both into a stereo destination gives a phase-opposed dual-mono image
    // rather than width. `markStereoPairs` agrees (the stems do not match
    // `_l`/`_r`) and rear-card-model.test.ts pins that it finds no pair here.
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
  // allowed to disagree; on this module they happen to agree, for two
  // INDEPENDENT reasons (the ranking argument below, and the band reading in
  // the same order as the law printed above it) — so keep them as two fields
  // and do not collapse one into the other.
  //
  // THE TIER LADDER, read back as a sentence. With 2 params and a glyph the
  // caps are mini 1 / compact 2 / full 2 (laneBodyPlan keeps the ROW: 2 md
  // cells + the glyph) / dock 2. So `order` decides exactly ONE thing: which
  // knob sits on the mini tile beside the meter.
  //
  // `base` takes it, and the argument is REACHABILITY FROM THE SPAWN STATE.
  //
  // This ranking was briefly `['cvAmount','base']`, bought with the glyph: the
  // `meter` reports the live OUTPUT LEVEL, which is most of what `base` sets
  // when nothing is patched, so ranking `base` first looked like spending the
  // tile's one cell to restate what the glyph already shows. That argument is
  // SELF-DEFEATING at the only state it has to survive. On a bare spawn the
  // defaults are `base = 0`, `cvAmount = 1`, and nothing is patched, so:
  //
  //   * `cvAmount × cv` = 0 — the cell cannot change the gain at ANY setting;
  //   * `gain = 0` ⇒ the output is silence ⇒ the meter is DARK, so the glyph
  //     it was traded against is not showing anything either.
  //
  // A mini tile whose one control is inert beside a glyph with nothing in it is
  // a tile with no reachable way to make the module pass audio. `base` has the
  // opposite property at every state: it is the one control that always moves
  // the gain, and moving it is also what LIGHTS the meter — which is what makes
  // the glyph's claimed redundancy true rather than aspirational. The glyph
  // earns its rank AFTER the module is audible, and the mini tile is where you
  // get it there. Pinned by the not-inert assertion in vca-gain-model.test.ts,
  // which derives the mini cell from the face rather than naming it, so a
  // future re-rank has to re-argue the property instead of editing a literal.
  //
  // WHAT IS GIVEN UP, stated because it is real: `cvAmount`'s SIGN is this
  // module's mode switch (positive amplifies, negative ducks, and because the
  // gain is unclamped a sum below 0 comes out phase-inverted rather than muted),
  // and a meter cannot show that. It reappears one zoom step later — `compact`
  // shows both knobs — and the mini tile is the tier where "can I hear it at
  // all" outranks "which way does the CV push".
  face: {
    order: ['base', 'cvAmount'],
    // ONE page, and its header is the module: the gain LAW in eight characters,
    // which is also where "why does a negative amount invert the phase" comes
    // from. Membership is in FUNCTION order — the band reads left to right in
    // the same order as the law printed above it, `base` then `cvAmount`.
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
    pages: [
      {
        id: 'gain',
        label: 'gain = base + cv × amount',
        // ANNOTATION (hidden unless the dock's annotate toggle is on), so it
        // may only ELABORATE — every fact the face needs at rest lives on a
        // surface that always paints. The two it elaborates are carried by the
        // readout strip (the unclamped sum, as a live number) and by the
        // sidebar flow (the full-bandwidth cv), which is why this reads as
        // context rather than as the only place either one is stated.
        hint:
          'the sum is NOT clamped: above 1 it boosts past unity, below 0 it passes ' +
          'phase-inverted — and only the two KNOBS are de-zipped, so cv itself reaches the ' +
          'multiply at full bandwidth',
        controls: ['base', 'cvAmount'],
      },
    ],
    glyph: 'meter',

    // ── PF-20 — THE FACEPLATE STRUCTURE ───────────────────────────────────
    //
    // DECLARATION ONLY. No field below adds a param, a port or a control
    // family, so the I/O contract and contract-lock.txt are byte-unchanged.
    //
    // ⚠ `title` AND `hint` ARE ANNOTATION-ONLY. `facePageHeader` returns null
    // before it reads either one unless the dock's annotate toggle is on
    // (dock-faceplate-model.ts, owner ruling 2026-08-03), so NOTHING
    // load-bearing may live here. The three facts this module actually has to
    // teach are placed on surfaces that always paint: the clip risk on the
    // readout strip, the full-bandwidth cv and the OUT INV tap in the sidebar.
    title: 'Amplifier',
    hint:
      'Multiplies the audio input by base + cv × amount — it spawns CLOSED, silent until CV ' +
      'arrives or BASE is raised, and a phase-inverted copy of the output is always live on ' +
      'OUT INV.',

    // THE HERO — READOUTS ONLY. No `cell`, no `control`, no `action`, and each
    // refusal is an argument rather than an omission:
    //
    //   * NO PICTURE. Every candidate graph on this module is a STRAIGHT LINE.
    //     The input→output transfer of a pure multiplier is a line through the
    //     origin of slope `gain`, for every setting, because the module is
    //     linear in its input by construction; the cv→gain curve is also a line
    //     (slope `cvAmount`, intercept `base`). A picture whose only two degrees
    //     of freedom are the two dials directly beneath it is the derived-
    //     readout trap wearing a graphic. It would also COST the live meter —
    //     `heroGlyph = hasGlyph && !(view === 'dock-full' && hero?.cell)`, so a
    //     hero cell suppresses the dock glyph, and trading a live RMS trace of
    //     the actual output on a module whose entire job is "how loud right
    //     now" for a static line-graph of two knob values is a downgrade. A
    //     readouts-only hero keeps the meter. (The graph earns its place the day
    //     a lin/exp RESPONSE param exists — that is a DSP change and belongs to
    //     its own owner-audition PR, never to a face wave.)
    //   * NO `control`. `heroFacePlan` MOVES a promoted key, it never copies, so
    //     promoting `base` would leave a one-knob band and break the reason the
    //     page keeps FUNCTION order: the band reads left-to-right in the same
    //     order as the law printed above it.
    //   * NO `action`. A VCA makes no sound of its own; auditioning it would
    //     mean synthesising a test tone inside the module whose whole job is
    //     transparency.
    hero: {
      // ONE entry, and the padding was REFUSED twice rather than not considered:
      //
      //   * a `CV 0` entry is `base` printed a second time — `base` IS the gain
      //     at cv 0, and correction 1 put the strip in its own full-width row
      //     where a duplicate reads as an independent second measurement that
      //     happens to agree;
      //   * a `PHASE: NORMAL / INVERTS` entry is fully redundant. `base` is
      //     never negative, so the sweep crosses zero IFF `base + cvAmount < 0`
      //     — i.e. exactly when the entry below prints ` INV`.
      //
      // A third candidate died with the DSP fix and is named so it is not
      // re-derived: `{ text: '-3 dB at 7 Hz' }` for the CV's tracking bandwidth.
      // That was true only while `si.smoo` sat on the SUM. #1313 moved it onto
      // the two sliders, so the cv path is full-bandwidth and the number is now
      // FALSE — and a fixed `text` never moves under the hand anyway, which is
      // the strip's whole job. It belongs in the sidebar as reference, and that
      // is where the corrected version of the fact now lives.
      readouts: [{ label: 'at cv 1', valueId: 'vca-gain-at-full-cv' }],
    },

    // NO SIDEBAR. The only block this face ever declared was the signal-flow
    // diagram, and the whole kind is gone (see the union in graph/types.ts), so
    // `sidebarPlan` returns null and DockFullView keeps the full-width editor.
    // The two facts the chain carried have real homes: `cv` is read at full
    // bandwidth → the rear card's `~` tick (pinned against vca.dsp below), and
    // OUT INV → the rear card's output rail, which is where that jack lives.

    // REAR CARD curation: neither input is a per-param CV (the worklet owns
    // the gain law), so derivation would fold both into one 'signal' band —
    // the spec's vca table reads better as signal → gain stage.
    //
    // ⚠ AUDIT REVERSED. The P1 batch-2 rear sweep left `cv` UN-ticked and
    // wrote down why: "the Faust gain sum runs through si.smoo BEFORE the
    // multiply, so CV tracks at envelope/LFO rate, not audio rate (patching
    // audio in is filtered, not ring-modulated)". #1313 moved the de-zip onto
    // the two sliders, so that premise is dead and the conclusion inverted
    // with it — `cv` is now read at FULL BANDWIDTH and an audio-rate signal
    // patched there ring-modulates. `filter.ts` states the doctrine in its
    // mirror form ("both CV values run through si.smoo … a `~` tick would be a
    // lie about the one thing the tick exists to say"); by that same rule vca
    // is now the case that must BE ticked. Pinned in vca-gain-model.test.ts
    // against the .dsp source, so the tick cannot outlive the DSP line again.
    //
    // `audio` stays UN-ticked: the tick marks the SURPRISING case — a CV hole
    // the DSP reads per sample — and saying "audio-rate" about an AUDIO input
    // is noise on every hole (the precedent mixer.ts cites in the other
    // direction).
    rear: {
      audioRate: ['cv'],
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
      "A voltage-controlled amplifier — the elementary 'how loud right now' utility. It multiplies the audio input by a gain of base + cv × cvAmount: patch an envelope or LFO into cv and shape the response with the two knobs. The two KNOBS are smoothed by a one-pole filter (Faust si.smoo) so turning them is click-free, but the cv input itself is left alone and reaches the multiply at full bandwidth — an ADSR's attack is passed intact however short it is, and an audio-rate signal patched into cv ring-modulates rather than being filtered away. The gain total is not clamped: sums above 1 boost past unity, and sums below 0 pass the signal phase-inverted. A sign-flipped copy of the output is always available on the audio_inv port for sidechain tricks, cancellation, or mid/side processing without a separate inverter module — it is a phase variant of the same mono output, not the other half of a stereo pair.",
    inputs: {
      audio:
        "The signal to be amplified or gated — an oscillator voice, sampler, or any audio source. It is multiplied sample-by-sample by the resolved gain (base + cv × cvAmount).",
      cv: "Control voltage for the gain: scaled by cvAmount and added to base. Typical sources are an ADSR for note shaping, an LFO for tremolo, or a sequencer CV lane for per-step level. This input is read at FULL BANDWIDTH — only the two knobs are de-zipped — so a short attack arrives with its shape intact (a 1 ms ADSR attack opens the VCA in 1 ms), and an audio-rate signal patched here ring-modulates the input rather than being filtered away. A hard gate edge is passed as a hard edge, so a square gate straight into cv can click.",
    },
    outputs: {
      audio:
        "The amplified signal: audio × (base + cv × cvAmount), with the two knob values de-zipped and the cv term passed at full bandwidth. Silent when base is 0 and nothing drives cv; unity passthrough at base 1 with no CV. The gain is unclamped — sums above 1 amplify beyond unity, and sums below 0 emerge phase-inverted.",
      audio_inv:
        "A sample-accurate phase-inverted (×−1) copy of the audio output, implemented as a parallel inverting gain tap. Always live — patch it for mid/side processing, or cancellation/sidechain tricks, without adding an inverter module. It is a VARIANT of the audio output rather than its stereo partner: both jacks carry the same mono signal, one sign-flipped, so patching the pair into a stereo destination gives a phase-opposed dual-mono image, not a widened one.",
    },
    controls: {
      base: "The static gain floor (linear 0 to 1, default 0), added to the scaled CV. At 0 the VCA is fully closed — silent until CV opens it; at 1 it passes unity with no CV. Raise it to leave some dry signal under modulation, or use it alone as a plain volume knob. The knob reads CLOSED at 0 and UNITY at 1, and prints the floor's gain in dB in between (that dB is the gain with NO CV present; once CV arrives the resolved gain is base + cv × amount).",
      cvAmount:
        "Depth and sign of the cv input (linear −1 to +1, default +1). At +1 the full CV adds to base; smaller values shallow the modulation. Negative values subtract the CV from base — with base raised, rising CV ducks the output (sidechain-style); and because the gain is unclamped, a sum below 0 passes the signal phase-inverted rather than muting. The knob reads the SENSE of that modulation — OPEN while positive, DUCK while negative, CV OFF at the centre detent where the cv input stops reaching the gain at all — and shows the numeric depth on hover.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'vca', wasmUrl, metaUrl, workletUrl }, node);
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
