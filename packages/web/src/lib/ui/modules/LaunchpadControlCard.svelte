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
  import { isSingleBound } from '$lib/control/launchpad/launchpad-device.svelte';
  import {
    startPairing,
    startSingle,
    cancelPairing,
    isPairing,
    pairRune,
    restoreLaunchpadPair,
    restoreLaunchpadSingle,
    bindLaunchpadToClip,
    unbindLaunchpad,
    boundClipNode,
    bindingRune,
    launchpadDeployment,
    launchpadActiveView,
    setLaunchpadView,
    restoreLaunchpadDeployment,
    viewRune,
  } from '$lib/control/launchpad/launchpad-control.svelte';
  import type { SingleView } from '$lib/control/launchpad/launchpad-map';

  let { id, data }: NodeProps = $props();

  // Seed the persisted deployment + view (per-machine) so the card shows the
  // last-used mode on mount. The actual device re-bind still needs a gesture
  // (Pair / Connect) for Web-MIDI access — this only restores the UI state.
  restoreLaunchpadDeployment();

  const supported = midiAvailable();
  let status = $state<'idle' | 'pairing' | 'paired' | 'no-midi' | 'one-unit' | 'no-device'>('idle');

  // Reactive: re-derive on device status / pairing / binding changes.
  let bound = $derived((statusRune(), pairRune(), bindingRune(), boundClipNode()));
  // "Connected" = a PAIR (two units) OR a SINGLE unit (one device, L slot).
  let paired = $derived((statusRune(), pairRune(), viewRune(), isPairBound() || isSingleBound()));
  // Which deployment + (single-mode) which view — drives the toggle UI.
  let deployment = $derived((statusRune(), pairRune(), viewRune(), launchpadDeployment()));
  let activeView = $derived((statusRune(), pairRune(), viewRune(), launchpadActiveView()));
  let isSingle = $derived((statusRune(), pairRune(), viewRune(), isSingleBound()));
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

  /** SINGLE-UNIT connect: bind ONE Launchpad to the L slot; a view toggle flips
   *  it between the clip matrix (L role) and the command deck/editor (R role). */
  async function connectSingle() {
    if (!supported) { status = 'no-midi'; return; }
    if (isPairing()) { cancelPairing(); }
    status = 'pairing';
    const ok = await startSingle(() => {
      status = 'paired';
      autoBind();
    });
    if (!ok) {
      // connected but no device? maybe a saved single restores silently.
      if (restoreLaunchpadSingle()) { status = 'paired'; autoBind(); }
      else status = supported ? 'no-device' : 'no-midi';
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

  // The 4 single-mode views (KEYS is a sub-mode of Clip, entered on the device).
  const VIEWS: { id: SingleView; label: string }[] = [
    { id: 'grid', label: 'GRID' },
    { id: 'clip', label: 'CLIP' },
    { id: 'arranger', label: 'ARR' },
    { id: 'control', label: 'CTRL' },
  ];
  function pickView(v: SingleView) {
    setLaunchpadView(v);
  }
  const viewLabel = (v: SingleView) =>
    v === 'grid' ? 'GRID' : v === 'clip' ? 'CLIP' : v === 'arranger' ? 'ARRANGER' : 'CONTROL';
</script>

<div class="mod-card launchpad-control-card" data-testid="launchpad-control-card" data-node-id={id}>
  <div class="lp-titlebar">
    <ModuleTitle {id} {data} defaultLabel="LAUNCHPAD CONTROL" inline={true} />
  </div>

  <div class="lp-body">
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
          {:else if paired && deployment === 'pair'}
            Re-pair Launchpads
          {:else}
            Pair Launchpads
          {/if}
        </button>
        <button
          class="lp-btn nodrag"
          type="button"
          data-testid="launchpad-control-single"
          onclick={connectSingle}
        >
          {paired && isSingle ? 'Re-connect single' : 'Connect single Launchpad'}
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

      {#if paired && isSingle}
        <div class="lp-actions lp-view-seg" role="group" aria-label="Launchpad view" data-testid="launchpad-control-view-seg">
          {#each VIEWS as v (v.id)}
            <button
              class="lp-btn lp-view-btn nodrag"
              class:active={activeView === v.id}
              type="button"
              data-testid={`launchpad-control-view-${v.id}`}
              aria-pressed={activeView === v.id}
              onclick={() => pickView(v.id)}
            >
              {v.label}
            </button>
          {/each}
        </div>
      {/if}

      {#if status === 'one-unit'}
        <div class="lp-warn" data-testid="launchpad-control-oneunit">
          One Launchpad — use <b>Connect single</b>, or plug in both for the split.
        </div>
      {:else if status === 'no-device'}
        <div class="lp-warn" data-testid="launchpad-control-nodevice">
          No Launchpad detected — plug one in, then <b>Connect single</b>.
        </div>
      {:else}
        <div class="lp-status" data-testid="launchpad-control-status">
          {#if pairingNow}
            Both Launchpads should light up (green + blue) — press any pad on the one you want as the LEFT (matrix) unit; the other becomes RIGHT.
          {:else if status === 'no-midi'}
            Couldn’t access MIDI — allow the permission prompt and try again.
          {:else if !paired}
            Not connected.
          {:else if isSingle && bound}
            Single unit driving clip-player <code>{bound}</code> — <b>{viewLabel(activeView)}</b> view (top row or the buttons to switch).
          {:else if isSingle && hasClip}
            Single unit ✓ — hit Bind to drive your clip-player.
          {:else if isSingle}
            Single unit ✓ — add a clip-player module to drive (auto-binds it).
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
  .lp-view-seg { gap: 4px; }
  .lp-view-btn { flex: 1 1 0; text-align: center; padding: 4px 6px; letter-spacing: 0.04em; opacity: 0.72; }
  .lp-view-btn.active { border-color: #8a6fd6; color: #b79cf0; background: rgba(120, 80, 200, 0.14); opacity: 1; }
  .lp-status { font-size: 11px; color: #9aa0b2; }
  .lp-status code { color: #cfd3df; }
  .lp-hint { margin: 0; font-size: 10px; color: #6f7488; }
  .lp-hint b { color: #9aa0b2; }
</style>
