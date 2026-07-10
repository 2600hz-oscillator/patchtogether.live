// packages/web/src/lib/audio/modules/es9.ts
//
// ES-9 — full 16×16 audio+CV I/O with a real Eurorack system, via the
// es9-bridge NATIVE companion app (repo: patchtogether.es9). The browser
// cannot do this alone: getUserMedia caps the ES-9 at its first stereo pair
// and setSinkId picks whole devices, never channel ranges (empirically
// verified — see audioin.ts + .myrobots/plans/es9-stereo-io.md). The native
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
// The CARD (Es9Card.svelte) owns the connection lifecycle (worker + rings,
// via $lib/audio/es9/bridge-client.ts) and hands ring specs to this factory
// through the __es9Attach handle hook — the audioin.ts card/engine seam, so
// this factory stays DOM-free and jsdom-testable.
//
// SIGNALS + the per-jack CLASS model: the wire carries RAW hardware floats
// (±1.0 ≙ ±10 V). Because canConnect() forbids one port serving both the
// audio and cv families, each hardware INPUT jack 1-14 exposes TWO ports —
// a raw `audio` port and a class-scaled `cv` twin (cv ×2 = ±5 V→±1;
// pitch ×10 = 1 V/oct→1.0/oct with 0 V ≙ C4; gate = hysteresis comparator
// →0|1). The 16 browser→hardware jacks are single `audio` ports widened
// with accepts:['cv','pitch','gate'] (the scope.ts/scaler.ts precedent),
// inverse-scaled per their class param. S/PDIF returns (USB in 15/16) are
// AC digital — audio only, no cv twin. USB outs 9-16 are the ES-9's
// internal-mixer buses — audio only.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ParamDef, PortDef } from '$lib/graph/types';
import type { RingSpec } from '$lib/audio/es9/es9-ring';
import workletUrl from '@patchtogether.live/dsp/dist/es9-bridge.js?url';

const PROCESSOR_NAME = 'es9-bridge';
const loadedContexts = new WeakSet<BaseAudioContext>();

/** Signal classes — MUST mirror packages/dsp/src/lib/es9-bridge-core.ts
 *  (0=audio raw, 1=cv ±5 V↔±1, 2=pitch 1 V/oct↔1.0/oct, 3=gate 0|1↔0/+5 V). */
export const ES9_CLASS_AUDIO = 0;
export const ES9_CLASS_CV = 1;
export const ES9_CLASS_PITCH = 2;
export const ES9_CLASS_GATE = 3;
export const ES9_CLASS_NAMES = ['audio', 'cv', 'pitch', 'gate'] as const;

const HW_CHANNELS = 16;
const CV_TWIN_BASE = 16;
/** DC-coupled input jacks (with cv twins); 15/16 are the S/PDIF return. */
const DC_INPUT_JACKS = 14;
/** DC-coupled output jacks; USB outs 9-16 are internal-mixer buses. */
const DC_OUTPUT_JACKS = 8;

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
    outClasses.push(
      c < DC_OUTPUT_JACKS ? (p[`out${c + 1}_class`] ?? ES9_CLASS_AUDIO) : ES9_CLASS_AUDIO,
    );
  }
  return { inClasses, outClasses };
}

/** The bridge-side underrun modes for the config message: any CV-ish class
 *  holds its last voltage on a hiccup; audio fades to silence. */
export function es9OutputModes(params: Record<string, number> | undefined): Record<string, 'audio' | 'cv'> {
  const { outClasses } = es9ClassesFromParams(params);
  const modes: Record<string, 'audio' | 'cv'> = {};
  for (let c = 0; c < HW_CHANNELS; c++) {
    modes[String(c)] = outClasses[c] === ES9_CLASS_AUDIO ? 'audio' : 'cv';
  }
  return modes;
}

// ---- docs (STRICT_DOCS: every port + control documented) ----------------

