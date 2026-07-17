// packages/web/src/lib/graph/crop-edit-ydoc.test.ts
//
// REAL-Y.Doc regression tests for the crop-rect edit helpers (crop-edit.ts),
// run against the SAME syncedStore + Y.Doc the live patch uses (graph/store.ts),
// so node.data.crop becomes a real Y type once written — the way to catch the
// "Type already integrated" trap (control-surface #566) if an edit ever
// re-inserted an integrated child. Mirrors mappy-edit-ydoc.test.ts.
//
// Also pins the per-NODE (not per-slot) invariant: a VIDEOVARISPEED slot save
// op (which rebuilds ONLY node.data.slotMeta, the #812 plain-clone pattern) must
// leave node.data.crop untouched.

import { describe, it, expect, afterEach } from 'vitest';
import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode } from './types';
import { writeCrop, readCrop } from '$lib/ui/modules/crop-edit';
import { deriveCropHeight } from '$lib/video/crop-core';

const CID = 'vvs-crop-ydoc-test';
const A_43 = 1024 / 768;
const A_169 = 1366 / 768;

function setup(): void {
  patch.nodes[CID] = {
    id: CID, type: 'videovarispeed', domain: 'video', position: { x: 0, y: 0 }, params: {}, data: {},
  } as unknown as ModuleNode;
}

/** Emulate the card's writeSlotMeta: rebuild ONLY node.data.slotMeta from plain
 *  clones (the #812 pattern) — must not touch node.data.crop. */
function writeSlotMetaLike(id: string, slot: number, name: string): void {
  ydoc.transact(() => {
    const t = patch.nodes[id];
    if (!t) return;
    if (!t.data) t.data = {};
    const d = t.data as { slotMeta?: ({ name: string } | null)[] };
    const cur = Array.isArray(d.slotMeta) ? d.slotMeta : [];
    const arr: ({ name: string } | null)[] = [];
    for (let i = 0; i < 7; i++) {
      if (i === slot) { arr.push({ name }); continue; }
      const e = cur[i];
      arr.push(e ? { name: e.name } : null);
    }
    d.slotMeta = arr;
  }, LOCAL_ORIGIN);
}

afterEach(() => {
  for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
  for (const id of Object.keys(patch.edges)) delete patch.edges[id];
});

describe('crop-edit — real Y.Doc crop mutators', () => {
  it('defaults to an inactive passthrough crop (no node.data.crop yet)', () => {
    setup();
    const s = readCrop(patch.nodes[CID], A_43, A_43);
    expect(s.active).toBe(false);
  });

  it('writeCrop persists an active rect that reads back fitted', () => {
    setup();
    writeCrop(CID, true, { x: 0.25, y: 0.3, w: 0.4 });
    const s = readCrop(patch.nodes[CID], A_43, A_43);
    expect(s.active).toBe(true);
    expect(s.rect.x).toBeCloseTo(0.25, 6);
    expect(s.rect.y).toBeCloseTo(0.3, 6);
    expect(s.rect.w).toBeCloseTo(0.4, 6);
    // stored value is a plain object on the (now-live) Y map
    const stored = (patch.nodes[CID]!.data as { crop?: unknown }).crop;
    expect(stored).toMatchObject({ active: true, x: 0.25, w: 0.4 });
  });

  it('repeated writeCrop edits never throw the integrate trap', () => {
    setup();
    expect(() => {
      for (let k = 0; k < 10; k++) {
        writeCrop(CID, true, { x: 0.1 + k * 0.02, y: 0.1, w: 0.3 });
      }
      writeCrop(CID, false, { x: 0.1, y: 0.1, w: 0.3 }); // remove → passthrough
      writeCrop(CID, true, { x: 0.2, y: 0.2, w: 0.5 });  // re-add
    }).not.toThrow();
    expect(readCrop(patch.nodes[CID], A_43, A_43).active).toBe(true);
  });

  it('remove (active=false) returns readCrop to passthrough', () => {
    setup();
    writeCrop(CID, true, { x: 0.2, y: 0.2, w: 0.5 });
    writeCrop(CID, false, { x: 0.2, y: 0.2, w: 0.5 });
    expect(readCrop(patch.nodes[CID], A_43, A_43).active).toBe(false);
  });

  it('a slot save op (rebuild slotMeta) PRESERVES the crop (per-node, #812)', () => {
    setup();
    writeCrop(CID, true, { x: 0.2, y: 0.25, w: 0.5 });
    // Two slot writes, exactly like loading videos into slots 2 + 5.
    writeSlotMetaLike(CID, 2, 'clipB.mp4');
    writeSlotMetaLike(CID, 5, 'clipE.mp4');
    const s = readCrop(patch.nodes[CID], A_43, A_43);
    expect(s.active).toBe(true);
    expect(s.rect.x).toBeCloseTo(0.2, 6);
    expect(s.rect.y).toBeCloseTo(0.25, 6);
    expect(s.rect.w).toBeCloseTo(0.5, 6);
    // slotMeta landed too (both keys coexist)
    const d = patch.nodes[CID]!.data as { slotMeta?: ({ name: string } | null)[] };
    expect(d.slotMeta?.[2]?.name).toBe('clipB.mp4');
    expect(d.slotMeta?.[5]?.name).toBe('clipE.mp4');
  });

  it('an output-aspect flip re-fits the same stored rect for the new mode', () => {
    setup();
    // Store under 16:9, then read under 4:3 — h = w in both (frame===region),
    // and the rect stays inside the frame.
    writeCrop(CID, true, { x: 0.1, y: 0.1, w: 0.6 });
    const wide = readCrop(patch.nodes[CID], A_169, A_169);
    const narrow = readCrop(patch.nodes[CID], A_43, A_43);
    for (const s of [wide, narrow]) {
      const h = deriveCropHeight(s.rect.w, A_43, A_43);
      expect(s.rect.x + s.rect.w).toBeLessThanOrEqual(1 + 1e-6);
      expect(s.rect.y + h).toBeLessThanOrEqual(1 + 1e-6);
    }
  });
});
