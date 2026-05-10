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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { dx7Def, DX7_DEFAULT_PRESET } from './dx7';
import { parseSyxBank } from '$lib/audio/dx7-syx';
import { patch as graphPatch } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AAAHGOOD_SYX = join(__dirname, '..', '__fixtures__', 'AAAHGOOD.SYX');

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

// ---------------- SYX-load → SyncedStore → patch-message regression ----------------
//
// REGRESSION (PR fix/dx7-syx-bank-loading): the user reported that uploading a
// .syx cartridge made every patch sound like the bundled E.PIANO 1. Root
// cause: when SYX voices live in node.data.userPatches (which is backed by
// the SyncedStore Y.Doc), reading them returns Yjs PROXY objects — Y.Map
// for the voice + Y.Array for op.r/op.l. The previous sendPatch built a
// payload that referenced those proxies directly, then handed it to
// `worklet.port.postMessage`. structuredClone (which postMessage uses
// under the hood in real browsers) rejects Yjs proxies — so the worklet
// never received the new patch and kept playing whatever it last got
// (E.PIANO 1, sent on factory init from the plain-JS DX7_BUILTIN_BANK).
//
// The fix: deep-unwrap to plain JS in sendPatch — every primitive coerced
// via Number()/Boolean()/String(), every array materialized into a fresh
// Array<number>. This test asserts the posted payload structured-clones
// successfully and that the cloned operators carry through the SYX
// voice's actual ratios + levels (NOT the E.PIANO defaults).
describe('dx7Def: SYX upload → patch message survives structured-clone (the bug)', () => {
  beforeEach(() => {
    // Wipe any leftover nodes from previous tests.
    for (const id of Object.keys(graphPatch.nodes)) {
      delete graphPatch.nodes[id];
    }
  });

  it('after SYX upload+select, posted patch (a) clones cleanly and (b) carries SYX voice data', async () => {
    const { posted, ctx } = makeMockEnv();
    const nodeId = 'dx7-syx-regression';

    // Spawn the dx7 factory against the SHARED graphPatch (the same one
    // Dx7Card.svelte writes through).
    const node: ModuleNode = {
      id: nodeId, type: 'dx7', domain: 'audio',
      position: { x: 0, y: 0 }, params: {}, data: {},
    };
    graphPatch.nodes[nodeId] = node;
    await dx7Def.factory(ctx as unknown as AudioContext, node);
    // Initial post is the bundled default (no SYX yet).
    expect(posted[0]?.voice?.name).toBe(DX7_DEFAULT_PRESET);

    // Mimic the Card: parse a real cartridge + write the voices into
    // node.data.userPatches via the SyncedStore (NOT plain JS — this is
    // what triggers the Yjs-proxy wrapping).
    const bytes = new Uint8Array(readFileSync(AAAHGOOD_SYX));
    const result = parseSyxBank(bytes);
    expect(result.voices.length).toBe(32);
    const t = graphPatch.nodes[nodeId]!;
    if (!t.data) t.data = {};
    (t.data as Record<string, unknown>).userPatches = result.voices;
    const target = result.voices[0]!; // "Trombones" — algorithm 18
    (t.data as Record<string, unknown>).preset = target.name;

    // Wait for the dx7 factory's poll loop (POLL_MS = 100) to react.
    await new Promise((r) => setTimeout(r, 200));

    // The posted payload must (a) survive structuredClone — the actual
    // browser postMessage path, and (b) reflect the SYX voice fields.
    const lastPatch = [...posted].reverse().find((m) => m.type === 'patch');
    expect(lastPatch, 'a patch message was posted after SYX preset select').toBeDefined();
    // (a) survives structured-clone — this is the regression assertion.
    expect(() => structuredClone(lastPatch)).not.toThrow();
    const cloned = structuredClone(lastPatch) as typeof lastPatch & {
      voice?: {
        name: string;
        algorithm: number;
        operators?: Array<{ r: number[]; l: number[]; ratio: number; level: number }>;
      };
    };
    // (b) carries SYX voice data after the clone — operators are real
    // Array<number>s, ratios + levels match the parsed voice (NOT the
    // bundled E.PIANO 1 defaults).
    expect(cloned.voice?.name).toBe(target.name);
    expect(cloned.voice?.algorithm).toBe(target.algorithm);
    const op0 = cloned.voice?.operators?.[0];
    expect(op0).toBeDefined();
    expect(Array.isArray(op0!.r)).toBe(true);
    expect(op0!.r).toEqual(target.operators[0]!.r);
    expect(op0!.l).toEqual(target.operators[0]!.l);
    expect(op0!.level).toBe(target.operators[0]!.level);
    // Spot-check op4 (where the SYX ratios diverge most from defaults).
    const op4 = cloned.voice?.operators?.[4];
    expect(op4!.ratio).toBeCloseTo(target.operators[4]!.ratio, 4);
  }, 5000);
});
