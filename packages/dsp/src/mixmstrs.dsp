declare name "MIXMSTRS";
declare description "8-channel stereo mixer with EQ, compressor, two stereo aux sends, two stereo returns. Multiple instances per rackspace.";

import("stdfaust.lib");

// ============== Per-channel knobs (8 channels × 9 = 72) + master = 73 ==============

// Channel volume (0..1, default 0.8)
ch1Vol  = hslider("ch1_volume[style:knob]", 0.8, 0.0, 1.0, 0.001) : si.smoo;
ch2Vol  = hslider("ch2_volume[style:knob]", 0.8, 0.0, 1.0, 0.001) : si.smoo;
ch3Vol  = hslider("ch3_volume[style:knob]", 0.8, 0.0, 1.0, 0.001) : si.smoo;
ch4Vol  = hslider("ch4_volume[style:knob]", 0.8, 0.0, 1.0, 0.001) : si.smoo;
ch5Vol  = hslider("ch5_volume[style:knob]", 0.8, 0.0, 1.0, 0.001) : si.smoo;
ch6Vol  = hslider("ch6_volume[style:knob]", 0.8, 0.0, 1.0, 0.001) : si.smoo;
ch7Vol  = hslider("ch7_volume[style:knob]", 0.8, 0.0, 1.0, 0.001) : si.smoo;
ch8Vol  = hslider("ch8_volume[style:knob]", 0.8, 0.0, 1.0, 0.001) : si.smoo;

// EQ low/mid/high (-12..+12 dB, default 0)
ch1Low  = hslider("ch1_low[style:knob][unit:dB]",  0.0, -12.0, 12.0, 0.01) : si.smoo;
ch1Mid  = hslider("ch1_mid[style:knob][unit:dB]",  0.0, -12.0, 12.0, 0.01) : si.smoo;
ch1High = hslider("ch1_high[style:knob][unit:dB]", 0.0, -12.0, 12.0, 0.01) : si.smoo;
ch2Low  = hslider("ch2_low[style:knob][unit:dB]",  0.0, -12.0, 12.0, 0.01) : si.smoo;
ch2Mid  = hslider("ch2_mid[style:knob][unit:dB]",  0.0, -12.0, 12.0, 0.01) : si.smoo;
ch2High = hslider("ch2_high[style:knob][unit:dB]", 0.0, -12.0, 12.0, 0.01) : si.smoo;
ch3Low  = hslider("ch3_low[style:knob][unit:dB]",  0.0, -12.0, 12.0, 0.01) : si.smoo;
ch3Mid  = hslider("ch3_mid[style:knob][unit:dB]",  0.0, -12.0, 12.0, 0.01) : si.smoo;
ch3High = hslider("ch3_high[style:knob][unit:dB]", 0.0, -12.0, 12.0, 0.01) : si.smoo;
ch4Low  = hslider("ch4_low[style:knob][unit:dB]",  0.0, -12.0, 12.0, 0.01) : si.smoo;
ch4Mid  = hslider("ch4_mid[style:knob][unit:dB]",  0.0, -12.0, 12.0, 0.01) : si.smoo;
ch4High = hslider("ch4_high[style:knob][unit:dB]", 0.0, -12.0, 12.0, 0.01) : si.smoo;
ch5Low  = hslider("ch5_low[style:knob][unit:dB]",  0.0, -12.0, 12.0, 0.01) : si.smoo;
ch5Mid  = hslider("ch5_mid[style:knob][unit:dB]",  0.0, -12.0, 12.0, 0.01) : si.smoo;
ch5High = hslider("ch5_high[style:knob][unit:dB]", 0.0, -12.0, 12.0, 0.01) : si.smoo;
ch6Low  = hslider("ch6_low[style:knob][unit:dB]",  0.0, -12.0, 12.0, 0.01) : si.smoo;
ch6Mid  = hslider("ch6_mid[style:knob][unit:dB]",  0.0, -12.0, 12.0, 0.01) : si.smoo;
ch6High = hslider("ch6_high[style:knob][unit:dB]", 0.0, -12.0, 12.0, 0.01) : si.smoo;
ch7Low  = hslider("ch7_low[style:knob][unit:dB]",  0.0, -12.0, 12.0, 0.01) : si.smoo;
ch7Mid  = hslider("ch7_mid[style:knob][unit:dB]",  0.0, -12.0, 12.0, 0.01) : si.smoo;
ch7High = hslider("ch7_high[style:knob][unit:dB]", 0.0, -12.0, 12.0, 0.01) : si.smoo;
ch8Low  = hslider("ch8_low[style:knob][unit:dB]",  0.0, -12.0, 12.0, 0.01) : si.smoo;
ch8Mid  = hslider("ch8_mid[style:knob][unit:dB]",  0.0, -12.0, 12.0, 0.01) : si.smoo;
ch8High = hslider("ch8_high[style:knob][unit:dB]", 0.0, -12.0, 12.0, 0.01) : si.smoo;

