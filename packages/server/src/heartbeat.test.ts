import { describe, it, expect } from 'vitest';
import { createHeartbeatExtension, HEARTBEAT_AWARENESS_FIELD } from './heartbeat.js';

interface MockTimer { fn: () => void; ms: number; id: number; }

class MockClock {
  private nowMs = 1_000_000;
  private timers = new Map<number, MockTimer>();
  private nextId = 1;

  now = (): number => this.nowMs;

  setInterval = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { fn, ms, id });
    return id;
  };

  clearInterval = (id: number): void => {
    this.timers.delete(id);
  };

  /** Simulate elapsed wall-clock; fire any timers whose interval has elapsed. */
  advance(deltaMs: number): void {
    const target = this.nowMs + deltaMs;
    while (this.nowMs < target) {
      let nextFireDelta = target - this.nowMs;
      let nextFireId: number | null = null;
      for (const t of this.timers.values()) {
        if (t.ms <= nextFireDelta) {
          nextFireDelta = t.ms;
          nextFireId = t.id;
        }
      }
      this.nowMs += nextFireDelta;
      if (nextFireId !== null) {
        const t = this.timers.get(nextFireId);
        if (t) t.fn();
      }
    }
  }

  activeTimers(): MockTimer[] {
    return Array.from(this.timers.values());
  }
}

interface AwarenessFieldWrite { field: string; value: unknown; }
class MockDocument {
  awarenessWrites: AwarenessFieldWrite[] = [];
  // Mirror y-protocols Awareness: Hocuspocus's Document constructor seeds
  // the local state with `null`, and setLocalStateField bails silently
  // until setLocalState is called with a non-null value. Tests cover the
  // setLocalState path to keep the assertion surface honest.
  private localState: Record<string, unknown> | null = null;
  awareness = {
    getLocalState: () => this.localState,
    setLocalState: (s: Record<string, unknown> | null) => {
      this.localState = s;
      if (s !== null) {
        for (const [field, value] of Object.entries(s)) {
          this.awarenessWrites.push({ field, value });
        }
      }
    },
  };
}

function makePayload(documentName: string, document: MockDocument) {
  return { documentName, document } as unknown as never;
}

describe('createHeartbeatExtension', () => {
  it('starts emitting on first connect', async () => {
    const clock = new MockClock();
    const ext = createHeartbeatExtension({
      now: clock.now,
      setInterval: clock.setInterval as never,
      clearInterval: clock.clearInterval as never,
    });
    const doc = new MockDocument();
    await ext.afterLoadDocument!(makePayload('rack-1', doc));
    expect(doc.awarenessWrites.length).toBe(0); // no clients yet, no emissions

    await ext.connected!(makePayload('rack-1', doc));
    // Initial emit is synchronous on connect.
    expect(doc.awarenessWrites.length).toBe(1);
    const w = doc.awarenessWrites[0]!;
    expect(w.field).toBe(HEARTBEAT_AWARENESS_FIELD);
    expect(w.value).toMatchObject({ tick: 1, ts_ms: expect.any(Number) });
  });

  it('emits at burst cadence (8 Hz) for the first 3 seconds', async () => {
    const clock = new MockClock();
    const ext = createHeartbeatExtension({
      now: clock.now,
      setInterval: clock.setInterval as never,
      clearInterval: clock.clearInterval as never,
    });
    const doc = new MockDocument();
    await ext.afterLoadDocument!(makePayload('rack-burst', doc));
    await ext.connected!(makePayload('rack-burst', doc));
    // Initial emit + 8 burst ticks at 125 ms = 1000 ms gives 9 emissions.
    clock.advance(1000);
    // Burst emits every 125 ms; in 1 s that's 8 ticks plus the connect-time emit.
    expect(doc.awarenessWrites.length).toBe(9);
    expect(ext._state('rack-burst')?.mode).toBe('burst');
  });

  it('switches from burst to steady (1 Hz) after burst window elapses', async () => {
    const clock = new MockClock();
    const ext = createHeartbeatExtension({
      now: clock.now,
      setInterval: clock.setInterval as never,
      clearInterval: clock.clearInterval as never,
    });
    const doc = new MockDocument();
    await ext.afterLoadDocument!(makePayload('rack-steady', doc));
    await ext.connected!(makePayload('rack-steady', doc));
    // Drive past the 3 s burst window.
    clock.advance(4000);
    expect(ext._state('rack-steady')?.mode).toBe('steady');
    const tickAt4s = ext._state('rack-steady')?.tick ?? 0;
    // Now drive 5 s of steady; expect ~5 more ticks.
    clock.advance(5000);
    const tickAt9s = ext._state('rack-steady')?.tick ?? 0;
    expect(tickAt9s - tickAt4s).toBeGreaterThanOrEqual(4);
    expect(tickAt9s - tickAt4s).toBeLessThanOrEqual(6);
  });

  it('returns to burst when a second client connects after steady-state', async () => {
    const clock = new MockClock();
    const ext = createHeartbeatExtension({
      now: clock.now,
      setInterval: clock.setInterval as never,
      clearInterval: clock.clearInterval as never,
    });
    const doc = new MockDocument();
    await ext.afterLoadDocument!(makePayload('rack-rejoin', doc));
    await ext.connected!(makePayload('rack-rejoin', doc));
    clock.advance(5000);
    expect(ext._state('rack-rejoin')?.mode).toBe('steady');
    // Second client joins.
    await ext.connected!(makePayload('rack-rejoin', doc));
    expect(ext._state('rack-rejoin')?.mode).toBe('burst');
  });

  it('stops emitting when the last client disconnects', async () => {
    const clock = new MockClock();
    const ext = createHeartbeatExtension({
      now: clock.now,
      setInterval: clock.setInterval as never,
      clearInterval: clock.clearInterval as never,
    });
    const doc = new MockDocument();
    await ext.afterLoadDocument!(makePayload('rack-leave', doc));
    await ext.connected!(makePayload('rack-leave', doc));
    expect(clock.activeTimers().length).toBe(1);
    await ext.onDisconnect!(makePayload('rack-leave', doc));
    expect(clock.activeTimers().length).toBe(0);
    expect(ext._state('rack-leave')?.mode).toBe('off');
  });

  it('cleans up state on document unload', async () => {
    const clock = new MockClock();
    const ext = createHeartbeatExtension({
      now: clock.now,
      setInterval: clock.setInterval as never,
      clearInterval: clock.clearInterval as never,
    });
    const doc = new MockDocument();
    await ext.afterLoadDocument!(makePayload('rack-unload', doc));
    await ext.connected!(makePayload('rack-unload', doc));
    await ext.afterUnloadDocument!({ documentName: 'rack-unload' } as never);
    expect(ext._state('rack-unload')).toBeUndefined();
    expect(clock.activeTimers().length).toBe(0);
  });

  it('emits a strictly monotonic tick id', async () => {
    const clock = new MockClock();
    const ext = createHeartbeatExtension({
      now: clock.now,
      setInterval: clock.setInterval as never,
      clearInterval: clock.clearInterval as never,
    });
    const doc = new MockDocument();
    await ext.afterLoadDocument!(makePayload('rack-mono', doc));
    await ext.connected!(makePayload('rack-mono', doc));
    clock.advance(2000);
    const ticks = doc.awarenessWrites.map((w) => (w.value as { tick: number }).tick);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]).toBeGreaterThan(ticks[i - 1]!);
    }
  });
});
