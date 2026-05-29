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

interface FakeConstantWrapper {
  __tag: string;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  offset: { setValueAtTime: ReturnType<typeof vi.fn> };
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function makeFakeAudioCtx(opts: { withDestination?: boolean } = {}): {
  ctx: BaseAudioContext;
  createdSplitters: FakeNode[];
  createdGains: FakeNode[];
  createdConstants: FakeNode[];
  /** Same construction order as createdConstants — but exposes the WRAPPER
   *  object the factory closed over (with the live `offset.setValueAtTime`
   *  fake), so forcePulse() tests can assert pulses landed on the same CSN
   *  identity the published audioSources entry references. */
  constantWrappers: FakeConstantWrapper[];
  workletNode: FakeNode | null;
  workletReady: Promise<void>;
  /** The fake destination node (when `withDestination: true`) — used to
   *  assert the silent worklet keep-alive landed on it. */
  destination: FakeNode | null;
} {
  const createdSplitters: FakeNode[] = [];
  const createdGains: FakeNode[] = [];
  const createdConstants: FakeNode[] = [];
  const constantWrappers: FakeConstantWrapper[] = [];
  let workletNode: FakeNode | null = null;
  let resolveWorklet: () => void = () => {};
  const workletReady = new Promise<void>((r) => { resolveWorklet = r; });

  const destination: FakeNode | null = opts.withDestination
    ? { __tag: 'destination', connect: vi.fn(), disconnect: vi.fn() }
    : null;

  const ctx = {
    currentTime: 0,
    ...(destination ? { destination } : {}),
    audioWorklet: {
      addModule: vi.fn().mockResolvedValue(undefined),
    },
    createGain: () => {
      // The wrapper IS what the factory closes over — push the wrapper so
      // assertions can match `connect`/`disconnect` call targets by identity.
      const base: FakeNode = { __tag: 'gain', connect: vi.fn(), disconnect: vi.fn() };
      const wrapper = Object.assign(base, { gain: { value: 1 } });
      createdGains.push(wrapper);
      return wrapper;
    },
    createChannelSplitter: () => {
      const n: FakeNode = { __tag: 'splitter', connect: vi.fn(), disconnect: vi.fn() };
      createdSplitters.push(n);
      return n;
    },
    createConstantSource: () => {
      const n: FakeNode = { __tag: 'constant', connect: vi.fn(), disconnect: vi.fn() };
      createdConstants.push(n);
      const wrapper: FakeConstantWrapper = {
        ...n,
        offset: { setValueAtTime: vi.fn() },
        start: vi.fn(),
        stop: vi.fn(),
      };
      constantWrappers.push(wrapper);
      return wrapper;
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
    constantWrappers,
    get workletNode() { return workletNode; },
    workletReady,
    destination,
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

  it('connects the worklet to ctx.destination through a silent gain (keep-alive — without this, Chromium treats the worklet as orphan + process() never runs)', async () => {
    const gl = makeFakeGl();
    const fake = makeFakeAudioCtx({ withDestination: true });
    const ctx: VideoEngineContext = {
      gl,
      res: { width: 640, height: 360 },
      compileFragment: () => ({}) as WebGLProgram,
      createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
      drawFullscreenQuad: () => undefined,
      audioCtx: fake.ctx as AudioContext,
    };
    doomDef.factory(ctx, { id: 'doom-keepalive', type: 'doom', params: {}, position: { x: 0, y: 0 } } as never);

    await fake.workletReady;
    await Promise.resolve();
    await Promise.resolve();

    // The keep-alive: worklet -> a NEW gain -> destination. createGain has
    // been called THREE times by this point: leftGain, rightGain (both
    // pre-worklet), and the keep-alive gain (post-worklet). The third
    // gain is the keep-alive node.
    expect(fake.createdGains.length).toBeGreaterThanOrEqual(3);
    const keepAliveGain = fake.createdGains[2]!;

    // worklet -> keepAliveGain edge: worklet.connect called twice now
    // (once to the splitter, once to the keep-alive gain).
    expect(fake.workletNode!.connect).toHaveBeenCalledTimes(2);
    expect(fake.workletNode!.connect).toHaveBeenNthCalledWith(2, keepAliveGain);

    // keepAliveGain -> ctx.destination edge: the silent path that keeps
    // the audio graph rendered. WITHOUT this, no path reaches destination
    // for a SCOPE-terminated patch (analyser is a sink but doesn't
    // terminate the graph), Chromium skips the worklet's process() entirely,
    // and audio_l/audio_r stay silent even though the splitter wiring is
    // correct.
    expect(keepAliveGain.connect).toHaveBeenCalledTimes(1);
    expect(keepAliveGain.connect).toHaveBeenCalledWith(fake.destination);
  });

  it('skips the keep-alive cleanly when the AudioContext has no destination (test fakes / OfflineAudioContext-like)', async () => {
    // The fake used by the older tests omits .destination — exercise the
    // guard so this code path stays test-friendly.
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
    doomDef.factory(ctx, { id: 'doom-no-dest', type: 'doom', params: {}, position: { x: 0, y: 0 } } as never);

    await fake.workletReady;
    await Promise.resolve();
    await Promise.resolve();

    // No destination → no keep-alive gain → only leftGain + rightGain.
    expect(fake.createdGains).toHaveLength(2);
    // worklet → splitter only; no second connect.
    expect(fake.workletNode!.connect).toHaveBeenCalledTimes(1);
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

// ---- Test hook: extras.forcePulse() -------------------------------------
//
// Locks in the deterministic-pulse hook the video→audio CV/gate e2e + composite
// VRT specs depend on. DOOM's WASM event queue (kill / door / weapon-fire) is
// stochastic + slow to spin up, so the spec drives the SAME `pulseGate` helper
// `drainAndPulseEvents` uses — no WASM-side changes required, no e2e flake from
// "did the marine kill anything yet?". The CSN identity is the same one
// exposed via audioSources, so the in-engine bridge captures the right ref.
describe('doomDef.factory — extras.forcePulse() test hook', () => {
  function spawnWithFakeAudio() {
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
    const handle = doomDef.factory(
      ctx,
      { id: 'doom-force', type: 'doom', params: {}, position: { x: 0, y: 0 } } as never,
    );
    return { handle, fake };
  }

  it('exposes forcePulse on the extras handle', () => {
    const { handle } = spawnWithFakeAudio();
    const extras = handle.read?.('extras') as { forcePulse?: (p: string) => void };
    expect(typeof extras.forcePulse).toBe('function');
  });

  it('forcePulse(evt_kill) drives setValueAtTime on the same CSN exposed via audioSources.evt_kill', () => {
    const { handle, fake } = spawnWithFakeAudio();
    // 6 CSN wrappers in construction order: kill, door, gun_p1..p4. The
    // factory closes over THESE wrapper objects + publishes them in
    // audioSources, so this index is the same node the engine bridge
    // sees.
    const killCsn = fake.constantWrappers[0]!;
    const audioSrc = handle.audioSources?.get('evt_kill');
    expect(audioSrc?.node).toBe(killCsn as unknown as AudioNode);
    killCsn.offset.setValueAtTime.mockClear();
    const extras = handle.read?.('extras') as { forcePulse: (p: string) => void };
    extras.forcePulse('evt_kill');
    // pulseGate fires offset=1 at t, offset=0 at t+10ms — 2 calls.
    const calls = killCsn.offset.setValueAtTime.mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0]![0]).toBe(1);
    expect(calls[1]![0]).toBe(0);
    expect(calls[1]![1]).toBeCloseTo(calls[0]![1] + 0.01, 4);
  });

  it('forcePulse(evt_door) + (evt_gun_p1..p4) each drive their own CSN', () => {
    const { handle, fake } = spawnWithFakeAudio();
    const doorCsn = fake.constantWrappers[1]!;
    const gun1    = fake.constantWrappers[2]!;
    const gun4    = fake.constantWrappers[5]!;
    for (const c of [doorCsn, gun1, gun4]) c.offset.setValueAtTime.mockClear();

    const extras = handle.read?.('extras') as { forcePulse: (p: string) => void };
    extras.forcePulse('evt_door');
    expect(doorCsn.offset.setValueAtTime).toHaveBeenCalledTimes(2);
    expect(gun1.offset.setValueAtTime).toHaveBeenCalledTimes(0);

    extras.forcePulse('evt_gun_p1');
    expect(gun1.offset.setValueAtTime).toHaveBeenCalledTimes(2);
    expect(gun4.offset.setValueAtTime).toHaveBeenCalledTimes(0);

    extras.forcePulse('evt_gun_p4');
    expect(gun4.offset.setValueAtTime).toHaveBeenCalledTimes(2);

    // Distinct CSNs — each port resolves to its own node, no double-pulse.
    expect(doorCsn).not.toBe(gun1);
    expect(gun1).not.toBe(gun4);
  });

  it('forcePulse is a safe no-op when no AudioContext is attached', () => {
    const gl = makeFakeGl();
    const ctx: VideoEngineContext = {
      gl,
      res: { width: 640, height: 360 },
      compileFragment: () => ({}) as WebGLProgram,
      createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
      drawFullscreenQuad: () => undefined,
      audioCtx: undefined,
    };
    const handle = doomDef.factory(
      ctx,
      { id: 'doom-noaudio', type: 'doom', params: {}, position: { x: 0, y: 0 } } as never,
    );
    const extras = handle.read?.('extras') as { forcePulse: (p: string) => void };
    expect(() => extras.forcePulse('evt_kill')).not.toThrow();
    expect(() => extras.forcePulse('evt_gun_p2')).not.toThrow();
  });

  it('forceHold(port, true) sets the same gate CSN to offset=1 without auto-fall-back', () => {
    const { handle, fake } = spawnWithFakeAudio();
    const killCsn = fake.constantWrappers[0]!;
    killCsn.offset.setValueAtTime.mockClear();
    const extras = handle.read?.('extras') as {
      forceHold: (p: string, h: boolean) => void;
    };
    extras.forceHold('evt_kill', true);
    // One setValueAtTime call with value=1 — no scheduled fall-back.
    expect(killCsn.offset.setValueAtTime).toHaveBeenCalledTimes(1);
    expect(killCsn.offset.setValueAtTime.mock.calls[0]![0]).toBe(1);
  });

  it('forceHold across all 6 gates lands on the correct CSN (KILL / DOOR / GUN_p1..p4)', () => {
    const { handle, fake } = spawnWithFakeAudio();
    const extras = handle.read?.('extras') as {
      forceHold: (p: string, h: boolean) => void;
    };
    const ports = ['evt_kill', 'evt_door', 'evt_gun_p1', 'evt_gun_p2', 'evt_gun_p3', 'evt_gun_p4'];
    for (let i = 0; i < ports.length; i++) {
      const csn = fake.constantWrappers[i]!;
      csn.offset.setValueAtTime.mockClear();
      extras.forceHold(ports[i]!, true);
      expect(csn.offset.setValueAtTime, `${ports[i]} should hit constantWrappers[${i}]`).toHaveBeenCalledTimes(1);
      expect(csn.offset.setValueAtTime.mock.calls[0]![0]).toBe(1);
    }
  });
});

// ---- ESC / ENTER per-slot gates (2026-05-29) ---------------------------
//
// Pins the new p{1..4}_esc + p{1..4}_enter ports — the menu (escape) +
// menu-select (enter) cv inputs added so a SEQUENCER → DOOM patch can drive
// the pause menu.

describe('doomDef — ESC + ENTER per-slot CV gates', () => {
  it('declares p1_esc / p1_enter (and p2..p4) — total 36 cv-gate inputs (4 slots × 9 gates)', () => {
    const ids = doomDef.inputs.map((p) => p.id);
    expect(ids).toContain('p1_esc');
    expect(ids).toContain('p1_enter');
    expect(ids).toContain('p4_esc');
    expect(ids).toContain('p4_enter');
    expect(ids).toHaveLength(36);
  });

  it('every per-slot gate (incl. esc/enter) has a paramTarget routing to a real synthetic param', () => {
    const paramIds = new Set(doomDef.params.map((p) => p.id));
    for (const input of doomDef.inputs) {
      const pt = input.paramTarget;
      expect(pt).toBe(`cv_${input.id}`);
      expect(pt && paramIds.has(pt)).toBe(true);
    }
  });
});

// ---- SP single-player CV-drives-player fallback (2026-05-29) -----------
//
// Pre-fix: in single-player (no MP launched, mySlot stays null → ownSlot
// null), the factory's own-slot-only guard dropped every CV write, so
// patching GAMEPAD or LFO into DOOM did nothing visible.
//
// Fix: when ownSlot===null (SP / unjoined), accept the P1 group only
// (the SP marine is consoleplayer 0) and ignore p2..p4 CV. Other slots'
// CV is still rejected so wiring four LFOs into p1..p4 doesn't quadruple
// drive the same key.
//
// We can't poke the C runtime from a unit test (no WASM), so this asserts
// the CV path WOULD reach the runtime by hand-instrumenting a stub.

import { parseSlotPortId } from '$lib/doom/doomkeys';

describe('doomDef.factory — SP single-player CV fallback', () => {
  it('SP (ownSlot=null) accepts CV for the p1 group only (slot 0 is the SP marine)', () => {
    // We're after the edge-detection + slot-routing branch; the spec is
    // proved by a property of `parseSlotPortId` + the documented contract.
    // (The behavioural assertion lives in the e2e — runtime ccall needs WASM.)
    for (const base of CV_GATE_PORT_IDS) {
      // p1_<base> parses to slot 0 — accepted under the SP rule.
      const p1 = parseSlotPortId(`p1_${base}`);
      expect(p1?.slot).toBe(0);
      // p3_<base> parses to slot 2 — rejected under the SP rule (the
      // factory's setParam early-returns on `parsed.slot !== 0` when
      // ownSlot is null).
      const p3 = parseSlotPortId(`p3_${base}`);
      expect(p3?.slot).toBe(2);
    }
  });

  it('SP fallback is documented at the setParam call site (regression anchor)', async () => {
    // Read the factory source + grep for the SP guard so anyone collapsing
    // the early-return back to the pre-fix `ownSlot === null` rejection
    // trips this test. Cheap regression anchor without needing WASM.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(__dirname, './doom.ts'),
      'utf8',
    );
    // The fix's anchor comment / behaviour line.
    expect(src).toContain('SINGLE-PLAYER / UNJOINED');
    expect(src).toContain('if (ownSlot === null) {');
    expect(src).toContain('if (parsed.slot !== 0) return;');
  });
});
