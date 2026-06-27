// packages/web/src/lib/audio/modules/featurecv.ts
//
// FEATURECV — an "audio → CV" feature extractor. One audio input → it measures
// WHOLE-SIGNAL timbre + dynamics and emits them as control voltages plus an
// onset trigger. Deliberately distinct from SYNESTHESIA (which does PER-BAND
// energy / gates / onsets); featurecv analyses the broadband signal, time-
// domain only (NO FFT) so it is fully deterministic:
//
//   loud   = broadband RMS              → cv `loud`   (energy / level)
//   bright = zero-crossing rate (ZCR)   → cv `bright` (spectral-brightness proxy)
//   punch  = crest factor (peak / RMS)  → cv `punch`  (transient-ness / dynamics)
//   onset  = time-domain flux onset     → gate `onset` (a clean trigger pulse)
//
// The three CV outputs are BIPOLAR (−1..+1) by DEFAULT; the POLARITY toggle
// (`bipolar`) switches to unipolar 0..1. Bipolar makes a strong feature sweep a
// knob-centred destination's FULL range (a unipolar source only sweeps half).
//
// ARCHITECTURE (mirrors SYNESTHESIA): a `domain: 'audio'` worklet module. The
// `gain` trim is a GainNode BEFORE the worklet (the SPECTROGRAPH pattern); the
// worklet writes each feature to its own mono output channel; the factory fans
// those into per-feature GainNodes (the patchable ports) and routes a muted
// keep-alive to ctx.destination so process() runs while the outputs are
// unpatched (an analyser's outputs usually are). The DSP lives in the pure core
// packages/dsp/src/lib/featurecv-dsp.ts (inlined into the worklet + unit/ART
// tested directly). A `snapshot` of UNIPOLAR feature levels is posted for the
// card's display meters.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/featurecv.js?url';

// Worklet output order = output-port order. Each is a mono channel.
const FEATURE_OUTS = ['loud', 'bright', 'punch', 'onset'] as const;
// k-rate worklet params (gain is the input GainNode, NOT a worklet param).
const WORKLET_PARAMS = ['attack', 'release', 'bipolar', 'onset_sens', 'onset_debounce'] as const;

export interface FeaturecvSnapshot {
  /** UNIPOLAR (0..1) feature levels for the card meters — independent of the
   *  output POLARITY. */
  loud: number;
  bright: number;
  punch: number;
  /** 1 if an onset fired in the latest reported quantum, else 0. */
  onset: number;
}

const loadedContexts = new WeakSet<BaseAudioContext>();

