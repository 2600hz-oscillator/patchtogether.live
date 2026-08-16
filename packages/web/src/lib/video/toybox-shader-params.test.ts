// packages/web/src/lib/video/toybox-shader-params.test.ts
//
// Gate for #1576 workstream 1's param extraction.
//
// ⚠ SCOPE — what these tests structurally CANNOT see: whether a shader that
// declares these uniforms actually COMPILES, and whether the extracted range is
// musically sensible. The first is `validateToyboxShader`'s job; the second is
// unanswerable from source and is exactly why `@param` exists. A green run here
// means "the declarations were read correctly", not "this shader is good".

import { describe, it, expect } from 'vitest';
import {
  extractShaderParams,
  labelForUniform,
  ENGINE_RESERVED_UNIFORMS,
  UNANNOTATED_RANGE,
} from './toybox-shader-params';
import { SHADERTOY_UNIFORM_BLOCK } from './toybox-shadertoy';

describe('the engine-reserved set is DERIVED from the block the engine prepends', () => {
  it('contains every uniform SHADERTOY_UNIFORM_BLOCK declares — both directions', () => {
    const declared = [...SHADERTOY_UNIFORM_BLOCK.matchAll(/^\s*uniform\s+\w+\s+(\w+)/gm)].map(
      (m) => m[1],
    );
    expect([...ENGINE_RESERVED_UNIFORMS].sort()).toEqual([...new Set(declared)].sort());
  });

  it('is NOT VACUOUS and covers the names that actually matter', () => {
    expect(ENGINE_RESERVED_UNIFORMS.size).toBeGreaterThan(0);
    for (const n of ['iTime', 'iResolution', 'iMouse', 'iFrame']) {
      expect(ENGINE_RESERVED_UNIFORMS.has(n), `${n} must be reserved`).toBe(true);
    }
  });

  it('NEGATIVE CONTROL: an ordinary author name is NOT reserved', () => {
    for (const n of ['speed', 'scale', 'iterations', 'time']) {
      expect(ENGINE_RESERVED_UNIFORMS.has(n), `${n} must NOT be reserved`).toBe(false);
    }
  });
});

describe('extractShaderParams — declarations', () => {
  it('reads a plain uniform with no annotation, using the neutral range', () => {
    const { params } = extractShaderParams('uniform float speed;\nvoid main(){}');
    expect(params).toEqual([
      {
        id: 'speed',
        label: 'SPEED',
        min: UNANNOTATED_RANGE.min,
        max: UNANNOTATED_RANGE.max,
        default: UNANNOTATED_RANGE.default,
        curve: 'linear',
      },
    ]);
  });

  it('honours precision qualifiers and comma-declarator lists', () => {
    const { params } = extractShaderParams('uniform highp float a, b;\nuniform mediump float c;');
    expect(params.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops an initializer from the declarator', () => {
    const { params } = extractShaderParams('uniform float gain = 2.0;');
    expect(params.map((p) => p.id)).toEqual(['gain']);
  });

  it('extracts ONLY float — a vec3/int/sampler uniform offers no single fader', () => {
    const { params } = extractShaderParams(
      'uniform vec3 tint;\nuniform int steps;\nuniform sampler2D tex;\nuniform float mix1;',
    );
    expect(params.map((p) => p.id)).toEqual(['mix1']);
  });

  it('preserves declaration order', () => {
    const { params } = extractShaderParams(
      'uniform float zeta;\nuniform float alpha;\nuniform float mid;',
    );
    expect(params.map((p) => p.id)).toEqual(['zeta', 'alpha', 'mid']);
  });
});

describe('extractShaderParams — the engine-reserved exclusion', () => {
  it('SKIPS a user redeclaration of an engine uniform, with a reason', () => {
    const { params, diagnostics } = extractShaderParams(
      'uniform float iTime;\nuniform float speed;',
    );
    expect(params.map((p) => p.id)).toEqual(['speed']);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ id: 'iTime', kind: 'engine-reserved' });
    expect(diagnostics[0].detail.length).toBeGreaterThan(20);
  });

  it('NEGATIVE CONTROL: without the exclusion iTime WOULD have become a fader', () => {
    // Same source, engine name swapped for an author name. If the exclusion were
    // removed, the assertion above would look exactly like this one — so this
    // pins that the skip is caused by the NAME, not by the shape of the source.
    const { params, diagnostics } = extractShaderParams(
      'uniform float myTime;\nuniform float speed;',
    );
    expect(params.map((p) => p.id)).toEqual(['myTime', 'speed']);
    expect(diagnostics).toEqual([]);
  });
});

