// packages/web/src/lib/video/modules/nibbles.test.ts
//
// NIBBLES module-def shape + factory contract.

import { describe, it, expect, vi } from 'vitest';
import { nibblesDef, NIBBLES_MAX_LENGTH } from './nibbles';
import type { VideoEngineContext } from '$lib/video/engine';

describe('nibblesDef — module def shape', () => {
  it('registers with the right type / domain / category / label', () => {
    expect(nibblesDef.type).toBe('nibbles');
    expect(nibblesDef.domain).toBe('video');
    expect(nibblesDef.category).toBe('sources');
    expect(nibblesDef.label).toBe('NIBBLES');
  });

  it('declares the video output, 3 gate outputs, length CV, and 2 audio outputs', () => {
    const outs = nibblesDef.outputs.map((p) => p.id);
    expect(outs).toEqual([
      'out',
      'pellet',
      'death',
      'dir_change',
      'length_cv',
      'snake',
      'gated',
    ]);
    const types = Object.fromEntries(nibblesDef.outputs.map((p) => [p.id, p.type]));
    expect(types).toEqual({
      out: 'video',
      pellet: 'gate',
      death: 'gate',
      dir_change: 'gate',
      length_cv: 'cv',
      snake: 'audio',
      gated: 'audio',
    });
  });

  it('declares no inputs (snake is driven by keyboard focus or AUTO)', () => {
    expect(nibblesDef.inputs).toEqual([]);
  });

  it('exposes the AUTO toggle + tick_ms params', () => {
    const paramIds = nibblesDef.params.map((p) => p.id);
    expect(paramIds).toEqual(['auto', 'tick_ms']);
    const auto = nibblesDef.params.find((p) => p.id === 'auto')!;
    expect(auto.defaultValue).toBe(0);
    expect(auto.curve).toBe('discrete');
    const tick = nibblesDef.params.find((p) => p.id === 'tick_ms')!;
    expect(tick.defaultValue).toBe(80);
    expect(tick.min).toBe(40);
    expect(tick.max).toBe(200);
  });

  it('NIBBLES_MAX_LENGTH is a positive integer (the 95th-percentile cap)', () => {
    expect(Number.isInteger(NIBBLES_MAX_LENGTH)).toBe(true);
    expect(NIBBLES_MAX_LENGTH).toBeGreaterThan(0);
  });
});

// ---- Factory contract ----------------------------------------------------

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
    pixelStorei: () => undefined,
    deleteTexture: () => undefined,
    deleteFramebuffer: () => undefined,
    deleteProgram: () => undefined,
    TEXTURE_2D: 0, RGBA: 0, UNSIGNED_BYTE: 0, FRAMEBUFFER: 0, TEXTURE0: 0,
    TEXTURE_MIN_FILTER: 0, TEXTURE_MAG_FILTER: 0,
    TEXTURE_WRAP_S: 0, TEXTURE_WRAP_T: 0,
    LINEAR: 0, NEAREST: 0, CLAMP_TO_EDGE: 0, UNPACK_FLIP_Y_WEBGL: 0,
  } as unknown as WebGL2RenderingContext;
}

interface FakeAudioParam {
  value: number;
  setValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  setTargetAtTime: ReturnType<typeof vi.fn>;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
}

function makeAudioParam(): FakeAudioParam {
  return {
    value: 0,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  };
}

