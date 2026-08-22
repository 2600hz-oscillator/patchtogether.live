// scripts/vrt-scope.mjs
//
// DERIVE THE CAPTURE SCOPE for `task vrt:commit` (#1795).
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// `vrt-update.yml`'s capture is ONE unsharded job over the whole FULL_MATCH
// spec set. MEASURED on the eight dispatches of 2026-08-17 (run ids in #1795):
//
//     unscoped capture   56 / 56 / 54 / 41 min
//     scoped capture      3 /  3 min
//
// The scoping capability already existed — `task vrt:commit` forwards `GREP` as
// `-f grep=…` — but nothing chose it for you, so the documented entry point
// (a bare `task vrt:commit`) swept everything. Everyone doing the obvious thing
// paid ~50 min for a change that usually touches ONE module. This file makes
// the scoped path the DEFAULT by deriving the token from the branch's own diff,
// and leaves the full sweep as an explicit `ALL=1`.
//
// ── WHY A SCOPED DEFAULT IS SAFE (the load-bearing argument) ───────────────
//
// A scoped capture cannot silently UNDER-capture in the population that gates:
// if the change moved a baseline the grep did not cover, `vrt-strict` —
// REQUIRED, 4 shards, `vrt.spec.ts` (STRICT_VRT_MODULES) + every face in
// `workflow-shell-faces.spec.ts` — goes RED on the next CI run and NAMES the
// file. The worst case is one extra round trip, not a stale baseline shipping
// green.
//
// ⚠ State the limit of that argument honestly: the informational full `vrt`
// job was DELETED from ci.yml on 2026-08-17, so the specs OUTSIDE the strict
// set (composites, topbar, playhead, interactions, groups, dashboard, landing,
// toybox, …) are compared by NO lane at all today, scoped or not. Scoping does
// not weaken a gate there, because there is no gate there — but do not read the
// safety argument as covering them.
//
// ── The shape of the decision ─────────────────────────────────────────────
//
// DENY BY DEFAULT. A branch is scoped only when EVERY changed file is either
//   * ignorable — it cannot move a rendered pixel (named list below, each entry
//     carrying its own reason), or
//   * attributable to ONE module type, by its PATH or by the module names its
//     own diff hunks add/remove,
// and the union of those attributions is exactly ONE type. Anything else —
// an unattributable renderable file (a shared primitive, a global stylesheet, a
// spec, a lockfile), or two or more distinct modules — falls back to the FULL
// sweep and says so, LOUDLY, with the file or the token list that forced it.
//
// ⚠ The multi-population case is REAL and is why the fallback is not optional:
// #1822 spans "cards mounting a fader", "cards carrying a domain-chain control"
// and "faces declaring a fader cell" — three populations that no single token
// expresses. Capturing a third of what moved would be far worse than the 50
// minutes.
//
// ⚠ THE TOKEN IS A SINGLE SHELL-SAFE WORD, and that is a hard constraint, not
// style. The capture step runs `task vrt:update -- --grep "$GREP"`, and go-task
// joins CLI_ARGS into a shell line UNQUOTED — an alternation like `a|b` would
// be word-split into a PIPE (the same hazard ci.yml's `vrt-strict-shard` job
// calls out when it bypasses the Taskfile to pass its own alternation). So a
// derived scope is one token matched as a SUBSTRING of the title path, never a
// regex we assembled. Over-capture (`polarizer` also selecting `depolarizer`)
// is harmless; under-capture is the thing being guarded.
//
// Anchored to artifacts, never to hand-typed counts: the module universe is the
// generated registry manifest, and the predicted cost is Playwright's own
// `--list` discovery filtered through the SAME grep model `vrt-shard-plan.mjs`
// probed against @playwright/test 1.59 (`grepTarget`).

import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error — plain .mjs with JSDoc types, no declaration file
import { grepTarget, testsFromListJson } from './vrt-shard-plan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Where `task test:emit-manifest` writes the registry projection. */
export const MANIFEST_PATH = 'e2e/.generated/registry-manifest.json';

