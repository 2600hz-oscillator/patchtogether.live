<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { modtrisDef, drawModtris, type ModtrisState } from '$lib/audio/modules/modtris';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  // Inputs: 5 gate inputs. Outputs: 2 gate outputs.
  const inputs: PortDescriptor[] = [
    { id: 'rotate_l',  label: 'ROT L (GATE)',  cable: 'gate' },
    { id: 'rotate_r',  label: 'ROT R (GATE)',  cable: 'gate' },
    { id: 'drop_fast', label: 'DROP (GATE)',   cable: 'gate' },
    { id: 'move_l',    label: 'MOVE L (GATE)', cable: 'gate' },
    { id: 'move_r',    label: 'MOVE R (GATE)', cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'line_cleared', label: 'LINE (GATE)',     cable: 'gate' },
    { id: 'overfill',     label: 'OVERFILL (GATE)', cable: 'gate' },
  ];

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let gravityBpm = $derived(node?.params.gravityBpm ?? modtrisDef.params[0]!.defaultValue);
  let levelStep  = $derived(node?.params.levelStep  ?? modtrisDef.params[1]!.defaultValue);

  const setParam = (paramId: string) => (v: number) => {
    const target = patch.nodes[id];
    if (target) target.params[paramId] = v;
  };
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
  <header class="title">MODTRIS</header>

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
      <Fader value={gravityBpm} min={30} max={240} defaultValue={60} label="Drop" curve="log"    onchange={setParam('gravityBpm')} readLive={readLive('gravityBpm')} />
      <Fader value={levelStep}  min={1}  max={20}  defaultValue={10} label="Lvl"  curve="linear" onchange={setParam('levelStep')}  readLive={readLive('levelStep')} />
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
