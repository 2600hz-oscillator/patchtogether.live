<script lang="ts">
  // PeerTubeCard — the SURFACE for a federated-video source whose lifecycle
  // belongs to the NODE.
  //
  // ⚠ THIS CARD CREATES NOTHING AND DISPOSES NOTHING (LEG-02 P3, #1511). The
  // <video>, its hls.js demuxer, the engine attach, the audio wire + un-mute,
  // the search catalogue, the selection→stream application, the play/next
  // trigger poll and the playhead loop are ALL owned by
  // `$lib/ui/media/node-hls-source-registry` on GRAPH lifetime, created and
  // swept from Canvas's own effects. This file adopts the node's element for
  // display, renders the browser, and forwards user GESTURES through
  // `nodeHlsSource.request(...)`.
  //
  // ⚠ NO `attachExternalSource` ANYWHERE IN THIS FILE, and that is the
  // mechanical fact that takes `peertube` out of `DOM_SOURCE_LANE_TYPES`: the
  // grep gate (`dom-source-modules.test.ts`) derives that set by walking each
  // card's component subtree for exactly this call, so the declaration and the
  // code cannot drift — the type leaves the set in the same diff the call leaves
  // the card.
  //
  // ⚠ NO `read(id, 'extras')` EITHER, and that deletion is load-bearing rather
  // than tidiness: a card that cannot reach the handle cannot tear it down, so
  // the class of defect `card-media-lifetime.test.ts` exists for becomes
  // unspellable here rather than merely absent. Its EXTRAS_OWNERS entry went
  // with it.
  //
  // FLOW (unchanged for the player): a debounced search box → Sepia Search (the
  // PeerTube fediverse meta-index, CORS-open + anonymous) → a results list →
  // click a result → the controller resolves its HLS master playlist and hands
  // it to hls.js → the engine module (peertube.ts) samples the element into the
  // FBO (a CLEAN `video` texture, since PeerTube sends ACAO:*) and taps stereo
  // audio (audio_l / audio_r).
  //
  // THE AUDIO TRAP, for the reader who comes here looking for it: the element is
  // created `muted` so the programmatic play() is allowed without a user
  // gesture, and MUST be un-muted after createMediaElementSource succeeds or
  // audio_l/audio_r carry silence. That step now lives in the controller's
  // `ensureAudioWired`, on node lifetime — which is what stops a card unmount
  // mid-retry from stranding the element muted forever.
  //
  // Multiplayer: only { searchTerm, selectedHost, uuid, name } live on node.data
  // (synced). Transient playback state is published by the controller and read
  // here — NEVER per-frame written to the synced store (the per-frame-write
  // storm lesson).
  //
  // ⚠ THE SEARCH BOX, THE ROSTER, THE TRANSPORT, THE ATTRIBUTION ANCHOR AND THE
  // DISCLAIMER ARE NOT IN THIS FILE ANY MORE. They live in
  // `./peertube/PeerTubePicker.svelte`, which the FACEPLATE BODY also mounts
  // (wave-4 face promotion). Promotion stops rendering this card on normal
  // surfaces, so a copy in each place is how the two drift — and this module
  // pair has a documented instance of correctness travelling by hand-copy and
  // arriving late (the `muted = false` audio trap).

  import { onDestroy } from 'svelte';
  import { nodeMedia, type NodeMediaLease } from '$lib/ui/media/node-media-registry';
  import { nodeHlsSource, HLS_SOURCE_SLOT } from '$lib/ui/media/node-hls-source.svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import { captureFlowStore } from './card-kit';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { mutateNode } from '$lib/graph/mutate';
  import { startCornerResize } from './card-resize';
  import ModuleTitle from './ModuleTitle.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import type { PeerTubeData } from '$lib/video/modules/peertube-query';
  import PeerTubePicker from './peertube/PeerTubePicker.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  // Guarded: the dock full-view plain-mounts this card OUTSIDE the
  // SvelteFlow provider, where a bare useStore() throws and killed the
  // card at init (no video in the expanded faceplate). Inside the
  // provider this is byte-identical; outside it's null -> zoom 1.
  const flowStore = captureFlowStore();

  // ---- Sizing (mirror VIDEOBOX / TV-LIBRARIAN; 180-multiple defaults) ----
  const DEFAULT_WIDTH = 360;
  const DEFAULT_HEIGHT = 540;
  const MIN_WIDTH = 360;
  const MIN_HEIGHT = 360;
  let cardWidth = $derived<number>((node?.data?.width as number | undefined) ?? DEFAULT_WIDTH);
  let cardHeight = $derived<number>((node?.data?.height as number | undefined) ?? DEFAULT_HEIGHT);

  // ---- PatchPanel ports (NO raw side handles — the #767 yellow-drill-down
  //      standard). Port ids are BYTE-IDENTICAL to the module def. ----
  const inputs: PortDescriptor[] = [
    { id: 'play_trigger', label: 'PLAY TRIGGER', cable: 'gate' },
    { id: 'next_trigger', label: 'NEXT TRIGGER', cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'video', label: 'VIDEO', cable: 'video' },
    { id: 'audio_l', label: 'AUDIO L', cable: 'audio' },
    { id: 'audio_r', label: 'AUDIO R', cable: 'audio' },
    { id: 'loaded', label: 'LOADED', cable: 'gate' },
    { id: 'ended', label: 'ENDED', cable: 'gate' },
    { id: 'playing', label: 'PLAYING', cable: 'gate' },
    { id: 'playhead', label: 'PLAYHEAD', cable: 'cv' },
  ];

  // ---- Persisted (synced) reads ----
  let selectedHost = $derived<string | null>(
    (node?.data as Partial<PeerTubeData> | undefined)?.selectedHost ?? null,
  );
  let uuid = $derived<string | null>(
    (node?.data as Partial<PeerTubeData> | undefined)?.uuid ?? null,
  );

  // ---- Card-local UI state ----
  let videoHost: HTMLDivElement | null = $state(null);
  let mediaLease: NodeMediaLease<HTMLElement> | null = null;

  // ---- The controller's published status ----
  //
  // Read THROUGH the registry rather than mirrored into card `$state`. There is
  // therefore no moment at which this surface's answer and the node's answer can
  // differ — the stale-mirror bug the pre-#1511 cards all had.
  let src = $derived(nodeHlsSource.view(id));
  let streamState = $derived(src.streamState);
  let isPlaying = $derived(src.isPlaying);

  // ── THE VIDEO NAME LIVES ON THE ACCESSIBLE NAME, NOT IN A TEXT NODE ──────
  //
  // ⚠ THE `peertube-now-playing` READOUT IS DELETED ON BOTH SURFACES, NOT
  // HIDDEN (owner ruling, 2026-08-17 — a derived value restated outside every
  // control). It moves to the picture's accessible name here and in the face
  // body, so it stays speakable and assertable, and the roster's highlighted
  // row is the painted answer. The instance host is not lost with it: the
  // attribution ANCHOR in the picker is a navigational control and names it.
  let pictureLabel = $derived<string>(
    src.selectionLabel
      ? `PEERTUBE picture — playing ${src.selectionLabel}${selectedHost ? ` on ${selectedHost}` : ''}`
      : 'PEERTUBE picture — nothing selected',
  );

  // ---- Adopt the NODE-owned <video> into this card ----
  //
  // The element is created once per node by the controller and parked
  // off-screen; every card mount adopts it and every unmount releases it.
  // Adoption is a TRANSFER and release is owner-checked in the registry, so the
  // two mounts a collapse straddles cannot fight over it in either order.
  //
  // ⚠ NO ATTACH CALL AND NO DISPOSER. The element arrives already attached and
  // already carrying its hls teardown: the controller `ensure`s it, attaches it
  // and registers the disposer at NODE creation, long before any card exists.
  // Adoption here is a DOM re-parent for display only.
  $effect(() => {
    const host = videoHost;
    if (!host) return;
    const lease = nodeMedia.adopt(id, HLS_SOURCE_SLOT, host, { kind: 'video' });
    mediaLease = lease;
    return () => {
      lease.release();
      if (mediaLease === lease) mediaLease = null;
    };
  });

  onDestroy(() => {
    // NOTE what is deliberately ABSENT: no teardownHls, no detach, no
    // unwireAudio, no setPlaying(false), no trigger-loop stop, no display-timer
    // stop. NONE of those exist here any more — they are the controller's, on
    // node lifetime. The search debounce is the PICKER's and dies with it.
    // Everything released here is THIS CARD'S OWN.
    mediaLease?.release();
    mediaLease = null;
  });

  // ---- Corner-drag resize ----
  let resizing = $state(false);
  let resizeAbort: AbortController | null = null;
  function onResizeStart(ev: PointerEvent): void {
    resizeAbort = startCornerResize(ev, {
      flowStore,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      getStartSize: () => ({ width: cardWidth, height: cardHeight }),
      // Boy-scout: TRACKED (mutateNode -> LOCAL_ORIGIN) so the resize reaches
      // Cmd-Z. The bare SyncedStore proxy write this replaces was outside the
      // UndoManager entirely — the same defect videobox's promotion fixed on
      // its own resize (#2303).
      apply: (w, h) => {
        mutateNode(id, (live) => {
          if (!live.data) live.data = {};
          (live.data as Record<string, unknown>).width = w;
          (live.data as Record<string, unknown>).height = h;
        });
      },
      onStart: () => { resizing = true; },
      onEnd: () => { resizing = false; resizeAbort = null; },
    });
  }
  onDestroy(() => { if (resizeAbort) resizeAbort.abort(); });
