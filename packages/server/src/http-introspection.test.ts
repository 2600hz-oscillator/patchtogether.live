import { describe, it, expect, vi } from 'vitest';
import {
  classifyMemory,
  createIntrospectionExtension,
  readMemoryThresholds,
  type IntrospectionDeps,
  type MetricsSnapshot,
} from './http-introspection.js';

interface MockTimer {
  fn: () => void;
  ms: number;
  id: number;
}

class MockClock {
  private nowMs = 1_000_000;
  private cpuUserUs = 0;
  private cpuSystemUs = 0;
  private memReading = { rss: 0, heapUsed: 0, heapTotal: 0, external: 0 };
  private uptimeS = 0;
  private timers = new Map<number, MockTimer>();
  private nextId = 1;
  logs: Array<{ level: 'info' | 'warn' | 'error'; msg: string }> = [];

  now = (): number => this.nowMs;
  uptime = (): number => this.uptimeS;
  memoryUsage = () => this.memReading;
  cpuUsage = () => ({ user: this.cpuUserUs, system: this.cpuSystemUs });
  setInterval = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { fn, ms, id });
    return id;
  };
  clearInterval = (id: number): void => {
    this.timers.delete(id);
  };
  log: IntrospectionDeps['log'] = (level, msg) => {
    this.logs.push({ level, msg });
  };

  setMem(mb: { rss: number; heapUsed?: number; heapTotal?: number; ext?: number }): void {
    const mbToB = (n: number): number => n * 1024 * 1024;
    this.memReading = {
      rss: mbToB(mb.rss),
      heapUsed: mbToB(mb.heapUsed ?? mb.rss * 0.5),
      heapTotal: mbToB(mb.heapTotal ?? mb.rss * 0.6),
      external: mbToB(mb.ext ?? 4),
    };
  }
  setCpu(userS: number, systemS: number): void {
    this.cpuUserUs = userS * 1_000_000;
    this.cpuSystemUs = systemS * 1_000_000;
  }
  setUptime(s: number): void {
    this.uptimeS = s;
  }
  advance(deltaMs: number): void {
    this.nowMs += deltaMs;
  }
  fireAllOnce(): void {
    for (const t of this.timers.values()) t.fn();
  }
  activeTimers(): number {
    return this.timers.size;
  }
}

function makeExt(opts?: {
  thresholds?: { warnMb: number; critMb: number };
  conns?: number;
  rooms?: number;
  persist?: 'postgres' | 'memory';
  uncaught?: number;
  unhandled?: number;
  env?: Record<string, string | undefined>;
  fetch?: (url: string) => Promise<unknown>;
}) {
  const clock = new MockClock();
  let conns = opts?.conns ?? 0;
  let rooms = opts?.rooms ?? 0;
  let uncaught = opts?.uncaught ?? 0;
  let unhandled = opts?.unhandled ?? 0;
  const persist = opts?.persist ?? 'postgres';
  const ext = createIntrospectionExtension(
    {
      getConnectionsCount: () => conns,
      getDocumentsCount: () => rooms,
      getPersistenceMode: () => persist,
      getUncaughtExceptions: () => uncaught,
      getUnhandledRejections: () => unhandled,
    },
    {
      deps: {
        now: clock.now,
        uptime: clock.uptime,
        memoryUsage: clock.memoryUsage,
        cpuUsage: clock.cpuUsage,
        setInterval: clock.setInterval as never,
        clearInterval: clock.clearInterval as never,
        log: clock.log,
        fetch: opts?.fetch ?? (async () => undefined),
      },
      thresholdOverride: opts?.thresholds,
      // Default to an empty env so server_version is deterministically
      // 'unknown' (not whatever the test runner's process.env happens to hold).
      env: opts?.env ?? {},
    },
  );
  return {
    clock,
    ext,
    setConns: (n: number) => {
      conns = n;
    },
    setRooms: (n: number) => {
      rooms = n;
    },
    setUncaught: (n: number) => {
      uncaught = n;
    },
    setUnhandled: (n: number) => {
      unhandled = n;
    },
  };
}

describe('readMemoryThresholds', () => {
  it('returns defaults when env is empty', () => {
    expect(readMemoryThresholds({})).toEqual({ warnMb: 384, critMb: 480 });
  });

  it('honours valid env overrides', () => {
    expect(
      readMemoryThresholds({ RELAY_MEM_WARN_MB: '200', RELAY_MEM_CRIT_MB: '300' }),
    ).toEqual({ warnMb: 200, critMb: 300 });
  });

  it('falls back to defaults on garbage values', () => {
    expect(
      readMemoryThresholds({ RELAY_MEM_WARN_MB: 'abc', RELAY_MEM_CRIT_MB: '-50' }),
    ).toEqual({ warnMb: 384, critMb: 480 });
  });
});

