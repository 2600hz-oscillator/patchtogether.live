// scripts/vrt-revalidate-gate.mjs
//
// The decision logic behind `vrt-update.yml`'s `revalidate` job — the step that
// has to guarantee a bot-pushed baseline commit actually gets a CI run.
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
// time, which is worse than not working: the job reports SUCCESS either way,
// because it never looked at whether the run it asked for exists.
//
// Every vrt-update dispatch on 2026-08-15 where an open PR existed, i.e. where
// the close+reopen actually ran (the other four found no open PR and exited
// early, so a human `opened` event created the run later):
//
//     PR #1677  closed 14:06:51.9 → reopened 14:06:53.1  → ci.yml run 14:06:54 ✓
//     PR #1689  closed 18:04:18   → reopened 18:04:19    → ci.yml run 18:04:22 ✓
//     PR #1692  closed 18:21:51.7 → reopened 18:21:53.3  → NO RUN AT ALL       ✗
//
// #1692's reopen produced no run of ANY workflow on that branch — not CI, not
// Deploy — so it is event delivery, not a path filter. Two of three. The gap
// between "it worked" and "it silently did nothing" was invisible from the
// workflow's own output, which is the repo's oldest lesson in a new costume: a
// safety step that is skipped looks exactly like a safety step that passed.
//
// ── What this module does instead ──────────────────────────────────────────
//
// It makes the re-fire SELF-VERIFYING. After each close+reopen it polls the
// same oracle `docs-only-gate.yml` uses — "did GitHub start a ci.yml run for
// this head SHA?" — and only reports success when the answer is yes. If the
// run never materialises it retries the re-fire, and when the retries are
// exhausted it FAILS the job with the remedy printed.
//
// It never posts a status, and it never marks anything green: the worst case is
// a RED vrt-update run naming the PR and the one-line fix. Posting success
// here would green-light genuinely untested code — the thing
// `scripts/docs-only-gate.mjs` is most careful to avoid — and the required
// contexts still come only from a real `pull_request` CI run.
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

/** The one-line remedy an operator can apply by hand. Printed on failure. */
export const REMEDY =
  'push any non-bot commit on top of the baseline commit — e.g. the ' +
  '`git merge origin/main` the PR owes anyway — which creates a new head SHA ' +
  'and fires a normal pull_request CI run.';

/**
 * Defaults. `pollsPerRefire × pollIntervalMs` is how long GitHub gets to
 * materialise a run before we assume the event was dropped; the two successful
 * re-fires above produced a run within 1–3 s of the reopen, so 6 × 5 s is ~10×
 * the observed latency and still bounded at well under a minute per attempt.
 */
export const DEFAULTS = {
  maxRefires: 3,
  pollsPerRefire: 6,
  pollIntervalMs: 5_000,
};

/**
 * The whole decision, as a pure step function so the negative controls are unit
 * tests rather than a CI experiment.
 *
 * Rule order is load-bearing:
 *   1. a run exists                       → satisfied (the only success)
 *   2. nothing re-fired yet               → refire immediately (don't burn the
 *                                           poll budget waiting for an event
 *                                           nobody has asked for)
 *   3. the current re-fire still has poll budget → wait
 *   4. re-fires remain                    → refire again
 *   5. otherwise                          → fail
 *
 * @param {object} s
 * @param {number} s.ciRunCount        pull_request-event ci.yml runs on the PR's CURRENT head
 * @param {number} s.refiresDone
 * @param {number} s.maxRefires
 * @param {number} s.pollsSinceRefire
 * @param {number} s.pollsPerRefire
 * @returns {{ action: 'satisfied'|'refire'|'wait'|'fail', reason: string }}
 */
