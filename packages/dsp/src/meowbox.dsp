declare name "MEOWBOX";
declare description "Gate-triggered cat-vocal synth voice. Three-formant bank + harmonic+noise excitation; morph crossfades 5 anchor presets (kitten, adult meow, purr, yowl, hiss).";

import("stdfaust.lib");

// V/oct pitch — 0 V = C4 (~261.6 Hz). Direct semitone equivalence.
pitchKnob = hslider("pitch[style:knob]",        0.0,  -36.0, 36.0, 0.001) : si.smoo;
morphKnob = hslider("morph[style:knob]",        0.25, 0.0,    1.0, 0.001) : si.smoo;
decayKnob = hslider("decay[style:knob][unit:s]", 0.4,  0.05,  2.0, 0.001) : si.smoo;
levelKnob = hslider("level[style:knob]",        1.0,  0.0,    2.0, 0.001) : si.smoo;

clamp(lo, hi, x) = x : max(lo) : min(hi);

// 5 anchor presets along the morph axis at 0.0, 0.25, 0.5, 0.75, 1.0.
//   0   — kitten meow:  F=(700, 1900, 3000), Q=(12,14,12), A=(1.0,0.85,0.5),
//                       voiced=0.85, riseAmt=25%, fallAmt=22%, decayScale=0.7
//   1   — adult meow:   F=(450, 1300, 2700), Q=(10,12,12), A=(1.0,0.7,0.4),
//                       voiced=0.85, riseAmt=15%, fallAmt=18%, decayScale=1.0
//   2   — purr:         F=(180,  350,  800), Q=( 6, 8, 8), A=(1.0,0.6,0.3),
//                       voiced=0.6, riseAmt=0, fallAmt=0,  decayScale=1.5
//   3   — yowl:         F=(380, 1100, 2400), Q=(14,16,14), A=(1.0,0.85,0.6),
//                       voiced=0.8, riseAmt=8,  fallAmt=14, decayScale=2.0
//   4   — hiss:         F=( 0,  4500, 8000), Q=( 0, 8, 8), A=(0.0,0.7,0.5),
//                       voiced=0.15, riseAmt=0, fallAmt=0,  decayScale=0.6

f1At(i) = ba.selectn(5, i, 700.0, 450.0, 180.0, 380.0, 100.0);
f2At(i) = ba.selectn(5, i, 1900.0, 1300.0, 350.0, 1100.0, 4500.0);
f3At(i) = ba.selectn(5, i, 3000.0, 2700.0, 800.0, 2400.0, 8000.0);
q1At(i) = ba.selectn(5, i, 12.0, 10.0, 6.0, 14.0, 0.5);
q2At(i) = ba.selectn(5, i, 14.0, 12.0, 8.0, 16.0, 8.0);
q3At(i) = ba.selectn(5, i, 12.0, 12.0, 8.0, 14.0, 8.0);
a1At(i) = ba.selectn(5, i, 1.0, 1.0, 1.0, 1.0, 0.0);
a2At(i) = ba.selectn(5, i, 0.85, 0.7, 0.6, 0.85, 0.7);
a3At(i) = ba.selectn(5, i, 0.5, 0.4, 0.3, 0.6, 0.5);
voicedAt(i)   = ba.selectn(5, i, 0.85, 0.85, 0.6, 0.8, 0.15);
riseAmtAt(i)  = ba.selectn(5, i, 0.25, 0.15, 0.0, 0.08, 0.0);
fallAmtAt(i)  = ba.selectn(5, i, 0.22, 0.18, 0.0, 0.14, 0.0);
decayScaleAt(i) = ba.selectn(5, i, 0.7, 1.0, 1.5, 2.0, 0.6);

// Crossfade between adjacent anchors.
mIdx(m) = clamp(0.0, 4.0, m * 4.0);
mSeg(m) = int(mIdx(m));
mSeg2(m) = min(4, mSeg(m) + 1);
mFrac(m) = mIdx(m) - int(mIdx(m));

