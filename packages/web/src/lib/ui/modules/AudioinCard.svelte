<script lang="ts">
  // AudioinCard — the LEGACY card for the AUDIO IN audio-source module.
  //
  // ⚠ IT OWNS NOTHING ANY MORE, AND THAT IS THE WHOLE POINT OF THIS FILE NOW.
  // It reads a projection and invokes `$lib/ui/modules/audioIn/audio-in-actions`
  // — the same seam the promoted face's `tileBody` and `fullViewBody` call. Two
  // moves got it here:
  //
  //   * #1590 moved the STREAM to the node (`node-audio-input-registry`),
  //     because `onDestroy(() => stopStream())` called an IRREVERSIBLE
  //     `MediaStreamTrack.stop()` on every collapse, dock eviction, ESC, M/E and
  //     navigation;
  //   * the FACE moved the ROSTER, the saved keys and the unattended acquire to
  //     `$lib/audio/input-device.svelte` + the action seam, because after
  //     promotion this card is no longer mounted on the default shell at all —
  //     `audioIn` is in neither `DOM_SOURCE_LANE_TYPES` nor
  //     `CARD_PRODUCER_LANE_TYPES`, so not even `<HeadlessSourceHost>` keeps a
  //     copy alive.
  //
  // ⚠ WHY IT IS MOVED RATHER THAN LEFT ALONE. It is still the lane surface under
  // `?shell=legacy`, and both surfaces can be mounted at once (a docked AUDIO IN
  // expanded under that flag). A card that kept its own `onMount` auto-acquire
  // would race the face's: `request()` calls `#releaseTracks` FIRST, so the two
  // would tear each other's capture down — the #1590 failure through a new door.
  // `beginAutoAcquire` is the atomic claim that makes the second caller a no-op,
  // and it only works if every caller goes through it.
  //
  // State scopes (unchanged):
  //   - the capture state machine: the NODE's, via the registry — per-tab, never
  //     in Yjs, because a permission grant is browser-instance-local.
  //   - `node.params.gain`: in Yjs, shared like every other module param.
  //   - `node.data.deviceId` / `node.data.musicMode`: in Yjs, written through
  //     `input-device.svelte` on a NON-TRACKED origin (undo must not re-open a
  //     different physical input).

  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { setNodeParam } from '$lib/graph/mutate';
  import { audioInDef } from '$lib/audio/modules/audioin';
  import {
    inputDeviceOptions,
    inputDeviceRoster,
    inputDeviceValue,
    inputMusicMode,
  } from '$lib/audio/input-device.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';
  import { nodeAudioInput, type AudioInputState } from './node-audio-input-registry.svelte';
  import {
    acquireAudioInput,
    bindAudioInputSurface,
    pickAudioInputDevice,
    releaseAudioInput,
    setAudioInputMusicMode,
  } from './audioIn/audio-in-actions';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  // ⚠ EVERYTHING HERE IS DERIVED — no card-local copy of anything (#1590). A
  // re-mounted card used to come up `idle` while the input was still live, and
  // the unmount that preceded it had already stopped the tracks.
  let view = $derived(nodeAudioInput.view(id));
  let inState = $derived(view.state as AudioInputState);
  let errorMsg = $derived(view.errorMsg);
  let liveChannels = $derived(view.liveChannels);
  let options = $derived(inputDeviceOptions(inputDeviceRoster()));
  let selectedDeviceId = $derived(inputDeviceValue(node));
  let musicMode = $derived(inputMusicMode(node));

  function pGain(): number {
    return node?.params['gain'] ?? audioInDef.params[0]!.defaultValue;
  }
  function setGain(v: number): void {
    setNodeParam(id, 'gain', v);
  }
  function readLiveGain(): number | undefined {
    const e = engineCtx.get();
    if (!e || !node) return undefined;
    return e.readParam(node, 'gain');
  }

  // ----- lifecycle -----
  //
  // ONE effect, and it is the same one both face surfaces run: adopt the node's
  // registry entry (non-destructive — a re-mount picks up a live entry), start
  // the app-wide device watch, and take the ONE unattended acquire this node
  // gets IF this origin already holds a grant.
  //
  // ⚠ IN AN `$effect`, NOT AT INIT: `id` is a prop, and reading it at init would
  // capture only its first value (svelte-check's `state_referenced_locally`).
  // Re-running is free — every step is idempotent.
  $effect(() => {
    void bindAudioInputSurface(id, engineCtx);
  });

  // ⚠ NO `onDestroy` AT ALL, AND ITS ABSENCE IS THE #1590 FIX. This unmount runs
  // on COLLAPSE, on dock LRU eviction, on ESC, on M/E and on navigation — none
  // of which mean the player is done with the rack's live input. It used to call
  // `stopStream()`, whose `t.stop()` is IRREVERSIBLE. The stream is keyed to the
  // NODE now and released by Canvas's `nodeAudioInput.sweep(liveIds)` when the
  // node itself is gone; the `devicechange` listener is the app-wide one in
  // `input-device.svelte`, which is never torn down either.

  // Status text for the LED row.
  //
  // ⚠ THE LEGACY CARD KEEPS ITS READOUTS. The resting-text rulings govern
  // FACES, and this template is what `?shell=legacy` renders until the legacy
  // fleet is deleted. The FACE deletes both of these — the state word and the
  // stereo/mono badge — onto `StatusLed` detail; see `audio-in-status.ts`.
  const STATE_LABEL: Record<AudioInputState, string> = {
    idle: 'idle',
    requesting: 'requesting…',
    streaming: 'active',
    'permission-denied': 'permission denied',
    'no-inputs-found': 'no inputs',
    'device-in-use': 'device in use',
    unsupported: 'unsupported',
    error: 'error',
  };

  const outputs = portsFromDef(audioInDef.outputs);
  // No inputs — keep typed.
  const inputs = portsFromDef(audioInDef.inputs);
