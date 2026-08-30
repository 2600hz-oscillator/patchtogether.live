#!/usr/bin/env node
// scripts/vrt-accept.mjs
//
// PROMOTE a failed vrt-strict run's `actual` bytes over their committed
// baselines — the verify-and-copy core of .github/workflows/vrt-accept.yml.
//
// This is NOT a re-capture. Under zero tolerance the strict lane's
// `<scene>-actual.png` is byte-for-byte what `--update-snapshots=all` would
// have committed (one stabilization loop, one buffer, two writeFileSync
// destinations — playwright toMatchSnapshot.js), so promotion re-rolls ZERO
// rasterization dice where a re-capture rolls them a third time. The trade is
// that every guard has to live HERE, because no browser will re-derive the
// pixels before they land:
//
//   REFUSED, loudly, naming the scene — never a warning:
//   · a scene whose shard wrote a `-previous.png` (the render NEVER SETTLED;
//     its actual is a moving frame — promoting it bakes motion into a
//     baseline that the next run then fails);
//   · a downloaded actual whose sha256 differs from the one the producing
//     shard recorded (artifact transport corrupted 10 of 98 PNGs on run
//     33211181271 — corruption must surface as a TRANSPORT MISMATCH, not as
//     whatever gate later decodes the poisoned baseline);
//   · a PNG that does not fully decode (scripts/vrt-png-verify.mjs — the
//     Adler-32 tail catches truncation that chunk CRCs hide; REUSED, not
//     reimplemented, so the two paths cannot drift);
//   · two shards offering the same baseline different bytes (the partition
//     leaked, or the render is per-VM bistable — either way promotion would
//     launder nondeterminism into git);
//   · a requested scene the manifests do not carry (typo / stale list), or a
//     short name matching more than one spec's snapshot;
//   · a manifest whose run_id / head_sha disagree with the run being
//     promoted (belt to the workflow's own freshness gate braces).
//
//   And ONE policy gate: more than VRT_ACCEPT_CEILING scenes without the
//   explicit ALL waiver is refused — a change that big is a CAPTURE, not an
//   accept (`task vrt:commit` is the deliberate full re-render; this tool
//   must not quietly replace it).
//
// Unlike the capture collector (vrt-commit-baselines.sh, which un-stages a
// corrupt file and lands the rest — right for a 25-minute render), ANY
// refusal here fails the WHOLE accept: re-running costs ~90 seconds and a
// partially-applied accept is a confusing audit record.
//
// The script only verifies and copies; git identity/commit/push stay in the
// workflow (same split as vrt-update.yml → vrt-commit-baselines.sh).
//
// Usage (from vrt-accept.yml):
//   node scripts/vrt-accept.mjs \
//     --candidates <dir with vrt-accept-candidates-*/…json> \
//     --results    <dir with vrt-strict-test-results-<n>/…> \
//     --run-id <id> --scenes "<'' | 'ALL' | [ALL] scene…>" \
//     --message-out <file> --accepted-out <file> [--head <sha>] [--actor <login>]

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDecodablePng } from './vrt-png-verify.mjs';
import { SCHEMA, dedupeInPlace, sha256 } from './vrt-accept-manifest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_ROOT = 'e2e/vrt/__screenshots__';

// The report's ceiling (§4.5): ~40 is where "reviewed accept" ends and
// "global re-render" begins. A policy threshold on a derived measurement,
// not a population count.
export const VRT_ACCEPT_CEILING = 40;

// ---- manifest loading ------------------------------------------------------

function walkJson(dir) {
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...walkJson(p));
    else if (/^vrt-accept-candidates-.*\.json$/.test(d.name)) out.push(p);
  }
  return out;
}

/**
 * Merge every shard manifest under `dir`. Cross-shard duplicates that agree
 * byte-for-byte collapse (two shards rendered one scene identically —
 * commit 4600f6ed8's run had exactly this); disagreement is a hard conflict.
 */
