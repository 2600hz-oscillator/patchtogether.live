// scripts/vrt-revalidate-gate.test.ts
//
// Gate for the SELF-VERIFYING VRT re-fire (.github/workflows/vrt-update.yml's
// `revalidate` job + scripts/vrt-revalidate-gate.mjs). Pure-unit, zero-flake,
// runs in the `unit` lane via `task test` → `task test:scripts`.
//
// ── What went wrong, and what this file is therefore for ────────────────────
//
// #1694: a baseline commit pushed with GITHUB_TOKEN gets NO ci.yml run, so a PR
// whose HEAD is `vrt-baseline-bot`'s commit is BLOCKED forever with zero
// failures — #1184's deadlock reached by a different route. `revalidate`
// close+reopens the PR to re-fire a `pull_request` event, and that worked for
// #1677 and #1689 and did nothing at all for #1692. The step reported SUCCESS
// all three times, because it never checked.
//
// #1815: checking that a run EXISTS is still the wrong question. A run held for
// approval is reported as `status: completed, conclusion: action_required` — a
// completed run, carrying a conclusion, that has executed NOTHING — so it
// satisfied "exists" and the job went green over a PR with ZERO check runs.
// Measured 2026-08-17 on head `ad27705cfc2bf342a2a4c5decef413cd6a69fb8d`:
// ci.yml `?head_sha=…&event=pull_request` → total_count 1, check-runs on the
// commit → 0, `runs/32072309818` → completed / action_required.
//
// ⚠ AND THE TWO "✓" TRACES THIS FILE WAS ORIGINALLY BUILT FROM WERE THE SAME
// BUG. `runs/31889032604/attempts/1` (c2c9c27eb, PR #1677) and
// `runs/31900111642/attempts/1` (022c6cc23, PR #1689) were BOTH
// `completed/action_required`; they ran only because a human approved them ~25
// min later. So `HEALTHY_BOT_SHA` below is renamed and re-labelled: it was
// never "the re-fire landed", it was "a parked run that a human rescued".
//
// So the thing that must be true is not "we re-fired", and not "a run EXISTS" —
// it is "a run EXECUTED, or will". This file pins that at the decision
// function, with both pre-fix behaviours kept as permanent negative-control
// legs so a green suite can never be confused with a fixture that has no
// deadlock in it.
//
// ── ⚠ WHAT THIS GATE CANNOT SEE ────────────────────────────────────────────
//  · Whether GitHub delivers the `reopened` event. That is the failure being
//    handled, not one that can be unit-tested; what IS tested is that the loop
//    fails loudly instead of passing when the event is never delivered.
//  · Whether the runner's GITHUB_TOKEN is permitted to POST …/approve. The
//    endpoint is pinned here and the workflow's `actions: write` is asserted,
//    but only a live capture proves the token is accepted — which is why an
//    approval failure is a LOUD verdict carrying GitHub's own error text
//    rather than a silent continue.
//  · Whether ruleset 16042163 still requires the contexts ci.yml produces.
//    That lives in a GitHub ruleset, and nothing in the repo pins it any more:
//    docs-only-gate.test.ts used to hold the context STRINGS against ci.yml's
//    job names and it is deleted with the bypass (2026-08-23). The strings are
//    restated below purely so this file can assert the module NEVER names one.
//  · Whether `secrets.VRT_BASELINE_PUSH_TOKEN` exists or is valid. The token is
//    optional by construction and the fallback shape is asserted below, so its
//    absence cannot break the workflow — and its EXPIRY cannot go silent,
//    because the verification runs either way.
//  · The `capture` job's own `if:`/`needs:` wiring — that is
//    scripts/vrt-update-revalidate.test.ts, which simulates GitHub's skip
//    propagation over the same YAML.
//
// The blindness that CANNOT hide: every YAML/shell assertion below is anchored
// to text that must exist in the real artifact, and the non-vacuity test pins
// the job set. If the scan stops recognising the files, that test goes red
// rather than every other one passing over an empty string.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as gate from './vrt-revalidate-gate.mjs';

/**
 * The two status contexts branch ruleset 16042163 requires, matched LITERALLY
 * by GitHub (em-dash included). They used to live in `scripts/docs-only-gate.mjs`,
 * which posted them; that bypass is deleted, and the only remaining use is the
 * DENIAL below — this module must never name one, because the sole thing that
 * may satisfy the ruleset is a real `pull_request` CI run.
 */
const REQUIRED_CONTEXTS = [
  'typecheck + unit + ART + E2E',
  'vrt-strict (visual regression — strict subset)',
] as const;

type Verdictish = 'ran' | 'parked' | 'stuck' | 'unknown';
type Action = 'satisfied' | 'approve' | 'refire' | 'wait' | 'fail';
type Step = { action: Action; reason: string; runIds?: string[] };
type Run = { id: number | string; status: string; conclusion: string | null; html_url?: string };
type Probe = { prNumber: number | null; headSha?: string; runs?: Run[] };
type Verdict = {
  ok: boolean;
  verdict: string;
  reason: string;
  refires: number;
  approvals: number;
  polls: number;
  headSha: string | null;
  prNumber: number | null;
};
type Cause = 'healthy' | 'parked' | 'inert-run' | 'no-run';