// ───────────────────────── tokenization ──────────────────────────
//
// A file is attributed to a module by WORD SEQUENCE, not by substring of the
// raw path. `RearCard.svelte` must not attribute to a module called `rear`, and
// `analog-logic-maths-face-model.ts` must attribute to `analogLogicMaths` —
// both fall out of splitting on non-alphanumerics AND camelCase boundaries and
// then asking for a contiguous run.

/** Lowercase word list: splits on non-alphanumerics and camelCase boundaries. */
export function words(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** Every start index at which `needle` occurs as a contiguous run inside `hay`. */
export function runIndices(hay, needle) {
  const out = [];
  if (needle.length === 0 || needle.length > hay.length) return out;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// ───────────────────────── ignorable files ───────────────────────
//
// DENY BY DEFAULT: a path is skipped only if it matches a NAMED entry here, and
// every entry states the reason it cannot move a rendered pixel. Anything not
// listed is treated as renderable, so an unrecognised file forces the full
// sweep rather than being quietly dropped from the decision.
//
// ⚠ `*.test.ts` is ignorable (vitest never renders a card); `*.spec.ts` under
// `e2e/` is NOT — a spec change can change what is captured.
export const IGNORABLE = [
  { why: 'markdown prose — no VRT scene renders a repo document', test: (p) => p.endsWith('.md') },
  { why: 'agent notes and skills — not shipped to the browser', test: (p) => p.startsWith('.myrobots/') || p.startsWith('.claude/') },
  {
    why: 'repo prose (the SvelteKit docs ROUTES live under packages/web/src/routes/docs and are not in this list)',
    test: (p) => p.startsWith('docs/') || p.startsWith('runbooks/'),
  },
  { why: 'ART audio baselines and scenarios — audio, not pixels', test: (p) => p.startsWith('art/') },
  { why: 'SQL schema — nothing in it reaches a rendered card', test: (p) => p.startsWith('db/') },
  { why: 'CI/tooling; nothing here is served to the browser', test: (p) => p.startsWith('.github/') || p.startsWith('scripts/') || p === 'Taskfile.yml' },
  { why: 'vitest unit test — never renders a card', test: (p) => p.endsWith('.test.ts') },
  {
    why: 'attest receipt — CI bookkeeping, no runtime effect',
    test: (p) => /^ci-[a-z0-9-]*attest\//.test(p),
  },
  {
    // e2e/vrt/vrt.config.ts has testDir '.' (i.e. e2e/vrt) and a FULL_MATCH of
    // bare filenames, so a spec under e2e/tests/ is never loaded by a capture.
    // ⚠ HELPERS there ARE loaded (`vrt.spec.ts` imports ../tests/_helpers and
    // ../tests/_registry), so this is scoped to `*.spec.ts` on purpose.
    why: 'functional e2e spec — the VRT config only loads specs under e2e/vrt/',
    test: (p) => p.startsWith('e2e/tests/') && p.endsWith('.spec.ts'),
  },
  { why: 'the OUTPUT of a capture, not an input to it', test: (p) => p.startsWith('e2e/vrt/__screenshots__/') },
  {
    why: 'generated review artifact (ledgers, timings, manifests) — reviewed as a diff, never rendered',
    test: (p) => /\.generated\.(md|json|txt)$/.test(p),
  },
  { why: 'generated docs contract pin — not rendered by any VRT scene', test: (p) => p.endsWith('lib/docs/contract-lock.txt') },
];

/** @returns the reason this path cannot move a baseline, or null. */
export function ignorableReason(path) {
  for (const e of IGNORABLE) if (e.test(path)) return e.why;
  return null;
}

// ───────────────────────── attribution ───────────────────────────

/**
 * The forms a module type can wear in a path or an identifier.
 *
 * `slewSwitch` ships as `SlewSwitchCard.svelte` (camelCase → words), as
 * `slewswitch-face-model.ts` and `packages/dsp/src/slewswitch.ts` (ALL ONE
 * WORD — the DSP and face-model files do not carry the hyphen), and as
 * `slewswitch-settle` in a readout key. Matching only the word sequence missed
 * every all-lowercase spelling and sent three real single-module PRs to the
 * full sweep, so the concatenation is a first-class form.
 */
export function typeForms(type) {
  const w = words(type);
  const forms = [w];
  if (w.length > 1) forms.push([w.join('')]);
  return forms;
}

/** Every start index at which ANY form of `type` occurs in `hay`. */
function formHits(hay, type) {
  const idx = [];
  let len = 0;
  for (const form of typeForms(type)) {
    const at = runIndices(hay, form);
    if (at.length) {
      idx.push(...at);
      len = Math.max(len, form.length);
    }
  }
  return { idx: [...new Set(idx)].sort((a, b) => a - b), len };
}

/**
 * The module types a PATH names, longest-match-wins.
 *
 * `analog-vco-scope.ts` matches both `analogVco` (words 0-1) and `scope`
 * (word 2); `packages/…/modules/cube/x.ts` matches `cube`. A shorter type whose
 * span is entirely inside a longer type's span is dropped, so
 * `analogVcoScope`-style names do not also drag in their prefixes. Two types at
 * DISJOINT spans both survive — and two tokens means the full sweep, which is
 * the safe direction.
 */
export function typesInPath(path, types) {
  const hay = words(path);
  const hits = [];
  for (const t of types) {
    const { idx, len } = formHits(hay, t);
    if (idx.length) hits.push({ type: t, len, idx });
  }
  hits.sort((a, b) => b.len - a.len || (a.type < b.type ? -1 : 1));
  const claimed = [];
  const covered = (start, len) => claimed.some((c) => start >= c[0] && start + len <= c[1]);
  const out = [];
  for (const h of hits) {
    const free = h.idx.filter((i) => !covered(i, h.len));
    if (free.length === 0) continue;
    out.push(h.type);
    for (const i of free) claimed.push([i, i + h.len]);
  }
  return out.sort();
}

/**
 * Drop whole-line comments from hunk text.
 *
 * ⚠ MEASURED, and it is the difference between this file working and not: the
 * prose in this repo NAMES OTHER MODULES CONSTANTLY. Scanning the raw hunks of
 * the analogLogicMaths promotion (5ecae1796) implicated SIX modules — every
 * extra one came from an explanatory comment (`strict-faces.ts` alone cited
 * `ninelives` and `illogic` in its rationale), so the derivation fell back to
 * the full sweep on a textbook single-module PR.
 *
 * This drops only lines whose FIRST non-space character starts a comment, so a
 * code line with a trailing `//` keeps its code — the CLAUDE.md hazard about a
 * `//`-stripping regex eating `'https://x'` cannot bite, because no line is
 * edited, only whole comment lines are removed. (`attest-code-basis.ts` does
 * the real parse; this is a heuristic on a diff, where there is no parseable
 * program to hand.)
 */
export function codeLines(text) {
  return String(text)
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (!t) return false;
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#'));
    })
    .join('\n');
}

