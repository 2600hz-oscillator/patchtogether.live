// packages/web/src/lib/audio/clip-audio-cache.ts
//
// LAZY DECODE for audio clips, behind a BYTE-CAPPED LRU.
//
// A launcher can hold 64 clips per player; decoding all of them at load would
// pin ~200 MB of AudioBuffers for takes that may never be launched. So decode
// happens at LAUNCH (or when a launch is queued — the warm-up), and the cache
// holds decoded buffers up to a byte ceiling, evicting least-recently-USED.
//
// ⚠ THE KEY IS (mediaId, takeAt), NOT mediaId ALONE. `takeAt` is the take's
// change signature (samsloop #1353: two takes of the same length at the same
// settings are otherwise identical in metadata, and a player keyed on the rest
// keeps playing the FIRST). Re-recording a slot replaces the clip record and
// its takeAt, so the stale buffer simply stops being asked for and ages out.
//
// ⚠ PCM IS NOT `decodeAudioData`. The studio/standard tiers are raw
// frame-addressable samples; building the AudioBuffer directly is a typed-array
// copy (milliseconds for a 3 MB take), keeps the FRAME COUNT exact (a lossy
// decoder's pre-skip/padding cannot creep in), and works against any
// BaseAudioContext. `opus` (the slice-8 compact tier) has no decode path here
// yet and reports null — a clip that cannot be decoded is a clip that does not
// sound, never one that half-sounds.
//
// ⚠ THE BUFFER IS BUILT AT THE RECORDED RATE (`rec.sampleRate`), never the
// live context's. An AudioBufferSourceNode resamples a mismatched buffer
// itself, so the take plays at its recorded PITCH on any context — the
// samsloop achievedRate lesson (tagging takes with a requested rate played
// −148 cents and 8.8 % long). The loop duration then differs from the live
// grid, which is the honest edge-26 behaviour.

import type { AudioClipRecord } from './modules/clip-types';
import { readClipMedia } from './clip-media-store';

/** Decoded-buffer ceiling. ~21 four-bar studio takes at 48 kHz; a full 8-lane
 *  live set fits with headroom, a whole 64-slot bank does not (by design). */
export const CLIP_AUDIO_CACHE_BYTES = 64_000_000;

/** The cache key — the take's identity, including its change signature. */
export function clipAudioCacheKey(rec: Pick<AudioClipRecord, 'mediaId' | 'takeAt'>): string {
  return `${rec.mediaId}:${rec.takeAt}`;
}

/** De-interleave stored PCM bytes into stereo channel data. PURE.
 *
 *  - `pcm-f32`: interleaved f32 [L0,R0,L1,R1,…] (stereo) or mono [S0,S1,…].
 *  - `pcm-i16`: same layout, i16 → /32768.
 *  - mono input is duplicated onto both legs (the dual-mono double-patch
 *    policy — never a "was it really stereo?" probe).
 *
 *  `frames` is clamped to what the bytes actually hold — after a crash the
 *  record can name more frames than reached the disk, and claiming them would
 *  loop garbage. */
export function pcmToChannelData(
  bytes: Uint8Array,
  format: 'pcm-f32' | 'pcm-i16',
  channels: 1 | 2,
  frames: number,
): { l: Float32Array<ArrayBuffer>; r: Float32Array<ArrayBuffer>; frames: number } {
  const bytesPerSample = format === 'pcm-f32' ? 4 : 2;
  const perFrame = bytesPerSample * channels;
  const onDisk = Math.floor(bytes.byteLength / perFrame);
  const n = Math.max(0, Math.min(Math.trunc(frames), onDisk));
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  if (n === 0) return { l, r, frames: 0 };
  // A view aligned to the payload — the Uint8Array may be offset into a
  // larger ArrayBuffer (File.arrayBuffer() is not, but the type allows it).
  if (format === 'pcm-f32') {
    const f = new Float32Array(bytes.buffer, bytes.byteOffset, n * channels);
    for (let i = 0; i < n; i++) {
      l[i] = f[i * channels] ?? 0;
      r[i] = f[i * channels + (channels - 1)] ?? 0;
    }
  } else {
    const s = new Int16Array(bytes.buffer, bytes.byteOffset, n * channels);
    for (let i = 0; i < n; i++) {
      l[i] = (s[i * channels] ?? 0) / 32768;
      r[i] = (s[i * channels + (channels - 1)] ?? 0) / 32768;
    }
  }
  return { l, r, frames: n };
}

