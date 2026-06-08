// packages/server/src/relay-error-handlers.ts
//
// Process-level last-resort error handlers for the relay, made ALERTABLE.
//
// The relay serves EVERY rack from one long-lived process, so crashing on an
// uncaught exception / unhandled rejection (node's default since v15) would nuke
// every connected rack at once and trigger a reconnect storm. We deliberately
// KEEP "log loudly + stay up" — the specific async paths that leaked are fixed at
// the source (db.ts swallows transient persist errors + a pool 'error' listener),
// and Fly health checks + the reaper keep the process honest.
//
// The gap this module closes: the previous handlers logged a free-form
// `console.error('… (relay stays up):', err)` line that log-based alerting (PR #74
// observability) can't reliably page on. Each handler now also emits ONE
// single-line, machine-parseable, tagged log line — `event=relay_uncaught_exception`
// / `event=relay_unhandled_rejection` with the error message, stack, and the relay
// boot_id (reused from boot-id.ts so it correlates with /health + /metrics) — so a
// log query can alert on any occurrence. We also keep a per-process counter for each
// so the count is surfaced on /metrics alongside the memory/persist signals.
//
// The handler bodies are extracted into small exported functions (logUncaught /
// logUnhandled) so they're unit-testable without actually triggering a process
// event (which would, by design, NOT crash and would be hard to assert on).

import { RELAY_BOOT_ID } from './boot-id.js';

/** Minimal logger surface so tests can spy without touching the real console. */
export type ErrorLogger = (msg: string) => void;

// eslint-disable-next-line no-console
const realLog: ErrorLogger = (msg) => console.error(msg);

// Per-process counters. Surfaced on /metrics via getters (see index.ts wiring).
let uncaughtExceptions = 0;
let unhandledRejections = 0;

export function getUncaughtExceptionCount(): number {
  return uncaughtExceptions;
}
export function getUnhandledRejectionCount(): number {
  return unhandledRejections;
}

/** Test-only: reset the counters between cases. */
export function _resetRelayErrorCounters(): void {
  uncaughtExceptions = 0;
  unhandledRejections = 0;
}

/** Coerce an arbitrary thrown value / rejection reason into a (message, stack)
 *  pair. Rejections in particular are often non-Error (a string, an object), so
 *  we can't assume `.message`/`.stack` exist. */
function describe(value: unknown): { message: string; stack: string } {
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack ?? '' };
  }
  // Non-Error: best-effort stringify. Keep it single-line-safe — the caller
  // collapses newlines for the tagged field.
  let message: string;
  try {
    message = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    message = String(value);
  }
  return { message: message ?? String(value), stack: '' };
}

/** Quote a value for a `key="…"` tagged-log field: collapse newlines (so the
 *  whole record stays on ONE greppable line) and escape embedded quotes. */
function field(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')}"`;
}

/** Build the structured tagged line for a given event. Pure → easy to assert. */
export function formatRelayErrorLine(
  event: 'relay_uncaught_exception' | 'relay_unhandled_rejection',
  value: unknown,
): string {
  const { message, stack } = describe(value);
  return (
    `event=${event} level=error stays_up=true ` +
    `boot_id=${RELAY_BOOT_ID} ` +
    `msg=${field(message)} stack=${field(stack)}`
  );
}

/** Handle an uncaught exception: bump the counter, emit the tagged alertable
 *  line (plus the existing human-readable line), and STAY UP. */
export function logUncaught(err: unknown, log: ErrorLogger = realLog): void {
  uncaughtExceptions += 1;
  log(formatRelayErrorLine('relay_uncaught_exception', err));
  // Keep the original human-readable line too — the structured line is for
  // machine alerting; this one carries the full object for a human reading logs.
  log(`[hocuspocus] uncaughtException (relay stays up): ${stringifyForHuman(err)}`);
}

/** Handle an unhandled promise rejection: same contract as logUncaught. */
export function logUnhandled(reason: unknown, log: ErrorLogger = realLog): void {
  unhandledRejections += 1;
  log(formatRelayErrorLine('relay_unhandled_rejection', reason));
  log(`[hocuspocus] unhandledRejection (relay stays up): ${stringifyForHuman(reason)}`);
}

/** Best-effort human-readable rendering for the companion console line. */
function stringifyForHuman(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Register the process-level guards. Called once at relay boot from index.ts.
 * Split out (a) so the wiring is testable and (b) to keep index.ts declarative.
 */
export function installRelayProcessGuards(
  proc: NodeJS.Process = process,
  log: ErrorLogger = realLog,
): void {
  proc.on('unhandledRejection', (reason) => logUnhandled(reason, log));
  proc.on('uncaughtException', (err) => logUncaught(err, log));
}
