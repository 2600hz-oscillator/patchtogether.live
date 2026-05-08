import { describe, it, expect } from 'vitest';
import { ClockSyncEstimator, toSharedTime } from './clock-sync';

describe('ClockSyncEstimator', () => {
  it('returns nulls until the first observation', () => {
    const est = new ClockSyncEstimator();
    const snap = est.snapshot();
    expect(snap.offsetMs).toBeNull();
    expect(snap.rttMs).toBeNull();
    expect(snap.converged).toBe(false);
    expect(snap.sampleCount).toBe(0);
  });

  it('produces an offset estimate after one observation', () => {
    const est = new ClockSyncEstimator();
    // Server at t=1000; client perf at t=200; expected offset ≈ 800.
    const snap = est.observe({ tick: 1, serverTs: 1000, clientRecvTs: 200 });
    expect(snap.offsetMs).toBeCloseTo(800, 2);
    expect(snap.sampleCount).toBe(1);
  });

  it('recovers shared-time correctly with simulated zero-latency network', () => {
    // Server clock running 5000 ms ahead of client perf. Zero RTT.
    const est = new ClockSyncEstimator();
    let serverTs = 1_000_000;
    let clientTs = 5_000;
    for (let i = 0; i < 10; i++) {
      est.observe({ tick: i + 1, serverTs, clientRecvTs: clientTs });
      serverTs += 1000;
      clientTs += 1000;
    }
    const snap = est.snapshot();
    expect(snap.offsetMs).toBeCloseTo(995_000, 0);
    expect(snap.converged).toBe(true);
    // Mapping should reproduce the server time exactly.
    const recovered = toSharedTime(clientTs - 1000, snap);
    expect(recovered).toBeCloseTo(serverTs - 1000, 0);
  });

  it('estimates RTT from server/client delta divergence', () => {
    // Simulate 50 ms of round-trip latency: each new heartbeat arrives
    // 50 ms later than its server timestamp would suggest. The first
    // sample's RTT is unmeasurable (synthetic Infinity); the second
    // produces the first measured value, which the filtered-min picks.
    const est = new ClockSyncEstimator();
    let serverTs = 1_000_000;
    let clientTs = 5_000;
    est.observe({ tick: 1, serverTs, clientRecvTs: clientTs });
    serverTs += 1000;
    clientTs += 1050;
    est.observe({ tick: 2, serverTs, clientRecvTs: clientTs });
    const snap = est.snapshot();
    expect(snap.rttMs).not.toBeNull();
    expect(snap.rttMs as number).toBeCloseTo(50, 1);
  });

  it('converges to the lowest-RTT sample under jittered latency', () => {
    const est = new ClockSyncEstimator();
    const TRUE_OFFSET = 12_345;
    let server = 1_000_000;
    // First sample's RTT is synthetic (no prior); subsequent samples
    // measure real RTT. Inject a low-noise pair (jitter 100→100) so
    // the measured RTT is 0; the rest are noisy. Min-RTT filtering
    // should pick the low-noise sample, yielding the cleanest offset.
    const jitter = [50, 100, 100, 300, 220, 180, 250, 130, 30, 170];
    for (let i = 0; i < jitter.length; i++) {
      const j = jitter[i]!;
      const client = server - TRUE_OFFSET + j;
      est.observe({ tick: i + 1, serverTs: server, clientRecvTs: client });
      server += 1000;
    }
    const snap = est.snapshot();
    expect(snap.converged).toBe(true);
    // The clean sample 2 has rtt=0; chosen offset = serverTs - clientRecv
    // + halfRTT/2 = TRUE_OFFSET - jitter[2] = 12345 - 100 = 12245.
    // We just check it's within typical jitter range of TRUE_OFFSET.
    expect(Math.abs((snap.offsetMs ?? 0) - TRUE_OFFSET)).toBeLessThanOrEqual(150);
    // RTT estimate locked onto the clean pair.
    expect(snap.rttMs).toBeLessThanOrEqual(50);
  });

  it('marks converged=true once burst-many samples have been seen', () => {
    const est = new ClockSyncEstimator();
    for (let i = 0; i < 7; i++) {
      est.observe({ tick: i + 1, serverTs: 1000 + i * 1000, clientRecvTs: i * 1000 });
    }
    expect(est.snapshot().converged).toBe(false);
    est.observe({ tick: 8, serverTs: 8000, clientRecvTs: 7000 });
    expect(est.snapshot().converged).toBe(true);
  });

  it('caps the rolling window so old samples drop off', () => {
    const est = new ClockSyncEstimator();
    for (let i = 0; i < 50; i++) {
      est.observe({ tick: i + 1, serverTs: 1000 + i * 1000, clientRecvTs: i * 1000 });
    }
    expect(est._debugSamples().length).toBe(16);
  });

  it('reset() clears state', () => {
    const est = new ClockSyncEstimator();
    est.observe({ tick: 1, serverTs: 1000, clientRecvTs: 200 });
    est.reset();
    expect(est.snapshot().sampleCount).toBe(0);
    expect(est.snapshot().offsetMs).toBeNull();
  });
});

describe('toSharedTime', () => {
  it('returns null when offset is null', () => {
    expect(toSharedTime(1000, { offsetMs: null, rttMs: null, converged: false, sampleCount: 0 })).toBeNull();
  });

  it('adds offset to perf time', () => {
    const snap = { offsetMs: 5000, rttMs: 10, converged: true, sampleCount: 8 };
    expect(toSharedTime(2000, snap)).toBe(7000);
  });
});
