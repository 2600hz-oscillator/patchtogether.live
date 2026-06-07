<script lang="ts">
  // GibribbonCard — Vib-Ribbon-style ribbon side-scroller rendered with DOOM
  // sprites. The card polls the engine's `read(node, 'snapshot')` ImageData at
  // ~30 Hz and blits it into the on-card <canvas>. When the card holds focus,
  // the keyboard maps to the ABXY player buttons (so you can play without
  // patching a controller); patched ABXY gate inputs work in parallel.
  //
  // The line-drawn ribbon + the marine/imp/zombie sprites are rasterised by the
  // factory (gibribbon.ts) into a 640×360 framebuffer; this card is purely the
  // display + HUD + keyboard bridge (DOM-free factory, testable card).

  import type { NodeProps } from '@xyflow/svelte';
  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position } from '@xyflow/svelte';
  import { patch } from '$lib/graph/store';
  import {
    gibribbonDef,
    INTERNAL_W as GIB_W,
    INTERNAL_H as GIB_H,
    type GibribbonHandleExtras,
  } from '$lib/video/modules/gibribbon';
  import type { GibButton } from '$lib/video/modules/gibribbon-events';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let cardEl: HTMLDivElement | null = $state(null);
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let ctx2d: CanvasRenderingContext2D | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let score = $state(0);
  let health = $state('healthy');
  let combo = $state(0);
  let loadErr = $state('');
  let hasFocus = $state(false);

  function getExtras(): GibribbonHandleExtras | null {
    const eng = engineCtx.get();
    if (!eng || !node) return null;
    return (eng.read(node, 'extras') as GibribbonHandleExtras | undefined) ?? null;
  }

  function pollStatus() {
    const eng = engineCtx.get();
    if (!eng || !node || !ctx2d) return;
    const snap = eng.read(node, 'snapshot') as ImageData | undefined;
    if (snap) ctx2d.putImageData(snap, 0, 0);
    const s = eng.read(node, 'score') as number | undefined;
    if (typeof s === 'number') score = s;
    const h = eng.read(node, 'health') as string | undefined;
    if (typeof h === 'string') health = h;
    const c = eng.read(node, 'combo') as number | undefined;
    if (typeof c === 'number') combo = c;
    const le = eng.read(node, 'loadError') as string | undefined;
    if (typeof le === 'string') loadErr = le;
  }

  onMount(() => {
    if (canvasEl) {
      // Buffer must match the snapshot ImageData dims (putImageData does NOT
      // scale); CSS pins the on-card DISPLAY size, so the preview stays the same
      // visual size — only the backing buffer gets sharper.
      canvasEl.width = GIB_W;
      canvasEl.height = GIB_H;
      ctx2d = canvasEl.getContext('2d');
    }
    pollTimer = setInterval(pollStatus, 33);
  });
  onDestroy(() => { if (pollTimer) clearInterval(pollTimer); });

  function resetGame() { getExtras()?.reset(); }

  // Keyboard → ABXY. Defaults to F/D/J/K (A/B/X/Y) with arrow-key aliases so
  // it's playable one-handed; stop propagation so SvelteFlow doesn't pan.
  function keyToButton(e: KeyboardEvent): GibButton | null {
    switch (e.key.toLowerCase()) {
      case 'f': case 'arrowleft':  return 'a';
      case 'd': case 'arrowdown':  return 'b';
      case 'j': case 'arrowright': return 'x';
      case 'k': case 'arrowup':    return 'y';
      default: return null;
    }
  }
  function onKeyDown(e: KeyboardEvent) {
    if (!hasFocus) return;
    // R restarts a finished game from the play surface (no need to reach for the
    // off-canvas RESET button on game over).
    if (e.key.toLowerCase() === 'r') {
      e.preventDefault();
      e.stopPropagation();
      getExtras()?.reset();
      return;
    }
    const btn = keyToButton(e);
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    getExtras()?.pushButton(btn);
  }
  function onFocusIn() { hasFocus = true; }
  function onFocusOut() { hasFocus = false; }

  const healthLabel = $derived(
    health === 'super' ? 'SUPER' :
    health === 'healthy' ? 'HEALTHY' :
    health === 'wounded' ? 'WOUNDED' :
    health === 'critical' ? 'CRITICAL' : 'GAME OVER',
  );
