// packages/web/src/lib/audio/modules/rings.test.ts
//
// Unit tests for RINGS: module-def shape; pure-math engine sanity.

import { describe, expect, it } from 'vitest';
import { ringsDef, ringsMath, RINGS_MAX_MODEL, type RingsParams } from './rings';

describe('ringsDef shape', () => {
  it('declares type=rings, label=RINGS, category=sources', () => {
    expect(ringsDef.type).toBe('rings');
    expect(ringsDef.label).toBe('RINGS');
    expect(ringsDef.category).toBe('sources');
  });

  it('exposes the expected input ports', () => {
    const ids = ringsDef.inputs.map((p) => p.id);
    expect(ids).toEqual([
      'in', 'pitch', 'strum',
      'model_cv', 'note_cv', 'str_cv', 'bright_cv', 'damp_cv', 'pos_cv', 'level_cv',
    ]);
  });

  it("exposes 2 audio outputs: odd + even", () => {
    const ids = ringsDef.outputs.map((p) => p.id);
    expect(ids).toEqual(['odd', 'even']);
    for (const p of ringsDef.outputs) expect(p.type).toBe('audio');
  });

  it('declares odd/even as a stereoPair', () => {
    expect(ringsDef.stereoPairs).toEqual([['odd', 'even']]);
  });

  it('exposes 7 params: model, note, structure, brightness, damping, position, level', () => {
    const ids = ringsDef.params.map((p) => p.id);
    expect(ids).toEqual(['model', 'note', 'structure', 'brightness', 'damping', 'position', 'level']);
  });

  it('every cv input has paramTarget pointing at a real param + cvScale set', () => {
    for (const port of ringsDef.inputs) {
      if (port.type !== 'cv') continue;
      expect(port.paramTarget).toBeDefined();
      expect(port.cvScale).toBeDefined();
      const param = ringsDef.params.find((p) => p.id === port.paramTarget);
      expect(param).toBeDefined();
    }
  });

  it(`model param: discrete 0..${RINGS_MAX_MODEL}`, () => {
    const p = ringsDef.params.find((p) => p.id === 'model')!;
    expect(p.curve).toBe('discrete');
    expect(p.min).toBe(0);
    expect(p.max).toBe(RINGS_MAX_MODEL);
    expect(RINGS_MAX_MODEL).toBe(1);
    const port = ringsDef.inputs.find((p) => p.id === 'model_cv')!;
    expect(port.cvScale).toEqual({ mode: 'discrete' });
  });

  it('note param: ±60 semitone offset', () => {
    const p = ringsDef.params.find((p) => p.id === 'note')!;
    expect(p.min).toBe(-60);
    expect(p.max).toBe(60);
    expect(p.units).toBe('st');
  });

  it('strum input is gate-typed', () => {
    expect(ringsDef.inputs.find((p) => p.id === 'strum')!.type).toBe('gate');
  });

  it('exciter `in` is audio-typed', () => {
    expect(ringsDef.inputs.find((p) => p.id === 'in')!.type).toBe('audio');
  });

  it('pitch input is pitch-typed', () => {
    expect(ringsDef.inputs.find((p) => p.id === 'pitch')!.type).toBe('pitch');
  });
});

const SR = 48000;

function powerAt(buf: Float32Array, freq: number, sr: number): number {
  const w = (2 * Math.PI * freq) / sr;
  let re = 0;
  let im = 0;
  for (let i = 0; i < buf.length; i++) {
    re += buf[i]! * Math.cos(w * i);
    im += buf[i]! * Math.sin(w * i);
  }
  return Math.sqrt(re * re + im * im) / buf.length;
}