describe('classifyMemory', () => {
  const t = { warnMb: 100, critMb: 200 };
  it('returns null below warn', () => {
    expect(classifyMemory(50, t)).toBeNull();
    expect(classifyMemory(100, t)).toBeNull();
  });
  it('returns warn between warn and crit', () => {
    expect(classifyMemory(150, t)).toBe('warn');
    expect(classifyMemory(200, t)).toBe('warn');
  });
  it('returns error above crit', () => {
    expect(classifyMemory(201, t)).toBe('error');
    expect(classifyMemory(9999, t)).toBe('error');
  });
});

describe('createIntrospectionExtension — snapshot shape', () => {
  it('matches the documented MetricsSnapshot keys exactly', () => {
    const { clock, ext } = makeExt({ conns: 3, rooms: 2 });
    clock.setMem({ rss: 100, heapUsed: 50, heapTotal: 60, ext: 4 });
    clock.setCpu(1.5, 0.25);
    clock.setUptime(42);
    const snap = ext._snapshot();
    const keys: Array<keyof MetricsSnapshot> = [
      'ts',
      'boot_id',
      'server_version',
      'uptime_s',
      'rss_mb',
      'heap_used_mb',
      'heap_total_mb',
      'ext_mb',
      'cpu_user_s',
      'cpu_system_s',
      'conns',
      'rooms',
      'persist_writes_per_min',
      'persist_mode',
      'relay_uncaught_exceptions',
      'relay_unhandled_rejections',
    ];
    expect(Object.keys(snap).sort()).toEqual([...keys].sort());
    expect(snap.uptime_s).toBe(42);
    expect(snap.rss_mb).toBe(100);
    expect(snap.heap_used_mb).toBe(50);
    expect(snap.heap_total_mb).toBe(60);
    expect(snap.ext_mb).toBe(4);
    expect(snap.cpu_user_s).toBe(1.5);
    expect(snap.cpu_system_s).toBe(0.25);
    expect(snap.conns).toBe(3);
    expect(snap.rooms).toBe(2);
    expect(snap.persist_writes_per_min).toBe(0);
    expect(snap.persist_mode).toBe('postgres');
    expect(snap.relay_uncaught_exceptions).toBe(0);
    expect(snap.relay_unhandled_rejections).toBe(0);
    expect(typeof snap.boot_id).toBe('string');
    expect(snap.boot_id.length).toBeGreaterThan(2);
  });

  it('reflects the injected persistence mode (memory)', () => {
    const { ext } = makeExt({ persist: 'memory' });
    expect(ext._snapshot().persist_mode).toBe('memory');
  });

  it("defaults server_version to 'unknown' when SERVER_VERSION is unset", () => {
    const { ext } = makeExt({ env: {} });
    expect(ext._snapshot().server_version).toBe('unknown');
  });

  it('surfaces the SERVER_VERSION env on the snapshot', () => {
    const { ext } = makeExt({ env: { SERVER_VERSION: '1.0.1-prod' } });
    expect(ext._snapshot().server_version).toBe('1.0.1-prod');
  });

  it('surfaces the injected relay error counters', () => {
    const { ext, setUncaught, setUnhandled } = makeExt();
    expect(ext._snapshot().relay_uncaught_exceptions).toBe(0);
    setUncaught(3);
    setUnhandled(5);
    const snap = ext._snapshot();
    expect(snap.relay_uncaught_exceptions).toBe(3);
    expect(snap.relay_unhandled_rejections).toBe(5);
  });

  it('defaults the relay error counters to 0 when the getters are absent', () => {
    // Existing callers that predate the optional getters still produce a valid
    // snapshot (the ?? 0 fallback) — this is what keeps the change additive.
    const ext = createIntrospectionExtension({
      getConnectionsCount: () => 0,
      getDocumentsCount: () => 0,
      getPersistenceMode: () => 'postgres',
    });
    const snap = ext._snapshot();
    expect(snap.relay_uncaught_exceptions).toBe(0);
    expect(snap.relay_unhandled_rejections).toBe(0);
  });

  it('boot_id is stable across snapshots from the same extension', () => {
    const { ext } = makeExt();
    const a = ext._snapshot().boot_id;
    const b = ext._snapshot().boot_id;
    expect(a).toBe(b);
  });

  it('boot_id differs across separately-constructed extensions', () => {
    const a = makeExt().ext._snapshot().boot_id;
    const b = makeExt().ext._snapshot().boot_id;
    expect(a).not.toBe(b);
  });

  it('tracks persist_writes_per_min via afterStoreDocument', async () => {
    const { clock, ext } = makeExt();
    await ext.afterStoreDocument!({} as never);
    await ext.afterStoreDocument!({} as never);
    await ext.afterStoreDocument!({} as never);
    expect(ext._snapshot().persist_writes_per_min).toBe(3);
    // Advance past the 60 s ring and confirm old writes get dropped.
    clock.advance(61_000);
    expect(ext._snapshot().persist_writes_per_min).toBe(0);
  });
});

