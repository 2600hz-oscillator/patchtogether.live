// packages/dsp/src/warrenspectrum.ts
//
// WARRENSPECTRUM — stereo 8-band filterbank with vactrol-style ping
// excitation. Each band is a per-channel pair of biquad bandpass filters
// (RBJ cookbook BPF, peaking variant — 0 dB at center, log-symmetric
// skirts) at fixed octave-spaced center frequencies covering 80 Hz to
// 10.24 kHz.
//
// Ping behavior: each band has its own gate input. Rising edge triggers
// a vactrol-style envelope (soft attack 10-30 ms with ±10% jitter,
// exponential decay 100-800 ms via the pingDecay knob with ±10% jitter,
// soft-saturated via tanh(env * 4) / tanh(4)). The ping fires not just
// the band itself but the adjacent two on each side with bleed weights
// 1.0 / 0.35 / 0.12 — the cluster rings as a group, the way a real
// resonator bank cross-couples mechanical excitation.
//
// The envelope drives a brief excitation impulse that's summed into the
// bandpass input (so the filter rings at its own center frequency), AND
// it modulates the per-band gain post-filter slightly (vactrol "pump"
// — the LDR brightens, then dims, more than just opening/closing).
//
// Inputs (3): in_l (audio L), in_r (audio R), pings_packed (8 gate
// channels packed 0..7). CV inputs route to AudioParams directly via
// the standard CV→param mechanism so this worklet doesn't need extra
// input ports for them. We expose 8 ping channels as a single 8-channel
// input bus rather than 8 separate inputs because AudioWorkletNode has
// a hard cap of 16 inputs and we'd burn 10 of them on pings — too
// brittle. The host materializes 8 GainNode pin-points and merges them
// into channels 0..7 of the same AudioNode input.
//
// Outputs (2): out_l, out_r.

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: typeof AudioWorkletProcessor
): void;

const NUM_BANDS = 8;
const Q = 6.0;
const BLEED_WEIGHTS = [1.0, 0.35, 0.12] as const; // offsets 0, ±1, ±2

// Center frequencies — octave-spaced, log-uniform 80 Hz .. 10.24 kHz.
const CENTER_HZ = [80, 160, 320, 640, 1280, 2560, 5120, 10240] as const;

interface BiquadState {
  // RBJ biquad direct form II transposed
  b0: number; b1: number; b2: number;
  a1: number; a2: number;
  z1: number; z2: number;
}

function makeBiquadBpf(fc: number, q: number, sr: number): BiquadState {
  // RBJ bandpass, constant 0dB peak gain.
  const w0 = (2 * Math.PI * fc) / sr;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const alpha = sinW / (2 * q);
  const b0 = alpha;
  const b1 = 0;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * cosW;
  const a2 = 1 - alpha;
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
    z1: 0,
    z2: 0,
  };
}

function processBiquad(state: BiquadState, x: number): number {
  // Direct form II transposed.
  const y = state.b0 * x + state.z1;
  state.z1 = state.b1 * x - state.a1 * y + state.z2;
  state.z2 = state.b2 * x - state.a2 * y;
  return y;
}

interface VactrolEnv {
  /** Excitation amplitude — accumulated bleed from this and neighbors. */
  excitation: number;
  /** Current envelope output (0..1). */
  env: number;
  /** Attack ramp accumulator while in attack phase. */
  attackProgress: number;
  /** Per-ping randomized attack samples (10-30 ms × ±10%). */
  attackSamples: number;
  /** Per-ping randomized decay coefficient (computed from knob × ±10%). */
  decayCoef: number;
  /** Phase: 0 = idle, 1 = attack, 2 = decay. */
  phase: 0 | 1 | 2;
  /** Previous gate value for rising-edge detection. */
  prevGate: number;
  /** Fast broadband click amplitude — decays per-sample at ~1ms; injected
   *  into the bandpass to make it ring at its center freq (vs. the
   *  smooth envelope which has no high-frequency content). */
  click: number;
}

function makeEnv(): VactrolEnv {
  return {
    excitation: 0,
    env: 0,
    attackProgress: 0,
    attackSamples: 0,
    decayCoef: 0,
    phase: 0,
    prevGate: 0,
    click: 0,
  };
}

/**
 * Soft-saturating nonlinear shaper. Maps unbounded positive excitation
 * onto 0..1 with a gentle compression curve so heavy retriggering
 * doesn't produce a runaway envelope. This is the "vactrol gets warm
 * and refuses to brighten further" character — physically a saturating
 * LDR response.
 */
export function vactrolShape(env: number, drive: number): number {
  // tanh-based; tanh(drive) is the asymptote at excitation → ∞.
  return Math.tanh(env * drive) / Math.tanh(drive);
}

