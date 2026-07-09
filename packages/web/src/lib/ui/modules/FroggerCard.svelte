<script lang="ts">
  // FroggerCard — 5 CV-gate inputs (up/down/left/right/start) + 3 gate
  // outputs (home/dead/level). Mirrors MODTRIS in structure: PatchPanel
  // surface for the gates, a 200×240 <canvas data-viz-passthrough> showing
  // the live game state, and one Knob for the per-level time budget.
  //
  // The Knob is MIDI-learnable via the shared Knob component (moduleId +
  // paramId props are what the MIDI-learn store binds to).

  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { froggerDef, drawFrogger, type FroggerState } from '$lib/audio/modules/frogger';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import { portsFromDef } from './card-kit';

  const inputs = portsFromDef(froggerDef.inputs, {
    up_gate: 'UP (GATE)', down_gate: 'DOWN (GATE)', left_gate: 'LEFT (GATE)',
    right_gate: 'RIGHT (GATE)', start_gate: 'START (GATE)',
  });
  const outputs = portsFromDef(froggerDef.outputs, {
    home_gate: 'HOME (GATE)', dead_gate: 'DEAD (GATE)', level_gate: 'LVL (GATE)',
  });

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let initialTime = $derived(
    node?.params.initialTime ?? froggerDef.params[0]!.defaultValue,
  );

  const setParam = (paramId: string) => (v: number) => setNodeParam(id, paramId, v);
  const readLive = (paramId: string) => () => {
    const eng = engineCtx.get();
    if (!eng || !node) return undefined;
    return eng.readParam(node, paramId);
  };

  // Canvas — 200 CSS px wide × 240 tall (a hair taller-than-square to fit
  // 14×13 grid + HUD strip). 2× DPR for crisp pixels.
  const CSS_W = 200;
  // Rack-compaction (#759): trimmed 240 → 226 so the card fits its 2u tier
  // with no content spill. drawFrogger scales to canvas.width/height.
  const CSS_H = 226;
  const DPR = 2;
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let raf: number | null = null;

  $effect(() => {
    if (!canvasEl) return;
    function tick() {
      const eng = engineCtx.get();
      if (eng && node && canvasEl) {
        const snap = eng.read(node, 'snapshot') as FroggerState | undefined;
        if (snap) {
          const ctx2d = canvasEl.getContext('2d');
          if (ctx2d) {
            drawFrogger(ctx2d, snap, canvasEl.width, canvasEl.height);
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

<div class="mod-card frogger-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">FROGGER</header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="game-area">
      <canvas
        bind:this={canvasEl}
        width={CSS_W * DPR}
        height={CSS_H * DPR}
        style={`width: ${CSS_W}px; height: ${CSS_H}px;`}
        data-viz-passthrough
        data-testid="frogger-canvas"
      ></canvas>
    </div>
    <div class="knob-row">
      <Knob
        value={initialTime}
        min={10} max={120} defaultValue={60}
        label="TIME" curve="linear"
        onchange={setParam('initialTime')}
        moduleId={id} paramId="initialTime"
        readLive={readLive('initialTime')}
      />
    </div>
  </PatchPanel>
</div>

<style>
  .frogger-card { width: 260px; min-height: 360px; }
  .frogger-card .game-area {
    display: flex;
    justify-content: center;
    /* Rack-compaction (#759): tighter padding to fit 2u. */
    padding: 4px 0 4px;
  }
  .frogger-card canvas {
    display: block;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
    border: 1px solid color-mix(in oklab, var(--cable-gate) 30%, transparent);
    border-radius: 2px;
    background: #070b12;
  }
  .frogger-card .knob-row {
    display: flex;
    justify-content: center;
    padding: 0 12px 4px;
  }
</style>
