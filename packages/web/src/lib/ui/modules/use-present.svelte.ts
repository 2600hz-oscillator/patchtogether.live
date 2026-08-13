// use-present.svelte.ts
//
// The CARD-SIDE VIEW of "Present on a second display", shared by every video
// card that offers the mode (VideoOutCard / BackdraftCard / BentboxCard /
// B3ntb0xCard) so the wiring is authored once.
//
// ⚠ THE CARD DOES NOT OWN THE PROJECTOR. It used to: this file held the popup
// sessions in a closure, blitted from the card's own <canvas>, and exposed a
// `dispose()` that every card called from `onDestroy`. Under the faceplate shell
// a collapse UNMOUNTS the card, so that combination closed the projector the
// moment the user collapsed the module — owner P0, 2026-08-12. The sessions, the
// blit source and the pull-eval render lease now live in
// $lib/ui/modules/node-present-registry, keyed by NODE id and swept against the
// live node set from Canvas. Read that file's header for the measurement and
// the three separate mechanisms.
//
// What survives here is exactly the part that IS the card's: resolving the
// target screen's rect from its fullscreen controller, resolving the live video
// engine, and exposing a reactive `isPresenting` for the menu.
//
// THERE IS DELIBERATELY NO `dispose()`. Its absence is the guard: a card cannot
// re-introduce the bug by calling something that no longer exists, and `tsc`
// refuses the attempt before any test runs. A projector is closed by the user
// ("Stop presenting" / the window button), by the node being deleted (the
// registry's graph sweep), or by the page going away — never by a view unmount.
//
// MULTI-DISPLAY: one session PER screen id, so a multi-projector venue can light
// up every display. `present(id)` adds/replaces that screen's popup and leaves
// the others running; `presentAll(ids)` fans out to every given display IN ONE
// CALL (one user gesture → one window.open per screen — the Window Management
// API's companion-window provision lets a single activation open the set; any
// the popup-blocker still refuses are skipped, not fatal). Because each popup is
// sized to cover its whole display, this path needs NO Fullscreen API, so it
// never triggers the browser's "is now full screen" overlay.

import type { FullscreenController } from './use-fullscreen.svelte';
import type { DomainEngine } from '$lib/audio/engine';
import type { VideoEngine } from '$lib/video/engine';
import {
  nodePresent,
  type NodePresentRegistry,
  type PresentEngine,
} from './node-present-registry.svelte';

export interface PresentController {
  /** Reactive: is at least one present popup open FOR THIS NODE? Drives the
   *  menu's "Stop presenting" item — and reads true on a card that mounted
   *  after the projector was opened, which a card-owned session could not. */
  readonly isPresenting: boolean;
  /** Reactive: how many present popups this node has open (across displays). */
  readonly presentingCount: number;
  /** Open a present popup on the display behind `screenId`. Keeps any OTHER
   *  displays' popups running; replaces this screen's if already presenting.
   *  Returns false if the engine is unreachable or the popup is blocked. */
  present(screenId: string): boolean;
  /** Open a popup on EACH given display in one call (one user gesture). Skips
   *  displays already presenting + any the popup-blocker refuses. Returns the
   *  number of NEW popups opened. */
  presentAll(screenIds: string[]): number;
  /** Close popups + stop blit loops. With a screenId, just that display; with
   *  no argument, ALL of this node's. Safe to call when idle. */
  stop(screenId?: string): void;
}

/** The structural slice of PatchEngine needed to reach the video domain
 *  (getDomain's generic is constrained to DomainEngine, matching PatchEngine's
 *  real signature — an unconstrained <T> is not assignable FROM PatchEngine).
 *  Same shape use-render-lease takes, for the same reason. */
export interface PresentEngineHost {
  getDomain: <T extends DomainEngine>(domain: string) => T;
}

export interface CreatePresentArgs {
  /** The card's node id — the registry key, and what the engine renders. */
  nodeId: () => string;
  /** Live engine getter (engineCtx.get). Resolved at CLICK time, not at card
   *  init, so a late engine boot still presents. */
  engine: () => PresentEngineHost | null | undefined;
  /** The card's fullscreen controller — used for getScreenRect(screenId). */
  fullscreen: Pick<FullscreenController, 'getScreenRect'>;
  /** Test seam — defaults to the real node-scoped registry. */
  registry?: NodePresentRegistry;
}

/** Resolve the video engine, or null when there is no video domain (audio-only
 *  boot) or it is missing the surface a projector needs. */
function resolveVideoEngine(host: PresentEngineHost | null | undefined): PresentEngine | null {
  if (!host) return null;
  let ve: VideoEngine | undefined;
  try {
    ve = host.getDomain<VideoEngine>('video');
  } catch {
    return null;
  }
  if (!ve || typeof ve.blitOutputToDrawingBuffer !== 'function' || typeof ve.acquireRenderLease !== 'function') {
    return null;
  }
  return ve as unknown as PresentEngine;
}

export function createPresent(args: CreatePresentArgs): PresentController {
  const registry = args.registry ?? nodePresent;

  return {
    get isPresenting() {
      return registry.isPresenting(args.nodeId());
    },
    get presentingCount() {
      return registry.presentingCount(args.nodeId());
    },
    present(screenId: string): boolean {
      const engine = resolveVideoEngine(args.engine());
      if (!engine) return false;
      return registry.present(args.nodeId(), screenId, {
        engine,
        rect: args.fullscreen.getScreenRect(screenId),
      });
    },
    presentAll(screenIds: string[]): number {
      const engine = resolveVideoEngine(args.engine());
      if (!engine) return 0;
      return registry.presentAll(args.nodeId(), screenIds, {
        engine,
        rectFor: (id) => args.fullscreen.getScreenRect(id),
      });
    },
    stop(screenId?: string): void {
      registry.stop(args.nodeId(), screenId);
    },
  };
}