describe('extractShaderParams — @param annotations', () => {
  it('reads min,max,default,curve from the declaration line', () => {
    const { params } = extractShaderParams('uniform float speed; // @param(0, 4, 1, log)');
    expect(params[0]).toMatchObject({ min: 0, max: 4, default: 1, curve: 'log' });
  });

  it('reads an annotation on the line ABOVE the declaration', () => {
    const { params } = extractShaderParams('// @param(0.5, 6, 2, linear)\nuniform float scale;');
    expect(params[0]).toMatchObject({ min: 0.5, max: 6, default: 2 });
  });

  it('defaults to the range MIDPOINT when only min,max are given', () => {
    const { params } = extractShaderParams('uniform float w; // @param(2, 8)');
    expect(params[0]).toMatchObject({ min: 2, max: 8, default: 5 });
  });

  it('accepts negatives and exponents', () => {
    const { params } = extractShaderParams('uniform float bipolar; // @param(-1, 1, -0.25)');
    expect(params[0]).toMatchObject({ min: -1, max: 1, default: -0.25 });
  });

  it('an annotation does NOT leak onto an unrelated later uniform', () => {
    const { params } = extractShaderParams(
      '// @param(0, 9, 3, exp)\nuniform float annotated;\nuniform float plain;',
    );
    expect(params[0]).toMatchObject({ id: 'annotated', max: 9 });
    expect(params[1]).toMatchObject({ id: 'plain', max: UNANNOTATED_RANGE.max });
  });

  // REGRESSION: a TRAILING annotation used to leak onto the NEXT line's uniform,
  // because "the line above" was consulted unconditionally. Caught by the
  // realistic end-to-end shader, not by the case above — there the annotation sat
  // on its own line, so the leak could not fire. The two shapes are different.
  it('a TRAILING annotation does not leak onto the uniform on the next line', () => {
    const { params } = extractShaderParams(
      'uniform float warp; // @param(-1, 1, 0)\nuniform float plain;',
    );
    expect(params[0]).toMatchObject({ id: 'warp', min: -1, max: 1, default: 0 });
    expect(params[1]).toMatchObject({
      id: 'plain',
      min: UNANNOTATED_RANGE.min,
      max: UNANNOTATED_RANGE.max,
      default: UNANNOTATED_RANGE.default,
    });
  });

  it('a standalone annotation still reaches past a NON-uniform line? no — it must be adjacent', () => {
    const { params } = extractShaderParams(
      '// @param(0, 9, 3)\n\nuniform float faraway;',
    );
    expect(params[0]).toMatchObject({ id: 'faraway', max: UNANNOTATED_RANGE.max });
  });
});

describe('extractShaderParams — malformed input is REPORTED, never silently dropped', () => {
  it('an inverted range falls back and says so', () => {
    const { params, diagnostics } = extractShaderParams('uniform float x; // @param(5, 1)');
    expect(params[0]).toMatchObject({ min: UNANNOTATED_RANGE.min, max: UNANNOTATED_RANGE.max });
    expect(diagnostics[0]).toMatchObject({ id: 'x', kind: 'empty-range' });
  });

  it('a zero-width range is NOT a range', () => {
    const { diagnostics } = extractShaderParams('uniform float x; // @param(3, 3)');
    expect(diagnostics[0]).toMatchObject({ kind: 'empty-range' });
  });

  it('a default outside the range is CLAMPED and reported', () => {
    const { params, diagnostics } = extractShaderParams('uniform float x; // @param(0, 1, 4)');
    expect(params[0].default).toBe(1);
    expect(diagnostics[0]).toMatchObject({ kind: 'default-out-of-range' });
  });

  it('a word-salad annotation reports rather than inventing a range', () => {
    const { params, diagnostics } = extractShaderParams('uniform float x; // @param(fast, slow)');
    expect(params[0]).toMatchObject({ min: UNANNOTATED_RANGE.min, max: UNANNOTATED_RANGE.max });
    expect(diagnostics[0]).toMatchObject({ kind: 'malformed-annotation' });
  });

  it('a duplicate declaration keeps the FIRST and reports the second', () => {
    const { params, diagnostics } = extractShaderParams(
      'uniform float x; // @param(0, 10)\nuniform float x; // @param(0, 99)',
    );
    expect(params).toHaveLength(1);
    expect(params[0].max).toBe(10);
    expect(diagnostics[0]).toMatchObject({ id: 'x', kind: 'duplicate' });
  });

  it('every diagnostic carries a detail a human can act on', () => {
    const { diagnostics } = extractShaderParams(
      'uniform float iTime;\nuniform float x; // @param(5, 1)\nuniform float x;',
    );
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const d of diagnostics) {
      expect(d.detail.length, `${d.kind} detail is too short to explain itself`).toBeGreaterThan(20);
      expect(d.detail).toContain(d.id);
    }
  });
});

