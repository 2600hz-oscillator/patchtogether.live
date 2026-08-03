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
// It shipped as `needs: [linux, darwin]` with NO `if:`. A job with `needs:`
// and no `if:` defaults to `success()`, which a SKIPPED dependency does not
// satisfy — GitHub propagates the skip. Both platform jobs carry their own
// `if:` on `inputs.platform`, so a single-platform dispatch skips one of them
// and therefore skipped `revalidate` too:
//
//     platform=linux  → darwin skipped → revalidate SKIPPED
//     platform=darwin → linux  skipped → revalidate SKIPPED
//     platform=both   → revalidate runs
//
// …and single-platform is the dispatch CLAUDE.md RECOMMENDS ("pick the ONE
// platform you need — the other runner is redundant CI wall-time"). So the
// documented re-validation was notional for the recommended usage, and the run
// still reported green: a skipped job is a grey check, not a red one.
//
// ── WHY THIS IS A TEST AND NOT A COMMENT ───────────────────────────────────
// The condition now spans four clauses across three jobs and two `outputs:`
// wirings. Nothing in the YAML enforces that they compose to the intended
// behaviour, and the failure mode is SILENT IN BOTH DIRECTIONS: too strict and
// revalidate never runs again (the original bug, restored); too loose and it
// close+reopens a PR after a FAILED capture, re-firing ~25 min of CI against
// baselines that were never regenerated.
//
// So this file re-implements GitHub's job-gating semantics and runs the REAL
// workflow file through them for every dispatch case.
//
// ── WHAT THIS GATE CANNOT SEE (stated, per the blind-gates rule) ────────────
//  · It models GitHub's documented semantics, not GitHub. If Actions changes
//    how skips propagate, this agrees with the docs and not with the runner.
//  · `cancelled()` is modelled as false; a mid-run workflow cancellation is
//    outside the scenario set (the `result == 'success' || 'skipped'` clauses
//    exclude it anyway, which is asserted).
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
// The blindness that CANNOT hide: the parser's non-vacuity test pins the three
// job names and requires each to have been found with a condition. If the scan
// ever stops recognising the file, that test goes red instead of every
// simulation passing over an empty job list.

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

describe('vrt-update revalidate is reachable from a SINGLE-platform dispatch', () => {
  it('the scan is not vacuous — it found the three jobs and their wiring', () => {
    // ⚠ A BARE GREEN BELOW WOULD BE INDISTINGUISHABLE FROM A BROKEN SCANNER.
    expect(JOBS.map((j) => j.name)).toEqual(['linux', 'darwin', 'revalidate']);
    expect(byName('linux')!.ifExpr, 'linux lost its platform guard').toContain('platform');
    expect(byName('darwin')!.ifExpr, 'darwin lost its platform guard').toContain('platform');
    expect(byName('revalidate')!.needs).toEqual(['linux', 'darwin']);
    expect(
      byName('revalidate')!.ifExpr,
      'revalidate has NO `if:` — with `needs:` that defaults to success(), which a ' +
        'SKIPPED dependency does not satisfy, so every single-platform dispatch ' +
        'silently skips the close+reopen re-validation.',
    ).not.toBeNull();
    // The `pushed` clause is only meaningful if both platform jobs actually
    // expose that output; a missing wiring would make revalidate unreachable.
    expect(byName('linux')!.outputs, 'linux must expose `pushed`').toContain('pushed');
    expect(byName('darwin')!.outputs, 'darwin must expose `pushed`').toContain('pushed');
  });

  it.each([
    ['linux-only, baselines captured', 'linux', { linux: CAPTURED }, true],
    ['darwin-only, baselines captured', 'darwin', { darwin: CAPTURED }, true],
    ['both, both captured', 'both', { linux: CAPTURED, darwin: CAPTURED }, true],
    [
      'both, only linux captured anything',
      'both',
      { linux: CAPTURED, darwin: NOTHING },
      true,
    ],
    ['linux-only, capture FAILED', 'linux', { linux: FAILED }, false],
    ['darwin-only, capture FAILED', 'darwin', { darwin: FAILED }, false],
    ['both, linux FAILED', 'both', { linux: FAILED, darwin: CAPTURED }, false],
    ['both, darwin FAILED', 'both', { linux: CAPTURED, darwin: FAILED }, false],
    ['both, BOTH failed', 'both', { linux: FAILED, darwin: FAILED }, false],
    ['linux-only, captured NOTHING', 'linux', { linux: NOTHING }, false],
    ['both, captured NOTHING', 'both', { linux: NOTHING, darwin: NOTHING }, false],
  ] as [string, string, Record<string, RunSpec>, boolean][])(
    'case: %s → revalidate runs = %s',
    (_label, platform, runs, expected) => {
      expect(revalidateRuns({ platform }, runs)).toBe(expected);
    },
  );

  it('a single-platform dispatch skips the OTHER platform but still re-validates', () => {
    // The precise shape of the bug: the skip is real and expected — what must
    // not happen is that skip propagating into revalidate.
    const linuxOnly = simulate(JOBS, { platform: 'linux' }, { linux: CAPTURED });
    expect(linuxOnly.darwin.result).toBe('skipped');
    expect(linuxOnly.revalidate.result).not.toBe('skipped');

    const darwinOnly = simulate(JOBS, { platform: 'darwin' }, { darwin: CAPTURED });
    expect(darwinOnly.linux.result).toBe('skipped');
    expect(darwinOnly.revalidate.result).not.toBe('skipped');
  });

  it('NEGATIVE CONTROL: the ORIGINAL (if-less) revalidate is unreachable single-platform', () => {
    // The permanent proof that the simulator can SEE the bug. Strip the `if:`
    // from revalidate — exactly the file as shipped — and every single-platform
    // dispatch must come back skipped. If this ever passes as `true`, the
    // simulator has stopped modelling skip propagation and every green above
    // is worthless.
    const broken = JOBS.map((j) =>
      j.name === 'revalidate' ? { ...j, ifExpr: null } : j,
    );
    expect(revalidateRuns({ platform: 'linux' }, { linux: CAPTURED }, broken)).toBe(false);
    expect(revalidateRuns({ platform: 'darwin' }, { darwin: CAPTURED }, broken)).toBe(false);
    // …and the reason it looked fine for so long: platform=both DID work.
    expect(
      revalidateRuns({ platform: 'both' }, { linux: CAPTURED, darwin: CAPTURED }, broken),
    ).toBe(true);
  });

  it('NEGATIVE CONTROL: a bare `always()` would re-validate a FAILED capture', () => {
    // The other direction — the naive fix is not merely weaker, it is wrong:
    // it close+reopens the PR after a capture that produced nothing, burning a
    // full CI cycle on baselines that were never regenerated. The real
    // condition must reject what this accepts.
    const naive = JOBS.map((j) =>
      j.name === 'revalidate' ? { ...j, ifExpr: 'always()' } : j,
    );
    expect(revalidateRuns({ platform: 'linux' }, { linux: FAILED }, naive)).toBe(true);
    expect(revalidateRuns({ platform: 'linux' }, { linux: NOTHING }, naive)).toBe(true);
    // The shipped condition rejects both.
    expect(revalidateRuns({ platform: 'linux' }, { linux: FAILED })).toBe(false);
    expect(revalidateRuns({ platform: 'linux' }, { linux: NOTHING })).toBe(false);
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
