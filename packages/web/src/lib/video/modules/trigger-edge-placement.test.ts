// packages/web/src/lib/video/modules/trigger-edge-placement.test.ts
//
// A SOURCE-LEVEL guard for the "level-read at DRAW time" bug class — the defect
// behind the FREEZEFRAME owner report of 2026-07-31 (a patched trigger updated
// ZERO frames) and its FRAMETABLE sibling (a patched trigger saved NOTHING).
//
// ── WHY THIS GATE HAS TO READ THE SOURCE ──
// Every runtime gate we have is STRUCTURALLY BLIND to this bug:
//   - contract-lock / module-docs-lint read the DEF. The FACTORY is what
//     disagreed with it.
//   - the pure-function unit tests import the decision functions (shouldCapture,
//     the save latch) and drive them directly. They pass no matter WHERE the
//     factory calls them from — and "where" is the entire bug.
//   - the per-module-per-port sweep asserts an edge MATERIALIZES, not that the
//     module reacted to it.
//   - the e2e that would see it lives in e2e/tests/freezeframe.spec.ts, and the
//     bug shipped while that file ran in NO CI LANE.
// This is the same shape as the backdraft "card silently disagrees with its def"
// hole, and the same remedy the repo already uses for it: grep the source, since
// no runtime gate can see the divergence. (Precedent: the controlFamilies →
// card-testid grep in module-docs-lint.test.ts.)
//
// ── THE RULE ──
// A rising edge on a raw-passthrough (gate/trigger-style) input MUST be detected
// in `setParam`, on the BRIDGE's clock — never by reading `params.<id>` inside
// `draw()`.
//
// The reason is not style, it is the wire protocol. `PatchEngine.
// installGateDispatch` handles any GATE SOURCE patched into an input with no
// non-passthrough `cvScale` — which includes every `type: 'cv'` clock/gate port,
// not just `type: 'gate'` ones. It does NOT stream the waveform. It counts
// rising edges on the audio thread and REPLAYS them on the ~25 ms scheduler tick
// as `setParam(0); setParam(1)` per edge, then `setParam(currentLevel)`.
// Measured byte-for-byte on the live chain (SEQUENCER.clock → FREEZEFRAME.
// gate_in), one trigger arrives as three writes in the SAME MILLISECOND:
//
//     3221:0   3221:1   3221:0
//
// So by the time `draw()` runs, `params.<id>` is back to 0. A detector reading
// the level there observes `0 → 0 → 0`: the rise never existed. The consumer is
// not "flaky" — it is DEAD, deterministically, for every patched trigger.
//
// ══════════════════════════════════════════════════════════════════════════════
// ⚠ WHAT THIS FILE LEARNED THE HARD WAY — READ BEFORE EDITING THE SCANNER
//
// The FIRST version of this guard was VACUOUS on the one module it was written
// for. `scanAll()` opened a file only `if (src.includes('detectEdge'))`, and the
// FREEZEFRAME fix REMOVED that import from frametable.ts (the latch moved to
// ./frametable-core). So the shipped frametable.ts was never opened, and the
// assertion "frametable is clean" passed by never looking. The bug could be put
// straight back — `if (frametableSaveWrite(saveLatch, params.saveTrig))` inside
// draw(), using the very helper the fix introduced — and all ten tests stayed
// GREEN. (Measured, not suspected: that exact regression was applied to the real
// file and the suite passed 10/10.)
//
// Two structural causes, both fixed below:
//   1. A LITERAL-STRING PRE-FILTER on one idiom is a blind spot generator. The
//      scanner now opens EVERY module file.
//   2. The edge-function index was PER-FILE, so a helper defined in another file
//      (frametable-core's `frametableSaveWrite`, plex-select's `gateEdge`) could
//      never be recognised. It now resolves IMPORTS and computes the edge-fn set
//      across files.
// The lesson generalises: ask of any new gate what it is STRUCTURALLY unable to
// see, then feed it a real regression and watch it go red. `NEGATIVE CONTROL:
// the REAL shipped frametable.ts with the bug put back` below does exactly that,
// against the on-disk file, so this can never rot into decoration again.
// ══════════════════════════════════════════════════════════════════════════════
//
// ══════════════════════════════════════════════════════════════════════════════
// ⚠ THE SECOND BLIND SPOT — found in review, fixed 2026-08-02. SAME CAUSE.
//
// Rule 3 filtered on `type: 'gate'`. THE DISPATCH DOES NOT. `installGateDispatch`
// keys off the SOURCE cable (`edge.sourceType === 'gate'`, engine.ts:1491) and
// requires only that the TARGET have no non-passthrough `cvScale` (:1503) — it
// never reads the target's declared type, and `canConnect` puts cv/pitch/gate in
// one interchangeable CV_FAMILY. All ten sites in rule 1's KNOWN_REMAINING are
// `type: 'cv'`, so rule 3 could not see ONE of the defects rule 1 already names.
//
// MEASURED: re-typing freezeframe's port to `type: 'cv'` and deleting the
// setParam `detectEdge` call — the literal owner-reported bug, verbatim — left
// the suite 17/17 GREEN. Rule 1 was blind (no edge call exists to find), rule 2
// was blind (no `edge:` key to fire on), rule 3 was blind (type is now 'cv').
//
// The lesson is the one this file already states and then failed to apply to
// itself: **a gate must filter on what the RUNTIME filters on.** Both blind
// spots were a predicate the dispatch does not share. Rule 3's predicate now
// mirrors engine.ts:1491/1503 line for line, and the negative control re-applies
// that exact regression so it can never come back silently.
// ══════════════════════════════════════════════════════════════════════════════
//
// ── WHAT THIS GATE STILL CANNOT SEE (state it, don't imply completeness) ──
// Rule 1 matches the DIRECT form `edgeFn(state, params.<id>)`, which is the form
// both real bugs took. An edge read that launders the level through a local
// first —
//     const sample = params[key];  …  detectEdge(state, sample)
// — is NOT matched. `vfpga-runner.ts` (`tickGates`, called from draw) is exactly
// that shape and is therefore invisible here; it is listed in KNOWN_UNMATCHABLE
// by hand so it is at least NAMED — nothing asserts anything about that list.
// Widening the matcher to arbitrary dataflow needs a real AST pass; the direct
// form is where the value is.
//
// The reachability walk (`drawRanges` → `declSites`) knew only `function f(){}`
// and `const f = () => {}` until 2026-08-02 — a NARROWING introduced with the
// filter itself, and a bad one, since these modules are written as OBJECT
// LITERALS. Method shorthand, property arrows and class methods are covered now
// (with negative controls per form, plus a phantom-declaration control). What
// remains uncovered is genuinely indirect dispatch — a helper reached through a
// computed property, an array of callbacks, or a value passed as an argument.
// Those need the same AST pass as the dataflow case above.
//
// Rule 3 reads the def as SOURCE TEXT, so a port literal built programmatically
// (spread from a shared const, or produced by a `.map()`) is matched only for
// its `<computed>` id, and a def assembled entirely at runtime is not matched at
// all. `vfpga-runner` and `doom` already show up as `<computed>`.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULES_DIR = fileURLToPath(new URL('.', import.meta.url));
/** packages/web/src/lib — the root the `$lib/…` specifier resolves against. */
const LIB_DIR = resolve(MODULES_DIR, '..', '..');

/** Comments are stripped before scanning: this very file's prose, and the long
 *  explanatory headers the fixes added, mention `detectEdge(` and `params.x` in
 *  English. A gate that matched its own documentation would be self-tripping. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

interface Block { start: number; end: number; body: string }

/** Body of the `{ … }` block that starts at/after `from`, brace-matched. */
function blockAt(src: string, from: number): Block {
  const start = src.indexOf('{', from);
  if (start < 0) return { start: -1, end: -1, body: '' };
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return { start, end: i, body: src.slice(start, i) }; }
  }
  return { start, end: src.length, body: src.slice(start) };
}

