<script lang="ts">
  // LAUNCHPAD CONTROL · RIGHT card — the COMMAND DECK / NOTE EDITOR unit.
  //
  // Sibling of LaunchpadControlLeftCard. Same connect/pair/bind flow (both cards
  // drive the same physical pair through the one launchpad-control singleton);
  // this card documents the DECK + EDITOR side: EDIT/COPY/PASTE/PASTE-REV/
  // DOUBLE/LENGTH/NOW + per-lane STOP + transport, and the note editor with
  // ▲▼◀▶ + SHIFT(×8) windowing.

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
    RGB_FUNC,
    RGB_FUNC_ON,
    RGB_COPY_BUFFER,
    RGB_STOP_ACTIVE,
    RGB_TRANSPORT_ON,
    RGB_NOTE_BY_VEL,
    RGB_NOTE_PLAYHEAD,
    type Rgb,
  } from '$lib/control/launchpad/launchpad-map';

  let { id, data }: NodeProps = $props();

  const supported = midiAvailable();
  let status = $state<'idle' | 'pairing' | 'paired' | 'no-midi' | 'one-unit'>('idle');

  let bound = $derived((statusRune(), pairRune(), bindingRune(), boundClipNode()));
  let paired = $derived((statusRune(), pairRune(), isPairBound()));
  // Pairing is ONE shared handshake across both cards — derive the live state
  // from the singleton so both cards always agree (was per-card local `status`,
  // which let the two cards show different labels at once).
  let pairingNow = $derived((statusRune(), pairRune(), isPairing()));

  function firstClipplayer(): string | null {
    for (const [nid, n] of Object.entries(patch.nodes)) {
      if ((n as { type?: string } | undefined)?.type === 'clipplayer') return nid;
    }
    return null;
  }
  // Reactive: is there a clip-player on the canvas to bind to? (Reads the live
  // patch so it updates as clip-players are added/removed.) The Bind button only
  // makes sense when one exists — otherwise it's a dead no-op.
  let hasClip = $derived((bindingRune(), statusRune(), firstClipplayer() !== null));

  async function pair() {
    if (!supported) { status = 'no-midi'; return; }
    if (isPairing()) { cancelPairing(); status = 'idle'; return; }
    status = 'pairing';
    const ok = await startPairing(() => {
      status = 'paired';
      autoBind();
    });
    if (!ok) {
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

  const hex = (c: Rgb) => `rgb(${Math.round((c[0] / 127) * 255)},${Math.round((c[1] / 127) * 255)},${Math.round((c[2] / 127) * 255)})`;
  const LEGEND: { label: string; rgb: Rgb }[] = [
    { label: 'function', rgb: RGB_FUNC },
    { label: 'held mod', rgb: RGB_FUNC_ON },
    { label: 'copy buffer', rgb: RGB_COPY_BUFFER },
    { label: 'lane playing (stop)', rgb: RGB_STOP_ACTIVE },
    { label: 'transport / FOLLOW', rgb: RGB_TRANSPORT_ON },
    { label: 'note (vel)', rgb: RGB_NOTE_BY_VEL[2] },
    { label: 'playhead note', rgb: RGB_NOTE_PLAYHEAD },
  ];
</script>

<div class="mod-card launchpad-control-card lp-right" data-testid="launchpad-control-right-card" data-node-id={id}>
  <div class="lp-titlebar">
    <ModuleTitle {id} {data} defaultLabel="LAUNCHPAD R · DECK" inline={true} />
  </div>

  <div class="lp-body">
    <p class="lp-blurb">
      The <b>right</b> Launchpad is the <b>command deck</b> (EDIT · COPY · PASTE · DOUBLE ·
      LENGTH · NOW + per-lane STOP + transport) and <b>flips to the note editor</b> while you
      edit — so the left unit keeps the live matrix. ▲▼◀▶ scroll the editor; hold <b>SHIFT</b> for ×8.
    </p>

    {#if !supported}
      <div class="lp-warn" data-testid="launchpad-control-right-nomidi">
        Web MIDI isn’t available in this browser — connect a Launchpad in Chrome/Edge.
      </div>
    {:else}
      <div class="lp-actions">
        <button
          class="lp-btn nodrag"
          type="button"
          data-testid="launchpad-control-right-pair"
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
            data-testid="launchpad-control-right-bind"
            onclick={toggleBind}
          >
            {bound ? 'Unbind clip-player' : 'Bind to clip-player'}
          </button>
        {/if}
      </div>
      <div class="lp-status" data-testid="launchpad-control-right-status">
        {#if pairingNow}
          Both Launchpads should light up (green + blue) — press any pad on the one you want as the LEFT (matrix) unit; the other becomes RIGHT.
        {:else if status === 'one-unit'}
          Only one Launchpad detected — connect BOTH units (each shows up as its “… MIDI” port), then Pair again.
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

    <div class="lp-legend" data-testid="launchpad-control-right-legend">
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
    min-width: 240px;
    max-width: 320px;
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
