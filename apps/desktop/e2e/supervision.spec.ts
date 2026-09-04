// Helper supervision (P3) — the harness legs, on the protocol-faithful Node
// stubs driven through the REAL supervisor state machine (injected binary
// paths — the same seam a packaged shell resolves Resources/helpers through):
//
//   1. supervisor boots stubs to 'running'; status surfaced via
//      ptNative.helperStatus (get + subscribe); missing binary = 'stopped'
//      with detail, no spawn spam.
//   2. origin allowlist on the SUPERVISED sockets: disallowed Origin → 403,
//      loopback/patchtogether origins → protocol reply (mirrors BridgeKit's
//      defaultOriginPolicy; the real bridges' own suites cover the Swift
//      side — es9 42/42, nativeapps 36/36 on this checkout).
//   3. es9: client attaches → SIGKILL stub → observed running→restarting
//      (backoff delay > 0)→running → client reattaches; then the busy →
//      {"type":"takeover"} eviction path, then GRACE takeover of a stale
//      incumbent (stub staleAfter shortened to keep the leg fast).
//   4. vst: mount → socket drop → reconnect same clientId → `mounted`
//      REPLAYED (park/adopt); live-socket clientId eviction; SIGKILL →
//      restart → fresh hello works (park state legitimately dies with the
//      bridge process — park is per-bridge-lifetime, asserted as such).
//
// All waits are observable-state (status feeds, socket messages, expect.poll)
// — zero fixed sleeps. Stub paths contain no spaces (PT_HELPER_*_ARGS is
// whitespace-split).

import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import * as path from 'node:path';
import WebSocket from 'ws';

const APP_DIR = path.resolve(__dirname, '..');
const WEB_ROOT = process.env.PT_DESKTOP_WEB_ROOT
  ? path.resolve(process.env.PT_DESKTOP_WEB_ROOT)
  : path.resolve(APP_DIR, '../../packages/web/build');
const STUBS = path.join(APP_DIR, 'dist', 'stubs');

// Each launch gets FRESH ports: a fixed pair raced across tests — the old
// shell's stub dies asynchronously after app.close() (stdin-close/SIGTERM),
// so the next test's supervisor probe could greet the LINGERING stub and go
// 'running' just as it exited (measured: ECONNREFUSED on the first client
// connect). Fix the fixture, never the timeout.
let portSlot = 0;
const BOOT_MS = 60_000;

interface HelperStatusLike {
  id: string;
  state: string;
  pid: number | null;
  attempt: number;
  delayMs: number | null;
  detail: string | null;
}

declare global {
  interface Window {
    __helperEvents?: HelperStatusLike[];
  }
}

async function launchShell(): Promise<{
  app: ElectronApplication;
  page: Page;
  es9Port: number;
  vstPort: number;
}> {
  const es9Port = 19210 + 2 * (portSlot % 40);
  const vstPort = 19310 + 2 * (portSlot % 40);
  portSlot += 1;
  const app = await _electron.launch({
    args: [APP_DIR],
    env: {
      ...process.env,
      PT_DESKTOP_WEB_ROOT: WEB_ROOT,
      PT_DESKTOP_PORT: '0',
      PT_DESKTOP_WINDOWED: '1',
      PT_HELPER_ES9_BIN: process.execPath,
      PT_HELPER_ES9_ARGS: `${path.join(STUBS, 'es9-stub.js')} --port ${es9Port} --stale-after-ms 400`,
      PT_HELPER_ES9_PORT: String(es9Port),
      PT_HELPER_VST_BIN: process.execPath,
      PT_HELPER_VST_ARGS: `${path.join(STUBS, 'vst-stub.js')} --port ${vstPort} --park-ms 20000`,
      PT_HELPER_VST_PORT: String(vstPort),
      // No PTZ stub — its row must read 'stopped: binary not found', proving
      // a missing helper degrades to a status row, not spawn churn.
      PT_HELPER_PTZ_BIN: '/nonexistent/pt-ptz',
      PT_HELPER_BACKOFF_BASE_MS: '200',
      // Keep the attempt counter intact across a whole test.
      PT_HELPER_STABLE_RESET_MS: '600000',
    },
  });
  // Main-process output (supervisor + forwarded helper stdio) into the test
  // log — the difference between a diagnosable red and a bare ECONNREFUSED.
  app.process().stdout?.on('data', (d: Buffer) => console.log(`[main] ${String(d).trimEnd()}`));
  app.process().stderr?.on('data', (d: Buffer) => console.error(`[main] ${String(d).trimEnd()}`));
  const page = await app.firstWindow();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/rack/, { timeout: BOOT_MS });
  return { app, page, es9Port, vstPort };
}

