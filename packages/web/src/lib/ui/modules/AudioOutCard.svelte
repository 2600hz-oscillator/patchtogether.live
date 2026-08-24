<script lang="ts">
  // ⚠ THE DEVICE PICKER'S MACHINERY IS NOT HERE ANY MORE, AND THAT IS THE FIX.
  //
  // This card used to own all three jobs — enumerate, write, and call
  // `setSinkId` — and it applied the pick from TWO places: the click, plus a
  // 100 ms x 50 `setInterval` that re-applied the saved id once the engine
  // appeared. Three defects came out of that arrangement, and all three are
  // gone rather than patched:
  //
  //   * THE TIMER LEAKED. `onMount` started it; `onDestroy` removed only the
  //     `devicechange` listener. An unmounted card kept ticking for up to its
  //     full 5 s window and wrote `$state` after destroy — and under dock
  //     collapse / LRU eviction this card unmounts routinely.
  //   * A STALE ERROR COULD OUTLIVE ITS CAUSE. The branch that discovered
  //     `setSinkId` was missing returned WITHOUT clearing `setSinkIdError`, so
  //     a rejection could sit under a notice saying the feature is unavailable.
  //   * A DEAD, SILENT CONTROL. The `<select>` disabled on
  //     `devices.length === 0 || !setSinkIdSupported` and the notice rendered
  //     only for the second cause — so a SUPPORTING browser that enumerated
  //     nothing showed a greyed `(no outputs)` and no reason at all.
  //
  // Ownership moved to `$lib/audio/output-device.svelte` (one roster, one
  // origin-tagged write) and the audio-out HANDLE (the one caller of
  // `setSinkId`, applying at engine boot and on write). The retry loop is
  // DELETED, not moved: the factory runs on engine boot by construction, which
  // is the event the loop was polling for.
  //
  // ⚠ AND THE CARD IS FIXED RATHER THAN ABANDONED. It still renders under
  // `?shell=legacy` and in the per-card VRT sweep, so a face does not pay a
  // card's debt — these edits are the payment.
  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { audioOutDef } from '$lib/audio/modules/audio-out';
  import { useEngine } from '$lib/audio/engine-context';
  import {
    ensureOutputDeviceWatch,
    ensureSinkReportWatch,
    outputDeviceOptions,
    outputDeviceRoster,
    outputDeviceValue,
    outputPickerBlock,
    outputSinkError,
    setOutputDevice,
  } from '$lib/audio/output-device.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let master = $derived(node?.params.master ?? audioOutDef.params[0]!.defaultValue);

  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }
  function readLive(paramId: string) {
    return () => {
      const e = engineCtx.get();
      if (!e || !node) return undefined;
      return e.readParam(node, paramId);
    };
  }

  // The app-wide roster: idempotent, so this card and the faceplate can both be
  // mounted (they are — the 🎧 panel and the dock) and there is still exactly
  // one `enumerateDevices()` per `devicechange`.
  $effect(() => {
    ensureOutputDeviceWatch();
    ensureSinkReportWatch();
  });

  let devices = $derived(outputDeviceRoster());
  let options = $derived(outputDeviceOptions(devices));
  let selectedOutputId = $derived(outputDeviceValue(node, devices));
  /** `'unsupported'` | `'no-devices'` | null — the two causes this card could
   *  not distinguish, now named separately in the markup below. */
  let block = $derived(outputPickerBlock(devices));
  let setSinkIdError = $derived(outputSinkError(node));

  const inputs = portsFromDef(audioOutDef.inputs);
</script>

<div class="vcard card">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="Audio Out" />

  <PatchPanel nodeId={id} {inputs}>
    <div class="device-area">
      <label class="device-row">
        <span class="device-label">out</span>
        <select
          class="device-select"
          data-testid="audioout-device-select"
          data-block={block ?? 'none'}
          value={selectedOutputId}
          onchange={(e) => setOutputDevice(id, (e.currentTarget as HTMLSelectElement).value)}
          disabled={block !== null}
        >
          {#if options.length === 0}
            <option value="">(no outputs)</option>
          {:else}
            {#each options as o (o.value)}
              <option value={o.value}>{o.label}</option>
            {/each}
          {/if}
        </select>
      </label>
      <!-- ⚠ TWO CAUSES, TWO NOTICES. The control disables on either, and until
           now only the first said why — so a supporting browser that enumerated
           nothing showed a greyed `(no outputs)` and no reason. -->
      {#if block === 'unsupported'}
        <div class="device-notice" data-testid="audioout-setsinkid-notice">
          Device selection requires Chromium-based browsers.
        </div>
      {:else if block === 'no-devices'}
        <div class="device-notice" data-testid="audioout-no-devices-notice">
          No output devices found.
        </div>
      {/if}
      <!-- The error is INDEPENDENT of the disabled notices, not an else-branch
           of them: a rejection happens on a browser that supports the feature
           and enumerated devices, i.e. exactly when neither notice shows. -->
      {#if setSinkIdError}
        <div class="device-notice err" role="alert" data-testid="audioout-sink-error">
          {setSinkIdError}
        </div>
      {/if}
    </div>

    <div class="fader-row">
      <NeonFader
        value={master}
        min={0}
        max={1}
        defaultValue={0.7}
        label="Master"
        curve="linear"
        onchange={setParam('master')} moduleId={id} paramId="master"
        readLive={readLive('master')}
      />
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 180px;
    min-height: 180px;
    background-color: #000;
    background-image: linear-gradient(var(--module-bg), var(--module-bg));
    /* Rack-compaction (#759): tightened 18/14 → 10/9 to fit the 1u tier. */
    padding-top: 10px;
    padding-bottom: 9px;
    isolation: isolate;
  }
  .stripe {
    background: var(--text-dim);
  }
  .device-area {
    /* Rack-compaction (#759): tightened vertical margins to fit 1u. */
    margin: 2px 8px 4px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .device-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.65rem;
    color: var(--text-dim);
  }
  .device-label {
    text-transform: uppercase;
    letter-spacing: 0.05em;
    min-width: 28px;
  }
  .device-select {
    flex: 1 1 auto;
    min-width: 0;
    background: #0c0e13;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 1px;
    padding: 1px 3px;
    font-size: 0.65rem;
    font-family: ui-monospace, monospace;
  }
  .device-select:disabled { opacity: 0.5; cursor: not-allowed; }
  .device-notice {
    font-size: 0.6rem;
    color: var(--text-dim);
    opacity: 0.7;
    line-height: 1.2;
  }
  .device-notice.err {
    color: #fca5a5;
    opacity: 1;
  }
  .fader-row {
    margin-top: 2px;
    display: flex;
    justify-content: center;
  }
</style>
