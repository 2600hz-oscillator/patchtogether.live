// packages/dsp/src/cocoadelay-core.ts
//
// Shared per-instance DSP core for Cocoa Delay. The AudioWorklet processor
// (cocoadelay.ts) wraps ONE core; CHARLOTTE'S ECHOS (charlottes-echos.ts)
// chains FOUR cores in series. Keeping the math here means both stay
// bit-identical — a CHARLOTTE stage IS a COCOA DELAY.
//
// Clean-room TypeScript translation of Tilde Murray's Cocoa Delay (GPL-3.0,
// see ../cocoa-delay). Every block — DELAY (Hermite tape read), LFO + DRIFT
// time modulation, FEEDBACK + stereo offset + pan modes, DUCKING, in-loop
// multi-mode FILTER, stateful DRIVE — is preserved.

const PI = Math.PI;
const TAPE_LENGTH_S = 10;

// Tempo-sync division → beats. Index 0 = Off (free ms); the rest are
// multiples of one beat (= one measured clock period).
export const SYNC_BEATS: number[] = [
  0, 4, 3, 2, 4 / 3, 3 / 2, 1, 2 / 3, 3 / 4, 1 / 2, 1 / 3,
  3 / 8, 1 / 4, 1 / 6, 3 / 16, 1 / 8, 1 / 12, 3 / 32, 1 / 16, 1 / 24,
];

// xorshift PRNG — same algorithm as the original Util.h so DRIFT matches.
export class Xorshift {
  private x = 123456789 >>> 0;
  private y = 362436069 >>> 0;
  private z = 521288629 >>> 0;
  next(): number {
    let t: number;
    this.x ^= (this.x << 16) >>> 0;
    this.x ^= this.x >>> 5;
    this.x ^= (this.x << 1) >>> 0;
    this.x = this.x >>> 0;
    t = this.x;
    this.x = this.y;
    this.y = this.z;
    this.z = (t ^ this.x ^ this.y) >>> 0;
    return -1.0 + (this.z / 0xffffffff) * 2.0;
  }
}

class OnePole {
  private a = 0;
  reset() { this.a = 0; }
  process(dt: number, input: number, cutoff: number, highPass: boolean): number {
    let c = cutoff * 44100 * dt;
    if (c > 1) c = 1;
    this.a += (input - this.a) * c;
    return highPass ? input - this.a : this.a;
  }
}
class TwoPole {
  private a = 0;
  private b = 0;
  reset() { this.a = 0; this.b = 0; }
  process(dt: number, input: number, cutoff: number, highPass: boolean): number {
    let c = cutoff * 44100 * dt;
    if (c > 1) c = 1;
    this.a += (input - this.a) * c;
    this.b += (this.a - this.b) * c;
    return highPass ? input - this.b : this.b;
  }
}
class FourPole {
  private a = 0;
  private b = 0;
  private c = 0;
  private d = 0;
  reset() { this.a = this.b = this.c = this.d = 0; }
  process(dt: number, input: number, cutoff: number, highPass: boolean): number {
    let c = cutoff * 44100 * dt;
    if (c > 1) c = 1;
    this.a += (input - this.a) * c;
    this.b += (this.a - this.b) * c;
    this.c += (this.b - this.c) * c;
    this.d += (this.c - this.d) * c;
    return highPass ? input - this.d : this.d;
  }
}
class StateVariable {
  private band = 0;
  private low = 0;
  reset() { this.band = 0; this.low = 0; }
  process(dt: number, input: number, cutoff: number, highPass: boolean): number {
    const x = input * 0.9;
    let f = 2 * Math.sin(PI * (cutoff * 8000.0) * dt);
    if (f > 1) f = 1; else if (f < 0) f = 0;
    const high = x - (this.low + this.band);
    this.band += f * high;
    this.low += f * this.band;
    return highPass ? high : this.low;
  }
}

type FilterCore = OnePole | TwoPole | FourPole | StateVariable;

