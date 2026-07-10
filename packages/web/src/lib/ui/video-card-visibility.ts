// packages/web/src/lib/ui/video-card-visibility.ts
//
// Card-viewport visibility feed for the video engine's SINK-DRIVEN PULL
// EVALUATION ($lib/video/pull-eval).
//
// Every mounted module card runs an unconditional preview rAF loop
// (blitOutputToDrawingBuffer + drawImage), so "the card blitted recently" is
// a necessary but NOT sufficient watch signal: a card panned out of the
// viewport keeps blitting a preview nobody can see. This helper closes that
// gap with ONE central IntersectionObserver over the SvelteFlow node
// elements (`.svelte-flow__node[data-id]`) instead of 30+ per-card edits:
//
//   - observed intersecting     → setVisibility(nodeId, true)
//   - observed NOT intersecting → setVisibility(nodeId, false)
//   - element unmounted         → setVisibility(nodeId, null)  (unknown →
//                                 the engine fails OPEN, i.e. visible)
//
// IntersectionObserver recomputes on layout/transform changes, so SvelteFlow
// pan/zoom (a CSS transform on the nodes' parent) drives updates with no
// per-frame JS. A generous rootMargin pre-wakes nodes just outside the
// viewport so panning back to a card never shows a stale first frame.
//
// A MutationObserver on the flow container rescans when SvelteFlow
// adds/removes node elements (spawn/delete), keeping the observed set in
// sync without polling.
//
// DELIBERATELY DOM-only + engine-agnostic (takes a setVisibility callback),
// so it unit-tests in jsdom with fake observers and stays OUT of the WebGL
// attest basis (it never touches GL).

const NODE_SELECTOR = '.svelte-flow__node[data-id]';

export interface VideoCardVisibilityObserver {
  /** Force a rescan of the container's node elements (normally automatic
   *  via the MutationObserver). */
  rescan(): void;
  /** Stop observing and clear every fed visibility back to unknown. */
  dispose(): void;
}

export function observeVideoCardVisibility(opts: {
  /** The SvelteFlow host element (Canvas's `.flow` div). */
  container: HTMLElement;
  /** Sink for visibility updates — Canvas wires this to
   *  `videoEngine.setCardVisibility`. `null` clears to unknown. */
  setVisibility: (nodeId: string, visible: boolean | null) => void;
  /** Pre-wake margin around the viewport (px). Default 300 so a card just
   *  offscreen resumes rendering before it pans into view. */
  rootMargin?: number;
}): VideoCardVisibilityObserver {
  const { container, setVisibility } = opts;
  const margin = opts.rootMargin ?? 300;

  // Fail-safe: in a runtime without the observers (very old browsers, jsdom
  // without polyfills) we feed NOTHING — the engine's fail-open default
  // (unknown = visible) keeps behavior identical to pre-visibility builds.
  if (typeof IntersectionObserver === 'undefined' || typeof MutationObserver === 'undefined') {
    return { rescan() {}, dispose() {} };
  }

  /** element → nodeId we are currently observing (also our reverse index for
   *  unmount cleanup). */
  const observed = new Map<Element, string>();

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const nodeId = observed.get(entry.target);
        if (!nodeId) continue;
        setVisibility(nodeId, entry.isIntersecting);
      }
    },
    // Root = browser viewport: SvelteFlow's pane fills the app shell, and the
    // viewport is the strictest thing the user can actually see.
    { root: null, rootMargin: `${margin}px` },
  );

  function rescan(): void {
    const present = new Set<Element>();
    for (const el of container.querySelectorAll(NODE_SELECTOR)) {
      present.add(el);
      if (observed.has(el)) continue;
      const nodeId = el.getAttribute('data-id');
      if (!nodeId) continue;
      observed.set(el, nodeId);
      io.observe(el);
    }
    // Anything we observed that is no longer in the DOM: clear to unknown so
    // a re-added node (undo, collab echo) starts fail-open.
    for (const [el, nodeId] of observed) {
      if (present.has(el)) continue;
      io.unobserve(el);
      observed.delete(el);
      setVisibility(nodeId, null);
    }
  }

  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.addedNodes.length > 0 || m.removedNodes.length > 0) {
        rescan();
        return;
      }
    }
  });
  mo.observe(container, { childList: true, subtree: true });
  rescan();

  return {
    rescan,
    dispose() {
      mo.disconnect();
      io.disconnect();
      for (const nodeId of observed.values()) setVisibility(nodeId, null);
      observed.clear();
    },
  };
}
