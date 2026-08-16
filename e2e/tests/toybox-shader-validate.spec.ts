// e2e/tests/toybox-shader-validate.spec.ts
//
// THE COMPILE PROBE, AGAINST A REAL GLSL COMPILER (#1576, workstream 3).
//
// ── Why this spec exists in this lane, and not as a unit test ───────────────
//
// `toybox-shader-validate.test.ts` covers the PURE half (log parsing, the
// compiler-line → source-line mapping) in the node `unit` lane. It cannot
// compile anything: there is no WebGL context there. So the half that matters
// most — that a REAL compiler's real output flows through the parser and comes
// out pointing at the right line — needs a browser.
//
// ── WHERE THIS ACTUALLY RUNS (established, not assumed) ────────────────────
//
// CLAUDE.md: *a gate that cannot fail on CI is decoration.* Two traps here, both
// checked before writing this:
//
//   1. CI's only renderer is SwiftShader. That is fine: shader compilation is
//      ANGLE's ESSL translator and needs NO GPU. The REQUIRED `webgl-smoke` job
//      already describes its own floor as asserting "a shader compiles".
//   2. ⚠ This file matches `**/toybox-*.spec.ts`, a WEBGL_HEAVY glob — and heavy
//      specs are NOT RUN ON PRs AT ALL (the `e2e-video` lane was deleted
//      2026-06-20). A spec that only lived there would be decoration exactly as
//      warned. It runs anyway because the `webgl-smoke` job leaves
//      `E2E_WEBGL_HEAVY` UNSET (= run everything) and selects by
//      `--grep "@webgl-smoke"`. So the tag is not decoration here, it is the
//      ONLY reason these tests execute on a PR. Do not remove it.
//
// There is deliberately NO capability skip. If WebGL2 is missing the probe
// THROWS and this spec goes red, because a validator that quietly passes when it
// could not look is worse than no validator.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';

interface Diagnostic {
  severity: 'error' | 'warning';
  line: number | null;
  message: string;
  raw: string;
}
interface Validation {
  ok: boolean;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  rawLog: string;
}

async function validate(page: Page, src: string, paramNames: string[] = []): Promise<Validation> {
  return page.evaluate(
    ([s, names]) =>
      (
        window as unknown as {
          __toyboxValidateShader: (src: string, p?: string[]) => Promise<Validation>;
        }
      ).__toyboxValidateShader(s as string, names as string[]),
    [src, paramNames] as const,
  );
}

