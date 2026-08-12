// scripts/verify-deploy-sha.mjs
//
// The decision logic behind deploy.yml's `verify-ci` job: may we deploy THIS
// commit?
//
// ── The hole this closes ───────────────────────────────────────────────────
//
// `verify-ci` used to ask GitHub for the newest CI run on the BRANCH and test
// only its conclusion:
//
//     STATUS=$(gh run list --branch "$BRANCH" --workflow CI --limit 1 \
//                --json conclusion,headSha --jq '.[0].conclusion')
//     [[ "$STATUS" != "success" ]] && exit 1
//
// `headSha` was fetched and then thrown away. So the check answered "has this
// branch ever been green recently?" while presenting as "is this commit green?"
// Push commit B on top of green commit A, dispatch a deploy, and B ships on A's
// evidence — with the job reporting success. Nothing about the output
// distinguishes that from a real verification.
//
// The fix is to bind the evidence to the artifact: the run must be FOR the
// exact SHA being deployed. That is the same anchor rule the rest of the repo
// applies to exemption lists — a record that names something other than what
// you are shipping is not evidence about what you are shipping.
//
// ── Why the nightly does NOT need this ─────────────────────────────────────
//
// `daily-prod-deploy.yml` was audited alongside and is already correct — it
// resolves runs with `ci.yml/runs?head_sha=$sha`, requires EVERY job (including
// the informational ones) to be success/skipped, requires the umbrella job to
// be present, and checks out that exact SHA to build and to deploy the relay.
// It is the model this brings deploy.yml up to, not a second instance of the
// bug. Do not "fix" it.
//
// ── The contract ───────────────────────────────────────────────────────────
//
// Deploy is allowed iff a CI run exists whose head SHA is EXACTLY the commit
// being deployed, that run is COMPLETED, and its conclusion is `success`.
// Every other state refuses, and each refuses with its own reason so a red job
// says which of them happened — "no run yet" and "run failed" are different
// problems with different fixes, and a single "not green" message hides that.

import { appendFileSync } from 'node:fs';

/**
 * @typedef {Object} CiRun
 * @property {string} [head_sha]   head SHA of the run, as GitHub reports it
 * @property {string} [status]     'queued' | 'in_progress' | 'completed'
 * @property {string} [conclusion] 'success' | 'failure' | 'cancelled' | …
 */

/**
 * Decide whether `sha` may be deployed, given the CI run GitHub returned for it
 * (or `null` when there is none).
 *
 * @param {{ sha: string, run: CiRun | null }} input
 * @returns {{ allow: boolean, reason: string }}
 */
export function decideDeploy({ sha, run }) {
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) {
    return { allow: false, reason: `deploy SHA is missing or not a full 40-char SHA: '${sha ?? ''}'` };
  }
  if (!run) {
    return {
      allow: false,
      reason: `no CI run exists for ${short(sha)} — this commit has never been tested. Push it and let CI run before deploying.`,
    };
  }
  // Defence in depth: the caller queries by head_sha, so a mismatch here means
  // the query changed shape or the API answered about a different commit. Fail
  // closed rather than trusting the caller's filter — that misplaced trust is
  // exactly what the old code did.
  if (!run.head_sha || run.head_sha.toLowerCase() !== sha.toLowerCase()) {
    return {
      allow: false,
      reason: `CI run is for ${short(run.head_sha ?? '<none>')} but the deploy is of ${short(sha)} — refusing to accept another commit's evidence.`,
    };
  }
  if (run.status !== 'completed') {
    return {
      allow: false,
      reason: `CI run for ${short(sha)} is '${run.status ?? '<unknown>'}', not completed — wait for it rather than deploying on a partial result.`,
    };
  }
  if (run.conclusion !== 'success') {
    return {
      allow: false,
      reason: `CI run for ${short(sha)} concluded '${run.conclusion ?? '<none>'}' (must be 'success').`,
    };
  }
  return { allow: true, reason: `CI run for ${short(sha)} is green.` };
}

function short(sha) {
  return typeof sha === 'string' ? sha.slice(0, 9) : String(sha);
}

/**
 * Parse the API payload the workflow passes in. `gh api …/runs?head_sha=` returns
 * `{ workflow_runs: [...] }`; an empty list means no run, and anything
 * unparseable is treated as no run (fail closed — a malformed body must never
 * read as evidence of green).
 *
 * @param {string | undefined} json
 * @returns {CiRun | null}
 */
export function parseRun(json) {
  if (!json || !json.trim()) return null;
  try {
    const body = JSON.parse(json);
    const runs = Array.isArray(body) ? body : (body.workflow_runs ?? []);
    return runs.length > 0 ? runs[0] : null;
  } catch {
    return null;
  }
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].endsWith('verify-deploy-sha.mjs');

if (isMain && process.argv[2] === 'decide') {
  const sha = process.env.DEPLOY_SHA ?? '';
  const { allow, reason } = decideDeploy({ sha, run: parseRun(process.env.CI_RUN_JSON) });

  console.log(allow ? `✓ ${reason}` : `✗ ${reason}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `allow=${allow}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `reason=${reason.replace(/[\r\n]+/g, ' ')}\n`);
  }
  if (!allow) {
    console.log(`::error::Refusing to deploy: ${reason}`);
    process.exit(1);
  }
}
