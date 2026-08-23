<script lang="ts">
  // packages/web/src/lib/ui/modules/pong/PongCourtBody.svelte
  //
  // The PONG dock full-view body: the COURT, plus the SCREEN ON/OFF switch.
  //
  // ⚠ THIS BODY IS NOT OPTIONAL CHROME — IT IS THE MODULE'S ONLY REMAINING
  // PICTURE. `drawPong` is a pure function that the legacy CARD called every rAF;
  // promotion stops both surfaces rendering that card, so without this slot a
  // faced pong would be three faders over an invisible game. The game itself runs
  // engine-side on the shared scheduler clock whether or not anything is mounted,
  // which is exactly why the picture can be lost without anything breaking.
  //
  // ⚠ AND THE LANE STILL HAS NO COURT. `hasVideoSurface` is `domain === 'video'`
  // and pong is audio, so there is no VideoTileThumb; `ShellExtension.glyph`
  // renders only under `binding.kind === 'algorithm'`, which needs an `algorithm`
  // param. That is a platform gap affecting five modules, prescribed in
  // `shell-glyph-live.ts`'s own comment, and NOT something this body can close.
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import { pongDef, drawPong, type PongState, type PongParams } from '$lib/audio/modules/pong';
  import { paramSpec } from '../card-kit';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets. */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  const pSpeed = paramSpec(pongDef, 'speed');
  const pPaddleH = paramSpec(pongDef, 'paddleH');
  const pServeAngle = paramSpec(pongDef, 'serveAngle');

  // ⚠ CSS PIXELS AND BACKING STORE ARE DIFFERENT NUMBERS, and conflating them is
  // a LIVE DEFECT ON THE LEGACY CARD that this body deliberately does not inherit.
  //
  // `PongDrawOpts` documents `paddleW` and `ballPx` in **CSS pixels** and defaults
  // them to 4 and 6. `PongCard.svelte` calls
  // `drawPong(ctx2d, snap, params, canvasEl.width, canvasEl.height)` — the
  // BACKING-STORE size, 2x the CSS size — and never applies `ctx.scale(DPR, DPR)`.
  // So on the card the ball renders at 3 CSS px, the paddles at 2, the centre dash
  // at 3 and the 14 px score font at SEVEN. Every def-reading gate is blind to it
  // and pong is EXEMPT_FROM_VRT, so no pixel test could ever have caught it.
  //
  // Here the transform carries the DPR and `drawPong` is handed CSS dimensions,
  // which is what its own contract asks for.
  const CSS_W = 320;
  const CSS_H = 224;
  const DPR = 2;

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // ⚠ STATE ON THE NODE, NOT IN THE COMPONENT — this component unmounts on dock
  // collapse / LRU eviction (#1531 / #1574 / #1583), and `node.data` is what
  // survives a tab switch, a remount, a reload and collab sync.
  let previewCollapsed = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.previewCollapsed as boolean | undefined) ?? false,
  );
  function togglePreview(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }

  function liveParams(): PongParams {
    const p = patch.nodes[nodeId]?.params ?? {};
    return {
      speed: (p.speed as number | undefined) ?? pSpeed.defaultValue,
      paddleH: (p.paddleH as number | undefined) ?? pPaddleH.defaultValue,
      serveAngle: (p.serveAngle as number | undefined) ?? pServeAngle.defaultValue,
    };
  }

  // ⚠ NO WATCH MARK HERE, AND THAT IS CORRECT RATHER THAN AN OMISSION. The other
  // faced bodies call `markWatched` because their picture is a VIDEO ENGINE
  // surface pulled only while something watches. Pong is an AUDIO module: the game
  // is stepped by the shared scheduler clock, which ticks regardless of what is
  // mounted, and this body only READS `eng.read(node, 'snapshot')`. So SCREEN OFF
  // stops a repaint and nothing else — the rally continues and the score gates go
  // on firing, which is the behaviour the ruling asks for, reached by a different
  // mechanism. Do not copy a `markWatched` call in from a video body; there is no
  // pull set to stay in.
  function draw(): void {
    rafId = null;
    if (previewCollapsed || !canvasEl) { rafId = requestAnimationFrame(draw); return; }
    // ⚠ `read` TAKES THE NODE, NOT THE ID. PongCard calls
    // `eng.read(node, 'snapshot')`; passing the id string instead type-errors AND
    // would silently paint nothing — an empty court that looks exactly like a game
    // that has not started. svelte-check caught it; no unit test would have.
    const e = engineCtx.get();
    const node = patch.nodes[nodeId];
    const snap = e && node ? (e.read(node, 'snapshot') as PongState | undefined) : undefined;
    const ctx2d = canvasEl.getContext('2d');
    if (ctx2d && snap) {
      // Reset then apply DPR, so repeated frames do not compound the transform.
      ctx2d.setTransform(DPR, 0, 0, DPR, 0, 0);
      drawPong(ctx2d, snap, liveParams(), CSS_W, CSS_H);
    }
    rafId = requestAnimationFrame(draw);
  }

  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });
</script>

<div class="pong-output" data-testid="pong-output-body">
  <div class="court-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <canvas
        bind:this={canvasEl}
        width={CSS_W * DPR}
        height={CSS_H * DPR}
        style="width:{CSS_W}px;height:{CSS_H}px"
        data-testid="pong-face-canvas"
        data-node-id={nodeId}
      ></canvas>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="pong-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the court is collapsed and its space reclaimed. The GAME KEEPS PLAYING: it is stepped by the shared scheduler clock, so the rally continues and the score outputs go on firing.'
        : 'SCREEN — turn the court off to collapse it and reclaim the vertical space. The game plays on either way.'}
    >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
  </div>
</div>

<style>
  .pong-output {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT — a measurement, not a taste. A stacked
     row cost spirographs ~18.8 px against ~11 px of slack and overhung its card by
     7.8 CSS px against a tolerance of 6. It OVERLAYS the court's bottom-right
     corner, so the body is exactly the height the court is. */
  .court-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF: the canvas is gone, and without a floor
       the wrap collapses to zero and takes the absolutely-positioned button with
       it. Inert behind the canvas whenever the court shows. */
    min-height: 18px;
  }
  .court-wrap canvas {
    display: block;
    border-radius: 3px;
    background: #05070a;
    max-width: 100%;
  }
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
</style>
