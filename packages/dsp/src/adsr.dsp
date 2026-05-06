declare name "ADSR";
declare description "Four-stage envelope generator. Triggered by gate input.";

import("stdfaust.lib");

attack  = hslider("attack[style:knob][unit:s]",  0.005, 0.001, 10.0, 0.001);
decay   = hslider("decay[style:knob][unit:s]",   0.1,   0.001, 10.0, 0.001);
sustain = hslider("sustain[style:knob]",         0.7,   0.0,   1.0,  0.001);
release = hslider("release[style:knob][unit:s]", 0.3,   0.001, 10.0, 0.001);

// Faust stdlib provides en.adsr(attack, decay, sustain, release, gate)
// Output is unipolar 0..1 envelope.
process(gate) = en.adsr(attack, decay, sustain, release, gate);
