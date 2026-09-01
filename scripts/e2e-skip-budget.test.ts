// scripts/e2e-skip-budget.test.ts
//
// The STATIC side of the per-lane skip-reason budget (#1502), anchored BOTH
// directions against runtimeSkipInventory() — the same counting machinery the
// ledger uses, so the budget and the reconciliation view cannot disagree about
// what a skip site is.
//
//   direction A (budget → tree): an entry naming a spec that no longer exists,
//     or whose reason pattern no longer matches anything in that spec, is RED —
//     stale entries don't get to keep certifying rows.
//   direction B (tree → budget): every skip SITE in e2e/tests must be claimed
//     by an entry — a NEW guard lands red at unit time (in the required unit
//     lane, i.e. at PR time) until it gets a NAMED (spec, reason) entry, which
//     is the deny-by-default the issue asks for.
//   unconditionally: the set of REASONLESS sites is EMPTY. Not a ceiling — an
//     empty-list assertion (a count of 0 measures nothing; an empty offender
//     list names the offender when it fails).
//
// ── WHAT THIS TEST STRUCTURALLY CANNOT SEE ─────────────────────────────────
//   • The REALIZED reason of a dynamic guard (`test.skip(true, someVar)`).
//     Those sites are anchored at (a) spec granularity and (b) the pattern
//     matching somewhere in the spec's SOURCE (the helper literal usually
//     lives in the same file); the runtime lane audit checks the realized
//     string against the same SKIP_BUDGET.
//   • Lane membership at runtime (which lane a row lands in) — that is the
//     lane audit's half (scripts/e2e-report-audit.mjs --lane <name>).
//   • Specs outside e2e/tests (vrt lanes have no merged-JSON audit).

import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs with JSDoc types, no declaration file
import * as recon from './test-reconciliation.mjs';
// @ts-expect-error — plain .mjs with JSDoc types, no declaration file
import * as budget from './e2e-skip-budget.mjs';

type Site = {
  loc: string;
  file: string;
  kind: 'runtime-guard' | 'declaration' | 'placeholder';
  modifier: string;
  reasonKind: 'literal' | 'dynamic' | 'none';
  reason: string;
};
type Entry = {
  specs: string[];
  reason: RegExp;
  lanes: string[];
  homeLane: string;
  why: string;
};

