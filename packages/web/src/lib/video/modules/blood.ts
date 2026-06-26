// packages/web/src/lib/video/modules/blood.ts
//
// BLOOD — single-instance, owner-only interactive video module (the NBlood/
// Build-engine port; the DOOM module's analogue). Phase 1 is SINGLE-PLAYER:
// one shared owner-spawned node, this peer runs its own WASM-backed NBlood
// instance + renders the Build software framebuffer into a GL texture.
//
// Engine reuse map (from DOOM): build-doom-wasm.sh → build-blood-wasm.sh;
// doom-runtime.ts → blood-runtime.ts; doomkeys.ts → blood-keys.ts; DoomCard →
// BloodCard. The multiplayer lockstep stack (doom-lockstep/doom-netcode) is
// reused VERBATIM in a later phase; Phase 1 ships single-player only.
//
// DATA: Blood game files are user-supplied + NOT redistributable
// (native/nblood/PHASE0-STATUS.md §3) — there is no out-of-box play. With no
// data the card shows "Blood data missing — run `task setup:blood`".
//
// Inputs (CV-typed gates — single player, one group, unlike DOOM's 4 per-slot):
//   up/down/left/right, fire, altfire, use, jump, crouch, weapnext/weapprev,
//   esc, enter — rising edges enqueue Build scancodes into the WASM input queue.
// Outputs:
//   out (video): the Build software framebuffer (aspect-correct letterboxed).
//   audio_l / audio_r (audio): stereo bridges (silent in v1 — PCM stub).
//
// NOTE (kill-gate status): blood.wasm LINKS + the engine boots in WASM; the
// only thing gating a rendered frame is the user-supplied data
// (native/nblood/PHASE1-STATUS.md). The factory is wired so that the moment a
// tester supplies BLOOD.RFF/GUI.RFF/SOUNDS.RFF via `task setup:blood`, the card
// renders the game.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { aspectFitScale } from '$lib/video/video-res';
import { BloodRuntime, loadBloodData } from '$lib/blood/blood-runtime';
import { detectEdge, makeEdgeState, type EdgeState } from '$lib/doom/cv-gate-edge';
import {
  CV_GATE_PORT_IDS,
  SCANCODE_FOR_CV_GATE,
  SCANCODE_FOR_KEYBOARD_CODE as KEYBOARD_CODE_SCANCODE,
  type BloodCvGatePortId,
} from '$lib/blood/blood-keys';

// Fragment shader: sample the Build framebuffer (RGBA8 from softsurface) +
// letterbox into the engine FBO. Build games render at 320×200 (10:8 → 1.6:1
// pixel-aspect, like DOOM); the letterbox math is res-adaptive via ctx.res.
const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasFrame;
uniform vec2 uLetterbox;