class MultiFilter {
  private cores: FilterCore[] = [new OnePole(), new TwoPole(), new FourPole(), new StateVariable()];
  private currentMode = 0;
  private previousMode = -1;
  private crossfading = false;
  private mix = 1.0;
  setMode(m: number): void {
    if (m !== this.currentMode) {
      this.previousMode = this.currentMode;
      this.currentMode = m;
      this.crossfading = true;
      this.mix = 0.0;
    }
  }
  process(dt: number, input: number, cutoff: number, highPass: boolean): number {
    if (!this.crossfading) {
      return this.cores[this.currentMode]!.process(dt, input, cutoff, highPass);
    }
    this.mix += 100.0 * dt;
    if (this.mix >= 1.0) {
      this.mix = 1.0;
      this.crossfading = false;
      if (this.previousMode >= 0) this.cores[this.previousMode]!.reset();
    }
    const prev = this.previousMode >= 0
      ? this.cores[this.previousMode]!.process(dt, input, cutoff, highPass)
      : 0;
    const cur = this.cores[this.currentMode]!.process(dt, input, cutoff, highPass);
    return prev * (1.0 - this.mix) + cur * this.mix;
  }
}

class StatefulDrive {
  private previous = 0;
  process(input: number, amount: number): number {
    const driven = input === 0 ? 0 : Math.sin(input * input) / input;
    const mix = Math.abs(this.previous + driven) * 0.5 * amount;
    this.previous = driven;
    return input * (1.0 - mix) + driven * mix;
  }
}

function hermite(x: number, y0: number, y1: number, y2: number, y3: number): number {
  const c0 = y1;
  const c1 = 0.5 * (y2 - y0);
  const c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
  const c3 = 1.5 * (y1 - y2) + 0.5 * (y3 - y0);
  return ((c3 * x + c2) * x + c1) * x + c0;
}
function panL(inL: number, inR: number, angle: number): number {
  return inL * Math.cos(angle) - inR * Math.sin(angle);
}
function panR(inL: number, inR: number, angle: number): number {
  return inL * Math.sin(angle) + inR * Math.cos(angle);
}

/** Per-sample settings driving the core. All values pre-resolved (knob+CV). */
export interface CocoaSettings {
  delayTime: number; // free-running seconds (used when tempoSync === 0)
  tempoSync: number; // 0 = off, else SYNC_BEATS index
  lfoAmount: number;
  lfoFrequency: number;
  driftAmount: number;
  driftSpeed: number;
  feedback: number;
  stereoOffset: number;
  panMode: number; // 0 static, 1 ping-pong, 2 circular
  pan: number;
  duckAmount: number;
  duckAttack: number;
  duckRelease: number;
  filterMode: number; // 0..3
  lowCut: number;
  highCut: number;
  driveGain: number;
  driveMix: number;
  driveCutoff: number;
  driveIterations: number;
  dryVolume: number;
  wetVolume: number;
}

/** One Cocoa Delay engine — holds its own tape buffer + modulation state. */
export class CocoaDelayCore {
  private dt: number;
  private bufLen: number;
  private bufL: Float32Array;
  private bufR: Float32Array;
  private writePosition = 0;
  private readPositionL = 0;
  private readPositionR = 0;
  private warmedUp = false;

  private currentPanMode = 0;
  private parameterChangeVolume = 1.0;
  private stationaryPanAmount = 0.0;
  private circularPanAmount = 0.0;

  private lpL = new MultiFilter();
  private lpR = new MultiFilter();
  private hpL = new MultiFilter();
  private hpR = new MultiFilter();
  private currentFilterMode = 0;

  private driveL = new StatefulDrive();
  private driveR = new StatefulDrive();
  private driveFilterL = new TwoPole();
  private driveFilterR = new TwoPole();

  private duckFollower = 0.0;
  private lfoPhase = 0.0;
  private driftVelocity = 0.0;
  private driftPhase = 0.0;
  private rng: Xorshift;

  // clock-period measurement (samples between rising edges)
  private clockSamplesSinceEdge = 0;
  private clockPeriodSamples = 0; // 0 = no clock yet
  private clockSeenEdges = 0;

