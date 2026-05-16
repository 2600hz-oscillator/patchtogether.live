// packages/dsp/src/macrooscillator.ts
//
// MACROOSCILLATOR — Plaits-style macro oscillator.
//
// "Plaits" (Mutable Instruments) ships 16+ synthesis models behind a single
// I/O surface: pitch, trigger, three timbre macros (HARMONICS / TIMBRE /
// MORPH) and a LEVEL. The model is selected at the front panel; the macros
// have a different meaning per model. The same three knobs sculpt a virtual
// analog wave, then a wavefolder, then an FM patch, then a chord, etc.
//
// First-slice scope (this PR — see follow-up issue for the rest):
//   model = 0  VIRTUAL ANALOG (VA)
//     A single morphing PolyBLEP oscillator. The wave morphs continuously
//     across saw → square → triangle as MORPH goes 0..1. HARMONICS detunes
//     a second copy of the same wave and sums it (super-saw flavour at
//     extreme harmonics). TIMBRE adds a wavefolder on the summed signal
//     for added harmonics without aliasing the morph.
//
//   model = 1  WAVESHAPE
//     A sine driven through a chain of soft folders + a tanh waveshaper.
//     MORPH crossfades between the wavefolder and the tanh waveshaper.
//     TIMBRE = drive amount. HARMONICS adds a sub-octave sine for body.
//
//   model = 2  FM 2-OP
//     Classic Chowning two-operator FM. HARMONICS picks the carrier:modulator
//     ratio (snaps to integer harmonic relations 1:1, 1:2, 2:1, 1:3, 3:1, etc.
//     to keep the timbre tonally meaningful). TIMBRE = modulation index
//     (how much the modulator FMs the carrier — clean sine at 0, bright
//     metallic at 1). MORPH = feedback amount on the carrier (self-FM,
//     DX-style; pushes the carrier toward a saw shape).
//
//   model = 3  FM 6-OP (DX7-FLAVOR)
//     Six-operator FM stack arranged in a fixed algorithm (carrier ← stack
//     of three modulators with a feedback loop). HARMONICS scales the
//     modulator ratios as a group (denser stack at high values). TIMBRE
//     is the global modulation index (master mod amount across all
//     operators). MORPH biases the operator-envelope decay times (short =
//     percussive, long = pad-like). Aux output taps the carrier-only
//     signal (clean sine fundamental, no modulators) for chord-stacking
//     or sidechain reference.
//
// Both models share:
//   - PolyBLEP antialiasing on the saw + square primitives (VA).
//   - PITCH input is V/oct (1 unit = 1 octave) summed with the NOTE param
//     (semitones offset from C4 = 261.6256 Hz, Plaits' base note convention
//     differs but for our modular's V/oct integration C4=0 V is the standard).
//   - TRIG input is a gate; rising edge resets the phase accumulator so a
//     percussive attack lines up cleanly with the sample clock (helps when
//     short envelopes mask the steady-state drift of the LFO + VCO).
//   - LEVEL is a final scalar (0..1) on the main OUT. AUX always carries
//     the sub-octave / unfolded variant of the same model (Plaits convention
//     — gives modular patchers a second timbre tap without a second VCO).

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(name: string, ctor: typeof AudioWorkletProcessor): void;

// ---------- DSP helpers ----------

/** PolyBLEP residual — corrects the discontinuity of a naive saw/square
 *  near the wrap point so audible aliasing stays below the noise floor for
 *  fundamentals below ~6 kHz. dt is the per-sample phase increment.
 *  Returns the correction to ADD to the naive sample at `t` (the current
 *  fractional phase, 0..1). */
function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** Smooth wavefolder — Plaits' "wfold" approximation. Input is folded
 *  through sin(x * (1 + fold * k)) with k tuned so fold=0 is identity and
 *  fold=1 is ~3 fold-overs. Cheaper than the Bhaskaran approximation Plaits
 *  uses internally but psycho-acoustically close enough for our purposes. */
function wavefold(x: number, fold: number): number {
  // fold ∈ [0..1] → drive ∈ [1..6]. Above ~6× the fold becomes harsh
  // metallic ringing; 6 is a good musical ceiling for the macro slot.
  const drive = 1 + fold * 5;
  return Math.sin(x * drive * Math.PI * 0.5) / Math.max(1, drive * 0.5);
}

// ---------- VA engine ----------

class VAEngine {
  // Two phase accumulators — primary + detune partner.
  phaseA = 0;
  phaseB = 0;
  // Sub-octave phase (one octave below). Used for AUX out.
  phaseSub = 0;

