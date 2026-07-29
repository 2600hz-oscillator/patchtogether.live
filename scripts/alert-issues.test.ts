// scripts/alert-issues.test.ts
//
// Gate for the ALERT-ISSUE RECONCILER (scripts/alert-issues.mjs +
// .github/workflows/live-smoke-alert.yml). Pure-unit, zero-flake, runs in the
// `unit` lane via `task test` → `task test:scripts`. No network, no clock.
//
// The bug being gated: the workflow called `issues.create()` on every firing
// run, so ONE ongoing incident (Neon HTTP 402) opened 45 of the repo's 47 open
// issues in ~4 weeks and none of them ever auto-closed. The tracker became 96%
// noise, which hides real human-filed issues.
//
// The fix must dedup WITHOUT suppressing, so the properties asserted here split
// in two, and the second set is the one that actually matters:
//
//   DEDUP  — a repeat of the SAME failure updates one issue instead of opening
//            another (the flood-stopping property).
//   SAFETY — the negative controls, each of which is a way the fix could have
//            made things WORSE than the flood:
//              · a DIFFERENT check must still open its own issue mid-incident
//                (no new outage is swallowed into an existing one);
//              · an issue with no key marker is NEVER touched (human-filed
//                issues, and the 45 pre-existing markerless duplicates, are
//                untouchable by construction);
//              · another environment's issues are never claimed or closed;
//              · a probe that produced NO USABLE RESULT closes nothing and
//                raises its own alert — a monitor that cannot measure must
//                never read as green.
//
// Per CLAUDE.md's "VALIDATE THE INSTRUMENT": `describe('negative control — the
// key is what makes dedup work')` perturbs the KEY DERIVATION itself and shows
// the old title-derived key fails on the very data that caused the flood. A
// dedup test that only ever feeds identical inputs would pass with a broken key.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as alerts from './alert-issues.mjs';

const {
  ALERT_LABELS,
  KEY_PREFIX,
  KNOWN_CHECK_IDS,
  HARNESS_CHECK_ID,
  CHECK_TITLES,
  envLabelFromUrl,
  alertKey,
  markerFor,
  alertKeyOf,
  parseAlertKey,
  renderNewIssueBody,
  parseStats,
  upsertStatsBlock,
  renderStatsBlock,
  issueTitle,
  planAlertActions,
  interpretSmokeLog,
  extractSmokeResult,
  applyPlan,
  inputFromEnv,
  sanitizeDetail,
} = alerts as unknown as Record<string, any>;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_SH = readFileSync(join(ROOT, 'scripts/live-smoke-alert.sh'), 'utf8');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/live-smoke-alert.yml'), 'utf8');

const ENV = 'dev.patchtogether.live';
const T0 = '2026-07-01T00:00:00.000Z';

/** The real HTTP 402 text from the flood, minus the parts that vary per run. */
const NEON_402 = (n: number) =>
  'web /api/health database UNREACHABLE: Server error (HTTP status 402): ' +
  `{"message":"You have exceeded the compute time quota","request_id":"req-${n}"}`;

// ---------------------------------------------------------------------------
// Helpers: an in-memory GitHub so the whole loop runs without a network
// ---------------------------------------------------------------------------

type FakeIssue = {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed';
  stateReason?: string;
  comments: string[];
};

function fakeGithub(seed: Partial<FakeIssue>[] = []) {
  let next = 1;
  const issues: FakeIssue[] = [];
  for (const s of seed) {
    issues.push({
      number: s.number ?? next++,
      title: s.title ?? 'seeded',
      body: s.body ?? '',
      labels: s.labels ?? [...ALERT_LABELS],
      state: s.state ?? 'open',
      comments: [],
    });
    next = Math.max(next, (s.number ?? 0) + 1);
  }
  return {
    issues,
    createdCount: 0,
    async listOpenAlertIssues() {
      return issues
        .filter((i) => i.state === 'open')
        .map((i) => ({ number: i.number, title: i.title, body: i.body }));
    },
    async createIssue(this: any, { title, body, labels }: any) {
      this.createdCount++;
      const issue: FakeIssue = {
        number: next++,
        title,
        body,
        labels,
        state: 'open',
        comments: [],
      };
      issues.push(issue);
      return { number: issue.number };
    },
    async updateIssue(n: number, patch: any) {
      const i = issues.find((x) => x.number === n);
      if (!i) throw new Error(`no issue #${n}`);
      Object.assign(i, patch);
    },
    async createComment(n: number, body: string) {
      const i = issues.find((x) => x.number === n);
      if (!i) throw new Error(`no issue #${n}`);
      i.comments.push(body);
    },
    async closeIssue(n: number, reason: string) {
      const i = issues.find((x) => x.number === n);
      if (!i) throw new Error(`no issue #${n}`);
      i.state = 'closed';
      i.stateReason = reason;
    },
  };
}