describe('memory alarm logic', () => {
  it('logs nothing when rss is below warn', () => {
    const { clock, ext } = makeExt({ thresholds: { warnMb: 100, critMb: 200 } });
    clock.setMem({ rss: 50 });
    ext._alarmTick();
    expect(clock.logs).toEqual([]);
  });

  it('logs warn when rss crosses warn but stays below crit', () => {
    const { clock, ext } = makeExt({ thresholds: { warnMb: 100, critMb: 200 } });
    clock.setMem({ rss: 150 });
    ext._alarmTick();
    expect(clock.logs.length).toBe(1);
    expect(clock.logs[0]!.level).toBe('warn');
    expect(clock.logs[0]!.msg).toMatch(/\[relay-alarm\] warn rss=150MB/);
  });

  it('logs error when rss crosses crit', () => {
    const { clock, ext } = makeExt({ thresholds: { warnMb: 100, critMb: 200 } });
    clock.setMem({ rss: 250 });
    ext._alarmTick();
    expect(clock.logs.length).toBe(1);
    expect(clock.logs[0]!.level).toBe('error');
    expect(clock.logs[0]!.msg).toMatch(/\[relay-alarm\] CRIT rss=250MB/);
  });

  it('honours env-derived defaults (384/480) when no override is provided', () => {
    // Build with NO threshold override + force env values.
    const clock = new MockClock();
    clock.setMem({ rss: 400 });
    const ext = createIntrospectionExtension(
      { getConnectionsCount: () => 0, getDocumentsCount: () => 0, getPersistenceMode: () => 'postgres' },
      {
        deps: {
          now: clock.now,
          uptime: clock.uptime,
          memoryUsage: clock.memoryUsage,
          cpuUsage: clock.cpuUsage,
          setInterval: clock.setInterval as never,
          clearInterval: clock.clearInterval as never,
          log: clock.log,
        },
        env: {}, // explicit empty env → defaults: warn=384, crit=480
      },
    );
    ext._alarmTick();
    // 400 > 384 (warn) but < 480 (crit) → warn level
    expect(clock.logs.length).toBe(1);
    expect(clock.logs[0]!.level).toBe('warn');
  });

  it('30 s interval is registered on onConfigure and stopped on onDestroy', async () => {
    const { clock, ext } = makeExt();
    expect(clock.activeTimers()).toBe(0);
    await ext.onConfigure!({} as never);
    expect(clock.activeTimers()).toBe(1);
    await ext.onDestroy!({} as never);
    expect(clock.activeTimers()).toBe(0);
  });
});

describe('Better Stack heartbeat ping', () => {
  const URL = 'https://uptime.betterstack.example/api/v1/heartbeat/tok';

  it('does not ping when BETTERSTACK_HEARTBEAT_URL is unset', async () => {
    const calls: string[] = [];
    const { ext } = makeExt({
      env: {},
      fetch: async (u) => {
        calls.push(u);
      },
    });
    await ext._pingHeartbeat();
    expect(calls).toEqual([]);
  });

  it('pings the heartbeat URL when set', async () => {
    const calls: string[] = [];
    const { ext } = makeExt({
      env: { BETTERSTACK_HEARTBEAT_URL: URL },
      fetch: async (u) => {
        calls.push(u);
      },
    });
    await ext._pingHeartbeat();
    expect(calls).toEqual([URL]);
  });

  it('swallows a failing heartbeat ping (never throws)', async () => {
    const { ext } = makeExt({
      env: { BETTERSTACK_HEARTBEAT_URL: URL },
      fetch: async () => {
        throw new Error('network down');
      },
    });
    await expect(ext._pingHeartbeat()).resolves.toBeUndefined();
  });

  it('fires from the 30 s alarm interval alongside the memory alarm', async () => {
    const calls: string[] = [];
    const { clock, ext } = makeExt({
      env: { BETTERSTACK_HEARTBEAT_URL: URL },
      fetch: async (u) => {
        calls.push(u);
      },
    });
    await ext.onConfigure!({} as never);
    clock.fireAllOnce();
    await Promise.resolve(); // flush the void pingHeartbeat() microtask
    expect(calls).toEqual([URL]);
    await ext.onDestroy!({} as never);
  });
});

