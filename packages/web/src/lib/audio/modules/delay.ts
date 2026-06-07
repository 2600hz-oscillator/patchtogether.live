// packages/web/src/lib/audio/modules/delay.ts
//
// DELAY — simple stereo-input / stereo-output delay line with time +
// feedback + mix. Pure-JS factory using Web Audio's built-in
// DelayNode + a feedback GainNode loop. No worklet, no Faust — the
// browser already has a low-latency delay primitive and the topology
// (input → delay → feedback → output, mixed with dry) is the canonical
// pattern every delay book describes the same way.
//
// Inspiration: shape-identical to VCV Rack's `dDelay` simple delay
// (BSD-3) and the Faust stdlib `de.delay` (MIT). No code lifted —
// the topology is generic enough that this is just "a delay".
//
// Knob curves chosen to match the typical eurorack delay (time log
// from 1 ms to 2 s; feedback linear 0..0.95 with hard ceiling; mix
// linear 0..1 dry-to-wet).
//
// Why a separate module instead of just inlining inside WAVESCULPT's
// FX slot: DELAY is broadly useful as a standalone patchable module,
// and the WAVESCULPT FX slots want to share the SAME delay instance
// type so the audible character matches when you pull DELAY out of an
// FX slot and into a patch wire.
//
// Inputs:
//   audio (audio): dry signal feeding the delay line.
//   time (cv, linear, paramTarget=time): displaces the delay-time knob.
//
// Outputs:
//   audio (audio): dry + wet, balance set by mix.
//
// Params:
//   time (log 0.001..MAX_DELAY_S, default 0.25): delay time in seconds.
//   feedback (linear 0..MAX_FEEDBACK, default 0.4): feedback ratio (hard-ceilinged).
//   mix (linear 0..1, default 0.35): dry/wet balance (0 = dry, 1 = wet only).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

/** Maximum delay time in seconds. AudioContext's DelayNode requires a
 *  fixed max at construction; we lock it at 2 s — covers everything
 *  from short slapback (~30 ms) to long ambient washes (~1.5 s) plus
 *  a small safety margin. */
const MAX_DELAY_S = 2;

/** Hard ceiling on feedback so a runaway patch can't blow speakers.
 *  At 0.95 the tail decays in finite time (audible for ~50 reps before
 *  dropping below -60 dB); above that you get self-oscillation that
 *  most users don't want and that destroys monitor cones. */
const MAX_FEEDBACK = 0.95;

export const delayDef: AudioModuleDef = {
  type: 'delay',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'delay',
  category: 'effects',
  schemaVersion: 1,
  inputs: [
    { id: 'audio', type: 'audio' },
    { id: 'time',  type: 'cv', paramTarget: 'time', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'audio', type: 'audio' },
  ],
  params: [
    { id: 'time',     label: 'Time', defaultValue: 0.25, min: 0.001, max: MAX_DELAY_S, curve: 'log',    units: 's' },
    { id: 'feedback', label: 'Fb',   defaultValue: 0.4,  min: 0,     max: MAX_FEEDBACK, curve: 'linear' },
    { id: 'mix',      label: 'Mix',  defaultValue: 0.35, min: 0,     max: 1,            curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const inputGain = ctx.createGain();
    inputGain.gain.value = 1;

    // Dry path — straight through, scaled by (1 - mix).
    const dry = ctx.createGain();
    dry.gain.value = 1 - (node.params?.mix as number ?? 0.35);
    inputGain.connect(dry);

    // Wet path — input → delay → feedback loop → wetGain → output.
    const delay = ctx.createDelay(MAX_DELAY_S);
    delay.delayTime.value = node.params?.time as number ?? 0.25;
    const feedback = ctx.createGain();
    feedback.gain.value = Math.min(MAX_FEEDBACK, node.params?.feedback as number ?? 0.4);
    const wet = ctx.createGain();
    wet.gain.value = node.params?.mix as number ?? 0.35;

    // Wiring:
    //   inputGain → delay → wet → output
    //                  ↑      ↓
    //                  └─ feedback ──── delay (loop)
    inputGain.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(wet);

    const output = ctx.createGain();
    output.gain.value = 1;
    dry.connect(output);
    wet.connect(output);

    return {
      domain: 'audio',
      inputs: new Map([
        ['audio', { node: inputGain, input: 0 }],
        // Time CV → DelayNode.delayTime via the engine's CV→AudioParam path.
        ['time',  { node: delay,     input: 0, param: delay.delayTime }],
      ]),
      outputs: new Map([
        ['audio', { node: output, output: 0 }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'time') {
          // setTargetAtTime instead of setValueAtTime — instant jumps
          // produce a click at the loop point because the buffer head
          // jumps too. ~10 ms smoothing is below the perceptual jitter
          // floor for delay-time mod yet fast enough to feel
          // responsive when you turn the knob.
          delay.delayTime.setTargetAtTime(
            Math.max(0.001, Math.min(MAX_DELAY_S, value)),
            ctx.currentTime,
            0.01,
          );
        } else if (paramId === 'feedback') {
          feedback.gain.setTargetAtTime(
            Math.max(0, Math.min(MAX_FEEDBACK, value)),
            ctx.currentTime,
            0.01,
          );
        } else if (paramId === 'mix') {
          const m = Math.max(0, Math.min(1, value));
          // Equal-power-style crossfade — perceptual loudness stays
          // roughly constant from full-dry to full-wet. Square-root
          // gives a nice halfway-mix that doesn't sag.
          dry.gain.setTargetAtTime(Math.sqrt(1 - m), ctx.currentTime, 0.01);
          wet.gain.setTargetAtTime(Math.sqrt(m),     ctx.currentTime, 0.01);
        }
      },
      readParam(paramId) {
        if (paramId === 'time')     return delay.delayTime.value;
        if (paramId === 'feedback') return feedback.gain.value;
        if (paramId === 'mix')      return wet.gain.value * wet.gain.value;
        return undefined;
      },
      dispose() {
        try { inputGain.disconnect(); } catch { /* */ }
        try { dry.disconnect();       } catch { /* */ }
        try { delay.disconnect();     } catch { /* */ }
        try { feedback.disconnect();  } catch { /* */ }
        try { wet.disconnect();       } catch { /* */ }
        try { output.disconnect();    } catch { /* */ }
      },
    };
  },
};
