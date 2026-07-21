<script lang="ts">
  // ChannelColumnsOverlay — the WORKFLOW-MODE channel-columns visual guide.
  //
  // Renders the 8 numbered channel columns (1..8 labelled at the BOTTOM) + the
  // SEND 1 / SEND 2 rail to their right, pinned to FLOW SPACE (so it pans/zooms
  // with the cards). A child of <SvelteFlow> so useSvelteFlow() resolves; it maps
  // the pure channel-columns geometry (flow coords) to screen rects via
  // flowToScreenPosition, re-projected on every viewport `tick`. Presentation-
  // only: pointer-events:none so it never intercepts card/cable interaction, and
  // it is mounted ONLY in workflow mode (dawless renders nothing → VRT stays
  // pixel-identical). Each column's number badge is tinted by its channel colour
  // (the automation-lane colour = the single source of truth for channel colour).

  import { useSvelteFlow } from '@xyflow/svelte';
  import {
    COLUMN_COUNT,
    SEND_BOX_COUNT,
    columnXBand,
    sendBoxXBand,
    COLUMN_TOP_Y,
    COLUMN_BASELINE_Y,
  } from '$lib/graph/channel-columns';

  interface Props {
    /** Per-channel colours (length 8) — the automation-lane colours. */
    columnColors: string[];
    /** Viewport change signal (incremented on pan/zoom) — re-projects the rects. */
    tick: number;
  }
  let { columnColors, tick }: Props = $props();

  const flow = useSvelteFlow();

  interface Rect { left: number; top: number; width: number; height: number }

  /** Screen-space rect for a flow-space band, via two-corner projection. */
  function project(x0: number, x1: number, y0: number, y1: number): Rect | null {
    try {
      const tl = flow.flowToScreenPosition({ x: x0, y: y0 });
      const br = flow.flowToScreenPosition({ x: x1, y: y1 });
      return { left: tl.x, top: tl.y, width: br.x - tl.x, height: br.y - tl.y };
    } catch {
      // useSvelteFlow can throw transiently during teardown.
      return null;
    }
  }

  let columns = $derived.by<{ ch: number; rect: Rect; color: string }[]>(() => {
    void tick; // re-project on viewport change
    const out: { ch: number; rect: Rect; color: string }[] = [];
    for (let ch = 1; ch <= COLUMN_COUNT; ch++) {
      const [x0, x1] = columnXBand(ch);
      const rect = project(x0, x1, COLUMN_TOP_Y, COLUMN_BASELINE_Y);
      if (rect) out.push({ ch, rect, color: columnColors[ch - 1] ?? '#3a4a52' });
    }
    return out;
  });

  // SEND 1 / SEND 2 sit SIDE BY SIDE (own X band each), full column height.
  let sends = $derived.by<{ slot: number; rect: Rect }[]>(() => {
    void tick;
    const out: { slot: number; rect: Rect }[] = [];
    for (let s = 1; s <= SEND_BOX_COUNT; s++) {
      const [x0, x1] = sendBoxXBand(s);
      const rect = project(x0, x1, COLUMN_TOP_Y, COLUMN_BASELINE_Y);
      if (rect) out.push({ slot: s, rect });
    }
    return out;
  });
</script>

<div class="wcol-overlay" aria-hidden="true" data-testid="channel-columns-overlay">
  {#each columns as { ch, rect, color } (ch)}
    <div
      class="wcol-band"
      style="left:{rect.left}px; top:{rect.top}px; width:{rect.width}px; height:{rect.height}px; --wcol-color:{color};"
    >
      <div class="wcol-label" data-testid="channel-column-label-{ch}">{ch}</div>
    </div>
  {/each}
  {#each sends as { slot, rect } (slot)}
    <div
      class="wcol-send"
      style="left:{rect.left}px; top:{rect.top}px; width:{rect.width}px; height:{rect.height}px;"
    >
      <div class="wcol-send-label" data-testid="send-box-label-{slot}">SEND {slot}</div>
    </div>
  {/each}
</div>

<style>
  .wcol-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
    z-index: 0; /* behind cards (xyflow nodes sit above the pane background) */
  }
  .wcol-band {
    position: absolute;
    box-sizing: border-box;
    border-left: 1px solid color-mix(in srgb, var(--wcol-color) 45%, transparent);
    border-right: 1px solid color-mix(in srgb, var(--wcol-color) 12%, transparent);
    background: linear-gradient(
      to bottom,
      color-mix(in srgb, var(--wcol-color) 5%, transparent),
      transparent 40%
    );
  }
  .wcol-label {
    position: absolute;
    left: 50%;
    bottom: 8px;
    transform: translateX(-50%);
    min-width: 22px;
    padding: 2px 8px;
    border-radius: 6px;
    font: 600 13px/1.2 system-ui, sans-serif;
    text-align: center;
    color: #0a1114;
    background: var(--wcol-color);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  }
  .wcol-send {
    position: absolute;
    box-sizing: border-box;
    border: 1px dashed rgba(0, 240, 255, 0.28);
    border-radius: 8px;
    background: rgba(0, 240, 255, 0.03);
  }
  .wcol-send-label {
    position: absolute;
    left: 50%;
    bottom: 8px;
    transform: translateX(-50%);
    padding: 2px 8px;
    border-radius: 6px;
    font: 600 11px/1.2 system-ui, sans-serif;
    letter-spacing: 0.08em;
    color: #071417;
    background: rgba(0, 240, 255, 0.7);
  }
</style>