/** Index just past the `)` that closes the balanced `( … )` starting at `i`. */
function afterParens(src: string, i: number): number {
  let depth = 0;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '(') depth++;
    else if (src[k] === ')') { depth--; if (depth === 0) return k + 1; }
  }
  return src.length;
}

interface Decl { name: string; start: number; end: number; body: string }

/** Reserved words that take a `(…)  {…}` shape and would otherwise be picked up
 *  as OBJECT-METHOD declarations named `if` / `while` / `catch` / … . Leaving
 *  them in produces a phantom decl whose "body" is a control-flow block, which
 *  is the 27-phantom-sites failure the header records, in a new costume. */
const NOT_A_DECL_NAME = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'do', 'else', 'return', 'function',
  'typeof', 'new', 'await', 'yield', 'case', 'with', 'delete', 'void', 'in', 'of',
]);

/**
 * Every named function-ish declaration WITH ITS BODY RANGE. Handles
 * `function f(…) {…}`, `const f = (…) => {…}`, `const f = (…) => expr;`,
 * `const f = function (…) {…}`, and — added 2026-08-02 — the three OBJECT/CLASS
 * forms below.
 *
 * ⚠ THE OBJECT FORMS ARE NOT OPTIONAL, they close a NARROWING THIS FILE
 * INTRODUCED. `drawRanges` walks from `draw()` through `declSites`, so any
 * helper declared in a form `declSites` cannot see is a body the reachability
 * filter never enters — a silent blind spot of exactly the shape this file was
 * written to eliminate. And the modules in question are written as OBJECT
 * LITERALS (`const surface = { draw(frame) {…}, tick() {…} }`), so the
 * uncovered forms were the COMMON ones here, not exotica:
 *
 *     { name(a) {…} }         object-literal / class METHOD shorthand
 *     { name: (a) => {…} }    PROPERTY ARROW
 *     class C { name(a) {…} } class METHOD
 *
 * ⚠ The body must be delimited PROPERLY, not by "the next `{` in the file".
 * An expression-bodied arrow (`const clamp01 = (v: number) => Math.min(1, v);`)
 * has no block at all, and taking the next brace swallows an unrelated function
 * further down — which made an earlier draft of this scanner classify `clamp01`
 * and `clampSym` as edge detectors and report 27 phantom sites.
 *
 * ⚠ The method-shorthand form is ANCHORED to a property position (`{`, `,`, `;`
 * or `}` before the name) precisely to avoid re-creating that failure: without
 * the anchor, `if (foo(x)) { … }` reads as a declaration of `foo` whose body is
 * the if-block. `NOT_A_DECL_NAME` covers the residue (`while (c) {…}` sits after
 * a `;`, so the anchor alone does not exclude it).
 */
