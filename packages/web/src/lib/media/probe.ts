// packages/web/src/lib/media/probe.ts
//
// Default async metadata probes for library items — browser-only (they build
// detached <video>/<audio>/<img> elements), called lazily per item so this
// module stays import-safe under node/vitest. The library takes a probe as an
// injectable option, so unit tests never reach this file's DOM code.
//
//   video → duration (s) + intrinsic dimensions
//   image → intrinsic dimensions
//   audio → duration (s)
//
// A probe failure REJECTS (the library marks the item 'failed' but keeps it —
// the browser may still be able to play what it couldn't describe).

import type { MediaKind } from './ingest';

export interface ProbedMeta {
  /** Playback length in seconds (video/audio). */
  durationS?: number;
  /** Intrinsic pixel dimensions (video/image). */
  width?: number;
  height?: number;
  /** Captured poster-frame object URL (video only; the Loaded Assets
   *  Picker's hover thumbnail). OWNED BY THE LIBRARY like item.objectUrl —
   *  revoked on remove/clear; consumers must not revoke it. Absent when
   *  the capture failed (a poster is best-effort, never a probe failure). */
  posterUrl?: string;
}

/** Probes that never settle would pin items at 'probing' forever — bound them. */
const PROBE_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${what} metadata probe timed out`)),
      PROBE_TIMEOUT_MS,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function probeImage(objectUrl: string): Promise<ProbedMeta> {
  return new Promise<ProbedMeta>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('image failed to decode'));
    img.src = objectUrl;
  });
}

// ---------------------------------------------------------------------------
// Poster-frame capture (video hover thumbnails)
// ---------------------------------------------------------------------------

/** Structural surface of the <video> element the capture needs — real
 *  elements satisfy it; unit tests drive fakes (jsdom can't decode video). */
export interface PosterVideoLike {
  videoWidth: number;
  videoHeight: number;
  duration: number;
  currentTime: number;
  addEventListener(type: string, cb: () => void, opts?: { once?: boolean }): void;
  removeEventListener(type: string, cb: () => void): void;
}

export interface PosterCanvasLike {
  width: number;
  height: number;
  getContext(id: '2d'): {
    drawImage(el: unknown, x: number, y: number, w: number, h: number): void;
  } | null;
  toBlob(cb: (blob: Blob | null) => void, type?: string, quality?: number): void;
}

export interface PosterCaptureOptions {
  /** Canvas factory — defaults to document.createElement('canvas'). */
  createCanvas?: (w: number, h: number) => PosterCanvasLike;
  /** Object-URL factory — defaults to URL.createObjectURL. */
  createObjectUrl?: (blob: Blob) => string;
  /** Seek-settle timeout (ms). */
  timeoutMs?: number;
}

/** Poster frames render as small hover thumbnails — cap the long edge so a
 *  4K clip doesn't pin a full-resolution JPEG per library item. */
const POSTER_MAX_EDGE = 320;
/** Seek a beat into the clip (many clips fade in from black at t=0), but
 *  never past the media (short clips clamp to a quarter of the duration). */
const POSTER_SEEK_S = 0.25;

/**
 * Capture one frame of an already-metadata-loaded video element as a JPEG
 * object URL. Resolves null (never rejects) when the frame can't be
 * captured — a poster is decoration, not a probe outcome.
 */
export function capturePosterFrame(
  el: PosterVideoLike,
  opts: PosterCaptureOptions = {},
): Promise<string | null> {
  const createCanvas =
    opts.createCanvas ??
    ((w: number, h: number) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c as unknown as PosterCanvasLike;
    });
  const createObjectUrl = opts.createObjectUrl ?? ((b: Blob) => URL.createObjectURL(b));
  const timeoutMs = opts.timeoutMs ?? 5000;

  if (!(el.videoWidth > 0) || !(el.videoHeight > 0)) return Promise.resolve(null);
  const scale = Math.min(1, POSTER_MAX_EDGE / Math.max(el.videoWidth, el.videoHeight));
  const w = Math.max(1, Math.round(el.videoWidth * scale));
  const h = Math.max(1, Math.round(el.videoHeight * scale));

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (url: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeEventListener('seeked', onSeeked);
      resolve(url);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const draw = () => {
      try {
        const canvas = createCanvas(w, h);
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          finish(null);
          return;
        }
        ctx.drawImage(el, 0, 0, w, h);
        canvas.toBlob((blob) => finish(blob ? createObjectUrl(blob) : null), 'image/jpeg', 0.7);
      } catch {
        finish(null);
      }
    };
    const onSeeked = () => draw();
    const target = Number.isFinite(el.duration)
      ? Math.min(POSTER_SEEK_S, el.duration / 4)
      : 0;
    if (target > 0) {
      el.addEventListener('seeked', onSeeked, { once: true });
      try {
        el.currentTime = target;
      } catch {
        el.removeEventListener('seeked', onSeeked);
        draw();
      }
    } else {
      // Live/zero-length metadata — draw whatever frame is current.
      draw();
    }
  });
}

function probeAv(tag: 'video' | 'audio', objectUrl: string): Promise<ProbedMeta> {
  const startedAt = Date.now();
  return new Promise<ProbedMeta>((resolve, reject) => {
    const el = document.createElement(tag);
    const cleanup = () => {
      // Detach the object URL so the element releases its decoder/network
      // handle (the URL itself stays alive — the library owns revocation).
      el.removeAttribute('src');
      el.load();
    };
    el.preload = 'metadata';
    el.muted = true;
    el.onloadedmetadata = () => {
      const meta: ProbedMeta = { durationS: el.duration };
      if (tag === 'video') {
        const v = el as HTMLVideoElement;
        meta.width = v.videoWidth;
        meta.height = v.videoHeight;
        // Poster capture is BEST-EFFORT: success attaches posterUrl, any
        // failure still resolves the metadata (never rejects the probe).
        // Bounded to the REMAINING withTimeout budget: if the capture
        // could settle after the outer probe timeout already rejected,
        // a minted poster URL would be orphaned (nobody would ever
        // revoke it) — so with too little budget left we skip capture.
        const remainingMs = PROBE_TIMEOUT_MS - (Date.now() - startedAt) - 500;
        if (remainingMs < 250) {
          cleanup();
          resolve(meta);
          return;
        }
        void capturePosterFrame(v, { timeoutMs: remainingMs }).then((posterUrl) => {
          cleanup();
          if (posterUrl) meta.posterUrl = posterUrl;
          resolve(meta);
        });
        return;
      }
      cleanup();
      resolve(meta);
    };
    el.onerror = () => {
      cleanup();
      reject(new Error(`${tag} metadata failed to load`));
    };
    el.src = objectUrl;
  });
}

/** The default probe the media library wires up (see library.svelte.ts). */
export function probeMedia(kind: MediaKind, objectUrl: string): Promise<ProbedMeta> {
  switch (kind) {
    case 'image':
      return withTimeout(probeImage(objectUrl), 'image');
    case 'video':
      return withTimeout(probeAv('video', objectUrl), 'video');
    case 'audio':
      return withTimeout(probeAv('audio', objectUrl), 'audio');
  }
}
