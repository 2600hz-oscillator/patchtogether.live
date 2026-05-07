// packages/server/src/heartbeat.ts
//
// Hocuspocus extension that emits a per-document heartbeat over Yjs
// Awareness. Each tick carries `{ tick: int, ts_ms: float }` keyed under
// the reserved field `__heartbeat`. Clients use these to derive a shared
// clock (offset + RTT) per .myrobots/plans/shared-state-sync.md §3.
//
// Cadence: 1 Hz steady-state, 8 Hz burst for the first BURST_DURATION_MS
// after any client connects. Burst gives newly-arrived clients a stable
// offset estimate inside ~1s without paying for that bandwidth at idle.

import type { Extension } from '@hocuspocus/server';

// Minimal structural type for the bits of the Hocuspocus Document we use.
// Importing the deep `Document.js` path resolves only to a .d.ts (the
// compiled JS is bundled into hocuspocus-server.cjs/esm) and trips
// nodenext + verbatimModuleSyntax. Local interface keeps the surface
// area honest and the runtime cast obvious.
//
// We use setLocalState (not setLocalStateField) because the y-protocols
// Awareness's setLocalStateField is a silent no-op when getLocalState()
// is null — and Hocuspocus's Document constructor explicitly calls
// `awareness.setLocalState(null)` at boot, which puts us in exactly that
// state. setLocalState always emits an `update` event, which is what the
// connected providers' awareness instances listen for to receive the
// per-document heartbeat.
interface DocumentLike {
  awareness: {
    getLocalState(): Record<string, unknown> | null;
    setLocalState(state: Record<string, unknown> | null): void;
  };
}

const STEADY_INTERVAL_MS = 1000;
const BURST_INTERVAL_MS = 125; // 8 Hz
const BURST_DURATION_MS = 3000;
const HEARTBEAT_FIELD = '__heartbeat';

interface DocState {
  /** Monotonic tick counter, ascending across the doc's lifetime. */
  tick: number;
  /** Last-observed connection arrival time (epoch ms). Used to decide
   *  whether burst rate is in effect. */
  newestConnectionAt: number;
  /** Number of currently-connected clients. The setInterval keeps running
   *  while > 0; flips off (and the timer is cleared) when the last client
   *  disconnects so an idle doc costs zero. */
  clientCount: number;
  /** The active timer; switches between burst and steady cadence. */
  timer: ReturnType<typeof setInterval> | null;
  /** Mode of `timer` so we know when to swap. */
  mode: 'burst' | 'steady' | 'off';
}

/** Pluggable clock + timer functions for tests; defaults are wall-clock. */
export interface HeartbeatDeps {
  now(): number;
  setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(t: ReturnType<typeof setInterval>): void;
}

const realDeps: HeartbeatDeps = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (t) => clearInterval(t),
};

export interface HeartbeatExtension extends Extension {
  /** Test-only: snapshot the current per-doc state. */
  _state(documentName: string): DocState | undefined;
  /** Test-only: force a tick emission for `documentName`. */
  _tick(documentName: string): void;
}

/**
 * Build the Hocuspocus extension.
 *
 * Implementation note: the server writes to the document's awareness with
 * its own Yjs `clientID` (the Awareness instance auto-assigns one when
 * the Doc is constructed). Clients see this as just another peer with a
 * special `__heartbeat` field — no protocol changes, no new wire types.
 */
