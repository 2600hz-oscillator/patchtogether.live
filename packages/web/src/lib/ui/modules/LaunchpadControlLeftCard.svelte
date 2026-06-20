<script lang="ts">
  // LAUNCHPAD CONTROL · LEFT card — the always-live 8×8 CLIP MATRIX unit.
  //
  // Modeled on ElectraControl/ElectraConnectButton: no eager MIDI prompt. The
  // "Pair Launchpads" button runs the press-a-pad L/R handshake on the first
  // click (gesture-gated sysex request). Once paired + a clip-player exists, the
  // card binds the LEFT Launchpad to it. The card itself has no audio I/O — all
  // hardware state is per-machine local; LED frames never touch the Y.Doc.
  //
  // Both the LEFT + RIGHT cards drive the SAME physical pair through the one
  // launchpad-device + launchpad-control singleton — so either card's Pair
  // button performs the same handshake, and binding to a clip-player from either
  // card binds the whole pair.

  import type { NodeProps } from '@xyflow/svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import { patch } from '$lib/graph/store';
  import {
    midiAvailable,
    isPairBound,
    statusRune,
  } from '$lib/control/launchpad/launchpad-device.svelte';
  import {
    startPairing,
    cancelPairing,
    isPairing,
    pairRune,
    restoreLaunchpadPair,
    bindLaunchpadToClip,
    unbindLaunchpad,
    boundClipNode,
    bindingRune,
  } from '$lib/control/launchpad/launchpad-control.svelte';
  import {
    RGB_PLAYING,
    RGB_QUEUED,
    RGB_LOADED,
    RGB_QUEUED_STOP,
    RGB_SCENE,
    RGB_COPY_BUFFER,
    type Rgb,
  } from '$lib/control/launchpad/launchpad-map';

  let { id, data }: NodeProps = $props();

  const supported = midiAvailable();
  let status = $state<'idle' | 'pairing' | 'paired' | 'no-midi' | 'one-unit'>('idle');

  // Reactive: re-derive on device status / pairing / binding changes.
  let bound = $derived((statusRune(), pairRune(), bindingRune(), boundClipNode()));
  let paired = $derived((statusRune(), pairRune(), isPairBound()));

  /** The first clip-player node in the patch (the matrix drives one). */
  function firstClipplayer(): string | null {
    for (const [nid, n] of Object.entries(patch.nodes)) {
      if ((n as { type?: string } | undefined)?.type === 'clipplayer') return nid;
    }
    return null;
  }

  async function pair() {
    if (!supported) { status = 'no-midi'; return; }
    if (isPairing()) { cancelPairing(); status = 'idle'; return; }
    // Try restoring a saved pair first (no prompt) — connect happens in start.
    status = 'pairing';
    const ok = await startPairing(() => {
      status = 'paired';
      autoBind();
    });
    if (!ok) {
      // startPairing already connected; maybe a saved pair restores silently.
      if (restoreLaunchpadPair()) { status = 'paired'; autoBind(); }
      else status = supported ? 'one-unit' : 'no-midi';
    }
  }

  function autoBind() {
    const cp = firstClipplayer();
    if (cp && boundClipNode() !== cp) bindLaunchpadToClip(cp);
  }

  function toggleBind() {
    if (boundClipNode()) { unbindLaunchpad(); return; }
    autoBind();
  }

  // Colour legend (drives the in-card swatches AND the in-app docs).
  const hex = (c: Rgb) => `rgb(${Math.round((c[0] / 127) * 255)},${Math.round((c[1] / 127) * 255)},${Math.round((c[2] / 127) * 255)})`;
  const LEGEND: { label: string; rgb: Rgb }[] = [
    { label: 'playing', rgb: RGB_PLAYING },
    { label: 'queued', rgb: RGB_QUEUED },
    { label: 'queued-stop', rgb: RGB_QUEUED_STOP },
    { label: 'loaded', rgb: RGB_LOADED },
    { label: 'scene', rgb: RGB_SCENE },
    { label: 'copy buffer', rgb: RGB_COPY_BUFFER },
  ];
</script>

<div class="mod-card launchpad-control-card lp-left" data-testid="launchpad-control-left-card" data-node-id={id}>
  <div class="lp-titlebar">
    <ModuleTitle {id} {data} defaultLabel="LAUNCHPAD L · MATRIX" inline={true} />
  </div>

  <div class="lp-body">
    <p class="lp-blurb">
      The <b>left</b> Launchpad is the always-live <b>8×8 clip matrix</b>: rows = lanes,
      columns = slots. Tap a pad to launch/stop a clip; the right column launches a whole scene.
    </p>

    {#if !supported}
      <div class="lp-warn" data-testid="launchpad-control-left-nomidi">
        Web MIDI isn’t available in this browser — connect a Launchpad in Chrome/Edge.
      </div>
    {:else}
      <div class="lp-actions">
        <button
          class="lp-btn nodrag"
          type="button"
          data-testid="launchpad-control-left-pair"
          onclick={pair}
        >
          {#if status === 'pairing'}
            Press a pad on the LEFT unit…
          {:else if paired}
            Re-pair Launchpads
          {:else}
            Pair Launchpads
          {/if}
        </button>
        {#if paired}
          <button
            class="lp-btn nodrag"
            type="button"
            data-testid="launchpad-control-left-bind"
            onclick={toggleBind}
          >
            {bound ? 'Unbind clip-player' : 'Bind to clip-player'}
          </button>
        {/if}
      </div>
      <div class="lp-status" data-testid="launchpad-control-left-status">
        {#if !paired}
          Not paired.
        {:else if bound}
          Driving clip-player <code>{bound}</code>.
        {:else}
          Paired ✓ — add a clip-player, then Bind.
        {/if}
      </div>
    {/if}

    <div class="lp-legend" data-testid="launchpad-control-left-legend">
      {#each LEGEND as l (l.label)}
        <span class="lp-swatch" title={l.label}>
          <span class="lp-chip" style:background={hex(l.rgb)}></span>{l.label}
        </span>
      {/each}
    </div>
  </div>
</div>

<style>
  .launchpad-control-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    min-width: 230px;
    max-width: 300px;
    color: var(--text, #cfd3df);
    font-size: 12px;
  }
  .lp-titlebar { display: flex; align-items: center; justify-content: space-between; }
  .lp-body { display: flex; flex-direction: column; gap: 8px; }
  .lp-blurb { margin: 0; line-height: 1.35; color: #9aa0b2; font-size: 11px; }
  .lp-blurb b { color: #cfd3df; }
  .lp-warn {
    background: #2a1b1b; border: 1px solid #5a2a2a; border-radius: 4px;
    padding: 6px 8px; color: #e8b0b0; font-size: 11px;
  }
  .lp-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .lp-btn {
    appearance: none; border: 1px solid var(--accent, #5a7); background: transparent;
    color: var(--accent, #5a7); border-radius: 4px; padding: 4px 10px; font-size: 12px; cursor: pointer;
  }
  .lp-btn:hover { filter: brightness(1.2); }
  .lp-status { font-size: 11px; color: #9aa0b2; }
  .lp-status code { color: #cfd3df; }
  .lp-legend { display: flex; flex-wrap: wrap; gap: 6px 10px; padding-top: 2px; }
  .lp-swatch { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: #9aa0b2; }
  .lp-chip { width: 12px; height: 12px; border-radius: 3px; display: inline-block; border: 1px solid #2b2e38; }
</style>