/**
 * The contents of every string literal on the given code lines — '…', "…" and
 * `…` — concatenated. Per-line on purpose: this runs on DIFF HUNKS, where a
 * multiline template has no guaranteed opening and closing line, so a
 * line-spanning parse would be pretending to a precision the input cannot
 * carry.
 */
export function stringLiteralText(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    for (const m of line.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)) {
      out.push(m[1] ?? m[2] ?? m[3] ?? '');
    }
  }
  return out.join('\n');
}

/**
 * The module types a file's CHANGED CODE names.
 *
 * This is what keeps a face PR scoped: `strict-faces.ts`, `_shell-faces.ts`,
 * `sidebar-panels.ts`, `face-readout-values.ts`, `card-def-debt.ts` and
 * `raw-write-ledger.ts` are shared ROSTER files whose PATH names no module, but
 * whose diff registers exactly the module being promoted — as
 * `'DestroyCard.svelte'`, as `slewSwitchSettleText`, as
 * `'$lib/ui/modules/slewswitch-face-model'`, as `'slewswitch-settle'`. Every
 * one of those spellings is the same word run once the text is tokenized the
 * way a path is, which is why this shares `words()` with `typesInPath`.
 *
 * Comment-stripped first, and that is not a nicety — see `codeLines`.
 *
 * ⚠ SINGLE-WORD types match only inside STRING LITERALS (#2116). A one-word
 * module name is also an ordinary identifier — `.filter((e) => …)` implicated
 * the `filter` MODULE, `patch.edges`/`buildEdges` would implicate `edges`, and
 * this file's own `codeLines` collides with `lines` — so a bare-identifier hit
 * on a one-word type is noise that forces a full sweep and teaches operators to
 * discount the fallback. The evidence a roster diff actually carries for a
 * one-word module is its STRING spellings (`'mapper'`, `type: 'tempest'`,
 * `'$lib/video/modules/mapper'`, `'mapper-face-model'`), so that is what
 * counts. Multi-word types keep the identifier match — `slewSwitchSettleText`
 * is real evidence and a contiguous [slew, switch] run does not occur in
 * ordinary code by accident.
 *
 * Safety direction, stated plainly: a one-word module named ONLY as a bare
 * identifier (an `EXTENSION_BODY_ROLES` key with no string spelling anywhere in
 * the file's diff) now yields no token here — which makes that file a BLOCKER
 * in `deriveVrtScope`, i.e. a LOUD full sweep, never a silent under-capture.
 */
