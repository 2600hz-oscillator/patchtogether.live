// packages/web/src/lib/video/toybox-shader-validate.test.ts
//
// The PURE half of shader validation (#1576, workstream 3): log parsing and the
// compiler-line → source-line mapping.
//
// ⚠ SCOPE — what these tests CANNOT see, and where that is covered instead:
//   * They never compile anything. There is no WebGL context in the node `unit`
//     lane, so `validateToyboxShader` itself is exercised by
//     `e2e/tests/toybox-shader-validate.spec.ts`, tagged `@webgl-smoke`, which
//     runs on SwiftShader in the REQUIRED webgl-smoke job on every PR.
//   * The log strings below are FIXTURES of formats seen in the wild. If a
//     driver invents a new shape, this file stays green and the e2e is what
//     notices — which is why the e2e asserts a parsed line number off a REAL
//     compiler, not a fixture.
//   * Nothing here proves a rejected shader is genuinely invalid, only that a
//     rejection is reported in a shape the UI can use.

import { describe, it, expect } from 'vitest';
import {
  parseShaderCompileLog,
  mapCompilerLineToSource,
  shadertoyPreambleLines,
  SHADERTOY_PROVIDED_UNIFORMS,
} from './toybox-shader-validate';
import { wrapShadertoySource, SHADERTOY_UNIFORM_BLOCK } from './toybox-shadertoy';

describe('parseShaderCompileLog — ANGLE / SwiftShader / Chrome format', () => {
  it('parses severity, line and message out of the canonical shape', () => {
    const d = parseShaderCompileLog(
      "ERROR: 0:12: 'nosuchthing' : undeclared identifier",
    );
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      severity: 'error',
      line: 12,
      message: "'nosuchthing' : undeclared identifier",
    });
  });

  it('parses warnings distinctly from errors', () => {
    const d = parseShaderCompileLog('WARNING: 0:3: unused variable');
    expect(d[0]!.severity).toBe('warning');
    expect(d[0]!.line).toBe(3);
  });

  it('parses several diagnostics from one log, in order', () => {
    const d = parseShaderCompileLog(
      [
        "ERROR: 0:4: 'a' : undeclared identifier",
        'WARNING: 0:9: something minor',
        "ERROR: 0:20: 'b' : syntax error",
      ].join('\n'),
    );
    expect(d.map((x) => [x.severity, x.line])).toEqual([
      ['error', 4],
      ['warning', 9],
      ['error', 20],
    ]);
  });

  it('keeps the compiler original text verbatim in raw', () => {
    const line = "ERROR: 0:12: 'x' : undeclared identifier";
    expect(parseShaderCompileLog(line)[0]!.raw).toBe(line);
  });

  it('strips the NUL terminator drivers append', () => {
    const d = parseShaderCompileLog("ERROR: 0:2: 'x' : bad\0\0");
    expect(d[0]!.message).toBe("'x' : bad");
    expect(d[0]!.message).not.toContain('\0');
  });

  it('ignores blank lines rather than emitting empty diagnostics', () => {
    expect(parseShaderCompileLog('\n\n   \n')).toEqual([]);
    expect(parseShaderCompileLog('')).toEqual([]);
  });
});

describe('parseShaderCompileLog — other driver shapes', () => {
  it('parses the Mesa "0:12(5): error:" form', () => {
    const d = parseShaderCompileLog('0:12(5): error: syntax error, unexpected $end');
    expect(d[0]).toMatchObject({ severity: 'error', line: 12 });
    expect(d[0]!.message).toBe('syntax error, unexpected $end');
  });

  it('parses a severity with no position as line: null', () => {
    const d = parseShaderCompileLog('ERROR: too many uniforms');
    expect(d[0]).toMatchObject({ severity: 'error', line: null, message: 'too many uniforms' });
  });

  it('KEEPS an unrecognised line as an error rather than dropping it', () => {
    // Swallowing an unparseable diagnostic would let a real failure surface as
    // "no errors" — the single worst outcome for a load gate.
    const d = parseShaderCompileLog('something the parser has never seen');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: 'error', line: null });
    expect(d[0]!.message).toBe('something the parser has never seen');
  });
});

