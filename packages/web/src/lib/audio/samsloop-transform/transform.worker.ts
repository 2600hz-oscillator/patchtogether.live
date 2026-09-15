// SAMSLOOP transform worker — the thinnest possible shim over
// `transform-core.ts`, so NORMALIZE / DENOISE (0.2–0.4 s of STFT at the
// sample caps, plus a 3 MB quantize + base64) never run on the thread that
// schedules audio. Vite module worker, created via
//   new Worker(new URL('./transform.worker.ts', import.meta.url), { type: 'module' })
// exactly as `audio/es9/bridge.worker.ts` is.
//
// ⚠ FIRST CROSS-PACKAGE WORKER. `transform-core.ts` imports the dsp cores
// from `packages/dsp/src/lib` by relative path. `vite.config.ts` sets no
// `worker.format`, so the worker build is Vite's default `iife`, which inlines
// that import into this chunk (and means the chunk cannot code-split). See
// the core's header; the main bundle crosses the same boundary the same way.
//
// Message contract: `SamsloopTransformRequest` in, `SamsloopTransformResponse`
// out, correlated by `id`. An `f32` source's ArrayBuffer is transferred in by
// the client; nothing is transferred back (the reply is a base64 string).

import { runSamsloopTransform, type SamsloopTransformRequest } from './transform-core';

function post(msg: unknown): void {
  (self as unknown as { postMessage(m: unknown): void }).postMessage(msg);
}

self.onmessage = (e: MessageEvent<SamsloopTransformRequest>) => {
  const req = e.data;
  try {
    post(runSamsloopTransform(req));
  } catch (err) {
    // A throw inside the core must still answer the press, or the client's
    // pending promise hangs and the face shows BUSY forever.
    post({ id: req?.id ?? -1, ok: false, reason: 'not-finite', error: String(err) });
  }
};