  reset(): void {
    this.phaseA = 0;
    this.phaseB = 0;
    this.phaseSub = 0;
  }

  /** Render one sample.
   *  freq          : Hz of the primary oscillator.
   *  harmonics     : 0..1 — detune amount + super-saw spread.
   *  timbre        : 0..1 — wavefolder amount on the summed wave.
   *  morph         : 0..1 — saw→square→triangle morph.
   *  sr            : sampleRate Hz.
   *  Returns [main, aux] where aux is the un-folded sub-octave for patching. */
  tick(
    freq: number,
    harmonics: number,
    timbre: number,
    morph: number,
    sr: number,
  ): [number, number] {
    const dt = freq / sr;
    // Detune: harmonics=0 → unison, harmonics=1 → ±semitone-ish.
    // (Math.pow(2, 1/12) - 1) ≈ 0.0594. We sweep ±half that for a thicker
    // unison that doesn't beat too fast.
    const detuneSemitones = harmonics * 0.5;
    const detuneRatio = Math.pow(2, detuneSemitones / 12) - 1;
    const dtB = dt * (1 + detuneRatio);

    // Advance phases.
    this.phaseA += dt;
    if (this.phaseA >= 1) this.phaseA -= 1;
    this.phaseB += dtB;
    if (this.phaseB >= 1) this.phaseB -= 1;
    this.phaseSub += dt * 0.5;
    if (this.phaseSub >= 1) this.phaseSub -= 1;

    // ---- One morphed oscillator ----
    // morph 0..0.5 → saw → square ; 0.5..1 → square → triangle.
    // We compute the three primitives + crossfade rather than have three
    // branches; cheap on modern CPUs and avoids audible artefacts on the
    // morph knob (which the player WILL automate).
    const morphAB = (t: number, dtl: number): number => {
      // Saw (naive) with polyBLEP correction.
      const sawNaive = 2 * t - 1;
      const saw = sawNaive - polyBlep(t, dtl);
      // Square (naive) with two polyBLEPs (rising + falling edge).
      const sqrNaive = t < 0.5 ? 1 : -1;
      let sqr = sqrNaive;
      sqr += polyBlep(t, dtl);
      // Falling edge is at t = 0.5; equivalent to a 0.5-shifted polyBLEP
      // subtraction.
      const tShifted = t + 0.5 - Math.floor(t + 0.5);
      sqr -= polyBlep(tShifted, dtl);
      // Triangle — integrate the square. Cheap leaky integrator: tri[n] =
      // tri[n-1] + sqr * dt * 4. We don't keep state per-call here (it'd
      // pollute the harmonics partner with the primary's history) so use
      // the closed-form: triangle = 1 - 4 * |t - 0.5|.
      const tri = 1 - 4 * Math.abs(t - 0.5);

      if (morph < 0.5) {
        const m = morph * 2;
        return saw * (1 - m) + sqr * m;
      }
      const m = (morph - 0.5) * 2;
      return sqr * (1 - m) + tri * m;
    };

    const oscA = morphAB(this.phaseA, dt);
    const oscB = morphAB(this.phaseB, dtB);

    // Sum + level-compensate. Two voices sum to ±2; halve to keep ±1.
    // At harmonics=0 phases are locked, sum=2*oscA — so divide by 2 to
    // preserve unity scale at zero detune.
    const summed = (oscA + oscB) * 0.5;

    // Wavefolder on the summed wave for additional harmonics. timbre=0 →
    // identity; timbre=1 → strong folding.
    const folded = wavefold(summed, timbre);

    // AUX: sub-octave triangle of the primary. The Plaits convention is
    // for AUX to carry a more "raw" variant — here, the unfolded sub.
    const subTri = 1 - 4 * Math.abs(this.phaseSub - 0.5);

    return [folded, subTri];
  }
}

// ---------- WAVESHAPE engine ----------

class WaveshapeEngine {
  phase = 0;
  subPhase = 0;

  reset(): void {
    this.phase = 0;
    this.subPhase = 0;
  }

