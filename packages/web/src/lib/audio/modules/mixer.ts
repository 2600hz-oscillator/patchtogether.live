// packages/web/src/lib/audio/modules/mixer.ts
//
// MIXER — 4-channel mono summing mixer with a master level.
//
// The utility that turns four mono sources into one bus: one level per
// channel, one master on the sum, one output. No pan, no EQ, no aux sends,
// no direct outs, no CV inputs — deliberately the smallest thing that sums.
//
// DSP: packages/dsp/src/mixer.dsp (Faust-compiled). The ENTIRE processor is
//
//   out = (in1·g1 + in2·g2 + in3·g3 + in4·g4) · gMaster
//
// where each g is its knob run through `si.smoo`. Verified against the
// generated C++ (`faust -lang cpp packages/dsp/src/mixer.dsp`): the smoother
// is a one-pole whose coefficient the compiler emits as 44.1/sampleRate, i.e.
// a ≈23 ms time constant at ANY sample rate. Two consequences the face + docs
// are written around:
//   * knob moves and remote param writes de-zip (no stepping), and
//   * the levels are CONTROL-rate, not audio-rate — MIXER is a mixer, never
//     a VCA or a ring modulator (VCA / ATTENUMIX are the modulated-level
//     utilities).
//
// HEADROOM — the fact that most often surprises people: the sum is NOT
// limited, clamped, or headroom-compensated, and `master` tops out at 1.0
// (it can only attenuate — there is no make-up gain). Four unity channels
// carrying correlated full-scale audio therefore leave this module at up to
// 4× full scale (+12 dB) and clip at whatever downstream stage clamps; the
// module itself never distorts. Every level DEFAULTS to 1.0, so a freshly
// spawned MIXER is a unity pass-through for one source and wants trimming
// for four. (Soft-clip + per-channel CV + direct outs → ATTENUMIX; stereo,
// EQ and aux sends → MIXMSTRS.)
//
// The four inputs are routed onto distinct channels of the Faust node's
// single multi-channel input via a ChannelMerger; an unpatched input
// contributes silence on its channel.
//
// Inputs:
//   in1..in4 (audio): the four channels to sum. AUDIO cables only — the
//     ports declare no `accepts` widening, so canConnect refuses cv / gate /
//     pitch sources (this is not a Eurorack-style CV summer).
//
// Outputs:
//   audio (audio): the summed bus (in1*ch1 + in2*ch2 + in3*ch3 + in4*ch4) * master.
//
// Params:
//   ch1..ch4 (LINEAR AMPLITUDE 0..1, default 1): per-channel level.
//   master (LINEAR AMPLITUDE 0..1, default 1): level on the summed bus.

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/mixer.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/mixer.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/mixer.worklet.js?url';

const PARAM_PREFIX = '/Mixer';

