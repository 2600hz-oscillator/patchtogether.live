// packages/web/src/lib/audio/modules/scope.test.ts
//
// Unit test for SCOPE's def shape, including the new mono-video
// output port added in this PR. SCOPE has no Faust assets so we can
// import its def directly without dynamic-import hedging.

import { describe, expect, it } from 'vitest';
import { scopeDef } from './scope';
import type { ModuleNode } from '$lib/graph/types';
import {
  pixelFromSample,
  RANGE_MAX_AUDIO,
  RANGE_MAX_CV,
  intensityToPersistScreens,
  phosphorAlpha,
  xyPixelX,
  xyPixelY,
  DEFAULT_INTENSITY,
  DOT_SCREENS,
  EDGE_ALPHA,
} from './scope-draw';

describe('SCOPE module def shape', () => {
  it('declares the mono-video output port', () => {
    const out = scopeDef.outputs.find((p) => p.id === 'out');
    expect(out, 'scope.out video port present').toBeDefined();
    expect(out?.type).toBe('mono-video');
  });

  it('preserves the legacy audio passthrough outputs', () => {
    const ids = scopeDef.outputs.map((p) => p.id);
    expect(ids).toContain('ch1_out');
    expect(ids).toContain('ch2_out');
  });

  it('exposes per-channel display-mode params (ch1Range, ch2Range)', () => {
    // The mode toggle is named ch{1,2}Range in the def (the param
    // shipped pre-PR as a generic "range" toggle; the AUDIO↔CV UX
    // landed in this PR). Both are discrete 0..1 with default 0 = AUDIO.
    const ch1 = scopeDef.params.find((p) => p.id === 'ch1Range');
    const ch2 = scopeDef.params.find((p) => p.id === 'ch2Range');
    expect(ch1, 'ch1Range param present').toBeDefined();
    expect(ch2, 'ch2Range param present').toBeDefined();
    for (const p of [ch1!, ch2!]) {
      expect(p.curve).toBe('discrete');
      expect(p.min).toBe(0);
      expect(p.max).toBe(1);
      expect(p.defaultValue).toBe(0); // 0 = AUDIO; today's behavior preserved
    }
  });

  it('exposes 2 audio inputs + 1 cv input per param', () => {
    // PR-69 added per-param CV inputs ("scope should have cv inputs
    // for everything"). Port id MUST equal param id so the cross-domain
    // CV bridge in PatchEngine routes via setParam(portId).
    const ids = scopeDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual(
      [
        'ch1', 'ch2',
        'timeMs',
        'ch1Scale', 'ch1Offset', 'ch1Range',
        'ch2Scale', 'ch2Offset', 'ch2Range',
        'mode',
        'intensity',
      ].sort(),
    );
    for (const p of scopeDef.inputs) {
      if (p.id === 'ch1' || p.id === 'ch2') {
        expect(p.type, `${p.id} stays audio`).toBe('audio');
      } else {
        expect(p.type, `${p.id} is CV`).toBe('cv');
        // Param routing invariant: port id == paramTarget == def.params[].id.
        expect((p as { paramTarget?: string }).paramTarget, `${p.id} routes to itself`).toBe(p.id);
      }
    }
  });
});

// ---- Per-channel single-sample readback (`read('ch1_last_sample')`) ------
//
// Used by e2e (vrt-composite + nibbles-cv-scope.spec.ts) to assert that a
// CV signal patched into ch1/ch2 actually arrives — vs. the original
// PR-#419 approach which read QBRT.readParam('cutoff') (the slider value,
// not the modulated AudioParam) and would never have moved.
//
// We don't run a full Web Audio graph here — instead we mock the analyser
// so its `getFloatTimeDomainData` writes a deterministic sample sequence.
// That's enough to pin the contract: `read('ch1_last_sample')` returns the
// LAST element of the buffer (i.e. the most recent time-domain sample), and
// `read('ch2_last_sample')` does the same against the ch2 analyser.

