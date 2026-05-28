// packages/web/src/lib/video/modules/doom.test.ts
//
// Locks down DOOM's module-def shape — port set, paramTarget wiring,
// maxInstances, audio output declarations. Plus a focused factory test
// that pins the audio-bridge contract (persistent GainNode identity)
// without touching real WebGL/WASM/Web-Audio.

import { describe, it, expect, vi } from 'vitest';
import { doomDef } from './doom';
import {
  CV_GATE_PORT_IDS,
  CV_GATE_PORT_IDS_BY_SLOT,
  cvGatePortIdForSlot,
} from '$lib/doom/doomkeys';
import type { VideoEngineContext } from '$lib/video/engine';

describe('doomDef — module def shape', () => {
  it('registers with the right type + domain + category + max-instances', () => {
    expect(doomDef.type).toBe('doom');
    expect(doomDef.domain).toBe('video');
    expect(doomDef.category).toBe('sources');
    expect(doomDef.maxInstances).toBe(1);
    expect(doomDef.label).toBe('DOOM');
  });

  it('is owner-only (round 5: host-only widget — only the rack owner may add it)', () => {
    expect(doomDef.ownerOnly).toBe(true);
  });

  it('declares 4 per-slot input GROUPS (p1..p4) × 7 gates = 28 cv ports (#353)', () => {
    const ids = doomDef.inputs.map((p) => p.id);
    // 4 slots × 7 base gates, in (slot, base) declaration order.
    expect(ids).toEqual(CV_GATE_PORT_IDS_BY_SLOT.map((e) => e.portId));
    expect(ids).toHaveLength(4 * CV_GATE_PORT_IDS.length);
    for (const inp of doomDef.inputs) {
      expect(inp.type).toBe('cv');
      // paramTarget routes the CV through engine setParam — the synthetic
      // cv_p{N}_<base> param is then edge-detected into per-slot key events.
      expect(inp.paramTarget).toBe(`cv_${inp.id}`);
    }
  });

  it('migrates the legacy single CV set → p1 (slot 0): bare `up` → `p1_up`', () => {
    expect(doomDef.schemaVersion).toBe(2);
    expect(typeof doomDef.migrateEdgePortId).toBe('function');
    for (const base of CV_GATE_PORT_IDS) {
      expect(doomDef.migrateEdgePortId!(base, 1)).toBe(cvGatePortIdForSlot(0, base));
    }
    // Non-cv ports (out/audio) are left untouched (null = no rewrite).
    expect(doomDef.migrateEdgePortId!('out', 1)).toBeNull();
    expect(doomDef.migrateEdgePortId!('audio_l', 1)).toBeNull();
    // Already-migrated per-slot ports are not double-rewritten.
    expect(doomDef.migrateEdgePortId!('p2_left', 1)).toBeNull();
  });

  it('declares a video out + stereo audio outputs + 6 Phase-1 SP event gates', () => {
    const outs = doomDef.outputs.map((p) => p.id);
    expect(outs).toEqual([
      'out', 'audio_l', 'audio_r',
      // Phase-1 event gates — KILL, DOOR, GUN_p1..p4.
      'evt_kill', 'evt_door', 'evt_gun_p1', 'evt_gun_p2', 'evt_gun_p3', 'evt_gun_p4',
    ]);
    const types = Object.fromEntries(doomDef.outputs.map((p) => [p.id, p.type]));
    expect(types).toEqual({
      out: 'video',
      audio_l: 'audio',
      audio_r: 'audio',
      evt_kill: 'gate',
      evt_door: 'gate',
      evt_gun_p1: 'gate',
      evt_gun_p2: 'gate',
      evt_gun_p3: 'gate',
      evt_gun_p4: 'gate',
    });
  });

  it('Phase-1 event gates all declare type=gate', () => {
    const gates = doomDef.outputs.filter((p) => p.id.startsWith('evt_'));
    expect(gates.map((g) => g.id)).toEqual([
      'evt_kill', 'evt_door', 'evt_gun_p1', 'evt_gun_p2', 'evt_gun_p3', 'evt_gun_p4',
    ]);
    for (const g of gates) expect(g.type).toBe('gate');
  });

  it('every per-slot cv-gate port has a matching synthetic param', () => {
    const paramIds = new Set(doomDef.params.map((p) => p.id));
    for (const { portId } of CV_GATE_PORT_IDS_BY_SLOT) {
      expect(paramIds.has(`cv_${portId}`), `expected param cv_${portId}`).toBe(true);
    }
  });

  it('exposes the audioGain user-facing param (no surprises)', () => {
    const paramIds = doomDef.params.map((p) => p.id);
    expect(paramIds).toContain('audioGain');
  });

  it('has no "running"/pause param (true-lockstep netgame — a local pause would desync)', () => {
    const paramIds = doomDef.params.map((p) => p.id);
    expect(paramIds).not.toContain('running');
  });

  it('schemaVersion is 2 (#353 per-player input groups)', () => {
    expect(doomDef.schemaVersion).toBe(2);
  });
});

