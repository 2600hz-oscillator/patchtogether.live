// packages/web/src/lib/ui/restored-video-boot.ts
//
// Pure decision helper for the persisted-rack VIDEO boot — the seam driven by
// the `$effect` in Canvas.svelte (see fix/video-engine-persist-reconcile).
//
// THE BUG it repairs: the PatchEngine + its auto-reconciler are created lazily
// by Canvas's `ensureEngine()`, which runs ONLY from user graph-mutations
// (spawn / duplicate / load / import) and the audio-gate click. A rack RESTORED
// from persistence — the `/rack` scratch IndexedDB replica (#1131) or the
// `/r/[id]` collab Y.Doc sync — therefore shows its video CARDS (SvelteFlow
// renders them straight off the snapshot) but renders NO video: nothing ever
// booted the engine, so the restored video nodes are never instantiated and the
// VideoEngine rAF render loop (only started from `engine.addNode`) never starts.
// The content stays black/frozen until the user happens to ADD or DELETE a node,
// whose `ensureEngine()` call finally boots + reconciles the whole (already
// seeded) graph and revives ALL restored video at once (the owner-reported
// symptoms: "re-add a source and it comes back"; "delete one and the others
// come back").
//
// Audio has no equivalent bug: it legitimately waits for a user gesture (the
// browser autoplay policy), so "audio silent until a click" is expected. Only
// the gesture-free VIDEO domain shows dead-on-load, which is why the boot is
// scoped to video here.
//
// THE FIX: once the persisted graph has LOADED and it holds ≥1 video node, boot
// the engine so its bus-driven reconciler instantiates the restored nodes and
// the render loop starts — no gesture required. Scoped to video so an
// audio-only / empty rack keeps the lazy boot (no eager AudioContext on every
// page view — audio still waits for the gesture it needs anyway), and the
// ephemeral e2e `/rack` (replica opt-out) is untouched.

/** Minimal node shape this decision reads (a `PatchSnapshot` node). */
export interface DomainedNode {
  domain: string;
}

export interface RestoredVideoBootInput {
  /** The persisted graph has finished LOADING: the scratch replica seed
   *  resolved (`scratchSeeded === true`), or the collab provider completed its
   *  first sync (`provider && providerHasSynced`). FALSE means either a load is
   *  still in flight (don't boot against a partial graph — the bus-driven
   *  reconciler will still catch late arrivals once booted) or there is no
   *  persistence at all (ephemeral canvas: nothing to restore, keep lazy boot). */
  loaded: boolean;
  /** The PatchEngine is already booted — its reconciler keeps restored video
   *  live via the snapshot bus, so a boot is neither needed nor wanted. */
  engineBooted: boolean;
  /** The (restored) graph nodes. */
  nodes: readonly DomainedNode[];
}

/**
 * Should Canvas eagerly boot the engine to render a restored VIDEO rack?
 *
 * True iff the persisted graph has loaded, the engine is not booted yet, and
 * the restored graph contains at least one video-domain node. Pure + idempotent
 * to call — the caller's `ensureEngine()` memoizes the actual boot, so a `true`
 * that briefly repeats before `engineBooted` flips is a harmless no-op.
 */
export function shouldBootEngineForRestoredVideo(input: RestoredVideoBootInput): boolean {
  if (!input.loaded) return false;
  if (input.engineBooted) return false;
  return input.nodes.some((n) => n.domain === 'video');
}
