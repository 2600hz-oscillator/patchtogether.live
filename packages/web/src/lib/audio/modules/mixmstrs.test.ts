// packages/web/src/lib/audio/modules/mixmstrs.test.ts
//
// Unit tests for MIXMSTRS:
//   - the comp macro mapping (added in feat/audio-fidelity-mixmstrs-comp-swolevco),
//   - the per-channel POST-FADER VU: rmsLevel() + read('levels') (added with the
//     Electra MIXMASTER meter view — accurate post-fader Faust taps),
//   - the 6-channel expansion (ch5/ch6 + 6 VU taps).
// Spectral / RMS behavior of the actual Faust DSP is covered under
// art/scenarios/mixmstrs/.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock the Faust runtime so the factory can run under vitest (node, no Web
// Audio / no WASM). The fake worklet node carries a parameter Map; the mock
// AudioContext (built per test) supplies the node-graph methods the factory
// touches and AnalyserNodes whose getFloatTimeDomainData returns a known buffer.
const fakeFaustNode = {
  parameters: new Map<string, { value: number; setValueAtTime: (v: number) => void }>(),
  connect: vi.fn(),
  disconnect: vi.fn(),
};
vi.mock('$lib/audio/faust-runtime', () => ({
  instantiateFaustModule: vi.fn(async () => fakeFaustNode),
}));

import {
  coerceChannelNames,
  mapCompMacro,
  MIXMSTRS_CHANNEL_NAME_MAX,
  mixmstrsDef,
  rmsLevel,
} from './mixmstrs';
import type { ModuleNode } from '$lib/graph/types';

describe('mapCompMacro: per-channel comp knob → (enable, thresh, ratio)', () => {
  it('comp=0 → bypass (enable=0, thresh=0, ratio=1)', () => {
    const m = mapCompMacro(0);
    expect(m.enable).toBe(0);
    expect(m.thresh).toBe(0);
    expect(m.ratio).toBe(1);
  });

  it('comp=1 → max compression (enable=1, thresh=-20, ratio=4)', () => {
    const m = mapCompMacro(1);
    expect(m.enable).toBe(1);
    expect(m.thresh).toBe(-20);
    expect(m.ratio).toBe(4);
  });

  it('comp=0.5 → midpoint (enable=1, thresh=-10, ratio=2.5)', () => {
    const m = mapCompMacro(0.5);
    expect(m.enable).toBe(1);
    expect(m.thresh).toBeCloseTo(-10, 6);
    expect(m.ratio).toBeCloseTo(2.5, 6);
  });

  it('clamps below 0 → bypass', () => {
    const m = mapCompMacro(-0.5);
    expect(m.enable).toBe(0);
  });

  it('clamps above 1 → max compression', () => {
    const m = mapCompMacro(1.5);
    expect(m.enable).toBe(1);
    expect(m.thresh).toBe(-20);
    expect(m.ratio).toBe(4);
  });

  it('any positive comp value enables the compressor (no dead zone above 0)', () => {
    for (const v of [0.001, 0.01, 0.05, 0.25, 0.99]) {
      expect(mapCompMacro(v).enable, `comp=${v}`).toBe(1);
    }
  });
});

