// packages/server/src/logger.ts
//
// Structured JSON logger for the Hocuspocus server. One line per event so
// log shippers (Axiom HTTP ingest, Fly logs forwarder) can parse without
// multi-line buffer handling. Field names match the web hooks.server.ts log
// format so cross-tier searches work uniformly:
//
//   { ts, level, msg, component, ... event-specific keys }
//
// The component is always 'hocuspocus' here so a single Axiom search like
// `component=="hocuspocus" and level=="error"` finds every server error
// across all tiers.
//
// Boot ID is regenerated each time the process starts. The crash-loop
// detector counts `msg=="startup"` events with distinct `boot_id`s in a
// time window.

const COMPONENT = 'hocuspocus';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  msg: string;
  level?: LogLevel;
  // Common event-specific keys the rest of the server emits. Open-ended
  // because new event shapes get added over time; structured-log shippers
  // happily ingest unknown keys.
  doc?: string;
  user?: string | null;
  sock?: string;
  size?: number;
  reason?: string;
  ms?: number;
  count?: number;
  [k: string]: unknown;
}

let bootId: string = '';

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Node 18 fallback (Node 22+ has crypto.randomUUID natively)
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function initBootId(): string {
  bootId = makeId();
  return bootId;
}

export function getBootId(): string {
  if (!bootId) bootId = makeId();
  return bootId;
}

export function log(fields: LogFields): void {
  const line = {
    ts: new Date().toISOString(),
    level: fields.level ?? 'info',
    component: COMPONENT,
    boot_id: getBootId(),
    ...fields,
  };
  // Always console.log: Fly captures stdout into its logs stream which is
  // queryable via `flyctl logs` AND can be shipped to Axiom via Fly's
  // log-shipper add-on. console.error reserved for errors so a tail can
  // grep level visibility without parsing JSON.
  if (line.level === 'error') {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(line));
  } else {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(line));
  }
}
