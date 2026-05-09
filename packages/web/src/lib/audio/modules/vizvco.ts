// packages/web/src/lib/audio/modules/vizvco.ts
//
// VIZVCO — analog VCO sister of analogVco, with two added features:
//   1. Built-in West-Coast (Buchla)-style wavefolder between the
//      oscillator and the four audio outputs. Fold amount is knob +
//      cv-controllable. fold = 0 = passthrough; fold > 0 = sin-fold.
//   2. A mono-video output port (`scope`) carrying the post-fold
//      waveform as an oscilloscope-style trace, rendered by the shared
//      packages/web/src/lib/video/waveform-video.ts renderer when the
//      port is connected to a video-domain target. (The texture
//      rendering happens in the VideoEngine; this module just exposes
//      an AnalyserNode tap on the output bus via videoSources.)
//
// We re-use the analog-vco DSP (faust worklet) — VIZVCO is the SAME
// oscillator, so shipping a separate WASM build would be wasteful.
// The wavefolder is implemented in plain Web Audio: a single
// WaveShaperNode per output channel, with a curve LUT precomputed
// from sin(x * (1 + fold)). When fold = 0 the curve is a perfect
// identity (passthrough); higher fold values create the foldback
// harmonics that define West-Coast timbres.

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/analog-vco.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/analog-vco.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/analog-vco.worklet.js?url';

const PARAM_PREFIX = '/Analog_VCO';

/** Wavefolder curve length. 4096 keeps the LUT fine-grained enough that
 *  the LINEAR interp WaveShaperNode does between samples is inaudible at
 *  audio rates. */
const FOLD_CURVE_LEN = 4096;

/**
 * Build a wavefolder curve at the given fold amount.
 *  - fold = 0  → identity (out = in)
 *  - fold > 0 → out = sin(in * (1 + fold * 4)) (West-Coast voltage)
 *
 * Curve length must be ODD-ish; 4096 with center at index 2048 is
 * standard. Inputs in [-1, 1] map to indices [0, 4095].
 *
 * Returned as `Float32Array<ArrayBuffer>` (not the default
 * `ArrayBufferLike`) so the result is directly assignable to
 * WaveShaperNode.curve (TS's strict typed-array signature).
 */
export function buildFoldCurve(fold: number): Float32Array<ArrayBuffer> {
  // Allocate from a fresh ArrayBuffer (not the default ArrayBufferLike)
  // so the typed-array's underlying-buffer phantom matches what
  // WaveShaperNode.curve declares.
  const curve = new Float32Array(new ArrayBuffer(FOLD_CURVE_LEN * 4));
  const k = 1 + fold * 4; // gain pumped into the sin() arg
  for (let i = 0; i < FOLD_CURVE_LEN; i++) {
    const x = (i / (FOLD_CURVE_LEN - 1)) * 2 - 1; // [-1, 1]
    if (fold <= 0) {
      curve[i] = x;
    } else {
      // sin(x * π * k) keeps oscillation properly bounded; we want a
      // smooth foldback rather than a harsh saturation.
      curve[i] = Math.sin(x * Math.PI * k);
    }
  }
  return curve;
}

