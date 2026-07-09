<script lang="ts">
  // TvLibrarianCard — international live-TV source.
  //
  // FLOW: a 2D world map (NO three.js — equirectangular, click → nearest
  // country) OR a country dropdown → a channel list (filtered famelack data) →
  // pick a channel → hls.js attaches its .m3u8 to a card-owned
  // <video crossorigin=anonymous> → the engine module (tv-librarian.ts) samples
  // it into the FBO (video out) + extracts stereo audio (audio_l/audio_r).
  //
  // Phase-0 spike (validated under the real /r/ COEP require-corp headers):
  // famelack HLS plays + yields an UNTAINTED WebGL2 texture (6/6 streams). So
  // `video` out is a real downstream-usable texture, not play-only.
  //
  // Multiplayer: the selected countryCode + channel (incl. name + url) live on
  // node.data so all rack-mates tune to the SAME stream. Transient playback
  // state (loading/error/hls instance) stays render-local (never written to the
  // synced store — the per-frame-write storm lesson).
  //
  // Legal posture: an in-card disclaimer ("third-party public streams, not
  // hosted here") + dataset attribution; geo-blocked channels are MARKED;
  // dead/unavailable streams fail cleanly → auto-skip, never hang.
  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps, useStore } from '@xyflow/svelte';
  import Hls from 'hls.js';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import { startCornerResize } from './card-resize';
  import ModuleTitle from './ModuleTitle.svelte';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    tvLibrarianDef,
    type TvLibrarianHandleExtras,
    type TvLibrarianData,
    type TvChannelMeta,
  } from '$lib/video/modules/tv-librarian';
  import {
    countriesMetadataUrl,
    countryChannelsUrl,
    parseCountriesMetadata,
    parseChannels,
    filterChannels,
    nextChannel,
    randomChannel,
    languageLabel,
    type CountryMeta,
    type Channel,
  } from '$lib/video/modules/tv-librarian-data';
  import { countryMarkers, nearestCountry } from '$lib/video/modules/tv-librarian-geo';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  const flowStore = useStore();

  // ---- Resize (mirror VIDEOBOX: user-resizable, 180-multiple defaults) ----
  const DEFAULT_WIDTH = 360;
  const DEFAULT_HEIGHT = 540;
  const MIN_WIDTH = 360;
  const MIN_HEIGHT = 360;
  let cardWidth = $derived<number>((node?.data?.width as number | undefined) ?? DEFAULT_WIDTH);
  let cardHeight = $derived<number>((node?.data?.height as number | undefined) ?? DEFAULT_HEIGHT);

  // ---- Persisted (synced) reads ----
  let countryCode = $derived<string | null>(
    (node?.data as Partial<TvLibrarianData> | undefined)?.countryCode ?? null,
  );
  let channel = $derived<TvChannelMeta | null>(
    (node?.data as Partial<TvLibrarianData> | undefined)?.channel ?? null,
  );

  // ---- Render-local (transient) state ----
  let videoEl: HTMLVideoElement | null = $state(null);
  let hls: Hls | null = null;
  let countries = $state<CountryMeta[]>([]);
  let channels = $state<Channel[]>([]);       // filtered, playable
  let datasetError = $state<string | null>(null);
  let loadingCountries = $state(false);
  let loadingChannels = $state(false);
  let streamState = $state<'idle' | 'loading' | 'playing' | 'unavailable'>('idle');
  let viewMode = $state<'map' | 'list'>('map');

  let availableCodes = $derived(new Set(countries.map((c) => c.code)));
  let markers = $derived(countryMarkers(availableCodes));

  // ---- Engine extras helper ----
  function getExtras(): TvLibrarianHandleExtras | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      const ve = e.getDomain<VideoEngine>('video');
      return (ve.read(id, 'extras') as TvLibrarianHandleExtras | undefined) ?? null;
    } catch {
      return null;
    }
  }
  function videoEngine(): VideoEngine | null {
    const e = engineCtx.get();
    if (!e) return null;
    try { return e.getDomain<VideoEngine>('video'); } catch { return null; }
  }

  // ---- Dataset fetch (runtime, graceful failure) ----
  async function fetchCountries(): Promise<void> {
    if (countries.length > 0 || loadingCountries) return;
    loadingCountries = true;
    datasetError = null;
    try {
      const resp = await fetch(countriesMetadataUrl(), { mode: 'cors' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      countries = parseCountriesMetadata(json);
      if (countries.length === 0) datasetError = 'No countries in dataset response.';
    } catch (err) {
      datasetError = `Could not load channel list: ${(err as Error)?.message ?? 'network error'}`;
    } finally {
      loadingCountries = false;
    }
  }

  async function fetchChannels(code: string): Promise<void> {
    loadingChannels = true;
    datasetError = null;
    channels = [];
    try {
      const resp = await fetch(countryChannelsUrl(code), { mode: 'cors' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      // Keep geo-blocked (marked in UI), drop youtube-only (no clean texture).
      channels = filterChannels(parseChannels(json), { requirePlayable: true });
    } catch (err) {
      datasetError = `Could not load channels: ${(err as Error)?.message ?? 'network error'}`;
    } finally {
      loadingChannels = false;
    }
  }

  // ---- Synced writes (single transact) ----
  function writeCountry(code: string): void {
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      const d = t.data as Partial<TvLibrarianData>;
      d.countryCode = code;
    }, LOCAL_ORIGIN);
  }

  function writeChannel(c: Channel): void {
    const meta: TvChannelMeta = {
      nanoid: c.nanoid,
      name: c.name,
      streamUrl: c.streamUrl ?? '',
      country: c.country,
      languages: c.languages,
    };
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      const d = t.data as Partial<TvLibrarianData>;
      d.channel = meta;
    }, LOCAL_ORIGIN);
  }

  // ---- Country / channel selection ----
  async function selectCountry(code: string): Promise<void> {
    writeCountry(code);
    await fetchChannels(code);
  }

  function selectChannel(c: Channel): void {
    if (!c.streamUrl) return;
    writeChannel(c);
    // pulse the channel_changed trigger output.
    getExtras()?.pulseChannelChanged();
    attachStream(c.streamUrl);
  }

  function onMapClick(ev: MouseEvent): void {
    const target = ev.currentTarget as HTMLElement;
    const r = target.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width;
    const y = (ev.clientY - r.top) / r.height;
    const code = nearestCountry(x, y, availableCodes);
    if (code) void selectCountry(code);
  }

  function pickRandom(): void {
    if (channels.length === 0) return;
    const c = randomChannel(channels, channel?.nanoid ?? null);
    if (c) selectChannel(c);
  }
  function pickNext(): void {
    if (channels.length === 0) return;
    const c = nextChannel(channels, channel?.nanoid ?? null);
    if (c) selectChannel(c);
  }

  // ---- HLS attach (robust: timeout + error → unavailable + auto-skip) ----
  let unavailableSkipTimer: ReturnType<typeof setTimeout> | null = null;
  let loadTimeout: ReturnType<typeof setTimeout> | null = null;

  function teardownHls(): void {
    if (loadTimeout) { clearTimeout(loadTimeout); loadTimeout = null; }
    try { hls?.destroy(); } catch { /* */ }
    hls = null;
  }

  function markUnavailable(): void {
    streamState = 'unavailable';
    getExtras()?.setStreamOnline(false);
    teardownHls();
    // Auto-skip to the next channel after a short beat (never hang on a dead
    // stream). Learned from the archivist hang bug.
    if (unavailableSkipTimer) clearTimeout(unavailableSkipTimer);
    unavailableSkipTimer = setTimeout(() => {
      unavailableSkipTimer = null;
      if (channels.length > 1 && streamState === 'unavailable') pickNext();
    }, 1800);
  }

  function attachStream(url: string): void {
    if (!videoEl || !url) return;
    teardownHls();
    if (unavailableSkipTimer) { clearTimeout(unavailableSkipTimer); unavailableSkipTimer = null; }
    streamState = 'loading';
    getExtras()?.setStreamOnline(false);
    getExtras()?.unwireAudio();
    // Re-mute for THIS stream's autoplay attempt. The programmatic play() below
    // (on channel select / remote tune — no user gesture) is only allowed on a
    // muted element; ensureAudioWired() un-mutes again once the audio is routed
    // into Web Audio (see the comment there). On a channel SWAP the previous
    // stream left the element un-muted, so without this the new play() would be
    // autoplay-blocked.
    if (videoEl) videoEl.muted = true;

    const onPlaying = (): void => {
      streamState = 'playing';
      getExtras()?.setStreamOnline(true);
      ensureAudioWired();
      if (loadTimeout) { clearTimeout(loadTimeout); loadTimeout = null; }
    };

    // 12s hard timeout: a stream that never produces a frame is "unavailable".
    if (loadTimeout) clearTimeout(loadTimeout);
    loadTimeout = setTimeout(() => {
      if (streamState !== 'playing') markUnavailable();
    }, 12000);

    if (Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: false });
      hls.on(Hls.Events.MANIFEST_PARSED, () => { void videoEl?.play().catch(() => {}); });
      hls.on(Hls.Events.ERROR, (_e, d) => {
        // Fatal errors (incl. COEP/CORS blocks → fragLoadError code 0) →
        // unavailable. Non-fatal errors hls.js recovers from on its own.
        if (d?.fatal) markUnavailable();
      });
      hls.loadSource(url);
      hls.attachMedia(videoEl);
    } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS.
      videoEl.src = url;
      void videoEl.play().catch(() => {});
    } else {
      markUnavailable();
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
      // CRITICAL: the <video> is created `muted` so the programmatic play()
      // satisfies the autoplay policy (an UNmuted auto-play() without a user
      // gesture is rejected → stream never starts). But a MUTED media element
      // feeds SILENCE into its MediaElementAudioSourceNode — the mute gates the
      // audio AT THE SOURCE, upstream of the Web Audio tap — so audio_l/audio_r
      // would carry zero even with the splitter correctly wired. Now that
      // wireAudio() has succeeded, createMediaElementSource has redirected the
      // element's audio INTO the Web Audio graph (its native speaker output is
      // disconnected), so un-muting un-gates the tap WITHOUT playing through the
      // speaker. This is the exact `videoEl.muted = false` step VIDEOBOX does
      // after load — TV LIBRARIAN was missing it, which is why the tuned
      // stream's audio never reached the outputs. (#tv-librarian-audio)
      if (videoEl) videoEl.muted = false;
      return;
    }
    if (attempt >= 50) return;
    audioWireTimer = setTimeout(() => ensureAudioWired(attempt + 1), 100);
  }

  // ---- next / random trigger-input polling (mirror VIDEOBOX play_trigger) ----
  // The CV bridge writes the gate level into the synthetic cv_next / cv_random
  // params on a rising edge; we read the instantaneous value + detect the edge.
  // (Reading a single bridge-written param value can't double-count — that's an
  // AnalyserNode-rescan bug; this is the established video-module convention.)
  let lastNext = 0;
  let lastRandom = 0;
  let triggerTimer: ReturnType<typeof setInterval> | null = null;
  function startTriggerLoop(): void {
    if (triggerTimer !== null) return;
    triggerTimer = setInterval(() => {
      const e = engineCtx.get();
      if (!e || !node) return;
      const vn = e.readParam(node, 'cv_next');
      const vr = e.readParam(node, 'cv_random');
      if (typeof vn === 'number') {
        if (lastNext < 0.5 && vn >= 0.5) pickNext();
        lastNext = vn;
      }
      if (typeof vr === 'number') {
        if (lastRandom < 0.5 && vr >= 0.5) pickRandom();
        lastRandom = vr;
      }
    }, 33);
  }
  function stopTriggerLoop(): void {
    if (triggerTimer !== null) { clearInterval(triggerTimer); triggerTimer = null; }
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
    void fetchCountries();
  });

  // When a country is already selected (patch load / remote peer), load its
  // channels once countries are available. Tracks last-loaded to avoid refetch.
  let lastLoadedCountry: string | null = null;
  $effect(() => {
    const code = countryCode;
    if (!code) return;
    if (code === lastLoadedCountry) return;
    lastLoadedCountry = code;
    void fetchChannels(code);
  });

  // When the persisted channel changes (local pick OR remote peer), attach its
  // stream locally. Tracks last-attached url so we don't re-attach on every tick.
  let lastAttachedUrl: string | null = null;
  $effect(() => {
    const url = channel?.streamUrl ?? null;
    void videoEl; // re-run once the element exists
    if (!url || !videoEl) return;
    if (url === lastAttachedUrl) return;
    lastAttachedUrl = url;
    attachStream(url);
  });

  onDestroy(() => {
    stopTriggerLoop();
    if (audioWireTimer) clearTimeout(audioWireTimer);
    if (unavailableSkipTimer) clearTimeout(unavailableSkipTimer);
    teardownHls();
    const ve = videoEngine();
    try { ve?.attachExternalSource(id, 'video', null); } catch { /* */ }
    getExtras()?.setStreamOnline(false);
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

  let countryName = $derived(countries.find((c) => c.code === countryCode)?.name ?? countryCode ?? '');

  const inputs = portsFromDef(tvLibrarianDef.inputs);
  const outputs = portsFromDef(tvLibrarianDef.outputs);
</script>

<div
  class="vcard card video tv-librarian-card"
  class:resizing
  style="width: {cardWidth}px; height: {cardHeight}px;"
  data-testid="tv-librarian-card"
  data-country={countryCode}
  data-stream-state={streamState}
  role="region"
  aria-label="TV LIBRARIAN"
>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="TV LIBRARIAN" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <!-- Preview -->
      <div class="preview-wrap" data-testid="tv-preview">
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          bind:this={videoEl}
          data-testid="tv-video"
          crossorigin="anonymous"
          muted
          playsinline
        ></video>
        {#if streamState === 'loading'}
          <div class="overlay" data-testid="tv-loading">tuning…</div>
        {:else if streamState === 'unavailable'}
          <div class="overlay err" data-testid="tv-unavailable">stream unavailable — skipping</div>
        {:else if !channel}
          <div class="overlay" data-testid="tv-empty">pick a country, then a channel</div>
        {/if}
      </div>

      {#if channel}
        <div class="now-playing" data-testid="tv-now-playing" title={channel.name}>
          <span class="np-name">{channel.name}</span>
          {#if languageLabel(channel.languages)}<span class="np-lang">{languageLabel(channel.languages)}</span>{/if}
        </div>
      {/if}

      <!-- Picker: map / list toggle -->
      <div class="picker-head">
        <div class="seg">
          <button type="button" class:active={viewMode === 'map'} onclick={() => (viewMode = 'map')} data-testid="tv-view-map">map</button>
          <button type="button" class:active={viewMode === 'list'} onclick={() => (viewMode = 'list')} data-testid="tv-view-list">list</button>
        </div>
        <button type="button" class="rnd-btn" onclick={pickRandom} disabled={channels.length === 0} data-testid="tv-random">random</button>
      </div>

      {#if datasetError}
        <div class="error" data-testid="tv-error">{datasetError}</div>
      {/if}

      {#if viewMode === 'map'}
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="map" onclick={onMapClick} data-testid="tv-map" role="presentation">
          <div class="map-grid"></div>
          {#each markers as m (m.code)}
            <span
              class="marker"
              class:sel={m.code === countryCode}
              style="left: {m.x * 100}%; top: {m.y * 100}%;"
              title={m.code}
              data-country={m.code}
            ></span>
          {/each}
          {#if loadingCountries}<div class="map-hint">loading map…</div>{/if}
        </div>
      {:else}
        <select
          class="country-select"
          value={countryCode ?? ''}
          onchange={(e) => void selectCountry((e.currentTarget as HTMLSelectElement).value)}
          data-testid="tv-country-select"
        >
          <option value="" disabled>— country —</option>
          {#each countries as c (c.code)}
            <option value={c.code}>{c.name} ({c.channelCount})</option>
          {/each}
        </select>
      {/if}

      {#if countryCode}
        <div class="chan-head">
          <span class="chan-country">{countryName}</span>
          <button type="button" class="next-btn" onclick={pickNext} disabled={channels.length === 0} data-testid="tv-next">next ▸</button>
        </div>
        <div class="channels" data-testid="tv-channels">
          {#if loadingChannels}
            <div class="muted">loading channels…</div>
          {:else if channels.length === 0}
            <div class="muted">no playable channels</div>
          {:else}
            {#each channels as c (c.nanoid)}
              <button
                type="button"
                class="chan"
                class:sel={c.nanoid === channel?.nanoid}
                onclick={() => selectChannel(c)}
                data-testid="tv-channel"
                data-nanoid={c.nanoid}
              >
                <span class="chan-name">{c.name}</span>
                {#if c.isGeoBlocked}<span class="badge geo" title="May be geo-blocked in your region">geo</span>{/if}
                {#if languageLabel(c.languages)}<span class="chan-lang">{languageLabel(c.languages)}</span>{/if}
              </button>
            {/each}
          {/if}
        </div>
      {/if}

      <!-- Legal disclaimer (tasteful, required). -->
      <div class="disclaimer" data-testid="tv-disclaimer">
        Third-party public streams — not hosted by patchtogether.
        Data via <a href="https://famelack.com" target="_blank" rel="noopener noreferrer">Famelack</a>
        · <a href="https://github.com/iptv-org/iptv" target="_blank" rel="noopener noreferrer">iptv-org</a>.
      </div>
    </div>
  </PatchPanel>

  <div
    class="resize-handle nodrag"
    role="separator"
    aria-label="Resize TV LIBRARIAN"
    data-testid="tv-resize-handle"
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

  .now-playing {
    display: flex; align-items: baseline; gap: 6px;
    font-size: 0.7rem;
    overflow: hidden;
  }
  .np-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .np-lang { color: var(--text-dim); font-size: 0.55rem; font-family: ui-monospace, monospace; }

  .picker-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 3px; overflow: hidden; }
  .seg button {
    background: transparent; color: var(--text-dim); border: none;
    padding: 2px 8px; font-size: 0.6rem; cursor: pointer;
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  .seg button.active { background: var(--cable-video); color: #000; }
  .rnd-btn, .next-btn {
    background: var(--cable-video); color: #000; border: none;
    border-radius: 2px; padding: 2px 8px; font-size: 0.6rem; cursor: pointer;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .rnd-btn:disabled, .next-btn:disabled { opacity: 0.4; cursor: default; }

  .map {
    position: relative;
    aspect-ratio: 2 / 1;
    background: linear-gradient(180deg, #0a1420, #0b1a16);
    border: 1px solid var(--border);
    border-radius: 2px;
    overflow: hidden;
    cursor: crosshair;
    flex: 0 0 auto;
  }
  .map-grid {
    position: absolute; inset: 0;
    background-image:
      linear-gradient(rgba(80, 200, 180, 0.08) 1px, transparent 1px),
      linear-gradient(90deg, rgba(80, 200, 180, 0.08) 1px, transparent 1px);
    background-size: 8.33% 16.66%;
  }
  .marker {
    position: absolute;
    width: 5px; height: 5px;
    margin-left: -2.5px; margin-top: -2.5px;
    border-radius: 50%;
    background: var(--cable-video);
    opacity: 0.55;
    pointer-events: none;
  }
  .marker.sel { opacity: 1; box-shadow: 0 0 0 2px rgba(255,255,255,0.5); width: 7px; height: 7px; margin-left: -3.5px; margin-top: -3.5px; }
  .map-hint {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    font-size: 0.6rem; color: var(--text-dim); font-family: ui-monospace, monospace;
  }

  .country-select {
    width: 100%;
    background: #11161f; color: var(--text);
    border: 1px solid var(--border); border-radius: 2px;
    padding: 3px 6px; font-size: 0.7rem;
  }

  .chan-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .chan-country { font-size: 0.65rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; }

  .channels {
    flex: 1; min-height: 0;
    overflow-y: auto;
    display: flex; flex-direction: column; gap: 1px;
    border: 1px solid var(--border); border-radius: 2px;
    padding: 2px;
  }
  .chan {
    display: flex; align-items: center; gap: 6px;
    background: transparent; color: var(--text);
    border: none; border-radius: 2px;
    padding: 3px 6px; font-size: 0.66rem; cursor: pointer;
    text-align: left; width: 100%;
  }
  .chan:hover { background: rgba(0, 240, 255, 0.08); }
  .chan.sel { background: rgba(0, 240, 255, 0.16); }
  .chan-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chan-lang { color: var(--text-dim); font-size: 0.5rem; font-family: ui-monospace, monospace; }
  .badge.geo {
    font-size: 0.45rem; text-transform: uppercase; letter-spacing: 0.04em;
    background: #6b3b12; color: #ffcf9e; padding: 1px 3px; border-radius: 2px;
  }
  .muted { color: var(--text-dim); font-size: 0.62rem; padding: 4px; font-family: ui-monospace, monospace; }

  .error { font-size: 0.6rem; color: #ff8c6b; font-family: ui-monospace, monospace; }

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
