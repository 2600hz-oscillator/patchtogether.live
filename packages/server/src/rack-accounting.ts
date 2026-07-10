// packages/server/src/rack-accounting.ts
//
// PER-RACK memory accounting for the relay.
//
// The existing memory alarm (http-introspection.ts) watches PROCESS RSS —
// it tells you the relay is near the cliff, but not WHICH rack is pushing
// it there. One process serves every rack (see index.ts), so a single
// runaway doc (a bot loop writing garbage, a poisoned client, tombstone
// bloat) climbs quietly inside the aggregate until the OOM-killer takes
// every rack down at once — the exact "relay OOM went unalerted" incident
// in `project_observability_priority`. This module attributes memory to
// individual racks so the alarm names the offender while there's still
// headroom to act.
//
// Accounting model (approximation, deliberately cheap):
//   tracked(rack) = bytes of the last full snapshot encode (or the restore
//                   at load) + the sum of incremental update bytes applied
//                   since that snapshot ("churn").
// Snapshot encodes reset churn to zero because the encode captures the
// full current state. Churn intentionally OVER-counts live memory (an
// update that overwrites a value still adds its bytes until the next
// snapshot) — over-counting is the safe direction for a pre-OOM warning,
// and Hocuspocus snapshots every 2–5 s of activity (snapshot-config.ts) so
// the drift window is short. This is accounting for ALERTING, not an exact
// RSS attribution.
//
// Alert plumbing follows the two conventions the app's Better Stack
// monitors already rely on (see http-introspection.ts + memory
// `project_observability_live_2026-06-10`):
//   1. a single-line machine-parseable tagged log with `event=…` +
//      `alert_state=…` + `boot_id=…` fields, emitted ONCE per upward
//      threshold crossing (level-latched so a busy rack can't spam);
//   2. the /metrics `alert_state` rollup — index.ts feeds this module's
//      `summary().level` into `computeAlertState`, so the EXISTING
//      per-tier keyword monitor (matching `"alert_state":"ok"`) fires on a
//      rack-level breach with no monitor changes.

export interface RackMemThresholds {
  warnMb: number;
  critMb: number;
}

/** Read per-rack thresholds from env, with defaults sized against the
 *  design ceiling of ~25 MB per rack (stack study §8): warn at 16 MB —
 *  far above any legitimate patch today, low enough to page long before
 *  one rack threatens a 512–1024 MB machine — and crit at 24 MB. Same
 *  parse-with-fallback shape as readMemoryThresholds. */
