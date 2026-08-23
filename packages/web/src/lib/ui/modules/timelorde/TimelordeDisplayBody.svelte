<script lang="ts">
  // packages/web/src/lib/ui/modules/timelorde/TimelordeDisplayBody.svelte
  //
  // The TIMELORDE dock full-view body: the big display — the owner's owl
  // painting, beat-pulsing, or the live VIDEO IN feed — plus the SCREEN ON/OFF
  // switch.
  //
  // ⚠ THIS COMPONENT RENDERS NOTHING. It BLITS. The picture is composited by
  // `TimelordeCard`'s rAF and pushed into the node as an `ImageBitmap`
  // (`write(node,'displayFrame')`); `video_out`'s own `drawFrame` blits the
  // latest one. This body pulls that SAME `drawFrame` — so what the faceplate
  // shows and what a downstream video module receives are the same pixels by
  // construction, and the owl render, the colour-targeted beat boost, the
  // reduced-motion freeze and the live-monitor branch keep exactly ONE
  // implementation. Re-implementing the owl here would have been a second place
  // for the display to be wrong, in a module whose whole design tension is that
  // two different states look identical.
  //
  // ⚠ AND THE PRODUCER IS NOT THIS COMPONENT, WHICH INVERTS THE COLLAPSE RULE
  // FROM RASTERIZE'S. In rasterize the painter is advanced INSIDE
  // `read('imageData')`, so its body must read unconditionally or the module
  // freezes. Here the producer is the CARD — kept alive off-screen by
  // `<HeadlessSourceHost>` for the whole session — so it keeps compositing and
  // pushing whatever this body does. SCREEN OFF therefore costs a BLIT and
  // nothing else: `video_out` is unaffected, which is the owner's
  // "it KEEPS RENDERING while OFF" floor satisfied by construction rather than
  // by care. (It is also the failure this module was one careless edit away
  // from: the card's rAF is the SOLE writer of `displayFrame`, so a SCREEN
  // switch that stopped it would make a preview toggle into a producer kill
  // switch for every downstream module — the #1720/#1721 class.)
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { edgesVersion, nodesStructuralVersion, nodeVersion } from '$lib/graph/node-versions.svelte';
  import { useEngine } from '$lib/audio/engine-context';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  // The card composites at this size and pushes a bitmap of it; matching it here
  // keeps the blit 1:1 rather than a resample of a resample.
  const DISPLAY_W = 220;
  const DISPLAY_H = 220;

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // ⚠ STATE LIVES ON THE NODE, NOT IN THIS COMPONENT. A `$state` here dies with
  // the component, and this component unmounts on dock collapse / LRU eviction —
  // the card-unmount-kills-node-lifetime-state class (#1531 / #1574 / #1583).
  // `node.data` survives a tab switch (the owner's stated floor), a remount, a
  // reload, and syncs to collaborators. Absent ⇒ false ⇒ ON, so an existing rack
  // opens unchanged. One boolean per CLICK, never per frame.
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

  // ── THE ACCESSIBLE NAME ───────────────────────────────────────────────────
  //
  // A canvas is `role="img"`, NOT a range role, so this is `aria-label` and not
  // `aria-valuetext`. It carries the two facts the picture itself cannot say —
  // WHICH source is on screen, and what the beat it is pulsing at actually is —
  // which is where every deleted resting readout on this module went.
  let wiringVersion = $derived(edgesVersion() + nodesStructuralVersion());
  let cardVersion = $derived(nodeVersion(nodeId));
  let hasVideoIn = $derived.by(() => {
    void wiringVersion;
    for (const e of Object.values(patch.edges)) {
      if (!e) continue;
      if (e.target?.nodeId === nodeId && e.target?.portId === 'video_in') return true;
    }
    return false;
  });
  let displayLabel = $derived.by(() => {
    void cardVersion;
    const params = patch.nodes[nodeId]?.params ?? {};
    if (hasVideoIn) return 'TIMELORDE display — the live video monitor, passed through to VIDEO OUT';
    const bpm = Math.round(typeof params.bpm === 'number' ? params.bpm : 120);
    const running = (typeof params.running === 'number' ? params.running : 1) >= 0.5;
    const wizard = (typeof params.wizardOn === 'number' ? params.wizardOn : 1) >= 0.5;
    if (!wizard) return 'TIMELORDE display — the owl is hidden; VIDEO OUT still carries it';
    return running
      ? `TIMELORDE display — the owl painting, its eyes and border pulsing at ${bpm} bpm`
      : `TIMELORDE display — the owl painting, steady: the transport is stopped at ${bpm} bpm`;
  });

  /** Pull `video_out`'s own drawFrame into our canvas — the audio-domain
   *  mono-video path TimelordeCard already uses to read an upstream source. */
  function draw(): void {
    rafId = null;
    if (canvasEl && !previewCollapsed) {
      const e = engineCtx.get();
      if (e) {
        let ae:
          | {
              getVideoSource?: (
                n: string,
                p: string,
              ) => { drawFrame?: (c: HTMLCanvasElement) => void } | null;
            }
          | undefined;
        try {
          ae = e.getDomain('audio') as unknown as typeof ae;
        } catch {
          ae = undefined;
        }
        const src = ae?.getVideoSource?.(nodeId, 'video_out') ?? null;
        // `drawFrame` paints the module's idle field when nothing has been
        // pushed yet, so there is never an uninitialised canvas on screen.
        try {
          src?.drawFrame?.(canvasEl);
        } catch {
          /* best-effort — never break the rAF loop */
        }
      }
    }
    rafId = requestAnimationFrame(draw);
  }

  // ONE place owns the loop so it cannot be started twice. It runs for the
  // lifetime of the component; `draw` itself decides whether to paint.
  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };
  });
</script>

<div class="timelorde-display" data-testid="timelorde-display-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <!-- ⚠ THE ROLE IS ON THE WRAPPER, NOT ON THE CANVAS, and that is a
           compiler ruling rather than a preference: svelte-check refuses
           `role="img"` on a <canvas> (a11y_no_interactive_element_to_
           noninteractive_role) and the repo runs it with --fail-on-warnings. A
           one-element wrapper is the ordinary way to give a canvas an
           accessible name; the SCREEN button stays OUTSIDE it so the image role
           has no focusable descendant. -->
      <div class="display-frame" role="img" aria-label={displayLabel}>
        <canvas
          bind:this={canvasEl}
          width={DISPLAY_W}
          height={DISPLAY_H}
          data-testid="timelorde-face-canvas"
        ></canvas>
      </div>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="timelorde-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title="SCREEN: turn the display off to reclaim its space. TIMELORDE keeps compositing it, and VIDEO OUT keeps passing it downstream."
    >SCREEN {previewCollapsed ? 'OFF' : 'ON'}</button>
  </div>
</div>

<style>
  .timelorde-display {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT — see the OVERLAY paragraph in
     module-faceplates.md. Stacking it under the canvas cost spirographs ~18.8 px
     against ~11 px of slack and overhung the card by 7.8 CSS px. It OVERLAYS the
     picture's bottom-right corner, so the body is exactly the height the picture
     is. */
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF: the canvas is gone, and without a floor
       the wrap would collapse to zero and take the absolutely-positioned button
       with it. Inert behind the canvas whenever the picture shows. */
    min-height: 18px;
  }
  .display-frame {
    display: block;
    line-height: 0;
  }
  .preview-wrap canvas {
    display: block;
    width: 220px;
    height: 220px;
    max-width: 100%;
    border: 1px solid #1a1f2a;
    border-radius: 4px;
    background: #07090d;
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
