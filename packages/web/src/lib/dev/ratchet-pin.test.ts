// packages/web/src/lib/dev/ratchet-pin.test.ts
//
// THE INSTRUMENT UNDER TEST IS GIT'S MERGE, NOT OURS.
//
// The defect this file exists for is not "the number was wrong". It is "two
// branches each wrote the SAME new number and git therefore reported no
// conflict". Any test of that claim which re-implements 3-way merging is
// testing our model of git, and the model is exactly the thing that was wrong.
// So the merge legs below shell out to `git merge-file`, which IS the
// algorithm that produced the three bad merges on 2026-08-08/09.
//
// Read the merge tests as a pair. The COUNT leg is a permanent NEGATIVE
// CONTROL: it reproduces the silent-wrong merge on every run, so if git ever
// changed its behaviour (or the fixture stopped exercising the real shape) the
// pin leg's green would no longer mean anything and the count leg goes red
// first.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalizeRatchetItems,
  checkRatchetPin,
  fnv1a32,
  ratchetPin,
  ratchetPinCount,
} from './ratchet-pin';

// ───────────────────────────── the merge harness ────────────────────────────

/** Run the REAL 3-way merge. Returns git's own verdict: `conflicts` is the
 *  number of conflict hunks (git merge-file's exit status), `text` the merged
 *  file. Exit status ≥ 128 is a git error, not a conflict count. */
function gitMergeFile(base: string, ours: string, theirs: string): {
  conflicts: number;
  text: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'ratchet-pin-merge-'));
  try {
    const p = (n: string) => join(dir, n);
    writeFileSync(p('base'), base);
    writeFileSync(p('ours'), ours);
    writeFileSync(p('theirs'), theirs);
    const r = spawnSync('git', ['merge-file', '-p', p('ours'), p('base'), p('theirs')], {
      encoding: 'utf8',
    });
    if (r.error) throw r.error;
    const status = r.status ?? -1;
    if (status < 0 || status >= 128) {
      throw new Error(`git merge-file failed (status ${status}): ${r.stderr}`);
    }
    return { conflicts: status, text: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The exact file shape that merged wrong: a SORTED, keyed list plus a pinned
 * scalar. `entries` are added in sorted position, so two branches adding
 * different entries touch different lines and the lists union cleanly — which
 * is correct and is not the bug. The bug is what happens to `pinLine`.
 */
function ledgerFile(entries: readonly string[], pinLine: string): string {
  return [
    'export const BOUND_CARDS = {',
    ...[...entries].sort().map((e) => `  '${e}': def,`),
    '};',
    '',
    // ⚠ THE PADDING IS LOAD-BEARING, and so is the choice of insertion points
    // below. `git merge-file` merges with 3 lines of context: two edits closer
    // than that fuse into one hunk and conflict on their own. The shape that
    // SHIPPED had the two list insertions several entries apart and the
    // constant a doc-comment away from the list, so both sides' list edits
    // merged cleanly and only the constant line collided — identically. Squash
    // this file and you accidentally test the case that already worked.
    '/** The ratchet. Lower it and this test is the thing that says no.',
    ' *  Whenever this file merges, RE-DERIVE the number from the list;',
    ' *  never inherit the literal. (This is the advice that did not work.) */',
    pinLine,
    '',
  ].join('\n');
}

/** Pull the committed pin/count token back out of a merged file. */
function readPinLine(text: string): string {
  const m = /^export const PIN = '?([^';]+)'?;$/m.exec(text);
  if (!m) throw new Error(`no pin line in:\n${text}`);
  return m[1];
}

/** Every `'x'` key in the merged list — the ground truth the pin must match. */
function readEntries(text: string): string[] {
  return [...text.matchAll(/^ {2}'([^']+)': def,$/gm)].map((m) => m[1]);
}

// The real 2026-08-08 shape: a shared base of converted cards; `main` adds
// meowbox and bumps the floor by one; the branch adds filter and bumps it by
// one. The two insertions are several sorted entries apart (see ledgerFile),
// which is why the LISTS union cleanly and only the constant collides.
const BASE_CARDS = [
  'adsr', 'backdraft', 'delay', 'gatemaiden', 'hydrogen', 'karplus', 'lfo',
  'ringback', 'snaredrum', 'vca', 'warrens',
];
const OURS_CARDS = [...BASE_CARDS, 'meowbox'];
const THEIRS_CARDS = [...BASE_CARDS, 'filter'];
/** What each side WROTE (base + 1) and what the merge is actually WORTH
 *  (base + 2). The gap between them is the whole defect. */
