// scripts/vrt-revalidate-gate.mjs
//
// The decision logic behind `vrt-update.yml`'s `revalidate` job — the step that
// has to guarantee a bot-pushed baseline commit actually gets a CI run THAT RUNS.
//
// ── The deadlock this exists to break (#1694) ──────────────────────────────
//
// `vrt-update.yml`'s capture job pushes regenerated baselines with the default
// `GITHUB_TOKEN`. GitHub's recursion guard means that push fires no
// `pull_request: synchronize`, so **no ci.yml run is ever created for the bot's
// commit**. Ruleset 16042163 requires two contexts, and — exactly as in #1184 —
// a never-reported required check is PENDING FOREVER. The PR sits
// `mergeStateStatus: BLOCKED` with ZERO failures and nothing to point at.
//
// Live case: PR #1692, head `d2bbfd4c0` (author `vrt-baseline-bot`):
//
//     gh api ".../actions/runs?head_sha=d2bbfd4c0"  →  total_count: 0
//
// ── ⚠ THE MITIGATION THAT WAS ALREADY HERE IS NOT RELIABLE ─────────────────
//
// `revalidate` already close+reopened the PR to re-fire a `pull_request` event,
// and the workflow's header asserted that this works. It works MOST of the
// time, which is worse than not working: the job reported SUCCESS either way,
// because it never looked at whether the run it asked for exists.
//
// ── AND THEN THE SAME MISTAKE ONE NOTCH IN: A RUN THAT EXISTS BUT NEVER RAN ─
//
// #1815. The success condition was "a run EXISTS for this head SHA". A run
// held for manual approval satisfies that: GitHub reports it as
// `status: completed, conclusion: action_required` — a completed run with a
// conclusion — while it has executed NOTHING. Measured 2026-08-17 on PR #1809,
// head `ad27705cfc2bf342a2a4c5decef413cd6a69fb8d`:
//
//     .../workflows/ci.yml/runs?head_sha=ad27705c…&event=pull_request
//                                       → total_count: 1     ← the old question: YES
//     .../actions/runs/32072309818       → completed / action_required
//     .../commits/ad27705c…/check-runs   → total_count: 0     ← nothing reported
//
// The revalidate job's own log for that capture reads
// `[probe 1] head=ad27705cf runs=1 → satisfied` — green, over a PR with zero
// check runs. Every workflow the push triggered was parked the same way, not
// just CI (`CI`, `Deploy`, `Docs-only gate`, `VRT changeset gallery`).
//
// ⚠ AND IT WAS NEVER OTHERWISE. The two 2026-08-15 traces this module was built
// from — "PR #1677 → ci.yml run 14:06:54 ✓" and "PR #1689 → run 18:04:22 ✓" —
// were BOTH parked on attempt 1:
//
//     runs/31889032604/attempts/1 → completed / action_required  (c2c9c27eb)
//     runs/31900111642/attempts/1 → completed / action_required  (022c6cc23)
//
// They ran only because a human approved them (~25 min later, attempt 2/3,
// `triggering_actor: 2600hz-oscillator`). The "✓" measured RUN CREATION and was
// read as EXECUTION. Swept across this repo's whole history, EVERY
// `pull_request` ci.yml run whose actor is `github-actions[bot]` is parked on
// attempt 1 and executes only after a human acts — which is why this fires on
// every capture rather than occasionally. That ROOT CAUSE is #1816: the cure is
// `secrets.VRT_BASELINE_PUSH_TOKEN` (already wired in vrt-update.yml, absent
// today), which makes the push a real account's; everything below is the
// backstop for as long as it is missing.
//
// The class is the repo's own: a gate that reads ONE SIDE of a two-sided
// contract. "A run was created" and "a run reported checks" are different
// facts, and only the second one unblocks the PR.
//
// ── What this module does ──────────────────────────────────────────────────
//
// It makes the re-fire SELF-VERIFYING. After each close+reopen it polls the
// same oracle `docs-only-gate.yml` uses — but it asks the STRONGER question:
// "did GitHub start a ci.yml run for this head SHA **that executed, or will**?"
// A parked run is APPROVED through the REST endpoint and re-verified; a run in
// any other inert state fails the job with its actual state printed.
//
// It never posts a status, and it never marks anything green: the worst case is
// a RED vrt-update run naming the PR, the run URL, the state GitHub reported,
// and the one-line fix. Posting success here would green-light genuinely
// untested code — the thing `scripts/docs-only-gate.mjs` is most careful to
// avoid — and the required contexts still come only from a real
// `pull_request` CI run.
//
// ── ⚠ THE ORACLE FILTERS ON `event=pull_request`, AND THAT IS THE POINT ────
//
// `docs-only-gate.yml`'s guard G2 asks "does ANY ci.yml run exist for this
// SHA?" because there, presence means REFUSE THE BYPASS — over-counting is the
// safe direction. Here presence means DECLARE SUCCESS, so the safe direction is
// the opposite one and the query must be narrower: a `workflow_dispatch` ci.yml
// run does NOT count toward a PR's required-status gate (confirmed on #524), so
// counting one would let this module call a still-deadlocked PR verified.
// Only `pull_request`-event runs are counted.
//
// ⚠ G2 inherits the WEAK question this module just fixed: a PARKED ci.yml run
// makes `decideBypass` refuse a bypass that should apply. Out of scope here
// (posting statuses that a later approval could contradict is its own hazard) —
// filed as #1817 rather than fixed in passing. `classifyRun`/`groupRuns` are
// exported so whichever remedy is chosen imports the taxonomy instead of
// growing a second copy of it.