function inputDocs(): Record<string, string> {
  const docs: Record<string, string> = {};
  for (let n = 1; n <= DC_OUTPUT_JACKS; n++) {
    docs[`out${n}`] =
      `To ES-9 hardware output jack ${n} (DC-coupled, ±10 V). Takes audio or any CV-family signal; the Out ${n} class selector sets the voltage scaling (audio = raw full scale, cv = ±1 → ±5 V, pitch = 1.0/oct → 1 V/oct, gate = 0|1 → 0/+5 V) and whether the jack holds (cv-ish) or fades (audio) if the browser stream hiccups.`;
  }
  for (let n = 9; n <= 16; n++) {
    docs[`mix${n}`] =
      `To ES-9 USB output channel ${n} — by default these feed the ES-9's internal 8×8 mixer / headphone buses rather than a rear jack (configurable in the ES-9's own config tool). Audio-rate, raw full scale.`;
  }
  return docs;
}

function outputDocs(): Record<string, string> {
  const docs: Record<string, string> = {};
  for (let n = 1; n <= DC_INPUT_JACKS; n++) {
    docs[`in${n}`] =
      `ES-9 hardware input jack ${n}, raw: float ±1.0 is ±10 V at the jack. This is the audio-typed port — patch it to mixers, effects, AUDIO OUT, or a SCOPE.`;
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
      `Signal class for input jack ${n}'s CV twin port (audio/cv/pitch/gate; default cv). Sets how hardware volts map onto app units on in${n}_cv: cv = ±5 V → ±1, pitch = 1 V/oct → 1.0/oct (0 V ≙ C4), gate = hysteresis comparator (rise ≥2 V, fall <1 V) → 0|1, audio = raw. The raw in${n} port is unaffected.`;
  }
  for (let n = 1; n <= DC_OUTPUT_JACKS; n++) {
    docs[`out${n}_class`] =
      `Signal class for hardware output jack ${n} (audio/cv/pitch/gate; default audio). Sets the inverse voltage mapping for signals patched into out${n} (cv = ±1 → ±5 V, pitch = 1.0/oct → 1 V/oct, gate = 0|1 → 0/+5 V, audio = raw full scale) AND the bridge's failure policy for the jack: cv-ish classes HOLD the last voltage on a stream hiccup, audio fades to silence.`;
  }
  return docs;
}

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
  // Widened like SCOPE's probes: a DC-coupled jack takes audio OR any
  // CV-family signal; the class param picks the voltage scaling.
  { id: 'out1', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
  { id: 'out2', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
  { id: 'out3', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
  { id: 'out4', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
  { id: 'out5', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
  { id: 'out6', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
  { id: 'out7', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
  { id: 'out8', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
  { id: 'mix9', type: 'audio' },
  { id: 'mix10', type: 'audio' },
  { id: 'mix11', type: 'audio' },
  { id: 'mix12', type: 'audio' },
  { id: 'mix13', type: 'audio' },
  { id: 'mix14', type: 'audio' },
  { id: 'mix15', type: 'audio' },
  { id: 'mix16', type: 'audio' },
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
  // case for the cv twin); outputs default audio (bit-transparent).
  { id: 'in1_class', label: 'In 1 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete' },
  { id: 'in2_class', label: 'In 2 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete' },
  { id: 'in3_class', label: 'In 3 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete' },
  { id: 'in4_class', label: 'In 4 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete' },
  { id: 'in5_class', label: 'In 5 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete' },
  { id: 'in6_class', label: 'In 6 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete' },
  { id: 'in7_class', label: 'In 7 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete' },
  { id: 'in8_class', label: 'In 8 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete' },
  { id: 'in9_class', label: 'In 9 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete' },
  { id: 'in10_class', label: 'In 10 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete' },
  { id: 'in11_class', label: 'In 11 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete' },
  { id: 'in12_class', label: 'In 12 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete' },
  { id: 'in13_class', label: 'In 13 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete' },
  { id: 'in14_class', label: 'In 14 class', defaultValue: 1, min: 0, max: 3, curve: 'discrete' },
  { id: 'out1_class', label: 'Out 1 class', defaultValue: 0, min: 0, max: 3, curve: 'discrete' },
  { id: 'out2_class', label: 'Out 2 class', defaultValue: 0, min: 0, max: 3, curve: 'discrete' },
  { id: 'out3_class', label: 'Out 3 class', defaultValue: 0, min: 0, max: 3, curve: 'discrete' },
  { id: 'out4_class', label: 'Out 4 class', defaultValue: 0, min: 0, max: 3, curve: 'discrete' },
  { id: 'out5_class', label: 'Out 5 class', defaultValue: 0, min: 0, max: 3, curve: 'discrete' },
  { id: 'out6_class', label: 'Out 6 class', defaultValue: 0, min: 0, max: 3, curve: 'discrete' },
  { id: 'out7_class', label: 'Out 7 class', defaultValue: 0, min: 0, max: 3, curve: 'discrete' },
  { id: 'out8_class', label: 'Out 8 class', defaultValue: 0, min: 0, max: 3, curve: 'discrete' },
  ],

  docs: {
    explanation:
      "Patches a REAL Eurorack system into the rack, both directions, through an Expert Sleepers ES-9 and the es9-bridge native companion app (macOS; runs at ws://127.0.0.1:9209). All 16 hardware inputs and 16 USB output channels are individually patchable — audio AND CV, because the ES-9's jacks are DC-coupled: send a hardware Maths LFO into any cv input here, or send a patchtogether LFO out to a hardware VCA. Each hardware input jack 1-14 has two ports: a raw audio port (±1.0 ≙ ±10 V) and a class-scaled CV twin whose selector (audio/cv/pitch/gate) maps volts onto app conventions (±5 V→±1 cv, 1 V/oct→1.0/oct pitch with 0 V ≙ C4, clean 0|1 gates via a hysteresis comparator). The 8 hardware output jacks take audio or CV-family cables directly, inverse-scaled by their own class selectors; cv-ish outputs HOLD their last voltage if the connection hiccups (a CV snapping to 0 V would yank every patched hardware parameter), audio outputs fade. Audio never touches the main thread — a transport Worker owns the localhost WebSocket and SharedArrayBuffer rings feed the audio thread — so canvas jank can't glitch the hardware stream. Requires the native bridge app running (Chromium; the card shows status). Without it the module sits silent and harmless in the patch.",
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
    const worklet = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
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

    // Initial per-jack classes from persisted params.
    const pushClasses = (params: Record<string, number> | undefined) => {
      const { inClasses, outClasses } = es9ClassesFromParams(params);
      worklet.port.postMessage({ type: 'classes', inClasses, outClasses });
    };
    pushClasses(node.params);

    // Live param mirror (setParam only hands us one param at a time).
    const liveParams: Record<string, number> = { ...(node.params ?? {}) };

    const inputsMap = new Map<string, { node: AudioNode; input: number }>();
    for (let n = 1; n <= DC_OUTPUT_JACKS; n++) {
      inputsMap.set(`out${n}`, { node: worklet, input: n - 1 });
    }
    for (let n = 9; n <= 16; n++) {
      inputsMap.set(`mix${n}`, { node: worklet, input: n - 1 });
    }
    const outputsMap = new Map<string, { node: AudioNode; output: number }>();
    for (let n = 1; n <= DC_INPUT_JACKS; n++) {
      outputsMap.set(`in${n}`, { node: worklet, output: n - 1 });
      outputsMap.set(`in${n}_cv`, { node: worklet, output: CV_TWIN_BASE + (n - 1) });
    }
    outputsMap.set('spdif_l', { node: worklet, output: 14 });
    outputsMap.set('spdif_r', { node: worklet, output: 15 });

    return {
      domain: 'audio',
      inputs: inputsMap,
      outputs: outputsMap,
      setParam(paramId, value) {
        if (/^(in\d+|out\d+)_class$/.test(paramId)) {
          liveParams[paramId] = value;
          pushClasses(liveParams);
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
