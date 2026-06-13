<script lang="ts">
  // VideoboxCard — file picker + multiplayer playhead.
  //
  // The card owns the <video> element + the object-URL pointing at the
  // user's picked File; the engine module (videobox.ts) samples that
  // element each video frame into its FBO + (after wireAudio) routes
  // its audio into the cross-domain audio bridge.
  //
  // Multiplayer (node.data via Yjs/SyncedStore):
  //   data.fileMeta              — name + duration, set by the loader,
  //                                visible to all peers (so they can
  //                                render "{user} loaded {filename}").
  //   data.isPlaying             — true when the player is logically
  //                                playing (shared across peers).
  //   data.lastSyncTime          — wallclock ms at the last sync write.
  //   data.lastSyncPosition      — video position (s) at lastSyncTime.
  //
  // On every local play/pause/seek we write the new sync triple to
  // data; peers observe the write through the snapshot bus + run
  // videobox-sync.ts's decideDriftCorrection to bring their local
  // element back in line.
  //
  // Peers without a local copy can still see the seekbar (its max is
  // data.fileMeta.duration, set by the loader) and the play state, but
  // their <video> stays in the "drop a file to play locally" state.

  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position, useStore, type NodeProps } from '@xyflow/svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import { startCornerResize } from './card-resize';
  import { createFullscreen } from './use-fullscreen.svelte';
  import { createFullFrame } from './use-full-frame.svelte';
  import VideoCanvasContextMenu from './VideoCanvasContextMenu.svelte';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    videoboxDef,
    type VideoboxHandleExtras,
    type VideoboxData,
  } from '$lib/video/modules/videobox';
  import {
    buildSyncWrite,
    decideDriftCorrection,
    type VideoboxFileMeta,
  } from '$lib/video/modules/videobox-sync';
  import {
    canPersistVideoHandles,
    newVideoFileId,
    putVideoFileHandle,
    getVideoFileHandle,
    deleteVideoFileHandle,
    queryHandleReadPermission,
    requestHandleReadPermission,
    formatFileSize,
    type StoredFileHandle,
  } from '$lib/video/video-file-store';
  import {
    registerVideoExport,
    unregisterVideoExport,
  } from '$lib/video/video-export-registry';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  const flowStore = useStore();

  // ---- Resize (mirror VideoOutCard / BentboxCard) ----
  // VIDEOBOX is now drag-resizable so several can be tiled into a grid
  // (a "wall of TVs" alongside VIDEO OUT / BENTBOX). Width/height persist
  // on node.data so they sync via Y.Doc. Rounded to whole-u (180px) rack tiles
  // (#759) so default + min land on the grid; user-resizable so the rack CSS
  // doesn't clamp it.
  const DEFAULT_WIDTH = 360;
  const DEFAULT_HEIGHT = 360;
  const MIN_WIDTH = 360;
  const MIN_HEIGHT = 360;
  let cardWidth = $derived<number>((node?.data?.width as number | undefined) ?? DEFAULT_WIDTH);
  let cardHeight = $derived<number>((node?.data?.height as number | undefined) ?? DEFAULT_HEIGHT);

  // ---- DOM refs + local state ----
  let videoEl: HTMLVideoElement | null = $state(null);
  let objectUrl: string | null = null;
  let localFileName = $state<string | null>(null);
  let isDragOver = $state(false);
  let loadError = $state<string | null>(null);

  // ---- Persistence: remembered file handle (Chromium) ----
  // When the user picks a file via showOpenFilePicker() (or drops one and
  // the browser exposes getAsFileSystemHandle()), we keep the returned
  // FileSystemFileHandle in IndexedDB keyed by an id, and stamp that id +
  // file size into the synced fileMeta. On a later patch load this lets us
  // reload the same file automatically (or in one click after a permission
  // re-grant). Firefox / Safari never produce a handle and use the re-link
  // prompt path only.
  const canRememberHandle = canPersistVideoHandles();
  // A handle we resolved from IDB on load but whose read permission is in
  // the 'prompt' state — the card shows a one-click "re-allow" affordance
  // (requestPermission must run inside a user gesture).
  let pendingHandle = $state<StoredFileHandle | null>(null);
  // True once we've attempted the auto/handle reload for the loaded patch
  // so we don't re-run it on every reactive tick.
  let handleReloadAttempted = false;

  // ---- Reactive reads from data (Yjs-backed) ----
  let fileMeta = $derived<VideoboxFileMeta | null>(
    (node?.data as Partial<VideoboxData> | undefined)?.fileMeta ?? null,
  );
  let isPlaying = $derived<boolean>(
    (node?.data as Partial<VideoboxData> | undefined)?.isPlaying ?? false,
  );
  let lastSyncTime = $derived<number>(
    (node?.data as Partial<VideoboxData> | undefined)?.lastSyncTime ?? 0,
  );
  let lastSyncPosition = $derived<number>(
    (node?.data as Partial<VideoboxData> | undefined)?.lastSyncPosition ?? 0,
  );
  let durationSec = $derived<number>(fileMeta?.duration ?? 0);

  /** Track whether THIS browser has loaded a local copy of the file. */
  let hasLocalFile = $derived<boolean>(localFileName !== null);

  // ---- Extras helper ----
  function getExtras(): VideoboxHandleExtras | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      const ve = e.getDomain<VideoEngine>('video');
      return (ve.read(id, 'extras') as VideoboxHandleExtras | undefined) ?? null;
    } catch {
      return null;
    }
  }

  function videoEngine(): VideoEngine | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      return e.getDomain<VideoEngine>('video');
    } catch {
      return null;
    }
  }

  // ---- Sync writers (call inside a single transact so peers see one
  //      coherent update) ----
  function writeSync(args: { isPlaying: boolean; currentPositionSec: number }): void {
    const next = buildSyncWrite({
      isPlaying: args.isPlaying,
      currentPositionSec: args.currentPositionSec,
      nowWallclockMs: Date.now(),
    });
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      const d = t.data as Partial<VideoboxData>;
      d.isPlaying = next.isPlaying;
      d.lastSyncTime = next.lastSyncTime;
      d.lastSyncPosition = next.lastSyncPosition;
    }, LOCAL_ORIGIN);
  }

  function writeFileMeta(meta: VideoboxFileMeta): void {
    // If we're replacing a file that had a DIFFERENT remembered handle in
    // THIS browser's IDB, drop the stale handle so it doesn't leak. (Only
    // when the id actually changes — a reload reuses the same id.)
    const prevId = fileMeta?.handleId;
    if (prevId && prevId !== meta.handleId) {
      void deleteVideoFileHandle(prevId);
    }
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      const d = t.data as Partial<VideoboxData>;
      d.fileMeta = meta;
      // Reset playhead to start so peers don't extrapolate against
      // stale lastSyncPosition that may exceed the new duration.
      d.isPlaying = false;
      d.lastSyncTime = Date.now();
      d.lastSyncPosition = 0;
    }, LOCAL_ORIGIN);
  }

  // ---- File-picker handling ----
  //
  // `opts.handle` — a FileSystemFileHandle to persist for one-click reload
  //   (from showOpenFilePicker / a drop that exposed getAsFileSystemHandle).
  // `opts.reuseHandleId` — when reloading from an existing remembered
  //   handle, keep the patch's existing handleId rather than minting a new
  //   one (the handle is already stored under it).
  async function loadFile(
    file: File,
    opts?: { handle?: StoredFileHandle | null; reuseHandleId?: string },
  ): Promise<void> {
    loadError = null;
    pendingHandle = null;
    if (!file.type.startsWith('video/')) {
      loadError = `Not a video file: ${file.type || file.name}`;
      return;
    }
    // Free the previous object URL — leaving them around accumulates
    // ~30 MB of blob storage per swap which the browser eventually GCs
    // anyway but it's polite to release explicitly.
    if (objectUrl) {
      try { URL.revokeObjectURL(objectUrl); } catch { /* */ }
      objectUrl = null;
    }
    objectUrl = URL.createObjectURL(file);
    localFileName = file.name;
    // Register this node's bytes resolver for the portable "Export performance"
    // (.zip) path: the exporter (Canvas) collects loaded video bytes across all
    // VIDEOBOX cards via the registry. Capture the URL + name now (the closure
    // re-reads `objectUrl`/`localFileName` so a later swap is reflected).
    registerVideoExport(id, async () => {
      const url = objectUrl;
      if (!url) return null;
      const resp = await fetch(url);
      const ab = await (await resp.blob()).arrayBuffer();
      return { bytes: new Uint8Array(ab), name: localFileName ?? file.name };
    });
    if (!videoEl) return;
    videoEl.src = objectUrl;
    // muted=false so audio plays through MediaElementSource (which IS
    // the audio output once we wireAudio()). The video element's own
    // speaker output is muted-by-Web-Audio once createMediaElementSource
    // is called, so this attribute only matters for the brief window
    // before wireAudio runs.
    videoEl.muted = false;

    // Wait for metadata so duration + readyState are populated before
    // we publish fileMeta. loadedmetadata fires fast (<100ms typical).
    await new Promise<void>((resolve) => {
      if (!videoEl) { resolve(); return; }
      if (videoEl.readyState >= 1 /* HAVE_METADATA */) { resolve(); return; }
      const onMeta = (): void => { videoEl?.removeEventListener('loadedmetadata', onMeta); resolve(); };
      videoEl.addEventListener('loadedmetadata', onMeta, { once: true });
    });
    if (!videoEl) return;

    // Persist the handle (if we have one + the browser supports it) so a
    // later patch load can reload this exact file in one click. We do this
    // BEFORE writing fileMeta so the handleId we stamp is the one the
    // handle is stored under. If anything fails we just omit handleId and
    // the re-link prompt remains the fallback.
    let handleId: string | undefined = opts?.reuseHandleId;
    if (opts?.handle && canRememberHandle) {
      if (!handleId) handleId = newVideoFileId();
      await putVideoFileHandle(handleId, opts.handle);
    }

    writeFileMeta({
      name: file.name,
      duration: Number.isFinite(videoEl.duration) ? videoEl.duration : 0,
      size: Number.isFinite(file.size) ? file.size : undefined,
      handleId,
    });

    // Now that the element has src + metadata, wire its audio into the graph.
    // RETRY until it sticks: wireAudio() no-ops when getExtras() is still null
    // (engine hasn't materialized this card's video node yet — slower to settle
    // when a cross-domain audio edge is already present) or the factory's own
    // <video> ref isn't set yet (attachExternalSource, driven by the onMount
    // poll, hasn't run). Calling it once lost that race and left audio_l /
    // audio_r stuck on the silent placeholder -> downstream AUDIO-OUT silent.
    // wireAudio() is idempotent, so retrying until isAudioWired() converges as
    // soon as both the handle and the element are ready.
    ensureAudioWired();
  }

  let audioWireTimer: ReturnType<typeof setTimeout> | null = null;
  function ensureAudioWired(attempt = 0): void {
    if (audioWireTimer) { clearTimeout(audioWireTimer); audioWireTimer = null; }
    if (!hasLocalFile) return; // file was cleared; nothing to wire
    const extras = getExtras();
    extras?.wireAudio();
    if (extras?.isAudioWired()) return;
    if (attempt >= 50) return; // ~5s of 100ms retries; give up quietly
    audioWireTimer = setTimeout(() => ensureAudioWired(attempt + 1), 100);
  }

  function onFileInputChange(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    // The native <input type=file> can't hand us a FileSystemFileHandle, so
    // a pick through this path gets no remembered-handle persistence (only
    // fileMeta is saved → re-link prompt next time). The picker-button path
    // below uses showOpenFilePicker when available to also persist a handle.
    if (file) void loadFile(file);
    try { input.value = ''; } catch { /* */ }
  }

  // Picker button: prefer showOpenFilePicker (Chromium) so we get a
  // FileSystemFileHandle to remember; fall back to the native <input>
  // (Firefox / Safari) by letting the click bubble to its <label>. Returns
  // true if it handled the pick itself (so the label's default is
  // suppressed), false to let the native input fire.
  async function pickViaPicker(): Promise<boolean> {
    if (!canRememberHandle) return false;
    const picker = (globalThis as {
      showOpenFilePicker?: (opts?: unknown) => Promise<StoredFileHandle[]>;
    }).showOpenFilePicker;
    if (typeof picker !== 'function') return false;
    try {
      const handles = await picker({
        multiple: false,
        types: [
          { description: 'Video', accept: { 'video/*': ['.mp4', '.webm', '.mov', '.m4v', '.ogv'] } },
        ],
      });
      const handle = handles?.[0];
      if (!handle) return true; // user cancelled — still "handled"
      const file = await handle.getFile();
      await loadFile(file, { handle });
    } catch (e) {
      // AbortError = user cancelled the picker; ignore. Anything else:
      // surface it but still count as handled (don't double-open inputs).
      if ((e as { name?: string })?.name !== 'AbortError') {
        loadError = `Could not open file: ${(e as Error)?.message ?? 'unknown error'}`;
      }
    }
    return true;
  }

  function onPickClick(ev: MouseEvent): void {
    if (!canRememberHandle) return; // let the native <input> handle it
    // We have the File System Access picker — use it instead of the input.
    ev.preventDefault();
    void pickViaPicker();
  }

  function onDragOver(ev: DragEvent): void {
    ev.preventDefault();
    isDragOver = true;
  }
  function onDragLeave(): void { isDragOver = false; }
  async function onDrop(ev: DragEvent): Promise<void> {
    ev.preventDefault();
    isDragOver = false;
    // Try to grab a FileSystemFileHandle from the drop (Chromium) so a
    // dropped file is also remembered for one-click reload. getAsFileSystemHandle
    // returns a Promise<FileSystemHandle | null>; absent on Firefox / Safari.
    const item = ev.dataTransfer?.items?.[0];
    let handle: StoredFileHandle | null = null;
    const getHandle = (item as unknown as {
      getAsFileSystemHandle?: () => Promise<StoredFileHandle | null>;
    })?.getAsFileSystemHandle;
    if (canRememberHandle && typeof getHandle === 'function') {
      try {
        const h = await getHandle.call(item);
        if (h && h.kind === 'file') handle = h;
      } catch { /* fall back to the plain File below */ }
    }
    const file = handle ? await handle.getFile().catch(() => null) : ev.dataTransfer?.files?.[0];
    if (file) void loadFile(file, { handle });
  }

  // ---- Persistence: reload from a remembered handle on patch load ----
  //
  // After the patch loads, fileMeta may carry a handleId pointing at a
  // handle THIS browser persisted. We:
  //   1. look the handle up in IDB by id;
  //   2. if not found (different machine/browser, or never stored) → leave
  //      it; the re-link prompt shows;
  //   3. if found + read permission is 'granted' → reload immediately;
  //   4. if found + permission is 'prompt' → stash it in pendingHandle so
  //      the card shows a one-click "re-allow <name>" button (the actual
  //      requestPermission() must run inside that click's user gesture);
  //   5. if 'denied' → leave it; re-link prompt shows.
  async function tryReloadFromHandle(): Promise<void> {
    const id = fileMeta?.handleId;
    if (!id || hasLocalFile) return;
    const handle = await getVideoFileHandle(id);
    if (!handle) return; // not in this browser → re-link prompt path
    const perm = await queryHandleReadPermission(handle);
    if (perm === 'granted') {
      try {
        const file = await handle.getFile();
        await loadFile(file, { handle, reuseHandleId: id });
      } catch {
        // File moved/deleted on disk since the handle was stored — fall
        // through to the re-link prompt.
      }
      return;
    }
    if (perm === 'prompt') {
      pendingHandle = handle;
    }
    // 'denied' → nothing; the re-link prompt covers it.
  }

  // One-click "re-allow <name>": request read permission inside this click
  // gesture, then reload. Bound to the re-allow button.
  async function onReAllow(): Promise<void> {
    const handle = pendingHandle;
    const id = fileMeta?.handleId;
    if (!handle) return;
    const perm = await requestHandleReadPermission(handle);
    if (perm === 'granted') {
      pendingHandle = null;
      try {
        const file = await handle.getFile();
        await loadFile(file, { handle, reuseHandleId: id ?? undefined });
        return;
      } catch { /* fall through to re-link */ }
    }
    // Denied or file gone — drop the pending handle so the re-link prompt
    // takes over.
    pendingHandle = null;
  }

  // Re-link prompt visibility: we have saved fileMeta (a file was loaded
  // when the patch was saved) but THIS browser has no local copy AND we
  // can't auto-reload from a remembered handle (none, denied, or a
  // different machine/browser). The pendingHandle case shows the one-click
  // re-allow affordance instead.
  let showRelinkPrompt = $derived<boolean>(
    !hasLocalFile && fileMeta !== null && pendingHandle === null,
  );

  // Run the handle-reload attempt once fileMeta becomes available (covers
  // both an initial patch load and a load that swaps fileMeta in later).
  $effect(() => {
    void fileMeta?.handleId;
    if (handleReloadAttempted) return;
    if (!fileMeta?.handleId) return;
    if (hasLocalFile) return;
    handleReloadAttempted = true;
    void tryReloadFromHandle();
  });

  // ---- Play / pause / seek ----
  function togglePlay(): void {
    if (!videoEl) {
      // No local file — still flip the shared isPlaying so peers WITH a
      // local copy follow. Position stays where it was.
      writeSync({ isPlaying: !isPlaying, currentPositionSec: lastSyncPosition });
      return;
    }
    const next = !isPlaying;
    writeSync({ isPlaying: next, currentPositionSec: videoEl.currentTime });
  }

  function onSeek(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const target = Number(input.value);
    if (!Number.isFinite(target)) return;
    if (videoEl && hasLocalFile) {
      videoEl.currentTime = target;
    }
    // Write the seek REGARDLESS of whether we have a local copy — peers
    // with copies will pick it up + jump there.
    writeSync({ isPlaying, currentPositionSec: target });
  }

  // ---- Sync-driven local element control ----
  //
  // Whenever any of (isPlaying / lastSyncTime / lastSyncPosition) change,
  // bring our local <video> back in line:
  //   - if the shared state says playing but our element is paused, play
  //   - if shared says paused but ours is playing, pause
  //   - if our position drifts > 0.5s off expected, seek
  $effect(() => {
    void isPlaying; void lastSyncTime; void lastSyncPosition;
    if (!videoEl || !hasLocalFile) return;
    const playState = isPlaying;
    if (playState && videoEl.paused) {
      // Programmatic play() can reject on autoplay-policy grounds even
      // after a user has gestured for the page (browsers gate per-element
      // sometimes). Swallow — the next user click on the play button
      // will retry from a fresh gesture.
      void videoEl.play().catch(() => { /* autoplay blocked */ });
    } else if (!playState && !videoEl.paused) {
      try { videoEl.pause(); } catch { /* */ }
    }
    const decision = decideDriftCorrection(
      { isPlaying: playState, lastSyncTime, lastSyncPosition },
      videoEl.currentTime,
      Date.now(),
      durationSec,
    );
    if (decision.kind === 'seek') {
      try { videoEl.currentTime = decision.to; } catch { /* */ }
    }
  });

  // While playing, the local element advances on its own; we ALSO need
  // a periodic drift check (separate from the sync-state change above)
  // so a local element that's running slow gradually catches up. 500ms
  // is plenty — the threshold is 0.5s, so a check at the same rate
  // bounds total drift at ~1s worst case before correction.
  let driftTimer: ReturnType<typeof setInterval> | null = null;
  function startDriftLoop(): void {
    if (driftTimer !== null) return;
    driftTimer = setInterval(() => {
      if (!videoEl || !hasLocalFile) return;
      if (!isPlaying) return;
      const dec = decideDriftCorrection(
        { isPlaying: true, lastSyncTime, lastSyncPosition },
        videoEl.currentTime,
        Date.now(),
        durationSec,
      );
      if (dec.kind === 'seek') {
        try { videoEl.currentTime = dec.to; } catch { /* */ }
      }
    }, 500);
  }
  function stopDriftLoop(): void {
    if (driftTimer !== null) { clearInterval(driftTimer); driftTimer = null; }
  }

  // ---- play_trigger gate input edge detection ----
  //
  // When a gate fires into play_trigger, the engine writes the rising-
  // edge value into the synthetic cv_play_trigger param. We poll the
  // engine's readParam for that synthetic param + detect a rising edge,
  // then toggle play state. Polling rather than reaching into the
  // factory keeps this single-direction (card observes engine; engine
  // never reaches into the card).
  let lastGateValue = 0;
  let gateTimer: ReturnType<typeof setInterval> | null = null;
  function startGateLoop(): void {
    if (gateTimer !== null) return;
    gateTimer = setInterval(() => {
      const e = engineCtx.get();
      if (!e || !node) return;
      const v = e.readParam(node, 'cv_play_trigger');
      if (typeof v !== 'number') return;
      // Rising edge across 0.5: pulse → toggle.
      if (lastGateValue < 0.5 && v >= 0.5) {
        // Compose toggle as if the user clicked play/pause locally.
        const cur = videoEl?.currentTime ?? lastSyncPosition;
        writeSync({ isPlaying: !isPlaying, currentPositionSec: cur });
      }
      lastGateValue = v;
    }, 33);
  }
  function stopGateLoop(): void {
    if (gateTimer !== null) { clearInterval(gateTimer); gateTimer = null; }
  }

  // ---- Attach the <video> element to the engine module ----
  //
  // Mirrors CameraInputCard: the factory may not exist yet when the
  // card mounts (engine.addNode is async); poll until it does or we
  // give up after ~5s.
  function attachVideoEl(): void {
    const ve = videoEngine();
    if (!ve || !videoEl) return;
    try { ve.attachExternalSource(id, 'video', videoEl); } catch { /* not ready */ }
  }

  // ---- Mount / unmount ----
  onMount(() => {
    let attempts = 0;
    const attach = setInterval(() => {
      attempts++;
      const ve = videoEngine();
      if (ve && videoEl) {
        try {
          ve.attachExternalSource(id, 'video', videoEl);
          const present = ve.read(id, 'hasVideoElement');
          if (present === true) clearInterval(attach);
        } catch { /* not ready */ }
      }
      if (attempts > 50) clearInterval(attach);
    }, 100);

    startDriftLoop();
    startGateLoop();
  });

  onDestroy(() => {
    stopDriftLoop();
    stopGateLoop();
    if (audioWireTimer) { clearTimeout(audioWireTimer); audioWireTimer = null; }
    const ve = videoEngine();
    try { ve?.attachExternalSource(id, 'video', null); } catch { /* */ }
    const extras = getExtras();
    extras?.unwireAudio();
    unregisterVideoExport(id);
    if (objectUrl) {
      try { URL.revokeObjectURL(objectUrl); } catch { /* */ }
      objectUrl = null;
    }
  });

  // ---- Displayed current position ----
  //
  // While playing, derive it from the sync state + elapsed wallclock
  // (so peers without a local copy still see the seekbar slider move).
  // While paused, just show lastSyncPosition.
  let displayPos = $state(0);
  let displayTimer: ReturnType<typeof setInterval> | null = null;
  function refreshDisplay(): void {
    if (videoEl && hasLocalFile) {
      displayPos = videoEl.currentTime;
      return;
    }
    if (isPlaying) {
      const elapsed = Math.max(0, (Date.now() - lastSyncTime) / 1000);
      displayPos = Math.min(durationSec || Infinity, lastSyncPosition + elapsed);
    } else {
      displayPos = lastSyncPosition;
    }
  }
  onMount(() => {
    displayTimer = setInterval(refreshDisplay, 100);
  });
  onDestroy(() => {
    if (displayTimer !== null) clearInterval(displayTimer);
  });

  function formatTime(s: number): string {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const mm = Math.floor(s / 60);
    const ss = Math.floor(s % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  }

  // ---------- True fullscreen (Fullscreen API) ----------
  // The preview-wrap is the fullscreen element; it holds the live <video>.
  const fs = createFullscreen();
  let wrapEl: HTMLDivElement | null = $state(null);
  $effect(() => { fs.setTarget(wrapEl); });
  $effect(() => fs.attach());

  // ---------- Full Frame (in-app, NOT browser fullscreen) ----------
  // Expands the <video> preview to consume the card border, hiding the file
  // picker / transport / seekbar / port labels + jacks; the card stays in
  // the rack + remains resizable. Persisted in node.data.fullFrame (Y.Doc-
  // synced) so a wall-of-TVs layout survives reload + is shareable.
  let fullFrame = $derived<boolean>((node?.data?.fullFrame as boolean | undefined) ?? false);
  const ff = createFullFrame({
    setFullFrame: (on) => {
      const target = patch.nodes[id];
      if (target) {
        if (!target.data) target.data = {};
        (target.data as Record<string, unknown>).fullFrame = on;
      }
    },
    exitFullscreen: () => void fs.exit(),
  });
  let cardEl: HTMLDivElement | null = $state(null);
  $effect(() => ff.attach(cardEl, () => fullFrame));

  // Right-click-on-preview context menu (Fullscreen / Full Frame).
  let ctxOpen = $state(false);
  let ctxX = $state(0);
  let ctxY = $state(0);
  function onPreviewContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    ctxX = e.clientX;
    ctxY = e.clientY;
    ctxOpen = true;
  }

  // ---------- Corner-drag resize ----------
  let resizing = $state(false);
  let resizeAbort: AbortController | null = null;
  function onResizeStart(ev: PointerEvent) {
    resizeAbort = startCornerResize(ev, {
      flowStore,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      getStartSize: () => ({ width: cardWidth, height: cardHeight }),
      apply: (w, h) => {
        const target = patch.nodes[id];
        if (target) {
          if (!target.data) target.data = {};
          (target.data as Record<string, unknown>).width = w;
          (target.data as Record<string, unknown>).height = h;
        }
      },
      onStart: () => { resizing = true; },
      onEnd: () => { resizing = false; resizeAbort = null; },
    });
  }
  onDestroy(() => { if (resizeAbort) resizeAbort.abort(); });
