// packages/web/src/lib/audio/modules/analog-vco.ts
//
// ANALOG VCO — classic analog-style voltage-controlled oscillator.
//
// One pitched oscillator emitting four simultaneous classic waveforms
// (saw, square, triangle, sine) PLUS a continuous saw→sine→square MORPH
// output driven by the `shape` knob (0=saw, 0.5=sine, 1=square) and its
// CV input — V/oct pitch tracking, audio-rate FM and PM inputs, plus the
// standard tune / fine / pulse-width controls.
// The DSP is Faust-compiled (see packages/dsp/src/analog-vco.dsp) and
// hosted in a Faust AudioWorklet. A ChannelMerger routes the pitch /
// FM / PM ports onto distinct input channels so per-port modulation
// stays isolated; a ChannelSplitter exposes the four waveform tap-offs
// on separate output ports. This is the project's bread-and-butter
// pitched source — patch one into VCA → ADSR → AUDIO OUT for a one-osc
// voice, or stack saw + square through a filter for a chorused bass.
//
// Inputs:
//   pitch (pitch): V/oct pitch input, 0V = C4. Drives oscillator frequency.
//   fm (audio): audio-rate frequency modulator, scaled by the fmAmount param.
//   pm (audio): audio-rate phase modulator, scaled by the pmAmount param.
//   tune (cv, linear, paramTarget=tune): displaces the tune knob (semitones).
//   fine (cv, linear, paramTarget=fine): displaces the fine knob (cents).
//   fmAmount (cv, linear, paramTarget=fmAmount): displaces the FM-depth knob.
//   pmAmount (cv, linear, paramTarget=pmAmount): displaces the PM-depth knob.
//   shape (cv, linear, paramTarget=shape): displaces the morph knob (0..1).
//
// Outputs:
//   saw (audio): naive sawtooth tap.
//   square (audio): pulse/square tap; duty cycle set by the pw param.
//   triangle (audio): triangle tap.
//   sine (audio): sine tap.
//   morph (audio): continuous saw→sine→square crossfade set by the shape knob.
//
// Params:
//   tune (linear -36..36, default 0): coarse tune in semitones.
//   fine (linear -100..100, default 0): fine tune in cents.
//   fmAmount (linear -1..1, default 0): depth of the FM input.
//   pmAmount (linear -1..1, default 0): depth of the PM input.
//   pw (linear 0.05..0.95, default 0.5): square-wave pulse width / duty.
//   shape (linear 0..1, default 0): morph output waveform. 0=saw, 0.5=sine,
//     1=square. At 0 the morph output equals the saw tap (back-compat).

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/analog-vco.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/analog-vco.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/analog-vco.worklet.js?url';

const PARAM_PREFIX = '/Analog_VCO';

