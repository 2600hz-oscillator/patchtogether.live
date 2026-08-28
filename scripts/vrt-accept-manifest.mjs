#!/usr/bin/env node
// scripts/vrt-accept-manifest.mjs
//
// EMIT THE ACCEPT-CANDIDATES MANIFEST from a failed vrt-strict shard.
//
// Why this exists: under zero tolerance, a strict shard's `<scene>-actual.png`
// is byte-for-byte what a `--update-snapshots=all` capture would have written
// to the baseline — Playwright's gate and capture share one stabilization loop
// and one `writeFileSync` buffer (toMatchSnapshot.js writeFiles: same buffer,
// both destinations, no re-encode). So a failing run already CONTAINS the next
// baseline, and vrt-accept.yml can promote it without a 25-minute re-capture.
// That promotion is only sound if this producer records, at the source:
//
//   · the BASELINE REPO PATH each actual maps to — derived from Playwright's
//     own attachment metadata, NEVER from the test-results folder name. The
//     folder name is TRUNCATED by Playwright (a 65-scene run renders
//     `moog907a` into `vrt-VRT-every-module-card--3cb78-g907a-…`), so any
//     folder-name parse writes real bytes to a wrong path sooner or later.
//     The `-expected` attachment's `path` IS `SnapshotHelper.expectedPath`,
//     the absolute committed-baseline path (toMatchSnapshot.js:150) — the one
//     the comparison actually read. It is cross-checked against the config's
//     `snapshotPathTemplate` shape below; disagreement is a hard refusal.
//   · the actual's sha256 — the end-to-end integrity anchor. Artifact
//     transport corrupted 10 of 98 PNGs on run 33211181271; decode-verify at
//     the sink catches bit-rot that breaks zlib, but only a producer-recorded
//     hash catches corruption that still decodes.
//   · whether a `-previous.png` exists — Playwright writes it ONLY when the
//     render never reached two consecutive identical screenshots ("Failed to
//     take two consecutive stable screenshots"). Such an actual is a moving
//     frame; promoting it bakes motion into a baseline. vrt-accept.yml
//     REFUSES these, so the flag must be recorded where the file is.
//
// Modes:
//   --report <playwright-json>   (CI path — authoritative)
//       Walk the JSON report's failed screenshot assertions; reconcile the
//       attachment set against the actual files on disk in BOTH directions:
//       an actual on disk that no report entry claims is a refusal (the
//       report and the results tree disagree — promote nothing).
//   --from-results-tree          (fallback — for artifact sets that predate
//       the JSON report step, e.g. triaging a downloaded run by hand)
//       Derive each actual's baseline path by looking its snapshot NAME up in
//       the checked-out e2e/vrt/__screenshots__ tree: exactly one spec dir
//       must hold `<name>.png` (zero = a NEW scene this mode cannot place —
//       refuse; two = ambiguous — refuse), and the test-results folder name
//       must start with that spec's slug (a cheap second witness). Deny by
//       default: anything this derivation cannot pin exactly is a refusal,
//       never a guess.
//
// Output: one JSON manifest (schema vrt-accept-candidates/v1). Exit 0 with a
// zero-candidate manifest is legitimate (a shard can fail for non-screenshot
// reasons); any ambiguity, conflict or reconciliation failure exits 1 and
// names the scene.
//
// Usage:
//   node scripts/vrt-accept-manifest.mjs --report <file> --results <dir> --out <file> [--shard N]
//   node scripts/vrt-accept-manifest.mjs --from-results-tree --results <dir> --out <file> [--shard N]

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDecodablePng } from './vrt-png-verify.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_ROOT = 'e2e/vrt/__screenshots__';
const NEVER_SETTLED = 'Failed to take two consecutive stable screenshots';

export const SCHEMA = 'vrt-accept-candidates/v1';

