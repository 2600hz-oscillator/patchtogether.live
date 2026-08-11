// packages/web/src/lib/audio/mono-normal-scan.ts
//
// THE ENUMERATOR for mono normals declared in packages/dsp/src worklets.
// Extracted from the gate (mono-normal-not-defeated.test.ts) so the scan lives
// in ONE place and can be unit-tested against synthetic source without touching
// the repo — the house pattern of card-def-agreement.ts.
//
// ── WHY THIS EXISTS (the gate that could not see 30 % of its own population) ──
// The gate shipped in #1343 detected a mono normal with ONE regex matching ONE
// expression on ONE line:
//
//     /inputs\[(\d+)\]\?\.\[0\]\s*\?\?\s*inputs\[(\d+)\]\?\.\[0\]/
//
// That is a SHAPE match, not a semantic one. It sees the normal only when both
// operands are spelled as literal `inputs[N]?.[0]` subscripts *on the same
// line*. Run verbatim over all 63 files in packages/dsp/src it found 7 normals.
// There are 12. It missed five, in four different modules, because each spells
// the same fallback through intermediate consts:
//
//   stereovca.ts:65-66   const inLBuf = inputs[0]?.[0];
//                        const inRRaw = inputs[1]?.[0];
//                        const inR = inRRaw ?? inLBuf;          ← 2 normals
//   samsloop-tap.ts:67   const rNorm = rRaw ?? lRaw;            ← 1 normal
//   ringback.ts:72       const inR = inputs[1]?.[0] ?? inL;     ← 1 normal (mixed)
//   twotracks.ts:606     const inR = inputs[inputOffset + 1]?.[0] ?? inL;
//                                                               ← 1 normal (symbolic index,
//                                                                 2 concrete reels)
//
// This is the repo's recurring defect, again: A FILTER APPLIED BEFORE THE CHECK
// SILENTLY REDEFINES THE CHECK'S SUBJECT. `RAW_PARAM_WRITE` matched only the
// bracket form and saw 3 of 99. `RANGE_BOUND_CARDS` was an opt-in filename list
// and saw 7 of 193. `if (!p.edge) continue` saw 63 of 362. Here the filter was
// a regex literal, and it reported "0 violations" over 58 % of the population.
//
// ── THE FIX: RESOLVE NAMES, THEN PROVE THE COVERAGE ──────────────────────────
// Two changes, and the second is the one that actually closes the hole.
//
//   1. SEMANTIC, not syntactic. The scanner builds an environment mapping every
//      identifier to the input reference it denotes (`inputs[N]`, or a channel
//      of it), resolved transitively, then classifies each `??`/`||`/ternary
//      fallback by what its operands MEAN. Spelling stops mattering.
//
//   2. THE RESIDUAL AUDIT (`auditCoverage`). Resolution is still a finite set of
//      forms, so a spelling nobody anticipated would go back to being invisible
//      — the exact failure being fixed. So the scanner ALSO enumerates every
//      fallback expression in the tree that *could* be a normal (a `??` / `||` /
//      ternary whose operands are not plainly literal defaults) and requires
//      each to be CLASSIFIED. An expression the resolver cannot account for is
//      reported as `unclassified`, and the gate is red until a human either
//      teaches the resolver or names it in the ledger with a reason.
//
//      That is the difference between asserting coverage and proving it: a new
//      unmatchable spelling now REDDENS instead of silently shrinking the
//      subject. It is the same inversion as anchoring a VRT ratchet to the PNG
//      artifact rather than to the exemption list.
//
// ── SCOPE, STATED (see also the assertions in the gate) ──────────────────────
// Read the `SCOPE` export. Nothing here inspects runtime behaviour; it is a
// source scanner, and the behavioural counterpart is
// e2e/tests/stereo-mono-normal.spec.ts.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DSP_DIR = fileURLToPath(new URL('../../../../dsp/src/', import.meta.url));
export const FACTORY_DIR = fileURLToPath(new URL('./modules/', import.meta.url));
/**
 * Where a worklet may be instantiated. NOT just the audio modules dir: the
 * `recorderbox-capture` worklet is constructed by a VIDEO module
 * (lib/video/modules/recorderbox.ts). A factory search limited to one directory
 * is precisely the "a checker that resolves ONE directory cannot speak for the
 * tree" failure this repo has hit before.
 */
export const FACTORY_DIRS = [
  FACTORY_DIR,
  fileURLToPath(new URL('../video/modules/', import.meta.url)),
];

/**
 * An array index. A literal subscript resolves to a `number`; anything else
 * (`inputOffset + 1`) is kept as its SYMBOLIC source text so the normal is still
 * discovered — see `SYMBOLIC_INDEX_EXPANSIONS` in the gate, which is what turns
 * a symbol into the concrete input numbers a factory could pin.
 */
export type Idx = number | string;

