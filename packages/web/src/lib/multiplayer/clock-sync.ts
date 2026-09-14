/** Four-timestamp exchange: performance.now() on the client, epoch ms on the
 * server. Half the transit time bounds uncertainty from path asymmetry. */
export interface ClockObservation {
  clientSendTs: number;
  serverRecvTs: number;
  serverSendTs: number;
  clientRecvTs: number;
}
export interface ClockSyncSample { offsetMs: number; rttMs: number; }
export interface ClockSyncSnapshot {
  offsetMs: number | null;
  rttMs: number | null;
  uncertaintyMs: number | null;
  /** Enough exchanges to select a sample; not a guarantee of accuracy. */
  converged: boolean;
  sampleCount: number;
}
const BURST_SAMPLES = 8;
const FILTER_WINDOW = 16;

export class ClockSyncEstimator {
  private samples: ClockSyncSample[] = [];
  observe(obs: ClockObservation): ClockSyncSnapshot {
    const { clientSendTs, serverRecvTs, serverSendTs, clientRecvTs } = obs;
    const elapsed = clientRecvTs - clientSendTs;
    const processing = serverSendTs - serverRecvTs;
    if (![clientSendTs, serverRecvTs, serverSendTs, clientRecvTs].every(Number.isFinite)
      || elapsed < 0 || processing < 0 || processing > elapsed) return this.snapshot();
    this.samples.push({
      offsetMs: ((serverRecvTs - clientSendTs) + (serverSendTs - clientRecvTs)) / 2,
      rttMs: elapsed - processing,
    });
    if (this.samples.length > FILTER_WINDOW) this.samples.shift();
    return this.snapshot();
  }
  reset(): void { this.samples = []; }
  snapshot(): ClockSyncSnapshot {
    let best: ClockSyncSample | undefined;
    for (const sample of this.samples) {
      if (!best || sample.rttMs <= best.rttMs) best = sample;
    }
    return {
      offsetMs: best?.offsetMs ?? null,
      rttMs: best?.rttMs ?? null,
      uncertaintyMs: best ? best.rttMs / 2 : null,
      converged: this.samples.length >= BURST_SAMPLES,
      sampleCount: this.samples.length,
    };
  }
  _debugSamples(): readonly ClockSyncSample[] { return this.samples; }
}
export function toSharedTime(perfNowMs: number, snapshot: ClockSyncSnapshot): number | null {
  return snapshot.offsetMs === null ? null : perfNowMs + snapshot.offsetMs;
}