// ---- helpers ---------------------------------------------------------------

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function walk(dir) {
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Repo-relative POSIX path, refusing anything that escapes the repo. */
function repoRel(abs, repoRoot) {
  const rel = relative(repoRoot, abs).split(sep).join('/');
  if (rel.startsWith('..')) {
    throw new Error(`path escapes the repo root: ${abs} (root ${repoRoot})`);
  }
  return rel;
}

/**
 * The template cross-check (§1.4.5 of the promote-on-accept report): the
 * attachment's expected path must be EXACTLY what the config template
 * `__screenshots__/{testFilePath}/{arg}{ext}` produces for this spec + name.
 * Two independent derivations that agree, or no candidate at all.
 */
export function templateBaselinePath(specFile, name) {
  return `${BASELINE_ROOT}/${specFile}/${name}.png`;
}

// ---- report mode -----------------------------------------------------------

/** Flatten the Playwright JSON report into [{specFile, title, result}] leaves. */
export function collectFailures(report) {
  const out = [];
  const visitSuite = (suite, specFile) => {
    for (const child of suite.suites ?? []) visitSuite(child, specFile ?? child.file);
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          if (result.status === 'passed' || result.status === 'skipped') continue;
          out.push({ specFile: spec.file ?? specFile, title: spec.title, result });
        }
      }
    }
  };
  for (const suite of report.suites ?? []) visitSuite(suite, suite.file);
  return out;
}

/**
 * Group one failed result's snapshot attachments by snapshot base name.
 * Attachment names are `<name>-expected.png` / `-actual.png` / `-previous.png`
 * / `-diff.png` (SnapshotHelper.attachmentBaseName + suffix); everything else
 * (trace, screenshot-on-failure, error-context) is ignored.
 */
export function groupSnapshotAttachments(attachments) {
  const groups = new Map();
  for (const a of attachments ?? []) {
    const m = /^(.+)-(expected|actual|previous|diff)\.png$/.exec(a.name ?? '');
    if (!m) continue;
    const g = groups.get(m[1]) ?? {};
    g[m[2]] = a.path;
    groups.set(m[1], g);
  }
  return groups;
}

/**
 * Build candidates from the JSON report + results tree. Throws (with every
 * problem listed, scene by scene) rather than emitting a doubtful manifest.
 */
export function candidatesFromReport({ report, resultsDir, repoRoot = ROOT }) {
  const problems = [];
  const candidates = [];
  const unpromotable = [];
  const claimedActuals = new Set();

  for (const { specFile, title, result } of collectFailures(report)) {
    const groups = groupSnapshotAttachments(result.attachments);
    if (groups.size === 0) {
      // A functional failure (timeout, crash, "unrecognised content at end of
      // stream" before any write) — nothing to promote, but the accept surface
      // should still say the scene is red for a NON-pixel reason.
      unpromotable.push({ spec_file: specFile, test_title: title, reason: 'no-snapshot-attachments' });
      continue;
    }
    for (const [name, g] of groups) {
      if (!g.actual) {
        unpromotable.push({ spec_file: specFile, test_title: title, name, reason: 'no-actual' });
        continue;
      }
      if (!g.expected) {
        // `updateSnapshots: none` (CI) never writes an actual without having
        // read a baseline, so this shape means the run was NOT the gate this
        // producer models — refuse rather than guess a path for it.
        problems.push(`${specFile} :: ${name}: actual attachment with NO expected attachment — cannot derive a baseline path`);
        continue;
      }
      let baselinePath;
      try {
        baselinePath = repoRel(g.expected, repoRoot);
      } catch (e) {
        problems.push(`${specFile} :: ${name}: ${e.message}`);
        continue;
      }
      const templated = templateBaselinePath(specFile, name);
      if (baselinePath !== templated) {
        problems.push(
          `${specFile} :: ${name}: attachment expected path "${baselinePath}" disagrees with ` +
            `snapshotPathTemplate derivation "${templated}" — refusing (a promote step must not guess)`,
        );
        continue;
      }
      if (!existsSync(g.actual)) {
        problems.push(`${specFile} :: ${name}: report names actual "${g.actual}" but it is not on disk`);
        continue;
      }
      const buf = readFileSync(g.actual);
      try {
        assertDecodablePng(buf);
      } catch (e) {
        problems.push(`${specFile} :: ${name}: actual does not decode (${e.message}) — corrupt at the SOURCE, not transport`);
        continue;
      }
      const neverSettled =
        g.previous !== undefined ||
        (result.errors ?? []).some((err) => (err.message ?? '').includes(NEVER_SETTLED));
      const actualAbs = resolve(g.actual);
      claimedActuals.add(actualAbs);
      candidates.push({
        key: `${specFile} :: ${name}`,
        name,
        spec_file: specFile,
        test_title: title,
        baseline_path: baselinePath,
        actual_path: relative(resolve(resultsDir), actualAbs).split(sep).join('/'),
        actual_sha256: sha256(buf),
        previous_png_present: g.previous !== undefined,
        settled: !neverSettled,
      });
    }
  }

  // Reconciliation, the direction the report cannot see: every actual ON DISK
  // must be claimed by exactly one report entry. An unclaimed actual means the
  // report and the results tree describe different runs — promote nothing.
  for (const f of existsSync(resultsDir) ? walk(resultsDir) : []) {
    if (!f.endsWith('-actual.png')) continue;
    if (!claimedActuals.has(resolve(f))) {
      problems.push(`actual on disk not claimed by any report failure: ${f}`);
    }
  }

  dedupeInPlace(candidates, problems);
  if (problems.length > 0) {
    throw new Error(`vrt-accept-manifest REFUSES to emit:\n  - ${problems.join('\n  - ')}`);
  }
  return { candidates, unpromotable };
}