  // outputs of the last processed sample
  outL = 0;
  outR = 0;

  /** `seed` lets chained instances diverge their DRIFT noise. */
  constructor(sampleRate: number, tapeLengthS = TAPE_LENGTH_S, seed = 0) {
    this.dt = 1.0 / sampleRate;
    this.bufLen = Math.max(1, Math.round(sampleRate * tapeLengthS));
    this.bufL = new Float32Array(this.bufLen);
    this.bufR = new Float32Array(this.bufLen);
    this.rng = new Xorshift();
    for (let i = 0; i < seed * 7; i++) this.rng.next();
  }

  /** Advance the clock-period estimate. Call once per sample BEFORE
   *  processSample if you want sync-locked timing; pass the gate value. */
  feedClock(gateValue: number, prevGateValue: number): void {
    this.clockSamplesSinceEdge++;
    if (prevGateValue < 0.5 && gateValue >= 0.5) {
      if (this.clockSeenEdges > 0 && this.clockSamplesSinceEdge > 1) {
        this.clockPeriodSamples = this.clockSamplesSinceEdge;
      }
      this.clockSamplesSinceEdge = 0;
      this.clockSeenEdges++;
    }
  }

  setFilterMode(mode: number): void {
    if (mode !== this.currentFilterMode) {
      this.currentFilterMode = mode;
      this.lpL.setMode(mode);
      this.lpR.setMode(mode);
      this.hpL.setMode(mode);
      this.hpR.setMode(mode);
    }
  }

  private baseDelayTime(p: CocoaSettings): number {
    const sync = Math.round(p.tempoSync);
    if (sync <= 0 || sync >= SYNC_BEATS.length || this.clockPeriodSamples <= 0) {
      return p.delayTime;
    }
    const beatLengthS = this.clockPeriodSamples * this.dt;
    return beatLengthS * (SYNC_BEATS[sync] as number);
  }

  private modulatedDelayTime(p: CocoaSettings): number {
    let t = this.baseDelayTime(p);
    if (p.lfoAmount !== 0) t = Math.pow(t, 1.0 + p.lfoAmount * Math.sin(this.lfoPhase * 2 * PI));
    if (p.driftAmount !== 0) t = Math.pow(t, 1.0 + p.driftAmount * Math.sin(this.driftPhase));
    return t;
  }

  private targetReadPositions(p: CocoaSettings, sampleRate: number): [number, number] {
    const offset = p.stereoOffset * 0.5;
    const baseTime = this.modulatedDelayTime(p);
    return [Math.pow(baseTime, 1.0 + offset) * sampleRate, Math.pow(baseTime, 1.0 - offset) * sampleRate];
  }

  private getSample(buf: Float32Array, position: number): number {
    const len = this.bufLen;
    const wrap = (k: number) => {
      let r = k % len;
      if (r < 0) r += len;
      return r;
    };
    const p0 = wrap(Math.floor(position) - 1);
    const p1 = wrap(Math.floor(position));
    const p2 = wrap(Math.ceil(position));
    const p3 = wrap(Math.ceil(position) + 1);
    const x = position - Math.floor(position);
    return hermite(x, buf[p0]!, buf[p1]!, buf[p2]!, buf[p3]!);
  }

