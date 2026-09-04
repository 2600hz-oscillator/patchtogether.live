// packages/web/src/lib/graph/performance-zip.test.ts
//
// Unit tests for the PORTABLE performance .zip (build/parse). The patch
// envelope inside the bundle is built from a REAL Y.Doc (per the
// yjs-save-load-real-ydoc discipline — never a hand-faked update string where
// the round-trip is the thing under test), so the test proves the actual graph
// state survives the zip wrap unchanged.

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import {
  buildPerformanceZip,
  streamPerformanceZip,
  PerformanceZipAborted,
  parsePerformanceZip,
  isPerformanceZip,
  MAX_VIDEO_BYTES,
  PERFORMANCE_ZIP_FORMAT,
  type PerformanceMedia,
} from './performance-zip';
import { makeEnvelope } from './persistence';
import { makePerformanceBundle, type PerformanceBundle } from './performance-bundle';

/** Build a real envelope from a real Y.Doc carrying a VIDEOBOX + a PICTUREBOX
 *  (the picture's bytes inline; the video's bytes are out-of-band). */
function realBundle(): { bundle: PerformanceBundle; nodes: Record<string, { id: string; type: string; data?: Record<string, unknown> | null; params?: Record<string, unknown> | null }> } {
  const store = syncedStore<{ nodes: Record<string, unknown>; edges: Record<string, unknown> }>({ nodes: {}, edges: {} });
  const ydoc = getYjsDoc(store);
  ydoc.transact(() => {
    (store.nodes as Record<string, unknown>)['v1'] = {
      id: 'v1',
      type: 'videobox',
      position: { x: 10, y: 20 },
      data: { fileMeta: { handleId: 'h-vid-1', name: 'clip.webm', size: 4242, duration: 3.5 } },
      params: {},
    };
    (store.nodes as Record<string, unknown>)['p1'] = {
      id: 'p1',
      type: 'picturebox',
      position: { x: 100, y: 200 },
      data: { imageBytes: 'BASE64IMAGEDATA==', imageMime: 'image/jpeg', imageName: 'mountain.png' },
      params: { gain: 1 },
    };
  });
  const envelope = makeEnvelope(ydoc);
  const nodes = {
    v1: { id: 'v1', type: 'videobox', data: { fileMeta: { handleId: 'h-vid-1', name: 'clip.webm', size: 4242, duration: 3.5 } }, params: {} },
    p1: { id: 'p1', type: 'picturebox', data: { imageBytes: 'BASE64IMAGEDATA==' }, params: { gain: 1 } },
  };
  const bundle = makePerformanceBundle({
    envelope,
    nodes,
    midiBindings: [{ key: 'p1:gain', channel: 0, cc: 7, learnedAt: 1 }],
    resolveMidiDevice: () => null,
    resolveGamepad: () => null,
  });
  return { bundle, nodes };
}

const VIDEO_BYTES = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]); // WebM-ish magic + payload

