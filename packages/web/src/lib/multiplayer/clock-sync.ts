// packages/web/src/lib/multiplayer/clock-sync.ts
//
// NTP-style offset estimator. Each heartbeat carries (tick, server_ts_ms);
// on receipt we record client_recv_ts and compute a candidate offset.
// We keep a rolling window of (offset, rtt) candidates and surface the
// "best" estimate (Cristian's algorithm: lowest-RTT sample wins).
//
// Pure data — no DOM, no Yjs, no Awareness. The provider-side code lives
// in shared-clock.svelte.ts, which imports this and feeds heartbeat
// observations into a single ClockSyncEstimator instance.

export interface HeartbeatObservation {
  /** Server's monotonic tick id (strictly increasing). */
  tick: number;
  /** Server-side `performance.now()` at the moment of broadcast (ms). */
  serverTs: number;
  /** Client-side `performance.now()` when the awareness update was applied (ms). */
  clientRecvTs: number;
}

export interface ClockSyncSample {
  /** offset_ms = serverTs - clientRecvTs + halfRtt. Add to client perf-now to get shared-time. */
  offsetMs: number;
  /** Full round-trip estimated as delta-clientRecv minus delta-serverTs over recent ticks. */
  rttMs: number;
  /** Tick id of the heartbeat that produced this sample. */
  tick: number;
}

export interface ClockSyncSnapshot {
  /** Smoothed best-estimate offset, or null until at least one sample has been collected. */
  offsetMs: number | null;
  /** Smoothed RTT, or null until two samples have been collected (RTT requires a delta). */
  rttMs: number | null;
  /** True once we've collected the burst (≥ 8 samples) so callers know offset is stable. */
  converged: boolean;
  /** Total observations seen. */
  sampleCount: number;
}

const BURST_SAMPLES = 8;
// Filtered-minimum window: pick the sample with smallest RTT across the
// last N. Larger windows are more robust to transient latency spikes;
// smaller windows track wall-clock drift faster. 16 samples at 1 Hz = 16s
// trailing window in steady state, ~2s in burst.
const FILTER_WINDOW = 16;

export class ClockSyncEstimator {
  private samples: ClockSyncSample[] = [];
  private lastObservation: HeartbeatObservation | null = null;

  /** Feed a heartbeat receipt; returns the new snapshot. */
  observe(obs: HeartbeatObservation): ClockSyncSnapshot {
    let rttMs: number | null;
    if (this.lastObservation) {
      // Server delta vs client delta is the round-trip elapsed time
      // discrepancy; positive = network round-trip introduces latency.
      // RTT = (clientRecvDelta - serverTsDelta). Bounded at 0 because
      // clock skew can otherwise produce nonsense negatives during burst.
      const clientDelta = obs.clientRecvTs - this.lastObservation.clientRecvTs;
      const serverDelta = obs.serverTs - this.lastObservation.serverTs;
      rttMs = Math.max(0, clientDelta - serverDelta);
    } else {
      // First sample: we don't have a real RTT measurement. We still
      // want to surface an offset estimate (useful for the very first
      // heartbeat after connect) so we synthesise rttMs = null and the
      // filter logic in snapshot() treats null as "untrusted; fall back
      // only when no measured-RTT samples are available".
      rttMs = null;
    }

    // One-way latency is half the RTT (Cristian's assumption: symmetric
    // network). Asymmetry biases all candidates equally; the
    // filtered-minimum step below picks the cleanest one.
    const halfRtt = rttMs ?? 0;
    const offsetMs = obs.serverTs - obs.clientRecvTs + halfRtt / 2;

    this.samples.push({ offsetMs, rttMs: rttMs ?? Number.POSITIVE_INFINITY, tick: obs.tick });
    if (this.samples.length > FILTER_WINDOW) {
      this.samples.shift();
    }
    this.lastObservation = obs;

    return this.snapshot();
  }

  /** Mark that the burst-rate ticks have fully arrived; reserved for callers
   *  that want to manually flag convergence (e.g. on a stateless ping/pong).
   *  Otherwise convergence is auto-detected once `sampleCount >= BURST_SAMPLES`. */
  reset(): void {
    this.samples = [];
    this.lastObservation = null;
  }

  snapshot(): ClockSyncSnapshot {
    const count = this.samples.length;
    if (count === 0) {
      return { offsetMs: null, rttMs: null, converged: false, sampleCount: 0 };
    }
    // Cristian's algorithm: pick the sample with smallest RTT. Filtering
    // by min-RTT (rather than averaging) is essential — averaging biases
    // toward the long-tail latency spike. Ties break toward the most
    // recent sample so wall-clock drift between the server and client
    // shows up as a slow walk in offset rather than a stale lock.
    let best = this.samples[0]!;
    for (let i = 1; i < count; i++) {
      const s = this.samples[i]!;
      if (s.rttMs <= best.rttMs) best = s;
    }
    // The first-ever sample carries no measured RTT (we synthesised
    // Infinity); when it's the only one available we still want to
    // surface an offset estimate, but report rttMs as null so callers
    // can tell convergence hasn't really happened yet.
    const rttMs = Number.isFinite(best.rttMs) ? best.rttMs : null;
    return {
      offsetMs: best.offsetMs,
      rttMs,
      converged: count >= BURST_SAMPLES,
      sampleCount: count,
    };
  }

  /** Inspect samples (test-only). */
  _debugSamples(): readonly ClockSyncSample[] {
    return this.samples;
  }
}

/** Convert a client perf-now reading to shared-time using a snapshot's offset.
 *  Returns null when the offset isn't yet known (pre-first-heartbeat). */
export function toSharedTime(perfNowMs: number, snapshot: ClockSyncSnapshot): number | null {
  if (snapshot.offsetMs === null) return null;
  return perfNowMs + snapshot.offsetMs;
}
