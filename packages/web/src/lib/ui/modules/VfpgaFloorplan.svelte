<script lang="ts">
  // VfpgaFloorplan — the fabric floorplan VIEW for the vfpga-runner card (P5).
  //
  // A READ-ONLY 2D diagram of the loaded VFPGA's placed fabric: the tile grid
  // (CLB/DSP/BRAM/REG/LUT16/IOB tiles in their placed cells, coloured by type)
  // + the routing nets (wires) with the lit/active signal path highlighted. It
  // derives its model purely from the existing spec fabric (buildFloorplan) and
  // paints it on a Canvas2D surface — it touches NOTHING in the engine render
  // path or any spec output. Canvas2D (not WebGL) keeps it out of the
  // webgl-attest hash basis.

  import { onMount } from 'svelte';
  import type { VfpgaSpec } from '$lib/video/vfpga/types';
  import { buildFloorplan, TILE_TYPE_META } from './vfpga-floorplan';
  import { drawFloorplan, DEFAULT_FLOORPLAN_COLORS, type FloorplanColors } from './vfpga-floorplan-draw';

  let { spec }: { spec: VfpgaSpec | undefined } = $props();

  const WIDTH = 320;
  const HEIGHT = 150;

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let mounted = $state(false);

  let floorplan = $derived(buildFloorplan(spec));

  /** Resolve the cable palette from CSS vars on the canvas element (falls back
   *  to the defaults in jsdom / before mount). */
  function resolveColors(): FloorplanColors {
    if (!canvasEl || typeof getComputedStyle !== 'function') return DEFAULT_FLOORPLAN_COLORS;
    const cs = getComputedStyle(canvasEl);
    const pick = (name: string, fallback: string) => {
      const v = cs.getPropertyValue(name).trim();
      return v || fallback;
    };
    return {
      ...DEFAULT_FLOORPLAN_COLORS,
      video: pick('--cable-video', DEFAULT_FLOORPLAN_COLORS.video),
      cv: pick('--cable-cv', DEFAULT_FLOORPLAN_COLORS.cv),
      gate: pick('--cable-gate', DEFAULT_FLOORPLAN_COLORS.gate),
    };
  }

  function render() {
    if (!canvasEl) return;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;
    drawFloorplan(ctx, floorplan, WIDTH, HEIGHT, resolveColors());
  }

  // re-draw whenever the model changes (program/preset swap) or after mount.
  $effect(() => {
    void floorplan;
    void mounted;
    render();
  });

  onMount(() => {
    if (canvasEl) {
      canvasEl.width = WIDTH;
      canvasEl.height = HEIGHT;
    }
    mounted = true;
  });

  // legend entries: only the tile types actually present in this fabric.
  let legend = $derived.by(() => {
    const present = new Set(floorplan.tiles.map((t) => t.type));
    return (Object.keys(TILE_TYPE_META) as (keyof typeof TILE_TYPE_META)[])
      .filter((k) => present.has(k) && k !== 'iob_in' && k !== 'iob_out')
      .map((k) => ({ key: k, ...TILE_TYPE_META[k] }));
  });
</script>

<div class="floorplan" data-testid="vfpga-floorplan">
  <canvas
    bind:this={canvasEl}
    class="fp-canvas"
    style={`width:${WIDTH}px;height:${HEIGHT}px;`}
    data-testid="vfpga-floorplan-canvas"
  ></canvas>
  {#if floorplan.hasFabric}
    <div class="fp-legend" data-testid="vfpga-floorplan-legend">
      {#each legend as l}
        <span class="leg"><span class="swatch" style={`background:${l.color};`}></span>{l.label}</span>
      {/each}
      <span class="leg lit"><span class="line"></span>lit net</span>
    </div>
  {:else}
    <div class="fp-note">no fabric map (legacy effect)</div>
  {/if}
</div>

<style>
  .floorplan {
    margin: 0 auto 8px;
    width: 320px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .fp-canvas {
    width: 320px;
    height: 150px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: #0a0d12;
    display: block;
  }
  .fp-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 0.55rem;
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
  }
  .leg {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .swatch {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    display: inline-block;
  }
  .leg.lit .line {
    width: 12px;
    height: 0;
    border-top: 2px solid var(--cable-video);
    display: inline-block;
  }
  .fp-note {
    font-size: 0.55rem;
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
  }
</style>
