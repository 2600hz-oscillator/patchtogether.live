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

describe('nibblesDef.factory — length_cv', () => {
  it('starts the ConstantSource at factory mount', () => {
    const { fixture } = spawn();
    // 4 CSNs: pellet, death, dir_change, length_cv.
    // Each has start() called exactly once at construction.
    for (const c of fixture!.constants) {
      expect(c.start).toHaveBeenCalledTimes(1);
    }
  });

  it('seeds length_cv.offset at the initial-length CV value (length=4)', () => {
    const { fixture } = spawn();
    // length_cv is the 4th ConstantSource (after pellet, death, dir_change).
    const lengthCv = fixture!.constants[3]!;
    // setValueAtTime(initialCv, 0) at construction.
    expect(lengthCv.offset.setValueAtTime).toHaveBeenCalled();
    const firstCall = lengthCv.offset.setValueAtTime.mock.calls[0]!;
    // lengthToCv(4) = (4 - 119/2) / (119/2) = -0.9328...
    expect(firstCall[0]).toBeCloseTo((4 - NIBBLES_MAX_LENGTH / 2) / (NIBBLES_MAX_LENGTH / 2), 3);
    expect(firstCall[1]).toBe(0);
  });

  it('updates length_cv.offset when the snake eats a pellet (length grows)', () => {
    // Regression: NIBBLES.length_cv → QBRT.cutoff_cv didn't move the
    // cutoff slider because the per-tick handler that updates the
    // ConstantSourceNode's offset was never reached. Drive the AUTO bot
    // until at least one pellet event fires + assert the offset is
    // re-scheduled via linearRampToValueAtTime.
    const { handle, fixture } = spawn();
    const lengthCv = fixture!.constants[3]!;
    // Clear the construction-time setValueAtTime so we count only
    // post-tick updates.
    lengthCv.offset.linearRampToValueAtTime.mockClear();

    handle.setParam('auto', 1);
    const extras = handle.read?.('extras') as { getScore: () => number };
    const surface = handle.surface;
    const startScore = extras.getScore();

    // Drive ticks until the snake grows OR we time out.
    let grew = false;
    for (let i = 0; i < 600 && !grew; i++) {
      surface.draw({
        gl: makeFakeGl(),
        time: i * 0.1,
        frame: i,
        getInputTexture: () => null,
      });
      if (extras.getScore() !== startScore) grew = true;
    }
    expect(grew).toBe(true);
    // The per-event handler must have called linearRampToValueAtTime on
    // length_cv.offset at least once (the proof the wiring fires on
    // length change).
    expect(lengthCv.offset.linearRampToValueAtTime).toHaveBeenCalled();
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

// ---- Test hook: extras.forcePulse() -------------------------------------
//
// Locks in the deterministic-pulse hook the video→audio CV/gate e2e + composite
// VRT specs depend on (per `e2e/tests/video-audio-cvgate-coverage.spec.ts` +
// `e2e/vrt/vrt-composite-coverage.spec.ts`). The hook MUST drive the same
// ConstantSourceNode the in-engine bridge captures via audioSources —
// otherwise the spec tests would assert against an output port that no
// downstream module ever sees.
describe('nibblesDef.factory — extras.forcePulse() test hook', () => {
  it('exposes forcePulse on the extras handle', () => {
    const { handle } = spawn();
    const extras = handle.read?.('extras') as { forcePulse: (port: string, v?: number) => void };
    expect(typeof extras.forcePulse).toBe('function');
  });

  it('forcePulse("pellet") pulses the same ConstantSourceNode exposed via audioSources.pellet', () => {
    const { handle, fixture } = spawn();
    // The pellet gate is the 1st CSN constructed.
    const pelletCsn = fixture!.constants[0]!;
    const audioSrc = handle.audioSources?.get('pellet');
    expect(audioSrc?.node).toBe(pelletCsn);
    // Drop any construction-time setValueAtTime so we count only the
    // post-force pulse.
    pelletCsn.offset.setValueAtTime.mockClear();
    const extras = handle.read?.('extras') as { forcePulse: (p: string) => void };
    extras.forcePulse('pellet');
    // pulseGate sets offset=1 at t, then offset=0 at t + 10ms.
    const calls = pelletCsn.offset.setValueAtTime.mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0]![0]).toBe(1);    // rising edge
    expect(calls[1]![0]).toBe(0);    // falling edge
    expect(calls[1]![1]).toBeCloseTo(calls[0]![1] + 0.01, 4);  // 10 ms gap
  });

  it('forcePulse("death") + ("dir_change") each pulse their own gate CSN', () => {
    const { handle, fixture } = spawn();
    const deathCsn = fixture!.constants[1]!;
    const dirCsn   = fixture!.constants[2]!;
    deathCsn.offset.setValueAtTime.mockClear();
    dirCsn.offset.setValueAtTime.mockClear();
    const extras = handle.read?.('extras') as { forcePulse: (p: string) => void };
    extras.forcePulse('death');
    expect(deathCsn.offset.setValueAtTime).toHaveBeenCalledTimes(2);
    expect(dirCsn.offset.setValueAtTime).toHaveBeenCalledTimes(0);
    extras.forcePulse('dir_change');
    expect(dirCsn.offset.setValueAtTime).toHaveBeenCalledTimes(2);
  });

  it('forcePulse("length_cv", v) linear-ramps length_cv.offset toward v', () => {
    const { handle, fixture } = spawn();
    const lengthCsn = fixture!.constants[3]!;
    lengthCsn.offset.linearRampToValueAtTime.mockClear();
    const extras = handle.read?.('extras') as { forcePulse: (p: string, v?: number) => void };
    extras.forcePulse('length_cv', 0.5);
    const calls = lengthCsn.offset.linearRampToValueAtTime.mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]![0]).toBeCloseTo(0.5, 4);
  });

  it('forcePulse("length_cv") with no value defaults to +1 and clamps overshoot', () => {
    const { handle, fixture } = spawn();
    const lengthCsn = fixture!.constants[3]!;
    lengthCsn.offset.linearRampToValueAtTime.mockClear();
    const extras = handle.read?.('extras') as { forcePulse: (p: string, v?: number) => void };
    extras.forcePulse('length_cv');
    expect(lengthCsn.offset.linearRampToValueAtTime.mock.calls[0]![0]).toBeCloseTo(1, 4);
    extras.forcePulse('length_cv', 5);   // overshoot → +1
    expect(lengthCsn.offset.linearRampToValueAtTime.mock.calls[1]![0]).toBeCloseTo(1, 4);
    extras.forcePulse('length_cv', -5);  // undershoot → −1
    expect(lengthCsn.offset.linearRampToValueAtTime.mock.calls[2]![0]).toBeCloseTo(-1, 4);
  });

  it('forcePulse is a safe no-op when no AudioContext is attached', () => {
    const { handle } = spawn(false);
    const extras = handle.read?.('extras') as { forcePulse: (p: string, v?: number) => void };
    expect(() => extras.forcePulse('pellet')).not.toThrow();
    expect(() => extras.forcePulse('length_cv', 0.5)).not.toThrow();
  });

  it('forceHold(port, true) sets the same gate CSN to offset=1 without auto-fall-back', () => {
    const { handle, fixture } = spawn();
    const pelletCsn = fixture!.constants[0]!;
    pelletCsn.offset.setValueAtTime.mockClear();
    pelletCsn.offset.cancelScheduledValues.mockClear();
    const extras = handle.read?.('extras') as {
      forceHold: (p: 'pellet' | 'death' | 'dir_change', high: boolean) => void;
    };
    extras.forceHold('pellet', true);
    // cancelScheduledValues + setValueAtTime(1, t) — ONE setValueAtTime call,
    // no falling edge scheduled (that's the point — the value sticks).
    expect(pelletCsn.offset.cancelScheduledValues).toHaveBeenCalled();
    expect(pelletCsn.offset.setValueAtTime).toHaveBeenCalledTimes(1);
    expect(pelletCsn.offset.setValueAtTime.mock.calls[0]![0]).toBe(1);
  });

  it('forceHold(port, false) clears the hold back to 0', () => {
    const { handle, fixture } = spawn();
    const deathCsn = fixture!.constants[1]!;
    deathCsn.offset.setValueAtTime.mockClear();
    const extras = handle.read?.('extras') as {
      forceHold: (p: 'pellet' | 'death' | 'dir_change', high: boolean) => void;
    };
    extras.forceHold('death', false);
    expect(deathCsn.offset.setValueAtTime.mock.calls[0]![0]).toBe(0);
  });
});
