// scripts/agent-context.test.ts
//
// The agent-facing context files must describe the tree that actually exists.
//
// CLAUDE.md carries an index of `.claude/skills/`, and CLAUDE.md + AGENTS.md
// point at process docs. An index is exactly the kind of hand-maintained prose
// that rots silently: a skill added without an index row is invisible to every
// agent, and an index row naming a deleted skill sends them looking for a file
// that isn't there. Neither failure reddens anything on its own.
//
// ANCHORED TO THE ARTIFACT, both directions, and DERIVED — this asserts set
// identity between the index and the directory listing, never a count. Adding a
// skill and its row together is green; doing either alone is red.
//
// The same file also holds the two `.myrobots/` gates (#1494), because
// `.myrobots` is agent-consumed context under the same authority statement:
//   1. it must not carry operational secret topology, and
//   2. the standing docs must not point at records it no longer contains.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..');
const CLAUDE_MD = join(REPO_ROOT, 'CLAUDE.md');
const AGENTS_MD = join(REPO_ROOT, 'AGENTS.md');
const SKILLS_DIR = join(REPO_ROOT, '.claude', 'skills');

/**
 * Skills on disk, in BOTH forms Claude Code supports:
 *
 *  - flat  — `<name>.md`                    (this repo's hand-authored skills)
 *  - packaged — `<name>/SKILL.md`           (what `@playwright/cli install --skills`
 *                                            writes, and the format vendored skills use)
 *
 * The flat-only version of this function was blind to the packaged form: a
 * vendored skill directory produced no `.md` at the top level, so it passed the
 * index check by being invisible rather than by being listed. That is the same
 * "the filter quietly redefined the subject" failure this gate exists to catch.
 */
function skillsOnDisk(): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      names.push(entry.name.replace(/\.md$/, ''));
    } else if (entry.isDirectory() && existsSync(join(SKILLS_DIR, entry.name, 'SKILL.md'))) {
      names.push(entry.name);
    }
  }
  return names.sort();
}

/**
 * Skill names cited in CLAUDE.md's index table.
 *
 * The table lives under the `## The skills` heading; rows name one or more
 * skills in backticks (`a` · `b`). Parsing only that section keeps an inline
 * `.claude/skills/foo.md` pointer elsewhere in the file from counting as an
 * index entry — the index is the table, and only the table.
 */
function skillsInIndex(claudeMd: string): string[] {
  const start = claudeMd.indexOf('## The skills');
  expect(start, 'CLAUDE.md must carry a `## The skills` index section').toBeGreaterThan(-1);
  const section = claudeMd.slice(start);
  const rows = section.split('\n').filter((l) => l.startsWith('|'));
  const names = new Set<string>();
  for (const row of rows) {
    for (const [, name] of row.matchAll(/`([a-z0-9-]+)`/g)) names.add(name);
  }
  return [...names].sort();
}

/**
 * Tracked files under `pathspecs`, repo-relative.
 *
 * Anchored to what is actually COMMITTED, not to what happens to be on disk:
 * only tracked content can leak, and an agent's untracked local scratch under
 * `.myrobots/` is none of this gate's business.
 */
function trackedFiles(...pathspecs: string[]): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
}

type Doc = { path: string; text: string };

const readDocs = (paths: string[]): Doc[] =>
  paths.map((path) => ({ path, text: readFileSync(join(REPO_ROOT, path), 'utf8') }));

/** Every tracked record under `.myrobots/` (all of it is text — .md/.html/no-ext). */
const myrobotsRecords = (): Doc[] => readDocs(trackedFiles('.myrobots'));

/**
 * The STANDING docs — the ones an agent is told to trust (authority tiers 2-5
 * in AGENTS.md). A dead pointer here is worse than one in a session record,
 * because these are read as current.
 */
const surfaceDocs = (): Doc[] =>
  readDocs(
    trackedFiles('CLAUDE.md', 'AGENTS.md', 'README.md', '.claude/skills', 'docs', 'runbooks').filter(
      (p) => p.endsWith('.md'),
    ),
  );

/** `.myrobots/...` record paths cited in prose. */
function citedMyrobotsPaths(text: string): string[] {
  return [...text.matchAll(/\.myrobots\/[A-Za-z0-9._/-]+\.(?:md|html)/g)].map((m) => m[0]);
}

