// packages/web/src/lib/video/modules/videocube.test.ts
//
// VIDEOCUBE def-shape + factory smoke. The GL COMBINE pipeline is exercised by
// E2E (jsdom can't render shaders) + the pure math in videocube-core.test.ts;
// here we pin the I/O contract and the cheap synchronous factory work — the
// 3-ring alloc, the MONO-DRONE audio seam standing up under a mock AudioContext,
// and a draw() driving the reduce→cube-slice-scan→setWave post end to end.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { videocubeDef, VIDEOCUBE_DEFAULTS, AUDIO_RECOMPUTE_EVERY } from './videocube';
import type { VideoEngineContext, VideoFrameContext } from '$lib/video/engine';

/** GL call stats the B2 throttle test reads (readPixels = the synchronous audio
 *  readback we must NOT do every frame under a modulating CV). */
interface GlStats { readPixels: number }

// ── Fake GL: no-op every call; return sane values where the factory branches. ──
function makeFakeGl(stats?: GlStats): WebGL2RenderingContext {
  const target: Record<string, unknown> = {
    createTexture: () => ({}),
    createFramebuffer: () => ({}),
    getUniformLocation: () => ({}),
    checkFramebufferStatus: () => 0x8cd5, // FRAMEBUFFER_COMPLETE
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    getExtension: () => null,
    getParameter: () => '',
    getError: () => 0,
    readPixels: () => { if (stats) stats.readPixels++; }, // leaves the strip all-zero (black rings)
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

function makeCtx(audio: FakeAudio | null, stats?: GlStats): VideoEngineContext {
  return {
    gl: makeFakeGl(stats),
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

function mkFrame(gl: WebGL2RenderingContext, hasInput = false): VideoFrameContext {
  return {
    gl, time: 0, frame: 0, timeDelta: 1 / 60,
    // hasInput → a truthy fake texture so the rings CAPTURE + advance (captured=true),
    // which is what the audio throttle needs to keep refreshing for a live source.
    getInputTexture: () => (hasInput ? ({} as WebGLTexture) : null),
    isOutputConnected: () => true,
  } as unknown as VideoFrameContext;
}

/** Count the setWave port posts (the ONLY thing recomputeSlice posts). */
function setWaveCount(audio: FakeAudio): number {
  return audio.node!.port.postMessage.mock.calls.filter(
    (c) => (c[0] as { type?: string })?.type === 'setWave',
  ).length;
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

  it('exposes the SIX dedicated slice-viz VIDEO outputs (per-port gated)', () => {
    const vizIds = ['scope_out', 'slice_out', 'depth_out', 'smooth_out', 'morph_out', 'chaos_out'];
    for (const id of vizIds) {
      const o = videocubeDef.outputs.find((p) => p.id === id);
      expect(o, id).toBeDefined();
      expect(o!.type, id).toBe('video');
    }
    // The originals are still there (viz ports are ADDED, not a replacement).
    expect(videocubeDef.outputs.find((o) => o.id === 'video_out')?.type).toBe('video');
    expect(videocubeDef.outputs.find((o) => o.id === 'audio_out')?.type).toBe('audio');
    expect(videocubeDef.outputs.length).toBe(8);
  });

  it('adds slice_view (discrete 0..2, default TEXTURED) — picture-only, no CV', () => {
    const sv = videocubeDef.params.find((p) => p.id === 'slice_view');
    expect(sv).toBeDefined();
    expect(sv!.min).toBe(0);
    expect(sv!.max).toBe(2);
    expect(sv!.curve).toBe('discrete');
    expect(VIDEOCUBE_DEFAULTS.slice_view).toBe(0);
    // slice_view is a viz colorize flavour → NOT wired to any CV input.
    const cvTargets = new Set(videocubeDef.inputs.filter((i) => i.type === 'cv').map((i) => i.paramTarget));
    expect(cvTargets.has('slice_view')).toBe(false);
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

  it('adds the orbit-camera VIEW params (zoom + 3 rotations) with sensible defaults', () => {
    const ids = new Set(videocubeDef.params.map((p) => p.id));
    for (const id of ['view_zoom', 'view_rot_x', 'view_rot_y', 'view_rot_z']) {
      expect(ids.has(id), id).toBe(true);
    }
    const zoom = videocubeDef.params.find((p) => p.id === 'view_zoom')!;
    expect(zoom.min).toBe(0.3);
    expect(zoom.max).toBe(3);
    expect(VIDEOCUBE_DEFAULTS.view_zoom).toBe(1);
    // A default off-axis view so the volume is seen at an angle (like CubeCard).
    expect(VIDEOCUBE_DEFAULTS.view_rot_x).toBeGreaterThan(0);
    expect(VIDEOCUBE_DEFAULTS.view_rot_y).toBeGreaterThan(0);
    expect(VIDEOCUBE_DEFAULTS.view_rot_z).toBe(0);
    // VIEW X / VIEW Y are the orbit-camera JOYSTICK axes → CV-assignable (view_x_cv
    // / view_y_cv). VIEW ZOOM / VIEW Z stay knob-only (picture-only, no CV input).
    const cvTargets = new Set(videocubeDef.inputs.filter((i) => i.type === 'cv').map((i) => i.paramTarget));
    expect(cvTargets.has('view_rot_x'), 'VIEW X has CV (joystick axis)').toBe(true);
    expect(cvTargets.has('view_rot_y'), 'VIEW Y has CV (joystick axis)').toBe(true);
    for (const id of ['view_zoom', 'view_rot_z']) {
      expect(cvTargets.has(id), `${id} has no CV`).toBe(false);
    }
    // The joystick CV ports resolve to the real view params.
    expect(videocubeDef.inputs.find((i) => i.id === 'view_x_cv')?.paramTarget).toBe('view_rot_x');
    expect(videocubeDef.inputs.find((i) => i.id === 'view_y_cv')?.paramTarget).toBe('view_rot_y');
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

  it('B2: no per-frame readback under a MODULATING CV — the recompute is THROTTLED', async () => {
    const stats: GlStats = { readPixels: 0 };
    const audio = makeFakeAudio();
    const ctx = makeCtx(audio, stats);
    const handle = videocubeDef.factory(ctx, mkNode());
    await audio.workletReady; await Promise.resolve(); await Promise.resolve();
    const frame = mkFrame(ctx.gl, true); // a live source so the rings advance every frame

    handle.surface.draw(frame); // seat the initial scan (consumes the spawn dirty flag)
    const after1 = setWaveCount(audio);

    // A CONSTANT CV writes the same value every frame → never re-dirties → no
    // rescan across many frames (the original B1 guarantee, preserved).
    stats.readPixels = 0;
    for (let i = 0; i < 6; i++) { handle.setParam('morph_fc', 0); handle.surface.draw(frame); }
    expect(setWaveCount(audio), 'constant CV → no recompute').toBe(after1);
    expect(stats.readPixels, 'constant CV → zero GPU readback').toBe(0);

    // THE HEADLINE B2 CASE: a MODULATING CV writes a NEW value every frame — the
    // signature changes every frame, so the sig-gate alone would NOT stop a
    // per-frame readback+alloc storm. The throttle must cap it to ~1 readback per
    // AUDIO_RECOMPUTE_EVERY frames, NOT one per frame.
    stats.readPixels = 0;
    const before = setWaveCount(audio);
    const FRAMES = AUDIO_RECOMPUTE_EVERY * 3; // 72 frames of live modulation
    for (let i = 0; i < FRAMES; i++) {
      handle.setParam('morph_fc', 0.1 + 0.3 * Math.sin(i)); // a distinct value each frame
      handle.surface.draw(frame);
    }
    const recomputes = setWaveCount(audio) - before;
    // A per-frame storm would be FRAMES recomputes (72) × 3 readbacks = 216.
    // Throttled: ~FRAMES / AUDIO_RECOMPUTE_EVERY = 3 recomputes.
    expect(recomputes, `modulating CV recompute is throttled (${recomputes} over ${FRAMES} frames)`)
      .toBeLessThanOrEqual(Math.ceil(FRAMES / AUDIO_RECOMPUTE_EVERY) + 1);
    expect(recomputes, 'but the drone DOES still track the sweep').toBeGreaterThanOrEqual(1);
    expect(stats.readPixels, 'readback is NOT per-frame (≤ 3 rings × recomputes)')
      .toBeLessThanOrEqual(3 * (Math.ceil(FRAMES / AUDIO_RECOMPUTE_EVERY) + 1));
    handle.dispose();
  });

  it('B2: an IDLE module recomputes a single tweak promptly (throttle only caps a sweep)', async () => {
    const audio = makeFakeAudio();
    const ctx = makeCtx(audio);
    const handle = videocubeDef.factory(ctx, mkNode());
    await audio.workletReady; await Promise.resolve(); await Promise.resolve();
    // No live input → rings idle → `sinceRecompute` grows past the throttle, so the
    // NEXT real param change fires on the very next frame (responsive when idle).
    const idle = mkFrame(ctx.gl, false);
    for (let i = 0; i < AUDIO_RECOMPUTE_EVERY + 2; i++) handle.surface.draw(idle);
    const base = setWaveCount(audio);
    handle.setParam('morph_fc', 0.7); // a real change while idle
    handle.surface.draw(idle);
    expect(setWaveCount(audio), 'idle tweak recomputes next frame').toBe(base + 1);
    handle.dispose();
  });

  it('B2: MATERIAL + WRAP mark the audio dirty (they govern both image AND sound)', async () => {
    const audio = makeFakeAudio();
    const ctx = makeCtx(audio);
    const handle = videocubeDef.factory(ctx, mkNode());
    await audio.workletReady; await Promise.resolve(); await Promise.resolve();
    const idle = mkFrame(ctx.gl, false); // idle so each dirty change fires promptly

    const drain = () => { for (let i = 0; i < AUDIO_RECOMPUTE_EVERY + 1; i++) handle.surface.draw(idle); };
    drain(); // let the throttle open
    let base = setWaveCount(audio);
    handle.setParam('material', 1); // SMOOTH → HARD
    handle.surface.draw(idle);
    expect(setWaveCount(audio), 'MATERIAL change re-derives the audio').toBe(base + 1);
    drain(); base = setWaveCount(audio);
    handle.setParam('wrap', 1); // clamp → mirror-fold
    handle.surface.draw(idle);
    expect(setWaveCount(audio), 'WRAP change re-derives the audio').toBe(base + 1);
    handle.dispose();
  });

  it('B3: READER MODE + LIVE re-derive the audio (audio reads the reader-selected frame)', async () => {
    const audio = makeFakeAudio();
    const ctx = makeCtx(audio);
    const handle = videocubeDef.factory(ctx, mkNode());
    await audio.workletReady; await Promise.resolve(); await Promise.resolve();
    const idle = mkFrame(ctx.gl, false);
    const drain = () => { for (let i = 0; i < AUDIO_RECOMPUTE_EVERY + 1; i++) handle.surface.draw(idle); };

    drain(); let base = setWaveCount(audio);
    handle.setParam('reader_mode', 1); // SMOOTH → MORPH: audio must re-pick the frame
    handle.surface.draw(idle);
    expect(setWaveCount(audio), 'reader_mode change re-derives the audio (B3)').toBe(base + 1);
    drain(); base = setWaveCount(audio);
    handle.setParam('live', 1); // force the no-lag frame → different reduced frame
    handle.surface.draw(idle);
    expect(setWaveCount(audio), 'LIVE change re-derives the audio (B3)').toBe(base + 1);
    handle.dispose();
  });

  it('VIEW camera params drive the volume render + round-trip, WITHOUT recomputing audio', async () => {
    const audio = makeFakeAudio();
    const ctx = makeCtx(audio);
    const handle = videocubeDef.factory(ctx, mkNode());
    await audio.workletReady; await Promise.resolve(); await Promise.resolve();
    const frame = mkFrame(ctx.gl, true);

    handle.surface.draw(frame); // initial scan
    const base = setWaveCount(audio);

    // Moving the orbit camera drives the ray-march uniforms but is picture-only:
    // it must NOT re-derive the audio (view params are not in AUDIO_PARAMS).
    for (const [pid, v] of [['view_zoom', 2], ['view_rot_x', 1.2], ['view_rot_y', -0.8], ['view_rot_z', 0.5]] as const) {
      handle.setParam(pid, v);
      handle.surface.draw(frame); // renders the volume with the new camera; must not throw
      expect(handle.readParam(pid)).toBe(v);
    }
    expect(setWaveCount(audio), 'VIEW params are picture-only (no audio recompute)').toBe(base);
    handle.dispose();
  });

  it('PER-PORT gating: each PATCHED viz port adds exactly one render pass (unpatched = ZERO)', async () => {
    const audio = makeFakeAudio();
    const ctx = makeCtx(audio);
    let drawCount = 0;
    (ctx as unknown as { drawFullscreenQuad: () => void }).drawFullscreenQuad = () => { drawCount++; };
    const handle = videocubeDef.factory(ctx, mkNode());
    await audio.workletReady; await Promise.resolve(); await Promise.resolve();

    const frameWith = (ports: string[]) =>
      ({ ...mkFrame(ctx.gl, true), connectedOutputPorts: () => new Set(ports) } as unknown as VideoFrameContext);

    // Seat the rings first (the first-frame FILL draws 60×/slot; warm up so both
    // measured frames are in the steady 1-draw-per-slot capture regime).
    for (let i = 0; i < 3; i++) handle.surface.draw(frameWith(['video_out']));

    // Only video_out patched → NO viz passes render (they are skipped entirely).
    drawCount = 0;
    handle.surface.draw(frameWith(['video_out']));
    const none = drawCount;

    // All 6 viz ports patched → 6 extra render passes vs the video_out-only frame.
    drawCount = 0;
    handle.surface.draw(frameWith(['video_out', 'scope_out', 'slice_out', 'depth_out', 'smooth_out', 'morph_out', 'chaos_out']));
    const all = drawCount;

    expect(all - none, 'six patched viz ports = six extra passes; unpatched = zero').toBe(6);
    handle.dispose();
  });

  it('slice_view is PICTURE-ONLY — it does NOT recompute the derived audio', async () => {
    const audio = makeFakeAudio();
    const ctx = makeCtx(audio);
    const handle = videocubeDef.factory(ctx, mkNode());
    await audio.workletReady; await Promise.resolve(); await Promise.resolve();
    const idle = mkFrame(ctx.gl, false);
    const drain = () => { for (let i = 0; i < AUDIO_RECOMPUTE_EVERY + 1; i++) handle.surface.draw(idle); };
    drain();
    const base = setWaveCount(audio);
    handle.setParam('slice_view', 2); // TEXTURED → WEIGHTS
    handle.surface.draw(idle);
    expect(handle.readParam('slice_view')).toBe(2);
    expect(setWaveCount(audio), 'slice_view is a viz colorize only (no audio recompute)').toBe(base);
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
