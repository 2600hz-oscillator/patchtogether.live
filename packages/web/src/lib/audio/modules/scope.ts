// packages/web/src/lib/audio/modules/scope.ts
//
// Scope — 2-channel passthrough oscilloscope. Plain JS (GainNode passthrough +
// AnalyserNode for waveform sampling). The card reads the analyser data via
// the engine's read(node, 'snapshot') interface.
//
// Two output paths:
//   - The on-card 2D canvas drives off `read('snapshot')` and renders via
//     packages/web/src/lib/audio/modules/scope-draw.ts (drawScope).
//   - The cross-domain video bridge (when SCOPE.out is patched into a
//     video-domain consumer) calls the SAME drawScope function via the
//     `drawFrame` field on videoSources, so the user sees a pixel-
//     equivalent trace on the OUTPUT canvas. Pre-PR-69 the bridge used
//     the generic GL waveform-video renderer with the raw analyser
//     buffer + rangeMax=1 — which ignored every scope param (timeMs,
//     scale, offset, range, XY, ch2). At 44.1kHz a 2048-sample buffer
//     spans many cycles densely-packed across the canvas width, which
//     looked like noise to the user (vs. the on-card timeMs window
//     showing one or two clean cycles). drawFrame closes that gap.
//
// Inputs:
//   ch1 (audio): channel-1 signal (passes through to ch1_out + drives the trace).
//   ch2 (audio): channel-2 signal (passes through to ch2_out + drives the second trace).
//   timeMs (cv, paramTarget=timeMs): displaces the timebase knob.
//   ch1Scale / ch1Offset / ch1Range (cv, paramTarget=…): displace channel-1 vertical scale / Y offset / display range mode.
//   ch2Scale / ch2Offset / ch2Range (cv, paramTarget=…): the same for channel 2.
//   mode (cv, paramTarget=mode): toggles XY-vs-time display.
//   intensity (cv, paramTarget=intensity): phosphor beam persistence.
//
// Outputs:
//   ch1_out (audio): clean ch1 passthrough (no scope-side processing).
//   ch2_out (audio): clean ch2 passthrough.
//   out (mono-video): the same waveform render the on-card canvas shows.
//
// Params:
//   timeMs (log 1..200 ms, default 20): scope time-window per screen width.
//   ch1Scale / ch2Scale (log 0.1..10, default 1): per-channel vertical scale.
//   ch1Offset / ch2Offset (linear -1..1, default 0): per-channel Y offset.
//   ch1Range / ch2Range (discrete 0..1, default 0): per-channel DISPLAY range —
//     the volts-per-division convention the trace is plotted against.
//     0 = AUDIO (±1 fills the half-height), 1 = CV (±5 V fills the same
//     half-height — the Eurorack pitch-CV convention).
//     ⚠ BOTH STATES ARE BIPOLAR. This line used to read "1 = unipolar 0..1",
//     which was wrong in both halves and contradicted the param comment eight
//     lines down as well as the read site: `pixelFromSample` (scope-draw.ts) is
//     `(sample / cvRange) * halfHeight` with `RANGE_MAX_CV = 5`, so state 1
//     divides by five and keeps the sign. Corrected with the faceplate, whose
//     `options` roster names these two states AUDIO and CV on screen.
//   mode (discrete 0..1, default 0): 0 = SPLIT (two stacked time-domain
//     traces), 1 = XY (ch1 vs ch2 — Lissajous / stereo phase).
//   intensity (linear 0..1, default 0.5): phosphor beam persistence. 0.5
//     (12:00) = today's render (one screen, full brightness, PIXEL-IDENTICAL
//     to pre-PR); 0 (7:00) = a single moving dot; 1 (5:00) = a ~2-screen
//     persistence trail. Applies in both NORMAL + XY modes. Display-only —
//     never touches the audio path.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { drawScope, type ScopeSnapshot, type ScopeDrawParams } from './scope-draw';
import { detectPitch, type PitchResult } from '$lib/audio/pitch-detect';
import { createCvShadow, type CvShadow } from '$lib/audio/cv-shadow';

export type { ScopeSnapshot } from './scope-draw';
export type { PitchResult } from '$lib/audio/pitch-detect';

