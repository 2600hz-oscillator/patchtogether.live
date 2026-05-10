// packages/web/src/lib/audio/modules/dx7.test.ts
//
// Unit tests for the DX7 module's host-side bridge. The DSP itself runs
// in an AudioWorklet (real-browser only); here we mock AudioContext +
// AudioWorkletNode so we can verify the host correctly routes algorithm
// changes through the patch-message channel rather than dropping them.
//
// REGRESSION: the factory's setParam used to early-out for any paramId
// that didn't have a matching AudioParam (`if (!p) return;`). Algorithm
// is NOT an AudioParam — it travels via port.postMessage — so the early
// return silently no-op'd algorithm switching. See the test
// `setParam('algorithm') posts a patch message even though ...`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dx7Def, DX7_DEFAULT_PRESET } from './dx7';
import type { ModuleNode } from '$lib/graph/types';

// ---------------- module-def shape ----------------

describe('dx7Def: shape', () => {
  it('declares the algorithm param with discrete 1..32 range', () => {
    const algo = dx7Def.params.find((p) => p.id === 'algorithm');
    expect(algo).toBeDefined();
    expect(algo?.min).toBe(1);
    expect(algo?.max).toBe(32);
    expect(algo?.curve).toBe('discrete');
    expect(algo?.defaultValue).toBe(5);
  });

  it('declares 4 params (algorithm, voiceCount, level, transpose)', () => {
    const ids = dx7Def.params.map((p) => p.id).sort();
    expect(ids).toEqual(['algorithm', 'level', 'transpose', 'voiceCount']);
  });
});

// ---------------- host bridge integration test ----------------
//
// We mock just enough of Web Audio (AudioContext, AudioWorkletNode, port,
// AudioParam) to drive `dx7Def.factory(...)` end-to-end and observe what
// messages the host posts to the worklet under different setParam paths.

interface PostedMessage { type: string; voice?: { algorithm: number; name: string } }

function makeMockEnv() {
  const posted: PostedMessage[] = [];
  const portMock = {
    postMessage: vi.fn((m: PostedMessage) => { posted.push(m); }),
    onmessage: null as unknown,
    close: vi.fn(),
  };
  const paramSet = new Map<string, { setValueAtTime: (v: number, t: number) => void; value: number }>();
  // The worklet declares only voiceCount, level, transpose as parameters.
  // Algorithm is deliberately NOT a parameter (handled via port message).
  for (const id of ['voiceCount', 'level', 'transpose']) {
    paramSet.set(id, {
      setValueAtTime: vi.fn(function (this: { value: number }, v: number) { this.value = v; }) as never,
      value: 0,
    });
  }
  class FakeAudioWorkletNode {
    port = portMock;
    parameters = {
      get: (k: string) => paramSet.get(k),
    };
    disconnect = vi.fn();
    constructor(_ctx: unknown, _name: string, _opts?: unknown) {}
  }
  const audioWorklet = {
    addModule: vi.fn(async (_url: string) => {}),
  };
  const ctx = {
    audioWorklet,
    currentTime: 0,
  };

  // Web Audio's AudioWorkletNode is referenced as a global constructor.
  (globalThis as unknown as { AudioWorkletNode: typeof FakeAudioWorkletNode }).AudioWorkletNode =
    FakeAudioWorkletNode;

  return { posted, ctx, paramSet };
}

function makeNode(params?: Record<string, number>): ModuleNode {
  return {
    id: 'dx-test',
    type: 'dx7',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: params ?? {},
    data: {},
  };
}