</script>

<div class="vcard card">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="AUDIO IN" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <label class="row">
        <span class="row-label">input</span>
        <select
          class="device-select"
          data-testid="audioin-device-select"
          value={selectedDeviceId ?? ''}
          onchange={(e) => pickAudioInputDevice(id, (e.currentTarget as HTMLSelectElement).value)}
          disabled={options.length === 0}
        >
          {#if options.length === 0}
            <option value="">(no inputs)</option>
          {:else}
            {#if !selectedDeviceId}
              <option value="" disabled selected>(pick one)</option>
            {/if}
            {#each options as o (o.value)}
              <option value={o.value} selected={o.value === selectedDeviceId}>{o.label}</option>
            {/each}
          {/if}
        </select>
      </label>

      <div
        class="row status-row"
        data-testid="audioin-status"
        data-state={inState}
      >
        <span
          class="led"
          class:streaming={inState === 'streaming'}
          class:warn={inState === 'requesting'}
          class:err={inState === 'permission-denied' || inState === 'no-inputs-found' || inState === 'device-in-use' || inState === 'error' || inState === 'unsupported'}
          aria-hidden="true"
        ></span>
        <span class="status-label">{STATE_LABEL[inState]}</span>
        {#if inState === 'streaming' && liveChannels > 0}
          <span class="ch-badge" data-testid="audioin-channels">
            {liveChannels >= 2 ? 'stereo' : 'mono'}
          </span>
        {/if}
      </div>

      <label class="row music-row" title="Force browser echo-cancel / noise-suppress / auto-gain OFF for a clean line-level feed">
        <input
          type="checkbox"
          data-testid="audioin-music-mode"
          checked={musicMode}
          onchange={(e) => setAudioInputMusicMode(id, (e.currentTarget as HTMLInputElement).checked)}
        />
        <span class="row-label music-label">music mode</span>
      </label>

      {#if errorMsg}
        <div class="error" role="alert" data-testid="audioin-error">{errorMsg}</div>
      {/if}

      <div class="controls">
        {#if inState === 'idle' || inState === 'permission-denied' || inState === 'device-in-use' || inState === 'error'}
          <button
            class="primary"
            data-testid="audioin-enable"
            onclick={() => acquireAudioInput(id)}
            disabled={options.length === 0}
          >
            {inState === 'permission-denied' ? 'Retry permission' : inState === 'device-in-use' || inState === 'error' ? 'Retry' : 'Click to enable'}
          </button>
        {:else if inState === 'streaming'}
          <button
            class="ghost"
            data-testid="audioin-disable"
            onclick={() => releaseAudioInput(id)}
          >
            Stop
          </button>
        {/if}
      </div>

      <div class="fader-row">
        <NeonFader
          value={pGain()}
          min={0}
          max={2}
          defaultValue={audioInDef.params[0]!.defaultValue}
          label="Gain"
          curve="linear"
          onchange={setGain}
          moduleId={id}
          paramId="gain"
          readLive={readLiveGain}
        />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 200px;
    min-height: 240px;
    background-color: #000;
    background-image: linear-gradient(var(--module-bg), var(--module-bg));
    isolation: isolate;
  }
  .stripe {
    background: var(--text-dim);
  }

  .body {
    margin-top: 6px;
    padding: 0 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.7rem;
    color: var(--text-dim);
  }
  .row-label {
    min-width: 40px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .device-select {
    flex: 1 1 auto;
    background: #0c0e13;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 1px;
    padding: 2px 4px;
    font-size: 0.7rem;
    font-family: ui-monospace, monospace;
    min-width: 0;
  }
  .device-select:disabled { opacity: 0.5; }

  .status-row { align-items: center; gap: 6px; }
  .led {
    width: 8px; height: 8px; border-radius: 50%;
    background: #555;
  }
  .led.streaming { background: #16a34a; box-shadow: 0 0 4px #16a34a; }
  .led.warn { background: #ca8a04; }
  .led.err { background: #dc2626; }
  .status-label { font-family: ui-monospace, monospace; font-size: 0.65rem; }
  .ch-badge {
    margin-left: auto;
    font-family: ui-monospace, monospace;
    font-size: 0.6rem;
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 2px;
    padding: 0 4px;
  }

  .music-row { gap: 6px; cursor: pointer; }
  .music-row input { margin: 0; accent-color: var(--cable-audio, #22c55e); }
  .music-label { min-width: 0; }

  .error {
    font-size: 0.65rem;
    color: #fca5a5;
    background: rgba(220, 38, 38, 0.08);
    border: 1px solid rgba(220, 38, 38, 0.3);
    padding: 4px 6px;
    border-radius: 2px;
    line-height: 1.3;
  }

  .controls {
    display: flex;
    gap: 6px;
    justify-content: center;
  }
  button {
    font-family: inherit;
    font-size: 0.7rem;
    padding: 3px 8px;
    border-radius: 2px;
    cursor: pointer;
    background: #14171f;
    color: var(--text);
    border: 1px solid var(--border);
  }
  button:hover:not(:disabled) { border-color: var(--accent-dim); }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button.primary {
    background: rgba(34, 197, 94, 0.12);
    border-color: var(--cable-audio, #22c55e);
    color: var(--text);
  }
  button.primary:hover:not(:disabled) {
    background: rgba(34, 197, 94, 0.2);
  }

  .fader-row {
    margin-top: 4px;
    display: flex;
    justify-content: center;
  }
</style>
