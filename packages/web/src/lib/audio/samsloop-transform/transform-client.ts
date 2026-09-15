// SAMSLOOP transform client — the main-thread end of `transform.worker.ts`.
//
// ONE lazy singleton Worker, constructed on the FIRST press and never at
// module load: a `new URL(..., import.meta.url)` at module scope would break
// the unit lane (vitest has no Worker) and SSR. Where `Worker` is undefined
// the request runs INLINE through the same pure core, which is what the unit
// tests drive; the face action also accepts an injected runner.
//
// Requests are correlated by a monotonic `id` on a pending map, so two nodes
// pressed back-to-back each get their own reply.

import {
  runSamsloopTransform,
  type SamsloopTransformRequest,
  type SamsloopTransformResponse,
} from './transform-core';

export type SamsloopTransformRunner = (
  req: SamsloopTransformRequest,
) => Promise<SamsloopTransformResponse>;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (res: SamsloopTransformResponse) => void>();

function ensureWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./transform.worker.ts', import.meta.url), {
      type: 'module',
      name: 'samsloop-transform',
    });
  } catch {
    return null;
  }
  worker.onmessage = (e: MessageEvent<SamsloopTransformResponse>) => {
    const res = e.data;
    const resolve = pending.get(res.id);
    if (!resolve) return;
    pending.delete(res.id);
    resolve(res);
  };
  worker.onerror = () => {
    // The worker died: answer every pending press with a refusal rather than
    // leaving the face on BUSY, and let the next press construct a fresh one.
    for (const [id, resolve] of pending) resolve({ id, ok: false, reason: 'not-finite' });
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** A fresh request id — the caller builds the request around it so the
 *  transferable source buffer can be listed on the post. */
export function nextSamsloopTransformId(): number {
  return nextId++;
}

/** Run a transform: in the module worker where one exists, inline otherwise. */
export const runSamsloopTransformAsync: SamsloopTransformRunner = (req) => {
  const w = ensureWorker();
  if (!w) return Promise.resolve(runSamsloopTransform(req));
  return new Promise((resolve) => {
    pending.set(req.id, resolve);
    const transfer: Transferable[] = req.source.kind === 'f32' ? [req.source.samples] : [];
    try {
      w.postMessage(req, transfer);
    } catch {
      pending.delete(req.id);
      resolve({ id: req.id, ok: false, reason: 'not-finite' });
    }
  });
};
