declare name "Filter";
declare description "Multi-mode resonant filter — LP / HP / BP via mode switch.";

import("stdfaust.lib");

cutoffKnob = hslider("cutoff[style:knob][unit:Hz]", 1000, 20, 20000, 0.1);
resKnob    = hslider("resonance[style:knob]",       0.1,  0.0,  0.99, 0.001);
modeKnob   = nentry("mode",                         0,    0,    2,    1);

process(audio, cutoffCv, resCv) = ba.selectn(3, int(modeKnob), lp, hp, bp)
with {
  // CV: ±1 = ±5 octaves around the knob position.
  fc = (cutoffKnob * pow(2.0, 5.0 * cutoffCv)) : max(20.0) : min(20000.0) : si.smoo;
  q  = (resKnob + resCv) : max(0.0) : min(0.99) : si.smoo;
  // Map [0, 0.99] resonance to a usable Q range for resonlp/hp/bp.
  Q  = q * 20.0 + 0.7;

  lp = fi.resonlp(fc, Q, 1.0, audio);
  hp = fi.resonhp(fc, Q, 1.0, audio);
  bp = fi.resonbp(fc, Q, 1.0, audio);
};
