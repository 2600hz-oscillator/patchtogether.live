// scripts/agent-context.test.ts
//
// The agent-facing context files must describe the tree that actually exists.
//
// Claude Code discovers packaged skills under `.claude/skills/`; Codex
// discovers the shared subset under `.agents/skills/`. The latter are
// symlinks, so one package is authoritative for both tools. This gate proves
// both discovery paths and the CLAUDE.md import rather than maintaining a prose
// index that can drift.
//
// The same file also holds the two `.myrobots/` gates (#1494), because
// `.myrobots` is agent-consumed context under the same authority statement:
//   1. it must not carry operational secret topology, and
//   2. the standing docs must not point at records it no longer contains.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..');
const CLAUDE_MD = join(REPO_ROOT, 'CLAUDE.md');
const AGENTS_MD = join(REPO_ROOT, 'AGENTS.md');
const CLAUDE_SKILLS_DIR = join(REPO_ROOT, '.claude', 'skills');
const CODEX_SKILLS_DIR = join(REPO_ROOT, '.agents', 'skills');
const CLAUDE_ONLY_SKILLS = new Set(['brief-replies']);

/**
 * Claude skills on disk. Phase 1 deliberately accepts only packaged skills:
 * every top-level entry must be a directory containing SKILL.md.
 */
function claudeSkillsOnDisk(): string[] {
  const entries = readdirSync(CLAUDE_SKILLS_DIR, { withFileTypes: true });
  const malformed = entries
    .filter(
      (entry) =>
        !entry.isDirectory() ||
        !existsSync(join(CLAUDE_SKILLS_DIR, entry.name, 'SKILL.md')),
    )
    .map((entry) => entry.name)
    .sort();
  expect(
    malformed,
    'every .claude/skills entry must be a packaged skill with SKILL.md',
  ).toEqual([]);
  return entries.map((entry) => entry.name).sort();
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
 * The STANDING docs — the ones an agent is told to trust (authority tiers 2-4
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
 *     `.claude/skills/deploy/SKILL.md`, `packages/`, `scripts/` and the
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
  it('Claude and Codex discover the intended skill packages from one source', () => {
    const claude = claudeSkillsOnDisk();
    expect(
      claude,
      'the old skill fleet must not survive the minimal cutover',
    ).toEqual(['brief-replies', 'deploy', 'module-surfaces', 'renderer-tests']);

    const codexEntries = readdirSync(CODEX_SKILLS_DIR, { withFileTypes: true });
    const codex = codexEntries.map((entry) => entry.name).sort();
    expect(codex, 'Codex must see every shared skill and no Claude-only skill').toEqual(
      claude.filter((name) => !CLAUDE_ONLY_SKILLS.has(name)),
    );

    for (const entry of codexEntries) {
      const link = join(CODEX_SKILLS_DIR, entry.name);
      expect(
        lstatSync(link).isSymbolicLink(),
        `.agents/skills/${entry.name} must be a symlink, not a duplicate`,
      ).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(join(CLAUDE_SKILLS_DIR, entry.name)));
    }
  });

  it('CLAUDE.md imports AGENTS.md and carries the Claude-only reply rule', () => {
    const claude = readFileSync(CLAUDE_MD, 'utf8');
    expect(claude).toMatch(/^@AGENTS\.md$/m);
    expect(claude).toMatch(/one to four lines/i);
    expect(claude).toMatch(/brief-replies\/SKILL\.md/);
  });

  it('the docs CLAUDE.md and AGENTS.md point at are really there', () => {
    const extract = (text: string): string[] =>
      [...text.matchAll(/\((docs\/[a-z0-9./-]+\.md)\)/g)].map(([, path]) => path);
    const sources = [CLAUDE_MD, AGENTS_MD].map((f) => readFileSync(f, 'utf8'));
    // The files were READ. An unreadable one would give an empty scan and make
    // the dangling check below agree about nothing.
    expect(sources.every((t) => t.length > 0), 'both context files must be readable').toBe(true);
    const cited = new Set(sources.flatMap(extract));
    // A pointer is only useful if it resolves; this is the same anchor rule as above.
    expect([...cited].filter((p) => !existsSync(join(REPO_ROOT, p)))).toEqual([]);

    // ⚠ THE NON-VACUITY ANCHOR IS A POSITIVE CONTROL NOW, NOT A NAME, AND THE
    // REASON IS WHAT HAPPENED TO THE LAST NAME. It read
    // `expect([...cited]).toContain('docs/design/face-migration.generated.md')`
    // — the right shape (a name, not a count) right up until the legacy-card
    // removal deleted that generated doc and the AGENTS.md sentence citing it.
    // AGENTS.md now links NO docs page, so any name would be a guess about
    // prose rather than a fact about the tree, and an empty `cited` would let
    // the dangling filter pass on nothing.
    //
    // So the extractor is proved against known answers instead: it must FIND a
    // real citation when one is present and must NOT invent one when it is not.
    // That is checkable forever, regardless of how the prose moves.
    expect(extract('see the [catalog](docs/design/game-modules.md) for more')).toEqual([
      'docs/design/game-modules.md',
    ]);
    expect(extract('a bare mention of docs/design/game-modules.md is not a link')).toEqual([]);
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

  // ── THE TREE-WIDE CITATION GATE IS DELETED (2026-08-23) ───────────────────
  //
  // It scanned EVERY tracked file for a `.myrobots/…` path that no longer
  // resolves, and it reddened CI when it found one. The subject was real (the
  // 2026-08 janitorial sweeps left 59 dead pointers in code comments) but the
  // SHAPE was wrong: a stale pointer in a comment costs a reader one failed
  // file-open, and this converted that into a blocked merge — most recently on
  // #2133, where a green PR went red because a comment named a session record a
  // sibling PR had tidied away. That is the "gate that fails on paperwork, not
  // on an event" class the 2026-08-23 CI audit is deleting.
  //
  // The STANDING-DOCS leg above is deliberately KEPT and is not the same thing:
  // its corpus is CLAUDE.md / AGENTS.md / README / skills / docs / runbooks —
  // the files agents are told to trust as current, where a dead pointer is read
  // as a live instruction rather than a footnote.

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

  it('AGENTS.md states the authority order and owner-controlled issue rule', () => {
    const agents = readFileSync(AGENTS_MD, 'utf8');
    // `.myrobots` being evidence rather than instruction is an owner ruling that
    // agents get wrong by default — if the entry point stops saying it, that is a
    // regression in the thing this file exists to do.
    expect(agents).toMatch(/evidence, not instruction/i);
    expect(agents).toMatch(/do not create or reopen GitHub issues without explicit owner approval/i);
    expect(agents).toMatch(/PRs do not require a matching issue/i);
  });
});