// ---- results-tree fallback mode --------------------------------------------

/** Spec-file → the slug prefix Playwright gives its output folders. */
function specSlugPrefix(specFile) {
  // `vrt.spec.ts` → folders start `vrt-`; `workflow-shell-faces.spec.ts` →
  // `workflow-shell-faces-`. Playwright slugs the spec path by replacing
  // non-alphanumerics; the `.spec.ts` suffix is dropped from the slug head.
  return `${specFile.replace(/\.spec\.ts$/, '').replace(/[^a-zA-Z0-9]+/g, '-')}-`;
}

/**
 * Fallback derivation for artifact sets that predate the JSON-report step:
 * place each actual's snapshot NAME in the committed baseline tree. Exactly
 * one spec dir must hold `<name>.png`; the truncated output-folder name must
 * agree with that spec; anything else is a refusal. NEW scenes (no committed
 * baseline anywhere) cannot be placed by this mode BY DESIGN — the report
 * carries their authoritative path, this mode does not.
 */
export function candidatesFromResultsTree({ resultsDir, repoRoot = ROOT }) {
  const problems = [];
  const candidates = [];
  const baselineDir = join(repoRoot, BASELINE_ROOT);
  if (!existsSync(baselineDir)) {
    throw new Error(`baseline tree not found at ${baselineDir} — run from a checkout of the run's commit`);
  }
  // name → [specFile…] over the committed tree (LFS pointers are fine: only
  // paths are consulted here, never pixel bytes).
  const byName = new Map();
  for (const specDir of readdirSync(baselineDir, { withFileTypes: true })) {
    if (!specDir.isDirectory()) continue;
    for (const f of readdirSync(join(baselineDir, specDir.name))) {
      if (!f.endsWith('.png')) continue;
      const name = f.slice(0, -'.png'.length);
      const list = byName.get(name) ?? [];
      list.push(specDir.name);
      byName.set(name, list);
    }
  }

  for (const f of walk(resultsDir)) {
    if (!f.endsWith('-actual.png')) continue;
    const name = basename(f).slice(0, -'-actual.png'.length);
    const folder = basename(dirname(f));
    const specs = byName.get(name) ?? [];
    if (specs.length === 0) {
      problems.push(`${name}: no committed baseline holds this snapshot name — a NEW scene needs the JSON-report mode`);
      continue;
    }
    if (specs.length > 1) {
      problems.push(`${name}: ambiguous — committed under ${specs.join(' AND ')}; refusing to pick`);
      continue;
    }
    const specFile = specs[0];
    if (!folder.startsWith(specSlugPrefix(specFile))) {
      problems.push(
        `${name}: results folder "${folder}" does not carry spec slug "${specSlugPrefix(specFile)}" — ` +
          `the tree-derived spec ${specFile} is not corroborated; refusing`,
      );
      continue;
    }
    const buf = readFileSync(f);
    try {
      assertDecodablePng(buf);
    } catch (e) {
      problems.push(`${name}: actual does not decode (${e.message})`);
      continue;
    }
    const previous = existsSync(join(dirname(f), `${name}-previous.png`));
    candidates.push({
      key: `${specFile} :: ${name}`,
      name,
      spec_file: specFile,
      test_title: null,
      baseline_path: templateBaselinePath(specFile, name),
      actual_path: relative(resolve(resultsDir), resolve(f)).split(sep).join('/'),
      actual_sha256: sha256(buf),
      previous_png_present: previous,
      settled: !previous,
    });
  }

  dedupeInPlace(candidates, problems);
  if (problems.length > 0) {
    throw new Error(`vrt-accept-manifest REFUSES to emit:\n  - ${problems.join('\n  - ')}`);
  }
  return { candidates, unpromotable: [] };
}

