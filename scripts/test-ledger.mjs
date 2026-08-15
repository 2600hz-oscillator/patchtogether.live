#!/usr/bin/env node
// scripts/test-ledger.mjs
//
// The GENERATED 3-bucket TEST LEDGER — the punch-list that replaced the stale,
// dated "Test Reconciliation" changelog (docs/test-reconciliation/, killed). A
// changelog goes out of date the moment it is written; this artifact is a PURE
// FUNCTION of the committed source tree, so its counts CANNOT silently rot — the
// freshness gate (scripts/test-ledger.test.ts, unit lane) regenerates and fails
// on any drift, exactly like the living-docs contract-lock.txt gate. Regenerate
// with `flox activate -- task test:ledger:accept`; check read-only with
// `flox activate -- task test:ledger`.
//
// The three buckets:
//
//   Bucket 1 — HARD SKIPS / QUARANTINES. Every declaration-level test disable
//     (test.skip / it.skip / .fixme / .todo / describe.skip|fixme / .only) plus
//     the per-module spawn-smoke QUARANTINE map. Each is BACKLOG (reconcile =
//     fix or delete; no permanent-exempt bucket) — the roadmap-to-zero-skips.
//     In-body RUNTIME guards (`test.skip(cond, …)`) are env gates, NOT disables,
//     and are excluded (same honest filter as the counting engine).
//
//   Bucket 2 — COVERAGE EXEMPTIONS. The declarative auto-enrollment opt-out
//     lists (a module opted out of a UNIVERSAL sweep still carries dedicated
//     coverage elsewhere). Deliberate, not a turned-off test — but counted +
//     itemized so drift is visible. NB: per repo doctrine the behavioral
//     exemptions here are ALSO tracked-to-zero backlog (see the roadmap).
//
//   Bucket 3 — INFORMATIONAL-ONLY CI LANES. Jobs in ci.yml that RUN on a PR but
//     do NOT gate merge: either `continue-on-error: true`, or in the `ci`
//     umbrella's `needs:` + `env:` yet absent from its failing `if [[ ]]` test
//     (waited-on, non-blocking), or labelled informational by the umbrella's own
//     aggregate step. Derived from ci.yml so the list can't go stale.
//
// Reuses the counting ENGINE in ./test-reconciliation.mjs (walk / countTests /
// disabledInventory / extractRecordKeys / extractSetItems) — one system, not a
// parallel counter. Determinism: no dates, no git, no registry manifest — every
// number is a function of committed files, and every list is sorted.
//
// Usage:
//   node scripts/test-ledger.mjs            # print the generated markdown to stdout
//   node scripts/test-ledger.mjs --write    # (re)write docs/testing/test-ledger.generated.md

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  walk,
  disabledInventory,
  extractRecordKeys,
  extractSetItems,
  runtimeSkipInventory,
} from './test-reconciliation.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LEDGER_PATH = join(ROOT, 'docs', 'testing', 'test-ledger.generated.md');

// ───────────────────────── helpers ─────────────────────────

/** First-sentence excerpt of a reason string, collapsed + capped, so the ledger
 *  is readable AND stable (only a reason's LEADING text churns the artifact). */
function summarize(reason) {
  const flat = String(reason).replace(/\s+/g, ' ').trim();
  const dot = flat.indexOf('. ');
  const semi = flat.indexOf('; ');
  let end = flat.length;
  if (dot !== -1) end = Math.min(end, dot + 1);
  if (semi !== -1) end = Math.min(end, semi);
  let out = flat.slice(0, end).trim();
  if (out.length > 120) out = out.slice(0, 117).trimEnd() + '…';
  return out;
}

const sortedKeys = (map) => [...map].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** Read a source file, extract a Record<string,string> literal's keys + a
 *  per-key one-line reason (parsed by locating `<key>: '<reason>'`). */
