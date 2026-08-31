<script lang="ts">
  // ElectraConnectButton — the gated "Send to Electra" affordance.
  //
  // Lives ON the ELECTRA CONTROL card (ElectraControlCard.svelte) — the send
  // action belongs to the module, so a rack WITHOUT an ElectraControl has no
  // send button (it was moved off the global topbar). Like
  // the MIDI-CV-BUDDY "Connect MIDI…" button, it does NOT request MIDI access on
  // mount — clicking it is the explicit, on-demand action that triggers the
  // (sysex-capable) permission prompt + the full automagic flow:
  //   identify → enumerate patch → generate .epr → push preset + Lua →
  //   import the CC map → start the feedback pump → switch to page 1.
  //
  // No eager prompt: the singleton broker only calls navigator.requestMIDIAccess
  // when run() is invoked here.

  // ⚠ THE FLASH ITSELF NO LONGER LIVES HERE. It moved to
  // `$lib/ui/modules/electra-cell-actions.ts` when electraControl was promoted,
  // because a ranked ACTION cell is rendered by the SHARED shell and its
  // `onFire` is a plain function — so the gesture needed a home outside any
  // component. This button is now a THIN RENDERER over that seam, which is what
  // keeps the legacy card (still live under `?shell=legacy`) and the faceplate
  // running ONE flash rather than two implementations that can disagree about a
  // hardware pipeline.
  //
  // What did NOT change: the testid, the caption vocabulary, the disabled rule,
  // the pointer guard, and the crosstalk guard (`stop()` before every run) —
  // that one just runs inside the seam now, on the run that needs it, instead of
  // on whichever component happened to unmount last.

  import { onDestroy } from 'svelte';
  import {
    electraSendToDevice,
    electraFlashOutcome,
    onElectraFlash,
    clearElectraBadges,
  } from '$lib/ui/modules/electra-cell-actions';

  let { nodeId = 'electra' }: { nodeId?: string } = $props();

  let outcome = $state(electraFlashOutcome());
  const off = onElectraFlash(() => { outcome = electraFlashOutcome(); });

  function onClick(): void {
    electraSendToDevice(nodeId);
  }

  onDestroy(() => {
    off();
    clearElectraBadges();
  });
</script>

<button
  class="electra-btn nodrag"
  type="button"
  data-testid="electra-connect-button"
  onclick={onClick}
  onpointerdown={(e) => e.stopPropagation()}
  disabled={outcome.status === 'connecting'}
  aria-label={outcome.detail
    ? `Send this board to the Electra One — ${outcome.detail}`
    : 'Send this board to the Electra One'}
  title={outcome.status === 'error' && outcome.detail
    ? outcome.detail
    : 'Generate a 3-page Electra One preset (Control Surface / MixMaster / System) from this rack and push it to a connected Electra. Asks for MIDI access on first click.'}
>
  {#if outcome.status === 'connecting'}
    Configuring…
  {:else if outcome.status === 'ready'}
    Electra ✓
  {:else if outcome.status === 'no-device'}
    No MIDI
  {:else if outcome.status === 'error'}
    Electra ✗
  {:else}
    Send to Electra
  {/if}
</button>

<style>
  .electra-btn {
    appearance: none;
    border: 1px solid var(--accent, #5a7);
    background: transparent;
    color: var(--accent, #5a7);
    border-radius: 4px;
    padding: 3px 10px;
    font-size: 12px;
    cursor: pointer;
  }
  .electra-btn:hover:not(:disabled) { filter: brightness(1.2); }
  .electra-btn:disabled { opacity: 0.6; cursor: default; }
</style>
