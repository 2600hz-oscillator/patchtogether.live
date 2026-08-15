// packages/web/src/lib/docs/docs-facts.test.ts
//
// Prose that states a FACT about the tree must match the tree.
//
// Measured 2026-08-12 (#1495): README.md claimed "45 modules total · 30 audio ·
// 15 video" while the registries held ~4x that, and two runbooks enumerated DB
// schemas 001-003 while 001-006 existed on disk. Nothing failed. Both are
// glob/directory-driven populations, so the docs could drift indefinitely and
// silently — and agents cite these files when planning.
//
// The registries are the authority here, not a number typed in this file: the
// counts are DERIVED at test time by importing the live registries, exactly the
// way the app builds them. There is no expected-count literal anywhere in this
// file, so a new module makes the README wrong (and this test red) without ever
// making this test stale.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../../../..');
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

/** Every integer in the text, so a claim can be checked without guessing its phrasing. */
const intsIn = (s: string) => [...s.matchAll(/\b(\d{1,4})\b/g)].map((m) => Number(m[1]));

describe('README module counts match the live registries', () => {
  const audio = listModuleDefs().length;
  const video = listVideoModuleDefs().length;
  const meta = listMetaModuleDefs().length;
  const readme = read('README.md');

  it('the registries are non-empty (the derivation is not vacuous)', () => {
    // Anchored to NAMES the registries must contain, never to a count — if the
    // glob silently resolved nothing, every assertion below would pass vacuously.
    const ids = listModuleDefs().map((d) => d.type);
    expect(ids).toContain('adsr');
    expect(listVideoModuleDefs().map((d) => d.type).length).toBeGreaterThan(0);
  });

  // Each sentence that states a count is checked against the derived number.
  // Failure message carries the live values so the fix is a copy-paste.
  it('every line claiming an audio/video module count is current', () => {
    // SCOPE, stated rather than assumed: this matches only counts qualified by
    // the word "module(s)". A bare "N audio …" is NOT a module count — README
    // line 146 says "10 audio channels packing 5 voice pairs", and an earlier
    // version of this predicate flagged it. Consequence: a count split across a
    // line break so that the number and the word "modules" land on different
    // lines is not checked (README:32-33 is one such sentence — the "68 video
    // modules" half is checked, the "120" half is not).
    const claims = readme
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /\b\d+\s+(?:audio|video)\s+modules?\b|\bmodules total\b/i.test(line));

    expect(
      claims.length,
      'README no longer states a module count anywhere — if that is intentional, delete this assertion; it exists to keep a STATED count honest',
    ).toBeGreaterThan(0);

    const wrong = claims.filter(({ line }) => {
      const nums = intsIn(line);
      // A line is right if the numbers it uses are all live values. This is
      // deliberately loose about phrasing and strict about the numbers.
      return !nums.every((n) => n === audio || n === video || n === meta || n === audio + video || n === audio + video + meta);
    });

    expect(
      wrong.map(({ n, line }) => `README.md:${n}: ${line.trim().slice(0, 90)}`),
      `live registry counts: ${audio} audio, ${video} video, ${meta} meta (${audio + video + meta} total)`,
    ).toEqual([]);
  });
});

describe('runbooks enumerate the DB schemas that exist', () => {
  const onDisk = readdirSync(join(REPO_ROOT, 'db/schema'))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  it('finds schema files at all (not vacuous)', () => {
    expect(onDisk).toContain('001_init.sql');
  });

  // A runbook that lists SOME schemas must not stop short of the newest one:
  // a reader following it would provision an out-of-date database. Checking
  // "mentions the highest-numbered file" is the property that matters, and it
  // needs no list in this test.
  const newest = () => onDisk[onDisk.length - 1];

  for (const doc of ['runbooks/architecture.md', 'runbooks/integrations/neon-postgres.md']) {
    it(`${doc} does not stop short of the newest schema`, () => {
      const text = read(doc);
      const mentionsAny = onDisk.some((f) => text.includes(f));
      if (!mentionsAny) return; // the doc doesn't enumerate schemas — nothing to keep current
      expect(
        text.includes(newest()),
        `${doc} enumerates DB schemas but omits the newest (${newest()}) — a reader following it provisions a stale database`,
      ).toBe(true);
    });
  }
});

describe('docs do not point at files that no longer exist', () => {
  // README cited `docs/adr/004-cv-range-convention.md`, which does not exist —
  // the CV range convention lives in docs/adr/004-cv-range-convention.md. A
  // dangling pointer sends an agent looking for authority that isn't there.
  it('README repo-relative doc references resolve', () => {
    const readme = read('README.md');
    const refs = new Set<string>();
    for (const [, p] of readme.matchAll(/`((?:docs|runbooks|\.myrobots)\/[A-Za-z0-9._/-]+\.md)`/g)) {
      refs.add(p);
    }
    expect(refs.size, 'no repo-relative doc references found to check').toBeGreaterThan(0);

    const dangling = [...refs].filter((p) => {
      try {
        readFileSync(join(REPO_ROOT, p), 'utf8');
        return false;
      } catch {
        return true;
      }
    });
    expect(dangling, 'README cites files that do not exist').toEqual([]);
  });
});