export const isLiteralIdx = (i: Idx): i is number => typeof i === 'number';

/** What an expression denotes, once names are resolved. */
export type InputRef =
  /** `inputs[input]` — the Float32Array[] for a whole worklet input. */
  | { kind: 'inputArray'; input: Idx }
  /** `inputs[input][channel]` — one channel's Float32Array. */
  | { kind: 'channel'; input: Idx; channel: Idx };

/** How the normal was written. Tracked so the negative-control matrix can
 *  assert that EVERY supported spelling is exercised by a real test. */
export type Spelling =
  /** `inputs[1]?.[0] ?? inputs[0]?.[0]` — both operands literal subscripts. */
  | 'direct'
  /** `inRRaw ?? inLBuf` — both operands intermediate consts. */
  | 'alias'
  /** `inputs[1]?.[0] ?? inL` — one subscript, one const. */
  | 'mixed'
  /** `const [l, r] = inputs[0]; … r ?? l` — operands from array destructuring. */
  | 'destructured'
  /** `rRaw ? rRaw : lRaw`, `rRaw !== undefined ? rRaw : lRaw`, … */
  | 'ternary'
  /** `rRaw || lRaw` — truthy fallback rather than nullish. */
  | 'or';

export interface MonoNormal {
  /** DSP source file, e.g. `clouds.ts`. */
  dspFile: string;
  /**
   * `input`   — worklet INPUT `normalled` normals from input `from`. Defeated by
   *             connecting anything to input `normalled`.
   * `channel` — CHANNEL `normalled` of input `onInput` normals from channel
   *             `from`. Defeated by a 'discrete' up-mix law.
   */
  kind: 'input' | 'channel';
  /** The index that falls back (the one that must stay genuinely absent). */
  normalled: Idx;
  /** The index it falls back TO. */
  from: Idx;
  /** For `channel`, the worklet input the channel array came from. */
  onInput?: Idx;
  line: number;
  text: string;
  spelling: Spelling;
}

/** A fallback expression the scanner looked at but did NOT call a normal. */
export interface Candidate {
  dspFile: string;
  line: number;
  text: string;
  left: string;
  right: string;
  /**
   * `normal`       — classified as a mono normal (see `MonoNormal`).
   * `default`      — right operand is a plain default (`null`, `0`, `[]`, …), so
   *                  the left is merely defaulted, not normalled.
   * `not-input`    — neither operand denotes a worklet input.
   * `same-ref`     — both operands denote the SAME input reference (degenerate).
   * `unclassified` — the left operand denotes an input but the scanner cannot
   *                  account for the fallback. THIS IS THE RED ONE.
   */
  verdict: 'normal' | 'default' | 'not-input' | 'same-ref' | 'unclassified';
  why?: string;
}

export interface ScanResult {
  normals: MonoNormal[];
  candidates: Candidate[];
  /** Files actually read (the denominator for "63 files"). */
  files: string[];
  /** Names bound to two different input refs in one file — resolution is
   *  file-global, so these are ambiguous and reported rather than guessed. */
  ambiguous: string[];
}

// ---------------------------------------------------------------------------
// Lexical prep: blank out comments and string literals so that prose like
// "// R normals to L" can never be parsed as code, WITHOUT moving any offset.
// ---------------------------------------------------------------------------