function makeNoiseBuf(n: number, seed = 0x12345): Float32Array {
  const out = new Float32Array(n);
  let s = seed | 0;
  for (let i = 0; i < n; i++) {
    s = (s * 16807) | 0;
    out[i] = ((s & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  }
  return out;
}

function makeBurstExciter(n: number, noiseLen: number, gain = 1.0): Float32Array {
  const noise = makeNoiseBuf(noiseLen);
  const out = new Float32Array(n);
  for (let i = 0; i < noiseLen; i++) out[i] = noise[i]! * gain;
  return out;
}

const baseParams: RingsParams = {
  model: 0, note: 0, structure: 0.0, brightness: 0.5,
  damping: 0.3, position: 0.5, level: 0.8,
};

describe('ringsMath — MODAL model', () => {
  it('produces non-silent, finite audio when excited with a noise burst at A4 pitch', () => {
    const exciter = makeBurstExciter(SR, 4800, 4.0);
    const { odd, even } = ringsMath.render(SR, SR, 0.75, {
      ...baseParams, structure: 0.3, position: 0.0,
    }, exciter);
    let peakOdd = 0;
    let peakEven = 0;
    for (let i = 0; i < odd.length; i++) {
      expect(Number.isFinite(odd[i]!)).toBe(true);
      expect(Number.isFinite(even[i]!)).toBe(true);
      const aO = Math.abs(odd[i]!);
      const aE = Math.abs(even[i]!);
      if (aO > peakOdd) peakOdd = aO;
      if (aE > peakEven) peakEven = aE;
    }
    expect(peakOdd).toBeGreaterThan(1e-6);
    expect(peakEven).toBeGreaterThan(1e-6);
  });

  it('carries strong energy at the fundamental (440Hz) when pitch=0.75 V/oct', () => {
    const exciter = makeBurstExciter(SR, 480);
    const { odd } = ringsMath.render(SR, SR, 0.75, baseParams, exciter);
    const tail = odd.slice(SR / 20);
    expect(powerAt(tail, 440, SR)).toBeGreaterThan(powerAt(tail, 1234, SR) * 3);
  });

  it('DAMPING low → long ring-out, DAMPING high → short ring-out', () => {
    const exciter = makeBurstExciter(SR, 480);
    const longRing = ringsMath.render(SR, SR, 0.75, { ...baseParams, damping: 0.05 }, exciter);
    const shortRing = ringsMath.render(SR, SR, 0.75, { ...baseParams, damping: 0.95 }, exciter);
    const tailStart = Math.floor(SR * 0.5);
    let longSum = 0;
    let shortSum = 0;
    for (let i = tailStart; i < SR; i++) {
      longSum  += longRing.odd[i]!  * longRing.odd[i]!;
      shortSum += shortRing.odd[i]! * shortRing.odd[i]!;
    }
    expect(Math.sqrt(longSum / (SR - tailStart))).toBeGreaterThan(Math.sqrt(shortSum / (SR - tailStart)) * 5);
  });
});

describe('ringsMath — SYMPATHETIC_STRING model', () => {
  const sympParams: RingsParams = { ...baseParams, model: 1 };

  it('produces audio when strummed with no audio exciter (KS burst self-excites)', () => {
    const { odd, even } = ringsMath.render(SR, SR, 0.75, sympParams, null, 0);
    let peak = 0;
    for (let i = 0; i < odd.length; i++) {
      expect(Number.isFinite(odd[i]!)).toBe(true);
      expect(Number.isFinite(even[i]!)).toBe(true);
      if (Math.abs(odd[i]!) > peak) peak = Math.abs(odd[i]!);
    }
    expect(peak).toBeGreaterThan(0.01);
  });

  it('carries energy at the fundamental pitch', () => {
    const { odd } = ringsMath.render(SR, SR, 0.75, sympParams, null, 0);
    const tail = odd.slice(SR / 10);
    expect(powerAt(tail, 440, SR)).toBeGreaterThan(powerAt(tail, 1100, SR) * 2);
  });

  it('DAMPING low → long ring-out, DAMPING high → short ring-out', () => {
    const longRing = ringsMath.render(SR, SR, 0.75, { ...sympParams, damping: 0.05 }, null, 0);
    const shortRing = ringsMath.render(SR, SR, 0.75, { ...sympParams, damping: 0.95 }, null, 0);
    const tailStart = Math.floor(SR * 0.5);
    let longSum = 0;
    let shortSum = 0;
    for (let i = tailStart; i < SR; i++) {
      longSum  += longRing.odd[i]!  * longRing.odd[i]!;
      shortSum += shortRing.odd[i]! * shortRing.odd[i]!;
    }
    expect(Math.sqrt(longSum / (SR - tailStart))).toBeGreaterThan(Math.sqrt(shortSum / (SR - tailStart)) * 5);
  });

  it('output stays soft-limited bounded (tanh)', () => {
    const hotExciter = makeNoiseBuf(SR, 0xdeadbeef);
    for (let i = 0; i < hotExciter.length; i++) hotExciter[i]! *= 10;
    const { odd, even } = ringsMath.render(SR, SR, 0.75, {
      ...sympParams, structure: 1.0, brightness: 1.0, damping: 0.1, level: 1.0,
    }, hotExciter, 0);
    let peakO = 0;
    let peakE = 0;
    for (let i = 0; i < odd.length; i++) {
      if (Math.abs(odd[i]!)  > peakO) peakO = Math.abs(odd[i]!);
      if (Math.abs(even[i]!) > peakE) peakE = Math.abs(even[i]!);
    }
    expect(peakO).toBeLessThanOrEqual(1.0);
    expect(peakE).toBeLessThanOrEqual(1.0);
  });
});

describe('ringsMath — V/oct mapping', () => {
  it('1 V/oct shifts fundamental up an octave', () => {
    const exciter = makeBurstExciter(SR, 480);
    const a4 = ringsMath.render(SR, SR, 0.75, baseParams, exciter);
    const a5 = ringsMath.render(SR, SR, 1.75, baseParams, exciter);
    const a4Tail = a4.odd.slice(SR / 20);
    const a5Tail = a5.odd.slice(SR / 20);
    expect(powerAt(a4Tail, 440, SR)).toBeGreaterThan(powerAt(a4Tail, 880, SR) * 0.5);
    expect(powerAt(a5Tail, 880, SR)).toBeGreaterThan(powerAt(a5Tail, 440, SR) * 2);
  });

  it('NOTE param adds semitones on top of pitch (note=12 → octave up)', () => {
    const sympParams: RingsParams = {
      ...baseParams, model: 1, structure: 0, brightness: 0.0, damping: 0.0,
    };
    const at0  = ringsMath.render(SR, SR, 0.75, sympParams,                  null, 0);
    const at12 = ringsMath.render(SR, SR, 0.75, { ...sympParams, note: 12 }, null, 0);
    const t0  = at0.odd.slice(SR / 10);
    const t12 = at12.odd.slice(SR / 10);
    expect(powerAt(t0, 440, SR)).toBeGreaterThan(powerAt(t12, 440, SR) * 2);
  });
});
