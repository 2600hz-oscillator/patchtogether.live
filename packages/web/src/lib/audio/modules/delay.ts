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
  params: [
    // `label` is COSMETIC (excluded from contract-signature.ts), so renaming
    // 'Fb' → 'Feedback' does not move contract-lock.txt. The legacy
    // DelayCard.svelte hardcodes its own fader captions, so it is byte-
    // identical either way — this label is what the RACKLINE face, the rear
    // card and the doc page read, and 'Fb' was an unreadable abbreviation
    // there.
    { id: 'time',     label: 'Time',     defaultValue: 0.25, min: 0.001, max: MAX_DELAY_S,  curve: 'log',    units: 's' },
    { id: 'feedback', label: 'Feedback', defaultValue: 0.4,  min: 0,     max: MAX_FEEDBACK, curve: 'linear' },
    { id: 'mix',      label: 'Mix',      defaultValue: 0.35, min: 0,     max: 1,            curve: 'linear' },
  ],

  // RACKLINE FACE (workflow-mode `?shell=1`). A delay has exactly one
  // canonical control trio and every pedal, rack unit and eurorack module
  // ships it in the same order, because it is the order of decreasing
  // structural consequence: TIME sets the RHYTHM (what the echo plays
  // against), FEEDBACK sets HOW MANY repeats (slapback vs wash), MIX sets
  // HOW MUCH you hear. So rank 1 = time (the identity — the one knob you
  // ride to lock echoes to the groove), 2 = feedback, 3 = mix. All three
  // survive to the compact tile; nothing is ever dock-only here.
  //
  // PAGES group by SIGNAL STAGE rather than one-page-per-knob: the two
  // controls that shape the recirculating line belong together, and MIX is
  // the output stage (the shimmershine/cloudseed 'output blend' precedent).
  //
  // GLYPH 'meter' (not 'scope'): the shell's scope window is ~43 ms, which
  // is SHORTER than almost every useful echo spacing, so a trace would just
  // show "the audio" and be indistinguishable from the dry signal. The RMS
  // meter instead pulses once per repeat and visibly steps down as the tail
  // regenerates — a live read of "is the delay still ringing", which is the
  // actual question a player asks this module. Matches the FX house
  // precedent (cloudseed / shimmershine / vca).
  face: {
    order: ['time', 'feedback', 'mix'],
    pages: [
      { id: 'line',   label: 'delay line',   controls: ['time', 'feedback'] },
      { id: 'output', label: 'output blend', controls: ['mix'] },
    ],
    glyph: 'meter',
    // REAR CARD. Only three holes, so the work here is NAMING, not layout.
    // Derivation would file the audio jack under a generic 'signal' band;
    // label it 'mono in' instead, because the single mono jack is the one
    // thing about this module a user coming from COFEFVE / CHARLOTTE'S
    // ECHOS (both stereo-jacked) will get wrong — the rear card is where
    // that belongs. The TIME CV hole is derived into the 'delay line' page
    // band, which is already the logical grouping.
    //
    // audioRate: DelayNode.delayTime is an a-rate AudioParam and the CV
    // reaches it through a plain WaveShaper with no smoothing, so this jack
    // genuinely IS sampled per-sample — the `~` tick is true here (unlike
    // shimmershine, whose k-rate worklet params deliberately omit it).
    rear: {
      groups: [{ id: 'signal', label: 'mono in', ports: ['audio'] }],
      audioRate: ['time'],
    },
  },

  // docs-hash-ignore:start  -- docs prose is hash-transparent to the ART audio-profile source pin
  docs: {
    explanation:
      "The PRIMITIVE echo — one audio jack in, one out, three knobs, no colour of its own. Input → delay line → feedback loop → output, summed against the dry signal: audio comes back out TIME seconds later, FEEDBACK decides how many times it repeats before fading, MIX decides how much of it you hear. This is the topology every other delay is a decoration of, and it is the cheapest to run (a native Web Audio DelayNode and two gains — no worklet, no DSP thread). Reach for it when you want repeats and nothing else: slapback at 30–120 ms, rhythmic echoes at a quarter of a bar, ambient washes with FEEDBACK up. The one behaviour worth internalising is that the delay line reads at a FRACTIONAL position, so CHANGING TIME VARISPEEDS THE BUFFER — the echoes Doppler-shift in pitch while the time is moving, exactly like dragging a tape machine's capstan, and settle back to normal pitch once it stops. That is a feature: patch a slow LFO into the TIME CV jack at a few milliseconds of depth and you have a flanger/chorus; patch an envelope and the tail dives in pitch. It is also why a big TIME jump audibly swoops instead of cutting. This module deliberately has NO tempo sync, no clock input, no filtering or saturation in the loop, and no stereo — if you want a delay locked to the rack clock, or tape wow/flutter, drive, ping-pong and ducking, patch COFEFVE instead; for repeats that degrade and climb in pitch as they decay, CHARLOTTE'S ECHOS. FEEDBACK is hard-ceilinged at 0.95 and has no CV jack, so this module can never be driven into self-oscillation.",
    inputs: {
      audio:
        'The signal to be echoed. It fans out to both halves of the module at once: straight to the dry side of the output crossfade, and into the delay buffer whose output feeds the feedback loop. There is exactly ONE audio jack — this is a mono patch point, unlike the stereo-jacked COFEFVE and CHARLOTTE\'S ECHOS.',
      time:
        "CV that displaces the TIME knob. Linear scaling across the 1 ms–2 s span, so ±1 moves the delay by up to ±1.0 s around the knob and pins at the ends. Two things make this the module's expressive jack. First, it is genuinely AUDIO-RATE and unsmoothed: the CV reaches DelayNode.delayTime (an a-rate AudioParam) through a plain scaling curve with no de-zipping, so it tracks per-sample — the ~10 ms smoothing you feel when you turn the knob is applied only on the KNOB path and does NOT apply here. Second, because moving the read position varispeeds the line, modulating this jack PITCH-SHIFTS the echoes rather than crossfading them: a few milliseconds of LFO depth is a chorus/flanger, a slow deep envelope is a tape pitch-dive. One sharp edge: the scaling curve is baked when the cable is PATCHED, so it centres on the knob position at that moment — move the TIME knob a long way afterwards and the sweep's end-stops no longer line up with the 1 ms–2 s range.",
    },
    outputs: {
      audio:
        'The dry signal and the recirculating echoes summed. The blend is an EQUAL-POWER crossfade — dry × √(1−MIX) + wet × √MIX — so perceived loudness stays roughly constant all the way from full-dry to full-wet instead of sagging in the middle. Mono, like the input.',
    },
    controls: {
      time:
        "Delay time, log-scaled from 1 ms to 2 s — comb/flange territory at the bottom, slapback around 30–120 ms, rhythmic echoes and ambient tails at the top. The full range is genuinely reachable inside the feedback loop (measured: a 1 ms setting really does place its first echo 48 samples later at 48 kHz). Turning this knob ramps the delay over ~10 ms rather than jumping, so the line varispeeds smoothly and the tail swoops in pitch like a tape motor catching up — it does not click, and it does not crossfade. The TIME CV jack sums on top of wherever you leave it.",
      feedback:
        "How much of the delayed signal is returned to the input of the line, 0 to 0.95. At 0 you get exactly one echo; the 0.4 default gives about 8 audible repeats; at the 0.95 ceiling the tail takes roughly 135 repeats to fall below −60 dB, which reads as a very long wash that nevertheless always ends. The ceiling is a hard clamp deliberately set below 1.0 so the loop can never self-amplify, and — unlike every other delay in the catalogue — there is NO CV jack on this control, so nothing patchable can push it past the clamp. That makes the safety absolute, at the cost of not being able to perform feedback swells; use COFEFVE if you need feedback under CV.",
      mix:
        'Dry / wet balance, applied as an equal-power crossfade (dry gets √(1−MIX), wet gets √MIX) so the halfway point sounds full instead of scooped. 0 is the untouched input, 1 is echoes only. Around the 0.35 default it sits as an insert; put it at 1 when feeding the module from an aux send. Knob-only — there is no MIX CV jack.',
    },
  },
  // docs-hash-ignore:end

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
