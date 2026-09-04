// Helper supervisor (P3) — one instance per native helper (es9-bridge,
// vst-bridge, pt-ptz), living in the Electron MAIN process.
//
// State machine (build-brief P3):
//   stopped → starting → running → restarting(backoff+jitter) → crash-looped
//                              ↘ foreign-listener (terminal)
//
// Health = process alive AND hello accepted AND THE PORT IS OURS.
//
// ⚠ That third clause is the one this file used to be missing, and its absence
// was not theoretical. The probe resolved true on ANY non-binary frame, and the
// child pid and the responder on the port were two facts never correlated — so
// a stale orphan from a previous launch (an OLDER BUILD, even) or any local
// process that answers anything at all made the supervisor report `running`
// for a child that had ALREADY EXITED. Measured, against the real class: a
// foreign server replying with the literal string "go away" produced
// `STATUS running pid=40174` while that pid was dead. The renderer meanwhile
// talks to the foreign listener, and P5's pre-flight row — whose entire value
// is being trustworthy before a set — paints green.
//
// The fix is ownership, in three layers, cheapest first:
//   1. the reply must PARSE as a JSON object with a known protocol `type`
//      (deviceInfo | helperInfo | status | pluginList) — kills "go away";
//   2. `protocolVersion`, which every tier already emits and NOBODY read, must
//      match when present — kills the older-build orphan;
//   3. the process LISTENING on the port must be our own child pid — kills
//      everything else, including a hostile local process that speaks perfect
//      protocol.
// Plus a per-launch nonce (see LAUNCH_ID_ENV) for the tier that echoes it.
//
// ⚠ NEVER KILL AN UNKNOWN LISTENER. This class only ever signals `this.child`,
// a handle it spawned itself (stop(), and the probe-deadline recycle). A port
// we do not own is reported, never reaped: killing by port would let a
// mis-detection take out the user's DAW. `foreign-listener` is therefore a
// TERMINAL state with the holder named in `detail`, not a restart loop.
//
// Against the SINGLE-CLIENT es9 bridge a 'busy' status is still a full health
// proof — the bridge answered protocol — and the probe never sends 'takeover',
// so an attached app client is never evicted. Against the vst bridge the probe
// is an anonymous hello (no clientId): its session dies with the probe socket,
// nothing parks. pt-ptz has no socket — its health tier in this slice is
// process-alive only (the CoreMIDI-port check is a later leg, macOS-only by
// nature).
//
// What this deliberately does NOT see: a helper that is alive and accepting
// TCP but wedged mid-render. The app's own client sees that first; the
// supervisor's job is process lifecycle, not stream quality.
//
// Crash-loop → a RED STATUS ROW via the status feed (ptNative.helperStatus).
// NEVER a modal — no modals while presenting.

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import WebSocket from 'ws';

export type HelperState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'restarting'
  | 'crash-looped'
  /** Something answered on this helper's port that we did not spawn. Terminal:
   *  reported with the holding pid/command, never killed, never restarted into
   *  a port we cannot have. */
  | 'foreign-listener';

/** Control-plane protocol the shell speaks. Helpers already put this on the
 *  wire (es9 + vst, stubs and real bridges alike); until this change nothing
 *  read it back. */
export const SUPPORTED_PROTOCOL_VERSION = 1;

/** Per-launch nonce, handed to every child in its environment.
 *
 *  A helper that echoes it back in its hello reply proves it belongs to THIS
 *  launch — the one thing "alive + hello" can never establish, since a stale
 *  orphan from the previous launch answers identically. The Node stubs echo it
 *  today; the Swift bridges do not yet (that is a wire change in two other
 *  repos, sequenced with P1's device-slot protocol work), so an ABSENT echo is
 *  the expected real-tier case and falls through to the pid check, which needs
 *  no helper cooperation at all. A WRONG echo is always fatal. */
export const LAUNCH_ID_ENV = 'PT_SHELL_LAUNCH_ID';

/** Reply types that prove control protocol, per BridgeProtocol.swift. */
const PROTOCOL_REPLY_TYPES = new Set(['deviceInfo', 'helperInfo', 'status', 'pluginList']);

