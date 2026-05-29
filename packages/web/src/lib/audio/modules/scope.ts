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
//   ch1Range / ch2Range (discrete 0..1, default 0): per-channel range mode (0 = bipolar ±1, 1 = unipolar 0..1).
//   mode (discrete 0..1, default 0): 0 = time-domain, 1 = XY (ch1 vs ch2).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { drawScope, type ScopeSnapshot, type ScopeDrawParams } from './scope-draw';
import { detectPitch, type PitchResult } from '$lib/audio/pitch-detect';

export type { ScopeSnapshot } from './scope-draw';
export type { PitchResult } from '$lib/audio/pitch-detect';

export const scopeDef: AudioModuleDef = {
  type: 'scope',
  domain: 'audio',
  label: 'Scope',
  category: 'utilities',
  schemaVersion: 1,
  // Module-grouping Phase 3B: SCOPE's on-card 2D canvas is hoisted into
  // the parent GroupCard's body when SCOPE is collapsed inside a group.
  // The card's <canvas data-viz-passthrough> element is portaled (i.e.
  // appendChild-moved) into the GroupCard so the same draw loop drives
  // both render paths without re-mounting the card. See GroupCard.svelte
  // for the portal mechanics + ScopeCard.svelte for the canvas marker.
  vizPassthrough: true,

  // CV inputs mirror every param 1:1 — port id == param id, which the
  // cross-domain CV bridge (PatchEngine.addCrossDomainCvBridge) routes
  // straight into setParam(portId, value). Discrete params (mode,
  // ch{1,2}Range) accept any CV value; the consumer reads the canonical
  // ≥0.5 threshold to decide their binary state, so a 5V CV pulse will
  // toggle XY mode just as expected.
  inputs: [
    { id: 'ch1', type: 'audio' },
    { id: 'ch2', type: 'audio' },
    { id: 'timeMs',    type: 'cv', paramTarget: 'timeMs' },
    { id: 'ch1Scale',  type: 'cv', paramTarget: 'ch1Scale' },
    { id: 'ch1Offset', type: 'cv', paramTarget: 'ch1Offset' },
    { id: 'ch1Range',  type: 'cv', paramTarget: 'ch1Range' },
    { id: 'ch2Scale',  type: 'cv', paramTarget: 'ch2Scale' },
    { id: 'ch2Offset', type: 'cv', paramTarget: 'ch2Offset' },
    { id: 'ch2Range',  type: 'cv', paramTarget: 'ch2Range' },
    { id: 'mode',      type: 'cv', paramTarget: 'mode' },
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
    { id: 'ch1Range',  label: 'Ch1 R',  defaultValue: 0,  min: 0,    max: 1,   curve: 'discrete' },
    { id: 'ch2Scale',  label: 'Ch2 Sc', defaultValue: 1,  min: 0.1,  max: 10,  curve: 'log' },
    { id: 'ch2Offset', label: 'Ch2 Y',  defaultValue: 0,  min: -1,   max: 1,   curve: 'linear' },
    { id: 'ch2Range',  label: 'Ch2 R',  defaultValue: 0,  min: 0,    max: 1,   curve: 'discrete' },
    // 0 = split (two stacked traces), 1 = XY (ch1 vs ch2 plot).
    { id: 'mode',      label: 'XY',    defaultValue: 0,  min: 0,    max: 1,   curve: 'discrete' },
  ],

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

    // Scope params live ENTIRELY on this handle for two reasons:
    //   1. The audio path doesn't use them (no Web Audio param to write
    //      back to) — they only affect display.
    //   2. Both the on-card canvas (via read('snapshot') + the card's
    //      reactive $derived) AND the video bridge (via drawFrame) need
    //      the live values. Keeping a single source of truth here means
    //      a CV signal modulating timeMs reaches both renders without
    //      drift.
    // Initial values: take from the materialized node, fall back to def
    // defaults. setParam updates both the live cache (for the bridge)
    // AND triggers a graph mutation via patch.nodes[].params (the card
    // reads the same source-of-truth — the patch graph — so manual
    // fader changes and CV-driven setParam calls converge).
    const params: Record<string, number> = {
      timeMs:    (node.params ?? {}).timeMs    ?? 20,
      ch1Scale:  (node.params ?? {}).ch1Scale  ?? 1,
      ch1Offset: (node.params ?? {}).ch1Offset ?? 0,
      ch1Range:  (node.params ?? {}).ch1Range  ?? 0,
      ch2Scale:  (node.params ?? {}).ch2Scale  ?? 1,
      ch2Offset: (node.params ?? {}).ch2Offset ?? 0,
      ch2Range:  (node.params ?? {}).ch2Range  ?? 0,
      mode:      (node.params ?? {}).mode      ?? 0,
    };

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
      const snap = readSnapshot();
      const dp: ScopeDrawParams = {
        timeMs:    params.timeMs!,
        ch1Scale:  params.ch1Scale!,
        ch1Offset: params.ch1Offset!,
        ch1Range:  params.ch1Range!,
        ch2Scale:  params.ch2Scale!,
        ch2Offset: params.ch2Offset!,
        ch2Range:  params.ch2Range!,
        mode:      params.mode!,
      };
      drawScope(ctx2d, snap, dp, canvas.width, canvas.height);
    }

    return {
      domain: 'audio',
      // gain1 and gain2 each act as both the input AND output for their channel
      // — Web Audio happily routes signal through a GainNode, and we tap a
      // separate analyser off it for visualization.
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['ch1', { node: gain1, input: 0 }],
        ['ch2', { node: gain2, input: 0 }],
        // CV inputs live on hidden internal AudioParams so the engine's
        // per-param tap analyser still picks them up (motorized faders
        // see the modulation). The actual VALUE coming from the CV
        // source flows through setParam(portId) — the cross-domain CV
        // bridge in VideoEngine writes one sample per video frame, the
        // intra-domain CV path uses the audio engine's sample-per-frame
        // tap. We use gain1.gain as a stable internal sink AudioParam
        // since gain1 is always present; the actual gain value isn't
        // affected (we never write to it from inside setParam).
        ['timeMs',    { node: gain1, input: 0, param: gain1.gain }],
        ['ch1Scale',  { node: gain1, input: 0, param: gain1.gain }],
        ['ch1Offset', { node: gain1, input: 0, param: gain1.gain }],
        ['ch1Range',  { node: gain1, input: 0, param: gain1.gain }],
        ['ch2Scale',  { node: gain2, input: 0, param: gain2.gain }],
        ['ch2Offset', { node: gain2, input: 0, param: gain2.gain }],
        ['ch2Range',  { node: gain2, input: 0, param: gain2.gain }],
        ['mode',      { node: gain1, input: 0, param: gain1.gain }],
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
        // Live-update the local cache. The card mirrors patch.nodes[].params
        // for its UI reads; CV-driven updates here flow into the same
        // params record the card reads from via $derived. (We don't
        // mutate patch.nodes here — the audio engine's reconciler owns
        // the patch state. The card's $derived re-runs when a fader
        // moves; the bridge's drawFrame reads our params record live
        // without going through Svelte's reactive system.)
        if (paramId in params) {
          params[paramId] = value;
        }
      },
      readParam(paramId) {
        return params[paramId];
      },
      read(key) {
        if (key === 'snapshot') {
          return readSnapshot();
        }
        if (key === 'pitch') {
          return readPitch();
        }
        return undefined;
      },
      dispose() {
        gain1.disconnect();
        gain2.disconnect();
        analyser1.disconnect();
        analyser2.disconnect();
      },
    };
  },
};
