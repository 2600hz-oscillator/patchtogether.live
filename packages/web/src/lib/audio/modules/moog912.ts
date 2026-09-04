// packages/web/src/lib/audio/modules/moog912.ts
//
// MOOG 912 ENVELOPE FOLLOWER — a slice of the Moog System 55 / 35 clone
// initiative (.myrobots/MOOG/). The 912 is a passive ANALYSIS utility: it
// watches an incoming AUDIO signal's amplitude and turns it into a smooth
// control voltage (an "envelope") plus a GATE that goes high while the input
// is sounding. Patch a drum or vocal in and use the env to open a VCF/VCA, or
// the gate to fire an envelope generator from a live source.
//
// PASSIVE / PURE Web Audio — NO AudioWorklet, NO Faust DSP. The whole module
// is a tiny node graph:
//
//   audio in
//     → GainNode (SENSITIVITY: input gain into the follower)
//     → WaveShaperNode (full-wave rectifier, |x|)
//     → BiquadFilterNode('lowpass', cutoff from SMOOTHING) ── env out
//                                                          └→ WaveShaperNode
//                                                             (hard threshold,
//                                                              1 if >~0.1 else 0)
//                                                              ── gate out
//
// The rectifier WaveShaper maps x → |x| (turn the bipolar AC waveform into a
// unipolar magnitude); the lowpass smooths that magnitude into a slow envelope
// — more SMOOTHING = lower cutoff = slower, lazier envelope. The gate
// WaveShaper is a steep step on the env: ~0 below the threshold, ~1 above, so
// `gate` is a clean on/off control while the input plays.
//
// CV semantics: the single input is plain AUDIO being analysed (PASSTHROUGH —
// it's the signal under measurement, not a knob modulator, so no cvScale /
// paramTarget). The two outputs are CV-domain control signals (env = cv,
// gate = gate), NOT audio.
//
// Inputs:
//   audio (audio): the signal to follow.
//
// Outputs:
//   env  (cv):   the smoothed amplitude envelope (rectified + lowpassed).
//   gate (gate): high (~1) while the envelope is above the gate threshold,
//                low (~0) otherwise.
//
// Params:
//   sensitivity (linear 0..1, default 0.7): input gain into the follower
//     (how hard the signal hits the rectifier — louder => bigger env).
//   smoothing (linear 0..1, default 0.5): maps to the envelope lowpass cutoff
//     (1 Hz at 1.0 .. 50 Hz at 0.0). MORE smoothing = LOWER cutoff = SLOWER
//     env. (See SMOOTH_MIN_HZ / SMOOTH_MAX_HZ below.)
//
// Categorized under Ports → moogafakkin (the shared SYS55/SYS35 bucket, mirroring the
// CP3 / 921A / 992). Category 'modulation' because it produces CV/gate control.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

// SMOOTHING → lowpass cutoff (Hz). smoothing=1.0 (max smoothing) → the SLOWEST
// envelope (lowest cutoff); smoothing=0.0 (no smoothing) → the FASTEST (highest
// cutoff). Log-interpolated so the knob feels even across its range.
export const SMOOTH_MIN_HZ = 1; // most smoothing (smoothing = 1.0)
export const SMOOTH_MAX_HZ = 50; // least smoothing (smoothing = 0.0)

/** Map the 0..1 SMOOTHING knob to a lowpass cutoff in Hz (log scale).
 *  smoothing=1 → SMOOTH_MIN_HZ (slow); smoothing=0 → SMOOTH_MAX_HZ (fast).
 *
 *  ⚠ TOTAL BY CONSTRUCTION (#1914). The clamp used to be written as
 *  `smoothing < 0 ? 0 : smoothing > 1 ? 1 : smoothing`, and BOTH comparisons
 *  are false for NaN — so NaN fell through untouched, `Math.exp` of it is NaN,
 *  and that NaN reached `envFilter.frequency`, after which ENV and GATE were
 *  BOTH DEAD until something wrote a finite value. Out-of-range FINITE values
 *  clamped correctly the whole time; only NaN escaped, which is exactly why it
 *  survived the range tests.
 *
 *  A non-finite input is treated as the same out-of-domain case the lower clamp
 *  already handles (no smoothing), so every FINITE input maps exactly as
 *  before — this is behaviour-preserving, not a re-tuning. The real fix is at
 *  the write boundary in `setParam` below; this arm guarantees no other caller
 *  can reconstruct the dead state by a different route. */
