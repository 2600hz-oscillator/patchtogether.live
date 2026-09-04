// packages/web/src/lib/audio/modules/moog904a.ts
//
// MOOG 904A — Voltage Controlled Low Pass Filter (slice 2 of the Moog
// System 55 / 35 clone initiative, .myrobots/MOOG/). The classic Moog
// transistor-ladder LPF: 24 dB/oct, with a FIXED CONTROL VOLTAGE (cutoff)
// pot, a RANGE switch (shifts cutoff in 2-octave steps), summed 1 V/oct
// CONTROL INPUTS, and a REGENERATION pot (variable Q / internal feedback)
// that self-oscillates into a clean sine VC generator near max.
//
// The 904A appears in BOTH systems (S35×1, S55×2) → shared → categorized
// under Ports → moogafakkin (the shared bucket, mirroring the 921 VCO).
//
// DSP: own-code, CLEAN-ROOM transistor-ladder core
// (packages/dsp/src/moog904a.ts + lib/moog-ladder-dsp.ts) — re-derived from
// the unpatented textbook TPT/Zavalishin zero-delay-feedback algorithm plus
// the Huovilainen tanh-per-loop TECHNIQUE. NOT a port of the LGPLv3
// Huovilainen code, the CC-BY-SA musicdsp model, or any Moog schematic
// (permissive / own-code only). The same lib
// is reused by 904B (HPF) + 904C (coupler) in later slices.
//
// Inputs:
//   audio (audio): signal to be filtered.
//   cutoff_cv (cv, paramTarget=cutoff): summing 1 V/oct CONTROL INPUT —
//     audio-rate, summed (exponentially) onto the cutoff in the worklet
//     (PASSTHROUGH — the worklet applies the 1 V/oct map per-sample).
//   reso_cv (cv, paramTarget=regeneration): REGENERATION CV — audio-rate,
//     summed onto the regeneration knob per-sample in the worklet
//     (PASSTHROUGH).
//
// Outputs:
//   audio (audio): 24 dB/oct low-pass output (self-oscillating sine near
//     regeneration=1).
//
// Params:
//   cutoff (log 20..20000 Hz, default 1000): FIXED CONTROL VOLTAGE pot.
//   range (discrete 1..3, default 2): RANGE switch — 2-octave steps.
//   regeneration (linear 0..1, default 0): variable Q / internal feedback.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ParamOption } from '$lib/graph/types';
import workletUrl from '@patchtogether.live/dsp/dist/moog904a.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
// Per-context cache so addModule isn't called twice on the same context.
const loadedContexts = new WeakSet<BaseAudioContext>();

/**
 * The RANGE switch's three positions.
 *
 * ⚠ THE POSITION NUMBERS EXISTED ONLY ON THE LEGACY CARD, and what they MEAN
 * existed nowhere at all. `Moog904aVcfCard.svelte` built its `role="radiogroup"`
 * from a local `RANGE_POS` array of bare `1` / `2` / `3` — so promotion would
 * have deleted the only place the positions are named, and even the card never
 * said that they are ×1 / ×4 / ×16.
 *
 * ⚠ THE LABELS ARE NAMES, NOT THE PANEL'S NUMERALS, AND A GATE MADE THAT CALL.
 * The first draft kept `1` / `2` / `3` for parity with the card's exact text.
 * `face-readout-source.test.ts` refused it: a param with `options` and no
 * `format` PAINTS its option label under the dial, so bare numerals would put a
 * decimal representation of knob state back on the faceplate — the thing the
 * 2026-08-17 owner ruling removed. The gate's own instruction is *"either name
 * the state or add a NUMERIC_LABEL_EXEMPTIONS entry saying why the number IS
 * the name"*.
 *
 * Naming it is the better answer here rather than the cheaper one, because THE
 * INVISIBILITY OF THIS SWITCH IS THE MODULE'S WHOLE FINDING: a faceplate
 * painting `2` under RANGE tells a player exactly as little as the card did.
 * `LOW` / `MID` / `HIGH` are the bands the DSP's own comments describe
 * (`~60–80` / `~260–340` / `~1.0–1.3 k` Hz at the knob's low end), the `title`
 * carries the position number AND the multiplier, and the delivered frequency
 * is printed live by `moog904a-cutoff-hz`.
 *
 * ⚠ `×1` / `×4` / `×16` was considered and REJECTED. It would pass the gate —
 * but only because `looksNumeric` anchors its `×` as a SUFFIX while the
 * function's own comment says a LEADING `×` "counts as part of the number". A
 * label that slips through a gap between a gate's stated intent and its regex
 * is not a label that satisfies the rule.
 *
 * ⚠ THE CONSEQUENCE IS PRINTED, NOT JUST DESCRIBED. Because the multiplier
 * lands BEFORE the worklet's 20 Hz / 20 kHz clamp, position 3 makes the top
 * 40.14 % of the CUTOFF dial bit-exactly dead (measured; see the face comment).
 * The `moog904a-cutoff-hz` readout pins at `20.0 kHz` across exactly that span,
 * which is the module's honest way of showing why the knob stopped responding.
 *
 * `options` is cosmetic in the contract projection, so declaring it costs no
 * `contract-lock` line.
 */