</script>

<div
  bind:this={cardEl}
  class="mod-card gibribbon-card"
  class:has-focus={hasFocus}
  tabindex="0"
  role="application"
  aria-label="GIBRIBBON — click to focus, then F/D/J/K (or arrows) play ABXY"
  onkeydown={onKeyDown}
  onfocusin={onFocusIn}
  onfocusout={onFocusOut}
>
  <div class="stripe" style="background: var(--cable-video);"></div>
  <ModuleTitle {id} {data} defaultLabel="GIBRIBBON" />

  <!-- INPUT handles (left edge): event-gen CV, transport, axes, ABXY buttons. -->
  <Handle type="target" position={Position.Left} id="cv1"   style="top: 56px;  --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 50px;">CV1</span>
  <Handle type="target" position={Position.Left} id="cv2"   style="top: 80px;  --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 74px;">CV2</span>
  <Handle type="target" position={Position.Left} id="cv3"   style="top: 104px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 98px;">CV3</span>
  <Handle type="target" position={Position.Left} id="cv4"   style="top: 128px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 122px;">CV4</span>
  <Handle type="target" position={Position.Left} id="clock" style="top: 152px; --handle-color: var(--cable-gate);" />
  <span class="port-label left" style="top: 146px;">CLK</span>
  <Handle type="target" position={Position.Left} id="gate"  style="top: 176px; --handle-color: var(--cable-gate);" />
  <span class="port-label left" style="top: 170px;">GTE</span>
  <Handle type="target" position={Position.Left} id="x"     style="top: 200px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 194px;">X</span>
  <Handle type="target" position={Position.Left} id="y"     style="top: 224px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 218px;">Y</span>
  <Handle type="target" position={Position.Left} id="a"     style="top: 248px; --handle-color: var(--cable-gate);" />
  <span class="port-label left" style="top: 242px;">A</span>
  <Handle type="target" position={Position.Left} id="b"     style="top: 272px; --handle-color: var(--cable-gate);" />
  <span class="port-label left" style="top: 266px;">B</span>
  <Handle type="target" position={Position.Left} id="x_btn" style="top: 296px; --handle-color: var(--cable-gate);" />
  <span class="port-label left" style="top: 290px;">XB</span>
  <Handle type="target" position={Position.Left} id="y_btn" style="top: 320px; --handle-color: var(--cable-gate);" />
  <span class="port-label left" style="top: 314px;">YB</span>

  <!-- OUTPUT handles (right edge): video, event gates, health CV. -->
  <Handle type="source" position={Position.Right} id="out"          style="top: 56px;  --handle-color: var(--cable-video);" />
  <span class="port-label right" style="top: 50px;">OUT</span>
  <Handle type="source" position={Position.Right} id="evt_hit"      style="top: 84px;  --handle-color: var(--cable-gate);" />
  <span class="port-label right" style="top: 78px;">HIT</span>
  <Handle type="source" position={Position.Right} id="evt_miss"     style="top: 112px; --handle-color: var(--cable-gate);" />
  <span class="port-label right" style="top: 106px;">MIS</span>
  <Handle type="source" position={Position.Right} id="evt_fire"     style="top: 140px; --handle-color: var(--cable-gate);" />
  <span class="port-label right" style="top: 134px;">FIR</span>
  <Handle type="source" position={Position.Right} id="evt_kill"     style="top: 168px; --handle-color: var(--cable-gate);" />
  <span class="port-label right" style="top: 162px;">KIL</span>
  <Handle type="source" position={Position.Right} id="evt_gameover" style="top: 196px; --handle-color: var(--cable-gate);" />
  <span class="port-label right" style="top: 190px;">GO</span>
  <Handle type="source" position={Position.Right} id="health_cv"    style="top: 224px; --handle-color: var(--cable-cv);" />
  <span class="port-label right" style="top: 218px;">HP</span>

  <div class="header-row">
    <div class="hud" data-testid="gibribbon-score">SCORE {score}</div>
    <div class="hud" class:dead={health === 'dead'} data-testid="gibribbon-health">{healthLabel}</div>
    <div class="hud" data-testid="gibribbon-combo">x{combo}</div>
  </div>

  <div class="screen-wrap">
    <canvas bind:this={canvasEl} class="screen" data-testid="gibribbon-screen"></canvas>
    {#if health === 'dead'}
      <div class="gameover-overlay" data-testid="gibribbon-gameover">
        <div class="go-title">GAME OVER</div>
        <div class="go-sub">press R or RESET to play again</div>
        <button type="button" class="go-btn" onclick={resetGame} data-testid="gibribbon-restart">RESTART</button>
      </div>
    {/if}
  </div>

  <div class="row">
    <button type="button" class="btn" onclick={resetGame} data-testid="gibribbon-reset">RESET</button>
    {#if loadErr}
      <span class="warn" data-testid="gibribbon-loaderr" title={loadErr}>line-art (no WAD)</span>
    {/if}
  </div>

  <div class="tip">Click to focus → F/D/J/K (or arrows) = A/B/X/Y, R = restart. Read the top lane for the next buttons. Patch X/Y to aim, CV1-4 + CLOCK + GATE to auto-generate.</div>
</div>

<style>
  .mod-card {
    width: max-content;
    min-width: 520px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding: 18px 30px 12px;
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
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }
  .port-label {
    position: absolute; font-size: 0.55rem; color: var(--text-dim);
    pointer-events: none; font-family: ui-monospace, monospace;
  }
  .port-label.left { left: 6px; }
  .port-label.right { right: 6px; }
  .header-row {
    display: flex; justify-content: space-between; align-items: center;
    margin: 4px 0 8px; padding: 0 4px; gap: 12px;
  }
  .hud {
    font-family: ui-monospace, monospace; font-size: 0.72rem;
    color: var(--text); letter-spacing: 0.08em;
  }
  .hud.dead { color: #e05050; }
  .screen-wrap {
    margin: 4px auto 10px; border: 1px solid #000;
    box-shadow: inset 0 0 12px rgba(0, 0, 0, 0.6), 0 0 4px rgba(0, 0, 0, 0.3);
    background: #000; border-radius: 3px; overflow: hidden; display: block;
    position: relative; /* anchor the GAME OVER overlay */
    width: 480px; height: 270px; /* fixed 16:9 display size (the 1024×576 buffer
                                    scales down to fit — preview stays same size) */
  }
  .screen { width: 100%; height: 100%; image-rendering: pixelated; display: block; }
  .gameover-overlay {
    position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 8px;
    background: rgba(0, 0, 0, 0.55); font-family: ui-monospace, monospace;
  }
  .go-title { color: #e05050; font-size: 1.6rem; letter-spacing: 0.18em; font-weight: 700; }
  .go-sub { color: var(--text-dim); font-size: 0.62rem; letter-spacing: 0.06em; }
  .go-btn {
    margin-top: 4px; background: #e05050; color: #000; border: none; border-radius: 3px;
    font-size: 0.72rem; letter-spacing: 0.1em; padding: 6px 16px; cursor: pointer;
    font-family: ui-monospace, monospace; font-weight: 700;
  }
  .go-btn:hover { background: #ff6868; }
  .row { display: flex; align-items: center; justify-content: center; gap: 14px; padding: 0 12px; }
  .btn {
    background: var(--module-bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 3px; font-size: 0.7rem; letter-spacing: 0.08em; padding: 6px 12px;
    cursor: pointer; font-family: ui-monospace, monospace;
  }
  .btn:hover { border-color: var(--accent-dim); }
  .warn { font-family: ui-monospace, monospace; font-size: 0.6rem; color: var(--text-dim); }
  .tip {
    font-family: ui-monospace, monospace; font-size: 0.55rem; color: var(--text-dim);
    text-align: center; margin-top: 8px; letter-spacing: 0.04em;
  }
</style>
