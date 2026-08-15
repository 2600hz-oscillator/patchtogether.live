// scripts/vrt-revalidate-gate.test.ts
//
// Gate for the SELF-VERIFYING VRT re-fire (.github/workflows/vrt-update.yml's
// `revalidate` job + scripts/vrt-revalidate-gate.mjs). Pure-unit, zero-flake,
// runs in the `unit` lane via `task test` → `task test:scripts`.
//
// ── What went wrong, and what this file is therefore for (#1694) ────────────
//
// A baseline commit pushed with GITHUB_TOKEN gets NO ci.yml run, so a PR whose
// HEAD is `vrt-baseline-bot`'s commit is BLOCKED forever with zero failures —
// #1184's deadlock reached by a different route. `revalidate` close+reopens the
// PR to re-fire a `pull_request` event, and MEASURED ON 2026-08-15 that worked
// for #1677 and #1689 and did nothing at all for #1692. The step reported
// SUCCESS all three times, because it never checked.
//
// So the thing that must be true is not "we re-fired" — it is "a run EXISTS".
// This file pins that, at the decision function, with the #1692 trace as a
// permanent negative control.
//
// ── ⚠ WHAT THIS GATE CANNOT SEE ────────────────────────────────────────────
//  · Whether GitHub delivers the `reopened` event. That is the failure being
//    handled, not one that can be unit-tested; what IS tested is that the loop
//    fails loudly instead of passing when the event is never delivered.
//  · Whether ruleset 16042163 still requires the contexts ci.yml produces.
//    That lives in a GitHub ruleset (docs-only-gate.test.ts pins the context
//    STRINGS against ci.yml's job names, which is the closest available proxy).
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

type Action = 'satisfied' | 'refire' | 'wait' | 'fail';
type Step = { action: Action; reason: string };
type Probe = { prNumber: number | null; headSha?: string; ciRunCount?: number };
type Verdict = {
  ok: boolean;
  verdict: string;
  reason: string;
  refires: number;
  polls: number;
  headSha: string | null;
  prNumber: number | null;
};