export function nextAction({
  ciRunCount,
  refiresDone,
  maxRefires,
  pollsSinceRefire,
  pollsPerRefire,
}) {
  if (ciRunCount > 0) {
    return {
      action: 'satisfied',
      reason: `${ciRunCount} pull_request-event ci.yml run(s) exist for the PR head — the required contexts will report`,
    };
  }
  // `maxRefires > 0` is not decoration: without it `maxRefires: 0` would still
  // close+reopen once, so the knob would not mean what it says and there would
  // be no way to exercise the failure path against a live PR without touching
  // it. A budget of zero must re-fire zero times.
  if (refiresDone === 0 && maxRefires > 0) {
    return {
      action: 'refire',
      reason: 'no ci.yml run for the PR head — re-firing pull_request (close → reopen)',
    };
  }
  if (pollsSinceRefire < pollsPerRefire) {
    return {
      action: 'wait',
      reason: `no run yet — waiting for GitHub (poll ${pollsSinceRefire + 1}/${pollsPerRefire} since re-fire ${refiresDone})`,
    };
  }
  if (refiresDone < maxRefires) {
    return {
      action: 'refire',
      reason: `re-fire ${refiresDone} produced no run within the poll window — retrying (${refiresDone + 1}/${maxRefires})`,
    };
  }
  return {
    action: 'fail',
    reason:
      `${maxRefires} close+reopen re-fires produced NO pull_request ci.yml run for the PR head. ` +
      `GitHub did not deliver the event. The PR is DEADLOCKED (#1694): its required contexts ` +
      `will never report and it shows zero failures. Remedy: ${REMEDY}`,
  };
}

/**
 * Drive `nextAction` against injected I/O. Every side effect is a parameter, so
 * the whole loop — including the failure path and the retry path — is exercised
 * by unit tests with fakes instead of by a 75-minute capture.
 *
 * `probe()` must return `{ prNumber, headSha, ciRunCount }`, or `{ prNumber:
 * null }` when no open PR has this head branch.
 *
 * @returns {Promise<{ok: boolean, verdict: string, reason: string, refires: number, polls: number, headSha: string|null, prNumber: number|null}>}
 */
export async function runVerification({
  probe,
  refire,
  sleep,
  log = () => {},
  maxRefires = DEFAULTS.maxRefires,
  pollsPerRefire = DEFAULTS.pollsPerRefire,
  pollIntervalMs = DEFAULTS.pollIntervalMs,
}) {
  let refiresDone = 0;
  let pollsSinceRefire = 0;
  let polls = 0;
  // Bounded by construction: every iteration either terminates or consumes one
  // unit of the (refire × poll) budget, so this can never spin. The worst case
  // is `maxRefires` × (1 refire + `pollsPerRefire` waits) plus the terminal
  // decision; `maxRefires + 1` covers the `maxRefires: 0` override, which must
  // still reach a real `fail` verdict rather than falling out of the loop.
  const hardCap = (maxRefires + 1) * (pollsPerRefire + 1) + 2;

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
        polls,
        headSha: null,
        prNumber: null,
      };
    }

    const step = nextAction({
      ciRunCount: p.ciRunCount,
      refiresDone,
      maxRefires,
      pollsSinceRefire,
      pollsPerRefire,
    });
    log(`[probe ${polls}] head=${String(p.headSha).slice(0, 9)} runs=${p.ciRunCount} → ${step.action}: ${step.reason}`);

    if (step.action === 'satisfied') {
      return {
        ok: true,
        verdict: 'verified',
        reason: step.reason,
        refires: refiresDone,
        polls,
        headSha: p.headSha,
        prNumber: p.prNumber,
      };
    }
    if (step.action === 'fail') {
      return {
        ok: false,
        verdict: 'deadlocked',
        reason: step.reason,
        refires: refiresDone,
        polls,
        headSha: p.headSha,
        prNumber: p.prNumber,
      };
    }
    if (step.action === 'refire') {
      await refire(p.prNumber);
      refiresDone++;
      pollsSinceRefire = 0;
      await sleep(pollIntervalMs);
      continue;
    }
    // 'wait'
    pollsSinceRefire++;
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
    polls,
    headSha: null,
    prNumber: null,
  };
  /* c8 ignore stop */
}

// ---------------------------------------------------------------------------
// CLI
//
//   node scripts/vrt-revalidate-gate.mjs verify
//       env: REPO, REF, [PUSHED_SHA], [MAX_REFIRES], [POLLS_PER_REFIRE],
//            [POLL_INTERVAL_MS]
//       Exits 1 (and prints the remedy) when the PR is deadlocked.
//
//   node scripts/vrt-revalidate-gate.mjs probe --repo R --sha S
//       Reads the oracle for one SHA and prints the count. This is the
//       instrument-validation entry point: run it against a SHA known to be
//       deadlocked and one known to be healthy and confirm the number MOVES.
//
// Both shell out to `gh`, which is on the runner and in the flox env.
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

