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

  import { onDestroy } from 'svelte';
  import { getActiveEngine } from '$lib/audio/engine-ref';
  import { ElectraAutoconfig } from '$lib/electra/autoconfig';
  import { buildLiveHost } from '$lib/electra/host';
  import { importBindings } from '$lib/midi/midi-learn.svelte';
  // The Lua layer is bundled as a raw string and uploaded to the device.
  import luaSource from '$lib/electra/lua-bundle';

  let status = $state<'idle' | 'connecting' | 'ready' | 'no-device' | 'error'>('idle');
  let detail = $state('');
  let auto: ElectraAutoconfig | null = null;

  async function onClick(): Promise<void> {
    if (status === 'connecting') return;
    status = 'connecting';
    detail = '';
    try {
      const host = buildLiveHost({ getEngine: () => getActiveEngine(), luaSource });
      auto = new ElectraAutoconfig(host);
      const res = await auto.run();
      if (!res.ok) {
        status = res.reason === 'no-midi-access' ? 'no-device' : 'error';
        detail = res.reason ?? 'failed';
        return;
      }
      // Inject the generated CC map into midi-learn so inbound CCs that the
      // orchestrator does NOT own still resolve, and our writable controls are
      // recognised as bound (the SAME moduleId:paramId keying MIDI uses).
      const learnable = auto.allocations
        .filter((a) => a.role === 'rw')
        .map((a) => ({
          key: a.key,
          channel: 0,
          cc: a.number,
          learnedAt: Date.now(),
        }));
      importBindings(learnable);
      status = res.isElectra ? 'ready' : 'ready'; // uploaded either way
      detail = res.isElectra ? 'Electra configured' : 'configured (device unconfirmed)';
    } catch (e) {
      status = 'error';
      detail = e instanceof Error ? e.message : String(e);
    }
  }

  onDestroy(() => auto?.stop());
</script>

<button
  class="electra-btn nodrag"
  type="button"
  data-testid="electra-connect-button"
  onclick={onClick}
  onpointerdown={(e) => e.stopPropagation()}
  disabled={status === 'connecting'}
  title="Generate a 3-page Electra One preset (Control Surface / MixMaster / System) from this rack and push it to a connected Electra. Asks for MIDI access on first click."
>
  {#if status === 'connecting'}
    Configuring…
  {:else if status === 'ready'}
    Electra ✓
  {:else if status === 'no-device'}
    No MIDI
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
