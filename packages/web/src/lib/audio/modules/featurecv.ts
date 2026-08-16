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

import { createWorkletNode } from '$lib/audio/worklet-guard';
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
  /** 1 if an onset fired at ANY point since the previous snapshot, else 0.
   *
   *  ⚠ SINCE THE PREVIOUS SNAPSHOT, not "in the latest quantum" — which is what
   *  this said, and what the worklet did, and the reason #1744 existed. A post
   *  happens every 16 quanta and a trigger pulse is ~1.9 quanta, so a
   *  latest-quantum flag reported 18.8–25.0 % of the pulses the ONSET jack
   *  emitted. It is latched across the post interval and consumed on each post;
   *  `packages/dsp/src/featurecv-snapshot.test.ts` gates both halves. */
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
    // (DEFAULT). Discrete 0/1.
    //
    // ⚠ THE `options` ROSTER IS WHAT KEEPS THE CARD'S VOCABULARY ON THE FACE.
    // Undeclared, a 0..1 discrete param renders as an anonymous <Toggle> — a
    // two-state switch printing `0` / `1` where the card has always printed
    // `UNI` / `BI`. The roster makes the dock paint the two NAMES on a
    // Segmented and gives every lane tier a persistent readout naming the
    // state. Cosmetic by construction (`ParamOption`): the projection in
    // contract-signature.ts reads id/min/max/curve/defaultValue/units only, so
    // naming a detent cannot move contract-lock.txt.
    {
      id: 'bipolar',
      label: 'Polarity',
      defaultValue: 1,
      min: 0,
      max: 1,
      curve: 'discrete',
      options: [
        { value: 0, label: 'UNI', title: 'Unipolar 0..+1 — classic envelope-style modulation' },
        { value: 1, label: 'BI', title: 'Bipolar −1..+1 — a strong feature sweeps a centred destination fully' },
      ],
    },
    // Onset sensitivity (linear) — higher fires on smaller transients.
    { id: 'onset_sens', label: 'Sens', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    // Onset debounce (ms, log) — minimum gap between onset triggers.
    { id: 'onset_debounce', label: 'Debnce', defaultValue: 80, min: 20, max: 1000, curve: 'log', units: 'ms' },
  ],

  // ── THE FACEPLATE (PF-20) ──────────────────────────────────────────────────
  //
  // WHAT THIS MODULE IS FOR, MUSICALLY. FEATURECV is the rack's LISTENER: the
  // only module that turns an arbitrary sound's TIMBRE and DYNAMICS into
  // control voltage without splitting it into bands first. SYNESTHESIA does
  // per-band energy; an envelope follower does level and nothing else. This one
  // measures the WHOLE signal and publishes three orthogonal descriptions of it
  // — how loud, how bright, how spiky — plus a trigger on every fresh attack.
  // The verb is *point it at a sound and let the sound play the rack*.
  //
  // RANKING, against the measured DSP rather than the declaration order. Every
  // number below is re-derived on every run by
  // `art/scenarios/featurecv/analysis.test.ts` (the shipping worklet, through
  // this def's own factory) and `featurecv-face-model.test.ts`.
  //
  //   1 POLARITY — THE ONLY CONTROL WITH UNCONDITIONAL AUTHORITY. Every other
  //     control on this module is inert until a cable arrives at `in`: with
  //     nothing patched the extractor's three targets are 0 and GAIN, ATK, REL,
  //     SENS and DEBNCE together move the outputs by exactly nothing. POLARITY
  //     still moves all three jacks a FULL RAIL, from −1.00 to 0.00 — which is
  //     also the fact a patcher most needs and least expects, because an
  //     un-driven featurecv at the shipped BIPOLAR default is holding three
  //     destinations at the BOTTOM of their range, not at their centre.
  //   2 GAIN — the only control IN FRONT of the measurement, and the only one
  //     that can destroy a feature outright: LOUD is `clamp01(2·rms·gain)`, so
  //     above an input RMS of −6.02 dBFS at unity the CV is PINNED and stops
  //     modulating. ⚠ Ranked 2 with a stated LIMIT rather than a claim: it
  //     reaches exactly ONE of the three features. ZCR counts sign changes and
  //     crest is a ratio, so both are scale-invariant and the trim is bit-exactly
  //     a no-op on BRIGHT and on PUNCH.
  //   3 ATTACK · 4 RELEASE — they shape all three CVs, always, which is why
  //     they out-rank the onset pair on REACH. They can change the SPEED of a
  //     feature but never its value or its existence, which is why they do not
  //     out-rank GAIN.
  //   5 SENS — the trigger's tunable, ranked below the four above because its
  //     authority is CONDITIONAL and that was measured rather than assumed: on
  //     a clean, well-separated 4 Hz hit train the entire travel is a no-op
  //     (12/12 pulses at SENS 0, 0.25, 0.5, 0.75 and 1). It bites on AMBIGUOUS
  //     material — a tremolo sine goes 1 → 13 pulses across the same travel —
  //     because the threshold is `avgFlux · mult + 0.15` and the fixed floor
  //     dominates whenever the running flux is small.
  //   6 DEBNCE — a lockout, so it only decides how CLOSE two triggers may be.
  //
  // Tier ladder as a sentence: *mini shows POLARITY; compact adds GAIN; the
  // six-cell lane plate and the dock both show all six, so the ranking's whole
  // authority is at the top two.*
  //
  // ⚠ `order` and `pages` DISAGREE, deliberately. `order` is PRIORITY and puts
  // POLARITY first; `pages` is SIGNAL ORDER and puts it LAST on the `feature`
  // page, after the trim and the smoothing whose result it maps. Priority and
  // signal flow genuinely differ here: the map is applied last and matters
  // most.
  //
  // ⚠ GLYPH: 'none', AND THAT IS A DECISION, NOT A DEFAULT. This def declares
  // three `cv` outputs and one `gate`, and NO `audio` output — so
  // `primaryAudioOutPortId` returns null and ANY other glyph resolves to
  // `{kind:'static'}`: a live-looking readout of nothing, which is the marbles
  // defect (#1692). Asserted at its cause in featurecv-face-model.test.ts,
  // negative-controlled in both directions against the real resolver.
  //
  // ⚠ WHAT PROMOTION TAKES AWAY, AND WHY IT IS NOT REPLACED WITH A METER.
  // `FeaturecvCard.svelte` carries three live bars and an ONSET LED pumped from
  // `engine.read(node, 'snapshot')`. A `FaceReadoutValue` sees ONLY params, so
  // they are structurally underivable — and rebuilding them as a polling
  // sidebar panel was rejected on MEASUREMENT, not on cost: the snapshot is the
  // extractor's UNSMOOTHED, always-UNIPOLAR target, so those bars disagree with
  // the jacks they are named after. At the shipped BIPOLAR default and white
  // noise in, the PUNCH bar reads 0.145 while the PUNCH jack sits at −0.703;
  // the bars do not move at all when ATTACK or RELEASE do. What replaces them
  // is the `featurecv-maps` sidebar picture, which is DRAWN from the same
  // constants the worklet uses rather than traced off a snapshot — so it is
  // deterministic on a running graph, a frozen one and a silent rack alike (the
  // `noise-taps` precedent).
  face: {
    order: ['bipolar', 'gain', 'attack', 'release', 'onset_sens', 'onset_debounce'],
    glyph: 'none',

    // TWO PAGES because there are TWO ENGINES, and they share nothing. The
    // three continuous CVs run through a 1024-sample analysis window and a pair
    // of one-pole followers; the ONSET detector runs per-sample on the RAW
    // signal and never touches the window, the followers or the polarity map.
    // A page is a different IDEA, and these two genuinely are.
    pages: [
      { id: 'feature', label: 'feature cv', controls: ['gain', 'attack', 'release', 'bipolar'] },
      { id: 'onset', label: 'onset', controls: ['onset_sens', 'onset_debounce'] },
    ],

    // No `title`, no `hint`, no band hints — owner ruling 2026-08-11: plain
    // labels and values on the face; the explanation lives in `docs`, one
    // right-click away.
    hero: {
      control: 'bipolar',
      readouts: [
        // THE RESTING LEVEL of all three feature CVs with nothing patched.
        // GAIN-invariant (a trim on silence is silence) and the only readout
        // that is; the probe below is its negative control on every render.
        { label: 'idle', valueId: 'featurecv-idle' },
        // WHAT A −12 dBFS SOURCE LEAVES AS LOUD, at the live GAIN and
        // POLARITY. A join no single dial can perform: `0.00` at the shipped
        // defaults, `+1.00` at GAIN 4 (clamped), `−0.75` at GAIN 0.25.
        { label: '−12 dB', valueId: 'featurecv-probe' },
        // THE ONSET THRESHOLD MULTIPLIER — the number SENS maps onto, and the
        // DIRECTION the dial cannot show: 4.00× at SENS 0, 1.20× at SENS 1.
        { label: 'fires at', valueId: 'featurecv-thresh' },
        // THE TRIGGER RATE CEILING the debounce lockout imposes.
        { label: 'max rate', valueId: 'featurecv-max-rate' },
      ],
    },

    sidebar: [
      // THE THREE MAPS — where each feature's window statistic lands on its
      // jack, with the rack's own generators marked. DRAWN, never traced.
      { kind: 'custom', label: 'maps', panelId: 'featurecv-maps' },
      // The three conversions the dials are structurally unable to print: two
      // one-pole time constants as the 10→90 % moves they deliver, and the
      // input level at which LOUD stops moving.
      {
        kind: 'readouts',
        label: 'delivered',
        entries: [
          { label: 'atk rise', valueId: 'featurecv-atk-rise' },
          { label: 'rel fall', valueId: 'featurecv-rel-fall' },
          { label: 'loud clip', valueId: 'featurecv-loud-clip' },
        ],
      },
    ],
  },

  docs: {
    explanation:
      "FEATURECV listens to one audio signal and turns its TIMBRE and DYNAMICS into control voltages — an audio-reactive modulation source. Unlike SYNESTHESIA (which splits the sound into frequency bands), featurecv measures the WHOLE signal, in the time domain only (no FFT) so it is fully deterministic. It derives three continuous features — LOUD (broadband RMS = how loud), BRIGHT (zero-crossing rate, a cheap spectral-brightness proxy = how bright/hissy vs dark/bassy), and PUNCH (crest factor = peak ÷ RMS = how spiky/transient vs sustained) — plus an ONSET trigger that pulses on each fresh attack in the sound. GAIN trims the input into the analyser; ATTACK / RELEASE smooth how quickly the CVs react. Patch LOUD into a VCA or filter to track dynamics, BRIGHT into a filter cutoff so the timbre opens up as the source gets brighter, PUNCH into anything you want to react to transients, and ONSET into an envelope generator or drum voice to fire on each hit. TWO THINGS TO KNOW BEFORE YOU PATCH IT, both measured on the shipping worklet through this module's own factory (art/scenarios/featurecv/analysis.test.ts). First, THE THREE FEATURE CVs REST AT THE BOTTOM RAIL, NOT AT ZERO. They are emitted BIPOLAR (−1..+1) by default so a strong feature sweeps a knob-centred destination's FULL range — but with nothing patched into IN, or during any silence in the source, all three sit at exactly −1.00 and hold their destinations at the bottom of their range. Flip POLARITY to UNIPOLAR (0..1) and the same silence rests at 0.00 instead, which is what you want for classic envelope-style modulation. Second, GAIN REACHES EXACTLY ONE OF THE THREE FEATURES. LOUD is a level and the trim moves it; BRIGHT counts zero crossings and PUNCH is a peak-to-RMS ratio, and both are scale-invariant, so turning GAIN is bit-exactly a no-op on those two jacks. The faceplate prints the resting level, what a −12 dBFS source leaves at LOUD, and the input level at which LOUD stops moving, for exactly these reasons.",
    inputs: {
      in: "The audio signal to analyse — the measured signal, not a modulator. Its loudness, brightness, and transients drive every output. Patch a drum bus, vocal, synth voice, or full mix here.",
    },
    outputs: {
      loud:
        "LOUD CV — the broadband RMS (overall energy / loudness) of the input over a 21.3 ms window, smoothed by ATTACK/RELEASE. Patch into a VCA gain or filter cutoff to make a destination track how loud the source is. Polarity set by the POLARITY toggle, so a silent input rests at −1.00 (bipolar) or 0.00 (unipolar). ⚠ IT IS THE ONE FEATURE WITH A CEILING: the RMS is multiplied by 2 and clamped, so at unity GAIN any source above −6.02 dBFS RMS reads a flat full scale and stops modulating at all. GAIN divides that ceiling — ×4 brings it down to −18.1 dBFS — and the faceplate prints the live number as `loud clip`.",
      bright:
        "BRIGHT CV — a brightness proxy from the zero-crossing rate: high when the sound is hissy / trebly (cymbals, noise, bright synths), low when it is dark / bassy. Patch into a filter cutoff so the timbre opens with the source's brightness. Polarity set by POLARITY. ⚠ SCALE-INVARIANT: it counts sign changes, so GAIN (and the source's own level) is bit-exactly a no-op here — measured, the rack's own white tap reads 0.97 unipolar at any trim. Full scale is reached at a zero-crossing rate of 0.5, which broadband noise sits essentially on top of.",
      punch:
        "PUNCH CV — the crest factor (peak ÷ RMS): high for spiky, transient, percussive material and low for sustained, compressed tones. Patch into modulation you want to react to how punchy the source is. Polarity set by POLARITY. ⚠ ALSO SCALE-INVARIANT — a ratio of two quantities GAIN scales identically — and the map is calibrated on crest 1..6, which puts steady material near the BOTTOM: a sine (crest 1.41) reads 0.08 unipolar / −0.83 bipolar, and the rack's own white tap (uniform noise, crest 1.73) reads 0.15 / −0.71. Sustained sources live in the bottom fifth of this jack's range; it is transients that move it.",
      onset:
        "ONSET trigger — fires a short 5 ms pulse ONCE on each detected attack (a fresh transient / hit) in the input, a clean rising edge that crosses the gate threshold, about 1.3 ms after the attack itself. Patch into an envelope generator, VCA, or drum voice to strike it from the live source. Unaffected by POLARITY. SENS sets how readily it fires; DEBNCE sets the minimum gap between pulses and therefore the fastest hit train that passes intact — 12.5 Hz at the shipped 80 ms, measured 36/36 pulses on a 3 s 12 Hz train, and every OTHER hit at 16 Hz (24 of 48).",
    },
    controls: {
      gain:
        "Input trim into the analyser (×0.25..×4, log, unity at noon) — boost a quiet source so LOUD reaches a usable CV range, or tame a hot one. It shapes the ANALYSIS level, not an audio output (there is none). ⚠ IT REACHES EXACTLY ONE OF THE THREE FEATURES. LOUD is a level and moves with it; BRIGHT counts zero crossings and PUNCH is a peak-to-RMS ratio, so both are scale-invariant and this trim is bit-exactly a no-op on them. What it does decide for LOUD is where that feature SATURATES: the RMS is doubled and clamped, so the input level at which LOUD pins at full scale is −6.02 dBFS at unity and 6.02 dB lower for every doubling of the trim.",
      attack:
        "How fast the feature CVs RISE toward a new value (ms, log) — short attack snaps to transients, long attack glides smoothly past them. Applies to LOUD, BRIGHT, and PUNCH. ⚠ THE NUMBER IS A ONE-POLE TIME CONSTANT, NOT A RISE TIME: the follower reaches 63 % of a step in the printed time and 10→90 % in 2.197× it, so the shipped 10 ms delivers a 22 ms move. The faceplate prints the delivered figure as `atk rise`.",
      release:
        "How fast the feature CVs FALL back when the input quietens or changes (ms, log) — short release tracks every dip, long release holds a smooth contour. Applies to LOUD, BRIGHT, and PUNCH. ⚠ Also a one-pole TIME CONSTANT: the shipped 100 ms delivers a 220 ms 90→10 % fall, printed on the faceplate as `rel fall`.",
      bipolar:
        "POLARITY of the three feature CV outputs — BIPOLAR (−1..+1, the default, so a strong feature sweeps a knob-centred destination's full range) vs UNIPOLAR (0..1, classic envelope-style). Does not affect the ONSET trigger. ⚠ IT IS ALSO THE ONLY CONTROL ON THE MODULE THAT DOES ANYTHING WITH NOTHING PATCHED, and that is why it is ranked first: a silent or unpatched input makes all three features 0, which BIPOLAR maps to −1.00 — the bottom rail, not the centre — so an idle featurecv holds its destinations hard down until it hears something. UNIPOLAR rests the same silence at 0.00.",
      onset_sens:
        "ONSET sensitivity — higher lowers the detector's adaptive threshold so it fires on smaller transients; lower only triggers on strong, clear attacks. The threshold is `mean flux × N + 0.15` and this dial sets N, INVERTED: 4.00× at SENS 0, 2.60× at the shipped 0.50, 1.20× at SENS 1. The faceplate prints N live as `fires at`. ⚠ ITS AUTHORITY IS CONDITIONAL, and measured: on a clean, well-separated hit train the whole travel is a no-op (12 pulses out of 12 at every setting), because an unambiguous transient clears every threshold. Where it earns its place is AMBIGUOUS material — a tremolo tone goes 1 → 13 pulses across the same travel, and hits buried in a loud noise bed go 4 → 10. There is additionally an absolute floor no SENS setting defeats: a source whose slow envelope stays under 0.005 produces no onsets at all.",
      onset_debounce:
        "ONSET debounce (ms, log) — the minimum time between onset triggers, a lockout that blocks a re-trigger on a transient's ringing tail so one hit makes exactly one pulse. It is therefore a RATE CEILING: the fastest hit train that passes intact is 1000 ÷ this number, so the shipped 80 ms tops out at 12.5 Hz — measured 36/36 pulses on a 3 s 12 Hz train, and every OTHER hit at 16 Hz (24 of 48). That is the number that decides whether 16th-note hi-hats get through, and the faceplate prints it live as `max rate`.",
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

    const workletNode = createWorkletNode(node, ctx, 'featurecv', {
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
