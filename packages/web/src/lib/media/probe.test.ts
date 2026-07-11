// packages/web/src/lib/media/probe.test.ts
//
// Unit coverage for the poster-frame capture (the Loaded Assets Picker's
// video hover thumbnail). Vitest runs in NODE (no jsdom, no media
// decode), so the video element + canvas are structural fakes through
// capturePosterFrame's injectable seams — the real-decode path is
// exercised by the workflow-media e2e in a real browser.

import { describe, expect, it, vi } from 'vitest';
import {
  capturePosterFrame,
  type PosterCanvasLike,
  type PosterVideoLike,
} from './probe';

interface FakeVideoOpts {
  width?: number;
  height?: number;
  duration?: number;
  /** Fire 'seeked' when currentTime is set (the happy path). */
  seekWorks?: boolean;
}

function fakeVideo(opts: FakeVideoOpts = {}): PosterVideoLike & { seeks: number[] } {
  const listeners = new Map<string, Array<() => void>>();
  const el = {
    videoWidth: opts.width ?? 640,
    videoHeight: opts.height ?? 480,
    duration: opts.duration ?? 10,
    seeks: [] as number[],
    _currentTime: 0,
    get currentTime() {
      return this._currentTime;
    },
    set currentTime(t: number) {
      this._currentTime = t;
      this.seeks.push(t);
      if (opts.seekWorks !== false) {
        // Fire like the real event loop would — asynchronously.
        queueMicrotask(() => {
          for (const cb of listeners.get('seeked') ?? []) cb();
        });
      }
    },
    addEventListener(type: string, cb: () => void) {
      const arr = listeners.get(type) ?? [];
      arr.push(cb);
      listeners.set(type, arr);
    },
    removeEventListener(type: string, cb: () => void) {
      const arr = listeners.get(type) ?? [];
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    },
  };
  return el as unknown as PosterVideoLike & { seeks: number[] };
}

function fakeCanvasFactory(blob: Blob | null = new Blob(['jpg'])) {
  const drawn: unknown[] = [];
  const sizes: Array<{ w: number; h: number }> = [];
  const createCanvas = (w: number, h: number): PosterCanvasLike => {
    sizes.push({ w, h });
    return {
      width: w,
      height: h,
      getContext: () => ({
        drawImage: (el: unknown) => {
          drawn.push(el);
        },
      }),
      toBlob: (cb: (b: Blob | null) => void) => cb(blob),
    };
  };
  return { createCanvas, drawn, sizes };
}

describe('capturePosterFrame', () => {
  it('seeks a beat in, draws the frame, and returns the blob object URL', async () => {
    const el = fakeVideo();
    const { createCanvas, drawn } = fakeCanvasFactory();
    const createObjectUrl = vi.fn(() => 'blob:poster/1');
    const url = await capturePosterFrame(el, { createCanvas, createObjectUrl });
    expect(url).toBe('blob:poster/1');
    expect(el.seeks).toEqual([0.25]);
    expect(drawn).toEqual([el]);
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
  });

  it('short clips clamp the seek to a quarter of the duration', async () => {
    const el = fakeVideo({ duration: 0.4 });
    const { createCanvas } = fakeCanvasFactory();
    await capturePosterFrame(el, { createCanvas, createObjectUrl: () => 'blob:p' });
    expect(el.seeks).toEqual([0.1]);
  });

  it('downscales the poster: the long edge is capped, aspect preserved', async () => {
    const el = fakeVideo({ width: 1920, height: 1080 });
    const { createCanvas, sizes } = fakeCanvasFactory();
    await capturePosterFrame(el, { createCanvas, createObjectUrl: () => 'blob:p' });
    expect(sizes[0]).toEqual({ w: 320, h: 180 });
  });

  it('resolves null for a video with no dimensions (never rejects)', async () => {
    const el = fakeVideo({ width: 0, height: 0 });
    const { createCanvas } = fakeCanvasFactory();
    await expect(
      capturePosterFrame(el, { createCanvas, createObjectUrl: () => 'blob:p' }),
    ).resolves.toBeNull();
  });

  it('resolves null when the canvas yields no blob', async () => {
    const el = fakeVideo();
    const { createCanvas } = fakeCanvasFactory(null);
    await expect(
      capturePosterFrame(el, { createCanvas, createObjectUrl: () => 'blob:p' }),
    ).resolves.toBeNull();
  });

  it('resolves null when the seek never settles (bounded, never hangs)', async () => {
    const el = fakeVideo({ seekWorks: false });
    const { createCanvas } = fakeCanvasFactory();
    await expect(
      capturePosterFrame(el, { createCanvas, createObjectUrl: () => 'blob:p', timeoutMs: 20 }),
    ).resolves.toBeNull();
  });
});
