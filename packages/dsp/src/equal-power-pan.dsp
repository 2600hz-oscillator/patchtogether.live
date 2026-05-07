declare name "EqualPowerPan";
declare description "Equal-power stereo pan. audio_in + pan_cv (-1..+1) -> (L, R) with -3dB center.";

import("stdfaust.lib");

panKnob = hslider("pan[style:knob]", 0.0, -1.0, 1.0, 0.001);

clamp(lo, hi, x) = x : max(lo) : min(hi);

process(audio, panCv) = audio * gainL, audio * gainR
with {
  p = clamp(-1.0, 1.0, panKnob + panCv) : si.smoo;
  theta = (p + 1.0) * (ma.PI / 4.0);
  gainL = cos(theta);
  gainR = sin(theta);
};
