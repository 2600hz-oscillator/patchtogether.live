<script lang="ts">
  // packages/web/src/lib/ui/modules/skifree/SkifreeScreen.svelte
  //
  // THE SLOPE — skifree's one picture, shared by its dock body and its lane
  // tile so the two surfaces can never show different pictures.
  //
  // ⚠ IT BLITS FROM THE NODE'S CANVAS AND NEVER ADOPTS IT. `skifree.ts` mints a
  // DETACHED canvas in the FACTORY and the bundle draws into it for the node's
  // whole lifetime; a DOM node has exactly one parent, so re-parenting it into
  // this component would hand the game's surface to something that unmounts on
  // a dock collapse or an LRU eviction. `drawImage` canvas-to-canvas is the
  // same copy the factory's `drawFrame` already makes for the `out` video port.
  //
  // ── ⚠ THE BLIT IS A SCALE, AND THE THREE-ARGUMENT FORM WAS SHIPPING A CROP ──
  //
  // `SkifreeCard.svelte` drew `c2d.drawImage(src, 0, 0)` under a comment
  // arguing it was "genuinely 1:1, both canvases are sized from the SAME
  // exported constant". That premise is FALSE, and the bundle is where it
  // breaks: `SkiFree.create()` OVERWRITES the canvas it is handed —
  //
  //     canvas.style.width  = `${width}px`;          // 320
  //     canvas.width        = Math.round(width * dpr);
  //
  // — so on any DPR >= 2 display the source canvas is 640x640 while the card's
  // was 320x320, and a 3-argument `drawImage` paints the source at its NATIVE
  // size into a destination a quarter the area. The player got the TOP-LEFT
  // QUADRANT of the slope with the skier jammed in the corner. Invisible to
  // every gate in the repo: Playwright and VRT both run at
  // `deviceScaleFactor: 1`, where the numbers coincide and the bug does not
  // exist.
  //
  // The fix is the NINE-argument form with the destination rect derived from
  // `src.width/height` — never from a constant, because the source size is the
  // bundle's to choose, not ours — plus `imageSmoothingEnabled = false` so the
  // pixel art stays crisp at the lane tile's genuine downscale. That call is a
  // named `EXEMPT_CALLS` entry in `preview-downscale-source.test.ts` (the
  // FoxyOutputBody / RasterizeOutputBody shape: deliberately crisp, and not the
  // #1846 defect on its merits since these pixels never touch the shared WebGL
  // drawing buffer).
  //
  // ── ⚠ THE MOUSE IS OWNED HERE, BECAUSE THE BUNDLE'S OWN PATH IS BROKEN ──────
  //
  // `controller.enableMouse(el)` attaches its listeners to `el` but computes
  // `canvas.getBoundingClientRect()` against the FACTORY's canvas — detached,
  // so every field is 0 — and then does `e.clientX - rect.left`. The cursor
  // therefore received raw VIEWPORT coordinates in a 0..320 space and the skier
  // pinned itself to an edge. That has been the shipping behaviour since #2192
  // moved the game onto the node. This component maps its OWN element's rect
  // through the def's pure `pointerToCanvasCoord` and calls `setCursor`
  // directly; `enableMouse` is never called from anywhere in the tree.
  //
  // ⚠ THE CURSOR WRITE SITS ABOVE THE `previewCollapsed` BRANCH, deliberately.
  // `player.isMoving` latches ONLY through `setCursor`, so a write path routed
  // through the paint would make SCREEN OFF a play kill switch on an unpatched
  // rack — different in kind from the producer kill switch it is not. The draw
  // loop reads the node EVERY frame and skips only the paint; the pointer
  // handlers consult `cvDriven` and nothing else.
  //
  // ⚠ CV OVERRIDES THE MOUSE, read off THE NODE'S OWN SNAPSHOT rather than the
  // `window.__skifree` bridge. They carry the same value — `tickFn` assigns
  // both from one `cvDriven` local — but the bridge is a single un-keyed
  // global that `skifree-bridge.ts` calls "a distinct defect… do not mistake
  // this file for having solved it", and a surface has no reason to reach for
  // it when the engine read it already makes is node-scoped.
  //
  // ⚠ NO DISTANCE / LIVES / MODE ROW. The card painted `{distance}m · lives {n}
  // · CV|MOUSE|IDLE · GAME OVER` as DOM chrome beside the canvas: a
  // measurement, a count, a state word and a status banner, none of which is a
  // module name, a section label, a control caption or an option name. The
  // resting-text ruling DELETES that row rather than relocating it. What
  // survives: the numbers the bundle's own InfoBox paints INSIDE the picture
  // (the game's artwork, and allowed), the same values on this frame's
  // `aria-label`, and the control mode as two `StatusLed` lamps whose captions
  // are static and whose sentence is on the lamp's own accessible name.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import { StatusLed } from '$lib/ui/controls';
  import {
    pointerToCanvasCoord,
    type SkifreeController,
    type SkifreeSnapshot,
  } from '$lib/audio/modules/skifree';
  import type { ModuleNode } from '$lib/graph/types';

  interface Props {
    /** The graph node this surface is showing — the extension slot's only prop. */
    nodeId: string;
    /** The slope's CSS size, in px. Square: the game canvas is square. */
    size: number;
    /** May the pointer steer here? TRUE on the dock body, FALSE on the lane
     *  tile — a 104 px picture is a glance, not an instrument, and two
     *  simultaneously-mounted steering surfaces for one node would fight over
     *  one cursor. */
    steerable?: boolean;
    /** Does this surface carry the SCREEN switch? The dock does; the tile does
     *  not (it has no room, and the dock is one click away). */
    screenToggle?: boolean;
    /** Testid namespace. The lane tile and the dock body can be MOUNTED AT THE
     *  SAME TIME, so they must not share testids. */
    testidPrefix: string;
  }
  let { nodeId, size, steerable = false, screenToggle = false, testidPrefix }: Props = $props();

  /** The destination backing store. Fixed rather than read from
   *  `devicePixelRatio`, so the picture this component paints does not change
   *  shape with the display — the SOURCE size is the only DPR-dependent number
   *  in the blit, and the nine-argument draw absorbs it. */
  const DPR = 2;

  const engineCtx = useEngine();

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let snapshot = $state<SkifreeSnapshot | null>(null);
  /** Has the pointer taken the controls on THIS surface? Component-local by
   *  design: it is per-viewer, per-surface performance state with no meaning to
   *  a collaborator, so it must not ride the Y.Doc. */
  let armed = $state(false);

  let rafId: number | null = null;

  // ⚠ STATE LIVES ON THE NODE. A `$state` here dies with the component, and
  // this component unmounts on a dock collapse / LRU eviction — the
  // card-unmount-kills-node-lifetime-state class (#1531 / #1574 / #1583).
  // Absent => false => ON, so an existing rack opens unchanged.
  //
  // ⚠ `nodeVersion(nodeId)` IS THE DEPENDENCY, AND IT IS LOAD-BEARING ON THIS
  // COMPONENT SPECIFICALLY, because this is the first shared surface mounted in
  // BOTH the dock and the xyflow LANE subtree. A bare
  // `patch.nodes[id]?.data?.previewCollapsed` derived is reactive in a
  // faceplate body — every other body in the tree writes exactly that — and is
  // NOT reactive inside xyflow's `NodeWrapper`, where the reactive source is
  // the `data.node` prop Canvas rebuilds. MEASURED, not predicted: the first
  // run of `skifree-face.spec.ts` had the DOCK slope vanish on SCREEN OFF while
  // the LANE tile kept painting, with the graph correct underneath.
  //
  // ⚠ AND THE OBVIOUS FIX IS THE WRONG ONE. Passing the enclosing `data` object
  // down moves the bug one level up and breaks the BODY instead:
  // `patch.nodes[id].data` is a Y-backed proxy whose identity never changes, so
  // a derived that stops at `.data` has no dependency on anything inside it.
  // The per-node version signal is a `SvelteMap` key that both subtrees can
  // see, which is why `ModuleShell`'s own `liveCell` is built the same way.
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

  /** The NODE's own game handle, through the engine — never the un-keyed
   *  `window.__skifree` global. */
  function nodeController(): SkifreeController | null {
    const eng = engineCtx.get();
    const node = patch.nodes[nodeId] as ModuleNode | undefined;
    if (!eng || !node) return null;
    return (eng.read(node, 'controller') as SkifreeController | undefined) ?? null;
  }

  let cvDriven = $derived(snapshot?.cvDriven === true);
  let gameReady = $derived(snapshot?.gameCreated === true);
  let bundleError = $derived(snapshot?.bundleError ?? null);
  /** Is the pointer actually driving right now? ARMED is not enough — a patched
   *  CV takes the cursor back the moment it goes non-zero. */
  let mouseDriving = $derived(steerable && armed && !cvDriven);

  // ── THE SPEAKABLE HALF OF A PAINTED HUD ────────────────────────────────────
  // The bundle's InfoBox paints distance and lives INTO the canvas, which a
  // screen reader cannot reach at all. This is where those numbers become
  // speakable — an `aria-label` on a frame, never a text node.
  let ariaLabel = $derived.by(() => {
    const s = snapshot;
    if (!s) return 'SKIFREE slope';
    if (s.bundleError) return `SKIFREE — the game bundle failed to load: ${s.bundleError}`;
    if (!s.gameCreated) return 'SKIFREE — loading the slope';
    const steer = s.cvDriven
      ? 'steered by CV'
      : (mouseDriving ? 'steered by the mouse' : 'idle — click the slope to steer');
    const over = s.gameOver ? ', game over' : '';
    return `SKIFREE — ${Math.round(s.distance)} metres, ${s.lives} lives, ${steer}${over}`;
  });

  /**
   * Write the cursor from a pointer position.
   *
   * ⚠ NOT GATED ON `previewCollapsed`, and see the header for why: `setCursor`
   * is the only thing that latches `player.isMoving`, so routing it through the
   * paint would make the SCREEN switch stop the game on an unpatched rack.
   */
  function writeCursor(e: PointerEvent | MouseEvent): void {
    if (!steerable || cvDriven) return;
    const el = canvasEl;
    const ctl = nodeController();
    if (!el || !ctl) return;
    const r = el.getBoundingClientRect();
    ctl.setCursor(
      pointerToCanvasCoord(e.clientX, r.left, r.width),
      pointerToCanvasCoord(e.clientY, r.top, r.height),
    );
  }

  /** CLICK-TO-ARM. The card gated the mouse on FOCUS, which is not portable to
   *  a faceplate: a `tabindex` here would add a tab stop inside the plate, and
   *  Tab is the FLIP gesture. A pointer gesture is the honest equivalent, and
   *  it is also the safer one — an unconditional hover would let a mouse merely
   *  crossing the dock steer a skier whose crashes are patched into a rack. */
  function onPointerDown(e: PointerEvent): void {
    if (!steerable) return;
    armed = true;
    writeCursor(e);
  }
  function onPointerMove(e: PointerEvent): void {
    if (!armed) return;
    writeCursor(e);
  }
  /** Leaving the picture drops the controls — the blur half of the card's
   *  focus/blur pair, expressed as a pointer event. */
  function onPointerLeave(): void {
    armed = false;
  }

  function draw(): void {
    rafId = null;
    const eng = engineCtx.get();
    const node = patch.nodes[nodeId] as ModuleNode | undefined;
    if (eng && node) {
      const snap = eng.read(node, 'snapshot') as SkifreeSnapshot | undefined;
      // ⚠ READ FIRST, PAINT SECOND. The engine read and the accessible name
      // track the game even while the screen is off; the collapse skips the
      // BLIT and nothing else.
      if (snap) snapshot = snap;
      if (!previewCollapsed && canvasEl) {
        const src = nodeController()?.canvas;
        const dst = canvasEl;
        if (src && src.width > 0 && src.height > 0) {
          const c2d = dst.getContext('2d');
          if (c2d) {
            c2d.imageSmoothingEnabled = false;
            try {
              // ⚠ NINE ARGUMENTS, DESTINATION DERIVED FROM THE SOURCE. See the
              // header: the bundle re-sizes the canvas it is handed by
              // `devicePixelRatio`, so the source is 640x640 on a retina display
              // and 320x320 elsewhere, and a 3-argument draw crops.
              c2d.drawImage(src, 0, 0, src.width, src.height, 0, 0, dst.width, dst.height);
            } catch (_e) { /* detached/tainted this frame — keep the last image */ }
          }
        }
      }
    }
    rafId = requestAnimationFrame(draw);
  }

  // ONE place owns the loop, so it cannot be started twice.
  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });
