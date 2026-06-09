<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { audioOutDef } from '$lib/audio/modules/audio-out';
  import { useEngine } from '$lib/audio/engine-context';
  import {
    findDefaultOutputDevice,
    formatDeviceLabel,
    type MinimalDevice,
  } from '$lib/audio/devices';
  import type { ModuleNode } from '$lib/graph/types';
  import type { AudioEngine } from '$lib/audio/engine';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let master = $derived(node?.params.master ?? audioOutDef.params[0]!.defaultValue);

  // ----- output device picker state -----
  //
  // Per-tab state; selected device id mirrors into node.data.outputDeviceId
  // in Yjs so reloads remember the choice (and collaborators see the
  // owner's pick — at the cost of a remote user being able to nudge your
  // sink choice, but same as every other Yjs-shared field).
  let devices = $state<MinimalDevice[]>([]);
  let selectedOutputId = $state<string | null>(null);
  let setSinkIdSupported = $state<boolean>(false);
  let setSinkIdError = $state<string | null>(null);

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

  function readSavedOutputDeviceId(): string | null {
    const d = node?.data;
    if (d && typeof d['outputDeviceId'] === 'string') {
      return d['outputDeviceId'] as string;
    }
    return null;
  }
  function setSavedOutputDeviceId(deviceId: string | null): void {
    const target = patch.nodes[id];
    if (!target) return;
    if (!target.data) target.data = {};
    if (deviceId === null) delete target.data['outputDeviceId'];
    else target.data['outputDeviceId'] = deviceId;
  }

  /**
   * Refresh the list of `audiooutput` devices via enumerateDevices().
   * Labels may be empty pre-permission (browsers gate them behind ANY
   * granted mic permission); we render them as numeric fallbacks via
   * `formatDeviceLabel`.
   */
  async function refreshDevices(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      devices = [];
      return;
    }
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      devices = all.filter((d) => d.kind === 'audiooutput');
    } catch (err) {
      console.warn('[audioOut] enumerateDevices failed:', err);
      devices = [];
    }
  }

  /**
   * Apply the user's pick via `audioCtx.setSinkId(deviceId)`. Chromium
   * 110+ + recent Safari support this; Firefox does not. When
   * unsupported, we silently fall back to the default device + show
   * an inline notice via the `setSinkIdSupported` flag.
   *
   * `setSinkId` is async + can reject (e.g. device disappeared between
   * enumerate and apply); we surface the error inline so the user
   * knows their pick didn't take.
   */
  async function applySinkId(deviceId: string): Promise<void> {
    const e = engineCtx.get();
    if (!e) return;
    let audioEngine: AudioEngine;
    try {
      audioEngine = e.getDomain<AudioEngine>('audio');
    } catch {
      return;
    }
    const ctx = audioEngine.ctx as AudioContext & {
      setSinkId?: (deviceId: string) => Promise<void>;
    };
    if (typeof ctx.setSinkId !== 'function') {
      setSinkIdSupported = false;
      return;
    }
    try {
      await ctx.setSinkId(deviceId);
      setSinkIdError = null;
    } catch (err) {
      setSinkIdError = (err as Error).message || 'setSinkId failed';
    }
  }

  function onPickOutputDevice(deviceId: string): void {
    selectedOutputId = deviceId;
    setSavedOutputDeviceId(deviceId);
    applySinkId(deviceId);
  }

  function onDeviceChange(): void {
    refreshDevices();
  }

  // ----- lifecycle -----

  onMount(() => {
    untrack(() => {
      selectedOutputId = readSavedOutputDeviceId();
    });

    // Feature-detect setSinkId on the live AudioContext. Done in a
    // small retry loop because the engine boot is async; the card may
    // mount before the engine exists.
    let attempts = 0;
    const detect = setInterval(() => {
      attempts++;
      const e = engineCtx.get();
      if (e) {
        try {
          const ae = e.getDomain<AudioEngine>('audio');
          const ctx = ae.ctx as AudioContext & { setSinkId?: unknown };
          setSinkIdSupported = typeof ctx.setSinkId === 'function';
          clearInterval(detect);
          // Re-apply any saved sink id on engine boot — restores the user's
          // pick across reload.
          if (setSinkIdSupported && selectedOutputId) {
            applySinkId(selectedOutputId);
          }
        } catch {
          // engine ready but no audio domain (shouldn't happen)
        }
      }
      if (attempts > 50) clearInterval(detect); // ~5s
    }, 100);

    refreshDevices();
    if (navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
    }
  });

  onDestroy(() => {
    if (navigator.mediaDevices?.removeEventListener) {
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
    }
  });

  const inputs: PortDescriptor[] = [
    { id: 'L', cable: 'audio' },
    { id: 'R', cable: 'audio' },
  ];
</script>

<div class="card">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="Audio Out" />

  <PatchPanel nodeId={id} {inputs}>
    <div class="device-area">
      <label class="device-row">
        <span class="device-label">out</span>
        <select
          class="device-select"
          data-testid="audioout-device-select"
          value={selectedOutputId ?? ''}
          onchange={(e) => onPickOutputDevice((e.currentTarget as HTMLSelectElement).value)}
          disabled={devices.length === 0 || !setSinkIdSupported}
        >
          {#if devices.length === 0}
            <option value="">(no outputs)</option>
          {:else}
            {#if !selectedOutputId}
              {@const def = findDefaultOutputDevice(devices)}
              <option value={def ?? ''} selected>
                {def === 'default' ? 'Default' : '(default)'}
              </option>
            {/if}
            {#each devices as d, i (d.deviceId)}
              <option value={d.deviceId} selected={d.deviceId === selectedOutputId}>
                {d.deviceId === 'default' ? 'Default' : formatDeviceLabel(d, i)}
              </option>
            {/each}
          {/if}
        </select>
      </label>
      {#if !setSinkIdSupported}
        <div class="device-notice" data-testid="audioout-setsinkid-notice">
          Device selection requires Chromium-based browsers.
        </div>
      {:else if setSinkIdError}
        <div class="device-notice err" role="alert">
          {setSinkIdError}
        </div>
      {/if}
    </div>

    <div class="fader-row">
      <Fader
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
    min-height: 200px;
    background-color: #000;
    background-image: linear-gradient(var(--module-bg), var(--module-bg));
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
    isolation: isolate;
  }
  :global(.svelte-flow__node:hover) .card {
    border-color: var(--accent-dim);
  }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--text-dim);
  }
  .device-area {
    margin: 4px 8px 8px;
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
    margin-top: 6px;
    display: flex;
    justify-content: center;
  }
</style>
