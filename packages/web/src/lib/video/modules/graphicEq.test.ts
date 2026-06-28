// packages/web/src/lib/video/modules/graphicEq.test.ts
//
// Factory-level guard for GRAPHIC EQ's audio→video bridge (the cross-domain
// audio-input tap). graphic-eq-core.test.ts covers only the pure math, and the
// render-smoke e2e runs with NOTHING patched into audio_l/audio_r (silent by
// design) — so without this, the L/R AnalyserNode tap, the gain(0) keep-alive,
// the audioInputs port mapping, and resume-on-suspended could silently break
// and every unit test + CI would stay green. That is exactly the silent-bridge
// class the real-source-chain discipline exists to catch (cf. recorderbox.test.ts
// / videobox.test.ts, which guard the same cross-domain contract).

import { describe, expect, it, vi } from 'vitest';
import { graphicEqDef } from './graphicEq';
import { FFT_SIZE } from './graphic-eq-core';
import type { VideoEngineContext } from '$lib/video/engine';

interface FakeNode {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

/** Minimal WebGL2 stand-in — survives the factory's program/VAO/VBO setup. */
function makeFakeGl(): WebGL2RenderingContext {
  const obj = (): unknown => ({});
  return {
    createShader: obj,
    shaderSource: () => undefined,
    compileShader: () => undefined,
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: () => undefined,
    createProgram: obj,
    attachShader: () => undefined,
    linkProgram: () => undefined,
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram: () => undefined,
    createBuffer: obj,
    createVertexArray: obj,
    bindVertexArray: () => undefined,
    bindBuffer: () => undefined,
    bufferData: () => undefined,
    enableVertexAttribArray: () => undefined,
    vertexAttribPointer: () => undefined,
    deleteBuffer: () => undefined,
    deleteVertexArray: () => undefined,
    deleteFramebuffer: () => undefined,
    deleteTexture: () => undefined,
    VERTEX_SHADER: 0, FRAGMENT_SHADER: 1, COMPILE_STATUS: 2, LINK_STATUS: 3,
    ARRAY_BUFFER: 4, DYNAMIC_DRAW: 5, FLOAT: 6,
  } as unknown as WebGL2RenderingContext;
}

function makeFakeAudioCtx(initialState: AudioContextState = 'suspended'): {
  ctx: AudioContext;
  destination: FakeNode;
  createdAnalysers: (FakeNode & { fftSize: number })[];
  createdGains: (FakeNode & { gain: { value: number } })[];
  resume: ReturnType<typeof vi.fn>;
  state: () => AudioContextState;
} {
  const createdAnalysers: (FakeNode & { fftSize: number })[] = [];
  const createdGains: (FakeNode & { gain: { value: number } })[] = [];
  const destination: FakeNode = { connect: vi.fn(), disconnect: vi.fn() };
  let state: AudioContextState = initialState;
  const resume = vi.fn().mockImplementation(() => { state = 'running'; return Promise.resolve(); });

  const ctx = {
    get state() { return state; },
    get sampleRate() { return 48000; },
    destination,
    resume,
    createAnalyser: () => {
      const n = {
        fftSize: 2048,
        smoothingTimeConstant: 0,
        minDecibels: 0,
        maxDecibels: 0,
        get frequencyBinCount(): number { return this.fftSize / 2; },
        connect: vi.fn(),
        disconnect: vi.fn(),
        getByteFrequencyData: vi.fn(),
      };
      createdAnalysers.push(n as unknown as FakeNode & { fftSize: number });
      return n;
    },
    createGain: () => {
      const n = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      createdGains.push(n);
      return n;
    },
  } as unknown as AudioContext;

  return { ctx, destination, createdAnalysers, createdGains, resume, state: () => state };
}

function makeCtx(audioCtx?: AudioContext): VideoEngineContext {
  return {
    gl: makeFakeGl(),
    res: { width: 1024, height: 768 },
    compileFragment: () => ({}) as WebGLProgram,
    createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
    drawFullscreenQuad: () => undefined,
    audioCtx,
  } as unknown as VideoEngineContext;
}

const node = { id: 'geq', type: 'graphicEq', params: {}, position: { x: 0, y: 0 } };

describe('graphicEqDef.factory — stereo audio→video bridge', () => {
  it('creates two FFT_SIZE analysers, a silent keep-alive, and maps both audio ports', () => {
    const fake = makeFakeAudioCtx('suspended');
    const handle = graphicEqDef.factory(makeCtx(fake.ctx), node as never);

    // Two analysers, both at FFT_SIZE (the bin count the band fold expects).
    expect(fake.createdAnalysers).toHaveLength(2);
    expect(fake.createdAnalysers[0]!.fftSize).toBe(FFT_SIZE);
    expect(fake.createdAnalysers[1]!.fftSize).toBe(FFT_SIZE);

    // Exactly one keep-alive gain, SILENT — this is a visualizer tap, never a
    // bus; a non-zero gain here would leak the input to the speakers.
    expect(fake.createdGains).toHaveLength(1);
    const keepAlive = fake.createdGains[0]!;
    expect(keepAlive.gain.value).toBe(0);

    // analyserL/R → keepAlive → destination, so Chromium actually pulls the
    // subgraph (an orphan analyser is never processed → no frequency data).
    const [analyserL, analyserR] = fake.createdAnalysers;
    expect(analyserL!.connect).toHaveBeenCalledWith(keepAlive);
    expect(analyserR!.connect).toHaveBeenCalledWith(keepAlive);
    expect(keepAlive.connect).toHaveBeenCalledWith(fake.destination);

    // audioInputs keys MUST match the def's input ids (audio_l/audio_r) or the
    // engine connects the upstream source into nothing → dead bridge.
    const ai = handle.audioInputs;
    expect(ai).toBeDefined();
    expect(ai!.get('audio_l')?.node).toBe(analyserL);
    expect(ai!.get('audio_l')?.input).toBe(0);
    expect(ai!.get('audio_r')?.node).toBe(analyserR);
    expect(ai!.get('audio_r')?.input).toBe(0);
  });

  it('resumes a SUSPENDED context (an idle context never pulls the tap)', () => {
    const fake = makeFakeAudioCtx('suspended');
    graphicEqDef.factory(makeCtx(fake.ctx), node as never);
    expect(fake.resume).toHaveBeenCalledTimes(1);
    expect(fake.state()).toBe('running');
  });

  it('does NOT resume an already-running context', () => {
    const fake = makeFakeAudioCtx('running');
    graphicEqDef.factory(makeCtx(fake.ctx), node as never);
    expect(fake.resume).not.toHaveBeenCalled();
  });

  it('still returns a renderable handle with no audioInputs when there is no AudioContext', () => {
    const handle = graphicEqDef.factory(makeCtx(undefined), node as never);
    expect(handle.surface).toBeDefined();
    expect(handle.audioInputs).toBeUndefined();
  });
});
