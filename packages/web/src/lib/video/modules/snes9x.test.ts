// packages/web/src/lib/video/modules/snes9x.test.ts
//
// Module-def shape + factory wiring tests for the SNES9X module. The real
// emulation is covered by the snes9x e2e + the pure unit suites under
// $lib/snes9x/; here we pin the IO contract (clock_in + 12 gamepad gate
// inputs; out + audio_l/audio_r + gate1..4 + cv1..4 outputs), the
// audioSources registration (stereo + all gate/CV CSNs), and the
// clock_in→gate3 passthrough pulse via setParam (no ROM needed: N<=1 → ×1
// in-phase passthrough).

import { describe, it, expect, vi } from 'vitest';
import { snes9xDef } from './snes9x';
import type { VideoEngineContext } from '$lib/video/engine';
import { SNES_BUTTONS } from '$lib/snes9x/snes-input';

describe('snes9xDef — module shape', () => {
  it('is a single-instance games video module', () => {
    expect(snes9xDef.type).toBe('snes9x');
    expect(snes9xDef.domain).toBe('video');
    expect(snes9xDef.label).toBe('SNES9X');
    expect(snes9xDef.category).toBe('games');
    expect(snes9xDef.maxInstances).toBe(1);
  });

  it('declares clock_in + the full SNES gamepad as gate inputs', () => {
    const ids = snes9xDef.inputs.map((p) => p.id);
    expect(ids).toContain('clock_in');
    for (const b of SNES_BUTTONS) expect(ids).toContain(b);
    // 1 clock + 12 buttons.
    expect(ids).toHaveLength(13);
    for (const p of snes9xDef.inputs) expect(p.type).toBe('gate');
  });

  it('declares out + separate audio_l/audio_r + 4 gates + 4 CVs', () => {
    const out = snes9xDef.outputs;
    const byId = Object.fromEntries(out.map((p) => [p.id, p.type]));
    expect(byId.out).toBe('video');
    expect(byId.audio_l).toBe('audio');
    expect(byId.audio_r).toBe('audio');
    for (const g of ['gate1', 'gate2', 'gate3', 'gate4']) expect(byId[g]).toBe('gate');
    for (const c of ['cv1', 'cv2', 'cv3', 'cv4']) expect(byId[c]).toBe('cv');
    // 1 video + 2 audio + 4 gate + 4 cv = 11.
    expect(out).toHaveLength(11);
  });
});

// ---- Factory wiring ----

function makeFakeGl(): WebGL2RenderingContext {
  const stub = (): unknown => ({});
  return {
    getUniformLocation: stub,
    createTexture: () => ({}),
    bindTexture: () => undefined,
    bindFramebuffer: () => undefined,
    viewport: () => undefined,
    useProgram: () => undefined,
    activeTexture: () => undefined,
    uniform1i: () => undefined,
    uniform1f: () => undefined,
    uniform2f: () => undefined,
    texImage2D: () => undefined,
    texSubImage2D: () => undefined,
    texParameteri: () => undefined,
    deleteTexture: () => undefined,
    deleteFramebuffer: () => undefined,
    deleteProgram: () => undefined,
    TEXTURE_2D: 0, RGBA: 0, UNSIGNED_BYTE: 0, FRAMEBUFFER: 0, TEXTURE0: 0,
    TEXTURE_MIN_FILTER: 0, TEXTURE_MAG_FILTER: 0,
    TEXTURE_WRAP_S: 0, TEXTURE_WRAP_T: 0,
    LINEAR: 0, NEAREST: 0, CLAMP_TO_EDGE: 0,
  } as unknown as WebGL2RenderingContext;
}

interface FakeConstant {
  offset: { value: number; setValueAtTime: ReturnType<typeof vi.fn> };
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function makeFakeAudioCtx() {
  const constants: FakeConstant[] = [];
  const ctx = {
    currentTime: 0,
    createGain: () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }),
    createConstantSource: () => {
      const n: FakeConstant = {
        offset: { value: 0, setValueAtTime: vi.fn() },
        start: vi.fn(), stop: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
      };
      constants.push(n);
      return n;
    },
    createChannelSplitter: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
    // No audioWorklet → setupPcmWorklet bails gracefully (audio silent).
  } as unknown as AudioContext;
  return { ctx, constants };
}

