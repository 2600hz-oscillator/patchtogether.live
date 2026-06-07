// packages/web/src/lib/video/video-frame-upload.ts
//
// Shared <video> -> GL-texture upload pump for the file/stream source
// modules (VIDEOBOX today; CAMERA / VideoVarispeed are candidates to adopt
// it next). It exists to fix the few-FPS VIDEOBOX output regression whose
// root cause was uploading a full-resolution decoded frame to the `out`
// texture on EVERY engine rAF tick (~60/sec), re-speccing the whole texture
// each call. For a 1080p clip that's ~8 MB/frame x 60 fps ~= 480 MB/s of
// GPU texture traffic, which collapses to a few FPS downstream.
//
// Two independent wins, both implemented here:
//
//  1. rVFC-driven cadence. We subscribe to the <video> element's own
//     `requestVideoFrameCallback` (rVFC) — its decode cadence (~24-30 fps for
//     a typical clip) — and only re-upload when a genuinely new decoded
//     frame has landed. The engine's draw() still runs at 60 fps but simply
//     binds the already-uploaded texture; the expensive upload happens at
//     decode rate, not render rate. Firefox lacks rVFC, so we fall back to a
//     per-tick check gated on `currentTime` advancing (don't re-upload an
//     unchanged frame).
//
//  2. Downscale to engine resolution. The whole video pipeline runs at a
//     fixed VIDEO_RES (1024x768) — every module FBO is that size and the
//     `out` texture is consumed at engine res downstream. Uploading a
//     1920x1080 frame just to have the GPU minify it during the fullscreen
//     quad is pure waste. We draw the decoded frame into an OffscreenCanvas
//     sized to the engine resolution once per new frame and upload THAT
//     (less pixel data for 1080p -> 1024x768). As a side benefit the
//     upload source becomes a <canvas>, which tolerates texSubImage2D in
//     this WebGL2 context (the <video> source is what raised
//     GL_INVALID_OPERATION in PR #288), so after the first allocate we use
//     texSubImage2D — same texture object, no re-spec.
//
// The helper is DOM-light: it only touches the <video> element it's handed
// and an OffscreenCanvas it owns. No engine internals beyond the GL context
// + target dimensions.

