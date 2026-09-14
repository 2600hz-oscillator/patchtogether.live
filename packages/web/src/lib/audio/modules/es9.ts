// ES-9 — full 16×16 audio+CV I/O with a real Eurorack system, via the
// es9-bridge NATIVE companion app (repo: patchtogether.es9). The browser
// cannot do this alone: getUserMedia caps the ES-9 at its first stereo pair
// and setSinkId picks whole devices, never channel ranges (empirically
// verified — see audioin.ts +). The native
// app owns CoreAudio (16-in/16-out, one clock, DC-coupled ±10 V jacks,
// bit-transparent) and serves a localhost WebSocket; this module is its
// in-graph face.
//
// NOTE — decision of record: es9-stereo-io.md recorded a "no native
// companion apps" stance (feedback_no_native_helper_apps). The owner
// explicitly reversed that for the ES-9 on 2026-07-09; this module + the
// native bridge are that reversal. The bridge stays an arm's-length separate
// process speaking a documented protocol (constants duplicated in
// $lib/audio/es9/es9-protocol.ts, never imported across repos).
//
// ARCHITECTURE (nothing audio-rate touches the main thread):
//
//   ws://127.0.0.1:9209/ws ◀──▶ bridge Worker ◀── SAB rings ──▶ 'es9-bridge'
//        (native app)          (es9/bridge.worker.ts)          AudioWorklet
//                                                              (packages/dsp)
//
// ⚠ THE CONNECTION IS OWNED HERE, BY THE ENGINE NODE — not by any view.
// This paragraph used to say "The CARD (Es9Card.svelte) owns the connection
// lifecycle", and it had been false since ownership moved to
// $lib/audio/es9/bridge-owner: see the factory below, which acquires the
// bridge and releases it in dispose(). The stale sentence mattered because a
// faceplate-body author reading this header would have built the wrong
// lifetime — the exact defect bridge-owner exists to prevent. The
// __es9Attach handle hook survives as the audioin.ts card/engine seam for a
// view that already holds ring specs; nothing in the product uses it today,
// and this factory stays DOM-free and jsdom-testable either way.
//
// SIGNALS + the per-jack CLASS model: the wire carries RAW hardware floats
// (±1.0 ≙ ±10 V, the ES-9's full scale). The app's audio unity is Eurorack
// NOMINAL — ±1.0 in the graph ≙ ±5 V at a DC-coupled jack, the same scale as
// cv — so the worklet scales the audio port ×2 on the way in and ×0.5 on the
// way out (ADR-019; until 2026-09-14 audio was ×1 and hardware arrived 6 dB
// under every internal module). Each DC jack ALSO carries a REFERENCE toggle
// (`in{n}_ref` / `out{n}_ref`, modular | line; ADR-020, owner 2026-09-14
// "add a toggle on the card to set it to line per jack"): under `line` the
// audio class means ±1.0 ≙ +4 dBu (1.228 V RMS = 1.736 V peak), ×5.76 in and
// ×0.174 out, so line-level gear reaches the same unity. Only the audio class
// reads it; cv/pitch/gate carry volts. Because canConnect() forbids one port
// serving both the audio and cv families, each hardware INPUT jack 1-14
// exposes TWO ports — an `audio` port (±5 V → ±1.0) and a class-scaled `cv`
// twin (cv ×2 = ±5 V→±1, the same scale; pitch ×10 = 1 V/oct→1.0/oct with
// 0 V ≙ C4; gate = hysteresis comparator →0|1). The 16 browser→hardware
// channels are single `audio` ports widened with accepts:['cv','pitch','gate']
// (the scope.ts/scaler.ts precedent), inverse-scaled per their class param
// on the 8 physical jacks; usb1-8 and the S/PDIF returns (USB in 15/16) are
// digital (0 dBFS = 1.0, passed ×1) — audio only, no cv twin.
//
// OUTPUT-DIRECTION CHANNEL MAP (hardware-verified + ES-9 manual §Routing):
// under the ES-9's DEFAULT routing the 8 physical DC-coupled jacks are
// driven by USB/DAW channels 9-16 — NOT 1-8. USB 1-8 feed the internal
// blocks instead (1-2 main outs, 3-4 phones, 5-6 S/PDIF, 7-8 the ES-5
// header; all AC-coupled → audio only). So the module's out1-8 jack ports
// map to worklet inputs 8..15 and usb1-8 to worklet inputs 0..7.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ModuleFace, ParamDef, ParamOption, PortDef } from '$lib/graph/types';
import type { RingSpec } from '$lib/audio/es9/es9-ring';
import {
  acquireEs9Bridge,
  releaseEs9Bridge,
  updateEs9Config,
  type Es9BridgeConfigLike,
} from '$lib/audio/es9/bridge-owner';
import workletUrl from '@patchtogether.live/dsp/dist/es9-bridge.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
const PROCESSOR_NAME = 'es9-bridge';
const loadedContexts = new WeakSet<BaseAudioContext>();

/** Signal classes — MUST mirror packages/dsp/src/lib/es9-bridge-core.ts
 *  (0=audio ±5 V↔±1, 1=cv ±5 V↔±1, 2=pitch 1 V/oct↔1.0/oct, 3=gate 0|1↔0/+5 V). */
export const ES9_CLASS_AUDIO = 0;
export const ES9_CLASS_CV = 1;
export const ES9_CLASS_PITCH = 2;
export const ES9_CLASS_GATE = 3;
export const ES9_CLASS_NAMES = ['audio', 'cv', 'pitch', 'gate'] as const;

