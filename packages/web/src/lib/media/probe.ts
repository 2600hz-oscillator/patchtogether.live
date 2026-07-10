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

function probeAv(tag: 'video' | 'audio', objectUrl: string): Promise<ProbedMeta> {
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