function readRecord(relPath, constName) {
  const src = readFileSync(join(ROOT, relPath), 'utf8');
  const keys = extractRecordKeys(src, constName);
  const reasons = new Map();
  for (const k of keys) {
    // Match `'<k>':` or `<k>:` followed by a single-quoted / double-quoted / template reason.
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:['"\`]${esc}['"\`]|\\b${esc})\\s*:\\s*(['"\`])((?:[^\\\\]|\\\\.)*?)\\1`);
    const m = re.exec(src);
    reasons.set(k, m ? m[2] : '');
  }
  return { keys, reasons };
}

// ───────────────────────── Bucket 1 — hard skips / quarantines ─────────────────────────

function bucket1() {
  const groups = [
    { block: 'unit', files: walk(join(ROOT, 'packages'), '.test.ts') },
    { block: 'e2e', files: [...walk(join(ROOT, 'e2e', 'tests'), '.spec.ts'), ...walk(join(ROOT, 'e2e', 'vrt'), '.spec.ts')] },
    { block: 'art', files: walk(join(ROOT, 'art', 'scenarios'), '.test.ts') },
  ];

  const blocks = groups.map(({ block, files }) => {
    const items = disabledInventory(files)
      .map((it) => ({ ...it, loc: it.loc }))
      .sort((a, b) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0));
    return { block, items };
  });

  // Quarantine MAP: modules.spec.ts renders these as an interpolated-title
  // test.fixme (so disabledInventory does NOT double-count them) — count the map.
  const quarantine = readRecord('e2e/tests/modules.spec.ts', 'QUARANTINE');

  const disabledTotal = blocks.reduce((n, b) => n + b.items.length, 0);
  const total = disabledTotal + quarantine.keys.size;
  return { blocks, quarantine, disabledTotal, total };
}

// ───────────────────── Runtime skips (env gates) — #1502 ─────────────────────
//
// The in-body `test.skip(cond, reason)` guards Bucket 1 deliberately EXCLUDES
// (env gates, not author disables). At REPORT time they still produce
// `status: 'skipped'` rows a green lane hides, so they are inventoried here and
// governed by the deny-by-default per-lane skip budget
// (scripts/e2e-skip-budget.mjs, enforced by the merge-report audits in ci.yml
// and anchored both directions by scripts/e2e-skip-budget.test.ts).
// Declaration-level disables are Bucket 1's rows; loop-generated
// `[SKIPPED:]`-marker placeholders are Bucket 2's — neither is repeated here.

function runtimeSkips() {
  const files = walk(join(ROOT, 'e2e', 'tests'), '.spec.ts');
  const items = runtimeSkipInventory(files)
    .filter((it) => it.kind === 'runtime-guard')
    .sort((a, b) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0));
  // Budget linkage (which entry admits which site) is the budget TEST's job —
  // it anchors both directions; the ledger only lists the surface.
  return { items };
}

