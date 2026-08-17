// packages/web/src/lib/video/toybox-shader-validate.ts
//
// COMPILE VALIDATION FOR USER-SUPPLIED GLSL (#1576, workstream 3).
//
// Answers the one question `extractShaderParams` structurally cannot: does this
// source actually COMPILE — and if not, WHERE. Used by the disk-load path now
// and by the subsite's paste box later (#1575), which is why the failure shape
// is `{ line, message }` the editor can point at, never a boolean and never the
// driver's raw blob.
//
// ── WHERE THIS CAN RUN, established rather than assumed ────────────────────
//
// CLAUDE.md: *a gate that cannot fail on CI is decoration.* So, before writing
// it: CI's only renderer is SwiftShader, and SHADER COMPILATION DOES NOT NEED A
// GPU — it is ANGLE's ESSL translator, which SwiftShader carries in full. The
// repo already relies on this: the REQUIRED `webgl-smoke` job describes its own
// floor as asserting "a real GL context paints non-black / A SHADER COMPILES /
// the OffscreenCanvas worker-proxy renders".
//
// Concretely, the split is:
//
//   * `parseShaderCompileLog` is PURE — no GL at all — so it carries the bulk of
//     the logic and is unit-tested exhaustively in the node `unit` lane.
//   * `validateToyboxShader` needs a WebGL2 context, so its gate is an e2e
//     tagged `@webgl-smoke`. That lane sets `E2E_SWIFTSHADER=1` and leaves
//     `E2E_WEBGL_HEAVY` UNSET (= run everything, filtered by the tag), so the
//     spec runs on SwiftShader on EVERY PR and can genuinely go red. It is not
//     enrolled in the heavy globs — those specs are not run on PRs at all.
//
// There is therefore NO capability skip here, deliberately. A missing WebGL2
// context is a hard error, not a reason to pass quietly: the whole point of a
// validator is that its silence means something.
//
// ── WHAT THIS CANNOT SEE (the gate's own scope, stated in the gate) ────────
//
//   * LINK errors. It compiles the fragment shader alone; it does not link a
//     program. Compile is where per-line diagnostics live, which is what the UI
//     needs. A shader that compiles but exhausts uniform slots at link time is
//     out of scope.
//   * RUNTIME behaviour — an infinite loop, a divide by zero, a black frame.
//     Compiling is not working.
//   * DRIVER VARIANCE. A source valid under ANGLE/SwiftShader may still hit a
//     vendor-specific limit elsewhere. ANGLE is the strict ESSL-spec reference,
//     so this errs toward rejecting sources some drivers would accept — the safe
//     direction for a load gate.

import { SHADERTOY_UNIFORM_BLOCK, isShadertoySource, wrapShadertoySource } from './toybox-shadertoy';
import { paramsNeedingDeclaration } from './toybox-shader-params';

export type ShaderDiagnosticSeverity = 'error' | 'warning';

/** One parsed line of a GLSL compiler log. */
export interface ShaderCompileDiagnostic {
  severity: ShaderDiagnosticSeverity;
  /**
   * 1-based line IN THE USER'S OWN SOURCE, already corrected for the engine
   * preamble — see `validateToyboxShader`. `null` when the driver reported no
   * position (some emit a bare summary line).
   */
  line: number | null;
  /** The message with severity and position stripped — what the UI shows. */
  message: string;
  /** The compiler's original line, kept verbatim so nothing is lost. */
  raw: string;
}

export interface ShaderValidation {
  /** True when the source compiled. Warnings do NOT make this false. */
  ok: boolean;
  errors: ShaderCompileDiagnostic[];
  warnings: ShaderCompileDiagnostic[];
  /** The driver's whole info log, untouched. Empty string on a clean compile. */
  rawLog: string;
}

// GLSL compiler logs are not standardised. These are the shapes seen in the
// wild, most specific first. `0` in `0:12` is the source-STRING index (always 0
// here — one string is submitted), and 12 is the line.
const LOG_PATTERNS: readonly { re: RegExp; sev: 1; line: 2; msg: 3 }[] = [
  // ANGLE / SwiftShader / Chrome:  "ERROR: 0:12: 'x' : undeclared identifier"
  { re: /^\s*(ERROR|WARNING)\s*:\s*\d+\s*:\s*(\d+)\s*:\s*(.*)$/i, sev: 1, line: 2, msg: 3 },
  // Position-less string index:     "ERROR: 12: something"
  { re: /^\s*(ERROR|WARNING)\s*:\s*(\d+)\s*:\s*(.*)$/i, sev: 1, line: 2, msg: 3 },
];
// Mesa:                            "0:12(5): error: syntax error"
const MESA_RE = /^\s*\d+:(\d+)\(\d+\)\s*:\s*(error|warning)\s*:\s*(.*)$/i;
// A severity word with no position at all: "ERROR: too many uniforms"
const BARE_RE = /^\s*(ERROR|WARNING)\s*:\s*(.*)$/i;

