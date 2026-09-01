// packages/web/src/lib/audio/modules/attenumix.ts
//
// ATTENUMIX — the simple mixer. 4-channel attenuating mixer with per-
// channel direct outs, per-channel CV-summed attenuator, and a master
// gain knob with tanh soft-clip on the summed mix.
//
// Per channel (i ∈ {1..4}):
//   att_i = clamp(knob_i + cv_i, 0, 1)    (knob+CV sum, bounded 0..1 —
//                                          attenuators only attenuate,
//                                          they never boost)
//   out_i = in_i * att_i                  (per-channel direct out)
// Mix:
//   sum   = out_1 + out_2 + out_3 + out_4
//   mix   = tanh(sum * master)            (master 0..2; tanh keeps a
//                                          master>1 boost musical)
//
// Why a separate module from VEILS (which shares the same "quad VCA +
// summing mix" topology):
//   - VEILS' channel knobs span [0, 2] because its identity is "gain past
//     unity = warm soft-clip at the channel". ATTENUMIX' channel knobs cap
//     at 1.0 because attenuators ATTENUATE — the boost lives on the
//     master, with the tanh placed after the master multiply.
//   - VEILS has a per-channel linear/exponential response toggle (a
//     classic VEILS feature). ATTENUMIX is the no-toggles, every-knob-
//     does-what-it-says-it-does mixer. If you want quad-VCA-with-
//     overdrive-per-channel, use VEILS; if you want "the mixer", use
//     ATTENUMIX.
//
// CV-input semantics: PASSTHROUGH_BY_DESIGN. The attenuator's natural
// range is [0, 1]; a ±1V LFO at knob=0 already sweeps full range (clamp
// rejects the negative half, the positive half fully opens the channel).
// Interposing a `linear` cvScale would compute (1-0)/2 = 0.5 and HALVE
// the LFO's reach — strictly worse. Documented in
// cv-scale-registry.test.ts → PASSTHROUGH_BY_DESIGN.
//
// ── THE CHANNELS CARRY AUDIO **OR** CV (the SCALER precedent) ──────────────
//
// The four channel inputs used to be bare `audio`, which made `cv → in1`
// REJECTED by canConnect — so ATTENUMIX could not attenuate or mix a control
// voltage at all, even though the DSP is a plain per-sample multiply that is
// completely indifferent to which class of signal it scales. They are now
// widened with `accepts: ['cv','pitch','gate']` — the SCOPE-probe / SCALER /
// ES-9 pattern: `audio`-typed so audio cables land natively, `accepts` so a
// CV / gate / pitch source lands too (canConnectToPort).
//
// The four DIRECT OUTS are TYPE-TRANSPARENT: `out_i` declares
// `adoptsUpstreamFrom: 'in_i'`, so its EMITTED cable type is whatever is
// patched into its OWN channel. This is a 1:1 mapping with no ambiguity —
// channel i's direct out carries exactly channel i's signal, scaled. WHY it
// matters is the SCALER dead-knob bug, verbatim: the audio→video bridge picks
// its read path off the SOURCE cable type, and an `audio`-typed source is RMS
// ENVELOPE-FOLLOWED and clamped to 1.0 (sign destroyed), while cv/pitch/gate
// is read as the raw tail sample. A hard-`audio` direct out therefore made an
// attenuated CV saturate at a modulation destination and the ATT knob do
// nothing. Adoption is LIVE (re-resolved in buildPatchSnapshot every graph
// update) and falls back to the declared `audio` when nothing is patched
// upstream, or when the adopted type could not legally reach the actual
// downstream target.
//
// ⚠ `mix` DOES **NOT** ADOPT — it stays hard `audio`, deliberately. Three
// reasons, in the order that decides it:
//   1. `adoptsUpstreamFrom` names ONE input port and `mix` sums FOUR. There is
//      no primary channel: nominating `in1` would emit the WRONG type in two
//      ordinary patches — in1 unpatched with CV on in2..in4 (no feeder → falls
//      back to `audio` → the RMS clamp, i.e. the dead-knob shape again), and
//      in1 audio with CV elsewhere (emits `audio` for a sum that contains CV).
//      A type that is right only when channel 1 happens to be representative
//      is a coin flip wearing a contract.
//   2. The "adopt only if every patched input agrees" variant is not
//      expressible here: `PortDef.adoptsUpstreamFrom` is a single `string`,
//      resolveAdoptedSourceTypes reads ONE inbound edge, and module-manifest's
//      def parser matches the value with a single-quoted-string regex — an
//      array form would silently drop out of the generated docs manifest.
//      Extending the mechanism is a graph-layer + docs-parser change that
//      would re-type SCALER too; it is not this module's call to make.
//   3. Independently of the mechanism, `mix` is NOT a faithful voltage. It is
//      `tanh(sum · master)` — a saturating nonlinearity, so even at unity a
//      ±0.4 CV leaves as ±0.3799, and four open CV channels collapse toward
//      ±1. The per-channel direct outs are EXACTLY `in · clamp(knob+cv, 0, 1)`
//      — linear, DC-coupled, sign-preserving — so the module already has an
//      exact CV path, and it is the one that maps 1:1 onto the mechanism.
// The summing bus is an AUDIO bus. For CV, take the direct outs.
//
// ⚠ PATCH THE INPUT FIRST. Connection legality is decided on what an output
// EMITS (graph/adopted-type), so a channel with a CV on it offers `cv` to any
// CV jack — but a channel with NOTHING patched has no adopted type yet and
// falls back to the declared `audio`, which a strictly-`cv` input refuses. That
// refusal is deliberate rather than an oversight: permitting it would create an
// edge that is genuinely audio landing on a CV param, which is the DC/click
// hazard `canConnect` exists to prevent. Feed the channel and the direct out
// connects. (Until this was fixed the adoption was READ-only — the cable could
// never be created, so the type it would have carried never mattered. That was
// the owner's "scaler's output wont patch to cv ins", and ATTENUMIX would have
// shipped with the same hole.)
//
// Inputs:
//   in1 / in2 / in3 / in4 (audio, also accept the CV family): four channel inputs.
//   cv1 / cv2 / cv3 / cv4 (cv): per-channel raw bipolar CV (PASSTHROUGH).
//
// Outputs:
//   out1 / out2 / out3 / out4 (TYPE-TRANSPARENT, `adoptsUpstreamFrom: 'inN'`):
//     per-channel direct outs (post-attenuator, pre-mix). Declared `audio` as
//     the no-cable-upstream fallback.
//   mix (audio): tanh(sum * master) — soft-clipped summing bus, audio by
//     construction (see above).
//
// Params:
//   att1 / att2 / att3 / att4 (linear 0..1, default 0): per-channel attenuator (sums with CV, clamped 0..1).
//   master (linear 0..2, default 1.0): output gain on the summed bus (>1 = boost into tanh).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/attenumix.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
const PROCESSOR_NAME = 'attenumix';
const loadedContexts = new WeakSet<BaseAudioContext>();

