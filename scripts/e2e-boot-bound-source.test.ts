// scripts/e2e-boot-bound-source.test.ts
//
// SOURCE-LEVEL GATE: a wait on a BOOT / FIRST-PAINT subject must carry an
// EXPLICIT timeout. The default is the bug.
//
// ── why a source gate and not a runtime one ─────────────────────────────────
//
// The defect is an ABSENCE. `expect(locator).toBeVisible()` with no options
// takes Playwright's 5 s expect timeout; nothing in the source says "5000", so
// there is nothing to grep for except the missing option. At runtime the two
// forms are indistinguishable on any machine fast enough to pass — which is
// every machine, until the one that isn't. CLAUDE.md names the answer for
// exactly this situation: "Guard it at the SOURCE level, since no runtime gate
// sees it."
//
// ── what it cost, measured ─────────────────────────────────────────────────
//
// #1875 took `main` red twice in one day. Reading the failing attempt out of
// the blob reports of every completed `ci.yml` run in the window to 2026-08-19
// (31 runs × 10 shards), the most common flake in the whole suite was one line:
//
//   Error: expect(locator).toBeVisible() failed
//   Locator: getByTestId('workflow-topbar')
//   Timeout: 5000ms
//
// `workflow-shell.spec.ts` recovered it on 16 of those 31 runs, always
// `failed -> passed` on the SAME SHA. #1898 fixed that one file; the sweep this
// gate closes (#1904) found the identical shape at twenty more sites. Every one
// of them rode GREEN jobs, because `retries: 1` recovered them — which is why
// the retry-recovery gate (#1903) needed this drained first.
//
// ── ⚠ the two APIs do NOT share a default ──────────────────────────────────
//
// `expect(locator).toBeVisible()` bounds at the 5 s EXPECT timeout.
// `locator.waitFor()` documents "Defaults to 0 - no timeout" and is bounded
// only by the per-test budget. They look alike and are not, and an early
// version of the #1904 inventory conflated them — which would have reported ~70
// offenders where there are ~20, and "fixed" a population that was never the
// defect. This gate reads the FIRST form only, deliberately, and the scope note
// below says what that leaves uncovered.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TESTS_DIR = join(REPO_ROOT, 'e2e', 'tests');

/**
 * The BOOT / FIRST-PAINT subjects: what a spec waits for after `goto` to decide
 * the app came up. Each carries WHY it is one, so the list cannot grow into a
 * grab-bag of "elements someone waited for".
 *
 * Deny-by-default is per SITE, not per file — a file already listed here still
 * reddens on a NEW bare wait, which is the inversion CLAUDE.md asks for.
 */
