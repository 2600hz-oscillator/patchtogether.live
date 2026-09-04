// packages/web/src/lib/audio/modules/qbrt.ts
//
// QBRT — stereo resonant multimode filter with a PING excitation jack.
// The project's "big-knob" stereo VCF, and — when triggered — a pluck /
// drum resonator that needs no oscillator. Faust DSP: packages/dsp/src/
// qbrt.dsp.
//
// Per channel, FOUR two-pole responses computed in PARALLEL (Faust's
// fi.resonlp / fi.resonbp / fi.resonhp — note resonhp is itself `x − lp` —
// plus `x − bp`), crossfaded by `mode` 0..1 (0 = low-pass, 1/3 = band-pass,
// 2/3 = high-pass, 1 = the input-minus-band-pass tap), linearly between
// neighbours. It is NOT a state-variable topology despite the `svf` name in
// the .dsp and the module's original description string; each channel is a
// bank of parallel biquads. `resonance` maps 0..0.99 onto
// an internal Q of 0.7..20.5 — no gain compensation, and (being a plain
// two-pole section) never self-oscillating. PING is how you make it sing:
// each rising edge injects a ~1 ms broadband click into BOTH channels'
// filter inputs AND jumps Q by +30, that boost decaying with a time
// constant of `pingDecay`, so the filter rings at `cutoff` and settles.
//
// All four knobs (and therefore the CV summed onto them) are read ONCE per
// 128-frame render quantum by the Faust worklet wrapper (`parameters[path][0]`
// — ~375 Hz at 48 kHz) and then one-pole smoothed inside the DSP by `si.smoo`
// (≈7 Hz corner / ~23 ms), so the CV jacks track at envelope/LFO rate, not
// audio rate.
//
// Inputs:
//   L (audio): left-channel signal (the ping click sums in here too).
//   R (audio): right-channel signal (likewise).
//   ping (gate cable, edge: 'trigger'): rising edge across 0.5 fires
//     the click + Q-boost excitation. Level while high is ignored, matching
//     qbrt.dsp:14's textbook rising-edge detector. (The contract gap this
//     comment used to describe was closed by the edge-declaration sweep.)
//   cutoff (cv, log, paramTarget=cutoff): ±1 = ×/÷ ~31 (≈ ±5 octaves).
//   resonance (cv, linear, paramTarget=resonance): ±1 = ±0.495 (half range).
//   mode (cv, discrete, paramTarget=mode): BUCKETED to the two ends of the
//     morph — negative CV → 0 (low-pass), zero/positive → 1 (top tap).
//   pingDecay (cv, log, paramTarget=pingDecay): ±1 = ×/÷ 10.
//
// Outputs:
//   L (audio): filtered left channel.
//   R (audio): filtered right channel.
//
// Params:
//   cutoff (log 20..20000 Hz, default 1000): corner/centre frequency — and
//     the pitch the filter rings at when PING fires.
//   resonance (linear 0..0.99, default 0.7): Q (0.7..20.5).
//   mode (linear 0..1, default 0): LP → BP → HP → input-minus-BP morph.
//   pingDecay (log 0.005..0.5s, default 0.15): time constant of the ping
//     Q-boost envelope (the ~1 ms click length is fixed).

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/qbrt.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/qbrt.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/qbrt.worklet.js?url';

const PARAM_PREFIX = '/QBRT';

