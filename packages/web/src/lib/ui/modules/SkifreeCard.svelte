<script lang="ts">
  // SkifreeCard — host shell around the upstream skifree.js engine (MIT,
  // Daniel Hough 2013). Mirrors Sm64Card's bundle-load pattern, but the
  // bundle is tiny (~24 KB) and we own a CLEAN controller API
  // (window.SkiFree.create) rather than monkey-patching globals.
  //
  // Lifecycle:
  //   1. onMount: inject <script src="/skifree/skifree.bundle.js">.
  //   2. onload: window.SkiFree.create({ canvas, width, height, onGate }) →
  //      a controller bound to OUR card canvas. Publish it on
  //      window.__skifree.controller so the audio factory (skifree.ts) can
  //      drive the CV cursor + read game state. The controller's onGate
  //      forwards to window.__skifree.onGate (set by the factory) → gate pulse.
  //   3. Focus handling: when the card is focused AND CV x/y are unpatched
  //      (factory sets window.__skifree.cvDriven = false), engage native mouse
  //      steering on the canvas. Patched CV (cvDriven = true) OR blur → mouse off.
  //   4. onDestroy: dispose the controller + remove the script + clear the bridge.
  //
  // maxInstances:1 → exactly one card mounted at a time; the bridge is a
  // single window.__skifree object.

  import { onMount, onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import {
    SKIFREE_CANVAS_SIZE,
    type SkifreeBridge,
    type SkifreeController,
    type SkifreeSnapshot,
  } from '$lib/audio/modules/skifree';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const inputs: PortDescriptor[] = [
    { id: 'x', label: 'X (CV)', cable: 'cv' },
    { id: 'y', label: 'Y (CV)', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'gate', label: 'GATE', cable: 'gate' },
    { id: 'out', label: 'OUT (VIDEO)', cable: 'video' },
  ];

  // Logical (CSS) canvas size — must match SKIFREE_CANVAS_SIZE so the
  // factory's CV→cursor map lands in the same coordinate space.
  const CSS = SKIFREE_CANVAS_SIZE;

  let cardEl: HTMLDivElement | null = $state(null);
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let loadStatus = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
  let loadError = $state<string | null>(null);
  let focused = $state(false);
  let snapshot = $state<SkifreeSnapshot | null>(null);

  let scriptTagEl: HTMLScriptElement | null = null;
  let controller: SkifreeController | null = null;
  let snapRaf: number | null = null;

  interface SkiFreeGlobal {
    create(opts: {
      canvas: HTMLCanvasElement;
      width: number;
      height: number;
      spriteBase?: string;
      onGate?: (evt: { type: 'crash' | 'eaten' }) => void;
    }): SkifreeController;
  }

  function ensureBridge(): SkifreeBridge {
    const w = globalThis as unknown as { __skifree?: SkifreeBridge };
    if (!w.__skifree) {
      w.__skifree = { controller: null, onGate: null, cvDriven: false };
    }
    return w.__skifree;
  }

  /** Engage / disengage native mouse steering. Engaged only when focused AND
   *  CV is not driving (cvDriven false). The controller's enable/disable is
   *  idempotent. */
  function syncMouseControl(): void {
    if (!controller) return;
    const bridge = ensureBridge();
    if (focused && !bridge.cvDriven) {
      controller.enableMouse(canvasEl ?? undefined);
    } else {
      controller.disableMouse();
    }
  }

  async function loadBundle(): Promise<void> {
    if (loadStatus !== 'idle') return;
    loadStatus = 'loading';
    try {
      const bridge = ensureBridge();
      // Inject the bundle <script>. Idempotent across hot-reload — if
      // window.SkiFree already exists (a prior mount loaded it) we skip the
      // network round-trip.
      const w = globalThis as unknown as { SkiFree?: SkiFreeGlobal };
      if (!w.SkiFree) {
        await new Promise<void>((resolve, reject) => {
          const s = document.createElement('script');
          s.src = '/skifree/skifree.bundle.js';
          s.async = false;
          s.onload = () => resolve();
          s.onerror = () => reject(new Error('SKIFREE bundle failed to load (404?)'));
          scriptTagEl = s;
          document.head.appendChild(s);
        });
      }
      if (!canvasEl) throw new Error('SKIFREE: canvas not bound');
      if (!w.SkiFree) throw new Error('SKIFREE: window.SkiFree missing after load');

      controller = w.SkiFree.create({
        canvas: canvasEl,
        width: CSS,
        height: CSS,
        spriteBase: '/skifree',
        // Forward every crash/eaten event to the factory's gate-pulse fn.
        onGate: (evt) => {
          const b = ensureBridge();
          if (b.onGate) b.onGate(evt);
        },
      });
      bridge.controller = controller;
      syncMouseControl();

      loadStatus = 'ready';
      loadError = null;
    } catch (e) {
      loadStatus = 'error';
      loadError = (e as Error).message;
    }
  }

  function pollSnapshot(): void {
    const eng = engineCtx.get();
    if (eng && node) {
      const snap = eng.read(node, 'snapshot') as SkifreeSnapshot | undefined;
      if (snap) {
        snapshot = snap;
        // The factory updates bridge.cvDriven each tick; re-evaluate mouse.
        syncMouseControl();
      }
    }
    snapRaf = requestAnimationFrame(pollSnapshot);
  }

  function onFocus(): void { focused = true; syncMouseControl(); }
  function onBlur(): void { focused = false; syncMouseControl(); }

  onMount(() => {
    snapRaf = requestAnimationFrame(pollSnapshot);
    void loadBundle();
  });

  onDestroy(() => {
    if (snapRaf !== null) cancelAnimationFrame(snapRaf);
    snapRaf = null;
    try { controller?.dispose(); } catch (_e) { /* */ }
    controller = null;
    if (scriptTagEl?.parentNode) scriptTagEl.parentNode.removeChild(scriptTagEl);
    scriptTagEl = null;
    // Clear the bridge so a re-mount starts clean. We leave window.SkiFree
    // (the loaded bundle code) in place — re-mount reuses it.
    delete (globalThis as unknown as { __skifree?: unknown }).__skifree;
  });
</script>

<div class="mod-card skifree-card" bind:this={cardEl}>
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <ModuleTitle {id} {data} defaultLabel="SKIFREE" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="game-area">
      <!-- The bundle controller binds to THIS canvas (window.SkiFree.create).
           tabindex makes it focusable so native mouse control can engage
           when x/y are unpatched. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <canvas
        bind:this={canvasEl}
        width={CSS}
        height={CSS}
        style={`width: ${CSS}px; height: ${CSS}px;`}
        tabindex="0"
        onfocus={onFocus}
        onblur={onBlur}
        data-viz-passthrough
        data-testid="skifree-canvas"
      ></canvas>

      {#if loadStatus === 'loading'}
        <div class="skifree-overlay">Loading…</div>
      {:else if loadStatus === 'error'}
        <div class="skifree-overlay skifree-overlay-err">Bundle failed: {loadError}</div>
      {/if}

      <div class="skifree-hud" data-testid="skifree-hud">
        {#if snapshot}
          <span>{snapshot.distance}m</span>
          <span>· lives {snapshot.lives}</span>
          <span class="ctl-mode">{snapshot.cvDriven ? 'CV' : (focused ? 'MOUSE' : 'IDLE')}</span>
          {#if snapshot.gameOver}<span class="over">GAME OVER</span>{/if}
        {/if}
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .skifree-card { width: 360px; min-height: 420px; }
  .skifree-card .game-area {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 6px 0 8px;
  }
  .skifree-card canvas {
    display: block;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
    border: 1px solid color-mix(in oklab, var(--cable-gate) 30%, transparent);
    border-radius: 2px;
    background: #cfe8ff; /* snow-white-blue idle */
    outline: none;
  }
  .skifree-card canvas:focus {
    border-color: var(--cable-gate);
  }
  .skifree-card .skifree-overlay {
    position: absolute;
    top: 12px;
    left: 12px;
    right: 12px;
    background: rgba(0, 0, 0, 0.7);
    color: #ffd040;
    padding: 6px 8px;
    border-radius: 2px;
    font-size: 11px;
    text-align: center;
    pointer-events: none;
  }
  .skifree-card .skifree-overlay-err { color: #ff5050; }
  .skifree-card .skifree-hud {
    display: flex;
    gap: 6px;
    margin-top: 6px;
    font-size: 10px;
    color: #88a;
    font-family: ui-monospace, monospace;
  }
  .skifree-card .skifree-hud .ctl-mode { color: var(--cable-gate); }
  .skifree-card .skifree-hud .over { color: #ff5050; font-weight: 700; }
</style>