/** Observable-state wait on the MAIN-process status via ptNative.
 *  ⚠ Deliberately NOT page.waitForFunction with an async predicate: in this
 *  Electron harness the predicate's PENDING PROMISE is itself truthy on the
 *  first poll (measured: an always-false async predicate "passed" in 298 ms),
 *  which made every such wait vacuous — the vst restart leg caught it because
 *  only there did reality lag the lie. page.evaluate awaits promises by
 *  contract, so the poll loop lives on the Node side. */
async function waitForState(page: Page, id: string, state: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async (id) => {
          const w = window as unknown as {
            ptNative?: { helperStatus: { get: () => Promise<{ current: HelperStatusLike[] }> } };
          };
          const snap = await w.ptNative?.helperStatus.get();
          return snap?.current.find((s) => s.id === id)?.state ?? null;
        }, id),
      { timeout: 30_000 },
    )
    .toBe(state);
}

async function history(page: Page, id: string): Promise<HelperStatusLike[]> {
  return page.evaluate(async (id) => {
    const w = window as unknown as {
      ptNative: { helperStatus: { get: () => Promise<{ history: HelperStatusLike[] }> } };
    };
    return (await w.ptNative.helperStatus.get()).history.filter((s) => s.id === id);
  }, id);
}

async function pidOf(page: Page, id: string): Promise<number> {
  const pid = await page.evaluate(async (id) => {
    const w = window as unknown as {
      ptNative: { helperStatus: { get: () => Promise<{ current: HelperStatusLike[] }> } };
    };
    return (await w.ptNative.helperStatus.get()).current.find((s) => s.id === id)?.pid ?? null;
  }, id);
  expect(pid).not.toBeNull();
  return pid as number;
}

// ---- tiny protocol client (Node side — same machine as the stubs) ----------

interface Client {
  ws: WebSocket;
  send: (obj: unknown) => void;
  /** Resolve the next JSON message matching the predicate (queued messages
   *  are consulted first — nothing is lost to ordering). */
  next: (match: (m: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>;
  /** Synchronous: is a matching message sitting in the unconsumed queue? */
  has: (match: (m: Record<string, unknown>) => boolean) => boolean;
  closed: Promise<void>;
  close: () => void;
}

function connect(port: number, origin?: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin ? { origin } : {});
    const queue: Record<string, unknown>[] = [];
    const waiters: {
      match: (m: Record<string, unknown>) => boolean;
      resolve: (m: Record<string, unknown>) => void;
    }[] = [];
    let closeResolve!: () => void;
    const closed = new Promise<void>((r) => (closeResolve = r));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      const i = waiters.findIndex((w) => w.match(msg));
      if (i >= 0) waiters.splice(i, 1)[0]!.resolve(msg);
      else queue.push(msg);
    });
    ws.on('close', () => closeResolve());
    ws.on('open', () =>
      resolve({
        ws,
        send: (obj) => ws.send(JSON.stringify(obj)),
        has: (match) => queue.some(match),
        next: (match) =>
          new Promise((res, rej) => {
            const qi = queue.findIndex(match);
            if (qi >= 0) {
              res(queue.splice(qi, 1)[0]!);
              return;
            }
            const timer = setTimeout(() => rej(new Error('timed out waiting for message')), 10_000);
            waiters.push({
              match,
              resolve: (m) => {
                clearTimeout(timer);
                res(m);
              },
            });
          }),
        closed,
        close: () => ws.close(),
      }),
    );
    ws.on('error', (err) => reject(err));
  });
}

/** One-shot hello probe: 'deviceInfo' | 'busy' (never sends takeover). */
async function helloProbe(port: number): Promise<string> {
  const c = await connect(port);
  try {
    c.send({ type: 'hello', rate: 48000, name: 'spec-probe' });
    const m = await c.next((x) => x.type === 'deviceInfo' || (x.type === 'status' && x.state === 'busy'));
    return m.type === 'deviceInfo' ? 'deviceInfo' : 'busy';
  } finally {
    c.close();
  }
}

