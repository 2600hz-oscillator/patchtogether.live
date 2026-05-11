declare name "Analog VCO";
declare description "Virtual-analog VCO. Saw, square, triangle, and sine outputs from a shared phase, anti-aliased via the Faust stdlib.";
declare author "inet.modular";

import("stdfaust.lib");

// ----- Knobs (smoothed to suppress zipper noise) -----
tune     = hslider("tune[style:knob][unit:semi]",   0,   -36,  36,   1)     : si.smoo;
fine     = hslider("fine[style:knob][unit:cent]",   0,   -100, 100,  1)     : si.smoo;
fmAmount = hslider("fmAmount[style:knob]",          0,   0,    1,    0.001) : si.smoo;
pw       = hslider("pw[style:knob]",                0.5, 0.05, 0.95, 0.001) : si.smoo;
pmAmount = hslider("pmAmount[style:knob]",          0,   0,    1,    0.001) : si.smoo;

// ----- Frequency: 1V/oct pitch CV + tune + fine + audio-rate FM -----
// pitch is an audio-rate CV input following D6 (1V/oct, 0.0 = C4 = 261.626 Hz).
freqHz(pitch, fm) =
  261.626 * pow(2.0, pitch + tune/12.0 + fine/1200.0 + fmAmount * fm)
  : max(1.0)
  : min(20000.0);

// ----- Phase accumulator with PM offset -----
// Manual phase rather than stdlib oscillators so we can add an external phase
// modulation signal `pm` per-sample (±1 input × pmAmount = up to ±1 cycle).
// pmAmount stays unipolar to mirror fmAmount (DSP-bipolar lift tracked as #67).
// All four shape derivations share this phase so they remain phase-coherent.
phasor(f)     = (+(f / ma.SR) : ma.frac) ~ _;
phasorPm(f, pm) = ma.frac(phasor(f) + pmAmount * pm);

saw(p) = 2.0 * p - 1.0;
sqr(p) = select2(p < pw, 1.0, -1.0);
tri(p) = (4.0 * abs(p - 0.5)) - 1.0;
sn(p)  = sin(2.0 * ma.PI * p);

// ----- Process: 3 inputs (pitch, fm, pm), 4 outputs (saw, sqr, tri, sin) -----
process(pitch, fm, pm) = saw(p), sqr(p), tri(p), sn(p)
with {
  p = phasorPm(freqHz(pitch, fm), pm);
};