// Minimal IncomingMessage / ServerResponse stand-ins for onRequest tests.
function makeReq(url: string): { url: string } {
  return { url };
}
function makeRes() {
  const captured: { status?: number; headers?: Record<string, string>; body?: string } = {};
  return {
    captured,
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status;
      captured.headers = headers;
    },
    end(body: string) {
      captured.body = body;
    },
  };
}

describe('onRequest routing', () => {
  it('replies to GET /health with 200 + {ok:true}', async () => {
    const { ext } = makeExt({ persist: 'memory' });
    const req = makeReq('/health');
    const res = makeRes();
    let threw = false;
    try {
      await ext.onRequest!({
        request: req,
        response: res,
        instance: {} as never,
      } as never);
    } catch (e) {
      // Empty-string throw is the Hocuspocus protocol for "extension handled it"
      threw = true;
      expect(e).toBe('');
    }
    expect(threw).toBe(true);
    expect(res.captured.status).toBe(200);
    expect(res.captured.headers!['Content-Type']).toBe('application/json');
    const body = JSON.parse(res.captured.body!);
    expect(body.ok).toBe(true);
    expect(typeof body.boot_id).toBe('string');
    // server_version (per-tier deploy string) surfaced on /health for deploy
    // confirmation; 'unknown' here since makeExt defaults env to {}.
    expect(body.server_version).toBe('unknown');
    // Phase 2a / FW1: /health surfaces the persistence mode so a misconfigured
    // prod relay serving a non-persistent rack is observable.
    expect(body.persist).toBe('memory');
  });

  it('replies to GET /metrics with the documented JSON shape', async () => {
    const { clock, ext } = makeExt({ conns: 7, rooms: 4, persist: 'memory' });
    clock.setMem({ rss: 123, heapUsed: 64, heapTotal: 80, ext: 8 });
    clock.setUptime(99);
    const req = makeReq('/metrics');
    const res = makeRes();
    try {
      await ext.onRequest!({ request: req, response: res, instance: {} as never } as never);
    } catch (e) {
      expect(e).toBe('');
    }
    expect(res.captured.status).toBe(200);
    const body = JSON.parse(res.captured.body!) as MetricsSnapshot;
    expect(body.rss_mb).toBe(123);
    expect(body.conns).toBe(7);
    expect(body.rooms).toBe(4);
    expect(body.uptime_s).toBe(99);
    expect(body.persist_mode).toBe('memory');
  });

  it('matches /metrics?fresh=1 as the metrics route (query is ignored)', async () => {
    const { ext } = makeExt();
    const res = makeRes();
    try {
      await ext.onRequest!({
        request: makeReq('/metrics?fresh=1'),
        response: res,
        instance: {} as never,
      } as never);
    } catch (e) {
      expect(e).toBe('');
    }
    expect(res.captured.status).toBe(200);
  });

  it('does NOT reply to other paths (falls through to Hocuspocus default)', async () => {
    const { ext } = makeExt();
    const res = makeRes();
    await ext.onRequest!({
      request: makeReq('/other'),
      response: res,
      instance: {} as never,
    } as never);
    // Nothing written; throw was never invoked.
    expect(res.captured.status).toBeUndefined();
    expect(res.captured.body).toBeUndefined();
  });
});

describe('snapshot integration smoke', () => {
  it('reflects real process numbers without mocks', () => {
    // Build with default deps to confirm the wiring against real process apis.
    const ext = createIntrospectionExtension({
      getConnectionsCount: () => 0,
      getDocumentsCount: () => 0,
      getPersistenceMode: () => 'postgres',
    });
    const snap = ext._snapshot();
    expect(snap.rss_mb).toBeGreaterThan(0);
    expect(snap.heap_used_mb).toBeGreaterThan(0);
    expect(snap.uptime_s).toBeGreaterThanOrEqual(0);
    expect(snap.cpu_user_s).toBeGreaterThanOrEqual(0);
    expect(snap.conns).toBe(0);
    expect(snap.rooms).toBe(0);
  });
});

// Silence: ensure no test left an interval running.
vi.useRealTimers();