import { DOCS_PATTERNS, REQUIRED_CONTEXTS } from './docs-only-gate.mjs';

/** The one-line remedy for "no run was created at all" (#1694). Printed on failure. */
export const REMEDY =
  'push any non-bot commit on top of the baseline commit — e.g. the ' +
  '`git merge origin/main` the PR owes anyway — which creates a new head SHA ' +
  'and fires a normal pull_request CI run.';

/**
 * The remedy for "a run exists and is PARKED" (#1815). Different failure,
 * different fix — and the first line of it is the one that retires the class.
 *
 * ⚠ `gh run approve` IS NOT A SUBCOMMAND. `gh run` offers cancel/delete/
 * download/list/rerun/view/watch; `gh run approve` prints that usage list and
 * **exits 0**, so a shell step built on it looks like it succeeded and does
 * nothing. Measured 2026-08-17. Use the REST endpoint (`approvePath()` below).
 */
export const PARKED_REMEDY =
  'approve the parked run — `gh api -X POST ' +
  'repos/<owner/repo>/actions/runs/<run_id>/approve` (⚠ NOT `gh run approve`, ' +
  'which is not a subcommand: it prints usage and exits 0). The durable fix is ' +
  'to give vrt-update.yml a VRT_BASELINE_PUSH_TOKEN so the baseline push is ' +
  'authored by an account whose runs are not held for approval — every ' +
  'github-actions[bot]-triggered pull_request run in this repo is parked.';

/**
 * Defaults. `pollsPerAction × pollIntervalMs` is how long GitHub gets to
 * materialise (or un-park) a run before we assume the event was dropped; the
 * successful re-fires observed produced a run within 1–3 s of the reopen, and
 * an approval flips a parked run to `queued` immediately (measured on
 * runs/32059281770: `completed/action_required` → `queued` on the next read).
 * 6 × 5 s is ~10× the observed latency and still bounded at well under a minute
 * per attempt.
 *
 * `maxApprovals` is a BUDGET, not a count of anything: one round for the runs
 * found on arrival, one more for a run created by a subsequent re-fire. A third
 * would mean approvals are not taking, which is a failure to report — not a
 * thing to retry.
 */
export const DEFAULTS = {
  maxRefires: 3,
  maxApprovals: 2,
  pollsPerAction: 6,
  pollIntervalMs: 5_000,
};

// ---------------------------------------------------------------------------
// THE TAXONOMY IS THE FIX
//
// One question is asked of every run GitHub reports: DID IT EXECUTE, or will
// it? Everything else about a run is irrelevant here — a `failure` run is a
// perfectly good answer (the contexts reported; the PR shows red and a human
// can see it), and an `action_required` run is not (nothing reported; the PR
// shows nothing at all).
//
// Both tables are EXHAUSTIVE over the values GitHub documents, so `unknown` can
// only mean GitHub invented a new one — which is named in the failure rather
// than silently swallowed into either bucket. Deny-by-default: an unrecognised
// state is NOT a pass.
// ---------------------------------------------------------------------------

/** @typedef {'ran'|'parked'|'stuck'|'unknown'|'by-conclusion'} RunVerdict */

/** Every `status` GitHub documents for a workflow run, and what it means here. */
export const RUN_STATUS_VERDICTS = Object.freeze({
  queued: { verdict: 'ran', why: 'accepted — GitHub will execute it and its jobs report as check runs' },
  requested: { verdict: 'ran', why: 'accepted, waiting on a runner' },
  pending: { verdict: 'ran', why: 'accepted, waiting on a runner' },
  in_progress: { verdict: 'ran', why: 'executing right now — its jobs are already reporting as check runs' },
  completed: { verdict: 'by-conclusion', why: 'the conclusion decides whether it executed' },
  waiting: {
    verdict: 'stuck',
    why: 'paused on a DEPLOYMENT-ENVIRONMENT review — a different approval ' +
      '(POST …/actions/runs/{id}/pending_deployments), which this gate does not clear',
  },
  action_required: {
    verdict: 'parked',
    why: 'held for approval before any job starts — the pre-completion spelling of the #1815 state',
  },
});

/** Every `conclusion` GitHub documents, and what it means here. */
export const RUN_CONCLUSION_VERDICTS = Object.freeze({
  success: { verdict: 'ran', why: 'executed; the required contexts reported' },
  failure: { verdict: 'ran', why: 'executed and reported RED — visible, actionable, not this bug' },
  cancelled: {
    verdict: 'ran',
    why: 'executed far enough to create check runs (measured on runs/32075496452: 16 jobs, ' +
      '30 check runs on the commit) — the PR shows a cancelled check, not nothing',
  },
  timed_out: { verdict: 'ran', why: 'executed and reported' },
  neutral: { verdict: 'ran', why: 'executed and reported' },
  skipped: { verdict: 'ran', why: 'jobs reported as skipped — the contexts exist' },
  action_required: {
    verdict: 'parked',
    why: 'PARKED AWAITING APPROVAL (#1815) — a completed run with a conclusion that ' +
      'executed nothing. Measured: 0 check runs on the head commit',
  },
  stale: {
    verdict: 'stuck',
    why: 'GitHub abandoned the run before executing it — nothing reported, and approving ' +
      'is not the remedy (the event has to be re-fired)',
  },
  startup_failure: {
    verdict: 'stuck',
    why: 'the run never produced a single job (measured on runs/30158132475: jobs total_count 0), ' +
      'so no context can report — the workflow file itself is the fault',
  },
});

