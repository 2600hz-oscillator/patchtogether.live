<script lang="ts">
  // PUSH 2 CONTROL card — binds an Ableton Push 2 to a focused clip-player. The
  // Push drives the FULL Launchpad clip-launch / note-editor / arm / scene / KEYS
  // parity surface (by injecting itself as the Launchpad control surface), plus
  // three additive features: the 8 above-display buttons SELECT channel 1-8 (the
  // card shows "CH n · instrument"), the 11 encoders drive MixMasters, and the
  // D-Pad scrolls the CLIP-view window. START/STOP moves to the Push Play button.
  //
  // Modeled on LaunchpadControlCard / ElectraConnectButton: no eager MIDI prompt.
  // "Connect Push 2" runs the gesture-gated sysex request; once connected + a
  // clip-player exists the card binds it. All hardware state is per-machine local;
  // LED frames never touch the Y.Doc. The 960×160 WebUSB display is Phase 2 — for
  // now the selected channel name lives here in the card.

  import type { NodeProps } from '@xyflow/svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import { patch } from '$lib/graph/store';
  import {
    midiAvailable,
    isConnected,
    connectPush,
    bindPushToClip,
    unbindPush,
    boundClipNode,
    channelName,
    selectedChannelIndex,
    selectChannel,
    firstMixmstrs,
    statusRune,
    setLaunchpadView,
  } from '$lib/control/push2/push2-control.svelte';
  import { launchpadActiveView } from '$lib/control/launchpad/launchpad-control.svelte';
  import type { SingleView } from '$lib/control/launchpad/launchpad-map';

  let { id, data }: NodeProps = $props();

  const supported = midiAvailable();
  let status = $state<'idle' | 'connecting' | 'connected' | 'no-midi' | 'no-device'>('idle');

  // Reactive: re-derive on device-status / channel-select / binding changes.
  let connected = $derived((statusRune(), isConnected()));
  let bound = $derived((statusRune(), boundClipNode()));
  let selCh = $derived((statusRune(), selectedChannelIndex()));
  let activeView = $derived((statusRune(), launchpadActiveView()));
  let hasMixer = $derived((statusRune(), firstMixmstrs() !== null));

  /** The first clip-player node in the patch (the Push drives one). */
  function firstClipplayer(): string | null {
    for (const [nid, n] of Object.entries(patch.nodes)) {
      if ((n as { type?: string } | undefined)?.type === 'clipplayer') return nid;
    }
    return null;
  }
  let hasClip = $derived((statusRune(), firstClipplayer() !== null));
  // The channel name shown in the top bar ("CH n · instrument"); Phase-1 stand-in
  // for the on-device 960×160 display (WebUSB is Phase 2).
  let chName = $derived((statusRune(), channelName(bound ?? firstClipplayer(), selCh)));

  async function connect() {
    if (!supported) { status = 'no-midi'; return; }
    status = 'connecting';
    const ok = await connectPush();
    if (!ok) { status = supported ? 'no-device' : 'no-midi'; return; }
    status = 'connected';
    autoBind();
  }

  function autoBind() {
    const cp = firstClipplayer();
    if (cp && boundClipNode() !== cp) bindPushToClip(cp);
  }
  function toggleBind() {
    if (boundClipNode()) { unbindPush(); return; }
    autoBind();
  }

  // The 4 single-mode views (KEYS is a sub-mode of Clip, entered on the device).
  const VIEWS: { id: SingleView; label: string }[] = [
    { id: 'grid', label: 'GRID' },
    { id: 'clip', label: 'CLIP' },
    { id: 'arranger', label: 'ARR' },
    { id: 'control', label: 'CTRL' },
  ];
  const CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7];
</script>