describe('buildPerformanceZip / parsePerformanceZip', () => {
  it('round-trips the manifest + media bytes exactly (real Y.Doc envelope)', () => {
    const { bundle } = realBundle();
    const media: PerformanceMedia[] = [
      { nodeId: 'v1', handleId: 'h-vid-1', role: 'video', name: 'clip.webm', bytes: VIDEO_BYTES },
    ];
    const zip = buildPerformanceZip({ bundle, media, savedAt: 1234 });
    expect(zip.length).toBeGreaterThan(0);
    expect(isPerformanceZip(zip)).toBe(true);

    const parsed = parsePerformanceZip(zip);
    expect(parsed.savedAt).toBe(1234);
    // Envelope survived unchanged → applying it to a fresh doc reconstructs the graph.
    expect(parsed.bundle.patch.update).toBe(bundle.patch.update);
    expect(parsed.bundle.midiBindings).toEqual(bundle.midiBindings);
    // The PICTUREBOX image rides INLINE in the envelope; re-decode to prove it.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Uint8Array.from(atob(parsed.bundle.patch.update), (c) => c.charCodeAt(0)));
    const p1 = doc.getMap('nodes').toJSON()['p1'] as { data: { imageBytes: string } };
    expect(p1.data.imageBytes).toBe('BASE64IMAGEDATA==');
    // The VIDEO bytes round-tripped out-of-band, byte-for-byte.
    expect(parsed.media).toHaveLength(1);
    expect(parsed.media[0]!.nodeId).toBe('v1');
    expect(parsed.media[0]!.handleId).toBe('h-vid-1');
    expect(parsed.media[0]!.name).toBe('clip.webm');
    expect(Array.from(parsed.media[0]!.bytes)).toEqual(Array.from(VIDEO_BYTES));
  });

  it('round-trips mixed VIDEO + AUDIO media (TWOTRACKS reel tapes) distinctly', () => {
    const { bundle } = realBundle();
    const vid = new Uint8Array([9, 8, 7]);
    const tapeA = new Uint8Array([1, 2, 3, 4]);
    const tapeB = new Uint8Array([5, 6, 7, 8]);
    // Two AUDIO entries on the SAME node (reel a + reel b) must not collide.
    const media: PerformanceMedia[] = [
      { nodeId: 'v1', handleId: 'h-vid', role: 'video', name: 'clip.webm', bytes: vid },
      { nodeId: 't1', handleId: 't1:a', role: 'audio', name: 'twotracks-a.pcm', bytes: tapeA },
      { nodeId: 't1', handleId: 't1:b', role: 'audio', name: 'twotracks-b.pcm', bytes: tapeB },
    ];
    const zip = buildPerformanceZip({ bundle, media, savedAt: 5 });
    const parsed = parsePerformanceZip(zip);
    expect(parsed.media).toHaveLength(3);
    const byHandle = Object.fromEntries(parsed.media.map((m) => [m.handleId, m]));
    expect(byHandle['h-vid']!.role).toBe('video');
    expect(Array.from(byHandle['h-vid']!.bytes)).toEqual([9, 8, 7]);
    expect(byHandle['t1:a']!.role).toBe('audio');
    expect(Array.from(byHandle['t1:a']!.bytes)).toEqual([1, 2, 3, 4]);
    expect(byHandle['t1:b']!.role).toBe('audio');
    expect(Array.from(byHandle['t1:b']!.bytes)).toEqual([5, 6, 7, 8]);
  });

  it('handles a rack with NO out-of-band media', () => {
    const { bundle } = realBundle();
    const zip = buildPerformanceZip({ bundle, media: [], savedAt: 0 });
    const parsed = parsePerformanceZip(zip);
    expect(parsed.media).toEqual([]);
    expect(parsed.bundle.patch.update).toBe(bundle.patch.update);
  });

  it('keeps two same-named videos on different nodes distinct', () => {
    const { bundle } = realBundle();
    const a = new Uint8Array([1, 1, 1]);
    const b = new Uint8Array([2, 2, 2, 2]);
    const media: PerformanceMedia[] = [
      { nodeId: 'v1', handleId: 'h1', role: 'video', name: 'same.mp4', bytes: a },
      { nodeId: 'v2', handleId: 'h2', role: 'video', name: 'same.mp4', bytes: b },
    ];
    const zip = buildPerformanceZip({ bundle, media, savedAt: 0 });
    const parsed = parsePerformanceZip(zip);
    expect(parsed.media).toHaveLength(2);
    const byNode = Object.fromEntries(parsed.media.map((m) => [m.nodeId, Array.from(m.bytes)]));
    expect(byNode['v1']).toEqual([1, 1, 1]);
    expect(byNode['v2']).toEqual([2, 2, 2, 2]);
  });

  it('is deterministic for a fixed input (no clock/random read)', () => {
    const { bundle } = realBundle();
    const media: PerformanceMedia[] = [
      { nodeId: 'v1', handleId: 'h-vid-1', role: 'video', name: 'clip.webm', bytes: VIDEO_BYTES },
    ];
    const z1 = buildPerformanceZip({ bundle, media, savedAt: 7 });
    const z2 = buildPerformanceZip({ bundle, media, savedAt: 7 });
    expect(Array.from(z1)).toEqual(Array.from(z2));
  });

  // ── THE LEG THE TEST ABOVE COULD ONLY PASS BY LUCK ──────────────────────
  //
  // Two back-to-back calls almost always land in the same 2-second DOS-time
  // bucket, so the assertion above was blind to the clock read it is NAMED
  // after — until a loaded CI runner spaced the two calls across a boundary
  // and it went red in exactly two bytes (the mod-time low byte, written once
  // in the local file header and once in the central directory).
  //
  // Faking the clock is what makes this DETERMINISTICALLY able to fail: the
  // two builds are now guaranteed to sit on opposite sides of a boundary, so
  // a regression to `zipSync(files)` fails EVERY run rather than one in N.
  it('stays byte-identical when the wall clock advances between builds', () => {
    const { bundle } = realBundle();
    const media: PerformanceMedia[] = [
      { nodeId: 'v1', handleId: 'h-vid-1', role: 'video', name: 'clip.webm', bytes: VIDEO_BYTES },
    ];
    const RealDate = Date;
    const realNow = Date.now;
    try {
      // fflate reads the ambient clock via `new Date()`, so move the whole
      // clock, not just Date.now.
      let t = Date.UTC(2024, 0, 1, 12, 0, 0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Date = class extends RealDate {
        constructor(...args: unknown[]) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (args.length === 0) super(t as any);
          else super(...(args as []));
        }
        static now(): number { return t; }
      };

      const z1 = buildPerformanceZip({ bundle, media, savedAt: 7 });
      t += 10_000; // five DOS ticks later — far past the 2 s granularity
      const z2 = buildPerformanceZip({ bundle, media, savedAt: 7 });

      const a = Array.from(z1);
      const b = Array.from(z2);
      const offsets: number[] = [];
      for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) offsets.push(i);
      expect(
        offsets,
        `the archive changed at byte offsets [${offsets.join(', ')}] purely ` +
          `because 10 s of wall clock passed. That is the ZIP entry mod-time ` +
          `(DOS, 2 s granularity), written into BOTH the local file header and ` +
          `the central directory — pass an explicit \`mtime\` to zipSync.`,
      ).toEqual([]);
      expect(a.length, 'and the length must not move either').toBe(b.length);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Date = RealDate;
      Date.now = realNow;
    }
  });

  // NEGATIVE CONTROL on the clock-faking harness itself: if the fake did not
  // actually move the ambient clock, the leg above would pass against the very
  // bug it exists to catch. Prove the fake is real by showing that a RAW
  // `zipSync` — with no explicit mtime — DOES move under the same fake.
  it('NEGATIVE CONTROL: the faked clock really does reach fflate', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const files = { 'x.json': strToU8('{"a":1}') };
    const RealDate = Date;
    const realNow = Date.now;
    try {
      let t = Date.UTC(2024, 0, 1, 12, 0, 0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Date = class extends RealDate {
        constructor(...args: unknown[]) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (args.length === 0) super(t as any);
          else super(...(args as []));
        }
        static now(): number { return t; }
      };
      const a = zipSync(files);
      t += 10_000;
      const b = zipSync(files);
      let diffs = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffs++;
      expect(
        diffs,
        'an UNPINNED zipSync must differ under the faked clock — if it does ' +
          'not, the fake is not reaching fflate and the determinism leg above ' +
          'is vacuous',
      ).toBeGreaterThan(0);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Date = RealDate;
      Date.now = realNow;
    }
  });
});

