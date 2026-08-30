// packages/web/src/lib/dev/behavioral-smoke-subset.test.ts
//
// Pins the `behavioral smoke (required subset)` CI job's `--grep` to the LIVE
// registry. Pure-unit, zero-flake, ~0 added CI wall-time; runs in the `unit`
// lane next to the manifest emitter it borrows its module enumeration from.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// That job is a REQUIRED check for every PR, and which rows it runs is decided
// by one regex in .github/workflows/ci.yml. Playwright's `--grep` is an
// UNANCHORED regex over the full (describe-prefixed) test title, so the
// alternative `filter` substring-matched
//
//     resofilter: each declared input perturbs the module's observable output …
//
// and RESOFILTER was gating every PR in the repo without ever having been chosen
// for the subset — discovered only because that row is the one that kept going
// red. Nothing was wrong with the workflow's syntax, nothing failed, and reading
// the seven names in the alternation told you the wrong answer about what runs.
//
// ── WHAT IT ASSERTS ──────────────────────────────────────────────────────────
//
// The check is ANCHORED TO THE ARTIFACT, not to the list: it reconstructs the
// exact titles the sweep will register (from the live registry, by the same
// `inputs.length && outputs.length` rule the spec's loop uses), runs the real
// regex over them, and compares the SELECTED SET against the declared intent.
//
//   (a) selected set === INTENDED_SUBSET — a new module whose type happens to
//       end in `…filter` / `…vca` / `…lfo` cannot silently join a required
//       check, and a rename cannot silently drop one.
//   (b) every alternative is accounted for — one that selects nothing is DEAD
//       and must be named in KNOWN_DEAD_ALTERNATIVES with its reason, so a typo
//       ('analogVCO') can never masquerade as a deliberately-inert entry.
//   (c) the regex is still unanchored-by-default — a NEGATIVE CONTROL proving
//       the `\b` is what does the work, so removing it goes red here rather than
//       quietly re-widening a required check.
//
// Editing the grep in ci.yml means editing INTENDED_SUBSET here in the SAME
// commit; that pairing is the whole safety argument.
//
// ── ⚠ WHAT THIS GATE IS STRUCTURALLY UNABLE TO SEE (#1847) ──────────────────
//
// It reconstructs titles from the LIVE REGISTRY and asks which ones the regex
// SELECTS. It never asks whether a selected row EXECUTES. So a subset module
// whose row is disabled at declaration — `test.fixme`, or an entry in the
// sweep's own FLAKE_PARK_1847 / SKIP_SPAWN maps — still contributes its title,
// still gets selected, and this gate stays GREEN while the required job runs a
// skip in its place.
//
// THAT WAS THE LIVE STATE FOR EIGHT DAYS, AND IT IS WHY THIS NOTE EXISTS. The
// #1847 flake park disabled `analogVco` and `lfo` — TWO OF THE SIX modules this
// subset resolves to — so `behavioral-smoke`, a REQUIRED pre-merge check with no
// JSON audit step, ran FOUR while every signal available said six: the lane was
// green, this gate was green, and a third of the core signal-path behavioral
// coverage was not executing.
//
// ⚠ FIXED, not mitigated: both rows are root-caused and running again (the
// verbatim CI failure rows and the arithmetic are on their
// BEHAVIORAL_PORT_TEST_SOURCE entries in the sweep). Neither was a race in the
// module — both were the sweep's generic BUGGLES.smooth stimulus, a
// setTimeout-scheduled random walk whose size and sign are a timing lottery,
// and for `lfo` additionally an observable whose OWN null scatter was 50 % of
// its mean. So the blind spot described above is real and still unasserted, but
// nothing is currently hiding in it.
//
// It remains deliberately NOT asserted here. The park map is the owner's
// instrument; a gate that reddens the required unit lane on a park is the gate
// arguing with the ruling rather than reporting it. What the sweep does instead
// is state the constraint where the parking happens: nothing the ci.yml grep
// selects may be parked, because that is a required lane claiming coverage it
// does not provide.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Side-effect barrels populate the three per-domain registries.
import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { getAllModuleSpecs } from './module-specs';

/** The modules the subset is MEANT to cover: the core signal-path set. */
const INTENDED_SUBSET = [
  'adsr',
  'analogVco',
  'filter',
  'lfo',
  'stereovca',
  'vca',
] as const;

/**
 * Alternatives that legitimately select nothing today, with the reason. An
 * entry here is a claim about the registry that (b) re-verifies every run — if
 * `noise` ever gains an input the row appears, the alternative stops being dead,
 * and this test fails until the entry is removed and INTENDED_SUBSET updated.
 */
const KNOWN_DEAD_ALTERNATIVES: Record<string, string> = {
  noise: 'the module declares ZERO inputs, so the behavioral sweep registers no row for it (`if (mod.inputs.length === 0) continue`). Kept in the grep so it re-enters the subset automatically if it ever gains one.',
};

const CI_YML = resolve(import.meta.dirname, '../../../../../.github/workflows/ci.yml');

/** The describe title the sweep nests every per-module row under. */
const DESCRIBE_TITLE =
  'per-module per-port: BEHAVIORAL input coverage (output changes on driven input vs unpatched)';

/** Reconstruct the per-module row title exactly as the spec builds it. */
function rowTitle(type: string): string {
  return `${DESCRIBE_TITLE} › ${type}: each declared input perturbs the module's observable output (vs unpatched control)`;
}