type ProbeOutcome =
  | { kind: 'ok' }
  /** No usable reply — keep trying until the deadline. */
  | { kind: 'silent' }
  /** Someone answered, but it is provably not our helper. */
  | { kind: 'foreign'; why: string };

export interface HelperStatus {
  id: string;
  state: HelperState;
  pid: number | null;
  port: number | null;
  /** Restart attempt counter since the last stable run (0 when healthy). */
  attempt: number;
  /** Backoff delay chosen for the CURRENT restarting transition (ms). */
  delayMs: number | null;
  detail: string | null;
  ts: number;
}

export interface HelperSpec {
  id: string;
  /** Absolute binary path, or null = unavailable (stays 'stopped' with detail). */
  binary: string | null;
  args: string[];
  /** WebSocket port for the hello health probe; null = process-alive only. */
  port: number | null;
  /** hello.rate the probe sends (the probe is a client per protocol v1). */
  probeRate?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** 0..1 multiplier range added on top of the exponential delay. */
  jitter?: number;
  /** This many restarts inside crashLoopWindowMs ⇒ 'crash-looped'. */
  crashLoopThreshold?: number;
  crashLoopWindowMs?: number;
  /** Give up the health probe (and restart) after this long in 'starting'. */
  healthTimeoutMs?: number;
  /** A run healthy for this long resets the attempt counter. */
  stableResetMs?: number;
  /** Per-launch nonce (see LAUNCH_ID_ENV). Empty = no nonce leg. */
  launchId?: string;
}

const DEFAULTS = {
  probeRate: 48000,
  backoffBaseMs: 300,
  backoffMaxMs: 10_000,
  jitter: 0.3,
  crashLoopThreshold: 5,
  crashLoopWindowMs: 30_000,
  healthTimeoutMs: 10_000,
  stableResetMs: 10_000,
  launchId: '',
};

/** Run a diagnostic command and collect stdout. ASYNC on purpose: this runs in
 *  the Electron MAIN process of a live instrument, and `lsof` measures ~45 ms
 *  per call on this machine — a spawnSync there is a main-thread stall during
 *  exactly the moment (a helper dying mid-set) when the shell most needs to
 *  stay responsive. Resolves null when the command cannot answer. */
function runDiagnostic(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    let settled = false;
    const done = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL'); // our own diagnostic child, never a listener
      done(null);
    }, 2_000);
    timer.unref();
    child.stdout?.on('data', (d: Buffer) => (out += String(d)));
    child.once('error', () => done(null));
    // `lsof` exits 1 with empty output when nothing matches — a normal answer,
    // not a failure. A missing binary arrives on 'error' above instead.
    child.once('close', () => done(out));
  });
}

/**
 * Which process is LISTENING on a loopback TCP port.
 *
 * `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fp` is already this program's idiom for
 * exactly this question — vst-bridge's own port-holder diagnostic uses it — so
 * the shell asks the same way. Resolves null when the question cannot be
 * answered (no lsof, or a platform without it): "unknown" is reported as
 * unknown, never silently upgraded to "ours".
 */
export async function listeningPids(port: number): Promise<number[] | null> {
  if (process.platform === 'win32') return null; // netstat parsing is a P7 item
  const out = await runDiagnostic('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
  if (out === null) return null;
  return out
    .split('\n')
    .filter((l) => l.startsWith('p'))
    .map((l) => Number(l.slice(1)))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Message-level verdict on one probe reply: is this OUR helper speaking?
 *
 * Exported and pure so the harness can drive every arm directly. Staging each
 * of these over a real socket means building a fake helper per arm; the arms
 * that matter most (a stale build's protocol version, another launch's nonce)
 * are the hardest to stage and therefore the ones a socket-only test quietly
 * never covers.
 *
 * The pid check is NOT here: it is impure by nature and lives on the class.
 */
export function judgeProtocolReply(
  raw: string,
  opts: { port: number; launchId?: string },
): { ok: true } | { ok: false; why: string } {
  const { port } = opts;
  let msg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, why: `port ${port} answered non-protocol JSON` };
    }
    msg = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, why: `port ${port} answered a non-JSON frame` };
  }

  const type = msg.type;
  if (typeof type !== 'string' || !PROTOCOL_REPLY_TYPES.has(type)) {
    return { ok: false, why: `port ${port} answered unknown message type '${String(type)}'` };
  }

  // Emitted by every tier since protocol v1; simply never consumed before.
  const version = msg.protocolVersion;
  if (version !== undefined && version !== SUPPORTED_PROTOCOL_VERSION) {
    return {
      ok: false,
      why: `port ${port} speaks protocol v${String(version)}, shell speaks v${SUPPORTED_PROTOCOL_VERSION} (a stale build?)`,
    };
  }

  // Nonce: absent is fine (the Swift bridges do not echo it yet), wrong never is.
  const echoed = msg.shellLaunchId;
  if (opts.launchId && echoed !== undefined && echoed !== opts.launchId) {
    return { ok: false, why: `port ${port} belongs to a different shell launch` };
  }

  return { ok: true };
}

