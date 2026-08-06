// use-render-lease.svelte.ts
//
// THE PRESENTING-MODE HARD RENDER LEASE, authored once for every card with an
// output surface (Full Frame / true fullscreen / Present-on-second-display).
//
// WHY (owner report 2026-08-05, fixed 2026-08-06): a presenting mode puts the
// card's pixels on a surface that OUTLIVES the flow node's viewport rect — a
// projector popup, a fullscreen element, a full-frame card the user then
// scrolls away from. The engine's sink-driven pull evaluation only keeps a
// node rendering while something OBSERVES it, and a card known-offscreen
// (IntersectionObserver → setCardVisibility(false)) is vetoed as an observer
// even though its blit loop keeps running. VideoOutCard carried the
// counter-measure ($effect → acquireRenderLease) since pull-eval landed; the
// FOUR other presenting cards (backdraft / bentbox / b3ntb0x / videobox) had
// the same three modes and NO lease. Measured on backdraft: presenting +
// on-screen drew 1:1 with the engine (+80/+80); scrolled off-screen it drew
// exactly 0 while the engine advanced 143 frames — the projector froze on the
// last frame. One helper, five cards, so the sixth presenting surface cannot
// ship without it by re-typing the effect.
//
// Runes module: attachRenderLease must be called during component INIT (it
// registers an $effect), exactly like createPresent/createFullscreen. The
// decision + acquisition core is a plain function (acquireLeaseIfPresenting)
// so the unit lane pins it without a component mount.

import type { VideoEngine } from '$lib/video/engine';
import type { DomainEngine } from '$lib/audio/engine';

/** The structural slice of PatchEngine the lease needs (getDomain's generic is
 *  constrained to DomainEngine, matching PatchEngine's real signature — an
 *  unconstrained <T> is not assignable FROM PatchEngine). */
export interface LeaseEngineLike {
  getDomain: <T extends DomainEngine>(domain: string) => T;
}

export interface RenderLeaseArgs {
  /** Live engine getter (engineCtx.get / cardParams engineCtx). Read INSIDE
   *  the effect so a late engine boot re-runs it. */
  engine: () => LeaseEngineLike | null | undefined;
  /** The card's node id. */
  nodeId: () => string;
  /** TRUE while any presenting mode is active (fs.isFullscreen ||
   *  present.isPresenting || fullFrame — the card's `expanded` derive). */
  presenting: () => boolean;
}

/**
 * The pure core: when presenting and the video engine is reachable, acquire a
 * hard render lease on the node and return its release fn; otherwise null.
 * Reads every arg exactly once so the $effect shell tracks them all.
 */
export function acquireLeaseIfPresenting(args: RenderLeaseArgs): (() => void) | null {
  const presenting = args.presenting();
  const e = args.engine();
  if (!presenting || !e) return null;
  let ve: VideoEngine | undefined;
  try {
    ve = e.getDomain<VideoEngine>('video');
  } catch {
    return null; // video domain not registered (audio-only boot) — nothing to lease
  }
  if (!ve || typeof ve.acquireRenderLease !== 'function') return null;
  return ve.acquireRenderLease(args.nodeId());
}

/**
 * Register the lease effect. Call during component init. The lease is
 * refcounted engine-side and released the moment every presenting mode ends
 * (effect cleanup), or on card unmount.
 */
export function attachRenderLease(args: RenderLeaseArgs): void {
  $effect(() => acquireLeaseIfPresenting(args) ?? undefined);
}