function blankWith(src: string, alsoStrings: boolean): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (a: number, b: number) => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = i; while (j < n && src[j] !== '\n') j++;
      blank(i, j); i = j; continue;
    }
    if (c === '/' && d === '*') {
      let j = i + 2; while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      blank(i, Math.min(j + 2, n)); i = j + 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      if (alsoStrings) blank(i + 1, j);
      i = j + 1; continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * Blank comments AND string contents, preserving every offset. Used by the
 * fallback scanner so that prose — cofefve's `// R normals to L`, or this
 * file's own header — can never be parsed as code.
 */
export const blankNonCode = (src: string) => blankWith(src, true);

/**
 * Blank COMMENTS ONLY, preserving offsets and string contents.
 *
 * Anything matching a string LITERAL (a processor name, a port id) must use
 * this: `blankNonCode` turns `'stereovca'` into `'         '`, so a literal
 * search over it silently matches nothing — the same "filter redefines the
 * subject" failure this whole file exists to fix, one level down.
 */
export const blankComments = (src: string) => blankWith(src, false);

// ---------------------------------------------------------------------------
// Operand scanning. An "operand" is a member/subscript chain: identifier chars,
// `.`, `?.`, `!`, and balanced `[]` / `()`.
// ---------------------------------------------------------------------------

const IDENT = /[A-Za-z0-9_$]/;

/** Scan BACKWARD from `end` (exclusive) and return the operand's start offset. */
export function operandStart(src: string, end: number): number {
  let i = end;
  while (i > 0 && /\s/.test(src[i - 1]!)) i--;
  const stop = i;
  for (;;) {
    if (i > 0 && (src[i - 1] === ']' || src[i - 1] === ')')) {
      const open = src[i - 1] === ']' ? '[' : '(';
      const close = src[i - 1]!;
      let depth = 0; let j = i - 1;
      for (; j >= 0; j--) {
        if (src[j] === close) depth++;
        else if (src[j] === open) { depth--; if (depth === 0) break; }
      }
      if (j < 0) return stop;
      i = j;
      continue;
    }
    if (i > 0 && (src[i - 1] === '!' || src[i - 1] === '.')) { i--; continue; }
    if (i > 0 && src[i - 1] === '?' && src[i] === '.') { i--; continue; }
    if (i > 0 && IDENT.test(src[i - 1]!)) { while (i > 0 && IDENT.test(src[i - 1]!)) i--; continue; }
    break;
  }
  return i;
}

/** Scan FORWARD from `start` and return the operand's end offset (exclusive). */
export function operandEnd(src: string, start: number): number {
  let i = start;
  const n = src.length;
  while (i < n && /\s/.test(src[i]!)) i++;
  for (;;) {
    if (i < n && IDENT.test(src[i]!)) { while (i < n && IDENT.test(src[i]!)) i++; continue; }
    if (i < n && (src[i] === '[' || src[i] === '(')) {
      const open = src[i]!;
      const close = open === '[' ? ']' : ')';
      let depth = 0; let j = i;
      for (; j < n; j++) {
        if (src[j] === open) depth++;
        else if (src[j] === close) { depth--; if (depth === 0) break; }
      }
      if (j >= n) return i;
      i = j + 1;
      continue;
    }
    if (i < n && src[i] === '!' ) { i++; continue; }
    if (i < n && src[i] === '?' && src[i + 1] === '.') { i += 2; continue; }
    if (i < n && src[i] === '.') { i++; continue; }
    break;
  }
  return i;
}

/** Split `a[b]` style trailing subscript off an operand: `foo?.[0]` → `foo`,`0`. */
function splitTrailingSubscript(expr: string): { base: string; index: string } | null {
  const t = expr.trim();
  if (!t.endsWith(']')) return null;
  let depth = 0; let j = t.length - 1;
  for (; j >= 0; j--) {
    if (t[j] === ']') depth++;
    else if (t[j] === '[') { depth--; if (depth === 0) break; }
  }
  if (j <= 0) return null;
  let base = t.slice(0, j).trim();
  if (base.endsWith('?.')) base = base.slice(0, -2).trim();
  if (base.endsWith('!')) base = base.slice(0, -1).trim();
  return { base, index: t.slice(j + 1, t.length - 1).trim() };
}

const toIdx = (raw: string): Idx => (/^\d+$/.test(raw) ? Number(raw) : raw);

/** Strip `!`, wrapping parens and a trailing `?.`. */
function clean(expr: string): string {
  let t = expr.trim();
  for (;;) {
    if (t.startsWith('(') && t.endsWith(')')) {
      let depth = 0; let ok = true;
      for (let k = 0; k < t.length; k++) {
        if (t[k] === '(') depth++;
        else if (t[k] === ')') { depth--; if (depth === 0 && k < t.length - 1) { ok = false; break; } }
      }
      if (ok) { t = t.slice(1, -1).trim(); continue; }
    }
    if (t.endsWith('!')) { t = t.slice(0, -1).trim(); continue; }
    break;
  }
  return t;
}

export type Env = Map<string, InputRef>;

/** Resolve an expression to the input reference it denotes, or null. */
export function resolveOperand(expr: string, env: Env): InputRef | null {
  const t = clean(expr);
  if (!t) return null;

  // `inputs` itself is not a ref; `inputs[K]` is.
  const sub = splitTrailingSubscript(t);
  if (sub) {
    const baseRef = sub.base === 'inputs' ? null : resolveOperand(sub.base, env);
    if (sub.base === 'inputs') return { kind: 'inputArray', input: toIdx(sub.index) };
    if (baseRef && baseRef.kind === 'inputArray') {
      return { kind: 'channel', input: baseRef.input, channel: toIdx(sub.index) };
    }
    // Subscripting a channel yields a SAMPLE, not a channel — not a ref.
    return null;
  }

  if (IDENT.test(t[0]!) && /^[A-Za-z0-9_$]+$/.test(t)) return env.get(t) ?? null;
  return null;
}

// ---------------------------------------------------------------------------
// The environment: every `const/let/var NAME = <input expr>` in the file, plus
// array destructuring, resolved to a fixpoint so aliases-of-aliases work.
// ---------------------------------------------------------------------------

const DECL_RE = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*[^=;]+?)?=\s*([^;\n]+)/g;
const DESTRUCTURE_RE = /\b(?:const|let|var)\s*\[([^\]]*)\]\s*(?::\s*[^=;]+?)?=\s*([^;\n]+)/g;