/** Human-readable identification of a foreign port holder, for the status row.
 *  Diagnosis only — nothing here signals anything. */
async function describePid(pid: number): Promise<string> {
  const out = await runDiagnostic('ps', ['-p', String(pid), '-o', 'comm=']);
  const name = (out ?? '').trim();
  return name ? `${name} (pid ${pid})` : `pid ${pid}`;
}

async function describePids(pids: number[]): Promise<string> {
  return (await Promise.all(pids.map(describePid))).join(', ');
}

export type StatusListener = (status: HelperStatus) => void;

export class HelperSupervisor {
  private readonly spec: Required<Omit<HelperSpec, 'binary' | 'port'>> & {
    binary: string | null;
    port: number | null;
  };
  private child: ChildProcess | null = null;
  private state: HelperState = 'stopped';
  private attempt = 0;
  private delayMs: number | null = null;
  private detail: string | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private recentFailures: number[] = [];
  private stopping = false;
  /** Terminal: no further spawns, whatever exits arrive afterwards. Set on
   *  'foreign-listener' — without it the SIGKILL of our own useless child
   *  would fire the exit handler and restart straight back into a port we have
   *  just proven belongs to someone else. */
  private terminal = false;
  /** Every pid this supervisor has ever spawned. A port held by one of these
   *  is OURS (a child on its way out during a restart), not a foreign
   *  listener — the distinction the whole ownership check turns on. */
  private readonly ownPids = new Set<number>();
  private readonly listeners = new Set<StatusListener>();
  /** Bounded transition history — the harness reads the full sequence. */
  readonly history: HelperStatus[] = [];

  constructor(spec: HelperSpec) {
    this.spec = { ...DEFAULTS, ...spec, binary: spec.binary, port: spec.port ?? null };
  }

  get id(): string {
    return this.spec.id;
  }

  status(): HelperStatus {
    return {
      id: this.spec.id,
      state: this.state,
      pid: this.child?.pid ?? null,
      port: this.spec.port,
      attempt: this.attempt,
      delayMs: this.delayMs,
      detail: this.detail,
      ts: Date.now(),
    };
  }

