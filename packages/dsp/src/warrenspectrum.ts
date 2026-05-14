// packages/dsp/src/warrenspectrum.ts
//
// WARRENSPECTRUM — stereo 8-band resonator filterbank with vactrol-style
// ping excitation. Two tuning modes:
//   - 'log'  : fixed octave-spaced 80..10240 Hz (legacy spectral-EQ).
//   - 'harm' : harmonic partials f[i] = rootHz * (i+1), root selected via
//              the `root` k-rate AudioParam (MIDI note number).
// Q, spread, and bleed are also k-rate so the topology can morph live.
//
// Ping behavior: each band has its own gate input. Rising edge triggers a
// vactrol-style envelope (soft attack 10-30 ms with ±10% jitter, exp decay
// 100-800 ms via the pingDecay knob with ±10% jitter, soft-saturated via
// tanh). The ping fires not just the band itself but the adjacent two on
// each side with weights [1.0, 0.35, 0.12] scaled by the bleed param —
// the cluster rings as a group like a mechanical resonator bank.
//
// Excitation path: TWO injections into the bandpass input —
//   (1) fast click impulse (0.98/sample decay, ~1ms) on rising edge —
//       gives the initial transient/attack;
//   (2) envelope-modulated broadband noise — keeps exciting the bandpass
//       through the envelope's full 100-800ms decay so the band rings
//       audibly for the whole envelope (without this, Q=6 only rings ~3ms
//       past the click).
//
// Inputs (4):
//   0: in_l           (1 channel)
//   1: in_r           (1 channel)
//   2: pings_packed   (8 channels; ch n = band n+1 gate; plus the host
//                      ORs global_ping into all 8 channels)
//   3: returns_packed (8 channels; ch n = mono audio return for band n+1)
//
// Outputs (3):
//   0: out_l            (1 channel — stereo mix L)
//   1: out_r            (1 channel — stereo mix R)
//   2: per_band_packed  (8 channels — band 1..8 mono signals, pre-pan,
//                        post-envelope, post-level — for external sends)
//
// Return-mask: per-band booleans posted by the host as a 'returnMask'
// message when edges change. When mask[b]=true, that band's contribution
// to the stereo mix is the return signal (replace). When false, the
// internal filtered+enveloped signal is used.

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
const BLEED_BASE = [1.0, 0.35, 0.12] as const; // offsets 0, ±1, ±2

// Log-spaced (legacy spectral-EQ) center frequencies.
const LOG_CENTER_HZ = [80, 160, 320, 640, 1280, 2560, 5120, 10240] as const;

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function bandCenterHz(tuningMode: number, rootMidi: number, i: number): number {
  // tuningMode: 0 = log, 1 = harm
  if (tuningMode >= 0.5) {
    return midiToHz(rootMidi) * (i + 1);
  }
  return LOG_CENTER_HZ[i] ?? 0;
}

interface BiquadState {
  // RBJ biquad direct form II transposed
  b0: number; b1: number; b2: number;
  a1: number; a2: number;
  z1: number; z2: number;
}