void main() {
  if (uHasFrame < 0.5) {
    // Idle: dark red scanline texture — reads as "alive, no signal" (Blood-red).
    float scan = 0.5 + 0.5 * sin(vUv.y * 100.0);
    outColor = vec4(0.06, 0.01, 0.01, 1.0) * scan;
    return;
  }
  vec2 centered = (vUv - 0.5) / uLetterbox + 0.5;
  if (centered.x < 0.0 || centered.x > 1.0 || centered.y < 0.0 || centered.y > 1.0) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  // softsurface emits RGBA (R in low byte — we set the masks in the shim), so
  // no BGRA swizzle here (DOOM's was BGRA).
  outColor = vec4(texture(uTex, centered).rgb, 1.0);
}`;

interface BloodParams {
  audioGain: number; // 0..2
  fillMode: number; // 0 = letterbox (default), 1 = fill (cover-crop)
}

const DEFAULTS: BloodParams = { audioGain: 1.0, fillMode: 0 };

// Default Build framebuffer size (320×200) until the engine reports a real one.
const DEFAULT_W = 320;
const DEFAULT_H = 200;

/** Card-facing handle (engine.read(id, 'extras')). The BLOOD analogue of
 *  DoomHandleExtras, trimmed to the single-player Phase-1 surface. */
export interface BloodHandleExtras {
  /** The live runtime (null while WASM/data load, or if not built). */
  getRuntime(): BloodRuntime | null;
  /** Load the WASM + user-supplied data, then boot the engine. Returns an error
   *  string (e.g. data-missing / not-built) or null on success. Idempotent. */
  ensureLoaded(): Promise<string | null>;
  /** Push a KeyboardEvent.code (the card translates → Build scancode). Returns
   *  true if the code is mapped. */
  pushKeyboardKey(code: string, pressed: boolean): boolean;
  /** Names of any REQUIRED Blood data files that were missing at load (so the
   *  card can show the "load your data" prompt). Empty once loaded OK. */
  missingDataFiles(): string[];
  /** Discard a prior (failed) load so a fresh ensureLoaded() re-attempts — used
   *  after the owner supplies in-browser data, so the data-missing result can be
   *  retried without re-spawning the node. Disposes any partly-booted runtime. */
  resetLoad(): void;
}

export const bloodDef: VideoModuleDef = {
  type: 'blood',
  palette: { top: 'Games', sub: 'Emulators' },
  domain: 'video',
  label: 'blood',
  category: 'sources',
  schemaVersion: 1,
  // ONE BLOOD node per rack (mirrors DOOM's one-shared-node model).
  maxInstances: 1,
  // Owner-only: like DOOM, only the rack owner may add it.
  ownerOnly: true,
  inputs: [
    ...CV_GATE_PORT_IDS.map((base) => ({
      id: base,
      type: 'cv' as const,
      // Movement/action gates are level-sensitive (held while HIGH); esc/enter
      // are menu triggers. Both flow through the unified cv/gate cable.
      edge: (base === 'esc' || base === 'enter' ? 'trigger' : 'gate') as 'trigger' | 'gate',
      paramTarget: `cv_${base}`,
    })),
  ],
  outputs: [
    { id: 'out', type: 'video' },
    { id: 'audio_l', type: 'audio' },
    { id: 'audio_r', type: 'audio' },
  ],
  params: [
    { id: 'audioGain', label: 'Gain', defaultValue: 1, min: 0, max: 2, curve: 'linear' },
    { id: 'fillMode', label: 'Fill', defaultValue: DEFAULTS.fillMode, min: 0, max: 1, curve: 'discrete' },
    // Synthetic CV-edge params (one per gate port), hidden from the card.
    ...CV_GATE_PORT_IDS.map((base) => ({
      id: `cv_${base}`,
      label: base.toUpperCase(),
      defaultValue: 0,
      min: 0,
      max: 1,
      curve: 'linear' as const,
    })),
  ],
  // docs-hash-ignore:start  -- co-located living-docs; stripped from the WebGL attest hash
  docs: {
    explanation:
      'BLOOD runs the NBlood (Build-engine) port of Blood as an interactive video source. ' +
      'It is owner-only and single-instance — the rack owner spawns it and plays; the ' +
      'video output is the Build software-rendered framebuffer, letterboxed into the engine ' +
      'canvas. Game data (BLOOD.RFF / GUI.RFF / SOUNDS.RFF / TILES000.ART) is USER-SUPPLIED ' +
      'and not redistributable, so the card shows a "data missing" overlay until you run ' +
      '`task setup:blood` with a copy you own (GOG/Steam One Unit Whole Blood or Fresh Supply).',
    inputs: {
      up: 'CV gate — move forward while the gate is held HIGH.',
      down: 'CV gate — move backward while held HIGH.',
      left: 'CV gate — turn left while held HIGH.',
      right: 'CV gate — turn right while held HIGH.',
      fire: 'CV gate — fire the current weapon while the gate is held HIGH.',
      altfire: 'CV gate — alternate fire while held HIGH.',
      use: 'CV gate — open doors / use switches while held HIGH.',
      jump: 'CV gate — jump while held HIGH.',
      crouch: 'CV gate — stay crouched while held HIGH.',
      weapnext: 'CV gate — select the next weapon while held HIGH.',
      weapprev: 'CV gate — select the previous weapon while held HIGH.',
      esc: 'CV trigger — open / back out of the menu (fires once per rising edge).',
      enter: 'CV trigger — confirm the highlighted menu item (fires once per rising edge).',
    },
    outputs: {
      out: 'The Build software-rendered game framebuffer, aspect-correct letterboxed into the canvas.',
      audio_l: 'Left channel of the game audio (silent in v1 — PCM bridge is stubbed).',
      audio_r: 'Right channel of the game audio (silent in v1 — PCM bridge is stubbed).',
    },
    controls: {
      audioGain: 'Trims the game-audio level feeding audio_l/audio_r (0..2, default 1).',
      fillMode: 'Letterbox (preserve aspect, default) vs fill (cover-crop) the canvas.',
    },
  },
  // docs-hash-ignore:end

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uTex = gl.getUniformLocation(program, 'uTex');
    const uHasFrame = gl.getUniformLocation(program, 'uHasFrame');
    const uLetterbox = gl.getUniformLocation(program, 'uLetterbox');

    const { fbo, texture } = ctx.createFbo();
    const bloodAspect = DEFAULT_W / DEFAULT_H;

    const sourceTex = gl.createTexture();
    if (!sourceTex) throw new Error('BLOOD: createTexture failed');
    let texW = DEFAULT_W;
    let texH = DEFAULT_H;
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, texW, texH, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array(texW * texH * 4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    let runtime: BloodRuntime | null = null;
    let loaded = false;
    let loadError: string | null = null;
    let loadPending: Promise<string | null> | null = null;
    let hasFrame = false;
    let missingFiles: string[] = [];

    const edgeStates = new Map<string, EdgeState>();
    for (const base of CV_GATE_PORT_IDS) edgeStates.set(base, makeEdgeState());

    const params: BloodParams & Record<string, number> = {
      ...DEFAULTS,
      ...(node.params as Partial<BloodParams>),
    };

    // Persistent audio bridges (silent v1 — PCM stub). Same identity contract as
    // DOOM so an early-wired cable lights up if/when audio lands.
    const audioSources = new Map<string, { node: AudioNode; output: number }>();
    let leftGain: GainNode | null = null;
    let rightGain: GainNode | null = null;
    if (ctx.audioCtx) {
      const ac = ctx.audioCtx;
      leftGain = ac.createGain();
      leftGain.gain.value = 1;
      rightGain = ac.createGain();
      rightGain.gain.value = 1;
      audioSources.set('audio_l', { node: leftGain, output: 0 });
      audioSources.set('audio_r', { node: rightGain, output: 0 });
    }

    async function ensureLoaded(): Promise<string | null> {
      if (loaded) return loadError;
      if (loadPending) return loadPending;
      const work = (async () => {
        const { runtime: rt, error: rtErr } = await BloodRuntime.load();
        if (!rt) {
          loadError = rtErr ?? 'BLOOD runtime failed to load';
          loaded = true;
          return loadError;
        }
        const { files, missing } = await loadBloodData();
        missingFiles = missing;
        if (missing.length > 0) {
          loadError = `Blood data missing (${missing.join(', ')}) — run \`task setup:blood\` with a copy you own.`;
          loaded = true;
          return loadError;
        }
        try {
          rt.init(files);
        } catch (e) {
          // The engine aborts in its resource loader if a required file is bad.
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

    function resetLoad(): void {
      // Tear down a partly-booted runtime + clear the load latch so a fresh
      // ensureLoaded() (after the owner supplies in-browser data) re-attempts.
      if (runtime) {
        try {
          runtime.dispose();
        } catch {
          /* */
        }
      }
      runtime = null;
      loaded = false;
      loadError = null;
      loadPending = null;
      missingFiles = [];
      hasFrame = false;
    }

    function pushKeyboardKey(code: string, pressed: boolean): boolean {
      if (!runtime) return false;
      // Lazy import avoided — the card already has the map; here we re-derive
      // from blood-keys via the runtime path. Keep it simple: the card passes
      // already-translated keys via the runtime; this convenience handles codes.
      const scancode = KEYBOARD_CODE_SCANCODE[code];
      if (scancode === undefined) return false;
      runtime.setKey(scancode, pressed);
      return true;
    }

    function uploadFramebufferToTexture(buf: Uint8ClampedArray, w: number, h: number): void {
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      if (w !== texW || h !== texH) {
        // Resolution changed (engine set its real video mode) — reallocate.
        texW = w;
        texH = h;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      }
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      hasFrame = true;
    }

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        if (runtime && runtime.isInitialized()) {
          try {
            runtime.runFrame();
          } catch {
            /* an asyncify rewind fault must never break the surface tick */
          }
          if (runtime.hasFrame()) {
            const { width, height } = runtime.resolution();
            const fb = runtime.getFramebuffer();
            if (fb && width > 0 && height > 0) uploadFramebufferToTexture(fb, width, height);
          }
        }

        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, sourceTex);
        g.uniform1i(uTex, 0);
        g.uniform1f(uHasFrame, hasFrame ? 1.0 : 0.0);
        const { sx, sy } = aspectFitScale(
          bloodAspect,
          ctx.res.width / ctx.res.height,
          params.fillMode >= 0.5 ? 'fill' : 'letterbox',
        );
        g.uniform2f(uLetterbox, sx, sy);
        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteTexture(sourceTex);
        gl.deleteProgram(program);
        if (leftGain) try { leftGain.disconnect(); } catch { /* */ }
        if (rightGain) try { rightGain.disconnect(); } catch { /* */ }
        if (runtime) runtime.dispose();
        runtime = null;
      },
    };

    const extras: BloodHandleExtras = {
      getRuntime() {
        return runtime;
      },
      ensureLoaded,
      pushKeyboardKey,
      missingDataFiles() {
        return missingFiles;
      },
      resetLoad,
    };

    return {
      domain: 'video',
      surface,
      audioSources,
      setParam(paramId, value) {
        if (paramId in params) (params as Record<string, number>)[paramId] = value;
        // CV-gate edge → scancode key. Single group (single-player).
        if (paramId.startsWith('cv_')) {
          const base = paramId.slice(3) as BloodCvGatePortId;
          const state = edgeStates.get(base);
          if (!state) return;
          const sc = SCANCODE_FOR_CV_GATE[base];
          if (sc === undefined) return;
          const ev = detectEdge(state, value);
          if (!ev || !runtime) return;
          runtime.setKey(sc, ev.pressed);
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
      dispose() {
        surface.dispose();
      },
    };
  },
};
