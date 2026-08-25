<script lang="ts">
  // TvLibrarianCard — the SURFACE for an international live-TV source whose
  // lifecycle belongs to the NODE.
  //
  // ⚠ THIS CARD CREATES NOTHING AND DISPOSES NOTHING (LEG-02 P3, #1511). The
  // <video>, its hls.js demuxer, the engine attach, the audio wire + un-mute,
  // the CHANNEL catalogue, the channel→stream application, the next/random
  // trigger poll and the unavailable auto-skip are ALL owned by
  // `$lib/ui/media/node-hls-source-registry` on GRAPH lifetime, created and
  // swept from Canvas's own effects. This file adopts the node's element for
  // display, renders the picker, and forwards user GESTURES through
  // `nodeHlsSource.request(...)`.
  //
  // ⚠ NO `attachExternalSource` ANYWHERE IN THIS FILE — the mechanical fact that
  // takes `tvLibrarian` out of `DOM_SOURCE_LANE_TYPES`, since the grep gate
  // (`dom-source-modules.test.ts`) derives that set by walking each card's
  // component subtree for exactly this call.
  //
  // ⚠ NO `read(id, 'extras')` EITHER: a card that cannot reach the handle cannot
  // tear it down. Its EXTRAS_OWNERS entry went with it.
  //
  // WHAT THIS CARD STILL OWNS, and why: the COUNTRY dataset. The world map and
  // the dropdown are a picker, not engine-visible state — nothing downstream of
  // this module can tell whether the country list ever loaded, and no CV input
  // reaches it. The CHANNEL list is different and moved: `next` and `random` are
  // gate INPUTS, so the thing they advance through has to exist whether or not a
  // card does.
  //
  // FLOW (unchanged for the player): a 2D world map (NO three.js —
  // equirectangular, click → nearest country) OR a country dropdown → the
  // controller's channel list (filtered famelack data) → pick a channel → the
  // controller hands its .m3u8 to hls.js → the engine module (tv-librarian.ts)
  // samples the element into the FBO (video out) + extracts stereo audio
  // (audio_l/audio_r).
  //
  // THE AUDIO TRAP, for the reader who comes looking: the element is created
  // `muted` so the programmatic play() is allowed without a user gesture, and
  // MUST be un-muted after createMediaElementSource succeeds — a muted element
  // feeds SILENCE into its MediaElementAudioSourceNode because the mute gates
  // the audio AT THE SOURCE. That is #tv-librarian-audio, and the step now lives
  // in the controller's `ensureAudioWired` on node lifetime, which is what stops
  // a card unmount mid-retry from stranding the element muted forever.
  //
  // Legal posture: an in-card disclaimer ("third-party public streams, not
  // hosted here") + dataset attribution; geo-blocked channels are MARKED;
  // dead/unavailable streams fail cleanly → auto-skip, never hang.
  import { onMount, onDestroy } from 'svelte';
  import { nodeMedia, type NodeMediaLease } from '$lib/ui/media/node-media-registry';
  import { nodeHlsSource, HLS_SOURCE_SLOT } from '$lib/ui/media/node-hls-source.svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import { startCornerResize } from './card-resize';
  import ModuleTitle from './ModuleTitle.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    tvLibrarianDef,
    type TvLibrarianData,
    type TvChannelMeta,
  } from '$lib/video/modules/tv-librarian';
  import {
    countriesMetadataUrl,
    parseCountriesMetadata,
    languageLabel,
    type CountryMeta,
  } from '$lib/video/modules/tv-librarian-data';
  import { countryMarkers, nearestCountry } from '$lib/video/modules/tv-librarian-geo';
  import { captureFlowStore, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  // Guarded: the dock full-view plain-mounts this card OUTSIDE the
  // SvelteFlow provider, where a bare useStore() throws and killed the
  // card at init (no video in the expanded faceplate). Inside the
  // provider this is byte-identical; outside it's null -> zoom 1.
  const flowStore = captureFlowStore();

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

  // ---- The controller's published status ----
  let src = $derived(nodeHlsSource.view(id));
  let streamState = $derived(src.streamState);
  let channels = $derived(src.catalogue);
  let loadingChannels = $derived(src.loadingCatalogue);

  // ---- Card-local UI state (the PICKER, not the player) ----
  let videoHost: HTMLDivElement | null = $state(null);
  let mediaLease: NodeMediaLease<HTMLElement> | null = null;
  let countries = $state<CountryMeta[]>([]);
  let countryError = $state<string | null>(null);
  let loadingCountries = $state(false);
  let viewMode = $state<'map' | 'list'>('map');
  /** The country dataset's own failure, else the controller's. */
  let datasetError = $derived(countryError ?? src.error);

  let availableCodes = $derived(new Set(countries.map((c) => c.code)));
  let markers = $derived(countryMarkers(availableCodes));

  // ---- Country dataset fetch (runtime, graceful failure) ----
  //
  // Card-lifetime ON PURPOSE — see the header. This is the map's data and
  // nothing engine-visible depends on it.
  async function fetchCountries(): Promise<void> {
    if (countries.length > 0 || loadingCountries) return;
    loadingCountries = true;
    countryError = null;
    try {
      const resp = await fetch(countriesMetadataUrl(), { mode: 'cors' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      countries = parseCountriesMetadata(json);
      if (countries.length === 0) countryError = 'No countries in dataset response.';
    } catch (err) {
      countryError = `Could not load channel list: ${(err as Error)?.message ?? 'network error'}`;
    } finally {
      loadingCountries = false;
    }
  }

  // ---- Synced write (single transact) ----
  function writeCountry(code: string): void {
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      const d = t.data as Partial<TvLibrarianData>;
      d.countryCode = code;
    }, LOCAL_ORIGIN);
  }

  // ---- Country / channel selection ----
  function selectCountry(code: string): void {
    writeCountry(code);
    // The controller would pick this up from `node.data` on the next graph tick
    // anyway (that is what makes a PEER's country change land). Asking directly
    // as well makes the LOCAL pick instant — the difference between a picker
    // that feels wired and one that feels laggy — and cannot double-fetch,
    // because the controller records the key it loaded.
    nodeHlsSource.request(id, { kind: 'catalogue', key: code });
  }

  function selectChannel(key: string): void {
    nodeHlsSource.request(id, { kind: 'select', candidateKey: key });
  }

  function onMapClick(ev: MouseEvent): void {
    const target = ev.currentTarget as HTMLElement;
    const r = target.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width;
    const y = (ev.clientY - r.top) / r.height;
    const code = nearestCountry(x, y, availableCodes);
    if (code) selectCountry(code);
  }

  function pickRandom(): void {
    nodeHlsSource.request(id, { kind: 'random' });
  }
  function pickNext(): void {
    nodeHlsSource.request(id, { kind: 'next' });
  }

  // ---- Adopt the NODE-owned <video> into this card ----
  //
  // ⚠ NO ATTACH CALL AND NO DISPOSER. The element arrives already attached and
  // already carrying its hls teardown: the controller `ensure`s it, attaches it
  // and registers the disposer at NODE creation, long before any card exists.
  // Adoption here is a DOM re-parent for display only, and it is a TRANSFER with
  // an owner-checked release, so the two mounts a collapse straddles cannot
  // fight over the element in either order.
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
    void fetchCountries();
  });

  onDestroy(() => {
    // NOTE what is deliberately ABSENT: no teardownHls, no detach, no
    // unwireAudio, no setStreamOnline(false), no trigger-loop stop. NONE of
    // those exist here any more — they are the controller's, on node lifetime.
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
        <!-- The <video> is NOT declared here: it belongs to the NODE and is
             adopted into this host div (see the $effect above). Declaring it
             in markup is what tied its lifetime to the card. -->
        <div class="video-host" bind:this={videoHost}></div>
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
          onchange={(e) => selectCountry((e.currentTarget as HTMLSelectElement).value)}
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
            {#each channels as c (c.key)}
              <button
                type="button"
                class="chan"
                class:sel={c.key === channel?.nanoid}
                onclick={() => selectChannel(c.key)}
                data-testid="tv-channel"
                data-nanoid={c.key}
              >
                <span class="chan-name">{c.label}</span>
                {#if c.badge === 'geo'}<span class="badge geo" title="May be geo-blocked in your region">geo</span>{/if}
                {#if c.sublabel}<span class="chan-lang">{c.sublabel}</span>{/if}
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
