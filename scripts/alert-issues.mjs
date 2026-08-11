// scripts/alert-issues.mjs
//
// The issue-reconciler behind `.github/workflows/live-smoke-alert.yml`.
//
// ── The flood this exists to stop ──────────────────────────────────────────
//
// The old workflow called `issues.create()` unconditionally every time it
// decided to fire, and its firing rule was "on transition, OR every run once
// unhealthy for 30+ min". A single ongoing incident therefore opened a BRAND
// NEW issue on every cron tick for as long as it lasted. On 2026-07-29 that was
// 45 of the 47 open issues — all the same Neon HTTP 402 (compute quota) — so
// the tracker was 96% noise and a real human-filed issue was invisible. Nothing
// ever auto-closed either, so the pile survived the incident.
//
// ── The fix: RECONCILE, don't append ───────────────────────────────────────
//
// Every run computes the CURRENT set of failing checks and reconciles the open
// alert issues against it, one issue PER CHECK:
//
//     failing & no open issue   → CREATE  (a genuinely new alert — notifies)
//     failing & open issue      → UPDATE the body's stats block (no notify)
//     open issue & NOT failing  → COMMENT "recovered" + CLOSE
//
// This is dedup, NOT suppression, and the distinction is load-bearing:
//
//   · Dedup is keyed on the CHECK, not on the incident. A new, distinct failure
//     (relay OOM appearing alongside the existing DB outage) has a different
//     key, finds no open issue, and opens its own — with a fresh notification —
//     even though another alert is already firing. There is no code path where
//     a new failure mode is folded into an existing issue.
//   · There is deliberately NO rate limit / backoff / cooldown. Suppressing by
//     TIME would mean a real new outage could go unreported for hours; that is
//     the failure mode we are trying not to trade into. Repeat failures are
//     cheap because a body PATCH sends no notification, so we can afford to
//     reconcile on every single tick — which also means recovery is detected
//     within one cron interval instead of never.
//
// ── Why the key is (env, checkId) and why that is STABLE ───────────────────
//
// The old title embedded the raw probe reason:
//
//     [CRIT] dev.patchtogether.live alert: web /api/health database UNREACHABLE:
//     Server error (HTTP status 402): {"message":"...
//
// That string carries an upstream HTTP body — it varies run to run, so ANY
// title/text-similarity dedup over it would have failed open (which is exactly
// what "45 duplicates" looks like). The key here is built only from:
//
//     live-smoke/<env-host>/<check-id>
//
//   · env-host  — the hostname of the probed web URL (`dev.patchtogether.live`),
//                 so a dev alert and a prod alert never collide, and a dev run
//                 can never close a prod issue.
//   · check-id  — the probe's own stable branch identifier (`web-db-unreachable`,
//                 `relay-mem-crit`, …). These are literals in
//                 scripts/live-smoke-alert.sh, not derived from any response
//                 body, so they are byte-stable across runs by construction.
//                 KNOWN_CHECK_IDS below is pinned against that shell script by
//                 scripts/alert-issues.test.ts, so the two cannot drift.
//
// Neither component contains anything the monitored system can influence.
//
// The key is carried in an HTML COMMENT MARKER in the issue body, not in the
// title, so a human may retitle/edit an alert issue without breaking dedup —
// and, critically, an issue WITHOUT a marker is invisible to this reconciler.
// That is the guard that stops it from ever commenting on, editing or closing a
// human-filed issue (or the 45 pre-existing markerless duplicates).

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Labels applied to every alert issue we open. */
export const ALERT_LABELS = ['observability', 'alert'];

/** Namespace prefix for every key this reconciler owns. */
export const KEY_PREFIX = 'live-smoke';

/** HTML-comment marker name that carries the alert key inside an issue body. */
export const MARKER_NAME = 'patchtogether-alert-key';

/** Fenced region of the body this reconciler rewrites; everything else is preserved. */
export const STATS_START = '<!-- alert-stats:start -->';
export const STATS_END = '<!-- alert-stats:end -->';