export function readRackMemThresholds(
  env: Record<string, string | undefined> = process.env,
): RackMemThresholds {
  const parse = (raw: string | undefined, fallback: number): number => {
    if (raw == null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    warnMb: parse(env.RELAY_RACK_WARN_MB, 16),
    critMb: parse(env.RELAY_RACK_CRIT_MB, 24),
  };
}

export type RackAlertLevel = 'ok' | 'warn' | 'crit';

/** Map a per-rack tracked size to its alert level. Pure for testing. */
export function classifyRackMb(mb: number, thresholds: RackMemThresholds): RackAlertLevel {
  if (mb > thresholds.critMb) return 'crit';
  if (mb > thresholds.warnMb) return 'warn';
  return 'ok';
}

const SEVERITY: Record<RackAlertLevel, number> = { ok: 0, warn: 1, crit: 2 };

/** Roll-up over every tracked rack — the shape /metrics surfaces. */
export interface RackMemSummary {
  /** Number of racks currently tracked (≈ loaded docs). */
  rackCount: number;
  /** Largest single rack's tracked size in MB (0 when none). */
  largestRackMb: number;
  /** Racks currently over the warn threshold (includes crit ones). */
  racksOverWarn: number;
  /** Racks currently over the crit threshold. */
  racksOverCrit: number;
  /** Worst level across all racks — feeds the /metrics alert_state rollup. */
  level: RackAlertLevel;
}

export interface RackAccountant {
  /** An incremental Yjs update was applied to this rack's doc. */
  recordUpdate(rackId: string, updateBytes: number): void;
  /** A full snapshot encode happened (store OR restore-at-load): the rack's
   *  base size is now exactly `snapshotBytes`; churn resets. */
  recordSnapshot(rackId: string, snapshotBytes: number): void;
  /** The doc was unloaded from memory — stop tracking (its RAM is freed;
   *  the process-level RSS alarm still covers heap fragmentation). */
  evict(rackId: string): void;
  /** Tracked size of one rack in MB (0 if untracked). */
  sizeMb(rackId: string): number;
  summary(): RackMemSummary;
}

export interface RackAccountantOptions {
  thresholds: RackMemThresholds;
  /** Sink for the threshold-crossing tagged line. 'warn' ↔ alert_state=warn,
   *  'error' ↔ alert_state=crit — the same level↔state mapping
   *  classifyMemory/computeAlertState use for the process alarm. */
  log(level: 'warn' | 'error', msg: string): void;
  /** Relay boot id stamped on each line so it correlates with /health,
   *  /metrics, and the relay-error-handler lines. */
  bootId: string;
}

const BYTES_PER_MB = 1024 * 1024;

interface RackEntry {
  snapshotBytes: number;
  churnBytes: number;
  /** Last level we ALERTED at (latch). Emits only on upward crossings;
   *  falling back below a threshold silently re-arms the latch. */
  alertedLevel: RackAlertLevel;
}

/** Build the tagged, single-line, machine-parseable alert line. Exported
 *  pure so the format is pinned by a unit test (the Better Stack log-alert
 *  pattern greps these fields — see relay-error-handlers.ts for the
 *  convention this follows). */
export function formatRackMemLine(
  rackId: string,
  rackMb: number,
  level: Exclude<RackAlertLevel, 'ok'>,
  thresholds: RackMemThresholds,
  bootId: string,
): string {
  const logLevel = level === 'crit' ? 'error' : 'warn';
  return (
    `event=relay_rack_mem level=${logLevel} alert_state=${level} ` +
    `rack="${rackId.replace(/"/g, '\\"')}" rack_mb=${rackMb} ` +
    `warn_mb=${thresholds.warnMb} crit_mb=${thresholds.critMb} ` +
    `boot_id=${bootId}`
  );
}

export function createRackAccountant(options: RackAccountantOptions): RackAccountant {
  const { thresholds, log, bootId } = options;
  const racks = new Map<string, RackEntry>();

  function entry(rackId: string): RackEntry {
    let e = racks.get(rackId);
    if (!e) {
      e = { snapshotBytes: 0, churnBytes: 0, alertedLevel: 'ok' };
      racks.set(rackId, e);
    }
    return e;
  }

  function trackedMb(e: RackEntry): number {
    return round((e.snapshotBytes + e.churnBytes) / BYTES_PER_MB, 2);
  }

  /** Re-classify after a size change; emit ONE tagged line per upward
   *  crossing, re-arm silently on the way down. */
  function reclassify(rackId: string, e: RackEntry): void {
    const mb = trackedMb(e);
    const level = classifyRackMb(mb, thresholds);
    if (SEVERITY[level] > SEVERITY[e.alertedLevel]) {
      e.alertedLevel = level;
      // level is 'warn' | 'crit' here ('ok' can't be > anything).
      log(
        level === 'crit' ? 'error' : 'warn',
        formatRackMemLine(rackId, mb, level as Exclude<RackAlertLevel, 'ok'>, thresholds, bootId),
      );
    } else if (SEVERITY[level] < SEVERITY[e.alertedLevel]) {
      e.alertedLevel = level;
    }
  }

  return {
    recordUpdate(rackId, updateBytes) {
      if (!Number.isFinite(updateBytes) || updateBytes <= 0) return;
      const e = entry(rackId);
      e.churnBytes += updateBytes;
      reclassify(rackId, e);
    },

    recordSnapshot(rackId, snapshotBytes) {
      if (!Number.isFinite(snapshotBytes) || snapshotBytes < 0) return;
      const e = entry(rackId);
      e.snapshotBytes = snapshotBytes;
      e.churnBytes = 0;
      reclassify(rackId, e);
    },

    evict(rackId) {
      racks.delete(rackId);
    },

    sizeMb(rackId) {
      const e = racks.get(rackId);
      return e ? trackedMb(e) : 0;
    },

    summary() {
      let largestRackMb = 0;
      let racksOverWarn = 0;
      let racksOverCrit = 0;
      let level: RackAlertLevel = 'ok';
      for (const e of racks.values()) {
        const mb = trackedMb(e);
        if (mb > largestRackMb) largestRackMb = mb;
        const l = classifyRackMb(mb, thresholds);
        if (l !== 'ok') racksOverWarn += 1;
        if (l === 'crit') racksOverCrit += 1;
        if (SEVERITY[l] > SEVERITY[level]) level = l;
      }
      return { rackCount: racks.size, largestRackMb, racksOverWarn, racksOverCrit, level };
    },
  };
}

function round(n: number, digits: number): number {
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}