const {
  REMEDY,
  PARKED_REMEDY,
  DEFAULTS,
  RUN_STATUS_VERDICTS,
  RUN_CONCLUSION_VERDICTS,
  BLOCKED_CAUSES,
  classifyRun,
  groupRuns,
  describeRuns,
  nextAction,
  runVerification,
  diagnoseBlocked,
  parseRunsResponse,
  ciRunsQuery,
  approvePath,
  assertFullSha,
  RUNS_PAGE_SIZE,
} = gate as unknown as {
  REMEDY: string;
  PARKED_REMEDY: string;
  DEFAULTS: {
    maxRefires: number;
    maxApprovals: number;
    pollsPerAction: number;
    pollIntervalMs: number;
  };
  RUN_STATUS_VERDICTS: Record<string, { verdict: string; why: string }>;
  RUN_CONCLUSION_VERDICTS: Record<string, { verdict: string; why: string }>;
  BLOCKED_CAUSES: Record<Cause, { issue: number | null; summary: string }>;
  classifyRun: (r: unknown) => { verdict: Verdictish; label: string; why: string };
  groupRuns: (runs: Run[]) => Record<Verdictish, Array<Run & { verdict: Verdictish; label: string; why: string }>>;
  describeRuns: (runs: Run[]) => string;
  nextAction: (s: {
    runs: Run[];
    approvedRunIds?: string[];
    approvalError?: string | null;
    approvalsDone?: number;
    maxApprovals?: number;
    refiresDone: number;
    maxRefires: number;
    pollsSinceAction: number;
    pollsPerAction: number;
  }) => Step;
  runVerification: (o: {
    probe: () => Promise<Probe>;
    refire: (pr: number) => Promise<void>;
    approve?: (ids: string[]) => Promise<{ ok: boolean; error?: string }>;
    sleep: (ms: number) => Promise<void>;
    log?: (m: string) => void;
    maxRefires?: number;
    maxApprovals?: number;
    pollsPerAction?: number;
    pollIntervalMs?: number;
  }) => Promise<Verdict>;
  diagnoseBlocked: (o: { runs?: Run[] }) => { cause: Cause; issue: number | null; reason: string };
  parseRunsResponse: (raw: string | object) => Run[];
  ciRunsQuery: (repo: string, sha: string) => string;
  approvePath: (repo: string, runId: string | number) => string;
  assertFullSha: (sha: string) => string;
  RUNS_PAGE_SIZE: number;
};

const WORKFLOW = readFileSync(
  fileURLToPath(new URL('../.github/workflows/vrt-update.yml', import.meta.url)),
  'utf8',
);
const COMMIT_SH = readFileSync(
  fileURLToPath(new URL('../.github/scripts/vrt-commit-baselines.sh', import.meta.url)),
  'utf8',
);
const MODULE_SRC = readFileSync(
  fileURLToPath(new URL('./vrt-revalidate-gate.mjs', import.meta.url)),
  'utf8',
);

// ─────────────────────────── the measured fixtures ──────────────────────────

/** PR #1692's baseline commit — the one with NO run at all (#1694). Full 40
 *  chars, and that is load-bearing; see the short-SHA control below. */
const DEADLOCKED_SHA = 'd2bbfd4c0874ecbbf910fffb19fe6dac2b3d7190';
/** PR #1689's baseline commit. ⚠ NOT "healthy": its run was PARKED on attempt 1
 *  (`runs/31900111642/attempts/1` → completed/action_required) and executed
 *  only after a human approved it. Kept because the short-SHA control needs a
 *  second real SHA, and because the mislabel is the point. */
const PARKED_BOT_SHA = '022c6cc23ad64028f5549359f2f65695541e3a25';

/** The #1815 run, verbatim from the API on 2026-08-17 (PR #1809, ad27705c…). */
const PARKED_RUN: Run = {
  id: 32072309818,
  status: 'completed',
  conclusion: 'action_required',
  html_url: 'https://github.com/2600hz-oscillator/patchtogether.live/actions/runs/32072309818',
};
/** The same run one field later — what approval turns it into (measured on
 *  runs/32059281770: POST …/approve → `queued`). */
const APPROVED_RUN: Run = { ...PARKED_RUN, status: 'queued', conclusion: null };
/** A run that actually executed. */
const RAN_RUN: Run = { id: 32061612281, status: 'completed', conclusion: 'success' };

/** Default step inputs — each test overrides only the field it is about. */
const base = {
  runs: [] as Run[],
  refiresDone: 0,
  maxRefires: DEFAULTS.maxRefires,
  pollsSinceAction: 0,
  pollsPerAction: DEFAULTS.pollsPerAction,
};

// ───────────────────────── a scriptable fake GitHub ─────────────────────────

/**
 * A fake whose run list changes the way the real API's does: runs appear after
 * a re-fire (event delivered) or never (#1692), and approving a parked run
 * flips it to `queued` (measured). Records every call so the tests can assert
 * on the interaction, not just the verdict.
 */
function fakeGitHub(opts: {
  prNumber?: number | null;
  /** Runs visible from the very first probe. */
  initialRuns?: Run[];
  /** Runs that materialise once this many re-fires have happened. */
  runsAfterRefire?: { after: number; runs: Run[] } | null;
  /** 'ok', or the error text POST …/approve fails with. */
  approve?: 'ok' | string;
  /** Head SHA per probe index; the last entry sticks. Models a human push. */
  heads?: string[];
}) {
  const calls = {
    probes: 0,
    refires: 0,
    sleeps: 0,
    closedReopened: [] as number[],
    approved: [] as string[],
  };
  const heads = opts.heads ?? ['d2bbfd4c0'];
  let runs: Run[] = [...(opts.initialRuns ?? [])];
  return {
    calls,
    probe: async (): Promise<Probe> => {
      calls.probes++;
      if (opts.prNumber === null) return { prNumber: null };
      const headSha = heads[Math.min(calls.probes - 1, heads.length - 1)];
      // A head that moved off the bot commit always has its own healthy run —
      // that is the manual remedy, observed working on #1692 (ca263abf0).
      if (headSha !== 'd2bbfd4c0') return { prNumber: opts.prNumber ?? 1692, headSha, runs: [RAN_RUN] };
      const appear = opts.runsAfterRefire;
      if (appear && calls.refires >= appear.after && runs.length === 0) runs = [...appear.runs];
      return { prNumber: opts.prNumber ?? 1692, headSha, runs: [...runs] };
    },
    refire: async (pr: number) => {
      calls.refires++;
      calls.closedReopened.push(pr);
    },
    approve: async (ids: string[]) => {
      calls.approved.push(...ids);
      if (opts.approve && opts.approve !== 'ok') return { ok: false, error: opts.approve };
      runs = runs.map((r) => (ids.includes(String(r.id)) ? { ...r, status: 'queued', conclusion: null } : r));
      return { ok: true };
    },
    sleep: async () => {
      calls.sleeps++;
    },
  };
}

/**
 * PRE-FIX BEHAVIOUR #1 (before #1694): close, reopen, declare victory. Kept so
 * the "no run at all" fixture can be shown to be one the OLD code calls green.
 */
async function legacyRefireOnly(gh: ReturnType<typeof fakeGitHub>): Promise<Verdict> {
  const p = await gh.probe();
  if (p.prNumber === null) {
    return { ok: true, verdict: 'no-open-pr', reason: '', refires: 0, approvals: 0, polls: 1, headSha: null, prNumber: null };
  }
  await gh.refire(p.prNumber);
  return {
    ok: true,
    verdict: 'reopened',
    reason: 'Reopened the PR — its pull_request CI run now validates the fresh baselines.',
    refires: 1,
    approvals: 0,
    polls: 1,
    headSha: p.headSha ?? null,
    prNumber: p.prNumber,
  };
}

