// packages/web/src/lib/audio/modules/audio-out.ts
//
// Audio Out — terminal stereo output. Two MONO inputs (L, R), each routed to
// the corresponding channel of a stereo bus. Eurorack convention: every patch
// cable is mono; if you want stereo, you patch both L and R.
//
// Audio-fidelity stage (PR feat/audio-fidelity-mixmstrs-comp-swolevco):
//
//   Two safety nets sit between user signal and AudioContext.destination:
//
//     1. DC blocker — a 5Hz BiquadFilter highpass on each channel. Catches
//        DC offset that any module elsewhere in the patch may have allowed
//        to leak through (e.g., LFO patched into an audio chain via VCA;
//        long-running feedback loops biasing slowly). Inaudible at 5Hz —
//        well below the lowest pitched note we care about (~20Hz) — but
//        eliminates the slow drift that, over hours, can clip the
//        downstream limiter or speaker excursion.
//
//     2. Master limiter — a look-ahead brickwall limiter worklet at a
//        -1 dBFS ceiling (packages/dsp/src/lib/master-limiter-dsp.ts).
//        Below the ceiling it is the IDENTITY, so a normally-leveled mix
//        passes untouched; above it, it applies the minimum reduction that
//        reaches the ceiling and the output is genuinely bounded.
//
//   Both stages are ALWAYS on for the terminal output. They are designed
//   to be inaudible on properly-leveled mixes; the design intent is "no
//   speaker damage from a runaway patch", not "make everything sound
//   compressed."
//
// P0-A1 (DSP audit, .myrobots/plans/dsp-stack-bass-freq-audit-2026-07-01.md).
// Stage 2 used to be a plain `DynamicsCompressorNode` at threshold -6 dB,
// ratio 4, knee 6, attack 3 ms, release 50 ms. Measured on that node (see
// art/scenarios/audio-out/master-limiter-sub-pump.test.ts for the harness):
//
//   input peak   sub-band gain ripple   output peak
//     -5.4 dBFS         0.003 dB           0.619
//     -2.9 dBFS         0.259 dB           0.805
//     +0.6 dBFS         1.606 dB           1.065   ← clips
//     +3.1 dBFS         3.044 dB           1.240   ← clips
//     +9.1 dBFS         5.032 dB           1.602   ← clips
//
// i.e. exactly where the safety net was supposed to act, it BOTH pumped the
// sub by several dB per strike AND still let the mix clip the device — a 4:1
// compressor is not a limiter. It also added a constant +1.35 dB of automatic
// makeup gain to every patch, which the brickwall does not.
//
// Inputs:
//   L (audio): left-channel signal to the speakers.
//   R (audio): right-channel signal to the speakers.
//
// Outputs: none (terminal sink).
//
// Params:
//   master (linear 0..1, default 0.7): master output gain pre-limiter.
//
// Read keys (not ports — no contract surface):
//   outputSnapshot            terminal samples, MONO DOWNMIX. Cannot tell
//                             only-L from only-R (both read half level), and
//                             reads ~0 for an anti-phase pair.
//   outputSnapshotL / …R      the same terminal point, PER CHANNEL. Use these
//                             for any assertion about WHICH side is audible.
//                             Negative-controlled both directions on every run
//                             by art/scenarios/audio-out/per-channel-taps.test.ts.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
// The ceiling is imported from the limiter core, NOT re-typed here: the worklet
// and this file's degraded fallback must agree by construction. (Relative,
// because `@patchtogether.live/dsp`'s exports map has no type resolution for
// bare `src/**` specifiers; the `?url` dist import below goes through the
// package name as usual.)
import { MASTER_CEILING_DB } from '../../../../../dsp/src/lib/master-limiter-dsp';
// The degraded tail + the runtime latch recovery live in a DIST-FREE module so
// they are covered by a pure unit test (audio-out-failover.test.ts) — this file
// cannot be imported outside Vite because of the `?url` worklet import below.
import {
  buildCeilingClipper,
  failoverTerminalTailToClip,
} from './audio-out-failover';
import workletUrl from '@patchtogether.live/dsp/dist/master-limiter.js?url';
import { createWorkletNode, onWorkletNodeError } from '$lib/audio/worklet-guard';