/**
 * The four signal classes as a param ROSTER — DERIVED from `ES9_CLASS_NAMES`,
 * never re-typed, so the names the face paints and the names the worklet
 * indexes cannot drift.
 *
 * ⚠ THIS IS ABOUT SELECTABILITY, NOT LABELS. A `0..3 discrete` param with no
 * roster falls through `paramCellKind` to a KNOB, and a four-state switch
 * drawn as a dial is a control a drag quantises straight back to where it
 * started (`moog962` shipped that way and `faces-parity` failed it twice). A
 * roster makes `paramCellKind` derive a SEGMENTED cell at the dock, where each
 * state is one press.
 *
 * ⚠ AND `optionsExhaustive` MUST NOT BE DECLARED HERE. `0..3 discrete` has
 * four steps and the roster has four members, so it is DENSE —
 * `param-vocabulary` refuses a redundant declaration by name ("roster covers
 * every step … so optionsExhaustive is redundant — delete it"), and there is
 * no between-member value for `snapToOptions` to repair. The SNAP contract
 * keys on the DECLARATION, not on "discrete with options".
 *
 * Cosmetic, like every roster: `serializeModuleContract` projects
 * id/min/max/curve/defaultValue/units and nothing else, so these 22 rosters
 * cost zero contract-lock lines.
 */
export const ES9_CLASS_OPTIONS: readonly ParamOption[] = ES9_CLASS_NAMES.map(
  (label, value) => ({ value, label }),
);

/** Per-jack audio REFERENCE — MUST mirror packages/dsp/src/lib/es9-bridge-core.ts
 *  REF_MODULAR / REF_LINE (0 = modular: ±1.0 ≙ ±5 V, the default and
 *  today's behaviour; 1 = line: ±1.0 ≙ +4 dBu = 1.736 V peak). Owner,
 *  2026-09-14: "can we do eurorack nominal but add a toggle on the card to
 *  set it to line per jack" (ADR-020). Only the AUDIO class reads it. */
export const ES9_REF_MODULAR = 0;
export const ES9_REF_LINE = 1;
export const ES9_REF_NAMES = ['modular', 'line'] as const;
/** The two references as a param ROSTER — derived like `ES9_CLASS_OPTIONS`
 *  and for the same reason (a 2-option roster paints two captioned buttons at
 *  the dock, not an anonymous switch). Dense: 2 options / 2 steps, so
 *  `optionsExhaustive` must NOT be declared. */
export const ES9_REF_OPTIONS: readonly ParamOption[] = ES9_REF_NAMES.map(
  (label, value) => ({ value, label }),
);

const HW_CHANNELS = 16;
const CV_TWIN_BASE = 16;
/** DC-coupled input jacks (with cv twins); 15/16 are the S/PDIF return.
 *  MIRRORED in packages/dsp/src/lib/es9-bridge-core.ts (DC_INPUT_JACKS),
 *  where the worklet's audio-scaling guard reads it. */
const DC_INPUT_JACKS = 14;
/** DC-coupled output jacks. */
const DC_OUTPUT_JACKS = 8;
/** First USB output channel (0-based) that drives a physical jack: the
 *  ES-9's DEFAULT routing puts the 8 jacks on USB/DAW channels 9-16
 *  (manual §Routing; hardware-verified) — USB 1-8 feed the internal
 *  mixer (main/phones), S/PDIF, and the ES-5 header. MIRRORED in
 *  packages/dsp/src/lib/es9-bridge-core.ts (JACK_CHANNEL_BASE). */
const JACK_CHANNEL_BASE = 8;

/** The 22 reference ids, DERIVED from the jack counts (never hand-listed):
 *  es9.test.ts pins them equal to the `_ref` members of `es9Def.params` (the
 *  literal lines below), and module-face-lint's ACKNOWLEDGED_LATCHING spreads
 *  them. Sits after the jack counts on purpose — a `const` read before its
 *  declaration is a TDZ ReferenceError at module load. */
export const ES9_REF_PARAM_IDS: readonly string[] = [
  ...Array.from({ length: DC_INPUT_JACKS }, (_, i) => `in${i + 1}_ref`),
  ...Array.from({ length: DC_OUTPUT_JACKS }, (_, i) => `out${i + 1}_ref`),
];

/** Payload the card hands across on connect (null = detach). */
export interface Es9AttachPayload {
  inRing: RingSpec;   // hardware → graph
  outRing: RingSpec;  // graph → hardware
}

// ---- ports (LITERAL arrays on purpose: the docs-site manifest extractor
// is a regex over source text and can't see computed builders — see
// module-manifest.ts synthesizeFromBuildHelper's warning) -----------------


/** Derive the worklet's 16-wide class arrays from the node's params. */
export function es9ClassesFromParams(params: Record<string, number> | undefined): {
  inClasses: number[];
  outClasses: number[];
} {
  const p = params ?? {};
  const inClasses: number[] = [];
  const outClasses: number[] = [];
  for (let c = 0; c < HW_CHANNELS; c++) {
    inClasses.push(
      c < DC_INPUT_JACKS ? (p[`in${c + 1}_class`] ?? ES9_CLASS_CV) : ES9_CLASS_AUDIO,
    );
    // The PHYSICAL jacks (out1-8 ports / out{n}_class params) live on USB
    // channels 9-16 — i.e. channel index 8 + (n-1). Channels 0-7 are the
    // internal mixer / S-PDIF / ES-5 feeds: always plain audio.
    outClasses.push(
      c >= JACK_CHANNEL_BASE
        ? (p[`out${c - JACK_CHANNEL_BASE + 1}_class`] ?? ES9_CLASS_AUDIO)
        : ES9_CLASS_AUDIO,
    );
  }
  return { inClasses, outClasses };
}

/** Derive the worklet's 16-wide audio-REFERENCE arrays from the node's
 *  params (sibling of `es9ClassesFromParams`; same channel map). Absent ids
 *  default to modular, so a rack saved before ADR-020 reads exactly as it
 *  did. The S/PDIF return (14/15) and the USB 1-8 feeds (0..7) are digital
 *  and always emit modular here — the worklet's jack-kind guards ignore the
 *  value on those channels anyway. */