/**
 * Compute the bleed contribution of one ping at band `n` to band `k`
 * given the BLEED_WEIGHTS array. Returns 0 if |n-k| > 2.
 */
export function bleedWeight(n: number, k: number): number {
  const d = Math.abs(n - k);
  if (d >= BLEED_WEIGHTS.length) return 0;
  return BLEED_WEIGHTS[d]!;
}

/**
 * Apply a fresh ping to band `n`: distribute excitation across n±2 using
 * BLEED_WEIGHTS, randomize attack + decay times per ±10% jitter, and
 * arm the attack phase. Pure function on the env array — used both at
 * worklet runtime and in the unit tests.
 */
export function applyPing(
  envs: VactrolEnv[],
  n: number,
  pingDecaySec: number,
  attackMsBase: number,
  sr: number,
  rand: () => number,
): void {
  for (let k = 0; k < envs.length; k++) {
    const w = bleedWeight(n, k);
    if (w === 0) continue;
    const e = envs[k]!;
    // Add excitation (clamped — adjacent pings within a band don't
    // accumulate past unity).
    e.excitation = Math.min(1.5, e.excitation + w);
    // Jitter: ±10% on attack and decay per ping.
    const aJ = 1 + (rand() - 0.5) * 0.2;
    const dJ = 1 + (rand() - 0.5) * 0.2;
    const attackMs = attackMsBase * aJ;
    const decaySec = Math.max(0.01, pingDecaySec * dJ);
    e.attackSamples = Math.max(1, Math.round((attackMs / 1000) * sr));
    e.attackProgress = 0;
    e.decayCoef = Math.exp(-1 / (decaySec * sr));
    e.phase = 1; // attack
    // Click impulse: scaled by bleed weight so neighbors get a softer
    // hit. Decays at ~98% per sample (≈1ms time constant at 48kHz),
    // so the bandpass sees a brief broadband impulse and rings at fc.
    e.click = Math.max(e.click, w * 0.8);
  }
}

/**
 * Step the envelope one sample. Returns the post-shape output.
 * Linear attack to excitation level, then exponential decay.
 */
export function stepEnv(e: VactrolEnv, drive: number): number {
  if (e.phase === 0) {
    e.env = 0;
    return 0;
  }
  if (e.phase === 1) {
    e.attackProgress += 1;
    const r = e.attackProgress / e.attackSamples;
    if (r >= 1) {
      e.env = e.excitation;
      e.phase = 2;
    } else {
      e.env = e.excitation * r;
    }
  } else {
    e.env = e.env * e.decayCoef;
    e.excitation = e.excitation * e.decayCoef;
    if (e.env < 1e-5) {
      e.env = 0;
      e.excitation = 0;
      e.phase = 0;
    }
  }
  return vactrolShape(e.env, drive);
}

// Re-exported types for the test mirror.
export type { VactrolEnv };
export { NUM_BANDS, BLEED_WEIGHTS, CENTER_HZ };

class WarrenspectrumProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const descs: Array<{
      name: string;
      defaultValue: number;
      minValue: number;
      maxValue: number;
      automationRate: 'a-rate' | 'k-rate';
    }> = [];
    for (let i = 1; i <= NUM_BANDS; i++) {
      descs.push({
        name: `level${i}`,
        defaultValue: 1.0,
        minValue: 0,
        maxValue: 2,
        automationRate: 'a-rate',
      });
    }
    descs.push({ name: 'master',     defaultValue: 1.0, minValue: 0, maxValue: 2, automationRate: 'a-rate' });
    descs.push({ name: 'pingDecay',  defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' });
    return descs;
  }

  private bpfL: BiquadState[] = [];
  private bpfR: BiquadState[] = [];
  private envs: VactrolEnv[] = [];
  /** Most recent waveform snapshot of the L input — drained by the host
   *  for the on-card visualization at ~30Hz. We send 256 samples per
   *  message so the host always has a fresh trace to render. */
  private wavBuf = new Float32Array(256);
  private wavWriteIdx = 0;
  private framesSincePost = 0;
  /** Bandflash array sent alongside wavBuf so the card flash-decays in
   *  sync with the worklet's envelopes (rather than tracking pings
   *  separately on the main thread). */
  private bandFlash = new Float32Array(NUM_BANDS);

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    for (let i = 0; i < NUM_BANDS; i++) {
      this.bpfL.push(makeBiquadBpf(CENTER_HZ[i]!, Q, sampleRate));
      this.bpfR.push(makeBiquadBpf(CENTER_HZ[i]!, Q, sampleRate));
      this.envs.push(makeEnv());
    }
  }

  private rand(): number {
    // Mulberry32-style PRNG would be nicer; Math.random suffices since
    // jitter is purely cosmetic.
    return Math.random();
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const outL = outputs[0]?.[0];
    const outR = outputs[1]?.[0];
    if (!outL || !outR) return true;

    const inL = inputs[0]?.[0];
    const inR = inputs[1]?.[0];
    // Pings: input index 2 is the 8-channel ping bus. Each channel maps
    // to one band. The host wires 8 separate ping inputs into channels
    // 0..7 of this input via a ChannelMergerNode.
    const pingsInput = inputs[2];

    const pingDecayKnob = parameters.pingDecay![0] ?? 0.5;
    // Map 0..1 → 100..800ms (ping decay range per spec).
    const pingDecaySec = 0.1 + pingDecayKnob * 0.7;
    const ATTACK_MS_BASE = 20; // mid of 10-30 range
    const DRIVE = 4.0;

    const masterArr = parameters.master!;

    const blockSize = outL.length;

    // Detect rising edges per band, then apply ping (which writes into
    // multiple envs via bleed). We do edge detection at the start of
    // the block — sample-accurate within a 128-sample block, which is
    // ~2.7ms — well below perceptual ping timing.
    if (pingsInput) {
      for (let b = 0; b < NUM_BANDS; b++) {
        const ch = pingsInput[b];
        if (!ch) continue;
        // Use the FIRST sample of the block as the gate level.
        const gate = ch[0] ?? 0;
        const prev = this.envs[b]!.prevGate;
        if (gate >= 0.5 && prev < 0.5) {
          applyPing(this.envs, b, pingDecaySec, ATTACK_MS_BASE, sampleRate, () => this.rand());
          this.bandFlash[b] = 1.0;
        }
        this.envs[b]!.prevGate = gate;
      }
    }

    for (let i = 0; i < blockSize; i++) {
      const xL = inL ? inL[i]! : 0;
      const xR = inR ? inR[i]! : 0;

      let sumL = 0;
      let sumR = 0;

      for (let b = 0; b < NUM_BANDS; b++) {
        const e = this.envs[b]!;
        // Step envelope once per sample.
        const envOut = stepEnv(e, DRIVE);

        // Click impulse: fast-decay broadband injection that drives the
        // bandpass into ringing at fc. Decays at ~1ms so the filter sees
        // a single sharp transient (vs. the smooth envelope which has
        // no high-frequency content of its own).
        const clickAmp = e.click;
        e.click = e.click * 0.98;
        if (e.click < 1e-5) e.click = 0;
        const ring = clickAmp;

        // Per-sample CV-modulated gain: paramArray length 1 or blockSize.
        const lvlArr = parameters[`level${b + 1}`]!;
        const lvl = lvlArr.length > 1 ? lvlArr[i]! : lvlArr[0]!;
        // Vactrol "pump": envOut slightly boosts the band gain when
        // active — adds liveliness on ping without sacrificing the
        // baseline EQ behavior.
        const bandGain = lvl * (1 + envOut * 0.5);

        const yL = processBiquad(this.bpfL[b]!, xL + ring) * bandGain;
        const yR = processBiquad(this.bpfR[b]!, xR + ring) * bandGain;
        sumL += yL;
        sumR += yR;
      }

      const master = masterArr.length > 1 ? masterArr[i]! : masterArr[0]!;
      outL[i] = sumL * master * 0.25;
      outR[i] = sumR * master * 0.25;

      // Capture L-input snapshot (the dry input) for the viz.
      this.wavBuf[this.wavWriteIdx] = xL;
      this.wavWriteIdx = (this.wavWriteIdx + 1) % this.wavBuf.length;
    }

    // Post snapshot to the main thread at ~30Hz.
    this.framesSincePost += blockSize;
    const POST_INTERVAL_SAMPLES = sampleRate / 30;
    if (this.framesSincePost >= POST_INTERVAL_SAMPLES) {
      this.framesSincePost = 0;
      // Decay flashes by ~30% per snapshot (matches ~0.92/frame at 60fps
      // on the card draw — close enough; card also decays locally).
      const flashCopy = new Float32Array(this.bandFlash);
      for (let b = 0; b < NUM_BANDS; b++) {
        this.bandFlash[b] = this.bandFlash[b]! * 0.65;
      }
      this.port.postMessage({
        type: 'snapshot',
        wave: new Float32Array(this.wavBuf),
        flash: flashCopy,
      });
    }

    return true;
  }
}

registerProcessor('warrenspectrum', WarrenspectrumProcessor);
