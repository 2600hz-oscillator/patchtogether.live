<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { pongDef, drawPong, type PongState, type PongParams } from '$lib/audio/modules/pong';
  import { paramSpec } from './card-kit';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  // Inputs: two paddle CVs. Outputs: two score gates.
  const inputs = portsFromDef(pongDef.inputs, {
    paddle_left: 'PADDLE L (CV)', paddle_right: 'PADDLE R (CV)',
  });
  const outputs = portsFromDef(pongDef.outputs, {
    score_left: 'SCORE L (GATE)', score_right: 'SCORE R (GATE)',
  });

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // Params reflect the patch graph (source of truth). The engine's
  // setParam is invoked by the reconciler when a fader moves; we mirror
  // here for the draw call.
  // ⚠ RANGES AND DEFAULTS COME FROM THE DEF, NOT FROM LITERALS RE-TYPED HERE.
  // The three faders below used to hard-code min/max/defaultValue while this very
  // file already imported `pongDef` — and read defaults out of it BY POSITION
  // (`params[0]`, `params[1]`, `params[2]`), which is its own hazard: adding a
  // param at the front silently re-points all three. This PR adds `freeze`, so
  // that hazard was about to become a live bug.
  //
  // They agreed with the def today; nothing held them there. pong sat outside
  // RANGE_BOUND_CARDS, whose own stated scope is that every card NOT in it is
  // unchecked — so a divergence would have been invisible to every gate. This is
  // the backdraft class verbatim. `paramSpec` throws on an unknown id, so a
  // renamed param fails loudly at mount instead of silently clamping.
  const pSpeed      = paramSpec(pongDef, 'speed');
  const pPaddleH    = paramSpec(pongDef, 'paddleH');
  const pServeAngle = paramSpec(pongDef, 'serveAngle');

  let speed      = $derived(node?.params.speed      ?? pSpeed.defaultValue);
  let paddleH    = $derived(node?.params.paddleH    ?? pPaddleH.defaultValue);
  let serveAngle = $derived(node?.params.serveAngle ?? pServeAngle.defaultValue);

  const setParam = (paramId: string) => (v: number) => setNodeParam(id, paramId, v);
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
  <ModuleTitle {id} {data} defaultLabel="PONG" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="game-area">
      <canvas
        bind:this={canvasEl}
        width={CSS_W * DPR}
        height={CSS_H * DPR}
        style={`width: ${CSS_W}px; height: ${CSS_H}px;`}
        data-testid="pong-canvas"
      ></canvas>
    </div>
    <div class="fader-row">
      <NeonFader value={speed}      min={pSpeed.min} max={pSpeed.max} defaultValue={pSpeed.defaultValue} label="Speed"  curve="log"    onchange={setParam('speed')} moduleId={id} paramId="speed"      readLive={readLive('speed')} />
      <NeonFader value={paddleH}    min={pPaddleH.min} max={pPaddleH.max} defaultValue={pPaddleH.defaultValue} label="Paddle" curve="linear" onchange={setParam('paddleH')} moduleId={id} paramId="paddleH"    readLive={readLive('paddleH')} />
      <NeonFader value={serveAngle} min={pServeAngle.min} max={pServeAngle.max} defaultValue={pServeAngle.defaultValue} label="Serve"  curve="linear" onchange={setParam('serveAngle')} moduleId={id} paramId="serveAngle" readLive={readLive('serveAngle')} />
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
