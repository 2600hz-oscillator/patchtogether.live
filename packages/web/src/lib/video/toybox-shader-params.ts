// packages/web/src/lib/video/toybox-shader-params.ts
//
// FIRST-CLASS PARAM EXTRACTION FOR ARBITRARY GLSL (#1576, workstream 1).
//
// ── Why this exists, and why it is NOT how bundled content works ────────────
//
// A BUNDLED TOYBOX shader does not declare its own params. `caustic-pool.glsl`
// simply *uses* `speed` and `scale` as bare identifiers, and the engine injects
// the matching `uniform float` declarations from the manifest's `params[]`. The
// manifest is the single source of truth there, and it is hand-maintained.
//
// A USER-SUPPLIED shader has no manifest entry. It declares its own uniforms,
// the ordinary way any GLSL does:
//
//     uniform float speed;   // @param(0, 4, 1, linear)
//
// This module turns those declarations into the SAME `ToyboxParamDef[]` shape
// the manifest carries, so a disk-loaded (and later, pasted) shader gets card
// faders, CV targets and randomize targets exactly like a bundled one — without
// a second code path downstream. Everything after extraction is shared.
//
// ⚠ THE EXCLUSION SET IS DERIVED, NEVER TYPED. Shadertoy sources are compiled
// with `SHADERTOY_UNIFORM_BLOCK` prepended, so `iTime`, `iResolution`, `iMouse`
// and friends are ALREADY declared by the engine. A user shader that declares
// `uniform float iTime;` itself must not sprout an "ITIME" fader — that control
// would fight the engine's own per-frame write and read as a dead knob. The
// reserved set is parsed OUT of `SHADERTOY_UNIFORM_BLOCK` at module load, so
// adding a uniform to that block automatically excludes it here and the two
// cannot drift. `toybox-shader-params.test.ts` asserts that derivation both
// ways.
//
// ⚠ GLSL HAS NO STRING LITERALS, which is the one reason the comment handling
// below can be a scanner rather than a full parser. CLAUDE.md's warning that
// "string safety is a property of the PARSER, not of a pattern" is about
// TypeScript, where a `//`-stripping regex eats `'https://x'`. That hazard does
// not exist in GLSL — there is no token in which `//` is not a comment. If this
// ever needs to handle a language with strings, it needs a real lexer.

import { SHADERTOY_UNIFORM_BLOCK } from './toybox-shadertoy';
import type { ToyboxParamDef } from './toybox-content';

/** Fader curves a `@param` annotation may name — the `ToyboxParamDef` set. */
const CURVES = ['linear', 'log', 'exp', 'discrete'] as const;
type Curve = (typeof CURVES)[number];

function isCurve(s: string): s is Curve {
  return (CURVES as readonly string[]).includes(s);
}

/**
 * Uniform names the ENGINE already declares for a Shadertoy-convention source,
 * DERIVED from the block the engine actually prepends. Never hand-listed.
 */
export const ENGINE_RESERVED_UNIFORMS: ReadonlySet<string> = new Set(
  [...SHADERTOY_UNIFORM_BLOCK.matchAll(/^\s*uniform\s+\w+\s+(\w+)/gm)].map((m) => m[1]),
);

/** Defaults for a uniform declared WITHOUT a `@param` annotation.
 *  0..1 is the honest neutral choice: the source states no range, so inventing
 *  a wider one would put the fader's travel somewhere the author never implied.
 *  The annotation exists precisely to say otherwise. */
export const UNANNOTATED_RANGE = { min: 0, max: 1, default: 0.5, curve: 'linear' as Curve };

/** Why a declared uniform did not become a param, or was adjusted. */
export interface ShaderParamDiagnostic {
  /** The uniform name the diagnostic is about. */
  id: string;
  kind:
    | 'engine-reserved' // shadows an engine-provided uniform; skipped
    | 'duplicate' // declared more than once; first wins
    | 'malformed-annotation' // `@param(...)` present but unparseable; defaults used
    | 'empty-range' // min >= max; defaults used
    | 'default-out-of-range'; // default outside [min,max]; clamped
  /** Human-readable detail, safe to surface in the load-error UI. */
  detail: string;
}

export interface ShaderParamExtraction {
  /** Extracted params, in declaration order — the manifest's `params[]` shape. */
  params: ToyboxParamDef[];
  /** Everything skipped or adjusted, so the UI can explain itself rather than
   *  silently dropping a control the author wrote. */
  diagnostics: ShaderParamDiagnostic[];
}

/**
 * Replace comment bodies with spaces, PRESERVING `@param(...)` annotations and
 * the source's line structure (so a `@param` on line N stays on line N).
 *
 * Returns the de-commented source plus, per line index, the raw text of any
 * `@param(...)` annotation found on that line.
 */