export function typesInDiffText(text, types) {
  if (!text) return [];
  const code = codeLines(text);
  const hay = words(code);
  if (hay.length === 0) return [];
  const strHay = words(stringLiteralText(code));
  return types
    .filter((t) => formHits(words(t).length > 1 ? hay : strHay, t).idx.length > 0)
    .sort();
}

/**
 * Parse `git diff -U0` into `path -> changed-line text` (added AND removed).
 *
 * `-U0` means there are no context lines, so a module named only in surrounding
 * unchanged code cannot leak into the attribution.
 */
export function parseChangedLines(diffText) {
  const byFile = new Map();
  let cur = null;
  for (const line of String(diffText).split('\n')) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      cur = m[2] || m[1];
      if (!byFile.has(cur)) byFile.set(cur, []);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+') || line.startsWith('-')) byFile.get(cur).push(line.slice(1));
  }
  return new Map([...byFile].map(([k, v]) => [k, v.join('\n')]));
}

// ───────────────────────── the decision ──────────────────────────

/**
 * TWO PHASES, and the order is the whole design.
 *
 * PHASE 1 — PATH. A file whose own path names a module belongs to that module.
 * This is the precise evidence and it is the ONLY thing that adds a token.
 *
 * PHASE 2 — CONTENT, for the files phase 1 could not place. A shared roster
 * file (`strict-faces.ts`, `face-readout-values.ts`, `card-def-debt.ts`, …)
 * changes in every face PR, so treating it as unattributable would send every
 * single-module PR to the 50-minute sweep — which is the defect. So its diff is
 * read, and:
 *
 *   · names a module phase 1 already implicated  → EXPLAINED, adds nothing;
 *   · names only OTHER modules                   → those are added (which means
 *                                                  ≥2 tokens, i.e. full sweep);
 *   · names no module at all                     → BLOCKER, full sweep. This is
 *                                                  the shared primitive / global
 *                                                  stylesheet / spec case.
 *
 * ⚠ THE ONE THING THIS CAN GET WRONG, stated plainly: a roster file that
 * changed entries for TWO modules is "explained" by the one phase 1 found, so a
 * co-named module's baseline can go uncaptured. That is precisely the case
 * `vrt-strict` catches — it renders EVERY face and the strict card set, is
 * REQUIRED, and names the file it fails on. Those co-named modules are reported
 * at dispatch (`alsoNamed`) so the operator can widen the scope on sight rather
 * than learning it from a red run.
 *
 * @param {{files: string[], types: string[], changedLines?: Map<string,string>}} input
 * @returns {{
 *   mode: 'scoped'|'full'|'none',
 *   token: string|null,
 *   tokens: string[],
 *   alsoNamed: string[],
 *   attributions: {file: string, types: string[], via: 'path'|'diff'}[],
 *   blockers: {file: string, why: string}[],
 *   ignored: {file: string, why: string}[],
 *   reason: string,
 * }}
 */
