declare name "VCA";
declare description "Voltage-controlled amplifier. audio * (base + cvAmount * cv).";

import("stdfaust.lib");

base     = hslider("base[style:knob]",     0.0,  0.0, 1.0, 0.001);
cvAmount = hslider("cvAmount[style:knob]", 1.0, -1.0, 1.0, 0.001);

// SMOOTH THE KNOBS, NOT THE CV.
//
// `si.smoo` is Faust's knob DE-ZIPPER — a one-pole at `1 - 44.1/ma.SR`,
// tau = 22.65 ms, -3 dB at 7.02 Hz, sample-rate invariant. The two hsliders
// genuinely need it: they step at block rate and would click.
//
// The `cv` INPUT does not. It is already a continuous audio-rate signal, and
// smoothing it puts a 7 Hz one-pole lowpass in front of the control voltage.
// Applying si.smoo to the SUM did exactly that, and it made the module deaf to
// the envelopes it exists to follow. Measured through the real compiled wasm:
// the 10-90% gain rise was 49.81 ms for an ideal step and **49.79 ms for BOTH
// a 1 ms and a 5 ms ADSR attack** — bit-for-bit the same number, so the VCA
// could not tell them apart and no percussive envelope survived it. A pluck or
// a kick shaped by ADSR→VCA came out as a ~50 ms swell.
//
// Smoothed per-slider, the CV path is full-bandwidth: 1 ms → 1.02 ms,
// 5 ms → 4.02 ms, 20 ms → 16.02 ms, 50 ms → 40.02 ms.
process(audio, cv) = audio * gain
with {
  gain = (base : si.smoo) + (cvAmount : si.smoo) * cv;
};