export function smoothingToCutoffHz(smoothing: number): number {
  const s = !Number.isFinite(smoothing) ? 0 : smoothing < 0 ? 0 : smoothing > 1 ? 1 : smoothing;
  // t=0 at smoothing=1 (min Hz), t=1 at smoothing=0 (max Hz).
  const t = 1 - s;
  const lnMin = Math.log(SMOOTH_MIN_HZ);
  const lnMax = Math.log(SMOOTH_MAX_HZ);
  return Math.exp(lnMin + (lnMax - lnMin) * t);
}

// Gate fires once the smoothed envelope rises above this level.
//
// NOTE: this is deliberately NOT the canonical CV edge threshold
// (`GATE_HI = 0.5` in $lib/audio/gate-trigger). This is an ENVELOPE-FOLLOWER
// SENSITIVITY level — how loud the rectified+smoothed AUDIO envelope must get
// before this module's gate OUTPUT opens. 0.1 (≈ −20 dB of full-scale) keeps
// the follower sensitive to quiet material; raising it to 0.5 would only open
// the gate on near-clipping audio. So it is intentionally a different number
// from the 0/1 CV gate-detection threshold used everywhere else.
export const GATE_THRESHOLD = 0.1;

/** Full-wave rectifier curve: x → |x|. A WaveShaper maps its input domain
 *  [-1, 1] (sampled across `len` points) through this; |x| folds the negative
 *  half up, turning the bipolar waveform into a unipolar magnitude.
 *  Returned as `Float32Array<ArrayBuffer>` (the type `WaveShaperNode.curve`
 *  requires — the default `new Float32Array(len)` is `ArrayBufferLike`). */
export function buildRectifyCurve(len = 1024): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(len * 4));
  for (let i = 0; i < len; i++) {
    // Map sample index → input value in [-1, 1].
    const x = (i / (len - 1)) * 2 - 1;
    curve[i] = Math.abs(x);
  }
  return curve;
}

/** Hard-threshold gate curve: ~0 below `threshold`, ~1 at/above. The env is
 *  unipolar (0..~1), so we only need the upper half of the [-1,1] domain to be
 *  meaningful; negative inputs (never produced by the rectified env) map to 0.
 *  Returned as `Float32Array<ArrayBuffer>` for `WaveShaperNode.curve` (see
 *  buildRectifyCurve). */
export function buildGateCurve(threshold = GATE_THRESHOLD, len = 1024): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(len * 4));
  for (let i = 0; i < len; i++) {
    const x = (i / (len - 1)) * 2 - 1;
    curve[i] = x >= threshold ? 1 : 0;
  }
  return curve;
}

