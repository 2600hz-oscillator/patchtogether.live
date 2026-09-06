// packages/web/src/lib/audio/modules/reverb.ts
//
// REVERB — the plain-room reverb (size / damp / mix).
//
// The minimal-knob reverb the basic palette ships. Faust-compiled DSP
// (packages/dsp/src/reverb.dsp), which is `re.mono_freeverb` from the Faust
// standard library — Jezar-at-Dreampoint's Freeverb in its mono form: EIGHT
// parallel lowpass-feedback comb filters summed, then FOUR series Schroeder
// allpasses for diffusion. Mono in / mono out. No CV; the three knobs are the
// entire user surface. For a long crystalline octave-up tail see
// SHIMMERSHINE; for a deeply tweakable diffusion engine see CLOUDSEED; for a
// dispersive spring "boing" see MOOG905.
//
// MEASURED behaviour (Faust 2.85.5 C backend, 48 kHz, Schroeder-integration
// T30x2 on the impulse response — see the notes on each param below):
//   - The comb delay taps are FIXED (Freeverb's 1116..1617 samples at 44.1 kHz
//     = 25.3..36.7 ms, rescaled to the running SR). `size` does NOT resize the
//     tank — it sets the comb FEEDBACK, `fb1 = 0.5 + 0.45*size` = 0.50..0.95.
//   - Audible-band (>100 Hz) T60 spans ~0.14 s .. ~4.4 s. NOT infinite: the
//     0.95 feedback ceiling caps the tail.
//   - The wet path is NOT level-matched to the dry: `mono_freeverb` sums 8
//     combs with no output scaling, so the wet leg runs ~+10..+18 dB hotter
//     than the input. `mix` is therefore also a LOUDNESS control and high
//     mix + high size can drive peaks well past full scale. See the docs
//     block + the note in the module's face rationale.
//
// Inputs:
//   audio (audio): dry mono signal into the tank (and the dry side of the mix).
//
// Outputs:
//   audio (audio): dry + wet, ratio set by mix.
//
// Params:
//   size (linear 0..1, default 0.5): comb feedback 0.50..0.95 = decay TIME.
//   damp (linear 0..1, default 0.3): one-pole LP inside each comb's feedback.
//   mix (linear 0..1, default 0.3): dry / wet balance (0 = dry, 1 = wet only).

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/reverb.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/reverb.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/reverb.worklet.js?url';

const PARAM_PREFIX = '/Reverb';

