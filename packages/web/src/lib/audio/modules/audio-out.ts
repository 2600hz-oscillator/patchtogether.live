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
//     2. Master limiter — DynamicsCompressorNode with permissive settings
//        (threshold -6dB, ratio 4:1, attack 3ms, release 50ms, knee 6dB).
//        Acts as a transparent ceiling; under normal mix levels it is
//        inactive. Catches the case where multiple sound sources sum into
//        a peak above 0 dBFS. Without it, the peak clips at the device.
//
//   Both stages are ALWAYS on for the terminal output. They are designed
//   to be inaudible on properly-leveled mixes; the design intent is "no
//   speaker damage from a runaway patch", not "make everything sound
//   compressed."

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

export const audioOutDef: AudioModuleDef = {
  type: 'audioOut',
  domain: 'audio',
  label: 'Audio Out',
  category: 'output',
  schemaVersion: 2, // bumped: previously had a single 'audio' input

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

  /**
   * Migrate a v1 Audio Out node (single 'audio' input) to v2 (L+R). Edges that
   * targeted the old 'audio' port get rewritten to 'L' (mono → left). Callers
   * are expected to handle the edge migration; the data shape itself is
   * unchanged so this is a no-op at the node level.
   */
  migrate(data, _fromVersion) {
    return data;
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
    // DynamicsCompressorNode is stereo-by-design: feed it stereo, get
    // stereo. We collapse the two DC-blocked channels into a single
    // ChannelMergerNode → limiter → destination.
    //
    // Settings chosen for "transparent ceiling, not glue compressor":
    //   * threshold -6 dB — lets normal mixes through untouched.
    //   * ratio 4:1     — soft brake, not a brick wall.
    //   * knee 6 dB     — smooth onset, no audible knee.
    //   * attack 3 ms   — catches fast transients before they clip.
    //   * release 50 ms — fast enough to avoid pumping.
    const merger = ctx.createChannelMerger(2);
    dcL.connect(merger, 0, 0);
    dcR.connect(merger, 0, 1);

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.ratio.value = 4;
    limiter.knee.value = 6;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.05;
    merger.connect(limiter);
    limiter.connect(ctx.destination);

    // Terminal-output tap. An AnalyserNode hung off the SAME limiter node that
    // feeds ctx.destination, so a read of its buffer proves signal actually
    // reached the audible terminal stage — not merely some upstream analyser
    // (e.g. a SCOPE's ch1 sink, which buffers samples whether or not anything
    // downstream reaches the speakers). E2E audibility assertions read this via
    // read('outputSnapshot'); it is a passive sink (never connected onward) so
    // it costs nothing audible and can't alter the signal path.
    const outTap = ctx.createAnalyser();
    outTap.fftSize = 2048;
    outTap.smoothingTimeConstant = 0;
    limiter.connect(outTap);
    const outBuf = new Float32Array(outTap.fftSize);

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
        limiter.disconnect();
        try { outTap.disconnect(); } catch { /* */ }
      },
    };
  },
};