  tick(
    freq: number,
    harmonics: number,
    timbre: number,
    morph: number,
    sr: number,
  ): [number, number] {
    const dt = freq / sr;
    this.phase += dt;
    if (this.phase >= 1) this.phase -= 1;
    this.subPhase += dt * 0.5;
    if (this.subPhase >= 1) this.subPhase -= 1;

    // Base sine.
    const sine = Math.sin(2 * Math.PI * this.phase);
    // Sub sine for body. HARMONICS = sub mix.
    const sub = Math.sin(2 * Math.PI * this.subPhase);
    const body = sine + sub * harmonics * 0.7;

    // Drive: TIMBRE = drive amount; 0..1 → 1..8x pre-gain.
    const drive = 1 + timbre * 7;
    const driven = body * drive;

    // Two waveshapers; MORPH crossfades.
    // (a) Wavefolder: sin(driven * π / 2) — folds back on itself when
    //     |driven| > 1.
    const folded = Math.sin(driven * Math.PI * 0.5);
    // (b) Tanh waveshaper: gentle clipping with rich odd harmonics. tanh
    //     saturates smoothly; pairs nicely with the wavefolder in a morph.
    const tanhd = Math.tanh(driven);

    const main = folded * (1 - morph) + tanhd * morph;
    // Normalize — drive scales energy linearly; pull main back by the same
    // gain so a turn of the timbre knob doesn't shove the output 8x louder.
    const normalised = main / Math.max(1, Math.sqrt(drive));

    // AUX: the pre-distortion body. Useful as a clean fundamental tap.
    const aux = body / Math.max(1, 1 + harmonics * 0.7);

    return [normalised, aux];
  }
}

// ---------- FM 2-OP engine ----------

/** Quantised carrier:modulator ratios — picked to land on integer-harmonic
 *  relationships that sound musical (vs arbitrary non-integer ratios which
 *  produce inharmonic clangour). Index into this table with HARMONICS. */
const FM2_RATIOS: [number, number][] = [
  [1, 1],   // unison sidebands → square-ish
  [1, 2],   // octave-up modulator → clarinet-ish
  [2, 1],   // octave-down modulator → bell-ish
  [1, 3],   // fifth-up modulator → reedy
  [3, 1],   // fifth-down modulator → wooden
  [1, 4],   // double-octave modulator → glassy
  [2, 3],   // 3:2 ratio → metallic
  [3, 2],   // inverse — different timbre even though ratio is reciprocal
];

class FM2OpEngine {
  // Carrier phase + modulator phase + carrier history (for feedback).
  cPhase = 0;
  mPhase = 0;
  // One-sample feedback memory on the carrier. DX-style: prev sample is
  // fed back into the carrier's phase modulation input.
  cPrev = 0;

  reset(): void {
    this.cPhase = 0;
    this.mPhase = 0;
    this.cPrev = 0;
  }

  tick(
    freq: number,
    harmonics: number,
    timbre: number,
    morph: number,
    sr: number,
  ): [number, number] {
    // HARMONICS picks a ratio pair from the table. Quantise so the timbre
    // doesn't smear continuously across non-musical ratios.
    const ratioIdx = Math.max(0, Math.min(FM2_RATIOS.length - 1, Math.floor(harmonics * FM2_RATIOS.length)));
    const [cRatio, mRatio] = FM2_RATIOS[ratioIdx]!;
    const cFreq = freq * cRatio;
    const mFreq = freq * mRatio;

    this.cPhase += cFreq / sr;
    if (this.cPhase >= 1) this.cPhase -= 1;
    this.mPhase += mFreq / sr;
    if (this.mPhase >= 1) this.mPhase -= 1;

    // Modulation index: TIMBRE 0..1 → 0..8 radians. 8 is the upper end of
    // musically useful FM depth (DX7 maxes out around 6-8 for most patches;
    // beyond that you get aliasing noise rather than recognisable timbre).
    const modIndex = timbre * 8;
    const mod = Math.sin(2 * Math.PI * this.mPhase) * modIndex;

    // Feedback: MORPH 0..1 → 0..π feedback radians. At high feedback the
    // carrier self-modulates and approaches a sawtooth (the DX feedback
    // trick).
    const fbk = morph * Math.PI;
    const carrierPhase = 2 * Math.PI * this.cPhase + mod + this.cPrev * fbk;
    const carrier = Math.sin(carrierPhase);
    this.cPrev = carrier;

    // AUX: clean carrier sine, no modulation. Useful as a chord-stacking
    // tap (player can sum AUX from N copies for a clean polyphonic stack).
    const aux = Math.sin(2 * Math.PI * this.cPhase);

    return [carrier * 0.8, aux];
  }
}

// ---------- FM 6-OP engine (DX7-flavor) ----------

/** Fixed algorithm: 4 modulators stack into 1 carrier, with op6 in a
 *  feedback loop. Indices in this array are operator slots:
 *    0 = carrier (output)
 *    1..4 = modulators (chained: 4→3→2→1 then 1→carrier)
 *    5 = feedback op (modulates itself, then adds to carrier input)
 *  This is a simplification of DX7 algorithm 1 — the gnarliest available
 *  on the original hardware.
 *
 *  Operator ratios are baseline 1.0 and get scaled by HARMONICS (denser
 *  stack → higher modulator ratios → more inharmonic / metallic). */