describe('SCOPE.read("ch{1,2}_last_sample") returns the most-recent analyser sample', () => {
  /** Minimal fake AudioContext shaped for scopeDef.factory. Each
   *  analyser fills the supplied Float32Array with a fixed tail value. */
  function makeFakeCtxWithTailSamples(ch1Tail: number, ch2Tail: number): {
    ctx: AudioContext;
    setTails: (a: number, b: number) => void;
  } {
    let tail1 = ch1Tail;
    let tail2 = ch2Tail;
    function gainNode(): unknown {
      return {
        gain: { value: 1, setValueAtTime() {} },
        connect() {},
        disconnect() {},
      };
    }
    function analyser(getTail: () => number): unknown {
      return {
        fftSize: 2048,
        smoothingTimeConstant: 0,
        connect() {},
        disconnect() {},
        getFloatTimeDomainData(buf: Float32Array) {
          // Fill with zeros for the body, write the "tail" sample at
          // the last index — matches how a settled DC signal would
          // look at the most-recent sample.
          buf.fill(0);
          buf[buf.length - 1] = getTail();
        },
      };
    }
    let n1 = 0;
    const ctx = {
      sampleRate: 48000,
      currentTime: 0,
      createGain: () => gainNode(),
      createAnalyser: () => {
        n1 += 1;
        return n1 === 1 ? analyser(() => tail1) : analyser(() => tail2);
      },
    } as unknown as AudioContext;
    return {
      ctx,
      setTails(a, b) { tail1 = a; tail2 = b; },
    };
  }

  it('returns the analyser tail sample for ch1', async () => {
    const { ctx } = makeFakeCtxWithTailSamples(0.42, -0.17);
    const node = { id: 'sc', type: 'scope', domain: 'audio', params: {} } as unknown as ModuleNode;
    const handle = await scopeDef.factory(ctx, node);
    const v = handle.read!('ch1_last_sample');
    expect(v).toBeCloseTo(0.42, 6);
  });

  it('returns the analyser tail sample for ch2', async () => {
    const { ctx } = makeFakeCtxWithTailSamples(0.42, -0.17);
    const node = { id: 'sc', type: 'scope', domain: 'audio', params: {} } as unknown as ModuleNode;
    const handle = await scopeDef.factory(ctx, node);
    const v = handle.read!('ch2_last_sample');
    expect(v).toBeCloseTo(-0.17, 6);
  });

  it('tracks subsequent reads when the tail sample changes', async () => {
    const ctxWrap = makeFakeCtxWithTailSamples(0.0, 0.0);
    const node = { id: 'sc', type: 'scope', domain: 'audio', params: {} } as unknown as ModuleNode;
    const handle = await scopeDef.factory(ctxWrap.ctx, node);
    expect(handle.read!('ch1_last_sample')).toBeCloseTo(0.0, 6);
    ctxWrap.setTails(0.8, 0.0);
    expect(handle.read!('ch1_last_sample')).toBeCloseTo(0.8, 6);
    ctxWrap.setTails(-0.5, 0.0);
    expect(handle.read!('ch1_last_sample')).toBeCloseTo(-0.5, 6);
  });

  it('still returns undefined for unknown keys', async () => {
    const { ctx } = makeFakeCtxWithTailSamples(0, 0);
    const node = { id: 'sc', type: 'scope', domain: 'audio', params: {} } as unknown as ModuleNode;
    const handle = await scopeDef.factory(ctx, node);
    expect(handle.read!('not_a_real_key')).toBeUndefined();
  });
});