const LIMITER_PROCESSOR = 'master-limiter';
const limiterLoaded = new WeakSet<BaseAudioContext>();

export const audioOutDef: AudioModuleDef = {
  type: 'audioOut',
  palette: { top: 'Audio modules', sub: 'I/O' },
  domain: 'audio',
  label: 'audio out',
  category: 'output',

  inputs: [
    { id: 'L', type: 'audio' },
    { id: 'R', type: 'audio' },
  ],
  outputs: [],

  params: [
    {
      id: 'master',
      label: 'Master',
      defaultValue: 0.7,
      min: 0,
      max: 1,
      curve: 'linear',
      units: 'gain',
    },
  ],

  docs: {
    explanation:
      "The terminal stereo output — where the patch reaches your speakers. It takes two mono inputs (L and R), each routed to one side of the stereo bus, following the Eurorack convention that every cable is mono and you patch both sides for stereo. Mental model: the last module in the chain; whatever you wire into L and R is what you hear. Two always-on safety stages sit between your signal and the hardware: a 5 Hz DC-blocking high-pass (inaudible, but it stops slow DC drift from a feedback loop or a misrouted LFO from stressing your speakers) and a master brickwall limiter with a -1 dBFS ceiling. The limiter looks ahead 2 ms, so anything that stays under the ceiling passes through at exactly unity — it does not compress, colour or pump your low end — and anything above it is turned down by just enough to reach the ceiling, which is what stops a runaway patch clipping the device. The card also lets you choose the output device on browsers that support it. There are no outputs — this is a sink.",
    inputs: {
      L: "Left-channel audio to the speakers. Patch a mono source here for the left side; for a stereo source wire both L and R.",
      R: "Right-channel audio to the speakers. Leave it unpatched for a mono signal in L, or wire the right side of a stereo source here.",
    },
    outputs: {},
    controls: {
      master:
        "Master output level applied to both channels before the limiter, 0 (silence) to 1 (unity), default 0.7. It sets your overall loudness; the limiter downstream is a brickwall ceiling that does nothing at all until you exceed -1 dBFS, so use this for the actual mix level rather than driving into the limiter for loudness.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const gainL = ctx.createGain();
    const gainR = ctx.createGain();
    const initialMaster = (node.params ?? {}).master ?? 0.7;
    gainL.gain.value = initialMaster;
    gainR.gain.value = initialMaster;

    // ---------------- Stage 1: DC blocker (per channel) ----------------
    //
    // A 1st-order (Q=0.707) highpass at 5Hz. The cutoff is far below the
    // lowest audible pitch (~20Hz), so the audible frequency content is
    // attenuated by less than 0.1 dB. But DC and sub-audio drift are
    // attenuated by ~12 dB/octave below 5Hz — enough to keep the limiter
    // and speaker safe.
    const dcL = ctx.createBiquadFilter();
    dcL.type = 'highpass';
    dcL.frequency.value = 5;
    dcL.Q.value = 0.707;
    const dcR = ctx.createBiquadFilter();
    dcR.type = 'highpass';
    dcR.frequency.value = 5;
    dcR.Q.value = 0.707;
    gainL.connect(dcL);
    gainR.connect(dcR);

    // ---------------- Stage 2: master limiter (stereo) ----------------
    //
    // Collapse the two DC-blocked channels into one stereo bus, then hand it
    // to the look-ahead brickwall limiter worklet. It is stereo-LINKED (one
    // gain across L/R) so the image never wanders on a peak; the core carries
    // the design notes and the no-overshoot proof.
    const merger = ctx.createChannelMerger(2);
    dcL.connect(merger, 0, 0);
    dcR.connect(merger, 0, 1);

    // `tail` is whatever node ends up feeding ctx.destination — the limiter
    // normally, the degraded clipper if the worklet cannot load.
    let tail: AudioNode;
    // Non-null iff the worklet actually built — the node whose runtime latch we
    // have to survive. See `failoverTerminalTailToClip` above.
    let limiter: AudioWorkletNode | null = null;
    try {
      if (!limiterLoaded.has(ctx)) {
        await ctx.audioWorklet.addModule(workletUrl);
        limiterLoaded.add(ctx);
      }
      // 'discrete' + explicit 2: L and R are two INDEPENDENT mono jacks, not a
      // stereo pair to be up/down-mixed. An unpatched R stays silent.
      limiter = createWorkletNode(node, ctx, LIMITER_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete',
      });
      tail = limiter;
    } catch (err) {
      // audioOut is the TERMINAL sink: a rejected factory here means the whole
      // patch is silent, which is a worse failure than a degraded ceiling. So
      // fall back to a synchronous, pure-graph hard clip at the same ceiling —
      // memoryless, hence still incapable of ducking the sub — and say so.
      //
      // ⚠ THIS CATCH IS LOAD-TIME ONLY. A throw inside the limiter's process()
      // happens on the render thread AFTER construction and cannot reach here.
      // That path is handled by the processorerror wiring further down.
      console.warn(
        `[audio-out] master limiter worklet unavailable; falling back to a ${MASTER_CEILING_DB} dBFS hard clip`,
        err,
      );
      tail = buildCeilingClipper(ctx);
    }
    merger.connect(tail);
    tail.connect(ctx.destination);

    // Terminal-output tap. An AnalyserNode hung off the SAME node that feeds
    // ctx.destination, so a read of its buffer proves signal actually
    // reached the audible terminal stage — not merely some upstream analyser
    // (e.g. a SCOPE's ch1 sink, which buffers samples whether or not anything
    // downstream reaches the speakers). E2E audibility assertions read this via
    // read('outputSnapshot'); it is a passive sink (never connected onward) so
    // it costs nothing audible and can't alter the signal path.
    const outTap = ctx.createAnalyser();
    outTap.fftSize = 2048;
    outTap.smoothingTimeConstant = 0;
    tail.connect(outTap);
    const outBuf = new Float32Array(outTap.fftSize);

    // ---------------- Per-channel terminal taps (L / R) ----------------
    //
    // `outTap` above is STRUCTURALLY BLIND TO STEREO. An AnalyserNode
    // analyses a MONO DOWNMIX per spec (Web Audio §AnalyserNode: the input is
    // down-mixed to mono using its channelCount/channelInterpretation, which
    // default to max/speakers), so on the stereo terminal bus:
    //
    //   - only-L and only-R are INDISTINGUISHABLE — both read exactly half
    //     level. Measured under node-web-audio-api with a 0.5-amplitude sine
    //     into L only: mono tap RMS 0.1745, left tap RMS 0.3491, right 0.
    //   - an ANTI-PHASE stereo pair reads ~0 — "perfectly silent" and
    //     "perfectly cancelling" are the same number.
    //
    // So a `read('outputSnapshot')` assertion can never say WHICH side is
    // audible. These two taps can. A ChannelSplitter(2) hung off the SAME
    // `tail` node that feeds ctx.destination gives one mono stream per
    // channel — same terminal point as `outTap`, so both see limiter action
    // and the master gain, i.e. exactly what the speakers get.
    //
    // Purely additive: `outputSnapshot` above is untouched, and these are
    // passive sinks (never connected onward) so the audible signal path is
    // byte-identical.
    const chanSplit = ctx.createChannelSplitter(2);
    tail.connect(chanSplit);
    const outTapL = ctx.createAnalyser();
    outTapL.fftSize = 2048;
    outTapL.smoothingTimeConstant = 0;
    const outTapR = ctx.createAnalyser();
    outTapR.fftSize = 2048;
    outTapR.smoothingTimeConstant = 0;
    chanSplit.connect(outTapL, 0);
    chanSplit.connect(outTapR, 1);
    const outBufL = new Float32Array(outTapL.fftSize);
    const outBufR = new Float32Array(outTapR.fftSize);

    // ---------------- Runtime latch → hard-clip failover ----------------
    //
    // Registered here rather than at construction because the failover has to
    // rewire the TAPS too, and they do not exist until now. There is no `await`
    // between the limiter's construction and this line, so no event can be
    // missed in the gap: `processorerror` is delivered as a task on the main
    // thread, and this whole factory body runs to completion first.
    //
    // The shared guard (worklet-guard.ts) has ALREADY logged and ledgered the
    // latch by the time this runs — this listener is the RECOVERY, not the
    // report.
    if (limiter) {
      let failedOver = false;
      onWorkletNodeError(limiter, () => {
        if (failedOver) return; // a latched processor may fire more than once
        failedOver = true;
        tail = failoverTerminalTailToClip(ctx, tail, merger, [
          ctx.destination,
          outTap,
          chanSplit,
        ]);
      });
    }

    // Keep both gain nodes in the active graph even if nothing is patched
    // to either input. (Same trick as the Faust modules' channel mergers —
    // a silent ConstantSource per side ensures the node processes.)
    const silenceL = ctx.createConstantSource();
    silenceL.offset.value = 0;
    silenceL.start();
    silenceL.connect(gainL);
    const silenceR = ctx.createConstantSource();
    silenceR.offset.value = 0;
    silenceR.start();
    silenceR.connect(gainR);

    return {
      domain: 'audio',
      inputs: new Map([
        ['L', { node: gainL, input: 0 }],
        ['R', { node: gainR, input: 0 }],
      ]),
      outputs: new Map(),
      setParam(paramId, value) {
        if (paramId === 'master') {
          gainL.gain.setValueAtTime(value, ctx.currentTime);
          gainR.gain.setValueAtTime(value, ctx.currentTime);
        }
      },
      readParam(paramId) {
        if (paramId === 'master') return gainL.gain.value;
        return undefined;
      },
      read(key) {
        // Terminal-output samples — what the limiter is feeding to
        // ctx.destination this frame. Used by e2e to assert end-to-end
        // audibility (signal reached the speakers through the user's patch).
        if (key === 'outputSnapshot') {
          outTap.getFloatTimeDomainData(outBuf);
          return { samples: outBuf, sampleRate: ctx.sampleRate };
        }
        // Per-CHANNEL terminal samples, same shape as `outputSnapshot`, so
        // every existing helper works on them unchanged. Use these — never
        // the mono key — whenever an assertion is about WHICH side is
        // audible; the mono key cannot tell only-L from only-R.
        if (key === 'outputSnapshotL') {
          outTapL.getFloatTimeDomainData(outBufL);
          return { samples: outBufL, sampleRate: ctx.sampleRate };
        }
        if (key === 'outputSnapshotR') {
          outTapR.getFloatTimeDomainData(outBufR);
          return { samples: outBufR, sampleRate: ctx.sampleRate };
        }
        return undefined;
      },
      dispose() {
        try { silenceL.stop(); } catch { /* */ }
        try { silenceR.stop(); } catch { /* */ }
        silenceL.disconnect();
        silenceR.disconnect();
        gainL.disconnect();
        gainR.disconnect();
        dcL.disconnect();
        dcR.disconnect();
        merger.disconnect();
        try { tail.disconnect(); } catch { /* */ }
        try { outTap.disconnect(); } catch { /* */ }
        try { chanSplit.disconnect(); } catch { /* */ }
        try { outTapL.disconnect(); } catch { /* */ }
        try { outTapR.disconnect(); } catch { /* */ }
      },
    };
  },
};
