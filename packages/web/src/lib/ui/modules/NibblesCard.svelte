<script lang="ts">
  // NibblesCard — 320×200 game screen + AUTO toggle + arrow-key driving.
  //
  // The card polls the engine's `read(node, 'snapshot')` at ~30 Hz for the
  // current ImageData and putImageData()s it into the on-card <canvas>.
  // When the card has focus AND AUTO is off, arrow keydowns are translated
  // into the four NibblesDirection values via the factory's extras handle.
  //
  // Resize behaviour: CSS scales the 320×200 source up with image-rendering:
  // pixelated. The on-card knobs / buttons stay fixed-size; only the
  // game-screen area scales.

  import type { NodeProps } from '@xyflow/svelte';
  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { nibblesDef, type NibblesHandleExtras } from '$lib/video/modules/nibbles';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function defaultFor(k: string): number {
    return nibblesDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
  }
  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }
  const set = (k: string) => (v: number) => {
    setNodeParam(id, k, v);
  };

  // ---------- Card surface ----------
  let cardEl: HTMLDivElement | null = $state(null);
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let ctx2d: CanvasRenderingContext2D | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let score = $state(4);
  let alive = $state(true);

  // ---------- Resize state ----------
  // Scale step in multiples of the native 320×200 source. 1×, 2×, 3×, 4×.
  let scale = $state(1);

  // ---------- Auto + focus ----------
  let autoOn = $derived(paramVal('auto') >= 0.5);
  let hasFocus = $state(false);

  function getExtras(): NibblesHandleExtras | null {
    const eng = engineCtx.get();
    if (!eng || !node) return null;
    return (eng.read(node, 'extras') as NibblesHandleExtras | undefined) ?? null;
  }

  function pollStatus() {
    const eng = engineCtx.get(); if (!eng || !node || !ctx2d) return;
    const snap = eng.read(node, 'snapshot') as ImageData | undefined;
    if (snap) ctx2d.putImageData(snap, 0, 0);
    const sc = eng.read(node, 'score') as number | undefined;
    if (typeof sc === 'number') score = sc;
    const al = eng.read(node, 'alive') as boolean | undefined;
    if (typeof al === 'boolean') alive = al;
  }

  onMount(() => {
    if (canvasEl) {
      canvasEl.width = 320;
      canvasEl.height = 200;
      ctx2d = canvasEl.getContext('2d');
    }
    pollTimer = setInterval(pollStatus, 33); // ~30 Hz
  });
  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  function toggleAuto() {
    const t = patch.nodes[id]; if (!t) return;
    t.params.auto = (t.params.auto ?? 0) >= 0.5 ? 0 : 1;
  }

  function resetGame() {
    const extras = getExtras();
    extras?.reset();
  }

  function cycleScale() {
    scale = (scale % 4) + 1; // 1 → 2 → 3 → 4 → 1
  }

  // Keyboard: arrow keys drive direction only when the card holds focus.
  function onKeyDown(e: KeyboardEvent) {
    if (!hasFocus) return;
    if (autoOn) return;
    let dir: 'up' | 'down' | 'left' | 'right' | null = null;
    if (e.key === 'ArrowUp') dir = 'up';
    else if (e.key === 'ArrowDown') dir = 'down';
    else if (e.key === 'ArrowLeft') dir = 'left';
    else if (e.key === 'ArrowRight') dir = 'right';
    if (!dir) return;
    // Same pattern as the DoomCard arrow-key handling (PR #275): stop
    // propagation so SvelteFlow's keyboard-pan handler doesn't move the
    // viewport while we're driving the snake.
    e.preventDefault();
    e.stopPropagation();
    const extras = getExtras();
    extras?.pushDirection(dir);
  }

  function onFocusIn() { hasFocus = true; }
  function onFocusOut() { hasFocus = false; }

  let screenW = $derived(320 * scale);
  let screenH = $derived(200 * scale);
</script>

<div
  bind:this={cardEl}
  class="mod-card nibbles-card"
  class:has-focus={hasFocus}
  tabindex="0"
  role="application"
  aria-label="NIBBLES — arrow keys drive snake when AUTO is off"
  onkeydown={onKeyDown}
  onfocusin={onFocusIn}
  onfocusout={onFocusOut}