describe('SCOPE pixelFromSample (display-mode scaling)', () => {
  // halfHeight=100, cvRange=5 — chosen to match the task spec's pinned
  // endpoints. Caller (the channel-draw loop) wraps the result into
  //   y = h/2 - (yOffsetPx * scale + offset * h/2)
  // so a +halfHeight return lands at the top of the channel (0 px) and
  // a -halfHeight return at the bottom (h px) once scale=1, offset=0.

  it('AUDIO mode: ±1 fills the channel; 0 sits at the mid-line', () => {
    expect(pixelFromSample(0, false, 100, 5)).toBe(0);
    expect(pixelFromSample(1, false, 100, 5)).toBe(100);
    expect(pixelFromSample(-1, false, 100, 5)).toBe(-100);
  });

  it('CV mode: ±5V fills the channel; 0 sits at the mid-line', () => {
    expect(pixelFromSample(0, true, 100, 5)).toBe(0);
    expect(pixelFromSample(5, true, 100, 5)).toBe(100);
    expect(pixelFromSample(-5, true, 100, 5)).toBe(-100);
  });

  it('CV mode: a 1V signal sits at 1/5 of the channel height', () => {
    // Eurorack convention: 1V/oct → one octave above C4 should be a
    // readable fraction of the channel, NOT pinned to the rails.
    expect(pixelFromSample(1, true, 100, 5)).toBe(20);
    expect(pixelFromSample(-1, true, 100, 5)).toBe(-20);
  });

  it('AUDIO mode: a 1V "CV" signal would clip the rails (motivates the toggle)', () => {
    // If the user patches a CV-range signal but leaves the channel in
    // AUDIO mode, samples beyond ±1 land outside the channel. Pinning
    // this asserts WHY the toggle matters.
    expect(pixelFromSample(5, false, 100, 5)).toBe(500);
    expect(pixelFromSample(-5, false, 100, 5)).toBe(-500);
  });

  it('exposed display-range constants match the Eurorack convention', () => {
    expect(RANGE_MAX_AUDIO).toBe(1);
    expect(RANGE_MAX_CV).toBe(5);
  });
});

// ---- Phosphor INTENSITY param + persistence mapping ----------------------

describe('SCOPE intensity param def', () => {
  it('exposes a linear 0..1 intensity param defaulting to 0.5 (12:00)', () => {
    const p = scopeDef.params.find((q) => q.id === 'intensity');
    expect(p, 'intensity param present').toBeDefined();
    expect(p!.curve).toBe('linear');
    expect(p!.min).toBe(0);
    expect(p!.max).toBe(1);
    // Default MUST be the 12:00 mid-point so the on-card render is the
    // pixel-identical legacy path out of the box.
    expect(p!.defaultValue).toBe(0.5);
    expect(p!.defaultValue).toBe(DEFAULT_INTENSITY);
  });

  it('exposes an intensity CV input routing to itself', () => {
    const inp = scopeDef.inputs.find((q) => q.id === 'intensity');
    expect(inp, 'intensity CV input present').toBeDefined();
    expect(inp!.type).toBe('cv');
    expect((inp as { paramTarget?: string }).paramTarget).toBe('intensity');
  });
});

