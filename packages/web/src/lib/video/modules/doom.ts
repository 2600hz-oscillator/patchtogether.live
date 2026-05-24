// packages/web/src/lib/video/modules/doom.ts
//
// DOOM — single-instance interactive video module. One WASM-backed
// instance of doomgeneric runs on whichever rack-mate spawned the
// module ("host"); spectators receive framebuffers via Yjs awareness
// at ~10 Hz and render those instead of running their own WASM.
//
// Multiplayer: see /docs/design/game-modules.md §3 (DOOM rack model)
// and packages/web/src/lib/doom/doom-presence.ts. This factory is
// agnostic of the multiplayer wiring — the card decides whether to
// drive the runtime locally or feed it from incoming awareness
// frames. The engine here just exposes:
//   - the GL surface that displays the 640×400 BGRA framebuffer (with
//     aspect-correct letterboxing into the engine's 640×360 FBO);
//   - the 7 CV-gate inputs (w/a/s/d/space/ctrl/alt) edge-detected into
//     dgpt_set_key calls on the runtime;
//   - the stereo audio outputs (audio_l, audio_r) routed through the
//     new VideoNodeHandle.audioSources cross-domain bridge to feed the
//     audio graph (silent until slice 8 lands).
//
// The card connects to the runtime via the handle's `read('extras')`
// channel — mirrors how PictureboxCard pulls setImage/setFilename out
// of PICTUREBOX's factory.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { DoomRuntime } from '$lib/doom/doom-runtime';
import { detectEdge, makeEdgeState, type EdgeState } from '$lib/doom/cv-gate-edge';
import { CV_GATE_PORT_IDS, KEY_FOR_CV_GATE, type CvGatePortId } from '$lib/doom/doomkeys';

// AudioWorkletProcessor URL — served as a static asset under
// /doom/doom-pcm-worklet.js. Loaded lazily per AudioContext (WeakSet
// avoids double-add on hot-reload + on a second DOOM module spawn
// within the same audio context). maxInstances:1 means we only ever
// hit this once per page-load in practice.
const DOOM_PCM_WORKLET_URL = '/doom/doom-pcm-worklet.js';
const WORKLET_LOADED = new WeakSet<BaseAudioContext>();

async function ensureDoomPcmWorklet(ac: BaseAudioContext): Promise<void> {
  if (WORKLET_LOADED.has(ac)) return;
  // The processor name 'doom-pcm' is registered inside the worklet
  // file; calling addModule twice with the same name across two
  // contexts is fine, but within ONE context it throws — hence the
  // per-context guard.
  await ac.audioWorklet.addModule(DOOM_PCM_WORKLET_URL);
  WORKLET_LOADED.add(ac);
}

// Fragment shader: sample the 640×400 BGRA framebuffer and letterbox it
// into the engine's 640×360 FBO. DOOM is 1.6:1 (640:400 = 8:5); the
// engine's FBO is 16:9 (640:360 = 16:9 ≈ 1.78:1). So we keep height +
// letterbox horizontally — a slight black bar on either side at the
// engine's aspect.
//
// vUv is (0..1, 0..1) over the FBO with origin bottom-left (GL default,
// vUv = aPos * 0.5 + 0.5 in the shared vertex shader). DOOM's
// framebuffer is row-major top-down (DG_ScreenBuffer is uint32_t pixel
// 0..639 row 0 = top), and we upload with UNPACK_FLIP_Y_WEBGL=true so
// the GL coordinate `vUv.y = 0 = bottom` maps to DOOM's `y = bottom`.
// BGRA → RGBA swizzle in the shader (DOOM's pixel_t is uint32_t with
// blue in low byte → little-endian = B,G,R,A in memory).
const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasFrame;
uniform vec2 uLetterbox;  // (sx, sy) — UV scale to fit DOOM aspect in engine FBO

