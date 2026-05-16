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

// ---------- Top-level processor ----------

class MacrooscillatorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // model: 0 = VA, 1 = WAVESHAPE. Quantised in render via Math.round.
      // a-rate so live model-switching from the CV input is smooth (well,
      // glitchy — the engines have different state — but the model knob
      // never wants k-rate quantisation lag).
      { name: 'model',     defaultValue: 0,   minValue: 0,    maxValue: 1, automationRate: 'a-rate' as const },
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
      }
      this.lastGate = trig;

      // Clamp + round model.
      const modelIdx = Math.max(0, Math.min(1, Math.round(model)));

      const hClamp = Math.max(0, Math.min(1, harmonics));
      const tClamp = Math.max(0, Math.min(1, timbre));
      const mClamp = Math.max(0, Math.min(1, morph));

      // ALWAYS tick both engines so phase accumulators stay coherent across
      // a model switch. Costs one extra trig call per sample (~12 ns); buys
      // us silent model switching where the unselected engine doesn't
      // restart from phase=0 every time the user moves the knob.
      const [vaMain, vaAux] = this.va.tick(freq, hClamp, tClamp, mClamp, sr);
      const [wsMain, wsAux] = this.ws.tick(freq, hClamp, tClamp, mClamp, sr);

      const mainPick = modelIdx === 0 ? vaMain : wsMain;
      const auxPick = modelIdx === 0 ? vaAux : wsAux;

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
