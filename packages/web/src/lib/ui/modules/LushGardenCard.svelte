<script lang="ts">
  // LushGardenCard — generative layered-garden video source card.
  //
  // Live preview shows the CLEAN output (the canonical surface) via
  // blitOutputToDrawingBuffer + drawImage(engine.canvas) — the MILKDROP /
  // RUTTETRA preview path. Knobs: RATE (log) / HORIZON / VIEW (all
  // MIDI-assignable via the standard Knob). A [GATED] badge appears while
  // a cable is patched into the `grow` trigger (SHAPEGEN [CLOCKED]
  // pattern) — spawning is then one-plant-per-rising-edge. All jacks live
  // on the yellow drill-down PatchPanel (#767 standard — no raw side
  // <Handle>s). A small readout polls the engine's plantCount probe.
  //
  // NOTE: the HORIZON knob moves INVISIBLE placement geometry only — the
  // preview draws no line/guide at it (owner directive), so twisting it
  // shows up purely as where far plants stop appearing.

  import { onMount, onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import {
    lushgardenDef,
    LUSHGARDEN_GROW_PORT_ID,
    LUSHGARDEN_RESET_PORT_ID,
  } from '$lib/video/modules/lushgarden';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function defaultFor(k: string): number {
    return lushgardenDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
  }
  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }
  const set = (k: string) => (v: number) => {
    setNodeParam(id, k, v);
  };

  function getVideoEngine(): VideoEngine | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      return e.getDomain<VideoEngine>('video') ?? null;
    } catch {
      return null;
    }
  }

  // ----- Preview: blit the CLEAN output (canonical surface) -----
  let previewEl: HTMLCanvasElement | null = $state(null);
  let plantCount = $state(0);
  let rafId: number | null = null;

  function drawPreview(): void {
    rafId = null;
    const videoEngine = getVideoEngine();
    if (videoEngine && previewEl) {
      const c2d = previewEl.getContext('2d', { alpha: false });
      if (c2d) {
        try {
          videoEngine.blitOutputToDrawingBuffer(id);
          c2d.drawImage(
            videoEngine.canvas as CanvasImageSource,
            0, 0, previewEl.width, previewEl.height,
          );
        } catch {
          /* engine churn — never let it kill the rAF loop */
        }
      }
      try {
        const n = videoEngine.read(id, 'plantCount');
        if (typeof n === 'number') plantCount = n;
      } catch {
        /* ignore */
      }
    }
    rafId = requestAnimationFrame(drawPreview);
  }

  onMount(() => {
    if (previewEl) {
      previewEl.width = 240;
      previewEl.height = 180;
    }
    rafId = requestAnimationFrame(drawPreview);
  });
  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
  });

  // [GATED] badge: a cable is patched into the grow trigger → spawning is
  // one-plant-per-rising-edge (rate knob dormant). Same edge-scan approach
  // as SHAPEGEN's [CLOCKED] badge.
  let gated = $derived<boolean>(
    Object.values(patch.edges ?? {}).some(
      (e) => e?.target?.nodeId === id && e?.target?.portId === LUSHGARDEN_GROW_PORT_ID,
    ),
  );

  // Ports — ids byte-identical to lushgardenDef.
  const inputs: PortDescriptor[] = [
    { id: 'background', label: 'BG', cable: 'video' },
    { id: 'rate', label: 'RATE', cable: 'cv' },
    { id: 'horizon', label: 'HRZN', cable: 'cv' },
    { id: 'view', label: 'VIEW', cable: 'cv' },
    { id: LUSHGARDEN_GROW_PORT_ID, label: 'GROW', cable: 'gate' },
    { id: LUSHGARDEN_RESET_PORT_ID, label: 'RST', cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'mono', label: 'MONO', cable: 'video' },
    { id: 'watercolor', label: 'WCLR', cable: 'video' },
    { id: 'psychedelic', label: 'PSY', cable: 'video' },
    { id: 'clean', label: 'CLEAN', cable: 'video' },
  ];
</script>

<div class="mod-card lushgarden-card" data-testid="lushgarden-card">
  <div class="stripe" style="background: var(--cable-video);"></div>
  <ModuleTitle {id} {data} defaultLabel="LUSH GARDEN" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <div class="screen-wrap">
        {#if gated}
          <span class="gated-badge" data-testid="lushgarden-gated-badge">[GATED]</span>
        {/if}
        <canvas bind:this={previewEl} class="screen" data-testid="lushgarden-screen"></canvas>
        <span class="count" data-testid="lushgarden-plant-count">{plantCount}</span>
      </div>

      <div class="row">
        <Knob
          value={paramVal('rate')}
          min={0.5} max={10} defaultValue={defaultFor('rate')}
          label="RATE" curve="log"
          onchange={set('rate')} moduleId={id} paramId="rate"
        />
        <Knob
          value={paramVal('horizon')}
          min={0} max={1} defaultValue={defaultFor('horizon')}
          label="HORIZON" curve="linear"
          onchange={set('horizon')} moduleId={id} paramId="horizon"
        />
        <Knob
          value={paramVal('view')}
          min={0} max={1} defaultValue={defaultFor('view')}
          label="VIEW" curve="linear"
          onchange={set('view')} moduleId={id} paramId="view"
        />
        <Knob
          value={paramVal('fov')}
          min={0} max={1} defaultValue={defaultFor('fov')}
          label="FOV" curve="linear"
          onchange={set('fov')} moduleId={id} paramId="fov"
        />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .mod-card {
    width: 300px;
    min-height: 322px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }
  .body {
    /* Clear the PatchPanel's top-left/right trigger affordances. */
    margin-top: 24px;
  }
  .screen-wrap {
    margin: 12px auto 12px;
    width: 240px;
    height: 180px;
    border: 1px solid #000;
    box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.6), 0 0 4px rgba(0, 0, 0, 0.3);
    background: #060904;
    border-radius: 3px;
    overflow: hidden;
    position: relative;
  }
  .screen {
    width: 240px;
    height: 180px;
    display: block;
  }
  .gated-badge {
    position: absolute;
    top: 4px;
    right: 4px;
    font-size: 0.55rem;
    letter-spacing: 0.08em;
    color: #9be87c;
    background: rgba(0, 0, 0, 0.55);
    border: 1px solid #9be87c;
    border-radius: 2px;
    padding: 1px 4px;
    font-family: ui-monospace, monospace;
    pointer-events: none;
    z-index: 2;
  }
  .count {
    position: absolute;
    bottom: 4px;
    right: 4px;
    font-size: 0.55rem;
    color: rgba(155, 232, 124, 0.8);
    background: rgba(0, 0, 0, 0.45);
    border-radius: 2px;
    padding: 1px 4px;
    font-family: ui-monospace, monospace;
    pointer-events: none;
    z-index: 2;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 0 14px;
  }
</style>
