<script lang="ts">
  // packages/web/src/lib/ui/modules/seqtris/SeqtrisWell.svelte
  //
  // THE 8x8 WELL — the one picture BOTH promoted surfaces paint.
  //
  // A lane tile and an open dock pane for the same node are mounted at the same
  // time, so the two bodies are counterparts rather than siblings: they pass
  // different `testidPrefix`es into this component instead of sharing testids,
  // and they cannot show different pictures because there is only one of them.
  // (`SkifreeScreen` is the precedent for the shared-surface half.)
  //
  // ── ⚠ THE WELL IS DOM, NOT A CANVAS, AND CONVERTING IT WOULD BE A REGRESSION
  //
  // `SeqtrisCard.svelte` renders a CSS `grid` of 64 `<span>`s and this carries
  // that over unchanged. The modtris / skifree DPR lessons are real and they do
  // NOT apply here: both are canvas-BLIT hazards (a backing store measured in
  // device pixels handed to a painter that lays out in CSS px; a source rect
  // scaled into a destination rect). A CSS grid has neither — the browser
  // rasterises DOM at device pixels natively, and `1fr` columns with
  // `aspect-ratio: 1/1` are resolution-independent by construction.
  //
  // Converting the well to a canvas to "follow the precedent" would DELETE 64
  // `data-testid`s and the `data-piece` attribute — the only machine-readable
  // read of the board that is not a `page.evaluate` into engine internals — and
  // would IMPORT the bug class this module is currently immune to. So:
  //
  //   * the size is set in CSS px on the CONTAINER only (`--well-px`), never per
  //     cell, so the grid divides its box exactly and cannot accumulate rounding
  //     into a ninth column;
  //   * `aspect-ratio: 1 / 1` is the geometric guarantee that 8 columns and 8
  //     rows stay square at any tier — what a blit's destination rect would
  //     otherwise have to assert;
  //   * ⚠ NO `image-rendering: pixelated`. modtris needs it because it IS a
  //     bitmap; on DOM cells it is inert, and a copied incantation.
  //
  // ── ⚠ THIS SUBSCRIBES. IT DOES NOT rAF, AND THAT IS THE DIVERGENCE ─────────
  //
  // `ModtrisWellBody` and `SkifreeScreen` both run `requestAnimationFrame`
  // loops because their modules expose no listener seam. SEQTRIS DOES: the
  // factory's `changed()` fires a listener set on every state change, and the
  // card has always subscribed rather than polled. A body that polled on rAF
  // would burn a frame's work per node per frame to re-read a board that moves
  // at most once per clock pulse — and would make an IDLE, UNCLOCKED seqtris
  // (the resting state a VRT scene captures) do work forever.
  //
  // ── ⚠ WHAT THIS COMPONENT MAY NEVER DO ────────────────────────────────────
  //
  //   * call `launchpad.release()`. That is the node's death, called from the
  //     factory's `dispose`; a component lifecycle hook releasing the hardware
  //     is #1728, refused by name in the binder's own header. `unbind()` is a
  //     USER GESTURE only, and it lives in the dock body.
  //   * re-derive the palette. `seqtrisCssColor` is imported — the engine's own
  //     comment: "ONE palette for both surfaces on purpose… a second copy of
  //     these numbers is how the two drift apart."
  //   * statically import the Launchpad device module. `LaunchpadPort` arrives
  //     as `import type` only (erased), because `launchpad-device.svelte.ts`
  //     declares `$state` at module scope and the ART harness runs the audio
  //     registry with no Svelte plugin. `seqtris.test.ts`'s lazy-import guard
  //     covers this file.
  import { onDestroy } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import { getSchedulerClock } from '$lib/audio/scheduler-clock';
  import type { ModuleNode } from '$lib/graph/types';
  import type { SeqtrisCardApi, SeqtrisSnapshot } from '$lib/audio/modules/seqtris';
  import {
    SEQTRIS_COLS,
    SEQTRIS_ROWS,
    cellIndex,
    seqtrisCssColor,
    type SeqtrisPieceId,
  } from '$lib/audio/modules/seqtris-engine';

  interface Props {
    nodeId: string;
    /** The well's edge in CSS px. Set on the CONTAINER only — see the header. */
    size: number;
    /** `seqtris-tile` or `seqtris-face`. The two surfaces coexist, so every
     *  testid below is namespaced rather than shared. */
    testidPrefix: string;
    /** Dock-only: offer the SCREEN switch. The TILE honours the same
     *  `node.data.previewCollapsed` flag without offering the control, so one
     *  flag drives two surfaces and they cannot disagree. */
    screenToggle?: boolean;
  }
  let { nodeId, size, testidPrefix, screenToggle = false }: Props = $props();

  const engineCtx = useEngine();

  function api(): SeqtrisCardApi | null {
    const engine = engineCtx.get();
    const node = patch.nodes[nodeId] as ModuleNode | undefined;
    if (!engine || !node) return null;
    return (engine.read(node, 'card-api') as SeqtrisCardApi | undefined) ?? null;
  }

  // ── THE PUSH SUBSCRIPTION ──────────────────────────────────────────────────
  let snap = $state<SeqtrisSnapshot | null>(null);
  let unsubscribe: (() => void) | null = null;

  /** Idempotent, exactly as on the card — a second call while subscribed is a
   *  no-op rather than a second listener. */
  function attach(): boolean {
    if (unsubscribe) return true;
    const a = api();
    if (!a) return false;
    snap = a.snapshot();
    unsubscribe = a.subscribe(() => {
      snap = a.snapshot();
    });
    return true;
  }

  // ⚠ TWO DRIVERS, AND NEITHER IS SUFFICIENT ALONE.
  //
  //   1. The `$effect` reads `nodeVersion(nodeId)` DIRECTLY — a genuine signal
  //      read in a tracked context, so a rebuilt node re-attaches. ⚠ It does NOT
  //      derive the node proxy and depend on that: the SyncedStore proxy has a
  //      STABLE IDENTITY, so a derived recomputing to "the same proxy" is
  //      value-equal and Svelte never notifies its dependents
  //      ([[yjs-proxy-stable-identity-defeats-derived]]). Reading the leaf
  //      counter is what makes the dependency real.
  //   2. ⚠ BUT THE ENGINE HANDLE CAN APPEAR WITH NO NODE WRITE BEHIND IT. On
  //      spawn the node lands in the Y.Doc FIRST (bumping the version) and the
  //      reconciler builds the handle AFTER, so the effect has already run and
  //      failed by the time `card-api` exists. Nothing in the graph moves to
  //      say so. The backstop is one subscriber on the SCHEDULER CLOCK — the
  //      same clock the factory's game already runs on — WHICH REMOVES ITSELF
  //      THE MOMENT ATTACH SUCCEEDS. It is a one-shot readiness wait expressed
  //      against a real running clock, not a render loop and not a timeout: an
  //      attached body costs zero ticks.
  let unsubscribeRetry: (() => void) | null = null;
  function stopRetry(): void {
    unsubscribeRetry?.();
    unsubscribeRetry = null;
  }
  function armRetry(): void {
    if (unsubscribeRetry) return;
    unsubscribeRetry = getSchedulerClock().subscribe(() => {
      if (attach()) stopRetry();
    });
  }
  $effect(() => {
    void nodeVersion(nodeId);
    if (!attach()) armRetry();
  });

  onDestroy(() => {
    // A leaked listener per mount, and a body unmounts on every dock collapse
    // and LRU eviction.
    unsubscribe?.();
    unsubscribe = null;
    stopRetry();
  });

  // ── VIEW STATE ON THE NODE, NEVER IN THIS COMPONENT ────────────────────────
  // A `$state` here dies with the component, and this component unmounts on
  // dock collapse / LRU eviction (the #1531 / #1574 / #1583 class). `node.data`
  // survives a remount, a reload and a collaborator. Absent => false => ON, so
  // an existing rack opens unchanged. ONE write per CLICK, never per frame —
  // the board itself never touches the graph store at all.
  let previewCollapsed = $derived.by<boolean>(() => {
    void nodeVersion(nodeId);
    return (patch.nodes[nodeId]?.data?.previewCollapsed as boolean | undefined) ?? false;
  });
  function togglePreview(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }

  // ⚠ THE 64-NULL FALLBACK IS LOAD-BEARING, not defensive noise: it is what
  // makes the frame before `attach()` succeeds render an EMPTY WELL instead of
  // throwing, which is the frame a VRT capture can land on.
  let board = $derived<readonly (SeqtrisPieceId | null)[]>(
    snap?.board ?? Array.from({ length: SEQTRIS_COLS * SEQTRIS_ROWS }, () => null),
  );
  const ROWS = Array.from({ length: SEQTRIS_ROWS }, (_, r) => r);
  const COLS = Array.from({ length: SEQTRIS_COLS }, (_, c) => c);

  // The card's label, carried over verbatim. ⚠ It is the ONLY route by which
  // this module's numbers reach a screen reader, and it is deliberately the
  // only one: the card shows no counters, no LINES pill and no GAME OVER
  // banner, and neither does the face.
  let ariaLabel = $derived(
    `Seqtris well, 8 by 8${snap?.piece ? `, current piece ${snap.piece}` : ''}`,
  );