// ---- the legs ---------------------------------------------------------------

test('supervisor boots stubs to running; status via ptNative; missing binary degrades to a row', async () => {
  const { app, page } = await launchShell();
  try {
    await waitForState(page, 'es9', 'running');
    await waitForState(page, 'vst', 'running');

    const ptz = (await history(page, 'ptz')).at(-1);
    expect(ptz?.state).toBe('stopped');
    expect(ptz?.detail).toContain('binary not found');

    // Clean first boots: starting → running, no restart noise.
    for (const id of ['es9', 'vst']) {
      const states = (await history(page, id)).map((s) => s.state);
      expect(states).toEqual(['starting', 'running']);
    }
  } finally {
    await app.close();
  }
});

test('origin allowlist holds on the supervised helper sockets', async () => {
  const { app, page, es9Port, vstPort } = await launchShell();
  try {
    await waitForState(page, 'es9', 'running');
    await waitForState(page, 'vst', 'running');

    // Disallowed Origin → the 403 arm (ws surfaces it as 'Unexpected server
    // response: 403').
    for (const port of [es9Port, vstPort]) {
      await expect(connect(port, 'https://evil.example')).rejects.toThrow(/403/);
    }

    // Loopback origin → full protocol reply.
    const es9 = await connect(es9Port, 'http://localhost:5173');
    es9.send({ type: 'hello', rate: 48000, name: 'spec' });
    const info = await es9.next((m) => m.type === 'deviceInfo');
    expect(info.inputChannels).toBe(16);
    es9.close();

    // Production origin → allowed on the vst socket too.
    const vst = await connect(vstPort, 'https://patchtogether.live');
    vst.send({ type: 'hello', rate: 48000, clientId: 'spec-origin' });
    await vst.next((m) => m.type === 'helperInfo');
    vst.close();
  } finally {
    await app.close();
  }
});

test('es9: SIGKILL → supervised backoff restart → reattach; busy/takeover; grace takeover', async () => {
  const { app, page, es9Port } = await launchShell();
  try {
    await waitForState(page, 'es9', 'running');

    // Live subscription BEFORE the kill — proves the push channel carries the
    // recovery sequence (get() history is the completeness backstop).
    await page.evaluate(() => {
      window.__helperEvents = [];
      const w = window as unknown as {
        ptNative: { helperStatus: { subscribe: (cb: (s: HelperStatusLike) => void) => void } };
      };
      w.ptNative.helperStatus.subscribe((s) => window.__helperEvents!.push(s));
    });

    // Client attaches.
    const a = await connect(es9Port);
    a.send({ type: 'hello', rate: 48000, name: 'client-a' });
    await a.next((m) => m.type === 'deviceInfo');

    // SIGKILL the stub out from under supervisor AND client.
    const pid = await pidOf(page, 'es9');
    process.kill(pid, 'SIGKILL');
    await a.closed; // the client observably lost its bridge

    // Supervised recovery, seen LIVE: restarting (with a real backoff delay)
    // then running again.
    await page.waitForFunction(
      () => {
        const ev = window.__helperEvents ?? [];
        const ri = ev.findIndex((s) => s.id === 'es9' && s.state === 'restarting');
        return ri >= 0 && ev.slice(ri).some((s) => s.id === 'es9' && s.state === 'running');
      },
      undefined,
      { timeout: 30_000 },
    );
    const events = await page.evaluate(() => window.__helperEvents ?? []);
    const restarting = events.find((s) => s.id === 'es9' && s.state === 'restarting');
    expect(restarting?.attempt).toBe(1);
    expect(restarting?.delayMs ?? 0).toBeGreaterThan(0);
    expect((await pidOf(page, 'es9'))).not.toBe(pid);

    // Reattach: the restarted bridge's slot is free.
    const a2 = await connect(es9Port);
    a2.send({ type: 'hello', rate: 48000, name: 'client-a2' });
    await a2.next((m) => m.type === 'deviceInfo');

    // busy → takeover: a second client is offered the action and the claim
    // evicts the incumbent with status 'stopped'.
    const b = await connect(es9Port);
    b.send({ type: 'hello', rate: 48000, name: 'client-b' });
    const busy = await b.next((m) => m.type === 'status' && m.state === 'busy');
    expect(String(busy.detail)).toContain('takeover');
    b.send({ type: 'takeover' });
    b.send({ type: 'hello', rate: 48000, name: 'client-b' });
    await b.next((m) => m.type === 'deviceInfo');
    await a2.next((m) => m.type === 'status' && m.state === 'stopped');

    // GRACE takeover: b goes silent; once its idle passes the stub's 400 ms
    // staleAfter, a plain hello claims the slot with NO takeover message.
    // expect.poll = bounded observable-state retry (each probe is one hello;
    // busy probes never refresh the incumbent's clock).
    await expect
      .poll(() => helloProbe(es9Port), { timeout: 15_000 })
      .toBe('deviceInfo');
    await b.next((m) => m.type === 'status' && m.state === 'stopped');
    b.close();
    a2.close();
  } finally {
    await app.close();
  }
});

