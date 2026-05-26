// packages/web/src/lib/video/modules/doom.test.ts
//
// Locks down DOOM's module-def shape — port set, paramTarget wiring,
// maxInstances, audio output declarations. Plus a focused factory test
// that pins the audio-bridge contract (persistent GainNode identity)
// without touching real WebGL/WASM/Web-Audio.

import { describe, it, expect, vi } from 'vitest';
import { doomDef } from './doom';
import { CV_GATE_PORT_IDS } from '$lib/doom/doomkeys';
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

  it('declares exactly the 7 CV-gate input ports the plan calls for', () => {
    const ids = doomDef.inputs.map((p) => p.id);
    expect(ids).toEqual([...CV_GATE_PORT_IDS]);
    for (const inp of doomDef.inputs) {
      expect(inp.type).toBe('cv');
      // paramTarget routes the CV through engine setParam — the synthetic
      // cv_<port> param is then edge-detected into key-down/up events.
      expect(inp.paramTarget).toBe(`cv_${inp.id}`);
    }
  });

  it('declares a video out + stereo audio outputs that ride the video → audio bridge', () => {
    const outs = doomDef.outputs.map((p) => p.id);
    expect(outs).toEqual(['out', 'audio_l', 'audio_r']);
    const types = Object.fromEntries(doomDef.outputs.map((p) => [p.id, p.type]));
    expect(types).toEqual({ out: 'video', audio_l: 'audio', audio_r: 'audio' });
  });

  it('every cv-gate port has a matching synthetic param', () => {
    const paramIds = new Set(doomDef.params.map((p) => p.id));
    for (const port of CV_GATE_PORT_IDS) {
      expect(paramIds.has(`cv_${port}`), `expected param cv_${port}`).toBe(true);
    }
  });

  it('exposes the run / audioGain user-facing params (no surprises)', () => {
    const paramIds = doomDef.params.map((p) => p.id);
    expect(paramIds).toContain('running');
    expect(paramIds).toContain('audioGain');
  });

  it('schemaVersion is 1 (first slice)', () => {
    expect(doomDef.schemaVersion).toBe(1);
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
  workletNode: FakeNode | null;
  workletReady: Promise<void>;
} {
  const createdSplitters: FakeNode[] = [];
  const createdGains: FakeNode[] = [];
  let workletNode: FakeNode | null = null;
  let resolveWorklet: () => void = () => {};
  const workletReady = new Promise<void>((r) => { resolveWorklet = r; });

  const ctx = {
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

  return { ctx, createdSplitters, createdGains, get workletNode() { return workletNode; }, workletReady };
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
});