export function deriveVrtScope({ files, types, changedLines = new Map() }) {
  const attributions = [];
  const blockers = [];
  const ignored = [];
  const tokens = new Set();
  const alsoNamed = new Set();

  const renderable = [];
  for (const file of files) {
    const skip = ignorableReason(file);
    if (skip) ignored.push({ file, why: skip });
    else renderable.push(file);
  }

  // Phase 1 — path.
  const unplaced = [];
  for (const file of renderable) {
    const hit = typesInPath(file, types);
    if (hit.length === 0) {
      unplaced.push(file);
      continue;
    }
    attributions.push({ file, types: hit, via: 'path' });
    for (const t of hit) tokens.add(t);
  }

  // Phase 2 — content, for what the paths could not place.
  //
  // Split into two passes ON PURPOSE: every file is judged against the SAME
  // phase-1 token set. A single pass would make the verdict depend on the order
  // git happened to list the files in — one file could add a token that
  // "explains" the next — and a decision function that reads its own output is
  // not one you can test.
  const contentHits = new Map(unplaced.map((f) => [f, typesInDiffText(changedLines.get(f) ?? '', types)]));
  const pathTokens = new Set(tokens);
  for (const [file, hit] of contentHits) {
    if (hit.length === 0) {
      blockers.push({ file, why: 'renderable, and its changed code names no module' });
      continue;
    }
    const known = hit.filter((t) => pathTokens.has(t));
    if (known.length > 0) {
      attributions.push({ file, types: known, via: 'diff' });
      for (const t of hit) if (!pathTokens.has(t)) alsoNamed.add(t);
      continue;
    }
    attributions.push({ file, types: hit, via: 'diff' });
    for (const t of hit) tokens.add(t);
  }

  const list = [...tokens].sort();
  const also = [...alsoNamed].filter((t) => !tokens.has(t)).sort();
  const decision = (mode, token, reason) => ({
    mode,
    token,
    tokens: list,
    alsoNamed: also,
    attributions,
    blockers,
    ignored,
    reason,
  });

  if (blockers.length) {
    return decision(
      'full',
      null,
      `${blockers.length} changed file(s) can move a baseline but name no module — the blast radius is not expressible as one token`,
    );
  }
  if (list.length === 0) return decision('none', null, 'no changed file on this branch can move a VRT baseline');
  if (list.length > 1) {
    return decision('full', null, `${list.length} modules are implicated (${list.join(', ')}) and GREP takes a SINGLE token`);
  }
  return decision('scoped', list[0], `every changed file is either ignorable or attributable to ${list[0]}`);
}

/** Reject anything that would not survive go-task's unquoted CLI_ARGS join. */
export const TOKEN_RE = /^[A-Za-z0-9_.-]+$/;

// ───────────────────────── selection model ───────────────────────

/**
 * Which discovered tests does `token` select? Substring match against the SAME
 * string Playwright applies `--grep` to (`chromium-vrt <file> <describe>
 * <title>`), probed in vrt-shard-plan.mjs.
 */
