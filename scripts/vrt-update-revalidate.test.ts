// scripts/vrt-update-revalidate.test.ts
//
// A SAFETY STEP THAT IS SKIPPED LOOKS EXACTLY LIKE A SAFETY STEP THAT PASSED.
//
// `vrt-update.yml`'s `revalidate` job close+reopens the PR so a real
// `pull_request` run re-validates bot-pushed baselines. That close+reopen is
// the ONLY reason a bot-pushed baseline is ever checked: a GITHUB_TOKEN push
// does not fire CI, and a `workflow_dispatch` run does not count toward a
// required-status gate (confirmed on PR #524).
//
// ⚠ AND THE CLOSE+REOPEN ITSELF IS NOT RELIABLE (#1694) — measured 2 of 3 on
// 2026-08-15, with #1692 left permanently BLOCKED and zero failures to point
// at. That is a different failure from the one this file models: here the
// question is WHETHER THE JOB RUNS, there it is whether running it achieved
// anything. The job now verifies its own effect and fails loudly when the run
// never appears; that half lives in scripts/vrt-revalidate-gate{.mjs,.test.ts}.
// Both halves are load-bearing — a verification step that is SKIPPED is exactly
// as silent as the unverified re-fire was, which is what this file prevents.
//
// ── THE HISTORICAL BUG, AND WHY IT CANNOT RECUR ────────────────────────────
// The workflow used to be a TWO-PLATFORM matrix and `revalidate` shipped as
// `needs: [linux, darwin]` with NO `if:`. A job with `needs:` and no `if:`
// defaults to `success()`, which a SKIPPED dependency does not satisfy —
// GitHub propagates the skip. Both platform jobs carried their own `if:` on
// `inputs.platform`, so a single-platform dispatch skipped one of them and
// therefore skipped `revalidate` too:
//
//     platform=linux  → darwin skipped → revalidate SKIPPED
//     platform=darwin → linux  skipped → revalidate SKIPPED
//     platform=both   → revalidate runs
//
// …and single-platform was the dispatch CLAUDE.md RECOMMENDED. So the
// documented re-validation was notional for the recommended usage, and the run
// still reported green: a skipped job is a grey check, not a red one.
//
// ⚠ 2026-08-10 — THE MATRIX IS GONE and the defect went with it rather than
// being patched around. There is ONE baseline set (no `{platform}` in
// `snapshotPathTemplate`) authored by ONE `capture` job, so there is no sibling
// to skip and no propagation to model. What is left to get wrong is narrower
// and is what this file now pins.
//
// ── WHAT IS STILL LOAD-BEARING ─────────────────────────────────────────────
// A capture that rewrote NOTHING still SUCCEEDS — Playwright only rewrites a
// snapshot whose comparison FAILS — so `needs: capture` ALONE is wrong in the
// loose direction: it would close+reopen the PR and burn ~25 min of CI on a
// branch whose baselines never moved. `capture.outputs.pushed` is the only
// thing that distinguishes "captured" from "ran and changed nothing", and the
// failure mode is SILENT IN BOTH DIRECTIONS: too strict and revalidate never
// runs again (the original bug, restored); too loose and it re-fires CI over
// nothing.
//
// So this file re-implements GitHub's job-gating semantics and runs the REAL
// workflow file through them for every outcome the capture can have.
//
// ── WHAT THIS GATE CANNOT SEE (stated, per the blind-gates rule) ────────────
//  · It models GitHub's documented semantics, not GitHub. If Actions changes
//    how skips propagate, this agrees with the docs and not with the runner.
//  · `cancelled()` is modelled as false; a mid-run workflow cancellation is
//    outside the scenario set.
//  · Only `.github/workflows/vrt-update.yml` is scanned. The same
//    skipped-dependency class in any OTHER workflow is outside this gate — the
//    other workflows were audited by hand when this landed (deploy.yml,
//    daily-prod-deploy.yml, flake-check-3x.yml and ci.yml all already wrap the
//    affected jobs in `always() && …`); nothing re-checks them automatically.
//  · The expression evaluator supports only the subset these workflows use
//    (status functions, && || !, == !=, parens, string literals, and
//    needs/inputs lookups). It THROWS on anything else rather than guessing —
//    an unsupported operator is a loud failure, never a silent `false`.
//
// The blindness that CANNOT hide: the parser's non-vacuity test pins the job
// names and requires each to have been found with its wiring. If the scan ever
// stops recognising the file, that test goes red instead of every simulation
// passing over an empty job list.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WORKFLOW = fileURLToPath(
  new URL('../.github/workflows/vrt-update.yml', import.meta.url),
);

