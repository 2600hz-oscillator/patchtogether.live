declare name "Analog VCO";
declare description "Virtual-analog VCO. Saw, square, triangle, and sine outputs from a shared phase, plus a continuous saw->sine->square morph output. Hard-sync in/out for classic oscillator sync.";
declare author "inet.modular";

import("stdfaust.lib");

// ----- Knobs (smoothed to suppress zipper noise) -----
tune     = hslider("tune[style:knob][unit:semi]",   0,   -36,  36,   1)     : si.smoo;
fine     = hslider("fine[style:knob][unit:cent]",   0,   -100, 100,  1)     : si.smoo;
// fmAmount / pmAmount are bipolar: negative inverts the modulator (180° phase
// flip on the FM/PM signal). The freq + phase math below is naturally signed,
// so no compute change is needed — only the slider range is extended.
fmAmount = hslider("fmAmount[style:knob]",          0,   -1,   1,    0.001) : si.smoo;
pw       = hslider("pw[style:knob]",                0.5, 0.05, 0.95, 0.001) : si.smoo;
pmAmount = hslider("pmAmount[style:knob]",          0,   -1,   1,    0.001) : si.smoo;
// shape: continuous waveform morph for the `morph` output ONLY (the four
// fixed taps are unchanged). 0.0 = saw, 0.5 = sine, 1.0 = square. The morph
// crossfades a shared-phase saw → sine → square so a single knob (or CV)
// sweeps the classic three. Smoothed so a CV sweep is click-free.
shape    = hslider("shape[style:knob]",             0,   0,    1,    0.001) : si.smoo;

// ----- Frequency: 1V/oct pitch CV + tune + fine + audio-rate FM -----
// pitch is an audio-rate CV input following D6 (1V/oct, 0.0 = C4 = 261.626 Hz).
freqHz(pitch, fm) =
  261.626 * pow(2.0, pitch + tune/12.0 + fine/1200.0 + fmAmount * fm)
  : max(1.0)
  : min(20000.0);

// ----- Hard sync: detect a rising edge through 0 on the sync input -----
// A rising edge (prev sample <= 0, this sample > 0) on the external sync
// input forces a phase reset to 0 — the classic hard-sync behaviour: the
// slave restarts its cycle every time the master completes one, which is
// what produces the characteristic hard-sync timbre. With `sync` unpatched
// the input is silence (0.0 every sample), so `syncEdge` is 0 every sample
// and the phasor reduces EXACTLY to the un-synced accumulator below — the
// output is bit-identical to a VCO with no sync port (backward compat).
//   syncEdge = 1.0 on the sample where a rising zero-crossing occurs, else 0.
syncEdge(sync) = (sync > 0.0) & (sync' <= 0.0);

// ----- Phase accumulator with PM offset + hard-sync reset -----
// Manual phase rather than stdlib oscillators so we can add an external phase
// modulation signal `pm` per-sample (±1 input × pmAmount = up to ±1 cycle;
// pmAmount is bipolar — negative shifts in the opposite direction) AND apply a
// hard-sync reset. All four shape derivations share this phase so they remain
// phase-coherent.
//
// reset==0 (no sync edge): loop(prev) = frac(prev + f/SR) — IDENTICAL to the
//   original `phasor(f) = (+(f/ma.SR) : ma.frac) ~ _`.
// reset==1 (sync edge):    loop(prev) = 0 — phase snaps to the cycle start.
phasorReset(f, reset) = loop ~ _
with {
  loop(prev) = (1.0 - reset) * ma.frac(prev + f / ma.SR);
};
phasorPm(f, pm, reset) = ma.frac(phasorReset(f, reset) + pmAmount * pm);

saw(p) = 2.0 * p - 1.0;
sqr(p) = select2(p < pw, 1.0, -1.0);
tri(p) = (4.0 * abs(p - 0.5)) - 1.0;
sn(p)  = sin(2.0 * ma.PI * p);
// 50%-duty square for the morph endpoint — kept independent of the `pw` knob
// so the morph's square end is the canonical ±1 square regardless of pulse
// width (pw still shapes the dedicated `square` tap).
sq50(p) = select2(p < 0.5, 1.0, -1.0);

// ----- Continuous saw->sine->square morph (the 5th output) -----
// Two-segment linear crossfade over a SHARED phase so the morph stays phase-
// coherent with the four fixed taps. shape in [0,0.5] blends saw->sine
// (mix = 2*shape); shape in [0.5,1] blends sine->square (mix = 2*shape-1).
// At shape==0 the morph output is exactly the saw tap (2p-1), so wiring the
// morph in place of saw with the knob at 0 reproduces the bare saw.
morph(p) =
  (sn(p) * lo + saw(p) * (1.0 - lo)) * (shape < 0.5) +
  (sq50(p) * hi + sn(p) * (1.0 - hi)) * (shape >= 0.5)
with {
  lo = 2.0 * shape;
  hi = 2.0 * shape - 1.0;
};

// ----- sync_out: a one-sample rising-edge pulse per cycle boundary -----
// We emit a +1 pulse on the sample where the phase WRAPS (the un-PM'd phasor
// jumps DOWN past the 1.0 boundary back toward 0). Detecting the wrap on the
// raw phasor (pre-PM) keeps the pulse aligned to the oscillator's fundamental
// regardless of PM. A downstream slave's `sync_in` edge detector resets on
// this rising edge → master.sync_out → slave.sync_in gives hard sync.
//   pWrapped < pWrapped'  ⇒  the accumulator just wrapped 1.0 → 0 this sample.
syncPulse(pRaw) = (pRaw < pRaw') * 1.0;

// ----- Process: 4 inputs (pitch, fm, pm, sync), 6 outputs -----
//   outputs: saw, sqr, tri, sin, morph, sync_out
process(pitch, fm, pm, sync) =
  saw(p), sqr(p), tri(p), sn(p), morph(p), syncPulse(pRaw)
with {
  f    = freqHz(pitch, fm);
  reset = syncEdge(sync);
  pRaw = phasorReset(f, reset);
  p    = ma.frac(pRaw + pmAmount * pm);
};