function scanComments(src: string): { code: string; annotations: Map<number, string> } {
  const annotations = new Map<number, string>();
  const out: string[] = [];
  let line = 0;
  let i = 0;
  let inBlock = false;

  const noteAnnotation = (text: string, atLine: number) => {
    const m = /@param\s*\(([^)]*)\)/.exec(text);
    if (m && !annotations.has(atLine)) annotations.set(atLine, m[1]);
  };

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        out.push('  ');
        i += 2;
        continue;
      }
      if (c === '\n') line++;
      out.push(c === '\n' ? '\n' : ' ');
      i++;
      continue;
    }

    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      noteAnnotation(src.slice(i, stop), line);
      out.push(' '.repeat(stop - i));
      i = stop;
      continue;
    }

    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      noteAnnotation(src.slice(i, stop), line);
      inBlock = end === -1;
      const chunk = src.slice(i, stop);
      for (const ch of chunk) {
        if (ch === '\n') {
          line++;
          out.push('\n');
        } else out.push(' ');
      }
      i = stop;
      inBlock = false;
      continue;
    }

    if (c === '\n') line++;
    out.push(c);
    i++;
  }

  return { code: out.join(''), annotations };
}

/** Parse an annotation body `min,max,default,curve` — every field optional. */
function parseAnnotation(
  body: string,
  id: string,
  diagnostics: ShaderParamDiagnostic[],
): { min: number; max: number; default: number; curve: Curve } {
  const parts = body
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const nums = parts.filter((p) => /^[-+]?[0-9]*\.?[0-9]+(e[-+]?\d+)?$/i.test(p)).map(Number);
  const curveTok = parts.find((p) => isCurve(p));

  if (parts.length > 0 && nums.length === 0 && !curveTok) {
    diagnostics.push({
      id,
      kind: 'malformed-annotation',
      detail: `@param(${body}) has no numbers and no curve name — using the ${UNANNOTATED_RANGE.min}..${UNANNOTATED_RANGE.max} default.`,
    });
    return { ...UNANNOTATED_RANGE };
  }

  let min = nums.length > 0 ? nums[0] : UNANNOTATED_RANGE.min;
  let max = nums.length > 1 ? nums[1] : UNANNOTATED_RANGE.max;
  let def = nums.length > 2 ? nums[2] : undefined;
  const curve = curveTok ?? UNANNOTATED_RANGE.curve;

  if (!(max > min)) {
    diagnostics.push({
      id,
      kind: 'empty-range',
      detail: `@param declares min=${min} max=${max}, which is not a range — using ${UNANNOTATED_RANGE.min}..${UNANNOTATED_RANGE.max}.`,
    });
    min = UNANNOTATED_RANGE.min;
    max = UNANNOTATED_RANGE.max;
    def = def === undefined ? undefined : def;
  }

  if (def === undefined) def = min + (max - min) / 2;

  if (def < min || def > max) {
    const clamped = Math.min(max, Math.max(min, def));
    diagnostics.push({
      id,
      kind: 'default-out-of-range',
      detail: `default ${def} is outside ${min}..${max} — clamped to ${clamped}.`,
    });
    def = clamped;
  }

  return { min, max, default: def, curve };
}

/**
 * Every uniform name the SOURCE declares itself, of ANY type.
 *
 * ── Why this is not just `extractShaderParams(...).params` ──────────────────
 *
 * Extraction answers "which CONTROLS does this shader offer" and is therefore
 * `float`-only and reserved-filtered. This answers a different, purely
 * syntactic question — "which names does this text already occupy at global
 * scope" — and so it must see `vec3`, `sampler2D`, an engine-reserved name and
 * a duplicate alike. A `uniform vec3 speed;` collides with an injected
 * `uniform float speed;` just as fatally as a matching one would.
 *
 * Array declarators (`uniform vec3 iChannelResolution[4];`) yield the bare name.
 * PURE; comment-safe (the same scanner extraction uses).
 */
export function declaredUniformNames(src: string): ReadonlySet<string> {
  const { code } = scanComments(src);
  const out = new Set<string>();
  // `uniform [precision] <type> a, b[2];` — any type, whole declarator list.
  const DECL = /\buniform\s+(?:lowp\s+|mediump\s+|highp\s+)?\w+\s+([^;{]+);/g;
  for (const m of code.matchAll(DECL)) {
    for (const rawDeclarator of m[1].split(',')) {
      const id = rawDeclarator
        .split('=')[0]
        .replace(/\[[^\]]*\]/g, '')
        .trim();
      if (/^[A-Za-z_]\w*$/.test(id)) out.add(id);
    }
  }
  return out;
}

