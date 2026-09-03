// packages/web/src/lib/audio/modules/mixmstrs.test.ts
//
// Unit tests for MIXMSTRS:
//   - the comp macro mapping (added in feat/audio-fidelity-mixmstrs-comp-swolevco),
//   - the per-channel POST-FADER VU: rmsLevel() + read('levels') (added with the
//     Electra MIXMASTER meter view — accurate post-fader Faust taps),
//   - the 8-channel expansion (ch7/ch8 + 8 VU taps).
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
  mapCompMacro,
  mixmstrsDef,
  mixmstrsPostFaderTap,
  mixmstrsRecTapPair,
  MIXMSTRS_MASTER_TAP,
  MIXMSTRS_POST_FADER_TAP_OFFSET,
  rmsLevel,
  type MixmstrsRecTaps,
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
// The 16 post-fader meter AnalyserNodes (one per LEG, created first and in
// leg order: ch1L, ch1R, ch2L, ch2R, …) are each fed a KNOWN constant buffer,
// so read('levels') returns a deterministic, ordered number[8] we can assert
// on (ordering + scale + the combine-after-RMS property).
//
// ⚠ THE COMBINE ORDER IS THE CONTRACT UNDER TEST. The DSP used to hand back a
// mono `(L+R)*0.5` per channel and that sum is measurably phase-blind: an
// anti-phase channel read rms 0.0000e+0 while masterL/masterR each carried
// 0.184216. The factory now RMSes each leg separately and combines energies
// (`sqrt((L²+R²)/2)`), which cannot cancel — and a constant buffer per leg is
// exactly the probe that separates the two orders: legs +c and −c read c
// combined-after and 0 summed-before.
// ─────────────────────────────────────────────────────────────────────────

interface FakeAnalyser {
  __meterCh: number;
  fftSize: number;
  smoothingTimeConstant: number;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  getFloatTimeDomainData: (buf: Float32Array) => void;
}

/** Build a mock AudioContext. `legAmps[k]` is the constant amplitude the k-th
 *  created analyser reports (RMS of a constant = |constant|); the factory
 *  creates the 16 meter-leg analysers FIRST, in leg order. Pass 8 per-channel
 *  values through `perChannel()` when both legs should agree. */
function makeMockCtx(legAmps: number[]): unknown {
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
      // The factory creates the 16 meter-leg analysers FIRST and in leg order
      // (ch1L, ch1R, ch2L, ch2R, …) — tag each with its creation index so its
      // buffer carries that leg's amplitude. Later analysers (comp/rec shadow
      // observation taps) read past the array and fill 0, which is fine: no
      // test here asserts through them.
      const leg = analyserCount++;
      return {
        __meterCh: leg,
        fftSize: 1024,
        smoothingTimeConstant: 0,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getFloatTimeDomainData: (buf: Float32Array) => buf.fill(legAmps[leg] ?? 0),
      };
    },
  };
}

