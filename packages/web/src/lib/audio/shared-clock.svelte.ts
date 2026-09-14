// Shared rack time comes from correlated request/response exchanges. Awareness
// remains presence state and never contributes a clock observation.
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import { ClockSyncEstimator, type ClockSyncSnapshot } from '$lib/multiplayer/clock-sync';

export const HEARTBEAT_AWARENESS_FIELD = '__heartbeat';
export const RESYNC_INTERVAL_MS = 5000;
export const RESYNC_SMOOTHING_MS = 200;
const PROBE_BURST_MS = 125;
const PROBE_STEADY_MS = 1000;
const PROBE_TIMEOUT_MS = 5000;

export interface SharedClockHandle {
  readonly epoch_ms: number | null;
  readonly snapshot: ClockSyncSnapshot;
  readonly resyncCount: number;
  sharedTimeAt(perfNowMs: number): number | null;
  sharedTimeNow(): number | null;
  resetEpoch(): void;
  onReset(fn: () => void): () => void;
  rngSeed(): number;
  destroy(): void;
}
interface InternalDeps {
  perfNow(): number;
  setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(t: ReturnType<typeof setInterval>): void;
  randomU32(): number;
}
const browserDeps: InternalDeps = {
  perfNow: () => performance.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: t => clearInterval(t),
  randomU32: () => Math.floor(Math.random() * 0x100000000) | 0,
};
export interface CreateSharedClockOptions {
  provider: HocuspocusProvider | null;
  ydoc: Y.Doc | null;
  deps?: Partial<InternalDeps>;
}

export function createSharedClock(opts: CreateSharedClockOptions): SharedClockHandle {
  const deps = { ...browserDeps, ...opts.deps };
  const provider = opts.provider;
  const estimator = new ClockSyncEstimator();
  let snapshot = $state<ClockSyncSnapshot>(estimator.snapshot());
  let epoch_ms = $state<number | null>(null);
  let resyncCount = $state(0);
  let offset: number | null = null;
  let smoothing: { from: number; to: number; started: number } | null = null;
  const meta = opts.ydoc?.getMap('meta') ?? null;
  const resetListeners = new Set<() => void>();
  let observedEpoch: number | null = null;
  const onMetaChange = () => {
    const value = meta?.get('epoch_ms');
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    const changed = value !== observedEpoch;
    observedEpoch = value;
    epoch_ms = value;
    if (changed) for (const listener of resetListeners) listener();
  };
  onMetaChange();
  meta?.observe(onMetaChange);

  function effectiveOffset(): number | null {
    if (!smoothing) return offset;
    const fraction = Math.min(1, Math.max(0, (deps.perfNow() - smoothing.started) / RESYNC_SMOOTHING_MS));
    const value = smoothing.from + (smoothing.to - smoothing.from) * fraction;
    if (fraction === 1) smoothing = null;
    return value;
  }
  function sharedTimeAt(perfNowMs: number): number | null {
    const current = effectiveOffset();
    return current === null ? null : perfNowMs + current;
  }
  function rngSeed(): number {
    if (!meta || !opts.ydoc) return 0;
    if (typeof meta.get('rngSeed') !== 'number') {
      opts.ydoc.transact(() => {
        if (typeof meta.get('rngSeed') !== 'number') meta.set('rngSeed', deps.randomU32());
      });
    }
    return meta.get('rngSeed') as number;
  }
  function applyObservation(): void {
    snapshot = estimator.snapshot();
    const target = snapshot.offsetMs;
    if (target === null) return;
    const current = effectiveOffset();
    if (current === null) offset = target;
    else if (offset !== null && Math.abs(target - offset) >= 0.05) {
      smoothing = { from: current, to: target, started: deps.perfNow() };
      offset = target;
      resyncCount++;
    }
    if (snapshot.converged && meta && opts.ydoc && typeof meta.get('epoch_ms') !== 'number') {
      opts.ydoc.transact(() => {
        if (typeof meta.get('epoch_ms') !== 'number') meta.set('epoch_ms', Math.round(deps.perfNow() + target));
        rngSeed();
      });
    }
  }

  let connected = provider?.configuration.websocketProvider.status === 'connected';
  let sequence = 0;
  let pending: { id: number; sent: number } | null = null;
  let lastSent = -Infinity;
  let session: string | null = null;
  function requestSample(): void {
    if (!provider || !connected) return;
    const now = deps.perfNow();
    if (pending && now - pending.sent < PROBE_TIMEOUT_MS) return;
    if (now - lastSent < (snapshot.converged ? PROBE_STEADY_MS : PROBE_BURST_MS)) return;
    pending = { id: ++sequence, sent: now };
    lastSent = now;
    try { provider.sendStateless(JSON.stringify({ type: 'clock-ping', id: pending.id })); }
    catch { pending = null; }
  }
  const onStateless = ({ payload }: { payload: string }) => {
    const received = deps.perfNow();
    if (payload.length > 512) return;
    let response: { type?: unknown; id?: unknown; session?: unknown; serverRecvTs?: unknown; serverSendTs?: unknown };
    try { response = JSON.parse(payload); } catch { return; }
    if (!response || response.type !== 'clock-pong' || !pending || response.id !== pending.id
      || typeof response.session !== 'string' || !response.session
      || typeof response.serverRecvTs !== 'number' || typeof response.serverSendTs !== 'number') return;
    const sent = pending.sent;
    pending = null;
    if (received - sent > PROBE_TIMEOUT_MS) return;
    if (session !== null && session !== response.session) estimator.reset();
    session = response.session;
    estimator.observe({ clientSendTs: sent, clientRecvTs: received,
      serverRecvTs: response.serverRecvTs, serverSendTs: response.serverSendTs });
    applyObservation();
  };
  const onStatus = ({ status }: { status: string }) => {
    connected = status === 'connected';
    pending = null;
    estimator.reset();
    snapshot = estimator.snapshot();
    lastSent = -Infinity;
    if (connected) requestSample();
  };
  provider?.on('stateless', onStateless);
  provider?.on('status', onStatus);
  const timer = provider ? deps.setInterval(requestSample, PROBE_BURST_MS) : null;
  requestSample();

  return {
    get epoch_ms() { return epoch_ms; },
    get snapshot() { return snapshot; },
    get resyncCount() { return resyncCount; },
    sharedTimeAt,
    sharedTimeNow: () => sharedTimeAt(deps.perfNow()),
    resetEpoch() {
      const time = sharedTimeAt(deps.perfNow());
      if (time === null || !meta || !opts.ydoc) return;
      opts.ydoc.transact(() => meta.set('epoch_ms', Math.round(time)));
    },
    onReset(fn) { resetListeners.add(fn); return () => { resetListeners.delete(fn); }; },
    rngSeed,
    destroy() {
      provider?.off('stateless', onStateless);
      provider?.off('status', onStatus);
      meta?.unobserve(onMetaChange);
      if (timer !== null) deps.clearInterval(timer);
      pending = null;
      resetListeners.clear();
    },
  };
}
export { toSharedTime } from '$lib/multiplayer/clock-sync';
