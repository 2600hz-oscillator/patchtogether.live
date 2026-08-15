// scripts/art-cv-reach-optin.test.ts
//
// The CV-reach sweeps are opt-in: excluded from ART's default (REQUIRED) lane,
// and run by `npm run art:cv-reach -w art`, which is what ci.yml's MAIN-ONLY
// `cv-param-reach` job invokes.
//
// That is a TWO-SIDED contract across two files, and CLAUDE.md's rule applies
// verbatim: *a gate that reads only one side of a two-sided contract proves
// nothing about the other side.* Both failure modes are silent and opposite:
//
//   in the config's exclude, NOT in the script  → excluded everywhere, so the
//       sweep gates NOTHING while still looking present in the tree
//   in the script, NOT in the config's exclude  → rides the REQUIRED `art`
//       lane and cancels it at the 10 min timeout
//
// The second one is not hypothetical. `cv-display-param-reach` landed while the
// exclude list named only `cv-param-reach`, and cancelled `art` at 10m21s on
// PR #1676 — the same shape that forced the sweep into its own job to begin
// with (#1669).
//
// ⚠ SCOPE — what this test structurally CANNOT see: a brand-new sweep that is
// in NEITHER list. Membership here is derived from the two lists agreeing with
// each other and with the filesystem; nothing in the tree declares "I am an
// expensive registry-wide sweep", so a third sweep added to neither file rides
// the required lane exactly as `cv-display-param-reach` did. Closing that needs
// a marker ON the scenario (an exported flag the config reads), not a bigger
// list. Until then this catches the DRIFT case, not the birth case.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, 'art/vitest.config.ts');
const PKG = join(ROOT, 'art/package.json');

/** Scenario dirs named in the config's non-opted-in `exclude` list. */
function excludedSweeps(src = readFileSync(CONFIG, 'utf8')): string[] {
  return [...src.matchAll(/'scenarios\/([A-Za-z0-9-]+)\/\*\*'/g)].map((m) => m[1]).sort();
}

/** Scenario dirs the `art:cv-reach` script actually runs. */
function scriptSweeps(pkg = JSON.parse(readFileSync(PKG, 'utf8'))): string[] {
  const script: string = pkg.scripts?.['art:cv-reach'] ?? '';
  return [...script.matchAll(/scenarios\/([A-Za-z0-9-]+)/g)].map((m) => m[1]).sort();
}

describe('the CV-reach opt-in is a two-sided contract (#1676)', () => {
  it('every EXCLUDED sweep is one the cv-reach script RUNS — else it gates nothing', () => {
    const excluded = excludedSweeps();
    const run = scriptSweeps();
    const orphaned = excluded.filter((d) => !run.includes(d));
    expect(
      orphaned,
      `excluded from ART's default lane but never run by \`art:cv-reach\`: ${orphaned.join(', ')}. ` +
        `Such a sweep is excluded EVERYWHERE — it looks present in the tree and asserts nothing. ` +
        `Add it to art/package.json's art:cv-reach script.`,
    ).toEqual([]);
  });

  it('every sweep the script RUNS is EXCLUDED from the default lane — else it cancels `art`', () => {
    const excluded = excludedSweeps();
    const run = scriptSweeps();
    const leaking = run.filter((d) => !excluded.includes(d));
    expect(
      leaking,
      `run by \`art:cv-reach\` but not excluded from ART's default lane: ${leaking.join(', ')}. ` +
        `These ride the REQUIRED \`art\` job and cancel it at its 10 min timeout ` +
        `(measured: PR #1676, 10m21s). Add them to the exclude list in art/vitest.config.ts.`,
    ).toEqual([]);
  });

  it('ANCHORED: every named sweep directory still exists', () => {
    const named = [...new Set([...excludedSweeps(), ...scriptSweeps()])];
    const missing = named.filter((d) => !existsSync(join(ROOT, 'art/scenarios', d)));
    expect(
      missing,
      `named in the opt-in but absent from art/scenarios: ${missing.join(', ')}. ` +
        `A list entry that no longer resolves is stale — delete it.`,
    ).toEqual([]);
  });

  it('is NOT VACUOUS — it is looking at a non-empty population', () => {
    expect(excludedSweeps().length).toBeGreaterThan(0);
    expect(scriptSweeps().length).toBeGreaterThan(0);
  });

  // ── negative controls: both directions must actually be able to fail ──

  it('NEGATIVE CONTROL: a sweep excluded but not run is CAUGHT', () => {
    const excluded = ['cv-param-reach', 'cv-ghost-sweep'];
    const run = ['cv-param-reach'];
    expect(excluded.filter((d) => !run.includes(d))).toEqual(['cv-ghost-sweep']);
  });

  it('NEGATIVE CONTROL: a sweep run but not excluded is CAUGHT', () => {
    const excluded = ['cv-param-reach'];
    const run = ['cv-param-reach', 'cv-ghost-sweep'];
    expect(run.filter((d) => !excluded.includes(d))).toEqual(['cv-ghost-sweep']);
  });

  it('NEGATIVE CONTROL: the parsers read the REAL files, not a fixture', () => {
    // If either parser silently returned [] the two agreement tests above would
    // pass vacuously in BOTH directions — the classic all-green-and-blind shape.
    expect(excludedSweeps()).toContain('cv-param-reach');
    expect(scriptSweeps()).toContain('cv-param-reach');
  });
});