describe('coerceChannelNames: per-channel custom name coercion + default fallback', () => {
  it('always returns exactly 6 entries (one per channel)', () => {
    expect(coerceChannelNames(undefined)).toHaveLength(6);
    expect(coerceChannelNames(null)).toHaveLength(6);
    expect(coerceChannelNames([])).toHaveLength(6);
    expect(coerceChannelNames(['a'])).toHaveLength(6);
    expect(coerceChannelNames(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])).toHaveLength(6);
  });

  it('undefined / non-array → all null (every channel falls back to its default)', () => {
    expect(coerceChannelNames(undefined)).toEqual([null, null, null, null, null, null]);
    expect(coerceChannelNames('nope')).toEqual([null, null, null, null, null, null]);
    expect(coerceChannelNames(42)).toEqual([null, null, null, null, null, null]);
    expect(coerceChannelNames({ 0: 'kick' })).toEqual([null, null, null, null, null, null]);
  });

  it('keeps set names, pads missing/short channels with null', () => {
    expect(coerceChannelNames(['Kick', 'Snare'])).toEqual([
      'Kick', 'Snare', null, null, null, null,
    ]);
  });

  it('empty / whitespace-only / non-string entries → null (default fallback)', () => {
    expect(coerceChannelNames(['', '   ', 'Bass', 3, null, undefined])).toEqual([
      null, null, 'Bass', null, null, null,
    ]);
  });

  it('trims surrounding whitespace but preserves inner spacing + case', () => {
    expect(coerceChannelNames(['  Lead Vox  '])[0]).toBe('Lead Vox');
  });

  it('caps each name at MIXMSTRS_CHANNEL_NAME_MAX chars', () => {
    const long = 'x'.repeat(MIXMSTRS_CHANNEL_NAME_MAX + 20);
    const [first] = coerceChannelNames([long]);
    expect(first).toHaveLength(MIXMSTRS_CHANNEL_NAME_MAX);
    expect(first).toBe('x'.repeat(MIXMSTRS_CHANNEL_NAME_MAX));
  });

  it('ignores extra channels beyond the 6th', () => {
    const out = coerceChannelNames(['1', '2', '3', '4', '5', '6', '7-ignored']);
    expect(out).toEqual(['1', '2', '3', '4', '5', '6']);
  });
});