const SIDE_COUNT = BASE_CARDS.length + 1;
const MERGED_COUNT = BASE_CARDS.length + 2;

describe('ratchet pins: git can SEE a two-sided bump, a bare count cannot', () => {
  it('NEGATIVE CONTROL — the BARE COUNT merges clean and lands WRONG (the shipped bug)', () => {
    const merged = gitMergeFile(
      ledgerFile(BASE_CARDS, `export const PIN = ${BASE_CARDS.length};`),
      ledgerFile(OURS_CARDS, `export const PIN = ${SIDE_COUNT};`),
      ledgerFile(THEIRS_CARDS, `export const PIN = ${SIDE_COUNT};`),
    );

    // (a) git is happy. This is the finding: no marker, no warning, exit 0.
    expect(merged.conflicts, 'a bare count MUST merge silently — else this control is not reproducing the bug').toBe(0);
    // (b) the lists unioned correctly…
    expect(readEntries(merged.text)).toHaveLength(MERGED_COUNT);
    // (c) …and the ratchet did not: one whole card of slack, which the next
    //     card to fall out of the set is absorbed by.
    expect(Number(readPinLine(merged.text))).toBe(SIDE_COUNT);
    expect(
      MERGED_COUNT - Number(readPinLine(merged.text)),
      'the slack a silent merge leaves behind',
    ).toBe(1);
    // (d) and the OLD assertion — `actual >= FLOOR` — is green on that slack.
    expect(readEntries(merged.text).length >= Number(readPinLine(merged.text))).toBe(true);
  });

  it('the PIN makes the same merge a CONFLICT, so a human sees it', () => {
    const merged = gitMergeFile(
      ledgerFile(BASE_CARDS, `export const PIN = '${ratchetPin(BASE_CARDS)}';`),
      ledgerFile(OURS_CARDS, `export const PIN = '${ratchetPin(OURS_CARDS)}';`),
      ledgerFile(THEIRS_CARDS, `export const PIN = '${ratchetPin(THEIRS_CARDS)}';`),
    );
    expect(merged.conflicts, 'two different pins from one base must CONFLICT').toBeGreaterThan(0);
    expect(merged.text).toContain('<<<<<<<');
    // The two candidate tokens are both in the conflict hunk, and they differ
    // in the DIGEST even though both claim the SAME count — which is precisely
    // the information a bare integer cannot carry.
    expect(ratchetPin(OURS_CARDS)).not.toBe(ratchetPin(THEIRS_CARDS));
    expect(ratchetPinCount(ratchetPin(OURS_CARDS))).toBe(ratchetPinCount(ratchetPin(THEIRS_CARDS)));
  });

  it('and if a conflict is resolved by taking ONE side, the check still fails', () => {
    // A human who resolves the conflict by picking `ours` has NOT fixed it —
    // the merged set is base+2 cards and the pin describes base+1. Belt and
    // braces: the conflict is the warning, this is the backstop.
    const mergedCards = canonicalizeRatchetItems([...OURS_CARDS, ...THEIRS_CARDS]);
    expect(mergedCards).toHaveLength(MERGED_COUNT);
    const v = checkRatchetPin({
      name: 'PIN',
      pinned: ratchetPin(OURS_CARDS),
      items: mergedCards,
      direction: 'grow',
    });
    expect(v.ok).toBe(false);
    expect(v.message).toContain(String(MERGED_COUNT));
    expect(v.message).toContain(ratchetPin(mergedCards));
  });

  it('a branch that touches only the LIST merges clean and is red on arrival', () => {
    // The other realistic shape: one side edits the list and forgets the pin.
    // Nothing to conflict on, so the merge is clean — and the check is red the
    // moment the suite runs, which is the behaviour we want.
    const merged = gitMergeFile(
      ledgerFile(BASE_CARDS, `export const PIN = '${ratchetPin(BASE_CARDS)}';`),
      ledgerFile(OURS_CARDS, `export const PIN = '${ratchetPin(BASE_CARDS)}';`),
      ledgerFile(BASE_CARDS, `export const PIN = '${ratchetPin(BASE_CARDS)}';`),
    );
    expect(merged.conflicts).toBe(0);
    expect(
      checkRatchetPin({
        name: 'PIN',
        pinned: readPinLine(merged.text),
        items: readEntries(merged.text),
        direction: 'grow',
      }).ok,
    ).toBe(false);
  });
});