test.describe('TOYBOX shader validation — real GLSL compiler', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // The hook is installed by +layout.svelte under testHooksEnabled(). If it is
    // absent the build lost VITE_E2E_HOOKS — fail LOUDLY rather than skip, or
    // every assertion below would silently stop meaning anything.
    await expect
      .poll(
        () =>
          page.evaluate(
            () => typeof (window as unknown as Record<string, unknown>).__toyboxValidateShader,
          ),
        { message: '__toyboxValidateShader hook must be installed (VITE_E2E_HOOKS=1 build)' },
      )
      .toBe('function');
  });

  // ------------------------------------------------------------------
  // The positive leg: a real, valid shader compiles.
  // ------------------------------------------------------------------
  test('a VALID Shadertoy source compiles clean @webgl-smoke', async ({ page }) => {
    const res = await validate(
      page,
      `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  fragColor = vec4(uv, 0.5 + 0.5 * sin(iTime), 1.0);
}`,
    );
    expect(res.errors, `unexpected errors: ${res.rawLog}`).toEqual([]);
    expect(res.ok).toBe(true);
  });

  test('a VALID plain main() engine source compiles clean @webgl-smoke', async ({ page }) => {
    // The non-Shadertoy branch takes a different path (no wrapper at all), so a
    // green Shadertoy leg says nothing about it.
    const res = await validate(
      page,
      `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = vec4(vUv, 0.0, 1.0); }`,
    );
    expect(res.errors, `unexpected errors: ${res.rawLog}`).toEqual([]);
    expect(res.ok).toBe(true);
  });

  test('engine-provided uniforms need no declaration @webgl-smoke', async ({ page }) => {
    // Validating the bare text instead of the wrapped text would report iTime,
    // iMouse and iChannel0 as undeclared for essentially every Shadertoy source
    // — the failure mode that makes a validator useless. This is the guard.
    const res = await validate(
      page,
      `void mainImage(out vec4 c, in vec2 p) {
  c = texture(iChannel0, p / iResolution.xy) * iMouse.x * iTime * float(iFrame);
}`,
    );
    expect(res.errors, `engine uniforms wrongly reported: ${res.rawLog}`).toEqual([]);
    expect(res.ok).toBe(true);
  });

  test('an injected PARAM uniform is declared for the source @webgl-smoke', async ({ page }) => {
    // The engine injects `uniform float <name>;` for each content param, so a
    // source using its params must validate when those names are passed in…
    const src = `void mainImage(out vec4 c, in vec2 p) { c = vec4(speed, scale, 0.0, 1.0); }`;
    const withParams = await validate(page, src, ['speed', 'scale']);
    expect(withParams.errors, `params not injected: ${withParams.rawLog}`).toEqual([]);
    expect(withParams.ok).toBe(true);

    // …and must FAIL without them. This is the negative control for the leg
    // above: without it, a validator that ignored `paramNames` entirely would
    // look identical.
    const without = await validate(page, src, []);
    expect(without.ok).toBe(false);
    expect(without.errors.length).toBeGreaterThan(0);
  });

  // ------------------------------------------------------------------
  // The negative leg: broken shaders are REJECTED, with usable positions.
  // ------------------------------------------------------------------
  test('a BROKEN source is rejected with structured errors @webgl-smoke', async ({ page }) => {
    const res = await validate(
      page,
      `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = thisIsNotAFunction(fragCoord);
}`,
    );
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    // Structured, not a blob: every error carries a message, and at least one
    // names the offending symbol.
    for (const e of res.errors) expect(e.message.length).toBeGreaterThan(0);
    expect(res.errors.map((e) => e.message).join(' ')).toContain('thisIsNotAFunction');
  });

  test('the reported LINE is the user own line, not the wrapped line @webgl-smoke', async ({
    page,
  }) => {
    // THE ASSERTION THIS WHOLE SPEC EXISTS FOR. The engine prepends ~21 lines
    // before the user's body, so an unmapped compiler line would point roughly
    // 21 lines past the end of a short shader — plausible-looking and useless.
    // Put the ONLY error on a known line and demand exactly that number back.
    const src = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  float ok = 1.0;
  fragColor = vec4(ok);
  undefinedSymbolOnLineFive;
}`;
    const res = await validate(page, src);
    expect(res.ok).toBe(false);
    const positioned = res.errors.filter((e) => e.line !== null);
    expect(positioned.length, `no positioned error in: ${res.rawLog}`).toBeGreaterThan(0);
    // Line 4 of the source above (1-based) holds the bad symbol.
    expect(positioned.map((e) => e.line)).toContain(4);
  });

  test('a #version line in the user source does not shift the reported line @webgl-smoke', async ({
    page,
  }) => {
    // The wrapper STRIPS a leading #version from the body, so without the
    // compensating correction every line would come back one short. The two
    // sources below differ ONLY by that line, and both errors sit on their own
    // file's line 4 — so a missing correction shows up as 3 here.
    const src = `#version 300 es
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = vec4(1.0);
  bogusSymbolHere;
}`;
    const res = await validate(page, src);
    expect(res.ok).toBe(false);
    const lines = res.errors.filter((e) => e.line !== null).map((e) => e.line);
    expect(lines, `raw: ${res.rawLog}`).toContain(4);
  });

  test('an EMPTY source is rejected rather than passing vacuously @webgl-smoke', async ({
    page,
  }) => {
    const res = await validate(page, '');
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
  });
});
