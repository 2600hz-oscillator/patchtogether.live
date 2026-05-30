// packages/web/src/lib/video/video-frame-upload.test.ts
//
// Unit coverage for the rVFC-driven, engine-resolution-downscaled frame
// uploader that fixes the few-FPS VIDEOBOX output regression. Vitest runs
// under node (no WebGL2 / no real OffscreenCanvas), so we inject fakes:
//   - a recording GL stub that counts texImage2D / texSubImage2D calls
//   - a fake OffscreenCanvas whose 2d ctx records drawImage size
//   - a fake <video> element with toggleable rVFC support + currentTime
//
// The behaviours we lock down are exactly the perf-relevant ones:
//   1. rVFC path: one upload per decoded frame, NOT per uploadIfReady() call.
//   2. Downscale: the frame is drawn to the engine-res canvas, and the GPU
//      upload source is that small canvas (texSubImage2D after first alloc).
//   3. Firefox fallback (no rVFC): gated on currentTime advancing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVideoFrameUploader } from './video-frame-upload';

const W = 640;
const H = 480;

// --- Fakes ---------------------------------------------------------------

function makeGl() {
  const calls = { texImage2D: 0, texSubImage2D: 0, deleteTexture: 0, createTexture: 0 };
  const gl = {
    TEXTURE_2D: 1, RGBA: 2, UNSIGNED_BYTE: 3, LINEAR: 4, CLAMP_TO_EDGE: 5,
    TEXTURE_MIN_FILTER: 6, TEXTURE_MAG_FILTER: 7, TEXTURE_WRAP_S: 8, TEXTURE_WRAP_T: 9,
    UNPACK_FLIP_Y_WEBGL: 10, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 11,
    createTexture: vi.fn(() => { calls.createTexture++; return {} as WebGLTexture; }),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    pixelStorei: vi.fn(),
    texImage2D: vi.fn(() => { calls.texImage2D++; }),
    texSubImage2D: vi.fn(() => { calls.texSubImage2D++; }),
    deleteTexture: vi.fn(() => { calls.deleteTexture++; }),
  };
  return { gl: gl as unknown as WebGL2RenderingContext, calls };
}

interface FakeVideo {
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  currentTime: number;
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
}

/** Build a fake <video>. If `withRvfc`, expose rVFC + return a fire() to
 *  simulate a decoded frame landing. */
function makeVideo(withRvfc: boolean) {
  let pending: (() => void) | null = null;
  const v: FakeVideo = {
    readyState: 2, // HAVE_CURRENT_DATA
    videoWidth: 1920,
    videoHeight: 1080,
    currentTime: 0,
  };
  if (withRvfc) {
    v.requestVideoFrameCallback = (cb: () => void) => { pending = cb; return 1; };
    v.cancelVideoFrameCallback = () => { pending = null; };
  }
  const fire = () => { const cb = pending; pending = null; cb?.(); };
  return { v: v as unknown as HTMLVideoElement, fire };
}

const drawSizes: Array<[number, number]> = [];

class FakeOffscreenCanvas {
  width: number;
  height: number;
  constructor(w: number, h: number) { this.width = w; this.height = h; }
  getContext() {
    return {
      drawImage: (_src: unknown, _x: number, _y: number, w: number, h: number) => {
        drawSizes.push([w, h]);
      },
    };
  }
}

