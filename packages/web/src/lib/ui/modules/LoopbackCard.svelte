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
  import { type NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { setNodeParam } from '$lib/graph/mutate';
  import { loopbackDef } from '$lib/video/modules/loopback';
  import {
    acquireViewportStream,
    isViewportCaptureSupported,
  } from '$lib/ui/viewport-acquire';
  import { computeCropUv, FULL_FRAME_CROP } from '$lib/video/loopback-crop';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  type State = 'idle' | 'requesting' | 'capturing' | 'ended' | 'unsupported' | 'error';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  // OUT-only patch panel (no inputs — a pure source). Port id is BYTE-IDENTICAL
  // to the def so persisted edges + the CV bridge route unchanged.
  const inputs: PortDescriptor[] = [];
  const outputs: PortDescriptor[] = [{ id: 'out', label: 'OUT', cable: 'video' }];

  let videoEl: HTMLVideoElement | null = $state(null);
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

  function stopStream(): void {
    if (stream) {
      for (const t of stream.getTracks()) t.stop();
      stream = null;
    }
    if (videoEl) videoEl.srcObject = null;
    videoEngine()?.attachExternalSource(id, 'video', null);
  }

  function onStopCapture(): void {
    stopStream();
    capState = 'idle';
  }

  function onToggleCrop(): void {
    setNodeParam(id, 'crop', p('crop') < 0.5 ? 1 : 0);
  }

  // The app viewport element whose on-screen rectangle defines "what the user
  // sees". The SvelteFlow pane is the canvas the user pans/zooms; fall back to
  // the document element (whole layout viewport) if it isn't mounted.
  function viewportElement(): Element | null {
    if (typeof document === 'undefined') return null;
    return document.querySelector('.svelte-flow') ?? document.documentElement;
  }

  // Push the measured crop rectangle to the engine every animation frame while
  // capturing. Crop ON → the viewport element's rect; OFF → the whole tab.
  $effect(() => {
    if (capState !== 'capturing') return;
    let raf = 0;
    const tick = (): void => {
      const ve = videoEngine();
      if (ve) {
        let crop = FULL_FRAME_CROP;
        if (p('crop') >= 0.5) {
          const el = viewportElement();
          if (el && typeof window !== 'undefined') {
            const r = el.getBoundingClientRect();
            crop = computeCropUv(
              { x: r.left, y: r.top, width: r.width, height: r.height },
              window.innerWidth,
              window.innerHeight,
            );
          }
        }
        ve.setParam(id, '_cropU0', crop.u0);
        ve.setParam(id, '_cropU1', crop.u1);
        ve.setParam(id, '_cropV0', crop.v0);
        ve.setParam(id, '_cropV1', crop.v1);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
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
    stopStream();
    videoEngine()?.attachExternalSource(id, 'video', null);
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

<div class="card video">
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
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={videoEl}
        data-testid="loopback-preview"
        playsinline
        muted
        autoplay
      ></video>
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
      <Fader
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
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
  }
  :global(.svelte-flow__node:hover) .card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--cable-video);
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
  video {
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