  /** Process one stereo sample. Writes outL/outR and returns outL. */
  processSample(p: CocoaSettings, dl: number, dr: number, sampleRate: number): void {
    const dt = this.dt;
    this.setFilterMode(Math.round(p.filterMode));

    if (!this.warmedUp) {
      const [tl, tr] = this.targetReadPositions(p, sampleRate);
      this.readPositionL = tl;
      this.readPositionR = tr;
      this.warmedUp = true;
    }

    // pan-mode crossfade + pan-amount smoothing
    const targetPanMode = Math.round(p.panMode);
    if (this.currentPanMode !== targetPanMode) {
      this.parameterChangeVolume -= 100.0 * dt;
      if (this.parameterChangeVolume <= 0.0) {
        this.parameterChangeVolume = 0.0;
        this.currentPanMode = targetPanMode;
      }
    } else if (this.parameterChangeVolume < 1.0) {
      this.parameterChangeVolume += 100.0 * dt;
      if (this.parameterChangeVolume > 1.0) this.parameterChangeVolume = 1.0;
    }
    const stationaryTarget =
      this.currentPanMode === 0 || this.currentPanMode === 1 ? p.pan : 0.0;
    this.stationaryPanAmount += (stationaryTarget - this.stationaryPanAmount) * 100.0 * dt;
    const circularTarget = this.currentPanMode === 2 ? p.pan : 0.0;
    this.circularPanAmount += (circularTarget - this.circularPanAmount) * 100.0 * dt;

    // read positions (eased toward target)
    const [targL, targR] = this.targetReadPositions(p, sampleRate);
    this.readPositionL += (targL - this.readPositionL) * 10.0 * dt;
    this.readPositionR += (targR - this.readPositionR) * 10.0 * dt;

    // ducking follower (sidechain on dry sum)
    {
      const inputSum = dl + dr;
      const speed = this.duckFollower < Math.abs(inputSum) ? p.duckAttack : p.duckRelease;
      this.duckFollower += (Math.abs(inputSum) - this.duckFollower) * speed * dt;
    }

    // LFO + drift advance
    this.lfoPhase += p.lfoFrequency * dt;
    while (this.lfoPhase > 1.0) this.lfoPhase -= 1.0;
    this.driftVelocity += this.rng.next() * 10000.0 * p.driftSpeed * dt;
    this.driftVelocity -= this.driftVelocity * 2.0 * Math.sqrt(p.driftSpeed) * dt;
    this.driftPhase += this.driftVelocity * dt;

    // read from tape
    let oL = this.getSample(this.bufL, this.writePosition - this.readPositionL);
    let oR = this.getSample(this.bufR, this.writePosition - this.readPositionR);

    // circular panning
    {
      const cL = panL(oL, oR, this.circularPanAmount);
      const cR = panR(oL, oR, this.circularPanAmount);
      oL = cL;
      oR = cR;
    }

    // filters (LP then HP)
    oL = this.lpL.process(dt, oL, p.lowCut, false);
    oR = this.lpR.process(dt, oR, p.lowCut, false);
    oL = this.hpL.process(dt, oL, p.highCut, true);
    oR = this.hpR.process(dt, oR, p.highCut, true);

    // drive
    if (p.driveGain > 0) {
      const iters = Math.round(p.driveIterations);
      for (let i = 0; i < iters; i++) {
        oL = this.driveL.process(oL * p.driveGain, p.driveMix) / p.driveGain;
        oR = this.driveR.process(oR * p.driveGain, p.driveMix) / p.driveGain;
        oL = this.driveFilterL.process(dt, oL, p.driveCutoff, false);
        oR = this.driveFilterR.process(dt, oR, p.driveCutoff, false);
      }
    }

    // write to tape (feedback + input + panning + ping-pong)
    {
      let writeL = dl;
      let writeR = dr;
      const pL = panL(writeL, writeR, this.stationaryPanAmount * 0.5);
      const pR = panR(writeL, writeR, this.stationaryPanAmount * 0.5);
      writeL = pL;
      writeR = pR;
      writeL += oL * p.feedback;
      writeR += oR * p.feedback;
      if (this.currentPanMode === 1) {
        this.bufL[this.writePosition] = writeR * this.parameterChangeVolume;
        this.bufR[this.writePosition] = writeL * this.parameterChangeVolume;
      } else {
        this.bufL[this.writePosition] = writeL * this.parameterChangeVolume;
        this.bufR[this.writePosition] = writeR * this.parameterChangeVolume;
      }
    }
    this.writePosition = (this.writePosition + 1) % this.bufLen;

    // output (dry + ducked wet)
    let duckValue = p.duckAmount * this.duckFollower;
    if (duckValue > 1.0) duckValue = 1.0;
    const wet = p.wetVolume * (1.0 - duckValue);
    this.outL = dl * p.dryVolume + oL * wet;
    this.outR = dr * p.dryVolume + oR * wet;
  }
}
