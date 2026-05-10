// Unit coverage for the right-click "Duplicate" pure helper.
//
// What we assert:
//   - id is fresh (never collides with anything in `existingIds`);
//   - position is offset by the documented delta (or the override is honored);
//   - data is deep-cloned (mutating the duplicate's nested fields does not
//     touch the source — the same property the reconciler relies on);
//   - params are independent (mutating one does not affect the other);
//   - asset-bearing modules (PICTUREBOX imageBytes, SCORE pages, DX7
//     userPatches, DRUMSEQZ quicksave slots) round-trip correctly.

import { describe, it, expect } from 'vitest';
import { buildDuplicate, DUPLICATE_OFFSET } from './duplicate';
import type { ModuleNode } from './types';

function srcNode(overrides: Partial<ModuleNode> = {}): ModuleNode {
  return {
    id: 'analogVco-aaaaaaaa',
    type: 'analogVco',
    domain: 'audio',
    position: { x: 100, y: 200 },
    params: { freq: 440, gain: 0.7 },
    ...overrides,
  };
}

describe('buildDuplicate — id', () => {
  it('mints a fresh id of shape `{type}-{slice}` that does not collide', () => {
    const src = srcNode();
    const dup = buildDuplicate(src, [src.id]);
    expect(dup.id).not.toBe(src.id);
    expect(dup.id.startsWith('analogVco-')).toBe(true);
  });

  it('avoids collision when the random slice happens to match an existing id', () => {
    const src = srcNode();
    // Pre-take the suffix-based candidate; helper must regenerate.
    const dup = buildDuplicate(
      src,
      [src.id, 'analogVco-deadbeef'],
      { idSuffix: 'deadbeef' },
    );
    expect(dup.id).not.toBe('analogVco-deadbeef');
    expect(dup.id.startsWith('analogVco-')).toBe(true);
  });

  it('uses the supplied idSuffix when free', () => {
    const src = srcNode();
    const dup = buildDuplicate(src, [src.id], { idSuffix: '12345678' });
    expect(dup.id).toBe('analogVco-12345678');
  });
});

describe('buildDuplicate — position', () => {
  it('offsets by DUPLICATE_OFFSET in both axes by default', () => {
    const src = srcNode({ position: { x: 100, y: 200 } });
    const dup = buildDuplicate(src, [src.id]);
    expect(dup.position).toEqual({
      x: 100 + DUPLICATE_OFFSET,
      y: 200 + DUPLICATE_OFFSET,
    });
  });

  it('honors positionOverride when supplied', () => {
    const src = srcNode({ position: { x: 100, y: 200 } });
    const dup = buildDuplicate(src, [src.id], {
      positionOverride: { x: 555, y: 666 },
    });
    expect(dup.position).toEqual({ x: 555, y: 666 });
  });
});

describe('buildDuplicate — params independence', () => {
  it('shallow-clones params so mutating the duplicate does not touch the source', () => {
    const src = srcNode({ params: { freq: 440, gain: 0.7 } });
    const dup = buildDuplicate(src, [src.id]);
    dup.params.freq = 880;
    expect(src.params.freq).toBe(440);
  });
});

describe('buildDuplicate — type + domain preservation', () => {
  it('preserves type + domain', () => {
    const src = srcNode({ type: 'lines', domain: 'video' });
    const dup = buildDuplicate(src, [src.id]);
    expect(dup.type).toBe('lines');
    expect(dup.domain).toBe('video');
  });
});

describe('buildDuplicate — data deep-clone (no Yjs alias)', () => {
  it('omits data when source has none', () => {
    const src = srcNode();
    const dup = buildDuplicate(src, [src.id]);
    expect(dup.data).toBeUndefined();
  });

  it('PICTUREBOX-shaped data: imageBytes round-trips, mutating dup does not touch src', () => {
    // imageBytes is stored as a plain Array<number> on the wire (Yjs JSON).
    const imageBytes = Array.from({ length: 8 }, (_, i) => i * 2);
    const src = srcNode({
      type: 'picturebox',
      domain: 'video',
      data: { imageBytes, mime: 'image/png', width: 2, height: 2 },
    });
    const dup = buildDuplicate(src, [src.id]);
    expect(dup.data).toEqual({ imageBytes, mime: 'image/png', width: 2, height: 2 });

    // Mutating dup.data.imageBytes does NOT touch source's array.
    (dup.data!.imageBytes as number[])[0] = 99;
    expect((src.data!.imageBytes as number[])[0]).toBe(0);
  });

  it('SCORE-shaped data: pages array of arrays round-trips, mutating dup does not touch src', () => {
    const pages = [
      [{ on: true, midi: 60 }, { on: true, midi: 64 }],
      [{ on: false, midi: null }, { on: true, midi: 67 }],
    ];
    const src = srcNode({
      type: 'score',
      data: { pages, currentPage: 0 },
    });
    const dup = buildDuplicate(src, [src.id]);
    expect(dup.data).toEqual({ pages, currentPage: 0 });

    // Deep mutation: dup's nested step does not leak to src.
    (dup.data!.pages as Array<Array<{ on: boolean }>>)[0][0].on = false;
    expect((src.data!.pages as Array<Array<{ on: boolean }>>)[0][0].on).toBe(true);
  });

  it('DX7-shaped data: userPatches array round-trips, mutating dup does not touch src', () => {
    const userPatches = [
      { name: 'BASS 1', operators: [{ ratio: 1.0, level: 99 }] },
      { name: 'LEAD',   operators: [{ ratio: 2.0, level: 80 }] },
    ];
    const src = srcNode({
      type: 'dx7',
      data: { userPatches, currentPatchIndex: 0 },
    });
    const dup = buildDuplicate(src, [src.id]);
    expect(dup.data).toEqual({ userPatches, currentPatchIndex: 0 });

    // Mutate dup deeply; src must be untouched.
    (dup.data!.userPatches as Array<{ name: string }>)[0].name = 'CHANGED';
    expect((src.data!.userPatches as Array<{ name: string }>)[0].name).toBe('BASS 1');
  });

  it('DRUMSEQZ-shaped data: quicksave slots round-trip and are not aliased', () => {
    const slots = [
      { steps: [true, false, true, false], bpm: 120 },
      { steps: [false, true, false, true], bpm: 140 },
    ];
    const src = srcNode({
      type: 'drumseqz',
      data: { slots, activeSlot: 0 },
    });
    const dup = buildDuplicate(src, [src.id]);
    expect(dup.data).toEqual({ slots, activeSlot: 0 });

    // Mutating the duplicate's deep structure does not touch the source.
    (dup.data!.slots as Array<{ bpm: number }>)[0].bpm = 999;
    expect((src.data!.slots as Array<{ bpm: number }>)[0].bpm).toBe(120);
  });
});
