// packages/web/src/lib/audio/modules/delay.ts
//
// DELAY — the PRIMITIVE single-tap echo: one audio jack in, one out, with
// time + feedback + mix. Pure-JS factory using Web Audio's built-in
// DelayNode + a feedback GainNode loop. No worklet, no Faust — the
// browser already has a low-latency delay primitive and the topology
// (input → delay → feedback → output, mixed with dry) is the canonical
// pattern every delay book describes the same way.
//
// VARISPEED, NOT CROSSFADE (measured, 2026-07-26). The DelayNode is a
// FRACTIONAL-READ line, so moving `time` resamples the buffer and Dopplers
// the content — it does not crossfade between read heads. Probe in headless
// Chromium: ramping delayTime by +0.5 s over 1 s drops a 1 kHz sine to
// ~498 Hz, i.e. 1000 × (1 − 0.5) — the exact varispeed prediction, nowhere
// near the 1000 Hz a crossfading line would hold. That is the flange /
// chorus / tape-warble mechanism, and the reason fast TIME sweeps bend
// pitch. (The docs used to claim a crossfade; they were wrong.)
//
// The same probe found NO render-quantum floor on the delay length even with
// the feedback cycle attached: a requested 1 ms delay produced its first echo
// at exactly 48 samples @ 48 kHz, identical to the cycle-free control graph.
// So the full 1 ms..2 s range really is reachable in the loop.
//
// Inspiration: shape-identical to VCV Rack's `dDelay` simple delay
// (BSD-3) and the Faust stdlib `de.delay` (MIT). No code lifted —
// the topology is generic enough that this is just "a delay".
//
// Knob curves chosen to match the typical eurorack delay (time log
// from 1 ms to 2 s; feedback linear 0..0.95 with hard ceiling; mix
// linear 0..1 dry-to-wet, applied as an equal-power crossfade).
//
// Why a separate module: DELAY is the clean, colourless, cheapest-to-
// instantiate echo — the one you patch when you want repeats and nothing
// else. COFEFVE is the full tape/BBD machine (tempo sync, wow/flutter,
// drive, ping-pong, ducking, CV on everything); CHARLOTTE'S ECHOS is the
// destructive multi-head shimmer. NOTE: WAVESCULPT's FX slot does NOT share
// this module — `makeDelayFx()` in wavesculpt.ts is an independent COPY of
// the topology with its own hardcoded constants (0.28 s / 0.45 feedback),
// so the two do not track each other. Nothing imports `delayDef` except
// DelayCard.svelte.
//
// Inputs:
//   audio (audio): dry signal feeding the delay line.
//   time (cv, linear, paramTarget=time): displaces the delay-time knob.
//
// Outputs:
//   audio (audio): dry + wet, balance set by mix.
//
// Params:
//   time (log 0.001..MAX_DELAY_S, default 0.25): delay time in seconds.
//   feedback (linear 0..MAX_FEEDBACK, default 0.4): feedback ratio (hard-ceilinged).
//   mix (linear 0..1, default 0.35): dry/wet balance (0 = dry, 1 = wet only).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import {
  formatDelayFeedback,
  formatDelayMix,
  formatDelayTime,
} from '$lib/audio/delay-echo-model';

/** Maximum delay time in seconds. AudioContext's DelayNode requires a
 *  fixed max at construction; we lock it at 2 s — covers everything
 *  from short slapback (~30 ms) to long ambient washes (~1.5 s) plus
 *  a small safety margin. */
const MAX_DELAY_S = 2;

/** Hard ceiling on feedback so a runaway patch can't blow speakers.
 *  At 0.95 the tail still decays in finite time — 0.95^n crosses -60 dB at
 *  n ≈ 135, so the ceiling buys a very long but always-terminating tail
 *  (at the 0.4 default it is ~8 repeats). Above 1.0 you get true
 *  self-oscillation that most users don't want and that destroys monitor
 *  cones. NOTE: `feedback` has NO CV input, which is what keeps this
 *  ceiling absolute — see the doc note on the missing feedback CV. */
