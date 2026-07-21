#!/usr/bin/env node
// scripts/test-reconciliation.mjs
//
// Test-suite counting ENGINE — a per-test-block tally of TOTAL tests and
// DISABLED tests across every test block in the repo, plus the exemption-map /
// Set-literal extractors (extractRecordKeys / extractSetItems) and the itemized
// disabled inventory (disabledInventory).
//
// This is now consumed as a LIBRARY by scripts/test-ledger.mjs — the GENERATED
// 3-bucket test ledger (docs/testing/test-ledger.generated.md) that replaced the
// old dated "Test Reconciliation" changelog + its GitHub Pages site (killed in
// the testing-ledger cleanup: a dated changelog goes stale; a generated,
// freshness-gated artifact cannot). The standalone `node scripts/test-reconciliation.mjs`
// CLI below still prints a live human/JSON table on demand, and this file's
// counting logic is guarded by scripts/test-reconciliation.test.ts.
//
//   block        what it counts                                    kind
//   ───────────  ───────────────────────────────────────────────  ───────────
//   unit         test()/it() in packages/**/<…>.test.ts (vitest)   raw
//   e2e          test() in e2e/tests/**/<…>.spec.ts (playwright)   raw
//   art          it()/test() in art/scenarios/**/<…>.test.ts       raw
//   vrt          enrolled module cards + bespoke scene snapshots    parametrized
//   behavioral   enrolled modules in the behavioral input sweep     parametrized
//   @collab      test() under a @collab describe/test (multi-user)  raw (subset of e2e)
//
// "DISABLED" = a DECLARATION-level disablement that removes a test from the
// run permanently:  test.skip('name', fn) / it.skip / test.fixme('name', fn) /
// describe.skip / describe.fixme.  It does NOT count in-body RUNTIME guards
// (`test.skip(cond, 'reason')` / `test.skip(true, 'reason')` inside a test
// body) — those are environment gates (DB/asset/relay present?), not a test
// the author turned off. We distinguish the two by whether the FIRST argument
// to .skip()/.fixme() is a string literal (declaration) vs an expression /
// `true` (runtime guard). This is the honest read of "what's turned off".
//
// `test.only` / `it.only` / `describe.only` are an ALERT (forbidOnly:true hard-
// fails CI) — counted into `disabled` AND surfaced as `alerts`.
//
// Parametrized blocks (vrt, behavioral) do NOT have one literal test() per
// unit — the spec does `for (const mod of REGISTRY) test(...)`. Counting raw
// test() calls there is meaningless, so we count the ENROLLED UNITS the loop
// produces (registry modules minus the spec's exemption set) and label the
// block `parametrized`. The numbers are computed from the SAME inputs the spec
// reads (e2e/.generated/registry-manifest.json + the exemption files), so they
// track the real enrolment.
//
// EVERY disabled test is reconciliation BACKLOG — there is NO permanent
// "intentional / correct-by-design" exempt bucket. A module/port leaves the
// `disabled` count ONLY by being re-enabled-and-asserting (drive the port in a
// context where it genuinely affects the observed output) or by having its
// auto-enrolled assertion DELETED (a port that can never affect output under any
// patching, with a one-line rationale). The headline metric of this entire
// report is `disabled → 0` across every block. The exemption maps keep a
// per-entry note with a concrete re-enable path, but that note is a "how to fix
// this backlog item", NOT a "this is permanently fine".
//
// Determinism: NO Date.now()/new Date() — the entry date is passed via --date
// or read from `git log -1 --format=%cd`. The counts are pure functions of the
// committed source tree, so repeated runs on the same tree are byte-identical.
//
// Usage:
//   node scripts/test-reconciliation.mjs              # human table to stdout
//   node scripts/test-reconciliation.mjs --json       # machine JSON to stdout
//   node scripts/test-reconciliation.mjs --date 2026-06-07   # override entry date

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ───────────────────────── file discovery ─────────────────────────

/** Recursively list files under `dir` matching `suffix`, skipping ignored
 *  dirs. Sorted for deterministic ordering. */
function walk(dir, suffix, out = []) {
  if (!existsSync(dir)) return out;
  const IGNORE = new Set([
    'node_modules', 'dist', '.generated', '__screenshots__',
    'test-results', 'playwright-report', '.svelte-kit', 'build',
  ]);
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORE.has(e.name)) continue;
      walk(p, suffix, out);
    } else if (e.isFile() && e.name.endsWith(suffix)) {
      out.push(p);
    }
  }
  return out;
}

// ───────────────────────── test() counting ─────────────────────────

