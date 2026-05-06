declare name "DRUMMERGIRL";
declare description "All-in-one drum voice. VCO+noise blend through ADSR. Shape morphs through 16 percussion presets.";

import("stdfaust.lib");

pitchKnob  = hslider("pitch[style:knob][unit:semi]", 0.0,  -36.0, 36.0,  0.001) : si.smoo;
toneKnob   = hslider("tone[style:knob]",             0.3,  0.0,    1.0,  0.001) : si.smoo;
shapeKnob  = hslider("shape[style:knob]",            0.3,  0.0,    1.0,  0.001) : si.smoo;
// Volume — direct gain on the output. >1.0 lets percussion poke above unity
// without needing an external VCA gain-stage. Clamped at 2.0 (200%).
volumeKnob = hslider("volume[style:knob]",           1.0,  0.0,    2.0,  0.001) : si.smoo;
// Decay — direct override of the shape preset's decay time. Shape still drives
// attack/sustain/release/sweep so each preset keeps its character; only the
// decay axis is user-controlled.
decayKnob  = hslider("decay[style:knob][unit:s]",    0.15, 0.001,  0.5,  0.001) : si.smoo;

// Helper: clamp + smooth.
clamp(lo, hi, x) = x : max(lo) : min(hi);

// 16 percussion presets along the shape axis. Each row is
//   (attack, decay, sustain, release, pitchSweepAmount).
// pitchSweepAmount maps how much the VCO frequency ramps from a high start
// down to its base over the attack window. 0 = no sweep (cymbals/hats),
// 1 = full octave sweep (kick/tom).

// Attack-decay-sustain-release values for shape index 0..15.
attackAt(i) = ba.selectn(16, i,
  0.0,   0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.005,
  0.005, 0.005, 0.005, 0.001, 0.001, 0.001, 0.001, 0.001);

decayAt(i) = ba.selectn(16, i,
  0.4,   0.25,  0.18,  0.15,  0.05,  0.07,  0.4,   0.25,
  0.2,   0.18,  0.12,  0.08,  0.05,  0.3,   0.45,  0.5);

sustainAt(i) = ba.selectn(16, i,
  0.0,   0.05,  0.08,  0.1,   0.0,   0.02,  0.0,   0.05,
  0.0,   0.0,   0.0,   0.5,   0.4,   0.0,   0.0,   0.0);

releaseAt(i) = ba.selectn(16, i,
  0.1,   0.1,   0.12,  0.1,   0.02,  0.05,  0.1,   0.12,
  0.15,  0.18,  0.15,  0.2,   0.18,  0.4,   0.5,   0.6);

sweepAt(i) = ba.selectn(16, i,
  1.0,   0.85,  0.6,   0.5,   0.0,   0.0,   0.0,   0.7,
  0.8,   0.6,   0.4,   0.0,   0.0,   0.0,   0.0,   0.0);

// Crossfade between preset[k] and preset[k+1].
shapeIdx(s) = clamp(0.0, 15.0, s * 15.0);
seg(s)      = int(shapeIdx(s));
seg2(s)     = min(15, seg(s) + 1);
frac(s)     = shapeIdx(s) - int(shapeIdx(s));

attackOf(s)  = attackAt(seg(s))  * (1.0 - frac(s)) + attackAt(seg2(s))  * frac(s);
decayOf(s)   = decayAt(seg(s))   * (1.0 - frac(s)) + decayAt(seg2(s))   * frac(s);
sustainOf(s) = sustainAt(seg(s)) * (1.0 - frac(s)) + sustainAt(seg2(s)) * frac(s);
releaseOf(s) = releaseAt(seg(s)) * (1.0 - frac(s)) + releaseAt(seg2(s)) * frac(s);
sweepOf(s)   = sweepAt(seg(s))   * (1.0 - frac(s)) + sweepAt(seg2(s))   * frac(s);

// Base frequency: pitch knob in semis from C2 (~65 Hz).
baseFreq = 65.406 * pow(2.0, pitchKnob / 12.0);

// Pitch envelope: scale a fast-decaying envelope by sweepOf, multiply VCO freq
// by 2^(sweep * env). en.are(attack, release, gate) is a simple AR.
pitchEnv(g) = en.are(0.001, max(0.005, attackOf(shapeKnob) + 0.01), g) * sweepOf(shapeKnob) * 4.0;

vco(g) = os.osc(baseFreq * pow(2.0, pitchEnv(g)));
noise = no.noise;

mixed(g) = vco(g) * toneKnob + noise * (1.0 - toneKnob);

env(g) = en.adsr(
  max(0.0,    attackOf(shapeKnob)),
  max(0.001,  decayKnob),
  clamp(0.0, 1.0, sustainOf(shapeKnob)),
  max(0.001,  releaseOf(shapeKnob)),
  g
);

process(gate) = mixed(gate) * env(gate) * volumeKnob;