export function selectionFor(token, tests) {
  const re = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const hit = tests.filter((t) => re.test(grepTarget(t)));
  return { tests: hit, files: [...new Set(hit.map((t) => t.file))].sort() };
}

// ───────────────────────────── CLI ───────────────────────────────
//
//   node scripts/vrt-scope.mjs decide [--branch <b>] [--base <ref>]
//       → stdout: exactly one line, `SCOPE <token>` or `FULL`
//         stderr: the human-readable report
//         exit 0 decided · 3 nothing to capture · 1 the tooling failed
//   node scripts/vrt-scope.mjs check --grep <token|empty>
//       → CI-side: validate the token, count what it selects, refuse a grep
//         that selects NOTHING, and write the job summary.

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

function fail(msg) {
  process.stderr.write(`\nvrt-scope: ${msg}\n`);
  process.exit(1);
}

/**
 * @param {boolean} refresh re-run the producer even when the file is present.
 *   The DERIVATION refreshes (a manifest predating this branch would not know a
 *   module the branch added, and the derivation would attribute its files to
 *   nothing); the CI-side CHECK does not, because `task vrt:update` re-emits it
 *   minutes later anyway and a second vitest boot is pure wall time.
 */
function emitManifest(refresh) {
  if (!refresh) {
    try {
      readFileSync(join(ROOT, MANIFEST_PATH), 'utf8');
      return { status: 0 };
    } catch {
      /* fall through and produce it */
    }
  }
  return run('task', ['test:emit-manifest'], { stdio: ['ignore', 'ignore', 'pipe'] });
}

function loadTypes() {
  const emit = emitManifest(true);
  let text;
  try {
    text = readFileSync(join(ROOT, MANIFEST_PATH), 'utf8');
  } catch {
    fail(
      `could not read ${MANIFEST_PATH} (and \`task test:emit-manifest\` did not produce it${
        emit.stderr ? `: ${String(emit.stderr).trim().split('\n').slice(-3).join(' ')}` : ''
      }).\n` +
        `  Fix the checkout, or choose the scope yourself:\n` +
        `    GREP=<token> task vrt:commit     # scope to one module\n` +
        `    ALL=1        task vrt:commit     # deliberate full sweep`,
    );
  }
  if (emit.status !== 0) {
    process.stderr.write(
      `vrt-scope: WARNING — \`task test:emit-manifest\` failed; using the manifest already on disk, which may not know a module this branch added.\n`,
    );
  }
  return JSON.parse(text).modules.map((m) => m.type);
}

function discover() {
  // `vrt.spec.ts` iterates the registry manifest at FILE-PARSE time
  // (e2e/tests/_registry.ts), so discovery — not just the run — needs it on
  // disk. Same reason ci.yml's vrt-strict-shard emits it before `--list`.
  emitManifest(false);
  const r = run('npx', [
    '--workspace',
    'e2e',
    'playwright',
    'test',
    '--config=vrt/vrt.config.ts',
    '--list',
    '--reporter=json',
  ]);
  if (r.status !== 0) {
    fail(
      `Playwright discovery failed, so the predicted cost of this capture cannot be stated:\n` +
        `${String(r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n')}\n\n` +
        `  Fix the checkout (npm install / task setup), or choose the scope yourself:\n` +
        `    GREP=<token> task vrt:commit     # scope to one module\n` +
        `    ALL=1        task vrt:commit     # deliberate full sweep`,
    );
  }
  return testsFromListJson(JSON.parse(r.stdout));
}

function bar(title) {
  return `\n── ${title} ${'─'.repeat(Math.max(0, 66 - title.length))}\n`;
}