// ───────────── The SUBJECT of an exemption list (#1524) ─────────────
//
// "370 exemptions" was one undifferentiated number, and nobody could say
// whether it was scandalous or fine, because the bucket mixed populations with
// opposite dispositions. The split below is per LIST, not per ENTRY — SEVEN
// classifications instead of 370 — because the thing that decides the
// disposition is WHAT THE SWEEP GATES, which is a property of the list:
//
//   'legacy-card' — the sweep screenshots a `?shell=legacy` CARD
//     (vrt.spec.ts spawns `/rack?shell=legacy&seed=none` and captures the card
//     element). LEG-08 #1519 deletes the card fleet; LEG-06 #1517 replaces the
//     visual coverage with full-tier FACE baselines and states the policy in
//     as many words: "Do NOT backfill 'baseline pending' exemptions … the masks
//     die with the cards." So an entry here is not debt anyone should pay — it
//     is work that will be DELETED, and paying it is double-paying.
//
//   'engine' — the sweep drives the audio/video GRAPH and survives the legacy
//     deletion untouched. These are the entries where "payable debt" is a real
//     question, and where the answer has to be argued per entry.
//
// ⚠ A per-ENTRY classification field was CONSIDERED AND REJECTED (issue #1524
// scope item 1 asked for one). A required field on 370 entries is 370 hand-typed
// known answers — the inventory-of-payable-debt the owner ruling forbids, and a
// re-count tax on every agent who touches the area afterwards. What is written
// instead is derived: this per-list subject, plus the DOM-source capability
// derivation below, both read off artifacts that move on their own.
const RECORD_EXEMPTIONS = [
  { id: 'vrt.EXEMPT_FROM_VRT', file: 'e2e/vrt/vrt-exemptions.ts', konst: 'EXEMPT_FROM_VRT', subject: 'legacy-card', desc: 'modules skipped from the per-card VRT sweep' },
  { id: 'behavioral.BEHAVIORAL_MODULE_EXEMPT', file: 'e2e/tests/per-module-per-port-behavioral.spec.ts', konst: 'BEHAVIORAL_MODULE_EXEMPT', subject: 'engine', desc: 'whole-module skips of the behavioral CONTROL→PATCHED delta sweep' },
  { id: 'behavioral.BEHAVIORAL_SWEEP_EXEMPT', file: 'e2e/tests/per-module-per-port-behavioral.spec.ts', konst: 'BEHAVIORAL_SWEEP_EXEMPT', subject: 'engine', desc: 'per-PORT skips of the behavioral delta sweep (module still enrolled)' },
  { id: 'per-port.SKIP_SPAWN', file: 'e2e/tests/_per-module-per-port-shared.ts', konst: 'SKIP_SPAWN', subject: 'engine', desc: 'modules skipped from the per-module-per-port spawn (handle/emit/drive) sweep' },
  { id: 'per-port.EXEMPT_OUTPUT_EMIT_MODULES', file: 'e2e/tests/_per-module-per-port-shared.ts', konst: 'EXEMPT_OUTPUT_EMIT_MODULES', subject: 'engine', desc: 'whole-module output-emit exemptions (asset/ROM/press-driven)' },
  { id: 'per-port.EXEMPT_OUTPUT_EMIT', file: 'e2e/tests/_per-module-per-port-shared.ts', konst: 'EXEMPT_OUTPUT_EMIT', subject: 'engine', desc: 'per-PORT output-emit exemptions (module\'s other outputs DO emit)' },
  { id: 'per-port.EXEMPT_INPUT_DRIVE', file: 'e2e/tests/_per-module-per-port-shared.ts', konst: 'EXEMPT_INPUT_DRIVE', subject: 'engine', desc: 'per-PORT input-drive exemptions (gameplay-deep / asset-gated inputs)' },
];

/** The LEG-* issue that DELETES each subject, so an entry dies with its cause
 *  instead of being maintained forever. Rendered beside the population. */
const SUBJECT_ANCHORS = {
  'legacy-card': {
    label: 'LEGACY-RETIRING — the subject is a `?shell=legacy` card',
    anchor:
      'deleted by LEG-08 (#1519, the 195-card fleet); replacement visual coverage is LEG-06 ' +
      '(#1517), whose delete-on-migrate policy says in as many words: do NOT backfill ' +
      '"baseline pending" exemptions. Paying one of these is work that will be deleted.',
  },
  engine: {
    label: 'LIVE — the subject is the audio/video graph',
    anchor:
      'survives the legacy deletion. CAPABILITY where the environment genuinely cannot ' +
      'supply the input (derived below where the artifact allows); otherwise payable debt, ' +
      'and payable debt is PAID rather than listed.',
  },
};

/**
 * DERIVED CAPABILITY — the one capability family this repo can read off an
 * artifact instead of trusting prose. `DOM_SOURCE_LANE_TYPES` is the set of
 * modules whose engine source is created and attached BY A MOUNTED CARD (the
 * set the shell already keeps alive off-screen via HeadlessSourceHost). Under
 * the bare `spawnPatch` these sweeps use, that source does not exist, so the
 * control arm and the patched arm both read silence — a structural no-delta,
 * not a dead port. LEG-02 (#1511) moves the media lifecycle onto the node,
 * which is exactly what makes these payable; until then they are capability.
 *
 * Read off the source, so a module entering or leaving the set moves this
 * number with no edit here.
 */
function domSourceTypes() {
  const src = readFileSync(join(ROOT, 'packages/web/src/lib/ui/workflow/dom-source-modules.ts'), 'utf8');
  return extractSetItems(src, 'DOM_SOURCE_LANE_TYPES');
}

