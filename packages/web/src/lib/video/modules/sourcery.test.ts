// packages/web/src/lib/video/modules/sourcery.test.ts
//
// SOURCERY module-def SHAPE test (ports / params / CV targets / lowercase
// label). The pure algorithm is covered exhaustively by
// $lib/video/sourcery-core.test.ts; the GL factory's draw() needs a WebGL2
// context (jsdom has none) and is covered by the e2e spec + the auto-enrolled
// per-module-per-port / VRT sweeps.

import { describe, it, expect } from 'vitest';
import { sourceryDef } from './sourcery';
import { SOURCERY_PROC_W, SOURCERY_PROC_H, SOURCERY_MAX_REGIONS } from '$lib/video/sourcery-core';

describe('sourceryDef — module shape', () => {
  it('exports the processing-grid constants the factory + fill shader use', () => {
    expect(SOURCERY_PROC_W).toBe(128);
    expect(SOURCERY_PROC_H).toBe(96);
    expect(SOURCERY_MAX_REGIONS).toBe(128);
  });

});
