<script lang="ts">
  // PUSH 2 CONTROL card — binds an Ableton Push 2 to a focused clip-player. The
  // Push drives the FULL Launchpad clip-launch / note-editor / arm / scene / KEYS
  // parity surface (by injecting itself as the Launchpad control surface), plus
  // the PUSH CARD surface: the 8 above-display buttons SELECT lane 1-8, the
  // #2-from-the-left encoder flips through that lane's module cards, and the 8
  // display encoders turn the current card's 8 controls. START/STOP moves to the
  // Push Play button.
  //
  // THE PREVIEW IS THE POINT. This card renders the EXACT same PushCardView the
  // 960×160 panel paints, through the exact same draw ops, into a canvas scaled
  // to the card width. That makes the whole feature — schema, lane selection,
  // curve math, layout — visible and testable with NO HARDWARE ATTACHED, which
  // is the only reason any of it could be built without a Push on the desk.
  //
  // Modeled on LaunchpadControlCard / ElectraConnectButton: no eager MIDI prompt.
  // "Connect Push 2" runs the gesture-gated sysex request; "Connect display" is a
  // SEPARATE gesture (WebUSB is its own permission) and is never required — a
  // missing display leaves the pads and encoders working. All hardware state is
  // per-machine local; LED and display frames never touch the Y.Doc.

  import type { NodeProps } from '@xyflow/svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import { patch } from '$lib/graph/store';
  import { nodesStructuralVersion, docVersion } from '$lib/graph/node-versions.svelte';
  import {
    midiAvailable,
    isConnected,
    connectPush,
    bindPushToClip,
    unbindPush,
    boundClipNode,
    selectedChannelIndex,
    selectChannel,
    currentPushCardView,
    focusedModuleId,
    scrollPushCard,
    statusRune,
    setLaunchpadView,
  } from '$lib/control/push2/push2-control.svelte';
  import {
    usbAvailable,
    connectDisplay,
    isDisplayConnected,
    displayStatus,
    displayStatusRune,
  } from '$lib/control/push2/push2-display.svelte';
  import { renderPushCard, PUSH_SCREEN_W, PUSH_SCREEN_H } from '$lib/control/push2/push-screen-layout';
  import { paintPushOps } from '$lib/control/push2/push-card-paint';
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
  let usbOk = usbAvailable();
  let displayOn = $derived((displayStatusRune(), isDisplayConnected()));
  let displaySt = $derived((displayStatusRune(), displayStatus()));

  // The push card, re-derived on lane/focus change (statusRune), on any
  // structural graph change, and on any param write (docVersion) — the same
  // signals the panel's own repaint tick reacts to.
  let card = $derived((statusRune(), nodesStructuralVersion(), docVersion(), currentPushCardView()));
  let focusId = $derived((statusRune(), nodesStructuralVersion(), focusedModuleId()));

  // The 960×160 preview: the SAME draw ops the panel gets.
  let previewCanvas = $state<HTMLCanvasElement | null>(null);
  $effect(() => {
    const c = previewCanvas;
    const v = card; // tracked
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    paintPushOps(ctx, renderPushCard(v));
  });

  async function connectScreen() {
    await connectDisplay(); // false on decline/unsupported — never throws
  }

  /** The first clip-player node in the patch (the Push drives one). */
  function firstClipplayer(): string | null {
    for (const [nid, n] of Object.entries(patch.nodes)) {
      if ((n as { type?: string } | undefined)?.type === 'clipplayer') return nid;
    }
    return null;
  }
  let hasClip = $derived((statusRune(), firstClipplayer() !== null));

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
        {#if usbOk && !displayOn}
          <button
            class="p2-btn nodrag"
            type="button"
            data-testid="push2-display-connect"
            onclick={connectScreen}
          >
            Connect display
          </button>
        {/if}
      </div>

      <!-- THE PUSH CARD, exactly as the 960×160 panel draws it. Shown whether or
           not any hardware is attached, so the schema + selection are visible
           without a Push on the desk. -->
      <div class="p2-screen" data-testid="push2-card-preview" aria-label="Push 2 screen preview">
        <canvas
          bind:this={previewCanvas}
          width={PUSH_SCREEN_W}
          height={PUSH_SCREEN_H}
          data-testid="push2-card-canvas"
          data-card-module={card.moduleType}
          data-card-lane={card.lane}
          data-card-empty={card.empty ?? ''}
          data-card-focus={focusId ?? ''}
        ></canvas>
      </div>

      <!-- Flip through the lane's cards — the #2-from-the-left encoder on the
           hardware, two buttons here. -->
      <div class="p2-actions p2-flip" role="group" aria-label="Push card">
        <button class="p2-btn p2-flip-btn nodrag" type="button"
          data-testid="push2-card-prev" onclick={() => scrollPushCard(-1)}>‹</button>
        <span class="p2-flip-label" data-testid="push2-card-name">
          {card.empty ? card.empty.replace('-', ' ') : card.title}
          {#if card.index !== null && card.count}<span class="p2-flip-idx">{card.index}/{card.count}</span>{/if}
        </span>
        <button class="p2-btn p2-flip-btn nodrag" type="button"
          data-testid="push2-card-next" onclick={() => scrollPushCard(1)}>›</button>
      </div>

      <!-- Lane select (mirrors the 8 above-display buttons). -->
      <div class="p2-actions p2-ch-seg" role="group" aria-label="Push lane select">
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

      {#if connected}
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
        {#if connected && usbOk && !displayOn}
          <div class="p2-hint" data-testid="push2-display-hint">
            Screen not connected ({displaySt}) — hit <b>Connect display</b>. The pads
            and encoders work without it.
          </div>
        {:else if connected && !usbOk}
          <div class="p2-hint" data-testid="push2-display-nousb">
            No WebUSB here — the on-device screen needs Chrome/Edge. Everything else
            still works; the card above shows what the screen would.
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
    min-width: 340px;
    max-width: 360px;
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
  .p2-screen {
    border: 1px solid #333a48; border-radius: 4px; background: #000; overflow: hidden;
    line-height: 0;
  }
  .p2-screen canvas { display: block; width: 100%; height: auto; image-rendering: pixelated; }
  .p2-flip { align-items: center; flex-wrap: nowrap; gap: 4px; }
  .p2-flip-btn { padding: 1px 8px; line-height: 1.3; }
  .p2-flip-label {
    flex: 1 1 auto; min-width: 0; text-align: center; font-size: 11px; color: #9aa0b2;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .p2-flip-idx { color: #6f7488; margin-left: 4px; }
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
