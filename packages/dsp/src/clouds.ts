// packages/dsp/src/clouds.ts
//
// CLOUDS — granular texture processor, after Émilie Gillet's "Clouds"
// (Mutable Instruments). The original C++ lives at:
//   eurorack/clouds/dsp/granular_processor.{h,cc}
//   eurorack/clouds/dsp/granular_sample_player.h
//   eurorack/clouds/dsp/grain.h
// and is MIT-licensed (Copyright 2014 Émilie Gillet) — the same license as
// patchtogether.live. The header notice from the original is reproduced
// below for attribution. This is a clean-room re-implementation in pure
// TypeScript: it follows the *algorithm shape* (ring buffer + overlap-add
// grain cloud + dry/wet) rather than literal numerical fidelity. None of
// pichenettes' STM32-specific lookup tables, μ-law buffer packing, or
// sample-rate-converted downsampling crossed over.
//
// ----------------------------------------------------------------------------
// Copyright 2014 Émilie Gillet.
//
// Author: Émilie Gillet (emilie.o.gillet@gmail.com)
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the "Software"),
// to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense,
// and/or sell copies of the Software, and to permit persons to whom the
// Software is furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
// ----------------------------------------------------------------------------
//
// First-slice scope (this PR):
//   - GRANULAR mode only (mandatory headline mode). STRETCH / LOOPING-DELAY /
//     SPECTRAL deferred to follow-up — see PR body.
//   - 6 macro knobs (Position, Size, Pitch, Density, Texture, Blend).
//   - Stereo audio in / stereo audio out.
//   - V/oct on pitch input (sums with the Pitch knob), 1 V = 1 octave.
//   - Freeze: stop writing to the buffer (loop the captured texture).
//   - 6 CV inputs (one per knob) wired as AudioParam fast paths.
//
// Algorithm shape:
//   - 2.0-second stereo capture ring buffer (Float32 per channel — simpler
//     than the original's μ-law / 16-bit modes; the modular host has
//     gigabytes of RAM rather than 64 KB SRAM).
//   - Up to 24 simultaneous grains (vs 40/64 in the original — perceptual
//     ceiling for the texture at typical density settings).
//   - Each grain reads from a sample-accurate fractional position in the
//     ring buffer at a configurable pitch ratio, with an envelope window
//     (rectangular → triangular → Hann morph via the Texture macro).
//   - Density spawns grains at a deterministic rate.
//   - Output is the overlap-add sum of all active grains, normalised by
//     √(active count).
//   - Dry/wet crossfade at the end (Blend).
//   - fillLevel tracking: at startup the capture buffer is silent; we
//     track how many real samples have been written so newly-spawned
//     grains read from the actually-filled portion rather than reading
//     pre-warmup zeros.

const BUFFER_SECONDS = 2.0;
const MAX_GRAINS = 24;

// ── THE GRAIN LENGTH LAW, AND THE CLAMP THAT MUST NOT CONTRADICT IT ─────────
//
// SIZE maps exponentially onto a grain length:
//   ms = GRAIN_MIN_MS · (GRAIN_MAX_MS / GRAIN_MIN_MS)^size
// and the result is then hard-limited to GRAIN_CAP_FRACTION of the ring, so
// POSITION keeps somewhere to travel: `headroom = availableHistory − safeLen`
// goes to zero as the grain approaches the whole buffer, and a grain longer
// than the ring would read through the write head into its own future.
//
// ⚠ THOSE TWO NUMBERS USED TO DISAGREE, AND THE DISAGREEMENT WAS A DEAD ZONE.
// The law asked for up to 1500 ms while the clamp allowed 0.4 · 2.0 s = 800 ms,
// so every SIZE above log(800/60)/log(25) = 0.804744 produced the SAME 800 ms
// grain. MEASURED on this worklet (art/scenarios/clouds/size-travel.test.ts):
// the top 19.50 % of SIZE rendered BIT-IDENTICAL output — and that plateau is a
// defect rather than arithmetic, because the `Math.floor` quantisation floor
// everywhere else on the dial is Δsize ≈ 6e-6…2.7e-5, i.e. the dead band was
// ~10⁴× wider than anything the flooring explains.
//
// THE FIX IS TO MAKE THE CEILING THE LAW'S OWN TOP. `GRAIN_CAP_FRACTION` stays
// the physical guard (it is what POSITION's travel is carved out of) and
// `GRAIN_MAX_MS` is DERIVED from it, so the clamp below is a safety net that
// provably never binds and the two can never drift apart again. 0.75 preserves
// the 1500 ms the law always declared and leaves POSITION 0.5 s of tape at the
// longest grain.
const GRAIN_MIN_MS = 60;
const GRAIN_CAP_FRACTION = 0.75;
const GRAIN_MAX_MS = BUFFER_SECONDS * GRAIN_CAP_FRACTION * 1000; // 1500 ms