export function es9RefsFromParams(params: Record<string, number> | undefined): {
  inRefs: number[];
  outRefs: number[];
} {
  const p = params ?? {};
  const inRefs: number[] = [];
  const outRefs: number[] = [];
  for (let c = 0; c < HW_CHANNELS; c++) {
    inRefs.push(c < DC_INPUT_JACKS ? (p[`in${c + 1}_ref`] ?? ES9_REF_MODULAR) : ES9_REF_MODULAR);
    outRefs.push(
      c >= JACK_CHANNEL_BASE
        ? (p[`out${c - JACK_CHANNEL_BASE + 1}_ref`] ?? ES9_REF_MODULAR)
        : ES9_REF_MODULAR,
    );
  }
  return { inRefs, outRefs };
}

/**
 * The bridge-side underrun modes for the config message.
 *
 * The wire protocol has exactly two policies, and the mapping is a SAFETY
 * choice per class, not a cosmetic one:
 *
 *   'cv'    HOLD the last voltage. Right for a LEVEL — a pitch that collapsed
 *           to 0 V (= C4) on a dropout would be a wrong note, and holding the
 *           last value is inaudible for a slow modulation.
 *   'audio' FADE to silence. Right for anything where a frozen value is itself
 *           a wrong output.
 *
 * ⚠ GATE JACKS FAIL LOW, and this is deliberate (owner-reported 2026-08-07:
 * Pam's New Workout not locking cleanly to CV Buddy's clock, with a Mandala
 * MK2 downstream of Pam's dropping triggers).
 *
 * Gate was previously lumped in with the CV-ish classes and therefore HELD. A
 * clock pulse is only ~5 ms high, so a stream hiccup that lands inside one
 * freezes the jack at +5 V until samples resume — the downstream gear sees one
 * long gate instead of a pulse train, gets no rising edges for the duration,
 * and a Pam's driving further dividers loses every derived trigger. A held
 * gate does not merely lose information; it EMITS A WRONG SUSTAINED SIGNAL —
 * a stuck note, a stuck envelope, a clock that stopped.
 *
 * Failing low loses at most the pulses inside the hiccup, which is the
 * graceful failure, so gate takes the fade policy. Pitch and CV still hold.
 */
export function es9OutputModes(params: Record<string, number> | undefined): Record<string, 'audio' | 'cv'> {
  const { outClasses } = es9ClassesFromParams(params);
  const modes: Record<string, 'audio' | 'cv'> = {};
  for (let c = 0; c < HW_CHANNELS; c++) {
    const cls = outClasses[c];
    // HOLD only for the level-carrying classes; gate and audio both fail low.
    modes[String(c)] = cls === ES9_CLASS_CV || cls === ES9_CLASS_PITCH ? 'cv' : 'audio';
  }
  return modes;
}

/**
 * The whole bridge CONFIG message for a node's current params — the channel
 * masks plus the per-jack underrun policy.
 *
 * ⚠ ONE BUILDER, BECAUSE TWO OF THEM IS THE BUG THAT WAS ALREADY LIVE. The
 * factory built this inline at acquire time and `Es9Card.svelte` built its own
 * copy at selector-change time, and only the card's ever reached
 * `updateEs9Config` — on a card the default shell has not mounted in a lane
 * since ownership moved to the engine node. So on the renderer every user
 * actually gets, the native app kept whatever failure policy it was handed at
 * NODE CONSTRUCTION, and neither a class change nor the CV-Buddy janitor's
 * `out{N}_class` writes (which go straight through the store under
 * `CVBUDDY_JANITOR_ORIGIN` and touch no card at all) ever moved it. That is
 * safety-relevant by this file's own words: a jack left on a HOLD policy
 * freezes its last voltage on a stream hiccup, which for a gate is a stuck
 * note or a stopped clock. `setParam` below now pushes it, so the policy
 * follows the param wherever the param is written from.
 *
 * v1 subscribes/drives all channels — loopback bandwidth is trivial and it
 * keeps the masks decoupled from patch-edge churn.
 */
export function es9BridgeConfig(params: Record<string, number> | undefined): Es9BridgeConfigLike {
  return {
    inputChannels: Array.from({ length: HW_CHANNELS }, (_, c) => c),
    outputChannels: Array.from({ length: HW_CHANNELS }, (_, c) => c),
    outputModes: es9OutputModes(params),
  };
}

// ---- docs (STRICT_DOCS: every port + control documented) ----------------

function inputDocs(): Record<string, string> {
  const docs: Record<string, string> = {};
  for (let n = 1; n <= DC_OUTPUT_JACKS; n++) {
    docs[`out${n}`] =
      `To ES-9 physical output jack ${n} (DC-coupled, ±10 V; USB channel ${8 + n} under the ES-9's default routing). Takes audio or any CV-family signal; the Out ${n} class selector sets the voltage scaling (audio = ±1 → ±5 V, or ±1 → ±1.736 V with Out ${n} ref set to line for a line-level input; cv = ±1 → ±5 V, pitch = 1.0/oct → 1 V/oct, gate = 0|1 → 0/+5 V) and how the jack fails if the browser stream hiccups (cv and pitch HOLD their last voltage, since a collapsed pitch is a wrong note; gate and audio fall to zero, since a frozen gate is a stuck note or a stopped clock).`;
  }
  const usbDefault: Record<number, string> = {
    1: 'the main outputs (via internal mix 1) and phones',
    2: 'the main outputs (via internal mix 2) and phones',
    3: 'the headphone mix (internal mix 3)',
    4: 'the headphone mix (internal mix 4)',
    5: 'the S/PDIF output (left)',
    6: 'the S/PDIF output (right)',
    7: 'the ES-5 expansion header (left)',
    8: 'the ES-5 expansion header (right)',
  };
  for (let n = 1; n <= 8; n++) {
    docs[`usb${n}`] =
      `To ES-9 USB channel ${n} — under the default routing this feeds ${usbDefault[n]}, NOT a rear jack (re-routable in the ES-9 config tool). Audio-rate: these destinations are AC-coupled, so send audio here, not CV.`;
  }
  return docs;
}