/**
 * PRE-FIX BEHAVIOUR #2 (before #1815): "a run exists" — literally
 * `total_count > 0`. This is the entire defect, in one line, and it is kept as
 * a permanent leg: the parked fixture MUST satisfy it, or the fixture is not
 * modelling #1815 and every green below means nothing.
 */
function legacyExistsOnly(runs: Run[]): boolean {
  return runs.length > 0;
}

// ─────────────────────────────── the taxonomy ───────────────────────────────

describe('classifyRun: EXECUTED, or did not — nothing else is asked of a run', () => {
  it('the #1815 run — completed WITH a conclusion, and it ran nothing', () => {
    const c = classifyRun(PARKED_RUN);
    expect(c.verdict).toBe('parked');
    // The message has to name the state, because "no run found" and "a run that
    // never ran" were reported identically and that is what got this misfiled
    // as #1694 twice.
    expect(c.label).toContain('conclusion=action_required');
    expect(c.why).toMatch(/approval/i);
  });

  it('⚠ NEGATIVE CONTROL, BOTH DIRECTIONS: one field decides it, and it moves', () => {
    // Same run object, same id, same everything — only the conclusion differs.
    // If the classifier were reading anything else (existence, id, url) these
    // two would agree, and the gate would be back where it started.
    expect(classifyRun(PARKED_RUN).verdict).toBe('parked');
    expect(classifyRun({ ...PARKED_RUN, conclusion: 'success' }).verdict).toBe('ran');
    expect(classifyRun({ ...PARKED_RUN, status: 'queued', conclusion: null }).verdict).toBe('ran');
  });

  it('a FAILING run is a passing answer — it reported, and the PR shows red', () => {
    // The distinction this whole module is about: red is visible and
    // actionable; parked is invisible. Only the second one is the bug.
    expect(classifyRun({ id: 1, status: 'completed', conclusion: 'failure' }).verdict).toBe('ran');
    expect(classifyRun({ id: 1, status: 'completed', conclusion: 'cancelled' }).verdict).toBe('ran');
  });

  it('rejects the OTHER states that execute nothing — enumerated, not guessed', () => {
    // `stale`: GitHub abandoned the run before executing it.
    expect(classifyRun({ id: 1, status: 'completed', conclusion: 'stale' }).verdict).toBe('stuck');
    // `startup_failure`: measured in this repo (runs/30158132475) to have jobs
    // total_count 0, so no context can ever report from it.
    expect(classifyRun({ id: 1, status: 'completed', conclusion: 'startup_failure' }).verdict).toBe('stuck');
    // `waiting`: parked on a deployment-environment review — a DIFFERENT
    // approval endpoint, so it must not be mistaken for the approvable kind.
    expect(classifyRun({ id: 1, status: 'waiting', conclusion: null }).verdict).toBe('stuck');
    // the pre-completion spelling of #1815
    expect(classifyRun({ id: 1, status: 'action_required', conclusion: null }).verdict).toBe('parked');
  });

  it('DENY BY DEFAULT: a state GitHub invents later is NOT a pass', () => {
    expect(classifyRun({ id: 1, status: 'completed', conclusion: 'quantum_tunnelled' }).verdict).toBe('unknown');
    expect(classifyRun({ id: 1, status: 'levitating', conclusion: null }).verdict).toBe('unknown');
    // A completed run must carry a conclusion; one that does not tells us
    // nothing, and "nothing" is not "fine".
    expect(classifyRun({ id: 1, status: 'completed', conclusion: null }).verdict).toBe('unknown');
    expect(classifyRun({}).verdict).toBe('unknown');
  });

  it('the tables are EXHAUSTIVE and every entry resolves to a real verdict', () => {
    // Anchored to the artifact: every key in either table must classify to one
    // of the four verdicts (no `by-conclusion` leaking out of classifyRun), and
    // every entry must carry a `why` — the why is what the failure prints.
    const offenders: string[] = [];
    for (const [status, entry] of Object.entries(RUN_STATUS_VERDICTS)) {
      if (!entry.why || entry.why.length < 20) offenders.push(`status ${status}: thin why`);
      const v = classifyRun({ id: 1, status, conclusion: status === 'completed' ? 'success' : null }).verdict;
      if (!['ran', 'parked', 'stuck', 'unknown'].includes(v)) offenders.push(`status ${status} → ${v}`);
    }
    for (const [conclusion, entry] of Object.entries(RUN_CONCLUSION_VERDICTS)) {
      if (!entry.why || entry.why.length < 20) offenders.push(`conclusion ${conclusion}: thin why`);
      const v = classifyRun({ id: 1, status: 'completed', conclusion }).verdict;
      if (!['ran', 'parked', 'stuck'].includes(v)) offenders.push(`conclusion ${conclusion} → ${v}`);
    }
    expect(offenders).toEqual([]);
    // …and the sweep is not vacuous: it really did read both tables.
    expect(Object.keys(RUN_STATUS_VERDICTS)).toContain('action_required');
    expect(Object.keys(RUN_CONCLUSION_VERDICTS)).toContain('action_required');
  });

  it('groupRuns buckets a mixed list, and describeRuns prints where to look', () => {
    const g = groupRuns([PARKED_RUN, RAN_RUN, { id: 3, status: 'completed', conclusion: 'stale' }]);
    expect(g.ran.map((r) => r.id)).toEqual([RAN_RUN.id]);
    expect(g.parked.map((r) => r.id)).toEqual([PARKED_RUN.id]);
    expect(g.stuck.map((r) => r.id)).toEqual([3]);
    const text = describeRuns([PARKED_RUN]);
    expect(text).toContain(String(PARKED_RUN.id));
    expect(text).toContain('action_required');
    expect(text, 'the run URL is how a human acts on this').toContain(PARKED_RUN.html_url!);
    expect(describeRuns([])).toBe('none');
  });
});

// ─────────────────────────────── the decision ───────────────────────────────