xfade(getter, m) = getter(mSeg(m)) * (1.0 - mFrac(m)) + getter(mSeg2(m)) * mFrac(m);

f1Of(m)         = xfade(f1At, m);
f2Of(m)         = xfade(f2At, m);
f3Of(m)         = xfade(f3At, m);
q1Of(m)         = max(0.5, xfade(q1At, m));
q2Of(m)         = max(0.5, xfade(q2At, m));
q3Of(m)         = max(0.5, xfade(q3At, m));
a1Of(m)         = xfade(a1At, m);
a2Of(m)         = xfade(a2At, m);
a3Of(m)         = xfade(a3At, m);
voicedOf(m)     = xfade(voicedAt, m);
riseAmtOf(m)    = xfade(riseAmtAt, m);
fallAmtOf(m)    = xfade(fallAmtAt, m);
decayScaleOf(m) = xfade(decayScaleAt, m);

// Base frequency: pitchKnob is in semitones from C4.
baseFreq(p) = 261.6256 * pow(2.0, p / 12.0);

// Pitch contour: a fast rise + slow fall, tagged with morph-dependent
// rise/fall amounts. Returns semitone offset.
//   en.are: attack-release with sustain at 1 while gate held — so during the
//   rise window we get a +riseAmt octave bump, then it falls toward 0.
pitchEnvSemi(g, m) =
  en.are(0.03, 0.08, g) * riseAmtOf(m) * 12.0
  - en.adsr(0.0, 0.25, 0.0, decayKnob * decayScaleOf(m), g) * fallAmtOf(m) * 12.0;

freqHz(p, g, m) = baseFreq(p) * pow(2.0, pitchEnvSemi(g, m) / 12.0);

// Excitation: a small harmonic stack (F + 2F + 3F + 4F at decreasing amplitudes)
// representing voiced cat phonation, blended with white noise for hiss/breath.
voicedExc(p, g, m) =
  os.osc(freqHz(p, g, m)) * 1.0
  + os.osc(freqHz(p, g, m) * 2.0) * 0.5
  + os.osc(freqHz(p, g, m) * 3.0) * 0.25
  + os.osc(freqHz(p, g, m) * 4.0) * 0.125;

// Tremolo for purr — adds a 15 Hz amplitude wobble. Strength scales with
// voicedOf(m) so non-purr presets aren't affected (their voiced is high
// enough that tremolo on purrs is the relevant case; hiss has voiced ~0.15
// so tremolo has minimal effect anyway).
tremolo(m) = 1.0 - 0.4 * (1.0 - voicedOf(m)) + 0.4 * (1.0 - voicedOf(m)) * os.osc(15.0);

excit(p, g, m) =
  voicedExc(p, g, m) * voicedOf(m) * tremolo(m)
  + no.noise * (1.0 - voicedOf(m));

// Three parallel resonant bandpass formants.
formants(x, m) =
  fi.resonbp(f1Of(m), q1Of(m), 1.0, x) * a1Of(m)
  + fi.resonbp(f2Of(m), q2Of(m), 1.0, x) * a2Of(m)
  + fi.resonbp(f3Of(m), q3Of(m), 1.0, x) * a3Of(m);

// Amplitude envelope. Decay scales by morph (purr decays slowly, hiss fast).
ampEnv(g, m) = en.adsr(0.005, 0.05, 0.4, decayKnob * decayScaleOf(m), g);

// Stereo decorrelation: the right channel is delayed by up to 1 ms,
// gated by the inverse of ampEnv so the spread grows during the tail.
maxDelay = 0.001 * ma.SR;
stereoSpread(g, m) = (1.0 - ampEnv(g, m)) * 0.6;

leftCh(p, g, m)  = formants(excit(p, g, m), m) * ampEnv(g, m) * levelKnob;
rightCh(p, g, m) = de.fdelay(maxDelay, stereoSpread(g, m) * maxDelay, leftCh(p, g, m));

process(gate) =
  leftCh(pitchKnob, gate, morphKnob),
  rightCh(pitchKnob, gate, morphKnob);