export function buildEnv(code: string): { env: Env; ambiguous: string[]; destructured: Set<string> } {
  const env: Env = new Map();
  const ambiguous: string[] = [];
  const destructured = new Set<string>();
  const same = (a: InputRef, b: InputRef) => JSON.stringify(a) === JSON.stringify(b);

  const put = (name: string, ref: InputRef) => {
    const prev = env.get(name);
    if (prev && !same(prev, ref)) { if (!ambiguous.includes(name)) ambiguous.push(name); return; }
    env.set(name, ref);
  };

  // Fixpoint: three passes is ample for the alias depths in this tree, and it
  // terminates regardless.
  for (let pass = 0; pass < 3; pass++) {
    for (const m of code.matchAll(DECL_RE)) {
      const name = m[1]!;
      // Only take the FIRST fallback operand of an initialiser: `const inR =
      // inputs[1]?.[0] ?? inL;` binds inR to the normalled channel, which is
      // what a later reference to inR denotes for our purposes.
      const rhs = m[2]!.split('??')[0]!.trim();
      const ref = resolveOperand(rhs, env);
      if (ref) put(name, ref);
    }
    for (const m of code.matchAll(DESTRUCTURE_RE)) {
      const names = m[1]!.split(',').map((s) => s.trim());
      const ref = resolveOperand(m[2]!.split('??')[0]!.trim(), env);
      if (!ref || ref.kind !== 'inputArray') continue;
      names.forEach((nm, k) => {
        if (!nm || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(nm)) return;
        put(nm, { kind: 'channel', input: ref.input, channel: k });
        destructured.add(nm);
      });
    }
  }
  return { env, ambiguous, destructured };
}

// ---------------------------------------------------------------------------
// Classification.
// ---------------------------------------------------------------------------

/** Right-hand operands that make a fallback a plain DEFAULT, not a normal. */
const DEFAULT_RHS = /^(null|undefined|0|0\.0|\[\]|''|""|`+`|\{\}|NaN|false|new Float32Array\(.*\)|EMPTY[A-Za-z0-9_$]*|SILENT[A-Za-z0-9_$]*)$/;

const idxEq = (a: Idx, b: Idx) => a === b;

function classify(
  dspFile: string, line: number, text: string,
  leftText: string, rightText: string, spelling: Spelling, env: Env,
): { candidate: Candidate; normal?: MonoNormal } {
  const base = { dspFile, line, text, left: leftText.trim(), right: rightText.trim() };
  const l = resolveOperand(leftText, env);
  const r = resolveOperand(rightText, env);

  if (!l) return { candidate: { ...base, verdict: 'not-input' } };

  if (!r) {
    if (DEFAULT_RHS.test(clean(rightText))) return { candidate: { ...base, verdict: 'default' } };
    return {
      candidate: {
        ...base, verdict: 'unclassified',
        why: `left operand \`${base.left}\` denotes a worklet input but the fallback `
          + `\`${base.right}\` could not be resolved — if this is a mono normal the scanner `
          + 'is BLIND to it; teach resolveOperand or name it in the ledger',
      },
    };
  }

  // channel normal: same input, different channel.
  if (l.kind === 'channel' && r.kind === 'channel' && idxEq(l.input, r.input)) {
    if (idxEq(l.channel, r.channel)) return { candidate: { ...base, verdict: 'same-ref' } };
    return {
      candidate: { ...base, verdict: 'normal' },
      normal: {
        dspFile, kind: 'channel', normalled: l.channel, from: r.channel,
        onInput: l.input, line, text, spelling,
      },
    };
  }

  // input normal: different worklet inputs.
  if (l.kind === 'channel' && r.kind === 'channel') {
    if (idxEq(l.input, r.input)) return { candidate: { ...base, verdict: 'same-ref' } };
    return {
      candidate: { ...base, verdict: 'normal' },
      normal: { dspFile, kind: 'input', normalled: l.input, from: r.input, line, text, spelling },
    };
  }

  if (l.kind === 'inputArray' && r.kind === 'inputArray') {
    if (idxEq(l.input, r.input)) return { candidate: { ...base, verdict: 'same-ref' } };
    return {
      candidate: { ...base, verdict: 'normal' },
      normal: { dspFile, kind: 'input', normalled: l.input, from: r.input, line, text, spelling },
    };
  }

  return {
    candidate: {
      ...base, verdict: 'unclassified',
      why: `operands denote different KINDS of input reference (${l.kind} vs ${r.kind})`,
    },
  };
}

// ---------------------------------------------------------------------------
// The scan.
// ---------------------------------------------------------------------------

/**
 * Line lookup, precomputed once per file. (Slicing + splitting per candidate is
 * O(n) each and turns a 63-file scan quadratic.)
 */
