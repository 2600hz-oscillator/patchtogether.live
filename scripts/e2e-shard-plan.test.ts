// scripts/e2e-shard-plan.test.ts
//
// Guards the cost-based e2e shard planner (#1538).
//
// THE PROPERTY THAT MATTERS: once CI assigns spec files explicitly, Playwright
// is no longer the thing guaranteeing the whole suite runs — we are. A planner
// that silently dropped a spec would look EXACTLY like a speedup: shards finish
// sooner, everything is green, and the lost coverage is invisible. So the
// union/no-duplicate assertions below are not hygiene, they are the safety
// argument for the whole change.

import { describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs with JSDoc types, no declaration file
import { planShards, median, loadTimings, loadContention, PENDING_FIRST_MEASUREMENT } from './e2e-shard-plan.mjs';
// @ts-expect-error — plain .mjs with JSDoc types, no declaration file
import { scanContention, MEDIA_MARKERS } from './e2e-contention-scan.mjs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimatch } from 'minimatch';
import { WEBGL_HEAVY_GLOBS } from '../e2e/webgl-heavy-globs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_DIR = join(REPO, 'e2e/tests');

const SHARDS = 10;

describe('the partition covers the suite exactly', () => {
  const timings: Record<string, number> = loadTimings();
  const files = Object.keys(timings);

  it('has real timings to plan with (not vacuous)', () => {
    // Anchored to a NAME the artifact must contain, never to a count.
    expect(files).toContain('per-module-per-port-inputs.spec.ts');
    expect(Object.values(timings).every((v) => typeof v === 'number' && v >= 0)).toBe(true);
  });

  it('every file lands in exactly one shard — none dropped, none duplicated', () => {
    const { groups } = planShards(files, timings, SHARDS);
    const flat = groups.flat();
    expect(flat.length, 'a dropped spec would look like a speedup').toBe(files.length);
    expect(new Set(flat).size, 'a duplicated spec wastes a shard and skews the balance').toBe(files.length);
    expect([...flat].sort()).toEqual([...files].sort());
  });

  it('is deterministic — CI computes this independently per shard job', () => {
    // Each shard job runs the planner itself; they must agree without talking.
    const a = planShards(files, timings, SHARDS).groups;
    const b = planShards([...files].reverse(), timings, SHARDS).groups;
    expect(b).toEqual(a);
  });

  it('a spec with NO measured cost is still scheduled, and is reported', () => {
    // A spec added since the last timings accept must not vanish from CI.
    const withNew = [...files, 'zz-brand-new.spec.ts'];
    const { groups, unknown } = planShards(withNew, timings, SHARDS);
    expect(unknown).toContain('zz-brand-new.spec.ts');
    expect(groups.flat()).toContain('zz-brand-new.spec.ts');
    expect(groups.flat().length).toBe(withNew.length);
  });

  it('balances cost far better than the count-based split it replaces', () => {
    const { loads } = planShards(files, timings, SHARDS);
    const spread = Math.max(...loads) / Math.min(...loads);
    // Measured baseline for the CURRENT (count-based) sharding is 2.31x.
    // This is a policy threshold on a DERIVED measurement, not a population
    // count: it does not change when the suite grows.
    expect(spread, `cost spread across ${SHARDS} shards`).toBeLessThan(1.15);
  });

  it('degenerate shard counts behave', () => {
    expect(planShards(files, timings, 1).groups[0].length).toBe(files.length);
    expect(() => planShards(files, timings, 0)).toThrow();
  });
});

describe('contention classes are SPREAD, not packed', () => {
  const timings: Record<string, number> = loadTimings();
  const contention: Record<string, string> = loadContention();
  const files = Object.keys(timings);

  it('the media class is derived and non-empty (not vacuous)', () => {
    // Anchored to a NAME the class must contain — the spec whose 3/3 failure
    // proved cost balance alone is not sufficient.
    expect(contention['camera-input.spec.ts']).toBe('media');
  });

  it('no shard gets a disproportionate share of one class', () => {
    // WHY THIS EXISTS: cost balancing implicitly assumes specs are INDEPENDENT.
    // They are not. LPT packs expensive specs together precisely BECAUSE they
    // are expensive, which put camera-input on a shard with five other media
    // specs and failed it 3/3 (`{present: true, tracks: []}` — the element
    // outliving its stream under concurrent decode). Cost spread was perfect
    // and the lane was still red, so this property cannot be expressed as cost.
    const { groups } = planShards(files, timings, SHARDS, contention);
    const perShard = groups.map(
      (g: string[]) => g.filter((f) => contention[f] === 'media').length,
    );
    const total = files.filter((f) => contention[f] === 'media').length;
    // EXACTLY the round-robin ideal, with no slack. Measured: pure LPT gives
    // [0,3,3,2,3,2,4,4,0,1] — max 4, and two shards get NONE — while spreading
    // gives [3,3,2,2,2,2,2,2,2,2]. A `+1` of slack here would admit the LPT
    // arrangement and this guard would not discriminate; I wrote it that way
    // first and the negative control caught it.
    const ceiling = Math.ceil(total / SHARDS);
    expect(
      Math.max(...perShard),
      `media specs per shard ${JSON.stringify(perShard)} — packing them re-creates the contention that reddened a required lane`,
    ).toBeLessThanOrEqual(ceiling);
    // And no shard may be starved of the class while another carries a pile:
    // pure LPT left two shards with ZERO, which is the same imbalance seen from
    // the other side.
    expect(Math.max(...perShard) - Math.min(...perShard)).toBeLessThanOrEqual(1);
  });

  it('spreading does not cost the balance it was added to protect', () => {
    const { loads } = planShards(files, timings, SHARDS, contention);
    expect(Math.max(...loads) / Math.min(...loads)).toBeLessThan(1.15);
  });
});

describe('median', () => {
  it('handles odd, even and empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(1);
  });
});