/**
 * Secret TOPOLOGY — not values. The 2026-08-11 dawless record wrote down the
 * Neon project id and that the key sits at a relative `../neon.txt`; the
 * licence-split plan enumerated which env vars hold secrets. Neither leaked a
 * credential, and that is exactly why nothing reddened: the map to the keys
 * reads like ordinary prose. `runbooks/secrets-and-accounts.md` is the single
 * home for that inventory, and it is itself values-free by policy.
 *
 * Each entry carries its own `sample` — the leak shape it was written for —
 * which the negative-control leg re-runs through this same predicate, so a
 * pattern cannot rot into a permanently-green regex.
 *
 * ⚠ WHAT THIS GATE CANNOT SEE, stated so a green run is not read as more than
 * it is:
 *   - Only `.myrobots/` is scanned. `runbooks/`, `docs/observability/`,
 *     `.claude/skills/deploy-pipeline.md`, `packages/`, `scripts/` and the
 *     workflows all name secret VARIABLES legitimately — that is their job.
 *   - `DATABASE_URL` is deliberately absent from the patterns. `.myrobots`
 *     records discuss it as a TEST PRECONDITION ("@collab is vacuous without
 *     DATABASE_URL"), which is a behavioural fact about the suite, not a map to
 *     a credential. Adding it would produce noise, and noise gets exempted.
 *   - It reads bytes at HEAD. Git history is out of scope (issue #1494 records
 *     that nothing here was ever a credential value, so there is nothing to
 *     scrub).
 */
const SECRET_TOPOLOGY: ReadonlyArray<{ name: string; re: RegExp; sample: string; why: string }> = [
  {
    name: 'key-file path',
    re: /neon\.txt|cf\.env|\.env\.local|\bsecrets?\.(?:txt|env|json)\b/i,
    sample: 'Neon topology is branch-per-tier, key in `../neon.txt`',
    why: 'names the file an operator keeps credentials in',
  },
  {
    name: 'secret env-var inventory',
    re: /\b(?:CLERK_SECRET_KEY|INVITE_SECRET|BETA_GATE_[A-Z_]+|NEON_API_KEY|NEON_PROJECT_ID|SENTRY_AUTH_TOKEN|CLOUDFLARE_API_TOKEN|FLY_API_TOKEN|BETTERSTACK_HEARTBEAT_URL)\b/,
    sample: 'already gitignored (`INVITE_SECRET`, `CLERK_SECRET_KEY`, `BETA_GATE_PASS`)',
    why: 'enumerates which variables hold secrets',
  },
  {
    name: 'account / endpoint identifier',
    re: /\bep-[a-z0-9]+(?:-[a-z0-9]+)*-\d{6,}\b|\.neon\.tech\b/i,
    // SYNTHETIC id on purpose — a gate against publishing account identifiers
    // must not publish one in its own fixture.
    sample: 'one project, at ep-example-endpoint-00000000.us-east-2.aws.neon.tech',
    why: 'a real account/endpoint identifier — topology, not design',
  },
  {
    name: 'credential-shaped value',
    re: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{8,}|\bnpg_[A-Za-z0-9]{16,}|\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    sample: 'CLERK key sk_live_EXAMPLENOTAREALKEY0123',
    why: 'an actual credential value — stop and rotate, do not just delete',
  },
  {
    name: 'connection string with a password',
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:/@]+:[^\s@]+@(?!localhost|127\.0\.0\.1)/i,
    sample: 'postgresql://user:hunter2@db.example.com/main',
    why: 'a DSN carrying a password against a non-local host',
  },
];

/** Offending `path ↳ pattern` lines, one per (file, pattern) hit. */
function scanForSecretTopology(docs: Doc[]): string[] {
  return docs.flatMap((d) =>
    SECRET_TOPOLOGY.filter((p) => p.re.test(d.text)).map(
      (p) => `${d.path}\n      ↳ ${p.name}: ${p.why}`,
    ),
  );
}

