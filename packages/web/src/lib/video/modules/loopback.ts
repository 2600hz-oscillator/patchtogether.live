// packages/web/src/lib/video/modules/loopback.ts
//
// LOOPBACK — the BROWSER VIEWPORT as a video source. Zero inputs, one video
// output whose contents are what the user currently SEES in this tab (the
// visible SvelteFlow pane), so you can feed LOOPBACK → RECORDERBOX to record
// the viewport, or → any video effect for live self-referential feedback.
//
// ── Mechanism (the single technical decision) ────────────────────────────────
// The card acquires a current-tab MediaStream via the Screen Capture API
// (`getDisplayMedia({ video: { displaySurface: 'browser' }, preferCurrentTab,
// selfBrowserSurface: 'include' })`, see viewport-acquire.ts), attaches a hidden
// <video> element to this runtime via `attachExternalSource('video', el)`, and
// the engine uploads that element into a GPU texture each frame — EXACTLY like
// CAMERA (camera-input.ts). The only difference from CAMERA is the source is the
// tab, and a CROP step windows the captured tab frame down to the app viewport
// element's on-screen rectangle so the OUT is "just the active viewport", not
// the surrounding browser/app chrome.
//
// The crop is a pure sub-rectangle sample in the shader: the card measures the
// viewport element's getBoundingClientRect each frame, converts it to GL
// sample-space UV bounds (loopback-crop.ts computeCropUv — resolution-
// independent, vertical-flip baked in for the UNPACK_FLIP_Y upload), and pushes
// the four bounds to this runtime via the private `_cropU0/_cropU1/_cropV0/
// _cropV1` setParam channel (per-viewer LOCAL state — each collaborator's
// viewport differs, so it must NOT sync through the Y.Doc param path). The
// cropped region is then aspect-fit (LETTERBOX/contain) into the engine FBO so
// the WHOLE viewport is preserved with black bars rather than cropping edges
// away — the correct semantic for "record what I see".
//
// The factory stays DOM-lean (it holds the card's <video>, tolerating null like
// CAMERA) so jsdom unit tests exercise the def shape without a MediaStream shim;
// the full GL + getDisplayMedia path is covered by e2e/tests/loopback.spec.ts
// via a deterministic synthetic-frame seam (no real display prompt in CI).
//
// Inputs:  none (a pure source).
// Outputs: out (video) — the cropped, letterboxed, gain-multiplied viewport.
// Params:  gain (linear 0..2) — RGB output gain; crop (discrete 0/1) —
//          crop-to-viewport vs whole-tab.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { createVideoAudioKeepAlive, type VideoAudioKeepAlive } from '$lib/video/video-audio-keepalive';
import { aspectFitScale } from '$lib/video/video-res';
import { cropRegionAspect, FULL_FRAME_CROP, type CropUv } from '$lib/video/loopback-crop';

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;   // 0 = idle pattern, 1 = sample texture
uniform float uGain;       // post-multiplier on RGB
uniform vec4  uCrop;       // (u0, v0, u1, v1) — sample-space crop sub-rect
uniform vec2  uFit;        // (sx, sy) letterbox (contain) scale, <= 1

