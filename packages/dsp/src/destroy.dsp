declare name "DESTROY";
declare description "Bitcrusher: sample-rate reduction (decimation) + bit-depth reduction, with wet/dry.";

import("stdfaust.lib");

decimateKnob = hslider("decimate[style:knob]", 1.0,  1.0, 64.0, 0.001) : si.smoo;
bitsKnob     = hslider("bits[style:knob]",     16.0, 1.0, 16.0, 0.001) : si.smoo;
wetKnob      = hslider("wet[style:knob]",      1.0,  0.0, 1.0,  0.001) : si.smoo;

// CV is routed directly to the underlying AudioParams via paramTarget — no
// separate audio-rate CV inputs needed at the DSP. The hslider becomes an
// AudioParam in the worklet and sums incoming CV with the knob position.
process(audio) = audio * (1.0 - wetKnob) + crushed * wetKnob
with {
  d   = decimateKnob : max(1.0)  : min(64.0);
  b   = bitsKnob     : max(1.0)  : min(16.0);

  // Sample-rate reduction: hold the input for `d` audio samples between
  // refreshes. ba.sAndH(trig, x) latches `x` on rising edges of `trig`.
  // Build a periodic trigger by counting samples mod d.
  counter = ba.period(int(d));
  trig    = counter == 0;
  decimated = ba.sAndH(trig, audio);

  // Bit-depth reduction: quantize to 2^b levels in [-1, 1].
  levels = pow(2.0, b - 1.0);
  quantized = floor(decimated * levels + 0.5) / levels;

  crushed = quantized;
};
