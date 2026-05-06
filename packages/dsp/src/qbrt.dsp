declare name "QBRT";
declare description "Stereo state-variable filter, pingable. Multi-mode crossfade LP→BP→HP→Notch.";

import("stdfaust.lib");

cutoffKnob    = hslider("cutoff[style:knob][unit:Hz]", 1000.0, 20.0, 20000.0, 0.1)  : si.smoo;
resonanceKnob = hslider("resonance[style:knob]",       0.7,    0.0,  0.99,    0.001) : si.smoo;
modeKnob      = hslider("mode[style:knob]",            0.0,    0.0,  1.0,     0.001) : si.smoo;

// Rising-edge detector on the ping input, then a short decaying impulse.
edge(x) = (x >= 0.5) & (x' < 0.5);
impulse(p) = igen
letrec {
  'igen = ba.if(edge(p), 1.0, igen * 0.9985);
};

// Stereo SVF: process L and R through identical resonant filter banks,
// crossfading 4 modes (LP / BP / HP / Notch) by a continuous `mode` value.
svf(fcSm, qSm, mSm, x) =
  out
with {
  lp = fi.resonlp(fcSm, qSm, 1.0, x);
  bp = fi.resonbp(fcSm, qSm, 1.0, x);
  hp = fi.resonhp(fcSm, qSm, 1.0, x);
  // Notch ≈ input − bandpass (classic SVF identity).
  notch = x - bp;
  m3 = mSm * 3.0;
  seg = int(min(2.0, m3));
  t   = m3 - seg;
  out = ba.selectn(3, seg,
                   lp * (1.0 - t) + bp * t,
                   bp * (1.0 - t) + hp * t,
                   hp * (1.0 - t) + notch * t);
};

// CV is routed directly to the underlying AudioParams via paramTarget; the
// hslider AudioParam sums knob + connected CV at audio rate.
process(l, r, ping) = (svf(fcSm, qSm, mSm, l + i),
                       svf(fcSm, qSm, mSm, r + i))
with {
  fcSm = cutoffKnob    : max(20.0) : min(20000.0);
  qSm  = (resonanceKnob : max(0.0) : min(0.99)) * 20.0 + 0.7;
  mSm  = modeKnob      : max(0.0)  : min(1.0);
  i    = impulse(ping) * 0.5;
};
