<script lang="ts">
  // packages/web/src/lib/ui/modules/archivist/ArchivistBrowseControls.svelte
  //
  // THE ARCHIVIST BROWSE + TRANSPORT SURFACE — the search this module IS, and
  // the transport for whatever it found. ONE component, TWO mounts: the dock
  // `fullViewBody` and the lane `tileBody`.
  //
  // ⚠ WHY ONE COMPONENT RATHER THAN A CARD COPY AND A FACE COPY. The pair would
  // have to agree about the year-bound parse, the disabled rules on ↻ next, the
  // seek clamp and which of `searchTerm`/`mediaType` is authoritative — and this
  // module has a documented case of exactly that drift: `updateDuration`'s
  // comment records the seek `max` and the duration readout sitting at 0 after
  // metadata loaded, because one surface mutated a nested Y value in place and
  // the other never re-read it. A shared component makes no-drift structural
  // rather than a convention, which is the property `PeerTubePicker` was
  // introduced for on the neighbouring module.
  //
  // ⚠ IT IS NOT A SECOND OWNER, AND THAT IS THE WHOLE DESIGN. `archivist` is in
  // `DOM_SOURCE_LANE_TYPES`: its three media elements, the fetch/parse/
  // best-file-pick chain, the engine attach and the audio wire belong to
  // `ArchivistCard.svelte`, which promotion parks in `<HeadlessSourceHost>` at
  // `left:-9999px` with `pointer-events: none` — MOUNTED, so the item keeps
  // playing, but unclickable. This surface READS the card's published status
  // and INVOKES its registered commands through
  // `$lib/ui/media/archivist-status-registry`. It fetches nothing, touches no
  // element and calls no engine method.
  //
  // ⚠ THE SEARCH INPUTS ARE LOCAL `$state` REHYDRATED ONCE AT MOUNT, NOT A
  // REACTIVE `patch` READ. The shape was forced by a mount whose subtree did
  // not make `patch.nodes[…]` reads reactive; that mount is gone, and the shape
  // is KEPT because a one-shot `onMount` read is correct in BOTH
  // subtrees, which is the same argument `PeerTubePicker` records for its own
  // search box. Everything DERIVED FROM THE ITEM arrives as a LEAF PROP instead
  // — never the `data` object, whose SyncedStore proxy has a stable identity a
  // value-equal `$derived` would never re-run on.
  import { onMount } from 'svelte';
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import {
    archivistStatus,
    ARCHIVIST_STATUS_IDLE,
    ARCHIVIST_MEDIA_TYPES,
    type ArchivistStatus,
  } from '$lib/ui/media/archivist-status-registry';
  import type { ArchivistMediaType } from '$lib/video/modules/archivist-query';
  import { formatTime, SKIP_STEP_S, clampSeek } from '$lib/video/modules/archivist-scrub';
  import StatusLed from '$lib/ui/controls/StatusLed.svelte';

  interface Props {
    /** The graph node these controls drive. */
    nodeId: string;
    /**
     * LEAF PROPS, never the `data` object — see the header. Each surface
     * derives these its own way (the card from its reactive xyflow `data.node`
     * prop, the faceplate bodies from `patch.nodes[id]`), which is precisely
     * why they cannot be read here.
     */
    hasItem: boolean;
    itemTitle: string | null;
    itemType: Exclude<ArchivistMediaType, 'any'> | null;
    durationSec: number;
    isPlaying: boolean;
    cleanOutput: boolean;
    detailsUrl: string;
    /** COMPACT drops the year bounds and the attribution row — the lane tile is
     *  192 px and cannot hold them. It never drops a control that is the ONLY
     *  route to something (search, ↻ next and the transport all stay). */
    compact?: boolean;
    /** Distinguishes the three mounts' testids; the card keeps the historical
     *  `archivist-` prefix so every shipped selector in `archivist.spec.ts`
     *  keeps resolving. */
    testidPrefix?: string;
  }
  let {
    nodeId,
    hasItem,
    itemTitle,
    itemType,
    durationSec,
    isPlaying,
    cleanOutput,
    detailsUrl,
    compact = false,
    testidPrefix = 'archivist',
  }: Props = $props();

  // ---- The card's published status, read THROUGH the registry ----
  //
  // `null` is a REAL state — no card has published, i.e. none is mounted — and
  // it renders as idle with every gesture disabled rather than as a live-
  // looking surface whose buttons go nowhere.
  //
  // ⚠ THE SUBSCRIBER ASSIGNS; IT NEVER READ-MODIFY-WRITES. This is a
  // correctness requirement, not a style note, and it is written down because
  // the first draft got it wrong and took the whole rack down with it. The
  // block shipped as `let statusTick = $state(0)` bumped by `statusTick += 1`,
  // and `notify()` runs SYNCHRONOUSLY inside the PUBLISHER's own `$effect` —
  // ArchivistCard's publish, registerCommands and the lease release all call
  // it. So `statusTick += 1` executed inside that effect's TRACKED run, reading
  // `statusTick` and writing it in one expression. Svelte then has an effect
  // that reads and writes the same state: every archivist spawn died with
  // `effect_update_depth_exceeded` and took the rack's render down with it.
  //
  // A bare ASSIGNMENT has no such read, so the publisher's effect never
  // acquires this state as a dependency. It is also exactly what the two
  // shipped siblings do — `CameraSourceControls.svelte` and
  // `LoopbackOutputBody.svelte` each hold a `$state` and `sync()` it — and it
  // costs nothing in freshness, because `sync()` runs synchronously in the
  // notify: there is still no moment at which this surface's answer and the
  // card's can differ.
  let live = $state<ArchivistStatus | null>(null);
  let commandable = $state(false);
  $effect(() => {
    const id = nodeId;
    const sync = (): void => {
      live = archivistStatus.read(id);
      commandable = archivistStatus.hasCommands(id);
    };
    sync();
    return archivistStatus.subscribe(id, sync);
  });
  let status = $derived<ArchivistStatus>(live ?? ARCHIVIST_STATUS_IDLE);
  let hasCommands = $derived(commandable);

  let loading = $derived(status.loading);
  let errorMsg = $derived(status.errorMsg);
  let positionSec = $derived(status.positionSec);
  let isTimeMedia = $derived(itemType === 'audio' || itemType === 'video');

  // ---- The persisted search inputs ----
  //
  // ⚠ THE YEAR BOUNDS ARE `number | null`, NOT STRINGS, AND THAT IS A FIX
  // RATHER THAN A PREFERENCE. They are bound to `<input type="number">`, which
  // Svelte treats as NUMBER-LIKE: `bind_value` writes `to_number(input.value)`
  // into the bound state — a NUMBER once a digit is typed, `null` when the box
  // is emptied — regardless of what the declaration initialised it to. The
  // shipped card held these as `$state('')` under a `…Str` name and called
  // `.trim()` on them, so typing a year and pressing Search threw
  // `$.get(...).trim is not a function` INSIDE `ydoc.transact` and killed the
  // gesture. Every archivist test left the year boxes empty, so nothing ever
  // reached the line; the face spec's first leg now types one.
  let searchTerm = $state('');
  let mediaType = $state<ArchivistMediaType>('video');
  let yearFrom = $state<number | null>(null);
  let yearTo = $state<number | null>(null);

  onMount(() => {
    const d = patch.nodes[nodeId]?.data as Record<string, unknown> | undefined;
    if (!d) return;
    if (typeof d.searchTerm === 'string') searchTerm = d.searchTerm;
    if (typeof d.mediaType === 'string') mediaType = d.mediaType as ArchivistMediaType;
    if (typeof d.yearFrom === 'number') yearFrom = d.yearFrom;
    if (typeof d.yearTo === 'number') yearTo = d.yearTo;
  });

  /** A year bound as the graph must hold it: a FINITE number, or null. Never
   *  NaN — the card's `currentQuery` would drop a NaN anyway, but a NaN written
   *  into the Y.Doc is a value a peer has to render. */
  function yearOrNull(v: number | null): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  /**
   * Mirror the inputs onto the node.
   *
   * ⚠ WRITTEN BEFORE EVERY `search` REQUEST, NEVER PASSED AS AN ARGUMENT. The
   * card's handler reads the query from the GRAPH (see the registry's
   * `ArchivistCommands` note), so this write is what makes the search use what
   * is in this box. It also keeps the multiplayer mirror the module always had.
   */
  function writeSearchInputs(): void {
    ydoc.transact(() => {
      const t = patch.nodes[nodeId];
      if (!t) return;
      if (!t.data) t.data = {};
      const d = t.data as Record<string, unknown>;
      d.searchTerm = searchTerm;
      d.mediaType = mediaType;
      d.yearFrom = yearOrNull(yearFrom);
      d.yearTo = yearOrNull(yearTo);
    }, LOCAL_ORIGIN);
  }

  // ---- Gestures ----
  //
  // Each is a USER ACTION that cannot originate anywhere else, handed to the
  // card through the one seam that reaches it whether or not this surface is
  // the one the user is looking at.
  function runSearch(): void {
    writeSearchInputs();
    archivistStatus.request(nodeId, { kind: 'search' });
  }
  /**
   * ↻ next — re-roll another match from the page the card already holds.
   *
   * ⚠ IT DELIBERATELY DOES **NOT** WRITE THE INPUTS, and that is the one place
   * this differs from `runSearch`. THREE mounts of this component exist at once
   * (the parked card's, the dock body's and the lane tile's) and each holds its
   * OWN one-shot-hydrated copy of the four keys, so a `writeSearchInputs()`
   * here lets a re-roll pressed on a STALE mount overwrite the graph's query
   * with that mount's boxes — a lane tile that hydrated at spawn would blank a
   * term typed in the dock, and the card's own `nextRandom` falls back to a
   * FULL search on an empty page, which would then run the blanked query. The
   * gesture says "another one like the last", so it must not restate what the
   * last one was. Nothing is lost by omitting it: a term typed here and then
   * re-rolled has already reached the graph through the input's own `onchange`,
   * which fires on the blur the button click causes. The ↻ next button never
   * wrote them before the faceplate either — this preserves that.
   */
  function nextRandom(): void {
    archivistStatus.request(nodeId, { kind: 'next' });
  }
  function onSearchKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Enter') { ev.preventDefault(); runSearch(); }
  }
  function onTypeChange(ev: Event): void {
    mediaType = (ev.target as HTMLSelectElement).value as ArchivistMediaType;
    writeSearchInputs();
  }
  function togglePlay(): void {
    archivistStatus.request(nodeId, { kind: 'togglePlay' });
  }
  function skip(deltaS: number): void {
    archivistStatus.request(nodeId, { kind: 'skip', deltaS });
  }
  function jumpRandom(): void {
    archivistStatus.request(nodeId, { kind: 'jumpRandom' });
  }
  function onSeekInput(ev: Event): void {
    const positionS = clampSeek(Number((ev.target as HTMLInputElement).value), durationSec);
    archivistStatus.request(nodeId, { kind: 'seek', positionS });
  }

  // ── THE `0:04 / 2:00` LINE IS DELETED, NOT MOVED ─────────────────────────
  //
  // ⚠ Owner ruling: a faceplate paints no resting readout of derived state, and
  // decimal/derived readouts go rather than hide. videobox and videovarispeed
  // deleted this exact line for this exact reason. Position survives where a
  // scrubber's position always did — ON THE SCRUBBER, and speakably in its
  // `aria-valuetext`, which is a property of the control rather than a text
  // node beside it.
  let seekValueText = $derived(
    durationSec > 0
      ? `${formatTime(positionSec)} of ${formatTime(durationSec)}`
      : 'no time media loaded',
  );

  /** ↻ next falls back to a full search when no page is held, so it is live
   *  whenever a search could run at all — but never while one is in flight and
   *  never with no card to deliver to. */
  let canReroll = $derived(hasCommands && !loading && (status.docCount > 0 || hasItem));
