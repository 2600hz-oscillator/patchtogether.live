// packages/web/src/lib/audio/modules/resofilter.ts
//
// RESOFILTER — multi-mode filter port of Resonarium's MultiFilter
// (gabrielsoule/resonarium, plugin/Source/dsp/MultiFilter.{h,cpp}). Five
// modes drawn straight from upstream's MultiFilter::Type enum +
// filterTextFunction (plugin/Source/Parameters.cpp lines 7-21):
//
//     index   short   long           role
//     ─────   ─────   ────           ─────────────────────────────────────
//       0     LP      Low-pass       attenuates above cutoff
//       1     HP      High-pass      attenuates below cutoff
//       2     BP      Band-pass      peaks at cutoff
//       3     NT      Notch          dips at cutoff
//       4     AP      Allpass        flat magnitude, phase-rotating
//
// Upstream's `none` mode is dropped — we have a Mix knob, so users dial mix
// to 0 for a bypass. The 1-level enum (no Type-vs-Character split) was
// chosen over a 2-level `mode + submode` because Resonarium ships exactly
// these 5 characters in one enum (no separate ladder / SVF / comb axis on
// the MultiFilter); flattening keeps the card's mode-name label legible in
// one line and the spec encourages whichever reads better. The card shows
// the long-form name (e.g. "Low-pass") next to the MODE knob.
//
// DSP topology lives in packages/dsp/src/lib/resofilter-dsp.ts (Cytomic /
// Zavalishin TPT SVF; all 5 modes share one state, so the dial is a pure
// output picker — switching modes mid-render is pop-free).
//
// Per-mode topology summary (see lib/resofilter-dsp.ts header for details):
//   • LP:    SVF lp tap
//   • HP:    SVF hp tap
//   • BP:    SVF bp tap
//   • Notch: lp + hp                (= input − k·bp)
//   • Allpass: lp + hp − k·bp       (standard TPT allpass form)
//
// Drive: upstream's MultiFilter does NOT have a drive stage (the optional
// saturation in Resonarium lives in WrappedSVF / Distortion, not here), so
// the brief's "If not, omit" applies — Drive is NOT exposed on this port.
//
// Inputs (3): audio (audio), cutoff_cv (cv→cutoff), reso_cv (cv→resonance).
// Outputs (2): out_l, out_r (stereo pair). The underlying SVF is mono per
// channel, with independent state on L vs R so a stereo input keeps its
// separation through the filter.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/resofilter.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
// ⚠ THE MODE NAMES ARE NOW IMPORTED, NOT RE-TYPED. They used to be a
// hand-maintained SECOND COPY here, with a comment saying so and a test
// asserting only that the COUNT matched — which is exactly the shape that lets
// two rosters drift while every gate stays green.
//
// The stated reason for the copy was that the DSP lib "references the
// `sampleRate` global through its descendants". It does not: every function in
// `resofilter-dsp.ts` takes `sr` as an argument and the module body declares
// nothing but consts, functions and classes. The worklet ENTRY
// (`packages/dsp/src/resofilter.ts`) is the file that reads the global, and it
// is not imported here.
//
// Relative path rather than the `@patchtogether.live/dsp/src/...` alias, for
// the reason warrensspectrum.ts and sample-hold.ts already state: worktrees may
// not symlink the workspace package under node_modules, and the TS path-alias
// rules don't reliably resolve TS source out of it. The web test file
// `resofilter-dsp.test.ts` has imported this exact path since the module
// shipped.
import {
  RESOFILTER_MODE_NAMES,
  RESOFILTER_MODE_SHORT,
  RESOFILTER_MODE_COUNT,
  RESOFILTER_MAX_MODE,
  type ResofilterMode,
} from '../../../../../dsp/src/lib/resofilter-dsp';
// ⚠ AND THE FOUR PARAM DECLARATIONS LIVE OUTSIDE THIS FILE, which is a
// `ringback-crush-model`-shaped move with one extra reason: an e2e spec cannot
// import a module DEF at all (the `?url` line above is a Vite import with no
// meaning to Playwright's Node loader, and it fails the whole spec file before
// collection), so the numbers have to sit somewhere def-free for
// `resofilter-face.spec.ts` to compute its expectations from the same source
// the panel prints. See $lib/audio/resofilter-params.
import { RESOFILTER_MODE_OPTIONS, RESOFILTER_PARAMS } from '$lib/audio/resofilter-params';