export const qbrtDef: AudioModuleDef = {
  type: 'qbrt',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'qbrt',
  category: 'filters',
  // `pingDecay` (added with the vactrol-style ping path rework) is backfilled
  // from its factory default on load, so no migration callback (or version
  // bump) is needed.
  inputs: [
    { id: 'L',         type: 'audio' },
    { id: 'R',         type: 'audio' },
    { id: 'ping',      type: 'gate', edge: 'trigger' },
    // CV scaling per docs/adr/004-cv-range-convention.md — LFO ±1 sweeps
    // the param's full musical range centered on the knob.
    //
    // cutoff: log scaling (20Hz..20kHz spans 10 octaves; cv=±1 = ±5 octaves).
    // resonance: linear (0..0.99 — already small but full sweep).
    // mode: discrete bucket (0/1).
    // pingDecay: log (0.005..0.5s spans ~6.6 octaves).
    { id: 'cutoff',    type: 'cv', paramTarget: 'cutoff',    cvScale: { mode: 'log' } },
    { id: 'resonance', type: 'cv', paramTarget: 'resonance', cvScale: { mode: 'linear' } },
    { id: 'mode',      type: 'cv', paramTarget: 'mode',      cvScale: { mode: 'discrete' } },
    { id: 'pingDecay', type: 'cv', paramTarget: 'pingDecay', cvScale: { mode: 'log' } },
  ],
  outputs: [
    { id: 'L', type: 'audio' },
    { id: 'R', type: 'audio' },
  ],
  // `label` is COSMETIC — it is NOT part of the contract signature (see the
  // contract-signature.ts header), so these carry no contract weight. They are
  // the RACKLINE face's own control labels and the rear card's hole labels, so
  // they are named for the FUNCTION: 'Cutoff' (not 'Cut' — this is a corner
  // frequency, not an attenuation) and 'Ping Dec' (not 'Ping' — the PING jack
  // is the trigger; this knob is the decay time, and the two would otherwise
  // render as two holes both labelled PING).
  params: [
    { id: 'cutoff',    label: 'Cutoff',   defaultValue: 1000, min: 20,    max: 20000, curve: 'log',    units: 'Hz' },
    { id: 'resonance', label: 'Res',      defaultValue: 0.7,  min: 0,     max: 0.99,  curve: 'linear' },
    { id: 'mode',      label: 'Mode',     defaultValue: 0,    min: 0,     max: 1,     curve: 'linear' },
    { id: 'pingDecay', label: 'Ping Dec', defaultValue: 0.15, min: 0.005, max: 0.5,   curve: 'log',    units: 's' },
  ],

  // ── RACKLINE face (P1 total-rework — UI CURATION ONLY, deliberately outside
  // the I/O contract; see ModuleFace in $lib/graph/types). Designed from what
  // QBRT actually IS rather than transcribed from its legacy four-fader row:
  // ONE resonant filter that a PING jack can also play as a percussion voice.
  // So the ranking leads with the controls that are live on EVERY patch and
  // parks the ping-only control behind them.
  //
  //   mini (1):    CUTOFF — the big knob, and the only one that is two things
  //                at once: the filter's corner AND the pitch it rings at.
  //   compact (2 cells + glyph): + RESONANCE (how hard it sings / how long it
  //                rings). A glyph-bearing face fits TWO whole knob columns
  //                beside the trace (faceTierCap), so MODE (which of the four
  //                responses you are hearing) joins at the full tier.
  //   full (8):    all four — PING DEC joins last; it is inert until a cable
  //                reaches the PING jack.
  //   dock:        two section bands that read as the signal flow — the
  //                always-on resonant filter, then the ping excitation path.
  //
  // glyph 'scope' (a live analyser trace on the L output), NOT the FX-family
  // default 'meter': this module\'s identity is the RING — a decaying sinusoid
  // whose pitch is CUTOFF and whose length is RESONANCE × PING DEC. A trace
  // shows both of those; an RMS meter shows neither, and QBRT has no wet/dry
  // balance for a meter to arbitrate. (A param-derived FREQUENCY-RESPONSE
  // curve would be the ideal identity glyph here — the glyph vocabulary has
  // no such kind yet.)
  face: {
    order: ['cutoff', 'resonance', 'mode', 'pingDecay'],
    pages: [
      { id: 'filter', label: 'resonant filter',  controls: ['cutoff', 'resonance', 'mode'] },
      { id: 'ping',   label: 'ping · resonator', controls: ['pingDecay'] },
    ],
    glyph: 'scope',
    // REAR CARD curation (rear-card-model). Pure derivation would sweep L, R
    // AND the ping gate into a single leading band — and label it 'voice',
    // because a gate is present — but they do different jobs: L/R are the
    // through-signal this module filters, PING is the excitation that PLAYS
    // it. So the audio pair claims the leading slot as 'signal', and the gate
    // is pinned into the 'ping' page band where it sits directly beside the
    // PING DEC CV that shapes what it fires.
    //
    // No `audioRate` ticks on purpose: all four knobs are one-pole smoothed
    // inside the DSP (`si.smoo`, ≈7 Hz corner), so every CV sum landing on
    // them is consumed at control rate — none of these is an audio-rate jack.
    rear: {
      groups: [
        { id: 'signal', label: 'signal',           ports: ['L', 'R'] },
        { id: 'ping',   label: 'ping · resonator', ports: ['ping'] },
      ],
    },
  },

  docs: {
    explanation:
      "A stereo resonant filter with a PING excitation jack — the project's big-knob stereo VCF, and, the moment you trigger it, a pluck/drum resonator that needs no oscillator at all. Left and right run identical two-pole filter banks off one shared set of controls: strictly DUAL-MONO — no cross-feed, no mid/side matrix — so the stereo image you patch in survives untouched while both sides answer to the same knobs. MODE is a single continuous MORPH rather than a switch: four responses are computed in parallel — a resonant low-pass, a resonant band-pass, a high-pass (which is itself input-minus-low-pass), and an input-minus-band-pass tap — and linearly crossfaded between neighbours, so one knob walks the whole response family. RESONANCE maps its 0–0.99 range onto an internal Q of 0.7 (essentially maximally-flat, no peak) up to 20.5, and it is NOT gain-compensated: the peak at CUTOFF grows roughly in step with Q, so a high setting is both sharper and markedly louder around the corner. It never self-oscillates — a plain two-pole section is unconditionally stable however hard you push Q — and that is exactly what PING is for. Each rising edge on PING does two things at once: it injects a broadband click into BOTH channels' filter inputs — a one-pole decay from an amplitude of 1.5, so it starts hotter than unity, and it is ~1 ms long at 44.1/48 kHz (the per-sample coefficient is a fixed 0.98, so the click halves in length at 96 kHz) — and it slams the internal Q up by +30 (to ~50 at the top of the RESONANCE range), that boost then decaying exponentially with a time constant of PING DEC. The filter rings at CUTOFF and settles — a pluck. Patch a drum-sequencer lane into PING and sweep CUTOFF for kick / tom / laser-pew hits with no oscillator in the patch; leave PING unpatched and it is an ordinary stereo filter you run audio through. One caveat worth knowing before you reach for a modulator: the Faust wrapper reads each knob (and the CV summed onto it) ONCE per 128-sample block — about 375 Hz at 48 kHz — and the DSP then one-pole smooths it at about a 7 Hz corner, so the four CV jacks track at envelope/LFO rate and an audio-rate signal patched into one is block-sampled and smoothed into a vague drift rather than heard as modulation. This is a clean filter, not an FM or ring-mod front end.",
    inputs: {
      L: "Left audio input — the signal the left filter section processes. The PING excitation click is summed in at this same point, so your signal and the ring pass through one and the same filter (the ring is not a parallel voice).",
      R: "Right audio input — the signal the right filter section processes, with the same shared controls and the same PING click summed in. The ping excitation is identical on both channels, so a ping alone is dead-centre mono however you patch L/R.",
      ping:
        "The excitation TRIGGER. Each rising edge across 0.5 fires two things at once: a broadband click into both channels' filter inputs (peak amplitude 1.5, decaying to nothing in ~1 ms at 44.1/48 kHz — its 0.98-per-sample coefficient is not sample-rate compensated, so it is half as long at 96 kHz), and a +30 jump in the filter's internal Q on top of whatever RESONANCE is set to, which then decays with PING DEC's time constant. The filter rings at CUTOFF as a result — a pluck. Only the RISING edge matters: how long the signal stays high changes nothing, so drive it from a clock, a drum-sequencer lane, or any trigger source. Because the Q boost is added on top of the knob, PING still plucks convincingly with RESONANCE at zero — and the ring is not level-compensated, so at high RESONANCE it can be far hotter than the dry signal.",
      cutoff:
        "CV for CUTOFF, log-scaled: ±1 multiplies or divides the knob frequency by about 31×, i.e. a roughly ±5-octave sweep centred on wherever you left the knob and pinned at the 20 Hz / 20 kHz ends. Patch an envelope for filter sweeps, or a sequencer/pitch CV to play the ping's ring as a melody. It is control-rate (the knob is internally smoothed at ~7 Hz), so this jack does filter sweeps, not filter FM.",
      resonance:
        "CV for RESONANCE, linear: ±1 displaces the knob by up to half the 0–0.99 range in each direction (±0.495), clamped at the ends. Use it to open the filter into its sharp, ringing region on accents, or to duck a peaky setting back to flat. It cannot reach self-oscillation — there is none to reach — but at the top of the sweep the peak at CUTOFF is around +26 dB.",
      mode:
        "CV for MODE — and note this jack is BUCKETED, not continuous (a discrete cv scale): the −1..+1 sweep resolves to only the two ENDS of the morph, negative CV driving the response to the low-pass end and zero-or-positive driving it to the top (input-minus-band-pass) end. So a gate or square LFO here FLIPS the filter's character; it will not slide through the band-pass and high-pass region in between. Use the knob itself for those blends.",
      pingDecay:
        "CV for PING DEC, log-scaled: ±1 multiplies or divides the knob time by 10 (the 5 ms–0.5 s range spans 100×, so a full swing covers a decade either way), clamped at the ends. Modulate it per hit to make plucks shorter or longer without touching the resonance.",
    },
    outputs: {
      L: "Left filtered output — the left input after the filter, including whatever the PING excitation is currently ringing. Unity in the passband for the taps that HAVE one (low-pass at DC, high-pass up top, the 4th tap at both ends); the band-pass tap at MODE ⅓ has none — it is silent at DC and at the top and only its Q-scaled peak survives. The resonant peak at CUTOFF is NOT gain-compensated in any mode, so high RESONANCE, or a fresh ping, can push this well above the level going in.",
      R: "Right filtered output — the right channel of the same stereo pair, identical processing and identical ping excitation. Take L and R together to keep the stereo image of whatever you fed in; a bare ping appears equally on both.",
    },
    controls: {
      cutoff:
        "CUTOFF — the filter's corner / centre frequency, 20 Hz to 20 kHz on a log dial (default 1 kHz). It is doing two jobs: it sets where the filter acts on the signal you patch through, and it IS the pitch the filter rings at when PING fires, so on a ping patch this knob is effectively the tuning control. Internally smoothed, so sweeps are click-free.",
      resonance:
        "RESONANCE — the filter's Q, mapping the 0–0.99 control onto Q 0.7 to 20.5. At 0 the low-pass and high-pass ends are flat and clean with no peak at all (Q 0.7 is a hair under Butterworth) — the MODE = 1 tap is the exception, where a Q below 1 leaves a dip at CUTOFF instead (about −10.5 dB at RESONANCE 0). As you climb, the peak at CUTOFF sharpens, the ring after a ping lasts longer, and — since there is no gain compensation — the filter also gets substantially louder around CUTOFF (about +26 dB at the top). It never reaches self-oscillation, no matter how far you push it: PING is how you make this filter sing.",
      mode:
        "MODE — one continuous morph across four filter taps rather than a mode switch: 0 = low-pass, ⅓ = band-pass, ⅔ = high-pass, 1 = the input-minus-band-pass tap, with a linear crossfade between each adjacent pair (0.5 sits half band-pass, half high-pass). Low-pass and high-pass pass their band at unity with the resonant peak riding on top at CUTOFF; band-pass keeps only the region around CUTOFF, and its level rises with Q too. One structural quirk worth knowing: the high-pass tap is built as input-minus-low-pass, which puts a second zero at CUTOFF/Q rather than a double zero at DC — so it falls at 12 dB/oct only between CUTOFF/Q and CUTOFF and flattens to 6 dB/oct below that, leaking noticeably more bass than a textbook 2-pole high-pass at high RESONANCE (at Q 20.5 that knee sits around CUTOFF/20). The fourth tap is intended as a notch, but the band-pass it subtracts is itself Q-scaled, so it only truly nulls with RESONANCE around 0.015 — by about 0.065 the dip has closed to flat, and above that it inverts into a large resonant PEAK at CUTOFF (≈ +23 dB at the default RESONANCE) sitting on an otherwise unity-flat signal. Read the top of the sweep as a 'dry plus resonant bell' colour unless you deliberately park RESONANCE near zero for a real notch.",
      pingDecay:
        "PING DEC — the time constant (5 ms to 0.5 s, log, default 0.15 s) of the Q-boost envelope that PING fires: the +30 of extra Q falls to about a third of its peak after this long, and is essentially spent after roughly five times it. Short reads as a clicky percussive pluck, long as a sustained 'peeeew'. Two things it does NOT do: it leaves the ~1 ms excitation click itself untouched, and it is not the only thing setting the tail — the ring's own decay is governed by RESONANCE and CUTOFF, so a high-Q low-frequency ping rings on well past a short PING DEC.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'qbrt', wasmUrl, metaUrl, workletUrl }, node);
    const merger = ctx.createChannelMerger(3);
    merger.connect(f);
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(merger, 0, 0);
    silence.connect(merger, 0, 1);
    silence.connect(merger, 0, 2);

    const splitter = ctx.createChannelSplitter(2);
    f.connect(splitter);

    const params = f.parameters as unknown as Map<string, AudioParam>;
    for (const def of qbrtDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    const pCutoff    = params.get(`${PARAM_PREFIX}/cutoff`);
    const pRes       = params.get(`${PARAM_PREFIX}/resonance`);
    const pMode      = params.get(`${PARAM_PREFIX}/mode`);
    const pPingDecay = params.get(`${PARAM_PREFIX}/pingDecay`);

    return {
      domain: 'audio',
      inputs: new Map([
        ['L',         { node: merger, input: 0 }],
        ['R',         { node: merger, input: 1 }],
        ['ping',      { node: merger, input: 2 }],
        ['cutoff',    { node: f, input: 0, param: pCutoff! }],
        ['resonance', { node: f, input: 0, param: pRes! }],
        ['mode',      { node: f, input: 0, param: pMode! }],
        ['pingDecay', { node: f, input: 0, param: pPingDecay! }],
      ]),
      outputs: new Map([
        ['L', { node: splitter, output: 0 }],
        ['R', { node: splitter, output: 1 }],
      ]),
      setParam(paramId, value) {
        params.get(`${PARAM_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(`${PARAM_PREFIX}/${paramId}`)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        silence.disconnect();
        merger.disconnect();
        f.disconnect();
        splitter.disconnect();
      },
    };
  },
};