describe('shadertoyPreambleLines — DERIVED, never a literal', () => {
  it('locates the body exactly where the real wrapper puts it', () => {
    // The independent check: wrap a marker for real and find it. If the derived
    // offset and the wrapper ever disagree, every reported line number is wrong.
    const marker = 'MARKER_BODY_LINE';
    const wrapped = wrapShadertoySource(marker, '', []);
    const actual = wrapped.split('\n').findIndex((l) => l.includes(marker));
    expect(shadertoyPreambleLines([], '')).toBe(actual);
  });

  it('tracks the param block exactly — including its counter-intuitive empty case', () => {
    // MEASURED (0→21, 1→21, 2→22, 3→23), and this is the case FOR deriving.
    // The wrapper interpolates `${paramDecls}` on a line of its own, and an
    // EMPTY join still occupies that line. So zero params and one param yield
    // the SAME preamble, and it grows one line per param only from the second
    // onward. A hand-typed `BASE + paramNames.length` would be off by one for
    // every shader that declares params — pointing every diagnostic at the
    // wrong line, silently. Deriving from the wrapper is exact by construction.
    const none = shadertoyPreambleLines([], '');
    const one = shadertoyPreambleLines(['speed'], '');
    const two = shadertoyPreambleLines(['speed', 'scale'], '');
    const three = shadertoyPreambleLines(['speed', 'scale', 'warp'], '');
    expect(one).toBe(none);
    // Negative control in the MOVING direction: the offset must actually track
    // the param list, or a hard-coded constant would satisfy the line above.
    expect(two - one).toBe(1);
    expect(three - two).toBe(1);
  });

  it('grows with the common chunk too', () => {
    const none = shadertoyPreambleLines([], '');
    const withCommon = shadertoyPreambleLines([], 'float helper(){return 1.0;}\nfloat h2(){return 2.0;}');
    expect(withCommon).toBeGreaterThan(none);
  });

  it('does not count a param name the wrapper refuses to inject', () => {
    // The wrapper skips names that collide with a Shadertoy uniform, so the
    // offset must not move for those — otherwise the correction over-shoots.
    expect(shadertoyPreambleLines(['iTime'], '')).toBe(shadertoyPreambleLines([], ''));
  });
});

describe('mapCompilerLineToSource', () => {
  it('subtracts the preamble so line N of the user source reports as N', () => {
    const preamble = shadertoyPreambleLines([], '');
    // The user's line 1 is the first line after the preamble.
    expect(mapCompilerLineToSource(preamble + 1, preamble, false)).toBe(1);
    expect(mapCompilerLineToSource(preamble + 7, preamble, false)).toBe(7);
  });

  it('adds back the #version line the wrapper strips', () => {
    // With a #version line, the user's line 2 becomes body line 1. So a
    // diagnostic at the first body line is really the user's line 2.
    const preamble = shadertoyPreambleLines([], '');
    expect(mapCompilerLineToSource(preamble + 1, preamble, true)).toBe(2);
  });

  it('reports a diagnostic INSIDE the preamble as position-less', () => {
    // Pointing at a line the user cannot see is worse than admitting we do not
    // know which line it was.
    const preamble = shadertoyPreambleLines([], '');
    expect(mapCompilerLineToSource(2, preamble, false)).toBeNull();
    expect(mapCompilerLineToSource(preamble, preamble, false)).toBeNull();
  });

  it('is the identity when nothing was prepended (a plain main() source)', () => {
    // A non-Shadertoy source is compiled verbatim, so no correction applies at
    // all — and a correction wrongly applied there would be silently off-by-N.
    expect(mapCompilerLineToSource(12, 0, false)).toBe(12);
  });
});

describe('SHADERTOY_PROVIDED_UNIFORMS is derived from the engine block', () => {
  it('lists exactly the uniforms the engine actually prepends', () => {
    // Asserted BOTH directions against the block itself, so adding a uniform to
    // the engine block cannot drift this list.
    const fromBlock = [...SHADERTOY_UNIFORM_BLOCK.matchAll(/^\s*uniform\s+\w+\s+(\w+)/gm)].map(
      (m) => m[1],
    );
    expect([...SHADERTOY_PROVIDED_UNIFORMS].sort()).toEqual([...fromBlock].sort());
  });

  it('contains iTime and iResolution, and NOT an ordinary author name', () => {
    expect(SHADERTOY_PROVIDED_UNIFORMS).toContain('iTime');
    expect(SHADERTOY_PROVIDED_UNIFORMS).toContain('iResolution');
    expect(SHADERTOY_PROVIDED_UNIFORMS).not.toContain('speed');
  });
});