interface Grain {
  active: boolean;
  readPos: number;
  pitchRatio: number;
  age: number;
  length: number;
  gainL: number;
  gainR: number;
}

class LcgRng {
  state: number;
  constructor(seed: number) {
    this.state = seed | 0;
    if (this.state === 0) this.state = 1;
  }
  next(): number {
    this.state = Math.imul(this.state, 16807) | 0;
    return (this.state & 0x7fffffff) / 0x7fffffff;
  }
}

function grainEnvelope(phase: number, texture: number): number {
  if (phase < 0 || phase >= 1) return 0;
  const rect = 1;
  const tri = 1 - Math.abs(2 * phase - 1);
  const hann = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
  if (texture < 0.5) {
    const t = texture * 2;
    return rect * (1 - t) + tri * t;
  }
  const t = (texture - 0.5) * 2;
  return tri * (1 - t) + hann * t;
}

function readBufferLerp(buf: Float32Array, pos: number): number {
  const len = buf.length;
  let p = pos - Math.floor(pos / len) * len;
  const i0 = Math.floor(p);
  const i1 = i0 + 1 === len ? 0 : i0 + 1;
  const frac = p - i0;
  return buf[i0]! * (1 - frac) + buf[i1]! * frac;
}

class GranularEngine {
  bufL: Float32Array;
  bufR: Float32Array;
  writeHead = 0;
  bufLen: number;
  fillLevel = 0;
  grains: Grain[] = [];
  spawnPhasor = 0;
  rng = new LcgRng(0xc0ffee);

  constructor(sr: number) {
    this.bufLen = Math.max(2, Math.floor(sr * BUFFER_SECONDS));
    this.bufL = new Float32Array(this.bufLen);
    this.bufR = new Float32Array(this.bufLen);
    for (let i = 0; i < MAX_GRAINS; i++) {
      this.grains.push({
        active: false, readPos: 0, pitchRatio: 1, age: 0, length: 0,
        gainL: 0.7, gainR: 0.7,
      });
    }
  }

  reset(): void {
    for (let i = 0; i < this.bufLen; i++) { this.bufL[i] = 0; this.bufR[i] = 0; }
    this.writeHead = 0;
    this.fillLevel = 0;
    this.spawnPhasor = 0;
    for (const g of this.grains) { g.active = false; g.age = 0; }
  }

  private findFreeGrain(): number {
    for (let i = 0; i < this.grains.length; i++) {
      if (!this.grains[i]!.active) return i;
    }
    return -1;
  }

  private spawnGrain(position: number, size: number, pitchRatio: number, sr: number): void {
    const idx = this.findFreeGrain();
    if (idx < 0) return;
    const g = this.grains[idx]!;
    const ms = GRAIN_MIN_MS * Math.pow(GRAIN_MAX_MS / GRAIN_MIN_MS, size);
    const lengthSamples = Math.max(8, Math.floor((ms / 1000) * sr));
    // NON-BINDING BY CONSTRUCTION — see the constants above. Kept as a guard so
    // a future BUFFER_SECONDS / fraction edit cannot produce a grain longer than
    // the ring; asserted never to bind in art/scenarios/clouds/size-travel.test.ts.
    const safeLen = Math.min(lengthSamples, Math.floor(this.bufLen * GRAIN_CAP_FRACTION));
    g.length = safeLen;
    g.age = 0;
    const availableHistory = Math.max(safeLen + 1, Math.min(this.fillLevel, this.bufLen));
    const headroom = Math.max(0, availableHistory - safeLen);
    const offset = safeLen + position * headroom;
    g.readPos = this.writeHead - offset;
    g.pitchRatio = pitchRatio;
    const pan = 0.3 + this.rng.next() * 0.4;
    g.gainL = Math.cos(pan * Math.PI * 0.5);
    g.gainR = Math.sin(pan * Math.PI * 0.5);
    g.active = true;
  }

