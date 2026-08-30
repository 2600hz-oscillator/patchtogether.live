<script lang="ts">
  // LoopbackCard — UI for the LOOPBACK browser-viewport video source.
  //
  // Owns: getDisplayMedia (current-tab capture) + the hidden capture <video> +
  // the capture-permission state machine + the per-frame crop-rect push. Hands
  // the <video> element to the engine module via attachExternalSource (single
  // source of truth — the WebGL2 sampler reads it directly), and pushes the
  // measured viewport crop rectangle to the engine each frame via the private
  // `_crop*` setParam channel (LOCAL, per-viewer — never synced, since each
  // collaborator's viewport differs).
  //
  // State scopes:
  //   - `state` (idle / requesting / capturing / …): per-tab, local Svelte
  //     $state. NOT in Yjs — a screen-capture grant is browser-instance-local.
  //   - `node.params.gain / crop`: in Yjs, synced across collaborators.

  import { onMount, onDestroy } from 'svelte';
  import { nodeMedia, type NodeMediaLease } from '$lib/ui/media/node-media-registry';
  import { type NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { setNodeParam } from '$lib/graph/mutate';
  import { patch } from '$lib/graph/store';
  import { loopbackDef } from '$lib/video/modules/loopback';
  import {
    acquireViewportStream,
    isViewportCaptureSupported,
    type LoopbackCaptureState,
  } from '$lib/ui/viewport-acquire';
  import {
    loopbackStatus,
    type LoopbackCommandLease,
  } from '$lib/ui/media/loopback-status-registry';
  import { loopbackCropPump } from '$lib/ui/media/loopback-crop-pump';
  // ⚠ NO `computeCropUv` / `FULL_FRAME_CROP` IMPORT ANY MORE — the crop math is
  // reached through the pump now, and re-importing it here would be the first
  // step back towards a second measurement site.
  import type { VideoEngine } from '$lib/video/engine';
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

  const engineCtx = useEngine();

  // OUT-only patch panel (no inputs — a pure source). Port id is BYTE-IDENTICAL
  // to the def so persisted edges + the CV bridge route unchanged.
  const inputs = portsFromDef(loopbackDef.inputs);
  const outputs = portsFromDef(loopbackDef.outputs);

  // The <video> and the capture STREAM are owned by the NODE, not by this
  // card (see $lib/ui/media/node-media-registry). Loopback was the worst case
  // of the card-lifetime bug: `onDestroy` stopped the tracks, and
  // getDisplayMedia cannot be restarted without a fresh user gesture — so a
  // collapse did not merely pause the capture, it ended it permanently and the
  // user had to re-pick the tab.
  let videoHost: HTMLDivElement | null = $state(null);
  let videoEl: HTMLVideoElement | null = $state(null);
  let mediaLease: NodeMediaLease<HTMLElement> | null = null;
  const MEDIA_SLOT = 'main';
  /** Mirror of the NODE-owned stream; rehydrated on adopt. */
  let stream: MediaStream | null = null;
  let capState: State = $state('idle');
  let errorMsg = $state<string | null>(null);

  function p(name: string): number {
    const def = loopbackDef.params.find((x) => x.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number): void => setNodeParam(id, paramId, v);
  }

  function videoEngine(): VideoEngine | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      return e.getDomain<VideoEngine>('video');
    } catch {
      return null;
    }
  }

  async function requestCapture(): Promise<void> {
    if (!isViewportCaptureSupported()) {
      capState = 'unsupported';
      errorMsg = 'This browser does not support tab/screen capture (getDisplayMedia).';
      return;
    }
    capState = 'requesting';
    errorMsg = null;
    stopStream();

    const md = navigator.mediaDevices as unknown as {
      getDisplayMedia: (c: MediaStreamConstraints) => Promise<MediaStream>;
    };
    const result = await acquireViewportStream((c) => md.getDisplayMedia(c));
    if (!result.stream) {
      const e = result.error;
      if (e && (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError')) {
        // User dismissed the picker or denied — a normal outcome, back to idle.
        capState = 'idle';
        errorMsg = null;
      } else {
        capState = 'error';
        errorMsg = e ? `${e.name}: ${e.message}` : 'Capture failed.';
      }
      return;
    }
    stream = result.stream;
    // The registry owns it from here: it stops the PREVIOUS stream (a re-share
    // legitimately replaces it) and never stops this one on a card unmount.
    nodeMedia.setStream(id, MEDIA_SLOT, stream);
    startCropPump();

    if (videoEl) {
      videoEl.srcObject = stream;
      try {
        await videoEl.play();
      } catch (playErr) {
        console.warn('[loopback] video.play() rejected:', playErr);
      }
    }

    // Announce the element to the engine module (the sampler reads it directly).
    videoEngine()?.attachExternalSource(id, 'video', videoEl);

    // The user can stop the share from the browser's share bar → the track
    // ends. Return to idle with a re-capture button.
    const track = stream.getVideoTracks()[0];
    track?.addEventListener('ended', () => {
      if (capState === 'capturing') {
        capState = 'ended';
        errorMsg = null;
        stopStream();
      }
    });

    capState = 'capturing';
  }

  /** An EXPLICIT stop (the user pressed stop, or the share bar ended the
   *  track). This is a genuine content change, not a view teardown, so the
   *  registry frees the stream here. It is never called from onDestroy. */
  function stopStream(): void {
    nodeMedia.setStream(id, MEDIA_SLOT, null);
    stream = null;
    if (videoEl) videoEl.srcObject = null;
    videoEngine()?.attachExternalSource(id, 'video', null);
    // The pump is NODE-keyed and deliberately outlives this card, so the thing
    // that ends it is an end of CONTENT — never a view teardown. This is the
    // same line `stopStream` already draws for the stream itself.
    loopbackCropPump.stop(id);
  }

  function onStopCapture(): void {
    stopStream();
    capState = 'idle';
  }

  /**
   * Start the NODE-keyed crop pump (see $lib/ui/media/loopback-crop-pump).
   *
   * ⚠ EVERY DEPENDENCY IS A FUNCTION READ FRESH EACH FRAME, and `cropEnabled`
   * reads the GRAPH STORE rather than this component's `p('crop')`. The pump
   * outlives this card by design; a captured component-scoped value would
   * freeze at the last mounted frame, which is exactly the stuck-value bug the
   * move was made to remove.
   */
  function startCropPump(): void {
    loopbackCropPump.start(id, {
      cropEnabled: () => {
        const raw = patch.nodes[id]?.params?.crop;
        const def = loopbackDef.params.find((x) => x.id === 'crop')?.defaultValue ?? 1;
        return (typeof raw === 'number' ? raw : def) >= 0.5;
      },
      push: (crop) => {
        const ve = videoEngine();
        if (!ve) return;
        ve.setParam(id, '_cropU0', crop.u0);
        ve.setParam(id, '_cropU1', crop.u1);
        ve.setParam(id, '_cropV0', crop.v0);
        ve.setParam(id, '_cropV1', crop.v1);
      },
    });
  }

  function onToggleCrop(): void {
    setNodeParam(id, 'crop', p('crop') < 0.5 ? 1 : 0);
  }

  // ⚠ THE CROP PUMP USED TO LIVE HERE, as an `$effect` that started a rAF loop
  // while `capState === 'capturing'` and cancelled it on teardown. It moved to
  // `$lib/ui/media/loopback-crop-pump` (NODE-keyed) for two measured reasons —
  // a collapse froze `_crop*` at the last mounted frame while the capture kept
  // running, and the promotion put this card inside a SECOND `.svelte-flow`
  // (the headless host's), which made the old
  // `document.querySelector('.svelte-flow')` reader ambiguous. The full
  // argument is in that file's header; what belongs here is only the START and
  // the STOP, and both are content events rather than view events.
  //
  // Rehydrate the pump whenever this card finds a capture already running —
  // a remount after a collapse, or the first mount inside the headless host.
  // `start` is idempotent while running, so this cannot stack a second loop.
  $effect(() => {
    if (capState === 'capturing') startCropPump();
  });

  // ── Publish status + register the commands the FACEPLATE drives ───────────
  //
  // ⚠ THIS IS WHAT MAKES A PROMOTED LOOPBACK USABLE AT ALL. Under the default
  // shell this card runs inside `<HeadlessSourceHost>` — mounted (so the stream
  // survives) but `pointer-events: none`, so every button below is unreachable.
  // The faceplate reads this status and invokes these commands; ownership of
  // getDisplayMedia, the MediaStream and this state machine never leaves here.
  // See $lib/ui/media/loopback-status-registry.
  let commandLease: LoopbackCommandLease | null = null;

  $effect(() => {
    // Re-published on every state/error change — the face's lamp, its error
    // text and whether its buttons are offerable all derive from this.
    loopbackStatus.publish(id, {
      state: capState,
      errorMsg,
      supported: isViewportCaptureSupported(),
    });
  });

  $effect(() => {
    const lease = loopbackStatus.registerCommands(id, {
      acquire: () => void requestCapture(),
      stop: onStopCapture,
    });
    commandLease = lease;
    return () => {
      lease.release();
      if (commandLease === lease) commandLease = null;
    };
  });

  // ---- Adopt the NODE-owned <video> into this card ----
  $effect(() => {
    const host = videoHost;
    if (!host) return;
    const lease = nodeMedia.adopt(id, MEDIA_SLOT, host, {
      kind: 'video',
      init: (el) => {
        const v = el as HTMLVideoElement;
        v.playsInline = true;
        v.muted = true;
        v.autoplay = true;
        v.setAttribute('data-testid', 'loopback-preview');
      },
    });
    mediaLease = lease;
    const v = lease.el as HTMLVideoElement;
    videoEl = v;
    // Rehydrate from the node: a capture may already be running from a
    // previous mount, in which case the element still holds its srcObject.
    stream = nodeMedia.stream(id, MEDIA_SLOT);
    if (stream && v.srcObject !== stream) v.srcObject = stream;
    if (stream && capState !== 'capturing') capState = 'capturing';
    return () => {
      lease.release();
      if (mediaLease === lease) mediaLease = null;
    };
  });

  onMount(() => {
    if (!isViewportCaptureSupported()) {
      capState = 'unsupported';
      errorMsg = 'This browser does not support tab/screen capture (getDisplayMedia).';
      return;
    }
    // Hand the (empty, not-yet-capturing) <video> to the engine right away so a
    // later srcObject attach is picked up without a re-mount. Poll until the
    // engine-side node exists (addNode is async) OR we time out.
    let attempts = 0;
    const iv = setInterval(() => {
      attempts++;
      const ve = videoEngine();
      if (ve) {
        try {
          ve.attachExternalSource(id, 'video', videoEl);
          if (ve.read(id, 'hasVideoElement') === true) clearInterval(iv);
        } catch {
          /* engine not ready */
        }
      }
      if (attempts > 50) clearInterval(iv); // ~5s
    }, 100);
  });

  onDestroy(() => {
    // NOTE what is deliberately ABSENT: no stopStream(), no detach. A collapse
    // MOVES this card between mounts; stopping the tracks here ended a capture
    // that cannot be restarted without a new user gesture. The stream belongs
    // to the node and is stopped by nodeMedia when the node leaves the graph.
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
          onclick={requestCapture}
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
