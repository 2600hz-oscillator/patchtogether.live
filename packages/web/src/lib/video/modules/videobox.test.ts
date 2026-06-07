// packages/web/src/lib/video/modules/videobox.test.ts
//
// Locks down VIDEOBOX's module-def shape. Mirrors doom.test.ts —
// no factory/runtime execution (those need WebGL + a real <video>
// element; covered in e2e).

import { describe, expect, it, vi } from 'vitest';
import { videoboxDef } from './videobox';
import type { VideoboxHandleExtras } from './videobox';
import type { VideoEngineContext } from '$lib/video/engine';
import { getVideoModuleDef, listVideoModuleDefs } from '$lib/video/module-registry';
// Side-effect import auto-registers every video def (including ours).
import '$lib/video/modules';

describe('videoboxDef — module def shape', () => {
  it('registers under type "videobox" with the right metadata', () => {
    expect(videoboxDef.type).toBe('videobox');
    expect(videoboxDef.domain).toBe('video');
    expect(videoboxDef.label).toBe('videobox');
    expect(videoboxDef.category).toBe('sources');
    expect(videoboxDef.schemaVersion).toBe(1);
  });

  it('declares a single play_trigger gate input that routes through a synthetic param', () => {
    expect(videoboxDef.inputs).toHaveLength(1);
    const inp = videoboxDef.inputs[0]!;
    expect(inp.id).toBe('play_trigger');
    expect(inp.type).toBe('gate');
    // The cross-domain bridge sets the synthetic cv_<port> param so the
    // engine setParam path catches edges. Mirrors DOOM's CV-gate plumbing.
    expect(inp.paramTarget).toBe('cv_play_trigger');
  });

  it('declares one video output + stereo audio outputs', () => {
    const outs = videoboxDef.outputs.map((o) => ({ id: o.id, type: o.type }));
    expect(outs).toEqual([
      { id: 'video',   type: 'video' },
      { id: 'audio_l', type: 'audio' },
      { id: 'audio_r', type: 'audio' },
    ]);
  });

  it('exposes a gain user param + the cv_play_trigger edge-detector param', () => {
    const ids = videoboxDef.params.map((p) => p.id);
    expect(ids).toContain('gain');
    expect(ids).toContain('cv_play_trigger');

    const gain = videoboxDef.params.find((p) => p.id === 'gain')!;
    expect(gain.min).toBe(0);
    expect(gain.max).toBe(2);
    expect(gain.defaultValue).toBe(1);
    expect(gain.curve).toBe('linear');

    const cv = videoboxDef.params.find((p) => p.id === 'cv_play_trigger')!;
    expect(cv.min).toBe(0);
    expect(cv.max).toBe(1);
    expect(cv.curve).toBe('linear');
  });

  it('every default value is within the declared min/max range', () => {
    for (const p of videoboxDef.params) {
      expect(p.defaultValue, `${p.id} ≥ min`).toBeGreaterThanOrEqual(p.min);
      expect(p.defaultValue, `${p.id} ≤ max`).toBeLessThanOrEqual(p.max);
    }
  });

  it('appears in the global video registry list (auto-registered via barrel import)', () => {
    const types = listVideoModuleDefs().map((d) => d.type);
    expect(types).toContain('videobox');
    const looked = getVideoModuleDef('videobox');
    expect(looked).toBe(videoboxDef);
  });

  it('has a factory function (not invoked under node — see e2e)', () => {
    expect(typeof videoboxDef.factory).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Audio keep-alive contract (the 1fps fix).
//
// With nothing patched to its audio outputs, a MediaElementAudioSourceNode
// whose graph never reaches audioCtx.destination is not pulled in real-time,
// so Chromium throttles the <video>'s decode to ~1 fps -> rVFC fires ~1/sec
// -> the uploader runs at ~1 fps -> visibly choppy video. wireAudio() must
// install a permanent silent gain(0) -> destination keep-alive so the
// element is demanded every quantum (full-rate decode) without leaking audio.
// ---------------------------------------------------------------------------

interface FakeAudioNode {
  __tag: string;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function makeFakeGl(): WebGL2RenderingContext {
  const stub = (): unknown => ({});
  return {
    getUniformLocation: stub,
    createTexture: () => ({}),
    bindTexture: () => undefined,
    texParameteri: () => undefined,
    deleteTexture: () => undefined,
    deleteFramebuffer: () => undefined,
    deleteProgram: () => undefined,
    TEXTURE_2D: 0, RGBA: 0, UNSIGNED_BYTE: 0,
    TEXTURE_MIN_FILTER: 0, TEXTURE_MAG_FILTER: 0,
    TEXTURE_WRAP_S: 0, TEXTURE_WRAP_T: 0,
    LINEAR: 0, CLAMP_TO_EDGE: 0, UNPACK_FLIP_Y_WEBGL: 0,
  } as unknown as WebGL2RenderingContext;
}

function makeFakeAudioCtx(initialState: AudioContextState = 'suspended'): {
  ctx: AudioContext;
  destination: FakeAudioNode;
  createdGains: (FakeAudioNode & { gain: { value: number } })[];
  createdSplitters: FakeAudioNode[];
  mediaElSrc: FakeAudioNode | null;
  resume: ReturnType<typeof vi.fn>;
  state: () => AudioContextState;
} {
  const createdGains: (FakeAudioNode & { gain: { value: number } })[] = [];
  const createdSplitters: FakeAudioNode[] = [];
  let mediaElSrc: FakeAudioNode | null = null;
  const destination: FakeAudioNode = { __tag: 'destination', connect: vi.fn(), disconnect: vi.fn() };
  let state: AudioContextState = initialState;
  const resume = vi.fn().mockImplementation(() => { state = 'running'; return Promise.resolve(); });

  const ctx = {
    get state() { return state; },
    get currentTime() { return 0; },
    destination,
    resume,
    createConstantSource: () => ({
      __tag: 'const',
      offset: { setValueAtTime: vi.fn() },
      start: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
    createMediaElementSource: () => {
      const n: FakeAudioNode = { __tag: 'mediaElSrc', connect: vi.fn(), disconnect: vi.fn() };
      mediaElSrc = n;
      return n;
    },
    createChannelSplitter: () => {
      const n: FakeAudioNode = { __tag: 'splitter', connect: vi.fn(), disconnect: vi.fn() };
      createdSplitters.push(n);
      return n;
    },
    createGain: () => {
      const n = { __tag: 'gain', gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      createdGains.push(n);
      return n;
    },
  } as unknown as AudioContext;

  return {
    ctx,
    destination,
    createdGains,
    createdSplitters,
    get mediaElSrc() { return mediaElSrc; },
    resume,
    state: () => state,
  };
}

function makeCtx(fake: ReturnType<typeof makeFakeAudioCtx>): VideoEngineContext {
  return {
    gl: makeFakeGl(),
    res: { width: 640, height: 480 },
    compileFragment: () => ({}) as WebGLProgram,
    createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
    drawFullscreenQuad: () => undefined,
    audioCtx: fake.ctx,
  };
}

/** A minimal <video> stand-in — wireAudio only needs a non-null element. */
function makeFakeVideoEl(): HTMLVideoElement {
  return { requestVideoFrameCallback: undefined } as unknown as HTMLVideoElement;
}

describe('videoboxDef.factory — silent audio keep-alive (1fps fix)', () => {
  it('connects MediaElementSource -> gain(0) -> destination on wireAudio + resumes a suspended context', () => {
    const fake = makeFakeAudioCtx('suspended');
    const handle = videoboxDef.factory(makeCtx(fake), { id: 'vb', type: 'videobox', params: {}, position: { x: 0, y: 0 } } as never);
    const extras = handle.read?.('extras') as VideoboxHandleExtras;

    // Attach an element + wire audio (mirrors the card's load path).
    handle.attachExternalSource?.('video', makeFakeVideoEl());
    expect(handle.read?.('hasKeepAlive')).toBe(false);
    extras.wireAudio();

    // A keep-alive GainNode must exist + carry zero gain (no audible leak).
    expect(handle.read?.('hasKeepAlive')).toBe(true);
    expect(fake.createdGains).toHaveLength(1);
    const keepAlive = fake.createdGains[0]!;
    expect(keepAlive.gain.value).toBe(0);

    // src -> keepAlive (in parallel with src -> splitter) and
    // keepAlive -> destination, so the context actually pulls the element.
    expect(fake.mediaElSrc!.connect).toHaveBeenCalledWith(keepAlive);
    expect(keepAlive.connect).toHaveBeenCalledWith(fake.ctx.destination);

    // A suspended context won't pull -> must be resumed.
    expect(fake.resume).toHaveBeenCalledTimes(1);
    expect(fake.state()).toBe('running');
  });

  it('does not resume an already-running context', () => {
    const fake = makeFakeAudioCtx('running');
    const handle = videoboxDef.factory(makeCtx(fake), { id: 'vb', type: 'videobox', params: {}, position: { x: 0, y: 0 } } as never);
    const extras = handle.read?.('extras') as VideoboxHandleExtras;
    handle.attachExternalSource?.('video', makeFakeVideoEl());
    extras.wireAudio();
    expect(fake.resume).not.toHaveBeenCalled();
    expect(handle.read?.('hasKeepAlive')).toBe(true);
  });

  it('tears down the keep-alive gain node on unwireAudio (no leaked nodes)', () => {
    const fake = makeFakeAudioCtx('running');
    const handle = videoboxDef.factory(makeCtx(fake), { id: 'vb', type: 'videobox', params: {}, position: { x: 0, y: 0 } } as never);
    const extras = handle.read?.('extras') as VideoboxHandleExtras;
    handle.attachExternalSource?.('video', makeFakeVideoEl());
    extras.wireAudio();
    const keepAlive = fake.createdGains[0]!;

    extras.unwireAudio();
    expect(keepAlive.disconnect).toHaveBeenCalledTimes(1);
    expect(handle.read?.('hasKeepAlive')).toBe(false);
  });

  it('tears down the keep-alive on dispose()', () => {
    const fake = makeFakeAudioCtx('running');
    const handle = videoboxDef.factory(makeCtx(fake), { id: 'vb', type: 'videobox', params: {}, position: { x: 0, y: 0 } } as never);
    const extras = handle.read?.('extras') as VideoboxHandleExtras;
    handle.attachExternalSource?.('video', makeFakeVideoEl());
    extras.wireAudio();
    const keepAlive = fake.createdGains[0]!;

    handle.dispose();
    expect(keepAlive.disconnect).toHaveBeenCalled();
    expect(handle.read?.('hasKeepAlive')).toBe(false);
  });
});