/**
 * Classify ONE run. Pure, so both directions of the negative control are unit
 * tests rather than a CI experiment.
 *
 * @param {{id?: unknown, status?: unknown, conclusion?: unknown, html_url?: unknown}} run
 * @returns {{verdict: 'ran'|'parked'|'stuck'|'unknown', label: string, why: string}}
 */
export function classifyRun(run) {
  const status = String(run?.status ?? '');
  const rawConclusion = run?.conclusion;
  const conclusion = rawConclusion === null || rawConclusion === undefined ? null : String(rawConclusion);
  const label = `status=${status || '<none>'} conclusion=${conclusion ?? '<none>'}`;

  const s = RUN_STATUS_VERDICTS[status];
  if (!s) {
    return {
      verdict: 'unknown',
      label,
      why: `GitHub reported a run status this gate does not know ('${status}'). Deny-by-default: ` +
        'an unrecognised state is not a pass — extend RUN_STATUS_VERDICTS with its meaning.',
    };
  }
  if (s.verdict !== 'by-conclusion') return { verdict: s.verdict, label, why: s.why };

  if (conclusion === null) {
    return {
      verdict: 'unknown',
      label,
      why: 'a completed run must carry a conclusion; this one carries none, so nothing can be concluded from it',
    };
  }
  const c = RUN_CONCLUSION_VERDICTS[conclusion];
  if (!c) {
    return {
      verdict: 'unknown',
      label,
      why: `GitHub reported a run conclusion this gate does not know ('${conclusion}'). ` +
        'Deny-by-default — extend RUN_CONCLUSION_VERDICTS with its meaning.',
    };
  }
  return { verdict: c.verdict, label, why: c.why };
}

/**
 * Bucket a list of runs by verdict. The buckets are what every decision below
 * reads; nothing reads a COUNT of runs.
 *
 * @param {Array<object>} runs
 */
export function groupRuns(runs) {
  const grouped = { ran: [], parked: [], stuck: [], unknown: [] };
  for (const run of runs ?? []) {
    const c = classifyRun(run);
    grouped[c.verdict].push({ ...run, ...c });
  }
  return grouped;
}

/** One line per run: id, what GitHub said, why that matters, and where to look. */
export function describeRuns(runs) {
  const list = runs ?? [];
  if (list.length === 0) return 'none';
  return list
    .map((r) => {
      const c = r.verdict ? r : { ...r, ...classifyRun(r) };
      const url = r.html_url ? ` ${r.html_url}` : '';
      return `run ${r.id ?? '<no id>'} [${c.verdict}] ${c.label} — ${c.why}${url}`;
    })
    .join('; ');
}

/**
 * The whole decision, as a pure step function.
 *
 * Rule order is load-bearing:
 *   1. a run that EXECUTED (or will)      → satisfied (the only success)
 *   2. a PARKED run not yet approved      → approve it (#1815) — never re-fire,
 *                                           which would only create another
 *                                           parked run
 *   3. approval failed, or its budget is  → fail, naming the state and the
 *      spent while runs are still parked    approval error verbatim
 *   4. approved and still parked, budget  → wait
 *      remains
 *   5. no run at all / only inert runs, and nothing re-fired yet → refire
 *   6. the current action still has poll budget → wait
 *   7. re-fires remain                    → refire again
 *   8. otherwise                          → fail
 *
 * @param {object} s
 * @param {Array<object>} s.runs      pull_request-event ci.yml runs on the PR's CURRENT head
 * @param {string[]} [s.approvedRunIds] ids this loop has already POSTed /approve for
 * @param {string|null} [s.approvalError] the verbatim error from a failed approval
 * @param {number} [s.approvalsDone]
 * @param {number} [s.maxApprovals]
 * @param {number} s.refiresDone
 * @param {number} s.maxRefires
 * @param {number} s.pollsSinceAction
 * @param {number} s.pollsPerAction
 * @returns {{action: 'satisfied'|'approve'|'refire'|'wait'|'fail', reason: string, runIds?: string[]}}
 */
