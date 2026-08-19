// packages/web/src/lib/audio/modules/moog923.ts
//
// MOOG 923 FILTERS / NOISE SOURCE — a slice of the Moog System 35 clone
// (.myrobots/MOOG/). The 923 is a dual-purpose utility panel:
//
//   1. NOISE SOURCE — the same white + pink noise generators the 903A
//      ships, on two independent outputs, gain-scaled by a single LEVEL
//      knob. Implemented (like NOISE / 903A) by pre-generating a 2-second
//      loopable AudioBuffer per flavor via noiseGenerators and looping it
//      through an AudioBufferSourceNode → GainNode. NO worklet — a looping
//      buffer is far cheaper than a per-sample JS callback.
//
//   2. FIXED FILTER section — a low-pass + a high-pass filter operating on
//      one external AUDIO input. The input fans out (one GainNode) into two
//      BiquadFilterNodes ('lowpass' / 'highpass'); each filter is a
//      separate output (lp / hp). Pure Web Audio (BiquadFilterNode), no
//      worklet — the 904C is the only Moog filter that needs the custom
//      ladder worklet.
//
// PURE Web Audio: noise buffer-loop factory + a small Biquad graph. No
// AudioWorklet, no Faust DSP.
//
// Inputs:
//   audio (audio): the external signal fed into the LP + HP filter section.
//     PASSTHROUGH (the signal being filtered, not a knob modulator) → no
//     cvScale / paramTarget.
//
// Outputs:
//   white (audio): full-spectrum white noise (LEVEL-scaled).
//   pink  (audio): 1/f pink noise, -3 dB/oct (LEVEL-scaled).
//   lp    (audio): the audio input low-passed at lpCutoff.
//   hp    (audio): the audio input high-passed at hpCutoff.
//
// Params:
//   level    (linear 0..1, default 0.8): master gain on both noise taps.
//   lpCutoff (linear 0..1, default 0.5): low-pass corner; the 0..1 knob is
//     mapped LOG to ~40 Hz .. 20 kHz inside the factory.
//   hpCutoff (linear 0..1, default 0.5): high-pass corner; same log map.
//
// Categorized under Ports → moogafakkin (mirroring the CP3 / 921A SYS55 bucket).
// Category 'filter' because the headline feature is the LP/HP filter pair.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { noiseGenerators } from '$lib/audio/modules/noise';

/** Buffer length for the loopable noise tables — 2 s, same as NOISE/903A.
 *  The loop period (~0.5 Hz) is imperceptible; noise is aperiodic so the
 *  seam is silent. */
const BUFFER_SECONDS = 2;

/** Log map a normalized 0..1 cutoff knob onto the audible filter range
 *  ~40 Hz .. 20 kHz. Exposed for the unit test so the mapping is pinned. */
export const CUTOFF_MIN_HZ = 40;
export const CUTOFF_MAX_HZ = 20000;
export function cutoffToHz(norm: number): number {
  const t = Math.min(1, Math.max(0, norm));
  // Exponential interpolation between min and max in log space.
  return CUTOFF_MIN_HZ * Math.pow(CUTOFF_MAX_HZ / CUTOFF_MIN_HZ, t);
}

