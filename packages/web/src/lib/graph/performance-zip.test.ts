// packages/web/src/lib/graph/performance-zip.test.ts
//
// Unit tests for the PORTABLE performance .zip (build/parse). The patch
// envelope inside the bundle is built from a REAL Y.Doc (per the
// yjs-save-load-real-ydoc discipline — never a hand-faked update string where
// the round-trip is the thing under test), so the test proves the actual graph
// state survives the zip wrap unchanged.

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { zipSync, strToU8 } from 'fflate';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import {
  buildPerformanceZip,
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