function lineIndex(raw: string) {
  const starts = [0];
  for (let i = 0; i < raw.length; i++) if (raw[i] === '\n') starts.push(i + 1);
  const lines = raw.split('\n');
  const lineOf = (off: number) => {
    let lo = 0; let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= off) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  return { lineOf, textOf: (off: number) => (lines[lineOf(off) - 1] ?? '').trim() };
}

/**
 * Find every mono normal in one DSP source, and every fallback CANDIDATE the
 * scanner considered (which is what makes the coverage provable).
 */
export function scanSource(dspFile: string, src: string): {
  normals: MonoNormal[]; candidates: Candidate[]; ambiguous: string[];
} {
  const code = blankNonCode(src);
  const { env, ambiguous, destructured } = buildEnv(code);
  const normals: MonoNormal[] = [];
  const candidates: Candidate[] = [];
  const { lineOf, textOf } = lineIndex(src);

  const push = (
    off: number, leftText: string, rightText: string, spelling: Spelling,
  ) => {
    const line = lineOf(off);
    const { candidate, normal } = classify(
      dspFile, line, textOf(off), leftText, rightText, spelling, env,
    );
    candidates.push(candidate);
    if (normal) normals.push(normal);
  };

  const isDestructured = (t: string) => {
    const id = t.trim();
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(id) && destructured.has(id);
  };

  const spellingOf = (leftText: string, rightText: string, fallback: Spelling): Spelling => {
    // A destructured binding is reported as such whichever operator produced it
    // — the point of the label is WHERE the name came from.
    if (isDestructured(leftText) || isDestructured(rightText)) return 'destructured';
    if (fallback !== 'alias') return fallback;
    const lSub = /(^|[^A-Za-z0-9_$])inputs\s*[?!]*\s*[.[]/.test(leftText);
    const rSub = /(^|[^A-Za-z0-9_$])inputs\s*[?!]*\s*[.[]/.test(rightText);
    if (lSub && rSub) return 'direct';
    if (lSub || rSub) return 'mixed';
    return 'alias';
  };

  // (1) nullish / logical-or fallbacks.
  for (let i = 0; i < code.length - 1; i++) {
    const isNullish = code[i] === '?' && code[i + 1] === '?';
    const isOr = code[i] === '|' && code[i + 1] === '|';
    if (!isNullish && !isOr) continue;
    // Skip `??=` / `||=`.
    if (code[i + 2] === '=') continue;
    const ls = operandStart(code, i);
    const le = i;
    const rs = i + 2;
    const re = operandEnd(code, rs);
    const leftText = code.slice(ls, le);
    const rightText = code.slice(rs, re);
    if (!leftText.trim() || !rightText.trim()) continue;
    push(ls, leftText, rightText, spellingOf(leftText, rightText, isOr ? 'or' : 'alias'));
  }

  // (2) ternary fallbacks: `X ? X : Y`, `X !== undefined ? X : Y`, `!X ? Y : X`.
  //     A ternary whose two BRANCHES denote different input refs is a normal
  //     however the condition is spelled — so classify on the branches and
  //     ignore the test. Scanned linearly, like the operators above: a regex
  //     for this shape backtracks catastrophically (measured 7.4 s on a 5.5 kB
  //     file before this was rewritten).
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '?') continue;
    if (code[i + 1] === '?' || code[i - 1] === '?') continue; // nullish
    if (code[i + 1] === '.') continue;                        // optional chain
    const consStart = i + 1;
    const consEnd = operandEnd(code, consStart);
    if (consEnd <= consStart) continue;
    let j = consEnd;
    while (j < code.length && /\s/.test(code[j]!)) j++;
    if (code[j] !== ':') continue;
    const altStart = j + 1;
    const altEnd = operandEnd(code, altStart);
    if (altEnd <= altStart) continue;
    const cons = code.slice(consStart, consEnd);
    const alt = code.slice(altStart, altEnd);
    // Only a ternary whose BOTH branches denote inputs is interesting here;
    // a per-sample guard like `inL ? inL[i] : 0` resolves to a sample, not a
    // channel, and correctly falls out.
    if (!resolveOperand(cons, env) || !resolveOperand(alt, env)) continue;
    push(consStart, cons, alt, spellingOf(cons, alt, 'ternary'));
  }

  return { normals, candidates, ambiguous };
}

/** True for a DSP source file we scan (skips tests, decls and .dsp/Faust). */
export const isDspSource = (f: string) =>
  f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts');

/** Scan the whole DSP tree. */
export function scanDspTree(dir: string = DSP_DIR): ScanResult {
  const normals: MonoNormal[] = [];
  const candidates: Candidate[] = [];
  const ambiguous: string[] = [];
  const files: string[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!isDspSource(f)) continue;
    files.push(f);
    const r = scanSource(f, readFileSync(`${dir}${f}`, 'utf8'));
    normals.push(...r.normals);
    candidates.push(...r.candidates);
    for (const a of r.ambiguous) ambiguous.push(`${f}:${a}`);
  }
  return { normals, candidates, files, ambiguous };
}