</script>

<div
  bind:this={cardEl}
  class="card video videobox-card"
  class:drag-over={isDragOver}
  class:resizing
  class:full-frame={fullFrame}
  style="width: {cardWidth}px; height: {cardHeight}px;"
  data-testid="videobox-card"
  data-has-local-file={hasLocalFile}
  data-is-playing={isPlaying}
  data-full-frame={fullFrame}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  role="region"
  aria-label="VIDEOBOX video player"
>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="VIDEOBOX" />

  <Handle type="target" position={Position.Left}  id="play_trigger" style="top: 56px; --handle-color: var(--cable-gate);" />
  <span class="port-label left" style="top: 50px;">TRIG</span>

  <Handle type="source" position={Position.Right} id="video"   style="top: 56px; --handle-color: var(--cable-video);" />
  <span class="port-label right" style="top: 50px;">VID</span>
  <Handle type="source" position={Position.Right} id="audio_l" style="top: 84px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: 78px;">A-L</span>
  <Handle type="source" position={Position.Right} id="audio_r" style="top: 112px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: 106px;">A-R</span>

  <div class="body">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={wrapEl}
      class="preview-wrap"
      class:fullscreen={fs.isFullscreen}
      class:full-frame={fullFrame}
      data-testid="videobox-fs-wrap"
      oncontextmenu={onPreviewContextMenu}
    >
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={videoEl}
        data-testid="videobox-video"
        playsinline
      ></video>
      {#if !hasLocalFile && !fileMeta}
        <div class="overlay drop-hint" data-testid="videobox-drop-hint">
          <div>Drop a video file</div>
          <div class="sub">or click to select</div>
        </div>
      {:else if !hasLocalFile && pendingHandle}
        <!-- One-click re-allow: a remembered handle exists in THIS browser
             but its read permission lapsed (patch reopened). Re-grant +
             reload in a single user gesture. -->
        <div class="overlay reallow-hint" data-testid="videobox-reallow-hint">
          <div><strong>{fileMeta?.name}</strong></div>
          <button
            type="button"
            class="reallow-btn"
            onclick={onReAllow}
            data-testid="videobox-reallow-btn"
          >Click to re-allow {fileMeta?.name}</button>
        </div>
      {:else if showRelinkPrompt}
        <!-- Re-link fallback (all browsers / cross-machine): no usable
             handle, so prompt the user to re-pick (or drop) their own copy.
             Picking reloads it + (if supported) stores a fresh handle for
             next time. The <label> drives the native <input> on Firefox /
             Safari; onPickClick intercepts to use showOpenFilePicker on
             Chromium so the re-picked file gets a fresh remembered handle. -->
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
        <label
          class="overlay relink-hint"
          data-testid="videobox-relink-hint"
          onclick={onPickClick}
        >
          <input
            type="file"
            accept="video/*"
            onchange={onFileInputChange}
            data-testid="videobox-relink-input"
          />
          <div class="relink-label">Re-link: drop "{fileMeta?.name}"</div>
          <div class="sub">
            {formatFileSize(fileMeta?.size)} · {formatTime(durationSec)}
          </div>
        </label>
      {/if}
    </div>

    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
    <label class="pick-btn" data-testid="videobox-pick-label" onclick={onPickClick}>
      <input
        type="file"
        accept="video/*"
        onchange={onFileInputChange}
        data-testid="videobox-file-input"
      />
      <span>{hasLocalFile ? 'Pick another video…' : 'Choose video…'}</span>
    </label>

    {#if loadError}
      <div class="error" data-testid="videobox-error">{loadError}</div>
    {/if}

    <div class="transport">
      <button
        type="button"
        class="play-btn"
        onclick={togglePlay}
        data-testid="videobox-play-btn"
        aria-pressed={isPlaying}
      >{isPlaying ? 'Pause' : 'Play'}</button>
      <span class="time" data-testid="videobox-time">
        {formatTime(displayPos)} / {formatTime(durationSec)}
      </span>
    </div>

    <input
      class="seek"
      type="range"
      min="0"
      max={Math.max(0.001, durationSec)}
      step="0.01"
      value={displayPos}
      oninput={onSeek}
      disabled={durationSec <= 0}
      data-testid="videobox-seek"
      aria-label="Video playhead"
    />

    {#if fileMeta}
      <div class="filename" title={fileMeta.name} data-testid="videobox-filename">
        {fileMeta.name}
      </div>
    {/if}
  </div>

  <!-- Bottom-right corner-drag resize handle (nodrag so xyflow's node-drag
       doesn't hijack the pointerdown). -->
  <div
    class="resize-handle nodrag"
    role="separator"
    aria-label="Resize VIDEOBOX"
    data-testid="videobox-resize-handle"
    onpointerdown={onResizeStart}
  ></div>
</div>

<VideoCanvasContextMenu
  bind:open={ctxOpen}
  x={ctxX}
  y={ctxY}
  title="VIDEOBOX"
  availableScreens={fs.availableScreens}
  onrequestscreens={() => void fs.loadScreens()}
  onfullscreen={(screenId) => { ff.exit(); void fs.enter(screenId); }}
  onfullframe={() => ff.toggle(fullFrame)}
  isFullFrame={fullFrame}
  onclose={() => { ctxOpen = false; }}
/>

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
    /* The body fills the card below the header so the preview-wrap can
     * grow as the card is resized (and to 100% in full-frame). */
    display: flex;
    flex-direction: column;
  }
  .card.resizing { transition: none; }
  :global(.svelte-flow__node:hover) .card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .card.drag-over {
    border-color: var(--cable-video);
    box-shadow: 0 0 0 2px var(--cable-video), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--cable-video);
  }
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
    letter-spacing: 0.05em;
  }
  .port-label {
    position: absolute;
    font-size: 0.55rem;
    color: var(--text-dim);
    pointer-events: none;
    font-family: ui-monospace, monospace;
  }
  .port-label.left { left: 14px; }
  .port-label.right { right: 14px; }

  .body {
    margin-top: 28px;
    padding: 0 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
    min-height: 0;
  }

  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    align-items: center;
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    min-height: 160px;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    /* Grow to consume the card space above the transport controls so a
     * resized card shows a bigger preview. */
    flex: 1;
  }
  video {
    display: block;
    max-width: 100%;
    max-height: 100%;
    width: 100%;
    height: auto;
    object-fit: contain;
    background: #000;
  }
  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    background: rgba(5, 6, 8, 0.85);
    color: var(--text);
    font-size: 0.7rem;
    padding: 8px;
    gap: 4px;
  }
  .overlay .sub {
    color: var(--text-dim);
    font-size: 0.6rem;
  }
  .drop-hint { border: 1px dashed color-mix(in oklab, var(--cable-video) 50%, transparent); }

  /* Re-allow affordance (remembered handle, lapsed permission). */
  .reallow-hint { gap: 8px; }
  .reallow-btn {
    background: var(--cable-video);
    color: #000;
    border: none;
    border-radius: 2px;
    padding: 5px 12px;
    font-size: 0.65rem;
    cursor: pointer;
    letter-spacing: 0.03em;
    max-width: 90%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .reallow-btn:hover { filter: brightness(1.1); }

  /* Re-link prompt (no usable handle — re-pick your own copy). */
  .relink-hint {
    cursor: pointer;
    border: 1px dashed color-mix(in oklab, var(--cable-video) 50%, transparent);
    gap: 6px;
  }
  .relink-hint input { display: none; }
  .relink-label {
    color: var(--text);
    font-size: 0.7rem;
    max-width: 92%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .relink-hint:hover .relink-label { text-decoration: underline; }

  .pick-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: #1a1f2a;
    color: var(--text-dim);
    border: 1px dashed #404652;
    border-radius: 2px;
    padding: 4px 8px;
    font-size: 0.65rem;
    cursor: pointer;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .pick-btn input { display: none; }
  .pick-btn:hover {
    color: var(--text);
    border-color: #6a7282;
  }

  .error {
    font-size: 0.6rem;
    color: #ff6b6b;
    font-family: ui-monospace, monospace;
  }

  .transport {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .play-btn {
    background: var(--cable-video);
    color: #000;
    border: none;
    border-radius: 2px;
    padding: 3px 10px;
    font-size: 0.7rem;
    cursor: pointer;
    letter-spacing: 0.05em;
    min-width: 56px;
  }
  .play-btn:hover { filter: brightness(1.1); }
  .time {
    font-size: 0.65rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
  }

  .seek {
    width: 100%;
    accent-color: var(--cable-video);
  }
  .seek:disabled { opacity: 0.5; }

  .filename {
    font-size: 0.6rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ---------- True fullscreen (Fullscreen API) ---------- */
  .preview-wrap.fullscreen {
    width: 100%;
    height: 100%;
    background: #000;
    aspect-ratio: auto;
  }
  /* Zoom-fit: fill the fullscreen viewport (100% × 100%) + object-fit:contain
   * so the video scales UP as large as possible while preserving aspect,
   * centered, with black bars on the off-axis. width/height:auto could leave
   * a small-intrinsic clip un-scaled in the center of the screen. */
  .preview-wrap.fullscreen video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    cursor: pointer;
  }

  /* ---------- FULL FRAME (in-app, NOT browser fullscreen) ---------- */
  /* The <video> preview consumes the whole card border; hide the title,
   * stripe, port labels, file picker, transport + seekbar so the card shows
   * only video. Stays in the rack + resizable; double-click exits. */
  .card.full-frame {
    padding: 0;
  }
  .card.full-frame .title,
  .card.full-frame .stripe,
  .card.full-frame .port-label,
  .card.full-frame .pick-btn,
  .card.full-frame .transport,
  .card.full-frame .seek,
  .card.full-frame .filename,
  .card.full-frame .error {
    display: none;
  }
  /* Hide the card's OWN Svelte Flow jacks while full-frame — keep them in
   * the DOM (opacity/pointer-events, not display:none) so existing cables
   * stay connected; we hide, not remove. */
  .card.full-frame :global(.svelte-flow__handle) {
    opacity: 0;
    pointer-events: none;
  }
  .card.full-frame .body {
    margin-top: 0;
    padding: 0;
    gap: 0;
  }
  .preview-wrap.full-frame {
    width: 100%;
    height: 100%;
    border: none;
    border-radius: 0;
    background: #000;
    aspect-ratio: auto;
    cursor: pointer;
  }
  .preview-wrap.full-frame video {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  /* Keep the re-allow / re-link affordances legible if a peer loaded a file
   * we can't play locally — but the drop-hint should vanish so full-frame
   * is clean. */
  .card.full-frame .drop-hint {
    display: none;
  }

  /* ---------- Corner-drag resize handle ---------- */
  .resize-handle {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    background: linear-gradient(
      135deg,
      transparent 50%,
      var(--cable-video) 50%,
      var(--cable-video) 60%,
      transparent 60%,
      transparent 70%,
      var(--cable-video) 70%,
      var(--cable-video) 80%,
      transparent 80%
    );
    opacity: 0.7;
    z-index: 5;
  }
  .resize-handle:hover { opacity: 1; }
</style>
