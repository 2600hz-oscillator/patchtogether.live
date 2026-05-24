<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { pongDef, drawPong, type PongState, type PongParams } from '$lib/audio/modules/pong';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  // Inputs: two paddle CVs. Outputs: two score gates.
  const inputs: PortDescriptor[] = [
    { id: 'paddle_left',  label: 'PADDLE L (CV)', cable: 'cv' },
    { id: 'paddle_right', label: 'PADDLE R (CV)', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'score_left',  label: 'SCORE L (GATE)', cable: 'gate' },
    { id: 'score_right', label: 'SCORE R (GATE)', cable: 'gate' },
  ];

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // Params reflect the patch graph (source of truth). The engine's
  // setParam is invoked by the reconciler when a fader moves; we mirror
  // here for the draw call.
  let speed      = $derived(node?.params.speed      ?? pongDef.params[0]!.defaultValue);
  let paddleH    = $derived(node?.params.paddleH    ?? pongDef.params[1]!.defaultValue);
  let serveAngle = $derived(node?.params.serveAngle ?? pongDef.params[2]!.defaultValue);

  const setParam = (paramId: string) => (v: number) => {
    const target = patch.nodes[id];
    if (target) target.params[paramId] = v;
  };
  const readLive = (paramId: string) => () => {
    const eng = engineCtx.get();
    if (!eng || !node) return undefined;
    return eng.readParam(node, paramId);
  };

  // Canvas — 200×140 CSS px, 2× DPR for crisp pixels.
  const CSS_W = 200;
  const CSS_H = 140;
  const DPR = 2;
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let raf: number | null = null;

  $effect(() => {
    if (!canvasEl) return;
    function tick() {
      const eng = engineCtx.get();
      if (eng && node && canvasEl) {
        const snap = eng.read(node, 'snapshot') as PongState | undefined;
        if (snap) {
          const ctx2d = canvasEl.getContext('2d');
          if (ctx2d) {
            const params: PongParams = { speed, paddleH, serveAngle };
            drawPong(ctx2d, snap, params, canvasEl.width, canvasEl.height);
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

<div class="mod-card pong-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">PONG</header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="game-area">
      <canvas
        bind:this={canvasEl}
        width={CSS_W * DPR}
        height={CSS_H * DPR}
        style={`width: ${CSS_W}px; height: ${CSS_H}px;`}
        data-viz-passthrough
        data-testid="pong-canvas"
      ></canvas>
    </div>
    <div class="fader-row">
      <Fader value={speed}      min={0.25} max={4}  defaultValue={1.0} label="Speed"  curve="log"    onchange={setParam('speed')} moduleId={id} paramId="speed"      readLive={readLive('speed')} />
      <Fader value={paddleH}    min={0.05} max={0.5} defaultValue={0.2} label="Paddle" curve="linear" onchange={setParam('paddleH')} moduleId={id} paramId="paddleH"    readLive={readLive('paddleH')} />
      <Fader value={serveAngle} min={0}    max={1}   defaultValue={0.3} label="Serve"  curve="linear" onchange={setParam('serveAngle')} moduleId={id} paramId="serveAngle" readLive={readLive('serveAngle')} />
    </div>
  </PatchPanel>
</div>

<style>
  .pong-card { width: 240px; min-height: 280px; }
  .pong-card .game-area {
    display: flex;
    justify-content: center;
    padding: 6px 0 8px;
  }
  .pong-card canvas {
    display: block;
    /* Crisp pixel rendering for 16-bit aesthetic. */
    image-rendering: pixelated;
    image-rendering: crisp-edges;
    border: 1px solid color-mix(in oklab, var(--cable-gate) 30%, transparent);
    border-radius: 2px;
  }
  .pong-card .fader-row {
    display: flex;
    gap: 8px;
    justify-content: space-around;
    padding: 0 12px;
    margin-top: 4px;
  }
</style>
