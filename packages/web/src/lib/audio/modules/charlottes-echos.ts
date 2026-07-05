// packages/web/src/lib/audio/modules/charlottes-echos.ts
//
// CHARLOTTE'S ECHOS — destructive multi-head stereo delay.
//
// A stereo delay with a thicker, more abused character than the basic
// DELAY: per-tap pitch-up grain, gradual feedback-loop decay, and high
// feedback ratios that smear into endless tails. The "destructive" name
// captures the intent — this is the delay you reach for when you want
// the wet path to colour and degrade the source, not stay clean. DSP is
// a TS AudioWorklet (packages/dsp/src/charlottes-echos.ts) built from four
// clean-room AnalogDelayCore stages (the GPL-free own-code core that also
// powers COFEFVE) plus an own-code varispeed shifter for the pitch-up.
// Internally this is the audio sibling of VDELAY in the video domain and is
// the effect 4× COFEFVE analog delays would approximate if stacked in serial.
//
// Inputs:
//   L (audio): left-channel signal.
//   R (audio): right-channel signal.
//   delay (cv, log, paramTarget=delay): scales the delay-time knob (log).
//
// Outputs:
//   L (audio): left-channel wet+dry mix.
//   R (audio): right-channel wet+dry mix.
//
// Params:
//   delay (log 0.001..1.5 s, default 0.4): tap time.
//   feedback (linear 0..1, default 0.5): feedback ratio (high ≈ infinite tails).
//   decay (linear 0..1, default 0.2): per-tap colour-decay (HF loss in the loop).
//   pitchUp (linear 0..0.2, default 0): per-tap pitch-shift on the feedback path.
//   mix (linear 0..1, default 0.5): dry/wet balance.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/charlottes-echos.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

export const charlottesEchosDef: AudioModuleDef = {
  type: 'charlottesEchos',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: "charlotte's echos",
  category: 'effects',
  stereoPairs: [['L', 'R']],

  inputs: [
    { id: 'L',     type: 'audio' },
    { id: 'R',     type: 'audio' },
    // CV scaling per .myrobots/plans/cv-range-standard.md.
    // delay: log (0.001..1.5s).
    { id: 'delay', type: 'cv', paramTarget: 'delay', cvScale: { mode: 'log' } },
  ],
  outputs: [
    { id: 'L', type: 'audio' },
    { id: 'R', type: 'audio' },
  ],
  params: [
    { id: 'delay',    label: 'Delay',  defaultValue: 0.4, min: 0.001, max: 1.5, curve: 'log',    units: 's' },
    { id: 'feedback', label: 'Fbk',    defaultValue: 0.5, min: 0,     max: 1,   curve: 'linear' },
    { id: 'decay',    label: 'Decay',  defaultValue: 0.2, min: 0,     max: 1,   curve: 'linear' },
    { id: 'pitchUp',  label: 'Ptch',   defaultValue: 0,   min: 0,     max: 0.2, curve: 'linear' },
    { id: 'mix',      label: 'Mix',    defaultValue: 0.5, min: 0,     max: 1,   curve: 'linear' },
  ],

  docs: {
    explanation:
      "A destructive multi-head stereo delay — a four-stage cascade of echoes that colour and degrade the source rather than repeating it cleanly. Each of the four stages tap the delayed signal in turn; FEEDBACK is fed to every stage so repeats compound across the chain into smeared, endless tails, DECAY progressively tapers each later stage's level and adds in-loop drive and high-frequency loss for a darkening, dub-like decay, and PITCHUP shifts each stage up by a compounding ratio so the cascaded echoes climb in pitch — the classic ascending-shimmer effect. It is the audio sibling of the video-domain VDELAY, and roughly the sound of four COFEFVE analog delays stacked in serial. Reach for it when you want the wet path to abuse the signal.",
    inputs: {
      L: 'Left-channel input feeding the multi-head delay cascade.',
      R: 'Right-channel input feeding the cascade.',
      delay: 'CV that scales the DELAY-time knob (log-scaled), shifting all tap times together — sweep it for tape-warble and pitch-bend smears on the echoes.',
    },
    outputs: {
      L: 'Left-channel output: the dry signal blended with the four-stage wet cascade per MIX.',
      R: 'Right-channel output: the dry signal blended with the wet cascade per MIX.',
    },
    controls: {
      delay: 'Base tap time in seconds, log-scaled 1 ms..1.5 s — the spacing of the first echo (the cascade stages derive from it). Summed with the DELAY CV input.',
      feedback: 'Feedback amount fed to EVERY stage (0..1). Because it compounds across the four-stage chain, even moderate settings build long tails and high settings smear into near-infinite, self-sustaining echoes.',
      decay: "Per-tap colour-decay (0..1): progressively tapers each later stage's wet level and adds in-loop tanh drive plus high-frequency loss, so the repeats darken and degrade as they fade — the 'destructive', dub-delay character.",
      pitchUp: 'Per-stage upward pitch shift (0..0.2). At 0 the internal varispeed grain shifter is bypassed entirely and the echoes repeat at pitch; above 0 each successive stage is transposed up by a compounding ratio so the cascaded echoes climb in pitch — the signature ascending shimmer.',
      mix: 'Dry / wet balance (0..1): 0 is the clean input, 1 is the cascade only, between crossfades the two.',
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'charlottes-echos', {
      numberOfInputs: 2,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    // Silence keeps the node active even when nothing is patched in.
    const silenceL = ctx.createConstantSource();
    const silenceR = ctx.createConstantSource();
    silenceL.offset.value = 0;
    silenceR.offset.value = 0;
    silenceL.start();
    silenceR.start();
    silenceL.connect(workletNode, 0, 0);
    silenceR.connect(workletNode, 0, 1);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of charlottesEchosDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }
    const pDelay = params.get('delay');
    const pFb = params.get('feedback');
    const pDecay = params.get('decay');
    const pPitch = params.get('pitchUp');
    const pMix = params.get('mix');

    return {
      domain: 'audio',
      inputs: new Map([
        ['L',     { node: workletNode, input: 0 }],
        ['R',     { node: workletNode, input: 1 }],
        ['delay', { node: workletNode, input: 0, param: pDelay! }],
      ]),
      outputs: new Map([
        ['L', { node: workletNode, output: 0 }],
        ['R', { node: workletNode, output: 1 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { silenceL.stop(); } catch { /* */ }
        try { silenceR.stop(); } catch { /* */ }
        silenceL.disconnect();
        silenceR.disconnect();
        workletNode.disconnect();
      },
    };
  },
};