// ───────────────────────────── the workflow scanner ─────────────────────────
// A scanner rather than a YAML load, matching the precedent in
// scripts/ci-playwright-timeout.test.ts: it has to survive `${{ }}` expressions
// and block scalars, and it must read the `if:` text VERBATIM (a loader would
// hand back a folded string whose newlines are already gone).

export interface Job {
  name: string;
  needs: string[];
  /** The raw `if:` expression text, or null when the job declares none. */
  ifExpr: string | null;
  /** Job-level `outputs:` keys. */
  outputs: string[];
}

export function parseJobs(src: string): Job[] {
  const lines = src.split('\n').map((l) => l.replace(/\r$/, ''));
  const jobs: Job[] = [];
  let cur: Job | null = null;
  let inJobsBlock = false;

  const indentOf = (l: string) => l.length - l.trimStart().length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line) || line.trim() === '') continue;

    if (/^jobs:\s*$/.test(line)) {
      inJobsBlock = true;
      continue;
    }
    if (!inJobsBlock) continue;
    // A key back at column 0 ends the jobs block.
    if (indentOf(line) === 0) break;

    const jobStart = /^ {2}([A-Za-z0-9][A-Za-z0-9_-]*):\s*$/.exec(line);
    if (jobStart) {
      if (cur) jobs.push(cur);
      cur = { name: jobStart[1], needs: [], ifExpr: null, outputs: [] };
      continue;
    }
    if (!cur) continue;

    // Only job-level keys (4-space indent) — never a step's `if:`/`id:`.
    const needs = /^ {4}needs:\s*(.*)$/.exec(line);
    if (needs) {
      const rest = needs[1].trim();
      if (rest.startsWith('[')) {
        cur.needs = rest
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      } else if (rest) {
        cur.needs = [rest];
      } else {
        // block sequence: `- name` lines below
        for (let j = i + 1; j < lines.length; j++) {
          const m = /^ {6}-\s*(\S+)\s*$/.exec(lines[j]);
          if (!m) break;
          cur.needs.push(m[1]);
          i = j;
        }
      }
      continue;
    }

    const outputs = /^ {4}outputs:\s*$/.exec(line);
    if (outputs) {
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*#/.test(lines[j]) || lines[j].trim() === '') continue;
        const m = /^ {6}([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[j]);
        if (!m) break;
        cur.outputs.push(m[1]);
        i = j;
      }
      continue;
    }

    const cond = /^ {4}if:\s*(.*)$/.exec(line);
    if (cond) {
      const rest = cond[1].trim();
      if (rest && !/^[|>][-+]?$/.test(rest)) {
        cur.ifExpr = rest;
      } else {
        // Block scalar — take every following line indented deeper than the key.
        const body: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() === '') continue;
          if (indentOf(lines[j]) <= 4) break;
          body.push(lines[j].trim());
          i = j;
        }
        cur.ifExpr = body.join('\n');
      }
      continue;
    }
  }
  if (cur) jobs.push(cur);
  return jobs;
}

// ─────────────────────── the GitHub expression evaluator ────────────────────
// Deliberately a translator to JS rather than a regex soup: `==` inside a
// string literal, or a job name containing `-`, both break the naive version.

type Ctx = {
  inputs: Record<string, string>;
  needs: Record<string, { result: string; outputs: Record<string, string> }>;
};