/**
 * Every check id `scripts/live-smoke-alert.sh` can push onto `failures`.
 *
 * PINNED to that shell script by alert-issues.test.ts (same cross-file identity
 * discipline as docs-only-gate.test.ts pinning DOCS_PATTERNS to ci.yml). Adding
 * a probe branch without adding it here fails the `unit` lane — which matters
 * because an id missing from this list is one we would open an issue for but
 * never auto-close (see `orphans` in planAlertActions).
 */
export const KNOWN_CHECK_IDS = [
  'web-health-status',
  'web-health-body',
  // The gate that watches the gate: the DB read is opt-in (`?deep=1`) since it
  // wakes Neon, and this fires if the probe did NOT run — because a response
  // that was never probed would otherwise sail through every DB check below it.
  'web-db-not-probed',
  'web-db-unreachable',
  'web-db-schema-drift',
  'relay-health-status',
  'relay-health-body',
  'relay-metrics-status',
  'relay-metrics-body',
  'relay-mem-crit',
];

/**
 * Synthetic check for "the probe harness itself did not produce a usable
 * result" (script crashed, markers missing, JSON unparseable). It gets its own
 * key so a broken probe is LOUD rather than silently reading as healthy — and
 * when it fires we refuse to close anything, because an unusable probe is not
 * evidence of recovery.
 */
export const HARNESS_CHECK_ID = 'probe-harness';

/** Stable human-readable phrase per check id — used in the issue TITLE. */
export const CHECK_TITLES = {
  'web-health-status': 'web /api/health returned a non-200',
  'web-health-body': 'web /api/health body missing ok:true',
  'web-db-not-probed': 'web /api/health did not RUN the DB probe (the DB checks are testing nothing)',
  'web-db-unreachable': 'web /api/health reports the database UNREACHABLE',
  'web-db-schema-drift': 'web /api/health reports schema drift (racks-missing)',
  'relay-health-status': 'relay /health returned a non-200',
  'relay-health-body': 'relay /health body missing ok:true',
  'relay-metrics-status': 'relay /metrics returned a non-200',
  'relay-metrics-body': 'relay /metrics body missing numeric rss_mb',
  'relay-mem-crit': 'relay RSS is over the crit threshold',
  [HARNESS_CHECK_ID]: 'live-smoke probe produced no usable result',
};

/** Check ids this reconciler is allowed to auto-close on recovery. */
export function closableCheckIds() {
  return new Set([...KNOWN_CHECK_IDS, HARNESS_CHECK_ID]);
}

// ---------------------------------------------------------------------------
// Keys + markers (pure)
// ---------------------------------------------------------------------------

/**
 * Environment label for a probed URL — the bare hostname, lowercased.
 * Falls back to a sanitised form of the input so a malformed URL still yields a
 * deterministic (if ugly) key rather than colliding everything into one bucket.
 */
