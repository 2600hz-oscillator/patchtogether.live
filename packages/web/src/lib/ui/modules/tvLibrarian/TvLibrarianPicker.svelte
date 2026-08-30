<script lang="ts">
  // packages/web/src/lib/ui/modules/tvLibrarian/TvLibrarianPicker.svelte
  //
  // THE BROWSE SURFACE, SHARED BY BOTH SURFACES — the map/list toggle, the world
  // map, the country dropdown, the channel roster and the two navigation
  // gestures, plus the legal disclaimer.
  //
  // ⚠ WHY THIS IS ONE COMPONENT RATHER THAN TWO COPIES. Promotion stops BOTH
  // surfaces rendering `TvLibrarianCard.svelte`, so the faceplate needs this
  // surface; `?shell=legacy` still renders the card, so the card needs it too.
  // Two copies of a picker is how the two drift, and this module already has a
  // documented instance of correctness travelling by hand-copy and arriving late
  // (the `muted = false` audio trap — see node-hls-source-registry's header).
  // One component, two mounts, no drift by construction.
  //
  // ⚠ WHAT THIS COMPONENT DOES *NOT* OWN: the stream. The `<video>`, its hls.js
  // demuxer, the engine attach, the audio wire, the CHANNEL catalogue and the
  // next/random trigger loop all belong to `$lib/ui/media/node-hls-source` on
  // NODE lifetime (LEG-02 P3, #1511). This file forwards user gestures through
  // `nodeHlsSource.request(...)` and renders what the controller publishes.
  //
  // WHAT IT DOES OWN: the COUNTRY dataset. That is picker data — nothing
  // downstream of this module can tell whether the country list ever loaded, and
  // no CV input reaches it — so it is fetched on THIS component's lifetime, and
  // a rack with no surface mounted correctly never fetches it.
  import { onMount } from 'svelte';
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import { nodeHlsSource } from '$lib/ui/media/node-hls-source.svelte';
  import type { TvLibrarianData, TvChannelMeta } from '$lib/video/modules/tv-librarian';
  import {
    countriesMetadataUrl,
    parseCountriesMetadata,
    type CountryMeta,
  } from '$lib/video/modules/tv-librarian-data';
  import { countryMarkers, nearestCountry } from '$lib/video/modules/tv-librarian-geo';

  interface Props {
    /** The graph node this picker browses for — the id it WRITES against. */
    nodeId: string;
    /**
     * The node's selected country code, read by WHOEVER MOUNTED THIS.
     *
     * ⚠ THE LEAF, NOT THE `data` OBJECT, AND BOTH HALVES OF THAT ARE MEASURED.
     *
     * (1) It is a PROP rather than a `patch.nodes[nodeId]` read here, because the
     *     LEGACY CARD is mounted by xyflow's `NodeWrapper` from a `data.node`
     *     prop that Canvas rebuilds, and inside THAT subtree the same `patch`
     *     read did not recompute: choosing a country wrote `US` into the graph,
     *     the card's own `data-country` attribute updated from its prop, and this
     *     component's `{#if countryCode}` stayed false — so the channel roster
     *     never appeared. Only the caller knows what is reactive where it stands.
     *
     * (2) It is the LEAF rather than the enclosing `data` object because passing
     *     the object reintroduces the bug one level up. `patch.nodes[id].data` is
     *     a Y-backed proxy whose IDENTITY NEVER CHANGES, so a `$derived` that
     *     stops at `.data` has no dependency on anything inside it and never
     *     re-runs. Passing `data` "worked" in the card and silently broke the
     *     face body — the two failures look identical from the outside and have
     *     opposite-looking causes.
     */
    countryCode: string | null;
    /** The tuned station, same rule as `countryCode` — the LEAF, from the
     *  caller's own reactive source. */
    channel: TvChannelMeta | null;
  }
  let { nodeId, countryCode, channel }: Props = $props();

  // ---- The controller's published status ----
  let src = $derived(nodeHlsSource.view(nodeId));
  let channels = $derived(src.catalogue);
  let loadingChannels = $derived(src.loadingCatalogue);

  // ---- Picker-local UI state ----
  let countries = $state<CountryMeta[]>([]);
  let countryError = $state<string | null>(null);
  let loadingCountries = $state(false);
  let viewMode = $state<'map' | 'list'>('map');
  /** The country dataset's own failure, else the controller's. */
  let datasetError = $derived(countryError ?? src.error);

  let availableCodes = $derived(new Set(countries.map((c) => c.code)));
  let markers = $derived(countryMarkers(availableCodes));
  let countryName = $derived(
    countries.find((c) => c.code === countryCode)?.name ?? countryCode ?? '',
  );

  // ── THE DETERMINISM SEAM, AND WHY THERE IS ONLY ONE ──────────────────────
  //
  // ⚠ THE PICTURE NEEDS NO PIN AT ALL, which is worth stating because the build
  // spec prescribed two. `tv-librarian.ts`'s idle branch is
  // `vec4(0.05, 0.05, 0.09 + vUv.y * 0.05, 1.0)` — no clock, no accumulator, no
  // uniform that is not a param — so with nothing tuned the module's output is
  // already a pure function of position and is identical across boots, renderers
  // and frame counts. Checked at the shader rather than assumed.
  //
  // THE ROSTER IS THE ONE NON-DETERMINISM, and only half of it is the obvious
  // half. A VRT runner cannot reach famelack, so `fetch` REJECTS and the catch
  // below paints `Could not load channel list: <message>` — and that message is
  // the ENVIRONMENT's, not ours, so the dock baseline would be a function of
  // which browser build refused the request. The pin replaces the fetch with a
  // fixed two-country dataset, so the map's markers, the dropdown's options and
  // the absence of an error line are all fixed.
  //
  // ⚠ A PAGE GLOBAL IS WHAT REACHES THIS FILE: `simPin` installs globals with
  // `addInitScript` before `goto`, and this is a main-thread Svelte component,
  // so it reads them at mount. The `__loopbackTestFrame` / `__camerainputTestFrame`
  // shape, and it is e2e-only — no e2e file is in the WebGL attest basis, and
  // neither is this component.
  const TEST_COUNTRIES: readonly CountryMeta[] = [
    { code: 'US', name: 'United States', channelCount: 2 },
    { code: 'FR', name: 'France', channelCount: 1 },
  ];

  function pinnedCountries(): CountryMeta[] | null {
    const pin = (globalThis as { __tvLibrarianTestCountries?: unknown }).__tvLibrarianTestCountries;
    return pin ? [...TEST_COUNTRIES] : null;
  }

  async function fetchCountries(): Promise<void> {
    if (countries.length > 0 || loadingCountries) return;
    const pinned = pinnedCountries();
    if (pinned) { countries = pinned; return; }
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

  function writeCountry(code: string): void {
    ydoc.transact(() => {
      const t = patch.nodes[nodeId];
      if (!t) return;
      if (!t.data) t.data = {};
      (t.data as Partial<TvLibrarianData>).countryCode = code;
    }, LOCAL_ORIGIN);
  }

  function selectCountry(code: string): void {
    writeCountry(code);
    // The controller would pick this up from `node.data` on the next graph tick
    // anyway (that is what makes a PEER's country change land). Asking directly
    // as well makes the LOCAL pick instant, and cannot double-fetch because the
    // controller records the key it loaded.
    nodeHlsSource.request(nodeId, { kind: 'catalogue', key: code });
  }

  function selectChannel(key: string): void {
    nodeHlsSource.request(nodeId, { kind: 'select', candidateKey: key });
  }

  function onMapClick(ev: MouseEvent): void {
    const target = ev.currentTarget as HTMLElement;
    const r = target.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width;
    const y = (ev.clientY - r.top) / r.height;
    const code = nearestCountry(x, y, availableCodes);
    if (code) selectCountry(code);
  }

  function pickRandom(): void { nodeHlsSource.request(nodeId, { kind: 'random' }); }
  function pickNext(): void { nodeHlsSource.request(nodeId, { kind: 'next' }); }

  // ── THE SELECTED ROW IS SCROLLED INTO VIEW ON TUNE ────────────────────────
  //
  // ⚠ THIS IS WHAT MAKES REMOVING THE NOW-PLAYING READOUT SAFE, so it is not a
  // nicety. The highlighted row is now the ONLY painted answer to "which station
  // is this?" — the derived readout that used to sit beside the picture is gone
  // under the 2026-08-17 ruling, and it lives on the picture's accessible name.
  // A highlight the player has to scroll to find is not an answer, so a tune
  // brings its own row into view. `block: 'nearest'` so an already-visible row
  // does not jump.
  let listEl: HTMLDivElement | null = $state(null);
  $effect(() => {
    const key = channel?.nanoid;
    const root = listEl;
    if (!key || !root) return;
    const row = root.querySelector<HTMLElement>(`[data-nanoid="${CSS.escape(key)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  });

  onMount(() => { void fetchCountries(); });
</script>

<div class="tv-picker">
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
    <div class="channels" bind:this={listEl} data-testid="tv-channels">
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

  <!-- ⚠ THE LEGAL DISCLAIMER AND THE DATASET ATTRIBUTION, KEPT VERBATIM ON BOTH
       SURFACES. It is the one text here whose justification is legal rather than
       design: the famelack / iptv-org dataset licence requires the attribution,
       and the streams are third-party. No permitted resting-text role covers it,
       and body text is `face-resting-text-source.test.ts`'s stated blind spot,
       so it would ship green either way — which is exactly why it is called out
       here rather than left to be quietly deleted by a future literal reading of
       the ruling. Routed to the owner as a cohort question (peertube carries the
       same shape). -->
  <div class="disclaimer" data-testid="tv-disclaimer">
    Third-party public streams — not hosted by patchtogether.
    Data via <a href="https://famelack.com" target="_blank" rel="noopener noreferrer">Famelack</a>
    · <a href="https://github.com/iptv-org/iptv" target="_blank" rel="noopener noreferrer">iptv-org</a>.
  </div>
</div>

<style>
  .tv-picker {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
    min-height: 0;
  }

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
</style>
