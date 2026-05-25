// use-full-frame.svelte.ts
//
// Sibling to use-fullscreen.svelte.ts. Where createFullscreen() drives TRUE
// browser fullscreen (the canvas escapes the rack to fill the physical
// screen), createFullFrame() drives an IN-APP "Full Frame" mode: the card
// stays at its position in the rack but its video surface expands to consume
// the card's OWN border — the card chrome (param knobs, port labels, the
// card's own Handle jacks) is hidden so several VIDEOBOX / VIDEO OUT / BENTBOX
// nodes can be tiled into a grid as a "wall of TVs", showing only video.
//
// Persistence + multiplayer: full-frame is per-card state stored in
// node.data.fullFrame (NOT browser-session state) so it survives reload and
// syncs to rack-mates over Y.Doc — a wall-of-TVs layout is shareable. The
// card owns the read (a $derived off node.data.fullFrame) + the write (into
// the patch store inside the supplied setter); this helper holds the
// lifecycle (dblclick-to-exit while active) and the mutual-exclusion contract.
//
// Mutual exclusion with true fullscreen: a card can be NEITHER, full-frame,
// OR fullscreen — never both at once. Entering full-frame asks the supplied
// `exitFullscreen` to drop any active browser-fullscreen first; entering
// fullscreen (in the card) likewise sets fullFrame=false. The two states are
// orthogonal mechanisms (CSS-in-rack vs Fullscreen API) but we keep them
// mutually exclusive so the UI is never in an ambiguous double-expanded state.
//
// The card's rAF blit is independent of this helper, so the full-frame view
// stays live — we only toggle persisted state + a CSS class, never the render
// loop.

export interface FullFrameController {
  /** Wire up the dblclick-to-exit lifecycle against the card element.
   *  Call from an $effect with the card's root element so it tears down on
   *  unmount / re-binds when the element changes. While full-frame is active
   *  a double-click on the card exits back to normal chrome (mirrors the
   *  fullscreen dblclick-exit). Returns a cleanup fn. */
  attach(el: HTMLElement | null, isActive: () => boolean): () => void;
  /** Enter full-frame. Drops any active true-fullscreen first (mutual
   *  exclusion) then persists fullFrame=true via the card's setter. */
  enter(): void;
  /** Exit full-frame (also bound to dblclick on the card while active). */
  exit(): void;
  /** Toggle full-frame on/off. */
  toggle(currentlyActive: boolean): void;
}

export interface FullFrameOptions {
  /** Persist the new full-frame flag onto node.data.fullFrame (Y.Doc-synced).
   *  The card supplies this so the helper stays decoupled from the store. */
  setFullFrame: (on: boolean) => void;
  /** Drop any active TRUE browser fullscreen so the two modes stay mutually
   *  exclusive. Card passes its createFullscreen() controller's exit(). */
  exitFullscreen: () => void;
}

export function createFullFrame(opts: FullFrameOptions): FullFrameController {
  return {
    enter() {
      // Mutual exclusion: never full-frame AND fullscreen at once.
      opts.exitFullscreen();
      opts.setFullFrame(true);
    },
    exit() {
      opts.setFullFrame(false);
    },
    toggle(currentlyActive: boolean) {
      if (currentlyActive) this.exit();
      else this.enter();
    },
    attach(el: HTMLElement | null, isActive: () => boolean) {
      if (!el) return () => {};
      const onDblClick = (e: MouseEvent) => {
        // Only act while full-frame; otherwise let double-clicks be (e.g. a
        // future dbl-click-to-rename on the header in normal chrome).
        if (!isActive()) return;
        e.preventDefault();
        e.stopPropagation();
        opts.setFullFrame(false);
      };
      el.addEventListener('dblclick', onDblClick);
      return () => {
        el.removeEventListener('dblclick', onDblClick);
      };
    },
  };
}