  tick(
    inL: number, inR: number,
    position: number, size: number, pitchSemitones: number,
    density: number, texture: number, blend: number,
    freeze: boolean,
    sr: number,
  ): [number, number] {
    if (!freeze) {
      this.bufL[this.writeHead] = inL;
      this.bufR[this.writeHead] = inR;
      if (this.fillLevel < this.bufLen) this.fillLevel++;
    }
    const clampedSemis = Math.max(-24, Math.min(24, pitchSemitones));
    const pitchRatio = Math.pow(2, clampedSemis / 12);

    const minIntervalSamples = sr / 1200;
    const maxIntervalSamples = sr / 6;
    const interval = maxIntervalSamples * Math.pow(minIntervalSamples / maxIntervalSamples, density);
    this.spawnPhasor += 1;
    if (this.spawnPhasor >= interval) {
      this.spawnPhasor -= interval;
      this.spawnGrain(position, size, pitchRatio, sr);
    }

    let wetL = 0;
    let wetR = 0;
    let activeCount = 0;
    for (let i = 0; i < this.grains.length; i++) {
      const g = this.grains[i]!;
      if (!g.active) continue;
      const phase = g.age / g.length;
      const env = grainEnvelope(phase, texture);
      const sL = readBufferLerp(this.bufL, g.readPos);
      const sR = readBufferLerp(this.bufR, g.readPos);
      wetL += sL * env * g.gainL;
      wetR += sR * env * g.gainR;
      g.readPos += g.pitchRatio;
      g.age += 1;
      activeCount++;
      if (g.age >= g.length) g.active = false;
    }
    if (activeCount > 1) {
      const norm = 1 / Math.sqrt(activeCount);
      wetL *= norm;
      wetR *= norm;
    }
    wetL *= 1.4;
    wetR *= 1.4;
    wetL = Math.tanh(wetL);
    wetR = Math.tanh(wetR);

    const outL = inL * (1 - blend) + wetL * blend;
    const outR = inR * (1 - blend) + wetR * blend;
    this.writeHead = (this.writeHead + 1) % this.bufLen;
    return [outL, outR];
  }
}

class CloudsProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'position', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'size',     defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'pitch',    defaultValue: 0,   minValue: -24, maxValue: 24, automationRate: 'k-rate' as const },
      { name: 'density',  defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'texture',  defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'blend',    defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'freeze',   defaultValue: 0,   minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
    ];
  }

  private engine: GranularEngine;
  private lastFreezeGate = 0;
  private latchedFreeze = false;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.engine = new GranularEngine(sampleRate);
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const outL = outputs[0]?.[0];
    const outR = outputs[1]?.[0];
    if (!outL || !outR) return true;

    const inLBlock = inputs[0]?.[0] ?? null;
    const inRBlock = inputs[1]?.[0] ?? inputs[0]?.[0] ?? null;
    const pitchBlock = inputs[2]?.[0] ?? null;
    const freezeBlock = inputs[3]?.[0] ?? null;

    const positionArr = parameters.position;
    const sizeArr = parameters.size;
    const pitchArr = parameters.pitch;
    const densityArr = parameters.density;
    const textureArr = parameters.texture;
    const blendArr = parameters.blend;
    const freezeArr = parameters.freeze;

    const position = positionArr[0]!;
    const size = sizeArr[0]!;
    const pitchKnob = pitchArr[0]!;
    const density = densityArr[0]!;
    const texture = textureArr[0]!;
    const blend = blendArr[0]!;
    const sr = sampleRate;

    for (let i = 0; i < outL.length; i++) {
      const inL = inLBlock ? inLBlock[i]! : 0;
      const inR = inRBlock ? inRBlock[i]! : 0;
      const pitchV = pitchBlock ? pitchBlock[i]! : 0;
      const freezeCv = freezeBlock ? freezeBlock[i]! : 0;
      const freezeParam = freezeArr.length > 1 ? freezeArr[i]! : freezeArr[0]!;

      const gateCombined = Math.max(freezeCv, freezeParam);
      if (gateCombined >= 0.5 && this.lastFreezeGate < 0.5) {
        this.latchedFreeze = !this.latchedFreeze;
      }
      this.lastFreezeGate = gateCombined;
      const freeze = this.latchedFreeze;

      const pitchSemis = pitchV * 12 + pitchKnob;

      const [oL, oR] = this.engine.tick(
        inL, inR, position, size, pitchSemis, density, texture, blend,
        freeze, sr,
      );
      outL[i] = oL;
      outR[i] = oR;
    }
    return true;
  }
}

registerProcessor('clouds', CloudsProcessor);

// Pure-math mirror lives in packages/web/src/lib/audio/modules/clouds.ts
// (exported as cloudsMath). Any algorithmic change here MUST be mirrored
// there.