function declSites(src: string): Decl[] {
  const out: Decl[] = [];
  const push = (name: string, parenAt: number): void => {
    let p = afterParens(src, parenAt);
    // step over an optional return-type annotation and the `=>`
    while (p < src.length && src[p] !== '{' && src[p] !== ';' && src[p] !== '\n') {
      if (src.startsWith('=>', p)) { p += 2; continue; }
      p++;
    }
    while (p < src.length && /\s/.test(src[p]!)) p++;
    if (src[p] === '{') {
      const b = blockAt(src, p);
      out.push({ name, start: b.start, end: b.end, body: b.body });
    } else {
      let depth = 0;
      let k = p;
      for (; k < src.length; k++) {
        const c = src[k]!;
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === ';' && depth <= 0) break;
      }
      out.push({ name, start: p, end: k, body: src.slice(p, k) });
    }
  };

  const re = /(?:export\s+)?function\s+([A-Za-z0-9_$]+)\s*\(|(?:const|let)\s+([A-Za-z0-9_$]+)\s*(?::[^=;]*?)?=\s*(?:async\s+)?(?:function\b\s*\*?\s*\(|\()/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = (m[1] ?? m[2])!;
    const parenAt = src.indexOf('(', m.index + m[0].length - 1);
    if (parenAt < 0) continue;
    push(name, parenAt);
  }

  // PROPERTY ARROW — `{ name: (a) => {…} }` / `name: async (a) => {…}`.
  const arrowRe = /(?:^|[{,;])\s*(?:readonly\s+)?([A-Za-z0-9_$]+)\s*:\s*(?:async\s+)?\(/gm;
  while ((m = arrowRe.exec(src)) !== null) {
    const name = m[1]!;
    if (NOT_A_DECL_NAME.has(name)) continue;
    const parenAt = src.lastIndexOf('(', arrowRe.lastIndex);
    const after = afterParens(src, parenAt);
    let q = after;
    while (q < src.length && src[q] !== '{' && src[q] !== ';' && src[q] !== '\n') {
      if (src.startsWith('=>', q)) break;
      q++;
    }
    if (!src.startsWith('=>', q)) continue; // a typed property, not an arrow
    push(name, parenAt);
  }

  // METHOD SHORTHAND — object literals AND class bodies: `{ name(a) {…} }`.
  const methRe = /(?:^|[{,;}])\s*(?:async\s+)?(?:static\s+)?(?:private\s+|public\s+|protected\s+)?([A-Za-z0-9_$]+)\s*\(/gm;
  while ((m = methRe.exec(src)) !== null) {
    const name = m[1]!;
    if (NOT_A_DECL_NAME.has(name)) continue;
    const parenAt = src.lastIndexOf('(', methRe.lastIndex);
    let q = afterParens(src, parenAt);
    // optional `: ReturnType` annotation before the body
    while (q < src.length && /[\s:A-Za-z0-9_$<>,.|[\]]/.test(src[q]!) && src[q] !== '{') q++;
    while (q < src.length && /\s/.test(src[q]!)) q++;
    if (src[q] !== '{') continue; // a CALL, not a method declaration
    push(name, parenAt);
  }

  return out;
}

/**
 * The ROOT edge-detection primitives in this repo. Everything else is derived
 * from these by call-graph closure, so a new one-hop helper needs no edit here.
 *   detectEdge              $lib/doom/cv-gate-edge      (freezeframe, backdraft, vfpga)
 *   gateEdge                $lib/video/plex-select      (lushgarden, outlines, shapegen, …)
 *   createRisingEdgeDetector $lib/audio/modules/transport-helpers (milkdrop)
 *   createEdgeCounter       $lib/audio/edge-detect      (the main-thread standard)
 */
const ROOT_EDGE_FNS: readonly string[] = [
  'detectEdge', 'gateEdge', 'createRisingEdgeDetector', 'createEdgeCounter',
];

/** Resolve a `$lib/…` or relative import specifier to a .ts file on disk. */
function resolveImport(fromFile: string, spec: string): string | null {
  let p: string;
  if (spec.startsWith('$lib/')) p = join(LIB_DIR, spec.slice('$lib/'.length));
  else if (spec.startsWith('.')) p = resolve(dirname(fromFile), spec);
  else return null; // node_modules / bare specifier — not our source
  for (const cand of [`${p}.ts`, join(p, 'index.ts')]) if (existsSync(cand)) return cand;
  return null;
}

const edgeFnMemo = new Map<string, Set<string>>();

/**
 * The set of function names that perform edge detection AS SEEN FROM `src`
 * (which lives at `file`): the roots, plus any edge-detecting symbol `src`
 * IMPORTS, plus its own local functions that (transitively) call one of those.
 *
 * The import hop is the whole point — `frametableSaveWrite` lives in
 * `$lib/video/frametable-core`, OUTSIDE this directory, and a per-file walk can
 * never learn it is an edge function. That blind spot is what made the first
 * version of this guard vacuous on frametable.
 */
function edgeFnsIn(file: string, src: string, stack: Set<string> = new Set()): Set<string> {
  const names = new Set<string>(ROOT_EDGE_FNS);

  const impRe = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'([^']+)'/g;
  let im: RegExpExecArray | null;
  while ((im = impRe.exec(src)) !== null) {
    const target = resolveImport(file, im[2]!);
    if (!target) continue;
    const exported = edgeFnsOf(target, stack);
    for (const raw of im[1]!.split(',')) {
      const n = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim();
      if (n && exported.has(n)) names.add(n);
    }
  }

  const decls = declSites(src);
  for (let pass = 0; pass < 4; pass++) {
    let grew = false;
    for (const d of decls) {
      if (names.has(d.name)) continue;
      for (const n of names) {
        if (new RegExp(`\\b${n}\\s*\\(`).test(d.body)) { names.add(d.name); grew = true; break; }
      }
    }
    if (!grew) break;
  }
  return names;
}

/** Memoized `edgeFnsIn` over a file's ON-DISK source — the cross-file hop. */
function edgeFnsOf(file: string, stack: Set<string> = new Set()): Set<string> {
  const memo = edgeFnMemo.get(file);
  if (memo) return memo;
  if (stack.has(file)) return new Set(); // import cycle
  stack.add(file);
  const names = edgeFnsIn(file, stripComments(readFileSync(file, 'utf8')), stack);
  stack.delete(file);
  edgeFnMemo.set(file, names);
  return names;
}

/**
 * Character ranges REACHABLE FROM `draw()` in a module file: every `draw(…) {…}`
 * body, plus (transitively) the body of every local function called from one.
 *
 * The rule's title has always been "reachable from draw"; before this it scanned
 * the WHOLE FILE, so a perfectly CORRECT setParam-clock detector that happened
 * to name `params.<id>` was flagged, and the shipped rule was really "never name
 * a param inside an edge call anywhere". Now the title is the rule.
 */
function drawRanges(src: string): Array<[number, number]> {
  const decls = declSites(src);
  const ranges: Array<[number, number]> = [];
  const queue: Array<{ start: number; end: number; body: string }> = [];
  const re = /\bdraw\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const p = afterParens(src, src.indexOf('(', m.index));
    let q = p;
    while (q < src.length && /\s/.test(src[q]!)) q++;
    if (src[q] !== '{') continue; // a CALL to draw(...), not its definition
    queue.push(blockAt(src, q));
  }
  const seen = new Set<string>();
  while (queue.length) {
    const b = queue.shift()!;
    ranges.push([b.start, b.end]);
    for (const d of decls) {
      if (seen.has(d.name)) continue;
      if (new RegExp(`\\b${d.name}\\s*\\(`).test(b.body)) {
        seen.add(d.name);
        queue.push(d);
      }
    }
  }
  return ranges;
}

export interface EdgeSite { module: string; param: string; via: string }

/** Every `<edgeFn>( … params.<id> … )` call REACHABLE FROM draw() in a video
 *  module def. `filePath` is where the file lives on disk (for import
 *  resolution); `src` is its comment-stripped source. */
function scanModule(filePath: string, src: string): EdgeSite[] {
  const out: EdgeSite[] = [];
  const module = filePath.replace(/^.*\//, '').replace(/\.ts$/, '');
  const ranges = drawRanges(src);
  const reachable = (i: number): boolean => ranges.some(([a, b]) => i >= a && i <= b);
  for (const fn of edgeFnsIn(filePath, src)) {
    // One level of nested parens in the arg list is plenty here.
    const re = new RegExp(`\\b${fn}\\s*\\(([^()]*(?:\\([^()]*\\)[^()]*)*)\\)`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const pm = /params\s*(?:\.\s*([A-Za-z0-9_$]+)|\[)/.exec(m[1] ?? '');
      if (pm && reachable(m.index)) out.push({ module, param: pm[1] ?? '<computed>', via: fn });
    }
  }
  return out;
}

function moduleFiles(): string[] {
  return readdirSync(MODULES_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort()
    .map((f) => join(MODULES_DIR, f));
}

/** Scan EVERY module def. No literal-string pre-filter — see the header. */
function scanAll(): EdgeSite[] {
  const out: EdgeSite[] = [];
  for (const path of moduleFiles()) {
    out.push(...scanModule(path, stripComments(readFileSync(path, 'utf8'))));
  }
  return out;
}

const key = (s: EdgeSite): string => `${s.module}.${s.param}`;

/**
 * THE NAMED DEFECT LIST. Sites that still read the level at draw time, verified
 * one by one on 2026-08-01. Every entry is a real defect: a gate SOURCE patched
 * into any of these ports is delivered by installGateDispatch (they are all
 * raw-passthrough — "NO cvScale => raw passthrough" in their own def comments),
 * so a TRIGGER into them does nothing at all. A HELD gate still works, which is
 * why they have gone unnoticed: the level stands across ticks, so the draw-time
 * detector does see that rise.
 *
 * NOT fixed in the FREEZEFRAME PR on purpose — each needs its own behavioural
 * verification, and BACKDRAFT is a look-affecting module under the WebGL attest
 * (owner-preview-before-merge). Tracked as follow-up work; the point of the list
 * is that every one of them is NAMED, and a site that is not named is RED.
 */
const KNOWN_REMAINING: readonly string[] = [
  // BACKDRAFT — 6 raw-passthrough clock/gate ports, all edge-read in draw().
  'backdraft.delayClock',   // clock-locked delay period measurement
  'backdraft.mirrorXGate',  // rising edge toggles mirror X
  'backdraft.mirrorYGate',  // rising edge toggles mirror Y
  'backdraft.shapeGate',    // rising edge cycles the shape
  'backdraft.pureGeoGate',  // rising edge toggles the masking space
  'backdraft.tvGate',       // rising edge toggles PURE TV
  // B3NTB0X / BENTBOX — the same mirror-gate helper, same placement.
  'b3ntb0x.mirrorXGate',
  'b3ntb0x.mirrorYGate',
  'bentbox.mirrorXGate',
  'bentbox.mirrorYGate',
];

/** Sites this scanner is KNOWN to miss (see the header's blind-spot note).
 *  Listed so the stated scope is honest, not so the gate can see them.
 *
 *  ⚠ PURELY DOCUMENTARY, and it always was. NO RULE IN THIS FILE READS IT — it
 *  is not a skip-list, not an exemption and not an anchor; the scanner is blind
 *  to these sites by construction, so listing one changes nothing a test does.
 *  Its `<= 1` cap was deleted 2026-08-10 with the other counts here, and unlike
 *  those two there is nothing to point at as the surviving protection, because
 *  there was never any protection to carry: the cap asserted the length of a
 *  list nobody consults. Do not read this array as coverage. */
const KNOWN_UNMATCHABLE: readonly string[] = [
  // vfpga-runner.ts `tickGates()` — reads `params[gateEvtParam(i+1)]` into a
  // local, then detectEdge(…, sample); called from draw(). Same defect class,
  // invisible to a direct-form matcher.
  'vfpga-runner.gate_evt_N (via a local; scanner blind spot)',
];

describe('video modules: a TRIGGER must be edge-detected in setParam, not read in draw', () => {
  it('finds no NEW level-read-at-draw-time site', () => {
    const found = scanAll();
    const novel = found.filter((s) => !KNOWN_REMAINING.includes(key(s)));
    expect(
      [...new Set(novel.map(key))].sort(),
      novel.length === 0
        ? ''
        : [
            '',
            'A video module edge-detects a gate/trigger input by reading `params.<id>` at DRAW time:',
            ...novel.map((s) => `  • ${key(s)}   (via ${s.via})`),
            '',
            'That does not work for a PATCHED TRIGGER. PatchEngine.installGateDispatch replays a',
            'counted edge as `setParam(0); setParam(1); setParam(level)` inside ONE ~25 ms scheduler',
            'tick — all three writes in the SAME MILLISECOND — so by the next draw the level is back',
            'to 0 and the rise is invisible. Measured on the live chain: 0 of 23 rendered frames',
            'updated across 6 triggers (FREEZEFRAME, owner report 2026-07-31).',
            '',
            'FIX: detect the edge inside setParam (it runs on the bridge clock, so a pulse shorter',
            'than a frame cannot be missed), latch a BOOLEAN, and CONSUME the latch in draw().',
            'Worked examples: freezeframe.ts (gate_in) and frametable-core.ts (the save latch).',
            'A LEVEL read in draw is correct ONLY for a true `edge: \'gate\'` port that acts WHILE high.',
          ].join('\n'),
    ).toEqual([]);
  });

  it('ANCHORED TO THE SOURCE — every named site still exists', () => {
    // If a listed site is gone, someone FIXED it: drop the entry in the same
    // commit. An entry nobody can resolve against the tree is one nobody is
    // watching, and it silently exempts the next defect that takes the name.
    const found = new Set(scanAll().map(key));
    const stale = KNOWN_REMAINING.filter((k) => !found.has(k));
    expect(
      stale,
      `these KNOWN_REMAINING entries no longer exist — they were fixed, so REMOVE them: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  // ⚠ TWO COUNTS DELETED HERE (2026-08-10). They were the whole body of
  // 'the known-remaining count is at its ceiling and cannot grow':
  //
  //   expect(KNOWN_REMAINING.length).toBeLessThanOrEqual(10);
  //   expect(KNOWN_UNMATCHABLE.length).toBeLessThanOrEqual(1);
  //
  // WHAT THEY PROTECTED, and who carries it now:
  //
  //   · `KNOWN_REMAINING <= 10` — that a NEW draw-time level read cannot appear.
  //     Carried by 'finds no NEW level-read-at-draw-time site' (deny by default:
  //     any scanned site not NAMED in KNOWN_REMAINING is RED) together with
  //     'ANCHORED TO THE SOURCE — every named site still exists' (a name that no
  //     longer resolves is RED). Those two hold the list equal to the live scan
  //     by NAME, which is strictly more informative than holding its length at
  //     ten — they say WHICH module and WHICH param, and a fix that forgets to
  //     delete its entry still reddens.
  //     ⚠ WHAT IS GENUINELY LOST: the number also stopped growth-BY-LISTING —
  //     shipping a new defect AND naming it here in the same commit went red at
  //     eleven, and now does not. What remains is that the new name appears in
  //     the diff of a file whose entire premise is that these are defects.
  //     Pre-authorised coverage loss of the kill-ratchets directive, recorded
  //     here rather than in a commit message.
  //
  //   · `KNOWN_UNMATCHABLE <= 1` — NOTHING. That list is documentary (see its
  //     doc comment): no rule consults it, so the cap asserted the length of a
  //     list that has no consumer. There is no successor assertion because there
  //     was no protection to move.

  // ---- INSTRUMENT CHECKS: prove the scanner can actually see the bug. ----
  // Without these, a scanner that silently matched NOTHING would report a clean
  // repo forever — the exact failure mode this file exists to prevent, and the
  // one the first version of this file actually shipped.

  it('the scanner OPENS every module file (no literal-string pre-filter)', () => {
    // The original blind spot in one assertion. `scanAll` used to skip any file
    // not containing the literal `detectEdge`, and the FREEZEFRAME fix removed
    // that import from frametable.ts — so the module the campaign fixed was
    // never read. Assert the two fixed modules are among the files scanned AND
    // that neither contains the old pre-filter token.
    const files = moduleFiles().map((f) => f.replace(/^.*\//, ''));
    expect(files, 'frametable.ts is scanned').toContain('frametable.ts');
    expect(files, 'freezeframe.ts is scanned').toContain('freezeframe.ts');
    const frametableSrc = readFileSync(join(MODULES_DIR, 'frametable.ts'), 'utf8');
    expect(
      frametableSrc.includes('detectEdge'),
      'frametable.ts no longer mentions detectEdge — which is exactly why a `src.includes("detectEdge")` pre-filter made this guard vacuous',
    ).toBe(false);
  });

  it('every module DEF yields a draw() range (the reachability filter cannot go silently blind)', () => {
    // The reachability filter added here is itself a new way to see nothing: a
    // def whose draw is written in a form `drawRanges` does not recognise (say
    // `draw: (frame) => { … }`) would produce ZERO ranges, and then NO site in
    // that file can ever be flagged — a clean report from a scan that never
    // looked. Same failure shape as the `detectEdge` pre-filter this file
    // replaced, so it gets the same treatment: assert the precondition.
    const blind: string[] = [];
    for (const path of moduleFiles()) {
      const src = stripComments(readFileSync(path, 'utf8'));
      const isDef = /VideoModuleDef/.test(src) && /factory\s*\(/.test(src);
      if (!isDef) continue; // helper/support file, not a module def
      if (drawRanges(src).length === 0) blind.push(path.replace(/^.*\//, ''));
    }
    expect(
      blind,
      'these video module DEFS produce no draw() range, so rule 1 is structurally unable to flag ' +
      'anything in them — teach drawRanges() their draw form before landing them: ' + blind.join(', '),
    ).toEqual([]);
  });

  it('the scanner resolves edge helpers ACROSS FILES (frametableSaveWrite)', () => {
    // `frametableSaveWrite` is declared in $lib/video/frametable-core, OUTSIDE
    // this directory. A per-file walk can never learn it is an edge function,
    // and that is the second half of why the guard could not see frametable.
    const fns = edgeFnsOf(join(MODULES_DIR, 'frametable.ts'));
    expect([...fns].sort(), 'the frametable save latch is a known edge function')
      .toContain('frametableSaveWrite');
    // …and the plex-select idiom five other modules use, likewise imported.
    expect([...edgeFnsOf(join(MODULES_DIR, 'shapegen.ts'))], 'gateEdge is a known edge function')
      .toContain('gateEdge');
  });

  it('NEGATIVE CONTROL: the REAL shipped frametable.ts with the bug PUT BACK is flagged', () => {
    // THE control that matters. Not a synthetic snippet — the actual on-disk
    // file, with the exact regression a future editor would write: move the
    // decision back into draw() as a LEVEL read, using the helper this fix
    // introduced. Applied to the shipped source this reintroduces the original
    // defect verbatim (a patched trigger saves NOTHING).
    const path = join(MODULES_DIR, 'frametable.ts');
    const shipped = readFileSync(path, 'utf8');
    const SHIPPED_CALL = 'if (frametableSaveConsume(saveLatch)) { snapshotRing(); saveCount++; }';
    const REGRESSED_CALL = 'if (frametableSaveWrite(saveLatch, params.saveTrig)) { snapshotRing(); saveCount++; }';
    expect(
      shipped.includes(SHIPPED_CALL),
      'the shipped draw() consumes the latch — if this line moved, update the control so it keeps regressing the REAL file',
    ).toBe(true);

    const regressed = stripComments(shipped.replace(SHIPPED_CALL, REGRESSED_CALL));
    const hits = scanModule(path, regressed);
    expect(
      hits.map(key),
      'the scanner must FLAG a draw-time level read of saveTrig in the real frametable.ts',
    ).toEqual(['frametable.saveTrig']);
    expect(hits[0]!.via).toBe('frametableSaveWrite');

    // …and the shipped file, unmodified, is clean. Both halves, same run: a
    // control that only shows the RED half cannot prove the GREEN half is real.
    expect(scanModule(path, stripComments(shipped)).map(key)).toEqual([]);
  });

  it('NEGATIVE CONTROL: the literal pre-fix FREEZEFRAME draw-time detector is flagged', () => {
    const preFix = `
      const gateEdge2 = makeEdgeState();
      const surface = {
        draw(frame) {
          if (detectEdge(gateEdge2, params.gateLevel)?.pressed === true) capture();
        },
      };
    `;
    const hits = scanModule(join(MODULES_DIR, 'freezeframe.ts'), stripComments(preFix));
    expect(hits.map(key)).toEqual(['freezeframe.gateLevel']);
  });

  it('NEGATIVE CONTROL: it flags a one-hop HELPER declared in the same file', () => {
    const viaHelper = `
      export function widgetGateTick(edge, sample) { return detectEdge(edge, sample)?.pressed === true; }
      const surface = { draw(frame) { if (widgetGateTick(g.x, params.someGate)) flip(); } };
    `;
    const hits = scanModule(join(MODULES_DIR, 'freezeframe.ts'), stripComments(viaHelper));
    expect(hits.map((h) => h.param)).toEqual(['someGate']);
    expect(hits[0]!.via).toBe('widgetGateTick');
  });

  it('NEGATIVE CONTROL: it follows draw() into the OBJECT/CLASS declaration forms', () => {
    // The reachability filter walks from draw() through `declSites`, so any
    // helper written in a form declSites cannot see is a body the filter never
    // enters. Before 2026-08-02 it knew only `function f(){}` and
    // `const f = () => {}` — while these modules are written as OBJECT LITERALS,
    // making the uncovered forms the COMMON ones. Each shape below hides the
    // real bug one hop from draw(); all three must be flagged.
    const shapes: Array<{ label: string; param: string; src: string }> = [
      {
        label: 'method shorthand',
        param: 'methodGate',
        src: `
          const surface = {
            tick() { if (detectEdge(g.x, params.methodGate)?.pressed === true) flip(); },
            draw(frame) { tick(); },
          };
        `,
      },
      {
        label: 'property arrow',
        param: 'arrowGate',
        src: `
          const surface = {
            tick: (n) => { if (detectEdge(g.x, params.arrowGate)?.pressed === true) flip(); },
            draw(frame) { tick(1); },
          };
        `,
      },
      {
        label: 'class method',
        param: 'classGate',
        src: `
          class Surface {
            tick() { if (detectEdge(g.x, params.classGate)?.pressed === true) flip(); }
            draw(frame) { tick(); }
          }
        `,
      },
    ];
    for (const { label, param, src } of shapes) {
      const hits = scanModule(join(MODULES_DIR, 'freezeframe.ts'), stripComments(src));
      expect(hits.map((h) => h.param), `${label}: the draw-time read one hop away must be flagged`)
        .toEqual([param]);
    }
  });

  it('the widened declSites introduces NO phantom declaration (control flow is not a decl)', () => {
    // The counter-risk of teaching declSites the method form: `if (foo(x)) { … }`
    // is textually `name ( … ) { … }` too. A phantom decl there would make an
    // if-block read as a function body and re-create the 27-phantom-sites bug in
    // a new costume. Anchoring + NOT_A_DECL_NAME are what prevent it; assert it.
    const controlFlow = `
      function real(a) { return a; }
      const surface = {
        draw(frame) {
          if (real(1)) { const x = 1; }
          while (real(2)) { const y = 2; }
          for (const k of list) { real(3); }
          switch (real(4)) { case 1: real(5); break; }
        },
      };
    `;
    const names = declSites(stripComments(controlFlow)).map((d) => d.name).sort();
    for (const kw of ['if', 'while', 'for', 'switch', 'case']) {
      expect(names, `'${kw}' must not be read as a declaration`).not.toContain(kw);
    }
    expect(names, 'the real declarations are still found').toEqual(['draw', 'real']);
  });

  it('POSITIVE CONTROL: the CORRECT setParam form is NOT flagged, even naming params.<id>', () => {
    // Placement is the rule. A detector on the setParam clock is CORRECT however
    // it names its argument — the previous whole-file scan flagged this shape,
    // which is why the rule shipped as "never name a param inside an edge call".
    const fixed = `
      const gateEdge2 = makeEdgeState();
      let armed = false;
      const handle = {
        setParam(paramId, value) {
          if (paramId === 'gateLevel' && detectEdge(gateEdge2, params.gateLevel)?.pressed === true) armed = true;
        },
        draw(frame) { if (armed) { armed = false; capture(); } },
      };
    `;
    expect(scanModule(join(MODULES_DIR, 'freezeframe.ts'), stripComments(fixed))).toEqual([]);
  });

  it('the two modules FIXED by this campaign are clean', () => {
    const found = new Set(scanAll().map((s) => s.module));
    expect(found.has('freezeframe'), 'freezeframe still reads a level at draw time').toBe(false);
    expect(found.has('frametable'), 'frametable still reads a level at draw time').toBe(false);
  });
});

// ===========================================================================
// RULE 2 — the DEF-DRIVEN check: a declared trigger input must be edge-detected
// SOMEWHERE IN setParam at all.
//
// ⚠ WHAT RULE 2 DOES **NOT** COVER — corrected 2026-08-01.
// An earlier version of this file (and the PR body, and the commit message)
// claimed "rule 2 is what would have caught the original FREEZEFRAME bug". That
// was FALSE and is retracted. Rule 2 fires on a port literal matching
// `edge: 'trigger'` … `paramTarget:`. The pre-fix def was
//
//     { id: 'gate_in', type: 'gate', paramTarget: 'gateLevel' }     // NO edge key
//
// (verbatim, `freezeframe.ts:282` before the fix) and the FIXED def declares
// `edge: 'gate'`. Rule 2 never fired for FREEZEFRAME, before or after. Rule 1
// could not see it either — the pre-fix module did NO edge detection anywhere,
// so a detectEdge-shaped scanner sees a perfectly clean file.
//
// RULE 3 below is the one that flags that def shape. Even it does not PROVE the
// bug: it proves nobody wrote down which reading the module implements. A port
// declared `edge: 'gate'` whose factory reads only the level is self-consistent,
// and the owner's report was about patching a TRIGGER into such a port. No
// static rule settles that; only the behavioural e2e can, which is what
// `e2e/tests/freezeframe.spec.ts` (e) is for. The honest division of labour:
//
//   rule 1 → edge detection in the WRONG PLACE          (source)
//   rule 2 → a declared TRIGGER with no edge detection   (def ↔ factory)
//   rule 3 → a gate input that declares NO semantic      (def completeness)
//   e2e (e) → what the module actually does to a trigger (behaviour)
// ===========================================================================

/** Edge-detection idioms in use across the video modules. Deliberately a list of
 *  REAL forms, not a wildcard: freezeframe uses `detectEdge`, frametable a
 *  `…SaveWrite` latch, lushgarden/outlines/shapegen `gateEdge()`, milkdrop a
 *  `createRisingEdgeDetector(...).scan(...)`. */
const EDGE_IDIOMS = /(detectEdge|gateEdge|\.scan\(|risingEdge|RisingEdge|EdgeCounter|SaveWrite)/;

/** Modules that deliberately delegate trigger edge-detection to their CARD,
 *  which POLLS readParam. ⚠ This is NOT a clean bill of health — a poller has
 *  the SAME exposure as a draw-time read: the bridge's `0,1,0` lands inside one
 *  millisecond, so any sampler that is not on the setParam clock can miss it.
 *  Listed here to keep this gate honest about what it is NOT asserting, and
 *  tracked as follow-up alongside the KNOWN_REMAINING list above.
 *
 *  ⚠ GREW 2 → 5 on 2026-08-09, and the growth is a REVEAL, not a regression.
 *  picturebox, videobox and videovarispeed have ALWAYS detected their edges in
 *  the card and nowhere else — `PictureboxCard.svelte:294`
 *  (`lastAssetGate < 0.5 && g >= 0.5`), `VideoboxCard.svelte:539-540`,
 *  `VideovarispeedCard.svelte:831` — while their module `setParam` reads a plain
 *  level. Rule 2 could not see any of it, because rule 2 fires on
 *  `edge: 'trigger' … paramTarget:` and none of the three declared an `edge` at
 *  all; they sat in the audio-side undeclared-edge ledger instead. The
 *  edge-declaration sweep wrote the declarations the DSP already implied, and
 *  rule 2 immediately reported the exposure that had been invisible since the
 *  modules shipped. The declarations are RIGHT (all three cards edge-detect and
 *  explicitly ignore the held level); the PLACEMENT is the open question, which
 *  is exactly what this list exists to track. Moving the detection onto the
 *  setParam clock is a BEHAVIOUR change and belongs in its own PR. */
const CARD_OWNED_EDGE_DETECTION: readonly string[] = [
  'tv-librarian',
  'peertube',
  'picturebox',
  'videobox',
  'videovarispeed',
];

/** `edge: 'trigger'` on a line that also routes to a param (outputs declare
 *  `edge` for the glyph but carry no paramTarget). */
const TRIGGER_INPUT_RE = /edge:\s*'trigger'[^\n]*paramTarget:/;

function modulesDeclaringTriggerInputs(): string[] {
  const out: string[] = [];
  for (const path of moduleFiles()) {
    const src = stripComments(readFileSync(path, 'utf8'));
    if (TRIGGER_INPUT_RE.test(src)) out.push(path.replace(/^.*\//, '').replace(/\.ts$/, ''));
  }
  return out;
}

/** Does this module's `setParam(paramId, …)` body edge-detect at all? */
function setParamEdgeDetects(src: string): boolean {
  const idx = src.search(/setParam\s*\(\s*paramId/);
  if (idx < 0) return false;
  return EDGE_IDIOMS.test(blockAt(src, idx).body);
}

describe("video modules: a port declaring edge:'trigger' must edge-detect in setParam", () => {
  it('every module with a trigger INPUT edge-detects it on the setParam clock', () => {
    const offenders: string[] = [];
    for (const m of modulesDeclaringTriggerInputs()) {
      if (CARD_OWNED_EDGE_DETECTION.includes(m)) continue;
      const src = stripComments(readFileSync(join(MODULES_DIR, `${m}.ts`), 'utf8'));
      if (src.search(/setParam\s*\(\s*paramId/) < 0) { offenders.push(`${m} (no setParam at all)`); continue; }
      if (!setParamEdgeDetects(src)) offenders.push(`${m} (setParam does not edge-detect)`);
    }
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : [
            '',
            "These modules declare an INPUT port with edge: 'trigger' — a promise that it",
            'FIRES ONCE PER RISING EDGE — but their setParam never edge-detects:',
            ...offenders.map((o) => `  • ${o}`),
            '',
            'A LEVEL read cannot keep that promise. installGateDispatch replays a counted edge',
            'as setParam(0); setParam(1); setParam(level) inside ONE scheduler tick, so the high',
            'is gone before the next draw and a level-reading consumer sees nothing at all.',
            '',
            "Either edge-detect the paramTarget in setParam, or change the port's declared",
            "semantic to edge: 'gate' if the LEVEL really is what it reads.",
          ].join('\n'),
    ).toEqual([]);
  });

  it('every card-owned exemption still names a module that declares a trigger input', () => {
    // Each entry is an UNVERIFIED trigger path, not an approved design.
    //
    // ⚠ `CARD_OWNED_EDGE_DETECTION.length <= 5` WAS DELETED HERE (2026-08-10).
    // WHAT IT PROTECTED: that the exemption pile cannot grow. WHO CARRIES THAT
    // NOW: the deny-by-default sweep above ('every module with a trigger INPUT
    // edge-detects it on the setParam clock') is the real gate — a module that
    // declares a trigger input and does not edge-detect in setParam is RED
    // unless it is NAMED here — and the anchor loop below makes a name that no
    // longer declares a trigger input RED, so an entry cannot rot into a silent
    // blanket exemption.
    // ⚠ WHAT IS GENUINELY LOST: the number stopped growth-BY-LISTING. A sixth
    // module could not be added at all; now it can, and the only brake is review
    // of the new name in the diff (the list grew 2 → 5 on 2026-08-09 by exactly
    // that route, with the ceiling raised in the same commit — which is what a
    // ceiling that moves with its list is worth). Pre-authorised coverage loss
    // of the kill-ratchets directive.
    for (const m of CARD_OWNED_EDGE_DETECTION) {
      expect(modulesDeclaringTriggerInputs(), `${m} no longer declares a trigger input — drop the exemption`)
        .toContain(m);
    }
  });

  it('NEGATIVE CONTROL: FRAMETABLE with its setParam latch removed is caught', () => {
    // Exercises the REAL rule against the REAL file: frametable declares
    // `save_trig` as edge:'trigger', so deleting the setParam latch must trip
    // rule 2. (This is the half of the FREEZEFRAME regression that rule 2 CAN
    // see; the def-level half is rule 3's negative control below.)
    const src = stripComments(readFileSync(join(MODULES_DIR, 'frametable.ts'), 'utf8'));
    expect(TRIGGER_INPUT_RE.test(src), 'frametable declares a trigger INPUT').toBe(true);
    expect(setParamEdgeDetects(src), 'and its shipped setParam DOES edge-detect').toBe(true);

    const stripped = src.replace(/if \(paramId === 'saveTrig'\) frametableSaveWrite\([^)]*\);/, '');
    expect(stripped, 'the control actually removed the latch').not.toEqual(src);
    expect(setParamEdgeDetects(stripped), 'with the latch gone, rule 2 fires').toBe(false);
  });
});

// ===========================================================================
// RULE 3 — DEF COMPLETENESS: an input that installGateDispatch CAN FEED must
// DECLARE which reading it implements (`edge: 'trigger'` or `edge: 'gate'`).
//
// This is the rule that flags the pre-fix FREEZEFRAME def. `PortDef.edge` is
// how the repo declares trigger-vs-gate semantics ($lib/audio/gate-trigger), and
// an input with a `paramTarget` that the gate bridge can reach is exactly the
// port that will be fed installGateDispatch's REPLAY. Leaving `edge` off does
// not make the port neutral — it makes the promise unwritten, so no gate can
// check it and every reader assumes their own reading. FREEZEFRAME shipped a
// level-only consumer behind a port the owner reasonably patched a trigger into.
//
// ══════════════════════════════════════════════════════════════════════════════
// ⚠ THE `type: 'gate'` FILTER WAS A HOLE BIG ENOUGH TO RE-SHIP THE ORIGINAL BUG
// (found in review, fixed 2026-08-02 — this is the SECOND blind spot this file
// has had, and it had the same cause as the first: the gate filtered on
// something the runtime does not filter on.)
//
// Rule 3 used to require `type: 'gate'` on the port literal. THE DISPATCH DOES
// NOT LOOK AT THE TARGET'S TYPE AT ALL. `PatchEngine.installGateDispatch`
// (audio/engine.ts) keys off the SOURCE CABLE —
//
//     if (edge.sourceType !== 'gate') return false;                    // :1491
//     if (input.cvScale && input.cvScale.mode !== 'passthrough') return false;  // :1503
//
// — and `canConnect` puts `cv`, `pitch` and `gate` in ONE interchangeable
// CV_FAMILY (graph/types.ts), so a gate cable patched into a `type: 'cv'` input
// is a legal, ordinary patch that gets the REPLAY. All ten sites in rule 1's
// KNOWN_REMAINING list are `type: 'cv'` ports — i.e. the old rule 3 could not
// see a single one of the defects its sibling rule already names.
//
// MEASURED, not reasoned: with the old filter, changing freezeframe's port to
//
//     { id: 'gate_in', type: 'cv', paramTarget: 'gateLevel' }
//
// and deleting the `detectEdge` call from setParam — i.e. RE-SHIPPING THE
// LITERAL OWNER-REPORTED BUG, verbatim — left this suite 17/17 GREEN. Rule 1
// sees nothing (a module that does no edge detection has no detectEdge call to
// find), rule 2 sees nothing (it fires on `edge: 'trigger'`, and the def has no
// `edge` key), and rule 3 saw nothing (the type is now 'cv'). The negative
// control at the bottom of this describe block is that exact def, so the hole
// cannot reopen silently.
//
// The predicate now MIRRORS THE DISPATCH: a `paramTarget` input, on a type a
// gate cable can legally terminate on, with no non-passthrough `cvScale`.
//
// ⚠ Also fixed here: the literal matcher was `/\{[^{}]*\}/g`, which cannot match
// a port literal CONTAINING a nested object — so any port with an inline
// `cvScale: { … }` was invisible to rule 3 outright. Brace-matched now.
// ══════════════════════════════════════════════════════════════════════════════
//
// Declaring it forces the choice, and the choice is then checked: 'trigger'
// hands the port to rule 2; 'gate' documents that the LEVEL is what it reads.
// A port that is a genuinely CONTINUOUS level (not a gate at all) has a third,
// non-lying exit: give it a real `cvScale`, which both describes it accurately
// and takes it off the gate-dispatch path in the engine.
// ===========================================================================

/** The cable types a `gate` SOURCE may legally terminate on — CV_FAMILY
 *  (`cv`/`pitch`/`gate`, freely interchangeable) plus `modsignal`, which opts in
 *  explicitly. Kept in sync with `canConnect` in $lib/graph/types. Anything here
 *  can receive installGateDispatch's replay. */
const GATE_REACHABLE_INPUT_TYPE = /type:\s*'(gate|cv|pitch|modsignal)'/;

/** Top-level `{ … }` literals inside `body`, BRACE-MATCHED so a nested object
 *  (`cvScale: { mode: 'passthrough' }`) stays part of its port literal instead
 *  of being matched as a literal in its own right. */
function portLiterals(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') { depth--; if (depth === 0 && start >= 0) { out.push(body.slice(start, i + 1)); start = -1; } }
  }
  return out;
}

/**
 * Input ports that installGateDispatch can feed a REPLAY into but which do not
 * declare an `edge` semantic. Mirrors the dispatch's own two conditions:
 * a reachable cable type, and no non-passthrough `cvScale`.
 */
function undeclaredGateInputs(src: string): string[] {
  const at = src.search(/inputs:\s*\[/);
  if (at < 0) return [];
  const open = src.indexOf('[', at);
  let depth = 0;
  let end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(open, end);
  const out: string[] = [];
  for (const lit of portLiterals(body)) {
    if (!/paramTarget:/.test(lit)) continue;
    if (!GATE_REACHABLE_INPUT_TYPE.test(lit)) continue;
    // A non-passthrough `cvScale` means the bridge SWEEPS the param range for
    // this input — installGateDispatch explicitly declines it (engine.ts:1503),
    // so it is not in the bug class and needs no edge declaration.
    if (/cvScale:/.test(lit) && !/mode:\s*'passthrough'/.test(lit)) continue;
    if (/edge:\s*'(trigger|gate)'/.test(lit)) continue;
    out.push((/id:\s*([A-Za-z0-9_$']+)/.exec(lit)?.[1] ?? '<computed>').replace(/'/g, ''));
  }
  return out;
}

function modulesWithUndeclaredGateInputs(): Array<{ module: string; ports: string[] }> {
  const out: Array<{ module: string; ports: string[] }> = [];
  for (const path of moduleFiles()) {
    const ports = undeclaredGateInputs(stripComments(readFileSync(path, 'utf8')));
    if (ports.length) out.push({ module: path.replace(/^.*\//, '').replace(/\.ts$/, ''), ports });
  }
  return out;
}

/** THE RATCHET. Bridge-reachable inputs whose `edge` semantic is still
 *  unwritten. Not asserted to be BUGS — asserted to be UNDECLARED, which is the
 *  state pre-fix FREEZEFRAME was in. Bring one up to the bar whenever you touch
 *  its module (boy-scout rule) and delete its entry in the same commit.
 *
 *  ⚠ RE-BASELINED 2026-08-02, and the numbers went UP: 7 modules / 17 ports
 *  became 15 / 40. Nothing regressed — the old predicate was BLIND to `cv`-typed
 *  ports, which is most of them. Six of the sites it newly saw (backdraft ×6,
 *  b3ntb0x ×2, bentbox ×2) are the SAME sites rule 1's KNOWN_REMAINING already
 *  names as real defects — the clearest possible evidence that the old
 *  `type: 'gate'` filter was looking in the wrong place.
 *
 *  ⚠ SHAPE CHANGED 2026-08-09, with the edge-declaration sweep that drained
 *  gibribbon / outlines / shapegen / vfpga-runner / videobox outright and the
 *  `type: 'gate'` half of doom / picturebox / videovarispeed. It used to be a
 *  MODULE list plus a hand-typed PORT COUNT (`= 40`), and that pair is the
 *  merge hazard CLAUDE.md now names: a module list cannot see a NEW undeclared
 *  port in an already-listed module, and a typed total merges cleanly-and-wrong
 *  across parallel branches (measured 3 of 3 on the edge ledger it replaced).
 *  It is now a NAMED `(module, port)` map with NO count at all — the assertion
 *  is a deep-equal against the live scan, so it ratchets in both directions by
 *  construction: a new undeclared port reddens, and draining one without
 *  deleting its entry reddens too.
 *
 *  DELETION CRITERIA (stated, per the standard): when this map is empty, delete
 *  it and make the rule-2 demand unconditional — exactly what the audio-side
 *  edge ledger did on 2026-08-09. Everything left here needs a per-port DSP read
 *  to choose trigger / gate / a real cvScale; none of it is mechanically
 *  payable from prose, which is why it is still a ratchet and not a sweep. */
const UNDECLARED_GATE_INPUTS: Readonly<Record<string, readonly string[]>> = {
  '4plexvid': ['gate1', 'gate2', 'gate3', 'gate4'],
  acidwarp: ['scene_cv'],
  b3ntb0x: ['mirror_x_gate', 'mirror_y_gate'], // also named in rule 1's KNOWN_REMAINING
  backdraft: ['delay_clock', 'mirror_x_gate', 'mirror_y_gate', 'shape_gate', 'pure_geo_gate', 'tv_gate'],
  bentbox: ['mirror_x_gate', 'mirror_y_gate'], // also named in rule 1's KNOWN_REMAINING
  blood: ['base'],
  doom: ['portId', 'iddqd_in', 'idkfa_in'], // 'portId' = the computed-id cv-gate spread
  picturebox: ['asset_pitch'],
  scoreboard: ['score', 'reset'],
  videovarispeed: ['asset_pitch'],
};

describe('video modules: a bridge-reachable INPUT with a paramTarget must DECLARE its edge semantic', () => {
  it('no NEW undeclared bridge-reachable input appears', () => {
    const found = modulesWithUndeclaredGateInputs();
    // NAMED PER INSTANCE, not per file: a module already in the map does NOT
    // get a free pass for a new undeclared port of a different id.
    const novel = found
      .map((f) => ({
        module: f.module,
        ports: f.ports.filter((p) => !(UNDECLARED_GATE_INPUTS[f.module] ?? []).includes(p)),
      }))
      .filter((f) => f.ports.length > 0);
    expect(
      novel.map((f) => `${f.module} (${f.ports.join(', ')})`),
      novel.length === 0
        ? ''
        : [
            '',
            'These modules declare an INPUT that installGateDispatch can feed — a paramTarget',
            "on a gate-reachable cable type (cv / pitch / gate / modsignal) with no",
            'non-passthrough cvScale — but no `edge:` semantic. Two shapes, ONE bug:',
            '',
            "    { id: 'gate_in', type: 'gate', paramTarget: 'gateLevel' }   // <- no edge",
            "    { id: 'gate_in', type: 'cv',   paramTarget: 'gateLevel' }   // <- no edge, ALSO fed",
            '',
            "⚠ The second one is not a lesser case. `cv`, `pitch` and `gate` are ONE",
            'interchangeable CV_FAMILY in canConnect(), and installGateDispatch never looks at',
            "the TARGET's type — only at the source cable being `gate` and the target having no",
            'non-passthrough cvScale. A gate patched into a cv input gets the identical REPLAY',
            '(setParam 0, 1, level inside one ~25 ms tick).',
            '',
            'So the port must choose one of THREE, and each is a real, non-lying option:',
            "  • edge: 'trigger'  — fires once per rising edge. Rule 2 then requires setParam",
            '                       edge detection, so the promise is checked, not just written.',
            "  • edge: 'gate'     — the LEVEL is what it reads, acting WHILE high.",
            '  • a real cvScale   — this is a CONTINUOUS level, not a gate at all. A',
            '                       non-passthrough cvScale both says so and takes the port off',
            '                       the gate-dispatch path in the engine (engine.ts:1503).',
            '',
            'Leaving it off does not make the port neutral; it leaves the promise unwritten,',
            'and every reader then assumes their own reading. That is exactly what FREEZEFRAME',
            'shipped, and what the owner reported on 2026-07-31.',
          ].join('\n'),
    ).toEqual([]);
  });

  it('the ratchet is ANCHORED to the defs and moves in BOTH directions', () => {
    // One deep-equal does the whole job, and there is no count to keep in sync:
    // ground truth is the live scan of the defs, and the map must reproduce it
    // exactly. A NEW undeclared port reddens (the clause above, per instance);
    // an entry for a port that now declares `edge` — or that no longer exists —
    // reddens HERE, so a drain cannot forget to delete its entry and leave slack.
    const live = Object.fromEntries(
      modulesWithUndeclaredGateInputs().map((f) => [f.module, [...f.ports].sort()]),
    );
    const pinned = Object.fromEntries(
      Object.entries(UNDECLARED_GATE_INPUTS).map(([m, ps]) => [m, [...ps].sort()]),
    );
    expect(
      live,
      'undeclared bridge-reachable video inputs drifted from the ratchet.\n' +
        'A port that now declares `edge` (or is gone) must be DELETED from\n' +
        'UNDECLARED_GATE_INPUTS in the same commit; a new one must be declared,\n' +
        'not added. When the map reaches {} delete it and make the rule\n' +
        'unconditional (its stated deletion criteria).',
    ).toEqual(pinned);
  });

  it('NEGATIVE CONTROL: the verbatim pre-fix FREEZEFRAME def is flagged; the shipped one is not', () => {
    // The port literal below is copied CHARACTER FOR CHARACTER from
    // `packages/web/src/lib/video/modules/freezeframe.ts:282` as it stood on
    // `main` before commit 9be2146e (`git show origin/main:…` at the time of
    // writing). It is the def that shipped the owner-reported bug.
    const preFixDef = `
      inputs: [
        { id: 'video_in', type: 'video' },
        { id: 'gate_in', type: 'gate', paramTarget: 'gateLevel' },
      ],
    `;
    expect(undeclaredGateInputs(stripComments(preFixDef)), 'the pre-fix def is FLAGGED')
      .toEqual(['gate_in']);

    // The SHIPPED def declares edge: 'gate' and is clean — read off disk, so the
    // control tracks the real file rather than a copy that can drift.
    const shipped = stripComments(readFileSync(join(MODULES_DIR, 'freezeframe.ts'), 'utf8'));
    expect(undeclaredGateInputs(shipped), 'the shipped freezeframe def is clean').toEqual([]);
  });

  it("NEGATIVE CONTROL: the SAME def with type 'cv' instead of 'gate' is flagged TOO", () => {
    // THE control for the hole this rule shipped with. Under the old
    // `type: 'gate'` filter this def passed, and with the setParam detector also
    // removed the WHOLE SUITE stayed 17/17 green while re-shipping the literal
    // owner-reported bug. `cv` and `gate` are one CV_FAMILY in canConnect() and
    // installGateDispatch never reads the target's type, so the two defs below
    // are the SAME defect and must be treated identically.
    const asGate = "inputs: [ { id: 'gate_in', type: 'gate', paramTarget: 'gateLevel' } ],";
    const asCv = "inputs: [ { id: 'gate_in', type: 'cv', paramTarget: 'gateLevel' } ],";
    expect(undeclaredGateInputs(asGate), "the 'gate'-typed def is flagged").toEqual(['gate_in']);
    expect(undeclaredGateInputs(asCv), "the 'cv'-typed def is flagged IDENTICALLY").toEqual(['gate_in']);
    // …and pitch / modsignal, the other two a gate cable can terminate on.
    expect(undeclaredGateInputs("inputs: [ { id: 'p', type: 'pitch', paramTarget: 'x' } ],")).toEqual(['p']);
    expect(undeclaredGateInputs("inputs: [ { id: 'm', type: 'modsignal', paramTarget: 'x' } ],")).toEqual(['m']);
  });

  it('NEGATIVE CONTROL: the REAL shipped freezeframe.ts, re-typed to cv, is flagged', () => {
    // Not a snippet — the on-disk def with the exact one-token regression a
    // future editor would make. This is the def half of the 17/17-green
    // measurement; the setParam half is rule 2's business.
    const path = join(MODULES_DIR, 'freezeframe.ts');
    const shipped = readFileSync(path, 'utf8');
    const SHIPPED_PORT = "{ id: 'gate_in', type: 'gate', edge: 'gate', paramTarget: 'gateLevel' }";
    const REGRESSED_PORT = "{ id: 'gate_in', type: 'cv', paramTarget: 'gateLevel' }";
    expect(
      shipped.includes(SHIPPED_PORT),
      'the shipped gate_in port literal moved — update this control so it keeps regressing the REAL file',
    ).toBe(true);
    const regressed = stripComments(shipped.replace(SHIPPED_PORT, REGRESSED_PORT));
    expect(undeclaredGateInputs(regressed), 'the re-typed real def is FLAGGED').toEqual(['gate_in']);
  });

  it('a non-passthrough cvScale takes a port OFF the rule (it is off the dispatch path too)', () => {
    // The escape hatch has to actually work, or the rule pushes authors into
    // writing a FALSE `edge:` on a genuinely continuous input. engine.ts:1503
    // declines any target with a non-passthrough cvScale, so this port is not in
    // the bug class — and the brace-matched literal scanner is what makes the
    // nested object visible at all (the old /\{[^{}]*\}/ could not match it).
    const scaled = "inputs: [ { id: 'c', type: 'cv', paramTarget: 'x', cvScale: { mode: 'unipolar', min: 0, max: 1 } } ],";
    expect(undeclaredGateInputs(scaled), 'a swept/continuous input needs no edge declaration').toEqual([]);
    // …but an EXPLICITLY passthrough cvScale is still raw, so still in scope.
    const pass = "inputs: [ { id: 'c', type: 'cv', paramTarget: 'x', cvScale: { mode: 'passthrough' } } ],";
    expect(undeclaredGateInputs(pass), 'an explicit passthrough cvScale is still bridge-reachable').toEqual(['c']);
  });
});
