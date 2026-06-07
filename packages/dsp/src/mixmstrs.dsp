declare name "MIXMSTRS";
declare description "6-channel stereo mixer with EQ, compressor, two stereo aux sends, two stereo returns. Multiple instances per rackspace.";

import("stdfaust.lib");

// ============== Per-channel knobs (6 channels × 9 = 54) + master = 55 ==============

// Channel volume (0..1, default 0.8)
ch1Vol  = hslider("ch1_volume[style:knob]", 0.8, 0.0, 1.0, 0.001) : si.smoo;
ch2Vol  = hslider("ch2_volume[style:knob]", 0.8, 0.0, 1.0, 0.001) : si.smoo;
ch3Vol  = hslider("ch3_volume[style:knob]", 0.8, 0.0, 1.0, 0.001) : si.smoo;
ch4Vol  = hslider("ch4_volume[style:knob]", 0.8, 0.0, 1.0, 0.001) : si.smoo;
ch5Vol  = hslider("ch5_volume[style:knob]", 0.8, 0.0, 1.0, 0.001) : si.smoo;
ch6Vol  = hslider("ch6_volume[style:knob]", 0.8, 0.0, 1.0, 0.001) : si.smoo;

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

// Send amounts (0..1, default 0): 6 channels × 2 sends = 12
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
channelChain(low, mid, high, thr, rat, en, vol, s1, s2, lIn, rIn) =
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
  s1L = finalL * s1;
  s1R = finalR * s1;
  s2L = finalL * s2;
  s2R = finalR * s2;
};

// ============== Top-level wiring ==============
// 16 audio inputs:
//   0,1   ch1 L/R
//   2,3   ch2 L/R
//   4,5   ch3 L/R
//   6,7   ch4 L/R
//   8,9   ch5 L/R
//  10,11  ch6 L/R
//  12,13  return1 L/R
//  14,15  return2 L/R
//
// 12 audio outputs:
//   0,1  master L/R
//   2,3  send1 L/R
//   4,5  send2 L/R
//   6    ch1 POST-FADER level tap (mono (L+R)/2, post EQ→comp→fader)
//   7    ch2 POST-FADER level tap
//   8    ch3 POST-FADER level tap
//   9    ch4 POST-FADER level tap
//  10    ch5 POST-FADER level tap
//  11    ch6 POST-FADER level tap
//
// The 6 trailing outputs are ACCURATE per-channel post-fader meter taps for the
// Electra MIXMASTER VU row + any on-card meter. They carry the channel's mixed-
// down signal AFTER EQ, compression, and the volume fader — so the VU reflects
// what the channel actually contributes to the master bus (the JS input-tap
// approximation this replaces ignored EQ/comp gain). The module factory taps
// these with AnalyserNodes and exposes the RMS as `read('levels') -> number[6]`;
// they are NOT patchable module ports. v1 is mono per channel; a future option
// is to emit stereo L/R taps (+12 outputs total) for an L/R-split VU.

process(c1l, c1r, c2l, c2r, c3l, c3r, c4l, c4r, c5l, c5r, c6l, c6r, r1l, r1r, r2l, r2r) =
  outL, outR, s1OutL, s1OutR, s2OutL, s2OutR,
  ch1Level, ch2Level, ch3Level, ch4Level, ch5Level, ch6Level
with {
  // Per-channel chains.
  ch1Out = channelChain(ch1Low, ch1Mid, ch1High, ch1Thr, ch1Rat, ch1En, ch1Vol, ch1S1, ch1S2, c1l, c1r);
  ch2Out = channelChain(ch2Low, ch2Mid, ch2High, ch2Thr, ch2Rat, ch2En, ch2Vol, ch2S1, ch2S2, c2l, c2r);
  ch3Out = channelChain(ch3Low, ch3Mid, ch3High, ch3Thr, ch3Rat, ch3En, ch3Vol, ch3S1, ch3S2, c3l, c3r);
  ch4Out = channelChain(ch4Low, ch4Mid, ch4High, ch4Thr, ch4Rat, ch4En, ch4Vol, ch4S1, ch4S2, c4l, c4r);
  ch5Out = channelChain(ch5Low, ch5Mid, ch5High, ch5Thr, ch5Rat, ch5En, ch5Vol, ch5S1, ch5S2, c5l, c5r);
  ch6Out = channelChain(ch6Low, ch6Mid, ch6High, ch6Thr, ch6Rat, ch6En, ch6Vol, ch6S1, ch6S2, c6l, c6r);

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

  masterL = (ch1ML + ch2ML + ch3ML + ch4ML + ch5ML + ch6ML + r1l + r2l) * masterVol;
  masterR = (ch1MR + ch2MR + ch3MR + ch4MR + ch5MR + ch6MR + r1r + r2r) * masterVol;

  s1OutL = ch1S1L + ch2S1L + ch3S1L + ch4S1L + ch5S1L + ch6S1L;
  s1OutR = ch1S1R + ch2S1R + ch3S1R + ch4S1R + ch5S1R + ch6S1R;
  s2OutL = ch1S2L + ch2S2L + ch3S2L + ch4S2L + ch5S2L + ch6S2L;
  s2OutR = ch1S2R + ch2S2R + ch3S2R + ch4S2R + ch5S2R + ch6S2R;

  outL = masterL;
  outR = masterR;

  // Per-channel POST-FADER level taps (mono (L+R)/2 of each channel's main
  // output — i.e. AFTER EQ → comp → volume fader, BEFORE master-bus summing /
  // master volume). The factory runs each through an AnalyserNode and reports
  // the RMS as read('levels'). Mixing L+R to mono here keeps the VU one value
  // per channel; a stereo VU would split these into 12 outputs (future option).
  ch1Level = (ch1ML + ch1MR) * 0.5;
  ch2Level = (ch2ML + ch2MR) * 0.5;
  ch3Level = (ch3ML + ch3MR) * 0.5;
  ch4Level = (ch4ML + ch4MR) * 0.5;
  ch5Level = (ch5ML + ch5MR) * 0.5;
  ch6Level = (ch6ML + ch6MR) * 0.5;
};
