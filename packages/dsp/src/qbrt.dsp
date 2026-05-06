declare name "QBRT";
declare description "Stereo state-variable filter, pingable. Multi-mode crossfade LP→BP→HP→Notch.";

import("stdfaust.lib");

cutoffKnob    = hslider("cutoff[style:knob][unit:Hz]", 1000.0, 20.0,  20000.0, 0.1)   : si.smoo;
resonanceKnob = hslider("resonance[style:knob]",       0.7,    0.0,   0.99,    0.001) : si.smoo;
modeKnob      = hslider("mode[style:knob]",            0.0,    0.0,   1.0,     0.001) : si.smoo;
// pingDecay — vactrol envelope decay time. Drives how long the filter
// "rings" after a ping pulse. Pew → short, peeeeew → long.
pingDecayKnob = hslider("pingDecay[style:knob][unit:s]", 0.15, 0.005, 0.5,     0.001) : si.smoo;

// Rising-edge detector on the ping input.
edge(x) = (x >= 0.5) & (x' < 0.5);

// Vactrol-style ping envelope. Modeled as a one-pole exponential decay
// triggered on the rising edge of the ping input. Decay time-constant
// is pingDecayKnob seconds — at SR=48k, coef = exp(-1/(decay*SR)).
//
// Used to (a) briefly boost Q so the filter rings sharply, and (b) gate
// a sub-millisecond click into the filter input as broadband excitation.
// Combined with high baseline Q this produces the classic "pew" laser tail.
qDecayCoef = exp(-1.0 / (max(0.005, pingDecayKnob) * ma.SR));
qPingEnv(p) = igen
letrec {
  'igen = ba.if(edge(p), 1.0, igen * qDecayCoef);
};

// Click excitation envelope: very fast decay (~1 ms at 48k) so the
// filter sees a single broadband impulse rather than a long DC offset.
clickEnv(p) = igen
letrec {
  'igen = ba.if(edge(p), 1.0, igen * 0.98);
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
//
// The ping path: when the ping input goes high, qPingEnv rises to 1.0 and
// decays exponentially over pingDecay seconds. Q is briefly boosted by up
// to +30 (well into the ringing range). Simultaneously a sub-millisecond
// click is added to the filter input — broadband excitation gives the
// resonant filter something to ring on, producing the laser-pew tail.
process(l, r, ping) = (svf(fcSm, qPing, mSm, l + click),
                       svf(fcSm, qPing, mSm, r + click))
with {
  fcSm  = cutoffKnob    : max(20.0) : min(20000.0);
  qBase = (resonanceKnob : max(0.0) : min(0.99)) * 20.0 + 0.7;
  ev    = qPingEnv(ping);
  qPing = qBase + ev * 30.0;
  mSm   = modeKnob      : max(0.0)  : min(1.0);
  click = clickEnv(ping) * 1.5;
};