/** Pure-math mirror of the worklet — unit + ART tests pin the per-channel
 *  attenuation, the mix-sum identity, and the master+tanh saturation curve
 *  without spinning up Web Audio. Any drift here means the worklet and
 *  this reference disagree. */
export const attenumixMath = {
  /** Per-channel attenuator: clamp(knob + cv, 0, 1). Negative knob+cv
   *  mutes (no phase flip); >1 knob+cv stops at unity (no boost). */
  channelAtt(knob: number, cv: number): number {
    const s = knob + cv;
    if (s <= 0) return 0;
    if (s >= 1) return 1;
    return s;
  },

  /** Per-channel multiply: out = in * att(knob + cv). */
  channelSample(inSample: number, knob: number, cv: number): number {
    return inSample * attenumixMath.channelAtt(knob, cv);
  },

  /** Mix soft-clip: tanh(sum * master). Master spans [0, 2] — pushing
   *  past 1 recruits the tanh for warm saturation. */
  mixSample(sum: number, master: number): number {
    return Math.tanh(sum * master);
  },

  /** Render `frames` samples through all 4 channels. Each channel's
   *  audio + CV may be null = unpatched (silent). Returns the four
   *  per-channel direct outs + the post-soft-clip mix. */
  render(
    ins: ReadonlyArray<Float32Array | null>,
    cvs: ReadonlyArray<Float32Array | null>,
    knobs: ReadonlyArray<number>,
    master: number,
    frames: number,
  ): { outs: Float32Array[]; mix: Float32Array } {
    const outs = [
      new Float32Array(frames),
      new Float32Array(frames),
      new Float32Array(frames),
      new Float32Array(frames),
    ];
    const mix = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let ch = 0; ch < 4; ch++) {
        const inBuf = ins[ch];
        const cvBuf = cvs[ch];
        const x = inBuf ? (inBuf[i] ?? 0) : 0;
        const c = cvBuf ? (cvBuf[i] ?? 0) : 0;
        const k = knobs[ch] ?? 0;
        const y = attenumixMath.channelSample(x, k, c);
        outs[ch]![i] = y;
        sum += y;
      }
      mix[i] = attenumixMath.mixSample(sum, master);
    }
    return { outs, mix };
  },
};

