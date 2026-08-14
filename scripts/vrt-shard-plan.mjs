// scripts/vrt-shard-plan.mjs
//
// COST-BASED shard assignment for the REQUIRED `vrt-strict` lane (#1595).
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// `vrt-strict` was ONE unsharded job while the e2e lane beside it ran 10 ways.
// Measured on ci.yml run 31736165616 (all green): 17.30 min wall, the longest
// job in the run, ending 0.1 min before the slowest e2e shard — i.e. it was
// half of a two-job floor under the PR-blocking critical path.
//
//     job wall           1038 s   (17.30 min)
//     Playwright step     881 s
//     sum of test time    860.1 s  over 115 tests
//     → fixed per-shard overhead ≈ 178 s (checkout + flox + LFS + npm + boot)
//
// ── Why not Playwright's own --shard ──────────────────────────────────────
//
// #1538's finding, and it is WORSE here. `--shard=N/M` splits by test COUNT,
// which on the e2e suite produced perfect count balance and 2.31x COST
// imbalance. This lane has only TWO spec files (vrt.spec.ts +
// workflow-shell-faces.spec.ts) and `fullyParallel: false`, so file-granular
// sharding cannot produce more than two bins at all — and those two bins are
// 238 s and 622 s, a 2.6x split that caps the achievable speedup at 1.4x.
//
// So the unit here is the TEST, not the file, and the selection mechanism is
// `--grep` over an anchored alternation of the shard's test titles.
//
// ── The property that actually matters ────────────────────────────────────
//
// Selecting tests explicitly means WE are responsible for covering the lane —
// Playwright is not. A partition that silently dropped a scene would look
// EXACTLY like a speedup on a REQUIRED gate: faster, green, and blind. Three
// independent checks, none of which can pass vacuously:
//
//   1. `planVrtShards` itself refuses a plan whose union is not the discovered
//      set, or that contains a duplicate — it throws, it does not warn.
//   2. `selects()` simulates Playwright's own grep matching over the discovered
//      title paths and asserts each shard's regex picks EXACTLY its group.
//      `scripts/vrt-shard-plan.test.ts` runs 1+2 on the committed artifact.
//   3. In CI each shard compares the tests it ACTUALLY EXECUTED (parsed back
//      out of the `list` reporter output) against its plan, and fails on any
//      difference. That one is anchored to the run, not to the plan.
//
// (1) and (2) are properties of the plan; only (3) can catch a grep that
// Playwright interprets differently than this file models it.
//
// ── How Playwright matches --grep (probed, not assumed) ───────────────────
//
// Measured against @playwright/test 1.59.1 with this exact config: the string
// grep is tested against is the title path joined by SPACES, starting with the
// PROJECT name —
//
//     chromium-vrt vrt.spec.ts VRT: every module card matches its baseline adsr card matches baseline
//
// Probe results that pinned it (counts out of 115):
//     `^chromium-vrt`                        115   ← project name leads
//     `vrt\.spec\.ts`                         48   ← file path, no `vrt/` prefix
//     `› polarizer card matches baseline$`     0   ← NOT joined by `›`
//     `polarizer card matches baseline$`        2   ← ⚠ also matches DEpolarizer
//     ` polarizer card matches baseline$`       1   ← the leading space anchors it
//
// The 2-vs-1 row is why every alternative below carries a leading-space anchor:
// module type names are suffixes of each other (polarizer/depolarizer) and an
// unanchored title would silently pull a sibling onto two shards.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The Playwright project name in e2e/vrt/vrt.config.ts. Part of the grep target. */
export const VRT_PROJECT = 'chromium-vrt';

/** `<spec file> :: <test title>` — the key shape of the timings artifact. */
export function keyOf(t) {
  return `${t.file} :: ${t.title}`;
}

/** @returns {Record<string, number>} `<file> :: <title>` -> seconds */
export function loadTimings(path = join(ROOT, 'e2e/vrt-strict-timings.generated.json')) {
  return JSON.parse(readFileSync(path, 'utf8')).tests;
}