// ---- shared: duplicate handling --------------------------------------------

/**
 * Two claims on one baseline path inside a shard: byte-agreement collapses to
 * one candidate (the run genuinely rendered the scene twice, identically);
 * disagreement is a conflict — the run is internally inconsistent and nothing
 * from it should be promoted. Mutates `candidates`, appends to `problems`.
 */
export function dedupeInPlace(candidates, problems) {
  const byPath = new Map();
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i];
    const prior = byPath.get(c.baseline_path);
    if (!prior) {
      byPath.set(c.baseline_path, c);
      continue;
    }
    if (prior.actual_sha256 === c.actual_sha256) {
      candidates.splice(i, 1); // identical render — one candidate stands for both
    } else {
      problems.push(
        `CONFLICT on ${c.baseline_path}: two actuals in one shard disagree ` +
          `(${prior.actual_sha256.slice(0, 12)} vs ${c.actual_sha256.slice(0, 12)})`,
      );
    }
  }
}

// ---- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const args = { report: null, results: null, out: null, shard: null, repoRoot: ROOT, fromResultsTree: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--report') args.report = argv[++i];
    else if (a === '--results') args.results = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--shard') args.shard = argv[++i];
    else if (a === '--repo-root') args.repoRoot = argv[++i];
    else if (a === '--from-results-tree') args.fromResultsTree = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.results || !args.out) throw new Error('usage: --results <dir> --out <file> and (--report <json> | --from-results-tree)');
  if (!args.report && !args.fromResultsTree) throw new Error('pass --report <json> (CI) or --from-results-tree (fallback)');
  if (args.report && args.fromResultsTree) throw new Error('--report and --from-results-tree are exclusive');
  return args;
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const resultsDir = isAbsolute(args.results) ? args.results : resolve(args.results);
    const built = args.fromResultsTree
      ? candidatesFromResultsTree({ resultsDir, repoRoot: args.repoRoot })
      : candidatesFromReport({
          report: JSON.parse(readFileSync(args.report, 'utf8')),
          resultsDir,
          repoRoot: args.repoRoot,
        });
    built.candidates.sort((a, b) => a.baseline_path.localeCompare(b.baseline_path));
    const manifest = {
      schema: SCHEMA,
      run_id: process.env.GITHUB_RUN_ID ?? null,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      job: process.env.GITHUB_JOB ?? null,
      shard: args.shard !== null ? Number(args.shard) : null,
      head_sha: process.env.VRT_HEAD_SHA || process.env.GITHUB_SHA || null,
      cpu_model: process.env.VRT_CPU_MODEL ?? null,
      source: args.fromResultsTree ? 'results-tree-fallback' : 'playwright-json-report',
      candidates: built.candidates,
      unpromotable: built.unpromotable,
    };
    writeFileSync(args.out, JSON.stringify(manifest, null, 2) + '\n');
    const settled = built.candidates.filter((c) => c.settled).length;
    console.error(
      `[vrt-accept-manifest] wrote ${args.out}: ${built.candidates.length} candidate(s) ` +
        `(${settled} settled, ${built.candidates.length - settled} NEVER-settled → refusable), ` +
        `${built.unpromotable.length} failing scene(s) with nothing to promote`,
    );
    for (const c of built.candidates) {
      console.error(`  ${c.settled ? ' ' : '⚠'} ${c.baseline_path}  ${c.actual_sha256.slice(0, 12)}`);
    }
  } catch (err) {
    console.error(`[vrt-accept-manifest] ERROR: ${err.message}`);
    process.exit(1);
  }
}
