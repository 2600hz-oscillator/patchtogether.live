<script lang="ts">
  // PeerTubeCard — federated-video SOURCE.
  //
  // FLOW: a debounced search box → Sepia Search (the PeerTube fediverse meta-
  // index, CORS-open + anonymous) → a results list (title, channel@host,
  // duration, thumbnail) → click a result → its per-instance video-details API
  // resolves the HLS master playlist (.m3u8) → hls.js attaches it to a card-owned
  // <video crossorigin="anonymous"> → the engine module (peertube.ts) samples it
  // into the FBO (CLEAN `video` texture, since PeerTube sends ACAO:*) + extracts
  // stereo audio (audio_l / audio_r).
  //
  // CRITICAL AUDIO TRAP (bit tv-librarian): the <video> is created `muted` so
  // autoplay is allowed; we MUST set `videoEl.muted = false` AFTER
  // createMediaElementSource succeeds — the tap redirects audio into WebAudio, so
  // un-muting un-gates it WITHOUT native speaker output. We re-mute before each
  // new stream's autoplay attempt. Otherwise audio_l/audio_r are silent.
  //
  // Multiplayer: only { instanceHost, uuid, name, selectedHost } live on
  // node.data (synced). Transient playback state (results, hls instance, loading,
  // playhead) stays render-local — NEVER per-frame written to the synced store
  // (the per-frame-write storm lesson).
  //
  // Graceful CORS: ~1/6 instances misconfigure CORS (raw S3, no ACAO) → on a
  // SecurityError / taint / fatal hls error the card degrades to "display
  // unavailable" + auto-skips to the next result (never crashes / hangs).

  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps, useStore } from '@xyflow/svelte';
  import Hls from 'hls.js';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import { startCornerResize } from './card-resize';
  import ModuleTitle from './ModuleTitle.svelte';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import { type PeerTubeHandleExtras } from '$lib/video/modules/peertube';
  import {
    buildSearchUrl,
    parseSearchResponse,
    videoDetailsUrl,
    watchUrl,
    resolveStream,
    formatDuration,
    type PeerTubeData,
    type PeerTubeVideo,
    type ResolvedStream,
  } from '$lib/video/modules/peertube-query';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  const flowStore = useStore();

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

  // ---- Render-local (transient) state ----
  let videoEl: HTMLVideoElement | null = $state(null);
  let hls: Hls | null = null;
  let searchTerm = $state('');
  let instanceHost = $state('');
  let results = $state<PeerTubeVideo[]>([]);
  let resultIndex = $state(-1); // index of the currently-loaded result (for "next")
  let loading = $state(false);
  let statusMsg = $state<string | null>(null);
  let errorMsg = $state<string | null>(null);
  let streamState = $state<'idle' | 'loading' | 'playing' | 'unavailable'>('idle');
  let isPlaying = $state(false);
  let displayFrac = $state(0);

  // ---- Engine helpers ----
  function videoEngine(): VideoEngine | null {
    const e = engineCtx.get();
    if (!e) return null;
    try { return e.getDomain<VideoEngine>('video'); } catch { return null; }
  }
  function getExtras(): PeerTubeHandleExtras | null {
    const ve = videoEngine();
    if (!ve) return null;
    try { return (ve.read(id, 'extras') as PeerTubeHandleExtras | undefined) ?? null; } catch { return null; }
  }

  // ---- Synced writes (single transact each; only the small persisted set) ----
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
  function writeSelection(v: PeerTubeVideo | null): void {
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      const d = t.data as Partial<PeerTubeData>;
      d.selectedHost = v?.host ?? null;
      d.uuid = v?.uuid ?? null;
      d.name = v?.name ?? null;
    }, LOCAL_ORIGIN);
  }

  onMount(() => {
    const d = node?.data as Partial<PeerTubeData> | undefined;
    if (d) {
      searchTerm = d.searchTerm ?? '';
      instanceHost = d.instanceHost ?? '';
    }
  });

  // ---- Search (debounced + rate-limited: ~50 calls / 10 s) ----
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
    searchDebounce = setTimeout(() => { void runSearch(); }, 350);
  }
  function onSearchKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (searchDebounce) { clearTimeout(searchDebounce); searchDebounce = null; }
      void runSearch();
    }
  }

  async function runSearch(): Promise<void> {
    if (!rateOk()) {
      errorMsg = 'Slow down — too many searches; try again in a moment.';
      return;
    }
    errorMsg = null;
    loading = true;
    statusMsg = 'Searching the fediverse…';
    writeSearchTerm();
    try {
      const url = buildSearchUrl(searchTerm, { count: 24 });
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`search HTTP ${resp.status}`);
      const json = await resp.json();
      results = parseSearchResponse(json);
      resultIndex = -1;
      statusMsg = null;
      if (results.length === 0) errorMsg = 'No results — try another term.';
    } catch (e) {
      statusMsg = null;
      errorMsg = `Search failed: ${(e as Error)?.message ?? 'unknown error'}`;
    } finally {
      loading = false;
    }
  }

  // ---- Resolve + attach a selected video ----
  async function selectResult(v: PeerTubeVideo, index: number): Promise<void> {
    resultIndex = index;
    writeSelection(v);
    await resolveAndAttach(v.host, v.uuid);
  }

  /** Advance to the next result in the list (wraps); used by the next_trigger
   *  input + the "↻ next" button. */
  function nextResult(): void {
    if (results.length === 0) { void runSearch(); return; }
    const next = (resultIndex + 1 + results.length) % results.length;
    void selectResult(results[next], next);
  }

  async function resolveAndAttach(host: string, vid: string): Promise<void> {
    loading = true;
    errorMsg = null;
    statusMsg = 'Resolving stream…';
    streamState = 'loading';
    try {
      const resp = await fetch(videoDetailsUrl(host, vid));
      if (!resp.ok) throw new Error(`details HTTP ${resp.status}`);
      const stream = resolveStream(await resp.json());
      if (!stream) {
        statusMsg = null;
        markUnavailable('No playable stream for this video.');
        return;
      }
      statusMsg = null;
      attachStream(stream);
    } catch (e) {
      statusMsg = null;
      markUnavailable(`Could not resolve: ${(e as Error)?.message ?? 'network error'}`);
    } finally {
      loading = false;
    }
  }

  // ---- HLS / direct attach (robust: timeout + error/taint → unavailable + skip) ----
  let loadTimeout: ReturnType<typeof setTimeout> | null = null;
  let skipTimer: ReturnType<typeof setTimeout> | null = null;

  function teardownHls(): void {
    if (loadTimeout) { clearTimeout(loadTimeout); loadTimeout = null; }
    try { hls?.destroy(); } catch { /* */ }
    hls = null;
  }

  function markUnavailable(msg?: string): void {
    streamState = 'unavailable';
    if (msg) errorMsg = msg;
    getExtras()?.setPlaying(false);
    isPlaying = false;
    teardownHls();
    // Auto-skip to the next result after a short beat (never hang on a dead /
    // CORS-misconfigured stream). Learned from the archivist/tv-librarian hang.
    if (skipTimer) clearTimeout(skipTimer);
    skipTimer = setTimeout(() => {
      skipTimer = null;
      if (results.length > 1 && streamState === 'unavailable') nextResult();
    }, 1800);
  }

  function attachStream(stream: ResolvedStream): void {
    if (!videoEl) return;
    teardownHls();
    getExtras()?.unwireAudio();
    streamState = 'loading';
    isPlaying = false;
    // Re-mute before each new autoplay attempt (the audio trap): a muted <video>
    // is always allowed to autoplay; we un-mute AFTER the audio tap is wired.
    videoEl.muted = true;
    videoEl.crossOrigin = 'anonymous'; // PeerTube sends ACAO:* → untainted texture

    const onPlaying = (): void => {
      streamState = 'playing';
      isPlaying = true;
      getExtras()?.setPlaying(true);
      ensureAudioWired();
      if (loadTimeout) { clearTimeout(loadTimeout); loadTimeout = null; }
    };

    // 14s hard timeout: a stream that never produces a frame is "unavailable".
    loadTimeout = setTimeout(() => {
      if (streamState !== 'playing') markUnavailable('Stream timed out.');
    }, 14_000);

    if (stream.kind === 'mp4') {
      // Direct progressive file — a plain <video src> (no hls.js needed).
      videoEl.src = stream.url;
      void videoEl.play().catch(() => { /* autoplay blocked → user gesture */ });
    } else if (Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: false });
      hls.on(Hls.Events.MANIFEST_PARSED, () => { void videoEl?.play().catch(() => {}); });
      hls.on(Hls.Events.ERROR, (_e, d) => {
        // Fatal errors (incl. COEP/CORS blocks on a misconfigured instance) →
        // unavailable + auto-skip. Non-fatal errors hls.js recovers from itself.
        if (d?.fatal) markUnavailable('Stream blocked (CORS) or unavailable.');
      });
      hls.loadSource(stream.url);
      hls.attachMedia(videoEl);
    } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS.
      videoEl.src = stream.url;
      void videoEl.play().catch(() => {});
    } else {
      markUnavailable('HLS not supported in this browser.');
      return;
    }
    videoEl.addEventListener('playing', onPlaying, { once: true });
    videoEl.addEventListener('loadeddata', () => {
      if (videoEl && videoEl.readyState >= 2) onPlaying();
    }, { once: true });
  }

  // ---- Audio wiring retry (mirror VIDEOBOX.ensureAudioWired) ----
  let audioWireTimer: ReturnType<typeof setTimeout> | null = null;
  function ensureAudioWired(attempt = 0): void {
    if (audioWireTimer) { clearTimeout(audioWireTimer); audioWireTimer = null; }
    const extras = getExtras();
    extras?.wireAudio();
    if (extras?.isAudioWired()) {
      // THE AUDIO TRAP FIX: the MediaElementSource tap now owns the element's
      // audio, so un-muting routes it into WebAudio (audio_l/audio_r) WITHOUT
      // native speaker output. Mandatory or audio_l/audio_r stay silent.
      if (videoEl) videoEl.muted = false;
      getExtras()?.fireLoaded();
      return;
    }
    if (attempt >= 50) return;
    audioWireTimer = setTimeout(() => ensureAudioWired(attempt + 1), 100);
  }

  // ---- Transport ----
  function togglePlay(): void {
    if (!videoEl) return;
    if (videoEl.paused) {
      void videoEl.play().catch(() => { /* autoplay blocked */ });
    } else {
      try { videoEl.pause(); } catch { /* */ }
    }
  }
  function onVideoPlay(): void { isPlaying = true; getExtras()?.setPlaying(true); }
  function onVideoPause(): void { isPlaying = false; getExtras()?.setPlaying(false); }
  function onVideoEnded(): void {
    isPlaying = false;
    getExtras()?.setPlaying(false);
    getExtras()?.fireEnded();
  }

  // ---- play_trigger / next_trigger input edge detection ----
  // The CV bridge writes the gate level into the synthetic cv_play_trigger /
  // cv_next_trigger params on a rising edge; we read the instantaneous value +
  // detect the edge (a single bridge-written param read can't double-count —
  // that's the AnalyserNode-whole-buffer-rescan bug, NOT this; this is the
  // established video-module convention, same as VIDEOBOX / TV-LIBRARIAN).
  let lastPlay = 0;
  let lastNext = 0;
  let triggerTimer: ReturnType<typeof setInterval> | null = null;
  function startTriggerLoop(): void {
    if (triggerTimer !== null) return;
    triggerTimer = setInterval(() => {
      const e = engineCtx.get();
      if (!e || !node) return;
      const vp = e.readParam(node, 'cv_play_trigger');
      const vn = e.readParam(node, 'cv_next_trigger');
      if (typeof vp === 'number') {
        if (lastPlay < 0.5 && vp >= 0.5) togglePlay();
        lastPlay = vp;
      }
      if (typeof vn === 'number') {
        if (lastNext < 0.5 && vn >= 0.5) nextResult();
        lastNext = vn;
      }
    }, 33);
  }
  function stopTriggerLoop(): void {
    if (triggerTimer !== null) { clearInterval(triggerTimer); triggerTimer = null; }
  }

  // ---- Per-frame display + playhead CV (render-local; never a synced write) ----
  let displayTimer: ReturnType<typeof setInterval> | null = null;
  function refreshDisplay(): void {
    const extras = getExtras();
    if (videoEl && videoEl.duration > 0 && Number.isFinite(videoEl.duration)) {
      displayFrac = Math.min(1, Math.max(0, videoEl.currentTime / videoEl.duration));
      extras?.setPlayhead(displayFrac);
      extras?.setPlaying(!videoEl.paused && !videoEl.ended);
    } else {
      extras?.setPlaying(false);
    }
  }

  // ---- Attach <video> element to the engine module (poll until ready) ----
  onMount(() => {
    let attempts = 0;
    const attach = setInterval(() => {
      attempts++;
      const ve = videoEngine();
      if (ve && videoEl) {
        try {
          ve.attachExternalSource(id, 'video', videoEl);
          if (ve.read(id, 'hasVideoElement') === true) clearInterval(attach);
        } catch { /* not ready */ }
      }
      if (attempts > 50) clearInterval(attach);
    }, 100);
    startTriggerLoop();
    displayTimer = setInterval(refreshDisplay, 100);
  });

  // When a selection is persisted (local pick OR remote peer / reload), resolve +
  // attach its stream locally. Tracks last-attached so we don't re-attach per tick.
  let lastAttached: string | null = null;
  $effect(() => {
    const host = selectedHost;
    const vid = uuid;
    void videoEl; // re-run once the element exists
    if (!host || !vid || !videoEl) return;
    const key = `${host}::${vid}`;
    if (key === lastAttached) return;
    lastAttached = key;
    void resolveAndAttach(host, vid);
  });

  onDestroy(() => {
    stopTriggerLoop();
    if (searchDebounce) clearTimeout(searchDebounce);
    if (audioWireTimer) clearTimeout(audioWireTimer);
    if (skipTimer) clearTimeout(skipTimer);
    if (displayTimer !== null) clearInterval(displayTimer);
    teardownHls();
    const ve = videoEngine();
    try { ve?.attachExternalSource(id, 'video', null); } catch { /* */ }
    getExtras()?.setPlaying(false);
    getExtras()?.unwireAudio();
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
  class="card video peertube-card"
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
            disabled={results.length === 0}
            data-testid="peertube-next"
            title="Load the next result"
          >↻ next</button>
        </div>
      </div>

      <!-- Preview -->
      <div class="preview-wrap" data-testid="peertube-preview">
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          bind:this={videoEl}
          data-testid="peertube-video"
          crossorigin="anonymous"
          muted
          playsinline
          onplay={onVideoPlay}
          onpause={onVideoPause}
          onended={onVideoEnded}
        ></video>
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
        {#each results as v, i (v.host + ':' + v.uuid)}
          <button
            type="button"
            class="result nodrag"
            class:sel={i === resultIndex}
            onclick={() => void selectResult(v, i)}
            data-testid="peertube-result"
            data-uuid={v.uuid}
          >
            {#if v.thumbnailUrl}
              <img class="thumb" src={v.thumbnailUrl} alt="" loading="lazy" />
            {:else}
              <span class="thumb thumb-empty">▶</span>
            {/if}
            <span class="r-meta">
              <span class="r-title">{v.name}</span>
              <span class="r-sub">{v.channel ? v.channel + ' · ' : ''}{v.host}{v.isLive ? ' · LIVE' : ''} · {formatDuration(v.duration)}</span>
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
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 12px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .card.resizing { transition: none; }
  :global(.svelte-flow__node:hover) .card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe {
    position: absolute; top: 0; left: 0; right: 0;
    height: 2px; border-radius: 2px 2px 0 0;
    background: var(--cable-video);
  }

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
  video {
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