const FM6_BASE_RATIOS = [1.0, 1.0, 2.0, 3.0, 4.0, 1.0]; // carrier first, then mods, then fbk op

class FM6OpEngine {
  phases = [0, 0, 0, 0, 0, 0];
  // Feedback memory for op5 (the feedback operator).
  fbkPrev = 0;
  // Per-op envelope state (one-pole decay, retriggered on phase reset).
  envs = [1, 1, 1, 1, 1, 1];

  reset(): void {
    for (let i = 0; i < 6; i++) this.phases[i] = 0;
    this.fbkPrev = 0;
    for (let i = 0; i < 6; i++) this.envs[i] = 1;
  }

  tick(
    freq: number,
    harmonics: number,
    timbre: number,
    morph: number,
    sr: number,
  ): [number, number] {
    // HARMONICS scales modulator ratios. 0 → all 1.0 (unison-y stack,
    // mostly fundamental + low harmonics). 1 → full base ratios (rich,
    // inharmonic).
    const ratioScale = 0.25 + harmonics * 0.75;

    // Envelope decay rate biased by MORPH. 0 → 50ms decay (percussive),
    // 1 → 5s decay (pad). Mapped exponentially so the knob feels musical.
    const decaySec = 0.05 * Math.pow(100, morph);
    const decayCoef = Math.exp(-1 / (decaySec * sr));

    // Advance phases.
    for (let i = 0; i < 6; i++) {
      const ratio = i === 0 ? 1.0 : FM6_BASE_RATIOS[i]! * ratioScale;
      this.phases[i]! += (freq * ratio) / sr;
      if (this.phases[i]! >= 1) this.phases[i]! -= 1;
      this.envs[i]! *= decayCoef;
    }

    // Global mod index from TIMBRE. 0..1 → 0..6.
    const modIndex = timbre * 6;

    // Feedback op (op5) — self-modulating sine; its output drives carrier.
    const fbkAmt = 0.5 * modIndex;
    const fbkPhase = 2 * Math.PI * this.phases[5]! + this.fbkPrev * fbkAmt;
    const fbk = Math.sin(fbkPhase) * this.envs[5]!;
    this.fbkPrev = fbk;

    // Chain: op4 → op3 → op2 → op1 (each modulates the next).
    const op4 = Math.sin(2 * Math.PI * this.phases[4]!) * this.envs[4]! * modIndex * 0.5;
    const op3 = Math.sin(2 * Math.PI * this.phases[3]! + op4) * this.envs[3]! * modIndex * 0.5;
    const op2 = Math.sin(2 * Math.PI * this.phases[2]! + op3) * this.envs[2]! * modIndex * 0.5;
    const op1 = Math.sin(2 * Math.PI * this.phases[1]! + op2) * this.envs[1]! * modIndex * 0.5;

    // Carrier sees op1 + feedback as phase mod.
    const carrierMod = op1 + fbk * 0.5;
    const carrier = Math.sin(2 * Math.PI * this.phases[0]! + carrierMod) * this.envs[0]!;

    // AUX: clean carrier (no FM applied) — same fundamental sine as the
    // base pitch. Used as a sidechain reference / clean octave-stack tap.
    const aux = Math.sin(2 * Math.PI * this.phases[0]!);

    return [carrier * 0.7, aux];
  }
}

// ---------- Top-level processor ----------

class MacrooscillatorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // model: 0=VA, 1=WAVESHAPE, 2=FM 2-OP, 3=FM 6-OP. Quantised in render
      // via Math.round. a-rate so live model-switching from the CV input is
      // smooth (well, glitchy — the engines have different state — but the
      // model knob never wants k-rate quantisation lag). maxValue grows as
      // new engines land; keep it equal to (MODEL_NAMES.length - 1).
      { name: 'model',     defaultValue: 0,   minValue: 0,    maxValue: 3, automationRate: 'a-rate' as const },
      // note: ±60 semitones offset on top of the V/oct pitch input.
      { name: 'note',      defaultValue: 0,   minValue: -60,  maxValue: 60, automationRate: 'a-rate' as const },
      { name: 'harmonics', defaultValue: 0.3, minValue: 0,    maxValue: 1,  automationRate: 'a-rate' as const },
      { name: 'timbre',    defaultValue: 0.3, minValue: 0,    maxValue: 1,  automationRate: 'a-rate' as const },
      { name: 'morph',     defaultValue: 0.5, minValue: 0,    maxValue: 1,  automationRate: 'a-rate' as const },
      { name: 'level',     defaultValue: 0.8, minValue: 0,    maxValue: 1,  automationRate: 'a-rate' as const },
    ];
  }

  private va = new VAEngine();
  private ws = new WaveshapeEngine();
  private fm2 = new FM2OpEngine();
  private fm6 = new FM6OpEngine();
  /** Last-block gate value — used for rising-edge detection across the
   *  block boundary so a gate ↑ that lands at the first sample of a new
   *  block still triggers phase reset. */
  private lastGate = 0;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const outMain = outputs[0]?.[0];
    const outAux = outputs[1]?.[0];
    if (!outMain || !outAux) return true;

    const pitchIn = inputs[0]?.[0];
    const trigIn = inputs[1]?.[0];

    const modelArr = parameters.model;
    const noteArr = parameters.note;
    const harmonicsArr = parameters.harmonics;
    const timbreArr = parameters.timbre;
    const morphArr = parameters.morph;
    const levelArr = parameters.level;

    const sr = sampleRate;

    for (let i = 0; i < outMain.length; i++) {
      const pitchV = pitchIn ? pitchIn[i]! : 0;
      const trig = trigIn ? trigIn[i]! : 0;

      const model = modelArr.length > 1 ? modelArr[i]! : modelArr[0]!;
      const note = noteArr.length > 1 ? noteArr[i]! : noteArr[0]!;
      const harmonics = harmonicsArr.length > 1 ? harmonicsArr[i]! : harmonicsArr[0]!;
      const timbre = timbreArr.length > 1 ? timbreArr[i]! : timbreArr[0]!;
      const morph = morphArr.length > 1 ? morphArr[i]! : morphArr[0]!;
      const level = levelArr.length > 1 ? levelArr[i]! : levelArr[0]!;

      // Pitch: V/oct 1V = 1 octave, note is semitones offset on top. C4 (0
      // V, 0 st) = 261.6256 Hz.
      const semitones = pitchV * 12 + note;
      let freq = 261.6256 * Math.pow(2, semitones / 12);
      if (freq < 1) freq = 1;
      else if (freq > 20000) freq = 20000;

      // Rising-edge trigger reset.
      if (trig >= 0.5 && this.lastGate < 0.5) {
        this.va.reset();
        this.ws.reset();
        this.fm2.reset();
        this.fm6.reset();
      }
      this.lastGate = trig;

      // Clamp + round model. maxValue grows as engines are added — keep in
      // sync with MODEL_NAMES length in the card.
      const modelIdx = Math.max(0, Math.min(3, Math.round(model)));

      const hClamp = Math.max(0, Math.min(1, harmonics));
      const tClamp = Math.max(0, Math.min(1, timbre));
      const mClamp = Math.max(0, Math.min(1, morph));

      // ALWAYS tick every engine so phase accumulators stay coherent across
      // a model switch. Costs an extra trig call per engine per sample
      // (~12 ns each); buys us silent model switching where the unselected
      // engine doesn't restart from phase=0 every time the user moves the
      // knob.
      const [vaMain, vaAux] = this.va.tick(freq, hClamp, tClamp, mClamp, sr);
      const [wsMain, wsAux] = this.ws.tick(freq, hClamp, tClamp, mClamp, sr);
      const [fm2Main, fm2Aux] = this.fm2.tick(freq, hClamp, tClamp, mClamp, sr);
      const [fm6Main, fm6Aux] = this.fm6.tick(freq, hClamp, tClamp, mClamp, sr);

      let mainPick = vaMain;
      let auxPick = vaAux;
      if (modelIdx === 1) { mainPick = wsMain; auxPick = wsAux; }
      else if (modelIdx === 2) { mainPick = fm2Main; auxPick = fm2Aux; }
      else if (modelIdx === 3) { mainPick = fm6Main; auxPick = fm6Aux; }

      const lvl = Math.max(0, Math.min(1, level));
      outMain[i] = mainPick * lvl;
      // AUX is intentionally NOT level-scaled — players use AUX as a
      // sidechain / scope tap and expect a steady amplitude.
      outAux[i] = auxPick;
    }

    return true;
  }
}

registerProcessor('macrooscillator', MacrooscillatorProcessor);

// Pure-math mirror of the engines lives in
// packages/web/src/lib/audio/modules/macrooscillator.ts (exported as
// macrooscillatorMath) so unit tests + ART scenarios can render audio under
// node without an AudioWorkletGlobalScope. Any change here MUST be mirrored
// there.