describe('dx7Def: factory + setParam algorithm bridge', () => {
  beforeEach(() => {
    // Each test gets fresh module state — but the factory itself is
    // stateless aside from `loadedContexts`. Use a fresh ctx per test so
    // addModule is invoked.
  });

  it('factory posts an initial patch message with the requested algorithm', async () => {
    const { posted, ctx } = makeMockEnv();
    const node = makeNode({ algorithm: 5 });
    await dx7Def.factory(ctx as unknown as AudioContext, node);
    // The factory's "initial patch send" block should emit exactly one
    // patch message before any setParam calls.
    expect(posted.length).toBeGreaterThanOrEqual(1);
    const init = posted[0]!;
    expect(init.type).toBe('patch');
    expect(init.voice?.name).toBe(DX7_DEFAULT_PRESET);
    expect(init.voice?.algorithm).toBe(5);
  });

  it('setParam("algorithm", 32) posts a patch message even though algorithm is NOT an AudioParam', async () => {
    // This is THE regression: previously the factory's setParam did
    //   const p = params.get(paramId); if (!p) return;
    // before checking the algorithm branch. params.get('algorithm') is
    // undefined (the worklet declares only voiceCount/level/transpose), so
    // the branch was unreachable and algo changes were silently dropped.
    const { posted, ctx } = makeMockEnv();
    const node = makeNode({ algorithm: 5 });
    const handle = await dx7Def.factory(ctx as unknown as AudioContext, node);
    const initialCount = posted.length;
    handle.setParam('algorithm', 32);
    expect(posted.length, 'one extra patch posted on algo change').toBe(initialCount + 1);
    const last = posted[posted.length - 1]!;
    expect(last.type).toBe('patch');
    expect(last.voice?.algorithm).toBe(32);
  });

  it('setParam("algorithm") with same value does NOT re-post (debounce)', async () => {
    const { posted, ctx } = makeMockEnv();
    const node = makeNode({ algorithm: 5 });
    const handle = await dx7Def.factory(ctx as unknown as AudioContext, node);
    const initialCount = posted.length;
    handle.setParam('algorithm', 5); // same as initial
    expect(posted.length).toBe(initialCount);
  });

  it('setParam("algorithm") clamps + rounds float values to 1..32 ints', async () => {
    const { posted, ctx } = makeMockEnv();
    const node = makeNode({ algorithm: 5 });
    const handle = await dx7Def.factory(ctx as unknown as AudioContext, node);
    handle.setParam('algorithm', 99);
    expect(posted[posted.length - 1]?.voice?.algorithm).toBe(32);
    handle.setParam('algorithm', -3);
    expect(posted[posted.length - 1]?.voice?.algorithm).toBe(1);
    handle.setParam('algorithm', 5.4);
    expect(posted[posted.length - 1]?.voice?.algorithm).toBe(5);
    handle.setParam('algorithm', 5.7);
    expect(posted[posted.length - 1]?.voice?.algorithm).toBe(6);
  });

  it('setParam("algorithm") sweeps across 1..32 produce 31 distinct posts', async () => {
    const { posted, ctx } = makeMockEnv();
    const handle = await dx7Def.factory(ctx as unknown as AudioContext, makeNode({ algorithm: 1 }));
    const start = posted.length;
    for (let a = 2; a <= 32; a++) {
      handle.setParam('algorithm', a);
    }
    // 31 algo changes (2..32) → 31 new patch messages.
    expect(posted.length - start).toBe(31);
    // Each posted patch reports the algorithm we asked for.
    for (let a = 2; a <= 32; a++) {
      const m = posted[start + (a - 2)]!;
      expect(m.voice?.algorithm).toBe(a);
    }
  });

  it('readParam("algorithm") returns the host-tracked currentAlgo', async () => {
    const { ctx } = makeMockEnv();
    const handle = await dx7Def.factory(ctx as unknown as AudioContext, makeNode({ algorithm: 5 }));
    expect(handle.readParam('algorithm')).toBe(5);
    handle.setParam('algorithm', 17);
    expect(handle.readParam('algorithm')).toBe(17);
  });

  it('non-algorithm setParam still routes through the AudioParam path', async () => {
    const { ctx, paramSet } = makeMockEnv();
    const handle = await dx7Def.factory(ctx as unknown as AudioContext, makeNode());
    handle.setParam('level', 1.5);
    expect(paramSet.get('level')?.value).toBe(1.5);
  });
});