// Set-shaped exemptions (bare `new Set([...])` with no per-entry reason).
// EMPTY since 2026-08-10: its only member was `vrt.EXEMPT_BASELINE_PAIRS`, the
// `<platform>/<scene>` skip list, and it died with the {platform} baseline
// dimension — one baseline set means there is no other platform to defer to.
// The array is kept, not inlined away, because the SHAPE is still supported and
// the next set-shaped exemption should land here rather than reinventing it.
const SET_EXEMPTIONS = [];

// Opt-IN completeness RATCHETS (the more members the better — the inverse of an
// exemption). Reported for drift visibility, clearly separated from opt-outs.
const RATCHETS = [
  { id: 'docs.STRICT_DOCS', file: 'packages/web/src/lib/docs/strict-docs.ts', konst: 'STRICT_DOCS', desc: 'modules held to the FULL living-docs completeness bar (deny-missing-docs)' },
  { id: 'vrt.STRICT_VRT_MODULES', file: 'e2e/vrt/vrt-exemptions.ts', konst: 'STRICT_VRT_MODULES', desc: 'modules whose card MUST ship a VRT baseline (deny-missing-baseline)' },
];

function bucket2() {
  const dom = domSourceTypes();
  const records = RECORD_EXEMPTIONS.map((e) => {
    const { keys, reasons } = readRecord(e.file, e.konst);
    // An entry's MODULE is the key up to the first '.' (per-port lists are
    // `<module>.<port>`); everything else is already a module type.
    const moduleOf = (k) => (k.includes('.') ? k.slice(0, k.indexOf('.')) : k);
    const domDerived = e.subject === 'engine'
      ? sortedKeys(new Set([...keys].filter((k) => dom.has(moduleOf(k)))))
      : [];
    return { ...e, kind: 'record', count: keys.size, keys: sortedKeys(keys), reasons, domDerived };
  });
  const sets = SET_EXEMPTIONS.map((e) => {
    const items = extractSetItems(readFileSync(join(ROOT, e.file), 'utf8'), e.konst);
    return { ...e, kind: 'set', count: items.size, keys: sortedKeys(items), subject: e.subject ?? 'engine', domDerived: [] };
  });
  const ratchets = RATCHETS.map((e) => {
    const items = extractSetItems(readFileSync(join(ROOT, e.file), 'utf8'), e.konst);
    return { ...e, count: items.size, keys: sortedKeys(items) };
  });
  const total = [...records, ...sets].reduce((n, e) => n + e.count, 0);
  return { records, sets, ratchets, total };
}

// ───────────────────────── Bucket 3 — informational CI lanes ─────────────────────────

/** Parse ci.yml into { name, line, text } job blocks (top-level 2-space keys
 *  under `jobs:`). Deterministic string parse — no YAML lib needed. */
function parseJobs(src) {
  const lines = src.split('\n');
  const jobsIdx = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const jobs = [];
  let cur = null;
  for (let i = jobsIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (/^[A-Za-z]/.test(l) && !/^\s/.test(l)) break; // dedent to a new top-level key
    if (m) {
      cur = { name: m[1], line: i + 1, body: [] };
      jobs.push(cur);
    } else if (cur) {
      cur.body.push(l);
    }
  }
  for (const j of jobs) j.text = j.body.join('\n');
  return jobs;
}