export function nextAction({
  runs,
  approvedRunIds = [],
  approvalError = null,
  approvalsDone = 0,
  maxApprovals = DEFAULTS.maxApprovals,
  refiresDone,
  maxRefires,
  pollsSinceAction,
  pollsPerAction,
}) {
  const g = groupRuns(runs);

  if (g.ran.length > 0) {
    return {
      action: 'satisfied',
      reason:
        `a pull_request-event ci.yml run for the PR head EXECUTED or is executing, so the ` +
        `required contexts report — ${describeRuns(g.ran)}`,
    };
  }

  // ── PARKED (#1815) ────────────────────────────────────────────────────────
  // A parked run is the reason this rule sits above the re-fire ladder: a
  // close+reopen would create a SECOND run, parked for the same reason, and the
  // PR would still have zero check runs. Approval is the only thing that moves.
  if (g.parked.length > 0) {
    const pending = g.parked.filter((r) => !approvedRunIds.includes(String(r.id)));
    if (approvalError !== null) {
      return {
        action: 'fail',
        reason:
          `the PR head's ci.yml run is PARKED AWAITING APPROVAL and approving it FAILED: ` +
          `${approvalError}. ${describeRuns(g.parked)}. The PR has zero check runs and shows ` +
          `BLOCKED with no failures (#1815). Remedy: ${PARKED_REMEDY}`,
      };
    }
    if (pending.length > 0 && approvalsDone < maxApprovals) {
      return {
        action: 'approve',
        runIds: pending.map((r) => String(r.id)),
        reason: `ci.yml run(s) for the PR head are PARKED — approving via the REST endpoint: ${describeRuns(pending)}`,
      };
    }
    if (pollsSinceAction < pollsPerAction) {
      return {
        action: 'wait',
        reason:
          `approved, still parked — waiting for GitHub to start it ` +
          `(poll ${pollsSinceAction + 1}/${pollsPerAction})`,
      };
    }
    return {
      action: 'fail',
      reason:
        `the PR head's ci.yml run is PARKED AWAITING APPROVAL and did not start after ` +
        `${approvalsDone} approval attempt(s): ${describeRuns(g.parked)}. It EXISTS but has ` +
        `executed nothing, so the PR has zero check runs and shows BLOCKED with no failures ` +
        `(#1815). Remedy: ${PARKED_REMEDY}`,
    };
  }

  const inert = [...g.stuck, ...g.unknown];
  const inertNote = inert.length > 0 ? ` (present but INERT: ${describeRuns(inert)})` : '';

  // `maxRefires > 0` is not decoration: without it `maxRefires: 0` would still
  // close+reopen once, so the knob would not mean what it says and there would
  // be no way to exercise the failure path against a live PR without touching
  // it. A budget of zero must re-fire zero times.
  if (refiresDone === 0 && maxRefires > 0) {
    return {
      action: 'refire',
      reason: `no ci.yml run for the PR head that ran or will run${inertNote} — re-firing pull_request (close → reopen)`,
    };
  }
  if (pollsSinceAction < pollsPerAction) {
    return {
      action: 'wait',
      reason: `no run yet${inertNote} — waiting for GitHub (poll ${pollsSinceAction + 1}/${pollsPerAction} since re-fire ${refiresDone})`,
    };
  }
  if (refiresDone < maxRefires) {
    return {
      action: 'refire',
      reason: `re-fire ${refiresDone} produced no run that runs${inertNote} — retrying (${refiresDone + 1}/${maxRefires})`,
    };
  }
  return {
    action: 'fail',
    reason:
      `${maxRefires} close+reopen re-fires produced NO pull_request ci.yml run that executed for ` +
      `the PR head${inertNote}. GitHub did not deliver the event. The PR is DEADLOCKED (#1694): its ` +
      `required contexts will never report and it shows zero failures. Remedy: ${REMEDY}`,
  };
}

/**
 * Drive `nextAction` against injected I/O. Every side effect is a parameter, so
 * the whole loop — the failure path, the retry path and the approval path — is
 * exercised by unit tests with fakes instead of by a 75-minute capture.
 *
 * `probe()` must return `{ prNumber, headSha, runs }`, or `{ prNumber: null }`
 * when no open PR has this head branch.
 *
 * `approve(runIds)` must return `{ ok: true }` or `{ ok: false, error }` — it
 * may NOT throw its way past the verdict, and it may not be omitted: a parked
 * run that is silently skipped is the pre-fix behaviour with extra steps.
 *
 * @returns {Promise<{ok: boolean, verdict: string, reason: string, refires: number, approvals: number, polls: number, headSha: string|null, prNumber: number|null}>}
 */