describe('agent context files describe the real tree', () => {
  it('every skill on disk is listed in CLAUDE.md, and every listed skill exists', () => {
    const onDisk = skillsOnDisk();
    const indexed = skillsInIndex(readFileSync(CLAUDE_MD, 'utf8'));

    // Both directions, each with its own message so a red run says WHICH way it broke.
    const missingFromIndex = onDisk.filter((s) => !indexed.includes(s));
    const missingFromDisk = indexed.filter((s) => !onDisk.includes(s));

    expect(
      missingFromIndex,
      'skills exist but no CLAUDE.md index row names them — agents will never load them',
    ).toEqual([]);
    expect(
      missingFromDisk,
      'CLAUDE.md names skills that do not exist — a stale row points agents at nothing',
    ).toEqual([]);
  });

  it('the docs CLAUDE.md and AGENTS.md point at are really there', () => {
    const cited = new Set<string>();
    for (const file of [CLAUDE_MD, AGENTS_MD]) {
      const text = readFileSync(file, 'utf8');
      for (const [, path] of text.matchAll(/\((docs\/[a-z0-9./-]+\.md)\)/g)) cited.add(path);
    }
    // A pointer is only useful if it resolves; this is the same anchor rule as above.
    expect([...cited].filter((p) => !existsSync(join(REPO_ROOT, p)))).toEqual([]);
    // Non-vacuity: anchored to a NAME the set must contain, not to a count.
    expect([...cited]).toContain('docs/process/issue-workflow.md');
  });

  it('every `.myrobots` record the standing docs point at still exists', () => {
    const docs = surfaceDocs();
    // Non-vacuity, anchored to a NAME the surface must contain (never a count):
    // if the reader silently returned nothing, the assertion below would pass
    // by having looked at nothing.
    expect(
      docs.map((d) => d.path),
      'the doc surface reader found no CLAUDE.md — it read the wrong tree',
    ).toContain('CLAUDE.md');

    const dangling = docs.flatMap((d) =>
      citedMyrobotsPaths(d.text)
        .filter((p) => !existsSync(join(REPO_ROOT, p)))
        .map((p) => `${d.path} → ${p}`),
    );

    expect(
      dangling,
      'a standing doc points at a `.myrobots` record that is not there — the ' +
        'three 2026-08 janitorial sweeps deleted records the rest of the tree ' +
        'still cited, and a dead pointer sends an agent looking for context ' +
        'that no longer exists. Move the durable part into the ADR/skill and ' +
        'drop the pointer.',
    ).toEqual([]);
  });

  it('`.myrobots` carries no secret topology', () => {
    const records = myrobotsRecords();
    // Non-vacuity WITHOUT a count: an empty read would make the scan silent.
    expect(
      records.map((r) => r.path),
      'no tracked file under .myrobots/ was read — the scan below would pass ' +
        'by looking at nothing. If `.myrobots/` is gone for good, DELETE this ' +
        'gate rather than leave a scan of an empty set standing green.',
    ).not.toEqual([]);

    expect(
      scanForSecretTopology(records),
      'secret topology in `.myrobots` — an agent reading a session record must ' +
        'not learn which variables hold secrets, which file the keys are in, or ' +
        'which account/endpoint we run on. `runbooks/secrets-and-accounts.md` ' +
        'is the ONE home for that; redact the passage and point at the runbook.',
    ).toEqual([]);
  });

  it('the secret-topology scan is negative-controlled in both directions', () => {
    // Direction 1 — each pattern still matches the leak shape it was written
    // for. A pattern that silently stops matching turns the gate above green by
    // making it blind, which is indistinguishable from "there is no leak".
    const blind = SECRET_TOPOLOGY.filter(
      (p) => scanForSecretTopology([{ path: 'sample', text: p.sample }]).length === 0,
    ).map((p) => p.name);
    expect(blind, 'a pattern no longer matches its own sample leak — the scan is blind').toEqual(
      [],
    );

    // Direction 2 — a leak planted in the REAL corpus surfaces, and surfaces
    // alone. This exercises the same plumbing the gate uses (so it proves the
    // reader reaches the corpus), and proves ordinary prose does not trip it.
    const canary = { path: '.myrobots/CANARY.md', text: 'the key lives in `../neon.txt`' };
    const benign = {
      path: '.myrobots/BENIGN.md',
      // DATABASE_URL is deliberately NOT a pattern — see the note on
      // SECRET_TOPOLOGY. This asserts that decision instead of leaving it prose.
      text: '@collab is vacuous without DATABASE_URL; see runbooks/architecture.md.',
    };
    expect(scanForSecretTopology([...myrobotsRecords(), benign, canary])).toEqual([
      `${canary.path}\n      ↳ key-file path: names the file an operator keeps credentials in`,
    ]);
  });

  it('AGENTS.md states the authority order and the issue rule', () => {
    const agents = readFileSync(AGENTS_MD, 'utf8');
    // `.myrobots` being evidence rather than instruction is an owner ruling that
    // agents get wrong by default — if the entry point stops saying it, that is a
    // regression in the thing this file exists to do.
    expect(agents).toMatch(/evidence, not instruction/i);
    expect(agents).toMatch(/Fixes #N/);
  });
});
