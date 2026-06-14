<script lang="ts">
  // ArchivistCard — universal Internet Archive (archive.org) media source.
  //
  // Search archive.org → pick a RANDOM matching item of the selected media
  // type (image | audio | video | any) → load + preview it. Scrub/seek for
  // time-media (audio + video). Per-type outputs (subject to CORS):
  //   image → clean WebGL `image` texture output.
  //   audio → clean `audio_l/audio_r` output (analysable/routable).
  //   video → PLAY-ONLY: plays + scrubs in the preview, but archive.org video
  //           lacks CORS on the served file so the `video` texture output
  //           cannot be delivered (tainted). The card shows this limitation.
  //
  // Search + metadata are CORS-open so we fetch them directly (no proxy).
  // All query/parse/file-pick logic lives in archivist-query.ts (pure,
  // unit-tested); scrub math in archivist-scrub.ts.
  //
  // PORTS: rendered through the shared yellow drill-down <PatchPanel> (NO raw
  // side handles — the #767 standard). Port ids are byte-identical to the
  // module def so the CV bridge + persisted edges route unchanged.
  //
  // PLAYBACK ROBUSTNESS: the file picker prefers HTML5-playable derivatives
  // (h.264 / theora / webm) and `waitForMeta` has an `error` listener + a
  // timeout, so an un-decodable archive.org derivative AUTO-ADVANCES to the
  // next random match instead of hanging the card on "Loading" forever.
  //
  // Multiplayer: the loaded item (identifier/title/type/fileUrl/duration) +
  // search inputs + isPlaying are mirrored on node.data (Yjs) so peers see
  // the same item + can drive play/seek. Each peer loads the URL locally.

  import { onMount, onDestroy } from 'svelte';
  import { useStore, type NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import { startCornerResize } from './card-resize';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    type ArchivistData,
    type ArchivistItemMeta,
    type ArchivistHandleExtras,
  } from '$lib/video/modules/archivist';
  import {
    type ArchivistMediaType,
    buildSearchUrl,
    parseSearchResponse,
    pickRandomDoc,
    parseMetadata,
    pickBestFile,
    buildFileUrl,
    buildDetailsUrl,
    concreteTypeFromMediatype,
    hasCleanOutput,
    METADATA_URL,
    type ArchivistDoc,
  } from '$lib/video/modules/archivist-query';
  import {
    clampSeek,
    skipBy,
    randomSeek,
    positionFraction,
    fractionToSeconds,
    formatTime,
    SKIP_STEP_S,
  } from '$lib/video/modules/archivist-scrub';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  const flowStore = useStore();

  // ---- Sizing ----
  const DEFAULT_WIDTH = 360;
  const DEFAULT_HEIGHT = 540;
  const MIN_WIDTH = 360;
  const MIN_HEIGHT = 360;
  let cardWidth = $derived<number>((node?.data?.width as number | undefined) ?? DEFAULT_WIDTH);
  let cardHeight = $derived<number>((node?.data?.height as number | undefined) ?? DEFAULT_HEIGHT);

  // ---- PatchPanel ports (NO raw side handles — the #767 yellow-drill-down
  //      standard). Port `id`s are BYTE-IDENTICAL to the module def + the prior
  //      raw <Handle>s so the CV bridge / persisted edges route unchanged; only
  //      the rendering moved into the panel. `cable` drives the row colour +
  //      the panel's Gates→CV→Audio grouping (gate/cv/video/audio match the def
  //      port `type`s). ----
  const inputs: PortDescriptor[] = [
    { id: 'play_trigger', label: 'PLAY TRIGGER', cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'image', label: 'IMAGE', cable: 'video' },
    { id: 'video', label: 'VIDEO', cable: 'video' },
    { id: 'audio_l', label: 'AUDIO L', cable: 'audio' },
    { id: 'audio_r', label: 'AUDIO R', cable: 'audio' },
    { id: 'loaded', label: 'LOADED', cable: 'gate' },
    { id: 'ended', label: 'ENDED', cable: 'gate' },
    { id: 'playing', label: 'PLAYING', cable: 'gate' },
    { id: 'playhead', label: 'PLAYHEAD', cable: 'cv' },
  ];

  // ---- DOM refs ----
  let mediaEl: HTMLVideoElement | null = $state(null); // <video> for video items
  let audioEl: HTMLAudioElement | null = $state(null); // <audio> for audio items
  let imgEl: HTMLImageElement | null = $state(null);    // <img> for image items

  // ---- Local UI state ----
  let searchTerm = $state('');
  let mediaType = $state<ArchivistMediaType>('video');
  let yearFromStr = $state('');
  let yearToStr = $state('');
  let lastDocs = $state<ArchivistDoc[]>([]); // current search page (for re-roll)
  let loading = $state(false);
  let statusMsg = $state<string | null>(null);
  let errorMsg = $state<string | null>(null);
  let displayPos = $state(0);

  // ---- Reactive reads from data (Yjs-backed) ----
  let item = $derived<ArchivistItemMeta | null>(
    (node?.data as Partial<ArchivistData> | undefined)?.item ?? null,
  );
  let isPlaying = $derived<boolean>(
    (node?.data as Partial<ArchivistData> | undefined)?.isPlaying ?? false,
  );
  let durationSec = $derived<number>(item?.duration ?? 0);
  let isTimeMedia = $derived<boolean>(item?.type === 'audio' || item?.type === 'video');
  let cleanOut = $derived<boolean>(item ? hasCleanOutput(item.type) : false);

  // Hydrate local inputs from saved data on mount.
  onMount(() => {
    const d = node?.data as Partial<ArchivistData> | undefined;
    if (d) {
      searchTerm = d.searchTerm ?? '';
      mediaType = d.mediaType ?? 'video';
      yearFromStr = d.yearFrom != null ? String(d.yearFrom) : '';
      yearToStr = d.yearTo != null ? String(d.yearTo) : '';
    }
  });

  // ---- Engine helpers ----
  function videoEngine(): VideoEngine | null {
    const e = engineCtx.get();
    if (!e) return null;
    try { return e.getDomain<VideoEngine>('video'); } catch { return null; }
  }
  function getExtras(): ArchivistHandleExtras | null {
    const ve = videoEngine();
    if (!ve) return null;
    try { return (ve.read(id, 'extras') as ArchivistHandleExtras | undefined) ?? null; } catch { return null; }
  }

  // ---- Data writers ----
  function writeItem(meta: ArchivistItemMeta | null): void {
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      const d = t.data as Partial<ArchivistData>;
      d.item = meta;
      d.isPlaying = false;
    }, LOCAL_ORIGIN);
  }
  function writeSearchInputs(): void {
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      const d = t.data as Partial<ArchivistData>;
      d.searchTerm = searchTerm;
      d.mediaType = mediaType;
      d.yearFrom = yearFromStr.trim() === '' ? null : Number(yearFromStr);
      d.yearTo = yearToStr.trim() === '' ? null : Number(yearToStr);
    }, LOCAL_ORIGIN);
  }
  function writePlaying(on: boolean): void {
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      (t.data as Partial<ArchivistData>).isPlaying = on;
    }, LOCAL_ORIGIN);
  }

  // ---- Search + load ----
  function parseYear(s: string): number | null {
    const t = s.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }

  /** Fetch a fresh random search page for the current inputs. */
  async function runSearch(): Promise<void> {
    errorMsg = null;
    loading = true;
    statusMsg = 'Searching archive.org…';
    writeSearchInputs();
    try {
      const url = buildSearchUrl(
        {
          term: searchTerm,
          mediatype: mediaType,
          yearFrom: parseYear(yearFromStr),
          yearTo: parseYear(yearToStr),
        },
        { rows: 50, random: true },
      );
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`search HTTP ${resp.status}`);
      const json = await resp.json();
      lastDocs = parseSearchResponse(json);
      if (lastDocs.length === 0) {
        statusMsg = null;
        errorMsg = 'No results — try another term or media type.';
        return;
      }
      await loadRandomFromDocs();
    } catch (e) {
      statusMsg = null;
      errorMsg = `Search failed: ${(e as Error)?.message ?? 'unknown error'}`;
    } finally {
      loading = false;
    }
  }

  /** Re-roll: pick another random item from the SAME search page (no refetch). */
  async function nextRandom(): Promise<void> {
    if (lastDocs.length === 0) { await runSearch(); return; }
    await loadRandomFromDocs();
  }

  async function loadRandomFromDocs(): Promise<void> {
    // Try several random docs in case some have no playable file of the type or
    // the chosen derivative won't decode (auto-advance — the user lands on a
    // playable item instead of a card stuck on "Loading"). Bounded by both an
    // attempt cap AND the number of distinct docs so we never spin.
    const tried = new Set<string>();
    const maxAttempts = Math.min(8, lastDocs.length);
    for (let attempt = 0; attempt < maxAttempts && tried.size < lastDocs.length; attempt++) {
      const doc = pickRandomDoc(lastDocs);
      if (!doc || tried.has(doc.identifier)) continue;
      tried.add(doc.identifier);
      const ok = await loadItem(doc);
      if (ok) return;
    }
    statusMsg = null;
    errorMsg = 'Could not find a playable item in the results — try another term or “↻ next”.';
  }

  /** Load one specific item: fetch metadata, pick the best file, attach. */
  async function loadItem(doc: ArchivistDoc): Promise<boolean> {
    loading = true;
    statusMsg = `Loading "${doc.title}"…`;
    errorMsg = null;
    try {
      const resp = await fetch(METADATA_URL(doc.identifier));
      if (!resp.ok) throw new Error(`metadata HTTP ${resp.status}`);
      const meta = parseMetadata(await resp.json(), doc.identifier);
      if (meta.restricted) return false; // skip restricted (belt + braces)

      // Resolve the concrete type. For 'any' we use the doc's mediatype.
      const concrete =
        mediaType === 'any'
          ? concreteTypeFromMediatype(doc.mediatype)
          : (mediaType as Exclude<ArchivistMediaType, 'any'>);
      if (!concrete) return false;

      const file = pickBestFile(meta.files, concrete);
      if (!file) return false;

      const fileUrl = buildFileUrl(meta, file.name);
      const itemMeta: ArchivistItemMeta = {
        identifier: doc.identifier,
        title: meta.title || doc.title,
        type: concrete,
        fileUrl,
        duration: 0, // filled after metadata loads for time-media
        cleanOutput: hasCleanOutput(concrete),
      };
      writeItem(itemMeta);
      const ok = await attachMedia(itemMeta);
      if (!ok) {
        // The picked derivative wouldn't decode (errored / timed out). Clear it
        // and let the caller advance to the next random match rather than
        // hanging at "Loading" — the user always lands on a playable item.
        writeItem(null);
        try { videoEngine()?.attachExternalSource(id, 'video', null); } catch { /* */ }
        statusMsg = `Couldn't play "${doc.title}" — skipping…`;
        return false;
      }
      statusMsg = null;
      getExtras()?.fireLoaded();
      return true;
    } catch (e) {
      errorMsg = `Load failed: ${(e as Error)?.message ?? 'unknown error'}`;
      return false;
    } finally {
      loading = false;
    }
  }

  /** Point the right element at the item's URL + wire it into the engine.
   *  Returns `true` when the element actually loaded (image decoded / media
   *  reached metadata), `false` on a load failure/timeout — the caller skips a
   *  failed item and advances to the next random match instead of hanging. */
  async function attachMedia(meta: ArchivistItemMeta): Promise<boolean> {
    const ve = videoEngine();
    // Tear down any previous wiring first.
    getExtras()?.unwireAudio();

    if (meta.type === 'image') {
      if (!imgEl) return false;
      imgEl.crossOrigin = 'anonymous'; // CORS-clean for archive images → untainted texture
      const ok = await new Promise<boolean>((resolve) => {
        if (!imgEl) { resolve(false); return; }
        const done = (): void => { cleanupImg(); resolve(true); };
        const onErr = (): void => { cleanupImg(); resolve(false); };
        function cleanupImg(): void {
          imgEl?.removeEventListener('load', done);
          imgEl?.removeEventListener('error', onErr);
        }
        imgEl.addEventListener('load', done, { once: true });
        imgEl.addEventListener('error', onErr, { once: true });
        imgEl.src = meta.fileUrl;
      });
      if (!ok) return false;
      // Attach AFTER load so the factory's one-shot texImage2D sees a decoded img.
      try { ve?.attachExternalSource(id, 'image', imgEl); } catch { /* not ready */ }
      return true;
    }

    if (meta.type === 'audio') {
      if (!audioEl) return false;
      audioEl.crossOrigin = 'anonymous'; // CORS-clean → MediaElementSource untainted
      audioEl.src = meta.fileUrl;
      const ok = await waitForMeta(audioEl);
      if (!ok) return false;
      updateDuration(meta, audioEl.duration);
      try { ve?.attachExternalSource(id, 'video', audioEl as unknown as HTMLVideoElement); } catch { /* */ }
      // ^ the factory's audio wiring path takes any HTMLMediaElement; the
      //   'video' kind just means "attach for audio/playback, not texturing".
      ensureAudioWired();
      return true;
    }

    if (meta.type === 'video') {
      if (!mediaEl) return false;
      // NO crossOrigin — archive.org video lacks CORS; setting crossorigin
      // would BLOCK playback entirely. Play-only (tainted), so we never
      // texture it; we only play + (optionally) wire its audio track.
      mediaEl.removeAttribute('crossorigin');
      mediaEl.src = meta.fileUrl;
      const ok = await waitForMeta(mediaEl);
      if (!ok) return false; // un-playable derivative → caller advances
      updateDuration(meta, mediaEl.duration);
      try { ve?.attachExternalSource(id, 'video', mediaEl); } catch { /* */ }
      // Audio track of a video item is also tainted (no CORS), so a
      // MediaElementSource would yield silence into the graph anyway and can
      // throw; we DO attempt wireAudio (it tolerates failure) but the audio
      // output for video items is best-effort / typically unavailable.
      ensureAudioWired();
      return true;
    }
    return false;
  }

  function updateDuration(meta: ArchivistItemMeta, dur: number): void {
    const d = Number.isFinite(dur) ? dur : 0;
    ydoc.transact(() => {
      const t = patch.nodes[id];
      const data = t?.data as Partial<ArchivistData> | undefined;
      const cur = data?.item;
      if (!data || !cur || cur.identifier !== meta.identifier) return;
      // REASSIGN the whole item object (don't mutate `cur.duration` in place):
      // the card's `durationSec = $derived(item?.duration)` reads node.data.item,
      // and an in-place nested mutation doesn't re-trigger the SvelteFlow node
      // re-render, so the "/ 0:00" duration readout + the seek `max` stayed at 0
      // even after metadata loaded. A fresh object is what writeItem() does (and
      // what made data-has-item reactive). Same nested-Y-mutation reactivity gap
      // documented in the repo's yjs-save-load memory.
      data.item = { ...cur, duration: d };
    }, LOCAL_ORIGIN);
  }

  /** Max wait for a media element to reach HAVE_METADATA before we treat it as
   *  un-playable. archive.org's CDN can be slow, but 12s is well past a normal
   *  first-byte → metadata for any decodable file; a hang past this means the
   *  derivative isn't HTML5-playable on this engine (or the network stalled). */
  const META_TIMEOUT_MS = 12_000;

  /**
   * Resolve when the media element has metadata, or report FAILURE on a media
   * `error` event OR after META_TIMEOUT_MS — so the card NEVER hangs forever on
   * "Loading" when a derivative can't be decoded (the old bug: no error/timeout
   * handler → spin at 0:00/0:00). All listeners + the timer are cleaned up on
   * every exit path. Returns `true` on success, `false` on failure/timeout.
   */
  function waitForMeta(el: HTMLMediaElement): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (el.readyState >= 1) { resolve(true); return; }
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        el.removeEventListener('loadedmetadata', onMeta);
        el.removeEventListener('error', onError);
        if (timer) { clearTimeout(timer); timer = null; }
      };
      const onMeta = (): void => { cleanup(); resolve(true); };
      const onError = (): void => { cleanup(); resolve(false); };
      el.addEventListener('loadedmetadata', onMeta, { once: true });
      el.addEventListener('error', onError, { once: true });
      timer = setTimeout(() => { cleanup(); resolve(false); }, META_TIMEOUT_MS);
    });
  }

  let audioWireTimer: ReturnType<typeof setTimeout> | null = null;
  function ensureAudioWired(attempt = 0): void {
    if (audioWireTimer) { clearTimeout(audioWireTimer); audioWireTimer = null; }
    const extras = getExtras();
    extras?.wireAudio();
    if (extras?.isAudioWired()) return;
    if (attempt >= 50) return;
    audioWireTimer = setTimeout(() => ensureAudioWired(attempt + 1), 100);
  }

  /** The active media element for the loaded type (null for images). */
  function activeMediaEl(): HTMLMediaElement | null {
    if (item?.type === 'audio') return audioEl;
    if (item?.type === 'video') return mediaEl;
    return null;
  }

  // ---- Transport ----
  function togglePlay(): void {
    const el = activeMediaEl();
    const next = !isPlaying;
    writePlaying(next);
    if (!el) return;
    if (next) void el.play().catch(() => { /* autoplay blocked */ });
    else try { el.pause(); } catch { /* */ }
  }

  function onSeekInput(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const target = clampSeek(Number(input.value), durationSec);
    const el = activeMediaEl();
    if (el) try { el.currentTime = target; } catch { /* */ }
    displayPos = target;
    getExtras()?.setPlayhead(positionFraction(target, durationSec));
  }

  function skip(deltaS: number): void {
    const el = activeMediaEl();
    if (!el) return;
    const target = skipBy(el.currentTime, deltaS, durationSec);
    try { el.currentTime = target; } catch { /* */ }
    displayPos = target;
  }

  function jumpRandom(): void {
    const el = activeMediaEl();
    if (!el) return;
    const target = randomSeek(durationSec);
    try { el.currentTime = target; } catch { /* */ }
    displayPos = target;
  }

  // ---- Sync shared isPlaying to the local element ----
  $effect(() => {
    void isPlaying;
    const el = activeMediaEl();
    if (!el) return;
    if (isPlaying && el.paused) void el.play().catch(() => { /* */ });
    else if (!isPlaying && !el.paused) try { el.pause(); } catch { /* */ }
  });

  // ---- play_trigger gate edge detection (mirrors VIDEOBOX) ----
  let lastGateValue = 0;
  let gateTimer: ReturnType<typeof setInterval> | null = null;
  function startGateLoop(): void {
    if (gateTimer !== null) return;
    gateTimer = setInterval(() => {
      const e = engineCtx.get();
      if (!e || !node) return;
      const v = e.readParam(node, 'cv_play_trigger');
      if (typeof v !== 'number') return;
      if (lastGateValue < 0.5 && v >= 0.5) togglePlay();
      lastGateValue = v;
    }, 33);
  }
  function stopGateLoop(): void {
    if (gateTimer !== null) { clearInterval(gateTimer); gateTimer = null; }
  }

  // ---- Per-frame display + playhead CV + gate outs ----
  let displayTimer: ReturnType<typeof setInterval> | null = null;
  function refreshDisplay(): void {
    const el = activeMediaEl();
    const extras = getExtras();
    if (el) {
      displayPos = el.currentTime;
      const frac = positionFraction(el.currentTime, durationSec || el.duration);
      extras?.setPlayhead(frac);
      extras?.setPlaying(!el.paused && !el.ended);
    } else {
      extras?.setPlaying(false);
    }
  }

  // ---- Mount / unmount ----
  onMount(() => {
    startGateLoop();
    displayTimer = setInterval(refreshDisplay, 100);
    // Re-attach a saved item on patch (re)load.
    if (item) void attachMedia(item);
  });
  onDestroy(() => {
    stopGateLoop();
    if (audioWireTimer) { clearTimeout(audioWireTimer); audioWireTimer = null; }
    if (displayTimer !== null) clearInterval(displayTimer);
    const ve = videoEngine();
    try { ve?.attachExternalSource(id, 'video', null); } catch { /* */ }
    try { ve?.attachExternalSource(id, 'image', null); } catch { /* */ }
    getExtras()?.unwireAudio();
  });

  // ---- `ended` trigger wiring ----
  function onEnded(): void {
    writePlaying(false);
    getExtras()?.fireEnded();
  }

  // ---- Form handlers ----
  function onSearchKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Enter') { ev.preventDefault(); void runSearch(); }
  }
  function onTypeChange(ev: Event): void {
    mediaType = (ev.target as HTMLSelectElement).value as ArchivistMediaType;
    writeSearchInputs();
  }

  // ---- Corner-drag resize ----
  let resizing = $state(false);
  let resizeAbort: AbortController | null = null;
  function onResizeStart(ev: PointerEvent) {
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

  let detailsUrl = $derived<string>(item ? buildDetailsUrl(item.identifier) : '');
</script>

<div
  class="card video archivist-card"
  class:resizing
  style="width: {cardWidth}px; height: {cardHeight}px;"
  data-testid="archivist-card"
  data-media-type={item?.type ?? mediaType}
  data-has-item={item !== null}
  data-clean-output={cleanOut}
  data-is-playing={isPlaying}
  role="region"
  aria-label="ARCHIVIST archive.org media source"
>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="ARCHIVIST" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
  <div class="body">
    <!-- Search controls -->
    <div class="controls">
      <div class="row">
        <select
          class="type-select nodrag"
          value={mediaType}
          onchange={onTypeChange}
          data-testid="archivist-type"
          aria-label="Media type"
        >
          <option value="image">image</option>
          <option value="audio">audio</option>
          <option value="video">video</option>
          <option value="any">any</option>
        </select>
        <input
          class="search-input nodrag"
          type="text"
          placeholder="search archive.org…"
          bind:value={searchTerm}
          onkeydown={onSearchKeydown}
          onchange={writeSearchInputs}
          data-testid="archivist-search"
          aria-label="Search term"
        />
      </div>
      <div class="row years">
        <input
          class="year-input nodrag"
          type="number"
          placeholder="from yr"
          bind:value={yearFromStr}
          onchange={writeSearchInputs}
          data-testid="archivist-year-from"
          aria-label="Year from"
        />
        <span class="dash">–</span>
        <input
          class="year-input nodrag"
          type="number"
          placeholder="to yr"
          bind:value={yearToStr}
          onchange={writeSearchInputs}
          data-testid="archivist-year-to"
          aria-label="Year to"
        />
        <button
          type="button"
          class="search-btn nodrag"
          onclick={() => void runSearch()}
          disabled={loading}
          data-testid="archivist-search-btn"
        >Search</button>
        <button
          type="button"
          class="reroll-btn nodrag"
          onclick={() => void nextRandom()}
          disabled={loading || (lastDocs.length === 0 && item === null)}
          data-testid="archivist-reroll-btn"
          title="Load another random match"
        >↻ next</button>
      </div>
    </div>

    <!-- Preview -->
    <div class="preview-wrap" data-testid="archivist-preview">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={mediaEl}
        class:hidden={item?.type !== 'video'}
        data-testid="archivist-video"
        playsinline
        onended={onEnded}
      ></video>
      <!-- svelte-ignore a11y_media_has_caption -->
      <audio
        bind:this={audioEl}
        class="audio-el"
        data-testid="archivist-audio"
        onended={onEnded}
      ></audio>
      <img
        bind:this={imgEl}
        class:hidden={item?.type !== 'image'}
        class="img-el"
        alt={item?.title ?? 'archive.org image'}
        data-testid="archivist-image"
      />

      {#if item?.type === 'audio'}
        <div class="audio-art" data-testid="archivist-audio-art">
          <div class="audio-art-icon">♪</div>
          <div class="audio-art-title">{item.title}</div>
        </div>
      {/if}

      {#if !item && !loading}
        <div class="overlay hint" data-testid="archivist-hint">
          <div>Search the Internet Archive</div>
          <div class="sub">pick a type + term, press Enter</div>
        </div>
      {/if}
      {#if loading}
        <div class="overlay hint" data-testid="archivist-loading">
          <div class="spinner"></div>
          <div class="sub">{statusMsg ?? 'Loading…'}</div>
        </div>
      {/if}
    </div>

    {#if errorMsg}
      <div class="error" data-testid="archivist-error">{errorMsg}</div>
    {/if}

    <!-- Transport (time-media only) -->
    {#if isTimeMedia}
      <div class="transport">
        <button type="button" class="t-btn nodrag" onclick={() => skip(-SKIP_STEP_S)} data-testid="archivist-back" title="Back 10s">−10s</button>
        <button type="button" class="play-btn nodrag" onclick={togglePlay} aria-pressed={isPlaying} data-testid="archivist-play">{isPlaying ? 'Pause' : 'Play'}</button>
        <button type="button" class="t-btn nodrag" onclick={() => skip(SKIP_STEP_S)} data-testid="archivist-fwd" title="Forward 10s">+10s</button>
        <button type="button" class="t-btn nodrag" onclick={jumpRandom} data-testid="archivist-rand-pos" title="Jump to random position">⤭</button>
        <span class="time" data-testid="archivist-time">{formatTime(displayPos)} / {formatTime(durationSec)}</span>
      </div>
      <input
        class="seek nodrag"
        type="range"
        min="0"
        max={Math.max(0.001, durationSec)}
        step="0.01"
        value={displayPos}
        oninput={onSeekInput}
        disabled={durationSec <= 0}
        data-testid="archivist-seek"
        aria-label="Playhead"
      />
    {/if}

    <!-- Attribution + per-type CORS note -->
    {#if item}
      <div class="meta" data-testid="archivist-meta">
        <a class="title-link nodrag" href={detailsUrl} target="_blank" rel="noopener noreferrer" title={item.title}>{item.title}</a>
        <div class="src-line">
          Internet Archive · {item.type}
          {#if !cleanOut}
            <span class="cors-warn" data-testid="archivist-cors-warn" title="archive.org video lacks CORS on the served file, so the texture output is tainted — preview/scrub only.">⚠ play-only (no clean output)</span>
          {/if}
        </div>
      </div>
    {/if}
  </div>

  <div
    class="resize-handle nodrag"
    role="separator"
    aria-label="Resize ARCHIVIST"
    data-testid="archivist-resize-handle"
    onpointerdown={onResizeStart}
  ></div>
  </PatchPanel>
</div>

<style>
  .card {
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
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
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--cable-video);
  }
  .body {
    /* Clear the PatchPanel's top-left/right trigger affordances (18px tall,
       inset from the corners) — same top margin the swept video cards use. */
    margin-top: 24px;
    padding: 0 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
    min-height: 0;
  }

  .controls { display: flex; flex-direction: column; gap: 4px; }
  .row { display: flex; gap: 4px; align-items: center; }
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

  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    align-items: center;
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    min-height: 140px;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    flex: 1;
  }
  video, .img-el {
    display: block;
    max-width: 100%; max-height: 100%;
    width: 100%; height: 100%;
    object-fit: contain;
    background: #000;
  }
  .hidden { display: none; }
  .audio-el { display: none; }
  .audio-art {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px; text-align: center; padding: 12px;
  }
  .audio-art-icon { font-size: 2.4rem; color: var(--cable-audio); }
  .audio-art-title {
    font-size: 0.7rem; color: var(--text-dim);
    max-width: 90%; overflow: hidden; text-overflow: ellipsis;
    display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical;
  }
  .overlay {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; background: rgba(5, 6, 8, 0.85);
    color: var(--text); font-size: 0.72rem; padding: 8px; gap: 6px;
  }
  .overlay .sub { color: var(--text-dim); font-size: 0.6rem; }
  .spinner {
    width: 18px; height: 18px; border-radius: 50%;
    border: 2px solid #2a3340; border-top-color: var(--cable-video);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

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
  .time { font-size: 0.6rem; color: var(--text-dim); font-family: ui-monospace, monospace; margin-left: auto; }

  .seek { width: 100%; accent-color: var(--cable-video); }
  .seek:disabled { opacity: 0.5; }

  .meta { display: flex; flex-direction: column; gap: 2px; }
  .title-link {
    font-size: 0.65rem; color: var(--text);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    text-decoration: none;
  }
  .title-link:hover { text-decoration: underline; color: var(--cable-video); }
  .src-line { font-size: 0.55rem; color: var(--text-dim); font-family: ui-monospace, monospace; }
  .cors-warn { color: #ffb454; }

  .resize-handle {
    position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
    cursor: nwse-resize;
    background: linear-gradient(135deg, transparent 50%, var(--cable-video) 50%,
      var(--cable-video) 60%, transparent 60%, transparent 70%,
      var(--cable-video) 70%, var(--cable-video) 80%, transparent 80%);
    opacity: 0.7; z-index: 5;
  }
  .resize-handle:hover { opacity: 1; }
</style>
