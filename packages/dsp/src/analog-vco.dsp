declare name "Analog VCO";
declare description "Virtual-analog VCO. Saw, square, triangle, and sine outputs from a shared phase, plus a continuous saw->sine->square morph output.";
declare author "inet.modular";

import("stdfaust.lib");

// ----- Knobs (smoothed to suppress zipper noise) -----
tune     = hslider("tune[style:knob][unit:semi]",   0,   -36,  36,   1)     : si.smoo;
fine     = hslider("fine[style:knob][unit:cent]",   0,   -100, 100,  1)     : si.smoo;
// fmAmount / pmAmount are bipolar: negative inverts the modulator (180° phase
// flip on the FM/PM signal). The freq + phase math below is naturally signed,
// so no compute change is needed — only the slider range is extended.
fmAmount = hslider("fmAmount[style:knob]",          0,   -1,   1,    0.001) : si.smoo;
pw       = hslider("pw[style:knob]",                0.5, 0.05, 0.95, 0.001) : si.smoo;
pmAmount = hslider("pmAmount[style:knob]",          0,   -1,   1,    0.001) : si.smoo;
// shape: continuous waveform morph for the `morph` output ONLY (the four
// fixed taps are unchanged). 0.0 = saw, 0.5 = sine, 1.0 = square. The morph
// crossfades a shared-phase saw → sine → square so a single knob (or CV)
// sweeps the classic three. Smoothed so a CV sweep is click-free.
shape    = hslider("shape[style:knob]",             0,   0,    1,    0.001) : si.smoo;

// ----- Frequency: 1V/oct pitch CV + tune + fine + audio-rate FM -----
// pitch is an audio-rate CV input following D6 (1V/oct, 0.0 = C4 = 261.626 Hz).
freqHz(pitch, fm) =
  261.626 * pow(2.0, pitch + tune/12.0 + fine/1200.0 + fmAmount * fm)
  : max(1.0)
  : min(20000.0);

// ----- Phase accumulator with PM offset -----
// Manual phase rather than stdlib oscillators so we can add an external phase
// modulation signal `pm` per-sample (±1 input × pmAmount = up to ±1 cycle;
// pmAmount is bipolar — negative shifts in the opposite direction).
// All four shape derivations share this phase so they remain phase-coherent.
phasor(f)     = (+(f / ma.SR) : ma.frac) ~ _;
phasorPm(f, pm) = ma.frac(phasor(f) + pmAmount * pm);

saw(p) = 2.0 * p - 1.0;
sqr(p) = select2(p < pw, 1.0, -1.0);
tri(p) = (4.0 * abs(p - 0.5)) - 1.0;
sn(p)  = sin(2.0 * ma.PI * p);
// 50%-duty square for the morph endpoint — kept independent of the `pw` knob
// so the morph's square end is the canonical ±1 square regardless of pulse
// width (pw still shapes the dedicated `square` tap).
sq50(p) = select2(p < 0.5, 1.0, -1.0);

// ----- Continuous saw->sine->square morph (the 5th output) -----
// Two-segment linear crossfade over a SHARED phase so the morph stays phase-
// coherent with the four fixed taps. shape in [0,0.5] blends saw->sine
// (mix = 2*shape); shape in [0.5,1] blends sine->square (mix = 2*shape-1).
// At shape==0 the morph output is exactly the saw tap (2p-1), so wiring the
// morph in place of saw with the knob at 0 reproduces the bare saw.
morph(p) =
  (sn(p) * lo + saw(p) * (1.0 - lo)) * (shape < 0.5) +
  (sq50(p) * hi + sn(p) * (1.0 - hi)) * (shape >= 0.5)
with {
  lo = 2.0 * shape;
  hi = 2.0 * shape - 1.0;
};

// ----- Process: 3 inputs (pitch, fm, pm), 5 outputs (saw, sqr, tri, sin, morph) -----
process(pitch, fm, pm) = saw(p), sqr(p), tri(p), sn(p), morph(p)
with {
  p = phasorPm(freqHz(pitch, fm), pm);
};