</script>

<div
  class="vcard card video peertube-card"
  class:resizing
  style="width: {cardWidth}px; height: {cardHeight}px;"
  data-testid="peertube-card"
  data-stream-state={streamState}
  data-has-selection={uuid !== null}
  data-is-playing={isPlaying}
  role="region"
  aria-label="PEERTUBE federated-video source"
>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="PEERTUBE" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <!-- Preview -->
      <div class="preview-wrap" data-testid="peertube-preview" role="img" aria-label={pictureLabel}>
        <!-- The <video> is NOT declared here: it belongs to the NODE and is
             adopted into this host div (see the $effect above). Declaring it
             in markup is what tied its lifetime to the card. -->
        <div class="video-host" bind:this={videoHost}></div>
        {#if streamState === 'loading'}
          <div class="overlay" data-testid="peertube-loading">loading…</div>
        {:else if streamState === 'unavailable'}
          <div class="overlay err" data-testid="peertube-unavailable">display unavailable — skipping</div>
        {:else if !uuid}
          <div class="overlay" data-testid="peertube-empty">search, then pick a video</div>
        {/if}
      </div>

      <!-- The search box, the transport, the attribution anchor, the roster and
           the disclaimer — ONE component, shared verbatim with the faceplate's
           `fullViewBody`, so neither surface can drift from the other. -->
      <PeerTubePicker nodeId={id} {selectedHost} {uuid} />
    </div>
  </PatchPanel>

  <div
    class="resize-handle nodrag"
    role="separator"
    aria-label="Resize PEERTUBE"
    data-testid="peertube-resize-handle"
    onpointerdown={onResizeStart}
  ></div>
</div>

<style>
  .card {
    padding-bottom: 12px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .card.resizing { transition: none; }
  .body {
    margin-top: 26px;
    padding: 0 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .preview-wrap {
    position: relative;
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    flex: 0 0 auto;
  }
  /* The <video> is ADOPTED into .video-host at runtime (node-owned, see
   * $lib/ui/media/node-media-registry), so Svelte cannot scope-class it —
   * these rules must be :global(). `display: contents` makes the adopted
   * element participate in the parent's layout exactly as the old inline
   * <video> did, so every descendant selector still matches. */
  .video-host { display: contents; }
  .video-host :global(video) {
    display: block;
    width: 100%; height: 100%;
    object-fit: contain;
    background: #000;
  }
  .overlay {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    text-align: center;
    background: rgba(5, 6, 8, 0.78);
    color: var(--text-dim);
    font-size: 0.65rem; padding: 6px;
    font-family: ui-monospace, monospace;
  }
  .overlay.err { color: #ffb86b; }

  .resize-handle {
    position: absolute; right: 0; bottom: 0;
    width: 16px; height: 16px; cursor: nwse-resize;
    background: linear-gradient(135deg, transparent 50%, var(--cable-video) 50%, var(--cable-video) 60%, transparent 60%, transparent 70%, var(--cable-video) 70%, var(--cable-video) 80%, transparent 80%);
    opacity: 0.7; z-index: 5;
  }
  .resize-handle:hover { opacity: 1; }
</style>