function decide(args) {
  const flag = (n, d) => {
    const i = args.indexOf(n);
    return i === -1 ? d : args[i + 1];
  };
  const branch = flag('--branch', '');
  let base = flag('--base', '');
  if (!base) {
    for (const cand of ['origin/main', 'main']) {
      if (run('git', ['rev-parse', '--verify', '--quiet', cand]).status === 0) {
        base = cand;
        break;
      }
    }
  }
  if (!base) fail('no origin/main or main to diff against — pass --base <ref>, GREP=<token> or ALL=1');

  const nameOnly = run('git', ['diff', '--name-only', `${base}...HEAD`]);
  if (nameOnly.status !== 0) fail(`git diff failed: ${String(nameOnly.stderr).trim()}`);
  const files = nameOnly.stdout.split('\n').filter(Boolean);
  const patch = run('git', ['diff', '-U0', `${base}...HEAD`]);
  const changedLines = parseChangedLines(patch.stdout ?? '');

  const types = loadTypes();
  const d = deriveVrtScope({ files, types, changedLines });

  let report = bar('VRT capture scope (derived — #1795)');
  report += `  branch      ${branch || '(current)'}\n`;
  report += `  base        ${base} (${files.length} changed file(s))\n`;

  // ⚠ The capture checks out origin/<branch>; the derivation read the LOCAL
  // tree. If they differ, the scope describes a different set of changes than
  // the one CI is about to capture.
  if (branch) {
    const local = run('git', ['rev-parse', 'HEAD']).stdout?.trim();
    const remote = run('git', ['rev-parse', '--verify', '--quiet', `origin/${branch}`]).stdout?.trim();
    if (remote && local && remote !== local) {
      report += `  WARNING     local HEAD ${local.slice(0, 9)} != origin/${branch} ${remote.slice(0, 9)} —\n`;
      report += `              the capture runs the REMOTE tree; push first, or the scope may not cover it.\n`;
    }
  }

  if (d.mode === 'none') {
    report += `\n  NOTHING TO CAPTURE — ${d.reason}.\n`;
    report += `  Every changed file is one the capture cannot move:\n`;
    for (const g of d.ignored.slice(0, 12)) report += `    ${g.file}  (${g.why})\n`;
    if (d.ignored.length > 12) report += `    … and ${d.ignored.length - 12} more\n`;
    report += `\n  Dispatch anyway if you believe a baseline is stale for another reason:\n`;
    report += `    GREP=<token> task vrt:commit\n    ALL=1        task vrt:commit\n`;
    process.stderr.write(report);
    process.exit(3);
  }

  const tests = discover();

  if (d.mode === 'full') {
    report += `\n  FULL SWEEP — ${d.reason}.\n`;
    if (d.blockers.length) {
      report += `  Forced by:\n`;
      for (const b of d.blockers.slice(0, 12)) report += `    ${b.file}  (${b.why})\n`;
      if (d.blockers.length > 12) report += `    … and ${d.blockers.length - 12} more\n`;
    }
    if (d.tokens.length) report += `  Modules named by the diff: ${d.tokens.join(', ')}\n`;
    report += `  Cost: ${tests.length} tests across ${new Set(tests.map((t) => t.file)).size} spec files, ONE unsharded job.\n`;
    if (d.tokens.length > 1) {
      report += `\n  If ONE of these covers everything that moved, scope it and pay minutes instead:\n`;
      report += `    GREP=${d.tokens[0]} task vrt:commit\n`;
    }
    process.stderr.write(report);
    process.stdout.write('FULL\n');
    return;
  }

  const sel = selectionFor(d.token, tests);
  if (sel.tests.length === 0) {
    report += `\n  NOTHING TO CAPTURE — the diff implicates '${d.token}', which no VRT test renders\n`;
    report += `  (exempt in e2e/vrt/vrt-exemptions.ts, or it has no scene).\n`;
    report += `  Dispatch anyway with GREP=<token> or ALL=1 if you believe otherwise.\n`;
    process.stderr.write(report);
    process.exit(3);
  }

  report += `  scope       ${d.token}\n`;
  report += `  selects     ${sel.tests.length} of ${tests.length} tests · ${sel.files.length} of ${
    new Set(tests.map((t) => t.file)).size
  } spec files\n`;
  report += `  attributed  ${d.attributions.length} file(s), ${d.ignored.length} ignored\n`;
  for (const a of d.attributions.slice(0, 8)) report += `    ${a.file}  (by ${a.via})\n`;
  if (d.attributions.length > 8) report += `    … and ${d.attributions.length - 8} more\n`;
  report += `  spec files  ${sel.files.join(', ')}\n`;
  if (d.alsoNamed.length) {
    // Named by a shared roster file's diff alongside the scoped module. NOT
    // captured — surfaced so a genuine second population is visible here rather
    // than in a red vrt-strict run.
    report += `  also named  ${d.alsoNamed.join(', ')} (mentioned by a shared file; NOT captured)\n`;
  }
  report += `\n  A scoped capture cannot silently under-capture where it matters: if this\n`;
  report += `  change moved a baseline outside the scope, vrt-strict (required) reddens and\n`;
  report += `  names the file. Sweep everything deliberately with:  ALL=1 task vrt:commit\n`;
  process.stderr.write(report);
  process.stdout.write(`SCOPE ${d.token}\n`);
}

