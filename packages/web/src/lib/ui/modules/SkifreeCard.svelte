<script lang="ts">
  // SkifreeCard — the VIEW onto the upstream skifree.js engine (MIT, Daniel
  // Hough 2013).
  //
  // ⚠ THIS CARD CREATES NOTHING AND DISPOSES NOTHING, AND THAT IS THE FIX.
  // It used to inject the bundle `<script>` in `onMount`, call
  // `window.SkiFree.create({ canvas })` against its OWN `bind:this` canvas, and
  // `controller.dispose()` in `onDestroy` — so the GAME's lifetime was the
  // CARD's. Under the shipping shell an un-migrated module renders a
  // PLACEHOLDER tile and its real card exists only while the dock full-view is
  // open, which meant:
  //
  //   * a rack containing SKIFREE had NO GAME AT ALL until someone expanded the
  //     dock — the DEFAULT state of any saved rack, not a collapse edge case;
  //   * collapsing that pane (or a dock LRU eviction when a third module is
  //     expanded, or ESC) DESTROYED THE RUN IN PROGRESS.
  //
  // MEASURED on `/rack` with nothing expanded, before the change:
  //   samples 45 / 368 ms · tick 0 -> 15 · distance 0 -> 0 · controller false
  // — the engine ticking while the skier never moved. It failed BLACK rather
  // than broken (the factory's `drawFrame` returns early with no controller, so
  // the `out` VIDEO port emitted a black frame and nothing was logged), which
  // is why it survived.
  //
  // The AUDIO FACTORY owns the game now: it has exactly node lifetime, it
  // creates a DETACHED canvas, loads the bundle and builds the controller. See
  // `$lib/audio/skifree-bridge`'s header for why the factory rather than a
  // node-keyed registry.
  //
  // What this card still does, all of it VIEW work:
  //   1. BLIT the owned canvas into its own visible one, every frame.
  //      ⚠ It must never RE-PARENT the owned canvas — a DOM node has one
  //      parent, so adopting it would hand the game's surface to a component
  //      that unmounts. That is the cameraInput trap, one seam over.
  //   2. Forward native MOUSE steering while focused and CV is unpatched
  //      (`enableMouse` takes THIS card's visible element, which is why mouse
  //      is a card concern even though the game is not).
  //   3. Poll the node's snapshot for the HUD.
  //
  // maxInstances:1 → one card at a time; the bridge is a single
  // window.__skifree object (still un-keyed by node — see the bridge header).

  import { onMount, onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { ensureSkifreeBridge } from '$lib/audio/skifree-bridge';
  import {
    SKIFREE_CANVAS_SIZE,
    type SkifreeBridge,
    type SkifreeController,
    type SkifreeSnapshot,
  } from '$lib/audio/modules/skifree';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const inputs: PortDescriptor[] = [
    { id: 'x', label: 'X (CV)', cable: 'cv' },
    { id: 'y', label: 'Y (CV)', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'gate', label: 'GATE', cable: 'gate' },
    { id: 'out', label: 'OUT (VIDEO)', cable: 'video' },
  ];

  // Logical (CSS) canvas size — must match SKIFREE_CANVAS_SIZE so the
  // factory's CV→cursor map lands in the same coordinate space.
  const CSS = SKIFREE_CANVAS_SIZE;

  let cardEl: HTMLDivElement | null = $state(null);
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let focused = $state(false);
  let snapshot = $state<SkifreeSnapshot | null>(null);
  /** True once the NODE reports it has built its game — read off the snapshot
   *  rather than tracked here, so the overlay and the HUD cannot disagree about
   *  whether a game exists. */
  let gameReady = $derived(snapshot?.gameCreated === true);

  let snapRaf: number | null = null;
  let blitRaf: number | null = null;
  /** The controller the NODE owns. Read, never created, never disposed. */
  let controller: SkifreeController | null = null;

  function ensureBridge(): SkifreeBridge {
    return ensureSkifreeBridge();
  }

  /** The node's own game handle, through the engine — scoped to THIS node
   *  rather than to the single un-keyed global. */
  function nodeController(): SkifreeController | null {
    const eng = engineCtx.get();
    if (!eng || !node) return null;
    return (eng.read(node, 'controller') as SkifreeController | undefined) ?? null;
  }

  /** Engage / disengage native mouse steering. Engaged only when focused AND
   *  CV is not driving (cvDriven false). The controller's enable/disable is
   *  idempotent. */
  function syncMouseControl(): void {
    if (!controller) return;
    const bridge = ensureBridge();
    if (focused && !bridge.cvDriven) {
      controller.enableMouse(canvasEl ?? undefined);
    } else {
      controller.disableMouse();
    }
  }

  /**
   * BLIT the node's game canvas onto this card's visible one, every frame.
   *
   * ⚠ A COPY, NOT AN ADOPTION. The owned canvas stays detached and parentless;
   * re-parenting it here would move the game's surface into a component that
   * unmounts on collapse, which is the bug this card was just relieved of
   * wearing a different hat. `drawImage` is canvas-to-canvas with no CPU
   * readback — the same thing the factory's `drawFrame` does for the video
   * port, so the two surfaces show one render rather than two.
   */
  function blit(): void {
    const next = nodeController();
    if (next !== controller) {
      controller = next;
      // A game that has just appeared may need mouse engaged immediately.
      syncMouseControl();
    }
    const src = controller?.canvas;
    const dst = canvasEl;
    if (src && dst && src.width > 0 && src.height > 0) {
      const c2d = dst.getContext('2d');
      if (c2d) {
        c2d.imageSmoothingEnabled = false;
        try {
          // ⚠ THE THREE-ARGUMENT FORM, BECAUSE THIS IS GENUINELY 1:1. Both
          // canvases are sized from the SAME exported constant — the factory
          // mints its game canvas at `SKIFREE_CANVAS_SIZE` and this card's
          // visible canvas is `width={CSS}` where `CSS = SKIFREE_CANVAS_SIZE` —
          // so there is no scale factor to apply. An earlier draft wrote the
          // nine-argument `drawImage(src, 0,0,sw,sh, 0,0,dw,dh)`, which is a
          // RESAMPLE by shape even when the numbers happen to match, and
          // `preview-downscale-source.test.ts` (#1846) caught it. The gate was
          // right: a call that names a destination width and height is claiming
          // a resize this code never performs, and the honest spelling is also
          // the one that cannot alias if the sizes ever drift apart.
          c2d.drawImage(src, 0, 0);
        } catch (_e) { /* detached/tainted this frame — leave the last image */ }
      }
    }
    blitRaf = requestAnimationFrame(blit);
  }

  function pollSnapshot(): void {
    const eng = engineCtx.get();
    if (eng && node) {
      const snap = eng.read(node, 'snapshot') as SkifreeSnapshot | undefined;
      if (snap) {
        snapshot = snap;
        // The factory updates bridge.cvDriven each tick; re-evaluate mouse.
        syncMouseControl();
      }
    }
    snapRaf = requestAnimationFrame(pollSnapshot);
  }

  function onFocus(): void { focused = true; syncMouseControl(); }
  function onBlur(): void { focused = false; syncMouseControl(); }

  onMount(() => {
    snapRaf = requestAnimationFrame(pollSnapshot);
    blitRaf = requestAnimationFrame(blit);
  });

  onDestroy(() => {
    // ⚠ EVERYTHING RELEASED HERE IS THIS COMPONENT'S OWN — two rAF handles and
    // the mouse binding. NOTHING node-owned is touched, and there is no longer
    // a spelling for touching it: the controller is created and disposed by the
    // factory (node lifetime), and the card-facing `releaseSkifreeCardState`
    // was DELETED rather than deprecated, so `tsc` refuses a future teardown
    // that tries to reach the game from here.
    //
    // ⚠ `disableMouse()` IS RELEASED, DELIBERATELY. The pointer binding is on
    // THIS card's element; leaving it engaged would keep a handler on a node
    // that is being removed from the document, and the next mount re-engages it
    // through `syncMouseControl`. It is card state, so the card frees it —
    // which is exactly the distinction that was missing before.
    if (snapRaf !== null) cancelAnimationFrame(snapRaf);
    snapRaf = null;
    if (blitRaf !== null) cancelAnimationFrame(blitRaf);
    blitRaf = null;
    try { controller?.disableMouse(); } catch (_e) { /* */ }
    controller = null;
  });
</script>

<div class="mod-card skifree-card" bind:this={cardEl}>
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <ModuleTitle {id} {data} defaultLabel="SKIFREE" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="game-area">
      <!-- The bundle controller binds to THIS canvas (window.SkiFree.create).
           tabindex makes it focusable so native mouse control can engage
           when x/y are unpatched. -->
      <canvas
        bind:this={canvasEl}
        width={CSS}
        height={CSS}
        style={`width: ${CSS}px; height: ${CSS}px;`}
        tabindex="0"
        onfocus={onFocus}
        onblur={onBlur}
        data-viz-passthrough
        data-testid="skifree-canvas"
      ></canvas>

      <!-- ⚠ THE FAILURE COMES OFF THE NODE'S SNAPSHOT, NOT OUT OF CARD STATE.
           The card no longer loads the bundle, so it cannot know why a load
           failed — and a permanent "Loading…" would be indistinguishable from a
           slow network for anyone actually using it. `bundleError` rides the
           payload this card already polls, so the report reaches whichever
           surface exists, and none (harmlessly) when none does. -->
      {#if snapshot?.bundleError}
        <div class="skifree-overlay skifree-overlay-err" data-testid="skifree-load-error">
          Bundle failed: {snapshot.bundleError}
        </div>
      {:else if !gameReady}
        <div class="skifree-overlay" data-testid="skifree-loading">Loading…</div>
      {/if}

      <div class="skifree-hud" data-testid="skifree-hud">
        {#if snapshot}
          <span>{snapshot.distance}m</span>
          <span>· lives {snapshot.lives}</span>
          <span class="ctl-mode">{snapshot.cvDriven ? 'CV' : (focused ? 'MOUSE' : 'IDLE')}</span>
          {#if snapshot.gameOver}<span class="over">GAME OVER</span>{/if}
        {/if}
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .skifree-card { width: 360px; min-height: 420px; }
  .skifree-card .game-area {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 6px 0 8px;
  }
  .skifree-card canvas {
    display: block;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
    border: 1px solid color-mix(in oklab, var(--cable-gate) 30%, transparent);
    border-radius: 2px;
    background: #cfe8ff; /* snow-white-blue idle */
    outline: none;
  }
  .skifree-card canvas:focus {
    border-color: var(--cable-gate);
  }
  .skifree-card .skifree-overlay {
    position: absolute;
    top: 12px;
    left: 12px;
    right: 12px;
    background: rgba(0, 0, 0, 0.7);
    color: #ffd040;
    padding: 6px 8px;
    border-radius: 2px;
    font-size: 11px;
    text-align: center;
    pointer-events: none;
  }
  .skifree-card .skifree-overlay-err { color: #ff5050; }
  .skifree-card .skifree-hud {
    display: flex;
    gap: 6px;
    margin-top: 6px;
    font-size: 10px;
    color: #88a;
    font-family: ui-monospace, monospace;
  }
  .skifree-card .skifree-hud .ctl-mode { color: var(--cable-gate); }
  .skifree-card .skifree-hud .over { color: #ff5050; font-weight: 700; }
</style>