function outputDocs(): Record<string, string> {
  const docs: Record<string, string> = {};
  for (let n = 1; n <= DC_INPUT_JACKS; n++) {
    docs[`in${n}`] =
      `ES-9 hardware input jack ${n} as audio: float ±1.0 is ±5 V at the jack (Eurorack nominal, the same unity as every internal module; the jack's ±10 V full scale reads as ±2.0; +4 dBu line level reads about ±0.35 — or set In ${n} ref to line and +4 dBu reads ±1.0 instead). This is the audio-typed port — patch it to mixers, effects, AUDIO OUT, or a SCOPE.`;
    docs[`in${n}_cv`] =
      `ES-9 input jack ${n} as CV, scaled by the In ${n} class selector: cv maps ±5 V to the app's ±1 modulation range, pitch maps 1 V/oct onto the app's 1.0/oct (0 V ≙ C4), gate runs a 2 V/1 V hysteresis comparator and emits clean 0|1. Patch this twin into cv/pitch/gate inputs — e.g. a hardware Maths LFO into a filter's cutoff CV.`;
  }
  docs['spdif_l'] =
    'Left channel of the ES-9 S/PDIF return (USB input 15). Digital audio — AC-coupled by nature, so no CV twin.';
  docs['spdif_r'] =
    'Right channel of the ES-9 S/PDIF return (USB input 16). Digital audio — AC-coupled by nature, so no CV twin.';
  return docs;
}

function controlDocs(): Record<string, string> {
  const docs: Record<string, string> = {};
  for (let n = 1; n <= DC_INPUT_JACKS; n++) {
    docs[`in${n}_class`] =
      `Signal class for input jack ${n}'s CV twin port (audio/cv/pitch/gate; default cv). Sets how hardware volts map onto app units on in${n}_cv: cv = ±5 V → ±1, pitch = 1 V/oct → 1.0/oct (0 V ≙ C4), gate = hysteresis comparator (rise ≥2 V, fall <1 V) → 0|1, audio = the same scaling as the audio port, ±5 V → ±1 or, with In ${n} ref set to line, 1.736 V → ±1 (they differ only in how the twin fails on a stream hiccup: audio fades, cv holds). The audio in${n} port ignores this selector and carries ±5 V → ±1, or ±1.736 V → ±1 with its ref set to line.`;
  }
  for (let n = 1; n <= DC_INPUT_JACKS; n++) {
    docs[`in${n}_ref`] =
      `Voltage reference for input jack ${n}'s AUDIO scaling (modular/line; default modular). modular: ±5 V at the jack reads ±1.0 (Eurorack nominal, the same unity as every internal module). line: +4 dBu (1.228 V RMS = 1.736 V peak) reads ±1.0, 9.2 dB of gain for line-level gear such as a mixer, interface or synth line out. Applies to the audio in${n} port and to in${n}_cv only when its class is audio; cv, pitch and gate twins carry volts and ignore it. Set it once for the gear on the jack and leave it.`;
  }
  for (let n = 1; n <= DC_OUTPUT_JACKS; n++) {
    docs[`out${n}_class`] =
      `Signal class for hardware output jack ${n} (audio/cv/pitch/gate; default audio). Sets the inverse voltage mapping for signals patched into out${n} (cv = ±1 → ±5 V, pitch = 1.0/oct → 1 V/oct, gate = 0|1 → 0/+5 V, audio = ±1 → ±5 V, the same scaling as cv, or ±1 → ±1.736 V with Out ${n} ref set to line) AND the bridge's failure policy for the jack on a stream hiccup: cv and pitch HOLD their last voltage (a pitch collapsing to 0 V would be a wrong note), while gate and audio FALL TO ZERO (a frozen gate is a stuck note or a stalled clock, which is worse than a dropped pulse).`;
  }
  for (let n = 1; n <= DC_OUTPUT_JACKS; n++) {
    docs[`out${n}_ref`] =
      `Voltage reference for output jack ${n} when its class is audio (modular/line; default modular). modular: ±1.0 drives ±5 V at the jack (Eurorack nominal). line: ±1.0 drives ±1.736 V peak (+4 dBu), 9.2 dB down, for a line-level input such as a mixer channel or an interface line in. cv, pitch and gate classes carry volts and ignore it. Set it once for the gear on the jack and leave it.`;
  }
  docs['es9-connect-{n}'] =
    "Bring the hardware link up. Unlike a browser permission this is not a grant the page can ask for — the es9-bridge companion app has to be RUNNING on this machine, because Chromium can only reach an ES-9's first stereo pair through getUserMedia and cannot pick a channel range at all. The app owns CoreAudio's full 16-in/16-out and serves a localhost WebSocket; pressing CONNECT points this node at it. Until it answers, every jack on this module sits silent and harmless in the patch. The link belongs to the NODE, not to any view, so it survives collapsing the dock, switching surfaces and never opening this plate again — and pressing CONNECT on an already-live link simply restarts it at the engine's current sample rate, which is the one rate the ring may run at.";
  docs['es9-disconnect-{n}'] =
    'Drop the hardware link without deleting the node. The jacks stay patched and the class settings stay exactly as they are; the native app simply stops being driven, which frees it for another client (it accepts one at a time) and stops the browser feeding the hardware. Use it before quitting the bridge app, or to hand the ES-9 to a DAW for a while. Press CONNECT to bring the same node back up — the SharedArrayBuffer rings live on this side of the worker, so a reconnect resumes against the rings the audio thread is already reading rather than needing the node rebuilt.';
  return docs;
}


/**
 * CONNECT ranks first because all hardware routing depends on the bridge.
 * DISCONNECT releases its single-client connection for a DAW. Output classes
 * precede input classes: outputs default to audio, so hardware CV use requires
 * an explicit change; inputs already default to CV.
 *
 * GROUPED BY JACK, never by control type (owner ruling 2026-09-04): each
 * jack's class selector and its modular/line ref toggle sit side by side, and
 * a cluster is one PAIR of jacks (class, ref, class, ref — four cells), so
 * column j means the same thing in every row of both console bands. Keep
 * jack-number captions: they distinguish otherwise identical controls.
 * The meter reads in1; the BRIDGE lamp distinguishes a disconnected bridge
 * from an unpatched, silent input.
 */
