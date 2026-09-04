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
  //   2. Forward MOUSE steering while focused and CV is unpatched — from ITS
  //      OWN pointer handlers, mapped through the def's pure
  //      `pointerToCanvasCoord`. ⚠ IT USED TO CALL `controller.enableMouse()`
  //      AND THAT WAS BROKEN ON EVERY SURFACE SINCE #2192: the bundle's
  //      handlers attach to the element they are given but take their rect from
  //      the FACTORY's canvas, which is detached, so `getBoundingClientRect()`
  //      is all zeros and `e.clientX - rect.left` handed raw VIEWPORT
  //      coordinates to a 0..320 space — the skier pinned itself to an edge and
  //      steering was one stuck direction. Fixed here and in the face body
  //      (`skifree/SkifreeScreen.svelte`) through ONE shared pure mapper, so
  //      the two surfaces cannot drift apart.
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
    pointerToCanvasCoord,
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

  /** Is mouse steering engaged right now? Engaged only when this card's canvas
   *  is FOCUSED and CV is not driving. Read per pointer event rather than
   *  latched, so a CV cable patched mid-gesture takes the cursor back on the
   *  very next move. */
  function mouseEngaged(): boolean {
    return focused && !ensureBridge().cvDriven;
  }

  /**
   * Write the cursor from a pointer position on THIS card's canvas.
   *
   * ⚠ THE CARD OWNS THIS NOW, AND IT HAD TO. `controller.enableMouse(el)`
   * attaches to `el` but computes `canvas.getBoundingClientRect()` against the
   * FACTORY's canvas — detached since #2192, so every field is 0 — and then
   * does `e.clientX - rect.left`. The cursor received raw VIEWPORT coordinates
   * in a 0..320 space, so the skier parked on an edge and "steering" was a
   * single stuck direction. The map is a RATIO of THIS element's rect, through
   * the def's pure `pointerToCanvasCoord`, which the face body calls too.
   */
  function steerFromPointer(e: PointerEvent): void {
    const ctl = controller;
    const el = canvasEl;
    if (!ctl || !el || !mouseEngaged()) return;
    const r = el.getBoundingClientRect();
    ctl.setCursor(
      pointerToCanvasCoord(e.clientX, r.left, r.width),
      pointerToCanvasCoord(e.clientY, r.top, r.height),
    );
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
    if (next !== controller) controller = next;
    const src = controller?.canvas;
    const dst = canvasEl;
    if (src && dst && src.width > 0 && src.height > 0) {
      const c2d = dst.getContext('2d');
      if (c2d) {
        c2d.imageSmoothingEnabled = false;
        try {
          // ⚠ NINE ARGUMENTS, AND THE THREE-ARGUMENT FORM WAS SHIPPING A CROP.
          // This code used to argue the blit was "genuinely 1:1, both canvases
          // are sized from the SAME exported constant". The premise is FALSE
          // and the bundle is where it breaks: `SkiFree.create()` OVERWRITES
          // the canvas it is handed —
          //     canvas.style.width = `${width}px`;      // 320
          //     canvas.width       = Math.round(width * dpr);
          // — so on any DPR >= 2 display the SOURCE is 640x640 while this
          // canvas is 320x320, and a 3-argument draw paints the source at its
          // NATIVE size into a quarter of the area: the player saw the TOP-LEFT
          // QUADRANT of the slope with the skier in the corner. Every gate in
          // the repo is blind to it — Playwright and VRT run at
          // `deviceScaleFactor: 1`, where the two numbers coincide.
          //
          // The destination rect is derived from `src.width/height`, never from
          // `SKIFREE_CANVAS_SIZE`: the source size is the bundle's to choose.
          // `preview-downscale-source.test.ts` (#1846) carries this call as a
          // NAMED exemption — deliberately crisp, like FOXY and RASTERIZE.
          c2d.drawImage(src, 0, 0, src.width, src.height, 0, 0, dst.width, dst.height);
        } catch (_e) { /* detached/tainted this frame — leave the last image */ }
      }
    }
    blitRaf = requestAnimationFrame(blit);
  }

  function pollSnapshot(): void {
    const eng = engineCtx.get();
    if (eng && node) {
      const snap = eng.read(node, 'snapshot') as SkifreeSnapshot | undefined;
      if (snap) snapshot = snap;
    }
    snapRaf = requestAnimationFrame(pollSnapshot);
  }

  // Focus is still the card's arming gesture — `mouseEngaged()` reads it, and
  // `bridge.cvDriven`, per pointer event rather than latching a mode.
  function onFocus(): void { focused = true; }
  function onBlur(): void { focused = false; }

  onMount(() => {
    snapRaf = requestAnimationFrame(pollSnapshot);
    blitRaf = requestAnimationFrame(blit);
  });

  onDestroy(() => {
    // ⚠ EVERYTHING RELEASED HERE IS THIS COMPONENT'S OWN — two rAF handles.
    // NOTHING node-owned is touched, and there is no longer a spelling for
    // touching it: the controller is created and disposed by the factory (node
    // lifetime), and the card-facing `releaseSkifreeCardState` was DELETED
    // rather than deprecated, so `tsc` refuses a future teardown that tries to
    // reach the game from here.
    //
    // ⚠ THERE IS NO LONGER A MOUSE BINDING TO RELEASE, and that is a
    // simplification the steering fix bought outright: the pointer handlers are
    // Svelte attributes on this card's own canvas, so they die with the
    // template. The old `disableMouse()` call here was freeing a listener the
    // BUNDLE had installed on this element — necessary while the bundle owned
    // the binding, and meaningless now that it does not.
    if (snapRaf !== null) cancelAnimationFrame(snapRaf);
    snapRaf = null;
    if (blitRaf !== null) cancelAnimationFrame(blitRaf);
    blitRaf = null;
    controller = null;
  });
</script>

<div class="mod-card skifree-card" bind:this={cardEl}>
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <ModuleTitle {id} {data} defaultLabel="SKIFREE" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="game-area">
      <!-- The card BLITS the node's game canvas here and never re-parents it.
           `tabindex` makes it focusable so mouse steering can engage when x/y
           are unpatched — the card's arming gesture, unchanged. The pointer
           handlers are the card's OWN (see `steerFromPointer`); the bundle's
           `enableMouse` is never called, because its rect comes from the
           factory's detached canvas and is all zeros. -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions
           — this canvas is already the card's focusable steering surface
           (`tabindex="0"`, focus/blur arming), so the pointer handlers are on
           the element that ALREADY owns the gesture. The alternative Svelte
           would accept is a wrapper with an interactive role, which would put a
           SECOND focus target on a card that has exactly one control. There is
           no keyboard steering to expose (owner ruling: no keyboard a11y). -->
      <canvas
        bind:this={canvasEl}
        width={CSS}
        height={CSS}
        style={`width: ${CSS}px; height: ${CSS}px;`}
        tabindex="0"
        onfocus={onFocus}
        onblur={onBlur}
        onpointerdown={steerFromPointer}
        onpointermove={steerFromPointer}
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
