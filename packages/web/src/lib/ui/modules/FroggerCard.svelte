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
  import { paramSpec, portsFromDef } from './card-kit';

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

  // ⚠ THE RANGE COMES FROM THE DEF, ONCE. This card used to pass literal
  // `min={10} max={120} defaultValue={60}` three lines below a line that
  // already read `froggerDef.params[0]!.defaultValue` — the backdraft class
  // verbatim (a card silently disagreeing with its def, invisible to every
  // def-reading gate). They happened to agree; nothing held them there, because
  // frogger sat outside `RANGE_BOUND_CARDS` and that set's own stated scope is
  // that every card NOT in it is unchecked. Bound through `paramSpec` and the
  // card enrolled in the set, so a divergence is now unrepresentable.
  const TIME = paramSpec(froggerDef, 'initialTime');
  let initialTime = $derived(node?.params.initialTime ?? TIME.defaultValue);

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
            // ⚠ CSS PX IN, DPR ON THE CONTEXT. This used to pass
            // `canvasEl.width/height` — the BACKING STORE, i.e. 400x452 at
            // DPR 2. `drawFrogger` derives every GRID dimension from the w/h
            // it is handed, so the board scaled correctly and the bug hid; but
            // `HUD_H = 22` and the two HUD fonts are ABSOLUTE, so the strip
            // rendered 11 CSS px tall with ~4.5 CSS px text. The grid geometry
            // is unchanged by this fix (cellPx was and is 14 CSS px) — only the
            // HUD becomes legible. The dock faceplate body calls the painter
            // exactly this way, so there is one board at one HUD scale.
            ctx2d.setTransform(DPR, 0, 0, DPR, 0, 0);
            drawFrogger(ctx2d, snap, CSS_W, CSS_H);
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
        data-testid="frogger-canvas"
      ></canvas>
    </div>
    <div class="knob-row">
      <Knob
        value={initialTime}
        min={TIME.min} max={TIME.max} defaultValue={TIME.defaultValue}
        label="TIME" curve={TIME.curve}
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