export const moog912Def: AudioModuleDef = {
  type: 'moog912',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  domain: 'audio',
  label: '912 envelope follower',
  category: 'modulation',

  inputs: [
    // The signal being analysed. Plain audio passthrough into the input gain;
    // PASSTHROUGH (it's the measured signal, not a knob modulator) → no
    // cvScale / paramTarget.
    { id: 'audio', type: 'audio' },
  ],
  outputs: [
    // The smoothed amplitude envelope (CV) + a gate while above threshold.
    { id: 'env', type: 'cv' },
    { id: 'gate', type: 'gate', edge: 'gate' },
  ],
  params: [
    { id: 'sensitivity', label: 'Sens',   defaultValue: 0.7, min: 0, max: 1, curve: 'linear' },
    { id: 'smoothing',   label: 'Smooth', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
  ],

  // ── THE FACE ────────────────────────────────────────────────────────────────
  //
  // ⚠ STOP 1 IS THE CLOSEST CALL IN THIS COHORT, AND IT IS WORKED EXPLICITLY
  // RATHER THAN WAVED THROUGH. The refuse rule fires when ALL of these hold:
  // ≤2 params · no control families · no `node.data` affordances · no derived
  // quantity worth a readout. moog912 has TWO params, no families and no
  // `node.data` — THREE OF FOUR. It survives on the fourth clause alone, and it
  // survives it decisively: the SMOOTH knob's real unit is invisible, and the
  // GATE's threshold in input dBFS is a number nothing on the module prints.
  // This is the moogCp3 precedent — the merit is the READOUT, not the ranking.
  // ⚠ IF THE READOUTS ARE CUT IN REVIEW THE ANSWER FLIPS TO "NO FACE ON MERIT".
  // It does not degrade to a thin face.
  //
  // WHAT IT IS FOR, MUSICALLY: it is the rack's only ANALYSIS module — it turns
  // "how loud is this right now" into a CV, plus an "is it playing" gate. The
  // verb is MAKING ONE SOUND PLAY ANOTHER: a drum loop opening a filter, a vocal
  // firing an envelope.
  //
  // THE RANKING ARGUMENT, FROM THE DSP:
  //
  //   sensitivity  rank 1 because it is THE ONLY CONTROL THAT CAN SILENCE AN
  //                OUTPUT. `GATE_THRESHOLD` is a bare constant that does NOT
  //                scale with SENS, so holding the gate open needs an input
  //                amplitude of π·0.1/(2·sens) — which exceeds FULL SCALE below
  //                sens = 0.157080. The bottom 15.71 % of a dial whose whole job
  //                is to open this output cannot open it, on any signal (#1914).
  //                ⚠ THIS ARGUMENT WOULD BE WRONG for a follower whose threshold
  //                scales with sensitivity, which is the usual design; it is
  //                defended by that constant being bare, and CONFIRMED on a real
  //                rendered graph (art/scenarios/moog912/face-audit.test.ts)
  //                rather than derived and hoped for.
  //   smoothing    rank 2: it shapes the contour and never gates it. Not inert —
  //                every position changes the ENV — just strictly less
  //                consequential.
  //
  // Tier ladder, in one line because there is no hierarchy to unfold: the glyph
  // must be 'none' (below), so the compact cap is LANE_ROW_MAX_CELLS = 3 and
  // BOTH controls fit from compact upward; the ladder only bites at mini, which
  // shows SENS.
  //
  // ⚠ NO `pages`, DELIBERATELY. Both knobs are the same idea — how the follower
  // listens — so the dock is single-page. A second page would cost a ~81 px band
  // on a dock that folds at 720p and would exist only to get a header, which the
  // skill refuses by name.
  face: {
    order: ['sensitivity', 'smoothing'],

    // ⚠ 'none' IS FORCED, NOT CHOSEN. This module\'s outputs are `env` (cv) and
    // `gate` (gate) — there is no `type: 'audio'` output at all — so
    // `primaryAudioOutPortId` returns NULL and 'meter', 'waveform', 'envelope'
    // and 'algorithm' ALL resolve to `{kind:'static'}`, the dead-glyph state
    // the lint refuses. ⚠ AND 'envelope' DOES NOT RESCUE IT despite this being
    // visibly an envelope module: that resolver keys on four params literally
    // named attack/decay/sustain/release, and this module has sensitivity and
    // smoothing. Same mechanism as #1888, of which this is the second witness
    // (moog911 was the first) — an arm with two modules it exists to serve and
    // cannot reach either.
    glyph: 'none',

    // THE HERO: the sensitivity dial, plus the two numbers that ARE this face's
    // reason to exist. Their reach is DISJOINT, so each is the other's control:
    //
    //   response  ← smoothing ONLY. The detector's cutoff in Hz. The dial is a
    //              bare 0..1 and the mapping is INVERTED and logarithmic —
    //              1 Hz at SMOOTH 1, 50 Hz at SMOOTH 0, a 5.64-octave span in
    //              which turning the knob UP makes the number go DOWN. At the
    //              shipped 0.5 it is 7.07 Hz.
    //   gate      ← sensitivity ONLY. How loud the input must be, in dBFS, to
    //              HOLD the gate open — and `—` when that exceeds full scale,
    //              which is the only place #1914's dead zone is visible.
    hero: {
      control: 'sensitivity',
    },
  },

  docs: {
    explanation:
      "A clean-room recreation of the Moog 912 Envelope Follower — a passive ANALYSIS utility that listens to an incoming audio signal's loudness and turns it into a smooth control voltage (an 'envelope') plus a gate that's high while the input is sounding. Internally the audio is full-wave rectified (|x|, turning the bipolar waveform into a magnitude) and lowpass-filtered into a slowly-varying level; a steep threshold on that level produces the gate. Patch a drum loop, vocal, or any live source in, and use ENV to open a VCA/filter that tracks the input's dynamics, or GATE to fire an envelope generator from an external sound. Mental model: 'how loud is this right now?' as a CV, plus a 'is it playing?' on/off gate. The two knobs trade off how hard the signal is measured (SENS) and how lazily the envelope reacts (SMOOTH).",
    inputs: {
      audio:
        "The signal to follow — the audio being measured (not a modulator). Its amplitude drives both the ENV and GATE outputs; louder material gives a bigger envelope. Patch a drum, vocal, or full mix here.",
    },
    outputs: {
      env:
        "The smoothed amplitude envelope as a control voltage: the rectified, lowpass-filtered loudness of the input. Patch it into a VCA's gain or a filter's cutoff to make them track how loud the source is.",
      gate:
        "Goes high (~1) while the followed envelope is above the detection threshold (the input is audibly playing) and low (~0) when it falls quiet — an auto-gate derived from the sound itself. Patch it into an envelope generator or VCA to trigger from a live source.",
    },
    controls: {
      sensitivity:
        "Input gain into the follower — how hard the incoming signal hits the detector. Higher SENS makes quiet material produce a bigger envelope (and opens the gate more readily); lower SENS only responds to loud peaks. ⚠ The GATE's detection level is a FIXED constant that does not scale with this knob, so SENS alone decides how loud the input must be to open it — and below about 0.157 nothing can: the level required passes full scale, so the bottom sixth of this dial cannot open the GATE output on any signal at all, however loud (#1914). The ENV output keeps working there; it is only the gate that goes unreachable. The faceplate prints the required input level in dBFS, and a dash once it becomes impossible.",
      smoothing:
        "How lazily the envelope reacts: more SMOOTH lowers the detector's lowpass cutoff so the CV glides slowly and ignores fast transients (a smooth contour); less SMOOTH speeds it up so the envelope snaps to each peak (a punchy, percussive follow). ⚠ The dial is a bare 0..1 but the thing it sets is a frequency, and the mapping is INVERTED and logarithmic: 50 Hz at 0, 1 Hz at 1 — a 5.6-octave span in which turning the knob UP makes the number go DOWN. The factory setting of 0.5 is 7.07 Hz, which neither the knob nor its label can tell you, so the faceplate prints it.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const initial = node.params ?? {};
    const valueOf = (id: string): number =>
      initial[id] ?? moog912Def.params.find((p) => p.id === id)!.defaultValue;

    const sensitivity = valueOf('sensitivity');
    const smoothing = valueOf('smoothing');

    // SENSITIVITY → input gain into the follower.
    const inputGain = ctx.createGain();
    inputGain.gain.value = sensitivity;

    // Full-wave rectifier: x → |x| (bipolar AC → unipolar magnitude).
    const rectifier = ctx.createWaveShaper();
    rectifier.curve = buildRectifyCurve();
    rectifier.oversample = '2x';

    // SMOOTHING → lowpass cutoff. The smoothed rectified magnitude IS the env.
    const envFilter = ctx.createBiquadFilter();
    envFilter.type = 'lowpass';
    envFilter.frequency.value = smoothingToCutoffHz(smoothing);
    // Gentle Q so the envelope settles without ringing/overshoot.
    envFilter.Q.value = 0.5;

    // Gate: a steep step on the env (~1 above threshold, ~0 below).
    const gateShaper = ctx.createWaveShaper();
    gateShaper.curve = buildGateCurve();
    gateShaper.oversample = 'none';

    // audio → inputGain → rectifier → envFilter (= env out) → gateShaper (= gate out)
    inputGain.connect(rectifier);
    rectifier.connect(envFilter);
    envFilter.connect(gateShaper);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['audio', { node: inputGain, input: 0 }],
      ]),
      outputs: new Map([
        ['env', { node: envFilter, output: 0 }],
        ['gate', { node: gateShaper, output: 0 }],
      ]),
      setParam(paramId, value) {
        // ⚠ REFUSE A NON-FINITE WRITE (#1914). An AudioParam that receives NaN
        // is poisoned for good: every sample downstream of it is NaN, so this
        // module's ENV and GATE both went dead and STAYED dead until something
        // happened to write a finite value again — one bad write bricking the
        // node. Dropping the write leaves the node at its last good value,
        // which is the only recovery a passive graph has. Finite values,
        // including out-of-range ones, are unaffected: they clamp downstream
        // exactly as before.
        if (!Number.isFinite(value)) return;
        if (paramId === 'sensitivity') {
          inputGain.gain.setValueAtTime(value, ctx.currentTime);
        } else if (paramId === 'smoothing') {
          envFilter.frequency.setValueAtTime(smoothingToCutoffHz(value), ctx.currentTime);
        }
      },
      readParam(paramId) {
        if (paramId === 'sensitivity') return inputGain.gain.value;
        // Read the smoothing knob position back from the live cutoff (invert
        // the log map) so the UI fader tracks the running node.
        if (paramId === 'smoothing') {
          const hz = envFilter.frequency.value;
          const lnMin = Math.log(SMOOTH_MIN_HZ);
          const lnMax = Math.log(SMOOTH_MAX_HZ);
          const t = (Math.log(hz) - lnMin) / (lnMax - lnMin);
          const s = 1 - t;
          return s < 0 ? 0 : s > 1 ? 1 : s;
        }
        return undefined;
      },
      dispose() {
        try { inputGain.disconnect(); } catch { /* */ }
        try { rectifier.disconnect(); } catch { /* */ }
        try { envFilter.disconnect(); } catch { /* */ }
        try { gateShaper.disconnect(); } catch { /* */ }
      },
    };
  },
};
