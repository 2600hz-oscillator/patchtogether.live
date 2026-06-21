<script lang="ts">
  // LAUNCHPAD CONTROL card — drives a PAIR of Novation Launchpad Mini Mk3 units
  // (consolidates the former LEFT + RIGHT cards into ONE compact unit). The LEFT
  // unit is the always-live 8×8 clip matrix; the RIGHT unit is the command deck
  // + note editor. Both halves drive the SAME physical pair through the one
  // launchpad-device + launchpad-control singleton.
  //
  // Modeled on ElectraControl/ElectraConnectButton: no eager MIDI prompt. The
  // "Pair Launchpads" button runs the press-a-pad L/R handshake on the first
  // click (gesture-gated sysex request). Once paired + a clip-player exists, the
  // card binds the pair to it. The card itself has no audio I/O — all hardware
  // state is per-machine local; LED frames never touch the Y.Doc.
  //
  // The full firmware-accurate colour language lives in LaunchpadDocs (right-
  // click the card → "View docs"); this card carries only a one-line pointer.

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

  let { id, data }: NodeProps = $props();

  const supported = midiAvailable();
  let status = $state<'idle' | 'pairing' | 'paired' | 'no-midi' | 'one-unit'>('idle');

  // Reactive: re-derive on device status / pairing / binding changes.
  let bound = $derived((statusRune(), pairRune(), bindingRune(), boundClipNode()));
  let paired = $derived((statusRune(), pairRune(), isPairBound()));
  // Pairing is ONE shared handshake — derive the live state from the singleton.
  let pairingNow = $derived((statusRune(), pairRune(), isPairing()));

  /** The first clip-player node in the patch (the matrix drives one). */
  function firstClipplayer(): string | null {
    for (const [nid, n] of Object.entries(patch.nodes)) {
      if ((n as { type?: string } | undefined)?.type === 'clipplayer') return nid;
    }
    return null;
  }
  // Reactive: is there a clip-player on the canvas to bind to? The Bind button
  // only makes sense when one exists — otherwise it's a dead no-op.
  let hasClip = $derived((bindingRune(), statusRune(), firstClipplayer() !== null));

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
</script>

<div class="mod-card launchpad-control-card" data-testid="launchpad-control-card" data-node-id={id}>
  <div class="lp-titlebar">
    <ModuleTitle {id} {data} defaultLabel="LAUNCHPAD CONTROL" inline={true} />
  </div>

  <div class="lp-body">
    <p class="lp-blurb">
      Drives a <b>pair</b> of Launchpad Mini Mk3: the <b>left</b> unit is the always-live
      <b>8×8 clip matrix</b> (tap to launch/stop; right column = scene); the <b>right</b> unit is the
      <b>command deck</b> (EDIT · COPY · PASTE · DOUBLE · LENGTH · NOW + per-lane STOP + transport)
      and flips to the <b>note editor</b> while you edit.
    </p>

    {#if !supported}
      <div class="lp-warn" data-testid="launchpad-control-nomidi">
        Web MIDI isn’t available in this browser — connect a Launchpad in Chrome/Edge.
      </div>
    {:else}
      <div class="lp-actions">
        <button
          class="lp-btn nodrag"
          type="button"
          data-testid="launchpad-control-pair"
          onclick={pair}
        >
          {#if pairingNow}
            Press a pad on the unit you want as LEFT…
          {:else if paired}
            Re-pair Launchpads
          {:else}
            Pair Launchpads
          {/if}
        </button>
        {#if paired && (bound || hasClip)}
          <button
            class="lp-btn nodrag"
            type="button"
            data-testid="launchpad-control-bind"
            onclick={toggleBind}
          >
            {bound ? 'Unbind clip-player' : 'Bind to clip-player'}
          </button>
        {/if}
      </div>

      {#if status === 'one-unit'}
        <div class="lp-warn" data-testid="launchpad-control-oneunit">
          <b>Only ONE Launchpad detected.</b> This card needs BOTH units of the pair — connect the
          second unit (each shows up as its own “… MIDI” port), then hit <b>Pair</b> again.
        </div>
      {:else}
        <div class="lp-status" data-testid="launchpad-control-status">
          {#if pairingNow}
            Both Launchpads should light up (green + blue) — press any pad on the one you want as the LEFT (matrix) unit; the other becomes RIGHT.
          {:else if status === 'no-midi'}
            Couldn’t access MIDI — allow the permission prompt and try Pair again.
          {:else if !paired}
            Not paired.
          {:else if bound}
            Driving clip-player <code>{bound}</code>.
          {:else if hasClip}
            Paired ✓ — hit Bind to drive your clip-player.
          {:else}
            Paired ✓ — add a clip-player module to drive (pairing auto-binds it).
          {/if}
        </div>
      {/if}
    {/if}

    <p class="lp-hint" data-testid="launchpad-control-docs-hint">
      Colour guide → right-click → <b>View docs</b>.
    </p>
  </div>
</div>

<style>
  .launchpad-control-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 7px 8px;
    min-width: 320px;
    max-width: 340px;
    color: var(--text, #cfd3df);
    font-size: 12px;
  }
  .lp-titlebar { display: flex; align-items: center; justify-content: space-between; }
  .lp-body { display: flex; flex-direction: column; gap: 5px; }
  .lp-blurb { margin: 0; line-height: 1.28; color: #9aa0b2; font-size: 11px; }
  .lp-blurb b { color: #cfd3df; }
  .lp-warn {
    background: #2a1b1b; border: 1px solid #5a2a2a; border-radius: 4px;
    padding: 6px 8px; color: #e8b0b0; font-size: 11px;
  }
  .lp-warn b { color: #f4cccc; }
  .lp-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .lp-btn {
    appearance: none; border: 1px solid var(--accent, #5a7); background: transparent;
    color: var(--accent, #5a7); border-radius: 4px; padding: 4px 10px; font-size: 12px; cursor: pointer;
  }
  .lp-btn:hover { filter: brightness(1.2); }
  .lp-status { font-size: 11px; color: #9aa0b2; }
  .lp-status code { color: #cfd3df; }
  .lp-hint { margin: 0; font-size: 10px; color: #6f7488; }
  .lp-hint b { color: #9aa0b2; }
</style>