// A test/it/describe call: capture the function chain (e.g. `test.skip`,
// `it.only`, `describe.fixme`) and the first character after the `(` so we
// can tell a string-literal first arg (declaration) from an expression. The
// trailing capture grabs the rest of the title string when it's a literal so
// we can tell a STATIC title (`'click+drag …'`) from a PARAMETRIZED one
// (an interpolated template ``${title} [SKIPPED: …]``).
//   group 1: fn        — test | it | describe
//   group 2: modifier  — undefined | skip | only | fixme | todo | concurrent | …
//   group 3: openchar  — first non-space char after `(`
const CALL_RE = /\b(test|it|describe)(?:\.(skip|only|fixme|todo|concurrent|each|sequential|failing))?\s*\(\s*(['"`]|[^'"`\s])([^'"`\n]*)/g;

/** Count raw test/it cases + declaration-level disabled in a set of files.
 *  Returns { total, disabled, skip, fixme, only, files, onlyLocations }.
 *
 *  total   = every test()/it() case that the runner would schedule, i.e.
 *            declaration calls regardless of modifier (skip/fixme are still
 *            "a test", just turned off). describe() is structural — NOT a test
 *            — so it's excluded from the count, EXCEPT describe.skip/.only/
 *            .fixme which disable an entire block (counted as 1 disabled unit
 *            + flagged, since we can't cheaply count the cases inside).
 *  disabled= declaration-level skip/fixme on test()/it() + describe.skip/fixme.
 *  In-body runtime guards (`test.skip(cond,…)` / `test.skip(true,…)`) are NOT
 *  disabled — they're env gates. We detect them: a `.skip(` whose first arg is
 *  NOT a string literal is a runtime guard, so we don't count it as a test at
 *  all (it's a statement inside an existing test body). */
function countTests(files) {
  let total = 0;
  let skip = 0;
  let fixme = 0;
  let only = 0;
  let describeSkip = 0;
  let parametrized = 0; // loop-generated cases (interpolated title) — see below
  const onlyLocations = [];

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const lineStart = lineStarts(src);

    let m;
    CALL_RE.lastIndex = 0;
    while ((m = CALL_RE.exec(src)) !== null) {
      const [, fn, mod, open, rest] = m;
      const firstArgIsString = open === "'" || open === '"' || open === '`';
      // A STATIC declaration has a plain string title. A title built from an
      // interpolated template (``${title} [SKIPPED: …]``) is a loop-generated
      // PARAMETRIZED case — Playwright emits one per registry module/port from
      // inside a `for` loop. Those belong to the parametrized blocks' enrolment
      // accounting (vrt/behavioral/per-port), NOT the raw block's disabled
      // tally, so counting them here would double-count the exemptions. We
      // detect interpolation by a `${` in the leading run of the title.
      const isInterpolatedTitle = open === '`' && /\$\{/.test(rest);

      if (fn === 'describe') {
        // Structural — only the disabling/focusing modifiers matter.
        if (mod === 'skip' || mod === 'fixme') describeSkip++;
        else if (mod === 'only') {
          only++;
          onlyLocations.push(locate(file, m.index, lineStart));
        }
        continue;
      }

      // test()/it().
      if (mod === 'skip' || mod === 'fixme') {
        // Declaration disable (`test.skip('name', fn)`) vs runtime guard
        // (`test.skip(cond, 'reason')` / `test.skip(true, …)` in a body).
        // A declaration's first arg is the NAME string; a guard's first arg
        // is a boolean expression. Distinguish by the first arg type.
        if (!firstArgIsString) {
          // in-body runtime guard — neither a test nor a static disable.
          continue;
        }
        if (isInterpolatedTitle) {
          // loop-generated exemption placeholder — accounted for in the
          // parametrized block, not here.
          parametrized++;
          continue;
        }
        total++;
        if (mod === 'skip') skip++;
        else fixme++;
        continue;
      }

      if (mod === 'only') {
        total++;
        only++;
        onlyLocations.push(locate(file, m.index, lineStart));
        continue;
      }

      if (mod === 'todo') {
        // test.todo('name') — a placeholder, never runs. Count as disabled.
        total++;
        skip++;
        continue;
      }

      // Plain test()/it() (and .each/.concurrent/.sequential/.failing — these
      // still run). A loop-generated case (interpolated title) is parametrized
      // — tracked separately, not in the raw total.
      if (isInterpolatedTitle) {
        parametrized++;
        continue;
      }
      total++;
    }
  }

  return {
    total,
    disabled: skip + fixme + only + describeSkip,
    skip,
    fixme,
    only,
    describeSkip,
    parametrized,
    files: files.length,
    onlyLocations,
  };
}

/** Itemized companion to countTests(): return EVERY declaration-level disable
 *  (test.skip / it.skip / test.fixme / test.todo / describe.skip|fixme / .only)
 *  as { loc, kind, title } for the punch-list ledger. Applies the SAME
 *  static-vs-runtime-guard-vs-parametrized filter as countTests (a `.skip(cond)`
 *  runtime guard and a loop-generated interpolated-title placeholder are NOT
 *  disables), so the itemized list and the count agree by construction.
 *  Deterministic: files come pre-sorted from walk(), items in in-file order. */
function disabledInventory(files) {
  const items = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const lineStart = lineStarts(src);
    let m;
    CALL_RE.lastIndex = 0;
    while ((m = CALL_RE.exec(src)) !== null) {
      const [, fn, mod, open, rest] = m;
      const firstArgIsString = open === "'" || open === '"' || open === '`';
      const isInterpolatedTitle = open === '`' && /\$\{/.test(rest);
      const loc = locate(file, m.index, lineStart);
      const title = rest.trim();
      if (fn === 'describe') {
        if (mod === 'skip' || mod === 'fixme') items.push({ loc, kind: `describe.${mod}`, title });
        else if (mod === 'only') items.push({ loc, kind: 'describe.only', title });
        continue;
      }
      if (mod === 'skip' || mod === 'fixme') {
        if (!firstArgIsString) continue; // in-body runtime env-gate, not a disable
        if (isInterpolatedTitle) continue; // loop-generated parametrized placeholder
        items.push({ loc, kind: `test.${mod}`, title });
        continue;
      }
      if (mod === 'only') items.push({ loc, kind: 'test.only', title });
      else if (mod === 'todo') items.push({ loc, kind: 'test.todo', title });
    }
  }
  return items;
}

function lineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function locate(file, index, lineStart) {
  let lo = 0;
  let hi = lineStart.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStart[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return `${relative(ROOT, file)}:${lo + 1}`;
}

// ───────────────────────── @collab subset ─────────────────────────

/** Count e2e cases in files that carry a @collab tag (multi-user / DOOM-MP /
 *  relay surface). Those files are wholly the collab surface, so we attribute
 *  every test() case in them — the honest, reproducible read. Also tallies
 *  declaration-disabled among them. */
function countCollab(e2eFiles) {
  const collabFiles = e2eFiles.filter((f) => readFileSync(f, 'utf8').includes('@collab'));
  const r = countTests(collabFiles);
  return { ...r, files: collabFiles.length };
}

// ───────────────────────── parametrized blocks ─────────────────────────

function loadManifest() {
  const p = join(ROOT, 'e2e', '.generated', 'registry-manifest.json');
  if (!existsSync(p)) {
    return null; // emitted by `task test`; caller falls back / warns.
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** Extract the KEYS of a flat `Record<string, string>` literal
 *  (`const NAME … = { 'k': 'v', bare: 'v', … }`) from TS source. Heuristic
 *  (no TS parse) but the exemption files are flat literal maps so it's reliable
 *  + deterministic. Returns a Set of keys. */
function extractRecordKeys(src, constName) {
  const re = new RegExp(`\\b(?:const|let|var)\\s+${constName}\\b[^=]*=\\s*\\{`);
  const m = re.exec(src);
  if (!m) return new Set();
  let i = m.index + m[0].length - 1; // at the `{`
  let depth = 0;
  let body = '';
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
    body += ch;
  }
  // Keys appear at entry start (after `{` or `,`), optionally preceded by a
  // line comment. Match quoted keys (`'mod.port':`) AND bare-ident keys
  // (`bareModule:`), each immediately followed by a colon.
  const keys = new Set();
  const keyRe = /(?:^|[\{,])\s*(?:\/\/[^\n]*\n\s*)*(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*:/gm;
  let km;
  while ((km = keyRe.exec(body)) !== null) {
    keys.add(km[2] ?? km[3]);
  }
  return keys;
}

/** Extract the string members of a `new Set<...>([ 'a', 'b', … ])` literal
 *  (`const NAME … = new Set<string>([ … ])`) from TS source. Comments are
 *  stripped first so a quoted word inside a `// …` block comment is never
 *  mistaken for a member (STRICT_DOCS / EXEMPT_BASELINE_PAIRS / STRICT_VRT_MODULES
 *  all carry heavy inline commentary). Heuristic but deterministic; the
 *  exemption files are flat Set literals so it is reliable. Returns a Set. */
function extractSetItems(src, constName) {
  const re = new RegExp(`\\b${constName}\\b\\s*(?::[^=]*)?=\\s*new\\s+Set\\b`);
  const m = re.exec(src);
  if (!m) return new Set();
  const open = src.indexOf('[', m.index + m[0].length);
  if (open === -1) return new Set();
  let depth = 0;
  let body = '';
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) break;
    }
    body += ch;
  }
  const clean = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Set();
  const strRe = /(['"`])((?:[^'"`\\]|\\.)*?)\1/g;
  let sm;
  while ((sm = strRe.exec(clean)) !== null) out.add(sm[2]);
  return out;
}

/** VRT enrolment: registry modules minus EXEMPT_FROM_VRT (the per-card sweep
 *  in vrt.spec.ts), PLUS the bespoke video/composite scene snapshots counted
 *  by their committed baseline PNGs on one platform (darwin) so each SCENE is
 *  counted once. Disabled = 0 here (VRT card skips are platform-baseline
 *  pendings, reported separately as `exempt`). */
function countVrt(manifest) {
  const exemptSrc = readFileSync(join(ROOT, 'e2e', 'vrt', 'vrt-exemptions.ts'), 'utf8');
  const exempt = extractRecordKeys(exemptSrc, 'EXEMPT_FROM_VRT');

  let enrolledModules = 0;
  let exemptModules = 0;
  if (manifest) {
    for (const mod of manifest.modules) {
      if (exempt.has(mod.type)) exemptModules++;
      else enrolledModules++;
    }
  }

  const sceneSpecs = [
    'vrt-toybox.spec.ts',
    'vrt-wavesculpt-blink.spec.ts',
    'vrt-wavesculpt-walls.spec.ts',
    'vrt-quadralogical.spec.ts',
    'vrt-synesthesia-video.spec.ts',
    'vrt-synesthesia-composite.spec.ts',
    'vrt-scope-modes.spec.ts',
    'vrt-composite.spec.ts',
    'vrt-composite-coverage.spec.ts',
  ];
  let sceneSnapshots = 0;
  const shotRoot = join(ROOT, 'e2e', 'vrt', '__screenshots__');
  for (const spec of sceneSpecs) {
    const dir = join(shotRoot, spec, 'darwin');
    if (existsSync(dir)) {
      sceneSnapshots += readdirSync(dir).filter((f) => f.endsWith('.png')).length;
    }
  }

  const total = enrolledModules + sceneSnapshots;
  return {
    total,
    disabled: 0,
    enrolledModules,
    sceneSnapshots,
    exempt: exemptModules,
    kind: 'parametrized',
  };
}

/** Behavioral enrolment: registry modules minus the behavioral sweep's
 *  whole-module exemptions (BEHAVIORAL_MODULE_EXEMPT). Per-port exemptions
 *  (BEHAVIORAL_SWEEP_EXEMPT) skip ONE port's signal check, not the module's
 *  enrolment, so they're reported separately (`portExemptions`).
 *
 *  EVERY whole-module exemption is reconciliation BACKLOG — there is NO
 *  permanent "intentional / correct-by-design" bucket. An exempt module leaves
 *  the count ONLY by being re-enabled-and-asserting (drive the port in a context
 *  where it genuinely affects the observed output) or by having its
 *  auto-enrolled assertion DELETED (a port that can never affect output under
 *  any patching). `disabled` is the full module-exempt count, and the headline
 *  metric of this whole report is driving it to 0. The per-port exemptions are
 *  the SAME kind of backlog at port granularity (reported as `portExemptions`). */
function countBehavioral(manifest) {
  const src = readFileSync(
    join(ROOT, 'e2e', 'tests', 'per-module-per-port-behavioral.spec.ts'),
    'utf8',
  );
  const moduleExempt = extractRecordKeys(src, 'BEHAVIORAL_MODULE_EXEMPT');
  const sweepExempt = extractRecordKeys(src, 'BEHAVIORAL_SWEEP_EXEMPT');

  let enrolled = 0;
  let exempt = 0;
  if (manifest) {
    for (const mod of manifest.modules) {
      if (moduleExempt.has(mod.type)) exempt++;
      else enrolled++;
    }
  }

  return {
    total: enrolled,
    disabled: exempt,
    enrolledModules: enrolled,
    exempt,
    portExemptions: sweepExempt.size,
    kind: 'parametrized',
  };
}

// ───────────────────────── assemble report ─────────────────────────

function pct(disabled, total) {
  if (total === 0) return '0.0';
  return ((disabled / total) * 100).toFixed(1);
}

function resolveDate(argv) {
  const i = argv.indexOf('--date');
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cd', '--date=short'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(out)) return out;
  } catch {
    /* not a git checkout — fall through */
  }
  // Last resort (only when neither --date nor git is available, e.g. a
  // tarball build). Build-time only; not on a determinism-critical path.
  return new Date().toISOString().slice(0, 10);
}

// Exported for the unit test (scripts/test-reconciliation.test.ts) + the
// generated 3-bucket ledger (scripts/test-ledger.mjs, which reuses this
// counting engine rather than re-implementing it).
export { countTests, disabledInventory, extractRecordKeys, extractSetItems, countCollab, walk };

export function reconcile() {
  const unitFiles = walk(join(ROOT, 'packages'), '.test.ts');
  const e2eFiles = walk(join(ROOT, 'e2e', 'tests'), '.spec.ts');
  const artFiles = walk(join(ROOT, 'art', 'scenarios'), '.test.ts');
  const manifest = loadManifest();

  const unit = countTests(unitFiles);
  const e2e = countTests(e2eFiles);
  const art = countTests(artFiles);
  const collab = countCollab(e2eFiles);
  const vrt = countVrt(manifest);
  const behavioral = countBehavioral(manifest);

  const alerts = [...unit.onlyLocations, ...e2e.onlyLocations, ...art.onlyLocations];

  const blocks = [
    { block: 'unit', kind: 'raw', total: unit.total, disabled: unit.disabled, note: `${unit.files} files; static skip ${unit.skip}, fixme ${unit.fixme}, only ${unit.only}, describe.skip ${unit.describeSkip}; ${unit.parametrized} loop-generated cases (excl.)` },
    { block: 'e2e', kind: 'raw', total: e2e.total, disabled: e2e.disabled, note: `${e2e.files} files; static skip ${e2e.skip}, fixme ${e2e.fixme}, only ${e2e.only}, describe.skip ${e2e.describeSkip}; ${e2e.parametrized} loop-generated cases counted in parametrized blocks` },
    { block: 'art', kind: 'raw', total: art.total, disabled: art.disabled, note: `${art.files} scenario files; static skip ${art.skip}, fixme ${art.fixme}` },
    { block: 'vrt', kind: 'parametrized', total: vrt.total, disabled: vrt.disabled, note: `${vrt.enrolledModules} module cards + ${vrt.sceneSnapshots} scene shots; ${vrt.exempt} modules exempt` },
    { block: 'behavioral', kind: 'parametrized', total: behavioral.total, disabled: behavioral.disabled, note: `${behavioral.enrolledModules} modules enrolled; ${behavioral.exempt} module-exempt (all reconciliation backlog — fix or delete), ${behavioral.portExemptions} port-exemptions (same backlog at port granularity)` },
    { block: '@collab', kind: 'raw (e2e subset)', total: collab.total, disabled: collab.disabled, note: `${collab.files} files; skip ${collab.skip}, fixme ${collab.fixme}` },
  ];

  return { blocks, alerts, manifestPresent: !!manifest };
}

// ───────────────────────── CLI ─────────────────────────

function isMain() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const date = resolveDate(argv);
  const { blocks, alerts, manifestPresent } = reconcile();

  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ date, blocks, alerts, manifestPresent }, null, 2) + '\n');
  } else {
    const pad = (s, n) => String(s).padEnd(n);
    const padl = (s, n) => String(s).padStart(n);
    console.log(`Test Reconciliation — ${date}`);
    if (!manifestPresent) {
      console.log('  WARNING registry manifest absent (run `flox activate -- task test:emit-manifest`); parametrized counts are 0');
    }
    console.log('');
    console.log(`  ${pad('block', 12)} ${pad('kind', 18)} ${padl('total', 7)} ${padl('disabled', 9)} ${padl('%disabled', 10)}`);
    console.log(`  ${'-'.repeat(12)} ${'-'.repeat(18)} ${'-'.repeat(7)} ${'-'.repeat(9)} ${'-'.repeat(10)}`);
    for (const b of blocks) {
      console.log(`  ${pad(b.block, 12)} ${pad(b.kind, 18)} ${padl(b.total, 7)} ${padl(b.disabled, 9)} ${padl(pct(b.disabled, b.total) + '%', 10)}`);
    }
    console.log('');
    for (const b of blocks) console.log(`  · ${b.block}: ${b.note}`);
    console.log('');
    if (alerts.length) {
      console.log(`  ALERT — ${alerts.length} focused test(s) (.only) — forbidOnly:true hard-fails CI:`);
      for (const a of alerts) console.log(`      ${a}`);
    } else {
      console.log('  OK no focused (.only) tests');
    }
  }
}