<div class="mod-card push2-control-card" data-testid="push2-control-card" data-node-id={id}>
  <div class="p2-titlebar">
    <ModuleTitle {id} {data} defaultLabel="PUSH 2 CONTROL" inline={true} />
  </div>

  <div class="p2-body">
    {#if !supported}
      <div class="p2-warn" data-testid="push2-control-nomidi">
        Web MIDI isn’t available in this browser — connect a Push 2 in Chrome/Edge.
      </div>
    {:else}
      <div class="p2-actions">
        <button
          class="p2-btn nodrag"
          type="button"
          data-testid="push2-control-connect"
          onclick={connect}
        >
          {connected ? 'Re-connect Push 2' : 'Connect Push 2'}
        </button>
        {#if connected && (bound || hasClip)}
          <button
            class="p2-btn nodrag"
            type="button"
            data-testid="push2-control-bind"
            onclick={toggleBind}
          >
            {bound ? 'Unbind clip-player' : 'Bind to clip-player'}
          </button>
        {/if}
      </div>

      {#if connected}
        <!-- Selected-channel name bar (Phase-1 stand-in for the on-device display). -->
        <div class="p2-channel" data-testid="push2-control-channel">{chName}</div>

        <!-- Channel select (mirrors the 8 above-display buttons). -->
        <div class="p2-actions p2-ch-seg" role="group" aria-label="Push channel select">
          {#each CHANNELS as c (c)}
            <button
              class="p2-btn p2-ch-btn nodrag"
              class:active={selCh === c}
              type="button"
              data-testid={`push2-control-ch-${c + 1}`}
              aria-pressed={selCh === c}
              onclick={() => selectChannel(c)}
            >
              {c + 1}
            </button>
          {/each}
        </div>

        <!-- Single-mode view switch (same 4 views as the Launchpad). -->
        <div class="p2-actions p2-view-seg" role="group" aria-label="Push view" data-testid="push2-control-view-seg">
          {#each VIEWS as v (v.id)}
            <button
              class="p2-btn p2-view-btn nodrag"
              class:active={activeView === v.id}
              type="button"
              data-testid={`push2-control-view-${v.id}`}
              aria-pressed={activeView === v.id}
              onclick={() => setLaunchpadView(v.id)}
            >
              {v.label}
            </button>
          {/each}
        </div>
      {/if}

      {#if status === 'no-device'}
        <div class="p2-warn" data-testid="push2-control-nodevice">
          No Push 2 detected — plug one in, then <b>Connect Push 2</b>.
        </div>
      {:else}
        <div class="p2-status" data-testid="push2-control-status">
          {#if status === 'no-midi'}
            Couldn’t access MIDI — allow the permission prompt and try again.
          {:else if !connected}
            Not connected.
          {:else if bound}
            Driving clip-player <code>{bound}</code> — <b>{activeView.toUpperCase()}</b> view.
          {:else if hasClip}
            Push 2 ✓ — hit Bind to drive your clip-player.
          {:else}
            Push 2 ✓ — add a clip-player module to drive (auto-binds it).
          {/if}
        </div>
        {#if connected && !hasMixer}
          <div class="p2-hint" data-testid="push2-control-nomixer">
            Encoders idle — add a <b>mixmstrs</b> mixer for volume/send control.
          </div>
        {/if}
      {/if}
    {/if}

    <p class="p2-hint" data-testid="push2-control-docs-hint">
      Colour guide + control map → right-click → <b>View docs</b>.
    </p>
  </div>
</div>

<style>
  .push2-control-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 7px 8px;
    min-width: 320px;
    max-width: 340px;
    color: var(--text, #cfd3df);
    font-size: 12px;
  }
  .p2-titlebar { display: flex; align-items: center; justify-content: space-between; }
  .p2-body { display: flex; flex-direction: column; gap: 5px; }
  .p2-warn {
    background: #2a1b1b; border: 1px solid #5a2a2a; border-radius: 4px;
    padding: 6px 8px; color: #e8b0b0; font-size: 11px;
  }
  .p2-warn b { color: #f4cccc; }
  .p2-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .p2-btn {
    appearance: none; border: 1px solid var(--accent, #5a7); background: transparent;
    color: var(--accent, #5a7); border-radius: 4px; padding: 4px 10px; font-size: 12px; cursor: pointer;
  }
  .p2-btn:hover { filter: brightness(1.2); }
  .p2-channel {
    font: 600 12px/1.3 ui-monospace, 'SF Mono', Menlo, monospace;
    color: #cfe0ff; background: rgba(80, 110, 200, 0.14);
    border: 1px solid rgba(120, 150, 230, 0.4); border-radius: 4px; padding: 5px 8px;
    letter-spacing: 0.02em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .p2-ch-seg { gap: 3px; }
  .p2-ch-btn { flex: 1 1 0; min-width: 0; text-align: center; padding: 3px 0; opacity: 0.6; }
  .p2-ch-btn.active { border-color: #6f9bd6; color: #9cc0f0; background: rgba(80, 120, 200, 0.18); opacity: 1; }
  .p2-view-seg { gap: 4px; }
  .p2-view-btn { flex: 1 1 0; text-align: center; padding: 4px 6px; letter-spacing: 0.04em; opacity: 0.72; }
  .p2-view-btn.active { border-color: #8a6fd6; color: #b79cf0; background: rgba(120, 80, 200, 0.14); opacity: 1; }
  .p2-status { font-size: 11px; color: #9aa0b2; }
  .p2-status code { color: #cfd3df; }
  .p2-hint { margin: 0; font-size: 10px; color: #6f7488; }
  .p2-hint b { color: #9aa0b2; }
</style>
