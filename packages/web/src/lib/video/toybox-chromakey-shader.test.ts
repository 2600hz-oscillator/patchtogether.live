// packages/web/src/lib/video/toybox-chromakey-shader.test.ts
//
// Regression guard that the in-card chromakey combine shader pins TOYBOX's
// LEGACY hue+satGate keying (rgbToHsv + hueDistance + the satGate smoothstep)
// and exposes the keyR/keyG/keyB colour uniforms (the old single `key`
// channel-select uniform is gone).
//
// NOTE (keyer-framework 2026-07-11): this shader was originally a verbatim
// port OF the standalone chromakey.ts — that premise has INVERTED. The
// CHROMAKEY module moved to the shared keying core's chroma-plane (CbCr
// distance) metric ($lib/video/keying-core); TOYBOX's combine op deliberately
// KEEPS the legacy hue-angle+satGate math until its own migration (design doc
// §8 — deferred: it drags in toybox's alpha-aware `keep *= t.a` semantics and
// preset surfaces). Until then this test pins the legacy shader AS legacy.
// The v2→v3 DATA migration that mapped a saved `key` scalar to keyR/G/B was
// removed in the schema cleanup — this only covers the current shader surface.

import { describe, it, expect } from 'vitest';
import { __COMBINE_FRAG_SRC_FOR_TEST } from './modules/toybox';

describe('in-card chromakey shader pins the LEGACY hue+satGate keying', () => {
  it('includes rgbToHsv + hueDistance + the satGate smoothstep', () => {
    const src = __COMBINE_FRAG_SRC_FOR_TEST;
    expect(src).toContain('vec3 rgbToHsv(vec3 c)');
    expect(src).toContain('float hueDistance(float a, float b)');
    // The satGate from chromakey.ts: smoothstep(0.04, 0.18, <sat>).
    expect(src).toContain('smoothstep(0.04, 0.18,');
    // uniforms for the HSV key colour (the old single uKey is gone).
    expect(src).toContain('uniform float uKeyR;');
    expect(src).toContain('uniform float uKeyG;');
    expect(src).toContain('uniform float uKeyB;');
    expect(src).not.toContain('uniform float uKey;');
  });
});
