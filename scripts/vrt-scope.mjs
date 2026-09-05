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
// REQUIRED, 4 shards, every face in
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
//   * attributable to ONE module type BY ITS PATH,
// and the union of those attributions is exactly ONE type. Anything else —
// an unattributable renderable file (a shared primitive, a global stylesheet, a
// spec, a lockfile, a shared roster), or two or more distinct modules — falls
// back to the FULL sweep and says so, LOUDLY, naming the files that forced it
// and printing the `GREP=<module>` line that would have cost ~3 minutes.
//
// ⚠ 2026-08-23: THE DIFF-CONTENT INFERENCE IS GONE and the derivation is now
// PATH-ONLY, so the full-sweep fallback is the COMMON case rather than the
// exception — a face PR touches a shared roster file and will derive FULL. That
// is the deliberate trade: the operator types the token they already know
// instead of a heuristic guessing it from prose and identifiers and being wrong
// three times in one week. See the note above `deriveVrtScope`.
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

// ── THE DIFF-CONTENT TOKENIZER IS DELETED (2026-08-23) ─────────────────────
//
// `codeLines` / `stringLiteralText` / `typesInDiffText` / `parseChangedLines`
// lived here. They read each unattributable file's DIFF HUNKS and looked for
// module names in them, so a shared roster file (`strict-faces.ts`,
// `face-readout-values.ts`, `card-def-debt.ts`, …) could still be attributed to
// the module a face PR was promoting instead of forcing a full sweep.
//
// It was the right idea and it never stopped generating false positives: repo
// prose names other modules constantly (comment-stripping was added for that),
// `.filter((e) => …)` implicated the `filter` MODULE, `patch.edges` implicated
// `edges`, and the string-literal-only rule for one-word types (#2116) was the
// third narrowing of the same heuristic. It still forced full sweeps three
// times in the week of 2026-08-16, on single-module PRs.
//
// The 2026-08-23 CI simplification audit's verdict: keep the scoped dispatch,
// which is a real 3-min-vs-45-min win, and stop INFERRING the token. A file
// whose PATH names a module is still attributed — that is precise evidence with
// no false positives. Everything else is a BLOCKER and says so by name, and the
// operator who knows the answer passes `GREP=<module>`.

// ───────────────────────── the decision ──────────────────────────

/**
 * ONE PHASE: PATH. A file whose own path names a module belongs to that module.
 * That is precise evidence with no false-positive mode — a path is not prose.
 * Anything else that can move a pixel is a BLOCKER and is named in the report.
 *
 * ⚠ IT USED TO HAVE A SECOND PHASE and the audit deleted it (see the note above
 * the ignorable list). Phase 2 read the unplaced files' DIFF HUNKS for module
 * names, which is what let a shared roster file (`strict-faces.ts`,
 * `face-readout-values.ts`, `card-def-debt.ts`, …) be attributed to the module
 * a face PR was promoting. It never stopped producing false positives, and its
 * failure mode was the same as its absence: a LOUD full sweep on a
 * single-module PR.
 *
 * ⚠ SO THE HONEST CONSEQUENCE, stated rather than discovered: a face PR touches
 * a shared roster file, so it will now derive FULL. The remedy is not a cleverer
 * heuristic — it is the operator, who knows the answer, typing it:
 *
 *     GREP=<module> task vrt:commit        # ~3 min
 *     ALL=1         task vrt:commit        # 41-56 min, deliberately
 *
 * The report below names every blocker so that choice is informed.
 *
 * @param {{files: string[], types: string[]}} input
 * @returns {{
 *   mode: 'scoped'|'full'|'none',
 *   token: string|null,
 *   tokens: string[],
 *   attributions: {file: string, types: string[], via: 'path'}[],
 *   blockers: {file: string, why: string}[],
 *   ignored: {file: string, why: string}[],
 *   reason: string,
 * }}
 */
export function deriveVrtScope({ files, types }) {
  const attributions = [];
  const blockers = [];
  const ignored = [];
  const tokens = new Set();

  const renderable = [];
  for (const file of files) {
    const skip = ignorableReason(file);
    if (skip) ignored.push({ file, why: skip });
    else renderable.push(file);
  }

  for (const file of renderable) {
    const hit = typesInPath(file, types);
    if (hit.length === 0) {
      blockers.push({ file, why: 'renderable, and its PATH names no module' });
      continue;
    }
    attributions.push({ file, types: hit, via: 'path' });
    for (const t of hit) tokens.add(t);
  }

  const list = [...tokens].sort();
  const decision = (mode, token, reason) => ({
    mode,
    token,
    tokens: list,
    attributions,
    blockers,
    ignored,
    reason,
  });

  if (blockers.length) {
    return decision(
      'full',
      null,
      `${blockers.length} changed file(s) can move a baseline and no PATH names a module — the blast radius is not derivable`,
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

  const types = loadTypes();
  const d = deriveVrtScope({ files, types });

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
    if (d.tokens.length) report += `  Modules named by a changed PATH: ${d.tokens.join(', ')}\n`;
    report += `  Cost: ${tests.length} tests across ${new Set(tests.map((t) => t.file)).size} spec files, ONE unsharded job.\n`;
    // ⚠ THE COMMON CASE NOW, NOT THE EXCEPTION. Nothing infers a token from a
    // file's contents any more, so a shared roster file lands here on an
    // ordinary single-module PR. The operator knows the answer; this is where
    // they are asked for it.
    report += `\n  If ONE token covers everything that moved, scope it and pay ~3 min instead of 41-56:\n`;
    report += `    GREP=${d.tokens[0] ?? '<module>'} task vrt:commit\n`;
    report += `  Nothing derives that token from file CONTENTS any more (deleted 2026-08-23 —\n`;
    report += `  it inferred modules from prose and identifiers and was wrong three times in a week).\n`;
    process.stderr.write(report);
    process.stdout.write('FULL\n');
    return;
  }

  const sel = selectionFor(d.token, tests);
  if (sel.tests.length === 0) {
    report += `\n  NOTHING TO CAPTURE — the diff implicates '${d.token}', which no VRT test renders\n`;
    report += `  (it has no scene).\n`;
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
