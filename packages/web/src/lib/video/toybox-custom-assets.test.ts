// packages/web/src/lib/video/toybox-custom-assets.test.ts
//
// The bridge from a user-supplied SOURCE to a registered ASSET (#1576).
//
// ⚠ SCOPE — what these tests CANNOT see:
//   * Whether any of these shaders COMPILE. `registerCustomShaderSource` is
//     pure string work; a source that is total nonsense registers perfectly
//     happily. Compile validity is toybox-shader-validate.
//   * Whether the ENGINE applies the registered params. It does not yet — this
//     PR lands registration, not consumption.
//   * Whether a RACK-MATE sees the registration. It does not, by design; what
//     converges is the derivation, because the id is a pure hash of bytes that
//     already sync. The "same source ⇒ same id and params" test below is the
//     property that makes that true, and is the closest a unit test can get.

import { describe, it, expect, beforeEach } from 'vitest';
import { registerCustomShaderSource, unregisterCustomShaderSource } from './toybox-custom-assets';
import { clearRuntimeToyboxAssets, runtimeToyboxProvider } from './toybox-asset-registry';
import { customShaderKey, getContentMeta, listAllContent } from './toybox-content';

const PLAIN_GLSL = `
uniform float speed;   // @param(0, 4, 1, linear)
uniform float scale;   // @param(0.5, 8, 2)
out vec4 outColor;
void main() {
  outColor = vec4(speed, scale, 0.0, 1.0);
}
`;

const SHADERTOY_GLSL = `
uniform float warp; // @param(-1, 1, 0)
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = vec4(warp, iTime, 0.0, 1.0);
}
`;

beforeEach(() => {
  clearRuntimeToyboxAssets();
});

describe('registerCustomShaderSource', () => {
  it('makes the source resolvable by its customShaderKey via the ordinary SYNC getter', () => {
    const { id } = registerCustomShaderSource(PLAIN_GLSL, 'my-shader.glsl');
    expect(id).toBe(customShaderKey(PLAIN_GLSL));
    const meta = getContentMeta(id);
    expect(meta).toBeDefined();
    expect(meta?.label).toBe('my-shader.glsl');
  });

  it('carries the params extracted from the source own uniform declarations', () => {
    const { id, params } = registerCustomShaderSource(PLAIN_GLSL, 'x.glsl');
    expect(params.map((p) => p.id)).toEqual(['speed', 'scale']);
    // …and the SAME params are what a downstream sync lookup sees, which is the
    // whole point of routing through the registry rather than returning them.
    expect(getContentMeta(id)?.params).toEqual(params);
    const speed = params.find((p) => p.id === 'speed')!;
    expect({ min: speed.min, max: speed.max, default: speed.default }).toEqual({
      min: 0,
      max: 4,
      default: 1,
    });
  });

  it('is UNLISTED — it adds nothing to the content dropdown', async () => {
    const { id } = registerCustomShaderSource(PLAIN_GLSL, 'x.glsl');
    const listed = await listAllContent().catch(() => []);
    expect(listed.map((c) => c.id)).not.toContain(id);
  });

  it('marks the entry inlineSource so nothing ever tries to fetch it', () => {
    const { id } = registerCustomShaderSource(PLAIN_GLSL, 'x.glsl');
    expect(getContentMeta(id)?.inlineSource).toBe(true);
  });

  it('detects the Shadertoy convention and classifies the family accordingly', () => {
    const st = registerCustomShaderSource(SHADERTOY_GLSL, 'toy.glsl');
    const plain = registerCustomShaderSource(PLAIN_GLSL, 'plain.glsl');
    expect(getContentMeta(st.id)?.family).toBe('FRAG');
    expect(getContentMeta(st.id)?.input).toBe('scene');
    expect(getContentMeta(st.id)?.shadertoy).toBe(true);
    // Negative control: a plain main() source must NOT be classified as a FRAG,
    // or every custom shader would be handed the scene as iChannel0.
    expect(getContentMeta(plain.id)?.family).toBe('GEN');
    expect(getContentMeta(plain.id)?.input).toBe('none');
  });

  it('does not sprout a fader for an engine-provided uniform', () => {
    // The exclusion set is derived in toybox-shader-params; this asserts the
    // bridge does not undo it on the way through.
    const { params } = registerCustomShaderSource(
      'uniform float iTime;\nuniform float mine;\nvoid mainImage(out vec4 c, in vec2 p){c=vec4(mine);}',
      'z.glsl',
    );
    expect(params.map((p) => p.id)).toEqual(['mine']);
  });

  it('reports extraction diagnostics rather than swallowing them', () => {
    const { diagnostics } = registerCustomShaderSource(
      'uniform float bad; // @param(5, 1)\nvoid main(){}',
      'bad.glsl',
    );
    expect(diagnostics.map((d) => d.kind)).toContain('empty-range');
  });
});