  onStatus(cb: StatusListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  start(): void {
    this.stopping = false;
    this.terminal = false;
    if (!this.spec.binary || !fs.existsSync(this.spec.binary)) {
      this.transition('stopped', `binary not found: ${this.spec.binary ?? '(unset)'}`);
      return;
    }
    this.spawnOnce();
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.restartTimer = null;
    this.stableTimer = null;
    const child = this.child;
    if (child && child.pid) {
      child.kill('SIGTERM');
      // Escalate if it lingers — a dead shell must not orphan helpers.
      setTimeout(() => {
        if (this.child === child && child.exitCode === null) child.kill('SIGKILL');
      }, 2_000).unref();
    }
    this.transition('stopped', 'stopped by shell');
  }

  private transition(state: HelperState, detail: string | null, delayMs: number | null = null): void {
    if (state === 'foreign-listener') this.terminal = true;
    this.state = state;
    this.detail = detail;
    this.delayMs = delayMs;
    const snap = this.status();
    this.history.push(snap);
    if (this.history.length > 200) this.history.shift();
    for (const cb of this.listeners) cb(snap);
  }

  private spawnOnce(): void {
    if (this.stopping) return;
    this.transition('starting', null);
    // stdio piped so a supervisor death closes the helper's stdin — the
    // stubs treat that as "shell is gone, exit" (orphan guard on every tier).
    const child = spawn(this.spec.binary as string, this.spec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Per-launch nonce: a helper that echoes it proves it is OURS, not an
      // orphan of the previous launch holding the same port.
      env: this.spec.launchId
        ? { ...process.env, [LAUNCH_ID_ENV]: this.spec.launchId }
        : process.env,
    });
    this.child = child;
    if (child.pid !== undefined) this.ownPids.add(child.pid);
    // Helper output belongs in the shell's log — a silent helper failure is
    // undiagnosable from a status row alone.
    child.stdout?.on('data', (d: Buffer) => console.log(`[helper:${this.spec.id}] ${String(d).trimEnd()}`));
    child.stderr?.on('data', (d: Buffer) => console.error(`[helper:${this.spec.id}] ${String(d).trimEnd()}`));

    child.once('error', (err) => {
      if (this.child !== child) return;
      this.child = null;
      this.scheduleRestart(`spawn failed: ${err.message}`);
    });
    child.once('exit', (code, signal) => {
      console.error(`[helper:${this.spec.id}] exit code=${code ?? 'null'} signal=${signal ?? 'null'} (pid ${child.pid})`);
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping || this.terminal) return;
      this.scheduleRestart(`exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    });

    void this.probeUntilHealthy(child);
  }

  private async probeUntilHealthy(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + this.spec.healthTimeoutMs;
    /** Last foreign verdict seen. Kept rather than acted on immediately: a
     *  reply can legitimately race our own child's bind (the previous launch's
     *  orphan is still closing, lsof lags a few ms), so a single foreign
     *  answer is not yet a verdict — an ENTIRE probe window of them is. */
    let foreign: string | null = null;

    while (this.child === child && !this.stopping && Date.now() < deadline) {
      if (this.spec.port === null) {
        // No-socket helper (pt-ptz): alive is the whole health tier here.
        if (child.exitCode === null) this.markRunning(child, null);
        return;
      }
      const outcome = await this.helloProbe(this.spec.port, this.spec.probeRate, child);
      if (this.child !== child || this.stopping) return;
      if (outcome.kind === 'ok') {
        const note = await this.ownershipNote(this.spec.port);
        if (this.child !== child || this.stopping) return;
        this.markRunning(child, note);
        return;
      }
      foreign = outcome.kind === 'foreign' ? outcome.why : null;
      await delay(100);
    }
    if (this.child !== child || this.stopping) return;

    if (foreign) {
      // TERMINAL, and deliberately not a restart: every restart would spawn a
      // child that dies on a port it cannot bind, and every probe would green
      // against someone else's process. ⚠ The foreign listener is NAMED here
      // and left completely alone.
      console.error(`[helper:${this.spec.id}] ${foreign} — refusing to adopt it`);
      child.kill('SIGKILL'); // ours, and useless on a port it will never get
      this.transition('foreign-listener', foreign);
      return;
    }
    // Alive but never answered hello inside the budget — recycle it.
    console.error(
      `[helper:${this.spec.id}] probe deadline (${this.spec.healthTimeoutMs}ms) — recycling pid ${child.pid}`,
    );
    child.kill('SIGKILL');
  }

  /**
   * One hello round-trip, then the ownership questions.
   *
   * 'ok' means: a parseable control reply of a known type, a protocol version
   * we speak, a launch nonce that matches (when the tier echoes one), and a
   * listening socket held by OUR child. Anything provably not ours comes back
   * 'foreign' with the reason; everything else is 'silent' and simply retried.
   */
  private helloProbe(port: number, rate: number, child: ChildProcess): Promise<ProbeOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (outcome: ProbeOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* already dead */
        }
        resolve(outcome);
      };
      const timer = setTimeout(() => done({ kind: 'silent' }), 1_000);
      // No Origin header — the "non-browser local process" arm of the
      // bridges' default origin policy.
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', rate, name: 'shell-supervisor' })));
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        // The ownership half is async (an out-of-process `lsof`). If it were
        // to outrun the 1 s probe timer the round trip simply reports 'silent'
        // and the loop tries again — never a false 'ok'.
        void this.judgeReply(String(data), port, child).then(done);
      });
      ws.on('error', () => done({ kind: 'silent' }));
      ws.on('close', () => done({ kind: 'silent' }));
    });
  }

  private async judgeReply(raw: string, port: number, child: ChildProcess): Promise<ProbeOutcome> {
    const verdict = judgeProtocolReply(raw, { port, launchId: this.spec.launchId });
    if (!verdict.ok) return { kind: 'foreign', why: verdict.why };

    // The load-bearing check, and the only one that needs no helper cooperation.
    const pids = await listeningPids(port);
    if (pids === null) return { kind: 'ok' }; // unverifiable; noted on the status row
    if (child.pid !== undefined && pids.includes(child.pid)) return { kind: 'ok' };
    if (pids.length === 0) {
      // Answered, yet nothing is listening now: a race, not a verdict.
      return { kind: 'silent' };
    }
    return {
      kind: 'foreign',
      why: `port ${port} is held by ${await describePids(pids)}, not by our child (pid ${String(child.pid)})`,
    };
  }

  /** Is this helper's port held by a process we never spawned? Resolves the
   *  status-row detail naming the holder, or null (free port, our own pid, or
   *  a platform where the question cannot be answered). NOTHING is signalled
   *  here — a foreign holder is reported, never reaped. */
  private async foreignHolder(): Promise<string | null> {
    const port = this.spec.port;
    if (port === null) return null;
    const pids = await listeningPids(port);
    if (pids === null || pids.length === 0) return null;
    if (pids.some((p) => this.ownPids.has(p))) return null;
    return `port ${port} is held by ${await describePids(pids)}, not by our child`;
  }

  /** Detail line for a `running` row: silence when ownership was proven,
   *  an explicit caveat when it could not be. A status row that cannot say
   *  what it does not know is the instrument this whole change is about. */
  private async ownershipNote(port: number): Promise<string | null> {
    return (await listeningPids(port)) === null
      ? 'port ownership unverified (no lsof on this platform)'
      : null;
  }

  private markRunning(child: ChildProcess, detail: string | null): void {
    // A child that has already exited is never `running`, whatever answered on
    // the port. This is the exact shape of the measured false green.
    if (child.exitCode !== null || child.signalCode !== null) return;
    this.delayMs = null;
    this.transition('running', detail);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      if (this.child === child && this.state === 'running') {
        this.attempt = 0;
        this.recentFailures = [];
      }
    }, this.spec.stableResetMs);
    this.stableTimer.unref();
  }

  /**
   * ⚠ Ask WHY it keeps failing before restarting it.
   *
   * A child that dies on a busy port (real bridges: `portInUse` → exit(1))
   * restarts, dies, restarts — five times — and the row lands on
   * 'crash-looped', which reads as "the helper is broken" when the truth is
   * "someone else has the port". That misdiagnosis is what the pre-flight row
   * would show a performer. The check runs BEFORE the backoff because the exit
   * is faster than any probe window: whoever holds the port is either one of
   * OUR pids (a child on its way out — restart, that is normal) or nobody's
   * business but its own.
   */
  private scheduleRestart(reason: string): void {
    if (this.terminal || this.stopping) return;
    void this.foreignHolder().then((foreign) => {
      if (this.terminal || this.stopping) return;
      if (foreign) {
        console.error(`[helper:${this.spec.id}] ${foreign} — refusing to adopt it`);
        this.transition('foreign-listener', foreign);
        return;
      }
      this.backOffAndRestart(reason);
    });
  }

  private backOffAndRestart(reason: string): void {
    if (this.terminal || this.stopping) return;
    const now = Date.now();
    this.recentFailures = this.recentFailures.filter((t) => now - t < this.spec.crashLoopWindowMs);
    this.recentFailures.push(now);
    if (this.recentFailures.length >= this.spec.crashLoopThreshold) {
      // Red status row territory. The feed carries it; nothing modal ever.
      this.transition('crash-looped', reason);
      return;
    }
    this.attempt += 1;
    const base = Math.min(
      this.spec.backoffBaseMs * 2 ** (this.attempt - 1),
      this.spec.backoffMaxMs,
    );
    const withJitter = Math.round(base * (1 + this.spec.jitter * Math.random()));
    this.transition('restarting', reason, withJitter);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnOnce();
    }, withJitter);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
