// scripts/attest-preflight.ts
//
// THE QUIET-MACHINE GUARD — ONE implementation, sampled over TIME (#1331).
//
// ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
// `preflightSolo()` existed TWICE (webgl-attest.ts + grand-attest.ts, identical
// but for env-var names) and each decided from a SINGLE `ps` invocation.
// (grand-attest was deleted 2026-08-17; webgl is the only caller now, but the
// shared module stays — the duplication, not the count, was the bug.)
// Browser CPU is not a steady signal — it oscillates with a period of a few
// seconds — so one instant samples a spiky distribution rather than measuring
// it. Measured on one contended machine (#1331): four single instants of the
// same process read 33.0 %, 27 %, 26 %, 4.6 %. The guard would have refused
// three times and PASSED once, on identical conditions.
//
// The dangerous direction is the PASS. ~44 % of instants sat below threshold on
// a machine whose true distribution was:
//
//   45 samples @2 s: over-threshold(25 %) = 25 of 45, max 87.1 %, period ≈ 4 s
//
// A pass there runs the attest for minutes under a co-tenant spiking to 87 %,
// and THAT path WRITES an attestation JSON that is thereafter indistinguishable
// from an honest one.
//
// ⚠ A REGULAR INTERVAL IS NOT A FIX — it is the same bug with more steps.
// Twelve samples at a regular 10 s against that same machine read 3.9–5.6 %
// EVERY TIME: a confident, plausible, completely false "quiet". An even lag
// aliases against the period and lands in the troughs. So the offsets below are
// deliberately IRREGULAR and mutually co-prime-ish; the schedule is exported so
// a test can assert that property rather than trusting the comment.
//
// ── WHAT THIS STILL CANNOT SEE (state the gate's scope inside the gate) ─────
//   · A co-tenant that starts AFTER the window closes — that is the MID-RUN
//     watchdog's job (webgl-cotenancy.ts), which this module deliberately does
//     not duplicate.
//   · GPU occupancy itself. Every reading here is CPU%, used as a proxy,
//     because macOS exposes no per-process GPU share without elevated tooling.
//   · A process whose renderer name is not in COTENANT_RE (that list is the
//     shared one — fix it there, once).
//   · Thermal / memory-bandwidth contention with no CPU signature.

import { execSync } from 'node:child_process';
import { cpus, loadavg } from 'node:os';
import { parsePs, foreignCoTenants, type PsRow } from './webgl-cotenancy';

/** Per-process aggregate across the whole sampling window. */
export interface CoTenantOffender {
  pid: number;
  name: string;
  /** How many samples of the window this process sat AT OR OVER the threshold. */
  samplesOver: number;
  /** The highest CPU% seen for it in any sample. */
  maxCpu: number;
}

/** What the window actually measured — recorded in the attestation so a past
 *  attestation says how quiet the machine was, instead of leaving it unknowable
 *  (the retroactive-trust problem in #1331). */
export interface CoTenantProfile {
  samples: number;
  windowMs: number;
  /** Highest foreign CPU% seen in ANY sample, threshold-independent. */
  maxForeignCpu: number;
  /** Offenders (over threshold at least once), worst first. */
  offenders: CoTenantOffender[];
  thresholdCpu: number;
  load1: number;
  cores: number;
}

/**
 * The sampling schedule, in ms from window start.
 *
 * Gaps are pairwise-irregular primes so the series cannot phase-lock to a
 * co-tenant's oscillation (the measured one was ≈4 s; a 10 s regular lag
 * aliased into its troughs and read 3.9–5.6 % against a true 56 %-over-
 * threshold signal). Exported so `attest-preflight.test.ts` can assert the
 * irregularity instead of taking this comment's word for it.
 */
export const SAMPLE_OFFSETS_MS: readonly number[] = [0, 1103, 2892, 4193, 6504, 8201, 10204];

/** Refuse when a process is over threshold in at least this FRACTION of the
 *  window's samples. A policy threshold on a derived measurement (not a
 *  population count): it is the line between "a transient blip on an idle
 *  machine" (the merely-annoying false refusal) and "a real contender". */
export const SUSTAINED_FRACTION = 0.25;

/** Refuse on a single reading this many times the threshold, however brief —
 *  the measured bad machine peaked at 87.1 % against a 25 % threshold, and one
 *  such spike mid-spec is enough to stall a timing-sensitive WebGL test. */
