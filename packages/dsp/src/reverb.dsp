declare name "Reverb";
declare description "Algorithmic reverb (Faust stdlib mono freeverb).";

import("stdfaust.lib");

size = hslider("size[style:knob]", 0.5, 0.0, 1.0, 0.001);
damp = hslider("damp[style:knob]", 0.3, 0.0, 1.0, 0.001);
mix  = hslider("mix[style:knob]",  0.3, 0.0, 1.0, 0.001);

// re.mono_freeverb(fb1, fb2, damp, spread, x)
// fb1 = combfilter feedback (room size), fb2 = allpass feedback, damp = HF damping
process(audio) = audio * (1.0 - mixSm) + wet * mixSm
with {
  fb1 = (0.5 + 0.45 * size) : si.smoo;   // 0.50 .. 0.95
  fb2 = 0.5;                              // fixed allpass feedback
  d   = damp : si.smoo;
  mixSm = mix : si.smoo;
  wet = re.mono_freeverb(fb1, fb2, d, 0.5, audio);
};
