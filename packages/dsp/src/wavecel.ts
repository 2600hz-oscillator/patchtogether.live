// packages/dsp/src/wavecel.ts
//
// WAVECEL — stereo wavetable VCO with morph + spread + wavefolder.
//
// E352-format wavetable playback (256-sample frames). The host parses the
// WAV file (wavetable-parser.ts) and posts the frames as a flat Float32
// transfer to this worklet via { type: 'loadWavetable', frames: Array<Array>,
// sampleRate? } — Yjs-friendly plain-array wire format (recall the DX7 SYX
// proxy bug from PR-94: structuredClone over postMessage chokes on Yjs
// proxies, so the host always sends plain JS arrays).
//
// Spread: integer/continuous 1..5. At spread=N, N adjacent frames around
// the morph position are mixed with equal-power L/R panning — center frame
// equally on both sides, frames left of center weighted toward L, right of
// center toward R. spread=1 is mono on both channels.
//
// Wavefolder: symmetric foldback (`while y>1: y = 2-y` reflection),
// drive = 1 + amount*4. Bypass when amount <= 0.

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

const FRAME_SIZE = 256;
const C4_HZ = 261.626;

interface LoadMessage {
  type: 'loadWavetable';
  frames: number[][];
}
interface FrameStateRequest {
  type: 'requestFrames';
}

class WavecelProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'tune',   defaultValue: 0,   minValue: -36, maxValue: 36, automationRate: 'k-rate' as const },
      { name: 'fine',   defaultValue: 0,   minValue: -100, maxValue: 100, automationRate: 'k-rate' as const },
      { name: 'morph',  defaultValue: 0,   minValue: 0,   maxValue: 1,  automationRate: 'a-rate' as const },
      { name: 'spread', defaultValue: 1,   minValue: 1,   maxValue: 5,  automationRate: 'a-rate' as const },
      { name: 'fold',   defaultValue: 0,   minValue: 0,   maxValue: 1,  automationRate: 'a-rate' as const },
    ];
  }

  private frames: Float32Array[] = [];
  private phase = 0;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as LoadMessage | FrameStateRequest;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'loadWavetable') {
        if (!Array.isArray(m.frames) || m.frames.length === 0) {
          console.error('[wavecel] invalid loadWavetable: empty frames');
          return;
        }
        const next: Float32Array[] = [];
        for (let i = 0; i < m.frames.length; i++) {
          const src = m.frames[i];
          if (!src || src.length !== FRAME_SIZE) {
            console.error(`[wavecel] frame ${i} length ${src?.length} != ${FRAME_SIZE}`);
            return;
          }
          next.push(Float32Array.from(src));
        }
        this.frames = next;
      }
    };
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const outL = outputs[0]?.[0];
    const outR = outputs[1]?.[0];
    if (!outL || !outR) return true;

    if (this.frames.length === 0) {
      outL.fill(0);
      outR.fill(0);
      return true;
    }

    const pitchIn = inputs[0]?.[0];
    const fmIn = inputs[1]?.[0];
    const morphCv = inputs[2]?.[0];
    const spreadCv = inputs[3]?.[0];
    const foldCv = inputs[4]?.[0];

    const tune = parameters.tune[0] ?? 0;
    const fine = parameters.fine[0] ?? 0;
    const morphArr = parameters.morph;
    const spreadArr = parameters.spread;
    const foldArr = parameters.fold;

    const FC = this.frames.length;

    for (let i = 0; i < outL.length; i++) {
      const pitch = pitchIn ? pitchIn[i] : 0;
      const fm = fmIn ? fmIn[i] : 0;

      const morphKnob = morphArr.length > 1 ? morphArr[i] : morphArr[0];
      const spreadKnob = spreadArr.length > 1 ? spreadArr[i] : spreadArr[0];
      const foldKnob = foldArr.length > 1 ? foldArr[i] : foldArr[0];
      const mCv = morphCv ? morphCv[i] : 0;
      const sCv = spreadCv ? spreadCv[i] : 0;
      const fCv = foldCv ? foldCv[i] : 0;

      const morph = clamp01(morphKnob + mCv);
      // spread: linear cv blends across the 1..5 range (±1 = ±2 frames).
      const spread = clampRange(spreadKnob + sCv * 2, 1, 5);
      const foldAmt = clamp01(foldKnob + fCv);

      // Pitch.
      const semitones = pitch * 12 + tune + fine / 100 + fm * 12;
      let freq = C4_HZ * Math.pow(2, semitones / 12);
      if (freq < 1) freq = 1;
      else if (freq > sampleRate * 0.5) freq = sampleRate * 0.5;
      this.phase += freq / sampleRate;
      while (this.phase >= 1) this.phase -= 1;
      while (this.phase < 0) this.phase += 1;

      // Sample interpolation within a single frame (used by every spread
      // tap — they all share the same phase, just different frame index).
      const samplePos = this.phase * FRAME_SIZE;
      const sFloor = Math.floor(samplePos);
      const sFrac = samplePos - sFloor;
      const s1 = sFloor % FRAME_SIZE;
      const s2 = (sFloor + 1) % FRAME_SIZE;

      // Morph position → fractional frame index.
      const centerFrame = morph * (FC - 1);

      let l: number;
      let r: number;

      // Spread N taps, spaced 1 frame apart, centered on morph. spread=1
      // is mono-to-both-channels at unity; spread>1 uses equal-power
      // panning across taps + sqrt-of-weight normalization so RMS stays
      // roughly flat as spread crosses integer boundaries.
      const N = spread;
      const halfSpan = (N - 1) / 2;
      if (halfSpan === 0) {
        l = sampleFrame(this.frames, centerFrame, FC, s1, s2, sFrac);
        r = l;
      } else {
        let sumL = 0;
        let sumR = 0;
        let weightSum = 0;
        const tapCount = Math.max(1, Math.ceil(N));
        for (let t = 0; t < tapCount; t++) {
          const offset = (t - (tapCount - 1) / 2);
          if (Math.abs(offset) > halfSpan + 0.5) continue;
          const sample = sampleFrame(this.frames, centerFrame + offset, FC, s1, s2, sFrac);
          const nrm = offset / halfSpan;
          const panAngle = (Math.PI / 4) * (1 + clampRange(nrm, -1, 1));
          const lg = Math.cos(panAngle);
          const rg = Math.sin(panAngle);
          const edgeWeight = Math.max(0, Math.min(1, halfSpan + 0.5 - Math.abs(offset)));
          sumL += sample * lg * edgeWeight;
          sumR += sample * rg * edgeWeight;
          weightSum += edgeWeight;
        }
        const nrm = weightSum > 0 ? 1 / Math.sqrt(weightSum) : 0;
        l = sumL * nrm;
        r = sumR * nrm;
      }

      if (foldAmt > 0) {
        l = fold(l, foldAmt);
        r = fold(r, foldAmt);
      }

      outL[i] = l;
      outR[i] = r;
    }

    return true;
  }
}

function sampleFrame(
  frames: Float32Array[],
  frameFloat: number,
  FC: number,
  s1: number,
  s2: number,
  sFrac: number,
): number {
  const f1 = Math.max(0, Math.min(FC - 1, Math.floor(frameFloat)));
  const f2 = Math.max(0, Math.min(FC - 1, f1 + 1));
  const frameFrac = frameFloat - Math.floor(frameFloat);
  const a = frames[f1]!;
  const b = frames[f2]!;
  const va = a[s1]! + (a[s2]! - a[s1]!) * sFrac;
  const vb = b[s1]! + (b[s2]! - b[s1]!) * sFrac;
  return va + (vb - va) * frameFrac;
}

function fold(x: number, amount: number): number {
  if (amount <= 0) return x;
  const drive = 1 + amount * 4;
  let y = x * drive;
  let guard = 0;
  while ((y > 1 || y < -1) && guard < 32) {
    if (y > 1) y = 2 - y;
    else y = -2 - y;
    guard++;
  }
  return y;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampRange(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

registerProcessor('wavecel', WavecelProcessor);