describe('the id is a pure function of the SOURCE — the convergence property', () => {
  it('same text ⇒ same id and identical params, regardless of the filename', () => {
    // This is what lets two peers derive the same asset from the same synced
    // bytes without exchanging anything: the label is incidental, the id is not.
    const a = registerCustomShaderSource(PLAIN_GLSL, 'peer-a-name.glsl');
    const b = registerCustomShaderSource(PLAIN_GLSL, 'totally-different.frag');
    expect(b.id).toBe(a.id);
    expect(b.params).toEqual(a.params);
  });

  it('different text ⇒ different id', () => {
    const a = registerCustomShaderSource(PLAIN_GLSL, 'a.glsl');
    const b = registerCustomShaderSource(SHADERTOY_GLSL, 'b.glsl');
    expect(b.id).not.toBe(a.id);
    expect(getContentMeta(a.id)).toBeDefined();
    expect(getContentMeta(b.id)).toBeDefined();
  });

  it('re-registering the same source is idempotent, not a duplicate', () => {
    const a = registerCustomShaderSource(PLAIN_GLSL, 'a.glsl');
    registerCustomShaderSource(PLAIN_GLSL, 'a.glsl');
    registerCustomShaderSource(PLAIN_GLSL, 'a.glsl');
    expect(getContentMeta(a.id)).toBeDefined();
    // Idempotence has to be measured ON THE PROVIDER: a Map-keyed store would
    // dedupe silently, but an array-backed one would grow three entries and
    // still resolve correctly — so ask how many are actually held.
    const held = runtimeToyboxProvider.content().filter((e) => e.asset.id === a.id);
    expect(held).toHaveLength(1);
  });

  it('registering a DIFFERENT source really does add a second entry', () => {
    // Negative control for the idempotence assertion above: it must be able to
    // read "2", or "1" proves nothing.
    registerCustomShaderSource(PLAIN_GLSL, 'a.glsl');
    registerCustomShaderSource(SHADERTOY_GLSL, 'b.glsl');
    expect(runtimeToyboxProvider.content()).toHaveLength(2);
  });

  it('never collides with a manifest id, so it is always effective', () => {
    // The `custom-shader:` prefix is what makes the precedence rule a non-issue
    // for this path. Assert the prefix rather than trusting the comment.
    const { id, registration } = registerCustomShaderSource(PLAIN_GLSL, 'a.glsl');
    expect(id.startsWith('custom-shader:')).toBe(true);
    expect(registration.effective).toBe(true);
    expect(registration.shadowedBy).toBeUndefined();
  });
});

describe('unregisterCustomShaderSource', () => {
  it('removes the entry, keyed by the same source text', () => {
    const { id } = registerCustomShaderSource(PLAIN_GLSL, 'a.glsl');
    expect(getContentMeta(id)).toBeDefined();
    expect(unregisterCustomShaderSource(PLAIN_GLSL)).toBe(true);
    expect(getContentMeta(id)).toBeUndefined();
  });

  it('returns false for a source that was never registered', () => {
    expect(unregisterCustomShaderSource('void main(){}  // never seen')).toBe(false);
  });
});

describe('label handling', () => {
  it('falls back to a readable label when the filename is missing or blank', () => {
    const a = registerCustomShaderSource(PLAIN_GLSL, null);
    expect(getContentMeta(a.id)?.label).toBe('CUSTOM SHADER');
    clearRuntimeToyboxAssets();
    const b = registerCustomShaderSource(PLAIN_GLSL, '   ');
    expect(getContentMeta(b.id)?.label).toBe('CUSTOM SHADER');
  });
});
