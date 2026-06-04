// packages/web/src/lib/video/modules/mandelbulb.test.ts
//
// Unit tests for the MANDELBULB module def shape. The GL raymarch pipeline
// is exercised by E2E (jsdom can't render shaders); the DE algebra is in
// mandelbulb-math.test.ts.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mandelbulbDef, MANDELBULB_DEFAULTS } from './mandelbulb';
import type { VideoEngineContext } from '$lib/video/engine';

describe('mandelbulbDef shape', () => {
  it('is a video-source module with a mono-video output AND a mono-audio out', () => {
    expect(mandelbulbDef.type).toBe('mandelbulb');
    expect(mandelbulbDef.domain).toBe('video');
    const video = mandelbulbDef.outputs.find((o) => o.id === 'video_out');
    expect(video?.type).toBe('mono-video');
    // The slice → waveform → audio out (silent unless the slice toggle is ON,
    // but always DECLARED so the handle-presence sweep pins it).
    const audio = mandelbulbDef.outputs.find((o) => o.id === 'audio_out');
    expect(audio?.type).toBe('audio');
    expect(mandelbulbDef.outputs).toHaveLength(2);
  });

  it('declares zoom + every spatial control AND every slice control as a CV input', () => {
    const ids = mandelbulbDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual([
      'detail_cv', 'hue_cv', 'power_cv', 'rotate_x_cv', 'rotate_y_cv',
      'slice_rx_cv', 'slice_ry_cv', 'slice_rz_cv', 'slice_y_cv', 'zoom_cv',
    ]);
  });

  it('EVERY CV input has a matching param target + linear cvScale (full-range sweep)', () => {
    // The user requirement: zoom + spatial controls under BOTH CV and knobs.
    // Each cv port must map to a real param so the bridge sweeps it.
    const paramIds = new Set(mandelbulbDef.params.map((p) => p.id));
    for (const input of mandelbulbDef.inputs) {
      expect(input.type).toBe('cv');
      expect(input.paramTarget, `${input.id} paramTarget`).toBeTruthy();
      expect(paramIds.has(input.paramTarget!), `${input.paramTarget} is a real param`).toBe(true);
      expect(input.cvScale?.mode, `${input.id} cvScale`).toBe('linear');
    }
  });

  it('every CV-targeted param is also a KNOB on the card (knob + CV each)', () => {
    // Each input.paramTarget must appear in params (so the card renders a
    // knob for it) — the "knob AND CV" guarantee.
    const cvTargets = mandelbulbDef.inputs.map((p) => p.paramTarget);
    const knobIds = new Set(mandelbulbDef.params.map((p) => p.id));
    for (const t of cvTargets) {
      expect(knobIds.has(t!), `${t} has a knob`).toBe(true);
    }
  });

  it('declares the documented param set (incl. the slice toggle + slice controls)', () => {
    const ids = mandelbulbDef.params.map((p) => p.id).sort();
    expect(ids).toEqual([
      'autospin', 'detail', 'hue', 'power', 'rotate_x', 'rotate_y', 'screen_on',
      'slice', 'slice_rx', 'slice_ry', 'slice_rz', 'slice_y', 'zoom',
    ]);
  });

  it('the slice toggle defaults OFF (video-identity guarantee)', () => {
    const slice = mandelbulbDef.params.find((p) => p.id === 'slice')!;
    expect(slice.curve).toBe('discrete');
    expect(slice.defaultValue).toBe(0);
    expect(MANDELBULB_DEFAULTS.slice).toBe(0);
  });

  it('slice_y travels symmetrically in fractal space; slice rotations are ±π', () => {
    const y = mandelbulbDef.params.find((p) => p.id === 'slice_y')!;
    expect(y.min).toBe(-y.max);
    expect(y.max).toBeGreaterThan(0);
    for (const k of ['slice_rx', 'slice_ry', 'slice_rz'] as const) {
      const p = mandelbulbDef.params.find((pp) => pp.id === k)!;
      expect(p.min).toBeCloseTo(-Math.PI, 4);
      expect(p.max).toBeCloseTo(Math.PI, 4);
    }
  });

  it('power defaults to 8 (the classic Mandelbulb) and detail to ~20', () => {
    expect(MANDELBULB_DEFAULTS.power).toBe(8);
    expect(MANDELBULB_DEFAULTS.detail).toBe(20);
    const power = mandelbulbDef.params.find((p) => p.id === 'power')!;
    expect(power.defaultValue).toBe(8);
  });

  it('detail / autospin / screen_on are discrete toggles/steppers', () => {
    for (const k of ['detail', 'autospin', 'screen_on'] as const) {
      expect(mandelbulbDef.params.find((p) => p.id === k)?.curve).toBe('discrete');
    }
  });

  it('declares exactly ONE audio output (audio_out) — the slice readout', () => {
    // Honest port declaration: MANDELBULB now emits audio via the slice
    // readout, wired through VideoNodeHandle.audioSources when slice is ON.
    const audioOuts = mandelbulbDef.outputs.filter((o) => o.type === 'audio');
    expect(audioOuts.map((o) => o.id)).toEqual(['audio_out']);
  });

  it('EVERY slice CV input maps to a real slice param (knob + CV each)', () => {
    const paramIds = new Set(mandelbulbDef.params.map((p) => p.id));
    for (const sid of ['slice_y_cv', 'slice_rx_cv', 'slice_ry_cv', 'slice_rz_cv']) {
      const input = mandelbulbDef.inputs.find((p) => p.id === sid)!;
      expect(input.type).toBe('cv');
      expect(input.cvScale?.mode).toBe('linear');
      expect(paramIds.has(input.paramTarget!)).toBe(true);
    }
  });

  it('files itself into the video palette via def.palette (no shared edit)', () => {
    expect(mandelbulbDef.palette).toEqual({ top: 'Video modules', sub: 'Sources' });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Factory: SLICE-OFF video identity + SLICE-ON audio wiring.
//
// jsdom can't run the GL raymarch, but the factory's CHEAP synchronous work
// (FBO alloc + the audio-node decision) is testable with stub GL + audio ctx.
// The backwards-compat guarantee — slice OFF ⇒ NO audio node created — is the
// load-bearing assertion here.
// ──────────────────────────────────────────────────────────────────────────

function makeFakeGl(): WebGL2RenderingContext {
  return {
    createTexture: () => ({}),
    bindTexture: () => undefined,
    texImage2D: () => undefined,
    texParameteri: () => undefined,
    createFramebuffer: () => ({}),
    bindFramebuffer: () => undefined,
    framebufferTexture2D: () => undefined,
    checkFramebufferStatus: () => 0x8cd5, // FRAMEBUFFER_COMPLETE
    viewport: () => undefined,
    clearColor: () => undefined,
    clear: () => undefined,
    deleteTexture: () => undefined,
    deleteFramebuffer: () => undefined,
    deleteProgram: () => undefined,
    getUniformLocation: () => ({}),
    TEXTURE_2D: 0, RGBA8: 0, RGBA: 0, UNSIGNED_BYTE: 0,
    TEXTURE_MIN_FILTER: 0, TEXTURE_MAG_FILTER: 0,
    TEXTURE_WRAP_S: 0, TEXTURE_WRAP_T: 0, LINEAR: 0, CLAMP_TO_EDGE: 0,
    FRAMEBUFFER: 0, COLOR_ATTACHMENT0: 0, FRAMEBUFFER_COMPLETE: 0x8cd5,
    COLOR_BUFFER_BIT: 0,
  } as unknown as WebGL2RenderingContext;
}

interface FakeAudioBits {
  ctx: AudioContext;
  workletReady: Promise<void>;
  workletNode: { port: { postMessage: ReturnType<typeof vi.fn> } } | null;
  gainCount: () => number;
}
function makeFakeAudioCtx(): FakeAudioBits {
  let workletNode: FakeAudioBits['workletNode'] = null;
  let resolveWorklet: () => void = () => {};
  const workletReady = new Promise<void>((r) => { resolveWorklet = r; });
  let gains = 0;
  const ctx = {
    currentTime: 0,
    destination: { connect: vi.fn(), disconnect: vi.fn() },
    audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    createGain: () => { gains++; return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }; },
    createConstantSource: () => ({
      offset: { value: 0 }, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(),
    }),
  } as unknown as AudioContext;
  const FakeAudioWorkletNode = class {
    port = { postMessage: vi.fn() };
    connect = vi.fn();
    disconnect = vi.fn();
    constructor() { workletNode = this as unknown as FakeAudioBits['workletNode']; resolveWorklet(); }
  };
  (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeAudioWorkletNode;
  return { ctx, workletReady, get workletNode() { return workletNode; }, gainCount: () => gains };
}

function makeCtx(audio: FakeAudioBits | null): VideoEngineContext {
  return {
    gl: makeFakeGl(),
    res: { width: 640, height: 480 },
    compileFragment: () => ({}) as WebGLProgram,
    createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
    drawFullscreenQuad: () => undefined,
    audioCtx: audio?.ctx,
    notifyAudioSourcesChanged: vi.fn(),
  } as unknown as VideoEngineContext;
}

const mkNode = (params: Record<string, number> = {}) =>
  ({ id: 'mb-1', type: 'mandelbulb', params, position: { x: 0, y: 0 } } as never);

describe('mandelbulbDef.factory — slice-off video identity', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('SLICE OFF (default): NO audio node is created + audioSources has no audio_out', async () => {
    const audio = makeFakeAudioCtx();
    const addModule = audio.ctx.audioWorklet.addModule as ReturnType<typeof vi.fn>;
    const handle = mandelbulbDef.factory(makeCtx(audio), mkNode());
    // Let any (erroneous) async worklet load settle.
    await Promise.resolve();
    expect(handle.audioSources?.has('audio_out') ?? false).toBe(false);
    expect(addModule).not.toHaveBeenCalled();
    expect(audio.workletNode).toBeNull();
    handle.dispose();
  });

  it('SLICE OFF but no AudioContext at all: still constructs cleanly (no audio)', () => {
    const handle = mandelbulbDef.factory(makeCtx(null), mkNode());
    expect(handle.domain).toBe('video');
    expect(handle.audioSources?.size ?? 0).toBe(0);
    handle.dispose();
  });

  it('read("slice") reflects the toggle', () => {
    const off = mandelbulbDef.factory(makeCtx(null), mkNode());
    expect(off.read?.('slice')).toBe(false);
    off.dispose();
    const on = mandelbulbDef.factory(makeCtx(null), mkNode({ slice: 1 }));
    expect(on.read?.('slice')).toBe(true);
    on.dispose();
  });
});

describe('mandelbulbDef.factory — slice-on audio wiring', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('SLICE ON at spawn: publishes audio_out + loads the worklet + posts a wave', async () => {
    const audio = makeFakeAudioCtx();
    const handle = mandelbulbDef.factory(makeCtx(audio), mkNode({ slice: 1 }));
    // The persistent placeholder gain is published synchronously.
    expect(handle.audioSources?.has('audio_out')).toBe(true);
    await audio.workletReady;
    await Promise.resolve(); await Promise.resolve();
    expect(audio.workletNode).not.toBeNull();
    const posts = audio.workletNode!.port.postMessage.mock.calls.map((c) => c[0]);
    expect(posts.some((m: { type?: string }) => m?.type === 'setWave')).toBe(true);
    handle.dispose();
  });

  it('toggling slice ON via setParam lazily stands up the audio chain', async () => {
    const audio = makeFakeAudioCtx();
    const addModule = audio.ctx.audioWorklet.addModule as ReturnType<typeof vi.fn>;
    const handle = mandelbulbDef.factory(makeCtx(audio), mkNode());
    expect(addModule).not.toHaveBeenCalled();
    handle.setParam('slice', 1);
    expect(handle.audioSources?.has('audio_out')).toBe(true);
    await audio.workletReady;
    expect(addModule).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('a slice-shaping param change reposts a fresh waveform; a camera move does NOT', async () => {
    const audio = makeFakeAudioCtx();
    const handle = mandelbulbDef.factory(makeCtx(audio), mkNode({ slice: 1 }));
    await audio.workletReady;
    await Promise.resolve(); await Promise.resolve();
    const post = audio.workletNode!.port.postMessage as ReturnType<typeof vi.fn>;
    const before = post.mock.calls.length;
    // Camera-only move (zoom): the slice is camera-INDEPENDENT → no repost.
    handle.setParam('zoom', 2.5);
    expect(post.mock.calls.length).toBe(before);
    // Slice-shaping move (slice_y): a fresh scan is reposted.
    handle.setParam('slice_y', 0.7);
    const setWaves = post.mock.calls
      .map((c) => c[0])
      .filter((m: { type?: string }) => m?.type === 'setWave');
    expect(setWaves.length).toBeGreaterThanOrEqual(2);
    handle.dispose();
  });
});