void main() {
  if (uHasInput < 0.5) {
    // Idle: a dark TEAL vertical sweep (distinct hue from CAMERA's navy +
    // RECORDERBOX's crimson) so an un-started LOOPBACK card reads as "alive,
    // nothing captured yet" rather than a broken black frame.
    outColor = vec4(0.03, 0.08, 0.10, 1.0) + vUv.y * vec4(0.02, 0.05, 0.10, 0.0);
    return;
  }
  // Letterbox-fit the CROPPED region into the FBO without stretching. uFit <= 1
  // shrinks the sampled span so the off-axis falls outside [0,1] → black bars
  // (the whole viewport is preserved; nothing is cropped away by the fit).
  vec2 centered = (vUv - 0.5) / uFit + 0.5;
  if (any(lessThan(centered, vec2(0.0))) || any(greaterThan(centered, vec2(1.0)))) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  // Window the fitted UV into the crop sub-rectangle (uCrop.xy = min, .zw = max).
  vec2 uv = mix(uCrop.xy, uCrop.zw, centered);
  vec4 src = texture(uTex, uv);
  outColor = vec4(src.rgb * uGain, 1.0);
}`;

// ── Test-only deterministic frame seam ──────────────────────────────────────
// When `globalThis.__loopbackTestFrame` is truthy, the module uploads a fixed
// synthetic frame instead of the live tab <video>, and derives its crop purely
// from the `crop` PARAM (on → a fixed sub-quadrant, off → whole frame) with NO
// dependency on the card's per-frame getBoundingClientRect pushes. This lets the
// e2e exercise the FULL upload → crop → letterbox → gain path DETERMINISTICALLY
// with no getDisplayMedia prompt (ungrantable in headless CI) and no card rAF.
// Parallels CAMERA's __camerainputTestFrame seam. Default-undefined → zero
// production or unit-test impact.
const TEST_FRAME_W = 64;
const TEST_FRAME_H = 48;
// A fixed sub-quadrant (bottom-left, sample space) so crop-on vs crop-off yields
// a clearly different mean under the gradient frame below — the crop-toggle e2e
// asserts that difference (renderer-tolerant).
const TEST_CROP: CropUv = { u0: 0, u1: 0.5, v0: 0, v1: 0.5 };
let testFramePixels: Uint8Array | null = null;

function testFrameEnabled(): boolean {
  return !!(globalThis as { __loopbackTestFrame?: unknown }).__loopbackTestFrame;
}

function buildTestFrame(): Uint8Array {
  if (testFramePixels) return testFramePixels;
  const px = new Uint8Array(TEST_FRAME_W * TEST_FRAME_H * 4);
  // A 2D gradient (R rises left→right, G rises bottom→top) gives a strong
  // spatial MEAN gradient so any sub-rect crop differs from the full frame; an
  // 8×8 checker overlay adds high-frequency variance so the structured-content
  // floor is cleared for both the full frame AND a cropped sub-region.
  for (let y = 0; y < TEST_FRAME_H; y++) {
    for (let x = 0; x < TEST_FRAME_W; x++) {
      const i = (y * TEST_FRAME_W + x) * 4;
      const r = Math.round((x / (TEST_FRAME_W - 1)) * 255);
      const g = Math.round((y / (TEST_FRAME_H - 1)) * 255);
      const checker = (((x >> 3) ^ (y >> 3)) & 1) ? 40 : -40;
      px[i] = Math.max(0, Math.min(255, r + checker));
      px[i + 1] = Math.max(0, Math.min(255, g + checker));
      px[i + 2] = 128;
      px[i + 3] = 255;
    }
  }
  testFramePixels = px;
  return px;
}

interface LoopbackParams {
  gain: number;
  crop: number; // 0 = whole tab, 1 = crop to viewport
}

const DEFAULTS: LoopbackParams = {
  gain: 1.0,
  crop: 1, // crop-to-viewport by default — "just what I see"
};

export const loopbackDef: VideoModuleDef = {
  type: 'loopback',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'loopback',
  category: 'sources',
  inputs: [],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'gain', label: 'Gain', defaultValue: DEFAULTS.gain, min: 0, max: 2, curve: 'linear' },
    { id: 'crop', label: 'Crop', defaultValue: DEFAULTS.crop, min: 0, max: 1, curve: 'discrete' },
  ],
  // One capture per tab is the sane default: multiple getDisplayMedia streams of
  // the same tab multiply the recursive-preview cost for no benefit.
  maxInstances: 2,

  // docs-hash-ignore:start
  docs: {
    explanation: "LOOPBACK turns the BROWSER VIEWPORT into a video source: its single output carries what you currently SEE in this tab — the visible canvas pane — so you can feed it into RECORDERBOX to record your viewport, or into any video effect for live self-referential feedback. The card acquires the current tab with the Screen Capture API (getDisplayMedia with preferCurrentTab + self-capture allowed — the Start capture button is the required user gesture), runs the captured tab in a hidden <video>, and the engine samples each frame into a GPU texture (exactly like CAMERA). A crop step then windows that tab frame down to the app viewport element's on-screen rectangle so the output is just the active viewport, not the surrounding browser/app chrome; the cropped region is letterbox-fit into the engine frame (black bars rather than cropping edges away) so the WHOLE viewport is preserved. Because the preview shows the tab it is captured from, a live on-card preview is intentionally recursive (a video-feedback tunnel) — that is expected, not a bug. Usage: drop LOOPBACK in, click Start capture and confirm the tab in the picker, then patch OUT into RECORDERBOX (record the viewport) or a mixer/effect. Capture needs a gesture and can be stopped from the browser's share bar (the card returns to idle with a re-capture button); where the Screen Capture API is unavailable the card shows a disabled unsupported state.",
    inputs: {},
    outputs: {
      out: "Video output carrying the captured browser viewport: cropped to the visible pane (or the whole tab when Crop is off), letterbox-fit into the engine frame, and RGB gain-multiplied. Patch into RECORDERBOX to record the viewport, or into any downstream video module.",
    },
    controls: {
      gain: "Gain (linear, 0 to 2, default 1). RGB multiplier applied to the captured frame in the shader (src.rgb * gain, unclamped): 0 = black, 1 = unity, 2 = doubled/clipped. Handy to brighten a dim viewport before recording.",
      crop: "Crop (discrete 0/1, default 1 = on). ON crops the captured tab down to the visible canvas pane's on-screen rectangle (measured per frame from the viewport element), so OUT is just the active viewport; OFF passes the WHOLE captured tab. The crop is per-viewer local render state (each collaborator's viewport differs) and never distorts the source aspect — it letterbox-fits, preserving the full region.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, _node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTex      = gl.getUniformLocation(program, 'uTex');
    const uHasInput = gl.getUniformLocation(program, 'uHasInput');
    const uGain     = gl.getUniformLocation(program, 'uGain');
    const uCrop     = gl.getUniformLocation(program, 'uCrop');
    const uFit      = gl.getUniformLocation(program, 'uFit');

    const { fbo, texture: outTexture } = ctx.createFbo();

    let sourceTexture: WebGLTexture | null = null;
    let sourceTexAllocated = false;

    // The card-owned capture <video> element. Null until the card mounts +
    // acquires a stream.
    let videoEl: HTMLVideoElement | null = null;

    // Fresh-frame flag driven by requestVideoFrameCallback where available.
    let frameDirty = false;
    let rvfcId: number | null = null;
    let rvfcSupported = false;

    // Silent decode keep-alive so the capture <video> decodes at full rate even
    // when other video sources coexist (Chromium throttles offscreen elements
    // whose audio isn't pulled). Same pattern as CAMERA / VIDEOBOX.
    let keepAlive: VideoAudioKeepAlive | null = null;

    // Per-viewer LOCAL crop bounds, pushed each frame by the card via the
    // private `_crop*` setParam channel (NOT synced params). Default full-frame.
    const cropUv: CropUv = { ...FULL_FRAME_CROP };

    const params: LoopbackParams = { ...DEFAULTS };

    function wireKeepAlive(): void {
      if (keepAlive) return;
      if (!ctx.audioCtx || !videoEl) return;
      try {
        keepAlive = createVideoAudioKeepAlive(ctx.audioCtx, videoEl);
      } catch (err) {
        console.warn('[loopback] keep-alive wire failed:', err);
      }
    }

    function unwireKeepAlive(): void {
      if (keepAlive) keepAlive.disconnect();
      keepAlive = null;
    }

    function attachRvfc(): void {
      if (!videoEl) return;
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
      if (!tex) throw new Error('loopback: createTexture failed');
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      sourceTexture = tex;
      return tex;
    }

    /** Upload one frame from `videoEl` (or the synthetic test frame) into the
     *  source texture. Returns true when a fresh frame is present. */
    function uploadIfReady(): boolean {
      if (testFrameEnabled()) {
        const tex = ensureSourceTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        if (!sourceTexAllocated) {
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
          gl.texImage2D(
            gl.TEXTURE_2D, 0, gl.RGBA,
            TEST_FRAME_W, TEST_FRAME_H, 0,
            gl.RGBA, gl.UNSIGNED_BYTE,
            buildTestFrame(),
          );
          sourceTexAllocated = true;
        }
        return true;
      }
      if (!videoEl) return false;
      if (videoEl.readyState < 2) return false; // HAVE_CURRENT_DATA
      if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) return false;

      if (rvfcSupported && !frameDirty && sourceTexAllocated) return true;
      frameDirty = false;

      const tex = ensureSourceTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      try {
        if (!sourceTexAllocated) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoEl);
          sourceTexAllocated = true;
        } else {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, videoEl);
        }
      } catch (err) {
        console.error('[loopback] texImage2D failed:', err);
        return false;
      } finally {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      }
      return true;
    }

    /** The crop sub-rect + its source pixel dims for THIS draw. In the test
     *  seam the crop is derived from the `crop` PARAM (deterministic, card-
     *  independent); in production it is the card-pushed `cropUv`. */
    function effectiveCrop(): { crop: CropUv; srcW: number; srcH: number } {
      if (testFrameEnabled()) {
        const crop = params.crop >= 0.5 ? TEST_CROP : FULL_FRAME_CROP;
        return { crop, srcW: TEST_FRAME_W, srcH: TEST_FRAME_H };
      }
      return {
        crop: cropUv,
        srcW: videoEl?.videoWidth ?? 0,
        srcH: videoEl?.videoHeight ?? 0,
      };
    }

    const surface: VideoNodeSurface = {
      fbo,
      texture: outTexture,
      draw(frame) {
        const g = frame.gl;
        const hasInput = uploadIfReady();

        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        g.uniform1f(uHasInput, hasInput ? 1.0 : 0.0);
        g.uniform1f(uGain, params.gain);

        const { crop, srcW, srcH } = effectiveCrop();
        g.uniform4f(uCrop, crop.u0, crop.v0, crop.u1, crop.v1);

        // Letterbox-fit the cropped region's aspect into the engine FBO.
        const fboAspect = ctx.res.width / ctx.res.height;
        const cropAspect = cropRegionAspect(crop, srcW, srcH, fboAspect);
        const { sx, sy } = aspectFitScale(cropAspect, fboAspect, 'letterbox');
        g.uniform2f(uFit, sx, sy);

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
        // Private per-viewer crop channel (NOT declared params → never synced;
        // the card pushes these each frame from the viewport element's rect).
        switch (paramId) {
          case '_cropU0': cropUv.u0 = value; return;
          case '_cropU1': cropUv.u1 = value; return;
          case '_cropV0': cropUv.v0 = value; return;
          case '_cropV1': cropUv.v1 = value; return;
        }
        if (paramId in params) {
          (params as unknown as Record<string, number>)[paramId] = value;
        }
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      attachExternalSource(kind, el) {
        if (kind !== 'video') return;
        detachRvfc();
        unwireKeepAlive();
        sourceTexAllocated = false;
        videoEl = (el as HTMLVideoElement) ?? null;
        if (videoEl) {
          attachRvfc();
          wireKeepAlive();
        }
      },
      read(key) {
        if (key === 'hasVideoElement') return videoEl !== null;
        if (key === 'hasKeepAlive') return keepAlive !== null;
        if (key === 'rvfcSupported') return rvfcSupported;
        if (key === 'cropUv') return { ...cropUv };
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
