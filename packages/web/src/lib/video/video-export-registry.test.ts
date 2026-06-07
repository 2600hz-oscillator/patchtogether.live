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

  it('resolveAll collects bytes from every successful resolver', async () => {
    registerVideoExport('v1', async () => ({ bytes: new Uint8Array([1, 2, 3]), name: 'a.mp4' }));
    registerVideoExport('v2', async () => ({ bytes: new Uint8Array([4, 5]), name: 'b.mp4' }));
    const out = await resolveAllVideoExports();
    const byNode = Object.fromEntries(out.map((r) => [r.nodeId, { bytes: Array.from(r.bytes), name: r.name }]));
    expect(byNode['v1']).toEqual({ bytes: [1, 2, 3], name: 'a.mp4' });
    expect(byNode['v2']).toEqual({ bytes: [4, 5], name: 'b.mp4' });
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