const BOOT_SUBJECTS: ReadonlyArray<{ readonly probe: RegExp; readonly why: string }> = [
  {
    probe: /getByTestId\(['"]workflow-topbar['"]\)\)\s*\.toBeVisible\(([^;]*?)\)/g,
    why: 'the shell topbar — the first thing painted by /rack, and the subject of the #1875 main-red',
  },
  {
    probe: /locator\(['"]\[data-testid="canvas-root"\]['"]\)\)\s*\.toBeVisible\(([^;]*?)\)/g,
    why: 'the legacy canvas root — the /rack?shell=legacy equivalent of the topbar',
  },
];

/** One offending call site. */
export interface BareBootWait {
  readonly file: string;
  readonly line: number;
  readonly why: string;
  readonly source: string;
}

/**
 * THE PREDICATE. Both the gate and its controls call this exact function — a
 * control that re-implements the check proves nothing about the check.
 *
 * @param file  label used in the violation (a filename, or a fixture name)
 * @param src   the source text to scan
 */
export function bareBootWaits(file: string, src: string): BareBootWait[] {
  const out: BareBootWait[] = [];
  for (const { probe, why } of BOOT_SUBJECTS) {
    const re = new RegExp(probe.source, probe.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const args = m[1] ?? '';
      if (/\btimeout\s*:/.test(args)) continue; // explicitly bounded — fine
      const line = src.slice(0, m.index).split('\n').length;
      out.push({ file, line, why, source: m[0].replace(/\s+/g, ' ').trim() });
    }
  }
  return out;
}

function specFiles(): string[] {
  return readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith('.spec.ts'))
    .sort();
}

describe('e2e boot bounds are explicit (#1904)', () => {
  it('no boot/first-paint wait relies on the DEFAULT expect timeout', () => {
    const offenders = specFiles().flatMap((f) =>
      bareBootWaits(f, readFileSync(join(TESTS_DIR, f), 'utf8')),
    );
    // An unconditional assertion, never a ceiling: a threshold on a population
    // measures nothing and can only go stale (CLAUDE.md, population counts).
    expect(
      offenders.map((o) => `${o.file}:${o.line} — ${o.source} (${o.why})`),
      'A boot wait with no `timeout:` takes Playwright\'s 5s default. That is a DIFFERENT '
        + 'assertion on every runner, and it is what took main red twice in one day (#1875). '
        + 'Import BOOT_MS from e2e/_helpers/boot-budget.ts — do not re-type a number.',
    ).toEqual([]);
  });

  // ── CONTROLS, both directions, permanent ──────────────────────────────────
  //
  // A green gate and a gate that reads nothing look identical from the output.
  // The negative control proves the predicate CAN fire; the positive control
  // proves it does not fire on the fixed shape — so a regex that rots into
  // matching nothing, and one that matches everything, are both caught.

  it('NEGATIVE CONTROL: the predicate fires on the exact shape that took main red', () => {
    const bad = `
      await page.goto('/rack');
      await expect(page.getByTestId('workflow-topbar')).toBeVisible();
    `;
    const hits = bareBootWaits('fixture-bad.spec.ts', bad);
    expect(hits.length, 'the predicate no longer recognises the #1875 defect').toBe(1);
    expect(hits[0].line, 'the violation must point at the offending line').toBe(3);
  });

  it('POSITIVE CONTROL: the predicate stays silent on an explicitly bounded wait', () => {
    const good = `
      await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
      await expect(page.locator('[data-testid="canvas-root"]')).toBeVisible({ timeout: 30_000 });
    `;
    expect(
      bareBootWaits('fixture-good.spec.ts', good),
      'an explicit bound is the fix — flagging it would make the gate un-satisfiable',
    ).toEqual([]);
  });

  it('the gate reads a NON-EMPTY set of specs (a gate over nothing is decoration)', () => {
    // Anchored to the ARTIFACT: if e2e/tests stops resolving, this is RED
    // rather than vacuously green.
    expect(specFiles().length).toBeGreaterThan(0);
    expect(specFiles()).toContain('workflow-shell.spec.ts');
  });
});

// ── ⚠ WHAT THIS GATE IS STRUCTURALLY UNABLE TO SEE ─────────────────────────
//
//  · `locator.waitFor({ state: 'visible' })` on the same subjects. It has no
//    default timeout of its own, so it is bounded by the PER-TEST budget, not
//    by 5 s — a different bound with a different fix (`SLOW_BOOT_TEST_TIMEOUT_MS`,
//    applied per spec). Not an exemption: a different defect.
//  · An explicit but WRONG bound. `{ timeout: 15_000 }` satisfies this gate.
//    The measured failures were all at the 5 s default and none at 15 s+, so
//    the gate denies the default rather than legislating a number it has no
//    evidence for. ~40 sites carry a re-typed numeric literal; they are bounded
//    and not the defect, but they are a drift surface — folding them into
//    BOOT_MS is follow-up work on #1904, not a debt ledger.
//  · Boot subjects it does not name. BOOT_SUBJECTS is a closed list, so a spec
//    that waits on some third element to decide the app booted is invisible
//    here. Add it, with its `why`.
//  · INDIRECTION. It matches the locator expression at the call site, so
//    `const bar = page.getByTestId('workflow-topbar'); await expect(bar)
//    .toBeVisible();` reads as compliant. No spec does this today, and the
//    honest reason the gate tolerates it is that a source grep cannot follow a
//    binding — not that the form is safe.
//  · Anything outside `e2e/tests/*.spec.ts` — helpers, `e2e/vrt/`, other
//    workflows' specs.
//
// ── ⚠ DOOM ────────────────────────────────────────────────────────────────
//
// `doom-session-survives-card-collapse.spec.ts` is the one DOOM spec with a
// boot wait, and it ALREADY carries an explicit bound, so it satisfies this
// gate WITHOUT BEING TOUCHED and needs no exemption. That is also why the rule
// is "an explicit timeout" and not "a named constant": the stricter rule would
// have forced an edit to a DOOM spec, which the standing owner ruling forbids
// without specific approval ("do not fuck with doom in any way"). DOOM's game
// clock IS its frame clock, so a timing edit re-specifies how far the marine
// walks. No DOOM file is modified by #1904.
