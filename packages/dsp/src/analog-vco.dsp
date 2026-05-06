declare name "Analog VCO";
declare description "Virtual-analog VCO. Saw, square, triangle, and sine outputs from a shared phase, anti-aliased via the Faust stdlib.";
declare author "inet.modular";

import("stdfaust.lib");

// ----- Knobs (smoothed to suppress zipper noise) -----
tune     = hslider("tune[style:knob][unit:semi]",   0,   -36,  36,   1)     : si.smoo;
fine     = hslider("fine[style:knob][unit:cent]",   0,   -100, 100,  1)     : si.smoo;
fmAmount = hslider("fmAmount[style:knob]",          0,   0,    1,    0.001) : si.smoo;
pw       = hslider("pw[style:knob]",                0.5, 0.05, 0.95, 0.001) : si.smoo;

// ----- Frequency: 1V/oct pitch CV + tune + fine + audio-rate FM -----
// pitch is an audio-rate CV input following D6 (1V/oct, 0.0 = C4 = 261.626 Hz).
freqHz(pitch, fm) =
  261.626 * pow(2.0, pitch + tune/12.0 + fine/1200.0 + fmAmount * fm)
  : max(1.0)
  : min(20000.0);

// ----- Process: 2 inputs (pitch, fm), 4 outputs (saw, sqr, tri, sin) -----
process(pitch, fm) = saw, sqr, tri, sn
with {
  f   = freqHz(pitch, fm);
  saw = os.sawtooth(f);
  sqr = os.pulsetrain(f, pw);   // PW-controllable square via pulsetrain
  tri = os.triangle(f);
  sn  = os.osc(f);
};
