// e2e/_helpers/worker-handshake.ts
//
// #1905 — READING THE RENDER-WORKER HANDSHAKE FROM A SPEC.
//
// The producer-init race family always presented as ONE number — zero pixels —
// and that number was the same for four situations needing four different
// responses. `VideoEngine.workerHandshakeTrace()` returns both halves of the
// handshake (main-thread bridge + in-worker render loop); this module is the
// ONE export site specs read it through, so a second spec cannot hand-roll a
// subtly different reading of the same state.
//
// Use it in the FAILURE path of a poll, not the success path: it turns
// "expected > 0.02, received 0" into a sentence naming which stage stalled.

import { type Page } from '@playwright/test';

/** Both halves of the render-worker handshake (see VideoEngine.workerHandshakeTrace). */
export interface HandshakeTrace {
  main: {
    constructedAt: number;
    initSentAt: number | null;
    readyAt: number | null;
    glOk: boolean;
    failedAt: number | null;
    failReason: string | null;
    nodes: Array<{
      id: string;
      addNodeSentAt: number;
      syncsSent: number;
      framesReceived: number;
      framesDroppedUnknown: number;
      framesDroppedNotReady: number;
      framesDelivered?: number;
      framesDroppedUpload?: number;
      lastUploadError?: string | null;
    }>;
  } | null;
  worker: {
    now: number;
    initAt: number | null;
    glOkAt: number | null;
    glError: string | null;
    loopTicks: number;
    lastTickAt: number | null;
    loopErrors: number;
    lastError: string | null;
    paused: boolean;
    frozenTimeSec: number | null;
    nodes: Array<{
      id: string;
      addedAt: number;
      drawn: number;
      posted: number;
      withheld: number;
      firstContentAt: number | null;
      contentNote: string | null;
      drawErrors: number;
    }>;
  } | null;
  /** FALSE is a READING — a worker whose message loop is wedged cannot answer. */
  workerReplied: boolean;
}

export async function handshakeTrace(page: Page): Promise<HandshakeTrace> {
  return page.evaluate(async () => {
    const w = globalThis as unknown as {
      __engine?: () => { getDomain: (d: string) => { workerHandshakeTrace?: () => Promise<unknown> } };
    };
    const eng = w.__engine?.();
    const vid = eng?.getDomain('video');
    if (!vid?.workerHandshakeTrace) return { main: null, worker: null, workerReplied: false };
    return (await vid.workerHandshakeTrace()) as never;
  });
}

/**
 * One sentence naming WHICH stage of the handshake stalled, for `nodeId`.
 *
 * The ordering is the diagnosis: each branch rules out everything above it, so
 * the first one that matches is the earliest stage that failed. Pass the node
 * id the assertion was about — a rack can hold several worker-resident nodes
 * and only one of them may be stuck.
 */
export function describeHandshake(t: HandshakeTrace, nodeId: string): string {
  if (!t.main) return 'no worker bridge was ever constructed (flag off, or no worker-locus node in the rack)';
  if (t.main.failedAt !== null) return `worker FAILED OVER to the main thread: ${t.main.failReason}`;
  if (t.main.readyAt === null) {
    return `worker never confirmed WebGL2 — no ready message ${t.main.initSentAt === null ? '(init was never even sent)' : 'since init'}`;
  }
  if (!t.workerReplied) return 'worker did NOT answer a trace request — its MESSAGE loop is wedged (not just its render loop)';
  const w = t.worker!;
  if (w.loopErrors > 0) return `worker render loop threw ${w.loopErrors}× — last: ${w.lastError}`;
  if (w.paused) return `worker is PAUSED by determinism forwarding (frozenTimeSec=${w.frozenTimeSec}) — it posts no frames BY DESIGN`;
  const n = w.nodes.find((x) => x.id === nodeId);
  if (!n) {
    return `worker has no node '${nodeId}' — addNode never arrived, or its type is not in WORKER_FACTORIES ` +
      `(worker knows: [${w.nodes.map((x) => x.id).join(', ') || 'none'}])`;
  }
  if (n.drawErrors > 0) return `node '${nodeId}' THREW on draw ${n.drawErrors}× — the module cannot render in the worker realm`;
  if (n.drawn === 0) return `node '${nodeId}' attached but never drawn (loopTicks=${w.loopTicks}) — the render loop is not reaching it`;
  if (n.posted === 0) return `node '${nodeId}' drawn ${n.drawn}× but WITHHELD every frame: ${n.contentNote}`;
  const m = t.main.nodes.find((x) => x.id === nodeId);
  if (m && m.framesReceived === 0) {
    return `worker posted ${n.posted} frames for '${nodeId}' but the bridge accepted none ` +
      `(droppedUnknown=${m.framesDroppedUnknown}, droppedNotReady=${m.framesDroppedNotReady})`;
  }
  if (m && (m.framesDroppedUpload ?? 0) > 0 && (m.framesDelivered ?? 0) === 0) {
    return `the bridge received ${m.framesReceived} frames for '${nodeId}' and EVERY ONE failed to upload ` +
      `into the main-GL texture (${m.framesDroppedUpload} errors, last: ${m.lastUploadError}) — ` +
      'the worker is fine; the main-thread upload is the broken link';
  }
  return `node '${nodeId}' posted ${n.posted} frames (withheld ${n.withheld}, firstContent at ${n.firstContentAt?.toFixed(0)}ms) — ` +
    'the handshake completed, so a black picture here is a RENDER bug, not an init race';
}

/**
 * Attach the handshake diagnosis to a failing assertion and re-throw.
 *
 * `nodeId` may be a THUNK, for a poll that covers several nodes and only knows
 * which one is stuck at the moment it gives up — naming a healthy node would
 * produce a confident, wrong sentence, which is the failure mode this whole
 * exercise exists to remove.
 */
export async function withHandshakeDiagnosis<T>(
  page: Page,
  nodeId: string | (() => string),
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const id = typeof nodeId === 'function' ? nodeId() : nodeId;
    const t = await handshakeTrace(page).catch(() => null);
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      t
        ? `${msg}\n[#1905 handshake] ${describeHandshake(t, id)}\n[#1905 raw] ${JSON.stringify(t)}`
        : `${msg}\n[#1905 handshake] trace unavailable (page closed or engine gone)`,
    );
  }
}
