<script lang="ts">
  // ScoreboardCard — 4-digit neon 7-segment counter widget.
  //
  // I/O:
  //   - 2 cv-typed gate inputs (SCORE, RESET).
  //   - 1 video output (OUT).
  //   - 1 colour-wheel knob (the `color` param) — 0..1 maps 0..360° hue.
  //
  // All ports live in the shared yellow drill-down <PatchPanel> (the post-#767
  // hard standard — NO raw side <Handle> jacks; this also gives the card its
  // rear-view back panel). Port `id`s are byte-identical to scoreboardDef so the
  // CV bridge + persisted edges route unchanged.
  //
  // Layout:
  //   - Small preview canvas (200×56) showing the live counter, drawn via
  //     the same drawScoreboard helper the engine uploads to GL.
  //   - The preview polls the engine at rAF cadence via engine.read('score')
  //     so the displayed number tracks the live counter, regardless of
  //     which peer drove the gate.

  import { onMount, onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import { scoreboardDef } from '$lib/video/modules/scoreboard';
  import { drawScoreboard } from '$lib/video/modules/scoreboard-draw';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function defaultFor(k: string): number {
    return scoreboardDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
  }
  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }
  const set = (k: string) => (v: number) => {
    setNodeParam(id, k, v);
  };

  // -------- Live preview canvas (200×56) --------
  const PREVIEW_W = 200;
  // Rack-compaction (#759): trimmed 80 → 56 so the card fits its 1u tier.
  // drawScoreboard scales the 7-segment readout to the canvas dimensions, so
  // the digits stay legible at the shorter height.
  const PREVIEW_H = 56;
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let raf: number | null = null;
  let liveScore = $state(0);

  onMount(() => {
    function tick() {
      raf = null;
      const e = engineCtx.get();
      if (e && node) {
        const v = e.read(node, 'score');
        if (typeof v === 'number') liveScore = v;
      }
      if (canvasEl) {
        const ctx2d = canvasEl.getContext('2d');
        if (ctx2d) {
          drawScoreboard(ctx2d, PREVIEW_W, PREVIEW_H, liveScore, paramVal('color'));
        }
      }
      raf = requestAnimationFrame(tick);
    }
    if (canvasEl) {
      canvasEl.width = PREVIEW_W;
      canvasEl.height = PREVIEW_H;
    }
    raf = requestAnimationFrame(tick);
  });
  onDestroy(() => { if (raf !== null) cancelAnimationFrame(raf); });

  // Ports — ids byte-identical to scoreboardDef (score/reset = cv, out = video).
  const inputs: PortDescriptor[] = [
    { id: 'score', label: 'SCORE', cable: 'cv' },
    { id: 'reset', label: 'RESET', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [{ id: 'out', label: 'OUT', cable: 'video' }];
</script>

<div class="mod-card scoreboard-card" data-testid="scoreboard-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="SCOREBOARD" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <div class="screen-wrap">
        <canvas
          bind:this={canvasEl}
          class="screen"
          data-testid="scoreboard-screen"
          data-node-id={id}
        ></canvas>
      </div>

      <div class="knob-row">
        <Knob
          value={paramVal('color')}
          min={0} max={1} defaultValue={defaultFor('color')}
          label="COLOR" curve="linear"
          onchange={set('color')} moduleId={id} paramId="color"
        />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .mod-card {
    width: 260px;
    min-height: 180px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    /* Rack-compaction (#759): tighter padding to fit the 1u tier. */
    padding-top: 14px;
    padding-bottom: 9px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--cable-video);
  }
  .body {
    /* Clear the PatchPanel's top-left/right trigger affordances. */
    margin-top: 24px;
  }
  .screen-wrap {
    /* Rack-compaction (#759): tighter vertical margin + shorter readout to
     * fit the 1u tier. */
    margin: 0 auto 6px;
    width: 200px;
    height: 56px;
    border: 1px solid #000;
    background: #0a0a0a;
    box-shadow:
      inset 0 0 12px rgba(0, 0, 0, 0.7),
      0 0 4px rgba(0, 0, 0, 0.3);
    border-radius: 2px;
    overflow: hidden;
  }
  .screen {
    width: 200px;
    height: 56px;
    image-rendering: pixelated;
    display: block;
  }
  .knob-row {
    display: flex;
    justify-content: center;
    margin-top: 2px;
  }
</style>