// --- Fix B: ALL per-slot media (VIDEOVARISPEED 7 videos + PICTUREBOX 7 images)
//     must travel in the .ptperf. Before this, only ONE slot survived export. ---
describe('Fix B: 7-slot media round-trips losslessly', () => {
  /** Real envelope carrying a 7-slot PICTUREBOX (assets + assetNames inline on
   *  node.data) + a 7-slot VIDEOVARISPEED (slotMeta inline; bytes out-of-band).
   *  Built from a REAL Y.Doc so the slot arrays survive the encode/decode. */
  function multiSlotBundle(): PerformanceBundle {
    const store = syncedStore<{ nodes: Record<string, unknown>; edges: Record<string, unknown> }>({ nodes: {}, edges: {} });
    const ydoc = getYjsDoc(store);
    // 7 distinct base64 strings for the picturebox slots; 7 per-slot metas for
    // the videovarispeed slots (each carrying its own seeded handleId).
    const pbAssets = Array.from({ length: 7 }, (_, i) => `IMG-SLOT-${i}==`);
    const pbNames = Array.from({ length: 7 }, (_, i) => `img-${i}.png`);
    const vvsSlotMeta = Array.from({ length: 7 }, (_, i) => ({
      name: `vid-${i}.mp4`, duration: i, size: 100 + i,
      handleId: i === 0 ? 'bundle-vvs1' : `bundle-vvs1-slot-${i}`,
    }));
    ydoc.transact(() => {
      (store.nodes as Record<string, unknown>)['pb1'] = {
        id: 'pb1', type: 'picturebox', position: { x: 0, y: 0 },
        data: { imageBytes: pbAssets[0], imageMime: 'image/jpeg', imageName: pbNames[0], assets: pbAssets, assetNames: pbNames },
        params: { gain: 1 },
      };
      (store.nodes as Record<string, unknown>)['vvs1'] = {
        id: 'vvs1', type: 'videovarispeed', position: { x: 400, y: 0 },
        data: { fileMeta: { handleId: 'bundle-vvs1', name: 'vid-0.mp4', size: 100 }, isPlaying: false, loop: true, slotMeta: vvsSlotMeta },
        params: {},
      };
    });
    const envelope = makeEnvelope(ydoc);
    return makePerformanceBundle({
      envelope,
      nodes: {
        pb1: { id: 'pb1', type: 'picturebox', data: { assets: pbAssets, assetNames: pbNames }, params: {} },
        vvs1: { id: 'vvs1', type: 'videovarispeed', data: { fileMeta: { handleId: 'bundle-vvs1' }, slotMeta: vvsSlotMeta }, params: {} },
      },
      midiBindings: [],
      resolveMidiDevice: () => null,
      resolveGamepad: () => null,
    });
  }

  it('PICTUREBOX: all 7 assets[] + assetNames[] survive the round-trip (inline)', () => {
    const bundle = multiSlotBundle();
    const zip = buildPerformanceZip({ bundle, media: [], savedAt: 0 });
    const parsed = parsePerformanceZip(zip);
    // PICTUREBOX slots ride INLINE on node.data — decode the envelope + assert all 7.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Uint8Array.from(atob(parsed.bundle.patch.update), (c) => c.charCodeAt(0)));
    const pb1 = doc.getMap('nodes').toJSON()['pb1'] as { data: { assets: (string | null)[]; assetNames: (string | null)[] } };
    expect(pb1.data.assets).toHaveLength(7);
    for (let i = 0; i < 7; i++) {
      expect(pb1.data.assets[i], `slot ${i} image bytes`).toBe(`IMG-SLOT-${i}==`);
      expect(pb1.data.assetNames[i], `slot ${i} image name`).toBe(`img-${i}.png`);
    }
  });

  it('VIDEOVARISPEED: all 7 slots travel out-of-band + restore into the right slot index', () => {
    const bundle = multiSlotBundle();
    // One out-of-band video per populated slot, each tagged with its slot index
    // (exactly what Canvas.buildPerformanceZipBytes now emits for a 7-video VVS).
    const media: PerformanceMedia[] = Array.from({ length: 7 }, (_, i) => ({
      nodeId: 'vvs1',
      handleId: i === 0 ? 'bundle-vvs1' : `bundle-vvs1-slot-${i}`,
      role: 'video' as const,
      name: `vid-${i}.mp4`,
      // distinct bytes per slot so a mis-routed slot is caught
      bytes: new Uint8Array([0xff, i, i * 2, i * 3]),
      slot: i,
    }));
    const zip = buildPerformanceZip({ bundle, media, savedAt: 0 });
    const parsed = parsePerformanceZip(zip);

    expect(parsed.media, 'all 7 slot videos must travel (not just slot 0)').toHaveLength(7);
    // Each slot's bytes come back byte-exact, in the right slot index.
    const bySlot = Object.fromEntries(parsed.media.map((m) => [m.slot, m]));
    for (let i = 0; i < 7; i++) {
      expect(bySlot[i], `slot ${i} present`).toBeTruthy();
      expect(bySlot[i]!.handleId).toBe(i === 0 ? 'bundle-vvs1' : `bundle-vvs1-slot-${i}`);
      expect(bySlot[i]!.name).toBe(`vid-${i}.mp4`);
      expect(Array.from(bySlot[i]!.bytes), `slot ${i} bytes`).toEqual([0xff, i, i * 2, i * 3]);
    }
  });

  it('BACK-COMPAT: an OLD single-video manifest (no slot field) imports as slot 0', () => {
    const bundle = multiSlotBundle();
    // Simulate a manifest written BEFORE Fix B: a video media entry with NO
    // `slot` key at all (the only shape old exports produced).
    const oldZip = zipSync({
      'performance.json': strToU8(JSON.stringify({
        format: PERFORMANCE_ZIP_FORMAT,
        savedAt: 0,
        bundle,
        media: [{ nodeId: 'vvs1', handleId: 'bundle-vvs1', role: 'video', name: 'legacy.mp4', path: 'media/legacy.mp4' }],
      })),
      'media/legacy.mp4': new Uint8Array([1, 2, 3]),
    });
    const parsed = parsePerformanceZip(oldZip);
    expect(parsed.media).toHaveLength(1);
    expect(parsed.media[0]!.slot, 'missing slot defaults to 0').toBe(0);
    expect(parsed.media[0]!.handleId).toBe('bundle-vvs1');
    expect(Array.from(parsed.media[0]!.bytes)).toEqual([1, 2, 3]);
  });

  it('a single-video (slot 0 only) manifest does NOT emit a slot field (byte-stable)', () => {
    const { bundle } = realBundle();
    const zip = buildPerformanceZip({
      bundle,
      media: [{ nodeId: 'v1', handleId: 'h-vid-1', role: 'video', name: 'clip.webm', bytes: VIDEO_BYTES, slot: 0 }],
      savedAt: 0,
    });
    const entries = unzipSync(zip);
    const manifest = JSON.parse(strFromU8(entries['performance.json']!)) as { media: Array<Record<string, unknown>> };
    expect(manifest.media[0]).not.toHaveProperty('slot');
  });
});

