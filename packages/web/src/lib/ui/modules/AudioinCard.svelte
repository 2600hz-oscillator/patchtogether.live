<script lang="ts">
  // AudioinCard — UI for the AUDIO IN audio-source module.
  //
  // Owns the `getUserMedia` permission flow + the device dropdown +
  // the live MediaStream lifecycle. Hands the stream off to the
  // engine-side audio graph via the `audioInAttach` helper.
  //
  // State scopes:
  //   - `state` (idle | requesting | streaming | permission-denied | …):
  //     per-tab, lives in local Svelte $state. NOT in Yjs — permission
  //     grants are browser-instance-local.
  //   - `node.params.gain`: in Yjs. Shared across collaborators (a
  //     remote user adjusting your gain knob feels weird but matches
  //     how every other audio module works; AUDIO IN is no exception).
  //   - `node.data.deviceId`: in Yjs. Each user's browser tries to
  //     match it to a local input; if missing, dropdown shows "(saved
  //     device not found)" and the user picks again.

  import { onMount, onDestroy, untrack } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { audioInDef } from '$lib/audio/modules/audioin';
  import {
    buildAudioInConstraints,
    findDefaultInputDevice,
    formatDeviceLabel,
    type MinimalDevice,
  } from '$lib/audio/devices';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';
  import { nodeAudioInput } from './node-audio-input-registry.svelte';

  type State =
    | 'idle'                 // no stream + no permission attempt yet
    | 'requesting'           // getUserMedia in flight
    | 'streaming'            // stream attached
    | 'permission-denied'    // user blocked / browser-level block
    | 'no-inputs-found'      // enumerateDevices returned no audioinputs
    | 'device-in-use'        // NotReadableError — another tab has the mic
    | 'unsupported'          // browser lacks getUserMedia
    | 'error';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  // ----- local state -----
  let devices = $state<MinimalDevice[]>([]);
  let selectedDeviceId = $state<string | null>(null);
  // ⚠ inState / errorMsg / liveChannels are DERIVED from the node-keyed
  // registry, not card-local $state (#1590). They used to be card-local, so a
  // re-mounted card came up 'idle' while the input was still live — and worse,
  // the unmount that preceded it had already stopped the tracks. The registry
  // is the one home for both the resource and the status that describes it.
  let inState: State = $derived(nodeAudioInput.view(id).state as State);
  let errorMsg = $derived(nodeAudioInput.view(id).errorMsg);
  // "Music mode" — force the browser capture DSP (echo-cancel / noise-
  // suppress / auto-gain) OFF for a clean line-level feed. Persisted to
  // Yjs (node.data.musicMode) so it restores on reload + syncs to peers.
  // Default OFF (browser-default DSP) — forcing AGC off drops built-in-mic
  // level, so it's opt-in for users routing line-level gear.
  let musicMode = $state(false);
  // The channelCount the live track actually delivered (for the status
  // display: "stereo" vs "mono"). 0 until a stream attaches.
  let liveChannels = $derived(nodeAudioInput.view(id).liveChannels);
  // ⚠ THE CARD NO LONGER HOLDS THE STREAM. It belongs to the NODE — see
  // node-audio-input-registry.svelte.ts. The card adopts and reads.

  // ----- helpers -----

  function readSavedDeviceId(): string | null {
    const d = node?.data;
    if (d && typeof d['deviceId'] === 'string') return d['deviceId'] as string;
    return null;
  }
  function setSavedDeviceId(deviceId: string | null): void {
    const target = patch.nodes[id];
    if (!target) return;
    if (!target.data) target.data = {};
    if (deviceId === null) delete target.data['deviceId'];
    else target.data['deviceId'] = deviceId;
  }

  function readSavedMusicMode(): boolean {
    const d = node?.data;
    return !!(d && d['musicMode'] === true);
  }
  function setSavedMusicMode(on: boolean): void {
    const target = patch.nodes[id];
    if (!target) return;
    if (!target.data) target.data = {};
    if (on) target.data['musicMode'] = true;
    else delete target.data['musicMode'];
  }

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

  /**
   * Re-enumerate the audioinput devices. Returns whether labels are
   * visible (= permission has been granted at some point). Empty
   * labels indicate the browser's pre-permission privacy gate is
   * still in effect.
   */
  async function refreshDevices(): Promise<{ hasLabels: boolean }> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      devices = [];
      return { hasLabels: false };
    }
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const ins = all.filter((d) => d.kind === 'audioinput');
      devices = ins;
      return { hasLabels: ins.some((d) => d.label !== '') };
    } catch (err) {
      console.warn('[audioIn] enumerateDevices failed:', err);
      devices = [];
      return { hasLabels: false };
    }
  }

  /**
   * Acquire the selected (or default) input device. On success, attaches
   * the MediaStream to the engine module via `audioInAttach`.
   */
  async function requestStream(): Promise<void> {
    const targetId = selectedDeviceId ?? findDefaultInputDevice(devices);
    // ASK for a stereo pair — see buildAudioInConstraints. It's an IDEAL
    // constraint (channelCount: 2, no `exact:`), so a mono device still
    // streams (and the engine wiring keys off the DELIVERED channelCount,
    // not this request). A multichannel USB interface (e.g. Expert
    // Sleepers ES-9) hands us a true L/R pair (its FIRST stereo pair,
    // device inputs 1/2) instead of a browser-downmixed mono signal.
    // EMPIRICAL: the browser caps ES-9 capture at 2 channels
    // (getCapabilities max=2; channelCount:{exact:4} → OverconstrainedError),
    // so 4-in / per-channel is native-only (the native track; see the
    // es9-stereo-io plan).
    // `musicMode` forces the browser capture DSP off for a clean line feed.
    const constraints = buildAudioInConstraints(targetId, { musicMode });

    // ⚠ ACQUISITION IS THE REGISTRY'S (#1590). The constraints are the card's
    // business — device list, saved id, music mode; the STREAM, the engine
    // attach and the late-engine reconciler are the NODE's, because all three
    // used to die with this component. `t.stop()` is irreversible, so this is
    // the one row in #1583 where the unmount could not be recovered from.
    await nodeAudioInput.request(id, constraints, {
      onResolved: (realDeviceId) => {
        if (realDeviceId && realDeviceId !== selectedDeviceId) {
          selectedDeviceId = realDeviceId;
          setSavedDeviceId(realDeviceId);
        } else if (selectedDeviceId) {
          setSavedDeviceId(selectedDeviceId);
        }
      },
    });

    // Permission may have just been granted — re-enumerate for real labels.
    if (nodeAudioInput.isStreaming(id)) await refreshDevices();
  }

  /** USER-INITIATED release (the stop control + the re-acquire path). NEVER
   *  call this from a lifecycle hook — that is the #1590 defect. */
  function stopStream(): void {
    nodeAudioInput.stop(id);
  }

  function onPickDevice(deviceId: string): void {
    selectedDeviceId = deviceId;
    setSavedDeviceId(deviceId);
    // If we were already streaming, re-acquire on the new device.
    if (inState === 'streaming' || inState === 'device-in-use' || inState === 'error') {
      requestStream();
    }
  }

  function onToggleMusicMode(on: boolean): void {
    musicMode = on;
    setSavedMusicMode(on);
    // Capture DSP constraints can't be changed on a live track without a
    // re-acquire, so re-run getUserMedia if we're already streaming.
    if (inState === 'streaming') {
      requestStream();
    }
  }

  function onDeviceChange(): void {
    // Just refresh the list — the user's selectedDeviceId stays.
    // Browsers may have changed deviceId values for the SAME physical
    // device across plug events; if the saved id no longer matches,
    // the next requestStream() will report OverconstrainedError and
    // the user can repick.
    refreshDevices();
  }

  // ----- lifecycle -----

  // ADOPT the node's input entry before anything reads it. Non-destructive: if
  // a previous mount left this node streaming, this picks that entry up rather
  // than replacing it — which is what makes re-expanding show the LIVE input.
  // (In an $effect, not at init: `id` is a prop, and reading it at init would
  // capture only its first value — svelte-check's state_referenced_locally.
  // Re-running is free: adopt is idempotent and non-destructive.)
  $effect(() => {
    nodeAudioInput.adopt(id, engineCtx);
  });

  onMount(() => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      nodeAudioInput.setStatus(id, 'unsupported', 'Browser does not support getUserMedia');
      return;
    }

    untrack(() => {
      selectedDeviceId = readSavedDeviceId();
      musicMode = readSavedMusicMode();
    });

    // Initial enumerate. Empty labels at this point = no prior
    // permission grant; we wait for the user to click "Enable".
    refreshDevices().then((res) => {
      if (devices.length === 0) {
        nodeAudioInput.setStatus(id, 'no-inputs-found', 'No audio inputs detected.');
        return;
      }
      // If labels are already visible (permission previously granted
      // in this origin), auto-acquire — same convenience the CAMERA
      // card provides for repeat visits.
      if (res.hasLabels) {
        if (!selectedDeviceId) {
          selectedDeviceId = findDefaultInputDevice(devices);
        }
        requestStream();
      }
    });

    if (navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
    }
  });

  // ⚠ NO `stopStream()` HERE (#1590). This unmount runs on COLLAPSE, on dock
  // LRU eviction, on ESC, on M/E and on navigation — none of which mean the
  // user is done with the rack's live input. It used to call `stopStream()`,
  // whose `t.stop()` is IRREVERSIBLE: the input went silent mid-performance,
  // the OS mic indicator dropped, and re-expanding could not bring it back
  // (only a fresh getUserMedia can, which is a new permission decision).
  // The stream is keyed to the NODE now and released by Canvas's
  // `nodeAudioInput.sweep(liveIds)` when the node itself is gone.
  //
  // The devicechange listener IS card-owned — it only refreshes the dropdown.
  onDestroy(() => {
    if (navigator.mediaDevices?.removeEventListener) {
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
    }
  });

  // Status text for the LED row.
  const STATE_LABEL: Record<State, string> = {
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
          onchange={(e) => onPickDevice((e.currentTarget as HTMLSelectElement).value)}
          disabled={devices.length === 0}
        >
          {#if devices.length === 0}
            <option value="">(no inputs)</option>
          {:else}
            {#if !selectedDeviceId}
              <option value="" disabled selected>(pick one)</option>
            {/if}
            {#each devices as d, i (d.deviceId)}
              <option value={d.deviceId} selected={d.deviceId === selectedDeviceId}>
                {formatDeviceLabel(d, i)}
              </option>
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
          onchange={(e) => onToggleMusicMode((e.currentTarget as HTMLInputElement).checked)}
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
            onclick={requestStream}
            disabled={devices.length === 0}
          >
            {inState === 'permission-denied' ? 'Retry permission' : inState === 'device-in-use' || inState === 'error' ? 'Retry' : 'Click to enable'}
          </button>
        {:else if inState === 'streaming'}
          <button
            class="ghost"
            data-testid="audioin-disable"
            onclick={stopStream}
          >
            Stop
          </button>
        {/if}
      </div>

      <div class="fader-row">
        <Fader
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