export const attenumixDef: AudioModuleDef = {
  type: 'attenumix',
  palette: { top: 'Audio modules', sub: 'Mixing' },
  domain: 'audio',
  label: 'attenumix',
  category: 'utilities',

  inputs: [
    // The four CHANNEL inputs. `audio`-typed so audio cables land natively,
    // widened to the CV family so a CV / gate / pitch source can be attenuated
    // and mixed too — the multiply does not care which class it scales.
    { id: 'in1', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
    { id: 'in2', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
    { id: 'in3', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
    { id: 'in4', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
    // The ATTENUATOR CV holes — modulation for the knob, NOT channel signal.
    // Unchanged: raw bipolar CV summed into att_i, PASSTHROUGH_BY_DESIGN.
    { id: 'cv1', type: 'cv' },
    { id: 'cv2', type: 'cv' },
    { id: 'cv3', type: 'cv' },
    { id: 'cv4', type: 'cv' },
  ],
  outputs: [
    // Per-channel direct outs. TYPE-TRANSPARENT: each adopts the cable type of
    // its OWN channel input, so an attenuated CV stays CV downstream (and the
    // cross-domain bridge tail-samples it instead of RMS-clamping it).
    // `type: 'audio'` is the fallback when that channel has nothing patched.
    { id: 'out1', type: 'audio', adoptsUpstreamFrom: 'in1' },
    { id: 'out2', type: 'audio', adoptsUpstreamFrom: 'in2' },
    { id: 'out3', type: 'audio', adoptsUpstreamFrom: 'in3' },
    { id: 'out4', type: 'audio', adoptsUpstreamFrom: 'in4' },
    // The summing bus does NOT adopt — it sums four possibly-different classes
    // through a tanh soft-clip, so it is an AUDIO bus by construction. See the
    // header for the full argument.
    { id: 'mix',  type: 'audio' },
  ],
  params: [
    // Per-channel attenuators cap at 1.0 — the boost-above-unity lives on
    // the master knob. Default 0 so a freshly spawned ATTENUMIX is silent
    // until the user dials in a channel.
    { id: 'att1',   label: 'Att1',   defaultValue: 0,   min: 0, max: 1, curve: 'linear' },
    { id: 'att2',   label: 'Att2',   defaultValue: 0,   min: 0, max: 1, curve: 'linear' },
    { id: 'att3',   label: 'Att3',   defaultValue: 0,   min: 0, max: 1, curve: 'linear' },
    { id: 'att4',   label: 'Att4',   defaultValue: 0,   min: 0, max: 1, curve: 'linear' },
    // Master defaults to 1.0 = unity gain. Range up to 2.0 so users can
    // push the sum into the tanh for warm saturation.
    { id: 'master', label: 'Master', defaultValue: 1.0, min: 0, max: 2, curve: 'linear' },
  ],

  // ── THE FACEPLATE (PF-20) ─────────────────────────────────────────────────
  //
  // WHAT THIS MODULE IS FOR. ATTENUMIX is the rack's SUM. Four things go in,
  // one comes out, and the only decision a player makes is how much of each.
  // The thing it does that VEILS (the same quad-VCA-plus-mix topology) does
  // NOT is refuse to boost at the channel: every attenuator caps at unity, so
  // the mix bus is the ONLY nonlinearity in the module and all the loudness
  // lives in one knob. The verb is *bring a channel up until you hear it in
  // the sum, then set the master where the tanh starts to bend.*
  //
  // THE RANKING, and it is measured rather than conventional. The four
  // attenuators are INTERCHANGEABLE — a priority order over four identical
  // controls carries no information — so they are ranked by LAYOUT, 1→4, which
  // is the bluebox answer: every tier's PREFIX is then a recognisable fragment
  // of the strip rather than an arbitrary pick. What IS a real ranking
  // decision is MASTER, and it goes LAST:
  //
  //   ⚠ AT THE SHIPPED DEFAULTS, MASTER IS BIT-EXACTLY INERT. Every attenuator
  //   defaults to 0, so the summing bus is fed zero and `tanh(0 · master)` is
  //   exactly 0.000000000 at master 0, 1 AND 2 — measured through the shipping
  //   worklet, and pinned permanently in attenumix-face-model.test.ts. An
  //   attenuator, by contrast, makes sound on its own the moment a cable is in
  //   its channel. That is why this face does NOT copy `mixer`'s ranking,
  //   which puts `master` first: mixer's channels default to 1.0 (open), so
  //   there the master is the live control and here it is the asleep one. The
  //   same rank on this module would put its only always-inert-at-spawn
  //   control at the top of every tier.
  //
  // TIER LADDER, as a sentence: *mini shows CH 1; the compact tile shows CH 1-3
  // (three cells, because this face carries no glyph — see below); the six-cell
  // lane plate shows the whole module, all four channels and the master; and
  // the dock adds the readout row, the band headers and the rear jack field.*
  //
  // PAGES: two, and here `order` and `pages` AGREE rather than disagree —
  // priority and signal flow are genuinely the same on a mixer (the channels
  // are upstream of the bus in both senses). Two bands of 4 + 1, no wide cells
  // (a `fader` cell is a 22px column, PARAM_CELL_WIDTH_CLASS), so PF-21 packs
  // them into ONE row and the face is nowhere near DOCK_TAB_MIN_BANDS.
  //
  // ⚠ NO GLYPH, AND THAT IS A MEASUREMENT, NOT A SHRUG. `glyphBinding` taps
  // `primaryAudioOutPortId`, which is "the FIRST declared `audio` output"
  // (shell-glyph-live.ts:95) — on this def that resolves `out1`, channel one's
  // DIRECT OUT, not the `mix` bus. A `meter` here would paint one of four
  // channels while claiming to show the module's output: the blind-metric trap
  // drawn on a faceplate. There is no per-face way to name the tapped port, so
  // the honest face carries none, and the compact tier gets its third cell
  // back for it (faceTierCap: 2 with a glyph, 3 without).
  //
  // NO title, NO hint, NO band hints, NO sidebar — the owner's standing ruling
  // for faces (plain labels and values; the explanation lives in `docs` for
  // right-click → annotate). No `momentary`: nothing here is a gesture. No
  // hero `control` (no attenuator outranks another, and promoting MASTER would
  // contradict the rank-5 argument above) and no hero `cell` (this module has
  // no picture worth a PF-14 panel in v1) — the hero is the READOUT ROW, which
  // heroFacePlan supports on its own.
  face: {
    order: ['att1', 'att2', 'att3', 'att4', 'master'],

    pages: [
      { id: 'channels', label: 'attenuators', controls: ['att1', 'att2', 'att3', 'att4'] },
      { id: 'bus', label: 'mix bus', controls: ['master'] },
    ],

    // The card draws five FADERS and the shell must not silently substitute
    // knobs — "a level is a THROW rather than a dial" is the declared reason
    // `fader` exists at all (ModuleFace.paramCells, owner directive
    // 2026-08-10, prompted by `noise`). All five are continuous, which is the
    // shape the lint requires for this primitive.
    paramCells: {
      att1: 'fader', att2: 'fader', att3: 'fader', att4: 'fader', master: 'fader',
    },


    // REAR CARD (rear-card-model). The derivation cannot group this field on
    // its own: `rearTargetParamId` resolves a per-param CV from `paramTarget`
    // or an `<x>_cv` id, and this module's CV ports are named `cv1..cv4` with
    // NO paramTarget (they are audio-rate WORKLET INPUTS, not AudioParam
    // shadows — see attenumix-cv-path.test.ts), so all eight inputs would fall
    // into one undifferentiated `signal` band. Two curated groups instead:
    // `signal` claims the LEADING slot for the four audio ins (a processor's
    // plain feed, the vca/cloudseed reading), and `channels` claims the page
    // slot of the same name for the four CV holes — which is exactly where the
    // derivation would have filed them if they carried a `paramTarget`, so the
    // rear band and the front band are the same group under two apt names (the
    // mixer precedent). A curated group id that is neither the leading slot nor
    // a declared page id appends as a STRAY band the totality gate cannot see,
    // and module-face-lint refuses it.
    //
    // ⚠ `audioRate` IS DECLARED HERE, where mixer deliberately declares none.
    // The `~` tick marks the SURPRISING case — a CV hole the DSP reads PER
    // SAMPLE — and on this module that is exactly true and exactly unusual:
    // `cv1..cv4` are worklet inputs summed into the attenuator sample by
    // sample (`packages/dsp/src/attenumix.ts`), with no smoothing, so an
    // audio-rate signal patched there is a ring modulator rather than a
    // control. The audio ins are left un-ticked (saying "audio-rate" about an
    // AUDIO input is noise on every hole — the mixer/vca precedent).
    rear: {
      groups: [
        {
          id: 'signal',
          label: 'channel inputs · in1→ch 1 … in4→ch 4',
          ports: ['in1', 'in2', 'in3', 'in4'],
        },
        {
          id: 'channels',
          label: 'attenuator cv · sums into the knob, clamped 0..1',
          ports: ['cv1', 'cv2', 'cv3', 'cv4'],
        },
      ],
      audioRate: ['cv1', 'cv2', 'cv3', 'cv4'],
    },
  },

  docs: {
    explanation:
      "The simple, no-surprises mixer: four channels, each with its own attenuator knob (0..1) and a CV input that sums into that knob, plus a per-channel direct out and one summed MIX output. Per channel out = in · clamp(knob + cv, 0, 1) — the attenuators only ATTENUATE, they never boost or invert (a negative knob+CV mutes, not phase-flips). The four channels sum and pass through a MASTER gain, then a tanh soft-clip: out = tanh(sum · master). Master goes up to ×2, so pushing past unity drives the sum into the tanh for warm saturation instead of a hard digital clip. Compared with VEILS (same quad-VCA-plus-mix topology) ATTENUMIX is the toggle-free 'just the mixer' version — the boost lives on the master, not per channel. There is a DSP worklet for the per-sample math. EACH CHANNEL TAKES AUDIO OR CV: the four channel inputs accept audio, CV, pitch and gate cables, and each per-channel DIRECT OUT emits the cable type of its own channel input — so an attenuated control voltage stays a control voltage on the way out and patches straight into a CV jack, with the attenuator actually scaling it. Patch the channel input FIRST: an empty channel has no signal to take its type from, so its direct out still reads as audio and a CV-only input will refuse it until something is feeding that channel. The MIX output is the exception and stays AUDIO whatever the channels carry: it sums four channels that may be different classes of signal and then soft-clips them through tanh, so the summed result is not a faithful voltage. Mix control voltages on the direct outs, not on the mix bus.",
    inputs: {
      in1: "Channel 1 signal input — audio, or a CV / pitch / gate cable. Scaled by clamp(Att1 + CV1, 0, 1) into both the channel-1 direct out and the summed mix.",
      in2: "Channel 2 signal input — audio or the CV family. Scaled by clamp(Att2 + CV2, 0, 1).",
      in3: "Channel 3 signal input — audio or the CV family. Scaled by clamp(Att3 + CV3, 0, 1).",
      in4: "Channel 4 signal input — audio or the CV family. Scaled by clamp(Att4 + CV4, 0, 1).",
      cv1: "CV that sums into the channel-1 attenuator (knob + CV, clamped 0..1). Passed through raw (no scaling), so a ±1 LFO at knob=0 already sweeps the channel full range — the negative half is rejected by the clamp, the positive half fully opens the channel.",
      cv2: "CV summed into the channel-2 attenuator (raw, knob + CV clamped 0..1).",
      cv3: "CV summed into the channel-3 attenuator (raw, knob + CV clamped 0..1).",
      cv4: "CV summed into the channel-4 attenuator (raw, knob + CV clamped 0..1).",
    },
    outputs: {
      out1: "Channel 1 direct out — the post-attenuator signal (in1 · att1) BEFORE the summing bus and master, for splitting a channel off on its own. Exactly linear and DC-coupled, and type-transparent: it emits the cable type patched into IN 1, so a CV in makes this a CV out that patches into any CV input. With nothing patched into IN 1 it falls back to audio and a CV-only input will refuse it — patch the channel first. This, not the mix bus, is the module's CV path.",
      out2: "Channel 2 direct out (in2 · att2), pre-mix. Emits the cable type patched into IN 2.",
      out3: "Channel 3 direct out (in3 · att3), pre-mix. Emits the cable type patched into IN 3.",
      out4: "Channel 4 direct out (in4 · att4), pre-mix. Emits the cable type patched into IN 4.",
      mix: "The summing bus: tanh((out1 + out2 + out3 + out4) · master). The four attenuated channels summed, scaled by the MASTER knob, then soft-clipped — driving master above 1 recruits the tanh for warm saturation. Always an AUDIO output, whatever the channels carry: it mixes four inputs that may be different classes of signal, and the tanh bends whatever comes out of it (even at unity a ±0.4 CV leaves as ±0.38), so it cannot honestly claim to be a control voltage. Sum control voltages on the direct outs instead.",
    },
    controls: {
      att1: "Channel 1 attenuator, linear 0..1 (default 0 = muted). Sets the channel's level; sums with CV1 and is clamped to 0..1, so it only ever cuts — there is no boost or polarity flip here.",
      att2: "Channel 2 attenuator, linear 0..1 (default 0 = muted). Sums with CV2, clamped 0..1.",
      att3: "Channel 3 attenuator, linear 0..1 (default 0 = muted). Sums with CV3, clamped 0..1.",
      att4: "Channel 4 attenuator, linear 0..1 (default 0 = muted). Sums with CV4, clamped 0..1.",
      master: "Output gain on the summed bus, linear 0..2 (default 1.0 = unity). Below 1 trims the whole mix down; above 1 boosts the sum INTO the tanh soft-clip for warm saturation rather than a hard clip. Applies only to the MIX output, not the per-channel direct outs.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const worklet = createWorkletNode(node, ctx, PROCESSOR_NAME, {
      numberOfInputs: 8,
      numberOfOutputs: 5,
      outputChannelCount: [1, 1, 1, 1, 1],
    });

    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of attenumixDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['in1', { node: worklet, input: 0 }],
        ['in2', { node: worklet, input: 1 }],
        ['in3', { node: worklet, input: 2 }],
        ['in4', { node: worklet, input: 3 }],
        ['cv1', { node: worklet, input: 4 }],
        ['cv2', { node: worklet, input: 5 }],
        ['cv3', { node: worklet, input: 6 }],
        ['cv4', { node: worklet, input: 7 }],
      ]),
      outputs: new Map([
        ['out1', { node: worklet, output: 0 }],
        ['out2', { node: worklet, output: 1 }],
        ['out3', { node: worklet, output: 2 }],
        ['out4', { node: worklet, output: 3 }],
        ['mix',  { node: worklet, output: 4 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { worklet.disconnect(); } catch { /* */ }
      },
    };
  },
};
