declare name "MIXMSTRS";
declare description "4-channel stereo mixer with EQ, compressor, two stereo aux sends, two stereo returns. Singleton per rackspace.";

import("stdfaust.lib");

// ============== Per-channel knobs (4 channels × 9 = 36) + master = 37 ==============

// Channel volume (0..1, default 0.8)
ch1Vol  = hslider("ch1_volume[style:knob]", 0.8, 0.0, 1.0, 0.001) : si.smoo;
ch2Vol  = hslider("ch2_volume[style:knob]", 0.8, 0.0, 1.0, 0.001) : si.smoo;
ch3Vol  = hslider("ch3_volume[style:knob]", 0.8, 0.0, 1.0, 0.001) : si.smoo;
ch4Vol  = hslider("ch4_volume[style:knob]", 0.8, 0.0, 1.0, 0.001) : si.smoo;

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

// Send amounts (0..1, default 0): 4 channels × 2 sends = 8
ch1S1   = hslider("ch1_send1[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;
ch1S2   = hslider("ch1_send2[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;
ch2S1   = hslider("ch2_send1[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;
ch2S2   = hslider("ch2_send2[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;
ch3S1   = hslider("ch3_send1[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;
ch3S2   = hslider("ch3_send2[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;
ch4S1   = hslider("ch4_send1[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;
ch4S2   = hslider("ch4_send2[style:knob]", 0.0, 0.0, 1.0, 0.001) : si.smoo;

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
// 12 audio inputs:
//   0,1   ch1 L/R
//   2,3   ch2 L/R
//   4,5   ch3 L/R
//   6,7   ch4 L/R
//   8,9   return1 L/R
//  10,11  return2 L/R
//
// 6 audio outputs:
//   0,1  master L/R
//   2,3  send1 L/R
//   4,5  send2 L/R

process(c1l, c1r, c2l, c2r, c3l, c3r, c4l, c4r, r1l, r1r, r2l, r2r) =
  outL, outR, s1OutL, s1OutR, s2OutL, s2OutR
with {
  // Per-channel chains.
  ch1Out = channelChain(ch1Low, ch1Mid, ch1High, ch1Thr, ch1Rat, ch1En, ch1Vol, ch1S1, ch1S2, c1l, c1r);
  ch2Out = channelChain(ch2Low, ch2Mid, ch2High, ch2Thr, ch2Rat, ch2En, ch2Vol, ch2S1, ch2S2, c2l, c2r);
  ch3Out = channelChain(ch3Low, ch3Mid, ch3High, ch3Thr, ch3Rat, ch3En, ch3Vol, ch3S1, ch3S2, c3l, c3r);
  ch4Out = channelChain(ch4Low, ch4Mid, ch4High, ch4Thr, ch4Rat, ch4En, ch4Vol, ch4S1, ch4S2, c4l, c4r);

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

  masterL = (ch1ML + ch2ML + ch3ML + ch4ML + r1l + r2l) * masterVol;
  masterR = (ch1MR + ch2MR + ch3MR + ch4MR + r1r + r2r) * masterVol;

  s1OutL = ch1S1L + ch2S1L + ch3S1L + ch4S1L;
  s1OutR = ch1S1R + ch2S1R + ch3S1R + ch4S1R;
  s2OutL = ch1S2L + ch2S2L + ch3S2L + ch4S2L;
  s2OutR = ch1S2R + ch2S2R + ch3S2R + ch4S2R;

  outL = masterL;
  outR = masterR;
};