/** Expand 8 per-channel amplitudes into 16 leg amplitudes (L = R = value). */
function perChannel(chans: number[]): number[] {
  return chans.flatMap((v) => [v, v]);
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

  it('returns number[8] of the per-channel post-fader RMS levels', async () => {
    // Both legs of each channel at the same amplitude: the combined RMS
    // sqrt((c²+c²)/2) = c, so a correlated (mono-ish) channel reads exactly
    // what the old mono tap read.
    const ctx = makeMockCtx(perChannel([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]));
    const handle = await mixmstrsDef.factory(ctx as never, makeMixNode() as never);
    const levels = handle.read?.('levels') as number[];
    expect(Array.isArray(levels)).toBe(true);
    expect(levels).toHaveLength(8);
    expect(levels[0]).toBeCloseTo(0.1, 6);
    expect(levels[1]).toBeCloseTo(0.2, 6);
    expect(levels[2]).toBeCloseTo(0.3, 6);
    expect(levels[3]).toBeCloseTo(0.4, 6);
    expect(levels[4]).toBeCloseTo(0.5, 6);
    expect(levels[5]).toBeCloseTo(0.6, 6);
    expect(levels[6]).toBeCloseTo(0.7, 6);
    expect(levels[7]).toBeCloseTo(0.8, 6);
    handle.dispose?.();
  });

  it('preserves channel ORDER (louder channel → higher level at its index)', async () => {
    // ch7 loudest, ch1 quietest — the returned array must keep that ordering.
    // Values (ch1..ch8): descending chain is ch7 > ch5 > ch3 > ch2 > ch8 > ch4 > ch6 > ch1.
    const ctx = makeMockCtx(perChannel([0.05, 0.5, 0.9, 0.2, 0.95, 0.1, 0.99, 0.3]));
    const handle = await mixmstrsDef.factory(ctx as never, makeMixNode() as never);
    const levels = handle.read?.('levels') as number[];
    expect(levels[6]).toBeGreaterThan(levels[4]!); // ch7 > ch5
    expect(levels[4]).toBeGreaterThan(levels[2]!); // ch5 > ch3
    expect(levels[2]).toBeGreaterThan(levels[1]!); // ch3 > ch2
    expect(levels[1]).toBeGreaterThan(levels[7]!); // ch2 > ch8
    expect(levels[7]).toBeGreaterThan(levels[3]!); // ch8 > ch4
    expect(levels[3]).toBeGreaterThan(levels[5]!); // ch4 > ch6
    expect(levels[5]).toBeGreaterThan(levels[0]!); // ch6 > ch1
    handle.dispose?.();
  });

  it('a silent channel reads 0 (no floor / no leakage from neighbors)', async () => {
    const ctx = makeMockCtx(perChannel([0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5]));
    const handle = await mixmstrsDef.factory(ctx as never, makeMixNode() as never);
    const levels = handle.read?.('levels') as number[];
    expect(levels[0]).toBe(0);
    expect(levels[2]).toBe(0);
    expect(levels[4]).toBe(0);
    expect(levels[6]).toBe(0);
    expect(levels[1]).toBeCloseTo(0.5, 6);
    expect(levels[3]).toBeCloseTo(0.5, 6);
    expect(levels[5]).toBeCloseTo(0.5, 6);
    expect(levels[7]).toBeCloseTo(0.5, 6);
    handle.dispose?.();
  });

  it('REGRESSION: an ANTI-PHASE channel meters at its true level, not 0', async () => {
    // The phase-blindness fix, pinned at the combine seam. ch1's legs carry
    // +0.5 and −0.5 — the signal whose mono sum is digital silence and which
    // read rms 0.0000e+0 off the old (L+R)*0.5 DSP tap. RMS is sign-blind and
    // energies add, so the combined reading must be the true 0.5. An
    // implementation that summed the leg buffers BEFORE the RMS would read 0
    // here, which is exactly the defect this test exists to keep dead.
    const legs = new Array(16).fill(0);
    legs[0] = 0.5; // ch1L
    legs[1] = -0.5; // ch1R — anti-phase
    const ctx = makeMockCtx(legs);
    const handle = await mixmstrsDef.factory(ctx as never, makeMixNode() as never);
    const levels = handle.read?.('levels') as number[];
    expect(levels[0], 'the anti-phase channel must meter at its true level').toBeCloseTo(0.5, 6);
    expect(levels[1], 'and nothing leaks into ch2').toBe(0);
    handle.dispose?.();
  });

  it('a one-sided channel reads its energy share (L only → c/√2)', async () => {
    // sqrt((c² + 0²)/2) = c/√2 — the energy combine, asserted off the equal-leg
    // path so a "just return the L leg" implementation cannot pass.
    const legs = new Array(16).fill(0);
    legs[4] = 0.5; // ch3L only
    const ctx = makeMockCtx(legs);
    const handle = await mixmstrsDef.factory(ctx as never, makeMixNode() as never);
    const levels = handle.read?.('levels') as number[];
    expect(levels[2]).toBeCloseTo(0.5 / Math.SQRT2, 6);
    handle.dispose?.();
  });

  it('does NOT expose the 16 tap legs as patchable module ports (still 6 outputs)', async () => {
    const ctx = makeMockCtx(perChannel([0, 0, 0, 0, 0, 0, 0, 0]));
    const handle = await mixmstrsDef.factory(ctx as never, makeMixNode() as never);
    const outs = handle.outputs as Map<string, unknown>;
    expect([...outs.keys()].sort()).toEqual(
      ['masterL', 'masterR', 'send1L', 'send1R', 'send2L', 'send2R'].sort(),
    );
    handle.dispose?.();
  });

  it("read() of an unknown key is undefined", async () => {
    const ctx = makeMockCtx(perChannel([0, 0, 0, 0, 0, 0, 0, 0]));
    const handle = await mixmstrsDef.factory(ctx as never, makeMixNode() as never);
    expect(handle.read?.('nope')).toBeUndefined();
    handle.dispose?.();
  });

  it("read('recTaps') publishes all three rosters, addressed off ONE constant", async () => {
    const ctx = makeMockCtx(perChannel([0, 0, 0, 0, 0, 0, 0, 0]));
    const handle = await mixmstrsDef.factory(ctx as never, makeMixNode() as never);
    const taps = handle.read?.('recTaps') as MixmstrsRecTaps;
    // Shapes: 16 BOARD IN legs (channel legs only — no return-port inserts),
    // 16 POST FADER legs, one MASTER pair.
    expect(taps.board).toHaveLength(16);
    expect(taps.postFader).toHaveLength(16);
    expect(taps.master).toHaveLength(2);
    // BOARD IN: 16 DISTINCT insert-head nodes, each tapped at output 0.
    expect(new Set(taps.board.map((l) => l.node)).size).toBe(16);
    for (const leg of taps.board) expect(leg.output).toBe(0);
    // POST FADER + MASTER: every leg is the SAME splitter node, so the tap and
    // the patchable master jacks cannot be different graphs.
    const splitterNode = taps.master[0].node;
    expect(taps.master[1].node).toBe(splitterNode);
    for (const leg of taps.postFader) expect(leg.node).toBe(splitterNode);
    // And the indices come from the shared constants — the meter analysers
    // address the same outputs, which is the "one place computes this" rule.
    expect(taps.master[0].output).toBe(MIXMSTRS_MASTER_TAP.l);
    expect(taps.master[1].output).toBe(MIXMSTRS_MASTER_TAP.r);
    taps.postFader.forEach((leg, k) => {
      expect(leg.output).toBe(MIXMSTRS_POST_FADER_TAP_OFFSET + k);
    });
    handle.dispose?.();
  });

  it('mixmstrsRecTapPair selects the right stereo pair for every (tap, channel)', async () => {
    const ctx = makeMockCtx(perChannel([0, 0, 0, 0, 0, 0, 0, 0]));
    const handle = await mixmstrsDef.factory(ctx as never, makeMixNode() as never);
    const taps = handle.read?.('recTaps') as MixmstrsRecTaps;
    // BOARD IN, ch4 (0-based 3) → board legs 6/7.
    const board = mixmstrsRecTapPair(taps, 0, 3);
    expect(board.l).toBe(taps.board[6]);
    expect(board.r).toBe(taps.board[7]);
    // POST FADER, ch4 → splitter outputs from mixmstrsPostFaderTap(3).
    const post = mixmstrsRecTapPair(taps, 1, 3);
    expect(post.l.output).toBe(mixmstrsPostFaderTap(3).l);
    expect(post.r.output).toBe(mixmstrsPostFaderTap(3).r);
    // MASTER is the same pair for EVERY channel — eight lanes recording the
    // mix is eight copies of the mix.
    for (const ch0 of [0, 3, 7]) {
      const m = mixmstrsRecTapPair(taps, 2, ch0);
      expect(m.l).toBe(taps.master[0]);
      expect(m.r).toBe(taps.master[1]);
    }
    // A drifting effective value snaps like readRecState does (0.6 → tap 1),
    // and an out-of-range channel clamps instead of reading off the roster end.
    expect(mixmstrsRecTapPair(taps, 0.6, 0).l).toBe(taps.postFader[0]);
    expect(mixmstrsRecTapPair(taps, 0, 99).l).toBe(taps.board[14]);
    handle.dispose?.();
  });
});