export const featurecvDef: AudioModuleDef = {
  type: 'featurecv',
  // Same palette bucket as SYNESTHESIA / SPECTROGRAPH (the audio-analysis
  // cluster renders flat under Hybrid).
  palette: { top: 'Hybrid', sub: 'Hybrid' },
  domain: 'audio',
  label: 'feature cv',
  category: 'modulation',
  card: 'FeaturecvCard',
  schemaVersion: 1,

  inputs: [
    // The signal under analysis — plain audio PASSTHROUGH into the input trim
    // (it's the measured signal, not a knob modulator → no cvScale/paramTarget).
    { id: 'in', type: 'audio' },
  ],
  outputs: [
    { id: 'loud', type: 'cv' },
    { id: 'bright', type: 'cv' },
    { id: 'punch', type: 'cv' },
    // A trigger that fires ONCE per detected onset (a short pulse); edge-detect
    // it downstream, don't level-sample.
    { id: 'onset', type: 'gate', edge: 'trigger' },
  ],
  params: [
    // Input trim into the analyser (SPECTROGRAPH's gain: log, unity at noon).
    { id: 'gain', label: 'Gain', defaultValue: 1, min: 0.25, max: 4, curve: 'log' },
    // CV-smoothing attack / release (ms, log) — how fast the feature CVs rise /
    // fall. (Ranges mirror ATTACK_*/RELEASE_* in featurecv-dsp.)
    { id: 'attack', label: 'Atk', defaultValue: 10, min: 0.5, max: 500, curve: 'log', units: 'ms' },
    { id: 'release', label: 'Rel', defaultValue: 100, min: 1, max: 2000, curve: 'log', units: 'ms' },
    // POLARITY of the CV outputs: 0 = UNIPOLAR [0,1], 1 = BIPOLAR [-1,+1]
    // (DEFAULT). Discrete 0/1 (a toggle on the card).
    { id: 'bipolar', label: 'Polarity', defaultValue: 1, min: 0, max: 1, curve: 'discrete' },
    // Onset sensitivity (linear) — higher fires on smaller transients.
    { id: 'onset_sens', label: 'Sens', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    // Onset debounce (ms, log) — minimum gap between onset triggers.
    { id: 'onset_debounce', label: 'Debnce', defaultValue: 80, min: 20, max: 1000, curve: 'log', units: 'ms' },
  ],

  docs: {
    explanation:
      "FEATURECV listens to one audio signal and turns its TIMBRE and DYNAMICS into control voltages — an audio-reactive modulation source. Unlike SYNESTHESIA (which splits the sound into frequency bands), featurecv measures the WHOLE signal, in the time domain only (no FFT) so it is fully deterministic. It derives three continuous features — LOUD (broadband RMS = how loud), BRIGHT (zero-crossing rate, a cheap spectral-brightness proxy = how bright/hissy vs dark/bassy), and PUNCH (crest factor = peak ÷ RMS = how spiky/transient vs sustained) — plus an ONSET trigger that pulses on each fresh attack in the sound. The three feature CVs are emitted BIPOLAR (−1..+1) by default so a strong feature sweeps a knob-centred destination's FULL range; flip POLARITY to UNIPOLAR (0..1) for classic envelope-style modulation. GAIN trims the input into the analyser; ATTACK / RELEASE smooth how quickly the CVs react. Patch LOUD into a VCA or filter to track dynamics, BRIGHT into a filter cutoff so the timbre opens up as the source gets brighter, PUNCH into anything you want to react to transients, and ONSET into an envelope generator or drum voice to fire on each hit. The card shows live meters for the three features (display only).",
    inputs: {
      in: "The audio signal to analyse — the measured signal, not a modulator. Its loudness, brightness, and transients drive every output. Patch a drum bus, vocal, synth voice, or full mix here.",
    },
    outputs: {
      loud:
        "LOUD CV — the broadband RMS (overall energy / loudness) of the input, smoothed by ATTACK/RELEASE. Patch into a VCA gain or filter cutoff to make a destination track how loud the source is. Polarity set by the POLARITY toggle.",
      bright:
        "BRIGHT CV — a brightness proxy from the zero-crossing rate: high when the sound is hissy / trebly (cymbals, noise, bright synths), low when it is dark / bassy. Patch into a filter cutoff so the timbre opens with the source's brightness. Polarity set by POLARITY.",
      punch:
        "PUNCH CV — the crest factor (peak ÷ RMS): high for spiky, transient, percussive material and low for sustained, compressed tones. Patch into modulation you want to react to how punchy the source is. Polarity set by POLARITY.",
      onset:
        "ONSET trigger — fires a short pulse ONCE on each detected attack (a fresh transient / hit) in the input, a clean rising edge that crosses the gate threshold. Patch into an envelope generator, VCA, or drum voice to strike it from the live source. SENS sets how readily it fires; DEBNCE sets the minimum gap between pulses.",
    },
    controls: {
      gain:
        "Input trim into the analyser (×0.25..×4, log, unity at noon) — boost a quiet source so its features reach a usable CV range, or tame a hot one. It shapes the ANALYSIS level, not an audio output (there is none).",
      attack:
        "How fast the feature CVs RISE toward a new value (ms, log) — short attack snaps to transients, long attack glides smoothly past them. Applies to LOUD, BRIGHT, and PUNCH.",
      release:
        "How fast the feature CVs FALL back when the input quietens or changes (ms, log) — short release tracks every dip, long release holds a smooth contour. Applies to LOUD, BRIGHT, and PUNCH.",
      bipolar:
        "POLARITY of the three feature CV outputs — BIPOLAR (−1..+1, the default, so a strong feature sweeps a knob-centred destination's full range) vs UNIPOLAR (0..1, classic envelope-style). Toggle on the card; does not affect the ONSET trigger.",
      onset_sens:
        "ONSET sensitivity — higher lowers the detector's adaptive threshold so it fires on smaller transients; lower only triggers on strong, clear attacks. Tune to taste against your source.",
      onset_debounce:
        "ONSET debounce (ms, log) — the minimum time between onset triggers, a lockout that blocks a re-trigger on a transient's ringing tail so one hit makes exactly one pulse.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const nodeParams = node.params ?? {};
    const valueOf = (id: string): number =>
      nodeParams[id] ?? featurecvDef.params.find((p) => p.id === id)!.defaultValue;

    // GAIN trim BEFORE the worklet (SPECTROGRAPH pattern) → worklet input 0.
    const inGain = ctx.createGain();
    inGain.gain.value = valueOf('gain');

    const workletNode = new AudioWorkletNode(ctx, 'featurecv', {
      numberOfInputs: 1,
      numberOfOutputs: 4,
      outputChannelCount: [1, 1, 1, 1],
    });
    inGain.connect(workletNode);

    // Keep-alive: an AudioWorkletNode only runs process() while it has a path
    // to ctx.destination. FEATURECV is an analyser — its outputs are often
    // unpatched — so without this the worklet would never process (no CVs, no
    // onsets, no meters). Route worklet output 0 through a muted gain so the
    // WHOLE processor runs every quantum while the ports sit unpatched.
    const keepAlive = ctx.createGain();
    keepAlive.gain.value = 0;
    workletNode.connect(keepAlive);
    keepAlive.connect(ctx.destination);

    // Fan each mono worklet output → a GainNode = the individually-patchable port.
    const outGains: GainNode[] = [];
    const outputs = new Map<string, { node: AudioNode; output: number }>();
    FEATURE_OUTS.forEach((id, i) => {
      const g = ctx.createGain();
      g.gain.value = 1;
      workletNode.connect(g, i, 0);
      outGains.push(g);
      outputs.set(id, { node: g, output: 0 });
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const id of WORKLET_PARAMS) {
      params.get(id)?.setValueAtTime(valueOf(id), ctx.currentTime);
    }

    // ---- Snapshot pipe (UNIPOLAR feature levels for the card meters) ----
    let snap: FeaturecvSnapshot = { loud: 0, bright: 0, punch: 0, onset: 0 };
    workletNode.port.onmessage = (e: MessageEvent) => {
      const m = e.data as
        | { type?: string; loud?: number; bright?: number; punch?: number; onset?: number }
        | undefined;
      if (!m || m.type !== 'snapshot') return;
      snap = { loud: m.loud ?? 0, bright: m.bright ?? 0, punch: m.punch ?? 0, onset: m.onset ?? 0 };
    };

    const inputs = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>();
    inputs.set('in', { node: inGain, input: 0 });

    return {
      domain: 'audio',
      inputs,
      outputs,
      setParam(paramId, value) {
        if (paramId === 'gain') {
          inGain.gain.setValueAtTime(value, ctx.currentTime);
          return;
        }
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        if (paramId === 'gain') return inGain.gain.value;
        return params.get(paramId)?.value;
      },
      read(key) {
        if (key === 'snapshot') return snap satisfies FeaturecvSnapshot;
        return undefined;
      },
      dispose() {
        try { workletNode.port.onmessage = null; } catch { /* ignore */ }
        for (const g of outGains) g.disconnect();
        keepAlive.disconnect();
        inGain.disconnect();
        workletNode.disconnect();
      },
    };
  },
};