export const ES9_FACE: ModuleFace = {
  glyph: 'meter',
  // The three LAMPS are the only thing here that cannot be a cell: `StatusLed`
  // is rendered from a module-owned `fullViewBody` and nowhere else.
  extension: 'es9',
  order: [
    'es9-connect-{n}',
    'es9-disconnect-{n}',
    'out1_class', 'out1_ref', 'out2_class', 'out2_ref',
    'out3_class', 'out3_ref', 'out4_class', 'out4_ref',
    'out5_class', 'out5_ref', 'out6_class', 'out6_ref',
    'out7_class', 'out7_ref', 'out8_class', 'out8_ref',
    'in1_class', 'in1_ref', 'in2_class', 'in2_ref',
    'in3_class', 'in3_ref', 'in4_class', 'in4_ref',
    'in5_class', 'in5_ref', 'in6_class', 'in6_ref',
    'in7_class', 'in7_ref', 'in8_class', 'in8_ref',
    'in9_class', 'in9_ref', 'in10_class', 'in10_ref',
    'in11_class', 'in11_ref', 'in12_class', 'in12_ref',
    'in13_class', 'in13_ref', 'in14_class', 'in14_ref',
  ],
  pages: [
    {
      id: 'bridge',
      label: 'bridge',
      hint:
        'The link to the es9-bridge companion app, which owns the ES-9 through CoreAudio and '
        + 'serves it over a localhost WebSocket. It is not a browser permission: the app has to '
        + 'be running on this machine. Until it answers, every jack here is silent and harmless. '
        + 'The link belongs to the node, so collapsing this pane does not drop it.',
      controls: ['es9-connect-{n}', 'es9-disconnect-{n}'],
    },
    {
      id: 'out',
      label: 'out jacks',
      hint:
        'What each of the eight physical output jacks carries, which sets BOTH the voltage '
        + 'scaling on the way out (cv ±1 → ±5 V, pitch 1.0/oct → 1 V/oct, gate 0|1 → 0/+5 V, '
        + 'audio ±1 → ±5 V, or ±1.736 V with the jack\'s ref on line: +4 dBu, for a line-level '
        + 'input) AND how the jack fails if the stream hiccups: cv and pitch HOLD their last '
        + 'voltage, since a pitch collapsing to 0 V is a wrong note, while gate and audio fall '
        + 'to zero, since a frozen gate is a stuck note or a stopped clock. They default to '
        + 'audio and modular, so sending a rack LFO to hardware means changing one.',
      controls: [
        'out1_class', 'out1_ref', 'out2_class', 'out2_ref',
        'out3_class', 'out3_ref', 'out4_class', 'out4_ref',
        'out5_class', 'out5_ref', 'out6_class', 'out6_ref',
        'out7_class', 'out7_ref', 'out8_class', 'out8_ref',
      ],
      clusters: [
        { label: 'jacks 1-2', controls: ['out1_class', 'out1_ref', 'out2_class', 'out2_ref'] },
        { label: 'jacks 3-4', controls: ['out3_class', 'out3_ref', 'out4_class', 'out4_ref'] },
        { label: 'jacks 5-6', controls: ['out5_class', 'out5_ref', 'out6_class', 'out6_ref'] },
        { label: 'jacks 7-8', controls: ['out7_class', 'out7_ref', 'out8_class', 'out8_ref'] },
      ],
    },
    {
      id: 'in',
      label: 'in jacks',
      hint:
        'Each hardware input jack\'s CV TWIN class — cv ±5 V → ±1, pitch 1 V/oct → 1.0/oct with '
        + '0 V ≙ C4, gate through a 2 V / 1 V hysteresis comparator to a clean 0|1, audio the '
        + 'same scale as the audio port (only the hiccup policy differs: audio fades, cv holds) — '
        + 'beside the jack\'s REF: which volts the audio in{n} port reads as ±1.0. modular is '
        + '±5 V ≙ ±1.0 (a ±10 V signal reads ±2.0); line is +4 dBu (1.736 V peak) ≙ ±1.0, for '
        + 'line-level gear. The ref reaches the twin only when its class is audio; cv, pitch and '
        + 'gate twins carry volts. cv and modular are the defaults because a modular patch into a '
        + 'rack param is the case this twin exists for.',
      controls: [
        'in1_class', 'in1_ref', 'in2_class', 'in2_ref',
        'in3_class', 'in3_ref', 'in4_class', 'in4_ref',
        'in5_class', 'in5_ref', 'in6_class', 'in6_ref',
        'in7_class', 'in7_ref', 'in8_class', 'in8_ref',
        'in9_class', 'in9_ref', 'in10_class', 'in10_ref',
        'in11_class', 'in11_ref', 'in12_class', 'in12_ref',
        'in13_class', 'in13_ref', 'in14_class', 'in14_ref',
      ],
      clusters: [
        { label: 'jacks 1-2', controls: ['in1_class', 'in1_ref', 'in2_class', 'in2_ref'] },
        { label: 'jacks 3-4', controls: ['in3_class', 'in3_ref', 'in4_class', 'in4_ref'] },
        { label: 'jacks 5-6', controls: ['in5_class', 'in5_ref', 'in6_class', 'in6_ref'] },
        { label: 'jacks 7-8', controls: ['in7_class', 'in7_ref', 'in8_class', 'in8_ref'] },
        { label: 'jacks 9-10', controls: ['in9_class', 'in9_ref', 'in10_class', 'in10_ref'] },
        { label: 'jacks 11-12', controls: ['in11_class', 'in11_ref', 'in12_class', 'in12_ref'] },
        { label: 'jacks 13-14', controls: ['in13_class', 'in13_ref', 'in14_class', 'in14_ref'] },
      ],
    },
  ],
};

// ---- def ----------------------------------------------------------------

