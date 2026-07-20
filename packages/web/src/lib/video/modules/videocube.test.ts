// packages/web/src/lib/video/modules/videocube.test.ts
//
// VIDEOCUBE def-shape + factory smoke. The GL COMBINE pipeline is exercised by
// E2E (jsdom can't render shaders) + the pure math in videocube-core.test.ts;
// here we pin the I/O contract and the cheap synchronous factory work — the
// 3-ring alloc, the MONO-DRONE audio seam standing up under a mock AudioContext,
// and a draw() driving the reduce→cube-slice-scan→setWave post end to end.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { videocubeDef, VIDEOCUBE_DEFAULTS } from './videocube';
import type { VideoEngineContext, VideoFrameContext } from '$lib/video/engine';

// ── Fake GL: no-op every call; return sane values where the factory branches. ──
function makeFakeGl(): WebGL2RenderingContext {
  const target: Record<string, unknown> = {
    createTexture: () => ({}),
    createFramebuffer: () => ({}),
    getUniformLocation: () => ({}),
    checkFramebufferStatus: () => 0x8cd5, // FRAMEBUFFER_COMPLETE
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    getExtension: () => null,
    getParameter: () => '',
    getError: () => 0,
    readPixels: () => undefined, // leaves the strip all-zero (black rings)
  };
  return new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      return () => 0; // any other method → no-op / any constant → 0
    },
  }) as unknown as WebGL2RenderingContext;
}

interface FakeAudio {
  ctx: AudioContext;
  workletReady: Promise<void>;
  node: { port: { postMessage: ReturnType<typeof vi.fn> } } | null;
}
function makeFakeAudio(): FakeAudio {
  let node: FakeAudio['node'] = null;
  let resolve: () => void = () => {};
  const workletReady = new Promise<void>((r) => { resolve = r; });
  const ctx = {
    currentTime: 0,
    destination: { connect: vi.fn(), disconnect: vi.fn() },
    audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    createGain: () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }),
    createConstantSource: () => ({ offset: { value: 0 }, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() }),
  } as unknown as AudioContext;
  const FakeNode = class {
    port = { postMessage: vi.fn() };
    connect = vi.fn();
    disconnect = vi.fn();
    parameters = new Map([
      ['tune', { setValueAtTime: vi.fn() }],
      ['fine', { setValueAtTime: vi.fn() }],
      ['level', { setValueAtTime: vi.fn() }],
    ]);
    constructor() { node = this as unknown as FakeAudio['node']; resolve(); }
  };
  (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeNode;
  return { ctx, workletReady, get node() { return node; } };
}

function makeCtx(audio: FakeAudio | null): VideoEngineContext {
  return {
    gl: makeFakeGl(),
    res: { width: 1024, height: 768 },
    compileFragment: () => ({}) as WebGLProgram,
    createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
    drawFullscreenQuad: () => undefined,
    audioCtx: audio?.ctx,
    notifyAudioSourcesChanged: vi.fn(),
  } as unknown as VideoEngineContext;
}

const mkNode = (params: Record<string, number> = {}) =>
  ({ id: 'vc-1', type: 'videocube', params, position: { x: 0, y: 0 } } as never);

function mkFrame(gl: WebGL2RenderingContext): VideoFrameContext {
  return {
    gl, time: 0, frame: 0, timeDelta: 1 / 60,
    getInputTexture: () => null,
    isOutputConnected: () => true,
  } as unknown as VideoFrameContext;
}