beforeEach(() => {
  drawSizes.length = 0;
  (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas =
    FakeOffscreenCanvas as unknown;
});
afterEach(() => {
  delete (globalThis as unknown as { OffscreenCanvas?: unknown }).OffscreenCanvas;
});

// --- Tests ---------------------------------------------------------------

describe('createVideoFrameUploader — rVFC path', () => {
  it('uploads once per decoded frame, not once per uploadIfReady() call', () => {
    const { gl, calls } = makeGl();
    const up = createVideoFrameUploader({ gl, width: W, height: H });
    const { v, fire } = makeVideo(true);
    up.attach(v);
    expect(up.rvfcSupported).toBe(true);

    // First call always uploads (force first frame so texture is non-empty),
    // via texImage2D (allocate).
    expect(up.uploadIfReady()).toBe(true);
    expect(calls.texImage2D).toBe(1);
    expect(calls.texSubImage2D).toBe(0);
    expect(up.uploadCount).toBe(1);

    // Engine ticks at 60fps but no new decoded frame yet -> NO new upload.
    expect(up.uploadIfReady()).toBe(true);
    expect(up.uploadIfReady()).toBe(true);
    expect(up.uploadIfReady()).toBe(true);
    expect(up.uploadCount).toBe(1); // still 1 — the key perf property

    // A new decoded frame lands -> next tick uploads via texSubImage2D.
    fire();
    expect(up.uploadIfReady()).toBe(true);
    expect(up.uploadCount).toBe(2);
    expect(calls.texImage2D).toBe(1);   // still only the initial allocate
    expect(calls.texSubImage2D).toBe(1); // re-uses the texture, no re-spec
  });

  it('downscales the source to the engine resolution before upload', () => {
    const { gl } = makeGl();
    const up = createVideoFrameUploader({ gl, width: W, height: H });
    const { v } = makeVideo(true);
    up.attach(v);
    up.uploadIfReady();
    // Drew the 1920x1080 source into the 640x480 canvas (~6.75x less pixel data).
    expect(drawSizes[0]).toEqual([W, H]);
  });

  it('reports not-ready (idle) until the element has a decodable frame', () => {
    const { gl } = makeGl();
    const up = createVideoFrameUploader({ gl, width: W, height: H });
    const { v } = makeVideo(true);
    (v as unknown as FakeVideo).readyState = 1; // HAVE_METADATA, no frame
    up.attach(v);
    expect(up.uploadIfReady()).toBe(false);
    expect(up.uploadCount).toBe(0);
  });
});

describe('createVideoFrameUploader — Firefox fallback (no rVFC)', () => {
  it('uploads on first call, then only when currentTime advances', () => {
    const { gl, calls } = makeGl();
    const up = createVideoFrameUploader({ gl, width: W, height: H });
    const { v } = makeVideo(false);
    up.attach(v);
    expect(up.rvfcSupported).toBe(false);

    // First upload (allocate).
    expect(up.uploadIfReady()).toBe(true);
    expect(up.uploadCount).toBe(1);

    // Same currentTime (paused / engine faster than decode) -> skip.
    expect(up.uploadIfReady()).toBe(true);
    expect(up.uploadIfReady()).toBe(true);
    expect(up.uploadCount).toBe(1);

    // Advance currentTime (a new frame played) -> upload via texSubImage2D.
    (v as unknown as FakeVideo).currentTime = 0.04;
    expect(up.uploadIfReady()).toBe(true);
    expect(up.uploadCount).toBe(2);
    expect(calls.texSubImage2D).toBe(1);
  });
});

describe('createVideoFrameUploader — lifecycle', () => {
  it('dispose() deletes the GL texture and clears state', () => {
    const { gl, calls } = makeGl();
    const up = createVideoFrameUploader({ gl, width: W, height: H });
    const { v } = makeVideo(true);
    up.attach(v);
    up.uploadIfReady();
    expect(up.texture).not.toBeNull();
    up.dispose();
    expect(calls.deleteTexture).toBe(1);
    expect(up.texture).toBeNull();
  });

  it('re-attaching a new element forces a fresh first upload', () => {
    const { gl } = makeGl();
    const up = createVideoFrameUploader({ gl, width: W, height: H });
    const a = makeVideo(true);
    up.attach(a.v);
    up.uploadIfReady();
    expect(up.uploadCount).toBe(1);

    const b = makeVideo(true);
    up.attach(b.v);
    // New element -> first uploadIfReady() uploads even without an rVFC fire.
    expect(up.uploadIfReady()).toBe(true);
    expect(up.uploadCount).toBe(2);
  });
});
