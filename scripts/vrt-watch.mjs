// scripts/vrt-watch.mjs
//
// WATCH A VRT CAPTURE, AND REPORT WHAT IT ACTUALLY COMMITTED (#1821).
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// `task vrt:commit` dispatched the capture and then left the caller on their
// own. The repo shipped no watcher, so EVERY agent hand-rolled one, and a
// hand-rolled loop gets whatever interval felt responsive while writing it.
//
// MEASURED, 2026-08-18: three successive hand-rolled watchers at a 45 s
// interval drained the shared `gh` core quota to 0/5000. An exhausted quota
// answers 403, and a watcher that does not distinguish 403 from "no failures"
// reports success on no data — so the cost was not merely a stall, it was that
// the next census could have been silently wrong.
//
//     one watcher @ 45 s        ~80 calls/hour
//     a full capture (~50 min)  ~70 calls
//     three concurrent          ~240 calls/hour of pure polling
//
// The quota is shared across every agent and the coordinator's own board
// queries, so "poll less in my agent" fixes one agent. This file is the fix:
// ONE watcher the repo provides — the way `e2e/_helpers/frames.ts` is the one
// home for frame waits — so nobody has a reason to write the next one.
//
// ── The cadence, and its cost, written down ────────────────────────────────
//
// A capture is EITHER ~3 min (scoped, the default since #1795) or 41-57 min
// (full sweep). One fixed interval cannot serve both: short is wasteful for the
// full case, long is unresponsive for the scoped one. So: fast while a scoped
// capture could still be running, then a floor.
//
//     first FAST_WINDOW_MS (4 min)   every FAST_INTERVAL_MS (30 s)   8 calls
//     thereafter                     every SLOW_INTERVAL_MS (5 min)
//     hard cap                       DEFAULT_CAP_MS (75 min)
//
// Resulting cost — the number to compare against the ~70 above:
//
//     scoped (~3 min)   ~6 calls
//     full (~50 min)    ~18 calls
//     worst case (cap)  ~22 calls
//
// ── Rate-limit awareness is the load-bearing part ─────────────────────────
//
// `GET /rate_limit` does NOT consume core quota (GitHub documents it as
// exempt), so the watcher can always afford to ask before it spends. Below
// LOW_WATER it abandons the fast interval; at zero it SLEEPS to the documented
// reset rather than spinning out 403s.
//
// ⚠ A 403, a transport error and an empty body are NOT run results. They are
// UNKNOWN, and unknown never ends the watch and never counts as a conclusion.
// That is the specific failure this whole file is a reaction to.
//
// ── What it reports: the COMMITTED FILES, not the conclusion ──────────────
//
// The highest-value half, and the one everyone forgets. `--update-snapshots`
// only rewrites a comparison that FAILED, so a baseline that is wrong but
// inside tolerance passes and the capture commits NOTHING. A green dispatch
// that committed zero files is therefore a RED FLAG, not a pass — and a watcher
// that printed only `completed / success` would report that as a win.
//
// So on completion it diffs the branch's baseline directory across the run and
// prints the files. ⚠ DERIVED FROM GIT, never a typed count: the answer is read
// off the artifact the bot actually pushed.

import { execFileSync } from 'node:child_process';

// ── the cadence constants (see the header for the resulting call counts) ────

/** How long a scoped capture could still be running. */
export const FAST_WINDOW_MS = 4 * 60_000;
/** Poll interval inside that window. */
export const FAST_INTERVAL_MS = 30_000;
/** Poll interval after it — the floor. */
export const SLOW_INTERVAL_MS = 5 * 60_000;
/** Hard wall-clock cap: a full sweep is 41-57 min, so this clears it with slack
 *  and still guarantees the watch ENDS. */
export const DEFAULT_CAP_MS = 75 * 60_000;
/** Core-quota remaining below which the fast interval is abandoned. */
export const LOW_WATER = 200;