</script>

<div class="seqtris-well-wrap" style={`--well-px: ${size}px;`}>
  <!-- ⚠ THE `role="img"` FRAME RENDERS UNCONDITIONALLY AND ONLY THE GRID SITS
       INSIDE THE COLLAPSE GUARD, so the accessible name survives SCREEN OFF.
       (`FroggerBoardBody.svelte` puts the frame INSIDE its guard, which makes
       its own comment's claim false there. Another module's file — reported,
       not fixed here.)
       ⚠ role="img" sits on the WRAPPER. svelte-check refuses an `img` role on
       elements it considers interactive/noninteractive-mismatched, and
       `task typecheck` runs --fail-on-warnings. -->
  <div
    class="well"
    class:collapsed={previewCollapsed}
    role="img"
    aria-label={ariaLabel}
    data-preview-collapsed={previewCollapsed ? 'true' : 'false'}
    data-testid={`${testidPrefix}-well`}
  >
    {#if !previewCollapsed}
      <div class="grid" data-testid={`${testidPrefix}-grid`}>
        {#each ROWS as row (row)}
          {#each COLS as col (col)}
            {@const cell = board[cellIndex(row, col)] ?? null}
            <span
              class="cell"
              class:filled={cell !== null}
              style={`background: ${seqtrisCssColor(cell)};`}
              data-testid={`${testidPrefix}-cell-${row}-${col}`}
              data-piece={cell ?? ''}
            ></span>
          {/each}
        {/each}
      </div>
    {/if}
  </div>

  {#if screenToggle}
    <!-- ⚠ THE SWITCH OVERLAYS THE WELL AND COSTS ZERO LAYOUT HEIGHT. That is
         not a style preference: STACKING one under the picture cost spirographs
         ~18.8 px against ~11 px of slack and reddened io-spec-consistency.
         ⚠ AND SCREEN OFF HERE IS SAFE TWICE OVER. The game runs on the shared
         scheduler clock subscribed inside the module's FACTORY, so collapsing
         the well stops a DOM render and nothing else — pieces keep falling and
         PIECE / LINE / SPAWN keep firing. AND `launchpad.paint()` is called from
         `changed()` inside that same factory, so the PADS KEEP SHOWING THE
         BOARD: turning the screen off does not dark the hardware. -->
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      aria-pressed={!previewCollapsed}
      data-testid={`${testidPrefix}-screen-toggle`}
      title="SCREEN: turn the well off to reclaim its space. The game keeps playing, the PIECE / LINE / SPAWN jacks keep firing, and a bound Launchpad keeps showing the board."
    >SCREEN {previewCollapsed ? 'OFF' : 'ON'}</button>
  {/if}
</div>

<style>
  .seqtris-well-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF, where the grid is gone: without a
       floor the wrap would collapse and take the absolutely-positioned switch
       with it. Inert behind the well whenever the picture shows. */
    min-height: 18px;
  }
  /* The size lands on the CONTAINER, once. Cells stay `1fr`. */
  .well {
    width: var(--well-px);
    max-width: 100%;
    aspect-ratio: 1 / 1;
    padding: 2px;
    box-sizing: border-box;
    border-radius: 3px;
    background: #0b0c10;
  }
  .well.collapsed {
    /* No picture, no box — the frame stays in the tree for its accessible name
       and stops occupying the well's footprint. */
    aspect-ratio: auto;
    height: 0;
    padding: 0;
    background: transparent;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    grid-template-rows: repeat(8, 1fr);
    gap: 1px;
    width: 100%;
    height: 100%;
  }
  .cell {
    border-radius: 1px;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.03);
  }
  .cell.filled {
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);
  }
  .screen-btn {
    position: absolute;
    right: 2px;
    bottom: 2px;
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 2px;
    /* Legible over a live picture — a transparent button was not. */
    background: rgba(5, 6, 8, 0.72);
    color: var(--text-dim);
    cursor: pointer;
  }
  .screen-btn.on {
    color: var(--text);
    border-color: var(--accent-dim);
  }
  .screen-btn:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
</style>
