// packages/web/src/lib/video/modules/camera-input.ts
//
// CAMERA — webcam-as-source video module. Implementation of the spec at
// .myrobots/plans/module-camera-input.md.
//
// Frame ingestion path (the single technical decision): a card-owned
// HTMLVideoElement is attached to the module's runtime via
// `handle.attachExternalSource('video', el)`. Every engine tick we sample
// that element with `gl.texImage2D(target, 0, RGBA, RGBA, UNSIGNED_BYTE,
// videoEl)` (first call) → `texSubImage2D` (subsequent calls; cheaper, no
// re-allocation). The output is a fullscreen-quad pass-through with a
// gain multiplier and an optional horizontal flip ("mirror"), rendered
// into the module's FBO so downstream modules see standard `video`
// frames.
//
// The factory is DOM-free. The card UI handles `getUserMedia`, the
// device dropdown, and lifecycle of the `<video>` element. That keeps
// engine code testable without jsdom MediaStream shims.
//
// Inputs:
//   gain (cv, paramTarget=gain): displaces the output-gain knob.
//
// Outputs:
//   out (video): the camera stream as an RGB video source.
//
// Params:
//   gain (linear 0..2): RGB gain multiplier.
//   enabled (discrete 0..1): on/off toggle (off = silent black).
//   mirror (discrete 0..1): horizontal flip ("mirror selfie").

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { createVideoAudioKeepAlive, type VideoAudioKeepAlive } from '$lib/video/video-audio-keepalive';
import { aspectFitScale } from '$lib/video/video-res';

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;     // 0 = idle pattern, 1 = sample texture
uniform float uGain;         // post-multiplier on RGB
uniform float uMirror;       // 0 = passthrough, 1 = horizontal flip
// (sx, sy) — UV scale that ZOOM-FITS (cover) the camera's native aspect
// into the engine's 4:3 FBO without stretching. Computed adaptively per
// ctx.res so a 16:9 webcam gets sx>1 (zoom in + crop the sides) and FILLS
// the 4:3 frame edge-to-edge — no black bars. See cameraCoverScale().
uniform vec2 uLetterbox;