interface FakeAudioCtxFixture {
  ctx: AudioContext;
  oscs: { type: string; freq: FakeAudioParam; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> }[];
  constants: { offset: FakeAudioParam; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[];
  gains: { gain: FakeAudioParam; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[];
}

function makeFakeAudioCtx(): FakeAudioCtxFixture {
  const oscs: FakeAudioCtxFixture['oscs'] = [];
  const constants: FakeAudioCtxFixture['constants'] = [];
  const gains: FakeAudioCtxFixture['gains'] = [];
  const ctx = {
    currentTime: 0,
    createOscillator: () => {
      const freq = makeAudioParam();
      const o = {
        type: 'sine',
        frequency: freq,
        start: vi.fn(),
        stop: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      oscs.push({ type: o.type, freq, start: o.start, stop: o.stop, connect: o.connect });
      // Allow the caller to override `type`; OscillatorNode lets you set
      // it as a plain property in real audio code.
      Object.defineProperty(o, 'type', {
        get() { return oscs[oscs.length - 1]!.type; },
        set(v: string) { oscs[oscs.length - 1]!.type = v; },
      });
      return o;
    },
    createGain: () => {
      const gain = makeAudioParam();
      const n = {
        gain,
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gains.push(n);
      return n;
    },
    createConstantSource: () => {
      const offset = makeAudioParam();
      const n = {
        offset,
        start: vi.fn(),
        stop: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      constants.push(n);
      return n;
    },
  } as unknown as AudioContext;
  return { ctx, oscs, constants, gains };
}

function spawn(handleAudio = true) {
  const gl = makeFakeGl();
  const fixture = handleAudio ? makeFakeAudioCtx() : null;
  const ctx: VideoEngineContext = {
    gl,
    res: { width: 640, height: 360 },
    compileFragment: () => ({}) as WebGLProgram,
    createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
    drawFullscreenQuad: () => undefined,
    audioCtx: fixture?.ctx,
  };
  const handle = nibblesDef.factory(
    ctx,
    {
      id: 'nibbles-x',
      type: 'nibbles',
      params: {},
      position: { x: 0, y: 0 },
    } as never,
  );
  return { handle, fixture };
}

describe('nibblesDef.factory — audio sources', () => {
  it('publishes 4 gate/CV ConstantSourceNodes + 2 audio outputs (snake/gated)', () => {
    const { handle, fixture } = spawn();
    expect(fixture).not.toBeNull();
    // 4 CSNs: pellet, death, dir_change, length_cv.
    expect(fixture!.constants.length).toBe(4);
    // 2 oscillators: snake (continuous), gated (enveloped).
    expect(fixture!.oscs.length).toBe(2);
    for (const o of fixture!.oscs) expect(o.type).toBe('square');
    // 2 gains: snake amplitude + gated envelope.
    expect(fixture!.gains.length).toBe(2);

    for (const id of ['pellet', 'death', 'dir_change', 'length_cv', 'snake', 'gated']) {
      const src = handle.audioSources?.get(id);
      expect(src?.node, `expected ${id} in audioSources`).toBeDefined();
    }
  });
});

describe('nibblesDef.factory — extras', () => {
  it('exposes a card-facing extras with pushDirection/getScore/reset/snapshot', () => {
    const { handle } = spawn();
    const extras = handle.read?.('extras') as {
      pushDirection: (d: 'up'|'down'|'left'|'right') => boolean;
      getScore: () => number;
      reset: () => void;
      snapshot: () => ImageData | null;
    } | undefined;
    expect(extras).toBeDefined();
    expect(typeof extras!.pushDirection).toBe('function');
    expect(typeof extras!.getScore).toBe('function');
    expect(typeof extras!.reset).toBe('function');
    expect(typeof extras!.snapshot).toBe('function');
    // Fresh game starts at length 4.
    expect(extras!.getScore()).toBe(4);
  });

  it('pushDirection is rejected when AUTO is on', () => {
    const { handle } = spawn();
    handle.setParam('auto', 1);
    const extras = handle.read?.('extras') as {
      pushDirection: (d: 'up'|'down'|'left'|'right') => boolean;
    };
    expect(extras.pushDirection('up')).toBe(false);
    handle.setParam('auto', 0);
    expect(extras.pushDirection('up')).toBe(true);
  });
});

describe('nibblesDef.factory — GATED envelope fires on pellet event', () => {
  it('schedules a linear-attack ramp + decay setTargetAtTime when a pellet is eaten', async () => {
    const { handle, fixture } = spawn();
    expect(fixture).not.toBeNull();
    const gatedGainNode = fixture!.gains[1]!;  // 2nd gain = gated envelope
    // Reset counters from construction-time setValueAtTime(0).
    gatedGainNode.gain.linearRampToValueAtTime.mockClear();
    gatedGainNode.gain.setTargetAtTime.mockClear();

    // Drive a game tick where the snake eats food. Easiest path: reach
    // into the factory's state via a manual draw call after forcing
    // food onto the head's path. The handle doesn't expose state
    // directly, so we tick the surface a few times and rig food via the
    // module's own snapshot/score side-effects.
    //
    // Simpler: use the extras.reset() so we know the game is fresh,
    // then drive draw() at >tick_ms intervals + force a pellet via the
    // internal RNG by checking when getScore() goes from 4 → 5.
    //
    // For a deterministic test, we instead PULSE the envelope directly by
    // emitting a pellet event the same way the engine does: call
    // setDirection + tick from the engine module, then call the
    // factory's surface.draw() with the audio-context time advanced past
    // tick_ms.
    //
    // Easier still: arrange the snake one cell from food, then call
    // draw() with enough simulated time to land one tick.

    // We don't have a public knob into game state from the def, so we
    // assert the envelope path is wired by calling the surface.draw()
    // loop forward until at least one pellet event lands (by chance via
    // the seeded RNG). Bound the loop so a non-eating game gives a
    // clear failure rather than hanging.
    const surface = handle.surface;
    let simT = 0;
    const tickPeriod = 0.08;
    // 80ms tick × 200 = 16s game time. Bot is OFF; snake just walks
    // right then bounces off the wall — won't eat. So instead turn AUTO
    // ON for this test: the bot moves toward food.
    handle.setParam('auto', 1);
    for (let i = 0; i < 600 && gatedGainNode.gain.linearRampToValueAtTime.mock.calls.length === 0; i++) {
      simT += tickPeriod;
      surface.draw({
        gl: makeFakeGl(),
        time: simT,
        frame: i,
        getInputTexture: () => null,
      });
    }
    expect(gatedGainNode.gain.linearRampToValueAtTime).toHaveBeenCalled();
    // Decay path scheduled too.
    expect(gatedGainNode.gain.setTargetAtTime).toHaveBeenCalled();
  });
});

describe('nibblesDef.factory — AUTO toggle drives direction; OFF halts it', () => {
  it('with AUTO on, ticking moves the snake and may change its direction (via bot)', () => {
    const { handle } = spawn();
    handle.setParam('auto', 1);
    const extras = handle.read?.('extras') as { getScore: () => number };
    // Run many ticks; either the snake eats (score grows) or dies + auto-
    // restarts (score resets to 4 then probably grows again). Either way
    // the score should change OR alive should flip during the run — the
    // observable proof the bot is driving the sim.
    const surface = handle.surface;
    let lastScore = extras.getScore();
    let anyMutation = false;
    for (let i = 0; i < 400; i++) {
      surface.draw({
        gl: makeFakeGl(),
        time: i * 0.1,
        frame: i,
        getInputTexture: () => null,
      });
      const s = extras.getScore();
      if (s !== lastScore) { anyMutation = true; break; }
      lastScore = s;
    }
    expect(anyMutation).toBe(true);
  });
});