export const es9Def: AudioModuleDef = {
  type: 'es9',
  palette: { top: 'Audio modules', sub: 'I/O' },
  domain: 'audio',
  label: 'es-9',
  category: 'utilities',
  // One bridge, one device, one owner — the native app accepts a single
  // client, so a second module instance could only ever show "busy".
  maxInstances: 1,
  size: '3u',
  hp: 3,

  inputs: [
  // out1-8 = the PHYSICAL 3.5mm DC-coupled jacks. HARDWARE-VERIFIED default
  // routing (ES-9 manual §Routing p.11, confirmed on a real unit): the jacks
  // are driven by USB/DAW channels 9-16, NOT 1-8 — the factory below maps
  // these ports to worklet inputs 8..15. Widened like SCOPE's probes: a
  // DC-coupled jack takes audio OR any CV-family signal; the class param
  // picks the voltage scaling.
  { id: 'out1', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
  { id: 'out2', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
  { id: 'out3', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
  { id: 'out4', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
  { id: 'out5', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
  { id: 'out6', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
  { id: 'out7', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
  { id: 'out8', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
  // usb1-8 = USB/DAW channels 1-8, which by default feed the ES-9's
  // INTERNAL blocks, not jacks: 1-2 → main outs (via mix 1/2), 3-4 → phones
  // (via mix 3/4), 5-6 → S/PDIF out, 7-8 → the ES-5 expansion header.
  // Audio-typed (AC-coupled destinations — not a CV path).
  { id: 'usb1', type: 'audio' },
  { id: 'usb2', type: 'audio' },
  { id: 'usb3', type: 'audio' },
  { id: 'usb4', type: 'audio' },
  { id: 'usb5', type: 'audio' },
  { id: 'usb6', type: 'audio' },
  { id: 'usb7', type: 'audio' },
  { id: 'usb8', type: 'audio' },
  ],
  outputs: [
  { id: 'in1', type: 'audio' },
  { id: 'in2', type: 'audio' },
  { id: 'in3', type: 'audio' },
  { id: 'in4', type: 'audio' },
  { id: 'in5', type: 'audio' },
  { id: 'in6', type: 'audio' },
  { id: 'in7', type: 'audio' },
  { id: 'in8', type: 'audio' },
  { id: 'in9', type: 'audio' },
  { id: 'in10', type: 'audio' },
  { id: 'in11', type: 'audio' },
  { id: 'in12', type: 'audio' },
  { id: 'in13', type: 'audio' },
  { id: 'in14', type: 'audio' },
  { id: 'spdif_l', type: 'audio' },
  { id: 'spdif_r', type: 'audio' },
  { id: 'in1_cv', type: 'cv' },
  { id: 'in2_cv', type: 'cv' },
  { id: 'in3_cv', type: 'cv' },
  { id: 'in4_cv', type: 'cv' },
  { id: 'in5_cv', type: 'cv' },
  { id: 'in6_cv', type: 'cv' },
  { id: 'in7_cv', type: 'cv' },
  { id: 'in8_cv', type: 'cv' },
  { id: 'in9_cv', type: 'cv' },
  { id: 'in10_cv', type: 'cv' },
  { id: 'in11_cv', type: 'cv' },
  { id: 'in12_cv', type: 'cv' },
  { id: 'in13_cv', type: 'cv' },
  { id: 'in14_cv', type: 'cv' },
  ],
  params: [
  // 0=audio 1=cv 2=pitch 3=gate. Inputs default cv (the modular-native
  // case for the cv twin); outputs default audio (±1 → ±5 V on the 8 jacks;
  // usb1-8 stay bit-transparent whatever the class).
  { id: 'in1_class', label: 'In 1 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete', options: ES9_CLASS_OPTIONS },
  { id: 'in2_class', label: 'In 2 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete', options: ES9_CLASS_OPTIONS },
  { id: 'in3_class', label: 'In 3 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete', options: ES9_CLASS_OPTIONS },
  { id: 'in4_class', label: 'In 4 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete', options: ES9_CLASS_OPTIONS },
  { id: 'in5_class', label: 'In 5 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete', options: ES9_CLASS_OPTIONS },
  { id: 'in6_class', label: 'In 6 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete', options: ES9_CLASS_OPTIONS },
  { id: 'in7_class', label: 'In 7 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete', options: ES9_CLASS_OPTIONS },
  { id: 'in8_class', label: 'In 8 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete', options: ES9_CLASS_OPTIONS },
  { id: 'in9_class', label: 'In 9 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete', options: ES9_CLASS_OPTIONS },
  { id: 'in10_class', label: 'In 10 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete', options: ES9_CLASS_OPTIONS },
  { id: 'in11_class', label: 'In 11 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete', options: ES9_CLASS_OPTIONS },
  { id: 'in12_class', label: 'In 12 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete', options: ES9_CLASS_OPTIONS },
  { id: 'in13_class', label: 'In 13 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete', options: ES9_CLASS_OPTIONS },
  { id: 'in14_class', label: 'In 14 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete', options: ES9_CLASS_OPTIONS },
  { id: 'out1_class', label: 'Out 1 class', defaultValue: 0, min: 0, max: 3, curve: 'discrete', options: ES9_CLASS_OPTIONS },
  { id: 'out2_class', label: 'Out 2 class', defaultValue: 0, min: 0, max: 3, curve: 'discrete', options: ES9_CLASS_OPTIONS },
  { id: 'out3_class', label: 'Out 3 class', defaultValue: 0, min: 0, max: 3, curve: 'discrete', options: ES9_CLASS_OPTIONS },
  { id: 'out4_class', label: 'Out 4 class', defaultValue: 0, min: 0, max: 3, curve: 'discrete', options: ES9_CLASS_OPTIONS },
  { id: 'out5_class', label: 'Out 5 class', defaultValue: 0, min: 0, max: 3, curve: 'discrete', options: ES9_CLASS_OPTIONS },
  { id: 'out6_class', label: 'Out 6 class', defaultValue: 0, min: 0, max: 3, curve: 'discrete', options: ES9_CLASS_OPTIONS },
  { id: 'out7_class', label: 'Out 7 class', defaultValue: 0, min: 0, max: 3, curve: 'discrete', options: ES9_CLASS_OPTIONS },
  { id: 'out8_class', label: 'Out 8 class', defaultValue: 0, min: 0, max: 3, curve: 'discrete', options: ES9_CLASS_OPTIONS },
  // 0=modular 1=line — the audio REFERENCE per DC jack (ADR-020). NEW ids,
  // all default 0 = modular = the ADR-019 behaviour, so no saved rack moves
  // (audio-runtime contract: never re-interpret an existing id). Only the
  // audio class reads it. LITERAL lines like the class rows above (the docs
  // extractor is a regex); ES9_REF_PARAM_IDS is the derived twin the tests
  // pin these against.
  { id: 'in1_ref', label: 'In 1 ref', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ES9_REF_OPTIONS },
  { id: 'in2_ref', label: 'In 2 ref', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ES9_REF_OPTIONS },
  { id: 'in3_ref', label: 'In 3 ref', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ES9_REF_OPTIONS },
  { id: 'in4_ref', label: 'In 4 ref', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ES9_REF_OPTIONS },
  { id: 'in5_ref', label: 'In 5 ref', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ES9_REF_OPTIONS },
  { id: 'in6_ref', label: 'In 6 ref', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ES9_REF_OPTIONS },
  { id: 'in7_ref', label: 'In 7 ref', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ES9_REF_OPTIONS },
  { id: 'in8_ref', label: 'In 8 ref', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ES9_REF_OPTIONS },
  { id: 'in9_ref', label: 'In 9 ref', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ES9_REF_OPTIONS },
  { id: 'in10_ref', label: 'In 10 ref', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ES9_REF_OPTIONS },
  { id: 'in11_ref', label: 'In 11 ref', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ES9_REF_OPTIONS },
  { id: 'in12_ref', label: 'In 12 ref', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ES9_REF_OPTIONS },
  { id: 'in13_ref', label: 'In 13 ref', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ES9_REF_OPTIONS },
  { id: 'in14_ref', label: 'In 14 ref', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ES9_REF_OPTIONS },
  { id: 'out1_ref', label: 'Out 1 ref', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ES9_REF_OPTIONS },
  { id: 'out2_ref', label: 'Out 2 ref', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ES9_REF_OPTIONS },
  { id: 'out3_ref', label: 'Out 3 ref', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ES9_REF_OPTIONS },
  { id: 'out4_ref', label: 'Out 4 ref', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ES9_REF_OPTIONS },
  { id: 'out5_ref', label: 'Out 5 ref', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ES9_REF_OPTIONS },
  { id: 'out6_ref', label: 'Out 6 ref', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ES9_REF_OPTIONS },
  { id: 'out7_ref', label: 'Out 7 ref', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ES9_REF_OPTIONS },
  { id: 'out8_ref', label: 'Out 8 ref', defaultValue: 0, min: 0, max: 1, curve: 'discrete', options: ES9_REF_OPTIONS },
  ],

  face: ES9_FACE,

  // ⚠ TWO FAMILIES FOR TWO GESTURES, because `resolveFaceControl` resolves a
  // face key to a PARAM id, a family TEMPLATE (`<id>-{n}`) or a legend STATIC,
  // and CONNECT/DISCONNECT are none of the first. They are real affordances the
  // module owns — it has had both buttons since it shipped — and
  // `module-docs-lint` requires each declared `testidPrefix`
  // to appear in real UI source, which is why `Es9Card.svelte` grows the two
  // testids in this same diff. Adding the testid is the honest fix; dropping
  // the family would be fixing a declaration to satisfy a gate.
  controlFamilies: [
    { id: 'es9-connect', label: 'Connect', kind: 'other', testidPrefix: 'es9-connect' },
    { id: 'es9-disconnect', label: 'Disconnect', kind: 'other', testidPrefix: 'es9-disconnect' },
  ],

  docs: {
    explanation:
      "Patches a REAL Eurorack system into the rack, both directions, through an Expert Sleepers ES-9 and the es9-bridge native companion app (macOS; runs at ws://127.0.0.1:9209). All 16 hardware inputs and 16 USB output channels are individually patchable — audio AND CV, because the ES-9's jacks are DC-coupled: send a hardware Maths LFO into any cv input here, or send a patchtogether LFO out to a hardware VCA. Each hardware input jack 1-14 has two ports: an audio port (±1.0 ≙ ±5 V, Eurorack nominal — the same unity as every internal module — or ±1.0 ≙ +4 dBu line level with the jack's ref toggle set to line) and a class-scaled CV twin whose selector (audio/cv/pitch/gate) maps volts onto app conventions (±5 V→±1 cv, 1 V/oct→1.0/oct pitch with 0 V ≙ C4, clean 0|1 gates via a hysteresis comparator). The 8 hardware output jacks take audio or CV-family cables directly, inverse-scaled by their own class selectors (audio ±1.0 → ±5 V, or → ±1.736 V with the jack's ref on line); cv-ish outputs HOLD their last voltage if the connection hiccups (a CV snapping to 0 V would yank every patched hardware parameter), audio outputs fade. Audio never touches the main thread — a transport Worker owns the localhost WebSocket and SharedArrayBuffer rings feed the audio thread — so canvas jank can't glitch the hardware stream. Requires the native bridge app running (Chromium; the faceplate\'s BRIDGE lamp says whether it answered, and CONNECT is on the module\'s tile as well as its dock plate). Without it the module sits silent and harmless in the patch.",
    inputs: inputDocs(),
    outputs: outputDocs(),
    controls: controlDocs(),
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // One mono worklet index per jack (attenumix pattern): 16 inputs
    // (out1-8 + mix9-16), 32 outputs (in1-14 raw + spdif L/R + in1-14 cv
    // twins at index 16+n; 30/31 reserved-silent).
    const worklet = createWorkletNode(node, ctx, PROCESSOR_NAME, {
      numberOfInputs: HW_CHANNELS,
      numberOfOutputs: 32,
      outputChannelCount: new Array<number>(32).fill(1),
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
    });

    // Pin the worklet into the rendered graph: an unpatched module must
    // still pump the rings (the hardware side keeps flowing regardless of
    // what's patched in the browser). A zero-gain tap to the destination
    // guarantees the node is pulled every quantum without ever being
    // audible.
    const pin = ctx.createGain();
    pin.gain.value = 0;
    worklet.connect(pin, 0);
    pin.connect(ctx.destination);

    // Initial per-jack classes + audio references from persisted params (one
    // per-jack config message; the worklet applies whichever fields are set).
    const pushClasses = (params: Record<string, number> | undefined) => {
      const { inClasses, outClasses } = es9ClassesFromParams(params);
      worklet.port.postMessage({ type: 'classes', inClasses, outClasses, ...es9RefsFromParams(params) });
    };
    pushClasses(node.params);

    // Live param mirror (setParam only hands us one param at a time).
    const liveParams: Record<string, number> = { ...(node.params ?? {}) };

    const inputsMap = new Map<string, { node: AudioNode; input: number }>();
    for (let n = 1; n <= DC_OUTPUT_JACKS; n++) {
      // Physical jacks ride USB channels 9-16 (default routing).
      inputsMap.set(`out${n}`, { node: worklet, input: JACK_CHANNEL_BASE + (n - 1) });
    }
    for (let n = 1; n <= 8; n++) {
      // USB 1-8: internal mixer (main/phones) / S-PDIF / ES-5 feeds.
      inputsMap.set(`usb${n}`, { node: worklet, input: n - 1 });
    }
    const outputsMap = new Map<string, { node: AudioNode; output: number }>();
    for (let n = 1; n <= DC_INPUT_JACKS; n++) {
      outputsMap.set(`in${n}`, { node: worklet, output: n - 1 });
      outputsMap.set(`in${n}_cv`, { node: worklet, output: CV_TWIN_BASE + (n - 1) });
    }
    outputsMap.set('spdif_l', { node: worklet, output: 14 });
    outputsMap.set('spdif_r', { node: worklet, output: 15 });

    // ── OWN THE BRIDGE HERE, not on the card ────────────────────────────────
    // The connection's lifetime is now the NODE's lifetime, not a Svelte
    // component's. `Es9BridgeClient` is Worker + SharedArrayBuffer with no DOM
    // at all, so nothing about it ever required a card — it only lived there
    // because it was modelled on AudioinCard, which genuinely needs the DOM for
    // getUserMedia. Moving it restores the invariant `dom-source-modules` states
    // for video: the ENGINE-VISIBLE state of a rack must not depend on which UI
    // renders a module. Collapsing the dock pane, switching to ?shell=1, or
    // never opening the card at all can no longer stop the hardware stream.
    // No-ops without Worker/SAB (node, vitest, the ART harness).
    const rings = acquireEs9Bridge(node.id, ctx.sampleRate, es9BridgeConfig(node.params));
    if (rings) {
      worklet.port.postMessage({ type: 'rings', in: rings.inRing, out: rings.outRing });
    }

    return {
      domain: 'audio',
      inputs: inputsMap,
      outputs: outputsMap,
      setParam(paramId, value) {
        // `_ref` edits reach the worklet through the same per-jack message;
        // a ref id not admitted here would be silently dead after the first
        // edit (the initial push only sees node.params).
        if (/^(in\d+|out\d+)_(class|ref)$/.test(paramId)) {
          liveParams[paramId] = value;
          pushClasses(liveParams);
          if (!/_class$/.test(paramId)) return;
          // ⚠ AND PUSH THE BRIDGE'S FAILURE POLICY (class edits only — the
          // native HOLD/FADE policy is class-derived; a ref edit changes the
          // scale, not the policy). These are two different
          // messages to two different consumers: `classes` reaches the
          // AudioWorklet's per-jack voltage scaling, `config` reaches the
          // NATIVE APP's underrun policy (HOLD vs FADE). Only the first used
          // to happen without a mounted card, so a jack could be scaling as
          // `gate` while the app still failed it as `cv` — a held gate rather
          // than a dropped pulse. This is the one place that knows a class
          // changed with no view involved, which is what makes it the right
          // place: a store write from the CV-Buddy janitor arrives here too.
          updateEs9Config(node.id, es9BridgeConfig(liveParams));
        }
      },
      readParam(paramId) {
        return liveParams[paramId];
      },
      read(key) {
        if (key === 'sampleRate') return ctx.sampleRate;
        return undefined;
      },
      dispose() {
        // The node is leaving the graph — THIS is the only place the hardware
        // connection is torn down. A card unmount must never reach here.
        releaseEs9Bridge(node.id);
        worklet.port.postMessage({ type: 'detach' });
        try { worklet.disconnect(); } catch { /* */ }
        try { pin.disconnect(); } catch { /* */ }
      },
      // Card → engine seam (audioin __audioInAttach pattern): the card
      // hands the SAB ring specs over when the bridge connects, null on
      // disconnect. The worklet adopts/releases them via port messages.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ __es9Attach: (payload: Es9AttachPayload | null) => {
        if (payload === null) {
          worklet.port.postMessage({ type: 'detach' });
        } else {
          worklet.port.postMessage({
            type: 'rings',
            in: payload.inRing,
            out: payload.outRing,
          });
        }
      } } as any),
    };
  },
};

/**
 * Card-side accessor for the attach hook (mirrors audioInAttach). Returns
 * false when the node hasn't reconciled into the engine yet — retry.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function es9Attach(engine: any, nodeId: string, payload: Es9AttachPayload | null): boolean {
  try {
    const ae = engine?.getDomain?.('audio');
    if (!ae) return false;
    const handle = ae.nodes?.get?.(nodeId);
    if (!handle) return false;
    const fn = (handle as { __es9Attach?: (p: Es9AttachPayload | null) => void }).__es9Attach;
    if (typeof fn !== 'function') return false;
    fn(payload);
    return true;
  } catch {
    return false;
  }
}