const { runtimeSkipInventory, walk } = recon as {
  runtimeSkipInventory: (files: string[]) => Site[];
  walk: (dir: string, suffix: string) => string[];
};
const { SKIP_BUDGET, AUDITED_LANES, KNOWN_LANES, budgetViolations } = budget as {
  SKIP_BUDGET: Entry[];
  AUDITED_LANES: string[];
  KNOWN_LANES: string[];
  budgetViolations: (
    rows: { file: string; title: string; reason?: string | null }[],
    lane: string,
  ) => { file: string; violation: string }[];
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specFiles = walk(join(ROOT, 'e2e', 'tests'), '.spec.ts');
const inventory = runtimeSkipInventory(specFiles);
const sites = inventory.filter((s) => s.kind !== 'placeholder');
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** The claim predicate direction B runs (assertion AND negative control): does
 *  `entry` admit `site`? A literal site must match the pattern on its reason
 *  text; a dynamic site is claimed at SPEC granularity — the stated weaker
 *  anchor (its realized string is checked at runtime by the lane audit, and
 *  direction A separately requires the pattern to bind to the spec's source,
 *  where the realized literal usually lives). */
function claims(entry: Entry, site: Site): boolean {
  if (!entry.specs.includes(basename(site.file))) return false;
  if (site.reasonKind === 'literal') return entry.reason.test(site.reason);
  return true; // dynamic — spec-granularity claim, see the scope note above
}

const srcCache = new Map<string, string>();
const srcOf = (file: string) => {
  if (!srcCache.has(file)) srcCache.set(file, readFileSync(join(ROOT, file), 'utf8'));
  return srcCache.get(file)!;
};

/** Direction A's production, shared by its assertion and its negative control:
 *  the stale descriptions for a set of entries against the LIVE inventory. */
function staleEntries(entries: Entry[]): string[] {
  const stale: string[] = [];
  for (const e of entries) {
    for (const spec of e.specs) {
      const specSites = sites.filter((s) => basename(s.file) === spec);
      if (specSites.length === 0) {
        stale.push(`${spec} — no skip sites at all (entry ${e.reason})`);
        continue;
      }
      // The pattern must BIND to something in that spec — a literal site's
      // reason, or (for dynamic sites) the spec's source text — otherwise the
      // entry certifies nothing and is rot.
      const bound =
        specSites.some((s) => s.reasonKind === 'literal' && e.reason.test(s.reason))
        || (specSites.some((s) => s.reasonKind === 'dynamic') && e.reason.test(srcOf(specSites[0]!.file)));
      if (!bound) stale.push(`${spec} — pattern ${e.reason} matches no site reason and no source text`);
    }
  }
  return stale;
}

describe('skip budget — structure', () => {
  it('every entry is well-formed: named specs, regex reason, audited lanes, known homeLane, real why', () => {
    const offenders: string[] = [];
    for (const e of SKIP_BUDGET) {
      if (!Array.isArray(e.specs) || e.specs.length === 0) offenders.push(`entry with no specs: ${e.reason}`);
      if (!(e.reason instanceof RegExp)) offenders.push(`non-regex reason: ${String(e.reason)}`);
      for (const lane of e.lanes) {
        if (!AUDITED_LANES.includes(lane)) offenders.push(`unknown audited lane '${lane}' on ${e.reason}`);
      }
      if (!KNOWN_LANES.includes(e.homeLane)) offenders.push(`unknown homeLane '${e.homeLane}' on ${e.reason}`);
      // Prose-quality floor, not a population count: a `why` must justify, not label.
      if (typeof e.why !== 'string' || e.why.length < 60) offenders.push(`why too thin on ${e.reason}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('skip budget — direction A (budget → tree): no stale entries', () => {
  it('every (spec, reason) pair resolves to a live skip site', () => {
    expect(staleEntries(SKIP_BUDGET)).toEqual([]);
  });

  it('NEGATIVE CONTROL: fabricated stale entries are caught by the SAME production', () => {
    // Same predicate, perturbed input — proves the check above can actually
    // fail, not that the tree happens to be clean. Both stale shapes: a spec
    // that does not exist, and a real spec whose pattern binds to nothing.
    const gone: Entry = {
      specs: ['no-such-spec.spec.ts'],
      reason: /anything/,
      lanes: [],
      homeLane: 'local',
      why: 'fabricated entry for the negative control — names a spec that does not exist in the tree',
    };
    const unbound: Entry = {
      specs: ['es9-hardware.spec.ts'],
      reason: /a pattern that matches no reason and no source text zzz/,
      lanes: [],
      homeLane: 'local',
      why: 'fabricated entry for the negative control — real spec, pattern that binds to nothing',
    };
    expect(staleEntries([gone]).length).toBe(1);
    expect(staleEntries([unbound]).length).toBe(1);
  });
});

describe('skip budget — direction B (tree → budget): deny-by-default', () => {
  it('every skip site is claimed by a named entry (a NEW guard must land with one)', () => {
    const unclaimed = sites
      .filter((s) => !SKIP_BUDGET.some((e) => claims(e, s)))
      .map((s) => `${s.loc} (${s.modifier}, ${s.reasonKind}: ${s.reason.slice(0, 60)})`);
    expect(unclaimed).toEqual([]);
  });

  it('UNCONDITIONAL: no reasonless skip site exists — every runtime skip carries a reason string', () => {
    const anonymous = sites
      .filter((s) => s.reasonKind === 'none')
      .map((s) => `${s.loc} (${s.modifier}) — add a reason string / details-object annotation`);
    expect(anonymous).toEqual([]);
  });

  it('NEGATIVE CONTROL: a fabricated unbudgeted site is rejected by the same claim predicate', () => {
    const fake: Site = {
      loc: 'e2e/tests/zzz-fabricated.spec.ts:1',
      file: 'e2e/tests/zzz-fabricated.spec.ts',
      kind: 'runtime-guard',
      modifier: 'test.skip',
      reasonKind: 'literal',
      reason: 'a reason no budget entry has ever named',
    };
    expect(SKIP_BUDGET.some((e) => claims(e, fake))).toBe(false);
    // And a literal site in a BUDGETED spec with an unnamed reason is still
    // unclaimed — the claim is (spec, reason), not spec alone.
    const wrongReason: Site = { ...fake, file: 'e2e/tests/es9-hardware.spec.ts' };
    expect(SKIP_BUDGET.some((e) => claims(e, wrongReason))).toBe(false);
  });
});

describe('the lane gate itself (budgetViolations) — the predicate CI calls', () => {
  it('admits a budgeted (spec, reason) row in its lane', () => {
    const rows = [
      {
        file: 'es9-hardware.spec.ts',
        title: 'connects to the real bridge and reports the ES-9',
        reason: 'hardware-in-the-loop: needs a real ES-9 + es9-bridge on ws://127.0.0.1:9209 (opt in with ES9_HW=1)',
      },
    ];
    expect(budgetViolations(rows, 'e2e')).toEqual([]);
  });

  it('REDDENS a reasonless row (the anonymous class this issue exists to kill)', () => {
    const v = budgetViolations([{ file: 'es9-hardware.spec.ts', title: 't', reason: null }], 'e2e');
    expect(v.length).toBe(1);
    expect(v[0]!.violation).toMatch(/reasonless/);
  });

  it('REDDENS an unknown reason, and the same known reason in the WRONG lane', () => {
    const unknown = budgetViolations(
      [{ file: 'es9-hardware.spec.ts', title: 't', reason: 'some brand-new unexplained condition' }],
      'e2e',
    );
    expect(unknown.length).toBe(1);
    expect(unknown[0]!.violation).toMatch(/no budget entry/);

    // lanes:[] semantics — a DOOM-asset skip must never materialize in an
    // audited lane; if it does, the env drifted and the gate says so.
    const wrongLane = budgetViolations(
      [{ file: 'doom-aspect.spec.ts', title: 't', reason: 'DOOM WASM not built' }],
      'e2e',
    );
    expect(wrongLane.length).toBe(1);
  });

  it('ignores exemption placeholders — governed by the exemption maps, stated in the gate scope', () => {
    const rows = [{ file: 'per-module-per-port-behavioral.spec.ts', title: 'x: sweep [SKIPPED: exempt]', reason: null }];
    expect(budgetViolations(rows, 'behavioral')).toEqual([]);
  });
});

// ── the `collab` lane, armed 2026-09-01 (#2294) ────────────────────────────
//
// Until this issue the collab lane was UNAUDITED: it passed no `--lane`, and
// `--lane collab` was rejected outright by the audit CLI. Every runtime skip on
// the one lane that carries the eleven two-peer DOOM multiplayer tests printed
// and gated nothing, so "the DOOM WASM/WAD provisioning broke and all eleven
// stood down" and "all eleven passed" produced the same green job.
//
// The assertions below are about the BOUNDARY, not about a population snapshot:
// exactly one named quarantine is admitted, and the DOOM guards deliberately are
// not — the lane must redden when they fire, because that is the whole signal.
describe('the collab lane (#2294): armed, with ONE named skip', () => {
  it('is an audited lane at all — `--lane collab` used to be rejected', () => {
    expect(AUDITED_LANES).toContain('collab');
    // KNOWN_LANES spreads AUDITED_LANES, so promoting a lane must not leave a
    // duplicate behind — a homeLane check reading a doubled list still passes,
    // which is how a stale second copy survives unnoticed.
    expect(KNOWN_LANES.filter((l) => l === 'collab')).toEqual(['collab']);
  });

  it('admits the ONE legitimate skip: in-card-title\'s task #101 quarantine', () => {
    // The `50 passed / 1 skipped` measured on 2026-09-01 is this row.
    const rows = [
      {
        file: 'in-card-title.spec.ts',
        title: 'rename in A appears in B inside the in-card title (peer Yjs sync)',
        reason:
          'task #101: quarantined — relay-contention timeout on the @collab lane; '
          + 'root-cause the A→relay→B propagation stall, add a regression test, then un-fixme',
      },
    ];
    expect(budgetViolations(rows, 'collab')).toEqual([]);
  });

  it('⚠ REDDENS a DOOM asset skip — the eleven-tests-go-dark regression this lane exists to catch', () => {
    // Not a hypothetical shape: the WAD is fetched over the network from a
    // third-party mirror inside the collab job. If that step degrades, every
    // doom-mp-* test hits `test.skip(!assets.ok, assets.reason)` and the suite
    // reports a serene "40 passed / 11 skipped".
    //
    // ⚠ THIS IS ALSO WHERE THE DOOM FLAKE CARVE-OUT MUST *NOT* REACH.
    // e2e-report-audit.mjs excludes doom-*.spec.ts from `--fail-on-flaky` by
    // owner ruling; the skip budget has no such exclusion and must not grow one.
    // A DOOM flake is DOOM's timing being DOOM. A DOOM skip is DOOM not running.
    const doomRows = [
      { file: 'doom-mp-real.spec.ts', title: 'owner hosts + launches MP as P1', reason: 'DOOM WASM / WAD missing' },
      {
        file: 'doom-mp-lockstep-sharedstate.spec.ts',
        title: 'two peers in a FRESH coop game share IDENTICAL gamestate',
        reason: 'DOOM WASM / WAD missing — run build-doom-wasm.sh + fetch DOOM1.WAD',
      },
    ];
    const v = budgetViolations(doomRows, 'collab');
    expect(v.length).toBe(2);
    for (const row of v) expect(row.violation).toMatch(/no budget entry/);
  });

  it('⚠ no entry admits a DOOM spec on collab — the invariant #2294 bought', () => {
    // Stated as an invariant rather than a snapshot so it does not go stale on
    // unrelated additions. Widening this is not a bookkeeping edit: it re-opens
    // the exact hole the issue closed, and DOOM changes need owner approval.
    const doomAdmitted = SKIP_BUDGET.filter((e) => e.lanes.includes('collab'))
      .flatMap((e) => e.specs.filter((s) => /^doom-/.test(s)).map((s) => `${s} via ${e.reason}`));
    expect(
      doomAdmitted,
      'A DOOM skip admitted on the collab lane means the eleven multiplayer tests can stand '
        + 'down silently again (#2294). Do not register one to quiet a red lane.',
    ).toEqual([]);
  });

  it('REDDENS an unregistered reason and a reasonless row on collab, like every other lane', () => {
    const unknown = budgetViolations(
      [{ file: 'awareness.spec.ts', title: 'both contexts converge', reason: 'relay was busy, never mind' }],
      'collab',
    );
    expect(unknown.length).toBe(1);
    expect(unknown[0]!.violation).toMatch(/no budget entry/);

    const anonymous = budgetViolations(
      [{ file: 'shared-rack-sync.spec.ts', title: 'full flow', reason: null }],
      'collab',
    );
    expect(anonymous.length).toBe(1);
    expect(anonymous[0]!.violation).toMatch(/reasonless/);
  });

  it('CONTROL: the collab quarantine is NOT admitted on e2e — arming one lane is not arming all', () => {
    const rows = [{ file: 'in-card-title.spec.ts', title: 't', reason: 'task #101: quarantined' }];
    expect(budgetViolations(rows, 'e2e').length).toBe(1);
  });
});