export async function runVerification({
  probe,
  refire,
  approve = () => {
    throw new Error(
      'runVerification: an `approve` function is required — a parked run must be approved, never skipped',
    );
  },
  sleep,
  log = () => {},
  maxRefires = DEFAULTS.maxRefires,
  maxApprovals = DEFAULTS.maxApprovals,
  pollsPerAction = DEFAULTS.pollsPerAction,
  pollIntervalMs = DEFAULTS.pollIntervalMs,
}) {
  let refiresDone = 0;
  let approvalsDone = 0;
  let approvedRunIds = [];
  let approvalError = null;
  let pollsSinceAction = 0;
  let polls = 0;
  // Bounded by construction: every iteration either terminates or consumes one
  // unit of the (refire × poll) + approval budget, so this can never spin. The
  // worst case is `maxRefires` × (1 refire + `pollsPerAction` waits), plus one
  // iteration per approval round, plus the terminal decision; `maxRefires + 1`
  // covers the `maxRefires: 0` override, which must still reach a real `fail`
  // verdict rather than falling out of the loop.
  const hardCap = (maxRefires + 1) * (pollsPerAction + 1) + maxApprovals + 2;

  for (let i = 0; i < hardCap; i++) {
    const p = await probe();
    polls++;
    if (p.prNumber === null || p.prNumber === undefined) {
      // Not a failure: the baselines are pushed, and whoever opens a PR for this
      // branch later gets a normal `pull_request: opened` run. (Measured: four
      // of seven dispatches on 2026-08-15 took exactly this path.)
      return {
        ok: true,
        verdict: 'no-open-pr',
        reason:
          'no open PR has this head branch — nothing to re-validate; opening one ' +
          'later fires a normal pull_request CI run',
        refires: refiresDone,
        approvals: approvalsDone,
        polls,
        headSha: null,
        prNumber: null,
      };
    }

    const step = nextAction({
      runs: p.runs,
      approvedRunIds,
      approvalError,
      approvalsDone,
      maxApprovals,
      refiresDone,
      maxRefires,
      pollsSinceAction,
      pollsPerAction,
    });
    log(
      `[probe ${polls}] head=${String(p.headSha).slice(0, 9)} runs=[${describeRuns(p.runs)}] → ` +
        `${step.action}: ${step.reason}`,
    );

    if (step.action === 'satisfied') {
      return {
        ok: true,
        verdict: 'verified',
        reason: step.reason,
        refires: refiresDone,
        approvals: approvalsDone,
        polls,
        headSha: p.headSha,
        prNumber: p.prNumber,
      };
    }
    if (step.action === 'fail') {
      return {
        ok: false,
        verdict: approvalError !== null ? 'approval-failed' : groupRuns(p.runs).parked.length > 0 ? 'parked' : 'deadlocked',
        reason: step.reason,
        refires: refiresDone,
        approvals: approvalsDone,
        polls,
        headSha: p.headSha,
        prNumber: p.prNumber,
      };
    }
    if (step.action === 'approve') {
      const result = await approve(step.runIds ?? []);
      approvalsDone++;
      approvedRunIds = [...approvedRunIds, ...(step.runIds ?? [])];
      pollsSinceAction = 0;
      if (result && result.ok === false) {
        // LOUD, and it does not continue as if nothing happened: the next
        // iteration reads `approvalError` and fails with this text in it.
        approvalError = String(result.error ?? 'approval failed with no reason given');
        log(`[approve] FAILED: ${approvalError}`);
        continue;
      }
      await sleep(pollIntervalMs);
      continue;
    }
    if (step.action === 'refire') {
      await refire(p.prNumber);
      refiresDone++;
      pollsSinceAction = 0;
      await sleep(pollIntervalMs);
      continue;
    }
    // 'wait'
    pollsSinceAction++;
    await sleep(pollIntervalMs);
  }

  /* c8 ignore start — unreachable while the budget arithmetic above holds; kept
     so a future budget change cannot turn a bug into an infinite loop. */
  return {
    ok: false,
    verdict: 'budget-exhausted',
    reason:
      `the verification loop hit its hard cap of ${hardCap} iterations without a verdict — ` +
      `this is a bug in the budget arithmetic, not a GitHub failure. Remedy: ${REMEDY}`,
    refires: refiresDone,
    approvals: approvalsDone,
    polls,
    headSha: null,
    prNumber: null,
  };
  /* c8 ignore stop */
}

// ---------------------------------------------------------------------------
// "BLOCKED WITH NOTHING RED" HAS FOUR CAUSES AND THEY LOOK IDENTICAL
//
// From the PR page, #1184 / #1694 / #1783 / #1815 are the same picture: a
// required context that never reported. They need four different fixes, and
// #1694's fix (push a non-bot commit) accidentally clears #1815 too — which is
// exactly how #1815 got misfiled as #1694 twice.
//
// So the classification is written down ONCE, as a pure function over four
// observables, instead of being re-derived by whoever is looking today:
//
//   · the ci.yml pull_request runs on the head SHA, CLASSIFIED (not counted)
//   · whether the PR's changed files are docs-only by ci.yml's own path set
//   · which required contexts are posted as commit statuses
//   · whether docs-only-gate.yml ran for the SHA
// ---------------------------------------------------------------------------

/** The distinguishable causes, each with the issue that documents it. */
export const BLOCKED_CAUSES = Object.freeze({
  healthy: { issue: null, summary: 'a ci.yml run executed for this head — the contexts report' },
  'healthy-bypass': {
    issue: 1783,
    summary: 'docs-only change: ci.yml is path-skipped by design and docs-only-gate posted the contexts',
  },
  parked: { issue: 1815, summary: 'a ci.yml run was created and PARKED awaiting approval — it executed nothing' },
  'inert-run': {
    issue: 1815,
    summary: 'a ci.yml run exists in a state that executed nothing and cannot be approved (stale / startup_failure)',
  },
  'no-run': { issue: 1694, summary: 'NO ci.yml run was created for this head at all — the event was never delivered' },
  'path-skipped': {
    issue: 1184,
    summary: 'ci.yml is path-skipped for this docs-only change and no bypass ran — the contexts can never report',
  },
  'bypass-missing-status': {
    issue: 1783,
    summary: 'the docs-only bypass RAN but the required contexts are not posted — its status POST failed',
  },
  indeterminate: { issue: null, summary: 'not enough observables to tell the four causes apart' },
});

/**
 * Which of the four causes is this? Pure; the CLI below fetches the four
 * observables and hands them over.
 *
 * @param {object} o
 * @param {Array<object>} [o.runs]            ci.yml pull_request runs on the head SHA
 * @param {boolean|null} [o.docsOnly]         every changed file matches ci.yml's paths-ignore
 * @param {string[]} [o.postedContexts]       contexts present as commit statuses
 * @param {Array<object>} [o.bypassRuns]      docs-only-gate.yml runs on the head SHA
 * @returns {{cause: keyof typeof BLOCKED_CAUSES, issue: number|null, reason: string}}
 */