// Compressor: thresh -36..0 (default -12), ratio 1..10 (default 2),
// enable 0/1 (default 0 = bypass).
ch1Thr  = hslider("ch1_thresh[style:knob][unit:dB]", -12.0, -36.0, 0.0,  0.01) : si.smoo;
ch1Rat  = hslider("ch1_ratio[style:knob]",            2.0,   1.0,  10.0, 0.01) : si.smoo;
ch1En   = hslider("ch1_compEnable[style:knob]",       0.0,   0.0,  1.0,  0.01) : si.smoo;
ch2Thr  = hslider("ch2_thresh[style:knob][unit:dB]", -12.0, -36.0, 0.0,  0.01) : si.smoo;
ch2Rat  = hslider("ch2_ratio[style:knob]",            2.0,   1.0,  10.0, 0.01) : si.smoo;
ch2En   = hslider("ch2_compEnable[style:knob]",       0.0,   0.0,  1.0,  0.01) : si.smoo;
ch3Thr  = hslider("ch3_thresh[style:knob][unit:dB]", -12.0, -36.0, 0.0,  0.01) : si.smoo;
ch3Rat  = hslider("ch3_ratio[style:knob]",            2.0,   1.0,  10.0, 0.01) : si.smoo;
ch3En   = hslider("ch3_compEnable[style:knob]",       0.0,   0.0,  1.0,  0.01) : si.smoo;
ch4Thr  = hslider("ch4_thresh[style:knob][unit:dB]", -12.0, -36.0, 0.0,  0.01) : si.smoo;
ch4Rat  = hslider("ch4_ratio[style:knob]",            2.0,   1.0,  10.0, 0.01) : si.smoo;
ch4En   = hslider("ch4_compEnable[style:knob]",       0.0,   0.0,  1.0,  0.01) : si.smoo;
ch5Thr  = hslider("ch5_thresh[style:knob][unit:dB]", -12.0, -36.0, 0.0,  0.01) : si.smoo;
ch5Rat  = hslider("ch5_ratio[style:knob]",            2.0,   1.0,  10.0, 0.01) : si.smoo;
ch5En   = hslider("ch5_compEnable[style:knob]",       0.0,   0.0,  1.0,  0.01) : si.smoo;
ch6Thr  = hslider("ch6_thresh[style:knob][unit:dB]", -12.0, -36.0, 0.0,  0.01) : si.smoo;
ch6Rat  = hslider("ch6_ratio[style:knob]",            2.0,   1.0,  10.0, 0.01) : si.smoo;
ch6En   = hslider("ch6_compEnable[style:knob]",       0.0,   0.0,  1.0,  0.01) : si.smoo;
ch7Thr  = hslider("ch7_thresh[style:knob][unit:dB]", -12.0, -36.0, 0.0,  0.01) : si.smoo;
ch7Rat  = hslider("ch7_ratio[style:knob]",            2.0,   1.0,  10.0, 0.01) : si.smoo;
ch7En   = hslider("ch7_compEnable[style:knob]",       0.0,   0.0,  1.0,  0.01) : si.smoo;
ch8Thr  = hslider("ch8_thresh[style:knob][unit:dB]", -12.0, -36.0, 0.0,  0.01) : si.smoo;
ch8Rat  = hslider("ch8_ratio[style:knob]",            2.0,   1.0,  10.0, 0.01) : si.smoo;
ch8En   = hslider("ch8_compEnable[style:knob]",       0.0,   0.0,  1.0,  0.01) : si.smoo;