function check(args) {
  const i = args.indexOf('--grep');
  const grep = i === -1 ? '' : (args[i + 1] ?? '');
  const summary = [];
  if (grep && !TOKEN_RE.test(grep)) {
    fail(
      `grep '${grep}' is not a single shell-safe token (${TOKEN_RE}).\n` +
        `  The capture runs \`task vrt:update -- --grep "$GREP"\` and go-task joins CLI_ARGS\n` +
        `  into a shell line UNQUOTED, so a space or a '|' is word-split into something else\n` +
        `  entirely — most likely a capture that silently rewrites EVERY baseline.`,
    );
  }
  const tests = discover();
  const total = tests.length;
  const specs = new Set(tests.map((t) => t.file)).size;
  if (grep) {
    const sel = selectionFor(grep, tests);
    summary.push(`**Scope:** \`${grep}\` — selects **${sel.tests.length} of ${total}** tests across ${sel.files.length} of ${specs} spec files.`);
    summary.push('', ...sel.files.map((f) => `- \`${f}\``));
    if (sel.tests.length === 0) {
      writeSummary([
        `## VRT capture`,
        '',
        `**REFUSED:** grep \`${grep}\` selects **0 of ${total}** tests — this capture would render nothing and commit nothing,`,
        `which is indistinguishable from a capture that never ran. Fix the token or dispatch without one.`,
      ]);
      fail(`grep '${grep}' selects 0 of ${total} discovered tests — refusing to burn a runner on a capture that renders nothing.`);
    }
    process.stderr.write(`vrt-scope: '${grep}' selects ${sel.tests.length}/${total} tests across ${sel.files.length}/${specs} spec files.\n`);
  } else {
    summary.push(`**Scope:** FULL SWEEP — all **${total}** tests across ${specs} spec files, in ONE unsharded job.`);
    summary.push('', 'Scope the next one with `GREP=<token> task vrt:commit` (or let `task vrt:commit` derive it) — measured 3 min vs 41-56 min (#1795).');
    process.stderr.write(`vrt-scope: FULL SWEEP — ${total} tests across ${specs} spec files.\n`);
  }
  writeSummary([`## VRT capture`, '', ...summary]);
}

function writeSummary(lines) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, lines.join('\n') + '\n');
  } catch {
    /* summary is reporting, never a gate — never fail the run over it */
  }
}

const isMain = typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('vrt-scope.mjs');
if (isMain) {
  const args = process.argv.slice(2);
  if (args[0] === 'decide') decide(args.slice(1));
  else if (args[0] === 'check') check(args.slice(1));
  else fail(`usage: vrt-scope.mjs decide [--branch <b>] [--base <ref>] | check --grep <token>`);
}