describe('videocubeDef — I/O contract', () => {
  it('is a lowercase-labelled video source with pullExempt', () => {
    expect(videocubeDef.type).toBe('videocube');
    expect(videocubeDef.label).toBe('videocube');
    expect(videocubeDef.label).toBe(videocubeDef.label.toLowerCase());
    expect(videocubeDef.domain).toBe('video');
    expect(videocubeDef.pullExempt).toBe(true);
  });

  it('has 3 video inputs (A/B/C) + a video_out and audio_out', () => {
    for (const id of ['video_a', 'video_b', 'video_c']) {
      const p = videocubeDef.inputs.find((i) => i.id === id);
      expect(p, id).toBeDefined();
      expect(p!.type).toBe('video');
    }
    const vout = videocubeDef.outputs.find((o) => o.id === 'video_out');
    const aout = videocubeDef.outputs.find((o) => o.id === 'audio_out');
    expect(vout?.type).toBe('video');
    expect(aout?.type).toBe('audio');
  });

  it('every continuous CV input carries cvScale linear + a paramTarget', () => {
    const cvs = videocubeDef.inputs.filter((i) => i.type === 'cv');
    expect(cvs.length).toBeGreaterThan(10);
    for (const cv of cvs) {
      expect(cv.cvScale, cv.id).toEqual({ mode: 'linear' });
      expect(cv.paramTarget, cv.id).toBeTruthy();
      // the target must be a real param
      expect(videocubeDef.params.some((p) => p.id === cv.paramTarget), `${cv.id}→${cv.paramTarget}`).toBe(true);
    }
  });

  it('mirrors CUBE field knobs + the neutral defaults (Y centred, others 0/1)', () => {
    const ids = new Set(videocubeDef.params.map((p) => p.id));
    for (const id of ['morph_fc', 'connect', 'connect_strength', 'crush', 'space_crush', 'space_diffuse', 'slice_y', 'slice_rx', 'slice_ry', 'slice_rz', 'fold', 'spread', 'tune', 'fine', 'level', 'wrap', 'material', 'screen_on', 'reader_mode', 'freeze', 'live']) {
      expect(ids.has(id), id).toBe(true);
    }
    expect(VIDEOCUBE_DEFAULTS.slice_y).toBe(0.5);
    expect(VIDEOCUBE_DEFAULTS.morph_fc).toBe(0);
    expect(VIDEOCUBE_DEFAULTS.level).toBe(1);
    expect(VIDEOCUBE_DEFAULTS.screen_on).toBe(1);
  });

  it('every port + control is documented (STRICT completeness inputs)', () => {
    const d = videocubeDef.docs!;
    for (const i of videocubeDef.inputs) expect(d.inputs?.[i.id], `input ${i.id}`).toBeTruthy();
    for (const o of videocubeDef.outputs) expect(d.outputs?.[o.id], `output ${o.id}`).toBeTruthy();
    for (const p of videocubeDef.params) expect(d.controls?.[p.id], `control ${p.id}`).toBeTruthy();
  });
});

describe('videocubeDef.factory — construction + audio seam', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('constructs cleanly with NO AudioContext (video-only, no audio node)', () => {
    const handle = videocubeDef.factory(makeCtx(null), mkNode());
    expect(handle.domain).toBe('video');
    expect(handle.audioSources?.size ?? 0).toBe(0);
    expect(handle.read?.('audioReady')).toBe(false);
    handle.dispose();
  });

  it('MONO-DRONE: publishes audio_out synchronously + loads the mandelbulb-osc worklet', async () => {
    const audio = makeFakeAudio();
    const addModule = audio.ctx.audioWorklet.addModule as ReturnType<typeof vi.fn>;
    const handle = videocubeDef.factory(makeCtx(audio), mkNode());
    // The persistent placeholder gain is published up front (stable identity).
    expect(handle.audioSources?.has('audio_out')).toBe(true);
    expect(addModule).toHaveBeenCalled();
    await audio.workletReady;
    await Promise.resolve(); await Promise.resolve();
    expect(audio.node).not.toBeNull();
    expect(handle.read?.('audioReady')).toBe(true);
    handle.dispose();
  });

  it('a draw() runs the reduce→cube-slice-scan→setWave seam (posts a 256-sample wave)', async () => {
    const audio = makeFakeAudio();
    const ctx = makeCtx(audio);
    const handle = videocubeDef.factory(ctx, mkNode());
    await audio.workletReady;
    await Promise.resolve(); await Promise.resolve();
    // Drive one frame: compiles the deferred programs + runs the audio recompute.
    handle.surface.draw(mkFrame(ctx.gl));
    const posts = audio.node!.port.postMessage.mock.calls.map((c) => c[0] as { type?: string; wave?: Float32Array });
    const setWave = posts.find((m) => m?.type === 'setWave');
    expect(setWave, 'a setWave was posted from the slice scan').toBeTruthy();
    expect(setWave!.wave?.length, '256-sample cube slice').toBe(256);
    handle.dispose();
  });

  it('setParam clamps + round-trips through readParam', () => {
    const handle = videocubeDef.factory(makeCtx(null), mkNode());
    handle.setParam('morph_fc', 0.7);
    expect(handle.readParam('morph_fc')).toBe(0.7);
    handle.setParam('reader_mode', 2);
    expect(handle.readParam('reader_mode')).toBe(2);
    handle.dispose();
  });
});