export const scopeDef: AudioModuleDef = {
  type: 'scope',
  palette: { top: 'Hybrid', sub: 'Hybrid' },
  domain: 'audio',
  label: 'scope',
  category: 'utilities',

  // CV inputs mirror every param 1:1 — port id == param id. Two different
  // paths deliver a cable here, and the factory's shadows are what make
  // them agree: a CROSS-DOMAIN cable (video → audio) is sampled per frame
  // by PatchEngine.addCrossDomainCvBridge into setParam(portId, value),
  // while a SAME-DOMAIN cable is summed at audio rate straight into the
  // AudioParam by AudioEngine.addEdge. Both land on one junction.
  // Discrete params (mode, ch{1,2}Range) accept any CV value; the consumer
  // reads the canonical ≥0.5 threshold to decide their binary state, so a
  // 5V CV pulse will toggle XY mode just as expected.
  inputs: [
    // ch1/ch2 are the signal probes. They're typed `audio` (the trace + the
    // clean passthrough), but a SCOPE is a VISUALIZER, not a master bus — so
    // they also `accepts` the CV family (cv/pitch/gate) for scoping LFOs,
    // envelopes, pitch CV and gates. (canConnect blocks cv/pitch/gate→audio
    // globally to keep stray CV off the speaker bus; the per-port opt-in lifts
    // that only for the probe. The engine already routes these node-to-node.)
    { id: 'ch1', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
    { id: 'ch2', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
    // cvScale per ADR-004: ±1 sweeps the param's FULL natural range. These
    // hints were withheld while the CV landed on a stub AudioParam nobody
    // read (scaling the wrong param would have changed nothing); now that
    // each port owns a real shadow, they apply. Mode follows the param's
    // own curve — log for the multiplicative ones, discrete for the
    // two-state ones (the QBRT.mode convention).
    { id: 'timeMs',    type: 'cv', paramTarget: 'timeMs',    cvScale: { mode: 'log' } },
    { id: 'ch1Scale',  type: 'cv', paramTarget: 'ch1Scale',  cvScale: { mode: 'log' } },
    { id: 'ch1Offset', type: 'cv', paramTarget: 'ch1Offset', cvScale: { mode: 'linear' } },
    { id: 'ch1Range',  type: 'cv', paramTarget: 'ch1Range',  cvScale: { mode: 'discrete' } },
    { id: 'ch2Scale',  type: 'cv', paramTarget: 'ch2Scale',  cvScale: { mode: 'log' } },
    { id: 'ch2Offset', type: 'cv', paramTarget: 'ch2Offset', cvScale: { mode: 'linear' } },
    { id: 'ch2Range',  type: 'cv', paramTarget: 'ch2Range',  cvScale: { mode: 'discrete' } },
    { id: 'mode',      type: 'cv', paramTarget: 'mode',      cvScale: { mode: 'discrete' } },
    { id: 'intensity', type: 'cv', paramTarget: 'intensity', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'ch1_out', type: 'audio' },
    { id: 'ch2_out', type: 'audio' },
    // Mono-video output: the same waveform users see on the SCOPE
    // card's on-card 2D canvas, exposed as a GL texture for downstream
    // video-domain consumers (OUTPUT, MIXER, etc.). The bridge calls
    // our drawFrame() each video frame; we render via the shared
    // scope-draw module against the live analyser snapshots + current
    // params.
    { id: 'out',     type: 'mono-video' },
  ],
  params: [
    { id: 'timeMs',    label: 'Time',  defaultValue: 20, min: 1,    max: 200, curve: 'log',      units: 'ms' },
    { id: 'ch1Scale',  label: 'Ch1 Sc', defaultValue: 1,  min: 0.1,  max: 10,  curve: 'log' },
    { id: 'ch1Offset', label: 'Ch1 Y',  defaultValue: 0,  min: -1,   max: 1,   curve: 'linear' },
    // 0 = audio (±1 fills the canvas), 1 = cv (±5 — Eurorack pitch CV
    // convention so a multi-octave pitch sweep is readable without cranking
    // ch1Scale to 0.2). Per-channel; the scale fader still multiplies on top.
    //
    // ⚠ THE `options` ROSTER IS WHY THE SWITCH KEEPS ITS WORDS. Without one a
    // `0..1 discrete` param paints an ANONYMOUS toggle (`paintsReadout` is
    // `!format && (options || landmarks)`), and the only place the strings
    // AUDIO and CV exist today is `ScopeCard.svelte`'s own markup — which a
    // faceplate stops rendering. So promotion without this roster would DELETE
    // both words, and a toggle with no names announces pressed/unpressed:
    // enable-and-absence semantics, "the range is on". What this control picks
    // is one of two DISPLAY CONVENTIONS with different volts-per-division;
    // "off" is not a state it has. The names are PROMOTED, not invented — they
    // are the strings the card's button has always painted, the words
    // `drawScope`'s own corner label draws (`±1.0` / `±5V`), and word-for-word
    // the roster `dockscope.range` already ships for the identical control.
    { id: 'ch1Range',  label: 'Ch1 R',  defaultValue: 0,  min: 0,    max: 1,   curve: 'discrete',
      options: [
        { value: 0, label: 'AUDIO', title: 'audio range — ±1.0 fills the trace' },
        { value: 1, label: 'CV', title: 'CV range — ±5V, the Eurorack convention' },
      ] },
    { id: 'ch2Scale',  label: 'Ch2 Sc', defaultValue: 1,  min: 0.1,  max: 10,  curve: 'log' },
    { id: 'ch2Offset', label: 'Ch2 Y',  defaultValue: 0,  min: -1,   max: 1,   curve: 'linear' },
    { id: 'ch2Range',  label: 'Ch2 R',  defaultValue: 0,  min: 0,    max: 1,   curve: 'discrete',
      options: [
        { value: 0, label: 'AUDIO', title: 'audio range — ±1.0 fills the trace' },
        { value: 1, label: 'CV', title: 'CV range — ±5V, the Eurorack convention' },
      ] },
    // 0 = split (two stacked traces), 1 = XY (ch1 vs ch2 plot).
    //
    // ⚠ `SPLIT` IS THE WORD THE CODE ALREADY USES, and it is a correction
    // rather than an invention. The card paints `⇆` for state 0 — a glyph, not
    // a name, and one that reads as "swap" rather than "two traces". This
    // param's own comment (the line above) has always called it "split", and
    // `scope-draw.ts` names the function `drawSplit`. The card is the outlier.
    //
    // ⚠ AND THE LABEL MOVED `XY` → `Mode` IN THE SAME EDIT. Leaving it would
    // paint a cell CAPTIONED `XY` whose two positions read `SPLIT` and `XY` —
    // the caption colliding with one of the states it selects between. `label`
    // is UI metadata, out of `contract-signature`, so this is the same class of
    // edit as the roster beside it.
    { id: 'mode',      label: 'Mode',  defaultValue: 0,  min: 0,    max: 1,   curve: 'discrete',
      options: [
        { value: 0, label: 'SPLIT', title: 'two stacked time-domain traces' },
        { value: 1, label: 'XY', title: 'channel 1 against channel 2 — Lissajous / stereo phase' },
      ] },
    // Phosphor beam persistence (display-only). 0.5 (12:00) = legacy render
    // (one screen, full brightness, pixel-identical); 0 (7:00) = a single
    // moving dot; 1 (5:00) = ~2-screen persistence trail with phosphor fade.
    { id: 'intensity', label: 'Inten', defaultValue: 0.5, min: 0,   max: 1,   curve: 'linear' },
  ],

  // ── THE FACEPLATE ─────────────────────────────────────────────────────────
  //
  // SCOPE is THE RACK'S PROBE. You patch it INLINE — `ch1_out`/`ch2_out` are
  // the input gains verbatim, nothing touches the signal — and it draws what is
  // going past. So the verb a player performs here is FRAME A SIGNAL SO IT CAN
  // BE READ: choose the window, fit the amplitude, pick the volts-per-division,
  // and decide whether you are looking at two signals in time or one against
  // the other. Every rank below descends from that sentence.
  face: {
    // RANKED AGAINST THE DSP, then found to agree with declaration order —
    // stated because an unexamined rank and a derived one that happens to match
    // look identical in the diff.
    //
    // 1. `timeMs` is the only SHARED control and the only one that changes what
    //    you are looking AT rather than how it sits on screen. Every other
    //    continuous control is per-channel cosmetics on top of the window this
    //    one picks.
    // 2. Then CH1's three, then CH2's three — GROUPED BY CHANNEL, not by
    //    function, and this is the rank worth defending. The obvious
    //    alternative (`ch1Scale, ch2Scale, ch1Offset, ch2Offset, …`) reads
    //    better as a TABLE and worse as an INSTRUMENT: a player working on a
    //    trace works on ONE trace — they fit it, they move it clear of the
    //    other one, they set its convention — and interleaving makes every
    //    adjustment a two-column hunt. (mixmstrs' console grid is the
    //    counter-example that proves the rule is about the GESTURE, not the
    //    layout: there the columns ARE the instrument.)
    // 3. `mode` below both channels, because XY is meaningless until each trace
    //    is readable on its own — you set the channels up, THEN cross them.
    // 4. `intensity` LAST, and this one is taste rather than measurement: it is
    //    display feel, it is the only control here that cannot make a trace
    //    WRONG, and its shipped default is a special-cased legacy render
    //    (`isDefaultIntensity`), so it is the control a player is least likely
    //    to reach for on a fresh spawn.
    order: [
      'timeMs',
      'ch1Scale', 'ch1Offset', 'ch1Range',
      'ch2Scale', 'ch2Offset', 'ch2Range',
      'mode',
      'intensity',
    ],

    // ⚠ THE LANE TILE IS THE RANK'S PREFIX, AND THERE IS NO SECOND LIST. There
    // is no per-face "lane subset" field — `laneOrder()` only drops a hero cell
    // or an xyPad, neither of which this face declares — so what a lane tier
    // shows is literally the top of `order`. That makes the lane `timeMs`,
    // `ch1Scale`, `ch1Offset`: "make CHANNEL 1 readable without opening the
    // dock", which is the common case for a probe (one cable, one trace) and is
    // coherent on its own merits rather than as a leftover. The channel-grouped
    // rank and a hypothetical `timeMs`/`ch1Scale`/`ch2Scale` lane cannot both
    // be had without a new platform field, and inventing one for a lane
    // preference is not a trade this face is worth.
    //
    // ⚠ `ch1Range`/`ch2Range` are deliberately NOT near the top: they are set
    // once for the KIND of cable you patched and then left alone. dockscope
    // reached the identical conclusion for the identical control.

    // Three bands. CLUSTERS rather than PAGES for the two channels, and the
    // price list is the reason: a page costs a ~81 px band, a cluster costs a
    // ~14 px sub-header (see ModuleFacePage.clusters). The two channels are
    // *the same idea, twice* — that field's own worked example — so they are
    // clusters. `clusterFlow: 'row'` sets them side by side, which is the
    // mixmstrs RETURN-strip case: two peers wide enough to sit together and
    // narrow enough to fit, saving a whole band of vertical space.
    //
    // ⚠ `mode` SITS IN TIMEBASE, NOT IN CHANNELS, and that placement is an
    // argument rather than a leftover. XY is not a channel setting — it is a
    // statement about what the HORIZONTAL AXIS IS. In SPLIT the x axis is time
    // and `timeMs` scales it; in XY the x axis is channel 1 and `timeMs` still
    // picks the sample window but no longer scales anything visible. Putting
    // `mode` beside `timeMs` is the only arrangement in which the two controls
    // that define the horizontal axis are adjacent.
    pages: [
      {
        id: 'timebase',
        label: 'TIMEBASE',
        hint: 'the window the screen shows',
        controls: ['timeMs', 'mode'],
      },
      {
        id: 'channels',
        label: 'CHANNELS',
        hint: 'fit each trace and pick its volts-per-division',
        controls: ['ch1Scale', 'ch1Offset', 'ch1Range', 'ch2Scale', 'ch2Offset', 'ch2Range'],
        clusters: [
          { label: 'CH 1', controls: ['ch1Scale', 'ch1Offset', 'ch1Range'] },
          { label: 'CH 2', controls: ['ch2Scale', 'ch2Offset', 'ch2Range'] },
        ],
        clusterFlow: 'row',
      },
      {
        id: 'beam',
        label: 'BEAM',
        hint: 'phosphor persistence — display feel only',
        controls: ['intensity'],
      },
    ],

    // ⚠ NO TAB RAIL, and it could not engage even if this face wanted one:
    // `DOCK_TAB_MIN_BANDS` is 7 and these are three bands. `face.tabbed` is
    // fenced as DECLARED ONLY ON EXPLICIT OWNER INSTRUCTION, PER MODULE, and
    // there is no such instruction for scope. It is also the right answer on
    // the merits — nine params over one display is one honest idea, and the
    // ruling is *never pad pages to force the rail*.

    // All six CONTINUOUS controls are THROWS on the card (`<NeonFader>` ×6),
    // and nothing in a `ParamDef` separates "a throw" from any other continuous
    // scalar — so an undeclared face silently swaps every one for a dial, which
    // is the `noise` regression this map exists for.
    //
    // ⚠ THE DECLARATION HAS A MEASURED LAYOUT COST, ACCEPTED ON PURPOSE.
    // `LANE_CELL_H.fader` is 96 px against a 42 px plate row, so declaring
    // `fader` halves a module's lane plate. Scope's lane tier carries three
    // cells, so the tile stays one row either way — the cost lands on a module
    // that was never going to show six controls in a lane. Faced modules that
    // rank card-drawn faders and paint them as knobs have NOT converted; scope
    // converts because its lane set is small enough that the conversion is
    // free, not because the fleet has decided.
    //
    // The two range switches and `mode` are deliberately ABSENT: `min 0 /
    // max 1 / discrete` is the genuine two-state shape, `looksLikeToggle`
    // resolves it, and with a two-entry roster the dock renders a captioned
    // SEGMENTED pair.
    paramCells: {
      timeMs: 'fader',
      ch1Scale: 'fader',
      ch1Offset: 'fader',
      ch2Scale: 'fader',
      ch2Offset: 'fader',
      intensity: 'fader',
    },

    // ⚠ NO `momentary`. All three switches LATCH, and the classification is
    // made at the READ SITE rather than guessed from the shape: `drawScope`
    // compares `params.mode` and `params.ch{1,2}Range >= 0.5` on EVERY FRAME
    // (the `drawSplit`/`drawXY` dispatch and `pixelFromSample`'s `isCv`). There
    // is no edge detector anywhere in the chain, so these are LEVELS, not
    // triggers — `ACKNOWLEDGED_LATCHING`, never `face.momentary`. A momentary
    // render would snap the display back the instant the player let go, which
    // is not a control anyone could use to look at a 5 V pitch sweep.

    // ⚠ NO `bareCells`. Every caption disambiguates: `Ch1 Sc` / `Ch1 Y` /
    // `Ch1 R` under a `CH 1` heading are the only thing separating three
    // otherwise-identical cells, which is the tidyVco side of the ruling and
    // not the mixmstrs side — there the caption repeated the heading and said
    // nothing else; here it carries the FUNCTION, which the heading never does.

    // ⚠ NO GLYPH — AND THIS ONE IS REFUSED FOR THE OPPOSITE REASON DOCKSCOPE'S
    // WAS, WHICH IS THE WHOLE POINT OF THIS COMMENT.
    //
    // dockscope declares `outputs: []`, so `primaryAudioOutPortId` returns null,
    // every glyph literal falls to `{kind:'static'}`, and the dead-glyph clause
    // catches it. Its refusal is MECHANICAL — a gate makes it for you.
    //
    // SCOPE HAS NO SUCH PROTECTION. `ch1_out` is declared `type: 'audio'`, so
    // `primaryAudioOutPortId(scopeDef)` returns `'ch1_out'` and `glyphBinding`
    // short-circuits to `{ kind: 'live-audio', portId: 'ch1_out' }`. That
    // binding is LIVE. The dead-glyph clause is green. `VALID_GLYPHS` is
    // satisfied. NOTHING ANYWHERE REDDENS — and the picture would still be
    // wrong, in the one way that matters most on this module.
    //
    // Because `ch1_out` IS `gain1`: the factory creates it, connects it to
    // `analyser1`, publishes it as the output, and NOTHING ever writes
    // `gain1.gain` (`setParam` writes the nine CV shadows instead). So
    // `ch1_out` is bit-exactly the module's CH1 INPUT, and a `live-audio` glyph
    // on it paints a raw 2048-sample analyser dump that is invariant to
    // `timeMs` (no timebase), to `ch1Scale`/`ch1Offset`/`ch1Range` (no scale,
    // offset or ±5 V law), to `mode` (never an XY plot), to `intensity` (no
    // phosphor) and to `ch2*` entirely (channel 2 is not in the picture).
    // EVERY ONE OF THIS MODULE'S CONTROLS.
    //
    // ⚠ And it is worse here than on the recorded siblings, for a reason
    // specific to what this module IS. On `rasterize` a passthrough trace is
    // merely uninformative — nobody expects a raster module's tile to be a
    // waveform. ON SCOPE A WAVEFORM TRACE IS EXACTLY WHAT A PLAYER WILL BELIEVE
    // IS THE SCOPE'S TRACE. It would not fail to inform; it would actively
    // MISINFORM, on the one module whose entire contract is "this picture is
    // your signal, drawn the way you dialled it".
    //
    // So: `glyph: 'none'` — not because nothing fits, but because the thing
    // that fits is FALSE. `scope-face-model.test.ts` asserts that mechanism
    // directly (the binding really does resolve LIVE), because no gate does.
    //
    // ⚠ AND `glyph: 'algorithm'` DOES NOT RESCUE IT EITHER. The #2160 widening
    // resolves an extension arm BEFORE the audio-out short-circuit, so this def
    // COULD legally declare a layout-source glyph. Refused, and measured rather
    // than aesthetic: `ShellExtensionGlyphProps` is `{ num, numbers?, testid? }`
    // — no `nodeId`, no engine, no store — and `ModuleShell` hardcodes
    // `topologyValue` to 0 for a null `paramId`. Every instance of scope in the
    // rack would render a BYTE-IDENTICAL SVG that cannot vary per node or over
    // time. The widening removed the refusal; it did not add a data path, and
    // its own doc-comment says so.
    glyph: 'none',

    // The trace arrives through this slot instead — the engine handle's
    // `read('snapshot')` key is the only seam that reaches these samples, and
    // nothing in the glyph path calls `engine.read`. The body draws through
    // `drawScope`, the module's OWN pure function, which is what stops the
    // card, the faceplate and the `out` video texture from ever disagreeing
    // about what the trace looks like.
    // See `$lib/ui/modules/scope/shell-extension.ts`.
    extension: 'scope',
  },

  docs: {
    explanation:
      "A two-channel oscilloscope for SEEING your signals — it passes audio straight through untouched while drawing the waveform on its own screen, so you can patch it inline as a probe without altering the sound. Each channel has its own vertical SCALE, Y OFFSET, and RANGE mode (AUDIO plots ±1.0 full-height, CV plots ±5 V full-height — both bipolar; CV just divides by five so a pitch sweep fits), and a shared TIME knob sets how wide a window of the waveform fills the screen. An XY mode plots channel 1 against channel 2 (Lissajous figures, stereo phase) instead of two stacked traces, and an INTENSITY knob adds phosphor-style persistence from a single moving dot up to a glowing trail. Because it visualizes anything, the signal inputs also accept CV, pitch, and gate cables (not just audio). Every knob has a matching CV input, and the whole trace is also exported as a video output you can patch into the video domain. Display-only — none of the controls touch the audio path.",
    inputs: {
      ch1: "Channel-1 probe: the signal drawn on the upper trace (or the X axis in XY mode), and passed through cleanly to CH1 OUT. Typed audio but also accepts CV, pitch, and gate so you can scope LFOs, envelopes, pitch CV, and gates.",
      ch2: "Channel-2 probe: the lower trace (or the Y axis in XY mode), passed through to CH2 OUT. Also accepts CV/pitch/gate.",
      timeMs: "CV that modulates the TIME timebase knob — sweep how much of the waveform fits on screen.",
      ch1Scale: "CV that modulates channel 1's vertical SCALE — zoom the trace's amplitude in or out.",
      ch1Offset: "CV that modulates channel 1's Y OFFSET — slide the trace up or down on screen.",
      ch1Range: "CV that modulates channel 1's RANGE mode (≥ 0.5 switches the display convention from AUDIO ±1.0 to CV ±5 V).",
      ch2Scale: "CV that modulates channel 2's vertical SCALE.",
      ch2Offset: "CV that modulates channel 2's Y OFFSET.",
      ch2Range: "CV that modulates channel 2's RANGE mode.",
      mode: "CV that toggles the display MODE (≥ 0.5 switches from SPLIT into the XY plot) — e.g. a gate can flip the scope into XY view.",
      intensity: "CV that modulates the beam INTENSITY / persistence.",
    },
    outputs: {
      ch1_out: "Clean passthrough of the channel-1 input — the scope adds no processing, so you can chain it inline.",
      ch2_out: "Clean passthrough of the channel-2 input.",
      out: "A video output carrying the same waveform image the on-card screen shows — patch it into the video domain (OUTPUT, a video mixer) to put the trace on screen.",
    },
    controls: {
      timeMs: "The time window drawn across the screen width (1 to 200 ms, log, default 20): smaller values zoom in on a few cycles, larger values show a longer slice. The TIME CV input modulates this.",
      ch1Scale: "Channel-1 vertical zoom (0.1× to 10×, log, default 1): magnifies a quiet signal or shrinks a loud one to fit the screen.",
      ch1Offset: "Channel-1 vertical position (-1 to +1, default 0): nudges the trace up or down so two channels don't overlap.",
      ch1Range: "Channel-1 display range — the volts-per-division the trace is plotted against. AUDIO (0) fills the channel's half-height at ±1.0, the Web Audio sample convention; CV (1) fills the same half-height at ±5 V, the Eurorack convention, so a multi-octave pitch CV sweep is readable without re-zooming. BOTH settings are bipolar — CV divides by five and keeps the sign, it does not rectify or shift the trace. Display-only; the SCALE fader still multiplies on top.",
      ch2Scale: "Channel-2 vertical zoom (0.1× to 10×, log, default 1).",
      ch2Offset: "Channel-2 vertical position (-1 to +1, default 0).",
      ch2Range: "Channel-2 display range: AUDIO (0) = ±1.0 fills the half-height, CV (1) = ±5 V does. Both bipolar, same as channel 1.",
      mode: "Display mode: SPLIT (0) draws two stacked time-domain traces sharing one time axis, XY (1) plots channel 1 against channel 2 — Lissajous figures and stereo phase. In SPLIT the horizontal axis is TIME and the TIME knob scales it; in XY the horizontal axis IS channel 1, and TIME only selects how many samples are plotted.",
      intensity: "Phosphor beam persistence (0 to 1, default 0.5): at 0 the trace is a single moving dot, at 0.5 a full-brightness single-screen trace, toward 1 a ~2-screen glowing persistence trail. Visual feel only.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // Per channel: input → gain (passthrough) → output, with a tap to analyser.
    const gain1 = ctx.createGain();
    const gain2 = ctx.createGain();
    const analyser1 = ctx.createAnalyser();
    const analyser2 = ctx.createAnalyser();
    analyser1.fftSize = 2048;
    analyser2.fftSize = 2048;
    analyser1.smoothingTimeConstant = 0;
    analyser2.smoothingTimeConstant = 0;
    gain1.connect(analyser1);
    gain2.connect(analyser2);
    // Note: we don't connect analyser → anywhere; it's a sink that buffers samples.

    const buf1 = new Float32Array(analyser1.fftSize);
    const buf2 = new Float32Array(analyser2.fftSize);

    // ── CV SHADOWS: where the knob and the cable meet (#1664) ────────
    // Every scope param is DISPLAY-ONLY — applied in JS by `drawScope`,
    // never by a Web Audio node — so none of them is a real AudioParam.
    // Each therefore gets its OWN shadow: a ConstantSource(1) → GainNode
    // whose `.gain` is published as that port's param, and whose output
    // is the combined (knob + CV) value. See $lib/audio/cv-shadow.
    //
    // What was here before: six ports published `gain1.gain` and three
    // published `gain2.gain` — the LIVE ch1/ch2 passthrough gains, one
    // AudioParam shared across six inputs. So a cable into TIME did not
    // move the timebase, it amplitude-modulated the passthrough (measured
    // 7.010e+1 peak against a 5.0e-1 baseline), and `setParam` wrote a JS
    // record the same-domain CV path never reached. The comment that
    // justified it cited "the audio engine's sample-per-frame tap" for
    // intra-domain CV; there is no such mechanism — `AudioEngine.addEdge`
    // connects to the AudioParam and never calls `setParam`.
    //
    // The shadows are the single source of truth for BOTH render paths
    // (the on-card canvas via read('drawParams'), the cross-domain video
    // bridge via drawFrame), so the two cannot drift.
    const shadows: Record<string, CvShadow> = {
      timeMs:    createCvShadow(ctx, (node.params ?? {}).timeMs    ?? 20),
      ch1Scale:  createCvShadow(ctx, (node.params ?? {}).ch1Scale  ?? 1),
      ch1Offset: createCvShadow(ctx, (node.params ?? {}).ch1Offset ?? 0),
      ch1Range:  createCvShadow(ctx, (node.params ?? {}).ch1Range  ?? 0),
      ch2Scale:  createCvShadow(ctx, (node.params ?? {}).ch2Scale  ?? 1),
      ch2Offset: createCvShadow(ctx, (node.params ?? {}).ch2Offset ?? 0),
      ch2Range:  createCvShadow(ctx, (node.params ?? {}).ch2Range  ?? 0),
      mode:      createCvShadow(ctx, (node.params ?? {}).mode      ?? 0),
      intensity: createCvShadow(ctx, (node.params ?? {}).intensity ?? 0.5),
    };

    /** The draw parameters for THIS frame: knob + CV, sampled together so
     *  both render paths see one instant. */
    function liveParams(): ScopeDrawParams {
      return {
        timeMs:    shadows.timeMs!.read(),
        ch1Scale:  shadows.ch1Scale!.read(),
        ch1Offset: shadows.ch1Offset!.read(),
        ch1Range:  shadows.ch1Range!.read(),
        ch2Scale:  shadows.ch2Scale!.read(),
        ch2Offset: shadows.ch2Offset!.read(),
        ch2Range:  shadows.ch2Range!.read(),
        mode:      shadows.mode!.read(),
        intensity: shadows.intensity!.read(),
      };
    }

    function readSnapshot(): ScopeSnapshot {
      analyser1.getFloatTimeDomainData(buf1);
      analyser2.getFloatTimeDomainData(buf2);
      return { ch1: buf1, ch2: buf2, sampleRate: ctx.sampleRate };
    }

    // Pitch tuner reads ch1 (the analyser already mirrors what the user sees
    // on the trace). The card polls this on a ~100ms interval; YIN over a
    // 2048-sample window at 48kHz takes ~1ms.
    function readPitch(): PitchResult {
      analyser1.getFloatTimeDomainData(buf1);
      return detectPitch(buf1, ctx.sampleRate);
    }

    function drawFrame(canvas: OffscreenCanvas | HTMLCanvasElement): void {
      const ctx2d = canvas.getContext('2d') as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D
        | null;
      if (!ctx2d) return;
      drawScope(ctx2d, readSnapshot(), liveParams(), canvas.width, canvas.height);
    }

    return {
      domain: 'audio',
      // gain1 and gain2 each act as both the input AND output for their channel
      // — Web Audio happily routes signal through a GainNode, and we tap a
      // separate analyser off it for visualization.
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['ch1', { node: gain1, input: 0 }],
        ['ch2', { node: gain2, input: 0 }],
        // One shadow per port — never shared, never in the audio path. The
        // engine sums each cable into that port's own `.gain`; the draw
        // paths read the combined value back through its analyser. `node`
        // is the shadow too, so even the engine's no-param fallback branch
        // cannot land a cable on the ch1/ch2 passthrough.
        ...Object.entries(shadows).map(
          ([id, s]) => [id, { node: s.node, input: 0, param: s.param }] as const,
        ),
      ]),
      outputs: new Map([
        ['ch1_out', { node: gain1, output: 0 }],
        ['ch2_out', { node: gain2, output: 0 }],
      ]),
      // Cross-domain: the video bridge calls drawFrame() each video
      // frame. We hand back analyser1 too because the bridge type
      // requires it (legacy GL-renderer path), but it isn't used when
      // drawFrame is set.
      videoSources: new Map([
        ['out', { analyser: analyser1, sampleRate: ctx.sampleRate, drawFrame }],
      ]),
      setParam(paramId, value) {
        // A knob move lands on the SAME junction a cable does — the
        // shadow's `.gain` intrinsic — so the two sum instead of racing.
        // (We don't mutate patch.nodes here: the audio engine's reconciler
        // owns the patch state, and the card's faders read it directly.)
        shadows[paramId]?.set(value);
      },
      readParam(paramId) {
        // The knob alone. The engine folds in the modulator tap on top of
        // this for the motorized fader (see AudioEngine.readParam), so
        // returning the combined value here would double-count the CV.
        return shadows[paramId]?.knob();
      },
      read(key) {
        if (key === 'snapshot') {
          return readSnapshot();
        }
        // The COMBINED (knob + CV) draw parameters — what drawFrame is
        // rendering with. The CARD reads this so its on-card trace and the
        // video output are the same picture; reading the knob instead
        // would leave the card blind to every patched cable.
        if (key === 'drawParams') {
          return liveParams();
        }
        if (key === 'pitch') {
          return readPitch();
        }
        // Per-channel single-sample readback. Returns the most-recent
        // time-domain sample on the matching analyser — the same value
        // the trace renders at the right edge of the screen.
        //
        // Used by e2e (vrt-composite + nibbles-cv-scope.spec.ts) to read
        // the LIVE incoming signal at the ch1 / ch2 audio inputs, NOT
        // the user-dialed slider state — which is what an e2e proving a
        // CV signal "actually arrives" needs to assert against. (PR
        // #419 originally tried QBRT.readParam('cutoff') for this; that
        // returns the slider value, not the modulated AudioParam, so
        // the assertion was structurally wrong. SCOPE is the right
        // canonical "visible CV" consumer because its analyser samples
        // the bridged AudioNode directly.)
        if (key === 'ch1_last_sample') {
          analyser1.getFloatTimeDomainData(buf1);
          return buf1[buf1.length - 1];
        }
        if (key === 'ch2_last_sample') {
          analyser2.getFloatTimeDomainData(buf2);
          return buf2[buf2.length - 1];
        }
        return undefined;
      },
      // The inverse of read('drawParams'). A consumer holding the engine pushes
      // `PatchEngine.readParam` (the knob PLUS the engine's own per-port CV tap)
      // back in, so both render paths draw the modulated value while this module
      // owns NO AnalyserNode per port — which is what a permanently retained
      // Blink AudioHandler per port would have cost. See $lib/audio/cv-shadow.
      write(key, value) {
        if (key !== 'cvCombined' || typeof value !== 'object' || value === null) return;
        for (const [id, v] of Object.entries(value as Record<string, number>)) {
          shadows[id]?.setCombined(v);
        }
      },
      dispose() {
        gain1.disconnect();
        gain2.disconnect();
        analyser1.disconnect();
        analyser2.disconnect();
        for (const s of Object.values(shadows)) s.dispose();
      },
    };
  },
};