describe('parsePerformanceZip errors', () => {
  it('rejects an empty zip', () => {
    expect(() => parsePerformanceZip(new Uint8Array(0))).toThrow(/empty/i);
  });

  it('rejects a corrupt zip', () => {
    expect(() => parsePerformanceZip(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(/corrupt/i);
  });

  it('rejects a foreign zip (no performance.json)', () => {
    // A valid zip with the wrong entry name.
    const foreign = zipSync({ 'other.json': new Uint8Array([1, 2, 3]) });
    expect(() => parsePerformanceZip(foreign)).toThrow(/missing performance\.json/i);
    expect(isPerformanceZip(foreign)).toBe(false);
  });

  it('rejects a wrong-format manifest', () => {
    const wrong = zipSync({
      'performance.json': strToU8(JSON.stringify({ format: 'something-else', bundle: {}, media: [] })),
    });
    expect(() => parsePerformanceZip(wrong)).toThrow(/unsupported/i);
  });

  it('rejects an oversized bundled video', () => {
    const { bundle } = realBundle();
    // Craft a manifest pointing at an entry whose bytes exceed the cap, WITHOUT
    // allocating 50 MB: build the zip with a small entry, then assert the cap
    // path via a manifest that claims a too-big entry path resolved to big bytes.
    // Simplest faithful route: build a real oversized entry just over the cap is
    // expensive, so use a manifest whose media path holds bytes we control to be
    // exactly cap+1 via a sparse fill.
    const big = new Uint8Array(MAX_VIDEO_BYTES + 1); // zero-filled; compresses tiny
    const zip = zipSync({
      'performance.json': strToU8(JSON.stringify({
        format: PERFORMANCE_ZIP_FORMAT,
        savedAt: 0,
        bundle,
        media: [{ nodeId: 'v1', handleId: 'h', role: 'video', name: 'big.mp4', path: 'media/big.mp4' }],
      })),
      'media/big.mp4': big,
    });
    expect(() => parsePerformanceZip(zip)).toThrow(/exceeds the .* limit/i);
  });

  it('skips referenced-but-missing media (node falls back to re-link)', () => {
    const { bundle } = realBundle();
    const zip = zipSync({
      'performance.json': strToU8(JSON.stringify({
        format: PERFORMANCE_ZIP_FORMAT,
        savedAt: 0,
        bundle,
        media: [{ nodeId: 'v1', handleId: 'h', role: 'video', name: 'gone.mp4', path: 'media/gone.mp4' }],
      })),
      // no media/gone.mp4 entry
    });
    const parsed = parsePerformanceZip(zip);
    expect(parsed.media).toEqual([]); // skipped, not thrown
    expect(parsed.bundle.patch).toBeDefined();
  });
});

// ── STREAMING BUILDER — the file save path ────────────────────────────────
//
// The bug this suite exists for: the shipped save path built the WHOLE archive
// with `zipSync` and only then wrote it. Measured on 4x50 MB of incompressible
// (video-like) entries, RSS sampled synchronously at the point of maximum
// liveness — zipSync at the default level peaked at 706 MB (3.53x the input)
// and blocked the main thread for 4344 ms; STOREing the media dropped that to
// 443 MB / 371 ms; streaming into the sink dropped it to 244 MB (1.22x) / 355 ms.
//
// ⚠ The suite this was added to could not have caught any of it: its largest
// payload is a 12-byte `VIDEO_BYTES`, three orders of magnitude below the
// 100 MB per-slot cap the format actually accepts. So the cases below use a
// payload big enough to have a MEASURABLE high-water mark, and assert the
// allocation bound directly rather than trusting the mechanism.

/** An in-memory sink that records chunks — the structural subset of a
 *  `FileSystemWritableFileStream`, exactly what `createWritable()` returns. */
function makeSink() {
  const chunks: Uint8Array[] = [];
  let closed = false;
  let peakLive = 0;
  return {
    chunks,
    get closed() {
      return closed;
    },
    /** Largest single chunk handed to the sink — the streaming high-water mark
     *  for anything the writer holds on our behalf. */
    get peakChunkBytes() {
      return peakLive;
    },
    bytes(): Uint8Array {
      const total = chunks.reduce((a, c) => a + c.length, 0);
      const out = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) {
        out.set(c, o);
        o += c.length;
      }
      return out;
    },
    async write(chunk: Uint8Array): Promise<void> {
      if (chunk.length > peakLive) peakLive = chunk.length;
      chunks.push(chunk.slice()); // copy: fflate reuses its output buffers
    },
    async close(): Promise<void> {
      closed = true;
    },
  };
}

/** Incompressible bytes — video/PCM-shaped, so DEFLATE cannot shrink them and
 *  the level-0/level-6 difference is real rather than an artefact of zeros. */
function incompressible(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

function mediaOf(sizes: number[]): PerformanceMedia[] {
  return sizes.map((n, i) => ({
    nodeId: `v${i}`,
    handleId: `h-${i}`,
    role: 'video' as const,
    name: `clip-${i}.webm`,
    bytes: incompressible(n, i + 1),
    slot: i,
  }));
}

describe('streamPerformanceZip — the file save path', () => {
  it('round-trips through parsePerformanceZip identically to the buffered builder', async () => {
    const { bundle } = realBundle();
    const media = mediaOf([2048, 5000, 1]);
    const expected = media.map((m) => Array.from(m.bytes));
    const sink = makeSink();
    // release:false — this case needs the same input twice.
    await streamPerformanceZip({ bundle, media, savedAt: 7 }, sink, { release: false });
    expect(sink.closed).toBe(true);

    const streamed = parsePerformanceZip(sink.bytes());
    const buffered = parsePerformanceZip(buildPerformanceZip({ bundle, media, savedAt: 7 }));
    // The CONTAINERS differ by design (a streaming writer emits data
    // descriptors because it cannot know a CRC before writing the header), so
    // the contract asserted is round-trip equivalence, not byte equality.
    expect(streamed.savedAt).toBe(buffered.savedAt);
    expect(streamed.bundle).toEqual(buffered.bundle);
    expect(streamed.media.map((m) => [m.nodeId, m.handleId, m.role, m.name, m.slot])).toEqual(
      buffered.media.map((m) => [m.nodeId, m.handleId, m.role, m.name, m.slot]),
    );
    expect(streamed.media.map((m) => Array.from(m.bytes))).toEqual(expected);
  });

  it('is DETERMINISTIC for a fixed input (two streams, identical bytes)', async () => {
    const { bundle } = realBundle();
    const a = makeSink();
    const b = makeSink();
    await streamPerformanceZip({ bundle, media: mediaOf([3000]), savedAt: 7 }, a);
    await streamPerformanceZip({ bundle, media: mediaOf([3000]), savedAt: 7 }, b);
    expect(Array.from(a.bytes())).toEqual(Array.from(b.bytes()));
  });

  it('an empty-media bundle still produces a parseable archive', async () => {
    const { bundle } = realBundle();
    const sink = makeSink();
    await streamPerformanceZip({ bundle, media: [], savedAt: 3 }, sink);
    const parsed = parsePerformanceZip(sink.bytes());
    expect(parsed.media).toEqual([]);
    expect(parsed.bundle.patch).toBeDefined();
    expect(isPerformanceZip(sink.bytes())).toBe(true);
  });

  it('a ZERO-BYTE media entry does not stall the writer', async () => {
    // fflate needs a final push even for an empty entry; forgetting it hangs
    // the archive with no error, which is the worst possible save failure.
    const { bundle } = realBundle();
    const media: PerformanceMedia[] = [
      { nodeId: 'v0', handleId: 'h0', role: 'video', name: 'empty.webm', bytes: new Uint8Array(0) },
      ...mediaOf([100]),
    ];
    const sink = makeSink();
    await streamPerformanceZip({ bundle, media, savedAt: 1 }, sink);
    const parsed = parsePerformanceZip(sink.bytes());
    // A zero-length entry is dropped by unzipSync's entry map only if absent;
    // here it round-trips as an empty payload alongside the real one.
    expect(parsed.media.map((m) => m.bytes.length).sort((x, y) => x - y)).toEqual([0, 100]);
  });

  it('MEMORY: peak live output never approaches the payload size', async () => {
    // THE ACTUAL FIX. `buildPerformanceZip` returns one buffer the size of the
    // whole archive; the streaming builder hands the sink bounded chunks and
    // holds at most one at a time. 6 MB of media through a 64 KiB chunk must
    // never present the sink with anything near 6 MB.
    const { bundle } = realBundle();
    const payload = 6 * 1024 * 1024;
    const media = mediaOf([payload / 2, payload / 2]);
    const sink = makeSink();
    const written = await streamPerformanceZip({ bundle, media, savedAt: 9 }, sink, {
      chunkBytes: 64 * 1024,
    });
    expect(written).toBeGreaterThan(payload); // the whole payload really went out
    // Bound stated against the PAYLOAD, not against a magic constant, so the
    // assertion keeps its meaning if the chunk size changes.
    expect(sink.peakChunkBytes).toBeLessThan(payload / 8);

    // NEGATIVE CONTROL — the buffered builder fails this exact bound, so the
    // assertion above is measuring the change and not a property both share.
    const oneBuffer = buildPerformanceZip({ bundle, media: mediaOf([payload]), savedAt: 9 });
    expect(oneBuffer.length).toBeGreaterThan(payload / 8);
  });

  it('RELEASES each media buffer as it is consumed (the input is CONSUMED)', async () => {
    // Releasing is what takes the measured peak from 2.2x the input to 1.2x:
    // a 100 MB slot stops being resident the moment it has been written,
    // instead of at the end of the save.
    const { bundle } = realBundle();
    const media = mediaOf([4096, 4096]);
    const sink = makeSink();
    await streamPerformanceZip({ bundle, media, savedAt: 1 }, sink);
    expect(media.map((m) => m.bytes.length)).toEqual([0, 0]);
    // ...and the archive is complete regardless.
    expect(parsePerformanceZip(sink.bytes()).media.map((m) => m.bytes.length)).toEqual([4096, 4096]);
  });

  it('release can be opted OUT of, for a caller that still needs the bytes', async () => {
    const { bundle } = realBundle();
    const media = mediaOf([512]);
    await streamPerformanceZip({ bundle, media, savedAt: 1 }, makeSink(), { release: false });
    expect(media[0]!.bytes.length).toBe(512);
  });

  it('MEDIA IS STORED, NOT DEFLATED (level 6 over an MP4 bought nothing)', async () => {
    // Measured: level 6 over 8 MB of incompressible bytes took 86 ms and made
    // the archive LARGER (8390512 vs 8388608). A stored entry is the payload
    // plus headers, so the archive must not exceed the payload by much.
    const { bundle } = realBundle();
    const payload = 512 * 1024;
    const sink = makeSink();
    const written = await streamPerformanceZip({ bundle, media: mediaOf([payload]), savedAt: 1 }, sink);
    expect(written).toBeLessThan(payload * 1.02);
    // The buffered builder now STOREs media too, so both stay near the payload.
    expect(buildPerformanceZip({ bundle, media: mediaOf([payload]), savedAt: 1 }).length)
      .toBeLessThan(payload * 1.02);
  });

  it('reports progress monotonically, ending at the byte count returned', async () => {
    const { bundle } = realBundle();
    const seen: number[] = [];
    const written = await streamPerformanceZip(
      { bundle, media: mediaOf([200_000]), savedAt: 1 },
      makeSink(),
      { chunkBytes: 16 * 1024, onProgress: (n) => seen.push(n) },
    );
    expect(seen.length).toBeGreaterThan(1);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen[seen.length - 1]).toBe(written);
  });

  it('CANCELLATION: an abort mid-write throws PerformanceZipAborted and stops', async () => {
    const { bundle } = realBundle();
    const sink = makeSink();
    const signal = { aborted: false };
    // Abort once a couple of chunks have landed — a real mid-save cancel.
    let n = 0;
    const watching = {
      ...sink,
      async write(chunk: Uint8Array) {
        await sink.write(chunk);
        if (++n === 2) signal.aborted = true;
      },
    };
    await expect(
      streamPerformanceZip({ bundle, media: mediaOf([1024 * 1024]), savedAt: 1 }, watching, {
        chunkBytes: 32 * 1024,
        signal,
      }),
    ).rejects.toBeInstanceOf(PerformanceZipAborted);
    // Stopped early rather than finishing the payload behind the abort.
    expect(sink.chunks.length).toBeLessThan(20);
    // The sink is NOT closed: closing would COMMIT a truncated file. The
    // caller owns the rollback.
    expect(sink.closed).toBe(false);
  });

  it('an abort BEFORE the first chunk writes nothing at all', async () => {
    const { bundle } = realBundle();
    const sink = makeSink();
    await expect(
      streamPerformanceZip({ bundle, media: mediaOf([1024]), savedAt: 1 }, sink, {
        signal: { aborted: true },
      }),
    ).rejects.toBeInstanceOf(PerformanceZipAborted);
    expect(sink.chunks).toEqual([]);
    expect(sink.closed).toBe(false);
  });

  it('BACKPRESSURE: a slow sink is awaited, so nothing queues up behind it', async () => {
    // If the writer ignored the returned promise, every chunk would be handed
    // over before the first await resolved and `inFlight` would exceed 1.
    const { bundle } = realBundle();
    let inFlight = 0;
    let maxInFlight = 0;
    const slow = {
      chunks: 0,
      async write(_chunk: Uint8Array) {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await new Promise<void>((r) => setTimeout(r, 0));
        this.chunks++;
        inFlight--;
      },
      async close() {},
    };
    await streamPerformanceZip({ bundle, media: mediaOf([400_000]), savedAt: 1 }, slow, {
      chunkBytes: 32 * 1024,
    });
    expect(slow.chunks).toBeGreaterThan(5);
    expect(maxInFlight).toBe(1);
  });
});