/**
 * Parse a GLSL compiler info log into structured diagnostics.
 *
 * PURE — no GL, no globals. Line numbers are returned EXACTLY as the compiler
 * stated them; mapping them back onto the user's source is
 * `validateToyboxShader`'s job, because only it knows what preamble was
 * prepended.
 *
 * Unrecognised non-empty lines are kept as errors with `line: null` rather than
 * dropped: a diagnostic we cannot parse is still a diagnostic, and swallowing it
 * would let a real failure surface as "no errors".
 */
export function parseShaderCompileLog(log: string): ShaderCompileDiagnostic[] {
  const out: ShaderCompileDiagnostic[] = [];
  for (const raw of log.split('\n')) {
    // Drivers NUL-terminate the log; a trailing \0 would otherwise ride into
    // the message and render as a stray glyph in the UI.
    const line = raw.replace(/\0/g, '').trimEnd();
    if (line.trim().length === 0) continue;

    let matched = false;
    for (const p of LOG_PATTERNS) {
      const m = p.re.exec(line);
      if (!m) continue;
      out.push({
        severity: m[p.sev].toLowerCase() === 'warning' ? 'warning' : 'error',
        line: Number(m[p.line]),
        message: m[p.msg].trim(),
        raw: line,
      });
      matched = true;
      break;
    }
    if (matched) continue;

    const mesa = MESA_RE.exec(line);
    if (mesa) {
      out.push({
        severity: mesa[2].toLowerCase() === 'warning' ? 'warning' : 'error',
        line: Number(mesa[1]),
        message: mesa[3].trim(),
        raw: line,
      });
      continue;
    }

    const bare = BARE_RE.exec(line);
    if (bare) {
      out.push({
        severity: bare[1].toLowerCase() === 'warning' ? 'warning' : 'error',
        line: null,
        message: bare[2].trim(),
        raw: line,
      });
      continue;
    }

    out.push({ severity: 'error', line: null, message: line.trim(), raw: line });
  }
  return out;
}

/** A unique token that cannot occur in real GLSL, used to locate where the
 *  wrapper places the user's body. */
const BODY_ANCHOR = '__TOYBOX_BODY_ANCHOR__';

/**
 * How many lines `wrapShadertoySource` prepends before the user's body, DERIVED
 * from the wrapper itself rather than counted by hand.
 *
 * ⚠ This must never become a literal. The preamble's length depends on the
 * param-declaration block (one line per content param) and on the `common`
 * chunk, so a hand-typed offset would be wrong for most shaders and would go
 * stale the moment the wrapper gains a line — silently, by pointing every error
 * at the wrong line. Wrapping a sentinel and finding it is exact by
 * construction, for any param list.
 */
export function shadertoyPreambleLines(paramNames: string[] = [], common = ''): number {
  const probe = wrapShadertoySource(BODY_ANCHOR, common, paramNames);
  const at = probe.split('\n').findIndex((l) => l.includes(BODY_ANCHOR));
  // findIndex is 0-based and compiler lines are 1-based, so `at` IS the count of
  // lines preceding the body. -1 is impossible (we just put the anchor in), but
  // fail toward "no correction" rather than producing negative line numbers.
  return at < 0 ? 0 : at;
}

/**
 * Map a compiler line number back onto the user's own source.
 *
 * Two corrections, both necessary:
 *   1. subtract the preamble the wrapper prepended;
 *   2. add back the `#version` line the wrapper STRIPS from the body — if the
 *      user wrote one, every subsequent line of theirs shifted up by one.
 *
 * Exported so the mapping can be tested directly, in both directions, without a
 * GL context.
 */
export function mapCompilerLineToSource(
  compilerLine: number,
  preambleLines: number,
  versionStripped: boolean,
): number | null {
  const mapped = compilerLine - preambleLines + (versionStripped ? 1 : 0);
  // A diagnostic landing inside the preamble is not about the user's text (a
  // clash with an engine uniform, say). Report it position-less rather than
  // pointing at a line the user cannot see.
  return mapped >= 1 ? mapped : null;
}

