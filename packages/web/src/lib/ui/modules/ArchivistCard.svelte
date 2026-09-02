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
  import { nodeMedia, type NodeMediaLease } from '$lib/ui/media/node-media-registry';
  import { type NodeProps } from '@xyflow/svelte';
  import { captureFlowStore } from './card-kit';
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
  } from '$lib/video/modules/archivist-scrub';
  import { archivistStatus } from '$lib/ui/media/archivist-status-registry';
  import ArchivistBrowseControls from './archivist/ArchivistBrowseControls.svelte';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  // Guarded: the dock full-view plain-mounts this card OUTSIDE the
  // SvelteFlow provider, where a bare useStore() throws and killed the
  // card at init (no video in the expanded faceplate). Inside the
  // provider this is byte-identical; outside it's null -> zoom 1.
  const flowStore = captureFlowStore();

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
  // All THREE elements are owned by the NODE, not by this card (see
  // $lib/ui/media/node-media-registry) — an archive.org item is a video, an
  // image or an audio file, and the card picks per item. The pre-fix card
  // detached both engine sources on unmount, so a card move blanked a playing
  // item and the chain went black downstream.
  let videoHost: HTMLDivElement | null = $state(null);
  let audioHost: HTMLDivElement | null = $state(null);
  let imageHost: HTMLDivElement | null = $state(null);
  let mediaEl: HTMLVideoElement | null = $state(null); // <video> for video items
  let audioEl: HTMLAudioElement | null = $state(null); // <audio> for audio items
  let imgEl: HTMLImageElement | null = $state(null);    // <img> for image items
  const leases: (NodeMediaLease<HTMLElement> | null)[] = [null, null, null];

  // ---- Local UI state ----
  //
  // ⚠ THE FOUR SEARCH INPUTS ARE NO LONGER HELD HERE. They were card-local
  // `$state` hydrated once from `node.data` at mount, which had TWO consequences
  // — one of them a shipped defect this promotion had to fix rather than
  // inherit:
  //
  //   1. it made the card the only surface that could compose a query, which
  //      promotion (card parked off-screen, pointer-events:none) turns into "no
  //      surface can"; and
  //   2. ⚠ A PEER'S TYPING NEVER ARRIVED. The card WROTE all four keys to the
  //      Y.Doc for multiplayer and then never read them again, so a rack-mate
  //      changing the term left this card searching its own stale local copy —
  //      the mirror was write-only. Same for a patch loaded while the card was
  //      already mounted.
  //
  // The GRAPH is now the single answer: `ArchivistBrowseControls` writes the
  // keys and `currentQuery()` below reads them at the moment a search runs.
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
  // ---- Adopt the three NODE-owned elements into this card ----
  //
  // Each is a separate registry slot, so an item that switches type does not
  // disturb the other two. The reactive `class:hidden` / `alt` bindings the
  // markup used to carry are applied by the effect below, since these elements
  // are no longer declared by this component.
  $effect(() => {
    const hosts: [HTMLDivElement | null, string, 'video' | 'audio' | 'img', string][] = [
      [videoHost, 'video', 'video', 'archivist-video'],
      [audioHost, 'audio', 'audio', 'archivist-audio'],
      [imageHost, 'image', 'img', 'archivist-image'],
    ];
    const taken: NodeMediaLease<HTMLElement>[] = [];
    hosts.forEach(([host, slot, kind, testid], i) => {
      if (!host) return;
      const lease = nodeMedia.adopt(id, slot, host, {
        kind,
        init: (el) => {
          el.setAttribute('data-testid', testid);
          if (kind === 'video') (el as HTMLVideoElement).playsInline = true;
          if (kind === 'audio') el.classList.add('audio-el');
          if (kind === 'img') el.classList.add('img-el');
        },
      });
      leases[i] = lease;
      taken.push(lease);
      if (kind === 'video') mediaEl = lease.el as HTMLVideoElement;
      if (kind === 'audio') audioEl = lease.el as unknown as HTMLAudioElement;
      if (kind === 'img') imgEl = lease.el as HTMLImageElement;
    });
    // `onended={onEnded}` was a markup attribute on the video AND the audio.
    const enders = [mediaEl, audioEl].filter(Boolean) as HTMLMediaElement[];
    for (const el of enders) el.addEventListener('ended', onEnded);
    return () => {
      for (const el of enders) el.removeEventListener('ended', onEnded);
      for (const l of taken) l.release();
    };
  });

  // The `class:hidden` / `alt` bindings, applied imperatively. Reading `item`
  // here registers the reactive dependency exactly as the markup did.
  $effect(() => {
    const t = item?.type;
    mediaEl?.classList.toggle('hidden', t !== 'video');
    imgEl?.classList.toggle('hidden', t !== 'image');
    if (imgEl) imgEl.alt = item?.title ?? 'archive.org image';
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
  function writePlaying(on: boolean): void {
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      (t.data as Partial<ArchivistData>).isPlaying = on;
    }, LOCAL_ORIGIN);
  }

  // ---- Search + load ----

  /**
   * The query, READ FROM THE GRAPH at the moment it is needed.
   *
   * ⚠ THE GRAPH IS THE SINGLE ANSWER, and that is what makes ONE command seam
   * serve three surfaces. Three mounts of `ArchivistBrowseControls` can write
   * these keys (the card's, the dock body's, the lane tile's) and a rack-mate
   * can write them over Yjs; a query composed from any surface's own local copy
   * would be a fourth opinion, and the one that ran would depend on which
   * button was pressed. `ArchivistCommands.search` therefore takes no
   * arguments — see the registry's note — and this is the read it names.
   *
   * A plain non-reactive read is exactly right here: it runs inside a click /
   * command handler, never in a derivation, so the legacy card subtree's
   * non-reactive `patch` is not a constraint on it.
   */
  function currentQuery(): {
    term: string;
    mediatype: ArchivistMediaType;
    yearFrom: number | null;
    yearTo: number | null;
  } {
    const d = patch.nodes[id]?.data as Partial<ArchivistData> | undefined;
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;
    return {
      term: typeof d?.searchTerm === 'string' ? d.searchTerm : '',
      mediatype: (d?.mediaType ?? 'video') as ArchivistMediaType,
      yearFrom: num(d?.yearFrom),
      yearTo: num(d?.yearTo),
    };
  }

  /** Fetch a fresh random search page for the current inputs. */
  async function runSearch(): Promise<void> {
    errorMsg = null;
    loading = true;
    statusMsg = 'Searching archive.org…';
    try {
      const url = buildSearchUrl(currentQuery(), { rows: 50, random: true });
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
      // Read from the GRAPH for the same reason `runSearch` does — this runs
      // one await after the search that produced `doc`, and the filter that
      // chose it is the one on the node.
      const wanted = currentQuery().mediatype;
      const concrete =
        wanted === 'any'
          ? concreteTypeFromMediatype(doc.mediatype)
          : (wanted as Exclude<ArchivistMediaType, 'any'>);
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

  /** Absolute seek, in seconds. Clamped here rather than at the surface: the
   *  clamp is a property of the LOADED ITEM's duration, which only this owner
   *  is guaranteed to have (a surface can be mounted before metadata lands). */
  function seekTo(positionS: number): void {
    const target = clampSeek(positionS, durationSec);
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

  // ---- THE STATUS / COMMAND SEAM ($lib/ui/media/archivist-status-registry) ----
  //
  // ⚠ THIS IS WHAT MAKES A PROMOTED ARCHIVIST USABLE AT ALL. archivist is in
  // `DOM_SOURCE_LANE_TYPES`, so under the default shell this card is MOUNTED —
  // in `<HeadlessSourceHost>`, which is what keeps the three node-owned
  // elements attached and a loaded item playing — but parked at `left:-9999px`
  // with `pointer-events: none`, so nothing it draws can be clicked. The
  // faceplate's bodies show the state published below and invoke the commands
  // registered below. Ownership does not move: this card is still the only
  // thing that fetches, attaches, plays or seeks.
  //
  // ⚠ PUBLISH IS A TRACKED READ OF ALL FIVE FIELDS, deliberately. `loading`
  // alone is not the status a consumer paints: `statusMsg` says WHICH item is
  // being fetched, `errorMsg` carries the recovery instruction, `docCount`
  // decides whether ↻ next can promise a re-roll, and `positionSec` is the
  // scrubber's live position — the one field that ticks, and the reason it is
  // published here rather than written to the doc every 100 ms.
  $effect(() => {
    archivistStatus.publish(id, {
      loading,
      statusMsg,
      errorMsg,
      docCount: lastDocs.length,
      positionSec: displayPos,
    });
  });

  $effect(() => {
    // The lease is OWNER-CHECKED, so the remount churn this card sees (lane →
    // headless host → dock rail) cannot let a stale teardown unregister the
    // live mount's commands. See the registry header.
    const lease = archivistStatus.registerCommands(id, {
      search: () => { void runSearch(); },
      next: () => { void nextRandom(); },
      togglePlay,
      skip,
      seek: seekTo,
      jumpRandom,
    });
    return () => lease.release();
  });

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
    // NOTE what is deliberately ABSENT: no detach of either source, no
    // unwireAudio. All three elements belong to the NODE and keep playing
    // across a card move; detaching here blanked a live item. Teardown runs
    // from nodeMedia when the node leaves the graph.
    for (const l of leases) l?.release();
    leases.fill(null);
  });

  // ---- `ended` trigger wiring ----
  function onEnded(): void {
    writePlaying(false);
    getExtras()?.fireEnded();
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
  class="vcard card video archivist-card"
  class:resizing
  style="width: {cardWidth}px; height: {cardHeight}px;"
  data-testid="archivist-card"
  data-media-type={item?.type ?? 'none'}
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
    <!-- Preview. ⚠ THE ITEM IDENTITY LIVES ON THE ACCESSIBLE NAME, which is
         where the deleted `Internet Archive · {type}` line's content went — the
         same move the face body makes, so the two surfaces say one thing. -->
    <div
      class="preview-wrap"
      data-testid="archivist-preview"
      role="img"
      aria-label={item
        ? `ARCHIVIST picture — ${item.type} item “${item.title}” from the Internet Archive`
          + (cleanOut ? '' : ' (play-only: no clean picture output)')
        : 'ARCHIVIST picture — nothing loaded'}
    >
      <!-- The three media elements are NOT declared here: they belong to the
           NODE and are adopted into these host divs (see the $effect above).
           Declaring them in markup is what tied their lifetime to the card. -->
      <div class="video-host" bind:this={videoHost}></div>
      <div class="video-host" bind:this={audioHost}></div>
      <div class="video-host" bind:this={imageHost}></div>

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

    <!-- Search, transport and attribution — THE SHARED COMPONENT, not a copy.
         The dock full-view body and the lane tile mount the same file, so the
         three surfaces cannot drift; see its header for why that is structural
         on this module rather than merely tidy.

         ⚠ IT SITS BELOW THE PICTURE NOW (the search row used to be above it).
         One order for all three surfaces, and it is the order every other video
         surface in the tree already uses — picture first, browse under it.

         ⚠ TWO RESTING READOUTS ARE DELETED HERE, NOT MOVED. The `0:04 / 2:00`
         time line is gone (position lives on the scrubber and its
         `aria-valuetext`, the deletion videobox and videovarispeed already
         made), and so is the `Internet Archive · {type}` line — the type
         restated the picker two rows up and the source is the module's whole
         identity. What that line carried is on the picture's `aria-label`, and
         the `play-only` warning it hosted is now a `CLEAN OUT` StatusLed whose
         caption is static and whose sentence rides on `aria-label`/`title`. -->
    <ArchivistBrowseControls
      nodeId={id}
      testidPrefix="archivist"
      hasItem={item !== null}
      itemTitle={item?.title ?? null}
      itemType={item?.type ?? null}
      {durationSec}
      {isPlaying}
      cleanOutput={cleanOut}
      {detailsUrl}
    />
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
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .card.resizing { transition: none; }
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

  /* ⚠ THE SEARCH, TRANSPORT, SEEK, ERROR AND META RULES ARE GONE FROM HERE
     because their markup is gone from here: all of it moved into
     `archivist/ArchivistBrowseControls.svelte`, which carries its own scoped
     styles and is mounted by this card and by both faceplate bodies. Copying
     the rules back would be the drift that component exists to prevent. */

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
  /* The elements are ADOPTED into .video-host at runtime (node-owned), so
   * Svelte cannot scope-class them — these must be :global(). `display:
   * contents` keeps them in .preview-wrap's layout as the inline tags were. */
  .video-host { display: contents; }
  .video-host :global(video), .video-host :global(.img-el) {
    display: block;
    max-width: 100%; max-height: 100%;
    width: 100%; height: 100%;
    object-fit: contain;
    background: #000;
  }
  .video-host :global(.hidden) { display: none; }
  .video-host :global(.audio-el) { display: none; }
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