/** Translate the supported GitHub-expression subset to a JS expression. */
export function toJs(expr: string): string {
  const s = expr.replace(/\$\{\{/g, ' ').replace(/\}\}/g, ' ');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      out += ' ';
      i++;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let lit = '';
      let closed = false;
      while (j < s.length) {
        if (s[j] === "'" && s[j + 1] === "'") {
          lit += "'";
          j += 2;
          continue;
        }
        if (s[j] === "'") {
          closed = true;
          break;
        }
        lit += s[j];
        j++;
      }
      if (!closed) throw new Error(`unterminated string literal in: ${expr}`);
      out += JSON.stringify(lit);
      i = j + 1;
      continue;
    }
    if (s.startsWith('&&', i) || s.startsWith('||', i)) {
      out += s.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (s.startsWith('==', i)) {
      out += '===';
      i += 2;
      continue;
    }
    if (s.startsWith('!=', i)) {
      out += '!==';
      i += 2;
      continue;
    }
    if (c === '(' || c === ')' || c === '!') {
      out += c;
      i++;
      continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(s.slice(i));
    if (!m) throw new Error(`unsupported token '${c}' at ${i} in: ${expr}`);
    const path = m[0];
    i += path.length;
    let k = i;
    while (k < s.length && /\s/.test(s[k])) k++;
    if (s[k] === '(') {
      let e = k + 1;
      while (e < s.length && /\s/.test(s[e])) e++;
      if (s[e] !== ')') throw new Error(`only zero-arg functions supported: ${path}(…)`);
      out += `FN[${JSON.stringify(path)}]()`;
      i = e + 1;
      continue;
    }
    if (path === 'true' || path === 'false') {
      out += path;
      continue;
    }
    out += `GET(${JSON.stringify(path.split('.'))})`;
  }
  return out;
}

/** GitHub returns the empty string for an unset context value, never undefined. */
function makeGet(ctx: Ctx) {
  return (segs: string[]): string | boolean => {
    let node: unknown = ctx;
    for (const seg of segs) {
      if (node === null || typeof node !== 'object') return '';
      node = (node as Record<string, unknown>)[seg];
      if (node === undefined) return '';
    }
    return node as string;
  };
}

export function evaluate(expr: string, ctx: Ctx, needs: string[]): boolean {
  const results = needs.map((n) => ctx.needs[n]?.result ?? 'skipped');
  const FN: Record<string, () => boolean> = {
    always: () => true,
    // success(): every needed job succeeded. A skipped need does NOT satisfy it
    // — that propagation is the whole bug this file exists for.
    success: () => results.every((r) => r === 'success'),
    failure: () => results.some((r) => r === 'failure'),
    cancelled: () => false,
  };
  const fn = new Function('GET', 'FN', `"use strict"; return (${toJs(expr)});`);
  return Boolean(fn(makeGet(ctx), FN));
}

// ─────────────────────────── the job-graph simulator ────────────────────────

export interface RunSpec {
  result: 'success' | 'failure';
  pushed?: 'true' | 'false';
}

/**
 * Resolve every job's result under one dispatch.
 *
 * GitHub's rule: a job with `needs:` and no `if:` defaults to `success()`; a
 * job whose `if:` contains NO status-check function is implicitly ANDed with
 * `success()`. Only an explicit status function lets a job outlive a skipped or
 * failed dependency.
 */