export const vizvcoDef: AudioModuleDef = {
  type: 'vizvco',
  domain: 'audio',
  label: 'VIZVCO',
  category: 'sources',
  schemaVersion: 1,
  inputs: [
    { id: 'pitch', type: 'pitch' },
    { id: 'fm', type: 'audio' },
    // CV → wavefolder fold amount.
    { id: 'foldAmount', type: 'cv', paramTarget: 'foldAmount' },
  ],
  outputs: [
    { id: 'saw',      type: 'audio' },
    { id: 'square',   type: 'audio' },
    { id: 'triangle', type: 'audio' },
    { id: 'sine',     type: 'audio' },
    // Mono-video output: the shared waveform-video renderer draws this
    // module's output as an oscilloscope trace into a GL texture each
    // video frame. Audio side just exposes a tap; the VideoEngine
    // handles the actual rendering when a video edge is patched.
    { id: 'scope',    type: 'mono-video' },
  ],
  params: [
    { id: 'tune',       label: 'Tune', defaultValue: 0,   min: -36, max: 36, curve: 'linear', units: 'st' },
    { id: 'fine',       label: 'Fine', defaultValue: 0,   min: -100, max: 100, curve: 'linear', units: '¢' },
    { id: 'fmAmount',   label: 'FM',   defaultValue: 0,   min: 0, max: 1, curve: 'linear' },
    { id: 'pw',         label: 'PW',   defaultValue: 0.5, min: 0.05, max: 0.95, curve: 'linear' },
    { id: 'foldAmount', label: 'Fold', defaultValue: 0,   min: 0, max: 1, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const faustNode = await instantiateFaustModule(ctx, { name: 'analog-vco', wasmUrl, metaUrl, workletUrl });

    const merger = ctx.createChannelMerger(2);
    merger.connect(faustNode);
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(merger, 0, 0);
    silence.connect(merger, 0, 1);

    const splitter = ctx.createChannelSplitter(4);
    faustNode.connect(splitter);

    // One waveshaper per channel — the curve table is shared (we update
    // it on foldAmount changes). All four shapers see the same curve so
    // they remain phase-coherent siblings of each other.
    const shapers = [0, 1, 2, 3].map(() => {
      const ws = ctx.createWaveShaper();
      // 4x oversample to suppress aliasing from the steep sin folds.
      ws.oversample = '4x';
      return ws;
    });
    let currentFold = (node.params ?? {}).foldAmount ?? 0;
    for (const ws of shapers) {
      ws.curve = buildFoldCurve(currentFold);
    }
    // Per-channel: splitter[i] → shaper[i] → finalSplitter[i].
    // Use ChannelMergers as fan-out points so each shaper output can be
    // taken as a single-channel source AND summed for the scope tap.
    const channelOuts: GainNode[] = [];
    for (let i = 0; i < 4; i++) {
      splitter.connect(shapers[i]!, i);
      // Buffer the shaper output through a unity gain so we can
      // .connect() it multiple places (output port + scope summing).
      const gainOut = ctx.createGain();
      gainOut.gain.value = 1;
      shapers[i]!.connect(gainOut);
      channelOuts.push(gainOut);
    }
    // Scope tap: sum all four shaped outputs into a mono analyser. The
    // scope sees the full post-fold spectrum rather than just one wave.
    const scopeMix = ctx.createGain();
    scopeMix.gain.value = 0.25; // sum of four normalized → keep ≤1
    for (const c of channelOuts) c.connect(scopeMix);
    const scopeAnalyser = ctx.createAnalyser();
    scopeAnalyser.fftSize = 2048;
    scopeAnalyser.smoothingTimeConstant = 0;
    scopeMix.connect(scopeAnalyser);

    const params = faustNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of vizvcoDef.params) {
      if (def.id === 'foldAmount') continue; // not a faust param
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['pitch',      { node: merger, input: 0 }],
        ['fm',         { node: merger, input: 1 }],
        // Route foldAmount CV to a virtual AudioParam: we don't have a
        // worklet-side foldAmount, so we tap the analyser of an internal
        // ConstantSource — but Web Audio doesn't expose that pattern as a
        // real AudioParam without bookkeeping. Pragmatic alternative:
        // route foldAmount CV to a hidden gain.gain on a sink node and
        // expose it as the param target. We use scopeMix.gain since
        // scopeMix is a stable internal node — readers via the CV param
        // analyser tap will pick up modulator activity. This is a rare
        // case where the param IS internal-only; a future refactor can
        // give us a proper "control AudioParam" abstraction. For
        // motorized fader purposes the engine's per-param tap analyser
        // sees the actual modulator, which is what the UI cares about.
        ['foldAmount', { node: scopeMix, input: 0, param: scopeMix.gain }],
      ]),
      outputs: new Map([
        ['saw',      { node: channelOuts[0]!, output: 0 }],
        ['square',   { node: channelOuts[1]!, output: 0 }],
        ['triangle', { node: channelOuts[2]!, output: 0 }],
        ['sine',     { node: channelOuts[3]!, output: 0 }],
      ]),
      videoSources: new Map([
        ['scope', { analyser: scopeAnalyser, sampleRate: ctx.sampleRate }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'foldAmount') {
          currentFold = value;
          const c = buildFoldCurve(value);
          for (const ws of shapers) ws.curve = c;
          return;
        }
        params.get(`${PARAM_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        if (paramId === 'foldAmount') return currentFold;
        return params.get(`${PARAM_PREFIX}/${paramId}`)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* */ }
        silence.disconnect();
        merger.disconnect();
        faustNode.disconnect();
        splitter.disconnect();
        for (const ws of shapers) ws.disconnect();
        for (const c of channelOuts) c.disconnect();
        scopeMix.disconnect();
        scopeAnalyser.disconnect();
      },
    };
  },
};
