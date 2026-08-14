// scripts/vrt-shard-coverage.test.ts
//
// PERMANENT NEGATIVE-CONTROL LEGS for the one vrt-strict check that is anchored
// to the RUN rather than to the plan (#1595).
//
// This parser is the last line between "the required lane got faster" and "the
// required lane stopped rendering things". If it silently stopped matching the
// reporter's line format it would report `executed 0` — which the CI step
// catches — but if it matched TOO loosely, or counted a skip as a run, it would
// report a clean number for a lane that ran nothing. So the fixtures below are
// verbatim `list`-reporter lines from a real ubuntu-latest run (31736165616,
// job 94568963454), and every direction the check is supposed to move is
// exercised, not just the passing one.
//
// Validated once against the WHOLE log of that run before this file existed:
// 115 planned / 115 executed / 0 missing / 0 extra / 0 skipped, and the three
// perturbations below each flipped it red. These are those perturbations, kept.

import { describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs with JSDoc types, no declaration file
import { parseRunLog, compare } from './vrt-shard-coverage.mjs';

/** Verbatim lines from run 31736165616 (timestamps included — GitHub prefixes
 *  every log line with one, and the parser has to survive that). */
const LOG = [
  '2026-08-13T19:36:11.9235806Z   ✓    1 [chromium-vrt] › vrt/vrt.spec.ts:64:5 › VRT: every module card matches its baseline › adsr card matches baseline (17.1s)',
  '2026-08-13T19:36:17.0419606Z   ✓    2 [chromium-vrt] › vrt/vrt.spec.ts:64:5 › VRT: every module card matches its baseline › buggles card matches baseline (5.1s)',
  '2026-08-13T19:44:03.0000000Z   ✓   50 [chromium-vrt] › vrt/workflow-shell-faces.spec.ts:187:5 › VRT: P1 curated faces (?shell=1) — compact lane tile + dock full-view › face-tidyVco-dock: the dock full-view faceplate matches baseline (10.1s)',
  '2026-08-13T19:45:03.0000000Z   ✓   99 [chromium-vrt] › vrt/workflow-shell-faces.spec.ts:370:3 › VRT: P1 curated faces (?shell=1) — compact lane tile + dock full-view › every shipped face has a scene, and every scene has its baselines (6ms)',
].join('\n');

const KEYS = [
  'vrt.spec.ts :: adsr card matches baseline',
  'vrt.spec.ts :: buggles card matches baseline',
  'workflow-shell-faces.spec.ts :: face-tidyVco-dock: the dock full-view faceplate matches baseline',
  'workflow-shell-faces.spec.ts :: every shipped face has a scene, and every scene has its baselines',
];

describe('parsing what the shard actually executed', () => {
  it('reads the real reporter format, timestamps and all', () => {
    const { ran, skipped } = parseRunLog(LOG);
    expect([...ran.keys()].sort()).toEqual([...KEYS].sort());
    expect(skipped).toEqual([]);
  });

  it('keeps seconds, and converts a millisecond duration', () => {
    const { ran } = parseRunLog(LOG);
    expect(ran.get('vrt.spec.ts :: adsr card matches baseline')).toBe(17.1);
    expect(ran.get('workflow-shell-faces.spec.ts :: every shipped face has a scene, and every scene has its baselines')).toBeCloseTo(0.006);
  });

  it('a FAILED test still counts as executed — red and blind are different diagnoses', () => {
    const { ran } = parseRunLog(LOG.replace('✓    1', '✘    1'));
    expect([...ran.keys()]).toContain('vrt.spec.ts :: adsr card matches baseline');
  });
});

describe('the check moves in every direction it claims to', () => {
  it('POSITIVE: the planned set and the executed set agree', () => {
    const { ran, skipped } = parseRunLog(LOG);
    expect(compare(KEYS, ran, skipped).ok).toBe(true);
  });

  it('NEGATIVE (drop): a planned scene that never ran is MISSING, by name', () => {
    const { ran, skipped } = parseRunLog(LOG.split('\n').filter((l) => !l.includes('adsr')).join('\n'));
    const r = compare(KEYS, ran, skipped);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['vrt.spec.ts :: adsr card matches baseline']);
  });

  it('NEGATIVE (skip): a SKIP is not a pass', () => {
    // The whole reason this check exists rather than a pass/fail count.
    const { ran, skipped } = parseRunLog(LOG.replace('✓    2', '-    2'));
    const r = compare(KEYS, ran, skipped);
    expect(r.ok).toBe(false);
    expect(r.skipped).toEqual(['vrt.spec.ts :: buggles card matches baseline']);
    expect(r.missing).toEqual(['vrt.spec.ts :: buggles card matches baseline']);
  });

  it('NEGATIVE (extra): a scene this shard was not assigned is EXTRA', () => {
    // Two shards running the same scene means some third scene may be orphaned,
    // so an extra is a coverage bug, not a harmless duplicate.
    const { ran, skipped } = parseRunLog(LOG);
    const r = compare(KEYS.slice(1), ran, skipped);
    expect(r.ok).toBe(false);
    expect(r.extra).toEqual(['vrt.spec.ts :: adsr card matches baseline']);
  });

  it('a log with NO reporter lines at all reports every scene missing', () => {
    // "Playwright never started" must not look like "everything passed".
    const { ran, skipped } = parseRunLog('some unrelated output\nnpm ERR! boom\n');
    const r = compare(KEYS, ran, skipped);
    expect(r.ok).toBe(false);
    expect(r.missing.sort()).toEqual([...KEYS].sort());
  });
});
