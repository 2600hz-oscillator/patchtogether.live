// packages/web/src/lib/audio/modules/dockscope.ts
//
// DOCKSCOPE — the slim, rail-friendly oscilloscope (P2.5b; owner answer Q3
// pre-approved it: "if the regular scope cards dock poorly, owner
// pre-approves a NEW `dockscope` module variant"). The regular SCOPE's
// 320×300 fixed-raster trace upscales soft under the dock's 50–150% scale
// ladder — the P2.5a assessment's disqualifier. DOCKSCOPE is the answer:
// a 1u-tier HORIZONTAL trace whose card re-renders the vector trace at the
// live on-screen pixel size every frame (see dockscope-draw.ts), so it
// stays crisp at every dock zoom step. It is dockable by default
// (DOCKABLE_TYPES) and an ordinary canvas card everywhere else.
//
// Contract (deliberately slim):
//   * ch1 (audio input, accepts cv/pitch/gate — SCOPE's probe convention):
//     the one signal the trace draws. SCOPE has NO sync-trigger input
//     convention to mirror, so DOCKSCOPE is ch1-only by design — patch the
//     full SCOPE when you need dual traces, XY mode, passthrough outputs,
//     the tuner, or CV-per-param modulation.
//   * NO outputs: DOCKSCOPE is a terminal visualiser (an analysis sink,
//     like SPECTROGRAPH), not an inline probe — that keeps it out of the
//     audio-profile ART gate (nothing to capture) and the behavioral
//     sweep's output-delta dimension by SHAPE, not by exemption.
//   * Display-only params (timeMs / scale / range) mirror SCOPE's
//     conventions and never touch the audio path.
//
// Engine: SCOPE's exact analyser plumbing — a GainNode input feeding an
// AnalyserNode tap (fftSize 2048, smoothing 0) — shared by convention, and
// the trace math is IMPORTED from scope-draw (pixelFromSample + range
// conventions) rather than forked.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

/** What `read('snapshot')` returns: the live analyser window. */
export interface DockscopeSnapshot {
  samples: Float32Array;
  sampleRate: number;
}

export const dockscopeDef: AudioModuleDef = {
  type: 'dockscope',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'dockscope',
  category: 'utilities',
  // Rack: 1u tier, 2 tiles wide — the slim horizontal-trace form factor
  // that reads well in a dock rail at any step of the 50–150% ladder.
  size: '1u',
  hp: 2,

  inputs: [
    // The probe input: typed `audio`, but a scope is a VISUALIZER, so it
    // also accepts the CV family for scoping LFOs / envelopes / pitch CV /
    // gates — same per-port opt-in as SCOPE's ch1.
    { id: 'ch1', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
  ],
  outputs: [],
  params: [
    { id: 'timeMs', label: 'Time', defaultValue: 20, min: 1, max: 200, curve: 'log', units: 'ms' },
    { id: 'scale',  label: 'Scale', defaultValue: 1, min: 0.1, max: 10, curve: 'log' },
    // 0 = audio (±1 fills the trace), 1 = cv (±5V — Eurorack CV convention).
    { id: 'range',  label: 'Range', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
  ],

  docs: {
    explanation:
      "A slim one-channel oscilloscope built for the workflow dock rails — a single horizontal trace in a 1u face that stays crisp at every dock zoom step, because the trace is re-drawn as vectors at the card's live on-screen resolution instead of stretching a fixed bitmap (the reason the full SCOPE looks soft when docked). Patch any signal into CH1 to see it: the input is typed audio but also accepts CV, pitch, and gate cables, so it doubles as a rail-side LFO/envelope/gate monitor. A TIME knob sets how wide a window fills the trace, SCALE zooms the amplitude, and RANGE switches the display between audio (±1) and Eurorack CV (±5V) conventions. It is a terminal visualiser: the signal is only observed, never passed through — there are no outputs, so patch the full SCOPE instead when you need an inline probe, dual channels, XY mode, or the tuner. DOCKSCOPE is dockable by default and works as an ordinary canvas card too. Display-only — nothing here touches the audio path.",
    inputs: {
      ch1: "The probe: whatever is patched here is drawn on the trace. Typed audio but also accepts CV, pitch, and gate, so you can watch LFOs, envelopes, pitch CV, and gates from a dock rail. The signal is observed only — DOCKSCOPE has no outputs.",
    },
    outputs: {},
    controls: {
      timeMs: "The time window drawn across the trace width (1 to 200 ms, log, default 20): small values zoom in on a few cycles, large values show a longer slice — same convention as SCOPE's TIME knob.",
      scale: "Vertical zoom (0.1× to 10×, log, default 1): magnifies a quiet signal or shrinks a hot one to fit the 1u trace.",
      range: "Display range: 0 = audio (±1 fills the trace), 1 = CV (±5V Eurorack scaling) so a multi-octave pitch sweep or a 5V gate reads at a sensible height. Display-only.",
    },
  },

  async factory(ctx, _node): Promise<AudioDomainNodeHandle> {
    // SCOPE's channel plumbing, single-channel: input → gain, with an
    // analyser tap. The analyser is a sink that buffers samples; nothing
    // routes onward (terminal visualiser).
    const gain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    gain.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    // Display params live on the card (it reads patch.nodes[].params
    // directly, like ScopeCard) — the handle keeps a cache only so
    // setParam/readParam satisfy the engine's handle contract.
    const params: Record<string, number> = { timeMs: 20, scale: 1, range: 0 };

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number }>([
        ['ch1', { node: gain, input: 0 }],
      ]),
      outputs: new Map(),
      setParam(paramId, value) {
        if (paramId in params) params[paramId] = value;
      },
      readParam(paramId) {
        return params[paramId];
      },
      read(key) {
        if (key === 'snapshot') {
          analyser.getFloatTimeDomainData(buf);
          return { samples: buf, sampleRate: ctx.sampleRate } satisfies DockscopeSnapshot;
        }
        // Most-recent time-domain sample at the probe — same e2e seam as
        // SCOPE's ch1_last_sample (signal-arrival asserts).
        if (key === 'ch1_last_sample') {
          analyser.getFloatTimeDomainData(buf);
          return buf[buf.length - 1];
        }
        return undefined;
      },
      dispose() {
        gain.disconnect();
        analyser.disconnect();
      },
    };
  },
};