describe('FRESHNESS GATE — the artifact cannot silently predate the suite (#1600)', () => {
  // THE FAILURE MODE: a spec added after the last accept is invisible to the
  // cost artifact, rides the MEDIAN, and is free to co-locate with its own
  // contention class. layers-survive-card-collapse cost 309 CPU-s, was
  // scheduled at ~6 s (40x under), and failed shard 8 on a branch where it was
  // green everywhere else. Nothing reddened, because nothing LOOKED.
  //
  // MEMBERSHIP IS DERIVED, never listed: a spec is expected to be measured
  // exactly when the sharded lane runs it — on disk, not excluded by the
  // WEBGL_HEAVY globs (those specs are not run on PRs at all, see
  // e2e/webgl-heavy-globs.ts), and not a file whose source carries the
  // @collab/@capacity tags (those run in the collab job). The tag filter is an
  // over-approximation (a file with SOME tagged tests still runs its untagged
  // tests in the shard lane), so it is applied only on the EXPECTED side —
  // being measured while tag-filtered here is fine; being unmeasured while
  // scheduled is the defect.
  const timings: Record<string, number> = loadTimings();
  const diskSpecs = readdirSync(SPEC_DIR).filter((f) => f.endsWith('.spec.ts'));
  const scheduled = diskSpecs.filter((f) => {
    if (WEBGL_HEAVY_GLOBS.some((g: string) => minimatch(`e2e/tests/${f}`, g) || minimatch(f, g.replace(/^\*\*\//, '')))) return false;
    const src = readFileSync(join(SPEC_DIR, f), 'utf8');
    if (/@collab|@capacity/.test(src)) return false;
    return true;
  });

  it('every scheduled spec is MEASURED or NAMED as pending — deny by default', () => {
    const pendingNames = new Set(PENDING_FIRST_MEASUREMENT.map((p: { spec: string }) => p.spec));
    const offenders = scheduled.filter((f) => !(f in timings) && !pendingNames.has(f));
    expect(
      offenders,
      `unmeasured scheduled spec(s) — each rides the MEDIAN cost and joins no shard-balance ` +
        `reasoning until \`task e2e:timings:accept -- <ci-run-id>\` runs. Either accept a fresh run ` +
        `or add a NAMED { spec, why } entry to PENDING_FIRST_MEASUREMENT (e2e-shard-plan.mjs).`,
    ).toEqual([]);
  });

  it('the gate is not vacuous: the scheduled set is derived and non-trivial', () => {
    // Anchored to NAMES the derivation must produce, never to a count.
    expect(scheduled).toContain('per-module-per-port-inputs.spec.ts');
    expect(scheduled).toContain('camera-input.spec.ts');
    // …and the derivation really excludes: a heavy-glob spec is not scheduled.
    expect(scheduled).not.toContain('wavesculpt.spec.ts');
  });

  it('every PENDING entry is anchored — names a live spec that is genuinely unmeasured', () => {
    for (const p of PENDING_FIRST_MEASUREMENT as { spec: string; why: string }[]) {
      expect(existsSync(join(SPEC_DIR, p.spec)), `PENDING names a spec that no longer exists: ${p.spec}`).toBe(true);
      expect(p.spec in timings, `PENDING entry is STALE — ${p.spec} has been measured; remove the entry`).toBe(false);
      expect(p.why.length, `PENDING.why for ${p.spec} must say why it awaits measurement, not just that it does`).toBeGreaterThan(40);
    }
  });

  it('every measured entry names a spec that still exists — a deleted spec reddens here', () => {
    const stale = Object.keys(timings).filter((k) => !existsSync(join(SPEC_DIR, k)));
    expect(stale, 'artifact entries for deleted specs — run the accept to drop them').toEqual([]);
  });
});

describe('contention is DERIVED AT PLAN TIME, never a committed snapshot (#1600)', () => {
  it('loadContention() IS the source scan — the rewiring cannot silently revert', () => {
    expect(loadContention()).toEqual(scanContention());
  });

  it('the committed artifact carries COSTS ONLY', () => {
    const doc = JSON.parse(readFileSync(join(REPO, 'e2e/e2e-timings.generated.json'), 'utf8'));
    expect(
      'contention' in doc,
      'a committed contention key is a snapshot of a derivation — the exact staleness #1600 fixed',
    ).toBe(false);
  });

  it("classifies the class's own war stories (the specs whose co-location failed a lane)", () => {
    const map = scanContention();
    // camera-input failed 3/3 when packed with these — the reason PASS 1 exists.
    expect(map['camera-input.spec.ts']).toBe('media');
    expect(map['videobox-upload-perf.spec.ts']).toBe('media');
    expect(map['live-glyphs.spec.ts']).toBe('media');
    // …and the spec whose median-scheduling failure produced this issue.
    expect(map['layers-survive-card-collapse.spec.ts']).toBe('media');
  });

  it('does NOT classify DOM-only specs — over-breadth displaces the cost packing', () => {
    const map = scanContention();
    for (const f of ['flip-rack-rear-view.spec.ts', 'tab-focus-traversal.spec.ts', 'unpatch-patch-point.spec.ts']) {
      expect(map[f], `${f} is a DOM spec; if it now genuinely uses media, update this example`).toBeUndefined();
    }
  });

  it('markers are the load-bearing list — a gutted marker set reddens (permanent negative control)', () => {
    // The same predicate the scanner uses, applied to a marker that must
    // always classify: getUserMedia is the fake-capture-device fight itself.
    expect(MEDIA_MARKERS).toContain('getUserMedia');
    const src = readFileSync(join(SPEC_DIR, 'camera-input.spec.ts'), 'utf8');
    expect(MEDIA_MARKERS.some((m: string) => src.includes(m))).toBe(true);
  });
});
