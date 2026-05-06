declare name "VCA";
declare description "Voltage-controlled amplifier. audio * (base + cvAmount * cv).";

import("stdfaust.lib");

base     = hslider("base[style:knob]",     0.0,  0.0, 1.0, 0.001);
cvAmount = hslider("cvAmount[style:knob]", 1.0, -1.0, 1.0, 0.001);

process(audio, cv) = audio * gain
with {
  gain = base + cvAmount * cv : si.smoo;
};