export function diagnoseBlocked({ runs = [], docsOnly = null, postedContexts = [], bypassRuns = [] }) {
  const say = (cause, reason) => ({ cause, issue: BLOCKED_CAUSES[cause].issue, reason });
  const g = groupRuns(runs);

  if (g.ran.length > 0) return say('healthy', `${describeRuns(g.ran)}`);
  if (g.parked.length > 0) return say('parked', `${describeRuns(g.parked)}. ${PARKED_REMEDY}`);
  const inert = [...g.stuck, ...g.unknown];
  if (inert.length > 0) return say('inert-run', `${describeRuns(inert)}. ${REMEDY}`);

  // No ci.yml run at all. The two remaining causes are told apart by whether
  // ci.yml was SUPPOSED to run — which is a property of the changed files, not
  // of the run list.
  if (docsOnly === null) {
    return say(
      'indeterminate',
      'no ci.yml run exists, and the changed-file list was not supplied — without it ' +
        '"path-skipped by design" (#1184/#1783) and "the event was dropped" (#1694) are indistinguishable',
    );
  }
  if (!docsOnly) {
    return say(
      'no-run',
      'the change is NOT docs-only, so ci.yml should have run and no run exists: the ' +
        `pull_request event was never delivered (bot-authored HEAD is the known cause). ${REMEDY}`,
    );
  }
  const missing = REQUIRED_CONTEXTS.filter((c) => !postedContexts.includes(c));
  if (bypassRuns.length === 0) {
    return say(
      'path-skipped',
      'docs-only change, ci.yml correctly path-skipped, and docs-only-gate.yml did not run for ' +
        `this SHA — the required contexts (${missing.join(', ')}) can never report. Check that ` +
        "docs-only-gate.yml's `paths:` is still the exact inverse of ci.yml's `paths-ignore:`.",
    );
  }
  if (missing.length === 0) {
    return say('healthy-bypass', 'docs-only change; the bypass posted every required context');
  }
  return say(
    'bypass-missing-status',
    `docs-only change and docs-only-gate.yml ran (${describeRuns(bypassRuns)}), but these required ` +
      `contexts are NOT posted on the commit: ${missing.join(', ')}. Its status POST is the fault.`,
  );
}

// ---------------------------------------------------------------------------
// CLI
//
//   node scripts/vrt-revalidate-gate.mjs verify
//       env: REPO, REF, [PUSHED_SHA], [MAX_REFIRES], [MAX_APPROVALS],
//            [POLLS_PER_ACTION], [POLL_INTERVAL_MS]
//       Exits 1 (and prints the remedy) when the PR is deadlocked or parked.
//
//   node scripts/vrt-revalidate-gate.mjs probe --repo R --sha S
//       Reads the oracle for one SHA and prints the CLASSIFIED runs. This is
//       the instrument-validation entry point: run it against a SHA known to be
//       deadlocked and one known to be healthy and confirm the verdict MOVES.
//
//   node scripts/vrt-revalidate-gate.mjs diagnose --repo R --sha S
//       The one command for "this PR is BLOCKED and nothing is red": fetches
//       the four observables and names which of #1184 / #1694 / #1783 / #1815
//       it is.
//
// All shell out to `gh`, which is on the runner and in the flox env.
// ---------------------------------------------------------------------------

/**
 * ⚠ `head_sha=` MATCHES THE FULL 40-CHAR SHA AND NOTHING ELSE. An abbreviated
 * SHA does not error — it returns `total_count: 0`, which this module would
 * read as "no run exists" and report as a deadlock. Measured while building
 * this: `?head_sha=022c6cc23` → 0, `?head_sha=022c6cc23ad64…a25` → 1, for a
 * commit that demonstrably has a pull_request CI run.
 *
 * That is the whole "a wrong metric reads exactly like a finding" hazard in one
 * API parameter, and it is why this throws rather than querying: a false
 * DEADLOCKED verdict would fail every capture and send people hunting a GitHub
 * outage that is not there.
 *
 * ⚠ It also means the `gh api ".../runs?head_sha=<short>"` one-liner people
 * reach for — including the one in #1694's own report — is NOT a valid
 * measurement. Always resolve the SHA first.
 */
export function assertFullSha(sha) {
  if (!/^[0-9a-f]{40}$/.test(String(sha))) {
    throw new Error(
      `head_sha must be a full 40-char SHA, got '${sha}'. GitHub's ` +
        `?head_sha= filter silently returns total_count: 0 for an abbreviated ` +
        `SHA, which this gate would misread as a deadlock.`,
    );
  }
  return sha;
}

/**
 * GitHub's maximum page size. NOT a count of anything: the decision reads the
 * runs themselves, and `parseRunsResponse` refuses a truncated page rather than
 * deciding from a partial view.
 */
export const RUNS_PAGE_SIZE = 100;

/** @internal exported for the test — the exact oracle query, in one place. */
export function ciRunsQuery(repo, sha) {
  assertFullSha(sha);
  return (
    `repos/${repo}/actions/workflows/ci.yml/runs` +
    `?head_sha=${sha}&event=pull_request&per_page=${RUNS_PAGE_SIZE}`
  );
}

/** @internal exported for the test — the ONE approval endpoint, in one place. */
export function approvePath(repo, runId) {
  return `repos/${repo}/actions/runs/${runId}/approve`;
}

