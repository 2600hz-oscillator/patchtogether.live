// packages/dsp/src/slewswitch.ts
//
// SLEWSWITCH — quad slew limiter + 4→1 sequential CV switch worklet.
//
// Per-channel one-pole lowpass smooths each cv input; outputs are the
// four slewed signals (always live) plus a `switched` channel that
// crossfades through the four slewed lines on each `step_clock` rising
// edge. step_clock is read from input channel 0 of input 0 (gates use the
// same audio-rate convention as the rest of the codebase).
//
// Inputs (0..5):
//   0  cv1  (1 channel)
//   1  cv2  (1 channel)
//   2  cv3  (1 channel)
//   3  cv4  (1 channel)
//   4  step_clock (1 channel, gate)
//   5  reset (1 channel, gate)
//
// Outputs (0..6):
//   0  out1       (slewed cv1)
//   1  out2       (slewed cv2)
//   2  out3       (slewed cv3)
//   3  out4       (slewed cv4)
//   4  switched   (currently-selected slewed channel, equal-GAIN xfade — see
//                  the crossfade block in process(): equal-POWER overshot a
//                  correlated CV hand-off by 41.4 %, #1711)
//   5  step_idx   (-1..+1 quantized to 4 levels — for downstream display)
//   6  eoc        (gate pulse on wrap step3 → step0)
//
// Mode: 0=forward (0→1→2→3→0…), 1=pendulum (0→1→2→3→2→1→0…), 2=random
// (uniform pick over 0..length-1, excluding the current index).

const EOC_PULSE_S = 0.005; // 5 ms gate pulse on wrap

class SlewSwitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Per-channel slew time constants (seconds — tau of the one-pole).
      { name: 'slew1',     defaultValue: 0.5,   minValue: 0.001, maxValue: 5, automationRate: 'k-rate' as const },
      { name: 'slew2',     defaultValue: 0.5,   minValue: 0.001, maxValue: 5, automationRate: 'k-rate' as const },
      { name: 'slew3',     defaultValue: 0.5,   minValue: 0.001, maxValue: 5, automationRate: 'k-rate' as const },
      { name: 'slew4',     defaultValue: 0.5,   minValue: 0.001, maxValue: 5, automationRate: 'k-rate' as const },
      // 0 forward, 1 pendulum, 2 random
      { name: 'mode',      defaultValue: 0,     minValue: 0,     maxValue: 2, automationRate: 'k-rate' as const },
      { name: 'length',    defaultValue: 4,     minValue: 1,     maxValue: 4, automationRate: 'k-rate' as const },
      { name: 'xfadeTime', defaultValue: 0.05,  minValue: 0.001, maxValue: 2, automationRate: 'k-rate' as const },
    ];
  }

  // Per-channel smoothed state.
  private y = [0, 0, 0, 0];
  // Current + previous selection (drives the equal-gain crossfade).
  private curIdx = 0;
  private prevIdx = 0;
  // 0..1 fade progress from prevIdx → curIdx (1 = settled on curIdx).
  private xfade = 1;
  // Pendulum direction.
  private dir: 1 | -1 = 1;
  // Rising-edge detectors.
  private prevClock = 0;
  private prevReset = 0;
  // EOC pulse countdown (in samples).
  private eocRemaining = 0;
  // PRNG state for random mode — splitmix32 seeded from construction.
  private prng: number;

  constructor(options?: { processorOptions?: { seed?: number } }) {
    super(options);
    this.prng = Math.floor((options?.processorOptions?.seed ?? Math.random() * 0xffffffff) >>> 0) || 1;
  }

  private rand(): number {
    // Mulberry32 — fine enough for a step-selection PRNG.
    this.prng = (this.prng + 0x6d2b79f5) >>> 0;
    let t = this.prng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private advance(length: number, mode: number): void {
    if (length <= 1) { this.curIdx = 0; return; }
    const prev = this.curIdx;
    if (mode < 0.5) {
      // forward
      this.curIdx = (prev + 1) % length;
      if (this.curIdx === 0) this.eocRemaining = Math.round(EOC_PULSE_S * sampleRate);
    } else if (mode < 1.5) {
      // pendulum
      let next = prev + this.dir;
      if (next >= length) { this.dir = -1; next = prev - 1; }
      else if (next < 0)  { this.dir =  1; next = prev + 1; }
      this.curIdx = next;
      if (next === 0) this.eocRemaining = Math.round(EOC_PULSE_S * sampleRate);
    } else {
      // random — pick any of 0..length-1 except prev (so the switch
      // audibly does something each tick).
      let pick = Math.floor(this.rand() * length);
      if (pick === prev) pick = (pick + 1) % length;
      this.curIdx = pick;
      // No structural EOC in random mode; pulse on every step instead.
      this.eocRemaining = Math.round(EOC_PULSE_S * sampleRate);
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const in1 = inputs[0]?.[0];
    const in2 = inputs[1]?.[0];
    const in3 = inputs[2]?.[0];
    const in4 = inputs[3]?.[0];
    const clk = inputs[4]?.[0];
    const rst = inputs[5]?.[0];

    const out1     = outputs[0]?.[0];
    const out2     = outputs[1]?.[0];
    const out3     = outputs[2]?.[0];
    const out4     = outputs[3]?.[0];
    const swOut    = outputs[4]?.[0];
    const idxOut   = outputs[5]?.[0];
    const eocOut   = outputs[6]?.[0];
    if (!out1 || !out2 || !out3 || !out4 || !swOut || !idxOut || !eocOut) return true;

    const N = out1.length;
    const sr = sampleRate;
    const tau = [
      parameters.slew1[0]!,
      parameters.slew2[0]!,
      parameters.slew3[0]!,
      parameters.slew4[0]!,
    ];
    // alpha = 1 - exp(-dt/τ), per-sample.
    const alpha = tau.map((t) => 1 - Math.exp(-(1 / sr) / t));
    const mode = parameters.mode[0]!;
    const len = Math.max(1, Math.min(4, Math.round(parameters.length[0]!)));
    const xfadeT = Math.max(0.001, parameters.xfadeTime[0]!);
    const xfadeStep = (1 / sr) / xfadeT;

    // LENGTH is live, and `advance()` is the ONLY thing that folds curIdx back
    // into range (`% length`) — so turning LENGTH DOWN while the sequence sits
    // above the new top left a stale selection standing until the next clock.
    // Measured before this clamp (#1524): on step 4 with LENGTH 4 → 2,
    // `step_idx` emitted **+5.0** against a declared ±1 CV range, and
    // `switched` kept playing channel 4 — a channel LENGTH had just excluded.
    // Fold to the highest ACTIVE channel: shortening the lap should pull the
    // selection in, not park it outside. Regression: slewswitch.test.ts,
    // 'LENGTH turned DOWN below the current step'.
    if (this.curIdx >= len) this.curIdx = len - 1;
    if (this.prevIdx >= len) this.prevIdx = len - 1;

    for (let i = 0; i < N; i++) {
      const x1 = in1 ? in1[i]! : 0;
      const x2 = in2 ? in2[i]! : 0;
      const x3 = in3 ? in3[i]! : 0;
      const x4 = in4 ? in4[i]! : 0;
      const ck = clk ? clk[i]! : 0;
      const rs = rst ? rst[i]! : 0;

      this.y[0]! += alpha[0]! * (x1 - this.y[0]!);
      this.y[1]! += alpha[1]! * (x2 - this.y[1]!);
      this.y[2]! += alpha[2]! * (x3 - this.y[2]!);
      this.y[3]! += alpha[3]! * (x4 - this.y[3]!);

      out1[i] = this.y[0]!;
      out2[i] = this.y[1]!;
      out3[i] = this.y[2]!;
      out4[i] = this.y[3]!;

      // Reset edge — back to step 0 + cancel any pending crossfade.
      if (rs > 0.5 && this.prevReset <= 0.5) {
        this.prevIdx = this.curIdx;
        this.curIdx = 0;
        this.xfade = 1;
        this.dir = 1;
      }
      this.prevReset = rs;

      // Clock edge — advance + start a new crossfade.
      if (ck > 0.5 && this.prevClock <= 0.5) {
        this.prevIdx = this.curIdx;
        this.advance(len, mode);
        this.xfade = 0;
      }
      this.prevClock = ck;

      // Progress the crossfade.
      if (this.xfade < 1) {
        this.xfade = Math.min(1, this.xfade + xfadeStep);
      }

      // EQUAL-GAIN (linear) crossfade — the CV law, and NOT the audio one.
      //
      // This was an equal-power cos/sin pair, which is correct for UNCORRELATED
      // AUDIO (two incoherent sources sum in power, so a linear fade dips ~3 dB
      // at the midpoint and cos/sin holds it flat). Every port on this module is
      // typed `cv` and every documented use is a CV one — portamento for pitch,
      // envelope rounding, smoothing a steppy CV — and two CV levels are
      // perfectly CORRELATED, so cos+sin does not hold the level, it PEAKS at
      // √2 (#1711).
      //
      // MEASURED on the shipped worklet at the default xfadeTime 0.05 s, all
      // four channels held at the SAME level (a hand-off that must be a no-op):
      // level 1.00 → peak 1.414214, 0.50 → 0.707107, 0.25 → 0.353553. A flat
      // +41.42 % at every level, which is exactly √2. Between DIFFERENT levels
      // (0.2 → 0.4) it overshot to 0.4472 (+11.80 % past the target) and came
      // back DOWN — a non-monotone hand-off, on the one output whose whole job
      // is to hand off cleanly. With `switched` driving a 1 V/oct input that is
      // a ~5 semitone pitch blip on every step, including steps between two
      // channels holding the same note.
      //
      // `1 - x` and `x` sum to exactly 1, so equal levels hand off FLAT and any
      // pair interpolates monotonically between the endpoints. Regressions:
      // slewswitch.test.ts, 'the crossfade is EQUAL-GAIN'.
      const b = this.xfade;
      swOut[i] = (1 - b) * this.y[this.prevIdx]! + b * this.y[this.curIdx]!;

      // Step index spread evenly over -1..+1 across the ACTIVE channels.
      // Measured at each length: 4 -> -1 / -0.3333 / +0.3333 / +1; 3 -> -1 / 0 /
      // +1; 2 -> -1 / +1; 1 -> 0 (the len>1 guard, since there is no spread to
      // make). This comment used to read "0/-0.333/+0.333/+1", which is the
      // length-4 row with -1 mistyped as 0 (#1712).
      idxOut[i] = len > 1 ? (this.curIdx / (len - 1)) * 2 - 1 : 0;

      // EOC pulse output (5 ms).
      if (this.eocRemaining > 0) {
        eocOut[i] = 1;
        this.eocRemaining--;
      } else {
        eocOut[i] = 0;
      }
    }
    return true;
  }
}

registerProcessor('slewswitch', SlewSwitchProcessor);