export function loadManifests({ candidatesDir, runId, problems }) {
  const files = walkJson(candidatesDir);
  if (files.length === 0) {
    problems.push(`no vrt-accept-candidates-*.json under ${candidatesDir} — was the run red for screenshot reasons?`);
    return { candidates: [], manifests: [] };
  }
  const manifests = [];
  const candidates = [];
  for (const f of files.sort()) {
    const m = JSON.parse(readFileSync(f, 'utf8'));
    if (m.schema !== SCHEMA) {
      problems.push(`${f}: schema "${m.schema}" is not "${SCHEMA}" — refusing to interpret it`);
      continue;
    }
    if (runId && m.run_id && String(m.run_id) !== String(runId)) {
      problems.push(`${f}: manifest is from run ${m.run_id}, not the requested run ${runId} — a mixed download`);
      continue;
    }
    manifests.push(m);
    for (const c of m.candidates ?? []) candidates.push({ ...c, shard: m.shard, cpu_model: m.cpu_model, head_sha: m.head_sha });
  }
  dedupeInPlace(candidates, problems);
  return { candidates, manifests };
}

// ---- scene selection -------------------------------------------------------

/**
 * `scenes` string semantics (also what Taskfile `vrt:accept` emits):
 *   ''                → every SETTLED candidate, subject to the ceiling
 *   'ALL'             → every SETTLED candidate, ceiling deliberately waived
 *   'a b c'           → exactly these scenes, ceiling enforced
 *   'ALL a b … (>40)' → exactly these scenes, ceiling waived
 * A scene token is `<name>` or `<spec_file>/<name>`; a short name matching
 * two specs is refused with the qualified forms listed.
 */
export function selectScenes({ candidates, scenesSpec, problems }) {
  const tokens = (scenesSpec ?? '').split(/[\s,]+/).filter(Boolean);
  const waived = tokens[0] === 'ALL';
  const explicit = waived ? tokens.slice(1) : tokens;

  let selected;
  const excludedUnsettled = [];
  if (explicit.length === 0) {
    selected = candidates.filter((c) => {
      if (c.settled && !c.previous_png_present) return true;
      excludedUnsettled.push(c);
      return false;
    });
    if (selected.length === 0) {
      problems.push('nothing to accept: the run has no settled candidates');
    }
  } else {
    selected = [];
    for (const tok of explicit) {
      if (!/^[A-Za-z0-9_.\-/]+$/.test(tok)) {
        problems.push(`scene "${tok}" is not a valid scene token`);
        continue;
      }
      const matches = candidates.filter((c) => c.name === tok || `${c.spec_file}/${c.name}` === tok);
      if (matches.length === 0) {
        problems.push(`requested scene "${tok}" is not among this run's candidates (typo, or a stale list?)`);
      } else if (matches.length > 1) {
        problems.push(
          `requested scene "${tok}" is ambiguous — qualify it: ${matches.map((c) => `${c.spec_file}/${c.name}`).join(' | ')}`,
        );
      } else {
        // An EXPLICITLY requested never-settled scene is a refusal, not an
        // exclusion: the operator asked for a moving frame by name.
        const c = matches[0];
        if (!c.settled || c.previous_png_present) {
          problems.push(
            `scene "${tok}" NEVER SETTLED (-previous.png present): its actual is a moving frame — ` +
              'fix the motion, do not promote it',
          );
        } else {
          selected.push(c);
        }
      }
    }
  }

  if (selected.length > VRT_ACCEPT_CEILING && !waived) {
    problems.push(
      `${selected.length} scenes exceeds the accept ceiling of ${VRT_ACCEPT_CEILING}. ` +
        'A change this big is a CAPTURE, not an accept — use `task vrt:commit` for a deliberate ' +
        're-render, or re-run with ACCEPT_ALL=1 if every one of these has genuinely been reviewed.',
    );
  }
  return { selected, excludedUnsettled, waived };
}

// ---- verification + copy ---------------------------------------------------

/**
 * Verify one candidate end-to-end and copy its bytes over the baseline.
 * Returns 'accepted' | 'identical', or pushes to `problems` and returns null.
 */