/** Median of a numeric array (the cost assigned to an unmeasured test). */
export function median(xs) {
  if (xs.length === 0) return 1;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Parse `playwright test --list --reporter=json` into the flat test list.
 *
 * @param {any} report parsed JSON from Playwright's list reporter
 * @returns {{file: string, title: string, titlePath: string[]}[]}
 */
export function testsFromListJson(report) {
  const out = [];
  (function walk(suites, path) {
    for (const s of suites ?? []) {
      const p = [...path, s.title];
      for (const spec of s.specs ?? []) out.push({ file: spec.file, title: spec.title, titlePath: [...p, spec.title] });
      walk(s.suites, p);
    }
  })(report.suites, []);
  // Stable order regardless of reporter ordering — the plan must not depend on it.
  out.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  return out;
}

/** Escape a string for literal use inside a RegExp. */
export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The `--grep` pattern selecting exactly `group`.
 *
 * Anchored BOTH ends: a leading space (the title is never the first element of
 * the joined path, so one always precedes it) and `$` (the test title is always
 * last). Without the leading anchor ` polarizer …` also matches `depolarizer …`.
 */
export function grepFor(group) {
  if (group.length === 0) throw new Error('grepFor: empty group — a shard with no tests is a dropped-coverage bug');
  return `(?: ${group.map((t) => escapeRe(t.title)).join('| ')})$`;
}

/** The string Playwright applies `--grep` to, for a discovered test. */
export function grepTarget(t) {
  return [VRT_PROJECT, ...t.titlePath].join(' ');
}

/** Simulate Playwright's grep: which of `tests` does `pattern` select? */
export function selects(pattern, tests) {
  const re = new RegExp(pattern);
  return tests.filter((t) => re.test(grepTarget(t)));
}

/**
 * Partition `tests` into `shards` groups, balancing MEASURED cost.
 *
 * Longest-Processing-Time-first bin packing: sort by cost descending, place
 * each test on the currently-lightest shard. Deterministic — ties broken by
 * key — because every shard job runs this independently and they must agree
 * without communicating.
 *
 * THROWS rather than warns if the partition is not a partition. On a required
 * gate a silently-dropped scene is the failure mode this whole file exists to
 * make impossible, so it must not be expressible.
 *
 * @param {{file: string, title: string, titlePath: string[]}[]} tests
 * @param {Record<string, number>} timings
 * @param {number} shards
 * @returns {{groups: object[][], loads: number[], unknown: string[]}}
 */
export function planVrtShards(tests, timings, shards) {
  if (shards < 1) throw new Error(`shards must be >= 1, got ${shards}`);
  if (tests.length < shards) {
    throw new Error(`cannot split ${tests.length} tests across ${shards} shards without an empty shard`);
  }

  // The grep is built from the LEAF TITLE, so two tests sharing one would be
  // indistinguishable to the selector: one shard would run both and another
  // would run neither, with the union still looking complete. Refuse the plan
  // and name the collision rather than produce a partition we cannot select.
  const byTitle = new Map();
  for (const t of tests) {
    const prev = byTitle.get(t.title);
    if (prev && prev !== t.file) {
      throw new Error(
        `duplicate test title across spec files — the --grep selector cannot tell them apart: ` +
          `"${t.title}" appears in ${prev} and ${t.file}. Rename one.`,
      );
    }
    byTitle.set(t.title, t.file);
  }

  const known = Object.values(timings);
  const fallback = median(known);
  const unknown = tests.filter((t) => timings[keyOf(t)] === undefined).map(keyOf).sort();

  const cost = (t) => timings[keyOf(t)] ?? fallback;
  const groups = Array.from({ length: shards }, () => []);
  const loads = new Array(shards).fill(0);

  const ordered = [...tests].sort((a, b) => cost(b) - cost(a) || (keyOf(a) < keyOf(b) ? -1 : 1));
  for (const t of ordered) {
    let pick = 0;
    for (let i = 1; i < shards; i++) if (loads[i] < loads[pick]) pick = i;
    groups[pick].push(t);
    loads[pick] += cost(t);
  }
  for (const g of groups) g.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1));

  // ── UNION-EQUALS-DISCOVERED, asserted here so no caller can skip it ──────
  const flat = groups.flat();
  const seen = new Set(flat.map(keyOf));
  if (flat.length !== tests.length || seen.size !== tests.length) {
    throw new Error(
      `vrt shard plan is not a partition: ${tests.length} discovered, ${flat.length} assigned, ${seen.size} distinct`,
    );
  }
  for (const t of tests) {
    if (!seen.has(keyOf(t))) throw new Error(`vrt shard plan dropped ${keyOf(t)}`);
  }
  // Each shard's regex must select exactly its own group — see the probe note
  // at the top of this file for why the anchoring is load-bearing.
  for (let i = 0; i < shards; i++) {
    const hit = selects(grepFor(groups[i]), tests).map(keyOf).sort();
    const want = groups[i].map(keyOf).sort();
    if (hit.join('\u0000') !== want.join('\u0000')) {
      const extra = hit.filter((k) => !want.includes(k));
      const missing = want.filter((k) => !hit.includes(k));
      throw new Error(
        `shard ${i + 1}/${shards} grep does not select its own group ` +
          `(+${extra.length} ${JSON.stringify(extra.slice(0, 3))}, -${missing.length} ${JSON.stringify(missing.slice(0, 3))})`,
      );
    }
  }

  return { groups, loads, unknown };
}