/**
 * Read the oracle's response into the run list the decision consumes — and
 * REFUSE anything that would make the gate blind.
 *
 * `Number('')` is 0 and `undefined?.length` is a TypeError-in-waiting; both
 * read as "no run exists", which is the false-deadlock class the short-SHA
 * guard above exists for. A response this cannot make sense of THROWS.
 */
export function parseRunsResponse(raw) {
  const body = typeof raw === 'string' ? JSON.parse(raw || 'null') : raw;
  if (!body || typeof body !== 'object') {
    throw new Error(`ci.yml runs response was not an object: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  const total = Number(body.total_count);
  const runs = body.workflow_runs;
  if (!Number.isFinite(total) || !Array.isArray(runs)) {
    throw new Error(
      `ci.yml runs response is missing total_count/workflow_runs: ${JSON.stringify(body).slice(0, 200)}. ` +
        'Refusing to read that as a deadlock.',
    );
  }
  if (total > 0 && runs.length === 0) {
    throw new Error(
      `ci.yml runs response says total_count=${total} but returned an empty workflow_runs array — ` +
        'the instrument disagrees with itself; refusing to decide.',
    );
  }
  if (runs.length < total) {
    throw new Error(
      `ci.yml runs response is TRUNCATED (${runs.length} of ${total} on one page of ${RUNS_PAGE_SIZE}) — ` +
        'refusing to decide from a partial view.',
    );
  }
  return runs.map((r) => ({
    id: r.id,
    status: r.status,
    conclusion: r.conclusion,
    html_url: r.html_url,
  }));
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].endsWith('vrt-revalidate-gate.mjs');

if (isMain) {
  const { execFileSync } = await import('node:child_process');
  const gh = (args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();

  const cmd = process.argv[2];
  const argv = process.argv.slice(3);
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  // Resolve first — an abbreviated SHA is exactly what a human types, and
  // `?head_sha=` would answer 0 for it without complaining. `/commits/<ref>`
  // DOES accept the short form, so this is the one place the two behaviours
  // are reconciled instead of silently disagreeing.
  const resolveSha = (repo, given) => {
    const sha = /^[0-9a-f]{40}$/.test(given)
      ? given
      : gh(['api', `repos/${repo}/commits/${given}`, '--jq', '.sha']);
    if (sha !== given) console.log(`resolved ${given} → ${sha}`);
    return sha;
  };

  const readRuns = (repo, sha) => parseRunsResponse(gh(['api', ciRunsQuery(repo, sha)]));

  if (cmd === 'probe' || cmd === 'diagnose') {
    const repo = arg('repo') ?? process.env.REPO;
    const given = arg('sha');
    if (!repo || !given) {
      console.error(`usage: vrt-revalidate-gate.mjs ${cmd} --repo <owner/name> --sha <sha>`);
      process.exit(2);
    }
    const sha = resolveSha(repo, given);
    const runs = readRuns(repo, sha);
    const g = groupRuns(runs);
    console.log(`${sha}:`);
    console.log(`  ci.yml pull_request runs: ${describeRuns(runs)}`);

    if (cmd === 'probe') {
      console.log(
        g.ran.length > 0
          ? 'HEALTHY — a run executed (or is executing) for this SHA, so the required contexts report'
          : g.parked.length > 0
            ? `PARKED (#1815) — the run exists and executed NOTHING. ${PARKED_REMEDY}`
            : `DEADLOCKED — ${REMEDY}`,
      );
      process.exit(0);
    }

    // diagnose: the three further observables.
    const statuses = JSON.parse(gh(['api', `repos/${repo}/commits/${sha}/status`]));
    const postedContexts = (statuses.statuses ?? []).map((s) => s.context);
    const bypassRuns = parseRunsResponse(
      gh(['api', `repos/${repo}/actions/workflows/docs-only-gate.yml/runs?head_sha=${sha}&per_page=${RUNS_PAGE_SIZE}`]),
    );
    // The changed-file list, via the PR this commit belongs to. An APPROXIMATION
    // of docs-only-gate's own merge-base..head diff, and it is labelled as one:
    // it is used only to tell "ci.yml was path-skipped by design" from "the
    // event was dropped".
    let docsOnly = null;
    let files = [];
    try {
      const prs = JSON.parse(gh(['api', `repos/${repo}/commits/${sha}/pulls`]));
      if (prs.length > 0) {
        files = JSON.parse(gh(['api', `repos/${repo}/pulls/${prs[0].number}/files?per_page=${RUNS_PAGE_SIZE}`])).map(
          (f) => f.filename,
        );
        const { isDocsOnly } = await import('./docs-only-gate.mjs');
        docsOnly = isDocsOnly(files, DOCS_PATTERNS);
      }
    } catch (err) {
      console.log(`(could not read the PR's changed files: ${err})`);
    }

    const d = diagnoseBlocked({ runs, docsOnly, postedContexts, bypassRuns });
    console.log(`  docs-only change:         ${docsOnly === null ? 'unknown' : docsOnly}`);
    console.log(`  contexts posted:          ${postedContexts.join(', ') || 'none'}`);
    console.log(`  docs-only-gate runs:      ${describeRuns(bypassRuns)}`);
    console.log(`\nCAUSE: ${d.cause}${d.issue ? ` (#${d.issue})` : ''} — ${BLOCKED_CAUSES[d.cause].summary}`);
    console.log(`WHY:   ${d.reason}`);
    process.exit(0);
  }

  if (cmd === 'verify') {
    const repo = process.env.REPO;
    const ref = process.env.REF;
    const pushedSha = process.env.PUSHED_SHA ?? '';
    if (!repo || !ref) {
      console.error('verify: REPO and REF are required');
      process.exit(2);
    }
    const num = (name, fallback) => {
      const raw = process.env[name];
      const n = raw === undefined || raw === '' ? NaN : Number(raw);
      return Number.isFinite(n) ? n : fallback;
    };

    const probe = async () => {
      const prJson = gh([
        'pr', 'list', '--repo', repo, '--head', ref, '--state', 'open',
        '--json', 'number,headRefOid', '--limit', '1',
      ]);
      const prs = JSON.parse(prJson || '[]');
      if (prs.length === 0) return { prNumber: null };
      const headSha = prs[0].headRefOid;
      return { prNumber: prs[0].number, headSha, runs: readRuns(repo, headSha) };
    };

    const refire = async (prNumber) => {
      console.log(`Re-firing pull_request for PR #${prNumber} (close → reopen)…`);
      gh(['pr', 'close', String(prNumber), '--repo', repo]);
      gh(['pr', 'reopen', String(prNumber), '--repo', repo]);
    };

    // ⚠ REST, not `gh run approve` — that is not a subcommand and exits 0.
    // Measured working (admin PAT, and `actions: write` for GITHUB_TOKEN):
    // POST …/runs/32059281770/approve flipped completed/action_required →
    // queued. Approval does NOT cascade — the sibling Deploy/gallery runs on the
    // same SHA stayed parked — so every parked ci.yml run is approved by id.
    const approve = async (runIds) => {
      for (const id of runIds) {
        try {
          console.log(`Approving parked run ${id} (POST /${approvePath(repo, id)})…`);
          gh(['api', '-X', 'POST', approvePath(repo, id)]);
        } catch (err) {
          const detail = [err?.stderr, err?.stdout, err?.message]
            .map((v) => (v == null ? '' : String(v).trim()))
            .filter(Boolean)
            .join(' | ');
          return {
            ok: false,
            error:
              `POST /${approvePath(repo, id)} failed: ${detail}. The job's token needs ` +
              `\`actions: write\`; a fine-grained PAT needs Actions:write.`,
          };
        }
      }
      return { ok: true };
    };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    if (pushedSha) console.log(`baseline commit pushed: ${pushedSha}`);

    const result = await runVerification({
      probe,
      refire,
      approve,
      sleep,
      log: (m) => console.log(m),
      maxRefires: num('MAX_REFIRES', DEFAULTS.maxRefires),
      maxApprovals: num('MAX_APPROVALS', DEFAULTS.maxApprovals),
      pollsPerAction: num('POLLS_PER_ACTION', DEFAULTS.pollsPerAction),
      pollIntervalMs: num('POLL_INTERVAL_MS', DEFAULTS.pollIntervalMs),
    });

    console.log(
      `\nverdict: ${result.verdict} (re-fires=${result.refires}, approvals=${result.approvals}, probes=${result.polls})\n` +
        `reason:  ${result.reason}`,
    );

    if (result.ok) {
      console.log(`::notice::vrt-update revalidate: ${result.verdict} — ${result.reason}`);
      process.exit(0);
    }

    // The signal has to land where the human is looking. A COMMENT, never a
    // status: this path exists precisely because the code is unverified.
    if (result.prNumber !== null) {
      const parked = result.verdict === 'parked' || result.verdict === 'approval-failed';
      const body = parked
        ? `### ⚠ VRT baseline commit's CI run is PARKED, not run (#1815)\n\n` +
          `\`vrt-update.yml\` pushed \`${pushedSha || result.headSha}\` as \`vrt-baseline-bot\`. GitHub ` +
          `created a \`pull_request\` \`ci.yml\` run for head \`${String(result.headSha).slice(0, 9)}\` ` +
          `and HELD IT FOR APPROVAL, so it executed nothing.\n\n` +
          `**This PR shows \`BLOCKED\` with zero check runs and zero failures.**\n\n` +
          `\`\`\`\n${result.reason}\n\`\`\`\n\n` +
          `**Remedy:** ${PARKED_REMEDY}\n`
        : `### ⚠ VRT baseline commit did not get a CI run (#1694)\n\n` +
          `\`vrt-update.yml\` pushed \`${pushedSha || result.headSha}\` as \`vrt-baseline-bot\`, ` +
          `then re-fired \`pull_request\` ${result.refires}× by close+reopen. GitHub started ` +
          `no \`pull_request\` \`ci.yml\` run for head \`${String(result.headSha).slice(0, 9)}\`.\n\n` +
          `**This PR is deadlocked**: its required contexts will never report and it will show ` +
          `\`BLOCKED\` with zero failures.\n\n` +
          `**Remedy:** ${REMEDY}\n`;
      try {
        gh(['pr', 'comment', String(result.prNumber), '--repo', repo, '--body', body]);
        console.log(`posted a deadlock notice on PR #${result.prNumber}`);
      } catch (err) {
        console.log(`::warning::could not comment on PR #${result.prNumber}: ${err}`);
      }
    }
    console.log(`::error::vrt-update revalidate FAILED — ${result.reason}`);
    process.exit(1);
  }

  console.error(`unknown command '${cmd ?? ''}' — expected 'verify', 'probe' or 'diagnose'`);
  process.exit(2);
}