describe('extractShaderParams — comment handling', () => {
  it('ignores a uniform that is COMMENTED OUT (line comment)', () => {
    const { params } = extractShaderParams('// uniform float ghost;\nuniform float real;');
    expect(params.map((p) => p.id)).toEqual(['real']);
  });

  it('ignores a uniform inside a BLOCK comment', () => {
    const { params } = extractShaderParams('/*\nuniform float ghost;\n*/\nuniform float real;');
    expect(params.map((p) => p.id)).toEqual(['real']);
  });

  it('an unterminated block comment swallows the rest, and does not crash', () => {
    const { params } = extractShaderParams('uniform float real;\n/* uniform float ghost;');
    expect(params.map((p) => p.id)).toEqual(['real']);
  });

  it('block-comment line accounting stays correct for a later annotation', () => {
    const src = '/* header\n   spanning\n   lines */\n// @param(0, 3, 1)\nuniform float speed;';
    const { params } = extractShaderParams(src);
    expect(params[0]).toMatchObject({ id: 'speed', min: 0, max: 3, default: 1 });
  });
});

describe('labelForUniform — manifest style', () => {
  it('uppercases and splits camelCase / snake_case / kebab-case', () => {
    expect(labelForUniform('speed')).toBe('SPEED');
    expect(labelForUniform('flowField')).toBe('FLOW FIELD');
    expect(labelForUniform('flow_field')).toBe('FLOW FIELD');
    expect(labelForUniform('flow-field')).toBe('FLOW FIELD');
  });
});

describe('a realistic user shader end-to-end', () => {
  const SRC = `
// A pasted Shadertoy-style effect.
uniform float iTime;          // redeclared by the author; engine owns it
uniform vec2  iChannelOffset; // not a float
// @param(0.5, 8, 2, log)
uniform float zoom;
uniform float warp;           // @param(-1, 1, 0)
uniform float unlabelled;

void mainImage(out vec4 o, in vec2 c) { o = vec4(zoom, warp, unlabelled, 1.0); }
`;

  it('offers exactly the author-controllable floats, in order', () => {
    const { params } = extractShaderParams(SRC);
    expect(params.map((p) => p.id)).toEqual(['zoom', 'warp', 'unlabelled']);
  });

  it('carries the annotated ranges and the neutral fallback', () => {
    const { params } = extractShaderParams(SRC);
    expect(params[0]).toMatchObject({ min: 0.5, max: 8, default: 2, curve: 'log' });
    expect(params[1]).toMatchObject({ min: -1, max: 1, default: 0 });
    expect(params[2]).toMatchObject({ min: UNANNOTATED_RANGE.min, max: UNANNOTATED_RANGE.max });
  });

  it('explains the one thing it refused', () => {
    const { diagnostics } = extractShaderParams(SRC);
    expect(diagnostics.map((d) => d.kind)).toEqual(['engine-reserved']);
    expect(diagnostics[0].id).toBe('iTime');
  });

  it('produces the manifest ToyboxParamDef shape exactly — no extra keys', () => {
    const { params } = extractShaderParams(SRC);
    for (const p of params) {
      expect(Object.keys(p).sort()).toEqual(['curve', 'default', 'id', 'label', 'max', 'min']);
    }
  });
});