export function envLabelFromUrl(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return 'unknown-env';
  try {
    const host = new URL(raw).hostname.toLowerCase();
    if (host) return host;
  } catch {
    /* fall through to the sanitised form */
  }
  const cleaned = raw
    .replace(/^[a-z]+:\/\//i, '')
    .split('/')[0]
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'unknown-env';
}

/** The stable dedup key: `live-smoke/<env>/<check-id>`. */
export function alertKey(env, checkId) {
  return `${KEY_PREFIX}/${env}/${checkId}`;
}

/** The HTML comment that carries a key inside an issue body. */
export function markerFor(key) {
  return `<!-- ${MARKER_NAME}: ${key} -->`;
}

/**
 * The alert key an issue body declares, or null.
 *
 * A null return is what makes this reconciler INERT on issues it did not
 * create: human-filed issues and the pre-existing markerless duplicates are
 * never updated, commented on, or closed.
 */
export function alertKeyOf(body) {
  const m = String(body ?? '').match(
    new RegExp(`<!--\\s*${MARKER_NAME}\\s*:\\s*([^\\s>][^>]*?)\\s*-->`),
  );
  return m ? m[1].trim() : null;
}

/** Split a key back into its parts, or null if it is not one of ours. */
export function parseAlertKey(key) {
  const m = String(key ?? '').match(/^([^/]+)\/([^/]+)\/(.+)$/);
  if (!m || m[1] !== KEY_PREFIX) return null;
  return { prefix: m[1], env: m[2], checkId: m[3] };
}

// ---------------------------------------------------------------------------
// Issue body rendering (pure)
// ---------------------------------------------------------------------------

/** Collapse a probe detail to one safe, bounded line for embedding in Markdown. */
export function sanitizeDetail(detail, max = 500) {
  const one = String(detail ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/`/g, "'")
    .trim();
  if (!one) return '(no detail)';
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The rewritable stats region. Everything outside it survives an update. */
export function renderStatsBlock({ firstSeen, lastSeen, consecutive, detail, runUrl }) {
  return [
    STATS_START,
    `- **Status:** 🔴 FAILING`,
    `- **First seen:** ${firstSeen}`,
    `- **Last seen:** ${lastSeen}`,
    `- **Consecutive failing probes:** ${consecutive}`,
    `- **Latest detail:** \`${sanitizeDetail(detail)}\``,
    runUrl ? `- **Latest run:** ${runUrl}` : `- **Latest run:** (unknown)`,
    STATS_END,
  ].join('\n');
}

/** Read the stats a previous run wrote back out of a body. */
export function parseStats(body) {
  const src = String(body ?? '');
  const first = src.match(/\*\*First seen:\*\*\s*(\S+)/);
  const last = src.match(/\*\*Last seen:\*\*\s*(\S+)/);
  const n = src.match(/\*\*Consecutive failing probes:\*\*\s*(\d+)/);
  return {
    firstSeen: first ? first[1] : null,
    lastSeen: last ? last[1] : null,
    consecutive: n ? Number(n[1]) : 0,
  };
}

/**
 * Replace the stats region in an existing body, preserving every other byte
 * (so a human's triage notes on the issue are never clobbered). If the region
 * is missing — hand-mangled body — the fresh block is appended rather than
 * silently dropped.
 */
export function upsertStatsBlock(body, block) {
  const src = String(body ?? '');
  const s = src.indexOf(STATS_START);
  const e = src.indexOf(STATS_END);
  if (s === -1 || e === -1 || e < s) {
    return `${src.trimEnd()}\n\n${block}\n`;
  }
  return src.slice(0, s) + block + src.slice(e + STATS_END.length);
}

/** Title for an alert issue. Contains NO run-varying text — see the header. */
export function issueTitle(env, checkId) {
  const phrase = CHECK_TITLES[checkId] ?? checkId;
  return `[CRIT] ${env} — ${phrase} (${checkId})`;
}

/** The full body for a NEWLY opened alert issue. */
export function renderNewIssueBody({
  key,
  env,
  checkId,
  detail,
  nowIso,
  runUrl,
  webUrl,
  relayUrl,
  critMb,
}) {
  return [
    markerFor(key),
    `> Automated alert from \`.github/workflows/live-smoke-alert.yml\`.`,
    `> **This issue is REUSED for as long as \`${checkId}\` keeps failing** — the`,
    `> stats block below is rewritten in place instead of opening a new issue,`,
    `> and the workflow CLOSES this issue automatically when the check recovers.`,
    '',
    `**Check:** \`${checkId}\` — ${CHECK_TITLES[checkId] ?? 'no description'}`,
    `**Environment:** \`${env}\``,
    `**Alert key:** \`${key}\``,
    '',
    renderStatsBlock({
      firstSeen: nowIso,
      lastSeen: nowIso,
      consecutive: 1,
      detail,
      runUrl,
    }),
    '',
    '### Probe configuration',
    '',
    `- **Web URL:** ${webUrl ?? '(unset)'}`,
    `- **Relay URL:** ${relayUrl ?? '(unset)'}`,
    `- **Crit RSS threshold:** ${critMb ?? '(unset)'} MB`,
    '',
    '### What to do',
    '',
    `1. Reproduce locally: \`flox activate -- bash scripts/live-smoke-alert.sh --dry-run\``,
    `2. Runbook: \`runbooks/observability.md\` → "Live-smoke-alert workflow".`,
    `3. Do **not** close this by hand while the check is still failing — the next`,
    `   probe would find no open issue for \`${key}\` and open a fresh one. It`,
    `   closes itself on recovery.`,
    '',
    `Notification path: opening this issue emails repo watchers (tmayshark@gmail.com`,
    `per the observability slice-1 plan). Subsequent failures only EDIT the body,`,
    `which sends no notification — that is the whole point of the dedup.`,
  ].join('\n');
}

/** The comment left when a check recovers, just before the issue is closed. */
export function renderRecoveryComment({ checkId, env, nowIso, runUrl, consecutive }) {
  return [
    `✅ **RECOVERED** — \`${checkId}\` on \`${env}\` passed at ${nowIso}.`,
    '',
    consecutive
      ? `It had failed ${consecutive} consecutive probe(s).`
      : `It is no longer in the failing set.`,
    '',
    `Closing automatically. If it fails again, the workflow opens a NEW issue`,
    `(and emails watchers) rather than resurrecting this one, so a recurrence is`,
    `never silent.`,
    '',
    runUrl ? `Recovery run: ${runUrl}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The comment left on an issue closed as a same-key duplicate of another. */
export function renderDuplicateComment({ key, canonical, runUrl }) {
  return [
    `Closing as a duplicate of #${canonical} — both carry the alert key \`${key}\`,`,
    `and this reconciler keeps exactly one open issue per key. This can only`,
    `happen if two workflow runs raced; the OLDEST issue is kept as canonical so`,
    `the incident's first-seen timestamp survives.`,
    runUrl ? `\nRun: ${runUrl}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// The plan (pure) — the whole decision, testable without a network
// ---------------------------------------------------------------------------

/**
 * Reconcile the open alert issues against the CURRENT failing set.
 *
 * Pure: no I/O, no clock, no randomness. Everything it needs is an argument, so
 * every branch below — including the negative controls (markerless issues are
 * untouched; a broken probe closes nothing) — is a unit test rather than a
 * production experiment.
 *
 * @param {object}   input
 * @param {string}   input.env         env label, e.g. `dev.patchtogether.live`
 * @param {boolean}  input.probeOk     did the probe produce a usable result?
 * @param {{id:string,detail:string}[]} input.failing  currently failing checks
 * @param {{number:number,body:string,title?:string}[]} input.openIssues
 * @param {string}   input.nowIso      ISO timestamp for this run
 * @param {string}   [input.runUrl]    workflow run URL
 * @param {object}   [input.probeConfig] `{ webUrl, relayUrl, critMb }`
 * @returns {{creates:object[],updates:object[],closes:object[],duplicates:object[],orphans:object[],notes:string[]}}
 */
export function planAlertActions({
  env,
  probeOk,
  failing,
  openIssues,
  nowIso,
  runUrl,
  probeConfig = {},
}) {
  const notes = [];
  const creates = [];
  const updates = [];
  const closes = [];
  const duplicates = [];
  const orphans = [];

  const failingList = Array.isArray(failing) ? failing : [];
  const issues = Array.isArray(openIssues) ? openIssues : [];

  // ── Ours, by MARKER, and only for THIS environment ──────────────────────
  //
  // Two independent narrowings, both required:
  //   · a marker must be present  → human-filed issues (and the 45 pre-existing
  //     markerless duplicates) can never be touched by any branch below;
  //   · the key's env must match  → a dev-environment run can never close, edit
  //     or claim a prod-environment issue.
  //
  // Oldest-first so the canonical issue for a key is the one that carries the
  // real first-seen timestamp.
  const mine = new Map();
  for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
    const key = alertKeyOf(issue.body);
    if (!key) continue;
    const parsed = parseAlertKey(key);
    if (!parsed || parsed.env !== env) continue;
    if (mine.has(key)) {
      duplicates.push({
        number: issue.number,
        key,
        canonical: mine.get(key).issue.number,
        comment: renderDuplicateComment({
          key,
          canonical: mine.get(key).issue.number,
          runUrl,
        }),
      });
      continue;
    }
    mine.set(key, { issue, checkId: parsed.checkId });
  }

  // ── Failing now → CREATE (new alert) or UPDATE (same alert, still firing) ─
  const failingKeys = new Set();
  const seenIds = new Set();
  for (const f of failingList) {
    const checkId = String(f?.id ?? '').trim();
    if (!checkId) {
      notes.push('skipped a failing entry with no check id');
      continue;
    }
    if (seenIds.has(checkId)) continue; // the probe listed it twice
    seenIds.add(checkId);

    const key = alertKey(env, checkId);
    failingKeys.add(key);
    const detail = f?.detail ?? '';
    const existing = mine.get(key);

    if (!existing) {
      creates.push({
        key,
        checkId,
        title: issueTitle(env, checkId),
        labels: ALERT_LABELS,
        body: renderNewIssueBody({
          key,
          env,
          checkId,
          detail,
          nowIso,
          runUrl,
          webUrl: probeConfig.webUrl,
          relayUrl: probeConfig.relayUrl,
          critMb: probeConfig.critMb,
        }),
      });
      continue;
    }

    const prior = parseStats(existing.issue.body);
    const consecutive = (Number.isFinite(prior.consecutive) ? prior.consecutive : 0) + 1;
    const block = renderStatsBlock({
      firstSeen: prior.firstSeen ?? nowIso,
      lastSeen: nowIso,
      consecutive,
      detail,
      runUrl,
    });
    // Body ONLY — never the title. Identity lives in the marker, so a triager
    // who retitles an incident ("[CRIT] … — Neon quota, owner notified") keeps
    // their edit instead of having it overwritten every 10 minutes.
    updates.push({
      number: existing.issue.number,
      key,
      checkId,
      consecutive,
      body: upsertStatsBlock(existing.issue.body, block),
    });
  }

  // ── Not failing now → RECOVERED → comment + close ────────────────────────
  //
  // Gated on probeOk. A probe that produced no usable result is NOT evidence of
  // health, and closing on it would be the "alert silently disappears" bug —
  // strictly worse than the flood we are fixing.
  const closable = closableCheckIds();
  for (const [key, { issue, checkId }] of mine) {
    if (failingKeys.has(key)) continue;
    if (!probeOk) {
      notes.push(`probe unusable — leaving ${key} (#${issue.number}) open, not asserting recovery`);
      continue;
    }
    if (!closable.has(checkId)) {
      // A key we no longer understand (a probe branch was deleted). Leaving it
      // open is the conservative read; the KNOWN_CHECK_IDS pin makes this
      // essentially unreachable without a deliberate, unit-test-visible change.
      orphans.push({ number: issue.number, key, checkId });
      notes.push(`unknown check id '${checkId}' on #${issue.number} — left open for a human`);
      continue;
    }
    const prior = parseStats(issue.body);
    closes.push({
      number: issue.number,
      key,
      checkId,
      comment: renderRecoveryComment({
        checkId,
        env,
        nowIso,
        runUrl,
        consecutive: prior.consecutive,
      }),
    });
  }

  return { creates, updates, closes, duplicates, orphans, notes };
}

// ---------------------------------------------------------------------------
// Probe-log interpretation (pure)
// ---------------------------------------------------------------------------

export const SMOKE_BEGIN = '<<SMOKE_RESULT>>';
export const SMOKE_END = '<<END_SMOKE_RESULT>>';

/**
 * Pull the machine-readable JSON out of the probe's stdout log.
 *
 * The LAST marker pair wins, so a `--help`/echo of the markers earlier in the
 * log cannot shadow the real result.
 */
export function extractSmokeResult(log) {
  const lines = String(log ?? '').split('\n');
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === SMOKE_BEGIN) {
      start = i;
      end = -1;
    } else if (lines[i].trim() === SMOKE_END && start !== -1 && end === -1) {
      end = i;
    }
  }
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(lines.slice(start + 1, end).join('\n'));
  } catch {
    return null;
  }
}

