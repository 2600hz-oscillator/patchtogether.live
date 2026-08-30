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
  // Multiplayer: only { searchTerm, instanceHost, selectedHost, uuid, name } live
  // on node.data (synced). Transient playback state is published by the
  // controller and read here — NEVER per-frame written to the synced store (the
  // per-frame-write storm lesson).

  import { onMount, onDestroy } from 'svelte';
  import { nodeMedia, type NodeMediaLease } from '$lib/ui/media/node-media-registry';
  import { nodeHlsSource, HLS_SOURCE_SLOT } from '$lib/ui/media/node-hls-source.svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import { captureFlowStore } from './card-kit';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import { startCornerResize } from './card-resize';
  import ModuleTitle from './ModuleTitle.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import { watchUrl, type PeerTubeData } from '$lib/video/modules/peertube-query';

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
  let videoName = $derived<string | null>(
    (node?.data as Partial<PeerTubeData> | undefined)?.name ?? null,
  );

  // ---- Card-local UI state ----
  let videoHost: HTMLDivElement | null = $state(null);
  let mediaLease: NodeMediaLease<HTMLElement> | null = null;
  let searchTerm = $state('');
  let instanceHost = $state('');
  let rateMsg = $state<string | null>(null);

  // ---- The controller's published status ----
  //
  // Read THROUGH the registry rather than mirrored into card `$state`. There is
  // therefore no moment at which this surface's answer and the node's answer can
  // differ — the stale-mirror bug the pre-#1511 cards all had.
  let src = $derived(nodeHlsSource.view(id));
  let streamState = $derived(src.streamState);
  let catalogue = $derived(src.catalogue);
  let isPlaying = $derived(src.isPlaying);
  let displayFrac = $derived(src.playheadFrac);
  let loading = $derived(src.loadingCatalogue || src.loadingStream);
  let statusMsg = $derived(src.statusMsg);
  /** The controller's error, or this card's own rate-limit refusal. */
  let errorMsg = $derived(rateMsg ?? src.error);

  // ---- Synced writes (single transact; only the small persisted set) ----
  function writeSearchTerm(): void {
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      const d = t.data as Partial<PeerTubeData>;
      d.searchTerm = searchTerm;
      d.instanceHost = instanceHost;
    }, LOCAL_ORIGIN);
  }

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

  onMount(() => {
    const d = node?.data as Partial<PeerTubeData> | undefined;
    if (d) {
      searchTerm = d.searchTerm ?? '';
      instanceHost = d.instanceHost ?? '';
    }
  });

  // ---- Search (debounced + rate-limited: ~50 calls / 10 s) ----
  //
  // The RATE LIMIT stays here on purpose: it exists to protect Sepia Search from
  // a human holding a key down, which is a fact about this input box and not
  // about the node. The FETCH itself is the controller's — this only decides
  // whether to ask for one.
  const RATE_WINDOW_MS = 10_000;
  const RATE_MAX = 50;
  let callTimestamps: number[] = [];
  function rateOk(): boolean {
    const now = Date.now();
    callTimestamps = callTimestamps.filter((t) => now - t < RATE_WINDOW_MS);
    if (callTimestamps.length >= RATE_MAX) return false;
    callTimestamps.push(now);
    return true;
  }

  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
  function onSearchInput(): void {
    writeSearchTerm();
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { runSearch(); }, 350);
  }
  function onSearchKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (searchDebounce) { clearTimeout(searchDebounce); searchDebounce = null; }
      runSearch();
    }
  }

  function runSearch(): void {
    if (!rateOk()) {
      rateMsg = 'Slow down — too many searches; try again in a moment.';
      return;
    }
    rateMsg = null;
    writeSearchTerm();
    nodeHlsSource.request(id, { kind: 'catalogue', key: searchTerm });
  }

  // ---- Gestures ----
  //
  // Each of these is a USER ACTION that cannot originate anywhere else, handed
  // to the controller through the one seam that can reach it whether or not this
  // card is the surface the user is looking at.
  function selectResult(key: string): void {
    nodeHlsSource.request(id, { kind: 'select', candidateKey: key });
  }
  function nextResult(): void {
    nodeHlsSource.request(id, { kind: 'next' });
  }
  function togglePlay(): void {
    nodeHlsSource.request(id, { kind: 'togglePlay' });
  }

  onDestroy(() => {
    if (searchDebounce) clearTimeout(searchDebounce);
    // NOTE what is deliberately ABSENT: no teardownHls, no detach, no
    // unwireAudio, no setPlaying(false), no trigger-loop stop, no display-timer
    // stop. NONE of those exist here any more — they are the controller's, on
    // node lifetime. Everything released here is THIS CARD'S OWN.
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
      apply: (w, h) => {
        const t = patch.nodes[id];
        if (t) {
          if (!t.data) t.data = {};
          (t.data as Record<string, unknown>).width = w;
          (t.data as Record<string, unknown>).height = h;
        }
      },
      onStart: () => { resizing = true; },
      onEnd: () => { resizing = false; resizeAbort = null; },
    });
  }
  onDestroy(() => { if (resizeAbort) resizeAbort.abort(); });

  let attributionUrl = $derived<string>(
    selectedHost && uuid ? watchUrl(selectedHost, uuid) : '',
  );
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
      <!-- Search -->
      <div class="controls">
        <input
          class="search-input nodrag"
          type="text"
          placeholder="search the fediverse…"
          bind:value={searchTerm}
          oninput={onSearchInput}
          onkeydown={onSearchKeydown}
          data-testid="peertube-search"
          aria-label="Search term"
        />
        <div class="row">
          <input
            class="instance-input nodrag"
            type="text"
            placeholder="instance (optional)"
            bind:value={instanceHost}
            onchange={writeSearchTerm}
            data-testid="peertube-instance"
            aria-label="Instance host (optional)"
          />
          <button
            type="button"
            class="next-btn nodrag"
            onclick={nextResult}
            disabled={catalogue.length === 0}
            data-testid="peertube-next"
            title="Load the next result"
          >↻ next</button>
        </div>
      </div>

      <!-- Preview -->
      <div class="preview-wrap" data-testid="peertube-preview">
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

      {#if videoName}
        <div class="now-playing" data-testid="peertube-now-playing" title={videoName}>
          <span class="np-name">{videoName}</span>
          {#if attributionUrl}
            <a class="np-src nodrag" href={attributionUrl} target="_blank" rel="noopener noreferrer">{selectedHost}</a>
          {/if}
        </div>
      {/if}

      {#if uuid}
        <div class="transport">
          <button type="button" class="play-btn nodrag" onclick={togglePlay} aria-pressed={isPlaying} data-testid="peertube-play">{isPlaying ? 'Pause' : 'Play'}</button>
          <div class="bar" data-testid="peertube-bar"><div class="fill" style="width: {displayFrac * 100}%"></div></div>
        </div>
      {/if}

      {#if errorMsg}
        <div class="error" data-testid="peertube-error">{errorMsg}</div>
      {/if}
      {#if loading}
        <div class="status" data-testid="peertube-status">{statusMsg ?? 'Loading…'}</div>
      {/if}

      <!-- Results -->
      <div class="results" data-testid="peertube-results">
        {#each catalogue as c (c.key)}
          <button
            type="button"
            class="result nodrag"
            class:sel={c.key === src.selectionKey}
            onclick={() => selectResult(c.key)}
            data-testid="peertube-result"
            data-key={c.key}
          >
            {#if c.thumbnailUrl}
              <img class="thumb" src={c.thumbnailUrl} alt="" loading="lazy" />
            {:else}
              <span class="thumb thumb-empty">▶</span>
            {/if}
            <span class="r-meta">
              <span class="r-title">{c.label}</span>
              <span class="r-sub">{c.sublabel}</span>
            </span>
          </button>
        {/each}
      </div>

      <!-- Attribution / posture -->
      <div class="disclaimer" data-testid="peertube-disclaimer">
        Federated public videos via the <a href="https://joinpeertube.org" target="_blank" rel="noopener noreferrer">PeerTube</a>
        fediverse · search by <a href="https://sepiasearch.org" target="_blank" rel="noopener noreferrer">Sepia Search</a>.
      </div>
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

  .controls { display: flex; flex-direction: column; gap: 4px; }
  .row { display: flex; gap: 4px; align-items: center; }
  .search-input {
    width: 100%;
    background: #11151c; color: var(--text); border: 1px solid #404652;
    border-radius: 2px; font-size: 0.7rem; padding: 4px 6px;
  }
  .instance-input {
    flex: 1; min-width: 0;
    background: #11151c; color: var(--text); border: 1px solid #404652;
    border-radius: 2px; font-size: 0.62rem; padding: 3px 5px;
  }
  .next-btn {
    background: #2a3340; color: var(--text); border: none; border-radius: 2px;
    padding: 3px 8px; font-size: 0.6rem; cursor: pointer; letter-spacing: 0.03em;
  }
  .next-btn:disabled { opacity: 0.5; cursor: default; }
  .next-btn:hover:not(:disabled) { filter: brightness(1.2); }

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

  .now-playing { display: flex; align-items: baseline; gap: 6px; font-size: 0.7rem; overflow: hidden; }
  .np-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .np-src { color: var(--accent-dim); font-size: 0.55rem; font-family: ui-monospace, monospace; text-decoration: none; margin-left: auto; }
  .np-src:hover { text-decoration: underline; }

  .transport { display: flex; align-items: center; gap: 6px; }
  .play-btn {
    background: var(--cable-video); color: #000; border: none; border-radius: 2px;
    padding: 3px 10px; font-size: 0.66rem; cursor: pointer; min-width: 52px;
  }
  .play-btn:hover { filter: brightness(1.1); }
  .bar { flex: 1; height: 4px; background: #1a1f2a; border-radius: 2px; overflow: hidden; }
  .fill { height: 100%; background: var(--cable-video); }

  .error { font-size: 0.6rem; color: #ff8c6b; font-family: ui-monospace, monospace; }
  .status { font-size: 0.6rem; color: var(--text-dim); font-family: ui-monospace, monospace; }

  .results {
    flex: 1; min-height: 0;
    overflow-y: auto;
    display: flex; flex-direction: column; gap: 1px;
    border: 1px solid var(--border); border-radius: 2px;
    padding: 2px;
  }
  .result {
    display: flex; align-items: center; gap: 6px;
    background: transparent; color: var(--text);
    border: none; border-radius: 2px;
    padding: 3px 4px; cursor: pointer; text-align: left; width: 100%;
  }
  .result:hover { background: rgba(0, 240, 255, 0.08); }
  .result.sel { background: rgba(0, 240, 255, 0.16); }
  .thumb { width: 48px; height: 27px; object-fit: cover; border-radius: 1px; background: #000; flex: 0 0 auto; }
  .thumb-empty { display: flex; align-items: center; justify-content: center; color: var(--text-dim); font-size: 0.7rem; }
  .r-meta { display: flex; flex-direction: column; min-width: 0; }
  .r-title { font-size: 0.64rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .r-sub { font-size: 0.5rem; color: var(--text-dim); font-family: ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .disclaimer {
    margin-top: auto;
    font-size: 0.5rem; line-height: 1.3;
    color: var(--text-dim);
    border-top: 1px solid var(--divider);
    padding-top: 4px;
  }
  .disclaimer a { color: var(--accent-dim); }

  .resize-handle {
    position: absolute; right: 0; bottom: 0;
    width: 16px; height: 16px; cursor: nwse-resize;
    background: linear-gradient(135deg, transparent 50%, var(--cable-video) 50%, var(--cable-video) 60%, transparent 60%, transparent 70%, var(--cable-video) 70%, var(--cable-video) 80%, transparent 80%);
    opacity: 0.7; z-index: 5;
  }
  .resize-handle:hover { opacity: 1; }
</style>
