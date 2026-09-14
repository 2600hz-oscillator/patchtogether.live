import { describe, it, expect } from 'vitest';
import { ClockSyncEstimator, toSharedTime } from './clock-sync';

function exchange(est: ClockSyncEstimator, tick: number, outward: number, inward: number, processing = 0) {
  const sent = tick * 1000;
  return est.observe({ clientSendTs: sent, serverRecvTs: sent + outward + 5000,
    serverSendTs: sent + outward + processing + 5000, clientRecvTs: sent + outward + processing + inward });
}
describe('measured clock exchanges', () => {
  it('starts unknown and recovers the offset with zero transit delay', () => {
    const est = new ClockSyncEstimator();
    expect(toSharedTime(100, est.snapshot())).toBeNull();
    for (let i = 0; i < 8; i++) exchange(est, i, 0, 0);
    expect(est.snapshot()).toEqual({ offsetMs: 5000, rttMs: 0, uncertaintyMs: 0, sampleCount: 8, converged: true });
    expect(toSharedTime(100, est.snapshot())).toBe(5100);
  });
  it('clients with different fixed symmetric delays agree, and report their real RTT', () => {
    const a = new ClockSyncEstimator(); const b = new ClockSyncEstimator();
    for (let i = 0; i < 20; i++) { exchange(a, i, 10, 10); exchange(b, i, 110, 110); }
    expect(a.snapshot().rttMs).toBe(20); expect(b.snapshot().rttMs).toBe(220);
    expect(toSharedTime(21000, a.snapshot())).toBe(toSharedTime(21000, b.snapshot()));
    expect(a.snapshot().offsetMs).toBe(5000);
  });
  it('subtracts server processing time and exposes asymmetric-delay uncertainty', () => {
    const est = new ClockSyncEstimator();
    const snap = exchange(est, 1, 10, 110, 300);
    expect(snap.rttMs).toBe(120);
    expect(snap.offsetMs).toBe(4950);
    expect(Math.abs(snap.offsetMs! - 5000)).toBeLessThanOrEqual(snap.uncertaintyMs!);
  });
  it('selects a low-transit sample without mistaking constant delay for zero RTT', () => {
    const est = new ClockSyncEstimator();
    exchange(est, 1, 10, 10);
    for (let i = 2; i < 9; i++) exchange(est, i, 100, 300);
    expect(est.snapshot().offsetMs).toBe(5000);
    expect(est.snapshot().rttMs).toBe(20);
    expect(est.snapshot().converged).toBe(true);
    for (let i = 9; i < 30; i++) exchange(est, i, 200, 200);
    expect(est._debugSamples()).toHaveLength(16);
    expect(est.snapshot().rttMs).toBe(400);
  });
  it('rejects malformed or impossible timing, and resets for a new connection', () => {
    const est = new ClockSyncEstimator();
    for (const values of [[0, NaN, 1, 2], [10, 20, 19, 30], [10, 20, 21, 9], [0, 0, 50, 20]]) {
      const [clientSendTs, serverRecvTs, serverSendTs, clientRecvTs] = values as [number,number,number,number];
      est.observe({clientSendTs,serverRecvTs,serverSendTs,clientRecvTs});
    }
    expect(est.snapshot().sampleCount).toBe(0);
    exchange(est, 1, 10, 10); est.reset();
    expect(est.snapshot().offsetMs).toBeNull();
  });
});