/**
 * Turn a raw probe log into `{ probeOk, healthy, failing }`.
 *
 * Every "I cannot tell" path lands on probeOk=false with a `probe-harness`
 * failure — LOUD (it opens its own issue) and inert for recovery (it closes
 * nothing). A monitor that cannot measure must never read as green.
 */
export function interpretSmokeLog(log) {
  const result = extractSmokeResult(log);
  if (!result || typeof result !== 'object') {
    return {
      probeOk: false,
      healthy: false,
      result: null,
      failing: [
        {
          id: HARNESS_CHECK_ID,
          detail:
            'could not extract a SMOKE_RESULT JSON block from the probe output — ' +
            'the probe script crashed, timed out, or changed its output contract',
        },
      ],
    };
  }

  if (result.healthy === true) {
    return { probeOk: true, healthy: true, result, failing: [] };
  }

  const checks = Array.isArray(result.checks) ? result.checks.filter((c) => c && c.id) : [];
  if (checks.length === 0) {
    return {
      probeOk: false,
      healthy: false,
      result,
      failing: [
        {
          id: HARNESS_CHECK_ID,
          detail: `probe reported unhealthy but listed no checks; reason: ${
            result.reason ?? '(none)'
          }`,
        },
      ],
    };
  }

  return {
    probeOk: true,
    healthy: false,
    result,
    failing: checks.map((c) => ({ id: String(c.id), detail: String(c.detail ?? '') })),
  };
}