/** Stable identity for a normal. Symbolic indices keep their source text. */
export const normalKey = (n: MonoNormal) => `${n.dspFile}:${n.kind}:${n.normalled}`;

// ---------------------------------------------------------------------------
// Factory resolution — DERIVED, not hand-maintained.
//
// The shipped gate assumed "same basename for every module today". That is
// FALSE for samsloop-tap.ts, whose worklet is instantiated by samsloop.ts —
// so the shipped `factoryFor()` would have thrown ENOENT the moment its
// detector could see samsloop-tap's normal. The blindness was hiding a crash.
//
// The real link is the PROCESSOR NAME: the DSP registers it, the factory names
// it when constructing the AudioWorkletNode. Derive from that.
// ---------------------------------------------------------------------------

export function processorNameOf(src: string): string | null {
  const m = /registerProcessor\(\s*['"]([^'"]+)['"]/.exec(blankComments(src));
  return m?.[1] ?? null;
}

export interface FactoryRef { path: string; file: string; src: string }

/**
 * Find the factory file(s) that instantiate `dspFile`'s processor, by looking
 * for its registered processor name as a string literal under modules/.
 * Falls back to the same-basename convention.
 */
/**
 * Cache of (dir → [file, source]). Every `factoriesFor` call would otherwise
 * re-read both module directories in full — ~250 files per normal, and the gate
 * calls it once per normal in three separate legs (measured 10.1 s → 1.4 s).
 */
const dirCache = new Map<string, { file: string; path: string; src: string; blanked: string }[]>();
function readDir(dir: string) {
  let hit = dirCache.get(dir);
  if (!hit) {
    hit = [];
    if (existsSync(dir)) {
      for (const f of readdirSync(dir).sort()) {
        if (!isDspSource(f)) continue;
        const src = readFileSync(`${dir}${f}`, 'utf8');
        // Blank ONCE per file, not once per lookup: blankComments is a
        // char-by-char pass and the gate resolves factories ~13 times.
        hit.push({ file: f, path: `${dir}${f}`, src, blanked: blankComments(src) });
      }
    }
    dirCache.set(dir, hit);
  }
  return hit;
}

export function factoriesFor(
  dspFile: string, dspDir: string = DSP_DIR, factoryDirs: readonly string[] = FACTORY_DIRS,
): FactoryRef[] {
  const dspSrc = readFileSync(`${dspDir}${dspFile}`, 'utf8');
  const proc = processorNameOf(dspSrc);
  const hits: FactoryRef[] = [];
  if (proc) {
    const needle = new RegExp(`['"]${proc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
    for (const dir of factoryDirs) {
      for (const { file, path, src, blanked } of readDir(dir)) {
        // blankComments, NOT blankNonCode: the needle IS a string literal.
        if (needle.test(blanked)) hits.push({ path, file, src });
      }
    }
  }
  if (hits.length === 0) {
    for (const dir of factoryDirs) {
      const found = readDir(dir).find((e) => e.file === dspFile);
      if (found) { hits.push({ path: found.path, file: found.file, src: found.src }); break; }
    }
  }
  return hits;
}

/**
 * The registry `type:` a factory file declares, e.g. `charlottesEchos`.
 *
 * ⚠ ANCHORED TO THE DEF DECLARATION, NEVER "the first `type:` in the file".
 *
 * The first version of this read `/type:\s*'(\w+)'/` against the whole source
 * and took the earliest match. That is not reading the module's registry type —
 * it is reading TEXTUAL POSITION, and `type:` is a wildly common key. It broke
 * on main within hours, and nothing about the break was semantic:
 *
 *   before #1353   samsloop.ts:846  type: 'samsloop'      ← def, FIRST
 *                  samsloop.ts:982  type: 'loadSample'    ← postMessage payload
 *   after  #1353   samsloop.ts:972  type: 'loadSample'    ← postMessage, FIRST
 *                  samsloop.ts:982  type: 'samsloop'      ← def
 *
 * #1353 extracted `postSampleBuffer` and hoisted it above the def. No `type:`
 * was added, removed or renamed — the two simply swapped order — and this
 * function's answer silently changed from `samsloop` to `loadSample`. The
 * roster-parity gate then reported that samsloop had lost its mono normal and
 * that an unknown module was unmeasured. Both were false, and both were RED on
 * main, from a pure code motion in an unrelated PR.
 *
 * Every module def in the tree is declared exactly one way —
 * `export const <name>Def: <Audio|Video|Synced>ModuleDef = {` (verified across
 * all audio + video module files) — so that declaration is a real anchor.
 * Helper files that export no def return null, which is correct: they are not
 * modules.
 */
export function moduleTypeOf(factorySrc: string): string | null {
  const src = blankComments(factorySrc);
  const decl = /export\s+const\s+[A-Za-z0-9_$]*Def\s*:\s*[A-Za-z0-9_$]*ModuleDef\s*=\s*\{/.exec(src);
  if (!decl) return null;
  const body = src.slice(decl.index + decl[0].length);
  return /(^|[^A-Za-z0-9_$])type:\s*'([A-Za-z0-9_$]+)'/m.exec(body)?.[2] ?? null;
}

// ---------------------------------------------------------------------------
// THE SECOND INSTRUMENT — anchored to the DEF, blind in a DIFFERENT way.
//
// The residual audit above catches a spelling whose LEFT operand still resolves.
// It cannot catch one where NEITHER operand resolves — that lands in
// `not-input` and looks like any of the 399 arithmetic fallbacks in the tree.
//
// So the population is ALSO derived from a different artifact entirely: a
// module DEF that declares a stereo AUDIO INPUT PAIR and a stereo AUDIO OUTPUT
// PAIR is, by construction, a module whose OUT R can be silent for a mono
// patch — the exact defect class. Every such module must either have a
// detected normal or be named in the gate's ledger with a reason.
//
// A normal spelled in a way the text scanner cannot read therefore shows up
// HERE, as a stereo module with no normal, rather than vanishing. The two
// instruments fail independently, which is the whole point.
// ---------------------------------------------------------------------------

export interface StereoModule {
  /** Factory file under modules/, e.g. `stereovca.ts`. */
  file: string;
  audioIn: string[];
  audioOut: string[];
  /** The L/R input pairs, e.g. `[['in_l','in_r']]`. */
  inPairs: [string, string][];
  /** The L/R output pairs. */
  outPairs: [string, string][];
  /** The DSP file its processor name resolves to, if it is a worklet module. */
  dspFile: string | null;
}

/**
 * Split a port id into (stem, side) if it carries an L/R marker.
 * `in_l` → `in|`,L · `audio_r_in` → `audio_|_in`,R · `inL` → `in`,L · `L` → ``,L
 */
export function lrSplit(id: string): { stem: string; side: 'L' | 'R' } | null {
  let m = /^(.*?)_([lr])(_.*|)$/i.exec(id);
  if (m) return { stem: `${m[1]}_|${m[3]}`, side: m[2]!.toUpperCase() as 'L' | 'R' };
  m = /^(.+?)([LR])$/.exec(id);
  if (m) return { stem: m[1]!, side: m[2] as 'L' | 'R' };
  m = /^([lr])$/i.exec(id);
  if (m) return { stem: '', side: m[1]!.toUpperCase() as 'L' | 'R' };
  return null;
}

/** Pair up port ids that differ only by their L/R marker. */
export function lrPairs(ids: readonly string[]): [string, string][] {
  const byStem = new Map<string, { L?: string; R?: string }>();
  for (const id of ids) {
    const s = lrSplit(id);
    if (!s) continue;
    const slot = byStem.get(s.stem) ?? {};
    if (!slot[s.side]) slot[s.side] = id;
    byStem.set(s.stem, slot);
  }
  const out: [string, string][] = [];
  for (const { L, R } of byStem.values()) if (L && R) out.push([L, R]);
  return out;
}

/** Extract the bracketed array literal following `key` (brace/bracket matched). */
function arraySection(code: string, key: string): string {
  const i = code.search(new RegExp(`(^|[^A-Za-z0-9_$])${key}\\s*:\\s*\\[`, 'm'));
  if (i < 0) return '';
  const s = code.indexOf('[', i);
  let d = 0;
  for (let k = s; k < code.length; k++) {
    if (code[k] === '[') d++;
    else if (code[k] === ']') { d--; if (d === 0) return code.slice(s, k + 1); }
  }
  return '';
}

const audioPortIds = (section: string): string[] =>
  [...section.matchAll(/\{[^{}]*\}/g)]
    .filter((m) => /\btype:\s*'audio'/.test(m[0]))
    .map((m) => /\bid:\s*'([^']+)'/.exec(m[0])?.[1])
    .filter((x): x is string => !!x);

/**
 * Every module whose def declares an L/R AUDIO INPUT PAIR **and** an L/R AUDIO
 * OUTPUT PAIR — i.e. exactly the population whose OUT R can be digital silence
 * for a mono patch. Pairing on the L/R marker (rather than "2+ audio ports")
 * keeps the ledger small enough that a human actually reads it: 22 modules have
 * 2+ audio ports each way, but only 10 are real stereo pairs.
 */
export function findStereoModules(
  factoryDir: string = FACTORY_DIR, dspDir: string = DSP_DIR,
): StereoModule[] {
  const procToDsp = new Map<string, string>();
  for (const f of readdirSync(dspDir).sort()) {
    if (!isDspSource(f)) continue;
    const p = processorNameOf(readFileSync(`${dspDir}${f}`, 'utf8'));
    if (p && !procToDsp.has(p)) procToDsp.set(p, f);
  }

  const out: StereoModule[] = [];
  for (const { file: f, blanked: code } of readDir(factoryDir)) {
    // `blanked` is blankComments, NOT blankNonCode — port ids and types ARE
    // string literals, and blanking them would silently match nothing.
    const audioIn = audioPortIds(arraySection(code, 'inputs'));
    const audioOut = audioPortIds(arraySection(code, 'outputs'));
    const inPairs = lrPairs(audioIn);
    const outPairs = lrPairs(audioOut);
    if (inPairs.length === 0 || outPairs.length === 0) continue;
    let dspFile: string | null = null;
    for (const [p, df] of procToDsp) {
      if (new RegExp(`['"]${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(code)) { dspFile = df; break; }
    }
    out.push({ file: f, audioIn, audioOut, inPairs, outPairs, dspFile });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Defeat detection.
// ---------------------------------------------------------------------------

/**
 * Does `factorySrc` DEFEAT `normal` at worklet input `concreteIndex`? Returns
 * the reason, or null.
 *
 * A real patch cable is realised by the ENGINE (`sout.node.connect(din.node, …)`)
 * using the index the handle's `inputs` map declares — it never appears as a
 * literal `.connect(node, n, IDX)` inside a factory. So a literal connect to the
 * normalled input in the factory is, by construction, a pin.
 */
export function defeatReason(
  normal: MonoNormal, factorySrc: string, concreteIndex?: number,
): string | null {
  // blankComments, NOT blankNonCode: the 'discrete' test below searches for a
  // string LITERAL, and blankNonCode would blank it to `'        '` so the
  // check could never fire. (Caught by the destructured negative-control row —
  // the channel-defeat leg was silently dead until it did.)
  const code = blankComments(factorySrc);
  if (normal.kind === 'input') {
    const idx = concreteIndex ?? (isLiteralIdx(normal.normalled) ? normal.normalled : null);
    if (idx === null) return null; // caller must expand symbols; the gate enforces that.
    const pinRe = new RegExp(`\\.connect\\(\\s*\\w+\\s*,\\s*\\d+\\s*,\\s*${idx}\\s*\\)`);
    const m = pinRe.exec(code);
    if (m) {
      return `factory pins worklet input ${idx} (\`${m[0].trim()}\`), so Chrome always `
        + `hands process() a channel for it and \`${normal.text}\` can never fall through`;
    }
    return null;
  }
  if (/channelInterpretation:\s*'discrete'/.test(code)) {
    return `factory sets channelInterpretation: 'discrete', whose up-mix ZERO-FILLS channel `
      + `${normal.normalled} for a mono source, so \`${normal.text}\` can never fall through `
      + `(channel ${normal.normalled} exists, it is merely silent). Use 'speakers'.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// SCOPE — stated in the enumerator, asserted in the gate.
// ---------------------------------------------------------------------------

export const SCOPE = {
  /** Read: the TOP LEVEL of packages/dsp/src only (worklet entries live there). */
  dspDir: 'packages/dsp/src/*.ts',
  /**
   * NOT read: packages/dsp/src/lib/**. Those are pure cores that receive
   * Float32Arrays from a worklet entry, so they cannot declare a worklet-input
   * normal. Asserted in the gate rather than assumed.
   */
  notRead: ['packages/dsp/src/lib/**'],
  /**
   * Sources this cannot read AT ALL. A Faust `.dsp` has no TypeScript to
   * resolve, so a stereo Faust module (qbrt) is carried by the def-anchored leg
   * as a NAMED gap rather than being silently absent from the population.
   */
  notScanned: ['packages/dsp/src/*.dsp (Faust)'],
  /** Fallback forms the resolver understands (`Spelling`). */
  spellings: ['direct', 'alias', 'mixed', 'destructured', 'ternary', 'or'] as const,
  /**
   * Defeat mechanisms this can recognise. A THIRD mechanism — e.g. a factory
   * that up-mixes upstream of the worklet, or a merger feeding the normalled
   * input — is INVISIBLE here and would be caught only by the e2e counterpart.
   */
  defeats: ['factory pin on the normalled worklet INPUT', "'discrete' up-mix on a normalled CHANNEL"] as const,
  /**
   * Name resolution is FILE-GLOBAL, not lexically scoped. A file that binds the
   * same identifier to two different inputs in two functions is reported as
   * `ambiguous` rather than guessed — the gate requires that list to be empty.
   */
  resolution: 'file-global identifier binding, fixpoint over 3 passes',
} as const;