void main() {
  if (uHasFrame < 0.5) {
    // Idle: dark warm grey + a subtle scanline texture so an empty card
    // still reads as "alive but no signal" rather than "broken".
    float scan = 0.5 + 0.5 * sin(vUv.y * 100.0);
    outColor = vec4(0.04, 0.02, 0.02, 1.0) * scan;
    return;
  }
  // Compute centered, aspect-preserving UV. uLetterbox carries the
  // ratio of DOOM-aspect to FBO-aspect; we shrink the active region by
  // that factor and centre it. Outside the active region renders pure
  // black so spectators see a clean letterbox.
  vec2 centered = (vUv - 0.5) / uLetterbox + 0.5;
  if (centered.x < 0.0 || centered.x > 1.0 || centered.y < 0.0 || centered.y > 1.0) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec4 src = texture(uTex, centered);
  // BGRA → RGBA swizzle.
  outColor = vec4(src.b, src.g, src.r, 1.0);
}`;

// Parameters: just a master "running" toggle — the card has its own
// controls (focus / spawn-runtime / host-indicator), and there are no
// audio-rate knobs to expose. Keep the schema small to keep the
// module-spec snapshot deterministic.
interface DoomParams {
  running: number;     // 0 = paused (don't tick), 1 = run
  audioGain: number;   // 0..2, multiplier applied at the audio bridge (PCM zero-clipped under stereo PCM stub)
}

const DEFAULTS: DoomParams = {
  running: 1.0,
  audioGain: 1.0,
};

/** Handle-extras: card-facing handle for the runtime + input feedback.
 *  Mirrors PictureboxHandleExtras — the card calls
 *  `engine.read(id, 'extras')` to get this. */
export interface DoomHandleExtras {
  /** The live runtime (may be null while WASM is still loading or
   *  build-doom-wasm.sh hasn't been run yet). */
  getRuntime(): DoomRuntime | null;
  /** Card calls this once when the user spawns the module + clicks the
   *  card to confirm load. Returns an error string if the WASM/WAD
   *  load failed, or null on success. Idempotent. */
  ensureLoaded(): Promise<string | null>;
  /** Push a keyboard event (translated from KeyboardEvent.code by the
   *  card). Returns true if the code is mapped, false otherwise. */
  pushKeyboardKey(code: string, pressed: boolean): boolean;
  /** Push an already-translated raw doomkey (for the Yjs presence relay
   *  on the host side; spectators don't call this — they just render
   *  the host's framebuffer). */
  pushDoomKey(doomKey: number, pressed: boolean): void;
  /** Snapshot the current framebuffer for awareness broadcast. */
  snapshotFramebuffer(): Uint8ClampedArray | null;
  /** Spectator path: overwrite the displayed framebuffer with a remote
   *  one (received via Yjs awareness). Buffer must be BGRA8 at the
   *  engine's expected DOOM resolution. */
  pushRemoteFramebuffer(buf: Uint8Array): void;
}

export const doomDef: VideoModuleDef = {
  type: 'doom',
  domain: 'video',
  label: 'DOOM',
  category: 'sources',
  schemaVersion: 1,
  // ONE per rack — heavy WASM module + we don't want every rack-mate
  // running their own. Plan §"maxInstances: 1".
  maxInstances: 1,
  // 7 cv-typed gate inputs per the plan. paramTarget maps each to a
  // synthetic param so the engine's setParam path drives our edge
  // detector (the same way other modules handle CV-into-param).
  inputs: CV_GATE_PORT_IDS.map((id) => ({
    id,
    type: 'cv' as const,
    paramTarget: `cv_${id}`,
  })),
  outputs: [
    { id: 'audio_l', type: 'audio' },
    { id: 'audio_r', type: 'audio' },
  ],
  params: [
    { id: 'running', label: 'Run', defaultValue: 1, min: 0, max: 1, curve: 'discrete' },
    { id: 'audioGain', label: 'Gain', defaultValue: 1, min: 0, max: 2, curve: 'linear' },
    // Synthetic params for the CV edge detector — one per gate port.
    // Hidden from the card (the gate inputs render as cv-jacks via the
    // standard port-row). curve='linear' so setParam values arrive raw.
    ...CV_GATE_PORT_IDS.map((id) => ({
      id: `cv_${id}`,
      label: id.toUpperCase(),
      defaultValue: 0,
      min: 0,
      max: 1,
      curve: 'linear' as const,
    })),
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uTex = gl.getUniformLocation(program, 'uTex');
    const uHasFrame = gl.getUniformLocation(program, 'uHasFrame');
    const uLetterbox = gl.getUniformLocation(program, 'uLetterbox');

    // FBO at engine resolution + a "source texture" sized for the
    // DOOM framebuffer (640×400 BGRA8). Two textures because the FBO is
    // 640×360 (engine.res) — we don't want to resize FBOs per-module.
    const { fbo, texture } = ctx.createFbo();

    // Letterbox math: engine FBO is res.width×res.height, DOOM is
    // 640×400 (1.6:1). We keep DOOM upright at FBO height, so the
    // x-direction shrinks by (fboAspect / doomAspect).
    const fboAspect = ctx.res.width / ctx.res.height;
    const doomAspect = 640 / 400;
    // Active region: in U direction we scale by 1, V direction by 1.
    // To put a 1.6:1 source inside a wider FBO, the active region width
    // (in UV) is fboAspect / doomAspect → wait, actually:
    // We have a 1.78:1 canvas, fitting 1.6:1 content height-locked.
    // Content fills full height (V scale 1). Content width is
    // (height * doomAspect) / fboWidth = (1 * 1.6) / 1.78 = 0.9.
    // So we want active V = 1.0, active U = doomAspect/fboAspect = 0.9.
    // In the shader's `centered = (vUv - 0.5) / uLetterbox + 0.5`,
    // uLetterbox is the "size of active region in UV space" — values
    // less than 1 shrink the active region. So uLetterbox = (0.9, 1.0).
    const letterboxU = Math.min(1.0, doomAspect / fboAspect);
    const letterboxV = Math.min(1.0, fboAspect / doomAspect);

    const sourceTex = gl.createTexture();
    if (!sourceTex) throw new Error('DOOM: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    // Pre-allocate a 640×400 BGRA8 texture — we'll texSubImage2D into
    // it each frame (cheaper than re-allocating).
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,                // internal — we don't actually have a BGRA internal format on WebGL2; rely on the shader swizzle.
      640,
      400,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(640 * 400 * 4),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    let runtime: DoomRuntime | null = null;
    let loaded = false;
    let loadError: string | null = null;
    let loadPending: Promise<string | null> | null = null;
    let hasFrame = false;
    // Last-pushed remote framebuffer (spectator path). When non-null,
    // we upload this every frame instead of polling the runtime.
    let remoteFramebuffer: Uint8Array | null = null;
    let lastTicMs = performance.now();

    // Edge-detector state, one per CV gate port.
    const edgeStates = new Map<CvGatePortId, EdgeState>();
    for (const id of CV_GATE_PORT_IDS) edgeStates.set(id, makeEdgeState());

    const params: DoomParams & Record<string, number> = {
      ...DEFAULTS,
      ...(node.params as Partial<DoomParams>),
    };

    // Audio source registration. We publish entries lazily — start
    // with silent ConstantSourceNodes so the bridge always has a node
    // to wire (audio is in graph from the start, even before WASM
    // loads), then SWAP in the worklet once it loads.
    const audioSources = new Map<string, { node: AudioNode; output: number }>();
    let leftSrc: AudioNode | null = null;
    let rightSrc: AudioNode | null = null;
    let pcmWorklet: AudioWorkletNode | null = null;
    let pumpInterval: ReturnType<typeof setInterval> | null = null;

    if (ctx.audioCtx) {
      const ac = ctx.audioCtx;
      const l = ac.createConstantSource();
      l.offset.setValueAtTime(0, ac.currentTime);
      l.start();
      leftSrc = l;
      const r = ac.createConstantSource();
      r.offset.setValueAtTime(0, ac.currentTime);
      r.start();
      rightSrc = r;
      audioSources.set('audio_l', { node: l, output: 0 });
      audioSources.set('audio_r', { node: r, output: 0 });

      // Slice 8: load the doom-pcm AudioWorkletProcessor + swap the
      // silent fallback for a real PCM pump. setupPcmWorklet rewrites
      // the audioSources entries — downstream `getAudioSource` reads
      // by-port so the bridge picks up the worklet on next reconcile.
      void setupPcmWorklet(ac);
    }

    async function setupPcmWorklet(ac: BaseAudioContext): Promise<void> {
      try {
        await ensureDoomPcmWorklet(ac);
        const node = new AudioWorkletNode(ac, 'doom-pcm', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        pcmWorklet = node;
        // Replace the silent-CSN entries with the live worklet. The
        // audio bridge reads `audioSources` at addEdge time — cables
        // wired AFTER the worklet loads pick up the worklet; cables
        // wired in the ~100ms BEFORE it loads stay on the silent CSN
        // (user can re-wire to refresh). In practice the worklet
        // resolves well before users finish wiring a cable.
        audioSources.set('audio_l', { node, output: 0 });
        audioSources.set('audio_r', { node, output: 0 });

        // Pump the WASM mixer at ~60 Hz. The WASM's I_UpdateSound is
        // called from dgpt_tick which we drive at runTic from the
        // surface.draw path, so this pump JUST drains the already-mixed
        // samples into the worklet's queue.
        const samplesPerPump = Math.round(44100 / 60);
        pumpInterval = setInterval(() => {
          if (!runtime || !runtime.isInitialized()) return;
          if (!pcmWorklet) return;
          const frames = runtime.getPcmFrames(samplesPerPump);
          if (frames.length > 0) {
            pcmWorklet.port.postMessage({ type: 'pcm', samples: frames });
          }
        }, 16);
        try {
          pcmWorklet.port.postMessage({ type: 'gain', value: params.audioGain });
        } catch { /* */ }
      } catch (e) {
        // Worklet load failed — keep the silent ConstantSource fallback.
        // Common cause: CSP blocks the worklet URL, or build-doom-wasm
        // hasn't been run + the static file isn't shipped.
        // eslint-disable-next-line no-console
        console.warn('[DOOM] AudioWorklet load failed; audio_l/r will be silent', e);
      }
    }

    async function ensureLoaded(): Promise<string | null> {
      if (loaded) return loadError;
      if (loadPending) return loadPending;
      const work = (async () => {
        const { runtime: rt, error: rtErr } = await DoomRuntime.load();
        if (!rt) {
          loadError = rtErr ?? 'DOOM runtime failed to load';
          loaded = true;
          return loadError;
        }
        const { loadWad } = await import('$lib/doom/doom-runtime');
        const { bytes, error: wadErr } = await loadWad();
        if (!bytes) {
          loadError = wadErr ?? 'DOOM1.WAD missing';
          loaded = true;
          return loadError;
        }
        try {
          rt.init(bytes);
        } catch (e) {
          loadError = e instanceof Error ? e.message : String(e);
          loaded = true;
          return loadError;
        }
        runtime = rt;
        loaded = true;
        loadError = null;
        return null;
      })();
      loadPending = work;
      return work;
    }

    function pushKeyboardKey(code: string, pressed: boolean): boolean {
      if (!runtime) return false;
      return runtime.setKeyForKeyboardCode(code, pressed);
    }

    function pushDoomKey(doomKey: number, pressed: boolean): void {
      if (!runtime) return;
      runtime.setKey(doomKey, pressed);
    }

    function snapshotFramebuffer(): Uint8ClampedArray | null {
      if (!runtime || !runtime.isInitialized()) return null;
      // Caller MUST consume immediately — the view is into live HEAPU8.
      // The presence broadcaster does a base64 encode that copies the
      // bytes, so the snapshot survives the next tic.
      return runtime.getFramebuffer();
    }

    function pushRemoteFramebuffer(buf: Uint8Array): void {
      remoteFramebuffer = buf;
    }

    function uploadFramebufferToTexture(buf: Uint8Array | Uint8ClampedArray): void {
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      // We're uploading row-major top-down BGRA — set FLIP_Y so the GL
      // origin (bottom-left) sees the image right-side-up. Restore
      // afterwards so other modules' uploads aren't affected.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0, 0,
        640, 400,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        buf,
      );
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      hasFrame = true;
    }

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        // 1. Run a tic on the host (if running, runtime loaded, no
        //    remote-framebuffer override).
        if (params.running > 0.5 && runtime && runtime.isInitialized() && !remoteFramebuffer) {
          const now = performance.now();
          const msDelta = Math.max(1, Math.min(50, now - lastTicMs));
          lastTicMs = now;
          try { runtime.runTic(msDelta); } catch { /* */ }
          const fb = runtime.getFramebuffer();
          uploadFramebufferToTexture(fb);
        } else if (remoteFramebuffer) {
          uploadFramebufferToTexture(remoteFramebuffer);
        }

        // 2. Draw FBO.
        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, sourceTex);
        g.uniform1i(uTex, 0);
        g.uniform1f(uHasFrame, hasFrame ? 1.0 : 0.0);
        g.uniform2f(uLetterbox, letterboxU, letterboxV);
        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteTexture(sourceTex);
        gl.deleteProgram(program);
        if (pumpInterval !== null) {
          clearInterval(pumpInterval);
          pumpInterval = null;
        }
        if (pcmWorklet) {
          try { pcmWorklet.port.postMessage({ type: 'reset' }); } catch { /* */ }
          try { pcmWorklet.disconnect(); } catch { /* */ }
          pcmWorklet = null;
        }
        if (leftSrc) try { leftSrc.disconnect(); } catch { /* */ }
        if (rightSrc) try { rightSrc.disconnect(); } catch { /* */ }
        if (runtime) runtime.dispose();
        runtime = null;
      },
    };

    const extras: DoomHandleExtras = {
      getRuntime() { return runtime; },
      ensureLoaded,
      pushKeyboardKey,
      pushDoomKey,
      snapshotFramebuffer,
      pushRemoteFramebuffer,
    };

    return {
      domain: 'video',
      surface,
      audioSources,
      setParam(paramId, value) {
        if (paramId in params) (params as Record<string, number>)[paramId] = value;
        // Forward audioGain straight to the worklet so a knob twist
        // takes effect without waiting for the next PCM pump.
        if (paramId === 'audioGain' && pcmWorklet) {
          try { pcmWorklet.port.postMessage({ type: 'gain', value }); } catch { /* */ }
        }
        // CV-gate path: edge-detect cv_<port> params + forward to runtime.
        if (paramId.startsWith('cv_')) {
          const portId = paramId.slice(3) as CvGatePortId;
          const state = edgeStates.get(portId);
          if (!state) return;
          const ev = detectEdge(state, value);
          if (ev && runtime) {
            const dk = KEY_FOR_CV_GATE[portId];
            if (dk !== undefined) runtime.setKey(dk, ev.pressed);
          }
        }
      },
      readParam(paramId) {
        return (params as Record<string, number>)[paramId];
      },
      read(key) {
        if (key === 'extras') return extras;
        if (key === 'loaded') return loaded;
        if (key === 'loadError') return loadError;
        if (key === 'hasFrame') return hasFrame;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