// ---------------------------------------------------------------------------
// Applying the plan (the only impure part — the client is injected)
// ---------------------------------------------------------------------------

/**
 * Execute a plan against a GitHub client.
 *
 * `gh` is injected so the tests drive the whole create → update → recover loop
 * against an in-memory fake, i.e. the dedup property is proven end-to-end
 * without a network. Interface:
 *   createIssue({title, body, labels}) -> {number}
 *   updateIssue(number, {title, body})
 *   createComment(number, body)
 *   closeIssue(number, stateReason)
 */
export async function applyPlan(plan, gh, { log = () => {} } = {}) {
  const applied = { created: [], updated: [], closed: [], deduped: [] };

  for (const c of plan.creates) {
    const issue = await gh.createIssue({ title: c.title, body: c.body, labels: c.labels });
    applied.created.push({ number: issue?.number, key: c.key });
    log(`opened #${issue?.number} for ${c.key}`);
  }
  for (const u of plan.updates) {
    await gh.updateIssue(u.number, { body: u.body });
    applied.updated.push({ number: u.number, key: u.key, consecutive: u.consecutive });
    log(`updated #${u.number} for ${u.key} (consecutive=${u.consecutive}) — no notification sent`);
  }
  for (const d of plan.duplicates) {
    await gh.createComment(d.number, d.comment);
    await gh.closeIssue(d.number, 'not_planned');
    applied.deduped.push({ number: d.number, key: d.key, canonical: d.canonical });
    log(`closed #${d.number} as duplicate of #${d.canonical} (${d.key})`);
  }
  for (const c of plan.closes) {
    await gh.createComment(c.number, c.comment);
    await gh.closeIssue(c.number, 'completed');
    applied.closed.push({ number: c.number, key: c.key });
    log(`closed #${c.number} — ${c.key} RECOVERED`);
  }
  return applied;
}