/**
 * Of `paramIds`, the subset the SHADERTOY WRAPPER still has to declare — i.e.
 * those the source does not declare itself.
 *
 * ── The two conventions this reconciles, and why it is DERIVED ──────────────
 *
 * A BUNDLED Shadertoy content uses its params as BARE IDENTIFIERS and relies on
 * `wrapShadertoySource` to emit `uniform float <name>;` from the manifest. A
 * USER source DECLARES ITS OWN — that declaration is literally what extraction
 * read to produce the param — so emitting it again is a duplicate declaration at
 * global scope, and the whole program fails to compile. The failure is silent in
 * the worst way: the layer just never draws.
 *
 * The filter is read OFF THE SOURCE rather than off which branch the caller is
 * in, so it is one rule for both conventions and it also fixes the (currently
 * broken) case of a bundled Shadertoy shader that declares its own uniform.
 *
 * ⚠ CALLERS MUST PASS THE SAME LIST TO `wrapShadertoySource` AND TO
 * `shadertoyPreambleLines`. The preamble grows one line per DECLARED param, so
 * filtering one and not the other mis-points every compile diagnostic by the
 * number of names filtered out — silently. `toybox-shader-validate.ts` does both
 * from one variable for exactly that reason.
 *
 * PURE.
 */
export function paramsNeedingDeclaration(
  src: string,
  paramIds: readonly string[],
): string[] {
  const declared = declaredUniformNames(src);
  return paramIds.filter((id) => !declared.has(id));
}

/** `flowField` / `flow_field` / `flow-field` → `FLOW FIELD` (manifest style). */
export function labelForUniform(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toUpperCase();
}

/**
 * Extract card/CV/randomize params from arbitrary GLSL by reading its own
 * `uniform float` declarations.
 *
 * Handles precision qualifiers (`uniform highp float x;`) and comma lists
 * (`uniform float a, b;`). Only `float` is extracted — a fader writes one
 * scalar, so a `vec3` uniform has no single control to offer and is skipped
 * silently rather than half-supported.
 *
 * PURE: no GL, no fetch, no globals. Compile-VALIDITY is a separate question
 * answered by `validateToyboxShader` — this function will happily describe the
 * params of a shader that does not compile, which is the right split: the load
 * UI wants to say "this shader is broken HERE" and "it offers these controls"
 * independently.
 */
export function extractShaderParams(src: string): ShaderParamExtraction {
  const { code, annotations } = scanComments(src);
  const params: ToyboxParamDef[] = [];
  const diagnostics: ShaderParamDiagnostic[] = [];
  const seen = new Set<string>();

  // `uniform [precision] float a, b;` — captures the whole declarator list.
  const DECL = /\buniform\s+(?:lowp\s+|mediump\s+|highp\s+)?float\s+([^;]+);/g;

  // Which source lines carry a uniform declaration of ANY type. Needed because
  // a TRAILING annotation belongs to its own declaration and must not be
  // inherited by the next one — `uniform float warp; // @param(-1,1,0)` on one
  // line followed by a plain `uniform float x;` must leave x unannotated.
  const declLines = new Set<number>();
  {
    let n = 0;
    for (const l of code.split('\n')) {
      if (/\buniform\s/.test(l)) declLines.add(n);
      n++;
    }
  }

  for (const m of code.matchAll(DECL)) {
    const declLine = code.slice(0, m.index ?? 0).split('\n').length - 1;
    // An annotation on the declaration's own line wins. Otherwise inherit from
    // the line above ONLY when that line is a standalone comment — the common
    // `// @param(...)`-above-the-uniform style.
    const above = declLines.has(declLine - 1) ? undefined : annotations.get(declLine - 1);
    const annBody = annotations.get(declLine) ?? above;

    for (const rawDeclarator of m[1].split(',')) {
      // Drop any initializer: `speed = 1.0` → `speed`.
      const id = rawDeclarator.split('=')[0].trim();
      if (!/^[A-Za-z_]\w*$/.test(id)) continue;

      if (ENGINE_RESERVED_UNIFORMS.has(id)) {
        diagnostics.push({
          id,
          kind: 'engine-reserved',
          detail: `${id} is provided by the engine every frame — a fader for it would be overwritten, so no control is offered.`,
        });
        continue;
      }
      if (seen.has(id)) {
        diagnostics.push({
          id,
          kind: 'duplicate',
          detail: `${id} is declared more than once — the first declaration's range is used.`,
        });
        continue;
      }
      seen.add(id);

      const range =
        annBody === undefined
          ? { ...UNANNOTATED_RANGE }
          : parseAnnotation(annBody, id, diagnostics);

      params.push({
        id,
        label: labelForUniform(id),
        min: range.min,
        max: range.max,
        default: range.default,
        curve: range.curve,
      });
    }
  }

  return { params, diagnostics };
}