function makeBiquadBpf(fc: number, q: number, sr: number): BiquadState {
  // Clamp fc to the Nyquist-safe band — high harmonics can exceed sr/2.
  const fcClamped = Math.max(20, Math.min(sr * 0.45, fc));
  const w0 = (2 * Math.PI * fcClamped) / sr;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const alpha = sinW / (2 * Math.max(0.5, q));
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

function refreshBiquad(state: BiquadState, fc: number, q: number, sr: number): void {
  // Recompute coefficients in place, preserving z1/z2 state so the filter
  // doesn't click when frequency/Q is modulated.
  const fcClamped = Math.max(20, Math.min(sr * 0.45, fc));
  const w0 = (2 * Math.PI * fcClamped) / sr;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const alpha = sinW / (2 * Math.max(0.5, q));
  const a0 = 1 + alpha;
  state.b0 = alpha / a0;
  state.b1 = 0;
  state.b2 = -alpha / a0;
  state.a1 = (-2 * cosW) / a0;
  state.a2 = (1 - alpha) / a0;
}

function processBiquad(state: BiquadState, x: number): number {
  // Direct form II transposed.
  const y = state.b0 * x + state.z1;
  state.z1 = state.b1 * x - state.a1 * y + state.z2;
  state.z2 = state.b2 * x - state.a2 * y;
  return y;
}

interface VactrolEnv {
  excitation: number;
  env: number;
  attackProgress: number;
  attackSamples: number;
  decayCoef: number;
  phase: 0 | 1 | 2;
  prevGate: number;
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

export function vactrolShape(env: number, drive: number): number {
  return Math.tanh(env * drive) / Math.tanh(drive);
}

export function bleedWeight(n: number, k: number, bleedScale: number): number {
  const d = Math.abs(n - k);
  if (d >= BLEED_BASE.length) return 0;
  // Distance 0 always returns 1.0 (the pinged band itself). Off-diagonal
  // weights scale with the bleed knob.
  if (d === 0) return 1.0;
  return (BLEED_BASE[d] ?? 0) * bleedScale;
}

export function applyPing(
  envs: VactrolEnv[],
  n: number,
  pingDecaySec: number,
  attackMsBase: number,
  bleedScale: number,
  sr: number,
  rand: () => number,
): void {
  for (let k = 0; k < envs.length; k++) {
    const w = bleedWeight(n, k, bleedScale);
    if (w === 0) continue;
    const e = envs[k]!;
    e.excitation = Math.min(1.5, e.excitation + w);
    const aJ = 1 + (rand() - 0.5) * 0.2;
    const dJ = 1 + (rand() - 0.5) * 0.2;
    const attackMs = attackMsBase * aJ;
    const decaySec = Math.max(0.01, pingDecaySec * dJ);
    e.attackSamples = Math.max(1, Math.round((attackMs / 1000) * sr));
    e.attackProgress = 0;
    e.decayCoef = Math.exp(-1 / (decaySec * sr));
    e.phase = 1;
    e.click = Math.max(e.click, w * 0.8);
  }
}

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

export type { VactrolEnv };
export { NUM_BANDS, BLEED_BASE, LOG_CENTER_HZ };

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
    descs.push({ name: 'master',     defaultValue: 1.0, minValue: 0, maxValue: 2,  automationRate: 'a-rate' });
    descs.push({ name: 'pingDecay',  defaultValue: 0.5, minValue: 0, maxValue: 1,  automationRate: 'k-rate' });
    descs.push({ name: 'tuningMode', defaultValue: 0,   minValue: 0, maxValue: 1,  automationRate: 'k-rate' });
    descs.push({ name: 'root',       defaultValue: 60,  minValue: 24, maxValue: 108, automationRate: 'k-rate' });
    descs.push({ name: 'q',          defaultValue: 6,   minValue: 1, maxValue: 40, automationRate: 'k-rate' });
    descs.push({ name: 'spread',     defaultValue: 0,   minValue: 0, maxValue: 1,  automationRate: 'k-rate' });
    descs.push({ name: 'bleed',      defaultValue: 1,   minValue: 0, maxValue: 1,  automationRate: 'k-rate' });
    return descs;
  }

  private bpfL: BiquadState[] = [];
  private bpfR: BiquadState[] = [];
  private envs: VactrolEnv[] = [];
  /** Last-seen values for change detection — avoids per-block coef refresh. */
  private lastMode = -1;
  private lastRoot = -1;
  private lastQ = -1;
  /** Cached pan gains per band, recomputed when `spread` changes. */
  private panL = new Float32Array(NUM_BANDS).fill(Math.SQRT1_2);
  private panR = new Float32Array(NUM_BANDS).fill(Math.SQRT1_2);
  private lastSpread = -1;
  /** Per-band "use external return" mask, set via 'returnMask' message. */
  private returnPatched = new Array<boolean>(NUM_BANDS).fill(false);

  private wavBuf = new Float32Array(256);
  private wavWriteIdx = 0;
  private framesSincePost = 0;
  private bandFlash = new Float32Array(NUM_BANDS);

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    for (let i = 0; i < NUM_BANDS; i++) {
      this.bpfL.push(makeBiquadBpf(LOG_CENTER_HZ[i]!, 6.0, sampleRate));
      this.bpfR.push(makeBiquadBpf(LOG_CENTER_HZ[i]!, 6.0, sampleRate));
      this.envs.push(makeEnv());
    }
    this.port.onmessage = (ev: MessageEvent): void => {
      const data = ev.data as { type?: string; mask?: boolean[] } | null;
      if (data && data.type === 'returnMask' && Array.isArray(data.mask)) {
        for (let b = 0; b < NUM_BANDS; b++) {
          this.returnPatched[b] = !!data.mask[b];
        }
      }
    };
  }

  private rand(): number {
    return Math.random();
  }

  private refreshPan(spread: number): void {
    if (spread === this.lastSpread) return;
    this.lastSpread = spread;
    const n = NUM_BANDS;
    const center = (n - 1) / 2;
    for (let i = 0; i < n; i++) {
      const dist = Math.abs(i - center) / center;
      const sign = i % 2 === 0 ? -1 : 1;
      const p = Math.max(-1, Math.min(1, sign * dist * spread));
      const theta = ((p + 1) / 2) * (Math.PI / 2);
      this.panL[i] = Math.cos(theta);
      this.panR[i] = Math.sin(theta);
    }
  }

  private refreshFilters(tuningMode: number, rootMidi: number, q: number): void {
    if (tuningMode === this.lastMode && rootMidi === this.lastRoot && q === this.lastQ) return;
    this.lastMode = tuningMode;
    this.lastRoot = rootMidi;
    this.lastQ = q;
    for (let b = 0; b < NUM_BANDS; b++) {
      const fc = bandCenterHz(tuningMode, rootMidi, b);
      refreshBiquad(this.bpfL[b]!, fc, q, sampleRate);
      refreshBiquad(this.bpfR[b]!, fc, q, sampleRate);
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const outL = outputs[0]?.[0];
    const outR = outputs[1]?.[0];
    if (!outL || !outR) return true;

    const outBands = outputs[2]; // 8-channel per-band out (optional)

    const inL = inputs[0]?.[0];
    const inR = inputs[1]?.[0];
    const pingsInput = inputs[2];
    const returnsInput = inputs[3];

    const pingDecayKnob = parameters.pingDecay?.[0] ?? 0.5;
    const pingDecaySec = 0.1 + pingDecayKnob * 0.7;
    const ATTACK_MS_BASE = 20;
    const DRIVE = 4.0;
    const CLICK_DRIVE = 8.0;
    const NOISE_DRIVE = 1.5;

    const tuningMode = parameters.tuningMode?.[0] ?? 0;
    const rootMidi = parameters.root?.[0] ?? 60;
    const qVal = parameters.q?.[0] ?? 6;
    const spreadVal = parameters.spread?.[0] ?? 0;
    const bleedVal = parameters.bleed?.[0] ?? 1;

    this.refreshFilters(tuningMode, rootMidi, qVal);
    this.refreshPan(spreadVal);

    const masterArr = parameters.master ?? new Float32Array([1]);
    const blockSize = outL.length;

    if (pingsInput) {
      for (let b = 0; b < NUM_BANDS; b++) {
        const ch = pingsInput[b];
        if (!ch) continue;
        const gate = ch[0] ?? 0;
        const prev = this.envs[b]!.prevGate;
        if (gate >= 0.5 && prev < 0.5) {
          applyPing(this.envs, b, pingDecaySec, ATTACK_MS_BASE, bleedVal, sampleRate, () => this.rand());
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
        const envOut = stepEnv(e, DRIVE);

        const clickAmp = e.click * CLICK_DRIVE;
        e.click = e.click * 0.98;
        if (e.click < 1e-5) e.click = 0;

        const noise = (Math.random() * 2 - 1) * envOut * NOISE_DRIVE;
        const excitation = clickAmp + noise;

        const lvlArr = parameters[`level${b + 1}`];
        const lvl = lvlArr ? (lvlArr.length > 1 ? lvlArr[i]! : lvlArr[0]!) : 1.0;
        const bandGain = lvl * (1 + envOut * 0.5);

        const filteredL = processBiquad(this.bpfL[b]!, xL + excitation) * bandGain;
        const filteredR = processBiquad(this.bpfR[b]!, xR + excitation) * bandGain;

        // Per-band mono send: pre-pan, post-envelope, post-level so the
        // external send carries the same band signal the internal mix
        // uses (minus pan).
        const bandMono = (filteredL + filteredR) * 0.5;
        const bandOutCh = outBands?.[b];
        if (bandOutCh) bandOutCh[i] = bandMono;

        // Stereo mix contribution: if a band return is patched, use the
        // external return (post-effect) for the mix; otherwise use the
        // internal band signal. Pan via equal-power gains derived from
        // the spread param.
        const mixMono = (this.returnPatched[b] && returnsInput?.[b])
          ? (returnsInput[b]![i] ?? 0)
          : bandMono;
        sumL += mixMono * this.panL[b]!;
        sumR += mixMono * this.panR[b]!;
      }

      const master = masterArr.length > 1 ? masterArr[i]! : masterArr[0]!;
      outL[i] = sumL * master * 0.25;
      outR[i] = sumR * master * 0.25;

      this.wavBuf[this.wavWriteIdx] = xL;
      this.wavWriteIdx = (this.wavWriteIdx + 1) % this.wavBuf.length;
    }

    this.framesSincePost += blockSize;
    const POST_INTERVAL_SAMPLES = sampleRate / 30;
    if (this.framesSincePost >= POST_INTERVAL_SAMPLES) {
      this.framesSincePost = 0;
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
