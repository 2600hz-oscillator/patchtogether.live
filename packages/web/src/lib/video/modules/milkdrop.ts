// packages/web/src/lib/video/modules/milkdrop.ts
//
// MILKDROP — a Winamp/Milkdrop music visualizer as a fully CV-instrumented
// video SOURCE, wrapping the open-source butterchurn engine (@webamp/butterchurn,
// MIT) + the classic preset pack (butterchurn-presets, MIT).
//
// ── Why a wrapper, not a fork ────────────────────────────────────────────────
// butterchurn is WebGL2-native and renders into its OWN WebGL2 context on its
// OWN OffscreenCanvas (a multi-pass warp-mesh + blur + waveform pipeline). It is
// loaded from node_modules and NOT vendored under lib/video/** — the whole
// lib/video tree is hashed into the WebGL attest basis, and vendoring would pull
// butterchurn's entire source + the generated presets into the basis. Only THIS
// thin wrapper is in-basis. The presets are pulled behind a dynamic `import()`
// so they form a separate lazy chunk, never landing in the main bundle.
//
// ── Render handoff (foreign renderer → our FBO) ──────────────────────────────
// Each frame we call `visualizer.render({ audioLevels, elapsedTime })`. butterchurn
// blits its internal GL canvas into the 2D `bcCanvas` we handed it; we upload
// that canvas into a small GL texture (the video-frame-upload texImage2D pattern,
// cross-context safe) and then fullscreen-quad-copy it UP into the module's
// engine-resolution `out` FBO so it composites + reads back exactly like any
// other video source. butterchurn renders at a MODEST fixed internal size
// (BC_W×BC_H, modest mesh) so the multi-pass engine stays cheap on CI's
// SwiftShader software renderer.
//
// ── Audio in ─────────────────────────────────────────────────────────────────
// The `audio` input is an `audio`-typed input on a video module (the
// RECORDERBOX cross-domain audio→video direction): we publish a GainNode SINK
// via `audioInputs`, and the PatchEngine connects the upstream audio source's
// output into it. The sink fans into a mono AnalyserNode + an L/R splitter+pair,
// all fftSize 1024 (butterchurn's `fftSize`), and a silent gain(0)→destination
// keep-alive keeps the tap pulled. Each frame we `getByteTimeDomainData` →
// feed as `timeByteArray`(+L/R) to render({audioLevels}); passing audioLevels
// makes butterchurn use OUR bytes instead of its internal sampleAudio(). With
// nothing patched the analyser naturally reads flat 128 (silence).
//
// ── The CV instrumentation (the novel part) ──────────────────────────────────
// butterchurn's renderer builds a `globalVars` object each frame from
// `this.audioLevels.bass/mid/treb` (+`_att`) and merges it LAST into the
// per-frame preset equations, so those three scalars drive essentially ALL
// preset motion. `bass`/`mid`/`treb` are GETTERS on the live AudioLevels
// instance. We redefine them on the instance to consult a mutable `ov` override:
//   - a CV-patched band returns the mapped CV (CV REPLACES that band);
//   - an unpatched band falls through to the real computed value (live audio);
//   - a global `reactivity` scalar multiplies all three either way.
// No fork. Other runtime controls, also fork-free: `elapsedTime` → speed/time-
// warp; `loadPreset(preset, blendSeconds)` → preset-select (quantized CV) +
// morph (blend seconds); `next` trigger → advance preset on the rising edge.
//
// ── I/O ──────────────────────────────────────────────────────────────────────
//   Inputs:
//     audio        (audio) — the signal the visuals react to.
//     bass/mid/treb (cv)   — CV REPLACES that band (open = live audio).
//     reactivity   (cv)    — global scalar on all three bands.
//     speed        (cv)    — time-warp (elapsedTime multiplier, clamped ≥ 0).
//     presetSelect (cv)    — quantized index into the curated preset list.
//     morph        (cv)    — preset blend/crossfade seconds.
//     next         (gate, edge:'trigger') — rising edge → next preset.
//   Output:
//     out          (video) — the visualizer frame.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
// TYPE-ONLY import (fully erased): @webamp/butterchurn touches `window` at
// module-eval, so the RUNTIME import MUST stay lazy (dynamic import in the
// factory) — a static runtime import would crash every node-env unit test that
// side-effect-loads the video registry (and SSR). The lazy import also keeps the
// ~230 KB engine out of the main bundle (its own chunk).
import type { ButterchurnVisualizer } from '@webamp/butterchurn';
import { createRisingEdgeDetector } from '$lib/audio/modules/transport-helpers';
import { GATE_HI } from '$lib/audio/gate-trigger';

/** butterchurn's analyser window length (AudioProcessor: numSamps·2 = 1024).
 *  Our tap analysers MUST match so the byte arrays line up 1:1. */
const FFT_SIZE = 1024;

/** Modest fixed butterchurn render size (4:3, matching the engine default
 *  aspect). The internal warp mesh + texsize scale with this; keeping it small
 *  keeps the multi-pass engine cheap on CI's SwiftShader. The output is
 *  upscaled to the engine resolution by a copy pass, so downstream + the DRS
 *  pixel read still see a full engine-res texture. */
const BC_W = 640;
const BC_H = 480;
/** Warp-mesh resolution — HALF butterchurn's 48×36 default (per-vertex CPU
 *  equation eval each frame; the dominant cost on the software renderer). */