export function createHeartbeatExtension(
  depsOverride: Partial<HeartbeatDeps> = {},
): HeartbeatExtension {
  const deps: HeartbeatDeps = { ...realDeps, ...depsOverride };
  // documentName → DocState. Cleared on document unload.
  const docs = new Map<string, DocState>();
  // documentName → live Document reference (for emitting awareness updates).
  // We only hold these while at least one client is connected; on unload
  // the entry is dropped.
  const liveDocs = new Map<string, DocumentLike>();

  function emit(documentName: string): void {
    const doc = liveDocs.get(documentName);
    const state = docs.get(documentName);
    if (!doc || !state) return;
    state.tick += 1;
    const payload = {
      tick: state.tick,
      ts_ms: deps.now(),
    };
    // Write to the document's awareness using the server's auto-assigned
    // clientID. We MUST call setLocalState (not setLocalStateField) because
    // Hocuspocus's Document constructor seeds the awareness with
    // setLocalState(null), which makes setLocalStateField a no-op forever
    // (y-protocols/awareness.js bails when getLocalState() === null).
    // We merge the heartbeat into whatever state is currently there so any
    // future server-side awareness fields (none today) survive.
    try {
      const existing = doc.awareness.getLocalState() ?? {};
      doc.awareness.setLocalState({ ...existing, [HEARTBEAT_FIELD]: payload });
    } catch {
      // Document might be mid-destroy; ignore. The next interval tick
      // will see liveDocs without the entry and bail.
    }
  }

  function selectMode(state: DocState): 'burst' | 'steady' | 'off' {
    if (state.clientCount === 0) return 'off';
    const age = deps.now() - state.newestConnectionAt;
    return age < BURST_DURATION_MS ? 'burst' : 'steady';
  }

  function reschedule(documentName: string): void {
    const state = docs.get(documentName);
    if (!state) return;
    const desired = selectMode(state);
    if (desired === state.mode && state.timer !== null) return;
    if (state.timer !== null) {
      deps.clearInterval(state.timer);
      state.timer = null;
    }
    state.mode = desired;
    if (desired === 'off') return;
    const intervalMs = desired === 'burst' ? BURST_INTERVAL_MS : STEADY_INTERVAL_MS;
    state.timer = deps.setInterval(() => {
      emit(documentName);
      // Self-correct mode transitions (burst → steady when no recent join).
      const current = docs.get(documentName);
      if (current && selectMode(current) !== current.mode) {
        reschedule(documentName);
      }
    }, intervalMs);
  }

  function ensureState(documentName: string): DocState {
    let state = docs.get(documentName);
    if (!state) {
      state = {
        tick: 0,
        newestConnectionAt: 0,
        clientCount: 0,
        timer: null,
        mode: 'off',
      };
      docs.set(documentName, state);
    }
    return state;
  }

  return {
    extensionName: 'heartbeat',

    async afterLoadDocument(payload) {
      // Hocuspocus instantiates a Document per name on first connect (or
      // first onLoadDocument). We track the reference here; the doc lives
      // until afterUnloadDocument, at which point we drop our reference.
      liveDocs.set(payload.documentName, payload.document as unknown as DocumentLike);
      ensureState(payload.documentName);
    },

    async connected(payload) {
      const state = ensureState(payload.documentName);
      state.clientCount += 1;
      state.newestConnectionAt = deps.now();
      // Emit one tick immediately so the joining client gets an offset
      // sample without waiting for the next interval (~125ms-1000ms).
      emit(payload.documentName);
      reschedule(payload.documentName);
    },

    async onDisconnect(payload) {
      const state = docs.get(payload.documentName);
      if (!state) return;
      state.clientCount = Math.max(0, state.clientCount - 1);
      reschedule(payload.documentName);
    },

    async afterUnloadDocument(payload) {
      const state = docs.get(payload.documentName);
      if (state?.timer !== undefined && state?.timer !== null) {
        deps.clearInterval(state.timer);
      }
      docs.delete(payload.documentName);
      liveDocs.delete(payload.documentName);
    },

    _state(documentName) {
      return docs.get(documentName);
    },
    _tick(documentName) {
      emit(documentName);
    },
  };
}

export const HEARTBEAT_AWARENESS_FIELD = HEARTBEAT_FIELD;
export const HEARTBEAT_BURST_DURATION_MS = BURST_DURATION_MS;
export const HEARTBEAT_BURST_INTERVAL_MS = BURST_INTERVAL_MS;
export const HEARTBEAT_STEADY_INTERVAL_MS = STEADY_INTERVAL_MS;
