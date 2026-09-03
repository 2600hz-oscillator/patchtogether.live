<script lang="ts">
  // LoopbackCard — UI for the LOOPBACK browser-viewport video source.
  //
  // ⚠ THIS CARD OWNS NO LIFECYCLE ANY MORE, and that is the whole point of the
  // 2026-09-03 extraction. getDisplayMedia, the capture state machine, the
  // engine `attachExternalSource` and the crop pump's start/stop all moved to
  // `$lib/ui/media/node-loopback-source-registry` — a NODE-keyed controller
  // Canvas syncs from the graph. What is left here is a VIEW: the rack tile, the
  // patch panel, a preview of the node-owned <video>, and buttons that ASK the
  // controller to act.
  //
  // WHY. `loopback` was in `DOM_SOURCE_LANE_TYPES`, which meant the default
  // shell kept this card mounted OFF-SCREEN inside <HeadlessSourceHost> purely
  // so the source would exist — the card was load-bearing for a question that
  // is not a view question. A capture surviving a collapse, a dock move or a
  // shell flip is CONTENT. Now it is owned like content, and this file can be
  // deleted without taking the capture with it.
  //
  // ⚠ WHAT THIS CARD AND THE FACEPLATE NOW SHARE, exactly: they read the SAME
  // status from `loopback-status-registry` and they send the SAME two commands
  // to the same controller. Neither is privileged. That symmetry is the
  // parity argument made structural rather than asserted — there is no
  // affordance here that the face cannot reach, because both surfaces are
  // clients of one owner.
  //
  // State scopes:
  //   - capture state (idle / requesting / capturing / …): per-tab, held by the
  //     controller. NOT in Yjs — a screen-capture grant is browser-instance-local.
  //   - `node.params.gain / crop`: in Yjs, synced across collaborators.

  import { onDestroy } from 'svelte';
  import { nodeMedia, type NodeMediaLease } from '$lib/ui/media/node-media-registry';
  import { type NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { loopbackDef } from '$lib/video/modules/loopback';
  import { type LoopbackCaptureState } from '$lib/ui/viewport-acquire';
  import {
    loopbackStatus,
    type LoopbackStatus,
  } from '$lib/ui/media/loopback-status-registry';
  import { LOOPBACK_SOURCE_SLOT } from '$lib/ui/media/node-loopback-source.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  // ⚠ IMPORTED, NEVER RE-DECLARED. This used to be a local
  // `type State = 'idle' | …` union. It is now the ONE declaration in
  // `$lib/ui/viewport-acquire`, because the faceplate publishes this value
  // across a surface boundary and a state this card knows about but the
  // published union does not is a string the face's lamp cannot render — with
  // every runtime assertion still green. CAMERA has that defect shape gated;
  // this module does not have the defect. See the type's own header.
  type State = LoopbackCaptureState;

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  // OUT-only patch panel (no inputs — a pure source). Port id is BYTE-IDENTICAL
  // to the def so persisted edges + the CV bridge route unchanged.
  const inputs = portsFromDef(loopbackDef.inputs);
  const outputs = portsFromDef(loopbackDef.outputs);

  // The <video> and the capture STREAM are owned by the NODE, not by this
  // card (see $lib/ui/media/node-media-registry). This card ADOPTS the element
  // to show it and releases it on unmount; the element and the stream outlive
  // both events.
  let videoHost: HTMLDivElement | null = $state(null);
  let mediaLease: NodeMediaLease<HTMLElement> | null = null;

  // ── Read the controller's status through the cross-surface seam ───────────
  //
  // ⚠ THE SAME SEAM THE FACEPLATE READS, deliberately. Reading the controller's
  // `$state` record directly would work and would be one line shorter, and it
  // would also mean the card and the face could disagree the first time
  // somebody changed one of them. One truth, two clients.
  let live = $state<LoopbackStatus | null>(null);

  $effect(() => {
    const nodeId = id;
    const sync = (): void => {
      live = loopbackStatus.read(nodeId);
    };
    sync();
    return loopbackStatus.subscribe(nodeId, sync);
  });

  // ⚠ THE `null` FALLBACK IS 'idle', NOT A THIRD STATE, and that is a deliberate
  // difference from the faceplate. The face renders "nobody has published" as
  // its own dim lamp because it can be open on a node whose surface never
  // mounted. This card IS a surface for the node it renders, and the controller
  // publishes on creation, so `null` here is only the instant before Canvas's
  // first sync — showing 'idle' through it keeps the card's resting appearance
  // byte-identical to what its VRT baselines pinned.
  let capState = $derived<State>(live?.state ?? 'idle');
  let errorMsg = $derived<string | null>(live?.errorMsg ?? null);

  function p(name: string): number {
    const def = loopbackDef.params.find((x) => x.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number): void => setNodeParam(id, paramId, v);
  }

  /**
   * ⚠ A REAL CLICK HANDLER, AND IT MUST STAY ONE. `getDisplayMedia` is refused
   * outside a user activation and — unlike `getUserMedia` — there is NO
   * previously-granted state that would let a programmatic call through. The
   * activation reaches the controller because `request` calls into it
   * synchronously; an `await` anywhere on this path would silently stop the
   * picker from ever opening, and the refusal is indistinguishable from the
   * user dismissing the dialog.
   */
  function onRequestCapture(): void {
    const res = loopbackStatus.request(id, 'acquire');
    if (!res.delivered) {
      console.warn('[loopback] START CAPTURE reached no controller for node', id);
    }
  }

  function onStopCapture(): void {
    const res = loopbackStatus.request(id, 'stop');
    if (!res.delivered) {
      console.warn('[loopback] STOP reached no controller for node', id);
    }
  }

  function onToggleCrop(): void {
    setNodeParam(id, 'crop', p('crop') < 0.5 ? 1 : 0);
  }

  // ---- Adopt the NODE-owned <video> into this card, to SHOW it ----
  //
  // ⚠ ADOPT, not create. The controller `ensure`s the element into existence
  // with no host at all, so it exists (and is attached to the engine) whether
  // or not any surface is mounted. Adoption is a transfer with an owner-checked
  // release, so this card and the faceplate can hand it back and forth without
  // either teardown stranding the live one.
  $effect(() => {
    const host = videoHost;
    if (!host) return;
    const lease = nodeMedia.adopt(id, LOOPBACK_SOURCE_SLOT, host, { kind: 'video' });
    mediaLease = lease;
    return () => {
      lease.release();
      if (mediaLease === lease) mediaLease = null;
    };
  });

  onDestroy(() => {
    // NOTE what is deliberately ABSENT: no stop, no detach, no track teardown.
    // Unmounting a view is not a content event. The controller owns all three
    // and dies with the NODE.
    mediaLease?.release();
    mediaLease = null;
  });

  const STATE_LABEL: Record<State, string> = {
    idle: 'idle',
    requesting: 'requesting…',
    capturing: 'capturing',
    ended: 'sharing stopped',
    unsupported: 'unsupported',
    error: 'error',
  };
</script>

<div class="vcard card video">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="LOOPBACK" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
  <div class="body">
    <div class="row status-row" data-testid="loopback-status" data-state={capState}>
      <span
        class="led"
        class:capturing={capState === 'capturing'}
        class:warn={capState === 'requesting' || capState === 'ended'}
        class:err={capState === 'error' || capState === 'unsupported'}
      ></span>
      <span class="status-label">{STATE_LABEL[capState]}</span>
    </div>

    {#if errorMsg}
      <div class="error" role="alert">{errorMsg}</div>
    {/if}

    <div class="preview-wrap">
      <!-- The <video> is BOTH the texImage2D source AND a live preview. Because
           it is the tab it captures, the preview is intentionally recursive (a
           video-feedback tunnel) while capturing. -->
      <!-- The <video> is NOT declared here: it belongs to the NODE and is
           adopted into this host div (see the $effect above). -->
      <div class="video-host" bind:this={videoHost}></div>
      {#if capState === 'capturing'}
        <div class="hint" data-testid="loopback-recursive-hint">
          Capturing this tab — the preview loops recursively
        </div>
      {/if}
    </div>

    <div class="controls">
      {#if capState === 'unsupported'}
        <button class="ghost" data-testid="loopback-start-capture" disabled>
          Capture unsupported
        </button>
      {:else if capState === 'capturing'}
        <button class="ghost" data-testid="loopback-stop-capture" onclick={onStopCapture}>
          Stop capture
        </button>
      {:else}
        <button
          class="primary"
          data-testid="loopback-start-capture"
          onclick={onRequestCapture}
          disabled={capState === 'requesting'}
        >
          {capState === 'idle' ? 'Start capture' : capState === 'requesting' ? 'Requesting…' : 'Re-capture'}
        </button>
      {/if}
      <button
        class="ghost"
        data-testid="loopback-crop-toggle"
        onclick={onToggleCrop}
        aria-pressed={p('crop') > 0.5}
      >
        Crop{p('crop') > 0.5 ? ': viewport' : ': full tab'}
      </button>
    </div>

    <div class="fader-grid">
      <NeonFader
        value={p('gain')}
        min={0}
        max={2}
        defaultValue={loopbackDef.params.find((x) => x.id === 'gain')!.defaultValue}
        label="Gain"
        curve="linear"
        onchange={setParam('gain')} moduleId={id} paramId="gain"
      />
    </div>
  </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 280px;
    min-height: 320px;
  }
  .body {
    margin-top: 24px;
    padding: 0 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.7rem;
    color: var(--text-dim);
  }
  .status-row { align-items: center; gap: 6px; }
  .led {
    width: 8px; height: 8px; border-radius: 50%;
    background: #555;
  }
  .led.capturing { background: #16a34a; box-shadow: 0 0 4px #16a34a; }
  .led.warn { background: #ca8a04; }
  .led.err { background: #dc2626; }
  .status-label { font-family: ui-monospace, monospace; font-size: 0.65rem; }

  .error {
    font-size: 0.65rem;
    color: #fca5a5;
    background: rgba(220, 38, 38, 0.08);
    border: 1px solid rgba(220, 38, 38, 0.3);
    padding: 4px 6px;
    border-radius: 2px;
    line-height: 1.3;
  }

  .preview-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin: 4px 0;
    gap: 2px;
  }
  /* The <video> is ADOPTED into .video-host at runtime (node-owned, see
   * $lib/ui/media/node-media-registry), so these rules must be :global().
   * `display: contents` keeps the adopted element in the parent's layout. */
  .video-host { display: contents; }
  .video-host :global(video) {
    width: 200px;
    height: 112px;
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    object-fit: contain;
  }
  .hint {
    font-size: 0.6rem;
    color: var(--text-dim);
    opacity: 0.6;
    text-align: center;
    line-height: 1.2;
    max-width: 200px;
  }

  .controls {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
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
    background: rgba(244, 114, 182, 0.12);
    border-color: var(--cable-video);
    color: var(--text);
  }
  button.primary:hover:not(:disabled) { background: rgba(244, 114, 182, 0.2); }

  .fader-grid {
    display: flex;
    justify-content: center;
    margin-top: 4px;
  }
</style>