describe('nextAction: "done" means a run RAN, not that a run exists', () => {
  it('a run that executed is the ONLY success — and it wins from any state', () => {
    for (const refiresDone of [0, 1, DEFAULTS.maxRefires]) {
      for (const pollsSinceAction of [0, DEFAULTS.pollsPerAction]) {
        expect(
          nextAction({ ...base, runs: [RAN_RUN], refiresDone, pollsSinceAction }).action,
          `a ci.yml run executed, so the deadlock is broken regardless of how we got here ` +
            `(refires=${refiresDone}, polls=${pollsSinceAction})`,
        ).toBe('satisfied');
      }
    }
  });

  it('⚠ THE FIX: a PARKED run is NOT satisfied — it is APPROVED, by id', () => {
    const s = nextAction({ ...base, runs: [PARKED_RUN] });
    expect(s.action).toBe('approve');
    expect(s.runIds).toEqual([String(PARKED_RUN.id)]);
    expect(s.reason).toContain(String(PARKED_RUN.id));
  });

  it('⚠ NEGATIVE CONTROL: the PRE-FIX condition calls that exact run GREEN', () => {
    // "a run exists" — the whole of #1815 in one expression. The permanent leg:
    // if this ever stops being true, PARKED_RUN has stopped modelling the bug.
    expect(legacyExistsOnly([PARKED_RUN])).toBe(true);
    expect(nextAction({ ...base, runs: [PARKED_RUN] }).action).not.toBe('satisfied');
    // …and the other direction, so this proves a discrimination and not just a
    // refusal: the same shape that DID run is satisfied.
    expect(legacyExistsOnly([RAN_RUN])).toBe(true);
    expect(nextAction({ ...base, runs: [RAN_RUN] }).action).toBe('satisfied');
  });

  it('NEVER close+reopens a PR whose run is parked — that just parks another one', () => {
    // The re-fire is the remedy for "no event was delivered". Applying it to a
    // parked run churns the PR and produces a second run parked for the same
    // reason, which is why this rule sits ABOVE the re-fire ladder.
    const offenders: string[] = [];
    for (let refiresDone = 0; refiresDone <= DEFAULTS.maxRefires + 1; refiresDone++) {
      for (let pollsSinceAction = 0; pollsSinceAction <= DEFAULTS.pollsPerAction + 1; pollsSinceAction++) {
        for (const approvedRunIds of [[], [String(PARKED_RUN.id)]]) {
          const s = nextAction({ ...base, runs: [PARKED_RUN], approvedRunIds, refiresDone, pollsSinceAction });
          if (s.action === 'refire') offenders.push(`refires=${refiresDone} polls=${pollsSinceAction} approved=${approvedRunIds.length}`);
          if (s.action === 'satisfied') offenders.push(`SATISFIED at refires=${refiresDone} polls=${pollsSinceAction}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('once approved it WAITS for the poll budget, then FAILS naming the state', () => {
    const approvedRunIds = [String(PARKED_RUN.id)];
    expect(nextAction({ ...base, runs: [PARKED_RUN], approvedRunIds, approvalsDone: 1 }).action).toBe('wait');
    const s = nextAction({
      ...base,
      runs: [PARKED_RUN],
      approvedRunIds,
      approvalsDone: 1,
      pollsSinceAction: DEFAULTS.pollsPerAction,
    });
    expect(s.action).toBe('fail');
    expect(s.reason).toContain('#1815');
    expect(s.reason).toContain('action_required');
    expect(s.reason, 'the run URL, so the human can act in one click').toContain(PARKED_RUN.html_url!);
    expect(s.reason).toContain(PARKED_REMEDY);
  });

  it('an approval that FAILED fails the job immediately, with GitHub’s own words', () => {
    const s = nextAction({
      ...base,
      runs: [PARKED_RUN],
      approvedRunIds: [String(PARKED_RUN.id)],
      approvalsDone: 1,
      approvalError: 'HTTP 403: Resource not accessible by integration',
    });
    expect(s.action).toBe('fail');
    // Never a silent continue, and never a paraphrase: the reason a permission
    // failed is the whole diagnostic.
    expect(s.reason).toContain('Resource not accessible by integration');
    expect(s.reason).toContain(PARKED_REMEDY);
  });

  it('with no run and nothing re-fired yet, it re-fires immediately', () => {
    expect(nextAction(base).action).toBe('refire');
  });

  it('after a re-fire it WAITS for the poll budget, then re-fires again', () => {
    expect(nextAction({ ...base, refiresDone: 1, pollsSinceAction: 0 }).action).toBe('wait');
    expect(
      nextAction({ ...base, refiresDone: 1, pollsSinceAction: DEFAULTS.pollsPerAction - 1 }).action,
    ).toBe('wait');
    expect(
      nextAction({ ...base, refiresDone: 1, pollsSinceAction: DEFAULTS.pollsPerAction }).action,
    ).toBe('refire');
  });

  it('an INERT-but-unapprovable run is treated as no run — and is NAMED', () => {
    // `stale` / `startup_failure` are not approvable, so the re-fire ladder is
    // the right remedy; what must not happen is that they read as success, or
    // that the failure says "no run found" when a run is sitting right there.
    const stale = { id: 7, status: 'completed', conclusion: 'stale' };
    expect(nextAction({ ...base, runs: [stale] }).action).toBe('refire');
    const s = nextAction({
      ...base,
      runs: [stale],
      refiresDone: DEFAULTS.maxRefires,
      pollsSinceAction: DEFAULTS.pollsPerAction,
    });
    expect(s.action).toBe('fail');
    expect(s.reason).toContain('INERT');
    expect(s.reason).toContain('stale');
  });

  it('a budget of ZERO re-fires never touches the PR — it just fails', () => {
    // The knob has to mean what it says, and not only for tidiness: this is the
    // ONLY configuration in which the failure path can be exercised against a
    // live PR without closing it.
    const s = nextAction({ ...base, maxRefires: 0 });
    expect(s.action).not.toBe('refire');
    expect(
      nextAction({ ...base, maxRefires: 0, pollsSinceAction: DEFAULTS.pollsPerAction }).action,
    ).toBe('fail');
  });

  it('FAILS — never "satisfied" — once the re-fire budget is spent with no run', () => {
    const step = nextAction({
      ...base,
      refiresDone: DEFAULTS.maxRefires,
      pollsSinceAction: DEFAULTS.pollsPerAction,
    });
    expect(step.action).toBe('fail');
    // The message has to be actionable by whoever finds the red run, so pin the
    // two things they need: what happened, and the one command that fixes it.
    expect(step.reason).toContain('#1694');
    expect(step.reason).toContain(REMEDY);
  });

  it('NEGATIVE CONTROL: no reachable state returns "satisfied" without a run that RAN', () => {
    // The whole safety property in one assertion, swept over the entire state
    // space and over every run shape that does NOT mean "it executed".
    const notRan: Run[][] = [
      [],
      [PARKED_RUN],
      [{ id: 2, status: 'completed', conclusion: 'stale' }],
      [{ id: 3, status: 'completed', conclusion: 'startup_failure' }],
      [{ id: 4, status: 'waiting', conclusion: null }],
      [{ id: 5, status: 'completed', conclusion: 'nonsense_from_the_future' }],
      [PARKED_RUN, { id: 6, status: 'completed', conclusion: 'stale' }],
    ];
    const offenders: string[] = [];
    for (const runs of notRan) {
      for (let refiresDone = 0; refiresDone <= DEFAULTS.maxRefires + 1; refiresDone++) {
        for (let pollsSinceAction = 0; pollsSinceAction <= DEFAULTS.pollsPerAction + 1; pollsSinceAction++) {
          for (const approvalError of [null, 'HTTP 403']) {
            const s = nextAction({
              ...base,
              runs,
              approvedRunIds: [String(PARKED_RUN.id)],
              approvalsDone: 1,
              approvalError,
              refiresDone,
              pollsSinceAction,
            });
            if (s.action === 'satisfied') {
              offenders.push(`${JSON.stringify(runs)} refires=${refiresDone} polls=${pollsSinceAction}`);
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);
    // …and the control is not vacuous: add ONE run that ran to each of those
    // same lists and the SAME sweep is satisfied everywhere.
    const withRun: string[] = [];
    for (const runs of notRan) {
      for (let refiresDone = 0; refiresDone <= DEFAULTS.maxRefires + 1; refiresDone++) {
        const s = nextAction({ ...base, runs: [...runs, RAN_RUN], refiresDone });
        if (s.action !== 'satisfied') withRun.push(`${JSON.stringify(runs)} refires=${refiresDone} → ${s.action}`);
      }
    }
    expect(withRun).toEqual([]);
  });
});

// ──────────────────────────────── the driver ────────────────────────────────

describe('runVerification: the traces measured on 2026-08-15 and 2026-08-17', () => {
  it('#1815 — the push produced a PARKED run → approve it, verify, no PR churn', async () => {
    const gh = fakeGitHub({ prNumber: 1809, initialRuns: [PARKED_RUN], approve: 'ok' });
    const r = await runVerification({ ...gh, pollIntervalMs: 0 });

    expect(r.ok).toBe(true);
    expect(r.verdict).toBe('verified');
    expect(gh.calls.approved, 'the parked run is approved BY ID').toEqual([String(PARKED_RUN.id)]);
    expect(gh.calls.refires, 'a parked run must NOT be close+reopened').toBe(0);
    expect(r.approvals).toBe(1);
  });

  it('#1815 — when approval is REFUSED the job fails LOUDLY, carrying the reason', async () => {
    const gh = fakeGitHub({
      prNumber: 1809,
      initialRuns: [PARKED_RUN],
      approve: 'HTTP 403: Resource not accessible by integration',
    });
    const r = await runVerification({ ...gh, pollIntervalMs: 0 });

    expect(r.ok).toBe(false);
    expect(r.verdict).toBe('approval-failed');
    expect(r.reason).toContain('Resource not accessible by integration');
    expect(r.reason).toContain(PARKED_REMEDY);
    expect(gh.calls.refires, 'and it still does not churn the PR').toBe(0);
  });

  it('⚠ an omitted approver THROWS — a parked run may never be silently skipped', async () => {
    const gh = fakeGitHub({ prNumber: 1809, initialRuns: [PARKED_RUN] });
    await expect(
      runVerification({ probe: gh.probe, refire: gh.refire, sleep: gh.sleep, pollIntervalMs: 0 }),
    ).rejects.toThrow(/approve.*required/i);
  });

  it('#1692 — the re-fire is never delivered → the job FAILS, loudly', async () => {
    const gh = fakeGitHub({ prNumber: 1692, runsAfterRefire: null, approve: 'ok' });
    const r = await runVerification({ ...gh, maxRefires: 2, pollsPerAction: 2, pollIntervalMs: 0 });

    expect(r.ok).toBe(false);
    expect(r.verdict).toBe('deadlocked');
    expect(r.reason).toContain(REMEDY);
    expect(r.prNumber, 'the failure must name the PR it is about').toBe(1692);
    // It really did try before giving up.
    expect(gh.calls.refires).toBe(2);
    expect(gh.calls.closedReopened).toEqual([1692, 1692]);
  });

  it('NEGATIVE CONTROL: the PRE-#1694 step calls that exact fixture GREEN', async () => {
    // The permanent leg. Same fake, same absent run — the code that shipped
    // before #1694 reports success and moves on.
    const gh = fakeGitHub({ prNumber: 1692, runsAfterRefire: null });
    const legacy = await legacyRefireOnly(gh);
    expect(legacy.ok).toBe(true);
    expect(legacy.reason).toContain('now validates the fresh baselines');

    const gh2 = fakeGitHub({ prNumber: 1692, runsAfterRefire: null, approve: 'ok' });
    const shipped = await runVerification({ ...gh2, maxRefires: 1, pollsPerAction: 1, pollIntervalMs: 0 });
    expect(shipped.ok).toBe(false);
  });

  it('NEGATIVE CONTROL: the PRE-#1815 condition calls the PARKED fixture GREEN', async () => {
    // The second permanent leg, at the driver level. The shipped loop must
    // reach a DIFFERENT answer than `total_count > 0` on the same fixture —
    // and it does so by approving, which is the behaviour the whole change is.
    const parkedForever = fakeGitHub({
      prNumber: 1809,
      initialRuns: [PARKED_RUN],
      approve: 'ok',
    });
    // …with approval disabled, the shipped loop must still refuse it.
    const refusing = fakeGitHub({ prNumber: 1809, initialRuns: [PARKED_RUN], approve: 'nope' });
    const p = await parkedForever.probe();
    expect(legacyExistsOnly(p.runs ?? []), 'the OLD gate says: verified').toBe(true);
    const shipped = await runVerification({ ...refusing, maxRefires: 1, pollsPerAction: 1, pollIntervalMs: 0 });
    expect(shipped.ok, 'the NEW gate says: not verified').toBe(false);
  });

  it('#1677 / #1689 — a re-fire that lands with a run that RUNS → verified', async () => {
    const gh = fakeGitHub({
      prNumber: 1689,
      runsAfterRefire: { after: 1, runs: [RAN_RUN] },
      approve: 'ok',
    });
    const r = await runVerification({ ...gh, maxRefires: 3, pollsPerAction: 6, pollIntervalMs: 0 });

    expect(r.ok).toBe(true);
    expect(r.verdict).toBe('verified');
    expect(gh.calls.refires, 'one re-fire was enough — do not churn the PR further').toBe(1);
  });

  it('⚠ …and what ACTUALLY happened on #1689: the re-fire landed a PARKED run', async () => {
    // `runs/31900111642/attempts/1` → completed/action_required. The old gate
    // called this verified; the new one approves it and only then agrees.
    const gh = fakeGitHub({
      prNumber: 1689,
      runsAfterRefire: { after: 1, runs: [PARKED_RUN] },
      approve: 'ok',
    });
    const r = await runVerification({ ...gh, maxRefires: 3, pollsPerAction: 6, pollIntervalMs: 0 });
    expect(r.ok).toBe(true);
    expect(r.approvals).toBe(1);
    expect(gh.calls.approved).toEqual([String(PARKED_RUN.id)]);
  });

  it('a re-fire that lands only on the SECOND attempt is still a pass', async () => {
    const gh = fakeGitHub({
      prNumber: 1692,
      runsAfterRefire: { after: 2, runs: [RAN_RUN] },
      approve: 'ok',
    });
    const r = await runVerification({ ...gh, maxRefires: 3, pollsPerAction: 2, pollIntervalMs: 0 });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe('verified');
    expect(gh.calls.refires).toBe(2);
  });

  it('the PAT upgrade — the push already fired a real CI run → no churn at all', async () => {
    // `secrets.VRT_BASELINE_PUSH_TOKEN` present: the push is authored by a real
    // account, so it fires `pull_request: synchronize` AND the run is not held
    // for approval. The first probe sees a run that ran; nothing is touched.
    const gh = fakeGitHub({ prNumber: 1701, initialRuns: [RAN_RUN], approve: 'ok' });
    const r = await runVerification({ ...gh, pollIntervalMs: 0 });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe('verified');
    expect(gh.calls.refires, 'no PR churn when the push already triggered CI').toBe(0);
    expect(gh.calls.approved, 'and nothing to approve').toEqual([]);
  });

  it('a human push landing mid-loop satisfies it — the head is what is checked, not our SHA', async () => {
    // The documented manual remedy, and the reason the probe re-reads the PR
    // head every time instead of pinning the SHA the bot pushed.
    const gh = fakeGitHub({
      prNumber: 1692,
      runsAfterRefire: null,
      approve: 'ok',
      heads: ['d2bbfd4c0', 'd2bbfd4c0', 'ca263abf0'],
    });
    const r = await runVerification({ ...gh, maxRefires: 3, pollsPerAction: 1, pollIntervalMs: 0 });
    expect(r.ok).toBe(true);
    expect(r.headSha).toBe('ca263abf0');
  });

  it('no open PR → success, and NOTHING is closed, reopened or approved', async () => {
    const gh = fakeGitHub({ prNumber: null });
    const r = await runVerification({ ...gh, pollIntervalMs: 0 });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe('no-open-pr');
    expect(gh.calls.refires).toBe(0);
    expect(gh.calls.approved).toEqual([]);
  });

  it('the loop terminates — it cannot spin on a permanently silent GitHub', async () => {
    const gh = fakeGitHub({ prNumber: 1692, runsAfterRefire: null, approve: 'ok' });
    const r = await runVerification({ ...gh, maxRefires: 3, pollsPerAction: 6, pollIntervalMs: 0 });
    expect(r.verdict).toBe('deadlocked');
    // Bounded by (maxRefires + 1) × (pollsPerAction + 1) + maxApprovals + 2.
    expect(gh.calls.probes).toBeLessThanOrEqual((3 + 1) * (6 + 1) + DEFAULTS.maxApprovals + 2);
    // ⚠ And it must reach the loop's OWN verdict, never fall out of the bottom.
    // The trailing `budget-exhausted` return is a bug report about this
    // arithmetic, so seeing it here would mean the cap is too tight — a real
    // deadlock would then be reported as an internal error.
    expect(r.verdict).not.toBe('budget-exhausted');
  });

  it('a run parked FOREVER (approval accepted, nothing starts) still terminates', async () => {
    // Models an approval that GitHub accepts and then does nothing with: the
    // budget must run out into a real `parked` verdict, not spin and not pass.
    const gh = {
      calls: { approved: [] as string[] },
      probe: async () => ({ prNumber: 1809, headSha: 'ad27705cf', runs: [PARKED_RUN] }),
      refire: async () => {},
      approve: async (ids: string[]) => {
        gh.calls.approved.push(...ids);
        return { ok: true };
      },
      sleep: async () => {},
    };
    const r = await runVerification({ ...gh, maxRefires: 1, pollsPerAction: 2, pollIntervalMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe('parked');
    expect(r.verdict).not.toBe('budget-exhausted');
    // Approval is tracked BY RUN ID, not by a retry counter: the same parked run
    // is never POSTed twice however long the loop waits on it. (The
    // `maxApprovals` budget is the backstop for a stream of NEW parked runs.)
    expect(gh.calls.approved).toEqual([String(PARKED_RUN.id)]);
  });

  it('a ZERO re-fire budget still reaches a real verdict, not the internal cap', async () => {
    const gh = fakeGitHub({ prNumber: 1692, runsAfterRefire: null, approve: 'ok' });
    const r = await runVerification({ ...gh, maxRefires: 0, pollsPerAction: 2, pollIntervalMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe('deadlocked');
    expect(gh.calls.refires, 'maxRefires: 0 must close nothing').toBe(0);
  });
});

// ──────────────────────────────── the oracle ────────────────────────────────

describe('the oracle reads the right thing', () => {
  it('asks ci.yml for runs on THIS sha, restricted to pull_request events', () => {
    const q = ciRunsQuery('owner/repo', DEADLOCKED_SHA);
    expect(q).toContain('actions/workflows/ci.yml/runs');
    expect(q).toContain(`head_sha=${DEADLOCKED_SHA}`);
    // ⚠ THE NARROWING IS THE SAFETY ARGUMENT, not a tidy-up. A
    // workflow_dispatch ci.yml run does NOT count toward a PR's
    // required-status gate (confirmed on #524), so counting one would let this
    // module declare a still-deadlocked PR verified. Presence means DECLARE
    // SUCCESS here, so the safe direction is to under-count, never over-count.
    expect(q).toContain('event=pull_request');
    // ⚠ and it must fetch the RUNS, not one of them: the decision reads each
    // run's state, so a page of 1 could hide the run that matters.
    expect(q).toContain(`per_page=${RUNS_PAGE_SIZE}`);
    expect(RUNS_PAGE_SIZE).toBeGreaterThan(1);
  });

  it('NEGATIVE CONTROL: the query is a function of its inputs, not a constant', () => {
    expect(ciRunsQuery('a/b', DEADLOCKED_SHA)).not.toBe(ciRunsQuery('a/b', PARKED_BOT_SHA));
    expect(ciRunsQuery('a/b', DEADLOCKED_SHA)).not.toBe(ciRunsQuery('c/d', DEADLOCKED_SHA));
  });

  it('⚠ REFUSES an abbreviated SHA — GitHub answers 0 for one, without erroring', () => {
    // FOUND BY NEGATIVE-CONTROLLING THE INSTRUMENT AGAINST PRODUCTION, and it
    // is the sharpest edge in this whole module. Measured on the real API:
    //
    //   ?head_sha=022c6cc23                          → total_count 0
    //   ?head_sha=022c6cc23ad64028f5549359f2f65695541e3a25 → total_count 1
    //
    // …for the SAME commit. Without this guard the gate reads a short SHA as a
    // deadlock: it fails the capture and comments a deadlock notice on a PR
    // that is fine, and the output is indistinguishable from the real thing.
    expect(() => ciRunsQuery('a/b', '022c6cc23')).toThrow(/full 40-char SHA/);
    expect(() => ciRunsQuery('a/b', '')).toThrow();
    expect(() => ciRunsQuery('a/b', `${DEADLOCKED_SHA}extra`)).toThrow();
    expect(() => ciRunsQuery('a/b', DEADLOCKED_SHA.toUpperCase())).toThrow();
    // …and the positive half: the full form is accepted, so the guard is not
    // simply refusing everything.
    expect(() => ciRunsQuery('a/b', DEADLOCKED_SHA)).not.toThrow();
    expect(assertFullSha(PARKED_BOT_SHA)).toBe(PARKED_BOT_SHA);
  });

  it('the approval endpoint is spelled ONCE, and it is the REST one', () => {
    expect(approvePath('owner/repo', 12345)).toBe('repos/owner/repo/actions/runs/12345/approve');
    // ⚠ `gh run approve` IS NOT A SUBCOMMAND. Measured 2026-08-17: it prints
    // `gh run`'s usage and EXITS 0, so a shell step built on it looks like it
    // worked and approves nothing. Deny the INVOCATION in both artifacts — the
    // argv form this module would use, and the shell form a workflow would.
    // (A back-ticked mention is prose and stays legal, which is why the warning
    // above can be written down at all.)
    expect(MODULE_SRC).not.toMatch(/'run',\s*'approve'/);
    expect(MODULE_SRC).not.toMatch(/(?<!`)gh run approve/);
    expect(WORKFLOW).not.toMatch(/(?<!`)gh run approve/);
  });

  it('parseRunsResponse REFUSES every shape that would make the gate blind', () => {
    // `Number('')` is 0 and a missing array is a silent empty list — both read
    // as "no run exists", which is the false-deadlock class. Each of these must
    // throw rather than decide.
    expect(() => parseRunsResponse('')).toThrow(/not an object/);
    expect(() => parseRunsResponse('{}')).toThrow(/total_count/);
    expect(() => parseRunsResponse({ total_count: 2, workflow_runs: [] })).toThrow(/disagrees with itself/);
    expect(() => parseRunsResponse({ total_count: 3, workflow_runs: [PARKED_RUN] })).toThrow(/TRUNCATED/);
    // …and the positive half, with the fields the decision actually reads.
    const parsed = parseRunsResponse({ total_count: 1, workflow_runs: [PARKED_RUN] });
    expect(parsed).toEqual([
      { id: PARKED_RUN.id, status: 'completed', conclusion: 'action_required', html_url: PARKED_RUN.html_url },
    ]);
    expect(parseRunsResponse({ total_count: 0, workflow_runs: [] })).toEqual([]);
  });

  it('the manual `probe` entry point RESOLVES a short SHA instead of refusing it', () => {
    // A human debugging a stuck PR types the short form. `/commits/<ref>` does
    // accept it, so the CLI reconciles the two behaviours in one place rather
    // than letting them disagree silently. This is the entry point used to
    // negative-control the oracle against production before shipping.
    expect(MODULE_SRC).toContain('repos/${repo}/commits/${given}');
    expect(MODULE_SRC).toContain('resolved ${given} → ${sha}');
  });
});

// ───────────── one picture, four causes: the diagnostic tells them apart ─────

describe('diagnoseBlocked: "BLOCKED with nothing red" has four causes', () => {
  it('#1815 — a run exists and is PARKED', () => {
    const d = diagnoseBlocked({ runs: [PARKED_RUN] });
    expect(d.cause).toBe('parked');
    expect(d.issue).toBe(1815);
    expect(d.reason).toContain(String(PARKED_RUN.id));
  });

  it('#1694 — no run was created at all', () => {
    // ci.yml has NO path filter (the `paths-ignore` + docs-only bypass were
    // deleted 2026-08-23), so a missing run is unambiguous: the event was
    // dropped. While the filter existed this same input was indistinguishable
    // from "path-skipped by design", which is why the verdict then needed the
    // changed-file list, the bypass workflow's runs and the posted contexts.
    const d = diagnoseBlocked({ runs: [] });
    expect(d.cause).toBe('no-run');
    expect(d.issue).toBe(1694);
    expect(d.reason).toContain(REMEDY);
  });

  it('healthy — a real run executed', () => {
    expect(diagnoseBlocked({ runs: [RAN_RUN] }).cause).toBe('healthy');
  });

  it('an inert run that approval cannot fix', () => {
    const d = diagnoseBlocked({ runs: [{ id: 9, status: 'completed', conclusion: 'startup_failure' }] });
    expect(d.cause).toBe('inert-run');
    expect(d.reason).toContain('startup_failure');
  });

  it('⚠ NEGATIVE CONTROL: each run shape ALONE moves the verdict', () => {
    // One base input, three one-field perturbations, four different answers. If
    // the run classification were being ignored, two of these would collide.
    const causes = new Set<Cause>([
      diagnoseBlocked({ runs: [] }).cause,
      diagnoseBlocked({ runs: [PARKED_RUN] }).cause,
      diagnoseBlocked({ runs: [RAN_RUN] }).cause,
      diagnoseBlocked({ runs: [{ id: 9, status: 'completed', conclusion: 'startup_failure' }] }).cause,
    ]);
    expect([...causes].sort()).toEqual(['healthy', 'inert-run', 'no-run', 'parked'].sort());
    // …and every cause it can return is documented with the issue it belongs to.
    for (const c of causes) expect(BLOCKED_CAUSES[c].summary.length).toBeGreaterThan(20);
  });

  it('every documented cause is reachable — the table is not aspirational', () => {
    const reachable = new Set<Cause>([
      diagnoseBlocked({ runs: [RAN_RUN] }).cause,
      diagnoseBlocked({ runs: [PARKED_RUN] }).cause,
      diagnoseBlocked({ runs: [{ id: 1, status: 'completed', conclusion: 'stale' }] }).cause,
      diagnoseBlocked({ runs: [] }).cause,
    ]);
    const unreachable = Object.keys(BLOCKED_CAUSES).filter((c) => !reachable.has(c as Cause));
    expect(unreachable).toEqual([]);
  });
});

// ─────────────────────── the module cannot green a gate ─────────────────────

describe('the fix cannot satisfy a required context by itself', () => {
  it('never writes a commit status and never names a required context', () => {
    // The standing rule: the ONLY thing that may satisfy ruleset 16042163 is a
    // real pull_request CI run — nothing may post one. This module's
    // failure path exists precisely because the code is UNVERIFIED, so a green
    // context from here would be the exact inversion of its purpose.
    expect(MODULE_SRC).not.toMatch(/createCommitStatus|POST[^\n]*statuses|state:\s*'success'/);
    for (const ctx of REQUIRED_CONTEXTS) expect(MODULE_SRC).not.toContain(ctx);
  });

  it('⚠ its ONLY write to GitHub is the approval endpoint', () => {
    // Anchored to the artifact, deny-by-default: every POST in the source must
    // be the one this change added. A future POST to /statuses (or anywhere
    // else) reddens here rather than being noticed in review.
    const posts = [...MODULE_SRC.matchAll(/'-X',\s*'POST',\s*([^\]]+)\]/g)].map((m) => m[1].trim());
    expect(posts.length, 'the scan must have found the approval call').toBeGreaterThan(0);
    for (const p of posts) expect(p).toMatch(/^approvePath\(/);
  });

  it('the workflow job is NOT named after a required context', () => {
    // A job named after a required context creates a check run the instant it
    // starts and cannot withdraw it — and a job-level `if:` skip reports as
    // SUCCESS to branch protection.
    const names = [...WORKFLOW.matchAll(/^\s{4}name:\s*(.+)$/gm)].map((m) => m[1].trim());
    expect(names.length, 'the scan must have found the job names').toBeGreaterThan(0);
    for (const n of names) for (const ctx of REQUIRED_CONTEXTS) expect(n).not.toContain(ctx);
  });
});

// ──────────────────────────── the wiring is real ────────────────────────────

describe('vrt-update.yml actually runs the verifier', () => {
  it('the revalidate job invokes the module and can fail the run', () => {
    expect(WORKFLOW).toContain('node scripts/vrt-revalidate-gate.mjs verify');
    // A checkout is required for the script to exist on the runner — the job
    // used to have none.
    const revalidate = WORKFLOW.slice(WORKFLOW.indexOf('\n  revalidate:'));
    expect(revalidate).toContain('actions/checkout@v4');
    // ⚠ `actions: WRITE`, not read (#1815). Read is enough to see the parked
    // run and not enough to un-park it, which would leave the gate able only to
    // report the deadlock it is standing in.
    expect(revalidate).toMatch(/actions:\s*write/);
    expect(revalidate).not.toMatch(/actions:\s*read/);
    expect(revalidate).toMatch(/pull-requests:\s*write/);
    // ⚠ Nothing may swallow the verdict. `continue-on-error` here would restore
    // the pre-fix behaviour exactly: a re-fire that did nothing, reported green.
    expect(revalidate).not.toContain('continue-on-error');
  });

  it('the optional push token FALLS BACK — for the push AND for the approval', () => {
    // `${{ secrets.X || github.token }}` is today's behaviour when X is unset,
    // so the workflow is never broken by a secret nobody has created — and
    // `revalidate` verifies either way, so an EXPIRED token surfaces as a red
    // run rather than as a silent regression. Both call sites use the same
    // shape: the capture's push, and the verify step's approval.
    const uses = [
      ...WORKFLOW.matchAll(/\$\{\{\s*secrets\.VRT_BASELINE_PUSH_TOKEN\s*\|\|\s*github\.token\s*\}\}/g),
    ];
    expect(uses.length, 'push and approve both fall back the same way').toBeGreaterThan(1);
    expect(WORKFLOW).toMatch(
      /GH_TOKEN:\s*\$\{\{\s*secrets\.VRT_BASELINE_PUSH_TOKEN\s*\|\|\s*github\.token\s*\}\}/,
    );
  });

  it('the capture job exports the SHA it pushed, and the shell emits it', () => {
    expect(WORKFLOW).toMatch(/sha:\s*\$\{\{\s*steps\.commit\.outputs\.sha\s*\}\}/);
    expect(WORKFLOW).toMatch(/PUSHED_SHA:\s*\$\{\{\s*needs\.capture\.outputs\.sha\s*\}\}/);
    expect(COMMIT_SH).toContain('emit_sha "$(git rev-parse HEAD)"');
    expect(COMMIT_SH).toContain('echo "sha=$1" >>"$GITHUB_OUTPUT"');
  });
});
