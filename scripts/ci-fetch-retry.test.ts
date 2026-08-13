// scripts/ci-fetch-retry.test.ts
//
// Every network fetch in CI retries, because a required gate must not be one
// third-party hiccup away from reddening main.
//
// Measured 2026-08-12 (#1534): main run 31633557811 went red on
//
//     curl: (22) The requested URL returned error: 503
//
// downloading the pinned actionlint tarball from the GitHub releases CDN. The
// `actionlint` job failed, and the umbrella failed with it because $ACTIONLINT
// is in its failing `if`. No code was implicated. At the time twelve further
// fetches — the DOOM WAD, from a third-party mirror flakier than GitHub's —
// carried the same unretried shape.
//
// ⚠ `--retry-all-errors` is the load-bearing flag and is asserted separately.
// `--retry N` alone does NOT retry a 503: curl treats a well-formed HTTP error
// response as a completed request, not a transport failure. Verified against a
// local server that 503s twice then serves:
//
//     curl -sSfL                        → exit 22 after 1 request  (main's exact error)
//     curl -sSfL --retry 3 --retry-all-errors → exit 0  after 3 requests
//
// So a guard that only looked for `--retry` would pass a config that still
// cannot survive the failure this exists to prevent.
//
// DENY BY DEFAULT: a new `curl` fetching a URL fails this test unless it carries
// the flags or is named below with a reason. Anchored to the artifact — the
// exemption names a file and the reason it is safe, and it reddens if the shape
// it describes is gone.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..');
const WORKFLOWS = join(REPO_ROOT, '.github', 'workflows');

/**
 * Fetches that legitimately need no retry, each with the reason it is safe.
 * A file listed here must still CONTAIN the shape described, so a stale entry
 * cannot sit here unnoticed after the code moves on.
 */
const EXEMPT: ReadonlyArray<{ file: string; match: string; why: string }> = [
  {
    file: 'Taskfile.yml',
    match: 'if curl -fL --max-time 30',
    why: 'local dev DOOM-WAD fetch inside an `if` with a fallback path — a failed fetch is handled, not fatal, and --max-time 30 bounds it deliberately',
  },
];

/**
 * Whole `curl` invocations, with their starting line number.
 *
 * Continuation lines are JOINED first. These commands are written across
 * several backslash-continued lines, so a line-based scan both misses the URL
 * (it lives two lines below the flags) and would happily pass a `--retry` that
 * sits on a continuation line of an otherwise unretried command. Join, then
 * match — the unit being checked is the command, not the line.
 */
function curlFetches(file: string, text: string) {
  const lines = text.split('\n');
  const out: Array<{ file: string; n: number; line: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const start = i;
    let joined = lines[i].trim();
    while (joined.endsWith('\\') && i + 1 < lines.length) {
      joined = `${joined.slice(0, -1).trim()} ${lines[++i].trim()}`;
    }
    // A commented-out example is prose, not a fetch.
    if (/(^|\s)curl\s/.test(joined) && !joined.startsWith('#')) {
      out.push({ file, n: start + 1, line: joined });
    }
  }
  return out;
}

function allFetches() {
  const files = readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith('.yml'))
    .map((f) => join('.github/workflows', f));
  files.push('Taskfile.yml');

  return files.flatMap((rel) => curlFetches(rel, readFileSync(join(REPO_ROOT, rel), 'utf8')));
}

const isExempt = (f: { file: string; line: string }) =>
  EXEMPT.some((e) => e.file === f.file && f.line.includes(e.match));

describe('every CI network fetch survives a transient failure', () => {
  const fetches = allFetches();

  it('finds fetches to check at all (the guard is not vacuous)', () => {
    // Anchored to a NAME the population must contain, never to a count: if the
    // actionlint fetch stops existing, this guard has lost its subject and
    // should be reconsidered rather than silently passing over an empty set.
    expect(fetches.some((f) => f.line.includes('actionlint'))).toBe(true);
  });

  it('retries — no fetch may fail on the first attempt', () => {
    const offenders = fetches
      .filter((f) => !isExempt(f))
      .filter((f) => !/--retry\s+\d/.test(f.line))
      .map((f) => `${f.file}:${f.n}`);
    expect(offenders, 'add `--retry 3 --retry-delay 2 --retry-all-errors`').toEqual([]);
  });

  it('retries on HTTP ERROR RESPONSES too — --retry alone does not retry a 503', () => {
    const offenders = fetches
      .filter((f) => !isExempt(f))
      .filter((f) => /--retry\s+\d/.test(f.line) && !f.line.includes('--retry-all-errors'))
      .map((f) => `${f.file}:${f.n}`);
    expect(
      offenders,
      '`--retry N` without `--retry-all-errors` does NOT retry a 503 — the exact failure that reddened main',
    ).toEqual([]);
  });

  it('every exemption still describes something that exists', () => {
    const stale = EXEMPT.filter(
      (e) => !readFileSync(join(REPO_ROOT, e.file), 'utf8').includes(e.match),
    ).map((e) => `${e.file}: '${e.match}'`);
    expect(stale, 'an exemption naming a shape that is gone is one nobody is watching').toEqual([]);
  });
});