/** One reconcile tick: probe result in, GitHub mutated, plan out. */
async function tick(
  gh: ReturnType<typeof fakeGithub>,
  {
    failing,
    probeOk = true,
    nowIso,
    env = ENV,
  }: { failing: { id: string; detail: string }[]; probeOk?: boolean; nowIso: string; env?: string },
) {
  const plan = planAlertActions({
    env,
    probeOk,
    failing,
    openIssues: await gh.listOpenAlertIssues(),
    nowIso,
    runUrl: 'https://github.com/o/r/actions/runs/1',
    probeConfig: { webUrl: `https://${env}`, relayUrl: 'https://relay', critMb: '480' },
  });
  await applyPlan(plan, gh);
  return plan;
}

const openIssues = (gh: ReturnType<typeof fakeGithub>) => gh.issues.filter((i) => i.state === 'open');

// ---------------------------------------------------------------------------
// 1. The key is pinned to the probe script — the two cannot drift
// ---------------------------------------------------------------------------

describe('check-id registry is pinned to scripts/live-smoke-alert.sh', () => {
  /** Every `failures+=("…")` literal in the probe script. */
  function shellCheckIds(src: string): string[] {
    const out: string[] = [];
    const re = /failures\+=\("([^"]+)"\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) out.push(m[1]);
    return out;
  }

  it('finds a non-trivial number of ids in the shell script (the parser works)', () => {
    // Negative control on the INSTRUMENT: if the regex silently stopped
    // matching, the set-equality assertion below would compare [] to [] after
    // someone emptied KNOWN_CHECK_IDS, and pass vacuously.
    expect(shellCheckIds(PROBE_SH).length).toBeGreaterThanOrEqual(9);
    expect(shellCheckIds('nothing here')).toEqual([]);
  });

  it('KNOWN_CHECK_IDS === the ids the probe script can emit', () => {
    const fromShell = [...new Set(shellCheckIds(PROBE_SH))].sort();
    expect([...KNOWN_CHECK_IDS].sort()).toEqual(fromShell);
  });

  it('every known id (plus the harness id) has a stable human title', () => {
    for (const id of [...KNOWN_CHECK_IDS, HARNESS_CHECK_ID]) {
      expect(CHECK_TITLES[id], `missing CHECK_TITLES entry for '${id}'`).toBeTruthy();
    }
  });

  it('the probe script emits a machine-readable per-check array', () => {
    // The reconciler cannot key on anything the script does not emit.
    expect(PROBE_SH).toContain('checks: $checks');
    expect(PROBE_SH).toMatch(/--argjson checks "\$checks_json"/);
  });
});

// ---------------------------------------------------------------------------
// 2. Key stability — the property the whole design rests on
// ---------------------------------------------------------------------------

describe('alert key stability', () => {
  it('derives the env from the probed URL hostname', () => {
    expect(envLabelFromUrl('https://dev.patchtogether.live')).toBe('dev.patchtogether.live');
    expect(envLabelFromUrl('https://dev.patchtogether.live/api/health?x=1')).toBe(
      'dev.patchtogether.live',
    );
    expect(envLabelFromUrl('https://PATCHTOGETHER.LIVE')).toBe('patchtogether.live');
    expect(envLabelFromUrl('')).toBe('unknown-env');
    expect(envLabelFromUrl('not a url at all')).toBe('not-a-url-at-all');
  });

  it('is identical across runs whose error DETAIL differs', () => {
    // This is the exact data that defeated the old title-based identity.
    const a = alertKey(ENV, 'web-db-unreachable');
    const b = alertKey(ENV, 'web-db-unreachable');
    expect(a).toBe(b);
    expect(a).toBe(`${KEY_PREFIX}/${ENV}/web-db-unreachable`);
    // and the title, which humans read, is likewise run-invariant
    expect(issueTitle(ENV, 'web-db-unreachable')).toBe(
      issueTitle(ENV, 'web-db-unreachable'),
    );
    expect(issueTitle(ENV, 'web-db-unreachable')).not.toContain('402');
  });

  it('separates environments and separates checks', () => {
    expect(alertKey('prod.x', 'web-db-unreachable')).not.toBe(
      alertKey('dev.x', 'web-db-unreachable'),
    );
    expect(alertKey(ENV, 'relay-mem-crit')).not.toBe(alertKey(ENV, 'web-db-unreachable'));
  });

  it('round-trips through the body marker, and ignores bodies without one', () => {
    const key = alertKey(ENV, 'relay-mem-crit');
    const body = `${markerFor(key)}\nsome prose`;
    expect(alertKeyOf(body)).toBe(key);
    expect(parseAlertKey(key)).toEqual({
      prefix: KEY_PREFIX,
      env: ENV,
      checkId: 'relay-mem-crit',
    });
    expect(alertKeyOf('a human wrote this issue by hand')).toBeNull();
    expect(alertKeyOf('')).toBeNull();
    expect(alertKeyOf(undefined)).toBeNull();
    expect(parseAlertKey('some-other-tool/env/check')).toBeNull();
  });
});

