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
// ── WHAT THIS GATE STILL CANNOT SEE (state it, don't imply completeness) ──
// It matches the DIRECT form `edgeFn(state, params.<id>)`, which is the form
// both real bugs took. An edge read that launders the level through a local
// first —
//     const sample = params[key];  …  detectEdge(state, sample)
// — is NOT matched. `vfpga-runner.ts` (`tickGates`, called from draw) is exactly
// that shape and is therefore invisible here; it is listed in KNOWN_UNMATCHABLE
// by hand so it is at least counted. Widening the matcher to arbitrary dataflow
// needs a real AST pass; the direct form is where the value is.

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

/**
 * Every named function-ish declaration WITH ITS BODY RANGE. Handles
 * `function f(…) {…}`, `const f = (…) => {…}`, `const f = (…) => expr;` and
 * `const f = function (…) {…}`.
 *
 * ⚠ The body must be delimited PROPERLY, not by "the next `{` in the file".
 * An expression-bodied arrow (`const clamp01 = (v: number) => Math.min(1, v);`)
 * has no block at all, and taking the next brace swallows an unrelated function
 * further down — which made an earlier draft of this scanner classify `clamp01`
 * and `clampSym` as edge detectors and report 27 phantom sites.
 */
function declSites(src: string): Decl[] {
  const out: Decl[] = [];
  const re = /(?:export\s+)?function\s+([A-Za-z0-9_$]+)\s*\(|(?:const|let)\s+([A-Za-z0-9_$]+)\s*(?::[^=;]*?)?=\s*(?:async\s+)?(?:function\b\s*\*?\s*\(|\()/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = (m[1] ?? m[2])!;
    const parenAt = src.indexOf('(', m.index + m[0].length - 1);
    if (parenAt < 0) continue;
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
 * THE RATCHET. Sites that still read the level at draw time, verified one by one
 * on 2026-08-01. This list may only SHRINK. Every entry is a real defect: a gate
 * SOURCE patched into any of these ports is delivered by installGateDispatch
 * (they are all raw-passthrough — "NO cvScale => raw passthrough" in their own
 * def comments), so a TRIGGER into them does nothing at all. A HELD gate still
 * works, which is why they have gone unnoticed: the level stands across ticks,
 * so the draw-time detector does see that rise.
 *
 * NOT fixed in the FREEZEFRAME PR on purpose — each needs its own behavioural
 * verification, and BACKDRAFT is a look-affecting module under the WebGL attest
 * (owner-preview-before-merge). Tracked as follow-up work; the point of the
 * ratchet is that they are now COUNTED and no new one can join them.
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
 *  Listed so the true remaining count is honest, not so the gate can see them. */
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

  it('the ratchet only shrinks — every known site still exists', () => {
    // If a listed site is gone, someone FIXED it: drop the entry (and the count
    // ceiling below) in the same commit. A ratchet nobody tightens is a comment.
    const found = new Set(scanAll().map(key));
    const stale = KNOWN_REMAINING.filter((k) => !found.has(k));
    expect(
      stale,
      `these ratchet entries no longer exist — they were fixed, so REMOVE them from KNOWN_REMAINING (and lower the ceiling): ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('the known-remaining count is at its ceiling and cannot grow', () => {
    expect(KNOWN_REMAINING.length, 'unfixed level-read-at-draw sites').toBeLessThanOrEqual(10);
    expect(KNOWN_UNMATCHABLE.length, 'sites the scanner cannot see').toBeLessThanOrEqual(1);
  });

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
 *  tracked as follow-up alongside the KNOWN_REMAINING ratchet above. */
const CARD_OWNED_EDGE_DETECTION: readonly string[] = ['tv-librarian', 'peertube'];

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

  it('the card-owned exemption list stays small and cannot silently grow', () => {
    // Each entry is an UNVERIFIED trigger path, not an approved design.
    expect(CARD_OWNED_EDGE_DETECTION.length).toBeLessThanOrEqual(2);
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
// RULE 3 — DEF COMPLETENESS: a gate-cable INPUT that routes to a param must
// DECLARE which reading it implements (`edge: 'trigger'` or `edge: 'gate'`).
//
// This is the rule that flags the pre-fix FREEZEFRAME def. `PortDef.edge` is
// how the repo declares trigger-vs-gate semantics ($lib/audio/gate-trigger), and
// an input with a `paramTarget` on the gate cable is exactly the port that will
// be fed by installGateDispatch's REPLAY. Leaving `edge` off does not make the
// port neutral — it makes the promise unwritten, so no gate can check it and
// every reader assumes their own reading. FREEZEFRAME shipped a level-only
// consumer behind a port the owner reasonably patched a trigger into.
//
// Declaring it forces the choice, and the choice is then checked: 'trigger'
// hands the port to rule 2; 'gate' documents that the LEVEL is what it reads.
// ===========================================================================

/** Input port literals: `{ … type: 'gate' … paramTarget: … }` inside `inputs:`. */
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
  const re = /\{[^{}]*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const lit = m[0];
    if (!/paramTarget:/.test(lit)) continue;
    if (!/type:\s*'gate'/.test(lit)) continue;
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

/** THE RATCHET, shrink-only. Gate inputs whose `edge` semantic is still
 *  unwritten, counted on 2026-08-01. Not asserted to be BUGS — asserted to be
 *  UNDECLARED, which is the state pre-fix FREEZEFRAME was in. Bring one up to
 *  the bar whenever you touch its module (boy-scout rule) and lower both
 *  numbers in the same commit. */
const UNDECLARED_GATE_INPUT_MODULES: readonly string[] = [
  'gibribbon',      // clock, gate, a, b, x_btn, y_btn
  'outlines',       // gate, collide
  'picturebox',     // asset_gate
  'shapegen',       // clock
  'vfpga-runner',   // gate_evt_N (computed id)
  'videobox',       // play_trigger
  'videovarispeed', // cv_start, cv_pause, cv_reset, cv_loop_toggle, asset_gate
];
const UNDECLARED_GATE_INPUT_PORTS = 17;

describe('video modules: a gate INPUT with a paramTarget must DECLARE its edge semantic', () => {
  it('no NEW undeclared gate input appears', () => {
    const found = modulesWithUndeclaredGateInputs();
    const novel = found.filter((f) => !UNDECLARED_GATE_INPUT_MODULES.includes(f.module));
    expect(
      novel.map((f) => `${f.module} (${f.ports.join(', ')})`),
      novel.length === 0
        ? ''
        : [
            '',
            "These modules declare a `type: 'gate'` INPUT with a paramTarget but no `edge:`",
            'semantic — the shape pre-fix FREEZEFRAME shipped in:',
            '',
            "    { id: 'gate_in', type: 'gate', paramTarget: 'gateLevel' }   // <- no edge",
            '',
            'installGateDispatch feeds that port a REPLAY (setParam 0,1,level in one tick), so',
            "a consumer must choose: edge: 'trigger' (fires once per rising edge — then rule 2",
            "requires setParam edge detection) or edge: 'gate' (the LEVEL is what it reads).",
            'Leaving it off does not make the port neutral; it leaves the promise unwritten.',
          ].join('\n'),
    ).toEqual([]);
  });

  it('the undeclared ratchet only shrinks', () => {
    const found = modulesWithUndeclaredGateInputs();
    const names = new Set(found.map((f) => f.module));
    const stale = UNDECLARED_GATE_INPUT_MODULES.filter((m) => !names.has(m));
    expect(stale, `these modules now declare their gate semantics — REMOVE them from the ratchet: ${stale.join(', ')}`)
      .toEqual([]);
    const ports = found.reduce((n, f) => n + f.ports.length, 0);
    expect(ports, 'undeclared gate INPUT ports').toBeLessThanOrEqual(UNDECLARED_GATE_INPUT_PORTS);
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
});
