<script lang="ts">
  // packages/web/src/lib/ui/modules/painter/PainterEditorBody.svelte
  //
  // PAINTER's `fullViewBody` — the MS-Paint editor itself, at the head of the
  // module's dock faceplate.
  //
  // ── WHY THIS FILE HAS TO EXIST ──────────────────────────────────────────
  //
  // `painterDef.params` is `[]` and `inputs` is `[]`. The module has exactly
  // one affordance and it is a POINTER ON A CANVAS, so `face.order` ranks
  // nothing and the faceplate has no bands at all. Promotion sets
  // `migrated('painter')` true and from that moment neither surface renders
  // `PainterCard.svelte` — so without this slot a promoted painter would be a
  // module that cannot be drawn on. Not a preview being rescued: the whole
  // instrument.
  //
  // ── ⚠ THIS IS THE LIVE SURFACE, NOT A PREVIEW OF ONE ────────────────────
  //
  // The engine frame is this canvas, 1:1. While this body is mounted it CLAIMS
  // the node's extras binding (`nodeExtras.claim`) and pushes its own canvas,
  // because an in-progress stroke must appear on `out` BEFORE the op commits.
  // On unmount — and on SCREEN OFF, which unmounts the canvas — it RELEASES,
  // and `$lib/ui/media/extras-producers`' node-lifetime producer immediately
  // re-pushes its own replay of the same log. Both surfaces replay the SAME
  // deterministic `node.data.ops`, so the lease changes WHICH canvas is bound
  // and never WHAT is on it (#1720; the release path is owner-checked inside
  // the registry, so a stale unmount cannot revoke a live claim).
  //
  // ⚠ THE GESTURE ARITHMETIC IS NOT HERE. Every pointer -> `PaintOp`
  // conversion is `./paint-surface`, imported by this body AND by
  // `PainterCard.svelte`. A stroke drawn on the face and the same stroke drawn
  // on the card must serialise identically or the two surfaces paint different
  // pictures on every peer, and the op log is valid either way so nothing would
  // notice. One seam, two mounts.
  //
  // ⚠ IT MUST STAY 2-D. `painter.ts` is inside the WebGL attest basis and this
  // file is deliberately outside it — but `resolveWebglBasis()` sweeps
  // `lib/ui/modules/**/*.svelte` BY CONTENT, so a `getContext('webgl')` here
  // would enrol it permanently and put every future face edit on the real-GPU
  // attest critical path.
  //
  // ⚠ THE CANVAS IS ENGINE-RESOLUTION AND FIXED AT 4:3 (1024x768), shown
  // scaled. That is the shipped card's limitation carried verbatim, not a new
  // one: a 16:9 engine (1366x768) still gets a 4:3 drawing buffer letterboxed
  // by the shader. Fixing it is a DSP-adjacent behaviour change and does not
  // belong in a face PR.

  import { untrack } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import { nodeExtras } from '$lib/ui/media/node-extras';
  import type { ExtrasLease } from '$lib/ui/media/node-extras-registry';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { PainterHandleExtras } from '$lib/video/modules/painter';
  import {
    appendOp,
    clearOps,
    coerceOps,
    popOp,
    DEFAULT_BRUSH,
    DEFAULT_FG,
    MAX_BRUSH,
    MIN_BRUSH,
    PAINT_BG,
    WIN95_PALETTE,
    type OpLogData,
    type PaintOp,
    type Tool,
  } from '$lib/video/modules/painter-draw';
  import {
    applyOpToCanvas,
    fillOpFor,
    gestureKindFor,
    PAINT_TOOLS,
    pickColorAt,
    pointerToCanvas,
    replayPaintOps,
    shapeOpFor,
    strokeOpFor,
    textOpFor,
    type PaintToolState,
  } from './paint-surface';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  // v1 sizes to the 4:3 default; see the header.
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;

  // ── LOCAL tool state (per collaborator — NOT synced) ─────────────────────
  // Only the DRAWING syncs. Painting another peer's active tool out from under
  // them would be a multiplayer regression, which is also why none of these is
  // a face cell.
  let tool = $state<Tool>('pencil');
  let fg = $state(DEFAULT_FG);
  let bg = $state(PAINT_BG);
  let brush = $state(DEFAULT_BRUSH);
  let fillShapes = $state(false);
  let textValue = $state('TEXT');

  function tools(): PaintToolState {
    return { tool, fg, bg, brush, fillShapes, text: textValue };
  }

  // ── SCREEN ON / OFF ──────────────────────────────────────────────────────
  //
  // ⚠ LEAF READ, NOT `$derived(f(node))`. A Yjs node proxy's identity never
  // changes, so a derived over the NODE object never recomputes — the graph
  // moves and the UI is frozen. Reading `.data.previewCollapsed` subscribes to
  // the key that actually moves.
  //
  // ⚠ STATE ON THE NODE, NOT IN THIS COMPONENT. This body unmounts on dock
  // collapse / LRU eviction (the #1531 / #1574 / #1583 class), and `node.data`
  // survives a tab switch, a remount, a reload and collab sync. Absent => false
  // => ON, so an existing rack opens unchanged.
  //
  // ⚠ WHAT OFF MEANS HERE, AND WHY IT IS THE HONEST READING OF THE RULING.
  // On every other video face the picture is a PREVIEW beside the controls, so
  // OFF reclaims a screen. Here the picture IS the instrument, so OFF puts the
  // whole paint set away — toolbar, canvas and palette together — which is what
  // actually reclaims the space; leaving a toolbar behind with nothing to draw
  // on would be chrome for a surface that is gone. The output is UNAFFECTED:
  // the release below hands the binding straight back to the node-lifetime
  // producer, so `out` goes on carrying the drawing, and the watch mark keeps
  // being renewed (see `tick`).
  //
  // ⚠ AND IT IS RECOVERABLE FROM EITHER SIDE, which is the answer to the one
  // objection this switch attracts: `previewCollapsed` is Y.Doc-synced, so a
  // collaborator flipping it OFF collapses the editor for every peer. The
  // SCREEN button is rendered OUTSIDE the collapse (asserted by the shared
  // face-screen-render suite: "the toggle survives its own OFF state"), so any
  // peer turns it back on with one click. The alternative — a
  // `NO_SCREEN_SWITCH` exemption — would deny the module the fleet affordance
  // outright to prevent a state that undoes itself.
  let previewCollapsed = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.previewCollapsed as boolean | undefined) ?? false,
  );
  function toggleScreen(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }

  // ── The op log (node.data.ops, Y.Doc-synced) ─────────────────────────────
  function readOps(): PaintOp[] {
    return coerceOps((patch.nodes[nodeId]?.data as { ops?: unknown } | undefined)?.ops);
  }

  /** Persist a committed op. Mutates `live.data.ops` IN PLACE via `appendOp` —
   *  slicing + reassigning an array holding live (integrated) Y objects throws
   *  on the 2nd+ op ([[yjs-save-load-real-ydoc]]), which used to silently drop
   *  every paint after the first. The local canvas is already drawn; this
   *  persists and syncs it. */
  function commitOp(op: PaintOp): void {
    mutateNode(nodeId, (live) => appendOp(live.data as OpLogData, op));
  }
  function undo(): void {
    mutateNode(nodeId, (live) => popOp(live.data as OpLogData));
  }
  function clearAll(): void {
    mutateNode(nodeId, (live) => clearOps(live.data as OpLogData));
  }

  // ── The canvas ───────────────────────────────────────────────────────────
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let ctx2d: CanvasRenderingContext2D | null = null;
  let isDrawing = false;

  /** Full repaint from the synced log. Guarded so a remote edit landing
   *  mid-drag never wipes the stroke under the player's hand. */
  function syncFromOps(): void {
    if (!ctx2d || isDrawing) return;
    replayPaintOps(ctx2d, readOps(), ENGINE_W, ENGINE_H);
  }

  // ⚠ SETUP LIVES IN AN `$effect` KEYED ON `canvasEl`, NOT IN `onMount`, and
  // that is load-bearing rather than stylistic. The `{#if !previewCollapsed}`
  // above DESTROYS and RECREATES the element on every SCREEN cycle; `onMount`
  // does not re-run, so the sizing, the 2-D context and the engine binding
  // would all stay pointed at a detached canvas — a blank editor, strokes into
  // nowhere, and ops still committing. Re-running on the ELEMENT is what makes
  // the collapse survivable at all.
  //
  // ⚠ AND THE LEASE FOLLOWS THE ELEMENT. On teardown it is RELEASED, which
  // re-pushes the node-lifetime producer's own replay canvas immediately, so
  // `out` never reverts to the white placeholder. There is deliberately no
  // `setPaintCanvas(null)` here — that IS the placeholder bug.
  let extrasLease: ExtrasLease | null = null;
  let bindRetry: ReturnType<typeof setTimeout> | null = null;

  /** The lease OWNER token. One per component instance, so the registry's
   *  owner-check can tell this body's release from another surface's. */
  const leaseHolder = {};

  function paintExtras(): PainterHandleExtras | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      const ve = e.getDomain<VideoEngine>('video');
      return (ve.read(nodeId, 'extras') as PainterHandleExtras | undefined) ?? null;
    } catch {
      return null;
    }
  }

  /** Bind this canvas to the engine module, retrying while the reconciler has
   *  not built the node yet (the patch-LOAD race every extras consumer pays). */
  function bindCanvas(el: HTMLCanvasElement, attempt = 0): void {
    const extras = paintExtras();
    if (!extras) {
      if (attempt >= 50) return;
      if (bindRetry) clearTimeout(bindRetry);
      bindRetry = setTimeout(() => {
        bindRetry = null;
        if (canvasEl === el) bindCanvas(el, attempt + 1);
      }, 100);
      return;
    }
    extras.setPaintCanvas(el);
  }

  $effect(() => {
    const el = canvasEl;
    if (!el) return;
    untrack(() => {
      el.width = ENGINE_W;
      el.height = ENGINE_H;
      ctx2d = el.getContext('2d');
      if (ctx2d) replayPaintOps(ctx2d, readOps(), ENGINE_W, ENGINE_H);
      extrasLease = nodeExtras.claim(nodeId, leaseHolder);
      bindCanvas(el);
    });
    return () => {
      if (bindRetry) { clearTimeout(bindRetry); bindRetry = null; }
      ctx2d = null;
      isDrawing = false;
      extrasLease?.release();
      extrasLease = null;
    };
  });

  // Re-sync whenever the synced log changes (local commit, remote edit, undo,
  // clear). `readOps` ITERATES the live array inside this effect, which is what
  // subscribes to a push — reading the `.ops` property alone would not.
  $effect(() => {
    const ops = (patch.nodes[nodeId]?.data as { ops?: unknown } | undefined)?.ops;
    void ops;
    syncFromOps();
  });

  // ── The watch mark ───────────────────────────────────────────────────────
  //
  // ⚠ ONE rAF FOR THE COMPONENT'S WHOLE LIFETIME, AND IT RENEWS THE MARK IN
  // BOTH SCREEN STATES. There is no blit to skip here — this canvas IS the
  // source, not a copy of the output — so the loop's only job is to keep the
  // node a PULL ROOT while a player is looking at it.
  //
  // It is not decoration: the surface the player draws on is NOT the surface
  // the engine samples. The engine picks up these pixels inside `surface.draw`,
  // and `computePullActiveSet` skips an unwatched, side-effect-free node
  // entirely — painter is texture-only, so it is skippable by construction.
  // With the lane tile scrolled out from under the open dock its
  // `setCardVisibility(false)` DEMOTES the mark, and every stroke made after
  // that would sit on this canvas without ever reaching `out`. Renewing here
  // makes "the dock is open on this module" an observation in its own right.
  let rafId: number | null = null;
  function tick(): void {
    rafId = null;
    const e = engineCtx.get();
    if (e) {
      try {
        e.getDomain<VideoEngine>('video').markWatched?.(nodeId);
      } catch {
        /* engine not ready / no video domain — never nuke the loop */
      }
    }
    rafId = requestAnimationFrame(tick);
  }
  $effect(() => {
    untrack(() => { if (rafId === null) rafId = requestAnimationFrame(tick); });
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });

  // ── Pointer drawing ──────────────────────────────────────────────────────
  let strokePts: number[] = [];
  let startX = 0;
  let startY = 0;
  /** Snapshot of the committed picture, so a shape DRAG can preview without
   *  corrupting what is already there. */
  let committed: HTMLCanvasElement | null = null;

  function snapshotCommitted(): void {
    if (!canvasEl) return;
    if (!committed) committed = document.createElement('canvas');
    committed.width = ENGINE_W;
    committed.height = ENGINE_H;
    committed.getContext('2d')?.drawImage(canvasEl, 0, 0);
  }
  function restoreCommitted(): void {
    if (!ctx2d || !committed) return;
    ctx2d.clearRect(0, 0, ENGINE_W, ENGINE_H);
    ctx2d.drawImage(committed, 0, 0);
  }

  function onPointerDown(e: PointerEvent): void {
    if (!ctx2d || !canvasEl) return;
    // Guarded for the same reason `controls/Button.svelte` is: the capture sits
    // in front of the whole gesture switch below, so an unguarded throw would
    // swallow the stroke, the fill and the colour pick alike — the surface
    // would take the press and paint nothing. `?.` guards a MISSING method, not
    // a rejected pointer, which is the case that actually happens.
    try { canvasEl.setPointerCapture?.(e.pointerId); } catch { /* not capturable */ }
    const [x, y] = pointerToCanvas(canvasEl, e.clientX, e.clientY);
    startX = x;
    startY = y;

    switch (gestureKindFor(tool)) {
      case 'pick': {
        const hex = pickColorAt(ctx2d, x, y);
        if (hex) fg = hex;
        return;
      }
      case 'fill': {
        const op = fillOpFor(tools(), x, y);
        applyOpToCanvas(ctx2d, op, ENGINE_W, ENGINE_H);
        commitOp(op);
        return;
      }
      case 'text': {
        const op = textOpFor(tools(), x, y);
        if (!op) return;
        applyOpToCanvas(ctx2d, op, ENGINE_W, ENGINE_H);
        commitOp(op);
        return;
      }
      case 'stroke': {
        isDrawing = true;
        strokePts = [x, y];
        applyOpToCanvas(ctx2d, strokeOpFor(tools(), strokePts), ENGINE_W, ENGINE_H);
        return;
      }
      default: {
        isDrawing = true;
        snapshotCommitted();
      }
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (!isDrawing || !ctx2d || !canvasEl) return;
    const [x, y] = pointerToCanvas(canvasEl, e.clientX, e.clientY);
    if (gestureKindFor(tool) === 'stroke') {
      strokePts.push(x, y);
      // Redraw the whole stroke — cheap, and it keeps the round joins smooth.
      applyOpToCanvas(ctx2d, strokeOpFor(tools(), strokePts), ENGINE_W, ENGINE_H);
      return;
    }
    restoreCommitted();
    applyOpToCanvas(ctx2d, shapeOpFor(tools(), startX, startY, x, y), ENGINE_W, ENGINE_H);
  }

  function onPointerUp(e: PointerEvent): void {
    if (!isDrawing || !canvasEl) return;
    isDrawing = false;
    const [x, y] = pointerToCanvas(canvasEl, e.clientX, e.clientY);
    if (gestureKindFor(tool) === 'stroke') {
      if (strokePts.length === 0) strokePts = [startX, startY];
      commitOp(strokeOpFor(tools(), strokePts));
      strokePts = [];
      return;
    }
    commitOp(shapeOpFor(tools(), startX, startY, x, y));
  }

  // The palette: left-click sets the FOREGROUND, right-click the BACKGROUND.
  // ⚠ RIGHT-CLICK IS THE ONLY WAY TO SET THE BACKGROUND ON EITHER SURFACE, and
  // the background is what the ERASER paints and what FILLED shapes are filled
  // with — so it is a control, not a shortcut. `preventDefault` on the canvas
  // and on each swatch keeps the browser menu out of the gesture.
  function pickFg(hex: string): void { fg = hex; }
  function pickBg(e: Event, hex: string): void { e.preventDefault(); bg = hex; }

  /** The accessible name for the drawing surface. The op COUNT is a derived
   *  measurement, so it lives here and is never painted as resting text (the
   *  GAMES.md in-canvas ruling: what the USER paints is the module's artwork,
   *  what the FACE paints is chrome). */
  let strokeCount = $derived(readOps().length);
</script>

<div class="pt-body" data-testid="painter-face-body">
  {#if !previewCollapsed}
    <!-- ⚠ TWO ROWS, AND THE SPLIT IS A LAYOUT CONSTRAINT RATHER THAN TASTE.
         `.faceplate-body` is `width: max-content`, and a WRAPPING flex row's
         max-content is its UN-wrapped sum — so a single toolbar row would set
         the plate's width from the chrome (measured: 614 CSS px) and leave
         empty plate beside a canvas that did not ask for it. Split, each row's
         max-content is under the canvas's own width, so the PICTURE is what
         earns the plate — which is the compact ruling's own list. -->
    <div class="toolbar nodrag" data-testid="painter-face-toolbar">
      <div class="row">
        <div class="tools">
          {#each PAINT_TOOLS as t (t.id)}
            <button
              type="button"
              class="tool"
              class:active={tool === t.id}
              title={t.label}
              aria-label={t.label}
              aria-pressed={tool === t.id}
              data-testid={`painter-face-tool-${t.id}`}
              onclick={() => (tool = t.id)}
            >{t.glyph}</button>
          {/each}
        </div>

        <label class="opt" title="Brush / line size">
          <span class="lbl">SIZE</span>
          <input
            type="range" class="nodrag" min={MIN_BRUSH} max={MAX_BRUSH} step="1" value={brush}
            aria-label="brush size"
            data-testid="painter-face-size"
            oninput={(e) => (brush = Number((e.currentTarget as HTMLInputElement).value))} />
        </label>

        <label class="opt chk" title="Fill rectangles / ellipses with the background colour">
          <input
            type="checkbox" class="nodrag" checked={fillShapes}
            data-testid="painter-face-fill-shapes"
            onchange={(e) => (fillShapes = (e.currentTarget as HTMLInputElement).checked)} />
          <span class="lbl">FILL</span>
        </label>
      </div>

      <div class="row">
        <!-- The TEXT tool's stamp string.
             ⚠ IT IS IN THIS FILE RATHER THAN IN A SHARED CHILD ON PURPOSE:
             `face-migration-inventory`'s typed-entry leg reads the
             DIRECTLY-NAMED fullViewBody source, so an <input> hidden inside an
             imported component would read as "the face carries none" and the
             promotion would redden — with the affordance present and working.
             ⚠ AND IT IS TOOL-GATED, exactly as the card has it: the field does
             nothing at all unless TEXT is the active tool, and a control that
             cannot act is the dead-control shape this program keeps deleting. -->
        {#if tool === 'text'}
          <input
            type="text" class="text-input nodrag" value={textValue}
            placeholder="text to stamp"
            aria-label="text to stamp"
            data-testid="painter-face-text-input"
            oninput={(e) => (textValue = (e.currentTarget as HTMLInputElement).value)} />
        {/if}

        <div class="actions">
          <button type="button" class="act" data-testid="painter-face-undo"
            title="Undo — remove the last committed op" onclick={undo}>↶ UNDO</button>
          <button type="button" class="act" data-testid="painter-face-clear"
            title="Clear the canvas back to a blank white page" onclick={clearAll}>CLEAR</button>
        </div>
      </div>
    </div>

    <!-- ⚠ role="img" SITS ON THE FRAME, NOT ON THE <canvas>, which is the
         frogger/skifree shape: the canvas carries the pointer handlers, and
         svelte-check refuses event handlers on an element wearing a
         non-interactive role. The op COUNT is a derived measurement, so it
         reaches the a11y tree here and is never painted as a chrome row (the
         "N ops / synced" status line is refused by name). -->
    <div class="canvas-wrap nodrag" role="img" aria-label={`painter canvas — ${strokeCount} ops`}>
      <canvas
        bind:this={canvasEl}
        class="paint"
        data-testid="painter-face-canvas"
        data-node-id={nodeId}
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        oncontextmenu={(e) => e.preventDefault()}
      ></canvas>
    </div>

    <div class="palette-row nodrag">
      <div class="current" title="Foreground (left-click a swatch) / background (right-click)">
        <span class="sw bg" style={`background:${bg}`}></span>
        <span class="sw fg" style={`background:${fg}`}></span>
      </div>
      <div class="palette" data-testid="painter-face-palette">
        {#each WIN95_PALETTE as c (c)}
          <button
            type="button"
            class="swatch"
            style={`background:${c}`}
            title={`${c} — left-click sets the foreground, right-click the background`}
            aria-label={`colour ${c}`}
            data-testid={`painter-face-swatch-${c}`}
            onclick={() => pickFg(c)}
            oncontextmenu={(e) => pickBg(e, c)}
          ></button>
        {/each}
      </div>
    </div>
  {/if}

  <div class="screen-row">
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      data-testid="painter-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the paint surface is put away and its space reclaimed. The drawing keeps playing out of OUT; switching it back on returns the editor.'
        : 'SCREEN — turn the paint surface off to collapse the editor and reclaim its space. The module goes on rendering the drawing either way.'}
      onclick={toggleScreen}
    >SCREEN {previewCollapsed ? 'OFF' : 'ON'}</button>
  </div>
</div>

<style>
  .pt-body {
    /* ⚠ ONE WIDTH FOR THE WHOLE EDITOR, AND THE CANVAS IS WHAT SETS IT. The
       dock plate is `width: max-content`, so whatever child is widest decides
       how much grey the player is handed; the compact ruling's gate measures
       the gap between the plate and the rightmost thing the face DRAWS. Naming
       the width once and giving it to the canvas, the toolbar rows and the
       palette makes the PICTURE the widest drawn element by construction —
       there is no arrangement of the chrome that can quietly out-grow it. 480
       is the 4:3 editing size the spec mock uses (360 tall). */
    --pt-w: 480px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 2px 0 4px;
    min-width: 0;
  }

  .toolbar {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: var(--pt-w);
  }
  .toolbar .row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .tools { display: flex; gap: 2px; }
  .tool {
    width: 26px;
    height: 24px;
    font-size: 0.82rem;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text);
    background: var(--control-bg, #1c1c22);
    border: 1px solid var(--border);
    border-radius: 3px;
    cursor: pointer;
    padding: 0;
  }
  .tool:hover { border-color: var(--accent-dim); }
  .tool.active { border-color: var(--accent); background: var(--accent-glow, #2a2a40); }

  .opt { display: inline-flex; align-items: center; gap: 4px; }
  .opt .lbl { font-size: 0.5rem; color: var(--text-dim); letter-spacing: 0.06em; }
  .opt input[type='range'] { width: 96px; }
  .opt.chk { gap: 3px; }

  .text-input {
    flex: 1 1 80px;
    min-width: 80px;
    height: 22px;
    font-size: 0.72rem;
    color: var(--text);
    background: var(--control-bg, #1c1c22);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0 6px;
  }

  .actions { display: flex; gap: 6px; margin-left: auto; }
  .act {
    height: 22px;
    padding: 0 8px;
    font-size: 0.62rem;
    letter-spacing: 0.04em;
    color: var(--text);
    background: var(--control-bg, #1c1c22);
    border: 1px solid var(--border);
    border-radius: 3px;
    cursor: pointer;
  }
  .act:hover { border-color: var(--accent-dim); }

  /* The editing surface, and the WIDEST THING THE FACE DRAWS — see `--pt-w`.
     A live picture is a width earner in the compact ruling's own list; a
     toolbar is not. */
  .canvas-wrap {
    width: var(--pt-w);
    border: 1px solid var(--border);
    background: var(--module-bg);
    box-shadow: inset 0 0 6px rgba(0, 0, 0, 0.35);
    line-height: 0;
    overflow: hidden;
  }
  .paint {
    display: block;
    width: 100%;
    height: auto;
    cursor: crosshair;
    touch-action: none;
    image-rendering: auto;
  }

  /* Spans the plate under the canvas, for the same reason — a 28-swatch grid
     stopping short of the picture it colours reads as a truncation. */
  .palette-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: var(--pt-w);
  }
  .current { position: relative; width: 28px; height: 28px; flex: 0 0 auto; }
  .current .sw {
    position: absolute;
    width: 18px;
    height: 18px;
    border: 1px solid #000;
    border-radius: 2px;
  }
  .current .bg { right: 0; bottom: 0; }
  .current .fg { left: 0; top: 0; }
  .palette { display: grid; grid-template-columns: repeat(14, 1fr); gap: 1px; flex: 1; min-width: 0; }
  .swatch {
    aspect-ratio: 1;
    border: 1px solid rgba(0, 0, 0, 0.5);
    border-radius: 0;
    cursor: pointer;
    padding: 0;
    min-width: 0;
  }
  .swatch:hover { outline: 1px solid var(--accent); outline-offset: -1px; }

  /* Outside the collapse — see the SCREEN note in the script. */
  .screen-row { display: flex; }
  .screen-btn {
    padding: 3px 8px;
    font-size: 0.62rem;
    letter-spacing: 0.04em;
    color: var(--vp-text, #c8cede);
    background: var(--vp-surface, #171b24);
    border: 1px solid var(--vp-border, #2a2f3a);
    border-radius: 3px;
    cursor: pointer;
  }
  .screen-btn:hover { border-color: var(--vp-accent, #4a90d9); }
  .screen-btn.on { color: var(--vp-accent, #4a90d9); border-color: var(--vp-accent, #4a90d9); }
</style>
