<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { modtrisDef, drawModtris, type ModtrisState } from '$lib/audio/modules/modtris';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { paramSpec, portsFromDef } from './card-kit';

  // ⚠ THE RANGES COME FROM THE DEF, ONCE. This card used to read
  // `modtrisDef.params[N]!.defaultValue` for the VALUE and then re-type
  // `min={30} max={240} defaultValue={60}` / `min={1} max={20} defaultValue={10}`
  // as literals two lines later — HALF-BOUND, which is the worst of the three
  // states: it LOOKED def-driven while carrying a second copy of the travel.
  // They agreed; nothing held them there, and modtris sat outside
  // `RANGE_BOUND_CARDS`, whose own stated scope is that every card NOT in it is
  // unchecked. ⚠ The POSITIONAL reads were the sharper half: `params[0]` /
  // `params[1]` re-point silently at whatever is declared first, so the VRT
  // seam landing beside them in this same PR would have been one param
  // declaration away from swapping both faders with every gate green.
  const GRAVITY = paramSpec(modtrisDef, 'gravityBpm');
  const LEVEL = paramSpec(modtrisDef, 'levelStep');

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

  let gravityBpm = $derived(node?.params.gravityBpm ?? GRAVITY.defaultValue);
  let levelStep  = $derived(node?.params.levelStep  ?? LEVEL.defaultValue);

  const setParam = (paramId: string) => (v: number) => setNodeParam(id, paramId, v);
  const readLive = (paramId: string) => () => {
    const eng = engineCtx.get();
    if (!eng || !node) return undefined;
    return eng.readParam(node, paramId);
  };

  // Canvas — 200×260 CSS px (140 well + 60 next-piece strip),
  // 2× DPR for crisp pixels. Sized to fit standard 10x20 well at 12 px/cell
  // (120 px wide, 240 px tall) + a small NEXT strip.
  //
  // ⚠ THE PAINTER TAKES CSS PX AND THE CONTEXT CARRIES THE DPR. This card used
  // to pass `canvasEl.width/height` — the BACKING STORE at DPR 2, i.e. 400x520
  // — into a function that lays out in those same units and then draws its
  // strip at an ABSOLUTE `'700 9px'` / `'700 11px'` with absolute `+14`/`+90`
  // offsets. Every WELL dimension is derived from w/h so the board scaled
  // correctly and the bug hid in plain sight; only NEXT / LN / the count were
  // wrong, rendering at ~4.5-5.5 CSS px with a compressed vertical rhythm. There
  // was no pixel test at all, because modtris was EXEMPT_FROM_VRT — the
  // exemption this PR discharges is the first thing that could have caught it.
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
            ctx2d.setTransform(DPR, 0, 0, DPR, 0, 0);
            drawModtris(ctx2d, snap, CSS_W, CSS_H);
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
        data-testid="modtris-canvas"
      ></canvas>
    </div>
    <div class="fader-row">
      <NeonFader value={gravityBpm} min={GRAVITY.min} max={GRAVITY.max} defaultValue={GRAVITY.defaultValue} label={GRAVITY.label} curve={GRAVITY.curve} onchange={setParam('gravityBpm')} moduleId={id} paramId="gravityBpm" readLive={readLive('gravityBpm')} />
      <NeonFader value={levelStep}  min={LEVEL.min}   max={LEVEL.max}   defaultValue={LEVEL.defaultValue}   label={LEVEL.label}   curve={LEVEL.curve}   onchange={setParam('levelStep')} moduleId={id} paramId="levelStep"  readLive={readLive('levelStep')} />
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
