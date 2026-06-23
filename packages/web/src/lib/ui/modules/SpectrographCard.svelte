<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function param(id_: string, fallback: number): number {
    const v = node?.params?.[id_];
    return typeof v === 'number' ? v : fallback;
  }
  const set = (id_: string) => (v: number) => setNodeParam(id, id_, v);
  const live = (id_: string) => () => {
    const e = engineCtx.get();
    if (!e || !node) return undefined;
    return e.readParam(node, id_);
  };

  // The preview shows the COLOR (heat) output by default; a toggle flips
  // it to the BW (inverted-grayscale, printed-sonogram) output so you can
  // eyeball BOTH looks on the card without patching either out. This is a
  // pure VIEW switch on the card — both video outputs always render the
  // SAME binned plane regardless of what the preview shows.
  let viewBw = $state(false);

  // All ports live in the shared yellow drill-down <PatchPanel> (the post-#767
  // standard — no raw side <Handle> jacks).
  const inputs: PortDescriptor[] = [{ id: 'in', label: 'IN', cable: 'audio' }];
  const outputs: PortDescriptor[] = [
    { id: 'color', label: 'COLOR OUT', cable: 'mono-video' },
    { id: 'bw', label: 'B/W OUT', cable: 'mono-video' },
  ];

  // ---- Preview canvas: pull the live videoSource drawFrame ----
  // The audio module publishes a videoSource per output port whose
  // drawFrame paints the scrolling sonogram into any canvas. We pull the
  // selected output's drawFrame straight into our preview each rAF — the
  // SAME path the audio→video texture bridge uses, so the preview is an
  // honest WYSIWYG of what the patched output emits.
  let canvas: HTMLCanvasElement | null = $state(null);
  let raf: number | null = null;

  type VSrc = { drawFrame?: (c: OffscreenCanvas | HTMLCanvasElement) => void } | null;

  $effect(() => {
    if (!canvas) return;
    function tick(): void {
      const e = engineCtx.get();
      if (e && node && canvas) {
        let audioEngine:
          | { getVideoSource?: (n: string, p: string) => VSrc }
          | undefined;
        try {
          audioEngine = e.getDomain('audio') as unknown as typeof audioEngine;
        } catch {
          audioEngine = undefined;
        }
        const port = viewBw ? 'bw' : 'color';
        const vsrc = audioEngine?.getVideoSource?.(node.id, port) ?? null;
        if (vsrc?.drawFrame) {
          try {
            vsrc.drawFrame(canvas);
          } catch {
            /* keep the loop alive on a transient draw error */
          }
        }
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    };
  });

  onDestroy(() => {
    if (raf !== null) cancelAnimationFrame(raf);
  });
</script>

<div class="mod-card spectro-card" data-testid="spectrograph-card">
  <div class="stripe" style="background: var(--cable-video, #c084fc);"></div>
  <ModuleTitle {id} {data} defaultLabel="SPECTROGRAPH" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <div class="screen-wrap">
        <canvas
          bind:this={canvas}
          width="256"
          height="128"
          data-testid="spectrograph-preview"
          class:bw={viewBw}
        ></canvas>
        <button
          type="button"
          class="view-toggle"
          class:bw={viewBw}
          data-testid="spectrograph-view"
          data-view={viewBw ? 'bw' : 'color'}
          onclick={() => (viewBw = !viewBw)}
          title="Preview the COLOR (heat) or B/W (inverted, printed-sonogram) output"
        >{viewBw ? 'B/W' : 'COLOR'}</button>
      </div>
      <div class="controls">
        <Knob
          value={param('gain', 1)}
          min={0.25}
          max={4}
          defaultValue={1}
          label="GAIN"
          curve="log"
          onchange={set('gain')}
          moduleId={id}
          paramId="gain"
          readLive={live('gain')}
        />
        <div class="axis-note">20 Hz → 20 kHz · newest right</div>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .spectro-card {
    width: 320px;
    min-height: 220px;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 16px;
  }
  .screen-wrap {
    position: relative;
  }
  .screen-wrap canvas {
    display: block;
    width: 288px;
    height: 144px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: #050608;
    image-rendering: auto;
  }
  .screen-wrap canvas.bw {
    background: #f4f4f4;
  }
  .view-toggle {
    position: absolute;
    top: 4px;
    right: 4px;
    font-size: 0.5rem;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.06em;
    padding: 2px 6px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: rgba(12, 14, 18, 0.85);
    color: var(--cable-video, #c084fc);
    cursor: pointer;
    width: 52px;
    text-align: center;
  }
  .view-toggle.bw {
    color: #222;
    background: rgba(244, 244, 244, 0.9);
    border-color: #999;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .axis-note {
    font-size: 0.5rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    letter-spacing: 0.02em;
  }
</style>