interface CacheRow {
  buffer: AudioBuffer;
  bytes: number;
}

/** The byte-capped LRU. One instance per app (module singleton below); the
 *  class is exported so tests can build an isolated one, with the media
 *  reader injectable so eviction runs in node without OPFS. */
export class ClipAudioCache {
  /** Insertion order IS the recency order — Map re-insertion on hit. */
  #rows = new Map<string, CacheRow>();
  #bytes = 0;
  #cap: number;
  #readMedia: (mediaId: string) => Promise<Blob | null>;
  /** In-flight decodes, so a queued launch and the boundary launch of the
   *  same take share one read instead of racing two. */
  #inFlight = new Map<string, Promise<AudioBuffer | null>>();

  constructor(
    capBytes: number = CLIP_AUDIO_CACHE_BYTES,
    readMedia: (mediaId: string) => Promise<Blob | null> = readClipMedia,
  ) {
    this.#cap = capBytes;
    this.#readMedia = readMedia;
  }

  get bytes(): number {
    return this.#bytes;
  }
  get size(): number {
    return this.#rows.size;
  }

  /** The decoded buffer for a take, from cache or the media store. Null when
   *  the media is absent (a peer without the bytes — the named "media absent"
   *  state), the format has no decode path here, or nothing is playable. */
  getBuffer(ctx: BaseAudioContext, rec: AudioClipRecord): Promise<AudioBuffer | null> {
    const key = clipAudioCacheKey(rec);
    const hit = this.#rows.get(key);
    if (hit) {
      // Refresh recency.
      this.#rows.delete(key);
      this.#rows.set(key, hit);
      return Promise.resolve(hit.buffer);
    }
    const pending = this.#inFlight.get(key);
    if (pending) return pending;
    const p = this.#decode(ctx, rec, key).finally(() => {
      this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, p);
    return p;
  }

  async #decode(
    ctx: BaseAudioContext,
    rec: AudioClipRecord,
    key: string,
  ): Promise<AudioBuffer | null> {
    if (rec.format !== 'pcm-f32' && rec.format !== 'pcm-i16') return null; // opus = slice 8
    const file = await this.#readMedia(rec.mediaId);
    if (!file) return null; // media absent — a named state, not an error
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { l, r, frames } = pcmToChannelData(bytes, rec.format, rec.channels, rec.frames);
    if (frames < 1) return null;
    let buffer: AudioBuffer;
    try {
      buffer = ctx.createBuffer(2, frames, rec.sampleRate);
    } catch {
      return null; // a rate/length the engine refuses — nothing playable
    }
    buffer.copyToChannel(l, 0);
    buffer.copyToChannel(r, 1);
    this.#insert(key, { buffer, bytes: frames * 2 * 4 });
    return buffer;
  }

  #insert(key: string, row: CacheRow): void {
    const prior = this.#rows.get(key);
    if (prior) {
      this.#bytes -= prior.bytes;
      this.#rows.delete(key);
    }
    this.#rows.set(key, row);
    this.#bytes += row.bytes;
    // Evict oldest-used until under the cap — but never the row just added
    // (a single take larger than the cap still plays; the cache just holds
    // only it).
    for (const [k, v] of this.#rows) {
      if (this.#bytes <= this.#cap || k === key) {
        if (k === key) break;
        continue;
      }
      this.#rows.delete(k);
      this.#bytes -= v.bytes;
    }
  }

  /** Drop one take (a replaced slot frees its predecessor promptly). */
  evict(key: string): void {
    const row = this.#rows.get(key);
    if (!row) return;
    this.#rows.delete(key);
    this.#bytes -= row.bytes;
  }

  /** Tests + rack switches. */
  clear(): void {
    this.#rows.clear();
    this.#bytes = 0;
  }
}

/** The app-wide cache. */
export const clipAudioCache = new ClipAudioCache();

/** The playback path's one call: cached decode of a take against `ctx`. */
export function getClipAudioBuffer(
  ctx: BaseAudioContext,
  rec: AudioClipRecord,
): Promise<AudioBuffer | null> {
  return clipAudioCache.getBuffer(ctx, rec);
}