>
  <div class="stripe" style="background: var(--cable-video);"></div>
  <ModuleTitle {id} {data} defaultLabel="NIBBLES" />

  <!-- Output handles. Vertical stack on the RIGHT edge: gates on top, CV in the middle, audio at the bottom. -->
  <Handle type="source" position={Position.Right} id="out"        style="top: 56px;  --handle-color: var(--cable-video);" />
  <span class="port-label right" style="top: 50px;">OUT</span>
  <Handle type="source" position={Position.Right} id="pellet"     style="top: 84px;  --handle-color: var(--cable-gate);" />
  <span class="port-label right" style="top: 78px;">PEL</span>
  <Handle type="source" position={Position.Right} id="death"      style="top: 112px; --handle-color: var(--cable-gate);" />
  <span class="port-label right" style="top: 106px;">DTH</span>
  <Handle type="source" position={Position.Right} id="dir_change" style="top: 140px; --handle-color: var(--cable-gate);" />
  <span class="port-label right" style="top: 134px;">DIR</span>
  <Handle type="source" position={Position.Right} id="length_cv"  style="top: 168px; --handle-color: var(--cable-cv);" />
  <span class="port-label right" style="top: 162px;">LEN</span>
  <Handle type="source" position={Position.Right} id="snake"      style="top: 196px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: 190px;">SNK</span>
  <Handle type="source" position={Position.Right} id="gated"      style="top: 224px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: 218px;">GTD</span>

  <div class="header-row">
    <div class="score" data-testid="nibbles-score">LEN {score}{alive ? '' : ' †'}</div>
    <button
      type="button"
      class="btn auto-btn"
      class:on={autoOn}
      onclick={toggleAuto}
      data-testid="nibbles-auto"
      title="Toggle self-play (AUTO bot drives the snake)"
    >AUTO {autoOn ? 'ON' : 'OFF'}</button>
  </div>

  <div class="screen-wrap" style={`width: ${screenW}px; height: ${screenH}px;`}>
    <canvas bind:this={canvasEl} class="screen" data-testid="nibbles-screen"></canvas>
  </div>

  <div class="row">
    <Knob
      value={paramVal('tick_ms')}
      min={40} max={200} defaultValue={defaultFor('tick_ms')}
      label="TICK" curve="linear"
      onchange={set('tick_ms')} moduleId={id} paramId="tick_ms"
    />
    <div class="buttons">
      <button type="button" class="btn small" onclick={cycleScale} data-testid="nibbles-scale">{scale}×</button>
      <button type="button" class="btn small" onclick={resetGame} data-testid="nibbles-reset">RESET</button>
    </div>
  </div>

  <div class="tip">Click to focus → arrow keys drive snake. AUTO = self-play.</div>
</div>

<style>
  .mod-card {
    /* Width grows with the scale knob (screen-wrap width + chrome
     *  padding), but never narrower than the chrome row needs. */
    width: max-content;
    min-width: 380px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding: 18px 14px 12px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    outline: none;
  }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .has-focus {
    box-shadow: 0 0 0 1px var(--accent), 0 2px 12px rgba(135, 200, 255, 0.4);
  }
  .stripe {
    position: absolute; top: 0; left: 0; right: 0; height: 2px;
    border-radius: 2px 2px 0 0;
  }
  .port-label {
    position: absolute; font-size: 0.6rem; color: var(--text-dim);
    pointer-events: none; font-family: ui-monospace, monospace;
  }
  .port-label.right { right: 14px; }
  .header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin: 4px 0 8px;
    padding: 0 8px;
  }
  .score {
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    color: var(--text);
    letter-spacing: 0.08em;
  }
  .screen-wrap {
    margin: 4px auto 10px;
    border: 1px solid #000;
    box-shadow: inset 0 0 12px rgba(0, 0, 0, 0.6), 0 0 4px rgba(0, 0, 0, 0.3);
    background: #000;
    border-radius: 3px;
    overflow: hidden;
    display: block;
  }
  .screen {
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    display: block;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 0 12px;
  }
  .buttons {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .btn {
    background: var(--module-bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    padding: 6px 12px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
  }
  .btn:hover { border-color: var(--accent-dim); }
  .btn.on {
    background: rgba(135, 200, 255, 0.2);
    color: #87c8ff;
    border-color: #87c8ff;
  }
  .btn.small { font-size: 0.6rem; padding: 4px 8px; }
  .auto-btn { min-width: 86px; text-align: center; }
  .tip {
    font-family: ui-monospace, monospace;
    font-size: 0.55rem;
    color: var(--text-dim);
    text-align: center;
    margin-top: 8px;
    letter-spacing: 0.04em;
  }
</style>