const PROCESSOR_NAME = 'resofilter';
const loadedContexts = new WeakSet<BaseAudioContext>();

export {
  RESOFILTER_MODE_NAMES,
  RESOFILTER_MODE_SHORT,
  RESOFILTER_MODE_COUNT,
  RESOFILTER_MAX_MODE,
  RESOFILTER_MODE_OPTIONS,
  type ResofilterMode,
};

export const resofilterDef: AudioModuleDef = {
  type: 'resofilter',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'resofilter',
  category: 'processors',
  stereoPairs: [['out_l', 'out_r']],
  ossAttribution: { author: 'Gabriel Soule (Resonarium, MultiFilter)' },

  inputs: [
    // Stereo-aware audio input. Web Audio sums channels per input port; the
    // worklet branches on inputs[0][0] / inputs[0][1] so a stereo source
    // keeps its L/R separation. A mono source duplicates onto both filter
    // channels.
    { id: 'audio',     type: 'audio' },
    // Per-param CV via cvScale linear (matches the spec). The factory wires
    // these into the cutoff / resonance AudioParams.
    { id: 'cutoff_cv', type: 'cv', paramTarget: 'cutoff',    cvScale: { mode: 'linear' } },
    { id: 'reso_cv',   type: 'cv', paramTarget: 'resonance', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
  ],
  // The four declarations, in ONE def-free module the card and the face model
  // also import (see the note on the import above). `options` on MODE is what
  // makes the faceplate paint a five-button Segmented row instead of a rotary
  // reading `0.00`…`4.00` — the same defect, and the same fix, as filter's
  // MODE, on the one control that decides what RESONANCE means.
  params: RESOFILTER_PARAMS,

  docs: {
    explanation:
      "A clean multi-mode resonant filter (ported from Resonarium's MultiFilter) built on a zero-delay-feedback state-variable topology, so all of its modes share one filter state and switching between them mid-sound is pop-free. One MODE knob picks the response — Low-pass (attenuate above cutoff), High-pass (attenuate below), Band-pass (peak at cutoff), Notch (dip at cutoff), or Allpass (flat magnitude, phase-rotating) — and the card prints the long-form name of the current mode next to the knob. The input is stereo-aware (independent L/R filter state preserves the image), CUTOFF and RESONANCE are CV-modulatable, and a MIX knob crossfades dry to wet (turn it to 0 for bypass). A general-purpose tone-shaper for both subtractive synth voices and full mixes.",
    inputs: {
      audio: "The signal to filter (mono or stereo). A stereo source keeps its left/right separation through independent per-channel filter state; a mono source feeds both channels.",
      cutoff_cv: "CV control of the CUTOFF frequency — patch an envelope or LFO here for filter sweeps. It adds to the knob position IN HERTZ, not in octaves: a full-scale CV moves the corner by ±9990 Hz and the result is clamped to 20 Hz..20 kHz, so the reachable window is strongly asymmetric and changes with where the knob sits. From 1 kHz it reaches 20 Hz..10.99 kHz (5.64 octaves down, 3.46 up); from 100 Hz it reaches 20 Hz..10.09 kHz (2.32 down, 6.66 up); and with the knob at its 20 Hz minimum the CV cannot travel downward at all. The faceplate prints this window as CV REACH. (Most log-tapered params in the rack — including the qbrt and moog904c cutoffs — scale their CV logarithmically instead, which is symmetric at ±4.98 octaves everywhere.)",
      reso_cv: "CV control of the RESONANCE — modulate the emphasis at the cutoff for talking/wah-style motion (adds to the knob position). What that emphasis IS depends on MODE: see the RESONANCE control note. Above resonance 0.9985 the underlying damping is clamped, so CV pushed into the top 0.15 % of the scale changes nothing.",
    },
    outputs: {
      out_l: "Left filtered output (with the dry/wet MIX applied).",
      out_r: "Right filtered output. With a mono input it carries the same filtered signal as OUT L.",
    },
    controls: {
      cutoff: "The corner frequency the filter pivots around (20 Hz to 20 kHz, log, default 1 kHz) — what 'above'/'below'/'at cutoff' refers to for the selected mode. Two settings are worth knowing because they read as a broken module rather than a setting: a HIGH-PASS at the 20 Hz bottom of this dial is a bypass (measured at the dry level to two decimals), and so is a NOTCH there, because there is nothing below 20 Hz to remove. The CUTOFF CV input adds to this — see its own note, it is additive in Hertz rather than in octaves.",
      resonance: "One dial that sets one number — the SVF damping k = 2 − 2·resonance — and four different audible things depending on MODE. In LOW-PASS and HIGH-PASS it is the gain at the cutoff frequency and nothing else: exactly 1/k, measured −6.0 dB at resonance 0, 0.0 dB at 0.5, +14.0 dB at 0.9 and +34.0 dB at 0.99, identical in both modes and at every cutoff. In BAND-PASS it is that same peak AND the band's width. In NOTCH it is the WIDTH ONLY — the notch is a true zero at the cutoff at every resonance, and the dial takes it from 2.53 octaves wide down to 0.004, which a broadband level meter cannot see at all (0.55 dB across the whole travel). In ALLPASS it changes the output level by exactly nothing — the magnitude is unity at every frequency and every resonance — and is a pure phase rotation, controlling how abruptly the 360° sweep happens across the same octave span. Two hazards: the damping is CLAMPED at k = 0.003, so everything from resonance 0.9985 to 1.0 is the identical filter (the top 0.15 % of the dial is a plateau), and at that plateau the gain at cutoff is +50.46 dB with nothing here limiting it — a −6 dBFS sine leaves at +44.5 dBFS.",
      mode: "Picks the filter response among Low-pass, High-pass, Band-pass, Notch, and Allpass. All five are taps off ONE shared state-variable filter, so MODE is a pure output picker and changing it while audio plays is pop-free by construction — there is no state to reset and nothing to crossfade. It also decides what RESONANCE means; see that control's note. MODE rounds to the nearest state at exactly 0.5, so a CV or automation lane sitting on 0.5 selects High-pass, not Low-pass.",
      mix: "Dry/wet balance (0 to 1, default fully wet): 1 is the pure filtered signal, 0 is full bypass, and in between blends the two. At 0 the output is BIT-EXACTLY the input in all five modes (measured max|out − in| = 0.000e+0), so it is a true bypass rather than a very quiet filter. In between, dry and wet are summed as SIGNALS and not as levels — they have different phase, so the result is not a fade between the two curves: a low-pass at resonance 0.9 measures +14.0 dB at cutoff fully wet and +8.1 dB at MIX 0.5, where blending the two magnitudes would predict +9.5. Mixing dry into the ALLPASS is where that matters most, and it is how you get a phaser: the allpass has unity magnitude everywhere, so blending magnitudes would predict no change at all, while the rotating phase actually cancels against the dry path and turns a flat response into a deep notch at the cutoff.",
    },
  },

  // ── THE FACEPLATE ────────────────────────────────────────────────────────
  //
  // Four controls, one band, and one picture beside them. The whole argument
  // for this face is a single sentence that no surface on the module said
  // before it: RESONANCE is one dial that means three different KINDS of thing
  // depending on MODE, and in one mode it changes the output level by exactly
  // zero. Everything below is that sentence, expressed as numbers rather than
  // as a sentence — the arithmetic lives in `$lib/ui/modules/
  // resofilter-face-model`, which imports the shipping `resToK` rather than
  // mirroring it, and is negative-controlled in both directions on every run.
  face: {
    // Four params, so `faceTierCap('full')` (6) is never reached and the FULL
    // and DOCK tiers show the identical set. The ranking therefore only decides
    // MINI (1) and COMPACT (2 with a glyph), and what belongs in a 192 px tile
    // is what a hand moves: the sweep, then the emphasis. MODE is the most
    // CONSEQUENTIAL control and is ranked third anyway, deliberately — it is
    // set once and then read, and at the small tiers its job is to be legible
    // (which `options` fixes) rather than to be reachable.
    order: ['cutoff', 'resonance', 'mode', 'mix'],

    // NO `pages`: four controls is one idea, and a page costs an ~81 px band
    // for a header that would say "filter" over a filter.
    //
    // NO `paramCells`. The batch-4 spec proposed `{ mode: 'grid' }` — the chip
    // plus portaled diagram-grid popover — on the reasoning that five filter
    // responses are PICTURES. Checked against what the shell actually renders
    // and dropped: `ModuleShell` only passes ParamGrid a per-cell snippet for
    // the `algorithm` binding (dx7's 32 topologies), so a grid here would paint
    // five TEXT cells in a popover — strictly worse than five inline chips one
    // click away, on a roster small enough for a Segmented row.
    //
    // NO `momentary`, NO `rear`: nothing to press, and the derived rear card
    // already puts AUDIO in the signal band with the two CV holes under it.

    // A live trace of the module's own output. `glyphBinding` resolves this to
    // `live-audio` off `out_l` — the module HAS a primary audio output, so the
    // glyph is a real analyser tap and not the canned fallback trace a
    // `static` binding would draw. It is a flat line on a silent rack, which is
    // correct and deterministic for an insert with nothing patched (§3: peak
    // 0.000e+0 unpatched, all five modes) — and the picture that IS alive at
    // rest is the sidebar's, which is derived from the params.
    glyph: 'scope',

    // NO `title` and NO `hint`. Both paint only in annotation mode, and the
    // owner's 2026-08-11 ruling is that annotation should come from the
    // module's AUTHORED DOCS rather than from a second body of face prose —
    // so every explanatory sentence this face could have carried is in `docs`
    // above, where right-click → annotate already reads it. Nothing on this
    // panel is a sentence: the band header is a plain label, and every readout
    // is a value and a unit.

    hero: {
      control: 'cutoff',
      // NO `cell`. A panel's first legal rank is 7 (module-face-lint refuses a
      // PANEL selected at a lane tier and `faceTierCap('full')` is 6) and this
      // face has FOUR keys, so rank 7 is unreachable — the drummergirl wall.
      // The picture goes in the SIDEBAR, which carries no `face.order` key and
      // therefore no rank at all: the meowbox/noise answer.
      readouts: [
        // The two halves of what RESONANCE does, and they are each other's
        // negative control: `peak` is live in LP/HP/BP, `width` in BP/NT/AP, so
        // every mode has exactly one of them except BAND-PASS, which has both.
        // A `paramId: 'resonance'` readout prints `0.30` in all five.
        { label: 'peak', valueId: 'resofilter-peak-db' },
        { label: 'width', valueId: 'resofilter-band-width' },
        // Invariant to everything the other two move with, and moving with the
        // one thing they are both blind to.
        { label: 'cv reach', valueId: 'resofilter-cv-reach' },
      ],
    },

    // TWO BLOCKS. NO `signal-flow` — owner ruling 2026-08-11, and it would
    // have been a poor one here anyway: this module is a single SVF whose five
    // modes are taps off one shared state, so the chain is one box.
    sidebar: [
      {
        // The picture, beside the controls rather than above them. It is the
        // only surface that can show the ALLPASS doing anything: its magnitude
        // is unity at every frequency and every resonance (measured span 0.00
        // dB over the whole dial), so the panel draws PHASE there instead.
        kind: 'custom',
        label: 'response',
        panelId: 'svf-response',
        props: {
          cutoffParam: 'cutoff',
          resParam: 'resonance',
          modeParam: 'mode',
          mixParam: 'mix',
        },
      },
      {
        // FOUR STATES, ONE CLICK EACH — the filter `starting points` shape, and
        // here it does a second job the picture cannot: it makes the face's
        // whole argument reachable without turning anything. Each entry lands
        // on a different MODE, and the `note` beside it is the quantity that is
        // LIVE in that mode, so the four notes read
        //
        //     −2.9 dB · +20.0 dB · 1.13 oct · 0.288 oct
        //
        // — dB, dB, octaves, octaves, off ONE dial. That is "RESO means
        // different things" stated as four values and no sentence.
        //
        // ⚠ THE NOTES ARE PINNED, not typed and forgotten. `resofilter-face-
        // model.test.ts` recomputes each one from the preset's OWN `values`
        // through the same model the hero prints, so a law change reddens the
        // note instead of leaving a stale number beside a live button. (This is
        // the noise scar: a hero readout and a sidebar entry printed two
        // different true values of one quantity and nothing could see it.)
        kind: 'presets',
        label: 'starting points',
        entries: [
          { id: 'gentle-lp', label: 'gentle lp', note: '−2.9 dB',
            values: { mode: 0, cutoff: 1000, resonance: 0.3, mix: 1 } },
          { id: 'squelch', label: 'squelch', note: '+20.0 dB',
            values: { mode: 0, cutoff: 600, resonance: 0.95, mix: 1 } },
          { id: 'notch-out', label: 'notch out', note: '1.13 oct',
            values: { mode: 3, cutoff: 1000, resonance: 0.6, mix: 1 } },
          // The one state that is not reachable by picking a mode alone: an
          // allpass only becomes audible when some dry is mixed back against
          // it, because its magnitude is unity at every frequency on its own.
          { id: 'phaser', label: 'phaser', note: '0.288 oct',
            values: { mode: 4, cutoff: 800, resonance: 0.9, mix: 0.5 } },
        ],
      },
    ],
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = createWorkletNode(node, ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 2,
      // 2-channel input so a stereo source feeds L/R filter channels.
      //
      // 'speakers' (NOT 'discrete') is load-bearing. resofilter's stereo lives
      // on two CHANNELS of ONE input, so the up-mix law — not a connection —
      // decides what a MONO source puts on channel 1. Under 'discrete' a
      // 1-channel source up-mixes by ZERO-FILLING channel 1, so the DSP's
      // `inAudio[1] ?? inAudio[0]` mono normal can never fall through
      // (channel 1 exists, it is just silent) and OUT R was digital silence on
      // every patch the app can build. 'speakers' up-mixes mono by DUPLICATING
      // it to both channels, which is the normal the port's own doc promises
      // ("a mono source feeds both channels"); a real 2-channel source is
      // unaffected by either law. Enforced by mono-normal-not-defeated.test.ts.
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      outputChannelCount: [1, 1],
    });

    // Keep the node alive when nothing is patched in.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of resofilterDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['audio',     { node: workletNode, input: 0 }],
        ['cutoff_cv', { node: workletNode, input: 0, param: params.get('cutoff')! }],
        ['reso_cv',   { node: workletNode, input: 0, param: params.get('resonance')! }],
      ]),
      outputs: new Map([
        ['out_l', { node: workletNode, output: 0 }],
        ['out_r', { node: workletNode, output: 1 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* */ }
        try { silence.disconnect(); } catch { /* */ }
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};
