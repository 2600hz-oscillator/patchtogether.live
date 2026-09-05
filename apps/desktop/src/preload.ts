// patchtogether native shell — preload (P2 surface + P3 helperStatus).
//
// The web app must NEVER import Electron; this bridge is the only seam. The
// browser/e2e "simulated double" mirrors this exact shape.
//
// Everything renderer→main goes through ONE versioned envelope
// (bridge-protocol.ts): {v,id,op,payload} → {v,id,ok,…}, with request ids,
// AbortSignal cancellation and structured errors. Later phases (P1 slot
// assign/unbind/retry, P4 output↔display map, P5 pre-flight + device/display
// pickers) add OPS, not new channels — so sender validation, versioning and
// the error vocabulary are written once, in main, and inherited.
//
// `command()` RESOLVES with the envelope ({ok:true,result} | {ok:false,error})
// instead of rejecting. Two reasons, both load-bearing: contextBridge does not
// carry custom properties on a thrown Error across the world boundary, so a
// rejection would arrive as a bare message and `error.code` would be lost; and
// the consumer this contract exists for is P5's pre-flight status row, whose
// failure mode is a RED ROW — an outcome to render, not an exception to catch.
//
// quit() is GONE. It was exposed here with zero consumers anywhere in the
// repo, in direct contradiction of the owner ruling recorded in main.ts's own
// header ("Quit lives in the native menu only; the web UI never grows a quit
// affordance"). Restricting it to the main frame would have preserved a
// privileged verb the product is not allowed to have; deleting it removes the
// only state-changing verb on the bridge outright.

import { contextBridge, ipcRenderer } from 'electron';
import type { PtEvent, PtResult } from './bridge-protocol';
import type { HelperStatus } from './supervisor';

// ⚠ The preload runs SANDBOXED (webPreferences.sandbox, pinned in
// security.ts). A sandboxed preload's `require` resolves only `electron`,
// `events`, `timers` and `url` — a relative `require('./bridge-protocol')`
// throws at load and takes the whole bridge with it. So the two runtime
// literals are duplicated here on purpose. They are NOT free to drift:
// bridge.ts carries a compile-time equality assertion against the canonical
// definitions, so a rename in one place reddens `task typecheck` in the other.
// Types above are `import type` and erase to nothing.
export const PT_PRELOAD_BRIDGE_VERSION = 1;
export const PT_PRELOAD_CHANNELS = {
  command: 'pt:command',
  cancel: 'pt:command-cancel',
  event: 'pt:event',
} as const;
const PT_BRIDGE_VERSION = PT_PRELOAD_BRIDGE_VERSION;
const PT_BRIDGE_CHANNELS = PT_PRELOAD_CHANNELS;

export interface HelperStatusSnapshot {
  current: HelperStatus[];
  /** Bounded per-helper transition history — late subscribers (the pre-flight
   *  UI booting after the supervisors, or the harness) miss nothing. */
  history: HelperStatus[];
}

export interface PtCommandOptions {
  /**
   * Caller-chosen correlation id, so the call can be cancelled by name.
   *
   * ⚠ This is deliberately NOT an AbortSignal. contextBridge CLONES arguments
   * across the world boundary, and a cloned AbortSignal arrives in the preload
   * as a plain object with no addEventListener — cancellation would look wired
   * up and silently never fire. (Measured: `signal?.addEventListener is not a
   * function`.) Functions and strings cross intact, so the seam is an id plus
   * `cancel(id)`, and AbortSignal adaptation is two lines in the RENDERER,
   * where signals are real:
   *
   *     const id = crypto.randomUUID();
   *     signal.addEventListener('abort', () => ptNative.cancel(id));
   *     const res = await ptNative.command(op, payload, { requestId: id });
   *
   * Omit it and the bridge allocates one; the id always comes back on the
   * result envelope either way.
   */
  requestId?: string;
}

export interface PtNative {
  nativeAvailable: () => boolean;
  shellVersion: () => string;
  /** Envelope version — a renderer built against a different shell can say so
   *  instead of failing in op-shaped pieces. */
  bridgeVersion: () => number;
  onLoadPatchRequested: (cb: (filePath: string) => void) => void;
  /** Generic command seam. Phases add ops; this signature does not change. */
  command: <R = unknown>(
    op: string,
    payload?: unknown,
    opts?: PtCommandOptions,
  ) => Promise<PtResult<R>>;
  /** Cancel an in-flight command by its request id. Idempotent, and harmless
   *  for an id that already finished or never existed. */
  cancel: (requestId: string) => void;
  /** Unsolicited main→renderer events, in the same envelope. Returns an
   *  unsubscribe. */
  onEvent: (topic: string, cb: (payload: unknown) => void) => () => void;
  helperStatus: {
    /** Convenience wrapper over `command('helpers.status')`. Throws on a
     *  failed envelope: a shell that cannot report its own helpers is a bug,
     *  not a status the pre-flight row is supposed to paint. */
    get: () => Promise<HelperStatusSnapshot>;
    /** Live status pushes. Returns an unsubscribe. Crash-loop arrives here as
     *  state 'crash-looped' — a RED STATUS ROW, never a modal. */
    subscribe: (cb: (status: HelperStatus) => void) => () => void;
  };
}

let nextId = 0;
function newId(): string {
  nextId += 1;
  return `c${nextId}`;
}

function cancel(requestId: string): void {
  if (typeof requestId !== 'string' || requestId.length === 0) return;
  ipcRenderer.send(PT_BRIDGE_CHANNELS.cancel, { v: PT_BRIDGE_VERSION, id: requestId });
}

async function command<R>(
  op: string,
  payload?: unknown,
  opts?: PtCommandOptions,
): Promise<PtResult<R>> {
  const id = typeof opts?.requestId === 'string' && opts.requestId.length > 0 ? opts.requestId : newId();
  return (await ipcRenderer.invoke(PT_BRIDGE_CHANNELS.command, {
    v: PT_BRIDGE_VERSION,
    id,
    op,
    payload,
  })) as PtResult<R>;
}

const eventListeners = new Map<string, Set<(payload: unknown) => void>>();
ipcRenderer.on(PT_BRIDGE_CHANNELS.event, (_e, ev: PtEvent) => {
  if (ev?.v !== PT_BRIDGE_VERSION) return;
  for (const cb of eventListeners.get(ev.topic) ?? []) cb(ev.payload);
});

function onEvent(topic: string, cb: (payload: unknown) => void): () => void {
  let set = eventListeners.get(topic);
  if (!set) {
    set = new Set();
    eventListeners.set(topic, set);
  }
  const listeners = set;
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) eventListeners.delete(topic);
  };
}

const ptNative: PtNative = {
  nativeAvailable: () => true,
  shellVersion: () => process.env.npm_package_version ?? '0.1.0',
  bridgeVersion: () => PT_BRIDGE_VERSION,
  onLoadPatchRequested: (cb) => {
    ipcRenderer.on('pt:load-patch-requested', (_event, filePath: string) => cb(filePath));
  },
  command,
  cancel,
  onEvent,
  helperStatus: {
    // Routed through the envelope like everything else — the shape is proven
    // by a real caller, not asserted by a comment.
    get: async () => {
      const res = await command<HelperStatusSnapshot>('helpers.status');
      if (!res.ok) throw new Error(`helpers.status failed: ${res.error.code}: ${res.error.message}`);
      return res.result;
    },
    subscribe: (cb) => onEvent('helpers.status', (p) => cb(p as HelperStatus)),
  },
};

contextBridge.exposeInMainWorld('ptNative', ptNative);