const MAX_FEEDBACK = 0.95;

export const delayDef: AudioModuleDef = {
  type: 'delay',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'delay',
  category: 'effects',
  inputs: [
    { id: 'audio', type: 'audio' },
    { id: 'time',  type: 'cv', paramTarget: 'time', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'audio', type: 'audio' },
  ],
  // `label` is COSMETIC (excluded from contract-signature.ts), so renaming
  // 'Fb' → 'Feedback' does not move contract-lock.txt. This label is what the
  // RACKLINE face, the rear card, the doc page AND (since this PR) the legacy
  // card read — DelayCard.svelte used to hardcode its own caption 'Fb' beside a
  // def declaring 'Feedback', which is the same two-sided-contract divergence
  // the ranges were (see the card's header).
  //
  // `format` (PF-3) is UI VOCABULARY and contract-transparent — contract-
  // signature reads only id/min/max/curve/defaultValue/units, and a function is
  // unserializable by construction, so these three lines are a 0-line move in
  // contract-lock.txt. They are deliberately NOT hash-transparent:
  // `params:` bytes belong in the ART pin BY POLICY
  // (art/scenarios/pattern3-face-pin.test.ts: "params/inputs/outputs/factory
  // are deliberately NOT here"), so this PR takes the one-line `.sha` re-pin
  // rather than widening a hash exemption to cover a field the policy names.
  //
  // Every readout is bounded at 7 glyphs over its param's WHOLE range (the lane
  // knob column caps at 46 CSS px and does NOT ellipsize — lane-readout-fit.ts);
  // delay-echo-model.test.ts sweeps each range in PIXELS to prove it.
  params: [
    // `250 MS` / `1.20 S` — a log knob spanning two decades, where the raw
    // number is neither the unit a slapback is specified in nor the one an
    // ambient tail is.
    { id: 'time',     label: 'Time',     defaultValue: 0.25, min: 0.001, max: MAX_DELAY_S,  curve: 'log',    units: 's',
      format: formatDelayTime },
    // `8 REP` — the readout that earns its row. The ratio is a count in
    // disguise, and the count is the whole reason the knob exists; it also
    // makes the 0.95 clamp legible (`135 REP` = very long but FINITE, which a
    // self-oscillating delay would not show).
    { id: 'feedback', label: 'Feedback', defaultValue: 0.4,  min: 0,     max: MAX_FEEDBACK, curve: 'linear',
      format: formatDelayFeedback },
    // `DRY` / `35% WET` / `WET`. The ends are named because they change what
    // the module IS (a bypass, an aux-send return) and because `1.00` on an
    // equal-power crossfade does not read as "the dry signal is gone".
    { id: 'mix',      label: 'Mix',      defaultValue: 0.35, min: 0,     max: 1,            curve: 'linear',
      format: formatDelayMix },
  ],

  // PF-11. `face` is CURATION — ranking, band labels, the glyph choice, rear
  // grouping — and it reaches no audio code: this module's sound is the
  // `factory` below plus its params, and both stay inside the pin. Without
  // these markers a pure re-ranking moved `art/baselines/delay/audio.sha`, so
  // every face edit dragged an audio re-pin behind it and the `.sha` stopped
  // meaning "the audio changed". That is the owner's "docs must not change
  // attest hashes" directive applied to docs' UI-metadata sibling; it costs
  // ONE re-pin here, and face edits are free afterwards.
  // (`art/scenarios/delay/profile.test.ts` pins `docsStrippedRepoSourceSha` of
  // this file; pattern3-face-pin.test.ts fails any pinned def that grows an
  // unwrapped `face:` block.)
  //
  // ── RACKLINE FACE (workflow-mode `?shell=1`) ───────────────────────────────
  //
  // THE TIER LADDER FIRST, because it decides how much `order` is even worth
  // arguing about. THREE params and a glyph → mini 1 cell, compact 2 (the
  // glyph takes the third column: LANE_ROW_MAX_CELLS_WITH_GLYPH), full 3 on the
  // plate PLUS the glyph strip (3 cells = ceil(3/3) = ONE row, and
  // `laneBodyPlan` keeps the strip while the cells need only one row), dock 3.
  //
  // ⚠ That corrects this comment's previous claim that "all three survive to
  // the compact tile". They do not: the compact cap with a glyph is TWO, so
  // rank 3 is not on the lane tile until `full`. The claim was never checked
  // because no test read it; `delay-echo-model.test.ts` now derives the whole
  // ladder from `curatedFace`, so the next wrong sentence here fails a test.
  //
  // So `order` decides exactly two things: the mini tile's ONE cell, and which
  // knob is DROPPED from the compact tile. Both answers are `mix`-last, for a
  // reason that is delay-specific rather than a generic "most important first":
  //
  //   3 `mix` — the ONLY control on this module that exists elsewhere in the
  //     rack. Every module already has a fader in MIXMSTRS, and the standard
  //     way to run a delay is an aux send at mix = 1 with the send level AS the
  //     blend — so "how much wet" is reachable without this knob. "How long is
  //     the line" and "how many times does it come back" are reachable nowhere
  //     else in the patch. Replaceability, not importance, is what a tile with
  //     two cells should be spending them on.
  //
  //   1 `time` over 2 `feedback` — THE GLYPH BUYS THE RANK (the vca precedent,
  //     inverted). This face's own glyph argument, below, is that the RMS meter
  //     "pulses once per repeat and visibly steps down as the tail regenerates"
  //     — i.e. the thing the glyph is FOR is drawing the feedback decay. A mini
  //     tile that spends its single cell on the control the meter beside it
  //     already reports says one thing twice. `time` is what an RMS scalar
  //     structurally cannot report: a level has no time axis, so the pulse
  //     SPACING is only readable by watching several repeats, and the mini tier
  //     is a 46 px cell next to a 40 px bar — nobody is watching several
  //     repeats there.
  //
  //     The ranking survives disagreeing with that: if you read the meter as a
  //     glanceable LEVEL only (the honest reading of a small VU bar), then it
  //     reports `mix` rather than `feedback`, and `time` still wins rank 1 —
  //     because it is then the only control the meter reports nothing about.
  //     Two independent arguments, same order, which is why it is not re-ranked
  //     here despite the whole face being re-derived.
  //
  //     The independent half: `time` is the only param with a CV jack, the only
  //     one that is audio-rate, and the only one whose MOVEMENT is itself an
  //     audible event — the line is a fractional read, so turning it varispeeds
  //     the buffer and Dopplers the tail (measured, see the file header). It is
  //     the module's performance control; feedback and mix are settings.
  //
  // PAGES 2 → 1. The old split (`delay line` = time+feedback, `output blend` =
  // mix) spent a whole ~80 px band header on ONE knob, and `output blend` was a
  // house template copied verbatim across four defs — reverb, shimmershine and
  // cloudseed carry the same page, three of the four holding a single control,
  // which is the tell that it was inherited rather than decided. Collapsing is
  // NOT just budget: the three knobs are three knobs of one idea, and every
  // delay pedal ever built puts them in one row.
  //
  // What the split was implying is worth keeping, so the header states it
  // outright instead: time and feedback are INSIDE the recirculating loop and
  // mix is AFTER it. That is the module's one counter-intuitive behaviour (the
  // buffer keeps filling at mix = 0, so the tail is already there when you turn
  // it up), and a band called `output blend` never said it.
  //
  // `order` and `pages` MAY disagree — `order` is a PRIORITY ranking for the
  // tiers that show a subset, `pages` is FUNCTION order for the tier that shows
  // everything. Here they agree for two INDEPENDENT reasons (the ranking above,
  // and the signal path: in → line(time) → feedback → crossfade(mix)), so keep
  // them as two fields and do NOT reconcile one into the other.
  //
  // GLYPH 'meter' (not 'scope'): the shell's scope window is ~43 ms, which
  // is SHORTER than almost every useful echo spacing, so a trace would just
  // show "the audio" and be indistinguishable from the dry signal. The RMS
  // meter instead pulses once per repeat and visibly steps down as the tail
  // regenerates — a live read of "is the delay still ringing", which is the
  // actual question a player asks this module. Matches the FX house
  // precedent (cloudseed / shimmershine / vca).
  //
  // ⚠ AND IT IS WHY THIS FACE STAYS AT THREE RANKED CONTROLS. A fourth would
  // cross the plate to `ceil(4/3) = 2` rows, and `laneBodyPlan` drops the glyph
  // the moment the cells need both rows (`glyph = hasGlyph && rows <= 1`) — so
  // the in-lane glyph dies at `full`, permanently, for any 4th control.
  //
  // WHICH IS THE FIRST OF FOUR REASONS THE PLANNED `time_cv_amt` IS NOT HERE.
  // The face program (.myrobots/plans/…-design-program-2026-07-27.md §4.B, and
  // the round-2 spec) proposes a ±1 attenuverter on the TIME CV jack as rank 4.
  // Deliberately NOT taken, and the reasons are ordered worst-first:
  //
  //  1. IT DOES NOT EXIST YET AT THE PLATFORM LEVEL. The seam it needs (PF-12:
  //     an `attenuate` GainNode on the input descriptor, interposed between the
  //     cvScale chain and `din.param`) is not in the tree — `AudioDomainNode
  //     Handle.inputs` is `{node, input, param?}` and the CV→AudioParam branch
  //     connects the WaveShaper STRAIGHT to `din.param`. Verified, not assumed.
  //  2. THE ZERO-PLATFORM WORKAROUND IS BROKEN IN A WAY THAT IS EASY TO MISS.
  //     The obvious dodge — expose `param:` on a GainNode the module owns and
  //     feed its output through a depth gain — HIJACKS `inputs['time'].param`,
  //     which is also the AudioEngine's automation seam: `scheduleParam` and
  //     `holdParam` both reach a param through `handle.inputs.get(id)?.param`.
  //     Clip automation on TIME would then write delay-time SECONDS into a
  //     CV-delta gain. `holdParam` does not even consult a handle-supplied
  //     `scheduleParam` first, so a module-side override cannot cover it.
  //  3. THE PREMISE IS FALSIFIABLE. The justification offered is that this
  //     module's own docs advertise a dead feature ("a slow LFO into TIME CV at
  //     a few milliseconds of depth and you have a flanger"). It is not dead:
  //     depth on a CV cable is set at the SOURCE. LFO declares `depth` 0..1
  //     over a ±2 swing (LFO_DEPTH_GAIN = 2), so depth ≈ 0.0025 IS a ±5 ms
  //     sweep here, and SCALER (×0.1..×10, cv-accepting) trims a source with no
  //     depth of its own. (POLARIZER is NOT the answer — it re-centres a
  //     UNIPOLAR input, `(2·in − 1)·depth`, so it would offset a bipolar LFO.)
  //     What the attenuverter buys is ERGONOMICS on one jack, not a capability.
  //  4. AND IT COSTS THE GLYPH (above) plus an ART `.sha` + `.f32` re-pin,
  //     because the attenuator lives in `factory`, inside the audio pin.
  //
  // If PF-12 lands and the owner wants the trim anyway, the revert is additive:
  // one ParamDef, one `attenuate` GainNode in the factory, `order` grows a 4th
  // key — and the glyph loss is then a KNOWN price rather than a discovery.
  face: {
    order: ['time', 'feedback', 'mix'],
    pages: [
      { id: 'echo', label: 'one line, fed back · mix is outside the loop',
        controls: ['time', 'feedback', 'mix'] },
    ],
    glyph: 'meter',
    // REAR CARD. Only three holes, so the work here is NAMING, not layout.
    // Derivation would file the audio jack under a generic 'signal' band;
    // label it 'mono in' instead, because the single mono jack is the one
    // thing about this module a user coming from COFEFVE / CHARLOTTE'S
    // ECHOS (both stereo-jacked) will get wrong — the rear card is where
    // that belongs.
    //
    // THE PAGE COLLAPSE FORCES THE SECOND GROUP. `time` is a per-param CV, so
    // derivation files it under the band named after its param's PAGE — which
    // used to be `delay line` (a fine jack label) and would now be the
    // collapsed page's whole topology sentence, which heads a dock band and not
    // a rear one. Curating it re-heads that slot instead.
    //
    // ⚠ THE ID MUST BE THE PAGE ID, and the round-2 spec got this exactly
    // backwards — it proposed `id: 'mod'` *because* it "matches no page id, so
    // it appends after the page band". That append is precisely what
    // module-face-lint's stray-band gate REFUSES: a curated group must claim
    // the leading slot ('voice'/'signal') or name a real page, because an
    // appended band is invisible to the totality gate (which counts holes, not
    // their order). Naming the page is the SANCTIONED re-heading mechanism —
    // kickdrum's `sub`, tidyVco's `oscillator`, vca's `gain` — and it is NOT
    // the dx7 double-render bug: that fires only for the LEADING 'voice'/
    // 'signal' slot, which is pushed before the page loop and so gets claimed
    // twice. `signal` here holds `audio` and no page is called `signal`.
    //
    // Net: two bands + the output rail, three holes for three declared ports.
    //
    // audioRate: DelayNode.delayTime is an a-rate AudioParam and the CV
    // reaches it through a plain WaveShaper with no smoothing, so this jack
    // genuinely IS sampled per-sample — the `~` tick is true here (unlike
    // shimmershine, whose k-rate worklet params deliberately omit it).
    rear: {
      groups: [
        { id: 'signal', label: 'mono in', ports: ['audio'] },
        { id: 'echo', label: 'time cv · varispeeds the line', ports: ['time'] },
      ],
      audioRate: ['time'],
    },
  },

  docs: {
    explanation:
      "The PRIMITIVE echo — one audio jack in, one out, three knobs, no colour of its own. Input → delay line → feedback loop → output, summed against the dry signal: audio comes back out TIME seconds later, FEEDBACK decides how many times it repeats before fading, MIX decides how much of it you hear. This is the topology every other delay is a decoration of, and it is the cheapest to run (a native Web Audio DelayNode and two gains — no worklet, no DSP thread). Reach for it when you want repeats and nothing else: slapback at 30–120 ms, rhythmic echoes at a quarter of a bar, ambient washes with FEEDBACK up. The one behaviour worth internalising is that the delay line reads at a FRACTIONAL position, so CHANGING TIME VARISPEEDS THE BUFFER — the echoes Doppler-shift in pitch while the time is moving, exactly like dragging a tape machine's capstan, and settle back to normal pitch once it stops. That is a feature: patch a slow LFO into the TIME CV jack at a few milliseconds of depth and you have a flanger/chorus; patch an envelope and the tail dives in pitch. It is also why a big TIME jump audibly swoops instead of cutting. This module deliberately has NO tempo sync, no clock input, no filtering or saturation in the loop, and no stereo — if you want a delay locked to the rack clock, or tape wow/flutter, drive, ping-pong and ducking, patch COFEFVE instead; for repeats that degrade and climb in pitch as they decay, CHARLOTTE'S ECHOS. FEEDBACK is hard-ceilinged at 0.95 and has no CV jack, so this module can never be driven into self-oscillation.",
    inputs: {
      audio:
        'The signal to be echoed. It fans out to both halves of the module at once: straight to the dry side of the output crossfade, and into the delay buffer whose output feeds the feedback loop. There is exactly ONE audio jack — this is a mono patch point, unlike the stereo-jacked COFEFVE and CHARLOTTE\'S ECHOS.',
      time:
        "CV that displaces the TIME knob. Linear scaling across the 1 ms–2 s span, so ±1 moves the delay by up to ±1.0 s around the knob and pins at the ends. Two things make this the module's expressive jack. First, it is genuinely AUDIO-RATE and unsmoothed: the CV reaches DelayNode.delayTime (an a-rate AudioParam) through a plain scaling curve with no de-zipping, so it tracks per-sample — the ~10 ms smoothing you feel when you turn the knob is applied only on the KNOB path and does NOT apply here. Second, because moving the read position varispeeds the line, modulating this jack PITCH-SHIFTS the echoes rather than crossfading them: a slow LFO at a few thousandths of DEPTH is a chorus/flanger, a slow deep envelope is a tape pitch-dive. There is no attenuator on this jack, so the depth is set at the SOURCE: an LFO's own DEPTH reaches the chorus range directly (its 0–1 knob spans a ±2 swing, so about 0.0025 is a ±5 ms sweep here), and a SCALER inline (×0.1 to ×10) trims a source that has no depth knob of its own. A full-scale ±1 CV is a two-second peak-to-peak sweep — a special effect rather than a setting. One sharp edge: the scaling curve is baked when the cable is PATCHED, so it centres on the knob position at that moment — move the TIME knob a long way afterwards and the sweep's end-stops no longer line up with the 1 ms–2 s range.",
    },
    outputs: {
      audio:
        'The dry signal and the recirculating echoes summed. The blend is an EQUAL-POWER crossfade — dry × √(1−MIX) + wet × √MIX — so perceived loudness stays roughly constant all the way from full-dry to full-wet instead of sagging in the middle. Mono, like the input.',
    },
    controls: {
      time:
        "Delay time, log-scaled from 1 ms to 2 s — comb/flange territory at the bottom, slapback around 30–120 ms, rhythmic echoes and ambient tails at the top. The full range is genuinely reachable inside the feedback loop (measured: a 1 ms setting really does place its first echo 48 samples later at 48 kHz). Turning this knob ramps the delay over ~10 ms rather than jumping, so the line varispeeds smoothly and the tail swoops in pitch like a tape motor catching up — it does not click, and it does not crossfade. The TIME CV jack sums on top of wherever you leave it. The dial reads the delay in the unit you would specify it in, switching at one second: 250 MS at the default, 1.20 S up in ambient territory.",
      feedback:
        "How much of the delayed signal is returned to the input of the line, 0 to 0.95. The dial does not print that ratio — it prints what the ratio BUYS, the number of repeats before the tail falls below −60 dB: 1 REP at 0 (a single echo, nothing recirculates), 8 REP at the 0.4 default, 135 REP at the ceiling, which reads as a very long wash that nevertheless always ends. The ceiling is a hard clamp deliberately set below 1.0 so the loop can never self-amplify, and — unlike every other delay in the catalogue — there is NO CV jack on this control, so nothing patchable can push it past the clamp. That makes the safety absolute, at the cost of not being able to perform feedback swells; use COFEFVE if you need feedback under CV.",
      mix:
        'Dry / wet balance, applied as an equal-power crossfade (dry gets √(1−MIX), wet gets √MIX) so the halfway point sounds full instead of scooped. It is the only control here that is OUTSIDE the recirculating loop — the line keeps filling and feeding back at MIX 0, so the tail is already running when you turn it up. 0 is the untouched input, 1 is echoes only, and the dial names both ends (DRY / WET) and prints the wet share between them (35% WET at the default). Around 0.35 it sits as an insert; put it at 1 when feeding the module from an aux send. Knob-only — there is no MIX CV jack.',
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const inputGain = ctx.createGain();
    inputGain.gain.value = 1;

    // The dry/wet split. MUST use the SAME equal-power law setParam('mix')
    // and readParam('mix') use (√ of the blend), not a linear 1-mix / mix
    // split. It used to be linear here, which was a real bug with two
    // symptoms: (1) the very first touch of the MIX knob jumped the level
    // (at the 0.35 default, dry 0.650 → 0.806 and wet 0.350 → 0.592 with no
    // knob movement at all), and (2) readParam('mix') returns wet², which
    // only inverts the √ law — so before the first setParam it reported
    // 0.35² = 0.1225 instead of 0.35, and the motorised MIX fader read back
    // the wrong position. One law in all three places fixes both.
    const mix0 = Math.max(0, Math.min(1, node.params?.mix as number ?? 0.35));

    // Dry path — straight through, scaled by √(1 - mix).
    const dry = ctx.createGain();
    dry.gain.value = Math.sqrt(1 - mix0);
    inputGain.connect(dry);

    // Wet path — input → delay → feedback loop → wetGain → output.
    const delay = ctx.createDelay(MAX_DELAY_S);
    delay.delayTime.value = node.params?.time as number ?? 0.25;
    const feedback = ctx.createGain();
    feedback.gain.value = Math.min(MAX_FEEDBACK, node.params?.feedback as number ?? 0.4);
    const wet = ctx.createGain();
    wet.gain.value = Math.sqrt(mix0);

    // Wiring:
    //   inputGain → delay → wet → output
    //                  ↑      ↓
    //                  └─ feedback ──── delay (loop)
    inputGain.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(wet);

    const output = ctx.createGain();
    output.gain.value = 1;
    dry.connect(output);
    wet.connect(output);

    return {
      domain: 'audio',
      inputs: new Map([
        ['audio', { node: inputGain, input: 0 }],
        // Time CV → DelayNode.delayTime via the engine's CV→AudioParam path.
        ['time',  { node: delay,     input: 0, param: delay.delayTime }],
      ]),
      outputs: new Map([
        ['audio', { node: output, output: 0 }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'time') {
          // setTargetAtTime instead of setValueAtTime — instant jumps
          // produce a click at the loop point because the buffer head
          // jumps too. ~10 ms smoothing is below the perceptual jitter
          // floor for delay-time mod yet fast enough to feel
          // responsive when you turn the knob.
          delay.delayTime.setTargetAtTime(
            Math.max(0.001, Math.min(MAX_DELAY_S, value)),
            ctx.currentTime,
            0.01,
          );
        } else if (paramId === 'feedback') {
          feedback.gain.setTargetAtTime(
            Math.max(0, Math.min(MAX_FEEDBACK, value)),
            ctx.currentTime,
            0.01,
          );
        } else if (paramId === 'mix') {
          const m = Math.max(0, Math.min(1, value));
          // Equal-power-style crossfade — perceptual loudness stays
          // roughly constant from full-dry to full-wet. Square-root
          // gives a nice halfway-mix that doesn't sag.
          dry.gain.setTargetAtTime(Math.sqrt(1 - m), ctx.currentTime, 0.01);
          wet.gain.setTargetAtTime(Math.sqrt(m),     ctx.currentTime, 0.01);
        }
      },
      readParam(paramId) {
        if (paramId === 'time')     return delay.delayTime.value;
        if (paramId === 'feedback') return feedback.gain.value;
        if (paramId === 'mix')      return wet.gain.value * wet.gain.value;
        return undefined;
      },
      dispose() {
        try { inputGain.disconnect(); } catch { /* */ }
        try { dry.disconnect();       } catch { /* */ }
        try { delay.disconnect();     } catch { /* */ }
        try { feedback.disconnect();  } catch { /* */ }
        try { wet.disconnect();       } catch { /* */ }
        try { output.disconnect();    } catch { /* */ }
      },
    };
  },
};