</script>

<div class="skifree-screen" data-testid="{testidPrefix}-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <!-- ⚠ THE ROLE SPLITS ON `steerable`, and it is not cosmetic. The dock
           slope OWNS its pointer handling, which is what `application` is for;
           the lane tile is a picture of a game and nothing more. Neither takes
           a `tabindex`: Tab is the faceplate FLIP gesture and there is no
           keyboard steering to expose. -->
      {#if steerable}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions
             — `role="application"` is exactly right for a surface that owns its
             own pointer handling; Svelte's rules do not model it as
             interactive. -->
        <div
          class="slope-frame nodrag"
          role="application"
          aria-label={ariaLabel}
          data-armed={mouseDriving ? 'true' : 'false'}
          data-testid="{testidPrefix}-slope"
          onpointerdown={onPointerDown}
          onpointermove={onPointerMove}
          onpointerleave={onPointerLeave}
          onpointercancel={onPointerLeave}
        >
          <canvas
            bind:this={canvasEl}
            width={size * DPR}
            height={size * DPR}
            style={`width: ${size}px; height: ${size}px;`}
            data-viz-passthrough
            data-testid="{testidPrefix}-canvas"
          ></canvas>
        </div>
      {:else}
        <div class="slope-frame" role="img" aria-label={ariaLabel} data-testid="{testidPrefix}-slope">
          <canvas
            bind:this={canvasEl}
            width={size * DPR}
            height={size * DPR}
            style={`width: ${size}px; height: ${size}px;`}
            data-viz-passthrough
            data-testid="{testidPrefix}-canvas"
          ></canvas>
        </div>
      {/if}

      <!-- ⚠ THE FAILURE COMES OFF THE NODE'S SNAPSHOT. This surface does not
           load the bundle, so it cannot know why a load failed — and a
           permanent "Loading…" is indistinguishable from a slow network to
           anyone actually using it. Both are TRANSIENT states naming the
           surface's own condition (the samsloop NO SAMPLE LOADED shape), each
           replaced the moment a game exists. -->
      {#if bundleError}
        <div class="skifree-overlay err" data-testid="{testidPrefix}-load-error">
          Bundle failed: {bundleError}
        </div>
      {:else if !gameReady}
        <div class="skifree-overlay" data-testid="{testidPrefix}-loading">Loading…</div>
      {/if}
    {/if}

    {#if screenToggle}
      <button
        type="button"
        class="screen-btn nodrag"
        class:on={!previewCollapsed}
        onclick={togglePreview}
        data-testid="{testidPrefix}-screen-toggle"
        aria-pressed={!previewCollapsed}
        title="SCREEN: turn the slope off to reclaim its space. The game keeps playing, the GATE keeps pulsing on every crash and the video OUT keeps carrying the slope."
      >SCREEN {previewCollapsed ? 'OFF' : 'ON'}</button>
    {/if}
  </div>

  <!-- ⚠ TWO LAMPS, NOT ONE THREE-WAY WORD. `StatusLed`'s caption is STATIC by
       contract, so `CV | MOUSE | IDLE` cannot be a caption — that is the
       deleted state-word shape with a lamp drawn next to it. Two static
       captions whose LIT state carries the answer is the primitive's own form:
       both dark IS idle, and the sentence lives on each lamp's accessible
       name. -->
  <div class="modes" data-testid="{testidPrefix}-modes">
    <StatusLed
      caption="CV"
      lit={cvDriven}
      detail={cvDriven
        ? 'a patched CV is writing the cursor; it overrides the mouse'
        : 'nothing is patched into X or Y'}
      testid="{testidPrefix}-mode-cv"
    />
    <StatusLed
      caption="MOUSE"
      lit={mouseDriving}
      detail={mouseDriving
        ? 'the pointer is steering the skier on this surface'
        : (cvDriven
          ? 'CV has the cursor, so the mouse is inactive'
          : 'click the slope to steer with the mouse')}
      testid="{testidPrefix}-mode-mouse"
    />
  </div>
</div>

<style>
  .skifree-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 4px 0 2px;
  }
  /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT — it overlays the picture's
     bottom-right corner, so the body is exactly the height the picture is
     (the FroggerBoardBody measurement). */
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF: the canvas is gone, and without a
       floor the wrap would collapse to zero and take the absolutely-positioned
       button with it. Inert behind the canvas whenever the slope shows. */
    min-height: 18px;
  }
  .slope-frame { display: block; line-height: 0; }
  .preview-wrap canvas {
    display: block;
    /* Pixel art from 1991. Never smooth it. */
    image-rendering: pixelated;
    border: 1px solid color-mix(in oklab, var(--cable-gate) 30%, transparent);
    border-radius: 2px;
    background: #cfe8ff; /* snow-white-blue idle */
    max-width: 100%;
  }
  /* The focus ring the card had on `canvas:focus`, re-expressed for the gesture
     that replaced focus: the frame lights while the pointer holds the
     controls. */
  .slope-frame[data-armed='true'] canvas { border-color: var(--cable-gate); }
  .skifree-overlay {
    position: absolute;
    top: 10px;
    left: 10px;
    right: 10px;
    background: rgba(0, 0, 0, 0.7);
    color: #ffd040;
    padding: 5px 7px;
    border-radius: 2px;
    font-size: 10px;
    text-align: center;
    pointer-events: none;
  }
  .skifree-overlay.err { color: #ff5050; }
  .screen-btn {
    position: absolute;
    right: 4px;
    bottom: 4px;
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
  .screen-btn.on { color: var(--text); border-color: var(--accent-dim); }
  .screen-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
  .modes {
    display: flex;
    gap: 10px;
    align-items: center;
  }
</style>