const { REMEDY, DEFAULTS, nextAction, runVerification, ciRunsQuery, assertFullSha } =
  gate as unknown as {
    REMEDY: string;
    DEFAULTS: { maxRefires: number; pollsPerRefire: number; pollIntervalMs: number };
    nextAction: (s: {
      ciRunCount: number;
      refiresDone: number;
      maxRefires: number;
      pollsSinceRefire: number;
      pollsPerRefire: number;
    }) => Step;
    runVerification: (o: {
      probe: () => Promise<Probe>;
      refire: (pr: number) => Promise<void>;
      sleep: (ms: number) => Promise<void>;
      log?: (m: string) => void;
      maxRefires?: number;
      pollsPerRefire?: number;
      pollIntervalMs?: number;
    }) => Promise<Verdict>;
    ciRunsQuery: (repo: string, sha: string) => string;
    assertFullSha: (sha: string) => string;
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

/** Default step inputs — each test overrides only the field it is about. */
const base = {
  ciRunCount: 0,
  refiresDone: 0,
  maxRefires: DEFAULTS.maxRefires,
  pollsSinceRefire: 0,
  pollsPerRefire: DEFAULTS.pollsPerRefire,
};

// ───────────────────────── a scriptable fake GitHub ─────────────────────────

/**
 * A fake whose `ciRunCount` becomes non-zero only after `runAppearsAfterRefire`
 * re-fires — i.e. it models "the event was delivered" — or never, which is the
 * #1692 trace. Records every call so the tests can assert on the interaction,
 * not just the verdict.
 */
function fakeGitHub(opts: {
  prNumber?: number | null;
  runAppearsAfterRefire?: number | null;
  /** Head SHA per probe index; the last entry sticks. Models a human push. */
  heads?: string[];
  /** When set, the run exists from the very first probe (the PAT upgrade). */
  runExistsImmediately?: boolean;
}) {
  const calls = { probes: 0, refires: 0, sleeps: 0, closedReopened: [] as number[] };
  const heads = opts.heads ?? ['d2bbfd4c0'];
  return {
    calls,
    probe: async (): Promise<Probe> => {
      calls.probes++;
      if (opts.prNumber === null) return { prNumber: null };
      const headSha = heads[Math.min(calls.probes - 1, heads.length - 1)];
      const appears = opts.runAppearsAfterRefire;
      const exists =
        opts.runExistsImmediately === true ||
        // A head that moved off the bot commit always has its own run — that is
        // the manual remedy, observed working on #1692 (ca263abf0).
        headSha !== 'd2bbfd4c0' ||
        (appears !== null && appears !== undefined && calls.refires >= appears);
      return { prNumber: opts.prNumber ?? 1692, headSha, ciRunCount: exists ? 1 : 0 };
    },
    refire: async (pr: number) => {
      calls.refires++;
      calls.closedReopened.push(pr);
    },
    sleep: async () => {
      calls.sleeps++;
    },
  };
}

/**
 * THE PRE-FIX BEHAVIOUR, kept as a permanent leg. This is literally what
 * `revalidate` did before #1694: close, reopen, declare victory. It exists so
 * the deadlock fixture below can be shown to be one the OLD code calls green —
 * without it, a green suite would be indistinguishable from a fixture that
 * never had a deadlock in it.
 */
async function legacyRefireOnly(gh: ReturnType<typeof fakeGitHub>): Promise<Verdict> {
  const p = await gh.probe();
  if (p.prNumber === null) {
    return { ok: true, verdict: 'no-open-pr', reason: '', refires: 0, polls: 1, headSha: null, prNumber: null };
  }
  await gh.refire(p.prNumber);
  return {
    ok: true,
    verdict: 'reopened',
    reason: 'Reopened the PR — its pull_request CI run now validates the fresh baselines.',
    refires: 1,
    polls: 1,
    headSha: p.headSha ?? null,
    prNumber: p.prNumber,
  };
}

// ─────────────────────────────── the decision ───────────────────────────────

describe('nextAction: a re-fire is only ever "done" when a run EXISTS', () => {
  it('a run on the head is the ONLY success — and it wins from any state', () => {
    for (const refiresDone of [0, 1, DEFAULTS.maxRefires]) {
      for (const pollsSinceRefire of [0, DEFAULTS.pollsPerRefire]) {
        expect(
          nextAction({ ...base, ciRunCount: 1, refiresDone, pollsSinceRefire }).action,
          `a ci.yml run exists, so the deadlock is broken regardless of how we got here ` +
            `(refires=${refiresDone}, polls=${pollsSinceRefire})`,
        ).toBe('satisfied');
      }
    }
  });

  it('with no run and nothing re-fired yet, it re-fires immediately', () => {
    expect(nextAction(base).action).toBe('refire');
  });

  it('after a re-fire it WAITS for the poll budget, then re-fires again', () => {
    expect(nextAction({ ...base, refiresDone: 1, pollsSinceRefire: 0 }).action).toBe('wait');
    expect(
      nextAction({ ...base, refiresDone: 1, pollsSinceRefire: DEFAULTS.pollsPerRefire - 1 }).action,
    ).toBe('wait');
    expect(
      nextAction({ ...base, refiresDone: 1, pollsSinceRefire: DEFAULTS.pollsPerRefire }).action,
    ).toBe('refire');
  });

  it('a budget of ZERO re-fires never touches the PR — it just fails', () => {
    // The knob has to mean what it says, and not only for tidiness: this is the
    // ONLY configuration in which the failure path can be exercised against a
    // live PR without closing it, which is how the end-to-end check in this
    // change's PR body was run.
    const s = nextAction({ ...base, maxRefires: 0 });
    expect(s.action).not.toBe('refire');
    expect(
      nextAction({ ...base, maxRefires: 0, pollsSinceRefire: DEFAULTS.pollsPerRefire }).action,
    ).toBe('fail');
  });

  it('FAILS — never "satisfied" — once the re-fire budget is spent with no run', () => {
    const step = nextAction({
      ...base,
      refiresDone: DEFAULTS.maxRefires,
      pollsSinceRefire: DEFAULTS.pollsPerRefire,
    });
    expect(step.action).toBe('fail');
    // The message has to be actionable by whoever finds the red run, so pin the
    // two things they need: what happened, and the one command that fixes it.
    expect(step.reason).toContain('#1694');
    expect(step.reason).toContain(REMEDY);
  });

  it('NEGATIVE CONTROL: no reachable state returns "satisfied" with zero runs', () => {
    // The whole safety property in one assertion. If a refactor ever lets the
    // step declare victory without a run, this is what catches it — and it
    // sweeps the entire state space rather than the three cases above.
    const offenders: string[] = [];
    for (let refiresDone = 0; refiresDone <= DEFAULTS.maxRefires + 1; refiresDone++) {
      for (let pollsSinceRefire = 0; pollsSinceRefire <= DEFAULTS.pollsPerRefire + 1; pollsSinceRefire++) {
        const s = nextAction({ ...base, ciRunCount: 0, refiresDone, pollsSinceRefire });
        if (s.action === 'satisfied') offenders.push(`refires=${refiresDone} polls=${pollsSinceRefire}`);
      }
    }
    expect(offenders).toEqual([]);
    // …and the control is not vacuous: flip the one input it is supposed to
    // read and the SAME sweep is satisfied everywhere.
    const withRun: string[] = [];
    for (let refiresDone = 0; refiresDone <= DEFAULTS.maxRefires + 1; refiresDone++) {
      const s = nextAction({ ...base, ciRunCount: 1, refiresDone });
      if (s.action !== 'satisfied') withRun.push(`refires=${refiresDone}`);
    }
    expect(withRun).toEqual([]);
  });
});

// ──────────────────────────────── the driver ────────────────────────────────

describe('runVerification: the three traces measured on 2026-08-15', () => {
  it('#1692 — the re-fire is never delivered → the job FAILS, loudly', async () => {
    const gh = fakeGitHub({ prNumber: 1692, runAppearsAfterRefire: null });
    const r = await runVerification({ ...gh, maxRefires: 2, pollsPerRefire: 2, pollIntervalMs: 0 });

    expect(r.ok).toBe(false);
    expect(r.verdict).toBe('deadlocked');
    expect(r.reason).toContain(REMEDY);
    expect(r.prNumber, 'the failure must name the PR it is about').toBe(1692);
    // It really did try before giving up.
    expect(gh.calls.refires).toBe(2);
    expect(gh.calls.closedReopened).toEqual([1692, 1692]);
  });

  it('NEGATIVE CONTROL: the PRE-FIX step calls that exact fixture GREEN', async () => {
    // The permanent leg. Same fake, same absent run — the code that shipped
    // before #1694 reports success and moves on. This is the difference the
    // whole change consists of; if this ever stops passing, the fixture has
    // stopped modelling the deadlock and every green above means nothing.
    const gh = fakeGitHub({ prNumber: 1692, runAppearsAfterRefire: null });
    const legacy = await legacyRefireOnly(gh);
    expect(legacy.ok).toBe(true);
    expect(legacy.reason).toContain('now validates the fresh baselines');

    const gh2 = fakeGitHub({ prNumber: 1692, runAppearsAfterRefire: null });
    const shipped = await runVerification({
      ...gh2,
      maxRefires: 1,
      pollsPerRefire: 1,
      pollIntervalMs: 0,
    });
    expect(shipped.ok).toBe(false);
  });

  it('#1677 / #1689 — the re-fire IS delivered → verified, with one close+reopen', async () => {
    const gh = fakeGitHub({ prNumber: 1689, runAppearsAfterRefire: 1 });
    const r = await runVerification({ ...gh, maxRefires: 3, pollsPerRefire: 6, pollIntervalMs: 0 });

    expect(r.ok).toBe(true);
    expect(r.verdict).toBe('verified');
    expect(gh.calls.refires, 'one re-fire was enough — do not churn the PR further').toBe(1);
  });

  it('a re-fire that lands only on the SECOND attempt is still a pass', async () => {
    const gh = fakeGitHub({ prNumber: 1692, runAppearsAfterRefire: 2 });
    const r = await runVerification({ ...gh, maxRefires: 3, pollsPerRefire: 2, pollIntervalMs: 0 });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe('verified');
    expect(gh.calls.refires).toBe(2);
  });

  it('the PAT upgrade — the push already fired CI → verified with NO close+reopen', async () => {
    // `secrets.VRT_BASELINE_PUSH_TOKEN` present: the push itself fires
    // `pull_request: synchronize`, so the first probe already sees a run and
    // the PR is never closed. Nothing about the verification changes.
    const gh = fakeGitHub({ prNumber: 1701, runExistsImmediately: true });
    const r = await runVerification({ ...gh, pollIntervalMs: 0 });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe('verified');
    expect(gh.calls.refires, 'no PR churn when the push already triggered CI').toBe(0);
  });

  it('a human push landing mid-loop satisfies it — the head is what is checked, not our SHA', async () => {
    // The documented manual remedy, and the reason the probe re-reads the PR
    // head every time instead of pinning the SHA the bot pushed.
    const gh = fakeGitHub({
      prNumber: 1692,
      runAppearsAfterRefire: null,
      heads: ['d2bbfd4c0', 'd2bbfd4c0', 'ca263abf0'],
    });
    const r = await runVerification({ ...gh, maxRefires: 3, pollsPerRefire: 1, pollIntervalMs: 0 });
    expect(r.ok).toBe(true);
    expect(r.headSha).toBe('ca263abf0');
  });

  it('no open PR → success, and NOTHING is closed or reopened', async () => {
    const gh = fakeGitHub({ prNumber: null });
    const r = await runVerification({ ...gh, pollIntervalMs: 0 });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe('no-open-pr');
    expect(gh.calls.refires).toBe(0);
  });

  it('the loop terminates — it cannot spin on a permanently silent GitHub', async () => {
    const gh = fakeGitHub({ prNumber: 1692, runAppearsAfterRefire: null });
    const r = await runVerification({ ...gh, maxRefires: 3, pollsPerRefire: 6, pollIntervalMs: 0 });
    expect(r.verdict).toBe('deadlocked');
    // Bounded by maxRefires × (pollsPerRefire + 1) + 2 = 26.
    expect(gh.calls.probes).toBeLessThanOrEqual(3 * (6 + 1) + 2);
  });
});

// ──────────────────────────────── the oracle ────────────────────────────────

/** PR #1692's baseline commit — the one with no CI run. Full 40 chars, and
 *  that is load-bearing; see the short-SHA control below. */
const DEADLOCKED_SHA = 'd2bbfd4c0874ecbbf910fffb19fe6dac2b3d7190';
/** PR #1689's baseline commit — also bot-authored, but its re-fire landed. */
const HEALTHY_BOT_SHA = '022c6cc23ad64028f5549359f2f65695541e3a25';

describe('the oracle reads the right thing', () => {
  it('asks ci.yml for runs on THIS sha, restricted to pull_request events', () => {
    const q = ciRunsQuery('owner/repo', DEADLOCKED_SHA);
    expect(q).toContain('actions/workflows/ci.yml/runs');
    expect(q).toContain(`head_sha=${DEADLOCKED_SHA}`);
    // ⚠ THE NARROWING IS THE SAFETY ARGUMENT, not a tidy-up. A
    // workflow_dispatch ci.yml run does NOT count toward a PR's
    // required-status gate (confirmed on #524), so counting one would let this
    // module declare a still-deadlocked PR verified. docs-only-gate.yml's guard
    // G2 deliberately does NOT filter, because there presence means REFUSE and
    // over-counting is the safe direction; here presence means DECLARE SUCCESS,
    // so the safe direction is the opposite one.
    expect(q).toContain('event=pull_request');
  });

  it('NEGATIVE CONTROL: the query is a function of its inputs, not a constant', () => {
    expect(ciRunsQuery('a/b', DEADLOCKED_SHA)).not.toBe(ciRunsQuery('a/b', HEALTHY_BOT_SHA));
    expect(ciRunsQuery('a/b', DEADLOCKED_SHA)).not.toBe(ciRunsQuery('c/d', DEADLOCKED_SHA));
  });

  it('⚠ REFUSES an abbreviated SHA — GitHub answers 0 for one, without erroring', () => {
    // FOUND BY NEGATIVE-CONTROLLING THE INSTRUMENT AGAINST PRODUCTION, and it
    // is the sharpest edge in this whole change. Measured on the real API:
    //
    //   ?head_sha=022c6cc23                          → total_count 0
    //   ?head_sha=022c6cc23ad64028f5549359f2f65695541e3a25 → total_count 1
    //
    // …for the SAME commit, which has a pull_request CI run. Without this
    // guard the gate reads a short SHA as a deadlock: it fails the capture and
    // comments a deadlock notice on a PR that is perfectly healthy, and the
    // output is indistinguishable from the real thing.
    //
    // ⚠ It also invalidates the `gh api ".../runs?head_sha=<short>"` one-liner
    // in #1694's own report. The finding survived re-measurement with the full
    // SHA; the COMMAND did not.
    expect(() => ciRunsQuery('a/b', '022c6cc23')).toThrow(/full 40-char SHA/);
    expect(() => ciRunsQuery('a/b', '')).toThrow();
    expect(() => ciRunsQuery('a/b', `${DEADLOCKED_SHA}extra`)).toThrow();
    expect(() => ciRunsQuery('a/b', DEADLOCKED_SHA.toUpperCase())).toThrow();
    // …and the positive half: the full form is accepted, so the guard is not
    // simply refusing everything.
    expect(() => ciRunsQuery('a/b', DEADLOCKED_SHA)).not.toThrow();
    expect(assertFullSha(HEALTHY_BOT_SHA)).toBe(HEALTHY_BOT_SHA);
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

// ─────────────────────── the module cannot green a gate ─────────────────────

describe('the fix cannot satisfy a required context by itself', () => {
  it('never writes a commit status and never names a required context', () => {
    // The rule docs-only-gate.mjs is built around: the ONLY thing that may
    // satisfy ruleset 16042163 is a real pull_request CI run. This module's
    // failure path exists precisely because the code is UNVERIFIED, so a green
    // context from here would be the exact inversion of its purpose.
    expect(MODULE_SRC).not.toMatch(/createCommitStatus|\/statuses\b|state:\s*'success'/);
    expect(MODULE_SRC).not.toContain('typecheck + unit + ART + E2E');
    expect(MODULE_SRC).not.toContain('vrt-strict (visual regression');
  });

  it('the workflow job is NOT named after a required context', () => {
    // A job named after a required context creates a check run the instant it
    // starts and cannot withdraw it — and a job-level `if:` skip reports as
    // SUCCESS to branch protection.
    const names = [...WORKFLOW.matchAll(/^\s{4}name:\s*(.+)$/gm)].map((m) => m[1].trim());
    expect(names.length, 'the scan must have found the job names').toBeGreaterThan(0);
    for (const n of names) {
      expect(n).not.toContain('typecheck + unit + ART + E2E');
      expect(n).not.toContain('vrt-strict (visual regression');
    }
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
    // `actions: read` is what lets the oracle query run at all; without it the
    // probe 404s and the job would fail for the wrong reason.
    expect(revalidate).toMatch(/actions:\s*read/);
    expect(revalidate).toMatch(/pull-requests:\s*write/);
    // ⚠ Nothing may swallow the verdict. `continue-on-error` here would restore
    // the pre-fix behaviour exactly: a re-fire that did nothing, reported green.
    expect(revalidate).not.toContain('continue-on-error');
  });

  it('the optional push token FALLS BACK — an absent secret cannot break the capture', () => {
    // Implementing option 1 of #1694 without the ability to create the secret
    // is only safe while this holds. `${{ secrets.X || github.token }}` is
    // today's behaviour when X is unset, so the workflow is never broken by a
    // secret nobody has created — and `revalidate` verifies either way, so an
    // EXPIRED token surfaces as a red run rather than as a silent regression.
    expect(WORKFLOW).toMatch(
      /token:\s*\$\{\{\s*secrets\.VRT_BASELINE_PUSH_TOKEN\s*\|\|\s*github\.token\s*\}\}/,
    );
  });

  it('the capture job exports the SHA it pushed, and the shell emits it', () => {
    expect(WORKFLOW).toMatch(/sha:\s*\$\{\{\s*steps\.commit\.outputs\.sha\s*\}\}/);
    expect(WORKFLOW).toMatch(/PUSHED_SHA:\s*\$\{\{\s*needs\.capture\.outputs\.sha\s*\}\}/);
    expect(COMMIT_SH).toContain('emit_sha "$(git rev-parse HEAD)"');
    expect(COMMIT_SH).toContain('echo "sha=$1" >>"$GITHUB_OUTPUT"');
  });
});