export const reverbDef: AudioModuleDef = {
  type: 'reverb',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'reverb',
  category: 'effects',
  inputs: [{ id: 'audio', type: 'audio' }],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [
    { id: 'size', label: 'Size', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'damp', label: 'Damp', defaultValue: 0.3, min: 0, max: 1, curve: 'linear' },
    { id: 'mix',  label: 'Mix',  defaultValue: 0.3, min: 0, max: 1, curve: 'linear' },
  ],

  // ── RACKLINE FACE (P1 batch 3) ────────────────────────────────────────────
  // DESIGNED from what this module is FOR, not transcribed from the legacy
  // card's declaration-order SIZE / DAMP / MIX fader row.
  //
  // REVERB is the utility room: the reverb you patch when you do not want to
  // make any decisions. Its whole value proposition is that there are three
  // knobs and no menu. So the ladder is ranked by what a player's hand
  // actually reaches for on a send or an insert:
  //   mini    (1) → MIX. This module has no separate wet fader, so MIX *is*
  //                 "how much reverb" (the cloudseed LATE / shimmershine MIX
  //                 rank-1 reasoning). It is also the level-critical control
  //                 here, because the wet leg is ~+10 dB hotter than the dry
  //                 (see docs.controls.mix) — MIX is a volume knob whether you
  //                 meant it to be or not, so it must survive to the smallest
  //                 tile.
  //   compact (2 + glyph) → + SIZE, the decay time: how long the space rings.
  //   full/dock          → + DAMP, the tone trim.
  //
  // RE-RANKED: the old row ran SIZE / DAMP / MIX purely
  // because that is `params[]` order. DAMP is a set-and-forget tone control
  // and is the correct one to demote below the glyph; MIX is reached for on
  // every patch and was ranked last.
  //
  // Dock bands follow SIGNAL FLOW and deliberately reuse SHIMMERSHINE's band
  // vocabulary ('reverb tank' → 'output blend'), because SHIMMERSHINE is
  // literally this tank plus an octave-up regeneration loop: a player moving
  // between the two reverbs should meet the same furniture in the same order.
  //
  // GLYPH = 'meter' (live RMS off the `audio` output). A reverb's whole
  // perceptual signature is the TAIL, and an RMS meter is the one glyph that
  // reads a decay at 84 px — you can literally watch SIZE get longer. A
  // waveform trace of a diffuse wash is mush, and there is no shape-identity
  // param to derive a wave from (this is a processor, not a source). It also
  // earns its cell twice over here as the clip-warning for the hot wet leg.
  face: {
    order: ['mix', 'size', 'damp'],
    pages: [
      { id: 'tank', label: 'reverb tank', controls: ['size', 'damp'] },
      { id: 'output', label: 'output blend', controls: ['mix'] },
    ],
    glyph: 'meter',
    // REAR CARD curation. Two holes total — one in, one out — so there is no
    // grouping problem to solve; the single decision worth making is the band
    // NAME. Derivation would label it the generic 'signal'; 'mono in' states
    // the module's most consequential patch-time fact (there is no right
    // channel — this is a mono tank) at the hole itself, where a player
    // dragging a cable will actually read it. Deliberately NO `audioRate`
    // entries: the `~` tick marks a CV hole that is consumed per-sample
    // (the tidy-vco precedent); on a plain audio-cable input it is noise.
    rear: {
      groups: [{ id: 'signal', label: 'mono in', ports: ['audio'] }],
    },
  },

  docs: {
    explanation:
      "The plain room — the reverb you patch when you do not want to make any decisions. It is Freeverb (Jezar at Dreampoint) in its mono form, straight out of the Faust standard library: the input feeds EIGHT parallel comb filters, each recirculating through its own one-pole lowpass, and their sum then passes FOUR series Schroeder allpasses that smear the result into a diffuse wash. The comb taps are FIXED — Freeverb's classic 1116/1188/1277/1356/1422/1491/1557/1617-sample tunings at 44.1 kHz, i.e. 25.3 to 36.7 ms, rescaled to whatever sample rate you are running — so the wet cloud always starts about 25 ms behind the dry (a built-in pre-delay you cannot adjust) and the room's modal colour never changes. What SIZE changes is the comb FEEDBACK (0.50 to 0.95), which is decay TIME: a measured audible-band T60 of about 0.33 s at SIZE 0 and 4.4 s wide open with DAMP off, roughly 0.55 s where the knobs sit by default. It does not go to infinity — 0.95 is the ceiling. DAMP is the one-pole lowpass inside each comb's feedback path, so every trip round the loop comes back darker; it both darkens and shortens the tail, and at DAMP 1 the loop is closed altogether and all that is left is the ~0.14 s of allpass diffusion, whatever SIZE says. The one thing to know before you use it: the wet leg is NOT level-matched to the dry. The Faust tank sums eight combs with no output scaling, so it runs about +10 dB hotter than the input at default settings and up to +18 dB with SIZE wide open — MIX is a loudness control as much as a blend, and a fully wet, fully large setting will push peaks well past full scale. Ride the source level down, or put a VCA after it, before you go past about half MIX. Mono in, mono out, no CV: it adds no width of its own, and two instances fed the SAME signal produce two IDENTICAL tails (the algorithm is deterministic), so splitting a mono source into a pair of REVERBs gives you a dead-centre tail, not a stereo one. For a long crystalline octave-up tail reach for SHIMMERSHINE (this exact tank plus a pitch-shifted regeneration loop); for a deeply tweakable diffusion engine with real pre-delay, EQ and an RT60 readout reach for CLOUDSEED; for a dispersive metallic 'boing' reach for MOOG905.",
    inputs: {
      audio:
        'The dry mono signal. It is fanned out to all eight comb filters AND tapped straight through to the dry side of the MIX blend, so nothing you patch here is ever lost — at MIX 0 this input is the output, sample for sample. There is no input trim: because the wet leg has ~+10 dB of unscaled tank gain, set the level of whatever you patch here with that in mind rather than expecting the module to hold unity.',
    },
    outputs: {
      audio:
        "The mono output: dry × (1 − MIX) + wet × MIX, a straight linear crossfade of two signals. Those two signals are not level-matched — the wet one is roughly 10 dB louder — so the SUM rises as you open MIX (measured: about +2.4 dB at the 0.3 default, +5.7 dB at half, +11.4 dB fully wet at default SIZE and DAMP). Nothing here is limited or clipped, so at large SIZE and high MIX the output can exceed ±1 and will clip whatever it feeds. The tail's length follows SIZE, its brightness follows DAMP, and the first wet energy arrives about 25 ms after the dry.",
    },
    controls: {
      size:
        "The decay TIME, despite the name. It does NOT resize the tank: the eight comb delay taps are fixed at Freeverb's tunings (25.3–36.7 ms) and only ever rescale with the sample rate, so the room's modal colour, density and 25 ms onset are the same at both ends of the travel. What the knob sweeps is the comb feedback, 0.50 at the bottom to 0.95 at the top. Measured audible-band T60 (>100 Hz) with DAMP at 0: about 0.33 s / 0.46 / 0.71 / 1.28 / 4.4 s at SIZE 0 / 0.25 / 0.5 / 0.75 / 1. At the default DAMP of 0.3 the same points read about 0.27 / 0.37 / 0.55 / 1.02 / 3.6 s. Because 0.95 is the ceiling the tail always dies — there is no freeze or infinite-hold corner here (that is CLOUDSEED's INFINITE PAD preset or SHIMMERSHINE's regeneration loop). Note the top of the travel is where the tank's unscaled gain is worst: SIZE 1 is about +18 dB of wet gain, so long settings are the ones that clip.",
      damp:
        "The tone of the decay: a one-pole lowpass sitting inside every comb's feedback path, so each recirculation returns a little darker than the last and the tail rolls off progressively rather than all at once. Measured tail balance above vs below 2 kHz: about +6.8 dB (bright, distinctly metallic) at 0, −2.6 dB at the 0.3 default, −6.4 dB at 0.5, −15.3 dB at 0.8. It also SHORTENS the audible tail as it darkens — at SIZE 1 the T60 falls from 4.4 s at DAMP 0 to 3.6 / 3.4 / 2.7 / 1.16 s at 0.3 / 0.5 / 0.8 / 0.95 — so treat it as a second decay control, not a pure EQ. At 1 the filter closes completely: the combs stop feeding back and you hear only the four allpasses ringing out, about 0.14 s, no matter where SIZE is. Turn it up to sit a reverb behind a bright source without hiss; turn it down for the shiny, slightly artificial plate sound.",
      mix:
        "The dry/wet balance — out = dry × (1 − MIX) + wet × MIX, an ordinary linear crossfade. Treat it as a loudness control too: the wet signal it is crossfading toward is roughly 10 dB hotter than the dry (the tank sums eight combs unscaled), so opening MIX raises the output as well as the reverb. Measured against the dry level at default SIZE and DAMP: +0 dB at 0, +2.4 dB at the 0.3 default, +5.7 dB at 0.5, +11.4 dB fully wet — and the wet peak at SIZE 1 runs about +21 dB over the dry peak, comfortably past full scale. So: low values (up to ~0.3) are the safe 'touch of air on the bus' zone; going much past half, pull the source down or follow the module with a VCA. On an aux send you want 1, and there you are effectively using the module as a +10 dB wet generator, which is fine as long as the return fader knows it.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'reverb', wasmUrl, metaUrl, workletUrl }, node);
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(f);
    const params = f.parameters as unknown as Map<string, AudioParam>;
    for (const def of reverbDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    return {
      domain: 'audio',
      inputs: new Map([['audio', { node: f, input: 0 }]]),
      outputs: new Map([['audio', { node: f, output: 0 }]]),
      setParam(paramId, value) {
        params.get(`${PARAM_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(`${PARAM_PREFIX}/${paramId}`)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        silence.disconnect();
        f.disconnect();
      },
    };
  },
};