/** Minimal shape of the rVFC API (not yet in this codebase's lib.dom). */
interface VideoFrameCallbackCapable {
  requestVideoFrameCallback?: (cb: (now: number, meta: unknown) => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
}

export interface VideoFrameUploaderOpts {
  gl: WebGL2RenderingContext;
  /** Target (engine) width the source frame is downscaled to before upload. */
  width: number;
  /** Target (engine) height the source frame is downscaled to before upload. */
  height: number;
}

/**
 * Owns one GL texture + a downscale OffscreenCanvas and pumps frames from a
 * <video> element into the texture at the element's decode cadence.
 *
 * Lifecycle:
 *   const up = createVideoFrameUploader({ gl, width, height });
 *   up.attach(videoEl);          // subscribe to rVFC (or arm the fallback)
 *   ... each engine draw():  if (up.uploadIfReady()) bind(up.texture);
 *   up.detach();                 // on element swap
 *   up.dispose();                // on module teardown
 */
export interface VideoFrameUploader {
  /** The GL texture frames are uploaded into. Null until the first upload
   *  allocates it (so a never-started stream reserves no GPU memory). */
  readonly texture: WebGLTexture | null;
  /** True when the running browser exposes requestVideoFrameCallback. */
  readonly rvfcSupported: boolean;
  /** Total number of GPU texture uploads performed (instrumentation). */
  readonly uploadCount: number;
  /** Bind a <video> element + start tracking new decoded frames. Replaces
   *  any previously attached element. */
  attach(videoEl: HTMLVideoElement): void;
  /** Stop tracking the current element (cancels the rVFC subscription). */
  detach(): void;
  /** Upload the latest decoded frame if a new one is available. Returns true
   *  when there's a valid frame in the texture to sample (whether or not
   *  THIS call uploaded), false when the element isn't ready (-> idle). */
  uploadIfReady(): boolean;
  /** Free the GL texture + drop references. Call from module dispose(). */
  dispose(): void;
}

export function createVideoFrameUploader(
  opts: VideoFrameUploaderOpts,
): VideoFrameUploader {
  const { gl, width, height } = opts;

  let videoEl: HTMLVideoElement | null = null;
  let texture: WebGLTexture | null = null;
  let texAllocated = false;
  let uploadCount = 0;

  // rVFC bookkeeping. `frameDirty` flips true on every new decoded frame.
  let frameDirty = false;
  let rvfcId: number | null = null;
  let rvfcSupported = false;

  // Firefox fallback: track the last currentTime we uploaded so we can skip
  // re-uploading an unchanged frame when rVFC is unavailable.
  let lastUploadedTime = -1;

  // Downscale surface — engine-resolution OffscreenCanvas the decoded frame
  // is drawn into before upload. Lazily created so a module that never gets
  // a stream allocates nothing.
  let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  let canvas2d:
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null = null;

  function ensureCanvas(): boolean {
    if (canvas2d) return true;
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(width, height);
      const ctx = c.getContext('2d');
      if (!ctx) return false;
      canvas = c;
      canvas2d = ctx;
      return true;
    }
    // No OffscreenCanvas (very old runtime / certain jsdom). Fall back to a
    // DOM canvas if a document exists; otherwise we can't downscale.
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      const ctx = c.getContext('2d');
      if (!ctx) return false;
      canvas = c;
      canvas2d = ctx;
      return true;
    }
    return false;
  }

  function ensureTexture(): WebGLTexture {
    if (texture) return texture;
    const tex = gl.createTexture();
    if (!tex) throw new Error('VideoFrameUploader: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    texture = tex;
    return tex;
  }

  function attachRvfc(): void {
    if (!videoEl) return;
    const v = videoEl as unknown as VideoFrameCallbackCapable;
    if (typeof v.requestVideoFrameCallback !== 'function') {
      rvfcSupported = false;
      return;
    }
    rvfcSupported = true;
    const tick = (): void => {
      frameDirty = true;
      if (videoEl) {
        const vv = videoEl as unknown as VideoFrameCallbackCapable;
        rvfcId = vv.requestVideoFrameCallback!(tick);
      }
    };
    rvfcId = v.requestVideoFrameCallback(tick);
  }

  function detachRvfc(): void {
    if (rvfcId === null || !videoEl) {
      rvfcId = null;
      return;
    }
    const v = videoEl as unknown as VideoFrameCallbackCapable;
    if (typeof v.cancelVideoFrameCallback === 'function') {
      v.cancelVideoFrameCallback(rvfcId);
    }
    rvfcId = null;
  }

  return {
    get texture(): WebGLTexture | null {
      return texture;
    },
    get rvfcSupported(): boolean {
      return rvfcSupported;
    },
    get uploadCount(): number {
      return uploadCount;
    },

    attach(el: HTMLVideoElement): void {
      detachRvfc();
      videoEl = el ?? null;
      // New element -> its frame dimensions / decode timeline are fresh.
      // Force a first upload regardless of rVFC so a stream that never fires
      // rVFC (some headless Chromium builds, fake-device streams) still
      // shows SOMETHING instead of an empty texture.
      frameDirty = true;
      lastUploadedTime = -1;
      rvfcSupported = false;
      if (videoEl) attachRvfc();
    },

    detach(): void {
      detachRvfc();
      videoEl = null;
    },

    uploadIfReady(): boolean {
      if (!videoEl) return false;
      if (videoEl.readyState < 2) return false; // HAVE_CURRENT_DATA
      if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) return false;

      // Decide whether a NEW frame is available since our last upload.
      //  - rVFC path: trust `frameDirty` (set by the decode callback), but
      //    always upload the very first frame so the texture is non-empty.
      //  - fallback path: a frame is "new" when currentTime advanced (or it's
      //    the first upload). This is coarser than rVFC but never re-uploads
      //    an unchanged paused frame at 60 fps.
      let isNewFrame: boolean;
      if (rvfcSupported) {
        isNewFrame = frameDirty || !texAllocated;
      } else {
        isNewFrame = !texAllocated || videoEl.currentTime !== lastUploadedTime;
      }
      // No new frame -> keep the existing texture. Report ready iff we've
      // ever uploaded one (otherwise there's nothing valid to sample).
      if (!isNewFrame) return texAllocated;

      if (!ensureCanvas() || !canvas2d || !canvas) {
        // Can't downscale (no canvas surface). Bail to idle rather than
        // re-introducing the full-res per-frame texImage2D(<video>) path.
        return texAllocated;
      }

      // Downscale the decoded frame into the engine-resolution canvas. The
      // video frame is drawn flipped here? No — we keep the canvas the same
      // orientation as the source and use UNPACK_FLIP_Y_WEBGL on upload, so
      // the shader's top-left-origin sampling stays upright (#282).
      try {
        canvas2d.drawImage(videoEl, 0, 0, width, height);
      } catch (err) {
        // drawImage can throw if the element briefly has no current frame
        // (mid-seek). Skip this tick; keep the last good texture.
        console.warn('[videobox/upload] drawImage failed:', err);
        return texAllocated;
      }

      const tex = ensureTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      try {
        if (!texAllocated) {
          gl.texImage2D(
            gl.TEXTURE_2D, 0, gl.RGBA,
            gl.RGBA, gl.UNSIGNED_BYTE,
            canvas as TexImageSource,
          );
          texAllocated = true;
        } else {
          // Upload source is a <canvas> at a FIXED size, so texSubImage2D is
          // valid here (no re-spec) — unlike the <video> source that raised
          // GL_INVALID_OPERATION in PR #288.
          gl.texSubImage2D(
            gl.TEXTURE_2D, 0, 0, 0,
            gl.RGBA, gl.UNSIGNED_BYTE,
            canvas as TexImageSource,
          );
        }
        uploadCount++;
        frameDirty = false;
        lastUploadedTime = videoEl.currentTime;
      } catch (err) {
        console.warn('[videobox/upload] texture upload failed:', err);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        return texAllocated;
      }
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      return true;
    },

    dispose(): void {
      detachRvfc();
      videoEl = null;
      if (texture) {
        gl.deleteTexture(texture);
        texture = null;
      }
      texAllocated = false;
      canvas = null;
      canvas2d = null;
    },
  };
}