export const EGREGIOUS_MULTIPLE = 2;

/** Aggregate per-process across samples. PURE — the verdict logic is testable
 *  against a recorded real series with no `ps` and no clock. */
export function aggregateSamples(
  samples: ReadonlyArray<readonly PsRow[]>,
  thresholdCpu: number,
): { maxForeignCpu: number; offenders: CoTenantOffender[] } {
  const byKey = new Map<string, CoTenantOffender>();
  let maxForeignCpu = 0;
  for (const sample of samples) {
    for (const row of sample) {
      if (row.cpu > maxForeignCpu) maxForeignCpu = row.cpu;
      if (row.cpu < thresholdCpu) continue;
      const key = `${row.pid}:${row.name}`;
      const prev = byKey.get(key);
      if (prev) {
        prev.samplesOver += 1;
        if (row.cpu > prev.maxCpu) prev.maxCpu = row.cpu;
      } else {
        byKey.set(key, { pid: row.pid, name: row.name, samplesOver: 1, maxCpu: row.cpu });
      }
    }
  }
  const offenders = [...byKey.values()].sort(
    (a, b) => b.samplesOver - a.samplesOver || b.maxCpu - a.maxCpu,
  );
  return { maxForeignCpu, offenders };
}

/** The verdict over a completed profile. PURE. Returns the REASONS, so the
 *  refusal message can name which rule fired on which process rather than
 *  printing an instant that may not be representative. */
export function judgeProfile(profile: CoTenantProfile): {
  quiet: boolean;
  reasons: string[];
} {
  const sustainedMin = Math.max(2, Math.ceil(profile.samples * SUSTAINED_FRACTION));
  const reasons: string[] = [];
  for (const o of profile.offenders) {
    if (o.samplesOver >= sustainedMin) {
      reasons.push(
        `SUSTAINED: ${o.name} (pid ${o.pid}) at or over ${profile.thresholdCpu}% in ` +
          `${o.samplesOver}/${profile.samples} samples (peak ${o.maxCpu.toFixed(1)}%)`,
      );
    } else if (o.maxCpu >= profile.thresholdCpu * EGREGIOUS_MULTIPLE) {
      reasons.push(
        `SPIKE: ${o.name} (pid ${o.pid}) peaked at ${o.maxCpu.toFixed(1)}% ` +
          `(≥${EGREGIOUS_MULTIPLE}× the ${profile.thresholdCpu}% threshold) in ` +
          `${o.samplesOver}/${profile.samples} samples`,
      );
    }
  }
  if (profile.load1 > profile.cores * 0.5) {
    reasons.push(
      `LOAD: load(1m)=${profile.load1.toFixed(2)} on ${profile.cores} cores ` +
        `(over ${(profile.cores * 0.5).toFixed(1)})`,
    );
  }
  return { quiet: reasons.length === 0, reasons };
}

/** One `ps` sample, foreign rows only. Returns [] if `ps` is unavailable. */
export function sampleForeignCoTenants(minCpu: number): PsRow[] {
  let rows: PsRow[];
  try {
    rows = parsePs(execSync('ps -A -o %cpu=,pid=,ppid=,comm=', { encoding: 'utf8' }));
  } catch {
    return [];
  }
  return foreignCoTenants(rows, process.pid, minCpu);
}