describe('checkRatchetPin — both directions, negative-controlled', () => {
  const SET = ['a.one', 'b.two', 'c.three'];
  const PIN = ratchetPin(SET);

  it('accepts the set it was pinned from', () => {
    expect(checkRatchetPin({ name: 'P', pinned: PIN, items: SET, direction: 'shrink' }).ok).toBe(true);
    expect(checkRatchetPin({ name: 'P', pinned: PIN, items: SET, direction: 'grow' }).ok).toBe(true);
  });

  it('shrink ratchet: GROWTH is red, and so is an un-lowered pin after a drain', () => {
    const grew = checkRatchetPin({
      name: 'P', pinned: PIN, direction: 'shrink', items: [...SET, 'd.four'],
    });
    expect(grew.ok).toBe(false);
    expect(grew.message).toMatch(/GREW/);

    const drained = checkRatchetPin({
      name: 'P', pinned: PIN, direction: 'shrink', items: SET.slice(0, 2),
    });
    expect(drained.ok, 'slack left by a drain must be red, not silent').toBe(false);
    expect(drained.message).toMatch(/SAME commit/);
  });

  it('grow ratchet: SHRINKAGE is red, and so is an un-raised pin after a conversion', () => {
    const shrank = checkRatchetPin({
      name: 'P', pinned: PIN, direction: 'grow', items: SET.slice(0, 2),
    });
    expect(shrank.ok).toBe(false);
    expect(shrank.message).toMatch(/SHRANK/);

    const converted = checkRatchetPin({
      name: 'P', pinned: PIN, direction: 'grow', items: [...SET, 'd.four'],
    });
    expect(converted.ok).toBe(false);
    expect(converted.message).toMatch(/SAME commit/);
  });

  it('SAME COUNT, DIFFERENT SET is red — the half a bare integer cannot express', () => {
    const swapped = ['a.one', 'b.two', 'c.THREE'];
    expect(swapped).toHaveLength(SET.length);
    const v = checkRatchetPin({ name: 'P', pinned: PIN, items: swapped, direction: 'shrink' });
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/DIFFERENT SETS/);
    // …and a bare count would have been perfectly happy with it.
    expect(swapped.length).toBe(ratchetPinCount(PIN));
  });

  it('the failure message names the token to paste (the accept loop is one copy)', () => {
    const v = checkRatchetPin({
      name: 'P', pinned: PIN, direction: 'shrink', items: SET.slice(0, 2), detail: 'ctx',
    });
    expect(v.message).toContain(v.expected);
    expect(v.expected).toBe(ratchetPin(SET.slice(0, 2)));
    expect(v.message).toContain('ctx');
  });

  it('a malformed pin is a loud failure, never a silent pass', () => {
    for (const bad of ['8', '', 'eight@deadbeef', '8@nothex!!', '8@deadbee']) {
      const v = checkRatchetPin({ name: 'P', pinned: bad, items: SET, direction: 'shrink' });
      expect(v.ok, `"${bad}" must be rejected`).toBe(false);
    }
  });
});

describe('the digest itself', () => {
  it('is order- and duplicate-independent, and platform-stable', () => {
    expect(ratchetPin(['b', 'a'])).toBe(ratchetPin(['a', 'b']));
    expect(ratchetPin(['a', 'a', 'b'])).toBe(ratchetPin(['a', 'b']));
    // Pinned literal: if this ever changes, EVERY committed pin in the repo is
    // invalidated at once — so the constant is asserted, not just the property.
    expect(fnv1a32('')).toBe('811c9dc5');
    expect(fnv1a32('a')).toBe('e40c292c');
    expect(fnv1a32('foobar')).toBe('bf9cf968');
    expect(ratchetPin(['a', 'b'])).toBe(`2@${fnv1a32('a\nb')}`);
  });

  it('moves when the set moves — including a one-character difference', () => {
    // Negative-control the instrument: a digest that never changes would make
    // every pin check above vacuously green.
    const seen = new Set<string>();
    for (const s of [['x'], ['y'], ['x', 'y'], ['x', 'z'], ['xy'], ['x.y']]) seen.add(ratchetPin(s));
    expect(seen.size, 'six distinct sets must produce six distinct pins').toBe(6);
  });

  it('empty set is representable (a fully drained ledger is a real state)', () => {
    expect(ratchetPin([])).toBe(`0@${fnv1a32('')}`);
    expect(checkRatchetPin({ name: 'P', pinned: ratchetPin([]), items: [], direction: 'shrink' }).ok).toBe(true);
  });
});