// ── PRE/POST-FADER select, one per SEND BUS (owner 2026-08-06) ─────────────
// 0 = POST-fader (the default, and byte-identical to the pre-feature DSP):
//     the send taps the channel AFTER the volume fader, so pulling a fader down
//     pulls its send down with it and a muted channel sends nothing.
// 1 = PRE-fader: the send taps AFTER EQ + compressor but BEFORE the fader, so
//     the send level is `channel signal × send amount` regardless of the fader.
//     That is what lets a RETURN keep carrying sound while the channel it sits
//     on is muted (the owner's requirement) — the classic aux behaviour for a
//     monitor feed, or a reverb that should ring on through a mute.
//
// PRE is deliberately POST-EQ/COMP rather than pre-everything: an engineer
// expects the send to carry the channel's TONE, and either tap point satisfies
// "still audible while muted". (A pre-EQ tap would be a THIRD mode, not a
// redefinition of this one.)
//
// ONE flag per BUS, not per channel-send: an aux bus is pre or post as a whole
// on real consoles, and 2 switches beat 16. `si.smoo` on the flag makes a
// toggle a short CROSSFADE between the two tap points instead of a step, so
// flipping it mid-performance cannot click.
send1Pre = hslider("send1Pre[style:knob]", 0.0, 0.0, 1.0, 1.0) : si.smoo;
send2Pre = hslider("send2Pre[style:knob]", 0.0, 0.0, 1.0, 1.0) : si.smoo;

// ── RETURN strips (owner 2026-08-06) ───────────────────────────────────────
// The aux RETURNS used to sum into the master at fixed UNITY with no control
// at all — which made pre-fader sends only half a feature: you could feed a
// muted channel's signal to an effect, but you had no way to set how loud the
// wet came back. Each return now gets its own strip: VOLUME + the same 3-band
// EQ the channels have.
//
// DEFAULTS ARE THE OLD BEHAVIOUR EXACTLY: volume 1.0 (unity, NOT the channels'
// 0.8 — anything else would quietly drop the return level in every patch that
// already exists) and all three EQ bands at 0 dB.
//
// Returns deliberately have NO send controls: routing a return back into the
// send that feeds it is an infinite feedback loop, and defaulting to a
// structure that can howl is not worth the flexibility.
ret1Vol  = hslider("ret1_volume[style:knob]", 1.0, 0.0, 1.0, 0.001) : si.smoo;
ret1Low  = hslider("ret1_low[style:knob][unit:dB]",  0.0, -12.0, 12.0, 0.01) : si.smoo;
ret1Mid  = hslider("ret1_mid[style:knob][unit:dB]",  0.0, -12.0, 12.0, 0.01) : si.smoo;
ret1High = hslider("ret1_high[style:knob][unit:dB]", 0.0, -12.0, 12.0, 0.01) : si.smoo;
ret2Vol  = hslider("ret2_volume[style:knob]", 1.0, 0.0, 1.0, 0.001) : si.smoo;
ret2Low  = hslider("ret2_low[style:knob][unit:dB]",  0.0, -12.0, 12.0, 0.01) : si.smoo;
ret2Mid  = hslider("ret2_mid[style:knob][unit:dB]",  0.0, -12.0, 12.0, 0.01) : si.smoo;
ret2High = hslider("ret2_high[style:knob][unit:dB]", 0.0, -12.0, 12.0, 0.01) : si.smoo;