const MESH_W = 24;
const MESH_H = 18;

/** Curated subset (~20) of the classic Minimal preset pack — tasteful,
 *  well-known Flexi/Geiss/Martin presets. Resolved by name from the loaded
 *  pack (a missing name is skipped, so a pack-version drift degrades
 *  gracefully). Index 0 is a full-screen reaction-diffusion that renders
 *  non-black + structured regardless of audio (the deterministic DRS default). */
const CURATED_ORDER: readonly string[] = [
  'Geiss - Reaction Diffusion 2',
  'Flexi - mindblob [shiny mix]',
  'Flexi, martin + geiss - dedicated to the sherwin maxawow',
  'martin - witchcraft reloaded',
  'Geiss - Cauldron - painterly 2 (saturation remix)',
  'Flexi - alien fish pond',
  'flexi - bouncing balls [double mindblob neon mix]',
  'martin - chain breaker',
  'martin - reflections on black tiles',
  'Martin - acid wiring',
  'Geiss - Thumb Drum',
  'Unchained - Rewop',
  'Krash + Illusion - Spiral Movement',
  'Zylot - Paint Spill (Music Reactive Paint Mix)',
  'suksma - uninitialized variabowl (hydroponic chronic)',
  'Eo.S. + Phat - cubetrace - v2',
  'martin - extreme heat',
  'yin - 191 - Temporal singularities',
  'Unchained & Rovastar - Wormhole Pillars (Hall of Shadows mix)',
  'Idiot - Star Of Annon',
];

/** Param count used for the presetSelect range (static; the live list may be
 *  shorter after a pack drift — the runtime clamps to it). */
const CURATED_COUNT = CURATED_ORDER.length;

/** The curated preset NAMES, exported (names only — no preset bodies, so this
 *  pulls nothing from the lazy pack chunk) so MilkdropCard's picker can populate
 *  its dropdown immediately, before the engine's live list (`read('presetNames')`)
 *  resolves behind the dynamic import. */
export const MILKDROP_CURATED_NAMES: readonly string[] = CURATED_ORDER;

interface MilkdropParams {
  /** CV-only band override targets (no card fader → only the CV bridge writes
   *  them, so "written this frame" == "patched"). */
  bass: number;
  mid: number;
  treb: number;
  reactivity: number;
  speed: number;
  presetSelect: number;
  morph: number;
  /** Hidden synthetic edge-detector param for the `next` trigger. */
  nextTrig: number;
}

const DEFAULTS: MilkdropParams = {
  bass: 1,
  mid: 1,
  treb: 1,
  reactivity: 1,
  speed: 1,
  presetSelect: 0,
  morph: 2,
  nextTrig: 0,
};