function spawn() {
  const gl = makeFakeGl();
  const { ctx: audioCtx, constants } = makeFakeAudioCtx();
  const ctx: VideoEngineContext = {
    gl,
    res: { width: 1024, height: 768 },
    compileFragment: () => ({}) as WebGLProgram,
    createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
    drawFullscreenQuad: () => undefined,
    audioCtx,
  };
  const handle = snes9xDef.factory(
    ctx,
    { id: 'snes-x', type: 'snes9x', params: {}, position: { x: 0, y: 0 } } as never,
  );
  return { handle, constants };
}

describe('snes9xDef.factory — audioSources', () => {
  it('registers audio_l/audio_r + all 4 gates + all 4 CVs as audio sources', () => {
    const { handle } = spawn();
    const src = handle.audioSources!;
    for (const id of ['audio_l', 'audio_r', 'gate1', 'gate2', 'gate3', 'gate4', 'cv1', 'cv2', 'cv3', 'cv4']) {
      expect(src.has(id)).toBe(true);
    }
  });
});

describe('snes9xDef.factory — clock_in → gate3 passthrough (no ROM, N=1)', () => {
  it('a rising edge on clock_in pulses gate3 in phase (×1 passthrough)', () => {
    const { handle, constants } = spawn();
    // gate3 is the 3rd ConstantSourceNode created (gate1, gate2, gate3, ...).
    // Find it by the audioSources map node identity instead of index.
    const gate3Node = handle.audioSources!.get('gate3')!.node as unknown as FakeConstant;
    const before = gate3Node.offset.setValueAtTime.mock.calls.length;
    // Rising edge: cv_clock_in 0 → 1 (crosses the 0.6 rise threshold).
    handle.setParam!('cv_clock_in', 1);
    const after = gate3Node.offset.setValueAtTime.mock.calls.length;
    // pulseGate schedules two setValueAtTime calls (1 then 0).
    expect(after - before).toBe(2);
    expect(gate3Node.offset.setValueAtTime.mock.calls[before]![0]).toBe(1);
    expect(constants.length).toBeGreaterThan(0);
  });
});

describe('snes9xDef.factory — extras', () => {
  it('exposes the extras handle with the expected surface', () => {
    const { handle } = spawn();
    const extras = handle.read!('extras') as {
      isLoaded: () => boolean;
      romLoaded: () => boolean;
      gameId: () => string;
      forcePulse: (p: string) => void;
      readWram: (a: number) => number;
    };
    expect(typeof extras.isLoaded).toBe('function');
    expect(typeof extras.romLoaded).toBe('function');
    expect(typeof extras.forcePulse).toBe('function');
    expect(typeof extras.readWram).toBe('function');
    // No ROM yet → romLoaded false, gameId empty, readWram 0.
    expect(extras.romLoaded()).toBe(false);
    expect(extras.gameId()).toBe('');
    expect(extras.readWram(0x0100)).toBe(0);
  });

  it('forcePulse pulses the named gate', () => {
    const { handle } = spawn();
    const extras = handle.read!('extras') as { forcePulse: (p: string) => void };
    const gate1 = handle.audioSources!.get('gate1')!.node as unknown as FakeConstant;
    const before = gate1.offset.setValueAtTime.mock.calls.length;
    extras.forcePulse('gate1');
    expect(gate1.offset.setValueAtTime.mock.calls.length - before).toBe(2);
  });

  it('exposes the deterministic stepFrame + setManualStep gameplay-e2e hooks', () => {
    const { handle } = spawn();
    const extras = handle.read!('extras') as {
      stepFrame: (mask: number) => number;
      setManualStep: (on: boolean) => void;
      pulseCount: (p: string) => number;
    };
    expect(typeof extras.stepFrame).toBe('function');
    expect(typeof extras.setManualStep).toBe('function');
    // No ROM loaded → stepFrame is a safe no-op returning 0 (game mode),
    // and emits no gate pulses.
    const before = extras.pulseCount('gate1');
    expect(extras.stepFrame(0xff)).toBe(0);
    expect(extras.pulseCount('gate1')).toBe(before);
    extras.setManualStep(true); // must not throw without a ROM
  });
});