function bucket3() {
  const src = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const jobs = parseJobs(src);
  const byName = new Map(jobs.map((j) => [j.name, j]));

  const umbrella = byName.get('ci');
  // VAR → job from the umbrella `env:` block (`VAR: ${{ needs.<job>.result }}`).
  const varToJob = new Map();
  for (const mm of umbrella.text.matchAll(/([A-Z0-9_]+):\s*\$\{\{\s*needs\.([A-Za-z0-9_-]+)\.result\s*\}\}/g)) {
    varToJob.set(mm[1], mm[2]);
  }
  const jobToVar = new Map([...varToJob].map(([v, j]) => [j, v]));
  // VARs referenced in the failing `if [[ … ]]` test → these jobs GATE merge.
  // Scan only LIVE shell lines: strip `#`-comment lines first, because the step
  // carries prose comments that literally quote conditions ("the failing `if [[
  // ]]` test"; "arm it later by adding `|| "$GRAND_ATTEST" != "success"`") — those
  // are documentation, NOT live gates, and must not be read as such.
  const liveShell = umbrella.text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  const gatingVars = new Set([...liveShell.matchAll(/\$([A-Z0-9_]+)"\s*!=\s*"success"/g)].map((mm) => mm[1]));
  const gatingJobs = [...gatingVars].map((v) => varToJob.get(v)).filter(Boolean);
  // umbrella needs list.
  const needsM = /needs:\s*\[([^\]]*)\]/.exec(umbrella.text);
  const needs = needsM ? needsM[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  // Jobs the umbrella aggregate step explicitly labels informational.
  const echoInformational = new Set([...umbrella.text.matchAll(/echo\s+"([a-z0-9-]+):[^"\n]*informational/g)].map((mm) => mm[1]));

  const reasons = new Map();
  const informational = new Set();
  for (const j of jobs) {
    if (j.name === 'ci') continue;
    const coe = /^\s{4}continue-on-error:\s*true\s*$/m.test(j.text);
    const waitedNotGating = needs.includes(j.name) && !gatingJobs.includes(j.name);
    const echoed = echoInformational.has(j.name);
    if (!coe && !waitedNotGating && !echoed) continue;
    const why = [];
    if (coe) why.push('continue-on-error: true');
    if (waitedNotGating) why.push('in umbrella needs+env but absent from the failing `if` (waited-on, non-blocking)');
    else if (echoed) why.push('umbrella aggregate step labels it informational');
    informational.add(j.name);
    reasons.set(j.name, why.join('; '));
  }

  // ⚠ ANCHOR TO THE JOB KEY, NEVER TO A LINE NUMBER.
  //
  // This ledger used to print `(ci.yml:985)`. A line number is a reference to a
  // POSITION, and every edit above that position silently invalidates it:
  // adding a 26-line comment block over the `e2e` job moved every reference
  // below it by exactly 26 and turned this freshness gate RED with no job
  // added, no job removed, no reason changed and no content moved. Measured
  // 2026-08-12 — the ledger went stale purely from a comment.
  //
  // The job KEY is the same information without the fragility: stable across
  // unrelated edits, unique within `jobs:`, and — unlike a line number —
  // CHECKABLE against the artifact, which `test-ledger.test.ts` does (a name
  // that no longer resolves to a job in ci.yml is RED).
  //
  // Same disease as the toolchain pin file that was hashed WHOLESALE until it
  // was narrowed to the dependency surface: the reference was to more than the
  // thing it cared about.
  const items = [...informational].sort().map((name) => ({ name, reason: reasons.get(name) }));

  // Required status-check CONTEXTS (branch ruleset; not in-repo — see pr-workflow.md).
  // `name` is the DISPLAY context the ruleset matches on; `job` is the key it
  // lives under in ci.yml, which is what makes the entry locatable.
  const UMBRELLA_JOB = 'ci';
  const VRT_STRICT_JOB = 'vrt-strict';
  const umbrellaName = (/name:\s*(.+)/.exec(umbrella.text) || [])[1]?.trim() ?? UMBRELLA_JOB;
  const vrtStrict = byName.get(VRT_STRICT_JOB);
  const vrtStrictName = vrtStrict ? (/name:\s*(.+)/.exec(vrtStrict.text) || [])[1]?.trim() : VRT_STRICT_JOB;

  return {
    items,
    gatingJobs: gatingJobs.slice().sort(),
    requiredContexts: [
      { name: umbrellaName, job: UMBRELLA_JOB },
      { name: vrtStrictName, job: VRT_STRICT_JOB },
    ],
  };
}

// ───────────────────────── render ─────────────────────────

export function generateLedger() {
  const b1 = bucket1();
  const b2 = bucket2();
  const b3 = bucket3();
  const rs = runtimeSkips();
  const L = [];
  const p = (s = '') => L.push(s);

  p('<!-- GENERATED by scripts/test-ledger.mjs — DO NOT EDIT.');
  p('     Regenerate: `flox activate -- task test:ledger:accept`   Check: `flox activate -- task test:ledger`');
  p('     Freshness is gated by scripts/test-ledger.test.ts (unit lane) — a new skip or');
  p('     exemption fails that gate until this artifact is regenerated. -->');
  p('# Test ledger');
  p('');
  p('The **generated** 3-bucket punch-list of what is turned off, opted out, and');
  p('non-gating across the test suites. Counts are a pure function of the committed');
  p('source tree, so they cannot go stale. Prose + roadmap: `docs/testing/README.md`.');
  p('');
  p('| Bucket | What | Count |');
  p('| --- | --- | ---: |');
  p(`| 1 | HARD SKIPS / QUARANTINES (backlog → drive to 0) | ${b1.total} |`);
  p(`| 2 | COVERAGE EXEMPTIONS (deliberate auto-enrollment opt-outs) | ${b2.total} |`);
  p(`| 3 | INFORMATIONAL-ONLY CI LANES (run, never block merge) | ${b3.items.length} |`);
  p('');

  // ── CI gating summary (Bucket 3 context) ──
  p('## CI gating truth (from `.github/workflows/ci.yml`)');
  p('');
  // Boy-scout: the count was hand-typed as `2`. Derived from the list it
  // labels, so it cannot disagree with the lines printed underneath it.
  p(`Required status-check **contexts** (${b3.requiredContexts.length} — branch ruleset 16042163; not in-repo,`);
  p('see `.claude/skills/pr-workflow.md`). Anchored by ci.yml JOB KEY, not by line');
  p('number — a line number is invalidated by any edit above it:');
  for (const c of b3.requiredContexts) p(`- \`${c.name}\`  (ci.yml job \`${c.job}\`)`);
  p('');
  p(`Jobs gated THROUGH the \`ci\` umbrella (a failure of any blocks merge) — ${b3.gatingJobs.length}:`);
  p(`- ${b3.gatingJobs.map((j) => `\`${j}\``).join(', ')}`);
  p('');

  // ── Bucket 1 ──
  p(`## Bucket 1 — hard skips / quarantines (${b1.total})`);
  p('');
  p('Every declaration-level test disable + the spawn-smoke quarantine map. Each is');
  p('BACKLOG: reconcile by fixing (assert real behavior) or deleting (worthless) —');
  p('there is no permanent "intentional / correct-by-design" bucket. In-body runtime');
  p('guards (`test.skip(cond, …)`) are env gates, not disables, and are excluded.');
  p('');
  for (const blk of b1.blocks) {
    p(`### ${blk.block} — declaration-level disables (${blk.items.length})`);
    if (blk.items.length === 0) p('_none_');
    for (const it of blk.items) p(`- \`${it.loc}\` — ${it.kind} — ${it.title || '(no title)'}`);
    p('');
  }
  p(`### spawn-smoke QUARANTINE map (e2e/tests/modules.spec.ts) — ${b1.quarantine.keys.size}`);
  if (b1.quarantine.keys.size === 0) p('_none_');
  for (const k of sortedKeys(b1.quarantine.keys)) p(`- \`${k}\` — ${summarize(b1.quarantine.reasons.get(k))}`);
  p('');

  // ── Runtime skips (env gates) ──
  p(`## Runtime skips — in-body env gates (${rs.items.length})`);
  p('');
  p('`test.skip(cond, reason)` guards that skip AT RUNTIME when an environment');
  p('capability is missing (DB, asset, renderer, hardware). NOT disables — the test');
  p('runs wherever the capability exists — but each produces a `skipped` row a green');
  p('lane would otherwise hide, so the merged-report audits in ci.yml surface every');
  p('row and enforce the deny-by-default per-lane budget in');
  p('`scripts/e2e-skip-budget.mjs`: a reasonless or unknown-reason skip reds the');
  p('audit. Both directions are anchored by `scripts/e2e-skip-budget.test.ts`.');
  p('A reason shown as `(dynamic)` is computed at runtime; the budget test anchors');
  p('those at spec granularity and the lane audit checks the realized string.');
  p('');
  for (const it of rs.items) {
    const reason = it.reasonKind === 'literal' ? summarize(it.reason) : `(dynamic: \`${summarize(it.reason)}\`)`;
    p(`- \`${it.loc}\` — ${reason}`);
  }
  p('');

  // ── Bucket 2 ──
  p(`## Bucket 2 — coverage exemptions (${b2.total})`);
  p('');
  p('Declarative auto-enrollment opt-out lists. A module opted out of a UNIVERSAL');
  p('sweep still carries dedicated coverage (a bespoke spec / unit core / ART). These');
  p('are DELIBERATE — but per repo doctrine the **behavioral** exemptions are ALSO');
  p('tracked-to-zero backlog (reconcile = fix or delete); see the roadmap.');
  p('');
  p('**Split by SUBJECT (#1524)** — what the sweep gates decides the disposition,');
  p('so the split is per LIST and derived, never a field typed onto 370 entries:');
  p('');
  p('| subject | exemptions | disposition |');
  p('| --- | ---: | --- |');
  for (const [key, meta] of Object.entries(SUBJECT_ANCHORS)) {
    const n = [...b2.records, ...b2.sets]
      .filter((e) => e.subject === key)
      .reduce((s, e) => s + e.count, 0);
    p(`| \`${key}\` | ${n} | ${meta.label} — ${meta.anchor} |`);
  }
  p('');
  const domTotal = [...b2.records, ...b2.sets].reduce((s, e) => s + e.domDerived.length, 0);
  p(`Of the \`engine\` population, **${domTotal}** are DERIVED CAPABILITY: the module is in`);
  p('`DOM_SOURCE_LANE_TYPES` (`packages/web/src/lib/ui/workflow/dom-source-modules.ts`),');
  p('i.e. its engine source is created and attached by a MOUNTED CARD, which does not');
  p('exist under the bare `spawnPatch` these sweeps use — so both arms read silence by');
  p('construction. LEG-02 (#1511, node-owned media lifecycle) is what makes them');
  p('payable. Membership is read off that set, so it moves without an edit here.');
  p('');
  for (const e of [...b2.records, ...b2.sets]) {
    p(`### \`${e.konst}\` (${e.count}) — ${e.desc}`);
    p(`<sub>${e.file} · subject: \`${e.subject}\`</sub>`);
    if (e.domDerived.length > 0) {
      p(`<sub>derived capability (DOM_SOURCE_LANE_TYPES): ${e.domDerived.map((k) => `\`${k}\``).join(', ')}</sub>`);
    }
    if (e.count === 0) p('_none_');
    for (const k of e.keys) {
      const reason = e.reasons ? summarize(e.reasons.get(k)) : '';
      p(`- \`${k}\`${reason ? ` — ${reason}` : ''}`);
    }
    p('');
  }
  p('### Opt-IN completeness ratchets (the more members the better)');
  p('');
  for (const r of b2.ratchets) p(`- \`${r.konst}\`: **${r.count}** — ${r.desc} <sub>(${r.file})</sub>`);
  p('');

  // ── Bucket 3 ──
  p(`## Bucket 3 — informational-only CI lanes (${b3.items.length})`);
  p('');
  p('Jobs that RUN on a PR but never block merge. Red here is a signal to inspect,');
  p('not a merge blocker.');
  p('');
  for (const it of b3.items) p(`- \`${it.name}\` — ${it.reason}`);
  p('');

  return L.join('\n') + '\n';
}

// ───────────────────────── CLI ─────────────────────────

function isMain() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMain()) {
  const md = generateLedger();
  if (process.argv.includes('--write')) {
    writeFileSync(LEDGER_PATH, md, 'utf8');
    process.stderr.write(`[test-ledger] wrote ${LEDGER_PATH}\n`);
  } else {
    process.stdout.write(md);
  }
}

export { bucket1, bucket2, bucket3, existsSync };