const COPY_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
void main() {
  outColor = vec4(texture(uTex, vUv).rgb, 1.0);
}`;

const BANDS = ['bass', 'mid', 'treb'] as const;
const BAND_KEYS = ['bass', 'mid', 'treb', 'bass_att', 'mid_att', 'treb_att'] as const;
type BandKey = (typeof BAND_KEYS)[number];

/** Test seam: a finite `__milkdropFixedDelta` pins elapsedTime so butterchurn's
 *  internal clock advances deterministically under the DRS (default-undefined →
 *  the real per-frame delta). */
function fixedDelta(): number | null {
  const v = (globalThis as unknown as { __milkdropFixedDelta?: unknown }).__milkdropFixedDelta;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Test seam: when `__milkdropTestAudio` is true, feed a fixed synthetic sine
 *  into the time arrays so the DRS gets an audio-reactive (guaranteed non-black
 *  + structured) frame without wiring a live source (default-undefined → off). */
function testAudioOn(): boolean {
  return (globalThis as unknown as { __milkdropTestAudio?: unknown }).__milkdropTestAudio === true;
}

export const milkdropDef: VideoModuleDef = {
  type: 'milkdrop',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'milkdrop',
  category: 'sources',
  inputs: [
    // Audio the visuals react to (audio-typed input → cross-domain audio bridge).
    { id: 'audio', type: 'audio' },
    // Per-band CV overrides — CV REPLACES that band (port id == param id so the
    // CV bridge routes to setParam(<band>)).
    { id: 'bass', type: 'cv', paramTarget: 'bass', cvScale: { mode: 'linear' } },
    { id: 'mid', type: 'cv', paramTarget: 'mid', cvScale: { mode: 'linear' } },
    { id: 'treb', type: 'cv', paramTarget: 'treb', cvScale: { mode: 'linear' } },
    { id: 'reactivity', type: 'cv', paramTarget: 'reactivity', cvScale: { mode: 'linear' } },
    { id: 'speed', type: 'cv', paramTarget: 'speed', cvScale: { mode: 'linear' } },
    { id: 'presetSelect', type: 'cv', paramTarget: 'presetSelect', cvScale: { mode: 'linear' } },
    { id: 'morph', type: 'cv', paramTarget: 'morph', cvScale: { mode: 'linear' } },
    // Trigger: rising edge advances the preset. Gate cable, edge:'trigger';
    // the CV bridge writes the gate level to nextTrig + the factory edge-detects.
    { id: 'next', type: 'gate', edge: 'trigger', paramTarget: 'nextTrig' },
  ],
  outputs: [{ id: 'out', type: 'video' }],
  params: [
    { id: 'bass', label: 'Bass', defaultValue: DEFAULTS.bass, min: 0, max: 2, curve: 'linear' },
    { id: 'mid', label: 'Mid', defaultValue: DEFAULTS.mid, min: 0, max: 2, curve: 'linear' },
    { id: 'treb', label: 'Treble', defaultValue: DEFAULTS.treb, min: 0, max: 2, curve: 'linear' },
    { id: 'reactivity', label: 'React', defaultValue: DEFAULTS.reactivity, min: 0, max: 2, curve: 'linear' },
    { id: 'speed', label: 'Speed', defaultValue: DEFAULTS.speed, min: 0, max: 2, curve: 'linear' },
    { id: 'presetSelect', label: 'Preset', defaultValue: DEFAULTS.presetSelect, min: 0, max: CURATED_COUNT - 1, curve: 'linear' },
    { id: 'morph', label: 'Morph', defaultValue: DEFAULTS.morph, min: 0, max: 8, curve: 'linear' },
    { id: 'nextTrig', label: 'Next Trig', defaultValue: DEFAULTS.nextTrig, min: 0, max: 1, curve: 'linear' },
  ],

  // ⚠ FOUR PARAMS HAVE NO PLAYER CONTROL, and face completeness would have
  // PAINTED all four (#1726). `bass`/`mid`/`treb` are CV-only band OVERRIDES —
  // the def's own docs say "no panel knob; the MID jack writes it", and the card
  // has never drawn them — while `nextTrig` is the synthetic param the `next`
  // GATE writes so the CV bridge has somewhere to land a rising edge. Rendered
  // as ordinary continuous rotaries they would invite a player to drag a band
  // override that a patched cable then overwrites every frame, and to "turn up"
  // a trigger. `writer: 'cv-port'` rather than `'internal'` because each one IS
  // targeted by a real port (`bass`/`mid`/`treb` cv, `next` gate), which the
  // gate checks against this def's own ports — so the day a port stops
  // targeting one of them, the entry stops being true and says so.
  //
  // Free even on a basis file: `noUserControl` is one of the hash-transparent
  // def properties (`scripts/attest-code-basis.ts`).
  noUserControl: [
    {
      param: 'bass',
      writer: 'cv-port',
      why: 'CV-only band override: the BASS jack REPLACES butterchurn\'s bass scalar for as long as it is patched, and an unpatched band follows the live audio. no faceplate control has ever existed for it — a knob here would be overwritten every frame by the cable it exists to receive',
    },
    {
      param: 'mid',
      writer: 'cv-port',
      why: 'CV-only band override, exactly as bass: the MID jack replaces the mid scalar while patched, and the docs say "no panel knob; the MID jack writes it". REACT is the control a player actually turns to scale all three',
    },
    {
      param: 'treb',
      writer: 'cv-port',
      why: 'CV-only band override, exactly as bass and mid: the TREB jack replaces the treble scalar while patched, otherwise the band follows live audio. Scaled by REACT, which is the panel control for all three',
    },
    {
      param: 'nextTrig',
      writer: 'cv-port',
      why: 'SYNTHETIC trigger param: the NEXT gate port targets it so the CV bridge has somewhere to write the gate level, and the factory edge-detects a rising edge to advance the preset. It is a momentary EVENT, not a setting — painted as a 0..1 rotary it would read as "how much next", and holding it high does nothing because the detector fires once per EDGE',
    },
  ],

  // The card's two non-param affordances, declared as one-member families so the
  // docs gate can key authored prose to them and the shell can render a cell.
  // Both `testidPrefix` values are the ones `MilkdropCard.svelte` actually emits.
  controlFamilies: [
    { id: 'milkdrop-preset-select', label: 'Preset picker', kind: 'other', testidPrefix: 'milkdrop-preset-select' },
    { id: 'milkdrop-milk-input', label: 'Load .milk preset', kind: 'other', testidPrefix: 'milkdrop-milk-input' },
  ],

  // ── THE FACEPLATE ────────────────────────────────────────────────────────
  //
  // WHAT IT IS. MILKDROP is a Winamp-era preset visualizer as a CV-instrumented
  // video SOURCE. butterchurn drives nearly all preset motion from three audio
  // scalars, and the thing only this module does is let a CABLE REPLACE any of
  // them — so a patched LFO becomes "the bass" for as long as it is connected.
  // The verb is CHOOSE-AND-DRIVE: pick which visual you are inside, then decide
  // how hard it moves.
  //
  // ⚠ THE PRESET PICKER IS A FAMILY CELL, NOT AN `options` ROSTER ON THE PARAM,
  // and the choice is about TRUTH rather than convenience. A static roster on
  // `presetSelect` would name only the ~20 CURATED presets; the card's picker
  // also lists whatever `.milk` files the player imported this session, and the
  // engine clamps the index to the LIVE list length rather than the declared
  // max. A roster would therefore be wrong the moment anyone used the loader —
  // and it would cost a real-GPU re-attest, because `params` is real code while
  // `controlFamilies` is hash-transparent. The dx7 pair
  // (`dx7-preset-select-{n}` + `dx7-syx-input-{n}`) is the precedent, verbatim.
  //
  // ⚠ SO THE PARAM AND THE PICKER ARE BOTH PRESENT, exactly as on the card,
  // where the PST fader and the dropdown "stay in sync" because both write
  // `presetSelect`. That is not duplication to be tidied away: the fader is the
  // surface CV modulates and the patch saves, and the picker is the only place
  // the preset NAMES exist at all. Dropping either loses something real.
  //
  // ⚠ THE PRESET NAME IS NOT A READOUT HERE. The card prints a live
  // name/index line (`data-testid="milkdrop-preset"`); the 2026-08-19 rulings
  // deleted that shape, and the name survives as the SELECTED OPTION LABEL on
  // the picker — which is permitted resting text precisely because it
  // disambiguates the control's own position rather than restating a value.
  //
  // THE TIER LADDER, MEASURED through `curatedFace` rather than inferred from
  // `LANE_PLATE_MAX_CELLS` (#2085 — the cap is `laneBodyPlan` geometry, and for
  // a video face it resolves to 2 at BOTH lane tiers): mini 1 (PRESET — which
  // visual you are looking at) · compact 2 (PRESET and REACT: which visual, and
  // how hard the audio drives it) · plate 2 · dock everything, including the
  // picker and the loader.
  face: {
    order: [
      'presetSelect', 'reactivity', 'speed', 'morph',
      // The two card affordances. They rank BELOW the params deliberately: both
      // are WIDE cells that no lane tier can paint, so ranking them higher would
      // claim lane space they cannot use.
      'milkdrop-preset-select-{n}', 'milkdrop-milk-input-{n}',
    ],

    pages: [
      {
        id: 'preset',
        label: 'preset',
        hint: 'which of the curated visuals is running, how long it takes to cross-fade when that changes, and the loader for your own .milk files. The knob, the picker, the PRESET jack and the NEXT trigger all drive the same selection',
        controls: ['presetSelect', 'milkdrop-preset-select-{n}', 'morph', 'milkdrop-milk-input-{n}'],
      },
      {
        id: 'motion',
        label: 'motion',
        hint: "how hard and how fast the picture moves: REACT scales all three drive bands at once, and SPEED time-warps butterchurn's internal clock (0 freezes it)",
        controls: ['reactivity', 'speed'],
      },
    ],

    // ⚠ MANDATORY FOR A VIDEO DEF — no `type: 'audio'` output exists, so any
    // other glyph literal falls through `glyphBinding` to `{kind:'static'}` and
    // reddens module-face-lint's dead-glyph clause. The picture arrives from
    // `hasVideoSurface(def)` and the `fullViewBody` extension instead.
    glyph: 'none',

    extension: 'milkdrop',

    // ⚠ MONITOR MODE — the fourth of the five cards #2009 named. VERIFIED
    // AGAINST THE CARD: `MilkdropCard.svelte` mounts `hideControls`, the corner
    // resize, and the double-click restore.
    monitor: {
      why:
        'MILKDROP IS the picture — it is a visualizer, so the output is not a by-product of the '
        + 'controls, it is the entire point of the module, and every control here exists to steer '
        + 'something you can only judge by watching. Its docs have advertised the monitor since it '
        + 'shipped ("hiding the controls turns it into a resizable monitor"). It is also the face '
        + 'most likely to be left running as the visual itself while a player works elsewhere in '
        + 'the rack, which is exactly what a resizable full-plate picture is for.',
    },

    // The card draws its four param controls as `<NeonFader>` throws.
    paramCells: {
      presetSelect: 'fader', reactivity: 'fader', speed: 'fader', morph: 'fader',
    },

    // ⚠ NO `hero`, NO READOUT, NO SIDEBAR — the 2026-08-19 rulings. The finding
    // that lost its surface is the preset name/index line the card prints; it is
    // re-homed as the picker's selected option, which is the honest place for it.
  },

  docs: {
    explanation: `MILKDROP is a Winamp-style Milkdrop music visualizer as a fully CV-instrumented video SOURCE. It wraps the open-source butterchurn engine (a WebGL2 reimplementation of Ryan Geiss's Milkdrop) and a curated set of ~20 classic Flexi/Geiss/Martin presets, then exposes the parts that actually drive the look as patchable CV. Patch any audio into the AUDIO input and the visuals react to it: a mono mix plus left/right channels are tapped (the audio is TAP-ONLY and inaudible — a silent gain-0 keep-alive runs the tap without routing to the speakers, so feed AUDIO OUT separately to hear it). The novel part is the per-band CV: butterchurn drives nearly all preset motion from three audio scalars — bass, mid, treb — and MILKDROP lets a cable REPLACE any of them. Patch a CV/LFO/envelope into BASS, MID, or TREB and that band is driven by the cable instead of the live audio (an unpatched band still follows the audio); the REACT control scales all three at once. SPEED is a time-warp (it scales how fast butterchurn's internal clock advances, clamped at zero — turn it down to slow the motion, up to speed it up). PRESET selects which of the curated presets is showing (a quantized index, knob or CV), MORPH sets the crossfade time when the preset changes, and a rising edge on NEXT advances to the next preset hands-free (clock it from a sequencer to switch presets in time). The output is a normal downstream video texture: route OUT into a mixer, keyer, effect, or OUTPUT. With nothing patched it still animates (the preset runs on its own clock) and shows the current preset; there is a live preview screen, and two switches beside it that do opposite things: SCREEN turns the preview off to reclaim its space (the module goes on rendering either way), and MONITOR hides the control bands so the picture has the whole plate to itself - drag the bottom-right corner to size it, and click MONITOR again to bring the controls back. Either way it is a viewport only; neither changes the output resolution. The preset name is the picker's selected entry. To LOAD/BROWSE presets directly, the faceplate has a searchable preset PICKER (a dropdown listing every curated preset by name) — picking one loads it with a MORPH-second crossfade and is the same selection the PRESET knob, the PRESET CV jack, and the NEXT trigger drive (they stay in sync). A "Load .milk…" button imports a classic Winamp Milkdrop \`.milk\` preset file straight from disk: the file is converted to butterchurn's format in the browser (via milkdrop-preset-converter) and appended to the picker for the rest of the session (custom imports are in-session only and are not saved with the patch; the curated PRESET index IS saved).`,
    inputs: {
      audio: 'AUDIO (audio cable) - the signal the visuals react to. A GainNode sink (published for the cross-domain audio bridge) fans into a mono analyser plus a left/right analyser pair (fftSize 1024, butterchurn\'s window); each frame the raw bytes are fed to the engine so it reacts to YOUR audio rather than its own internal sampler. The tap is inaudible (a silent gain-0 keep-alive keeps it running); unpatched, the analyser reads flat silence so the preset animates on its own clock. Patch a stereo or mono mix here.',
      bass: 'BASS (cv) - REPLACES the bass band the visualizer reacts to. While patched, the mapped CV value drives every preset equation that reads bass (low-frequency motion); left unpatched, the bass band follows the live AUDIO input. Centered around an "average" level so an LFO sweeps the band roughly 0..2. Scaled by REACT.',
      mid: 'MID (cv) - REPLACES the mid band (mid-frequency motion). Same replace-vs-passthrough behavior as BASS: patched = driven by the cable, unpatched = follows live audio. Scaled by REACT.',
      treb: 'TREB (cv) - REPLACES the treble band (high-frequency motion). Same replace-vs-passthrough behavior as BASS: patched = driven by the cable, unpatched = follows live audio. Scaled by REACT.',
      reactivity: 'REACT (cv) - modulates the React control, a global scalar multiplied onto all three bands (bass/mid/treb) whether they come from CV or live audio. Below 1 calms the reaction, above 1 exaggerates it.',
      speed: 'SPEED (cv) - modulates the Speed control, a time-warp on butterchurn\'s internal clock (the per-frame elapsed time is multiplied by it, clamped at zero). Turn it down for slow-motion warp, up for faster motion; 0 freezes the animation.',
      presetSelect: 'PRESET (cv) - modulates the Preset control, a quantized index into the curated preset list. A sweep selects across the presets; when the rounded index changes, that preset is loaded with a MORPH-second crossfade.',
      morph: 'MORPH (cv) - modulates the Morph control, the crossfade time in seconds used when the preset changes (via PRESET, NEXT, or the card). 0 = hard cut, higher = a slow blend between presets.',
      next: 'NEXT (gate cable, edge:trigger) - a rising edge (crossing above mid-scale) advances to the NEXT preset in the curated list (wrapping), crossfading over MORPH seconds. Routed through the CV bridge as the synthetic nextTrig param and edge-detected per frame (fires once per rising edge, not while held). Patch a clock to switch presets in time.',
    },
    outputs: {
      out: 'OUT (video) - the rendered visualizer frame, upscaled to the engine output resolution. A normal downstream-usable video texture: chain it into any video input (mixer / keyer / effect / OUTPUT) and it also drives the faceplate\'s preview screen.',
    },
    controls: {
      'milkdrop-preset-select-{n}': 'Preset picker - a dropdown listing every preset by NAME: the ~20 curated ones plus any .milk files imported this session. Picking one loads it with a MORPH-second crossfade. It writes the same `presetSelect` value the PRESET knob, the PRESET CV jack and the NEXT trigger drive, so the selection stays in sync everywhere and is saved with the patch. It is also the only surface on which the preset NAMES appear at all — the knob and the CV jack address presets by index.',
      'milkdrop-milk-input-{n}': 'Load .milk preset - imports a classic Winamp Milkdrop `.milk` preset file from disk. The file is converted to butterchurn\'s format in the browser (milkdrop-preset-converter) and APPENDED to the picker for the rest of the session, then loaded with a MORPH-second crossfade; a status line reports progress or the failure. Custom imports are in-session only and are NOT saved with the patch (the curated PRESET index IS), so a reloaded rack returns to the curated list.',
      bass: 'Bass (0..2, default 1) - CV-only band override TARGET (no panel knob; the BASS jack writes it). When the BASS input is patched the mapped value REPLACES the bass band the visuals react to; unpatched, the live audio bass flows through. 1 is the "average" level.',
      mid: 'Mid (0..2, default 1) - CV-only band override target for the mid band (no panel knob; the MID jack writes it). Patched = the cable replaces the mid band; unpatched = live audio. 1 is the "average" level.',
      treb: 'Treble (0..2, default 1) - CV-only band override target for the treble band (no panel knob; the TREB jack writes it). Patched = the cable replaces the treble band; unpatched = live audio. 1 is the "average" level.',
      reactivity: 'React (0..2, default 1) - global reaction scalar multiplied onto all three bands (CV-driven or live). 1 = as-is, below 1 calms, above 1 exaggerates the audio reactivity. CV via the REACT jack; also a panel knob.',
      speed: 'Speed (0..2, default 1) - time-warp on the visualizer\'s internal clock: the per-frame elapsed time is multiplied by this (clamped at 0). 1 = normal, 0 = frozen, 2 = double-speed motion. CV via the SPEED jack; also a panel knob.',
      presetSelect: 'Preset (0..19, default 0) - selects the active preset by index into the curated ~20-preset list (rounded/quantized). Changing it loads that preset with a MORPH-second crossfade; the faceplate prints the current preset name + index. CV via the PRESET jack; also a panel knob.',
      morph: 'Morph (0..8 s, default 2) - crossfade time in seconds used whenever the preset changes (PRESET knob/CV, NEXT trigger, or the card). 0 = hard cut, larger = slow blend. CV via the MORPH jack; also a panel knob.',
      nextTrig: 'Next Trig (0..1, default 0) - hidden synthetic edge-detector param. The CV bridge writes the NEXT gate level here and the module edge-detects a rising crossing of mid-scale to advance to the next preset. Not a user-facing knob (drive the NEXT jack instead).',
    },
  },

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    let disposed = false;

    // ── Output target: engine-res FBO (managed → auto-resizes on aspect switch),
    //    plus a small source texture butterchurn's canvas uploads into, plus a
    //    copy program that upscales the source into the FBO each frame. ──
    const { fbo, texture } = ctx.createFbo();
    const copyProgram = ctx.compileFragment(COPY_FRAG_SRC);
    const uTex = gl.getUniformLocation(copyProgram, 'uTex');

    const srcTex = gl.createTexture();
    if (!srcTex) throw new Error('MILKDROP: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    let srcAllocated = false;

    // ── butterchurn visualizer on its OWN 2D output canvas (it owns a separate
    //    internal WebGL2 context). Needs an AudioContext: prefer the engine's
    //    shared one (so the audio tap lives in the same graph); else a standalone
    //    one (no cross-domain audio possible, but the engine still animates). ──
    const audioCtx: BaseAudioContext | null =
      ctx.audioCtx ??
      (typeof AudioContext !== 'undefined' ? new AudioContext() : null);

    const bcCanvas: OffscreenCanvas | HTMLCanvasElement | null =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(BC_W, BC_H)
        : typeof document !== 'undefined'
          ? Object.assign(document.createElement('canvas'), { width: BC_W, height: BC_H })
          : null;

    // The visualizer is created LAZILY in the async init below (the engine
    // import must stay lazy — see the top-of-file note).
    let viz: ButterchurnVisualizer | null = null;

    // ── CV instrumentation state: band overrides spliced into the live
    //    AudioLevels getters. ov[band] != null → CV value (× reactivity); else
    //    the real computed value (× reactivity for the val bands). ──
    const ov: Record<BandKey, number | null> = {
      bass: null, mid: null, treb: null, bass_att: null, mid_att: null, treb_att: null,
    };
    const params: MilkdropParams = { ...DEFAULTS, ...(node.params as Partial<MilkdropParams>) };

    /** Redefine the AudioLevels getters on the live instance to consult `ov`. */
    function installOverrides(v: ButterchurnVisualizer): void {
      try {
        const al = v.renderer.audioLevels as unknown as Record<string, number>;
        const proto = Object.getPrototypeOf(al);
        for (const k of BAND_KEYS) {
          const desc = Object.getOwnPropertyDescriptor(proto, k);
          const real = desc?.get;
          if (!real) continue;
          const scaled = k === 'bass' || k === 'mid' || k === 'treb';
          Object.defineProperty(al, k, {
            configurable: true,
            get(): number {
              const o = ov[k];
              const base = o != null ? o : real.call(this);
              return scaled ? base * params.reactivity : base;
            },
          });
        }
      } catch (e) {
        console.warn('[milkdrop] could not install AudioLevels CV overrides:', e);
      }
    }

    // Per-frame band-override dirty tracking: the CV bridge calls setParam(<band>)
    // ONLY while a cable is patched, so "written since the last draw" == "patched".
    const bandPending: Record<(typeof BANDS)[number], number> = { bass: 0, mid: 0, treb: 0 };
    const bandDirty: Record<(typeof BANDS)[number], boolean> = { bass: false, mid: false, treb: false };

    // ── Audio tap (cross-domain audio → video). Only when sharing the engine's
    //    AudioContext (else there's nothing to patch from). ──
    const timeByteArray = new Uint8Array(FFT_SIZE);
    const timeByteArrayL = new Uint8Array(FFT_SIZE);
    const timeByteArrayR = new Uint8Array(FFT_SIZE);
    let analyser: AnalyserNode | null = null;
    let analyserL: AnalyserNode | null = null;
    let analyserR: AnalyserNode | null = null;
    let sink: GainNode | null = null;
    let splitter: ChannelSplitterNode | null = null;
    let keepAlive: GainNode | null = null;
    let audioInputs: Map<string, { node: AudioNode; input: number }> | undefined;
    if (ctx.audioCtx) {
      const ac = ctx.audioCtx;
      sink = ac.createGain();
      analyser = ac.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0;
      analyserL = ac.createAnalyser();
      analyserL.fftSize = FFT_SIZE;
      analyserL.smoothingTimeConstant = 0;
      analyserR = ac.createAnalyser();
      analyserR.fftSize = FFT_SIZE;
      analyserR.smoothingTimeConstant = 0;
      splitter = ac.createChannelSplitter(2);
      sink.connect(analyser); // down-mixed mono window
      sink.connect(splitter);
      splitter.connect(analyserL, 0);
      splitter.connect(analyserR, 1);
      // Silent keep-alive so the tap subgraph is always pulled (gain 0 = inaudible).
      keepAlive = ac.createGain();
      keepAlive.gain.value = 0;
      analyser.connect(keepAlive);
      try { keepAlive.connect(ac.destination); } catch { /* offline/test ctx */ }
      audioInputs = new Map([['audio', { node: sink, input: 0 }]]);
    }

    // ── Curated preset list + first-preset load (async dynamic chunk). ──
    let presetList: Array<{ name: string; preset: unknown }> = [];
    let presetLoaded = false;
    let currentIndex = Math.max(0, Math.min(CURATED_COUNT - 1, Math.round(params.presetSelect)));
    let currentName = '';
    let loadSeq = 0; // guards against a stale async load winning over a newer one

    async function loadByIndex(index: number, blendSeconds: number): Promise<void> {
      if (!viz || presetList.length === 0) return;
      const i = ((index % presetList.length) + presetList.length) % presetList.length;
      const entry = presetList[i]!;
      const seq = ++loadSeq;
      try {
        await viz.loadPreset(entry.preset, Math.max(0, blendSeconds));
      } catch (e) {
        console.warn('[milkdrop] loadPreset failed:', e);
        return;
      }
      if (disposed || seq !== loadSeq) return; // a newer load superseded this one
      currentIndex = i;
      currentName = entry.name;
      presetLoaded = true;
    }

    /** Append a user-loaded CUSTOM preset (already converted to butterchurn JSON
     *  by the card via milkdrop-preset-converter) to the in-session list and
     *  load it. In-session only — the converted bytes are NOT written to the
     *  Y.Doc, so a custom preset is lost on reload (the curated index DOES
     *  persist via the presetSelect param). Returns the new entry's index so the
     *  card can reflect/re-select it. Exposed to the card via
     *  read('loadCustomPreset'). */
    function loadCustomPreset(preset: unknown, name: string, blendSeconds: number): number {
      if (preset == null) return -1;
      const label = name && name.trim() ? name.trim() : `custom ${presetList.length + 1}`;
      presetList.push({ name: label, preset });
      const idx = presetList.length - 1;
      void loadByIndex(idx, Math.max(0, blendSeconds));
      return idx;
    }

    if (audioCtx && bcCanvas) {
      void (async () => {
        try {
          // Lazy-load the engine + the curated preset pack as a separate chunk
          // (both keep `@webamp/butterchurn`'s window-touching module-eval out of
          // node-env tests / SSR and out of the main bundle).
          const [engineMod, presetMod] = await Promise.all([
            import('@webamp/butterchurn'),
            import('butterchurn-presets/lib/butterchurnPresetsMinimal.min.js'),
          ]);
          if (disposed) return;
          const butterchurn = engineMod.default;
          viz = butterchurn.createVisualizer(audioCtx, bcCanvas as HTMLCanvasElement, {
            width: BC_W,
            height: BC_H,
            meshWidth: MESH_W,
            meshHeight: MESH_H,
            pixelRatio: 1,
            textureRatio: 1,
          });
          viz.setInternalMeshSize(MESH_W, MESH_H);
          installOverrides(viz);

          const lib = (presetMod.default ?? (presetMod as unknown)) as { getPresets(): Record<string, unknown> };
          const all = lib.getPresets();
          presetList = CURATED_ORDER
            .map((name) => ({ name, preset: all[name] }))
            .filter((e): e is { name: string; preset: unknown } => e.preset != null);
          if (presetList.length === 0) {
            // Pack drift — fall back to whatever the pack ships.
            presetList = Object.entries(all).map(([name, preset]) => ({ name, preset }));
          }
          if (disposed) return;
          await loadByIndex(currentIndex, 0);
        } catch (e) {
          console.warn('[milkdrop] butterchurn init failed:', e);
        }
      })();
    }

    // ── `next` trigger edge detector (per-frame scalar, NOT a whole-AnalyserNode
    //    rescan — the gate arrives as one setParam value per frame via the CV
    //    bridge, so the shared rising-edge primitive fed one sample/frame is the
    //    correct + canonical detector here, as in the video-module precedent). ──
    const nextEdge = createRisingEdgeDetector(GATE_HI);
    const nextSample = new Float32Array(1);

    function fillSyntheticAudio(): void {
      // Fixed deterministic sine (one period across the window) so the DRS gets
      // an audio-reactive, non-black, structured frame with no live source.
      for (let i = 0; i < FFT_SIZE; i++) {
        const s = Math.sin((i / FFT_SIZE) * Math.PI * 2 * 8);
        const b = Math.round(128 + s * 110);
        timeByteArray[i] = b;
        timeByteArrayL[i] = b;
        timeByteArrayR[i] = b;
      }
    }

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        if (disposed || !viz || !presetLoaded || !bcCanvas) return;

        // 1. Audio bytes → either the live tap or the deterministic test sine.
        if (testAudioOn()) {
          fillSyntheticAudio();
        } else if (analyser && analyserL && analyserR) {
          analyser.getByteTimeDomainData(timeByteArray);
          analyserL.getByteTimeDomainData(timeByteArrayL);
          analyserR.getByteTimeDomainData(timeByteArrayR);
        } else {
          timeByteArray.fill(128);
          timeByteArrayL.fill(128);
          timeByteArrayR.fill(128);
        }

        // 2. Resolve per-frame band overrides (dirty == patched this frame).
        for (const band of BANDS) {
          if (bandDirty[band]) {
            ov[band] = bandPending[band];
            bandDirty[band] = false;
          } else {
            ov[band] = null;
          }
        }

        // 3. elapsedTime → speed/time-warp (clamped ≥ 0). Fixed under the DRS.
        const fd = fixedDelta();
        const baseDelta = fd != null ? fd : frame.timeDelta ?? 1 / 60;
        const elapsed = Math.max(0, baseDelta * params.speed);

        // 4. Render butterchurn into its own context + blit to bcCanvas.
        try {
          viz.render({
            audioLevels: { timeByteArray, timeByteArrayL, timeByteArrayR },
            elapsedTime: elapsed,
          });
        } catch (e) {
          console.warn('[milkdrop] render failed:', e);
          return;
        }

        // 5. Upload bcCanvas → srcTex (UNPACK_FLIP_Y matches the video-frame
        //    upload convention → upright downstream).
        g.bindTexture(g.TEXTURE_2D, srcTex);
        g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, true);
        g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        try {
          if (!srcAllocated) {
            g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, bcCanvas as TexImageSource);
            srcAllocated = true;
          } else {
            g.texSubImage2D(g.TEXTURE_2D, 0, 0, 0, g.RGBA, g.UNSIGNED_BYTE, bcCanvas as TexImageSource);
          }
        } catch (e) {
          g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
          console.warn('[milkdrop] canvas upload failed:', e);
          return;
        }
        g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);

        // 6. Copy-upscale srcTex → the engine-res `out` FBO.
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.disable(g.BLEND);
        g.useProgram(copyProgram);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, srcTex);
        if (uTex) g.uniform1i(uTex, 0);
        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteTexture(srcTex);
        gl.deleteProgram(copyProgram);
      },
    };

    return {
      domain: 'video',
      surface,
      audioInputs,
      setParam(paramId, value) {
        if (paramId === 'bass' || paramId === 'mid' || paramId === 'treb') {
          // Band override: store + mark patched-this-frame (draw consumes it).
          bandPending[paramId] = value;
          bandDirty[paramId] = true;
          params[paramId] = value;
          return;
        }
        if (paramId === 'next' || paramId === 'nextTrig') {
          // Gate level → per-frame rising-edge detect → advance preset.
          params.nextTrig = value;
          nextSample[0] = value;
          const edges = nextEdge.scan(nextSample, 0, 1);
          if (edges > 0 && presetLoaded) void loadByIndex(currentIndex + 1, params.morph);
          return;
        }
        if (paramId === 'presetSelect') {
          params.presetSelect = value;
          const idx = Math.max(0, Math.min((presetList.length || CURATED_COUNT) - 1, Math.round(value)));
          if (idx !== currentIndex && presetLoaded) void loadByIndex(idx, params.morph);
          else currentIndex = idx;
          return;
        }
        if (paramId in params) {
          (params as unknown as Record<string, number>)[paramId] = value;
        }
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        if (key === 'fboTexture') return texture;
        if (key === 'outputTexture:out') return texture;
        if (key === 'ready') return presetLoaded;
        if (key === 'presetIndex') return currentIndex;
        if (key === 'presetName') return currentName;
        if (key === 'presetCount') return presetList.length || CURATED_COUNT;
        // The LIVE preset names (curated, pack-drift-filtered, + in-session
        // customs) in presetList order — the picker's dropdown source once the
        // lazy pack chunk has resolved. Empty before then (card falls back to
        // MILKDROP_CURATED_NAMES). Re-read by the card only when presetCount
        // changes (not per frame), so the per-call array alloc is cheap.
        if (key === 'presetNames') return presetList.map((e) => e.name);
        // A stable command closure: convert-then-append a custom .milk preset.
        // The card calls it on file pick (NOT per frame).
        if (key === 'loadCustomPreset') return loadCustomPreset;
        return undefined;
      },
      dispose() {
        disposed = true;
        surface.dispose();
        try { keepAlive?.disconnect(); } catch { /* */ }
        try { analyser?.disconnect(); } catch { /* */ }
        try { analyserL?.disconnect(); } catch { /* */ }
        try { analyserR?.disconnect(); } catch { /* */ }
        try { splitter?.disconnect(); } catch { /* */ }
        try { sink?.disconnect(); } catch { /* */ }
        // If we created a STANDALONE AudioContext (engine had none), close it.
        if (!ctx.audioCtx && audioCtx && 'close' in audioCtx) {
          try { void (audioCtx as AudioContext).close(); } catch { /* */ }
        }
        viz = null;
      },
    };
  },
};
