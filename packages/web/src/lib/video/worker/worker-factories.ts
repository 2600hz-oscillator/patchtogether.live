// packages/web/src/lib/video/worker/worker-factories.ts
//
// THE RENDER WORKER'S BUNDLE MANIFEST — which module factories the worker is
// allowed to instantiate.
//
// ⚠ THIS IS NOT A HAND-MAINTAINED LIST OF NAMES. It is a BUNDLE manifest, and
// it has to be written out because static imports are the only way to tell a
// bundler which factories to include. Importing the module barrel instead
// would pull the WHOLE video registry — DOM-coupled factories and all — into
// the worker bundle, where `document` does not exist and the import would
// throw before a single frame rendered. So the explicitness is load-bearing,
// not laziness.
//
// What stops it going stale is not care, it is the gate:
// `worker-eligibility.test.ts` asserts these keys are EXACTLY the set of defs
// whose `renderLocus` is `'worker'` or `'worker-experimental'`, in BOTH
// directions —
//   * a def promoted to a worker locus with no entry here is RED (it would
//     silently render on the main thread forever, and the "migration" would be
//     a comment);
//   * an entry here for a def that is no longer worker-locus is RED (dead
//     weight in the worker bundle, anchored to an artifact that moved).
// The DEF is the source of truth; this file is the manifest that must agree
// with it.
//
// SEPARATE FILE from `render-worker.ts` on purpose: that file installs an
// `onmessage` handler on the worker global at module scope, so a test
// importing it to read this manifest would install that handler on the TEST
// realm. A manifest a gate cannot import without side effects is a manifest no
// gate will check.
//
// Every factory is imported from its DEF file, never a card — that is what
// keeps the worker bundle DOM-free.

import type { VideoModuleFactory } from '$lib/video/engine';
import { acidwarpDef } from '$lib/video/modules/acidwarp';
import { createToyboxWorkerHandle } from './toybox-worker-handle';
import type { WorkerFactoryRegistry } from './worker-engine';

/**
 * TOYBOX is the exception in SHAPE, not in policy: it is registered under a
 * BESPOKE worker handle rather than its own factory, because the main-thread
 * factory reads `livePatch.nodes[id]` every frame (Yjs / DOM-coupled). The
 * worker handle receives a serialized state snapshot over `MsgToyboxSync`
 * instead and renders the pure-GL layer kinds.
 *
 * It is registered but NOT promoted: its `video` layers still render black in
 * the worker (a patched `inA`/`inB` feed is a MAIN-GL texture, and there are
 * no cross-thread input textures), so it stays `worker-experimental` behind
 * the explicit flag. Promoting it would ship a black picture to anyone using a
 * video layer, which is a parity break, not a migration.
 */
export const WORKER_FACTORIES: WorkerFactoryRegistry = {
  [acidwarpDef.type as string]: acidwarpDef.factory as VideoModuleFactory,
  toybox: createToyboxWorkerHandle as VideoModuleFactory,
};

/** The manifest's keys — what the eligibility gate compares against the live
 *  def registry. Derived from the manifest itself, so the two cannot drift. */
export const WORKER_FACTORY_TYPES: readonly string[] = Object.keys(WORKER_FACTORIES);