describe('rmsLevel: pure RMS over a sample window', () => {
  it('a constant buffer reads back its absolute value (RMS of a DC level)', () => {
    expect(rmsLevel(new Float32Array(64).fill(0.5))).toBeCloseTo(0.5, 6);
    expect(rmsLevel(new Float32Array(64).fill(-0.25))).toBeCloseTo(0.25, 6);
  });
  it('silence reads 0', () => {
    expect(rmsLevel(new Float32Array(128))).toBe(0);
  });
  it('an empty buffer reads 0 (no divide-by-zero)', () => {
    expect(rmsLevel(new Float32Array(0))).toBe(0);
  });
  it('a full-scale square reads 1.0', () => {
    const buf = new Float32Array(100);
    for (let i = 0; i < buf.length; i++) buf[i] = i % 2 === 0 ? 1 : -1;
    expect(rmsLevel(buf)).toBeCloseTo(1, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// read('levels') — drives mixmstrsDef.factory() against a mock Web Audio env.
// Each of the 6 post-fader meter AnalyserNodes (created in channel order) is
// fed a KNOWN constant buffer, so read('levels') returns a deterministic,
// ordered number[6] we can assert on (ordering + scale).
// ─────────────────────────────────────────────────────────────────────────

interface FakeAnalyser {
  __meterCh: number;
  fftSize: number;
  smoothingTimeConstant: number;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  getFloatTimeDomainData: (buf: Float32Array) => void;
}

/** Build a mock AudioContext. `levels[ch]` is the constant amplitude the ch-th
 *  post-fader analyser reports (RMS of a constant = that constant). */
function makeMockCtx(levels: number[]): unknown {
  let analyserCount = 0;
  function audioParam(initial = 0) {
    return {
      value: initial,
      setValueAtTime: vi.fn(function (this: { value: number }, v: number) {
        this.value = v;
      }),
    };
  }
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  return {
    currentTime: 0,
    sampleRate: 48000,
    createChannelMerger: () => node(),
    createChannelSplitter: () => node(),
    createGain: () => ({ gain: audioParam(0), connect: vi.fn(), disconnect: vi.fn() }),
    createConstantSource: () => ({
      offset: audioParam(0),
      start: vi.fn(),
      stop: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
    createAnalyser: (): FakeAnalyser => {
      // The factory creates the 6 meter analysers in ch0..ch5 order — tag each
      // with its creation index so its buffer carries that channel's level.
      const ch = analyserCount++;
      return {
        __meterCh: ch,
        fftSize: 1024,
        smoothingTimeConstant: 0,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getFloatTimeDomainData: (buf: Float32Array) => buf.fill(levels[ch] ?? 0),
      };
    },
  };
}

function makeMixNode(id = 'mx1'): ModuleNode {
  return {
    id,
    type: 'mixmstrs',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
    data: {},
  } as unknown as ModuleNode;
}

describe("mixmstrs factory: read('levels') — post-fader per-channel VU", () => {
  beforeEach(() => {
    fakeFaustNode.parameters = new Map();
    fakeFaustNode.connect.mockClear();
    fakeFaustNode.disconnect.mockClear();
  });
  afterEach(() => vi.clearAllMocks());

  it('returns number[6] of the per-channel post-fader RMS levels', async () => {
    const ctx = makeMockCtx([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    const handle = await mixmstrsDef.factory(ctx as never, makeMixNode() as never);
    const levels = handle.read?.('levels') as number[];
    expect(Array.isArray(levels)).toBe(true);
    expect(levels).toHaveLength(6);
    expect(levels[0]).toBeCloseTo(0.1, 6);
    expect(levels[1]).toBeCloseTo(0.2, 6);
    expect(levels[2]).toBeCloseTo(0.3, 6);
    expect(levels[3]).toBeCloseTo(0.4, 6);
    expect(levels[4]).toBeCloseTo(0.5, 6);
    expect(levels[5]).toBeCloseTo(0.6, 6);
    handle.dispose?.();
  });

  it('preserves channel ORDER (louder channel → higher level at its index)', async () => {
    // ch5 loudest, ch1 quietest — the returned array must keep that ordering.
    const ctx = makeMockCtx([0.05, 0.5, 0.9, 0.2, 0.95, 0.1]);
    const handle = await mixmstrsDef.factory(ctx as never, makeMixNode() as never);
    const levels = handle.read?.('levels') as number[];
    expect(levels[4]).toBeGreaterThan(levels[2]!); // ch5 > ch3
    expect(levels[2]).toBeGreaterThan(levels[1]!); // ch3 > ch2
    expect(levels[1]).toBeGreaterThan(levels[3]!); // ch2 > ch4
    expect(levels[3]).toBeGreaterThan(levels[5]!); // ch4 > ch6
    expect(levels[5]).toBeGreaterThan(levels[0]!); // ch6 > ch1
    handle.dispose?.();
  });

  it('a silent channel reads 0 (no floor / no leakage from neighbors)', async () => {
    const ctx = makeMockCtx([0, 0.5, 0, 0.5, 0, 0.5]);
    const handle = await mixmstrsDef.factory(ctx as never, makeMixNode() as never);
    const levels = handle.read?.('levels') as number[];
    expect(levels[0]).toBe(0);
    expect(levels[2]).toBe(0);
    expect(levels[4]).toBe(0);
    expect(levels[1]).toBeCloseTo(0.5, 6);
    expect(levels[3]).toBeCloseTo(0.5, 6);
    expect(levels[5]).toBeCloseTo(0.5, 6);
    handle.dispose?.();
  });

  it('does NOT expose the 6 meter taps as patchable module ports (still 6 outputs)', async () => {
    const ctx = makeMockCtx([0, 0, 0, 0, 0, 0]);
    const handle = await mixmstrsDef.factory(ctx as never, makeMixNode() as never);
    const outs = handle.outputs as Map<string, unknown>;
    expect([...outs.keys()].sort()).toEqual(
      ['masterL', 'masterR', 'send1L', 'send1R', 'send2L', 'send2R'].sort(),
    );
    handle.dispose?.();
  });

  it("read() of an unknown key is undefined", async () => {
    const ctx = makeMockCtx([0, 0, 0, 0, 0, 0]);
    const handle = await mixmstrsDef.factory(ctx as never, makeMixNode() as never);
    expect(handle.read?.('nope')).toBeUndefined();
    handle.dispose?.();
  });
});
