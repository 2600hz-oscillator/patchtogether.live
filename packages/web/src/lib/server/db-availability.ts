// packages/web/src/lib/server/db-availability.ts
//
// Distinguishes "the database is UNAVAILABLE" (infrastructure) from "the query
// or schema is WRONG" (a bug in our code), and degrades the former to a 503.
//
// ── Why this exists ────────────────────────────────────────────────────────
// On 2026-07-28 the Neon account exceeded its compute-time quota. Every query
// on EVERY tier (autotest, dev AND prod) started returning HTTP 402. Nothing in
// `/r/[id]/+page.server.ts` handled that, so `getRackspace()` threw and
// SvelteKit emitted an opaque **HTTP 500** — meaning every rackspace URL in the
// product, including production, served an internal-error page for ~24h. The
// deploy-time live smoke caught it correctly (`/r/[id] must not 500`) and the
// 10-minute alert cron opened a CRIT issue every cycle.
//
// A database outage is a *service* problem, not a crash. The honest answer is
// 503 Service Unavailable: it tells the caller "retryable, come back", and it
// renders the friendly error page instead of an opaque "Internal Error".
//
// ── The rule: DID POSTGRES ANSWER? ─────────────────────────────────────────
// This is the whole classification, and it is deliberately narrow:
//
//   • Postgres replied with a real SQLSTATE  → the server ANSWERED us. Our
//     query or schema is at fault. **Rethrow → 500.**
//   • We never got a Postgres answer at all (HTTP gateway status, transport
//     failure, timeout)                      → the database is UNREACHABLE.
//     **503.**
//
// ⚠ The `rethrow → 500` half is NOT an oversight — it is the point. The
// `/r/[id]` live smoke is a CANARY that has already caught one real P0: the
// migration-005 `mode` column bug, where a qualified `r.mode` read raised
// SQLSTATE 42809 and 500'd every read path for a week (see the long comment in
// rackspaces.ts). If this helper swallowed *all* DB errors into a tidy 503,
// that canary would have gone green and the bug would have shipped silently.
// A schema/query error MUST stay loud. Only genuine unreachability degrades.
//
// See `db-availability.test.ts` — it negative-controls exactly that boundary.

import { error } from '@sveltejs/kit';

/** User-facing copy for a degraded (unreachable-database) response. */
export const DB_UNAVAILABLE_MESSAGE =
  'Rackspace storage is temporarily unavailable. This is a service issue on our ' +
  'side, not a problem with your link — please try again in a few minutes.';

/**
 * A real Postgres SQLSTATE: five chars, digits + uppercase letters (e.g.
 * `42809` undefined_function, `42703` undefined_column, `23505` unique
 * violation). Its PRESENCE proves the server processed the statement and
 * rejected it — i.e. the connection was fine and our SQL was not.
 */
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

/**
 * Neon's HTTP gateway statuses that mean "not available right now" as opposed
 * to "your credentials or query are wrong":
 *
 *   402 Payment Required   — compute-time / storage quota exhausted. THE
 *                            2026-07-28 incident, on all three tiers.
 *   408 Request Timeout
 *   429 Too Many Requests  — connection / rate limiting.
 *   5xx                    — gateway or compute-instance failure.
 *
 * Deliberately EXCLUDES 400/401/403/404: those mean a bad connection string or
 * revoked credentials — a MISCONFIGURATION, which must stay loud (500) rather
 * than masquerade as a transient blip. Same doctrine as MissingDatabaseUrlError
 * in db.ts, which we also leave un-degraded on purpose.
 */
const UNAVAILABLE_HTTP_STATUS_RE = /\(HTTP status (402|408|429|5\d\d)\)/i;

/**
 * Transport-level failures: we never reached the gateway at all. Covers the
 * undici/Workers `fetch failed` surface plus the usual socket errnos.
 */
const TRANSPORT_FAILURE_RE =
  /\b(fetch failed|network(?:\s+error)?|socket hang up|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR|AbortError|The operation was aborted|terminated)\b/i;

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return String(err ?? '');
}

function nameOf(err: unknown): string {
  if (err && typeof err === 'object') {
    const n = (err as { name?: unknown }).name;
    if (typeof n === 'string') return n;
  }
  return '';
}

/**
 * True when `err` means "the database could not be reached", false when it
 * means "the database answered and rejected our query".
 *
 * Returning FALSE is the safe default: an unrecognised error keeps its current
 * behaviour (bubbles to a 500), so this helper can only ever *downgrade*
 * failures it positively recognises as infrastructure.
 */
export function isDbUnavailableError(err: unknown): boolean {
  if (err === null || err === undefined) return false;

  // ── The load-bearing check ──
  // Postgres answered with a SQLSTATE → our SQL/schema is wrong, not the
  // connection. Never degrade these; the /r/[id] canary depends on them
  // staying 500s (see header).
  if (typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && SQLSTATE_RE.test(code)) return false;
  }

  const message = messageOf(err);

  // Neon itself tells us when a failure is worth retrying. The gateway embeds
  // the flag in the JSON error body, which the HTTP driver stringifies into
  // the message verbatim (confirmed against the live 402 payload).
  if (/"neon:retryable"\s*:\s*true/i.test(message)) return true;

  if (UNAVAILABLE_HTTP_STATUS_RE.test(message)) return true;
  if (TRANSPORT_FAILURE_RE.test(message)) return true;
  if (/^(AbortError|TimeoutError)$/.test(nameOf(err))) return true;

  return false;
}

/**
 * Run a database-backed read. An UNREACHABLE database becomes a 503; anything
 * else rethrows unchanged so it still surfaces as a 500.
 *
 * Wrap the individual DB call, NOT a whole `load` body — SvelteKit signals
 * `redirect()` / `error()` by throwing, and a broad try/catch around a loader
 * would swallow its own control flow.
 */
export async function dbRead<T>(op: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isDbUnavailableError(err)) throw err;

    // Single-line JSON so it greps cleanly out of `wrangler pages tail`
    // (matches the `invite-load` / `[dashboard]` log conventions).
    console.error(
      JSON.stringify({
        tag: 'db-unavailable',
        op,
        message: messageOf(err),
        timestamp: new Date().toISOString(),
      }),
    );

    throw error(503, DB_UNAVAILABLE_MESSAGE);
  }
}