export function verifyAndCopy({ c, resultsDir, repoRoot, problems, dryRun = false }) {
  if (typeof c.shard !== 'number') {
    problems.push(`${c.key}: manifest carries no shard number — cannot locate its test-results artifact`);
    return null;
  }
  if (!c.baseline_path.startsWith(`${BASELINE_ROOT}/`) || c.baseline_path.includes('..')) {
    problems.push(`${c.key}: baseline path "${c.baseline_path}" is outside ${BASELINE_ROOT} — refusing to write it`);
    return null;
  }
  const actualAbs = join(resultsDir, `vrt-strict-test-results-${c.shard}`, c.actual_path);
  if (!existsSync(actualAbs)) {
    problems.push(`${c.key}: actual not in the downloaded artifacts (${actualAbs}) — expired after 14 days, or a partial download?`);
    return null;
  }
  const buf = readFileSync(actualAbs);
  const gotSha = sha256(buf);
  if (gotSha !== c.actual_sha256) {
    problems.push(
      `${c.key}: TRANSPORT MISMATCH — downloaded sha256 ${gotSha.slice(0, 12)} != ` +
        `producer-recorded ${c.actual_sha256.slice(0, 12)}. The artifact pipeline corrupted this file.`,
    );
    return null;
  }
  try {
    assertDecodablePng(buf);
  } catch (e) {
    problems.push(`${c.key}: does not decode (${e.message}) — refusing to commit a poisoned baseline`);
    return null;
  }
  const dest = join(repoRoot, c.baseline_path);
  if (existsSync(dest) && sha256(readFileSync(dest)) === c.actual_sha256) {
    return 'identical';
  }
  if (!dryRun) {
    writeFileSync(dest, buf);
    // Re-read what landed: a partial write or a filesystem surprise must
    // surface HERE, not as the next CI run's mystery diff.
    const landed = readFileSync(dest);
    if (sha256(landed) !== c.actual_sha256) {
      problems.push(`${c.key}: post-copy verification failed — ${dest} does not hold the promoted bytes`);
      return null;
    }
    assertDecodablePng(landed);
  }
  return 'accepted';
}

// ---- provenance commit message ----------------------------------------------

export function buildCommitMessage({ accepted, identical, excludedUnsettled, runId, runAttempt, runUrl, headSha, cpuModels, actor }) {
  const lines = [];
  lines.push(`chore(vrt): ACCEPT ${accepted.length} baseline(s) from run ${runId} [no re-render]`);
  lines.push('');
  lines.push('Promoted the strict lane\'s own `actual` bytes verbatim — this is NOT a');
  lines.push('re-capture. Under --update-snapshots=all Playwright writes this exact');
  lines.push('buffer to both the baseline path and test-results/<scene>-actual.png');
  lines.push('(toMatchSnapshot.js writeFiles: one buffer, two destinations, no');
  lines.push('re-encode), so the failure artifact IS the capture output.');
  lines.push('');
  lines.push(`source run: ${runUrl} (attempt ${runAttempt ?? '?'}), dispatched by @${actor ?? 'unknown'}`);
  lines.push(`head_sha:   ${headSha}`);
  lines.push(`runner CPU: ${cpuModels.length ? cpuModels.join(' | ') : 'unrecorded'}`);
  lines.push('verified:   producer sha256 == downloaded bytes == committed bytes;');
  lines.push('            full IDAT decode (scripts/vrt-png-verify.mjs); no');
  lines.push('            -previous.png on any accepted scene (every render');
  lines.push('            settled); no cross-shard conflicts.');
  lines.push('');
  lines.push('accepted:');
  for (const c of accepted) {
    lines.push(`  ${c.baseline_path}  sha256 ${c.actual_sha256.slice(0, 12)}  shard ${c.shard}`);
  }
  if (identical.length > 0) {
    lines.push('already byte-identical (nothing to commit):');
    for (const c of identical) lines.push(`  ${c.baseline_path}`);
  }
  if (excludedUnsettled.length > 0) {
    lines.push('left RED — never settled, promotion refused (fix the motion):');
    for (const c of excludedUnsettled) lines.push(`  ${c.baseline_path}`);
  }
  return lines.join('\n') + '\n';
}