// Send amounts (0..1, default 0): 8 channels × 2 sends = 16
ch1S1   = hslider("ch1_send1[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;
ch1S2   = hslider("ch1_send2[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;
ch2S1   = hslider("ch2_send1[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;
ch2S2   = hslider("ch2_send2[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;
ch3S1   = hslider("ch3_send1[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;
ch3S2   = hslider("ch3_send2[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;
ch4S1   = hslider("ch4_send1[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;
ch4S2   = hslider("ch4_send2[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;
ch5S1   = hslider("ch5_send1[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;
ch5S2   = hslider("ch5_send2[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;
ch6S1   = hslider("ch6_send1[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;
ch6S2   = hslider("ch6_send2[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;
ch7S1   = hslider("ch7_send1[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;
ch7S2   = hslider("ch7_send2[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;
ch8S1   = hslider("ch8_send1[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;
ch8S2   = hslider("ch8_send2[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;

// Master output volume (0..1, default 0.8)
masterVol = hslider("master_volume[style:knob]", 0.8, 0.0, 1.0, 0.001) : si.smoo;

// ============== EQ ==============
// 3-band: low shelf @ 100 Hz, peaking EQ @ 1 kHz, high shelf @ 8 kHz.
// Built from primitives because Faust's `fi.low_shelf` / `fi.peak_eq_cq`
// signatures vary across stdlib versions and we want a stable build.
//
// Each band is implemented as a parametric biquad approximation:
//   - low/high shelf via 1st-order `fi.lowpass1` / `fi.highpass1` whose
//     cut frequency is shifted, mixed with a unity-gain bypass weighted
//     by 10^(gain_dB/20) - 1.
//   - peak band via `fi.bandpass(N, lo, hi)` mixed back into the dry
//     signal with the gain factor.
shelfGain(dB) = pow(10.0, dB / 20.0) - 1.0;

lowShelf(gainDB, fc, x) = x + fi.lowpass(1, fc, x) * shelfGain(gainDB);
highShelf(gainDB, fc, x) = x + fi.highpass(1, fc, x) * shelfGain(gainDB);
peakBand(gainDB, fcLow, fcHigh, x) =
  x + fi.bandpass(2, fcLow, fcHigh, x) * shelfGain(gainDB);

eq3band(low, mid, high, x) =
  highShelf(high, 8000.0,
    peakBand(mid, 600.0, 1600.0,
      lowShelf(low, 100.0, x)));

// ============== Compressor ==============
// co.compressor_stereo signature: compressor_stereo(ratio, thresh, attack, release, l, r)
// Returns (lOut, rOut). Soft knee + auto makeup are baked in by Faust's lib.
// Bypass: select2(enable >= 0.5, dry, wet).
compStereo(ratio, thresh, en, l, r) =
  ba.if(en >= 0.5, lOut, l),
  ba.if(en >= 0.5, rOut, r)
with {
  cmp = co.compressor_stereo(ratio, thresh, 0.005, 0.1, l, r);
  lOut = ba.take(1, cmp);
  rOut = ba.take(2, cmp);
};

// ============== Per-channel processing ==============
// channel(low, mid, high, thr, rat, en, vol, l, r) → (lOut, rOut, send1Contrib_l, ...)
// Returns 6 audio: (mainL, mainR, s1L, s1R, s2L, s2R).
//
// `s1pre`/`s2pre` (0..1) pick each send's TAP POINT — see the send1Pre/send2Pre
// declarations above. They arrive already SMOOTHED, so the expression below is
// a crossfade, not a branch:
//
//     tapGain = pre + (1 - pre) * vol
//       pre = 0 ⇒ tapGain = vol  ⇒ s1L = cL * vol * s1 = finalL * s1   (POST)
//       pre = 1 ⇒ tapGain = 1    ⇒ s1L = cL * s1                       (PRE)
//
// At the default (pre = 0) that reduces ALGEBRAICALLY to the pre-feature
// expression, which is why the shipped audio and every ART baseline are
// unchanged — the default path is not merely equivalent, it is the same
// multiply.
channelChain(low, mid, high, thr, rat, en, vol, s1, s2, s1pre, s2pre, lIn, rIn) =
  mainL, mainR, s1L, s1R, s2L, s2R
with {
  // EQ → comp → vol.
  eqL = eq3band(low, mid, high, lIn);
  eqR = eq3band(low, mid, high, rIn);
  cIn = compStereo(rat, thr, en, eqL, eqR);
  cL = ba.take(1, cIn);
  cR = ba.take(2, cIn);
  finalL = cL * vol;
  finalR = cR * vol;
  mainL = finalL;
  mainR = finalR;
  // Crossfade from the POST-fader signal (finalL, already through the fader)
  // toward the PRE-fader one (cL, straight off the compressor).
  //
  // MEASURED, not assumed: at the default (pre = 0) this is ALGEBRAICALLY the
  // old `finalL * s1`, but it is NOT bit-exact — the send baselines move by
  // 1–2 ULP on ~35% of samples (max 2.98e-08, −139.5 dB below peak; spectrum,
  // peakDb and rmsDb all unchanged). That is IEEE multiply being commutative
  // but not associative, and it is NOT avoidable by rewriting the source: the
  // hand-associated form `(finalL + pre*(cL-finalL)) * s1` and the obvious
  // `cL * (pre + (1-pre)*vol)` compile to byte-identical output, because Faust
  // normalises the expression tree itself. (`ba.if(pre>=0.5, cL, finalL) * s1`
  // WOULD stay bit-exact by blocking the reassociation, but it makes the toggle
  // a hard switch that CLICKS mid-performance — a worse trade than a one-time
  // −139 dB re-pin.) masterL, by contrast, IS byte-identical: the return-strip
  // EQ bypass below keeps the master path untouched.
  s1L = (finalL + s1pre * (cL - finalL)) * s1;
  s1R = (finalR + s1pre * (cR - finalR)) * s1;
  s2L = (finalL + s2pre * (cL - finalL)) * s2;
  s2R = (finalR + s2pre * (cR - finalR)) * s2;
};

// ============== Return strip ==============
// EQ → volume. No compressor, no sends (see the ret1Vol declaration).
//
// BIT-EXACT AT DEFAULT: eq3band is three biquads, and a shelving/peaking biquad
// at 0 dB is only unity to within coefficient rounding — so running the return
// through it unconditionally would have changed the SHIPPED audio of every
// existing patch by a hair, moving ART baselines for a feature that is supposed
// to default to a no-op. The `ba.if` bypass (the same trick compStereo already
// uses for its enable) takes the DRY path when all three bands are exactly 0,
// which is what a smoothed 0.0 default stays at forever. Result: defaults are
// the literal old expression `r1l * 1.0`, and the EQ only enters the signal
// path once the user actually turns a band.
returnChain(low, mid, high, vol, lIn, rIn) = outL, outR
with {
  flat = (low == 0.0) & (mid == 0.0) & (high == 0.0);
  eqL = eq3band(low, mid, high, lIn);
  eqR = eq3band(low, mid, high, rIn);
  outL = ba.if(flat, lIn, eqL) * vol;
  outR = ba.if(flat, rIn, eqR) * vol;
};

// ============== Top-level wiring ==============
// 20 audio inputs:
//   0,1   ch1 L/R
//   2,3   ch2 L/R
//   4,5   ch3 L/R
//   6,7   ch4 L/R
//   8,9   ch5 L/R
//  10,11  ch6 L/R
//  12,13  ch7 L/R
//  14,15  ch8 L/R
//  16,17  return1 L/R
//  18,19  return2 L/R
//
// 22 audio outputs:
//   0,1    master L/R
//   2,3    send1 L/R
//   4,5    send2 L/R
//   6,7    ch1 POST-FADER tap L/R (post EQ→comp→fader)
//   8,9    ch2 POST-FADER tap L/R
//  10,11   ch3 POST-FADER tap L/R
//  12,13   ch4 POST-FADER tap L/R
//  14,15   ch5 POST-FADER tap L/R
//  16,17   ch6 POST-FADER tap L/R
//  18,19   ch7 POST-FADER tap L/R
//  20,21   ch8 POST-FADER tap L/R
//
// The 16 trailing outputs are ACCURATE per-channel post-fader taps: the
// channel's signal AFTER EQ, compression, and the volume fader — what the
// channel actually contributes to the master bus (the JS input-tap
// approximation this replaced ignored EQ/comp gain). They are NOT patchable
// module ports; the factory consumes them.
//
// ⚠ STEREO, AND THAT IS A CORRECTNESS FIX RATHER THAN A FEATURE. These were
// mono `(L+R)*0.5` — the "future option" this file has named since it was
// written — and that sum is MEASURABLY PHASE-BLIND: an anti-phase channel read
// rms 0.0000e+0 while masterL and masterR each carried 0.184216, byte-identical
// to the in-phase render. A meter that reads silence on a channel you can hear
// is wrong, and a RECORDING taken off that tap would be worse: it would capture
// the cancellation rather than the channel. Splitting them is what makes
// `recTap = POST FADER` deliverable at all, and it fixes the VU on the way.
//
// Two consumers, both in the factory: `read('levels')` RMSes each leg and
// combines them (so an anti-phase channel now reads its true level), and the
// clip recorder's POST FADER tap takes the pair as-is.

process(c1l, c1r, c2l, c2r, c3l, c3r, c4l, c4r, c5l, c5r, c6l, c6r, c7l, c7r, c8l, c8r, r1l, r1r, r2l, r2r) =
  outL, outR, s1OutL, s1OutR, s2OutL, s2OutR,
  ch1TapL, ch1TapR, ch2TapL, ch2TapR, ch3TapL, ch3TapR, ch4TapL, ch4TapR,
  ch5TapL, ch5TapR, ch6TapL, ch6TapR, ch7TapL, ch7TapR, ch8TapL, ch8TapR
with {
  // Per-channel chains.
  ch1Out = channelChain(ch1Low, ch1Mid, ch1High, ch1Thr, ch1Rat, ch1En, ch1Vol, ch1S1, ch1S2, send1Pre, send2Pre, c1l, c1r);
  ch2Out = channelChain(ch2Low, ch2Mid, ch2High, ch2Thr, ch2Rat, ch2En, ch2Vol, ch2S1, ch2S2, send1Pre, send2Pre, c2l, c2r);
  ch3Out = channelChain(ch3Low, ch3Mid, ch3High, ch3Thr, ch3Rat, ch3En, ch3Vol, ch3S1, ch3S2, send1Pre, send2Pre, c3l, c3r);
  ch4Out = channelChain(ch4Low, ch4Mid, ch4High, ch4Thr, ch4Rat, ch4En, ch4Vol, ch4S1, ch4S2, send1Pre, send2Pre, c4l, c4r);
  ch5Out = channelChain(ch5Low, ch5Mid, ch5High, ch5Thr, ch5Rat, ch5En, ch5Vol, ch5S1, ch5S2, send1Pre, send2Pre, c5l, c5r);
  ch6Out = channelChain(ch6Low, ch6Mid, ch6High, ch6Thr, ch6Rat, ch6En, ch6Vol, ch6S1, ch6S2, send1Pre, send2Pre, c6l, c6r);
  ch7Out = channelChain(ch7Low, ch7Mid, ch7High, ch7Thr, ch7Rat, ch7En, ch7Vol, ch7S1, ch7S2, send1Pre, send2Pre, c7l, c7r);
  ch8Out = channelChain(ch8Low, ch8Mid, ch8High, ch8Thr, ch8Rat, ch8En, ch8Vol, ch8S1, ch8S2, send1Pre, send2Pre, c8l, c8r);

  // Sum channels into master + sends. Returns get summed into master only.
  ch1ML = ba.take(1, ch1Out); ch1MR = ba.take(2, ch1Out);
  ch1S1L = ba.take(3, ch1Out); ch1S1R = ba.take(4, ch1Out);
  ch1S2L = ba.take(5, ch1Out); ch1S2R = ba.take(6, ch1Out);

  ch2ML = ba.take(1, ch2Out); ch2MR = ba.take(2, ch2Out);
  ch2S1L = ba.take(3, ch2Out); ch2S1R = ba.take(4, ch2Out);
  ch2S2L = ba.take(5, ch2Out); ch2S2R = ba.take(6, ch2Out);

  ch3ML = ba.take(1, ch3Out); ch3MR = ba.take(2, ch3Out);
  ch3S1L = ba.take(3, ch3Out); ch3S1R = ba.take(4, ch3Out);
  ch3S2L = ba.take(5, ch3Out); ch3S2R = ba.take(6, ch3Out);

  ch4ML = ba.take(1, ch4Out); ch4MR = ba.take(2, ch4Out);
  ch4S1L = ba.take(3, ch4Out); ch4S1R = ba.take(4, ch4Out);
  ch4S2L = ba.take(5, ch4Out); ch4S2R = ba.take(6, ch4Out);

  ch5ML = ba.take(1, ch5Out); ch5MR = ba.take(2, ch5Out);
  ch5S1L = ba.take(3, ch5Out); ch5S1R = ba.take(4, ch5Out);
  ch5S2L = ba.take(5, ch5Out); ch5S2R = ba.take(6, ch5Out);

  ch6ML = ba.take(1, ch6Out); ch6MR = ba.take(2, ch6Out);
  ch6S1L = ba.take(3, ch6Out); ch6S1R = ba.take(4, ch6Out);
  ch6S2L = ba.take(5, ch6Out); ch6S2R = ba.take(6, ch6Out);

  ch7ML = ba.take(1, ch7Out); ch7MR = ba.take(2, ch7Out);
  ch7S1L = ba.take(3, ch7Out); ch7S1R = ba.take(4, ch7Out);
  ch7S2L = ba.take(5, ch7Out); ch7S2R = ba.take(6, ch7Out);

  ch8ML = ba.take(1, ch8Out); ch8MR = ba.take(2, ch8Out);
  ch8S1L = ba.take(3, ch8Out); ch8S1R = ba.take(4, ch8Out);
  ch8S2L = ba.take(5, ch8Out); ch8S2R = ba.take(6, ch8Out);

  // Returns now run through their own strips before summing into the master.
  // At defaults these reduce to `r1l * 1.0` — the pre-feature expression.
  ret1Out = returnChain(ret1Low, ret1Mid, ret1High, ret1Vol, r1l, r1r);
  ret2Out = returnChain(ret2Low, ret2Mid, ret2High, ret2Vol, r2l, r2r);
  ret1OutL = ba.take(1, ret1Out); ret1OutR = ba.take(2, ret1Out);
  ret2OutL = ba.take(1, ret2Out); ret2OutR = ba.take(2, ret2Out);

  masterL = (ch1ML + ch2ML + ch3ML + ch4ML + ch5ML + ch6ML + ch7ML + ch8ML + ret1OutL + ret2OutL) * masterVol;
  masterR = (ch1MR + ch2MR + ch3MR + ch4MR + ch5MR + ch6MR + ch7MR + ch8MR + ret1OutR + ret2OutR) * masterVol;

  s1OutL = ch1S1L + ch2S1L + ch3S1L + ch4S1L + ch5S1L + ch6S1L + ch7S1L + ch8S1L;
  s1OutR = ch1S1R + ch2S1R + ch3S1R + ch4S1R + ch5S1R + ch6S1R + ch7S1R + ch8S1R;
  s2OutL = ch1S2L + ch2S2L + ch3S2L + ch4S2L + ch5S2L + ch6S2L + ch7S2L + ch8S2L;
  s2OutR = ch1S2R + ch2S2R + ch3S2R + ch4S2R + ch5S2R + ch6S2R + ch7S2R + ch8S2R;

  outL = masterL;
  outR = masterR;

  // Per-channel POST-FADER taps: each channel's main output AFTER
  // EQ → comp → volume fader, BEFORE master-bus summing and master volume.
  //
  // ⚠ THE PAIR IS PASSED THROUGH UNMIXED. Summing to mono here is what made the
  // old tap phase-blind (see the header): the factory needs both legs, both to
  // meter honestly and to record from.
  ch1TapL = ch1ML; ch1TapR = ch1MR;
  ch2TapL = ch2ML; ch2TapR = ch2MR;
  ch3TapL = ch3ML; ch3TapR = ch3MR;
  ch4TapL = ch4ML; ch4TapR = ch4MR;
  ch5TapL = ch5ML; ch5TapR = ch5MR;
  ch6TapL = ch6ML; ch6TapR = ch6MR;
  ch7TapL = ch7ML; ch7TapR = ch7MR;
  ch8TapL = ch8ML; ch8TapR = ch8MR;
};
