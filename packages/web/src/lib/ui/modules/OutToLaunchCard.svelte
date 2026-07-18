<script lang="ts">
  // OUT TO LAUNCH card — binds a Novation Launchpad Mini Mk3 as a live 9×9 RGB
  // video MONITOR + shows an on-card 9×9 preview of exactly what the LEDs show.
  //
  // Device lifecycle lives HERE (mirrors LaunchpadControlCard's connect UX): no
  // eager MIDI prompt — "Connect" runs the gesture-gated sysex request, then we
  // list the Launchpad output ports and bind the picked one as a monitor
  // (bindMonitor claims exclusive LED control of that device). The module's
  // pure-GL factory produces the 9×9 grid (read('grid9x9')); this card's rAF
  // loop reads it, draws the preview, and — throttled to ~30 fps — maps it to
  // LED colours (monitorGridToLeds) and pushes it (setMonitorFrame). On unbind /
  // node-delete we release the device (clears its LEDs + returns it to Live).

  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';
  import { outToLaunchDef } from '$lib/video/modules/out-to-launch';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import { onMount, onDestroy } from 'svelte';
  import {
    midiAvailable,
    connect as deviceConnect,
    enumerateLaunchpadPorts,
    bindMonitor,
    unbindMonitor,
    isMonitorBound,
    monitorOutputId,
    isOutputClaimed,
    setMonitorFrame,
    statusRune,
    type LaunchpadPort,
  } from '$lib/control/launchpad/launchpad-device.svelte';
  import {
    monitorGridToLeds,
    LP_MONITOR_COLS,
    LP_MONITOR_ROWS,
    lpMonitorIndex,
    rgb8ToLp,
    CC_LOGO,
    LP_RGB_MAX,
  } from '$lib/control/launchpad/launchpad-sysex';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const { defaultFor, paramVal, set } = cardParams(outToLaunchDef, () => id, () => node);

  const inputs = portsFromDef(outToLaunchDef.inputs, { in: 'VIDEO' });
  const outputs = portsFromDef(outToLaunchDef.outputs);

  const supported = midiAvailable();
  let status = $state<'idle' | 'listing' | 'no-midi' | 'no-device'>('idle');
  let ports = $state<LaunchpadPort[]>([]);

  // Reactive device state (statusRune bumps on any bind/unbind).
  let bound = $derived((statusRune(), isMonitorBound(id)));
  let boundOut = $derived((statusRune(), monitorOutputId(id)));

  const engineCtx = useEngine();
  function getVideoEngine(): VideoEngine | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      return e.getDomain<VideoEngine>('video') ?? null;
    } catch {
      return null;
    }
  }

  // ── Preview canvas (9×9) + throttled LED push ──
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;
  let lastPush = 0;
  const PUSH_FPS = 30;
  const PUSH_INTERVAL_MS = 1000 / PUSH_FPS;

  // Preview geometry.
  const CELL = 22;
  const GAP = 3;
  const PAD = 7;
  const CANVAS_PX = LP_MONITOR_COLS * CELL + (LP_MONITOR_COLS - 1) * GAP + PAD * 2; // square

  /** Display value for an 8-bit channel through the SAME transform the LEDs get
   *  (so the preview matches the hardware), then scaled back to 0..255. */
  function disp(v8: number, bright: number, gamma: number): number {
    return Math.round((rgb8ToLp(v8, bright, gamma) / LP_RGB_MAX) * 255);
  }

  function cellXY(col: number, row: number): { x: number; y: number } {
    // col 0..8 left→right; row 0..8 BOTTOM→top → canvas y is top-origin.
    const x = PAD + col * (CELL + GAP);
    const y = PAD + (LP_MONITOR_ROWS - 1 - row) * (CELL + GAP);
    return { x, y };
  }

  function drawPreview(grid: Uint8Array | undefined, bright: number, gamma: number): void {
    const c2d = canvasEl?.getContext('2d', { alpha: false });
    if (!c2d) return;
    c2d.fillStyle = '#060608';
    c2d.fillRect(0, 0, CANVAS_PX, CANVAS_PX);
    for (let row = 0; row < LP_MONITOR_ROWS; row++) {
      for (let col = 0; col < LP_MONITOR_COLS; col++) {
        const p = (row * LP_MONITOR_COLS + col) * 4;
        const r = grid ? disp(grid[p] ?? 0, bright, gamma) : 0;
        const g = grid ? disp(grid[p + 1] ?? 0, bright, gamma) : 0;
        const b = grid ? disp(grid[p + 2] ?? 0, bright, gamma) : 0;
        const { x, y } = cellXY(col, row);
        const index = lpMonitorIndex(col, row);
        const isPad = col < 8 && row < 8;
        // Socket (unlit) then the lit colour on top so the 9×9 is always visible.
        c2d.fillStyle = '#131318';
        paintCell(c2d, x, y, isPad, index);
        if (r + g + b > 0) {
          c2d.fillStyle = `rgb(${r}, ${g}, ${b})`;
          paintCell(c2d, x, y, isPad, index);
        }
      }
    }
  }

  /** Pads render as rounded squares; the top row / right column / logo render as
   *  circles to mirror the Launchpad's round buttons. */
  function paintCell(c2d: CanvasRenderingContext2D, x: number, y: number, isPad: boolean, index: number): void {
    c2d.beginPath();
    if (isPad) {
      const rr = 4;
      c2d.roundRect(x, y, CELL, CELL, rr);
    } else {
      const cx = x + CELL / 2;
      const cy = y + CELL / 2;
      const rad = index === CC_LOGO ? CELL * 0.32 : CELL * 0.42;
      c2d.arc(cx, cy, rad, 0, Math.PI * 2);
    }
    c2d.fill();
  }

  function tick(): void {
    rafId = null;
    const bright = paramVal('bright');
    const gamma = paramVal('gamma');
    const ve = getVideoEngine();
    const grid = (ve?.read(id, 'grid9x9') as Uint8Array | undefined) ?? undefined;
    drawPreview(grid, bright, gamma);
    if (bound && grid) {
      const now = performance.now();
      if (now - lastPush >= PUSH_INTERVAL_MS) {
        lastPush = now;
        const leds = monitorGridToLeds(grid, { bright, gamma });
        setMonitorFrameSafe(id, leds);
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  onMount(() => {
    if (canvasEl) {
      canvasEl.width = CANVAS_PX;
      canvasEl.height = CANVAS_PX;
    }
    rafId = requestAnimationFrame(tick);
  });
  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (isMonitorBound(id)) unbindMonitor(id);
  });

  // setMonitorFrame no-ops if the token is unbound, so the push path is safe.
  function setMonitorFrameSafe(token: string, leds: Map<number, [number, number, number]>): void {
    setMonitorFrame(token, { leds });
  }

  async function connectAndList() {
    if (!supported) { status = 'no-midi'; return; }
    status = 'listing';
    await deviceConnect();
    ports = enumerateLaunchpadPorts();
    status = ports.length > 0 ? 'idle' : 'no-device';
  }

  function pick(port: LaunchpadPort) {
    bindMonitor(id, port.outputId);
  }
  function unbind() {
    unbindMonitor(id);
  }
  const isClaimedByOther = (port: LaunchpadPort) => isOutputClaimed(port.outputId, id);
</script>

<div class="mod-card otl-card" data-testid="out-to-launch-card" data-node-id={id}>
  <div class="stripe" style="background: var(--cable-video);"></div>
  <ModuleTitle {id} {data} defaultLabel="OUT TO LAUNCH" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="screen-wrap">
      <canvas bind:this={canvasEl} class="screen" data-testid="out-to-launch-preview"></canvas>
    </div>

    {#if bound}
      <div class="otl-banner" data-testid="out-to-launch-active">
        <b>MONITOR ACTIVE</b> — this Launchpad’s LEDs mirror the video. It can’t be used for control while bound.
      </div>
    {/if}

    <div class="row">
      <div class="knob-box">
        <Knob
          value={paramVal('bright')}
          min={0} max={1} defaultValue={defaultFor('bright')}
          label="BRIGHT" curve="linear"
          onchange={set('bright')} moduleId={id} paramId="bright"
        />
      </div>
      <div class="knob-box">
        <Knob
          value={paramVal('gamma')}
          min={0.5} max={3} defaultValue={defaultFor('gamma')}
          label="GAMMA" curve="linear"
          onchange={set('gamma')} moduleId={id} paramId="gamma"
        />
      </div>
    </div>

    <div class="otl-device nodrag">
      {#if !supported}
        <div class="otl-warn" data-testid="out-to-launch-nomidi">
          Web MIDI isn’t available in this browser — open in Chrome/Edge to drive a Launchpad.
        </div>
      {:else if bound}
        <div class="otl-status">Bound to <code>{boundOut}</code>.</div>
        <button class="otl-btn" type="button" data-testid="out-to-launch-unbind" onclick={unbind}>
          Unbind Launchpad
        </button>
      {:else}
        <button class="otl-btn" type="button" data-testid="out-to-launch-connect" onclick={connectAndList}>
          {status === 'listing' ? 'Connecting…' : 'Connect Launchpad'}
        </button>
        {#if status === 'no-device'}
          <div class="otl-warn" data-testid="out-to-launch-nodevice">
            No Launchpad detected. Plug one in (it shows up as a “… MIDI” port) and Connect again.
          </div>
        {:else if ports.length > 0}
          <div class="otl-picker" data-testid="out-to-launch-picker">
            {#each ports as p (p.outputId)}
              <button
                class="otl-btn otl-port"
                type="button"
                disabled={isClaimedByOther(p)}
                title={isClaimedByOther(p) ? 'Already in use by another binding' : 'Bind as monitor'}
                onclick={() => pick(p)}
              >
                {p.name}{isClaimedByOther(p) ? ' (in use)' : ''}
              </button>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  </PatchPanel>
</div>

<style>
  .mod-card {
    width: 300px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 12px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }
  .screen-wrap {
    margin: 8px auto 8px;
    width: fit-content;
    border: 1px solid #000;
    border-radius: 6px;
    background: #060608;
    box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.7), 0 0 4px rgba(0, 0, 0, 0.3);
    overflow: hidden;
  }
  .screen { display: block; image-rendering: pixelated; }
  .otl-banner {
    margin: 0 10px 6px;
    background: rgba(60, 180, 90, 0.14);
    border: 1px solid #3cb45a;
    border-radius: 4px;
    padding: 5px 8px;
    color: #b7f0c6;
    font-size: 10px;
    line-height: 1.3;
  }
  .otl-banner b { color: #d6ffe2; }
  .row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 24px;
    padding: 2px 16px 6px;
  }
  .knob-box { display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .otl-device { display: flex; flex-direction: column; gap: 6px; padding: 0 10px; }
  .otl-picker { display: flex; flex-direction: column; gap: 4px; }
  .otl-btn {
    appearance: none; border: 1px solid var(--accent, #5a7); background: transparent;
    color: var(--accent, #5a7); border-radius: 4px; padding: 5px 10px; font-size: 11px; cursor: pointer;
    text-align: left;
  }
  .otl-btn:hover:not(:disabled) { filter: brightness(1.2); }
  .otl-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .otl-port { font-family: ui-monospace, monospace; }
  .otl-status { font-size: 11px; color: #9aa0b2; }
  .otl-status code { color: #cfd3df; }
  .otl-warn {
    background: #2a1b1b; border: 1px solid #5a2a2a; border-radius: 4px;
    padding: 6px 8px; color: #e8b0b0; font-size: 10px; line-height: 1.3;
  }
</style>