</script>

<div class="arc-controls" class:compact data-testid="{testidPrefix}-controls">
  <div class="row">
    <select
      class="type-select nodrag"
      value={mediaType}
      onchange={onTypeChange}
      data-testid="{testidPrefix}-type"
      aria-label="Media type"
    >
      {#each ARCHIVIST_MEDIA_TYPES as t (t)}
        <option value={t}>{t}</option>
      {/each}
    </select>
    <input
      class="search-input nodrag"
      type="text"
      placeholder="search archive.org…"
      bind:value={searchTerm}
      onkeydown={onSearchKeydown}
      onchange={writeSearchInputs}
      data-testid="{testidPrefix}-search"
      aria-label="Search term"
    />
  </div>

  <div class="row years">
    {#if !compact}
      <input
        class="year-input nodrag"
        type="number"
        placeholder="from yr"
        bind:value={yearFrom}
        onchange={writeSearchInputs}
        data-testid="{testidPrefix}-year-from"
        aria-label="Year from"
      />
      <span class="dash" aria-hidden="true">–</span>
      <input
        class="year-input nodrag"
        type="number"
        placeholder="to yr"
        bind:value={yearTo}
        onchange={writeSearchInputs}
        data-testid="{testidPrefix}-year-to"
        aria-label="Year to"
      />
    {/if}
    <button
      type="button"
      class="search-btn nodrag"
      onclick={runSearch}
      disabled={loading || !hasCommands}
      data-testid="{testidPrefix}-search-btn"
    >Search</button>
    <button
      type="button"
      class="reroll-btn nodrag"
      onclick={nextRandom}
      disabled={!canReroll}
      data-testid="{testidPrefix}-reroll-btn"
      title="Load another random match"
    >↻ next</button>
  </div>

  <!-- A transient OUTCOME, replaced by the next search — not a resting readout.
       It is also the only thing that distinguishes "no results for that term"
       from a button that did nothing. -->
  {#if errorMsg}
    <div class="error" data-testid="{testidPrefix}-error">{errorMsg}</div>
  {/if}

  {#if isTimeMedia}
    <div class="transport">
      <button type="button" class="t-btn nodrag" onclick={() => skip(-SKIP_STEP_S)} data-testid="{testidPrefix}-back" title="Back 10s">−10s</button>
      <button type="button" class="play-btn nodrag" onclick={togglePlay} aria-pressed={isPlaying} data-testid="{testidPrefix}-play">{isPlaying ? 'Pause' : 'Play'}</button>
      <button type="button" class="t-btn nodrag" onclick={() => skip(SKIP_STEP_S)} data-testid="{testidPrefix}-fwd" title="Forward 10s">+10s</button>
      <button type="button" class="t-btn nodrag" onclick={jumpRandom} data-testid="{testidPrefix}-rand-pos" title="Jump to random position">⤭</button>
    </div>
    <input
      class="seek nodrag"
      type="range"
      min="0"
      max={Math.max(0.001, durationSec)}
      step="0.01"
      value={positionSec}
      oninput={onSeekInput}
      disabled={durationSec <= 0}
      data-testid="{testidPrefix}-seek"
      aria-label="Playhead"
      aria-valuetext={seekValueText}
    />
  {/if}

  {#if hasItem && !compact}
    <div class="meta" data-testid="{testidPrefix}-meta">
      <!-- ⚠ A NAVIGATIONAL CONTROL, NOT A READOUT, and the peertube precedent
           for keeping it: this anchor is the ONLY route from a loaded item to
           its archive.org page, where the licence and the uploader live. Its
           text is the item's own name INSIDE the control that opens it — the
           picturebox per-slot-filename shape. ⚠ The card's `Internet Archive ·
           {type}` line beside it is DELETED: the type restates the select two
           rows up, and the source is the module's whole identity. -->
      <a
        class="title-link nodrag"
        href={detailsUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={itemTitle ?? ''}
      >{itemTitle}</a>
      <!-- ⚠ THE `play-only (no clean output)` WARNING BECOMES A LAMP. It is the
           ONLY explanation a player has for a patched `video` jack delivering
           the idle pattern — archive.org serves its video without CORS, so the
           texture would be tainted and the factory never samples it. Deleting
           it outright would leave a dead-looking cable with no account of
           itself (the videovarispeed START-past-END argument). As a
           `StatusLed` the caption is STATIC and the sentence rides on
           `aria-label`/`title`, so no derived text is painted. -->
      <StatusLed
        caption="CLEAN OUT"
        lit={!cleanOutput}
        tone="warn"
        testid="{testidPrefix}-cors-warn"
        detail={cleanOutput
          ? `${itemType} items are CORS-clean — the ${itemType === 'image' ? 'image' : 'audio'} output carries real signal downstream.`
          : 'PLAY-ONLY: archive.org serves its video without CORS, so the texture would be tainted and the video output stays the idle pattern. It still plays and scrubs here.'}
      />
    </div>
  {/if}
</div>

<style>
  .arc-controls {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .row { display: flex; gap: 4px; align-items: center; min-width: 0; }
  .type-select {
    background: #1a1f2a; color: var(--text); border: 1px solid #404652;
    border-radius: 2px; font-size: 0.65rem; padding: 3px 4px;
  }
  .search-input {
    flex: 1; min-width: 0;
    background: #11151c; color: var(--text); border: 1px solid #404652;
    border-radius: 2px; font-size: 0.7rem; padding: 4px 6px;
  }
  .years { font-size: 0.65rem; }
  .year-input {
    width: 56px;
    background: #11151c; color: var(--text); border: 1px solid #404652;
    border-radius: 2px; font-size: 0.65rem; padding: 3px 4px;
  }
  .dash { color: var(--text-dim); }
  .search-btn, .reroll-btn {
    background: var(--cable-video); color: #000; border: none; border-radius: 2px;
    padding: 3px 8px; font-size: 0.65rem; cursor: pointer; letter-spacing: 0.03em;
  }
  .reroll-btn { background: #2a3340; color: var(--text); }
  .search-btn:disabled, .reroll-btn:disabled { opacity: 0.5; cursor: default; }
  .search-btn:hover:not(:disabled) { filter: brightness(1.1); }

  .error { font-size: 0.6rem; color: #ff6b6b; font-family: ui-monospace, monospace; }

  .transport { display: flex; align-items: center; gap: 4px; }
  .play-btn {
    background: var(--cable-video); color: #000; border: none; border-radius: 2px;
    padding: 3px 10px; font-size: 0.7rem; cursor: pointer; min-width: 52px;
  }
  .play-btn:hover { filter: brightness(1.1); }
  .t-btn {
    background: #2a3340; color: var(--text); border: none; border-radius: 2px;
    padding: 3px 6px; font-size: 0.6rem; cursor: pointer;
  }
  .t-btn:hover { filter: brightness(1.2); }

  .seek { width: 100%; accent-color: var(--cable-video); }
  .seek:disabled { opacity: 0.5; }

  .meta { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .title-link {
    font-size: 0.65rem; color: var(--text);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    text-decoration: none;
  }
  .title-link:hover { text-decoration: underline; color: var(--cable-video); }

  /* COMPACT — the 192 px lane tile. Only the year bounds and the attribution
     row are dropped (both are declared out in markup); everything that is the
     only route to something stays and simply tightens. */
  .compact .search-input { font-size: 0.6rem; padding: 2px 4px; }
  .compact .type-select { font-size: 0.55rem; padding: 2px 3px; }
  .compact .search-btn, .compact .reroll-btn { padding: 2px 5px; font-size: 0.55rem; }
  .compact .play-btn { min-width: 40px; padding: 2px 6px; font-size: 0.6rem; }
  .compact .t-btn { padding: 2px 4px; font-size: 0.55rem; }
</style>
