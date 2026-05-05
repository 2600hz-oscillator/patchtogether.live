declare name "Mixer";
declare description "Linear 4-input mixer with master gain.";

import("stdfaust.lib");

ch1Knob = hslider("ch1[style:knob]", 1.0, 0.0, 1.0, 0.001);
ch2Knob = hslider("ch2[style:knob]", 1.0, 0.0, 1.0, 0.001);
ch3Knob = hslider("ch3[style:knob]", 1.0, 0.0, 1.0, 0.001);
ch4Knob = hslider("ch4[style:knob]", 1.0, 0.0, 1.0, 0.001);
master  = hslider("master[style:knob]", 1.0, 0.0, 1.0, 0.001);

process(in1, in2, in3, in4) =
  (in1 * (ch1Knob : si.smoo)
 + in2 * (ch2Knob : si.smoo)
 + in3 * (ch3Knob : si.smoo)
 + in4 * (ch4Knob : si.smoo))
  * (master : si.smoo);