/** Pull the `--grep "…"` argument out of the behavioral-smoke step in ci.yml. */
function readSubsetGrep(): string {
  const yml = readFileSync(CI_YML, 'utf8');
  const step = yml.indexOf('Run behavioral smoke subset');
  expect(
    step,
    'ci.yml no longer has a step named "Run behavioral smoke subset" — this test can no longer find the grep it exists to pin. Re-point it or delete it; do NOT leave it passing vacuously.',
  ).toBeGreaterThan(-1);
  const tail = yml.slice(step);
  const m = /--grep "((?:[^"\\]|\\.)*)"/.exec(tail);
  expect(m, 'no `--grep "…"` found in the behavioral smoke step').not.toBeNull();
  return m![1]!;
}

/** Every module type for which the sweep registers a row (test or fixme). */
function rowModuleTypes(): string[] {
  return getAllModuleSpecs()
    .filter((s) => s.inputs.length > 0 && s.outputs.length > 0)
    .map((s) => s.type)
    .sort();
}

function selectedBy(pattern: string, types: string[]): string[] {
  const re = new RegExp(pattern);
  return types.filter((t) => re.test(rowTitle(t)));
}

describe('behavioral smoke (required subset): the ci.yml grep selects exactly the intended modules', () => {
  it('(a) selects exactly INTENDED_SUBSET — no substring stowaways', () => {
    const types = rowModuleTypes();
    // Instrument sanity: if the registry projection came back empty the whole
    // test would pass vacuously with an empty === empty comparison.
    expect(
      types.length,
      'registry projection returned no rows — the barrels did not load, so every assertion below would be vacuous',
    ).toBeGreaterThan(50);

    const selected = selectedBy(readSubsetGrep(), types);
    expect(
      selected,
      `The REQUIRED behavioral-smoke subset does not match its declared intent.\n` +
        `  selected by ci.yml's --grep : ${selected.join(', ') || '(none)'}\n` +
        `  INTENDED_SUBSET             : ${INTENDED_SUBSET.join(', ')}\n` +
        `Playwright's --grep is UNANCHORED, so a module whose type merely ENDS IN one of the\n` +
        `alternatives joins a required check silently. Fix the grep, or update INTENDED_SUBSET\n` +
        `in the same commit if the addition is deliberate.`,
    ).toEqual([...INTENDED_SUBSET]);
  });

  it('(b) every alternative in the grep selects something, or is a NAMED dead entry', () => {
    const types = rowModuleTypes();
    const grep = readSubsetGrep();
    const alternation = /\(([^)]*)\)/.exec(grep);
    expect(alternation, `no (a|b|c) alternation found in the grep: ${grep}`).not.toBeNull();
    const alternatives = alternation![1]!.split('|');
    expect(alternatives.length).toBeGreaterThan(1);

    const prefix = grep.slice(0, alternation!.index);
    const suffix = grep.slice(alternation!.index + alternation![0].length);

    const dead: string[] = [];
    for (const alt of alternatives) {
      if (selectedBy(`${prefix}(${alt})${suffix}`, types).length === 0) dead.push(alt);
    }
    const undeclared = dead.filter((a) => !(a in KNOWN_DEAD_ALTERNATIVES));
    expect(
      undeclared,
      `alternative(s) in the required-subset grep match NO registered module — almost certainly a\n` +
        `typo or a renamed module, which would shrink a required check with no failure anywhere.\n` +
        `If an alternative is deliberately inert, add it to KNOWN_DEAD_ALTERNATIVES with the reason.`,
    ).toEqual([]);

    // The other direction: a KNOWN_DEAD entry that has come back to life is a
    // stale claim, and a stale exemption is one nobody is watching.
    const resurrected = Object.keys(KNOWN_DEAD_ALTERNATIVES).filter((a) => !dead.includes(a));
    expect(
      resurrected,
      `KNOWN_DEAD_ALTERNATIVES names ${resurrected.join(', ')}, but it now selects rows — the module\n` +
        `gained an input/output. Drop the entry and add the module to INTENDED_SUBSET (or narrow the grep).`,
    ).toEqual([]);
  });

  it('(c) NEGATIVE CONTROL: without the word-boundary anchor the grep DOES over-select', () => {
    const types = rowModuleTypes();
    const grep = readSubsetGrep();
    expect(
      grep.startsWith('\\b'),
      'the required-subset grep lost its leading \\b anchor — Playwright --grep is unanchored, so ' +
        'every alternative is a SUFFIX match again',
    ).toBe(true);

    // Force the instrument to move: strip the anchor and confirm the selection
    // GROWS. If it did not, `\b` would be doing nothing and (a) would be
    // certifying a property this file cannot actually see.
    const unanchored = selectedBy(grep.slice(2), types);
    const anchored = selectedBy(grep, types);
    expect(
      unanchored.length,
      'stripping \\b did not widen the selection, so the anchor is not what constrains this grep — ' +
        'assertion (a) is passing for a reason other than the one stated. ' +
        `anchored=[${anchored.join(', ')}] unanchored=[${unanchored.join(', ')}]`,
    ).toBeGreaterThan(anchored.length);
    // And name the concrete stowaway, so the regression this pins stays legible.
    expect(unanchored).toContain('resofilter');
  });
});