export const analogVcoDef: AudioModuleDef = {
  type: 'analogVco',
  domain: 'audio',
  label: 'Analog VCO',
  category: 'sources',
  schemaVersion: 4,
  migrate(data, fromVersion) {
    const d = (data ?? {}) as { params?: Record<string, number> };
    const params = { ...(d.params ?? {}) };
    if (fromVersion < 2) {
      // v1 → v2: pmAmount param added. Seed with default 0 if missing so the
      // legacy DSP-less behavior (no PM) is preserved for v1 saved patches.
      if (params.pmAmount === undefined) params.pmAmount = 0;
    }
    // v2 → v3: fmAmount / pmAmount widened from [0..1] to [-1..+1]. Existing
    // values are already in [0..1] which is a legal subset of [-1..+1] — the
    // user's stored value lands at the same audible position with new
    // headroom below zero. No param transform required.
    if (fromVersion < 4) {
      // v3 → v4: `shape` morph param + `morph` output port added. Seed shape
      // at its default 0 (= saw) so existing patches' four fixed taps are
      // unchanged and the new morph output, if wired, starts as a bare saw.
      if (params.shape === undefined) params.shape = 0;
    }
    return { ...d, params };
  },
  inputs: [
    { id: 'pitch', type: 'pitch' },
    { id: 'fm',    type: 'audio' },
    { id: 'pm',    type: 'audio' },
    { id: 'tune',     type: 'cv', paramTarget: 'tune',     cvScale: { mode: 'linear' } },
    { id: 'fine',     type: 'cv', paramTarget: 'fine',     cvScale: { mode: 'linear' } },
    { id: 'fmAmount', type: 'cv', paramTarget: 'fmAmount', cvScale: { mode: 'linear' } },
    { id: 'pmAmount', type: 'cv', paramTarget: 'pmAmount', cvScale: { mode: 'linear' } },
    { id: 'shape',    type: 'cv', paramTarget: 'shape',    cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'saw',      type: 'audio' },
    { id: 'square',   type: 'audio' },
    { id: 'triangle', type: 'audio' },
    { id: 'sine',     type: 'audio' },
    { id: 'morph',    type: 'audio' },
  ],
  params: [
    { id: 'tune',     label: 'Tune', defaultValue: 0,   min: -36,   max: 36,   curve: 'linear', units: 'semi' },
    { id: 'fine',     label: 'Fine', defaultValue: 0,   min: -100,  max: 100,  curve: 'linear', units: 'cent' },
    { id: 'fmAmount', label: 'FM',   defaultValue: 0,   min: -1,    max: 1,    curve: 'linear' },
    { id: 'pmAmount', label: 'PM',   defaultValue: 0,   min: -1,    max: 1,    curve: 'linear' },
    { id: 'pw',       label: 'PW',   defaultValue: 0.5, min: 0.05,  max: 0.95, curve: 'linear' },
    { id: 'shape',    label: 'Wave', defaultValue: 0,   min: 0,     max: 1,    curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const faustNode = await instantiateFaustModule(ctx, { name: 'analog-vco', wasmUrl, metaUrl, workletUrl });

    // ChannelMerger routes per-port mono signals to distinct channels of
    // Faust's single multi-channel input. This is what makes sequencer.pitch
    // affect ONLY the pitch channel without bleeding into fm/pm.
    const merger = ctx.createChannelMerger(3);
    merger.connect(faustNode);
    // Feed silence to every merger input so the node stays in the active
    // processing graph even when nothing's externally patched. Without this,
    // a fresh module (no inputs connected) doesn't process and there's no audio.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(merger, 0, 0);
    silence.connect(merger, 0, 1);
    silence.connect(merger, 0, 2);

    // Splitter for the 5-channel output (saw / square / triangle / sine / morph).
    const splitter = ctx.createChannelSplitter(5);
    faustNode.connect(splitter);

    // Live single-cycle waveform tap. An AnalyserNode hangs off the MORPH
    // output (channel 4) so the on-card scope draws exactly what the morph
    // emits — reflecting both the `shape` knob/CV AND any FM / pitch / PM
    // modulation in real time (the analyser sees the post-DSP signal). It's a
    // pure sink (never connected onward), so it adds no load to the audio path.
    const scopeAnalyser = ctx.createAnalyser();
    scopeAnalyser.fftSize = 2048;
    scopeAnalyser.smoothingTimeConstant = 0;
    splitter.connect(scopeAnalyser, 4);
    const scopeBuf = new Float32Array(scopeAnalyser.fftSize);

    const params = faustNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of analogVcoDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }

    // Current oscillator frequency in Hz, used by the card to size one period.
    // Mirrors the DSP's freqHz(): 261.626 Hz (C4) × 2^(pitch + tune/12 +
    // fine/1200). pitch is the live V/oct CV (audio-rate) which we can't read
    // here, so the card falls back to zero-crossing windowing when the morph
    // is FM'd / pitched away from the knob-implied frequency.
    function currentFreqHz(): number {
      const tune = params.get(`${PARAM_PREFIX}/tune`)?.value ?? 0;
      const fine = params.get(`${PARAM_PREFIX}/fine`)?.value ?? 0;
      const f = 261.626 * Math.pow(2, tune / 12 + fine / 1200);
      return Math.min(20000, Math.max(1, f));
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['pitch', { node: merger, input: 0 }],
        ['fm',    { node: merger, input: 1 }],
        ['pm',    { node: merger, input: 2 }],
        // CV → AudioParam routing. The engine's addEdge fast-path uses `param`
        // to interpose the cvScale chain so an LFO ±1 sweeps the param's
        // natural range centered on the knob position.
        ['tune',     { node: faustNode, input: 0, param: params.get(`${PARAM_PREFIX}/tune`)!     }],
        ['fine',     { node: faustNode, input: 0, param: params.get(`${PARAM_PREFIX}/fine`)!     }],
        ['fmAmount', { node: faustNode, input: 0, param: params.get(`${PARAM_PREFIX}/fmAmount`)! }],
        ['pmAmount', { node: faustNode, input: 0, param: params.get(`${PARAM_PREFIX}/pmAmount`)! }],
        ['shape',    { node: faustNode, input: 0, param: params.get(`${PARAM_PREFIX}/shape`)!    }],
      ]),
      outputs: new Map([
        ['saw',      { node: splitter, output: 0 }],
        ['square',   { node: splitter, output: 1 }],
        ['triangle', { node: splitter, output: 2 }],
        ['sine',     { node: splitter, output: 3 }],
        ['morph',    { node: splitter, output: 4 }],
      ]),
      setParam(paramId, value) {
        params.get(`${PARAM_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(`${PARAM_PREFIX}/${paramId}`)?.value;
      },
      // The on-card single-cycle scope reads this snapshot on rAF. `freqHz` is
      // the knob-implied frequency for window sizing; the buffer is the live
      // morph output so the trace reflects shape + modulation as it happens.
      read(key) {
        if (key !== 'waveform') return undefined;
        scopeAnalyser.getFloatTimeDomainData(scopeBuf);
        return { data: scopeBuf, sampleRate: ctx.sampleRate, freqHz: currentFreqHz() };
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        silence.disconnect();
        merger.disconnect();
        faustNode.disconnect();
        splitter.disconnect();
        scopeAnalyser.disconnect();
      },
    };
  },
};

/** Shape of the live waveform snapshot read via `engine.read(node, 'waveform')`.
 *  Exported so the card + tests share one type. */
export interface VcoWaveformSnapshot {
  /** Float time-domain samples from the morph-output analyser ([-1, 1)). */
  data: Float32Array;
  sampleRate: number;
  /** Knob-implied fundamental in Hz (tune/fine only — used to size one period
   *  when zero-crossing detection can't lock a cycle). */
  freqHz: number;
}