/**
 * The delay before the NEXT poll.
 *
 * PURE. Backoff by ELAPSED TIME rather than attempt count, so a watch that
 * spent its first minutes asleep on an exhausted quota does not then burn the
 * fast budget it never used.
 */
export function nextDelayMs(elapsedMs, { lowQuota = false } = {}) {
  if (lowQuota) return SLOW_INTERVAL_MS;
  return elapsedMs < FAST_WINDOW_MS ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
}

/**
 * What to do about the current core quota.
 *
 * `wait` is milliseconds to sleep BEFORE polling at all — used only when the
 * quota is exhausted, where polling can produce nothing but 403s.
 */
export function rateLimitAction({ remaining, reset, nowMs }) {
  if (typeof remaining !== 'number' || Number.isNaN(remaining)) {
    // Could not read it ⇒ assume pressure. Never assume headroom.
    return { mode: 'unknown', wait: 0, lowQuota: true };
  }
  if (remaining <= 0) {
    const resetMs = typeof reset === 'number' && !Number.isNaN(reset) ? reset * 1000 : nowMs;
    return { mode: 'exhausted', wait: Math.max(0, resetMs - nowMs) + 30_000, lowQuota: true };
  }
  if (remaining < LOW_WATER) return { mode: 'low', wait: 0, lowQuota: true };
  return { mode: 'ok', wait: 0, lowQuota: false };
}

/**
 * Classify a `gh run view` result.
 *
 * ⚠ THE `unknown` BRANCH IS THE POINT. A failed call, a 403 and an empty body
 * all land there, and `done` is false for every one of them — so the watch
 * keeps going and never reports a conclusion it did not actually read.
 */
export function classifyRun(raw) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) return { done: false, status: 'unknown' };
  const t = raw.trim();
  if (t === 'poll-failed') return { done: false, status: 'unknown' };
  if (/^(HTTP\s+\d{3}|error|gh:)/i.test(t)) return { done: false, status: 'unknown' };
  const [status, conclusion = ''] = t.split(/\s+/);
  if (!status) return { done: false, status: 'unknown' };
  if (status !== 'completed') return { done: false, status };
  return { done: true, status, conclusion: conclusion || 'unknown' };
}

/** Baseline PNGs among a list of changed paths. */
export function baselineFiles(paths) {
  return paths.filter((p) => p.includes('__screenshots__') && p.endsWith('.png'));
}

/**
 * The completion report.
 *
 * ⚠ ZERO COMMITTED FILES IS RED, IN AS MANY WORDS, even when the run itself
 * concluded `success` — see the header. The count is `files.length`: DERIVED
 * from the diff, never typed.
 */
export function summarize({ conclusion, files, predicted }) {
  const n = files.length;
  const lines = [];
  lines.push(`vrt-update: ${conclusion}`);
  lines.push(`baseline files committed: ${n}`);
  for (const f of files) lines.push(`  ${f}`);
  let verdict;
  if (n === 0) {
    verdict = 'RED FLAG';
    lines.push('');
    lines.push('⚠ ZERO BASELINES COMMITTED — THIS IS A RED FLAG, NOT A PASS.');
    lines.push('  `--update-snapshots` only rewrites a comparison that FAILED, so a');
    lines.push('  baseline that is wrong but inside tolerance passes and commits nothing.');
    lines.push('  Either the capture never reached the scenes (a harness/boot failure');
    lines.push('  upstream of `toHaveScreenshot`), or the scope missed them, or the');
    lines.push('  change genuinely moved no pixels. Establish WHICH before believing it.');
  } else {
    verdict = 'committed';
    if (typeof predicted === 'number' && predicted !== n) {
      lines.push('');
      lines.push(`⚠ PREDICTED ${predicted}, COMMITTED ${n}. Reconcile before accepting:`);
      lines.push('  a file moved that you did not predict, or one you predicted did not.');
    }
  }
  return { verdict, count: n, lines };
}