function sleepSync(ms: number): void {
  // Synchronous by design: preflightSolo runs before any async work and its
  // callers are plain `if (!DRY) preflightSolo()` statements. Atomics.wait on a
  // throwaway buffer blocks without burning CPU (a spin loop would pollute the
  // very measurement this module exists to take).
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

/**
 * Sample the machine across the window and return the profile.
 *
 * `minCpu` is deliberately 0 for collection: every foreign row is recorded so
 * `maxForeignCpu` is threshold-independent evidence (a future threshold change
 * can be argued against attestations already written).
 */
export function measureCoTenants(thresholdCpu: number, load1: number, cores: number): CoTenantProfile {
  const samples: PsRow[][] = [];
  let prev = 0;
  for (const offset of SAMPLE_OFFSETS_MS) {
    if (offset > prev) sleepSync(offset - prev);
    prev = offset;
    samples.push(sampleForeignCoTenants(0));
  }
  const { maxForeignCpu, offenders } = aggregateSamples(samples, thresholdCpu);
  return {
    samples: samples.length,
    windowMs: SAMPLE_OFFSETS_MS[SAMPLE_OFFSETS_MS.length - 1] ?? 0,
    maxForeignCpu,
    offenders,
    thresholdCpu,
    load1,
    cores,
  };
}

export interface PreflightOptions {
  /** e.g. 'webgl:attest' — names the caller in every message. */
  label: string;
  /** e.g. 'WEBGL_ATTEST_ALLOW_BUSY' — the trusted-runner override. */
  allowBusyEnv: string;
  /** e.g. 'WEBGL_ATTEST_BUSY_CPU' — the per-process threshold override. */
  busyCpuEnv: string;
  /** Leaked dev servers from OTHER checkouts, already collected by the caller
   *  (it owns REPO_ROOT and the lsof plumbing). */
  leaked: ReadonlyArray<{ pid: number; port: number; cwd: string }>;
}

/**
 * REFUSE (exit 2) unless the machine is quiet across the whole window.
 * Returns the profile on success so the caller can record it in the
 * attestation — an attestation that cannot say how quiet the machine was is
 * exactly what made past ones un-auditable (#1331).
 */
export function preflightSolo(opts: PreflightOptions): CoTenantProfile | null {
  const cores = cpus().length || 1;
  const load1 = loadavg()[0] ?? 0;
  const thresholdCpu = Math.max(1, parseFloat(process.env[opts.busyCpuEnv] || '25') || 25);

  if (process.env[opts.allowBusyEnv] === '1') {
    console.log(`Pre-flight: ${opts.allowBusyEnv}=1 — skipping the quiet-machine guard.`);
    return null;
  }

  console.log(
    `Pre-flight: sampling co-tenants ${SAMPLE_OFFSETS_MS.length}× over ` +
      `${((SAMPLE_OFFSETS_MS[SAMPLE_OFFSETS_MS.length - 1] ?? 0) / 1000).toFixed(1)}s ` +
      `(irregular offsets — a single instant is a coin flip, #1331)…`,
  );
  const profile = measureCoTenants(thresholdCpu, load1, cores);
  const { quiet, reasons } = judgeProfile(profile);

  if (quiet && opts.leaked.length === 0) {
    console.log(
      `Pre-flight: machine looks quiet — ${profile.samples} samples, ` +
        `peak foreign CPU ${profile.maxForeignCpu.toFixed(1)}% (threshold ${thresholdCpu}%), ` +
        `load(1m)=${load1.toFixed(2)} on ${cores} cores. Proceeding.`,
    );
    return profile;
  }

  console.error('────────────────────────────────────────────────────────────');
  console.error(`${opts.label} PRE-FLIGHT — machine is NOT quiet; REFUSING to run.`);
  console.error(
    `  measured: ${profile.samples} samples over ${(profile.windowMs / 1000).toFixed(1)}s, ` +
      `peak foreign CPU ${profile.maxForeignCpu.toFixed(1)}%`,
  );
  for (const r of reasons) console.error(`  ${r}`);
  if (opts.leaked.length) {
    // `task worktree:guard` classifies an idle worktree as abandoned and removes
    // the CHECKOUT, but it never stops a dev server that worktree started. A
    // leaked vite keeps compiling and serving, which is CPU and (through the
    // browser that may still be pointed at it) GPU.
    console.error('  LEAKED dev servers from other checkouts:');
    for (const s of opts.leaked) console.error(`    pid ${s.pid} on :${s.port} — ${s.cwd}`);
    console.error('    → stop each from its own worktree: flox activate -- task e2e:stop');
  }
  console.error('  The real-GPU attest needs the GPU SOLO. A co-tenant browser or');
  console.error('  native GL app steals GPU cycles from the attest\'s single ANGLE/');
  console.error('  Metal context, so a DIFFERENT 1-2 timing-sensitive WebGL specs');
  console.error('  stall each run — the "transients in different files" false refusal.');
  console.error('  → Quit heavy browsers / native GL apps, then re-run.');
  console.error(`  → Override (dedicated/trusted runner only): ${opts.allowBusyEnv}=1`);
  console.error('────────────────────────────────────────────────────────────');
  process.exit(2);
}