describe('intensityToPersistScreens (INTENSITY -> persistence length in screens)', () => {
  it('pins the three calibration endpoints: 7:00->dot, 12:00->1 screen, 5:00->2 screens', () => {
    // 0.0 (7:00, min): a single moving DOT — near-zero trail.
    expect(intensityToPersistScreens(0)).toBeCloseTo(DOT_SCREENS, 10);
    expect(intensityToPersistScreens(0)).toBeLessThan(0.05);
    // 0.5 (12:00, default): exactly ONE screen — matches today.
    expect(intensityToPersistScreens(0.5)).toBeCloseTo(1, 10);
    // 1.0 (5:00, max): TWO screens — twice as long-lived.
    expect(intensityToPersistScreens(1)).toBeCloseTo(2, 10);
  });

  it('is strictly monotonic increasing across the knob travel', () => {
    let prev = -Infinity;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const v = intensityToPersistScreens(Math.min(1, t));
      expect(v, `persistScreens at intensity=${t.toFixed(2)} increases`).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it('clamps out-of-range knob values to the endpoints', () => {
    expect(intensityToPersistScreens(-1)).toBeCloseTo(DOT_SCREENS, 10);
    expect(intensityToPersistScreens(2)).toBeCloseTo(2, 10);
  });
});

describe('phosphorAlpha (trail brightness falls off with age)', () => {
  it('is full brightness at the newest beam position (age 0)', () => {
    expect(phosphorAlpha(0, 2)).toBeCloseTo(1, 10);
    expect(phosphorAlpha(0, 0.5)).toBeCloseTo(1, 10);
  });

  it('decays monotonically with age (older = dimmer), reaching the faint edge floor', () => {
    const persist = 2;
    let prev = Infinity;
    for (let age = 0; age <= persist; age += 0.1) {
      const a = phosphorAlpha(age, persist);
      expect(a, `alpha at age=${age.toFixed(1)} dims`).toBeLessThanOrEqual(prev + 1e-9);
      prev = a;
    }
    // The oldest visible position lands at the fixed faint floor.
    expect(phosphorAlpha(persist, persist)).toBeCloseTo(EDGE_ALPHA, 6);
  });

  it('a longer trail fades more gradually per-screen than a short one', () => {
    // At the SAME absolute age (0.5 screens), a 2-screen trail is brighter
    // than a 1-screen trail — phosphor "spread out" over a longer beam life.
    const long = phosphorAlpha(0.5, 2);
    const short = phosphorAlpha(0.5, 1);
    expect(long).toBeGreaterThan(short);
  });

  it('positions older than the trail length are clamped to the edge floor (not negative)', () => {
    expect(phosphorAlpha(5, 2)).toBeCloseTo(EDGE_ALPHA, 6);
  });
});

// ---- X/Y (Lissajous) coordinate mapping ----------------------------------

describe('xyPixelX / xyPixelY (signal -> display-square pixel)', () => {
  const W = 200;
  const H = 100;

  it('AUDIO range: 0V sits at the center of the square', () => {
    expect(xyPixelX(0, RANGE_MAX_AUDIO, 1, 0, W)).toBe(W / 2);
    expect(xyPixelY(0, RANGE_MAX_AUDIO, 1, 0, H)).toBe(H / 2);
  });

  it('AUDIO range: +full-scale -> right/top edge, -full-scale -> left/bottom edge', () => {
    // ch1 (+1) -> right edge; (-1) -> left edge.
    expect(xyPixelX(1, RANGE_MAX_AUDIO, 1, 0, W)).toBe(W);
    expect(xyPixelX(-1, RANGE_MAX_AUDIO, 1, 0, W)).toBe(0);
    // ch2 (+1) -> top edge (y grows downward); (-1) -> bottom edge.
    expect(xyPixelY(1, RANGE_MAX_AUDIO, 1, 0, H)).toBe(0);
    expect(xyPixelY(-1, RANGE_MAX_AUDIO, 1, 0, H)).toBe(H);
  });

  it('CV range: ±5V maps to the edges; ±1V to 1/5 toward an edge', () => {
    expect(xyPixelX(5, RANGE_MAX_CV, 1, 0, W)).toBe(W);
    expect(xyPixelX(-5, RANGE_MAX_CV, 1, 0, W)).toBe(0);
    // +1V -> 1/5 of half-width right of center.
    expect(xyPixelX(1, RANGE_MAX_CV, 1, 0, W)).toBeCloseTo(W / 2 + (W / 2) / 5, 6);
  });

  it('offset shifts the center; scale stretches around it', () => {
    // offset 0.5 (NDC) moves center right by quarter-width.
    expect(xyPixelX(0, RANGE_MAX_AUDIO, 1, 0.5, W)).toBeCloseTo(W / 2 + (0.5 * W) / 2, 6);
    // scale 2 on a 0.5 sample doubles its NDC deflection.
    expect(xyPixelX(0.5, RANGE_MAX_AUDIO, 2, 0, W)).toBe(W); // 0.5*2 = 1.0 -> right edge
  });
});
