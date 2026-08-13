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

  it('AGENTS.md states the authority order and the issue rule', () => {
    const agents = readFileSync(AGENTS_MD, 'utf8');
    // `.myrobots` being evidence rather than instruction is an owner ruling that
    // agents get wrong by default — if the entry point stops saying it, that is a
    // regression in the thing this file exists to do.
    expect(agents).toMatch(/evidence, not instruction/i);
    expect(agents).toMatch(/Fixes #N/);
  });
});