void main() {
  if (uHasInput < 0.5) {
    // Idle: dark navy with a faint vertical sweep, matching OUTPUT's
    // idle look so an unconfigured CAMERA card reads as "alive but
    // nothing here yet" rather than "broken".
    float v = vUv.y * 0.05;
    outColor = vec4(0.04, 0.06, 0.10 + v, 1.0);
    return;
  }
  // Centre + aspect-fit the active region so the camera frame keeps its native
  // aspect. uLetterbox is (sx,sy) from aspectFitScale: FILL/cover (sx,sy >= 1)
  // zooms IN + crops the off-axis (no bars — the default); LETTERBOX/contain
  // (sx,sy <= 1) shrinks so the whole frame fits with black bars.
  vec2 centered = (vUv - 0.5) / uLetterbox + 0.5;
  // Sample with optional horizontal mirror. The webcam frame comes in
  // upside-down relative to GL clip space, but we use UNPACK_FLIP_Y_WEBGL
  // at upload time to fix that — so vUv here is already top-left-origin
  // for the camera frame.
  vec2 uv = centered;
  if (uMirror > 0.5) uv.x = 1.0 - uv.x;
  // In LETTERBOX mode the centered UV can fall outside [0,1] — render those
  // bar pixels black (CLAMP_TO_EDGE would smear the edge). In FILL mode the UV
  // is always in range by construction so this is a no-op.
  if (any(lessThan(centered, vec2(0.0))) || any(greaterThan(centered, vec2(1.0)))) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  // 'sample' is a reserved word in GLSL ES 3.00 — use 'src' instead.
  vec4 src = texture(uTex, uv);
  outColor = vec4(src.rgb * uGain, 1.0);
}`;

/**
 * Zoom-fit ("cover") UV scale that fits a camera frame of native size
 * (srcW × srcH) into the engine FBO (fboW × fboH) WITHOUT stretching,
 * filling the frame edge-to-edge and cropping the overflow on the off-axis.
 *
 * Returned (sx, sy) are >= 1 and feed the shader's
 *   centered = (vUv - 0.5) / (sx, sy) + 0.5
 * which zooms IN (shrinks the sampled region) on the cropped axis so the
 * camera always fills the FBO — no black bars. This is the inverse of the
 * old "contain"/letterbox math (Math.min, scale <= 1) that shrank the feed
 * and produced top/bottom bars once the pipeline FBO flipped 16:9 → 4:3
 * while the camera kept requesting a 16:9 stream (regression #270a4441).
 *
 * Examples (fbo = 4:3, aspect 1.333):
 *   16:9 src (1.778) → (1.333, 1.0): crop sides, full height (the webcam case)
 *    4:3 src (1.333) → (1.0,   1.0): exact fit, no crop
 *    1:1 src (1.000) → (1.0,   1.333): crop top/bottom, full width
 *
 * Degenerate inputs (zero/NaN dimension) fall back to (1, 1) — no scaling.
 */
export function cameraCoverScale(
  srcW: number,
  srcH: number,
  fboW: number,
  fboH: number,
): { sx: number; sy: number } {
  if (!(srcW > 0) || !(srcH > 0) || !(fboW > 0) || !(fboH > 0)) {
    return { sx: 1, sy: 1 };
  }
  const fboAspect = fboW / fboH;
  const srcAspect = srcW / srcH;
  // Cover: scale the SMALLER-relative axis up so the larger one overflows
  // and gets cropped. Both factors are >= 1; exactly one is > 1 (or both
  // equal 1 when the aspects match).
  const sx = Math.max(1, srcAspect / fboAspect);
  const sy = Math.max(1, fboAspect / srcAspect);
  return { sx, sy };
}

interface CameraParams {
  gain: number;
  enabled: number;   // 0 | 1
  mirror: number;    // 0 | 1
  fillMode: number;  // 0 = letterbox, 1 = fill (cover-crop) — DEFAULT
}

const DEFAULTS: CameraParams = {
  gain: 1.0,
  enabled: 1,
  mirror: 1,
  // Cover-crop by default (the existing camera behaviour — never letterbox the
  // live feed). Per-source toggle to letterbox via the card's fit/fill control.
  fillMode: 1,
};

export const cameraInputDef: VideoModuleDef = {
  type: 'cameraInput',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'CAMERA',
  category: 'sources',
  schemaVersion: 1,
  inputs: [
    // CV input for gain modulation. paramTarget == port id keeps the
    // docs manifest in sync; the cross-domain CV bridge looks up the
    // target via port id directly.
    { id: 'gain', type: 'cv', paramTarget: 'gain' },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'gain',     label: 'Gain',   defaultValue: DEFAULTS.gain,     min: 0, max: 2, curve: 'linear' },
    { id: 'enabled',  label: 'On',     defaultValue: DEFAULTS.enabled,  min: 0, max: 1, curve: 'discrete' },
    { id: 'mirror',   label: 'Mirror', defaultValue: DEFAULTS.mirror,   min: 0, max: 1, curve: 'discrete' },
    { id: 'fillMode', label: 'Fill',   defaultValue: DEFAULTS.fillMode, min: 0, max: 1, curve: 'discrete' },
  ],
  // Soft cap mirroring the multiplayer per-rackspace user limit. The
  // browser will fail extra getUserMedia calls anyway with NotReadableError
  // if the hardware can't multiplex; this just keeps the patch graph
  // sane when someone spawns ten CAMERA cards by accident.
  maxInstances: 4,

  factory(ctx, _node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTex       = gl.getUniformLocation(program, 'uTex');
    const uHasInput  = gl.getUniformLocation(program, 'uHasInput');
    const uGain      = gl.getUniformLocation(program, 'uGain');
    const uMirror    = gl.getUniformLocation(program, 'uMirror');
    const uLetterbox = gl.getUniformLocation(program, 'uLetterbox');

    const { fbo, texture: outTexture } = ctx.createFbo();

    // The per-instance source texture — populated from the card's
    // <video> element. Allocated lazily on the first frame upload so
    // we don't reserve GPU memory for a stream that may never start.
    let sourceTexture: WebGLTexture | null = null;
    let sourceTexAllocated = false;

    // The DOM element the card hands us. Null until the card mounts.
    let videoEl: HTMLVideoElement | null = null;

    // True when a fresh frame is available since the last upload.
    // requestVideoFrameCallback (Chrome/FF/Safari 16.4+) sets this; on
    // older browsers we fall back to checking video.readyState every tick.
    let frameDirty = false;
    let rvfcId: number | null = null;
    let rvfcSupported = false;

    // Silent audio keep-alive (src -> gain(0) -> destination) so the
    // AudioContext pulls this element in real time. A <video> bound to a
    // capture MediaStream is throttled by Chromium just like a file element
    // when it's offscreen and its audio isn't pulled — so when several video
    // sources coexist, all but one decode at ~1 fps. The keep-alive keeps this
    // element demanded. Shared with VIDEOBOX / VIDEOVARISPEED via
    // video-audio-keepalive.ts. CAMERA has no audio OUTPUT ports — the
    // keep-alive is internal-only (gain 0 = inaudible) and never patched.
    let keepAlive: VideoAudioKeepAlive | null = null;

    function wireKeepAlive(): void {
      if (keepAlive) return;
      if (!ctx.audioCtx || !videoEl) return;
      try {
        keepAlive = createVideoAudioKeepAlive(ctx.audioCtx, videoEl);
      } catch (err) {
        // InvalidStateError: element already has a MediaElementSource (the card
        // re-attached the same element). Decode keep-alive is best-effort — a
        // failure just means CAMERA falls back to the pre-existing behaviour.
        console.warn('[cameraInput] keep-alive wire failed:', err);
      }
    }

    function unwireKeepAlive(): void {
      if (keepAlive) keepAlive.disconnect();
      keepAlive = null;
    }

    const params: CameraParams = { ...DEFAULTS };

    function attachRvfc(): void {
      if (!videoEl) return;
      // requestVideoFrameCallback isn't in the lib.dom yet for this
      // codebase; feature-test on the prototype.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v = videoEl as any;
      if (typeof v.requestVideoFrameCallback !== 'function') {
        rvfcSupported = false;
        return;
      }
      rvfcSupported = true;
      const tick = (): void => {
        frameDirty = true;
        if (videoEl) rvfcId = v.requestVideoFrameCallback(tick);
      };
      rvfcId = v.requestVideoFrameCallback(tick);
    }

    function detachRvfc(): void {
      if (rvfcId === null || !videoEl) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v = videoEl as any;
      if (typeof v.cancelVideoFrameCallback === 'function') {
        v.cancelVideoFrameCallback(rvfcId);
      }
      rvfcId = null;
    }

    function ensureSourceTexture(): WebGLTexture {
      if (sourceTexture) return sourceTexture;
      const tex = gl.createTexture();
      if (!tex) throw new Error('cameraInput: createTexture failed');
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      sourceTexture = tex;
      return tex;
    }

    /**
     * Upload one frame from `videoEl` into the source texture. Returns
     * true if a fresh frame landed (so the shader pass should run with
     * uHasInput=1), false otherwise (idle pattern).
     */
    function uploadIfReady(): boolean {
      if (!videoEl) return false;
      // HAVE_CURRENT_DATA = 2; the spec's minimum readiness for a
      // sampleable frame. We don't gate on HAVE_ENOUGH_DATA (4) because
      // it's overly strict for an always-live stream.
      if (videoEl.readyState < 2) return false;
      if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) return false;

      // If rVFC is wired AND we've already uploaded at least one frame,
      // skip when no new frame is queued — saves the GPU sync cost on a
      // 30 fps camera with a 60 fps engine. On the first call we ALWAYS
      // upload (sourceTexAllocated=false), regardless of rVFC; otherwise
      // headless / fake-device streams (which may never fire rVFC in
      // some Chromium builds) leave the texture empty forever and
      // downstream OUTPUT renders a black canvas.
      if (rvfcSupported && !frameDirty && sourceTexAllocated) return true;
      frameDirty = false;

      const tex = ensureSourceTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      try {
        if (!sourceTexAllocated) {
          gl.texImage2D(
            gl.TEXTURE_2D, 0, gl.RGBA,
            gl.RGBA, gl.UNSIGNED_BYTE,
            videoEl,
          );
          sourceTexAllocated = true;
        } else {
          // texSubImage2D after the first upload — same texture object,
          // no re-allocation. ~30% cheaper end-to-end on commodity GPUs.
          gl.texSubImage2D(
            gl.TEXTURE_2D, 0, 0, 0,
            gl.RGBA, gl.UNSIGNED_BYTE,
            videoEl,
          );
        }
      } catch (err) {
        // SecurityError can happen if COEP blocks the upload — surface
        // once via console; the OUTPUT will read as idle. Don't crash
        // the engine.
        console.error('[cameraInput] texImage2D failed:', err);
        return false;
      } finally {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      }
      return true;
    }

    const surface: VideoNodeSurface = {
      fbo,
      texture: outTexture,
      draw(frame) {
        const g = frame.gl;
        const uploaded = uploadIfReady();
        const hasInput = params.enabled > 0.5 && uploaded;

        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        g.uniform1f(uHasInput, hasInput ? 1.0 : 0.0);
        g.uniform1f(uGain,     params.gain);
        g.uniform1f(uMirror,   params.mirror);

        // Aspect-preserving fit into the live engine FBO (4:3 or 16:9). Per the
        // fillMode param: FILL/cover (default) crops the off-axis so a non-
        // matching webcam isn't stretched AND isn't letterboxed; LETTERBOX
        // shrinks to fit with black bars. Math adapts to ctx.res (so a 16:9
        // webcam cover-fills a 16:9 canvas edge-to-edge with no crop). Falls
        // back to (1,1) when dims are unknown (idle / pre-stream).
        const srcW = videoEl?.videoWidth ?? 0;
        const srcH = videoEl?.videoHeight ?? 0;
        const srcAspect = srcW > 0 && srcH > 0 ? srcW / srcH : ctx.res.width / ctx.res.height;
        const { sx, sy } = aspectFitScale(
          srcAspect,
          ctx.res.width / ctx.res.height,
          params.fillMode >= 0.5 ? 'fill' : 'letterbox',
        );
        g.uniform2f(uLetterbox, sx, sy);

        if (hasInput && sourceTexture) {
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, sourceTexture);
          g.uniform1i(uTex, 0);
        }

        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        detachRvfc();
        unwireKeepAlive();
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(outTexture);
        if (sourceTexture) gl.deleteTexture(sourceTexture);
        gl.deleteProgram(program);
        sourceTexture = null;
        sourceTexAllocated = false;
        videoEl = null;
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        if (paramId in params) {
          (params as unknown as Record<string, number>)[paramId] = value;
        }
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      attachExternalSource(kind, el) {
        if (kind !== 'video') return;
        // Clean up any previous element's rVFC subscription + keep-alive.
        detachRvfc();
        unwireKeepAlive();
        sourceTexAllocated = false; // re-alloc against the new dimensions
        videoEl = (el as HTMLVideoElement) ?? null;
        if (videoEl) {
          attachRvfc();
          // Keep the new element pulled so its decode runs at full rate even
          // when other video sources coexist on the rack.
          wireKeepAlive();
        }
      },
      read(key) {
        if (key === 'hasVideoElement') return videoEl !== null;
        if (key === 'hasKeepAlive') return keepAlive !== null;
        if (key === 'rvfcSupported') return rvfcSupported;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