/** Obtain a WebGL2 context for probing: a caller-supplied one, else a 1×1
 *  offscreen surface. Works on the main thread and in a worker. */
function probeContext(): WebGL2RenderingContext {
  if (typeof OffscreenCanvas !== 'undefined') {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
    if (gl) return gl as unknown as WebGL2RenderingContext;
  }
  if (typeof document !== 'undefined') {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (gl) return gl;
  }
  throw new Error(
    'TOYBOX: cannot validate a shader — no WebGL2 context is available in this environment',
  );
}

/**
 * Compile a user-supplied GLSL source the way the ENGINE would, and report
 * structured diagnostics against the USER'S OWN line numbers.
 *
 * The source is wrapped exactly as the factory wraps it — Shadertoy convention
 * detected with the engine's own `isShadertoySource`, then
 * `wrapShadertoySource` with the same param declarations — so a shader that
 * validates here compiles there. Validating the bare text instead would report
 * `iTime` as undeclared for every Shadertoy source, which is the opposite of
 * useful.
 *
 * @param src        the user's GLSL, as typed/loaded.
 * @param paramNames param uniforms the engine will inject (from
 *                   `extractShaderParams`), so a source referencing its own
 *                   declared params is not reported as undeclared.
 * @param gl         optional context to reuse; one is created if omitted.
 */
export function validateToyboxShader(
  src: string,
  paramNames: string[] = [],
  gl?: WebGL2RenderingContext,
): ShaderValidation {
  const ctx = gl ?? probeContext();
  const shadertoy = isShadertoySource(src);
  const versionStripped = /^\s*#version[^\n]*\n/.test(src);
  // A Shadertoy source is wrapped (preamble + params); a plain `main()` engine
  // source is compiled verbatim, so it needs no correction at all.
  // #1708: the engine declares only the params the SOURCE does not declare
  // itself (a user shader declares its own; injecting them again is a duplicate
  // global declaration). Validate through the identical filter or this probe
  // would report a compile error the engine does not produce.
  //
  // ⚠ ONE variable feeds BOTH the wrap and the preamble measurement. The
  // preamble grows one line per DECLARED param, so filtering the wrap and not
  // the offset would mis-point every diagnostic by the number filtered out —
  // silently, and only for shaders that declare their own uniforms.
  const declareNames = paramsNeedingDeclaration(src, paramNames);
  const wrapped = shadertoy ? wrapShadertoySource(src, '', declareNames) : src;
  const preamble = shadertoy ? shadertoyPreambleLines(declareNames, '') : 0;

  const shader = ctx.createShader(ctx.FRAGMENT_SHADER);
  if (!shader) {
    throw new Error('TOYBOX: could not allocate a shader object for validation');
  }
  let rawLog = '';
  let compiled = false;
  try {
    ctx.shaderSource(shader, wrapped);
    ctx.compileShader(shader);
    compiled = ctx.getShaderParameter(shader, ctx.COMPILE_STATUS) === true;
    rawLog = ctx.getShaderInfoLog(shader) ?? '';
  } finally {
    ctx.deleteShader(shader);
  }

  const all = parseShaderCompileLog(rawLog).map((d) => ({
    ...d,
    line: d.line === null ? null : mapCompilerLineToSource(d.line, preamble, versionStripped),
  }));
  const errors = all.filter((d) => d.severity === 'error');
  const warnings = all.filter((d) => d.severity === 'warning');

  // Trust COMPILE_STATUS over the log's contents: some drivers emit an empty
  // log on failure, and reporting "ok" with no errors would be the worst
  // possible outcome for a load gate.
  if (!compiled && errors.length === 0) {
    errors.push({
      severity: 'error',
      line: null,
      message: 'the shader failed to compile, but the driver reported no details',
      raw: rawLog,
    });
  }

  return { ok: compiled, errors, warnings, rawLog };
}

/** The engine-provided uniform names a validated source may reference without
 *  declaring. Re-exported from the block the engine actually prepends so the
 *  load UI can explain "iTime is provided for you" without re-listing them. */
export const SHADERTOY_PROVIDED_UNIFORMS: readonly string[] = [
  ...SHADERTOY_UNIFORM_BLOCK.matchAll(/^\s*uniform\s+\w+\s+(\w+)/gm),
].map((m) => m[1]);
