// Helper supervisor (P3) — one instance per native helper (es9-bridge,
// vst-bridge, pt-ptz), living in the Electron MAIN process.
//
// State machine (build-brief P3):
//   stopped → starting → running → restarting(backoff+jitter) → crash-looped
//
// Health = process alive AND hello accepted: after spawn, the supervisor
// dials the helper's WebSocket, sends a protocol hello, and waits for ANY
// control reply. Against the SINGLE-CLIENT es9 bridge a 'busy' status is a
// full health proof — the bridge answered protocol — and the probe never
// sends 'takeover', so an attached app client is never evicted. Against the
// vst bridge the probe is an anonymous hello (no clientId): its session dies
// with the probe socket, nothing parks. pt-ptz has no socket — its health
// tier in this slice is process-alive only (the CoreMIDI-port check is a
// later leg, macOS-only by nature).
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

export type HelperState = 'stopped' | 'starting' | 'running' | 'restarting' | 'crash-looped';

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
};

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
    });
    this.child = child;
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
      if (this.stopping) return;
      this.scheduleRestart(`exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    });

    void this.probeUntilHealthy(child);
  }

  private async probeUntilHealthy(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + this.spec.healthTimeoutMs;
    while (this.child === child && !this.stopping && Date.now() < deadline) {
      if (this.spec.port === null) {
        // No-socket helper (pt-ptz): alive is the whole health tier here.
        if (child.exitCode === null) this.markRunning(child);
        return;
      }
      const ok = await this.helloProbe(this.spec.port, this.spec.probeRate);
      if (this.child !== child || this.stopping) return;
      if (ok) {
        this.markRunning(child);
        return;
      }
      await delay(100);
    }
    if (this.child === child && !this.stopping) {
      // Alive but never answered hello inside the budget — recycle it.
      console.error(`[helper:${this.spec.id}] probe deadline (${this.spec.healthTimeoutMs}ms) — recycling pid ${child.pid}`);
      child.kill('SIGKILL');
    }
  }

  /** One hello round-trip. Resolves true on ANY control reply — deviceInfo /
   *  helperInfo (slot free) or status busy (slot held) both prove protocol. */
  private helloProbe(port: number, rate: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* already dead */
        }
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), 1_000);
      // No Origin header — the "non-browser local process" arm of the
      // bridges' default origin policy.
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', rate, name: 'shell-supervisor' })));
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        done(true);
      });
      ws.on('error', () => done(false));
      ws.on('close', () => done(false));
    });
  }

  private markRunning(child: ChildProcess): void {
    this.delayMs = null;
    this.transition('running', null);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      if (this.child === child && this.state === 'running') {
        this.attempt = 0;
        this.recentFailures = [];
      }
    }, this.spec.stableResetMs);
    this.stableTimer.unref();
  }

  private scheduleRestart(reason: string): void {
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