// ---- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    candidates: null,
    results: null,
    scenes: '',
    runId: null,
    head: null,
    actor: null,
    repoRoot: ROOT,
    messageOut: null,
    acceptedOut: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--candidates') args.candidates = argv[++i];
    else if (a === '--results') args.results = argv[++i];
    else if (a === '--scenes') args.scenes = argv[++i];
    else if (a === '--run-id') args.runId = argv[++i];
    else if (a === '--head') args.head = argv[++i];
    else if (a === '--actor') args.actor = argv[++i];
    else if (a === '--repo-root') args.repoRoot = argv[++i];
    else if (a === '--message-out') args.messageOut = argv[++i];
    else if (a === '--accepted-out') args.acceptedOut = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.candidates || !args.results || !args.runId) {
    throw new Error('usage: --candidates <dir> --results <dir> --run-id <id> [--scenes "…"] [--message-out f] [--accepted-out f] [--dry-run]');
  }
  return args;
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  const args = parseArgs(process.argv.slice(2));
  const problems = [];
  const { candidates } = loadManifests({ candidatesDir: resolve(args.candidates), runId: args.runId, problems });

  // Belt to the workflow's freshness-gate braces: the manifests were written
  // AT the render, so their head_sha is the render's truth independent of
  // what the Actions API says about the run.
  if (args.head) {
    for (const sha of new Set(candidates.map((c) => c.head_sha).filter(Boolean))) {
      if (sha !== args.head) {
        problems.push(`manifest head_sha ${sha} != checked-out tip ${args.head} — the branch moved; STALE run, refuse`);
      }
    }
  }

  const { selected, excludedUnsettled } = selectScenes({ candidates, scenesSpec: args.scenes, problems });

  const accepted = [];
  const identical = [];
  if (problems.length === 0) {
    for (const c of selected) {
      const verdict = verifyAndCopy({ c, resultsDir: resolve(args.results), repoRoot: args.repoRoot, problems, dryRun: args.dryRun });
      if (verdict === 'accepted') accepted.push(c);
      else if (verdict === 'identical') identical.push(c);
    }
  }

  if (problems.length > 0) {
    // The WHOLE accept fails — re-running costs ~90 s, a partial accept costs
    // an incoherent audit trail. Every problem is listed; none is a warning.
    console.error(`[vrt-accept] REFUSED — ${problems.length} problem(s), nothing was staged for commit:`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }

  const cpuModels = [...new Set(selected.map((c) => c.cpu_model).filter(Boolean))];
  const runUrl = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY ?? '<repo>'}/actions/runs/${args.runId}`;
  const message = buildCommitMessage({
    accepted,
    identical,
    excludedUnsettled,
    runId: args.runId,
    runAttempt: process.env.VRT_SOURCE_RUN_ATTEMPT ?? null,
    runUrl,
    headSha: args.head ?? candidates[0]?.head_sha ?? 'unknown',
    cpuModels,
    actor: args.actor,
  });
  if (args.messageOut) writeFileSync(args.messageOut, message);
  if (args.acceptedOut) writeFileSync(args.acceptedOut, accepted.map((c) => c.baseline_path).join('\n') + (accepted.length ? '\n' : ''));

  console.error(`[vrt-accept] ${args.dryRun ? 'DRY RUN — ' : ''}${accepted.length} accepted, ${identical.length} already byte-identical, ${excludedUnsettled.length} never-settled excluded`);
  for (const c of accepted) console.error(`  ✓ ${c.baseline_path}  ${c.actual_sha256.slice(0, 12)}  (shard ${c.shard})`);
  for (const c of identical) console.error(`  = ${c.baseline_path}  (already identical)`);
  for (const c of excludedUnsettled) console.error(`  ⚠ ${c.baseline_path}  NEVER SETTLED — left red for an underlying fix`);
  // stdout = the accepted count, for shell capture in the workflow.
  process.stdout.write(String(accepted.length));
}