describe('negative control — the key is what makes dedup work', () => {
  // Perturb the IDENTITY FUNCTION, not the code under test, and check the
  // number moves. Without this, every dedup assertion below could be passing
  // for the wrong reason (identical inputs in, identical key out).
  //
  // The old identity was the TITLE: `[CRIT] <env> alert: <reason>.slice(0,80)`.
  // Reconstructed here exactly, and run over the two shapes of reason the probe
  // actually produces.
  const oldTitleFor = (reason: string) => `[CRIT] ${ENV} alert: ${reason.split(';')[0].slice(0, 80)}`;

  it('the OLD title is ACCIDENTALLY stable for the 402 flood — the varying part falls past the 80-char cut', () => {
    // Verified against the live tracker on 2026-07-29: #1193…#1251 all carry
    // ONE byte-identical title. So the flood was not caused by a varying title —
    // it was caused by calling issues.create() unconditionally. But the title
    // being stable here is LUCK, not design: it is stable only because the
    // upstream `{"message":…}` body starts after character 80.
    const titles = [0, 1, 2, 3, 4].map((n) => oldTitleFor(NEON_402(n)));
    expect(new Set(titles).size).toBe(1);
    expect(titles[0]).toContain('{"message"');
    expect(titles[0]).not.toContain('request_id'); // the varying part, truncated away
  });

  it('the OLD title BREAKS the moment the varying part moves earlier in the reason', () => {
    // relay-mem-crit is the real counter-example: rss_mb is measured every probe
    // and sits ~14 characters into the reason, well inside the cut. Under the
    // old scheme this alert would have opened a fresh issue on EVERY tick with a
    // visibly different title — the flood, but unmistakable.
    const memTitles = [481.2, 483.9, 490.1, 502.7, 511.3].map((rss) =>
      oldTitleFor(`relay rss_mb=${rss} exceeds RELAY_MEM_CRIT_MB=480`),
    );
    expect(new Set(memTitles).size).toBe(5);

    // Same for a flapping upstream status code.
    const statusTitles = [500, 502, 503, 504].map((code) =>
      oldTitleFor(`web /api/health returned HTTP ${code}`),
    );
    expect(new Set(statusTitles).size).toBe(4);
  });

  it('the NEW (env, check) key yields exactly ONE id for BOTH of those', () => {
    expect(new Set([0, 1, 2, 3, 4].map(() => alertKey(ENV, 'web-db-unreachable'))).size).toBe(1);
    expect(new Set([481.2, 483.9, 490.1].map(() => alertKey(ENV, 'relay-mem-crit'))).size).toBe(1);
    expect(new Set([500, 502, 503].map(() => alertKey(ENV, 'web-health-status'))).size).toBe(1);
  });

  it('and it STILL distinguishes the three of them from each other', () => {
    // The other half: a key that collapses everything would also pass the test
    // above. Dedup must not become suppression.
    expect(
      new Set([
        alertKey(ENV, 'web-db-unreachable'),
        alertKey(ENV, 'relay-mem-crit'),
        alertKey(ENV, 'web-health-status'),
      ]).size,
    ).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 3. Body rendering + stats accounting
// ---------------------------------------------------------------------------

describe('issue body', () => {
  const body = renderNewIssueBody({
    key: alertKey(ENV, 'web-db-unreachable'),
    env: ENV,
    checkId: 'web-db-unreachable',
    detail: NEON_402(1),
    nowIso: T0,
    runUrl: 'https://run',
    webUrl: `https://${ENV}`,
    relayUrl: 'https://relay',
    critMb: '480',
  });

  it('carries the marker and an initial stats block', () => {
    expect(alertKeyOf(body)).toBe(alertKey(ENV, 'web-db-unreachable'));
    expect(parseStats(body)).toEqual({ firstSeen: T0, lastSeen: T0, consecutive: 1 });
  });

  it('preserves human prose outside the stats region on update', () => {
    const withNote = `${body}\n\n### Triage\nOwner pinged Neon support 2026-07-29.`;
    const updated = upsertStatsBlock(
      withNote,
      renderStatsBlock({
        firstSeen: T0,
        lastSeen: '2026-07-29T00:00:00.000Z',
        consecutive: 900,
        detail: NEON_402(2),
        runUrl: 'https://run/2',
      }),
    );
    expect(updated).toContain('Owner pinged Neon support 2026-07-29.');
    expect(parseStats(updated)).toEqual({
      firstSeen: T0,
      lastSeen: '2026-07-29T00:00:00.000Z',
      consecutive: 900,
    });
  });

  it('appends a stats block if a human deleted the region', () => {
    const mangled = `${markerFor(alertKey(ENV, 'relay-mem-crit'))}\njust prose`;
    const fixed = upsertStatsBlock(
      mangled,
      renderStatsBlock({ firstSeen: T0, lastSeen: T0, consecutive: 1, detail: 'x', runUrl: '' }),
    );
    expect(parseStats(fixed).consecutive).toBe(1);
    expect(fixed).toContain('just prose');
  });

  it('sanitizes multi-line / backticked upstream error text', () => {
    expect(sanitizeDetail('line1\nline2 `tick`')).toBe("line1 line2 'tick'");
    expect(sanitizeDetail('')).toBe('(no detail)');
    expect(sanitizeDetail('x'.repeat(1000)).length).toBeLessThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// 4. THE CORE: the four required behaviours
// ---------------------------------------------------------------------------

describe('reconcile — first failure OPENS', () => {
  it('opens exactly one issue, labelled, with the key marker', async () => {
    const gh = fakeGithub();
    const plan = await tick(gh, {
      failing: [{ id: 'web-db-unreachable', detail: NEON_402(1) }],
      nowIso: T0,
    });
    expect(plan.creates).toHaveLength(1);
    expect(plan.updates).toHaveLength(0);
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0].labels).toEqual(ALERT_LABELS);
    expect(alertKeyOf(gh.issues[0].body)).toBe(alertKey(ENV, 'web-db-unreachable'));
  });
});

describe('reconcile — repeat failure does NOT open a second issue', () => {
  it('updates the same issue and never creates again', async () => {
    const gh = fakeGithub();
    await tick(gh, { failing: [{ id: 'web-db-unreachable', detail: NEON_402(0) }], nowIso: T0 });

    for (let n = 1; n <= 5; n++) {
      const plan = await tick(gh, {
        failing: [{ id: 'web-db-unreachable', detail: NEON_402(n) }],
        nowIso: `2026-07-01T0${n}:00:00.000Z`,
      });
      expect(plan.creates).toHaveLength(0);
      expect(plan.updates).toHaveLength(1);
    }
    expect(gh.issues).toHaveLength(1);
    expect(gh.createdCount).toBe(1);
  });

  it('never overwrites a title a human retitled during triage', async () => {
    const gh = fakeGithub();
    await tick(gh, { failing: [{ id: 'web-db-unreachable', detail: NEON_402(0) }], nowIso: T0 });
    gh.issues[0].title = '[CRIT] Neon compute quota exhausted — owner notified 2026-07-29';

    const plan = await tick(gh, {
      failing: [{ id: 'web-db-unreachable', detail: NEON_402(1) }],
      nowIso: '2026-07-01T00:10:00.000Z',
    });

    expect(plan.updates[0]).not.toHaveProperty('title');
    expect(gh.issues[0].title).toBe(
      '[CRIT] Neon compute quota exhausted — owner notified 2026-07-29',
    );
    // …and the retitle did not break dedup, because identity is the marker
    expect(plan.creates).toHaveLength(0);
    expect(parseStats(gh.issues[0].body).consecutive).toBe(2);
  });

  it('a full 4-week incident at the real cron rate opens ONE issue, not ~4000', async () => {
    // The regression, at scale: 6 ticks/hour × 24 × 28. The old code called
    // issues.create() on every tick past the 30-minute sustained threshold.
    const gh = fakeGithub();
    const ticks = 6 * 24 * 28;
    for (let n = 0; n < ticks; n++) {
      await tick(gh, {
        failing: [{ id: 'web-db-unreachable', detail: NEON_402(n) }],
        nowIso: new Date(Date.parse(T0) + n * 600_000).toISOString(),
      });
    }
    expect(gh.createdCount).toBe(1);
    expect(gh.issues).toHaveLength(1);
    // and the issue records the true span + count, so nothing is lost by not
    // re-filing: first-seen is still the FIRST tick.
    const stats = parseStats(gh.issues[0].body);
    expect(stats.consecutive).toBe(ticks);
    expect(stats.firstSeen).toBe(T0);
    expect(stats.lastSeen).toBe(new Date(Date.parse(T0) + (ticks - 1) * 600_000).toISOString());
    // no notification-bearing comment was spammed onto it either
    expect(gh.issues[0].comments).toHaveLength(0);
  });
});

describe('reconcile — a DIFFERENT alert key DOES open its own issue', () => {
  it('opens a new issue mid-incident for a genuinely new failure', async () => {
    const gh = fakeGithub();
    await tick(gh, { failing: [{ id: 'web-db-unreachable', detail: NEON_402(1) }], nowIso: T0 });

    // The DB is still down AND now the relay is over its memory ceiling. The
    // relay failure must NOT be swallowed into the DB issue.
    const plan = await tick(gh, {
      failing: [
        { id: 'web-db-unreachable', detail: NEON_402(2) },
        { id: 'relay-mem-crit', detail: 'relay rss_mb=512 exceeds RELAY_MEM_CRIT_MB=480' },
      ],
      nowIso: '2026-07-01T00:10:00.000Z',
    });

    expect(plan.creates.map((c: any) => c.checkId)).toEqual(['relay-mem-crit']);
    expect(plan.updates.map((u: any) => u.checkId)).toEqual(['web-db-unreachable']);
    expect(openIssues(gh)).toHaveLength(2);
    expect(gh.issues.map((i) => alertKeyOf(i.body)).sort()).toEqual(
      [alertKey(ENV, 'relay-mem-crit'), alertKey(ENV, 'web-db-unreachable')].sort(),
    );
  });

  it('every known check id gets its own issue — nothing collapses into one', async () => {
    const gh = fakeGithub();
    await tick(gh, {
      failing: KNOWN_CHECK_IDS.map((id: string) => ({ id, detail: `${id} failed` })),
      nowIso: T0,
    });
    expect(gh.createdCount).toBe(KNOWN_CHECK_IDS.length);
    expect(new Set(gh.issues.map((i) => alertKeyOf(i.body))).size).toBe(KNOWN_CHECK_IDS.length);
  });

  it('a NEW failure still opens while an OLD one is in its 1000th tick', async () => {
    // The worst case for any "we already have an open alert" heuristic.
    const gh = fakeGithub();
    for (let n = 0; n < 1000; n++) {
      await tick(gh, {
        failing: [{ id: 'web-db-unreachable', detail: NEON_402(n) }],
        nowIso: new Date(Date.parse(T0) + n * 600_000).toISOString(),
      });
    }
    expect(gh.createdCount).toBe(1);
    const plan = await tick(gh, {
      failing: [
        { id: 'web-db-unreachable', detail: NEON_402(1000) },
        { id: 'relay-health-status', detail: 'relay /health returned HTTP 502' },
      ],
      nowIso: '2026-08-01T00:00:00.000Z',
    });
    expect(plan.creates).toHaveLength(1);
    expect(gh.createdCount).toBe(2);
  });
});

describe('reconcile — RECOVERY closes the issue', () => {
  it('comments and closes when the check stops failing', async () => {
    const gh = fakeGithub();
    await tick(gh, { failing: [{ id: 'web-db-unreachable', detail: NEON_402(1) }], nowIso: T0 });
    await tick(gh, {
      failing: [{ id: 'web-db-unreachable', detail: NEON_402(2) }],
      nowIso: '2026-07-01T00:10:00.000Z',
    });

    const plan = await tick(gh, { failing: [], nowIso: '2026-07-01T00:20:00.000Z' });

    expect(plan.closes).toHaveLength(1);
    expect(plan.closes[0].key).toBe(alertKey(ENV, 'web-db-unreachable'));
    const issue = gh.issues[0];
    expect(issue.state).toBe('closed');
    expect(issue.stateReason).toBe('completed');
    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0]).toContain('RECOVERED');
    expect(issue.comments[0]).toContain('2 consecutive probe(s)');
  });

  it('closes only the recovered check, leaving the still-failing one open', async () => {
    const gh = fakeGithub();
    await tick(gh, {
      failing: [
        { id: 'web-db-unreachable', detail: NEON_402(1) },
        { id: 'relay-mem-crit', detail: 'over ceiling' },
      ],
      nowIso: T0,
    });
    const plan = await tick(gh, {
      failing: [{ id: 'web-db-unreachable', detail: NEON_402(2) }],
      nowIso: '2026-07-01T00:10:00.000Z',
    });
    expect(plan.closes.map((c: any) => c.checkId)).toEqual(['relay-mem-crit']);
    expect(openIssues(gh)).toHaveLength(1);
    expect(alertKeyOf(openIssues(gh)[0].body)).toBe(alertKey(ENV, 'web-db-unreachable'));
  });

  it('a RECURRENCE after recovery opens a fresh issue (re-notifies)', async () => {
    const gh = fakeGithub();
    await tick(gh, { failing: [{ id: 'relay-mem-crit', detail: 'over' }], nowIso: T0 });
    await tick(gh, { failing: [], nowIso: '2026-07-01T00:10:00.000Z' });
    const plan = await tick(gh, {
      failing: [{ id: 'relay-mem-crit', detail: 'over again' }],
      nowIso: '2026-07-01T00:20:00.000Z',
    });
    expect(plan.creates).toHaveLength(1);
    expect(gh.createdCount).toBe(2);
    expect(openIssues(gh)).toHaveLength(1);
  });

  it('healthy with nothing open is a complete no-op', async () => {
    const gh = fakeGithub();
    const plan = await tick(gh, { failing: [], nowIso: T0 });
    expect(plan).toMatchObject({ creates: [], updates: [], closes: [], duplicates: [] });
    expect(gh.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. SAFETY negative controls — the ways this fix could be WORSE than the flood
// ---------------------------------------------------------------------------

describe('safety — issues without our marker are untouchable', () => {
  it('never updates, comments on, or closes a human-filed issue', async () => {
    const gh = fakeGithub([
      { number: 862, title: 'Test quality: migrate Playwright selectors', body: 'human prose' },
      { number: 868, title: '[collab-nightly] under-load @collab lane failing', body: 'more prose' },
    ]);
    const before = JSON.stringify(gh.issues);

    await tick(gh, { failing: [{ id: 'web-db-unreachable', detail: NEON_402(1) }], nowIso: T0 });
    await tick(gh, { failing: [], nowIso: '2026-07-01T00:10:00.000Z' }); // recovery sweep

    const survivors = gh.issues.filter((i) => i.number === 862 || i.number === 868);
    expect(JSON.stringify(survivors)).toBe(before);
    expect(survivors.every((i) => i.state === 'open')).toBe(true);
    expect(survivors.every((i) => i.comments.length === 0)).toBe(true);
  });

  it('leaves the 45 pre-existing markerless duplicates completely alone', async () => {
    // They carry the alert labels and the old [CRIT] title, so a
    // title/label-based reconciler would have mass-edited or mass-closed them.
    const legacy = Array.from({ length: 45 }, (_, n) => ({
      number: 1193 + n,
      title: `[CRIT] ${ENV} alert: ${NEON_402(n).slice(0, 80)}`,
      body: `**Live smoke probe failed** (state: SUSTAINED).\n\n**Reason:** ${NEON_402(n)}`,
      labels: [...ALERT_LABELS],
    }));
    const gh = fakeGithub(legacy);
    const before = JSON.stringify(gh.issues);

    await tick(gh, { failing: [{ id: 'web-db-unreachable', detail: NEON_402(99) }], nowIso: T0 });
    const recovery = await tick(gh, { failing: [], nowIso: '2026-07-01T00:10:00.000Z' });

    expect(recovery.closes.map((c: any) => c.number)).not.toContain(1193);
    const legacyNow = gh.issues.filter((i) => i.number >= 1193 && i.number <= 1237);
    expect(JSON.stringify(legacyNow)).toBe(before);
    expect(legacyNow.every((i) => i.state === 'open')).toBe(true);
  });
});

describe('safety — environments never cross', () => {
  it('a dev run neither claims nor closes a prod issue', async () => {
    const prodKey = alertKey('patchtogether.live', 'web-db-unreachable');
    const gh = fakeGithub([
      { number: 500, title: 'prod alert', body: `${markerFor(prodKey)}\n${renderStatsBlock({ firstSeen: T0, lastSeen: T0, consecutive: 3, detail: 'x', runUrl: '' })}` },
    ]);

    // dev is failing the SAME check — must open its own, not adopt #500
    const failPlan = await tick(gh, {
      failing: [{ id: 'web-db-unreachable', detail: NEON_402(1) }],
      nowIso: T0,
    });
    expect(failPlan.creates).toHaveLength(1);
    expect(failPlan.updates).toHaveLength(0);

    // dev recovers — must not close the prod issue
    const okPlan = await tick(gh, { failing: [], nowIso: '2026-07-01T00:10:00.000Z' });
    expect(okPlan.closes.map((c: any) => c.number)).not.toContain(500);
    expect(gh.issues.find((i) => i.number === 500)!.state).toBe('open');
  });
});

describe('safety — a broken probe is loud, and closes nothing', () => {
  it('opens its own probe-harness alert and asserts no recovery', async () => {
    const gh = fakeGithub();
    await tick(gh, { failing: [{ id: 'web-db-unreachable', detail: NEON_402(1) }], nowIso: T0 });

    const plan = await tick(gh, {
      probeOk: false,
      failing: [{ id: HARNESS_CHECK_ID, detail: 'probe produced no SMOKE_RESULT' }],
      nowIso: '2026-07-01T00:10:00.000Z',
    });

    expect(plan.closes).toEqual([]);
    expect(plan.creates.map((c: any) => c.checkId)).toEqual([HARNESS_CHECK_ID]);
    expect(plan.notes.join(' ')).toContain('not asserting recovery');
    // the real incident's issue is STILL OPEN — a monitor that cannot measure
    // must never be read as evidence of health
    expect(openIssues(gh).map((i) => alertKeyOf(i.body))).toContain(
      alertKey(ENV, 'web-db-unreachable'),
    );
  });

  it('the harness alert itself closes once the probe works again', async () => {
    const gh = fakeGithub();
    await tick(gh, {
      probeOk: false,
      failing: [{ id: HARNESS_CHECK_ID, detail: 'broken' }],
      nowIso: T0,
    });
    const plan = await tick(gh, { failing: [], nowIso: '2026-07-01T00:10:00.000Z' });
    expect(plan.closes.map((c: any) => c.checkId)).toEqual([HARNESS_CHECK_ID]);
  });
});

describe('safety — unknown check ids are left for a human, never auto-closed', () => {
  it('reports an orphan instead of closing a key it does not understand', async () => {
    const staleKey = alertKey(ENV, 'a-check-that-was-deleted');
    const gh = fakeGithub([{ number: 42, title: 'stale', body: markerFor(staleKey) }]);
    const plan = await tick(gh, { failing: [], nowIso: T0 });
    expect(plan.closes).toEqual([]);
    expect(plan.orphans.map((o: any) => o.number)).toEqual([42]);
    expect(gh.issues[0].state).toBe('open');
  });
});

describe('self-healing — a raced double-open collapses to the OLDEST', () => {
  it('closes the newer same-key issue as a duplicate and keeps first-seen', async () => {
    const key = alertKey(ENV, 'web-db-unreachable');
    const mk = (n: number, first: string) => ({
      number: n,
      title: issueTitle(ENV, 'web-db-unreachable'),
      body: `${markerFor(key)}\n${renderStatsBlock({
        firstSeen: first,
        lastSeen: first,
        consecutive: 1,
        detail: 'x',
        runUrl: '',
      })}`,
    });
    const gh = fakeGithub([mk(101, T0), mk(102, '2026-07-02T00:00:00.000Z')]);

    const plan = await tick(gh, {
      failing: [{ id: 'web-db-unreachable', detail: NEON_402(3) }],
      nowIso: '2026-07-03T00:00:00.000Z',
    });

    expect(plan.creates).toHaveLength(0);
    expect(plan.updates.map((u: any) => u.number)).toEqual([101]);
    expect(plan.duplicates.map((d: any) => d.number)).toEqual([102]);
    expect(gh.issues.find((i) => i.number === 102)!.state).toBe('closed');
    expect(gh.issues.find((i) => i.number === 102)!.stateReason).toBe('not_planned');
    expect(parseStats(gh.issues.find((i) => i.number === 101)!.body).firstSeen).toBe(T0);
  });
});

// ---------------------------------------------------------------------------
// 6. Probe-log interpretation
// ---------------------------------------------------------------------------

describe('interpretSmokeLog', () => {
  const wrap = (json: unknown) =>
    `[1/3] curl ...\n<<SMOKE_RESULT>>\n${JSON.stringify(json, null, 2)}\n<<END_SMOKE_RESULT>>\n`;

  it('reads a healthy result', () => {
    const r = interpretSmokeLog(wrap({ healthy: true, reason: 'all probes healthy', checks: [] }));
    expect(r).toMatchObject({ probeOk: true, healthy: true, failing: [] });
  });

  it('reads an unhealthy result with per-check ids', () => {
    const r = interpretSmokeLog(
      wrap({
        healthy: false,
        reason: 'x',
        checks: [{ id: 'web-db-unreachable', detail: NEON_402(1) }],
      }),
    );
    expect(r.probeOk).toBe(true);
    expect(r.healthy).toBe(false);
    expect(r.failing).toEqual([{ id: 'web-db-unreachable', detail: NEON_402(1) }]);
  });

  it('treats a missing / unparseable result as a LOUD harness failure', () => {
    for (const log of ['', 'curl: (28) Operation timed out', '<<SMOKE_RESULT>>\n{oops\n<<END_SMOKE_RESULT>>']) {
      const r = interpretSmokeLog(log);
      expect(r.probeOk).toBe(false);
      expect(r.healthy).toBe(false);
      expect(r.failing.map((f: any) => f.id)).toEqual([HARNESS_CHECK_ID]);
    }
  });

  it('never reads "unhealthy with no checks" as green', () => {
    const r = interpretSmokeLog(wrap({ healthy: false, reason: 'something', checks: [] }));
    expect(r.probeOk).toBe(false);
    expect(r.healthy).toBe(false);
    expect(r.failing.map((f: any) => f.id)).toEqual([HARNESS_CHECK_ID]);
  });

  it('the LAST marker pair wins, so echoed markers cannot shadow the result', () => {
    const log =
      '<<SMOKE_RESULT>>\n{"healthy": false, "checks": []}\n<<END_SMOKE_RESULT>>\n' +
      wrap({ healthy: true, checks: [] });
    expect(extractSmokeResult(log)).toMatchObject({ healthy: true });
  });

  it('deduplicates a check id the probe listed twice', () => {
    const plan = planAlertActions({
      env: ENV,
      probeOk: true,
      failing: [
        { id: 'relay-mem-crit', detail: 'a' },
        { id: 'relay-mem-crit', detail: 'b' },
      ],
      openIssues: [],
      nowIso: T0,
    });
    expect(plan.creates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Workflow wiring
// ---------------------------------------------------------------------------

describe('live-smoke-alert.yml wiring', () => {
  /**
   * The workflow with `#` comment lines removed.
   *
   * Assertions about what the workflow DOES must read only executable YAML —
   * otherwise the header comment explaining the old `issues.create()` flood
   * fails the very test that forbids it, and the fix would be to delete the
   * explanation. Keep the instrument pointed at the code.
   */
  const CODE = WORKFLOW.split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  it('the comment stripper leaves the executable body intact (instrument check)', () => {
    expect(CODE).toContain('runs-on: ubuntu-latest');
    expect(CODE).not.toContain('# Every 10 minutes');
  });

  it('no longer creates issues inline — it goes through the tested reconciler', () => {
    expect(CODE).not.toContain('issues.create');
    expect(CODE).not.toContain('actions/github-script');
    expect(CODE).toContain('node scripts/alert-issues.mjs reconcile');
  });

  it('grants issues:write and passes the probe log to the reconciler', () => {
    expect(CODE).toMatch(/issues:\s*write/);
    expect(CODE).toMatch(/SMOKE_LOG:\s*\/tmp\/smoke\.out/);
    expect(CODE).toMatch(/GITHUB_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
  });

  it('runs the probe exactly once per tick', () => {
    const calls = CODE.match(/bash scripts\/live-smoke-alert\.sh/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it('implements NO time-based suppression (dedup is not a cooldown)', () => {
    // A rate limit / backoff would reintroduce the "a real new outage goes
    // unreported for hours" failure that dedup is specifically not allowed to
    // trade into. The old state machine's 1800 s sustained-unhealth threshold
    // and its force_fire escape hatch are both gone.
    expect(CODE).not.toMatch(/1800|cooldown|backoff|sustained/i);
    expect(CODE).not.toMatch(/force_fire/);
    // and the alert state no longer lives in an expiring artifact
    expect(CODE).not.toMatch(/live-smoke-state|download-artifact/);
  });

  it('still fails the job when unhealthy, so the run itself is a signal', () => {
    expect(CODE).toMatch(/steps\.alerts\.outputs\.healthy != 'true'/);
  });

  it('still probes on the 10-minute cron', () => {
    expect(CODE).toMatch(/cron:\s*'\*\/10 \* \* \* \*'/);
  });
});

// ---------------------------------------------------------------------------
// 8. The REST client — the only part that would otherwise fail first in prod
// ---------------------------------------------------------------------------

describe('githubClient request construction', () => {
  function recordingFetch(pages: any[][] = [[]]) {
    const calls: { url: string; method: string; body: any }[] = [];
    let page = 0;
    const impl = async (url: string, init: any) => {
      calls.push({
        url,
        method: init.method,
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      const payload = init.method === 'GET' ? (pages[page++] ?? []) : { number: 7 };
      return { ok: true, status: 200, json: async () => payload, text: async () => '' };
    };
    return { calls, impl };
  }

  const client = (impl: any) =>
    (alerts as any).githubClient({ token: 't', repo: 'o/r', fetchImpl: impl });

  it('lists ALL open issues (never label-filtered) and drops pull requests', async () => {
    const { calls, impl } = recordingFetch([
      [
        { number: 1, title: 'a', body: 'x' },
        { number: 2, title: 'pr', body: 'y', pull_request: { url: 'u' } },
      ],
    ]);
    const issues = await client(impl).listOpenAlertIssues();
    expect(issues).toEqual([{ number: 1, title: 'a', body: 'x' }]);
    expect(calls[0].url).toContain('/repos/o/r/issues?state=open');
    // A server-side `labels=` filter is AND-semantics: a triager removing the
    // `alert` label would hide an open incident from the scan, and a hidden
    // issue is a duplicate on the next tick. Identity is the body marker.
    expect(calls[0].url).not.toContain('labels=');
  });

  it('paginates until a short page', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: 't', body: '' }));
    const { calls, impl } = recordingFetch([full, [{ number: 101, title: 't', body: '' }]]);
    const issues = await client(impl).listOpenAlertIssues();
    expect(issues).toHaveLength(101);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain('page=2');
  });

  it('creates, patches, comments and closes on the right endpoints', async () => {
    const { calls, impl } = recordingFetch();
    const c = client(impl);
    await c.createIssue({ title: 'T', body: 'B', labels: ALERT_LABELS });
    await c.updateIssue(9, { body: 'B2' });
    await c.createComment(9, 'hi');
    await c.closeIssue(9, 'completed');
    expect(calls.map((x) => `${x.method} ${x.url.replace('https://api.github.com', '')}`)).toEqual([
      'POST /repos/o/r/issues',
      'PATCH /repos/o/r/issues/9',
      'POST /repos/o/r/issues/9/comments',
      'PATCH /repos/o/r/issues/9',
    ]);
    expect(calls[3].body).toEqual({ state: 'closed', state_reason: 'completed' });
  });

  it('throws (rather than silently no-oping) on an API error', async () => {
    const impl = async () => ({
      ok: false,
      status: 403,
      text: async () => 'Resource not accessible by integration',
      json: async () => ({}),
    });
    await expect(client(impl).createIssue({ title: 'T', body: 'B', labels: [] })).rejects.toThrow(
      /403/,
    );
  });
});

describe('inputFromEnv', () => {
  it('builds the run URL and honours ALERT_DRY_RUN', () => {
    const cfg = inputFromEnv({
      SMOKE_LOG: '/tmp/smoke.out',
      WEB_URL: 'https://dev.patchtogether.live',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_RUN_ID: '77',
      ALERT_DRY_RUN: '1',
    });
    expect(cfg.runUrl).toBe('https://github.com/o/r/actions/runs/77');
    expect(cfg.dryRun).toBe(true);
    expect(inputFromEnv({}).dryRun).toBe(false);
    expect(inputFromEnv({}).runUrl).toBe('');
  });
});