// ───────────────────────────── CLI ─────────────────────────────
//
//   node scripts/vrt-shard-plan.mjs <shardIndex 1-based> <shardCount> --list <playwright-list.json> [--out <file>]
//       → prints the shard's --grep pattern on stdout; --out writes its
//         `<file> :: <title>` keys, one per line, for the post-run check.
//   node scripts/vrt-shard-plan.mjs --report <shardCount> [--list <file>]
//       → predicted per-shard load, using the committed timings as the roster.

const isMain =
  typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('vrt-shard-plan.mjs');

if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const timings = loadTimings();

  /** Roster from a Playwright --list JSON, or from the timings artifact itself. */
  const roster = () => {
    const listPath = flag('--list');
    if (listPath) return testsFromListJson(JSON.parse(readFileSync(listPath, 'utf8')));
    return Object.keys(timings)
      .map((k) => {
        const [file, title] = k.split(' :: ');
        return { file, title, titlePath: [file, '<describe>', title] };
      })
      .sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1));
  };

  if (args[0] === '--report') {
    const shards = Number(args[1] ?? 4);
    const tests = roster();
    const { loads } = planVrtShards(tests, timings, shards);
    const total = loads.reduce((a, b) => a + b, 0);
    // MEASURED on run 31736165616: job wall 1038 s − Playwright step 881 s =
    // 157 s of job overhead, plus 881 − 860.1 = 21 s of Playwright boot.
    const OVERHEAD_S = 178;
    console.log(`tests=${tests.length} totalCPU=${total.toFixed(1)}s overhead/shard=${OVERHEAD_S}s`);
    for (let i = 0; i < shards; i++) {
      console.log(`  shard ${i + 1}/${shards}: ${loads[i].toFixed(1)}s tests + ${OVERHEAD_S}s = ${((loads[i] + OVERHEAD_S) / 60).toFixed(2)} min`);
    }
    const max = Math.max(...loads);
    const min = Math.min(...loads);
    console.log(`spread ${(max / min).toFixed(3)}x · predicted job wall ${((max + OVERHEAD_S) / 60).toFixed(2)} min · runner ${((total + OVERHEAD_S * shards) / 60).toFixed(1)} job-min`);
    process.exit(0);
  }

  const idx = Number(args[0]);
  const count = Number(args[1]);
  if (!Number.isInteger(idx) || !Number.isInteger(count) || idx < 1 || idx > count) {
    throw new Error(`usage: vrt-shard-plan.mjs <1..N> <N> --list <playwright-list.json> [--out <file>]`);
  }
  if (!flag('--list')) throw new Error('need --list <playwright --list --reporter=json output>');

  const tests = roster();
  const { groups, unknown } = planVrtShards(tests, timings, count);
  if (unknown.length) {
    // Not dropped — scheduled at the median cost, and named so the artifact can
    // be refreshed deliberately rather than drifting.
    console.error(`::warning::${unknown.length} vrt-strict test(s) have no measured cost (using median): ${unknown.join(', ')}`);
  }
  const out = flag('--out');
  if (out) writeFileSync(out, groups[idx - 1].map(keyOf).join('\n') + '\n');
  // stdout is consumed by CI as the --grep pattern for this shard.
  console.log(grepFor(groups[idx - 1]));
}