// ---------------- Factory: audio-bridge contract ----------------
//
// Bug 3 regression: prior to this slice, the factory published
// silent ConstantSourceNodes as audio_l/audio_r and then MUTATED the
// audioSources Map once the AudioWorklet resolved. The video→audio
// bridge captures the AudioNode reference at addEdge time, so cables
// wired before the swap stayed connected to the silent CSN forever.
// Fix: publish a persistent GainNode per side from t=0 and connect
// the worklet INTO it later. This test pins the node identity.

function makeFakeGl(): WebGL2RenderingContext {
  const stub = (): unknown => ({});
  return {
    getUniformLocation: stub,
    createTexture: () => ({}),
    bindTexture: () => undefined,
    texImage2D: () => undefined,
    texSubImage2D: () => undefined,
    texParameteri: () => undefined,
    pixelStorei: () => undefined,
    deleteTexture: () => undefined,
    deleteFramebuffer: () => undefined,
    deleteProgram: () => undefined,
    TEXTURE_2D: 0, RGBA: 0, UNSIGNED_BYTE: 0,
    TEXTURE_MIN_FILTER: 0, TEXTURE_MAG_FILTER: 0,
    TEXTURE_WRAP_S: 0, TEXTURE_WRAP_T: 0,
    LINEAR: 0, CLAMP_TO_EDGE: 0, UNPACK_FLIP_Y_WEBGL: 0,
  } as unknown as WebGL2RenderingContext;
}

interface FakeNode { __tag: string; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }

function makeFakeAudioCtx(): {
  ctx: BaseAudioContext;
  createdSplitters: FakeNode[];
  createdGains: FakeNode[];
  createdConstants: FakeNode[];
  workletNode: FakeNode | null;
  workletReady: Promise<void>;
} {
  const createdSplitters: FakeNode[] = [];
  const createdGains: FakeNode[] = [];
  const createdConstants: FakeNode[] = [];
  let workletNode: FakeNode | null = null;
  let resolveWorklet: () => void = () => {};
  const workletReady = new Promise<void>((r) => { resolveWorklet = r; });

  const ctx = {
    currentTime: 0,
    audioWorklet: {
      addModule: vi.fn().mockResolvedValue(undefined),
    },
    createGain: () => {
      const n: FakeNode = { __tag: 'gain', connect: vi.fn(), disconnect: vi.fn() };
      createdGains.push(n);
      return { ...n, gain: { value: 1 } };
    },
    createChannelSplitter: () => {
      const n: FakeNode = { __tag: 'splitter', connect: vi.fn(), disconnect: vi.fn() };
      createdSplitters.push(n);
      return n;
    },
    createConstantSource: () => {
      const n: FakeNode = { __tag: 'constant', connect: vi.fn(), disconnect: vi.fn() };
      createdConstants.push(n);
      return {
        ...n,
        offset: { setValueAtTime: vi.fn() },
        start: vi.fn(),
        stop: vi.fn(),
      };
    },
  } as unknown as BaseAudioContext;

  // Replace AudioWorkletNode global with a fake constructor that
  // records the instance + resolves the worklet-ready promise so the
  // test can await the post-load assertions.
  const FakeAudioWorkletNode = class {
    port = { postMessage: vi.fn() };
    connect = vi.fn();
    disconnect = vi.fn();
    constructor() {
      workletNode = this as unknown as FakeNode;
      Object.assign(this, { __tag: 'worklet' });
      resolveWorklet();
    }
  };
  (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeAudioWorkletNode;

  return {
    ctx,
    createdSplitters,
    createdGains,
    createdConstants,
    get workletNode() { return workletNode; },
    workletReady,
  };
}

describe('doomDef.factory — audio bridge contract', () => {
  it('publishes audio_l/audio_r as persistent GainNodes from t=0 + keeps identity after worklet loads', async () => {
    const gl = makeFakeGl();
    const fake = makeFakeAudioCtx();
    const ctx: VideoEngineContext = {
      gl,
      res: { width: 640, height: 360 },
      compileFragment: () => ({}) as WebGLProgram,
      createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
      drawFullscreenQuad: () => undefined,
      audioCtx: fake.ctx as AudioContext,
    };
    const handle = doomDef.factory(ctx, { id: 'doom-x', type: 'doom', params: {}, position: { x: 0, y: 0 } } as never);

    const lBefore = handle.audioSources?.get('audio_l');
    const rBefore = handle.audioSources?.get('audio_r');
    expect(lBefore?.node).toBeDefined();
    expect(rBefore?.node).toBeDefined();
    // Distinct nodes — one per port, so downstream cables on audio_l vs
    // audio_r resolve to separate AudioNodes.
    expect(lBefore!.node).not.toBe(rBefore!.node);

    // Let the worklet-load microtask + the addModule promise settle.
    await fake.workletReady;
    await Promise.resolve();

    const lAfter = handle.audioSources?.get('audio_l');
    const rAfter = handle.audioSources?.get('audio_r');
    // Identity persistence: the bridge captures these refs at addEdge
    // time; mutating the map would silently break already-wired cables.
    expect(lAfter!.node).toBe(lBefore!.node);
    expect(rAfter!.node).toBe(rBefore!.node);

    // Splitter wiring: worklet → splitter, splitter[0] → leftGain,
    // splitter[1] → rightGain. Asserts that the audio path is actually
    // assembled, not just declared.
    expect(fake.workletNode!.connect).toHaveBeenCalledTimes(1);
    expect(fake.createdSplitters).toHaveLength(1);
    const splitter = fake.createdSplitters[0]!;
    expect(splitter.connect).toHaveBeenCalledTimes(2);
    expect(splitter.connect).toHaveBeenNthCalledWith(1, lBefore!.node, 0);
    expect(splitter.connect).toHaveBeenNthCalledWith(2, rBefore!.node, 1);
  });

  it('publishes 6 Phase-1 SP event-gate ConstantSourceNodes (KILL/DOOR/GUN_p1..p4) in audioSources', () => {
    const gl = makeFakeGl();
    const fake = makeFakeAudioCtx();
    const ctx: VideoEngineContext = {
      gl,
      res: { width: 640, height: 360 },
      compileFragment: () => ({}) as WebGLProgram,
      createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
      drawFullscreenQuad: () => undefined,
      audioCtx: fake.ctx as AudioContext,
    };
    const handle = doomDef.factory(ctx, { id: 'doom-evt', type: 'doom', params: {}, position: { x: 0, y: 0 } } as never);
    // 6 CSNs created (KILL + DOOR + 4 × GUN_pN). Identity-persistent — published
    // to audioSources from t=0 so a cable wired before WASM init still sees the
    // pulses.
    expect(fake.createdConstants).toHaveLength(6);
    const ids = ['evt_kill', 'evt_door', 'evt_gun_p1', 'evt_gun_p2', 'evt_gun_p3', 'evt_gun_p4'];
    for (const id of ids) {
      const src = handle.audioSources?.get(id);
      expect(src?.node, `expected ${id} in audioSources`).toBeDefined();
    }
    // All 6 are distinct nodes — each port resolves to its own CSN so a cable
    // wired to evt_gun_p1 doesn't double-pulse from evt_gun_p2.
    const nodes = ids.map((id) => handle.audioSources!.get(id)!.node);
    const unique = new Set(nodes);
    expect(unique.size).toBe(6);
  });

  it('exposes setKeyboardInert (Bug 4 hard gate) — callable before WASM loads', () => {
    const gl = makeFakeGl();
    const ctx: VideoEngineContext = {
      gl,
      res: { width: 640, height: 360 },
      compileFragment: () => ({}) as WebGLProgram,
      createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
      drawFullscreenQuad: () => undefined,
      audioCtx: undefined,
    };
    const handle = doomDef.factory(ctx, { id: 'doom-kb', type: 'doom', params: {}, position: { x: 0, y: 0 } } as never);
    const extras = handle.read?.('extras') as { setKeyboardInert?: (v: boolean) => void } | undefined;
    expect(typeof extras?.setKeyboardInert).toBe('function');
    // No runtime yet (WASM not built/loaded) — caching the inert state must
    // NOT throw; it is re-applied to the runtime once it comes up.
    expect(() => extras!.setKeyboardInert!(true)).not.toThrow();
    expect(() => extras!.setKeyboardInert!(false)).not.toThrow();
  });
});
