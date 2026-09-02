<script lang="ts">
  // packages/web/src/lib/ui/modules/peertube/PeerTubePicker.svelte
  //
  // THE BROWSE SURFACE, SHARED BY BOTH SURFACES — the search box with its rate
  // limiter, the transport, the attribution anchor, the results roster and the
  // legal disclaimer.
  //
  // ⚠ WHY THIS IS ONE COMPONENT RATHER THAN TWO COPIES. Promotion stops BOTH
  // surfaces rendering `PeerTubeCard.svelte`, so the faceplate needs this
  // surface; `?shell=legacy` still renders the card, so the card needs it too.
  // Two copies of a picker is how the two drift, and THIS MODULE PAIR HAS A
  // DOCUMENTED INSTANCE of correctness travelling by hand-copy and arriving
  // late — the `muted = false` audio trap that tvLibrarian hit one day before
  // peertube shipped (see node-hls-source-registry's header). One component,
  // two mounts, no drift by construction. It is the tvLibrarian/TvLibrarianPicker
  // shape, on the def whose controller is literally the same file.
  //
  // ⚠ WHAT THIS COMPONENT DOES *NOT* OWN: the stream, and not the catalogue
  // either. The `<video>`, its hls.js demuxer, the engine attach, the audio
  // wire + un-mute, the SEARCH FETCH, the selection→stream application and both
  // trigger polls belong to `$lib/ui/media/node-hls-source` on NODE lifetime
  // (LEG-02 P3, #1511). This file forwards user gestures through
  // `nodeHlsSource.request(...)` and renders what the controller publishes.
  //
  // WHAT IT DOES OWN: the RATE LIMIT and the debounce. Both are facts about an
  // input box a human can hold a key down in, not about the node — the same
  // split the card drew, moved rather than duplicated.
  import { onMount, onDestroy } from 'svelte';
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import { nodeHlsSource } from '$lib/ui/media/node-hls-source.svelte';
  import { watchUrl } from '$lib/video/modules/peertube-query';

  interface Props {
    /** The graph node this picker browses for — the id it WRITES against. */
    nodeId: string;
    /**
     * The selected video's home instance, read by WHOEVER MOUNTED THIS.
     *
     * ⚠ THE LEAF, NOT THE `data` OBJECT, AND BOTH HALVES OF THAT ARE MEASURED
     * ON THIS EXACT PAIR OF SURFACES (TvLibrarianPicker's `countryCode` prop
     * carries the long form):
     *
     * (1) It is a PROP rather than a `patch.nodes[nodeId]` read here, because
     *     the LEGACY CARD is mounted by xyflow's `NodeWrapper` from a
     *     `data.node` prop that Canvas rebuilds, and inside THAT subtree the
     *     same `patch` read does not recompute.
     *
     * (2) It is the LEAF rather than the enclosing `data` object because
     *     `patch.nodes[id].data` is a Y-backed proxy whose IDENTITY NEVER
     *     CHANGES: a `$derived` that stops at `.data` has no dependency on
     *     anything inside it and never re-runs. Passing `data` "works" in the
     *     card and silently breaks the body, and the two failures look
     *     identical from outside.
     */
    selectedHost: string | null;
    /** The selected video's uuid — same rule as `selectedHost`. */
    uuid: string | null;
    /** Optional prefix so a caller mounting this beside a second copy can keep
     *  strict locators unambiguous. Unused today (fullViewBody and the legacy
     *  card are never on screen together), and present so the tileBody variant
     *  cannot be added without a testid decision. */
    testidPrefix?: string;
  }
  let { nodeId, selectedHost, uuid, testidPrefix = 'peertube' }: Props = $props();

  // ---- The controller's published status ----
  //
  // Read THROUGH the registry rather than mirrored into local `$state`. There
  // is therefore no moment at which this surface's answer and the node's answer
  // can differ — the stale-mirror bug the pre-#1511 cards all had.
  let src = $derived(nodeHlsSource.view(nodeId));
  let catalogue = $derived(src.catalogue);
  let isPlaying = $derived(src.isPlaying);
  let displayFrac = $derived(src.playheadFrac);
  let loading = $derived(src.loadingCatalogue || src.loadingStream);
  let statusMsg = $derived(src.statusMsg);

  // ---- Picker-local UI state ----
  let searchTerm = $state('');
  let rateMsg = $state<string | null>(null);
  /** This surface's own rate-limit refusal, or the controller's error. */
  let errorMsg = $derived(rateMsg ?? src.error);

  let attributionUrl = $derived<string>(
    selectedHost && uuid ? watchUrl(selectedHost, uuid) : '',
  );

  // ---- The persisted search term ----
  //
  // ⚠ REHYDRATED AT MOUNT, AND THAT IS PARITY RATHER THAN POLISH: `advance()`
  // re-runs the persisted term on demand when the catalogue is empty, so a
  // reloaded rack whose box came up blank would show an empty search box that
  // the ↻ button nevertheless searches with. A one-shot `onMount` read is also
  // the only shape that is correct in BOTH subtrees — it is not a reactive
  // read, so the legacy card's non-reactive `patch` subtree cannot break it.
  onMount(() => {
    const d = patch.nodes[nodeId]?.data as Record<string, unknown> | undefined;
    const t = d?.searchTerm;
    if (typeof t === 'string') searchTerm = t;
  });

  function writeSearchTerm(): void {
    ydoc.transact(() => {
      const t = patch.nodes[nodeId];
      if (!t) return;
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).searchTerm = searchTerm;
    }, LOCAL_ORIGIN);
  }

  // ---- Search (debounced + rate-limited: ~50 calls / 10 s) ----
  //
  // The RATE LIMIT protects Sepia Search from a human holding a key down. The
  // FETCH itself is the controller's — this only decides whether to ask for
  // one, and SAYS SO when it refuses (a silent no-op on a held key is
  // indistinguishable from a broken search box).
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
    nodeHlsSource.request(nodeId, { kind: 'catalogue', key: searchTerm });
  }

  // ---- Gestures ----
  //
  // Each is a USER ACTION that cannot originate anywhere else, handed to the
  // controller through the one seam that reaches it whether or not this surface
  // is the one the user is looking at.
  function selectResult(key: string): void {
    nodeHlsSource.request(nodeId, { kind: 'select', candidateKey: key });
  }
  function nextResult(): void {
    nodeHlsSource.request(nodeId, { kind: 'next' });
  }
  function togglePlay(): void {
    nodeHlsSource.request(nodeId, { kind: 'togglePlay' });
  }

  onDestroy(() => {
    if (searchDebounce) clearTimeout(searchDebounce);
  });