// ── the IO shell ───────────────────────────────────────────────────────────

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();

function readRateLimit() {
  // ⚠ EXEMPT FROM CORE QUOTA, which is why this is safe to call every loop.
  try {
    const out = sh('gh', [
      'api',
      'rate_limit',
      '--jq',
      '(.resources.core.remaining|tostring) + " " + (.resources.core.reset|tostring)',
    ]);
    const [remaining, reset] = out.split(/\s+/).map(Number);
    return { remaining, reset };
  } catch {
    return { remaining: undefined, reset: undefined };
  }
}

function readRun(runId) {
  try {
    return sh('gh', [
      'run',
      'view',
      String(runId),
      '--json',
      'status,conclusion',
      '--jq',
      '.status + " " + (.conclusion // "")',
    ]);
  } catch {
    return 'poll-failed';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main(argv) {
  const arg = (k, d) => {
    const i = argv.indexOf(k);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  const runId = arg('--run');
  if (!runId) {
    console.error('usage: vrt-watch.mjs --run <id> [--branch <b>] [--predicted <n>] [--cap-min <m>]');
    process.exit(2);
  }
  const branch = arg('--branch', sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']));
  const predictedRaw = arg('--predicted');
  const predicted = predictedRaw ? Number(predictedRaw) : undefined;
  const capMs = Number(arg('--cap-min', String(DEFAULT_CAP_MS / 60_000))) * 60_000;

  // The BEFORE mark for the committed-file diff. Read off the REMOTE ref so a
  // dirty local tree cannot affect it.
  let before = '';
  try {
    sh('git', ['fetch', 'origin', branch]);
    before = sh('git', ['rev-parse', `origin/${branch}`]);
  } catch {
    console.error(`vrt-watch: could not read origin/${branch} — committed-file report will be skipped`);
  }

  const started = Date.now();
  let last = '';
  for (;;) {
    const elapsed = Date.now() - started;
    if (elapsed > capMs) {
      console.log(
        `vrt-update ${runId}: TIMED OUT after ${Math.round(elapsed / 60_000)} min ` +
          `(cap ${Math.round(capMs / 60_000)} min)`,
      );
      console.log('⚠ TIMED OUT IS NOT A RESULT. The run may still be going — re-check before concluding anything.');
      process.exit(1);
    }

    const rl = rateLimitAction({ ...readRateLimit(), nowMs: Date.now() });
    if (rl.mode === 'exhausted' && rl.wait > 0) {
      console.log(
        `vrt-update ${runId}: core quota exhausted — sleeping ${Math.round(rl.wait / 1000)}s to the documented reset`,
      );
      await sleep(rl.wait);
      continue;
    }

    const state = classifyRun(readRun(runId));
    const label = state.done ? `${state.status} / ${state.conclusion}` : state.status;
    if (label !== last) {
      console.log(`vrt-update ${runId}: ${label}`);
      last = label;
    }
    if (state.done) {
      let files = [];
      if (before) {
        try {
          sh('git', ['fetch', 'origin', branch]);
          const after = sh('git', ['rev-parse', `origin/${branch}`]);
          const changed =
            after === before
              ? []
              : sh('git', ['diff', '--name-only', `${before}..${after}`]).split('\n').filter(Boolean);
          files = baselineFiles(changed);
        } catch {
          console.error('vrt-watch: could not diff the branch — committed-file report skipped');
        }
      }
      const { verdict, lines } = summarize({ conclusion: state.conclusion, files, predicted });
      for (const l of lines) console.log(l);
      process.exit(verdict === 'RED FLAG' || state.conclusion !== 'success' ? 1 : 0);
    }
    await sleep(nextDelayMs(elapsed, { lowQuota: rl.lowQuota }));
  }
}

const isMain = typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('vrt-watch.mjs');
if (isMain) main(process.argv.slice(2));
