// scripts/verify-deploy-sha.test.ts
//
// Guards the deploy gate's decision logic (scripts/verify-deploy-sha.mjs) and,
// separately, that deploy.yml actually CALLS it.
//
// The second half matters as much as the first. The bug being fixed was not a
// wrong comparison — it was a comparison that was never made: `headSha` was
// fetched into the `--json` selection and then dropped by the `--jq`. A pure
// unit test of a function deploy.yml doesn't call would be decoration, so this
// asserts the wiring too, and asserts the old branch-latest shape cannot come
// back.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs with JSDoc types, no declaration file
import { decideDeploy, parseRun } from './verify-deploy-sha.mjs';

const REPO_ROOT = join(import.meta.dirname, '..');
const DEPLOY_YML = join(REPO_ROOT, '.github', 'workflows', 'deploy.yml');

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const green = (head = SHA) => ({ head_sha: head, status: 'completed', conclusion: 'success' });

describe('deploy is allowed only on the exact commit being deployed', () => {
  it('allows a completed, successful run whose head SHA is the deploy SHA', () => {
    const { allow } = decideDeploy({ sha: SHA, run: green() });
    expect(allow).toBe(true);
  });

  // THE REGRESSION. Green run, wrong commit — this is precisely the state the
  // old code accepted: deploy B on A's evidence.
  it("REFUSES a green run belonging to a DIFFERENT commit — the bug this closes", () => {
    const { allow, reason } = decideDeploy({ sha: SHA, run: green(OTHER) });
    expect(allow).toBe(false);
    expect(reason).toMatch(/another commit's evidence/);
  });

  it('refuses when no CI run exists for the commit', () => {
    const { allow, reason } = decideDeploy({ sha: SHA, run: null });
    expect(allow).toBe(false);
    expect(reason).toMatch(/never been tested/);
  });

  it('refuses a run that has not completed, rather than reading a partial result', () => {
    for (const status of ['queued', 'in_progress']) {
      const { allow, reason } = decideDeploy({
        sha: SHA,
        run: { head_sha: SHA, status, conclusion: null as unknown as string },
      });
      expect(allow, status).toBe(false);
      expect(reason, status).toMatch(/not completed/);
    }
  });

  it('refuses every non-success conclusion', () => {
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'neutral']) {
      const { allow } = decideDeploy({
        sha: SHA,
        run: { head_sha: SHA, status: 'completed', conclusion },
      });
      expect(allow, conclusion).toBe(false);
    }
  });

  it('refuses a missing or malformed deploy SHA', () => {
    for (const sha of ['', 'main', 'abc1234']) {
      expect(decideDeploy({ sha, run: green(sha) }).allow, JSON.stringify(sha)).toBe(false);
    }
  });

  it('is case-insensitive about SHA hex, since APIs differ', () => {
    expect(decideDeploy({ sha: SHA.toUpperCase(), run: green(SHA) }).allow).toBe(true);
  });
});

describe('parseRun fails closed', () => {
  it('reads the first run out of a workflow_runs payload', () => {
    expect(parseRun(JSON.stringify({ workflow_runs: [green()] }))?.head_sha).toBe(SHA);
  });

  it('treats empty, absent, and unparseable payloads as NO run', () => {
    // A malformed body must never read as evidence of green — the whole point.
    for (const body of ['', '   ', undefined, 'not json', '{"workflow_runs":[]}']) {
      expect(parseRun(body as string | undefined), JSON.stringify(body)).toBeNull();
    }
  });
});

describe('deploy.yml actually uses this gate', () => {
  const yml = readFileSync(DEPLOY_YML, 'utf8');

  it('calls the script from verify-ci', () => {
    expect(yml).toMatch(/node scripts\/verify-deploy-sha\.mjs decide/);
  });

  it('passes the dispatched commit, not a branch name', () => {
    expect(yml).toMatch(/DEPLOY_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/);
  });

  // Anchored to the ARTIFACT: if someone reintroduces "newest run on the
  // branch", this reddens even though the script above still passes its own
  // tests. That asymmetry is what let the original bug live.
  it('does not resolve CI by BRANCH-latest anywhere in the deploy path', () => {
    const offenders = yml
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /gh run list/.test(line) && /--branch/.test(line));
    expect(offenders, 'deploy verification must be keyed on head_sha, never branch-latest').toEqual(
      [],
    );
  });
});
