// packages/web/src/lib/video/modules/picturebox.test.ts
//
// Schema migration tests for the v1 → v2 PICTUREBOX shape change.
// PICTUREBOX got `imageBytes`/`imageMime`/`imageName` fields in v2 to
// carry image content over the wire. v1 nodes have to load cleanly
// (with default-null bytes) without surprising the card.

import { describe, expect, it } from 'vitest';
import { pictureboxDef } from './picturebox';

describe('PICTUREBOX def — schema v2', () => {
  it('reports schemaVersion 2', () => {
    expect(pictureboxDef.schemaVersion).toBe(2);
  });

  it('declares maxInstances = 8 (workspace cap mirror)', () => {
    expect(pictureboxDef.maxInstances).toBe(8);
  });

  it('exposes a migrate function', () => {
    expect(typeof pictureboxDef.migrate).toBe('function');
  });
});

describe('PICTUREBOX migration v1 → v2', () => {
  it('fills in missing imageBytes/imageMime/imageName from undefined data', () => {
    const out = pictureboxDef.migrate?.(undefined, 1) as Record<string, unknown>;
    expect(out.imageBytes).toBeNull();
    expect(out.imageMime).toBe('image/jpeg');
    expect(out.imageName).toBeNull();
  });

  it('fills in missing fields when data exists but lacks them', () => {
    const out = pictureboxDef.migrate?.({ unrelated: 'value' }, 1) as Record<string, unknown>;
    expect(out.imageBytes).toBeNull();
    expect(out.imageMime).toBe('image/jpeg');
    expect(out.imageName).toBeNull();
    // Pre-existing keys preserved.
    expect(out.unrelated).toBe('value');
  });

  it('preserves user-supplied fields if v1 already had them (forward-compat reads)', () => {
    const out = pictureboxDef.migrate?.(
      { imageBytes: 'AAAA', imageMime: 'image/png', imageName: 'x.png' },
      1,
    ) as Record<string, unknown>;
    expect(out.imageBytes).toBe('AAAA');
    expect(out.imageMime).toBe('image/png');
    expect(out.imageName).toBe('x.png');
  });

  it('does NOT default-fill creatorId for legacy nodes (loose grandfathering)', () => {
    const out = pictureboxDef.migrate?.({}, 1) as Record<string, unknown>;
    // Important: undefined / missing creatorId is intentional. The
    // per-user cap helper treats those as unattributed.
    expect(out.creatorId).toBeUndefined();
  });

  it('passes through v2 data unchanged (idempotent)', () => {
    const v2 = {
      imageBytes: 'BBBB',
      imageMime: 'image/jpeg',
      imageName: 'photo.jpg',
      creatorId: 'u1',
    };
    const out = pictureboxDef.migrate?.(v2, 2) as Record<string, unknown>;
    expect(out).toEqual(v2);
  });
});

describe('PICTUREBOX def — port surface unchanged from v1', () => {
  // The schema bump must not silently change the I/O surface — that's
  // a separate, breaking change that needs its own design pass.
  it('cv gain in, image out (per phase1.test.ts contract)', () => {
    expect(pictureboxDef.inputs.map((p) => p.id)).toEqual(['gain']);
    expect(pictureboxDef.inputs[0]?.type).toBe('cv');
    expect(pictureboxDef.outputs.map((p) => p.id)).toEqual(['out']);
    expect(pictureboxDef.outputs[0]?.type).toBe('image');
  });
});
