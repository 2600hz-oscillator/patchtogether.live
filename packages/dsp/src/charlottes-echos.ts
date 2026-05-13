// packages/dsp/src/charlottes-echos.ts
//
// CHARLOTTE'S ECHOS — destructive multi-head stereo delay.
//
// Architecture: one stereo ring buffer (1.5 s × 2 ch × 4 bytes = 576 KB,
// pre-allocated). Up to 16 read heads at any time. Heads spawn every
// `delaySamples` of write-time elapsed; each spawn captures the current
// (decay, pitchUp) snapshot so successive heads compound.
//
// Destructive stage: 12-bit crush + tanh. Applied per-head AND in the
// feedback path so artifacts compound over loops.
//
// Edge cases:
//   delay = 0       — clamped to 0.001 s (1 ms minimum, ~48 samples).
//   delay jumps     — handled organically: spawn-trigger uses current delay.
//   feedback = 1.0  — destruction loss prevents DC; we hard-clamp on write.
//
// Head fadeout: each alive head's `volume` decays exponentially per sample
// so it fades to ~5% over one delay cycle at decay=0.2 (classic tape feel).
// Without this, head 0's volume stayed at 1.0 forever and successive heads
// stacked at compounding gain — the wet sum at mix=1.0 ran away (peak ~3.8
// over 3s) and the audio-out master limiter choked it to silence, which
// the user reported as "zero audio at fully wet".

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

const BUFFER_SECONDS = 1.5;
const MAX_HEADS = 16;
const MIN_DELAY_S = 0.001;

interface Head {
  alive: boolean;
  // Read position in fractional samples — supports interpolation when
  // rate != 1 (pitchUp shifts).
  pos: number;
  rate: number;
  volume: number;
  // Spawn count at the time this head was born (debugging only).
  spawnIdx: number;
}

class CharlottesEchosProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Min 0.001 s (1 ms) is the explicit clamp from the spec.
      { name: 'delay',    defaultValue: 0.4, minValue: 0.001, maxValue: 1.5, automationRate: 'a-rate' as const },
      { name: 'feedback', defaultValue: 0.5, minValue: 0,     maxValue: 1,   automationRate: 'k-rate' as const },
      { name: 'decay',    defaultValue: 0.2, minValue: 0,     maxValue: 1,   automationRate: 'k-rate' as const },
      { name: 'pitchUp',  defaultValue: 0,   minValue: 0,     maxValue: 0.2, automationRate: 'k-rate' as const },
      { name: 'mix',      defaultValue: 0.5, minValue: 0,     maxValue: 1,   automationRate: 'k-rate' as const },
    ];
  }

  // Stereo ring buffer.
  private bufferLen: number;
  private bufL: Float32Array;
  private bufR: Float32Array;
  private writeIdx = 0;

  // Heads — fixed-capacity pool. `alive` flag indicates active.
  private heads: Head[] = [];
  // Sample counter since last spawn — when it hits delaySamples, we spawn.
  private samplesSinceSpawn = 0;
  // Monotonic spawn count for debugging + compound-power computation.
  private totalSpawns = 0;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.bufferLen = Math.max(1, Math.round(BUFFER_SECONDS * sampleRate));
    this.bufL = new Float32Array(this.bufferLen);
    this.bufR = new Float32Array(this.bufferLen);
    for (let i = 0; i < MAX_HEADS; i++) {
      this.heads.push({ alive: false, pos: 0, rate: 1, volume: 0, spawnIdx: 0 });
    }
  }

  /** Allocate a head from the pool, evicting FIFO if at cap. */
  private spawnHead(volume: number, rate: number): void {
    // Find a dead slot first.
    for (const h of this.heads) {
      if (!h.alive) {
        h.alive = true;
        h.pos = this.writeIdx;
        h.rate = rate;
        h.volume = volume;
        h.spawnIdx = this.totalSpawns;
        this.totalSpawns++;
        return;
      }
    }
    // FIFO eviction: replace the oldest (smallest spawnIdx).
    let oldestIdx = 0;
    let oldestSpawn = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.heads.length; i++) {
      if (this.heads[i]!.spawnIdx < oldestSpawn) {
        oldestSpawn = this.heads[i]!.spawnIdx;
        oldestIdx = i;
      }
    }
    const h = this.heads[oldestIdx]!;
    h.alive = true;
    h.pos = this.writeIdx;
    h.rate = rate;
    h.volume = volume;
    h.spawnIdx = this.totalSpawns;
    this.totalSpawns++;
  }

  /** Quantize to 12-bit grid and apply tanh saturation. */
  private destroy(x: number): number {
    const q = Math.floor(x * 2048 + 0.5) / 2048;
    return Math.tanh(q * 1.6);
  }

  /** Read a sample from a buffer at fractional position with linear interp. */
  private readBuf(buf: Float32Array, pos: number): number {
    // pos may be negative or >= bufferLen — wrap.
    const len = this.bufferLen;
    let p = pos % len;
    if (p < 0) p += len;
    const i0 = Math.floor(p);
    const i1 = (i0 + 1) % len;
    const frac = p - i0;
    return buf[i0]! * (1 - frac) + buf[i1]! * frac;
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const inL = inputs[0]?.[0] ?? null;
    const inR = inputs[1]?.[0] ?? inputs[0]?.[0] ?? null;
    const outL = outputs[0]?.[0];
    const outR = outputs[1]?.[0];
    if (!outL || !outR) return true;

    const blockLen = outL.length;
    const delayArr = parameters.delay;
    const feedback = Math.max(0, Math.min(1, parameters.feedback[0] ?? 0.5));
    const decay = Math.max(0, Math.min(1, parameters.decay[0] ?? 0.2));
    const pitchUp = Math.max(0, Math.min(0.2, parameters.pitchUp[0] ?? 0));
    const mix = Math.max(0, Math.min(1, parameters.mix[0] ?? 0.5));

    // If no heads alive yet, spawn the first one immediately so a single
    // input sample can produce a delayed echo on the next round-trip.
    if (this.totalSpawns === 0) {
      const v0 = Math.pow(1 - decay, 0); // = 1
      const r0 = Math.pow(1 + pitchUp, 0); // = 1
      this.spawnHead(v0, r0);
    }

    for (let i = 0; i < blockLen; i++) {
      const delaySec = Math.max(MIN_DELAY_S, delayArr.length > 1 ? (delayArr[i] ?? 0) : (delayArr[0] ?? 0));
      const delaySamples = delaySec * sampleRate;

      // Advance spawn counter; spawn a new head when we've crossed the delay.
      this.samplesSinceSpawn++;
      if (this.samplesSinceSpawn >= delaySamples) {
        this.samplesSinceSpawn = 0;
        const N = this.totalSpawns; // 0-indexed
        const volume = Math.pow(1 - decay, N);
        const rate = Math.pow(1 + pitchUp, N);
        this.spawnHead(volume, rate);
      }

      // Sum wet samples from all alive heads. Each head reads at the offset
      // (h.pos - delaySamples) — h.pos was initialized at writeIdx and walks
      // forward at h.rate per output sample, so the head reads `delaySamples`
      // behind its current position. Multiple heads simulate stacked taps
      // each with their own (volume, rate) snapshot from spawn time.
      //
      // Per-sample volume decay: head fades to `cycleAtten` over one full
      // delay cycle. At decay=0.2 that's ~0.29 per cycle (a gentle tape
      // tail); at decay=1.0 the head dies within a sample. Without this,
      // head 0 played forever at vol=1 and the wet sum ran away.
      const cycleAtten = Math.max(0.001, (1 - decay) * 0.3 + 0.05);
      const perSampleDecay = Math.pow(cycleAtten, 1 / Math.max(1, delaySamples));
      let wetL = 0;
      let wetR = 0;
      for (const h of this.heads) {
        if (!h.alive) continue;
        const rl = this.readBuf(this.bufL, h.pos - delaySamples);
        const rr = this.readBuf(this.bufR, h.pos - delaySamples);
        const sl = this.destroy(rl) * h.volume;
        const sr = this.destroy(rr) * h.volume;
        wetL += sl;
        wetR += sr;
        h.pos += h.rate;
        h.volume *= perSampleDecay;
        if (h.volume < 1e-5) h.alive = false;
      }

      const dryL = inL?.[i] ?? 0;
      const dryR = inR?.[i] ?? 0;

      // Feedback: write dry + (wet × feedback) into the buffer, with
      // destroy()-stage so artifacts compound on each lap.
      const writeL = this.destroy(dryL + wetL * feedback);
      const writeR = this.destroy(dryR + wetR * feedback);
      // Hard clamp: tanh saturates but with feedback=1.0 + DC input we want
      // a guaranteed cap.
      this.bufL[this.writeIdx] = Math.max(-1, Math.min(1, writeL));
      this.bufR[this.writeIdx] = Math.max(-1, Math.min(1, writeR));

      // Output: dry × (1 − mix) + wet × mix.
      outL[i] = dryL * (1 - mix) + wetL * mix;
      outR[i] = dryR * (1 - mix) + wetR * mix;

      this.writeIdx = (this.writeIdx + 1) % this.bufferLen;
    }

    return true;
  }
}

registerProcessor('charlottes-echos', CharlottesEchosProcessor);
