// packages/web/src/lib/audio/modules/scope.test.ts
//
// Unit test for SCOPE's def shape, including the new mono-video
// output port added in this PR. SCOPE has no Faust assets so we can
// import its def directly without dynamic-import hedging.

import { describe, expect, it } from 'vitest';
import { scopeDef } from './scope';
import type { ModuleNode } from '$lib/graph/types';

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
