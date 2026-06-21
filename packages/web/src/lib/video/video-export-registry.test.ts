// packages/web/src/lib/video/video-export-registry.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerVideoExport,
  unregisterVideoExport,
  registeredVideoExportNodeIds,
  resolveAllVideoExports,
  __clearVideoExportRegistry,
} from './video-export-registry';

describe('video-export-registry', () => {
  beforeEach(() => __clearVideoExportRegistry());

  it('registers + lists + unregisters node resolvers', () => {
    registerVideoExport('v1', async () => null);
    registerVideoExport('v2', async () => null);
    expect(registeredVideoExportNodeIds().sort()).toEqual(['v1', 'v2']);
    unregisterVideoExport('v1');
    expect(registeredVideoExportNodeIds()).toEqual(['v2']);
  });

  it('resolveAll collects bytes from every successful resolver (single-result, slot 0)', async () => {
    registerVideoExport('v1', async () => ({ bytes: new Uint8Array([1, 2, 3]), name: 'a.mp4' }));
    registerVideoExport('v2', async () => ({ bytes: new Uint8Array([4, 5]), name: 'b.mp4' }));
    const out = await resolveAllVideoExports();
    const byNode = Object.fromEntries(out.map((r) => [r.nodeId, { bytes: Array.from(r.bytes), name: r.name, slot: r.slot }]));
    // A single result with no slot defaults to slot 0 (single-video back-compat).
    expect(byNode['v1']).toEqual({ bytes: [1, 2, 3], name: 'a.mp4', slot: 0 });
    expect(byNode['v2']).toEqual({ bytes: [4, 5], name: 'b.mp4', slot: 0 });
  });

  it('resolveAll FLATTENS a multi-slot resolver to one entry per populated slot (VIDEOVARISPEED 7 videos)', async () => {
    // A VIDEOVARISPEED card returns an ARRAY of per-slot results. Each must
    // surface as its own media entry, tagged with its slot index — the Fix B
    // repair (before this, only slot 0 travelled into the .ptperf).
    registerVideoExport('vvs', async () =>
      Array.from({ length: 7 }, (_, i) => ({ bytes: new Uint8Array([i, i + 1]), name: `s${i}.mp4`, slot: i })),
    );
    // An empty slot inside the array is skipped (0-byte), not emitted.
    registerVideoExport('vvs2', async () => [
      { bytes: new Uint8Array([9]), name: 'kept.mp4', slot: 2 },
      { bytes: new Uint8Array(0), name: 'empty.mp4', slot: 5 },
    ]);
    const out = await resolveAllVideoExports();
    const vvs = out.filter((r) => r.nodeId === 'vvs').sort((a, b) => a.slot - b.slot);
    expect(vvs).toHaveLength(7);
    for (let i = 0; i < 7; i++) {
      expect(vvs[i]!.slot).toBe(i);
      expect(vvs[i]!.name).toBe(`s${i}.mp4`);
      expect(Array.from(vvs[i]!.bytes)).toEqual([i, i + 1]);
    }
    const vvs2 = out.filter((r) => r.nodeId === 'vvs2');
    expect(vvs2, 'empty slot dropped, populated slot kept').toHaveLength(1);
    expect(vvs2[0]!.slot).toBe(2);
  });

  it('skips a resolver that returns null, throws, or yields empty bytes', async () => {
    registerVideoExport('ok', async () => ({ bytes: new Uint8Array([1]), name: 'ok.mp4' }));
    registerVideoExport('null', async () => null);
    registerVideoExport('throws', async () => { throw new Error('revoked URL'); });
    registerVideoExport('empty', async () => ({ bytes: new Uint8Array(0), name: 'empty.mp4' }));
    const out = await resolveAllVideoExports();
    expect(out).toHaveLength(1);
    expect(out[0]!.nodeId).toBe('ok');
  });

  it('re-registering a node replaces its resolver', async () => {
    registerVideoExport('v1', async () => ({ bytes: new Uint8Array([1]), name: 'old.mp4' }));
    registerVideoExport('v1', async () => ({ bytes: new Uint8Array([2]), name: 'new.mp4' }));
    const out = await resolveAllVideoExports();
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('new.mp4');
  });
});