export const moog923Def: AudioModuleDef = {
  type: 'moog923',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  card: 'Moog923Card',
  domain: 'audio',
  label: '923 filters / noise source',
  category: 'filter',

  inputs: [
    // The external signal fed through the LP + HP filter section.
    // PASSTHROUGH (the audio being filtered, not a knob modulator).
    { id: 'audio', type: 'audio' },
  ],
  outputs: [
    { id: 'white', type: 'audio' },
    { id: 'pink',  type: 'audio' },
    { id: 'lp',    type: 'audio' },
    { id: 'hp',    type: 'audio' },
  ],
  params: [
    { id: 'level',    label: 'Level',   defaultValue: 0.8, min: 0, max: 1, curve: 'linear' },
    { id: 'lpCutoff', label: 'Lo Pass', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'hpCutoff', label: 'Hi Pass', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
  ],

  // ── THE FACEPLATE ─────────────────────────────────────────────────────────
  //
  // WHAT IT IS FOR. The 923 is the System 35's utility drawer: the panel you
  // patch when you need raw noise AND a way to split one signal into a low half
  // and a high half, and did not want to spend two modules on it. The verb is
  // SPLIT — one signal in, two bands out, and the two dials say where each half
  // gives up. What it does that its siblings do not is carry two instruments
  // that share a faceplate and NO SIGNAL PATH: `noise` gives three colours and
  // no filter, the 907A/914 give fourteen fixed sections and no noise, the 904C
  // gives one resonant ladder. Measured, because "share no path" is a claim: a
  // 200 Hz sine through `audio` leaves `lp` and `hp` at a BIT-IDENTICAL
  // 3.6421e-1 / 1.8171e-2 RMS at LEVEL 1 and at LEVEL 0.
  //
  // ── THE RANK ──────────────────────────────────────────────────────────────
  //
  // `level` FIRST, on unconditional applicability rather than importance. The
  // noise tables run from spawn with nothing patched, so LEVEL is live the
  // instant the module appears; the two cutoffs do NOTHING until something is
  // patched into `audio` (measured: `lp` and `hp` render bit-exactly 0.0 with
  // the input unpatched). A rank that put a cutoff first would put a dead
  // control at the top of a fresh module's tile.
  //
  // Then `lpCutoff`, then `hpCutoff` — and the argument for THAT order is that
  // there is no argument for any other. The two filters are exact mirrors of
  // one prototype: their −3 dB points measured 1.3293x and 0.7520x the declared
  // corner (= x and 1/x), and each carries the identical +1.96 dB hump 0.36 oct
  // inside its own passband. Nothing distinguishes them but which end of the
  // spectrum they keep, so the rank expresses the ONE order they genuinely have
  // — the spectrum, LOW then HIGH. That is `moog914`'s axis law reached from
  // the same place: interchangeable controls, no priority to express, so
  // express the axis instead of inventing a hierarchy.
  //
  // THE TIER LADDER, read back as a sentence: mini shows LEVEL; compact shows
  // all three dials (three, not two — see the glyph); the plate and the dock
  // show the same three, the dock adding the hero row and the sidebar.
  //
  // ── NO GLYPH, AND THAT IS THE MEASURED DECISION ON THIS FACE ──────────────
  //
  // `primaryAudioOutPortId` takes the FIRST `audio` output, which here is
  // `white`, so `glyph: 'meter'` and `glyph: 'scope'` BOTH resolve to
  // `{ kind: 'live-audio', portId: 'white' }` and there is no declaration that
  // can point either at `lp` or `hp`. A glyph would therefore picture the NOISE
  // half — and it is not free: `faceTierCap` gives a compact tile three knob
  // columns, or TWO plus the glyph. So a rack using the 923 as a FILTER would
  // buy a live picture of a signal path it is not using by giving up one of the
  // two dials it IS using. `noise` took the opposite decision on the opposite
  // facts (one knob, so a tile without a picture said nothing at all, and every
  // one of its three taps is what the meter reads). Here the tile says three
  // things without one. This is the #1692 glyph finding with its answer
  // inverted by the port roster, not ignored.
  //
  // ── TWO PAGES, BECAUSE THEY ARE TWO ENGINES ──────────────────────────────
  //
  // `order` is priority and `pages` is signal order, and here they agree. The
  // split is not editorial: the halves share no node, no gain and no sample,
  // and merging them into one band to save ~81 px would put a noise gain and
  // two filter corners under one heading as though turning one affected the
  // others. `noise` is one control, which normally does not earn a header — it
  // earns this one by being half of what the panel IS (the module is called
  // "923 filters / noise source"). Two bands is far below DOCK_TAB_MIN_BANDS,
  // so they pack onto ONE dock row and cost a header each, not a rail.
  //
  // ── THE READOUTS ─────────────────────────────────────────────────────────
  //
  // Five, none of them a knob relabelled, each negative-controlled permanently
  // in moog923-face-model.test.ts on the input a knob readback is blind to:
  //
  //   white / pink   ONE gain writes both tap gains and the two tables leave
  //                  12.30 dB apart, so the dial prints `0.80` for two jacks
  //                  that are not the same loudness. Each is the other's
  //                  control, and BOTH are invariant to either cutoff.
  //   lp / hp        the frequency the filter ACTUALLY turns over at. Web Audio
  //                  reads `Q` in dB on a lowpass/highpass and defaults it to
  //                  1, and this factory never sets it — so the declared corner
  //                  is a +1.00 dB point, not a −3 dB one. The control is
  //                  POSITIVE, against the wrong answer: the printed value must
  //                  NOT equal `cutoffToHz` of its own dial, which is what a
  //                  relabelled knob would say and what this module implied
  //                  until now.
  //   split          the octaves between those two points, signed — the band
  //                  that arrives at BOTH jacks or at NEITHER. The one number
  //                  no single dial can approximate: at the shipped defaults
  //                  both dials read 0.50 and the naive answer is "aligned",
  //                  while the taps in fact overlap by 0.82 oct.
  //
  // ⚠ THE Q IS NOT FIXED HERE, DELIBERATELY. Whether a 923 clone should carry
  // +1.96 dB of unchosen resonance is an audio-character question for the
  // owner's ears, and folding an audio change into a face PR that self-merges
  // on green is exactly the wrong place for it. Filed separately; the face and
  // the prose stop the product from claiming otherwise in the meantime.
  face: {
    order: ['level', 'lpCutoff', 'hpCutoff'],

    // See the glyph paragraph above: the only port a glyph can bind is `white`.
    glyph: 'none',

    pages: [
      { id: 'noise', label: 'noise', controls: ['level'] },
      { id: 'filter', label: 'filter', controls: ['lpCutoff', 'hpCutoff'] },
    ],

    // THE HERO: three readouts and no control. Promoting LEVEL here would move
    // it out of its own band for no gain — it is already rank 1, and the hero's
    // job on this module is the row of things the dials cannot say.
    hero: {
      readouts: [
        { label: 'white', valueId: 'moog923-white-db' },
        { label: 'pink', valueId: 'moog923-pink-db' },
        { label: 'split', valueId: 'moog923-split' },
      ],
    },

    // THE FILTER NUMBERS, in the sidebar rather than the hero, because they
    // belong to the half of the module that is silent until something is
    // patched — a hero row that reads `1.2 kHz / 672 Hz` beside two live noise
    // levels would give equal billing to a jack carrying nothing.
    sidebar: [
      {
        kind: 'readouts',
        label: 'filter −3 dB',
        entries: [
          { label: 'lp', valueId: 'moog923-lp-hz' },
          { label: 'hp', valueId: 'moog923-hp-hz' },
        ],
      },
    ],
  },

  docs: {
    explanation:
      "A recreation of the Moog 923 Filters / Noise Source — a dual-purpose utility panel from the System 35. It does two unrelated jobs at once. First, a NOISE SOURCE: white and pink noise generators on two independent outputs, both scaled by one LEVEL knob — the raw material for percussion, wind, snare bodies, and sample-and-hold. Second, a simple FIXED FILTER section: one external audio input fanned into a low-pass and a high-pass filter, each with its own frequency knob and its own output, so you can split a signal into low and high bands or just tame one end. The noise and the filter share no signal path — they are bundled on one panel for convenience, and the LEVEL knob is the noise half's alone. TWO THINGS WORTH KNOWING BEFORE YOU PATCH IT. First, the two noise taps are NOT level-matched: one knob drives both, but pink lands 12.3 dB below white at every setting, so equal channel gains do not give equal loudness. Second, the frequency a filter knob sets is where that filter is +1.0 dB, not where it is -3 dB: both filters run at the Web Audio default resonance, which puts a 2.0 dB hump about a third of an octave inside each passband and moves the real -3 dB point to 1.33x the knob's frequency on the low-pass and 0.75x on the high-pass. The faceplate prints the real ones. It is pure Web Audio (looping noise buffers + two biquads), no worklet.",
    inputs: {
      audio: "The external signal fed through the filter section — it fans into BOTH the low-pass and the high-pass at once (the signal being filtered, not a modulator).",
    },
    outputs: {
      white: "Full-spectrum white noise, scaled by the LEVEL knob — equal energy per Hz, bright and hissy. The LOUDER of the two noise taps by 12.3 dB, and the one a lane meter would read, since it is the first audio output declared.",
      pink: "Pink (1/f) noise, scaled by LEVEL — −3 dB/octave, warmer and more natural-sounding than white, good for wind and rumble. The QUIETER tap: 12.3 dB below white from the same LEVEL setting.",
      lp: "The audio input passed through the LOW-PASS filter, its frequency set by the LO PASS knob — the low band of the input. Silent until something is patched into the audio input, and unaffected by LEVEL. Its real −3 dB point sits 1.33x above the knob's frequency, with a 2.0 dB lift a third of an octave below it.",
      hp: "The audio input passed through the HIGH-PASS filter, its frequency set by the HI PASS knob — the high band of the input. Silent until something is patched into the audio input, and unaffected by LEVEL. Its real −3 dB point sits at 0.75x the knob's frequency, with a 2.0 dB lift a third of an octave above it.",
    },
    controls: {
      level: "Master gain on BOTH noise taps (white and pink) — sets the loudness of the noise outputs together. Equally in the sense of one multiplier, NOT one loudness: the two tables have different RMS, so the taps stay 12.3 dB apart at every setting. Does NOT affect the filter section at all — patch a signal in and the lp and hp outputs are identical at LEVEL 0 and at LEVEL 1. Defaults to 0.8.",
      lpCutoff: "Where the LOW-PASS gives up, for the filter section's lp output. The 0..1 knob maps log across ~40 Hz to 20 kHz; lower it to darken the lp output, raise it to let more through. It is NOT the −3 dB point: the filter reads +1.0 dB at the knob's own frequency and does not fall 3 dB until 1.33x above it, having lifted 2.0 dB a third of an octave below. Defaults to 0.5, which is 894 Hz on the knob and 1.2 kHz at −3 dB.",
      hpCutoff: "Where the HIGH-PASS gives up, for the filter section's hp output. The 0..1 knob maps log across ~40 Hz to 20 kHz; raise it to thin the hp output, lower it to let more low end through. Same shape mirrored: +1.0 dB at the knob's frequency, −3 dB at 0.75x it, and a 2.0 dB lift a third of an octave above. Defaults to 0.5, which is 894 Hz on the knob and 672 Hz at −3 dB — so at the shipped settings the two taps OVERLAP by 0.8 of an octave rather than meeting cleanly.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const initial = node.params ?? {};
    const paramOf = (id: string): number =>
      initial[id] ?? moog923Def.params.find((p) => p.id === id)!.defaultValue;

    // ---- Noise section (white + pink, looping buffers) ----
    const sampleRate = ctx.sampleRate;
    const bufferLen = Math.floor(BUFFER_SECONDS * sampleRate);

    function makeBuffer(data: Float32Array): AudioBuffer {
      const buf = ctx.createBuffer(1, bufferLen, sampleRate);
      const channel = buf.getChannelData(0);
      for (let i = 0; i < bufferLen; i++) channel[i] = data[i] ?? 0;
      return buf;
    }

    const whiteSrc = ctx.createBufferSource();
    whiteSrc.buffer = makeBuffer(noiseGenerators.white(bufferLen));
    whiteSrc.loop = true;

    const pinkSrc = ctx.createBufferSource();
    pinkSrc.buffer = makeBuffer(noiseGenerators.pink(bufferLen));
    pinkSrc.loop = true;

    // One LEVEL-scaled gain per noise tap (symmetrical disposal story, same
    // as NOISE/903A). Both driven by the single LEVEL value.
    const level = paramOf('level');
    const whiteGain = ctx.createGain();
    whiteGain.gain.value = level;
    const pinkGain = ctx.createGain();
    pinkGain.gain.value = level;

    whiteSrc.connect(whiteGain);
    pinkSrc.connect(pinkGain);
    whiteSrc.start();
    pinkSrc.start();

    // ---- Filter section (external audio → LP + HP) ----
    // The audio input fans out through one GainNode into both biquads, so a
    // single inputs-map entry feeds both filters.
    const fan = ctx.createGain();
    fan.gain.value = 1;

    const lpFilter = ctx.createBiquadFilter();
    lpFilter.type = 'lowpass';
    lpFilter.frequency.value = cutoffToHz(paramOf('lpCutoff'));

    const hpFilter = ctx.createBiquadFilter();
    hpFilter.type = 'highpass';
    hpFilter.frequency.value = cutoffToHz(paramOf('hpCutoff'));

    fan.connect(lpFilter);
    fan.connect(hpFilter);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        // Single audio input → the fan node feeding both filters.
        ['audio', { node: fan, input: 0 }],
      ]),
      outputs: new Map([
        ['white', { node: whiteGain, output: 0 }],
        ['pink',  { node: pinkGain,  output: 0 }],
        ['lp',    { node: lpFilter,  output: 0 }],
        ['hp',    { node: hpFilter,  output: 0 }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'level') {
          whiteGain.gain.setValueAtTime(value, ctx.currentTime);
          pinkGain.gain.setValueAtTime(value, ctx.currentTime);
        } else if (paramId === 'lpCutoff') {
          lpFilter.frequency.setValueAtTime(cutoffToHz(value), ctx.currentTime);
        } else if (paramId === 'hpCutoff') {
          hpFilter.frequency.setValueAtTime(cutoffToHz(value), ctx.currentTime);
        }
      },
      readParam(paramId) {
        if (paramId === 'level') return whiteGain.gain.value;
        // Invert the log map so the knob tracks the live biquad frequency.
        if (paramId === 'lpCutoff') return hzToCutoff(lpFilter.frequency.value);
        if (paramId === 'hpCutoff') return hzToCutoff(hpFilter.frequency.value);
        return undefined;
      },
      dispose() {
        try { whiteSrc.stop(); } catch { /* already stopped */ }
        try { pinkSrc.stop();  } catch { /* already stopped */ }
        try { whiteSrc.disconnect(); } catch { /* */ }
        try { pinkSrc.disconnect();  } catch { /* */ }
        try { whiteGain.disconnect(); } catch { /* */ }
        try { pinkGain.disconnect();  } catch { /* */ }
        try { fan.disconnect();       } catch { /* */ }
        try { lpFilter.disconnect();  } catch { /* */ }
        try { hpFilter.disconnect();  } catch { /* */ }
      },
    };
  },
};

/** Inverse of cutoffToHz — recover the normalized 0..1 knob value from a
 *  biquad frequency. Used by readParam so the UI knob tracks the live DSP. */
function hzToCutoff(hz: number): number {
  const clamped = Math.min(CUTOFF_MAX_HZ, Math.max(CUTOFF_MIN_HZ, hz));
  return Math.log(clamped / CUTOFF_MIN_HZ) / Math.log(CUTOFF_MAX_HZ / CUTOFF_MIN_HZ);
}