</script>

<div class="pt-picker">
  <!-- Search -->
  <div class="row">
    <input
      class="search-input nodrag"
      type="text"
      placeholder="search the fediverse…"
      bind:value={searchTerm}
      oninput={onSearchInput}
      onkeydown={onSearchKeydown}
      data-testid="{testidPrefix}-search"
      aria-label="Search term"
    />
    <button
      type="button"
      class="next-btn nodrag"
      onclick={nextResult}
      disabled={catalogue.length === 0}
      data-testid="{testidPrefix}-next"
      title="Load the next result"
    >↻ next</button>
  </div>

  {#if uuid}
    <div class="transport">
      <button
        type="button"
        class="play-btn nodrag"
        onclick={togglePlay}
        aria-pressed={isPlaying}
        data-testid="{testidPrefix}-play"
      >{isPlaying ? 'Pause' : 'Play'}</button>
      <div class="bar" data-testid="{testidPrefix}-bar"><div class="fill" style="width: {displayFrac * 100}%"></div></div>
      <!-- ⚠ A NAVIGATIONAL CONTROL, NOT A READOUT, and the only route from a
           playing federated video to the creator's page — it is also the only
           place the instance host is named at all. Kept deliberately under the
           2026-08-17 resting-readout ruling (owner question §5.7 of the wave
           plan; recommended default was KEEP). -->
      {#if attributionUrl}
        <a
          class="watch-link nodrag"
          href={attributionUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="{testidPrefix}-watch-link"
        >{selectedHost}</a>
      {/if}
    </div>
  {/if}

  {#if errorMsg}
    <div class="error" data-testid="{testidPrefix}-error">{errorMsg}</div>
  {/if}
  {#if loading}
    <div class="status" data-testid="{testidPrefix}-status">{statusMsg ?? 'Loading…'}</div>
  {/if}

  <!-- Results -->
  <div class="results" data-testid="{testidPrefix}-results">
    {#each catalogue as c (c.key)}
      <button
        type="button"
        class="result nodrag"
        class:sel={c.key === src.selectionKey}
        onclick={() => selectResult(c.key)}
        data-testid="{testidPrefix}-result"
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

  <!-- ⚠ ATTRIBUTION / POSTURE, kept on BOTH surfaces. This is the one text in
       the fleet whose justification is licensing rather than design, and body
       text is `face-resting-text-source.test.ts`'s stated blind spot — so it
       would ship green either way. Named here, in EXTENSION_BODY_ROLES and in
       strict-faces so a future literal reading of the resting-text ruling does
       not quietly delete a legal obligation. -->
  <div class="disclaimer" data-testid="{testidPrefix}-disclaimer">
    Federated public videos via the <a href="https://joinpeertube.org" target="_blank" rel="noopener noreferrer">PeerTube</a>
    fediverse · search by <a href="https://sepiasearch.org" target="_blank" rel="noopener noreferrer">Sepia Search</a>.
  </div>
</div>

<style>
  .pt-picker {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
    min-height: 0;
  }

  .row { display: flex; gap: 4px; align-items: center; }
  .search-input {
    flex: 1; min-width: 0;
    background: #11151c; color: var(--text); border: 1px solid #404652;
    border-radius: 2px; font-size: 0.7rem; padding: 4px 6px;
  }
  .next-btn {
    background: #2a3340; color: var(--text); border: none; border-radius: 2px;
    padding: 3px 8px; font-size: 0.6rem; cursor: pointer; letter-spacing: 0.03em;
    flex: 0 0 auto;
  }
  .next-btn:disabled { opacity: 0.5; cursor: default; }
  .next-btn:hover:not(:disabled) { filter: brightness(1.2); }

  .transport { display: flex; align-items: center; gap: 6px; }
  .play-btn {
    background: var(--cable-video); color: #000; border: none; border-radius: 2px;
    padding: 3px 10px; font-size: 0.66rem; cursor: pointer; min-width: 52px;
  }
  .play-btn:hover { filter: brightness(1.1); }
  .bar { flex: 1; height: 4px; background: #1a1f2a; border-radius: 2px; overflow: hidden; }
  .fill { height: 100%; background: var(--cable-video); }
  .watch-link {
    color: var(--accent-dim); font-size: 0.55rem; font-family: ui-monospace, monospace;
    text-decoration: none; flex: 0 0 auto; max-width: 45%;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .watch-link:hover { text-decoration: underline; }

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
</style>