export const mixerDef: AudioModuleDef = {
  type: 'mixer',
  palette: { top: 'Audio modules', sub: 'Mixing' },
  domain: 'audio',
  label: 'mixer',
  category: 'utilities',
  inputs: [
    { id: 'in1', type: 'audio' },
    { id: 'in2', type: 'audio' },
    { id: 'in3', type: 'audio' },
    { id: 'in4', type: 'audio' },
  ],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [
    { id: 'ch1',    label: 'Ch1',    defaultValue: 1, min: 0, max: 1, curve: 'linear' },
    { id: 'ch2',    label: 'Ch2',    defaultValue: 1, min: 0, max: 1, curve: 'linear' },
    { id: 'ch3',    label: 'Ch3',    defaultValue: 1, min: 0, max: 1, curve: 'linear' },
    { id: 'ch4',    label: 'Ch4',    defaultValue: 1, min: 0, max: 1, curve: 'linear' },
    { id: 'master', label: 'Master', defaultValue: 1, min: 0, max: 1, curve: 'linear' },
  ],

  // ── RACKLINE face (P1 batch-3 TOTAL REWORK — UI curation only, NOT the I/O
  // contract; see ModuleFace in $lib/graph/types). Designed from what a mixer
  // IS rather than transcribed from the legacy 5-fader row.
  //
  // THE RANKING. Four of the five controls are SYMMETRIC — any "top 2 of 5"
  // slice necessarily privileges some channels over others — so the ranking is
  // decided by the honest question the ladder actually asks: *if you can see
  // only ONE control, which one?* For a mixer that is unambiguously `master`:
  //   * one channel fader in isolation is useless — you cannot BALANCE with
  //     one knob, and picking ch1 over ch2/3/4 is arbitrary;
  //   * master is the only control whose meaning does not depend on which of
  //     four identical jacks you happened to patch, and it is the fader you
  //     ride (submix fades, taming the sum);
  //   * paired with the live 'meter' glyph it makes a COMPLETE micro-face —
  //     "this submix, how loud it is, and the knob that sets it".
  // The four channels then follow in jack order. The knob in the leading
  // position therefore means the SAME thing at every zoom tier (mini, compact
  // and the full-in-lane plate all lead with MASTER), which is the whole point
  // of a stable ranking.
  //   mini (1 + glyph)      master — the submix level, read against the meter.
  //   compact (2 + glyph)   + ch1 — the tile reads SOURCE · BUS · LEVEL.
  //   full-in-lane (plate)  all five (5 cells ≤ the 3×2 whole-cell cap; the
  //                         glyph steps aside for the ranked controls, per
  //                         laneBodyPlan) — the complete mixer in the lane.
  //
  // THE GLYPH is 'meter', and on this module it is load-bearing rather than
  // decorative: `master` cannot boost and the sum is NOT limited (see the
  // header), so a mixer's one real failure mode is summing into clipping with
  // nothing on the panel to say so. glyphBinding resolves 'meter' → live-audio
  // on the `audio` output, so the tile shows the REAL bus RMS.
  //
  // THE PAGES deliberately do NOT mirror the ranking: `order` is priority,
  // `pages` is the dock LAYOUT, and a faceplate should read in SIGNAL ORDER.
  // So the dock renders the four channel levels first and the master bus last
  // — sources, then the sum — while the tier ladder still leads with master.
  face: {
    order: ['master', 'ch1', 'ch2', 'ch3', 'ch4'],
    pages: [
      { id: 'channels', label: 'channel levels', controls: ['ch1', 'ch2', 'ch3', 'ch4'] },
      { id: 'bus', label: 'master bus', controls: ['master'] },
    ],
    glyph: 'meter',
    // REAR CARD curation (rear-card-model). With 4 symmetric inputs and 1
    // output this is one of the SIMPLEST possible fields — which makes the
    // band LABEL the only real decision, and on a module of four identical
    // holes the label has one job: say which hole feeds which fader. The
    // derivation would file all four into a generic 'signal' band (none is a
    // per-param CV), so the band is pinned instead and named for the
    // correspondence, sharing the `channels` page id so the front page and the
    // rear band are the same group under two apt names.
    //
    // NO `audioRate` ticks, on purpose: the `~` tick marks the SURPRISING case
    // — a CV hole the DSP reads per sample — and saying "audio-rate" about four
    // AUDIO inputs is noise on every hole (the vca precedent, which likewise
    // leaves its `audio` input un-ticked). It would also be actively
    // MISLEADING here: the audio path is per-sample but the LEVELS are
    // ≈23 ms-smoothed, and this module has no CV holes at all.
    rear: {
      groups: [
        {
          id: 'channels',
          label: 'channel inputs · in1→ch1 … in4→ch4',
          ports: ['in1', 'in2', 'in3', 'in4'],
        },
      ],
    },
  },

  docs: {
    explanation:
      "The four-into-one utility: patch up to four mono sources in, set how much of each goes to the bus, and one summed output comes back out. The whole processor is out = (in1×Ch1 + in2×Ch2 + in3×Ch3 + in4×Ch4) × Master — no pan, no EQ, no sends, no direct outs and no CV inputs, which is the point (per-channel CV, direct outs and soft-clip are ATTENUMIX; stereo with EQ and aux sends is MIXMSTRS). Two things worth knowing before you patch it. FIRST, the levels are LINEAR AMPLITUDE, not decibels and not an audio-taper fader: half travel is only −6 dB, a quarter is −12 dB, and everything below −20 dB is squeezed into the bottom tenth of the knob — so fine fades live near the bottom and the top half of the travel is a fairly small loudness change. SECOND, MIXER does not protect you: the sum is never limited, clamped or headroom-compensated, and Master maxes out at 1.0 so it can only attenuate — there is no make-up gain. Every level defaults to 1.0, which makes a fresh MIXER a clean unity pass-through for one source, but four hot sources at unity add up to as much as 4× full scale (+12 dB) and will clip wherever the signal is finally clamped, not here. Trim the channels or pull the master down, and watch the face's level meter (it reads the real bus, live) to see it happen. All five levels are one-pole smoothed with a roughly 23 ms time constant, so moves and remote/MIDI writes are click-free — and, by the same token, control-rate: patching an envelope at a level is not possible here and the knobs cannot be used as a VCA or a ring modulator.",
    inputs: {
      in1: "Channel 1 audio input; multiplied by the Ch1 level, then summed with the other three channels. AUDIO cables only — the port declares no widening, so CV, gate and pitch cables are refused (MIXER is not a CV summer). Unpatched it contributes silence, so an unused channel costs nothing whatever Ch1 is set to.",
      in2: "Channel 2 audio input; multiplied by the Ch2 level, then summed with the other three channels. AUDIO cables only (CV / gate / pitch sources are refused). Unpatched it contributes silence, so an unused channel costs nothing whatever Ch2 is set to.",
      in3: "Channel 3 audio input; multiplied by the Ch3 level, then summed with the other three channels. AUDIO cables only (CV / gate / pitch sources are refused). Unpatched it contributes silence, so an unused channel costs nothing whatever Ch3 is set to.",
      in4: "Channel 4 audio input; multiplied by the Ch4 level, then summed with the other three channels. AUDIO cables only (CV / gate / pitch sources are refused). Unpatched it contributes silence, so an unused channel costs nothing whatever Ch4 is set to.",
    },
    outputs: {
      audio:
        "The summed bus: (in1×Ch1 + in2×Ch2 + in3×Ch3 + in4×Ch4) × Master, mono. It is a plain sum — nothing here limits, soft-clips or divides by the channel count, and Master cannot exceed 1.0, so with several channels open the output can legitimately run well past full scale (four correlated unity sources reach 4×, about +12 dB) and will clip at the first stage that clamps rather than in this module. The bus goes silent when all four levels are at 0 or Master is at 0 — reached as a ≈23 ms glide, not an instant cut, because every level is one-pole smoothed.",
    },
    controls: {
      ch1: "Channel 1 level: a LINEAR AMPLITUDE multiplier from 0 (silent) to 1 (the input at its own level), default 1. Linear means the dB scale bunches at the bottom — 0.5 is −6 dB, 0.25 is −12 dB, 0.1 is −20 dB — so use the lower part of the travel for real fades. It only attenuates; there is no gain above unity anywhere in this module. Smoothed with a ≈23 ms one-pole, so moves never zipper — and are control-rate, not audio-rate.",
      ch2: "Channel 2 level: a LINEAR AMPLITUDE multiplier from 0 (silent) to 1 (the input at its own level), default 1. Linear means the dB scale bunches at the bottom — 0.5 is −6 dB, 0.25 is −12 dB, 0.1 is −20 dB — so use the lower part of the travel for real fades. It only attenuates; there is no gain above unity anywhere in this module. Smoothed with a ≈23 ms one-pole, so moves never zipper — and are control-rate, not audio-rate.",
      ch3: "Channel 3 level: a LINEAR AMPLITUDE multiplier from 0 (silent) to 1 (the input at its own level), default 1. Linear means the dB scale bunches at the bottom — 0.5 is −6 dB, 0.25 is −12 dB, 0.1 is −20 dB — so use the lower part of the travel for real fades. It only attenuates; there is no gain above unity anywhere in this module. Smoothed with a ≈23 ms one-pole, so moves never zipper — and are control-rate, not audio-rate.",
      ch4: "Channel 4 level: a LINEAR AMPLITUDE multiplier from 0 (silent) to 1 (the input at its own level), default 1. Linear means the dB scale bunches at the bottom — 0.5 is −6 dB, 0.25 is −12 dB, 0.1 is −20 dB — so use the lower part of the travel for real fades. It only attenuates; there is no gain above unity anywhere in this module. Smoothed with a ≈23 ms one-pole, so moves never zipper — and are control-rate, not audio-rate.",
      master:
        "The level on the summed bus (linear amplitude 0..1, default 1) — the fader you ride to bring the whole submix up and down without touching the balance between channels. Note what 1.0 does and does not mean: it is a unity COEFFICIENT on the sum, not a unity OUTPUT — with more than one channel open the bus is already louder than any single input, and Master cannot go above 1.0, so it is the module's only headroom control and the way you pull an over-hot sum back under full scale. At 0 the whole mix is silent. Smoothed like the channel levels (≈23 ms), so it fades rather than steps.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'mixer', wasmUrl, metaUrl, workletUrl });
    const merger = ctx.createChannelMerger(4);
    merger.connect(f);
    const params = f.parameters as unknown as Map<string, AudioParam>;
    for (const def of mixerDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    return {
      domain: 'audio',
      inputs: new Map([
        ['in1', { node: merger, input: 0 }],
        ['in2', { node: merger, input: 1 }],
        ['in3', { node: merger, input: 2 }],
        ['in4', { node: merger, input: 3 }],
      ]),
      outputs: new Map([['audio', { node: f, output: 0 }]]),
      setParam(paramId, value) {
        params.get(`${PARAM_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(`${PARAM_PREFIX}/${paramId}`)?.value;
      },
      dispose() {
        merger.disconnect();
        f.disconnect();
      },
    };
  },
};