test('vst: clientId park/adopt replays mounted; live-socket eviction; SIGKILL restart is a fresh bridge', async () => {
  const { app, page, vstPort } = await launchShell();
  try {
    await waitForState(page, 'vst', 'running');

    // Mount through a clientId session.
    const c1 = await connect(vstPort);
    c1.send({ type: 'hello', rate: 48000, clientId: 'spec-node-1' });
    await c1.next((m) => m.type === 'helperInfo');
    await c1.next((m) => m.type === 'pluginList');
    c1.send({ type: 'mount', pluginId: 'stub:sine' });
    await c1.next((m) => m.type === 'mounted');

    // Drop the socket → park; reconnect with the SAME clientId → the bridge
    // replays `mounted` unprompted (the reconnect contract).
    c1.close();
    await c1.closed;
    const c2 = await connect(vstPort);
    c2.send({ type: 'hello', rate: 48000, clientId: 'spec-node-1' });
    await c2.next((m) => m.type === 'helperInfo');
    const replayed = await c2.next((m) => m.type === 'mounted');
    expect((replayed.plugin as { id: string }).id).toBe('stub:sine');

    // Live-socket eviction: a new hello with the held clientId evicts c2.
    const c3 = await connect(vstPort);
    c3.send({ type: 'hello', rate: 48000, clientId: 'spec-node-1' });
    await c3.next((m) => m.type === 'mounted'); // adopted, state intact
    await c2.next((m) => m.type === 'status' && m.state === 'stopped');

    // SIGKILL → supervised restart → the NEW bridge accepts a fresh hello and
    // has nothing parked: park state is per-bridge-lifetime, by design.
    const pid = await pidOf(page, 'vst');
    process.kill(pid, 'SIGKILL');
    await c3.closed;
    // 'restarting' can flash by between status polls, so the wait is
    // "running again under a NEW pid"; the history (which misses nothing)
    // carries the restarting proof.
    await expect
      .poll(
        () =>
          page.evaluate(async (oldPid) => {
            const w = window as unknown as {
              ptNative: { helperStatus: { get: () => Promise<{ current: HelperStatusLike[] }> } };
            };
            const vst = (await w.ptNative.helperStatus.get()).current.find((s) => s.id === 'vst');
            return vst?.state === 'running' && vst.pid !== null && vst.pid !== oldPid;
          }, pid),
        { timeout: 30_000 },
      )
      .toBe(true);
    const states = (await history(page, 'vst')).map((s) => s.state);
    expect(states).toContain('restarting');

    const c4 = await connect(vstPort);
    c4.send({ type: 'hello', rate: 48000, clientId: 'spec-node-1' });
    await c4.next((m) => m.type === 'helperInfo');
    await c4.next((m) => m.type === 'pluginList');
    // FIFO ordering makes this sleep-free: a replayed `mounted` is sent
    // before any later reply, so after a ping→pong round trip its absence
    // from the unconsumed queue is a real absence.
    c4.send({ type: 'ping', t: 1 });
    await c4.next((m) => m.type === 'pong');
    expect(c4.has((m) => m.type === 'mounted')).toBe(false);
    c4.close();
  } finally {
    await app.close();
  }
});
