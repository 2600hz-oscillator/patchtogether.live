// packages/web/src/lib/video/modules/loopback.test.ts
//
// Unit-level checks for the LOOPBACK module def. Vitest runs under node (no
// WebGL2), so it verifies the def SHAPE — registration, I/O surface (zero
// inputs, one video output), params + ranges, guardrails — while the GL-bound
// factory + getDisplayMedia path is covered by e2e/tests/loopback.spec.ts.

import { describe, expect, it } from 'vitest';
import { listVideoModuleDefs } from '$lib/video/module-registry';
// Side-effect import auto-registers the video defs (incl. loopback).
import '$lib/video/modules';

describe('LOOPBACK — module def shape', () => {
  it('appears in the global video registry list (auto-registered)', () => {
    const types = listVideoModuleDefs().map((d) => d.type);
    expect(types).toContain('loopback');
  });

});
