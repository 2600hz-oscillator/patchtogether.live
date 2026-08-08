// packages/web/src/lib/audio/audio-health.svelte.ts
//
// THE READOUT — a Svelte 5 rune store that polls the three audio-health sensors
// and publishes them to the footer.
//
//   1. `playbackStats`      device-layer underruns (mode A)  → playback-stats.ts
//   2. scheduler tick stats main-thread starvation (mode D)  → tick-latency.ts
//   3. worklet latch ledger permanent processor death (B)    → worklet-guard.ts
//
// Those three are DIFFERENT DISEASES that produce the same user report. Mode C
// (context suspension) was already covered by `audio-gate.svelte.ts`'s
// `statechange` listener; this file adds the other three, which had no detector
// of any kind before this PR.
//
// ── Design notes that are load-bearing ──────────────────────────────────────
// * `poll()` IS PUBLIC. The 1 Hz timer is a convenience; the test drives
//   `poll()` directly so the permanent negative control needs no fake timers
//   and cannot flake. (`playbackStats` itself updates at about 1 Hz.)
// * The tick source is read through `peekSchedulerClock()`, which never
//   CONSTRUCTS the clock. A health readout that spawns the worker it is
//   measuring is not an observer.
// * `supported: false` is a first-class state, not an error. Firefox and Safari
//   have no `playbackStats`; they see "—" and are never nagged.
// * Nothing here is on the audio path. Reading a getter once a second is the
//   entire runtime cost.

import {
  snapshotAudioHealth,
  UNSUPPORTED_AUDIO_HEALTH,
  type AudioHealthSnapshot,
} from './playback-stats';
import { peekSchedulerClock } from './scheduler-clock';
import type { TickLatencyStats } from './tick-latency';
import {
  onWorkletError,
  workletErrorCount,
  workletErrorLog,
  type WorkletErrorRecord,
} from './worklet-guard';

/** How often the poller samples. `playbackStats` updates at roughly this rate. */
export const AUDIO_HEALTH_POLL_MS = 1000;

export interface AudioHealthMonitor {
  /** Device-layer underruns. `supported: false` on non-Chromium. */
  readonly health: AudioHealthSnapshot;
  /** Main-thread tick lateness, or null until some module starts the clock. */
  readonly tick: TickLatencyStats | null;
  /** Cumulative count of LATCHED worklet processors this session. */
  readonly workletErrors: number;
  /** The most recent latch, for the footer's attribution text. */
  readonly lastWorkletError: WorkletErrorRecord | null;
  /** Point the monitor at the live AudioContext (or null to detach). */
  bind(ctx: AudioContext | null): void;
  /** Sample every sensor once. Public so tests drive it without timers. */
  poll(): void;
  /** Begin/stop the 1 Hz poll. Idempotent. */
  start(): void;
  stop(): void;
}

export function createAudioHealthMonitor(opts?: {
  intervalMs?: number;
  /** Injectable for the unit lane; defaults to the live scheduler clock. */
  readTickStats?: () => TickLatencyStats | null;
}): AudioHealthMonitor {
  const intervalMs = opts?.intervalMs ?? AUDIO_HEALTH_POLL_MS;
  const readTickStats = opts?.readTickStats ?? (() => peekSchedulerClock()?.tickStats() ?? null);

  let health = $state<AudioHealthSnapshot>(UNSUPPORTED_AUDIO_HEALTH);
  let tick = $state<TickLatencyStats | null>(null);
  let workletErrors = $state(0);
  let lastWorkletError = $state<WorkletErrorRecord | null>(null);

  let ctx: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let offWorkletError: (() => void) | null = null;

  function poll(): void {
    health = ctx ? snapshotAudioHealth(ctx) : UNSUPPORTED_AUDIO_HEALTH;
    tick = readTickStats();
    // Re-read rather than relying only on the subscription: a latch that fired
    // BEFORE this monitor was constructed (module boot races the footer mount)
    // must still be counted. "Missed the event" and "no error" would otherwise
    // be indistinguishable — the exact confusion this PR exists to remove.
    const count = workletErrorCount();
    if (count !== workletErrors) {
      workletErrors = count;
      const log = workletErrorLog();
      lastWorkletError = log.length ? log[log.length - 1]! : null;
    }
  }

  return {
    get health() {
      return health;
    },
    get tick() {
      return tick;
    },
    get workletErrors() {
      return workletErrors;
    },
    get lastWorkletError() {
      return lastWorkletError;
    },
    bind(c: AudioContext | null) {
      ctx = c;
      poll();
    },
    poll,
    start() {
      if (timer === null) timer = setInterval(poll, intervalMs);
      if (!offWorkletError) {
        // Immediate, so a latch surfaces within a frame rather than within a
        // second — a dead rack is not something to learn about lazily.
        offWorkletError = onWorkletError((rec) => {
          workletErrors = rec.seq;
          lastWorkletError = rec;
        });
      }
      poll();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      offWorkletError?.();
      offWorkletError = null;
    },
  };
}