export function simulate(
  jobs: Job[],
  inputs: Record<string, string>,
  runs: Record<string, RunSpec>,
): Record<string, { result: string; outputs: Record<string, string> }> {
  const ctx: Ctx = { inputs, needs: {} };
  for (const job of jobs) {
    for (const dep of job.needs) {
      if (!(dep in ctx.needs)) {
        throw new Error(
          `job '${job.name}' needs '${dep}', which has not been resolved yet — ` +
            'the workflow file is not in topological order, so this simulation is invalid.',
        );
      }
    }
    const raw = job.ifExpr ?? 'success()';
    const hasStatusFn = /\b(success|always|failure|cancelled)\s*\(/.test(raw);
    const expr = hasStatusFn ? raw : `success() && (${raw})`;
    if (!evaluate(expr, ctx, job.needs)) {
      ctx.needs[job.name] = { result: 'skipped', outputs: {} };
      continue;
    }
    const spec = runs[job.name] ?? { result: 'success' as const };
    ctx.needs[job.name] = {
      result: spec.result,
      outputs: spec.pushed === undefined ? {} : { pushed: spec.pushed },
    };
  }
  return ctx.needs;
}

const SRC = readFileSync(WORKFLOW, 'utf8');
const JOBS = parseJobs(SRC);
const byName = (n: string) => JOBS.find((j) => j.name === n);

/** Did `revalidate` run under this dispatch? */
function revalidateRuns(
  inputs: Record<string, string>,
  runs: Record<string, RunSpec>,
  jobs: Job[] = JOBS,
): boolean {
  return simulate(jobs, inputs, runs).revalidate.result !== 'skipped';
}

const CAPTURED: RunSpec = { result: 'success', pushed: 'true' };
const NOTHING: RunSpec = { result: 'success', pushed: 'false' };
const FAILED: RunSpec = { result: 'failure' };

describe('vrt-update revalidate fires when — and only when — a baseline was pushed', () => {
  it('the scan is not vacuous — it found the jobs and their wiring', () => {
    // ⚠ A BARE GREEN BELOW WOULD BE INDISTINGUISHABLE FROM A BROKEN SCANNER.
    // ⚠ THREE JOBS SINCE #2249. The capture is a 6-way matrix now, and six
    // jobs cannot each push to one branch without racing — so the shards
    // upload and `collect` makes the single commit. `revalidate` therefore
    // hangs off `collect`, which is the job that knows whether anything was
    // actually pushed.
    expect(JOBS.map((j) => j.name)).toEqual(['capture', 'collect', 'revalidate']);
    expect(
      byName('capture')!.ifExpr,
      'the capture job grew an `if:`. If a platform/scope guard is coming back, the ' +
        'skip-propagation hazard comes back with it — restore the matrix cases below ' +
        'and re-read the header before shipping it.',
    ).toBeNull();
    expect(byName('revalidate')!.needs).toEqual(['collect']);
    // The collector runs on `always()` ON PURPOSE: five good shards must still
    // land their baselines when a sixth dies. That is the whole point of
    // sharding a capture, so it is asserted rather than left to read as a slip.
    expect(byName('collect')!.needs).toEqual(['capture']);
    expect(byName('collect')!.ifExpr, 'collect must run even if a shard failed').toContain('always()');
    expect(
      byName('revalidate')!.ifExpr,
      'revalidate has NO `if:` — with `needs: capture` that defaults to success(), which ' +
        'a capture that rewrote NOTHING satisfies, so the PR gets close+reopened and ~25 ' +
        'min of CI burns against baselines that never moved.',
    ).not.toBeNull();
    // The `pushed` clause is only meaningful if the capture job actually
    // exposes that output; a missing wiring would make revalidate unreachable.
    expect(byName('collect')!.outputs, 'the COMMITTING job must expose `pushed`').toContain('pushed');
  });

  it.each([
    ['baselines captured and pushed', { collect: CAPTURED }, true],
    ['the commit job FAILED', { collect: FAILED }, false],
    ['capture ran and rewrote NOTHING', { collect: NOTHING }, false],
  ] as [string, Record<string, RunSpec>, boolean][])(
    'case: %s → revalidate runs = %s',
    (_label, runs, expected) => {
      expect(revalidateRuns({}, runs)).toBe(expected);
    },
  );

  it('NEGATIVE CONTROL: an if-LESS revalidate re-fires CI over a capture that pushed nothing', () => {
    // The permanent proof that the simulator can SEE the failure this `if:`
    // exists to prevent. Strip it and a zero-file capture — which is a SUCCESS
    // as far as the job is concerned — still close+reopens the PR.
    const broken = JOBS.map((j) => (j.name === 'revalidate' ? { ...j, ifExpr: null } : j));
    expect(revalidateRuns({}, { collect: NOTHING }, broken)).toBe(true);
    // The shipped condition rejects it.
    expect(revalidateRuns({}, { collect: NOTHING })).toBe(false);
    // …and both agree that a FAILED capture never re-validates, because
    // `success()` already covers that half. The `if:` is doing the OTHER half.
    expect(revalidateRuns({}, { collect: FAILED }, broken)).toBe(false);
  });

  it('NEGATIVE CONTROL: a bare `always()` would re-validate a FAILED capture', () => {
    // The other direction — the naive fix is not merely weaker, it is wrong.
    const naive = JOBS.map((j) =>
      j.name === 'revalidate' ? { ...j, ifExpr: 'always()' } : j,
    );
    expect(revalidateRuns({}, { collect: FAILED }, naive)).toBe(true);
    expect(revalidateRuns({}, { collect: NOTHING }, naive)).toBe(true);
    // The shipped condition rejects both.
    expect(revalidateRuns({}, { collect: FAILED })).toBe(false);
    expect(revalidateRuns({}, { collect: NOTHING })).toBe(false);
  });

  it('SKIP PROPAGATION is still modelled, though this workflow no longer exercises it', () => {
    // The matrix is gone, so nothing in the real file can produce a skipped
    // dependency any more — which means the simulator's most important
    // behaviour would go untested and could rot silently before the next
    // workflow that needs it. Exercise it against a SYNTHETIC two-job shape
    // identical to the one this workflow shipped with, using the SAME
    // `simulate` the cases above call.
    const matrix: Job[] = [
      { name: 'capture', needs: [], ifExpr: "inputs.platform != 'darwin'", outputs: ['pushed'] },
      { name: 'other', needs: [], ifExpr: "inputs.platform != 'linux'", outputs: ['pushed'] },
      { name: 'revalidate', needs: ['capture', 'other'], ifExpr: null, outputs: [] },
    ];
    const linuxOnly = simulate(matrix, { platform: 'linux' }, { collect: CAPTURED });
    expect(linuxOnly.other.result, 'the guarded sibling must skip').toBe('skipped');
    expect(
      linuxOnly.revalidate.result,
      'a SKIPPED dependency must propagate into an if-less dependent — that propagation ' +
        'IS the bug this file was written for, and a simulator that stopped modelling it ' +
        'would pass every other case in here vacuously.',
    ).toBe('skipped');
    // …and the reason it looked fine for so long: both-platform DID work.
    const both = simulate(matrix, { platform: 'both' }, { capture: CAPTURED, other: CAPTURED });
    expect(both.revalidate.result).not.toBe('skipped');
  });

  it('NEGATIVE CONTROL: the evaluator is not stuck returning one value', () => {
    // Validate the instrument itself: both branches of each construct, and a
    // loud throw rather than a silent `false` on anything unsupported.
    const ctx: Ctx = {
      inputs: { platform: 'linux' },
      needs: { a: { result: 'success', outputs: { pushed: 'true' } } },
    };
    expect(evaluate("inputs.platform == 'linux'", ctx, [])).toBe(true);
    expect(evaluate("inputs.platform == 'darwin'", ctx, [])).toBe(false);
    expect(evaluate("needs.a.outputs.pushed == 'true'", ctx, ['a'])).toBe(true);
    // An unset output reads as '' — never as undefined, and never as truthy.
    expect(evaluate("needs.a.outputs.nope == 'true'", ctx, ['a'])).toBe(false);
    expect(evaluate('success()', ctx, ['a'])).toBe(true);
    expect(evaluate('success()', { ...ctx, needs: {} }, ['gone'])).toBe(false);
    expect(evaluate('always()', { ...ctx, needs: {} }, ['gone'])).toBe(true);
    expect(() => evaluate('inputs.platform =~ /x/', ctx, [])).toThrow();
  });
});
