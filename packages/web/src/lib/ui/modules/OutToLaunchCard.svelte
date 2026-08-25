<script lang="ts">
  // OUT TO LAUNCH card — binds a Novation Launchpad Mini Mk3 as a live 9×9 RGB
  // video MONITOR + shows an on-card 9×9 preview of exactly what the LEDs show.
  //
  // ⚠ THE DEVICE DOES NOT BELONG TO THIS CARD (#1728). It used to: `onDestroy`
  // called `unbindMonitor(id)`, which blanks all 81 LEDs, hands the Launchpad
  // back to Live mode and drops the claim — and a card unmounts on COLLAPSE, on
  // dock LRU eviction when a THIRD unrelated module is expanded, on ESC and on
  // navigation. Since `outToLaunch` is `bespoke-surface` its card only ever
  // exists inside the dock full-view, so closing that pane took the performer's
  // Launchpad dark mid-set with no re-bind on remount (measured: the card came
  // back showing "Connect Launchpad" with no port picker).
  //
  // The claim and the 30 fps LED PUMP now live on the NODE, in
  // $lib/ui/modules/node-launchpad-monitor-registry — the card ADOPTS and
  // READS. Teardown is keyed to GRAPH lifetime via that registry's
  // `sweep(liveNodeIds)` from Canvas. There is deliberately no teardown method
  // on the registry to call from a lifecycle hook.
  //
  // WHAT IS STILL CARD-LIFETIME, correctly: the on-card 9×9 PREVIEW canvas and
  // the rAF that paints it. A canvas that is not in the DOM cannot be drawn to,
  // so that rAF SHOULD die with the mount — and it no longer carries the LED
  // push, so its death costs the hardware nothing.

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
    isOutputClaimed,
    statusRune,
    type LaunchpadPort,
  } from '$lib/control/launchpad/launchpad-device.svelte';
  import { nodeLaunchpadMonitor } from './node-launchpad-monitor-registry.svelte';
  // ⚠ THE PREVIEW ARITHMETIC MOVED OUT OF THIS FILE and is now imported by BOTH
  // surfaces. Promotion means the faceplate body draws the same 9×9, and no
  // runtime gate compares two `.svelte` files — so a re-typed copy in the body
  // could have diverged silently and shown a different picture than this card
  // and the hardware. One module, two importers.
  import {
    drawOutToLaunchPreview,
    OTL_PREVIEW_PX,
  } from './outToLaunch/out-to-launch-preview';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const { defaultFor, paramVal, set } = cardParams(outToLaunchDef, () => id, () => node);

  const inputs = portsFromDef(outToLaunchDef.inputs, { in: 'VIDEO' });
  const outputs = portsFromDef(outToLaunchDef.outputs);

  const supported = midiAvailable();
  let status = $state<'idle' | 'listing' | 'no-midi' | 'no-device'>('idle');
  let ports = $state<LaunchpadPort[]>([]);

  // Reactive device state, read from the NODE's registry — not from card state.
  // A card that re-mounts onto a live binding must show MONITOR ACTIVE, which
  // is the whole point of the registry. (statusRune is still folded in so a
  // bind/unbind made through the device layer by any other route repaints too.)
  let bound = $derived((statusRune(), nodeLaunchpadMonitor.view(id).bound));
  let boundOut = $derived((statusRune(), nodeLaunchpadMonitor.view(id).outputId));

  const engineCtx = useEngine();
  // ADOPT — idempotent and non-destructive. Re-pins the engine accessor on
  // every mount (a reboot swaps the instance) and never resets a live bind.
  $effect(() => {
    nodeLaunchpadMonitor.adopt(id, engineCtx);
  });
  function getVideoEngine(): VideoEngine | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      return e.getDomain<VideoEngine>('video') ?? null;
    } catch {
      return null;
    }
  }

  // ── Preview canvas (9×9). The LED push + its throttle moved to the node
  //    registry with the pump (#1728); nothing on this card writes to hardware.
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  function drawPreview(grid: Uint8Array | undefined, bright: number, gamma: number): void {
    const c2d = canvasEl?.getContext('2d', { alpha: false });
    if (!c2d) return;
    drawOutToLaunchPreview(c2d, grid, bright, gamma);
  }

  /** PREVIEW ONLY. The LED push moved to the node registry's pump (#1728); this
   *  loop paints the on-card canvas and nothing else, so it is correct for it to
   *  live and die with the mount. */
  function tick(): void {
    rafId = null;
    const ve = getVideoEngine();
    const grid = (ve?.read(id, 'grid9x9') as Uint8Array | undefined) ?? undefined;
    drawPreview(grid, paramVal('bright'), paramVal('gamma'));
    rafId = requestAnimationFrame(tick);
  }

  onMount(() => {
    if (canvasEl) {
      canvasEl.width = OTL_PREVIEW_PX;
      canvasEl.height = OTL_PREVIEW_PX;
    }
    rafId = requestAnimationFrame(tick);
  });
  onDestroy(() => {
    // ⚠ THE PREVIEW rAF, AND NOTHING ELSE. Releasing the Launchpad here is
    // #1728 — a collapse is not the performer saying they are finished with
    // their hardware. The device is released by the registry's graph sweep, or
    // by the user pressing Unbind.
    if (rafId !== null) cancelAnimationFrame(rafId);
  });

  async function connectAndList() {
    if (!supported) { status = 'no-midi'; return; }
    status = 'listing';
    await deviceConnect();
    ports = enumerateLaunchpadPorts();
    status = ports.length > 0 ? 'idle' : 'no-device';
  }

  function pick(port: LaunchpadPort) {
    nodeLaunchpadMonitor.bind(id, port.outputId);
  }
  /** The USER's explicit release — named for their intent, not a lifecycle. */
  function unbind() {
    nodeLaunchpadMonitor.unbind(id);
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