/** @internal exported for the test — the exact oracle query, in one place. */
export function ciRunsQuery(repo, sha) {
  assertFullSha(sha);
  return (
    `repos/${repo}/actions/workflows/ci.yml/runs` +
    `?head_sha=${sha}&event=pull_request&per_page=1`
  );
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].endsWith('vrt-revalidate-gate.mjs');

if (isMain) {
  const { execFileSync } = await import('node:child_process');
  const gh = (args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();

  const cmd = process.argv[2];

  if (cmd === 'probe') {
    const argv = process.argv.slice(3);
    const arg = (name) => {
      const i = argv.indexOf(`--${name}`);
      return i === -1 ? undefined : argv[i + 1];
    };
    const repo = arg('repo') ?? process.env.REPO;
    const given = arg('sha');
    if (!repo || !given) {
      console.error('usage: vrt-revalidate-gate.mjs probe --repo <owner/name> --sha <sha>');
      process.exit(2);
    }
    // Resolve first — an abbreviated SHA is exactly what a human types, and
    // `?head_sha=` would answer 0 for it without complaining. `/commits/<ref>`
    // DOES accept the short form, so this is the one place the two behaviours
    // are reconciled instead of silently disagreeing.
    const sha = /^[0-9a-f]{40}$/.test(given)
      ? given
      : gh(['api', `repos/${repo}/commits/${given}`, '--jq', '.sha']);
    if (sha !== given) console.log(`resolved ${given} → ${sha}`);
    const count = Number(gh(['api', ciRunsQuery(repo, sha), '--jq', '.total_count']));
    console.log(`${sha}: ${count} pull_request-event ci.yml run(s)`);
    console.log(count > 0 ? 'HEALTHY — the required contexts report for this SHA' : `DEADLOCKED — ${REMEDY}`);
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
      const raw = gh(['api', ciRunsQuery(repo, headSha), '--jq', '.total_count']);
      const ciRunCount = Number(raw);
      // A non-numeric answer must THROW, not coerce. `Number('')` is 0, which
      // reads as "no run exists" — the same false-deadlock class as the short
      // SHA above, and just as invisible in the output.
      if (!Number.isFinite(ciRunCount)) {
        throw new Error(
          `ci.yml run count for ${headSha} was not a number: '${raw}'. ` +
            'Refusing to read that as a deadlock.',
        );
      }
      return { prNumber: prs[0].number, headSha, ciRunCount };
    };

    const refire = async (prNumber) => {
      console.log(`Re-firing pull_request for PR #${prNumber} (close → reopen)…`);
      gh(['pr', 'close', String(prNumber), '--repo', repo]);
      gh(['pr', 'reopen', String(prNumber), '--repo', repo]);
    };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    if (pushedSha) console.log(`baseline commit pushed: ${pushedSha}`);

    const result = await runVerification({
      probe,
      refire,
      sleep,
      log: (m) => console.log(m),
      maxRefires: num('MAX_REFIRES', DEFAULTS.maxRefires),
      pollsPerRefire: num('POLLS_PER_REFIRE', DEFAULTS.pollsPerRefire),
      pollIntervalMs: num('POLL_INTERVAL_MS', DEFAULTS.pollIntervalMs),
    });

    console.log(
      `\nverdict: ${result.verdict} (re-fires=${result.refires}, probes=${result.polls})\n` +
        `reason:  ${result.reason}`,
    );

    if (result.ok) {
      console.log(`::notice::vrt-update revalidate: ${result.verdict} — ${result.reason}`);
      process.exit(0);
    }

    // The signal has to land where the human is looking. A COMMENT, never a
    // status: this path exists precisely because the code is unverified.
    if (result.prNumber !== null) {
      const body =
        `### ⚠ VRT baseline commit did not get a CI run (#1694)\n\n` +
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

  console.error(`unknown command '${cmd ?? ''}' — expected 'verify' or 'probe'`);
  process.exit(2);
}