export const MOOG904A_RANGE_OPTIONS: readonly ParamOption[] = [
  { value: 1, label: 'LOW', title: 'position 1, ×1 — the dial reads true; the whole 20 Hz…20 kHz travel is usable' },
  { value: 2, label: 'MID', title: 'position 2, ×4 (+2 oct) — the dial delivers four times what it says, and clamps at 20 kHz above 5 kHz' },
  { value: 3, label: 'HIGH', title: 'position 3, ×16 (+4 oct) — sixteen times what the dial says, and everything above 1.25 kHz is the same filter' },
];

export const moog904aDef: AudioModuleDef = {
  type: 'moog904a',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  domain: 'audio',
  label: '904a vcf',
  category: 'filters',

  inputs: [
    { id: 'audio', type: 'audio' },
    // cutoff_cv + reso_cv are audio-rate CONTROL INPUTS (the worklet sums
    // knob + CV per-sample with the 1 V/oct map), so they don't go through
    // the CV→AudioParam fast path. paramTarget keeps docs labelling correct;
    // no cvScale (PASSTHROUGH_BY_DESIGN, like the 921's width_cv).
    { id: 'cutoff_cv', type: 'cv', paramTarget: 'cutoff' },
    { id: 'reso_cv', type: 'cv', paramTarget: 'regeneration' },
  ],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [
    { id: 'cutoff', label: 'Cutoff', defaultValue: 1000, min: 20, max: 20000, curve: 'log', units: 'Hz' },
    { id: 'range', label: 'Range', defaultValue: 2, min: 1, max: 3, curve: 'discrete', options: MOOG904A_RANGE_OPTIONS },
    { id: 'regeneration', label: 'Regen', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
  ],

  // ── THE FACE ────────────────────────────────────────────────────────────────
  //
  // WHAT IT IS FOR, MUSICALLY: the rack's transistor-ladder 24 dB/oct low-pass —
  // the one filter that stops being a filter and becomes an oscillator. The verb
  // is DARKENING AND OPENING A SOUND, AND FINDING THE EDGE WHERE IT STARTS TO
  // SING. What `filter` and `resofilter` do not have: a RANGE switch that
  // relocates the whole sweep, and a resonance that crosses into a bounded
  // self-oscillating sine.
  //
  // ⚠ THE HEADLINE — ONE DIAL, THREE MEANINGS. `cutoff` declares `units: 'Hz'`,
  // so the knob prints a number that reads like an answer, and RANGE multiplies
  // it by ×1 / ×4 / ×16 before it reaches the ladder. Dial pinned at 1000 Hz,
  // measured on the SHIPPING worklet with a Hann-windowed single-bin DFT over
  // the SETTLED TAIL:
  //
  //   RANGE 1   places the filter at  1000 Hz   (−3 dB corner   434.02 Hz)
  //   RANGE 2   places the filter at  4000 Hz   (−3 dB corner  1766.87 Hz)
  //   RANGE 3   places the filter at 16000 Hz   (−3 dB corner  9840.59 Hz)
  //
  // ⚠ AND THE CLAMP MAKES THE TOP OF THE DIAL DEAD. The 20 kHz clamp applies to
  // the PRODUCT, so at RANGE 2 every dial position from 5000 Hz up, and at
  // RANGE 3 every position from 1250 Hz up, is BIT-IDENTICAL to the maximum —
  // the top 20.07 % and 40.14 % of the log taper respectively, with both
  // boundaries landing exactly on 20000 ÷ ×4 and 20000 ÷ ×16. Negative control:
  // 2 % below each boundary correctly DIFFERS. (This has to be measured on the
  // settled TAIL — comparing whole buffers reports 0.00 % / 0.00 % / 6.17 %,
  // because `smCutoff` smooths the RAW dial in Hz BEFORE the multiply-and-clamp,
  // so two dials that settle to the same filter travel there differently.)
  //
  // THE RANKING ARGUMENT, FROM THE DSP:
  //
  //   cutoff        rank 1 on UNCONDITIONAL APPLICABILITY — every patched signal
  //                 passes through it, at every setting of everything else.
  //   regeneration  rank 2 because it is the only control that changes the
  //                 module's CLASS. Bisected on an UNPATCHED render, regen
  //                 0.665231 is where a silent 904a starts emitting: below it
  //                 the tail peaks at 4.9018e-7, above it at 1.6934e-1. That is
  //                 not a change of degree. ⚠ THIS ARGUMENT WOULD BE WRONG FOR
  //                 `resofilter`, whose Q never self-oscillates — the coupling
  //                 is a property of a ladder with tanh feedback.
  //   range         rank 3 DESPITE carrying the biggest number in this comment,
  //                 and the demotion is the defensible part: it MULTIPLIES what
  //                 rank 1 already does, and it is a set-once placement switch
  //                 rather than a performance control. Its consequence belongs
  //                 in a READOUT, not in a rank — and that is where it is.
  //
  // Tier ladder as a sentence: a glyph BINDS, so the compact cap is
  // LANE_ROW_MAX_CELLS_WITH_GLYPH = 2 — mini shows CUTOFF, compact adds REGEN
  // beside the trace, and plate and dock add RANGE, which is exactly the tier
  // where the readout that explains RANGE is also on screen.
  //
  // ⚠ `order` and `pages` DISAGREE DELIBERATELY: `order` ranks by what a player
  // reaches for, `pages` groups the two controls that JOINTLY determine one
  // frequency.
  face: {
    order: ['cutoff', 'regeneration', 'range'],

    pages: [
      {
        id: 'filter',
        label: 'filter',
        hint: 'the corner — and RANGE multiplies the dial by ×1 / ×4 / ×16 before the ladder sees it',
        controls: ['cutoff', 'range'],
      },
      {
        id: 'resonance',
        label: 'resonance',
        hint: 'internal feedback — past 0.665 the filter stops filtering and starts singing',
        controls: ['regeneration'],
      },
    ],

    // ⚠ IT RESOLVES, AND THE RESOLVER NAMES THE TAP: this def declares exactly
    // one `type: 'audio'` output, so `primaryAudioOutPortId` returns `audio` and
    // `glyphBinding` gives `{ kind: 'live-audio', portId: 'audio' }`. Both
    // `'meter'` and `'waveform'` resolve to that same tap; `'waveform'` because
    // this module's signature event — the ladder breaking into a sine — is a
    // SHAPE, and a meter would read the same for a filter sweep and a limit
    // cycle.
    //
    // ⚠ AND IT IS PIXEL-DETERMINISTIC, unlike the `analogVco` case, for a reason
    // that is a property of this module rather than of the harness: a 904a is a
    // FILTER with no source of its own, and `regeneration` SHIPS AT 0 — below
    // the 0.665231 self-oscillation threshold — so a freshly spawned, unpatched
    // 904a emits nothing and the trace is a flat centreline. The dither that
    // would make it non-deterministic is scaled by `regen⁴`, which is exactly 0
    // at the default.
    glyph: 'waveform',

    // THE HERO: the corner dial, plus the two things this module publishes that
    // none of its controls can print. Their reach is DISJOINT:
    //
    //   cutoff  moves on CUTOFF and RANGE — the frequency actually delivered,
    //           through the worklet's own clamp. It is the number the dial lies
    //           about, and it PINS at 20.0 kHz across the dead top of the dial.
    //   state   moves on REGENERATION alone — a NAME (`filter` / `osc`), not a
    //           number, because the REGEN dial reads a plausible 0.66 on BOTH
    //           sides of a boundary the module's output crosses by five and a
    //           half orders of magnitude.
    //
    // ⚠ NO −3 dB CORNER READOUT, and this was DRAFTED AND THEN REJECTED ON A
    // MEASUREMENT rather than skipped. The queue spec proposed
    // `cutoff · rangeMultiplier · 0.43419`, calling its error 0.19 %. That
    // constant is the cascade's LOW-FREQUENCY limit and this is a TPT design
    // whose `tan` prewarp compresses toward Nyquist, so the real error is
    // −0.04 % / −1.70 % / −29.40 % at RANGE 1 / 2 / 3 — wrong by nearly half an
    // octave exactly where this module's headline lives. The prewarped closed
    // form is accurate to 0.34 % but needs the SAMPLE RATE, which a
    // `FaceReadoutValue` cannot reach. Full working in moog904a-face-model.ts.
    hero: {
      control: 'cutoff',
    },
  },

  docs: {
    explanation:
      "A clean-room recreation of the Moog 904A Voltage Controlled Low Pass Filter — the iconic 24 dB/octave transistor-ladder LPF at the heart of the Moog sound. It rolls off everything above the cutoff at a steep four-pole slope, warming and darkening the signal. The CUTOFF knob sets the corner, the RANGE switch shifts that corner in two-octave steps, and REGENERATION is the resonance (internal feedback): turn it up to emphasise the band right at the cutoff, and near maximum the filter self-oscillates into a clean sine — a playable voltage-controlled oscillator in its own right. A summing 1 V/octave control input sweeps the cutoff (patch an envelope or LFO here for the classic filter sweep) and a second CV input modulates the regeneration. The ladder core is the textbook zero-delay-feedback algorithm with a tanh per loop for the analog drive, not a port of any Moog schematic.",
    inputs: {
      audio: "The signal to be filtered — the audio fed into the ladder.",
      cutoff_cv: "Summing 1 V/octave CONTROL INPUT to the cutoff (audio-rate). It adds exponentially onto the CUTOFF knob inside the worklet, so this is the jack for the classic filter sweep — an envelope opens/closes the corner, an LFO wobbles it, a pitch CV makes the cutoff track played notes. ⚠ WHICH QUANTITY tracks 1 V/octave matters here, because the answer differs: as a FILTER it does, measured +0.998 / +1.999 / +3.002 octaves at +1 / +2 / +3 V (the residual is the measurement's own resolution — doubling the knob instead of the jack reproduces it exactly). But once REGENERATION has pushed the filter into SELF-OSCILLATION, the pitch of the sine it emits does NOT: the same +1 / +2 / +3 V move it +0.981 / +1.946 / +2.880 octaves, so it drifts progressively flat and is about a fifth of a semitone short by three volts (#1913, filed for owner ears — the audio is deliberately unchanged). Use it as a filter sweep and it is exact; play it as an oscillator and it will not stay in tune with the rest of the rack.",
      reso_cv: "CONTROL INPUT to REGENERATION (audio-rate, summed per-sample). Modulate the resonance — e.g. an envelope that pushes the filter toward self-oscillation on each note for a chirp or zap.",
    },
    outputs: {
      audio: "The 24 dB/octave low-passed output. With REGENERATION near maximum and nothing patched in, it emits a clean self-oscillating sine at the cutoff frequency.",
    },
    controls: {
      cutoff: "The FIXED CONTROL VOLTAGE pot — where the filter is placed, on a 20 Hz to 20 kHz log taper. Everything above it is attenuated at the four-pole slope; lower it to darken, raise it to open up. CV adds on top of this setting. Defaults to 1 kHz. ⚠ The number on this dial is NOT the frequency the ladder receives: the RANGE switch multiplies it first (×1 / ×4 / ×16), so at the factory settings a dial reading 1 kHz places the filter at 4 kHz. The faceplate prints the delivered figure next to the dial for exactly this reason.",
      range: "RANGE switch (1 / 2 / 3) — shifts the whole cutoff sweep in two-octave steps (×1 / ×4 / ×16), so you can place the CUTOFF pot's travel in the bass, mids, or highs. Defaults to position 2 (the middle range). ⚠ The multiplier is applied BEFORE the 20 kHz ceiling, so the higher positions spend part of the dial pinned against it: at position 2 every CUTOFF setting above 5 kHz is the same filter, and at position 3 everything above 1.25 kHz is — the top 20 % and 40 % of the dial's travel respectively. The delivered-frequency readout stops climbing there, which is the visible sign that further turning is doing nothing.",
      regeneration: "REGENERATION — the resonance / internal feedback (variable Q). At 0 the filter is flat; turning it up emphasises a peak at the cutoff; past about 0.665 the filter self-oscillates and rings as a sine VCO even with nothing patched in. Defaults to 0 (no resonance). That crossing is a change of KIND rather than of degree — measured on the shipping filter, an unpatched 904A peaks at 4.9e-7 just below it and 1.7e-1 just above — so the faceplate names which side you are on rather than restating the dial.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = createWorkletNode(node, ctx, 'moog904a', {
      numberOfInputs: 3,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    // Feed silence into every input so the node stays in the active
    // processing graph even when nothing's externally patched (mirrors the
    // 921 VCO + analogVco silence-keepalive pattern).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);
    silence.connect(workletNode, 0, 1);
    silence.connect(workletNode, 0, 2);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of moog904aDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['audio', { node: workletNode, input: 0 }],
        ['cutoff_cv', { node: workletNode, input: 1 }],
        ['reso_cv', { node: workletNode, input: 2 }],
      ]),
      outputs: new Map([['audio', { node: workletNode, output: 0 }]]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        try { silence.disconnect(); } catch { /* */ }
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};