// ---------------------------------------------------------------------------
// Real GitHub client (fetch-based; no extra dependency)
// ---------------------------------------------------------------------------

/** Build a REST client bound to a repo. Only used by the CLI below. */
export function githubClient({ token, repo, apiUrl = 'https://api.github.com', fetchImpl }) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const base = `${apiUrl}/repos/${repo}`;
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
  };

  async function call(method, path, body) {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub ${method} ${path} → ${res.status} ${text.slice(0, 400)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  return {
    /**
     * ALL open issues, paginated; pull requests dropped.
     *
     * Deliberately NOT filtered by `labels=` server-side. The label filter is
     * AND-semantics, so a triager who removes `alert` from an open incident
     * would make it invisible here — and an invisible issue is a MISSING issue,
     * which means the next tick opens a duplicate: the exact bug being fixed.
     * Identity lives in the body marker, so the scan must see every open issue.
     * (This repo has ~47 open issues = one request; the labels are still applied
     * on create, for humans filtering the tracker.)
     */
    async listOpenAlertIssues() {
      const out = [];
      const MAX_PAGES = 10;
      let page = 1;
      for (; page <= MAX_PAGES; page++) {
        const batch = await call('GET', `/issues?state=open&per_page=100&page=${page}`);
        if (!Array.isArray(batch) || batch.length === 0) break;
        for (const i of batch) {
          if (i.pull_request) continue;
          out.push({ number: i.number, title: i.title, body: i.body ?? '' });
        }
        if (batch.length < 100) break;
      }
      if (page > MAX_PAGES) {
        // Truncation means we may not have seen an existing alert issue, so the
        // reconcile could duplicate. Say so loudly rather than quietly drifting.
        console.log(
          `::warning::open-issue scan hit the ${MAX_PAGES}-page cap — dedup may be incomplete`,
        );
      }
      return out;
    },
    createIssue: (i) => call('POST', '/issues', i),
    updateIssue: (n, patch) => call('PATCH', `/issues/${n}`, patch),
    createComment: (n, body) => call('POST', `/issues/${n}/comments`, { body }),
    closeIssue: (n, state_reason) =>
      call('PATCH', `/issues/${n}`, { state: 'closed', state_reason }),
  };
}

/** A client that logs what it WOULD do — `ALERT_DRY_RUN=1`. */
export function dryRunClient(log = console.log) {
  let next = 900000;
  return {
    async listOpenAlertIssues() {
      return [];
    },
    async createIssue(i) {
      log(`[dry-run] CREATE issue: ${i.title}`);
      return { number: next++ };
    },
    async updateIssue(n, patch) {
      log(`[dry-run] UPDATE #${n}: ${patch.title}`);
    },
    async createComment(n) {
      log(`[dry-run] COMMENT on #${n}`);
    },
    async closeIssue(n, reason) {
      log(`[dry-run] CLOSE #${n} (${reason})`);
    },
  };
}

// ---------------------------------------------------------------------------
// CLI — `node scripts/alert-issues.mjs reconcile`
// ---------------------------------------------------------------------------

/** @internal exported for the test; assembles CLI inputs from the environment. */
export function inputFromEnv(env) {
  return {
    smokeLogFile: env.SMOKE_LOG ?? '',
    webUrl: env.WEB_URL ?? '',
    relayUrl: env.RELAY_URL ?? '',
    critMb: env.RELAY_MEM_CRIT_MB ?? '',
    repo: env.GITHUB_REPOSITORY ?? '',
    token: env.GITHUB_TOKEN ?? '',
    runUrl:
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : '',
    dryRun: env.ALERT_DRY_RUN === '1' || env.ALERT_DRY_RUN === 'true',
  };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].endsWith('alert-issues.mjs');

if (isMain && process.argv[2] === 'reconcile') {
  const { readFileSync } = await import('node:fs');
  const cfg = inputFromEnv(process.env);

  let log = '';
  try {
    log = readFileSync(cfg.smokeLogFile, 'utf8');
  } catch (err) {
    console.log(`could not read SMOKE_LOG='${cfg.smokeLogFile}': ${err.message}`);
  }

  const { probeOk, healthy, failing } = interpretSmokeLog(log);
  const envLabel = envLabelFromUrl(cfg.webUrl);
  const nowIso = new Date().toISOString();

  console.log(`env:      ${envLabel}`);
  console.log(`probeOk:  ${probeOk}`);
  console.log(`healthy:  ${healthy}`);
  console.log(`failing:  ${failing.map((f) => f.id).join(', ') || '(none)'}`);

  const gh = cfg.dryRun
    ? dryRunClient()
    : githubClient({ token: cfg.token, repo: cfg.repo });

  const openIssues = await gh.listOpenAlertIssues();
  console.log(`open alert-labelled issues: ${openIssues.length}`);

  const plan = planAlertActions({
    env: envLabel,
    probeOk,
    failing,
    openIssues,
    nowIso,
    runUrl: cfg.runUrl,
    probeConfig: { webUrl: cfg.webUrl, relayUrl: cfg.relayUrl, critMb: cfg.critMb },
  });

  console.log(
    `plan: ${plan.creates.length} create, ${plan.updates.length} update, ` +
      `${plan.closes.length} close, ${plan.duplicates.length} dedupe, ` +
      `${plan.orphans.length} orphan`,
  );
  for (const n of plan.notes) console.log(`note: ${n}`);
  for (const o of plan.orphans) {
    console.log(`::warning::alert issue #${o.number} carries unknown check id '${o.checkId}'`);
  }

  await applyPlan(plan, gh, { log: (m) => console.log(m) });

  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_OUTPUT, `healthy=${healthy}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `probe_ok=${probeOk}\n`);
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `failing=${failing.map((f) => f.id).join(',')}\n`,
    );
  }
}
