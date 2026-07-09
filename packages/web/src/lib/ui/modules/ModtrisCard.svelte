<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { modtrisDef, drawModtris, type ModtrisState } from '$lib/audio/modules/modtris';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  // Inputs: 5 gate inputs. Outputs: 2 gate outputs.
  const inputs = portsFromDef(modtrisDef.inputs, {
    rotate_l: 'ROT L (GATE)', rotate_r: 'ROT R (GATE)', drop_fast: 'DROP (GATE)',
    move_l: 'MOVE L (GATE)', move_r: 'MOVE R (GATE)',
  });
  const outputs = portsFromDef(modtrisDef.outputs, {
    line_cleared: 'LINE (GATE)', overfill: 'OVERFILL (GATE)',
  });

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let gravityBpm = $derived(node?.params.gravityBpm ?? modtrisDef.params[0]!.defaultValue);
  let levelStep  = $derived(node?.params.levelStep  ?? modtrisDef.params[1]!.defaultValue);

  const setParam = (paramId: string) => (v: number) => setNodeParam(id, paramId, v);
  const readLive = (paramId: string) => () => {
    const eng = engineCtx.get();
    if (!eng || !node) return undefined;
    return eng.readParam(node, paramId);
  };

  // Canvas — 200×260 CSS px (140 well + 60 next-piece strip),
  // 2× DPR for crisp pixels. Sized to fit standard 10x20 well at 12 px/cell
  // (120 px wide, 240 px tall) + a small NEXT strip.
  const CSS_W = 200;
  const CSS_H = 260;
  const DPR = 2;
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let raf: number | null = null;

  $effect(() => {
    if (!canvasEl) return;
    function tick() {
      const eng = engineCtx.get();
      if (eng && node && canvasEl) {
        const snap = eng.read(node, 'snapshot') as ModtrisState | undefined;
        if (snap) {
          const ctx2d = canvasEl.getContext('2d');
          if (ctx2d) {
            drawModtris(ctx2d, snap, canvasEl.width, canvasEl.height);
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

<div class="mod-card modtris-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <ModuleTitle {id} {data} defaultLabel="MODTRIS" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="game-area">
      <canvas
        bind:this={canvasEl}
        width={CSS_W * DPR}
        height={CSS_H * DPR}
        style={`width: ${CSS_W}px; height: ${CSS_H}px;`}
        data-viz-passthrough
        data-testid="modtris-canvas"
      ></canvas>
    </div>
    <div class="fader-row">
      <Fader value={gravityBpm} min={30} max={240} defaultValue={60} label="Drop" curve="log"    onchange={setParam('gravityBpm')} moduleId={id} paramId="gravityBpm" readLive={readLive('gravityBpm')} />
      <Fader value={levelStep}  min={1}  max={20}  defaultValue={10} label="Lvl"  curve="linear" onchange={setParam('levelStep')} moduleId={id} paramId="levelStep"  readLive={readLive('levelStep')} />
    </div>
  </PatchPanel>
</div>

<style>
  .modtris-card { width: 260px; min-height: 380px; }
  .modtris-card .game-area {
    display: flex;
    justify-content: center;
    padding: 6px 0 8px;
  }
  .modtris-card canvas {
    display: block;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
    border: 1px solid color-mix(in oklab, var(--cable-gate) 30%, transparent);
    border-radius: 2px;
  }
  .modtris-card .fader-row {
    display: flex;
    gap: 8px;
    justify-content: space-around;
    padding: 0 12px;
    margin-top: 4px;
  }
</style>
