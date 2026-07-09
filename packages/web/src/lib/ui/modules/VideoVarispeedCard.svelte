<script lang="ts">
  // VideoVarispeedCard — local-file video player with a PERFORMANT varispeed
  // transport. The performant redo of the rolled-back VIDEOBOX #291.
  //
  // The card owns the <video> element + the object-URL for the picked File;
  // the engine module (videovarispeed.ts) samples that element into its FBO
  // via requestVideoFrameCallback (so the output streams at ANY speed —
  // the upload cadence is the element's own decode cadence, NOT playbackRate)
  // and routes audio into the cross-domain bridge after wireAudio().
  //
  // Transport (driven by this card's rAF loop):
  //   * Forward varispeed -> <video>.playbackRate (native, cheap; audio
  //     pitch/tempo-shifts = varispeed distortion).
  //   * Reverse -> THROTTLED currentTime scrub (~10 Hz, NOT per-frame) so the
  //     decoder never floods + the main thread never stalls. Audio muted in
  //     reverse (no native reverse audio).
  //   * START/END window + loop/one-shot + CV gates per videovarispeed-
  //     transport.ts.
  //
  // Play state + loop + fileMeta live on node.data so they persist across
  // reload. CV-connection lookups are cached (recomputed only when the edge
  // set changes) so the hot rAF loop never scans the patch.

  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    videoVarispeedDef,
    type VideoVarispeedHandleExtras,
    type VideoVarispeedData,
    VIDEOVARISPEED_MAX_SLOT_BYTES,
  } from '$lib/video/modules/videovarispeed';
  import { ASSET_SLOTS, ASSET_SLOT_LABELS, slotForVOct } from '$lib/video/asset-select';
  import type { VideoboxFileMeta } from '$lib/video/modules/videobox-sync';
  import {
    speedKnobToMultiplier,
    effectiveSpeedKnob,
    effectiveStartFraction,
    effectiveEndFraction,
    resolveWindow,
    decideEdgeAction,
    reverseScrubStep,
  } from '$lib/video/modules/videovarispeed-transport';
  import {
    canPersistVideoHandles,
    newVideoFileId,
    putVideoFileHandle,
    getVideoFileHandle,
    deleteVideoFileHandle,
    queryHandleReadPermission,
    requestHandleReadPermission,
    type StoredFileHandle,
  } from '$lib/video/video-file-store';
  import {
    registerVideoExport,
    unregisterVideoExport,
  } from '$lib/video/video-export-registry';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // ---- PatchPanel ports (NO raw side handles — the #767 yellow drill-down
  //      standard; also gives the card its rear-view back panel). Port `id`s are
  //      BYTE-IDENTICAL to the module def so the CV bridge + persisted edges
  //      route unchanged; only the rendering moved into the panel. ----
  const inputs = portsFromDef(videoVarispeedDef.inputs, {
    cv_start: 'START', cv_pause: 'PAUSE', cv_reset: 'RESET', cv_loop_toggle: 'LOOP',
    asset_pitch: 'ASSET PITCH', asset_gate: 'ASSET GATE', speedCv: 'SPEED',
  });
  const outputs = portsFromDef(videoVarispeedDef.outputs, { audio_l: 'AUDIO L', audio_r: 'AUDIO R' });

  // ---- DOM refs + local state ----
  //
  // 7 <video> elements, one per asset slot. Slot 0 is the MAIN preview
  // element (existing single-video behaviour); slots 1..6 are hidden,
  // preloaded elements in the "Load multiple…" panel. The ACTIVE slot's
  // element is what the engine samples + the transport loop drives; `videoEl`
  // is derived from `activeSlot` so all the existing transport code that
  // reads/mutates `videoEl` automatically follows the active element.
  let slotEls = $state<(HTMLVideoElement | null)[]>(new Array(ASSET_SLOTS).fill(null));
  let activeSlot = $state(0);
  let videoEl = $derived<HTMLVideoElement | null>(slotEls[activeSlot] ?? null);
  // Per-slot object URLs (local bytes; never synced) — index 0 is the single
  // video's url (kept in sync with the legacy `objectUrl` accessor below).
  let slotUrls: (string | null)[] = new Array(ASSET_SLOTS).fill(null);
  // Per-slot local filenames (drives the active card's data-has-local-file).
  let slotNames = $state<(string | null)[]>(new Array(ASSET_SLOTS).fill(null));
  // Per-slot LOCAL duration (seconds), captured from el.duration at
  // `loadedmetadata`. The synced fileMeta.duration can lag a freshly-loaded
  // slot by a frame or two (an unsynced slot reads durationSec=0 → resolveWindow
  // collapses to hasWindow:false → the transport pauses every frame → Play looks
  // dead). Reading the local element duration closes that window race AND lets
  // each inactive slot's VIRTUAL playhead wrap against its own duration so the
  // 7 slots de-sync by their differing lengths (Step 2).
  let slotDuration: number[] = new Array(ASSET_SLOTS).fill(0);
  // Per-slot VIRTUAL playhead (seconds). The ACTIVE slot tracks its element's
  // real currentTime; every OTHER loaded slot advances incrementally each
  // transport tick (dt × signed effective speed, wrapped via decideEdgeAction)
  // so a switch JUMPS the output to the selected clip at ITS live time rather
  // than restarting from 0. Incremental (not closed-form) so it integrates a
  // time-varying SPEED CV and survives loop wraps/clamps without drift.
  let slotPos: number[] = new Array(ASSET_SLOTS).fill(0);
  // Legacy single-video accessors map onto slot 0.
  let objectUrl: string | null = null;
  let localFileName = $state<string | null>(null);
  let isDragOver = $state(false);
  let loadError = $state<string | null>(null);
  // "Load multiple…" panel toggle (right-click on the card).
  let multiOpen = $state(false);

  // ---- Persistence: remembered file handle (Chromium) + re-link fallback ----
  // Mirrors VIDEOBOX: a picked/dropped FileSystemFileHandle is stashed in
  // IndexedDB keyed by an id stamped into fileMeta.handleId; on patch / perf-zip
  // load we reload that exact file (or the seeded blob the zip carried) so the
  // clip plays again WITHOUT a re-pick. Firefox / Safari never produce a handle
  // and fall back to the re-link prompt only.
  const canRememberHandle = canPersistVideoHandles();
  let pendingHandle = $state<StoredFileHandle | null>(null);
  let handleReloadAttempted = false;

  // ---- Reactive reads from data (Yjs-backed) ----
  // Synced 7-slot file meta (parallel to the asset slots). null entries = empty.
  let slotMeta = $derived<(VideoboxFileMeta | null)[]>(
    (node?.data as Partial<VideoVarispeedData> | undefined)?.slotMeta
      ?? new Array(ASSET_SLOTS).fill(null),
  );
  // Legacy single-video fileMeta lives at slot 0 for back-compat; the ACTIVE
  // slot's meta is what the transport readouts (duration / re-link) reflect.
  let baseFileMeta = $derived<VideoboxFileMeta | null>(
    (node?.data as Partial<VideoVarispeedData> | undefined)?.fileMeta ?? null,
  );
  // For slot 0 the legacy single-video `fileMeta` is authoritative (it's what
  // the perf-zip export/restore + handle-reload paths read/write); slots 1..6
  // use the per-slot slotMeta. This keeps slot 0 byte-identical to the
  // pre-asset-selector behaviour.
  let fileMeta = $derived<VideoboxFileMeta | null>(
    activeSlot === 0 ? (baseFileMeta ?? slotMeta[0] ?? null) : (slotMeta[activeSlot] ?? null),
  );
  let isPlaying = $derived<boolean>(
    (node?.data as Partial<VideoVarispeedData> | undefined)?.isPlaying ?? false,
  );
  let durationSec = $derived<number>(fileMeta?.duration ?? 0);
  let loop = $derived<boolean>(
    (node?.data as Partial<VideoVarispeedData> | undefined)?.loop ?? true,
  );

  /** Track whether THIS browser has loaded a local copy of the ACTIVE slot. */
  let hasLocalFile = $derived<boolean>((slotNames[activeSlot] ?? null) !== null);

  // ---- Transport param accessors (knob + sliders live on node.params) ----
  const { defaultFor, paramVal } = cardParams(videoVarispeedDef, () => id, () => node);
  const setParamFn = (k: string) => (v: number): void => {
    setNodeParam(id, k, v);
  };

  // ---- CV-connection detection (CACHED) ----
  //
  // END CV normals to +1 (unpatched END = full duration); START CV normals
  // to 0. We only sum a CV offset into a slider when its port has an incoming
  // edge. The hot rAF loop must NOT scan the patch every frame, so we compute
  // these reactively (recomputed only when the edge set changes) + read the
  // cached booleans in the loop.
  function portConnected(portId: string): boolean {
    for (const e of Object.values(patch.edges)) {
      if (e && e.target.nodeId === id && e.target.portId === portId) return true;
    }
    return false;
  }
  let startCvConnected = $derived<boolean>(
    (void Object.keys(patch.edges).length, portConnected('startCv')),
  );
  let endCvConnected = $derived<boolean>(
    (void Object.keys(patch.edges).length, portConnected('endCv')),
  );

  // ---- Live CV reads from the engine (raw bipolar -1..+1 samples) ----
  function readCv(paramId: string): number {
    const e = engineCtx.get();
    if (!e || !node) return 0;
    const v = e.readParam(node, paramId);
    return typeof v === 'number' ? v : 0;
  }

  // ---- Extras / engine helpers ----
  function getExtras(): VideoVarispeedHandleExtras | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      const ve = e.getDomain<VideoEngine>('video');
      return (ve.read(id, 'extras') as VideoVarispeedHandleExtras | undefined) ?? null;
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

  // ---- data writers ----
  function writePlaying(next: boolean): void {
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      (t.data as Partial<VideoVarispeedData>).isPlaying = next;
    }, LOCAL_ORIGIN);
  }
  function writeFileMeta(meta: VideoboxFileMeta): void {
    // Drop a stale remembered handle in THIS browser's IDB if the id changes
    // (a fresh pick); a reload reuses the same id, so no churn there.
    const prevId = fileMeta?.handleId;
    if (prevId && prevId !== meta.handleId) {
      void deleteVideoFileHandle(prevId);
    }
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      const d = t.data as Partial<VideoVarispeedData>;
      d.fileMeta = meta;
      d.isPlaying = false;
    }, LOCAL_ORIGIN);
  }
  function writeLoop(next: boolean): void {
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      (t.data as Partial<VideoVarispeedData>).loop = next;
    }, LOCAL_ORIGIN);
  }
  function toggleLoop(): void { writeLoop(!loop); }

  // ---- File-picker handling ----
  //
  // `opts.handle` — a FileSystemFileHandle to persist for one-click reload (from
  //   showOpenFilePicker / a drop that exposed getAsFileSystemHandle, or the
  //   synthetic blob-handle the perf-zip loader seeds).
  // `opts.reuseHandleId` — reload from an existing remembered handle: keep the
  //   patch's existing handleId rather than minting a new one.
  async function loadFile(
    file: File,
    opts?: { handle?: StoredFileHandle | null; reuseHandleId?: string },
  ): Promise<void> {
    // Legacy single-load path → slot 0 (the main preview element). Makes
    // slot 0 active so the existing transport drives it.
    await loadFileIntoSlot(0, file, opts);
  }

  /** Load `file` into asset slot `slot`. Slot 0 is the main preview element +
   *  the back-compat single-video write (fileMeta + export resolver); slots
   *  1..6 are the "Load multiple…" preloaded elements (per-slot objectUrl +
   *  slotMeta). When loading the ACTIVE slot, re-wires audio + decodes the
   *  first frame. Per-slot size cap keeps 7 preloaded elements bounded. */
  async function loadFileIntoSlot(
    slot: number,
    file: File,
    opts?: { handle?: StoredFileHandle | null; reuseHandleId?: string },
  ): Promise<void> {
    loadError = null;
    if (slot === activeSlot) pendingHandle = null;
    if (slot < 0 || slot >= ASSET_SLOTS) return;
    if (!file.type.startsWith('video/')) {
      loadError = `Not a video file: ${file.type || file.name}`;
      return;
    }
    if (Number.isFinite(file.size) && file.size > VIDEOVARISPEED_MAX_SLOT_BYTES) {
      loadError = `File too large (max ${Math.round(VIDEOVARISPEED_MAX_SLOT_BYTES / (1024 * 1024))} MB per slot)`;
      return;
    }
    const el = slotEls[slot];
    // Revoke a previous url for THIS slot.
    if (slotUrls[slot]) {
      try { URL.revokeObjectURL(slotUrls[slot]!); } catch { /* */ }
      slotUrls[slot] = null;
    }
    const url = URL.createObjectURL(file);
    slotUrls[slot] = url;
    slotNames[slot] = file.name;
    if (slot === 0) {
      objectUrl = url;
      localFileName = file.name;
    }
    // The portable "Export performance" (.zip) resolver is multi-slot: it
    // resolves EVERY populated slot's bytes (registerSlotExport, once on mount),
    // so all 7 videos travel in the bundle — not just slot 0 (the data-loss bug
    // Fix B repairs). Nothing slot-specific to register here.
    if (!el) return;
    el.src = url;
    el.muted = false;

    await new Promise<void>((resolve) => {
      if (el.readyState >= 1 /* HAVE_METADATA */) { resolve(); return; }
      const onMeta = (): void => { el.removeEventListener('loadedmetadata', onMeta); resolve(); };
      el.addEventListener('loadedmetadata', onMeta, { once: true });
    });

    // Capture the LOCAL duration now (el.duration is authoritative the instant
    // metadata loaded — before the synced fileMeta round-trips). Closes the
    // durationSec=0 window race that left Play looking dead on a fresh slot, and
    // gives each inactive slot's virtual playhead its own loop length.
    slotDuration[slot] = Number.isFinite(el.duration) ? el.duration : 0;
    slotPos[slot] = 0;
    // Keep this (and every other loaded) slot's decode alive even while it's NOT
    // the active source, so a later switch lands on an already-warm element
    // (never the throttled-to-1fps bug). Retries until the engine materializes.
    ensureAllSlotsAlive();

    // Persist the handle (slot 0 only; slots 1..6 keep objectUrl/handle local).
    let handleId: string | undefined = opts?.reuseHandleId;
    if (slot === 0 && opts?.handle && canRememberHandle) {
      if (!handleId) handleId = newVideoFileId();
      await putVideoFileHandle(handleId, opts.handle);
    }

    const meta: VideoboxFileMeta = {
      name: file.name,
      duration: Number.isFinite(el.duration) ? el.duration : 0,
      size: Number.isFinite(file.size) ? file.size : undefined,
      handleId,
    };
    if (slot === 0) writeFileMeta(meta);
    writeSlotMeta(slot, meta);

    // Force a first frame to decode so the output streams immediately even
    // before play (rVFC fires on the first decoded frame) — also satisfies the
    // "preload first frame" requirement for the inactive slots.
    try { el.currentTime = 0; } catch { /* */ }

    if (slot === activeSlot) ensureAudioWired();
  }

  /** Write a per-slot fileMeta into the synced slotMeta array.
   *
   *  Rebuilds the array from PLAIN clones of the existing entries. Reading back
   *  a previously-written entry yields a LIVE Y type (already integrated into
   *  the doc); putting it into the new array and reassigning would throw
   *  "reassigning object that already occurs in the tree" and abort the
   *  transaction — so before this, every slot AFTER the first silently failed
   *  to persist (only slot 0 ever saved). Cloning to plain objects keeps the
   *  whole-array reassign legal. (Same Y-reintegration trap as the sequencer
   *  save-to-slot bug.) */
  function writeSlotMeta(slot: number, meta: VideoboxFileMeta | null): void {
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      const d = t.data as Partial<VideoVarispeedData>;
      const cur = Array.isArray(d.slotMeta) ? d.slotMeta : [];
      const arr: (VideoboxFileMeta | null)[] = [];
      for (let i = 0; i < ASSET_SLOTS; i++) {
        if (i === slot) { arr.push(meta); continue; }
        const e = cur[i] as VideoboxFileMeta | null | undefined;
        // PLAIN clone of any prior entry — never re-insert a live Y type.
        arr.push(e ? { name: e.name, duration: e.duration, size: e.size, handleId: e.handleId } : null);
      }
      d.slotMeta = arr;
    }, LOCAL_ORIGIN);
  }

  // ---- Persistence: reload from a remembered handle on patch / perf-zip load ----
  //
  // After a load, fileMeta may carry a handleId pointing at a handle THIS
  // browser persisted, OR the synthetic blob handle the perf-zip loader seeded
  // (putVideoFileBlob under `bundle-<nodeId>`). Same flow as VIDEOBOX:
  //   - granted  → reload immediately (no re-pick);
  //   - prompt   → stash for a one-click re-allow gesture;
  //   - missing / denied → re-link prompt covers it.
  async function tryReloadFromHandle(): Promise<void> {
    const hid = fileMeta?.handleId;
    if (!hid || hasLocalFile) return;
    const handle = await getVideoFileHandle(hid);
    if (!handle) return; // not in this browser → re-link prompt path
    const perm = await queryHandleReadPermission(handle);
    if (perm === 'granted') {
      try {
        const file = await handle.getFile();
        await loadFile(file, { handle, reuseHandleId: hid });
      } catch { /* file moved/gone — re-link prompt takes over */ }
      return;
    }
    if (perm === 'prompt') pendingHandle = handle;
    // 'denied' → re-link prompt covers it.
  }

  // ---- Per-slot reload on perf-zip / patch load (slots 1..6) ----
  //
  // The portable .zip now carries EVERY populated slot's bytes (Fix B); on load
  // Canvas seeds each into the IDB blob store keyed by that slot's
  // slotMeta[i].handleId. Here each slot whose synced meta carries a handleId
  // that resolves to a (granted) blob handle in THIS browser is auto-loaded —
  // so all 7 videos come back with no re-pick. Slot 0 is handled by
  // tryReloadFromHandle above (it owns the legacy single-video fileMeta path);
  // a granted blob seeded under a slot's handleId wraps as 'granted' (see
  // video-file-store.blobHandleFrom), so cross-machine restore works too. A
  // slot whose handle isn't in this browser (a peer never had that file) is
  // skipped — the slot stays empty (its synced slotMeta still shows the name).
  const slotReloadAttempted = new Array<boolean>(ASSET_SLOTS).fill(false);
  async function tryReloadSlotFromHandle(slot: number): Promise<void> {
    if (slot <= 0 || slot >= ASSET_SLOTS) return; // slot 0 = single-video path
    if (slotHasLocalVideo(slot)) return; // already loaded locally
    const hid = slotMeta[slot]?.handleId;
    if (!hid) return;
    const handle = await getVideoFileHandle(hid);
    if (!handle) return; // not in this browser → stays empty (name still shows)
    const perm = await queryHandleReadPermission(handle);
    if (perm !== 'granted') return; // re-pick covers a lapsed/foreign handle
    try {
      const file = await handle.getFile();
      await loadFileIntoSlot(slot, file, { handle, reuseHandleId: hid });
    } catch { /* file moved/gone — slot stays empty */ }
  }

  // Run each slot's reload once its synced slotMeta.handleId becomes available
  // (mirrors the slot-0 $effect below). Independent per-slot attempt flags so a
  // late-arriving slot still fires.
  $effect(() => {
    for (let i = 1; i < ASSET_SLOTS; i++) {
      const hid = slotMeta[i]?.handleId;
      if (!hid || slotReloadAttempted[i] || slotHasLocalVideo(i)) continue;
      slotReloadAttempted[i] = true;
      void tryReloadSlotFromHandle(i);
    }
  });

  // One-click "re-allow": request read permission inside this click gesture,
  // then reload. Bound to the re-allow button.
  async function onReAllow(): Promise<void> {
    const handle = pendingHandle;
    const hid = fileMeta?.handleId;
    if (!handle) return;
    const perm = await requestHandleReadPermission(handle);
    if (perm === 'granted') {
      pendingHandle = null;
      try {
        const file = await handle.getFile();
        await loadFile(file, { handle, reuseHandleId: hid ?? undefined });
        return;
      } catch { /* fall through to re-link */ }
    }
    pendingHandle = null;
  }

  // Re-link prompt visibility: saved fileMeta exists (a file was loaded at save)
  // but THIS browser has no local copy + no usable handle.
  let showRelinkPrompt = $derived<boolean>(
    !hasLocalFile && fileMeta !== null && pendingHandle === null,
  );

  // Run the handle-reload attempt once fileMeta.handleId becomes available.
  $effect(() => {
    void fileMeta?.handleId;
    if (handleReloadAttempted) return;
    if (!fileMeta?.handleId) return;
    if (hasLocalFile) return;
    handleReloadAttempted = true;
    void tryReloadFromHandle();
  });

  // Wire the element's audio into the engine, RETRYING until it sticks.
  //
  // wireAudio() can no-op for two reasons that are both transient at file-load
  // time: (a) getExtras() returns null because the engine hasn't materialized
  // this card's video node yet (the reconciler runs async to the card, and is
  // slower to settle when a cross-domain audio edge is already present), and
  // (b) the factory's own <video> reference isn't set yet because
  // attachExternalSource (driven by the onMount poll) hasn't run. Calling
  // wireAudio exactly once (the old behaviour) lost this race and left audio_l /
  // audio_r stuck on the silent placeholder forever -> the operator's downstream
  // AUDIO-OUT patch was silent. wireAudio() is idempotent (guards on its own
  // audioWired flag), so retrying until isAudioWired() reports true is safe and
  // converges as soon as both the handle and the element are ready.
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

  // Keep EVERY loaded slot's element decoding (persistent per-element keep-alive
  // in the engine), not just the active one — a melodic/random switch pattern
  // defeats any "active + predicted-next" hybrid, so every loaded slot must stay
  // warm or it throttles to ~1 fps and the switch lands on a frozen frame (the
  // original bug). keepSlotAlive is idempotent per element; retried until the
  // engine has materialized this node (same race ensureAudioWired guards).
  let keepAliveTimer: ReturnType<typeof setTimeout> | null = null;
  function ensureAllSlotsAlive(attempt = 0): void {
    if (keepAliveTimer) { clearTimeout(keepAliveTimer); keepAliveTimer = null; }
    const extras = getExtras();
    let loaded = 0;
    let wired = 0;
    for (let i = 0; i < ASSET_SLOTS; i++) {
      const el = slotEls[i];
      if (!el || (slotNames[i] ?? null) === null) continue;
      loaded++;
      if (extras) { try { extras.keepSlotAlive(el); wired++; } catch { /* not ready */ } }
    }
    if (loaded > 0 && wired === loaded) return; // every loaded slot is warm
    if (attempt >= 50) return; // ~5s of retries; give up quietly
    keepAliveTimer = setTimeout(() => ensureAllSlotsAlive(attempt + 1), 100);
  }

  function onFileInputChange(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    // The native <input type=file> can't hand us a FileSystemFileHandle, so a
    // pick through this path gets no remembered-handle persistence (only
    // fileMeta + the export resolver). The picker button path uses
    // showOpenFilePicker when available to also persist a handle.
    if (file) void loadFile(file);
    try { input.value = ''; } catch { /* */ }
  }

  // Picker button: prefer showOpenFilePicker (Chromium) so we capture a
  // FileSystemFileHandle to remember; fall back to the native <input>.
  async function pickViaPicker(): Promise<boolean> {
    if (!canRememberHandle) return false;
    const picker = (globalThis as {
      showOpenFilePicker?: (opts?: unknown) => Promise<StoredFileHandle[]>;
    }).showOpenFilePicker;
    if (typeof picker !== 'function') return false;
    try {
      const handles = await picker({
        multiple: false,
        types: [{ description: 'Video', accept: { 'video/*': ['.mp4', '.webm', '.mov', '.m4v', '.ogv'] } }],
      });
      const handle = handles?.[0];
      if (!handle) return true; // user cancelled — still "handled"
      const file = await handle.getFile();
      await loadFile(file, { handle });
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') {
        loadError = `Could not open file: ${(e as Error)?.message ?? 'unknown error'}`;
      }
    }
    return true;
  }
  function onPickClick(ev: MouseEvent): void {
    if (!canRememberHandle) return; // let the native <input> handle it
    ev.preventDefault();
    void pickViaPicker();
  }

  function onDragOver(ev: DragEvent): void { ev.preventDefault(); isDragOver = true; }
  function onDragLeave(): void { isDragOver = false; }
  async function onDrop(ev: DragEvent): Promise<void> {
    ev.preventDefault();
    isDragOver = false;
    // Try to grab a FileSystemFileHandle (Chromium) so a dropped file is also
    // remembered for one-click reload.
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

  // ---- "Load multiple…" 7-slot panel (right-click toggle) ------------
  function onCardContextMenu(ev: MouseEvent): void {
    ev.preventDefault();
    multiOpen = !multiOpen;
  }
  let slotLoading = $state<boolean[]>(new Array(ASSET_SLOTS).fill(false));
  async function onSlotFileInputChange(ev: Event, slot: number): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      slotLoading[slot] = true;
      try {
        // Try to capture a FileSystemFileHandle on Chromium for slot 0 reload;
        // slots 1..6 keep objectUrl-only (re-link prompt covers reload).
        await loadFileIntoSlot(slot, file);
      } finally {
        slotLoading[slot] = false;
      }
    }
    try { input.value = ''; } catch { /* */ }
  }
  function clearSlot(slot: number): void {
    if (slot < 0 || slot >= ASSET_SLOTS) return;
    const el = slotEls[slot];
    if (el) { try { el.pause(); el.removeAttribute('src'); el.load(); } catch { /* */ } }
    if (slotUrls[slot]) {
      try { URL.revokeObjectURL(slotUrls[slot]!); } catch { /* */ }
      slotUrls[slot] = null;
    }
    slotNames[slot] = null;
    slotDuration[slot] = 0;
    slotPos[slot] = 0;
    if (slot === 0) { objectUrl = null; localFileName = null; }
    writeSlotMeta(slot, null);
    // If we cleared the ACTIVE slot, fall back to slot 0 if it has a video.
    if (slot === activeSlot && slot !== 0 && slotHasLocalVideo(0)) selectAssetSlot(0);
  }

  // ---- Transport window + speed helpers (live, CV-summed) ----
  function effectiveSpeed(): number {
    return speedKnobToMultiplier(
      effectiveSpeedKnob(paramVal('speed'), readCv('speedCv')),
    );
  }
  /** Effective duration of slot `i`: prefer the LOCAL element duration (set at
   *  loadedmetadata) and fall back to the synced fileMeta — closes the
   *  durationSec=0 race where a fresh slot's synced meta hasn't arrived yet
   *  (which collapsed resolveWindow → Play looked dead). */
  function slotDurationSec(i: number): number {
    const local = slotDuration[i] ?? 0;
    if (Number.isFinite(local) && local > 0) return local;
    if (i === activeSlot && Number.isFinite(durationSec) && durationSec > 0) return durationSec;
    const el = slotEls[i];
    return el && Number.isFinite(el.duration) ? el.duration : 0;
  }
  /** Resolve the playback window for a given duration with the live (CV-summed)
   *  START/END. Shared by the active transport + every slot's virtual playhead
   *  so they wrap on the SAME [start,end] (slots de-sync purely by duration). */
  function windowForDuration(dur: number) {
    const startFrac = effectiveStartFraction(paramVal('start'), readCv('startCv'), startCvConnected);
    const endFrac = effectiveEndFraction(paramVal('end'), readCv('endCv'), endCvConnected);
    return resolveWindow(dur, startFrac, endFrac);
  }
  function currentWindow() {
    return windowForDuration(slotDurationSec(activeSlot));
  }

  // ---- Play / pause / seek (manual UI) ----
  function togglePlay(): void {
    // A click always re-arms the transport: clear the render-local one-shot
    // latch so a Play after a one-shot ended actually plays again (and so the
    // latch can never silently swallow the user's intent).
    oneShotEnded = false;
    if (!videoEl) { writePlaying(!isPlaying); return; }
    writePlaying(!isPlaying);
  }
  function onSeek(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const target = Number(input.value);
    if (!Number.isFinite(target)) return;
    oneShotEnded = false; // scrubbing re-arms a one-shot that ran out
    slotPos[activeSlot] = target;
    if (videoEl && hasLocalFile) { try { videoEl.currentTime = target; } catch { /* */ } }
  }

  // ---- Gate actions ----
  function gateStart(): void {
    oneShotEnded = false; // a START gate re-arms a one-shot that ran out
    const w = currentWindow();
    const pos = w.hasWindow ? w.startSec : (videoEl?.currentTime ?? 0);
    if (videoEl && hasLocalFile) { try { videoEl.currentTime = pos; } catch { /* */ } }
    if (w.hasWindow) slotPos[activeSlot] = pos;
    writePlaying(w.hasWindow);
  }
  function gatePause(): void {
    oneShotEnded = false; // un-pausing re-arms; pausing is the normal toggle
    writePlaying(!isPlaying);
  }
  function gateReset(): void {
    const w = currentWindow();
    const pos = w.hasWindow ? w.startSec : 0;
    if (videoEl && hasLocalFile) { try { videoEl.currentTime = pos; } catch { /* */ } }
    slotPos[activeSlot] = pos;
  }

  // ---- Asset slot select (gate-driven) -------------------------------
  //
  // True iff slot `i` has a LOCAL video element with a loaded source — only
  // then can we make it active (a peer that hasn't re-linked that slot ignores
  // the switch + keeps its current display).
  function slotHasLocalVideo(i: number): boolean {
    return i >= 0 && i < ASSET_SLOTS && (slotNames[i] ?? null) !== null && slotEls[i] != null;
  }

  // Make slot `i` the active source: attach its element to the engine, JUMP the
  // output to that slot's LIVE virtual time (slotPos[i]) — not 0 — play if the
  // transport is playing, and re-point audio to the new element. Switching
  // therefore lands on the selected clip at its current position (clips loop +
  // de-sync via their differing durations), which is the user's ideal. No-op if
  // the slot has no local video.
  //
  // We do NOT tear down the OUTGOING element's audio keep-alive (the engine's
  // per-element keep-alive registry persists it) — that's what stops the
  // switched-away slot from throttling to ~1fps and stops a later re-select from
  // re-creating the once-per-element MediaElementSource (the multi-slot stall).
  function selectAssetSlot(i: number): void {
    if (!slotHasLocalVideo(i)) return;
    if (i === activeSlot) {
      // Already active — a re-trigger RESTARTS this slot from its window start
      // (a fresh strike of the same clip), syncing the virtual playhead.
      const el = slotEls[i];
      const w = windowForDuration(slotDurationSec(i));
      const pos = w.hasWindow ? w.startSec : 0;
      slotPos[i] = pos;
      if (el) { try { el.currentTime = pos; } catch { /* */ } }
      return;
    }
    const prev = slotEls[activeSlot];
    const next = slotEls[i];
    // Snapshot the OUTGOING element's REAL currentTime into its accumulator so a
    // switch BACK to it later resumes on the right frame (the active slot's
    // virtual playhead == its element's real time while it was on air).
    if (prev && Number.isFinite(prev.currentTime)) slotPos[activeSlot] = prev.currentTime;
    if (prev && !prev.paused) { try { prev.pause(); } catch { /* */ } }
    activeSlot = i;
    if (next) {
      // JUMP to the slot's live virtual time (clamped into its window).
      const w = windowForDuration(slotDurationSec(i));
      let pos = slotPos[i] ?? 0;
      if (w.hasWindow) pos = Math.min(Math.max(pos, w.startSec), w.endSec);
      slotPos[i] = pos;
      try { next.currentTime = pos; } catch { /* */ }
      if (isPlaying && effectiveSpeed() >= 0) {
        void next.play().catch(() => { /* autoplay */ });
      }
    }
    // Re-attach the engine source to the new element + re-point audio to it.
    // wireAudio() is idempotent + re-points audio_l/r to the now-active
    // element's persistent splitter (audio follows the switched video).
    const ve = videoEngine();
    try { ve?.attachExternalSource(id, 'video', next ?? null); } catch { /* */ }
    ensureAudioWired();
  }

  // ---- Gate input edge detection (rising-edge, polled) ----
  const lastGate: Record<string, number> = {
    cv_start: 0, cv_pause: 0, cv_reset: 0, cv_loop_toggle: 0, asset_gate: 0,
  };
  function risingEdge(paramId: string): boolean {
    const v = readCv(paramId);
    const prev = lastGate[paramId] ?? 0;
    lastGate[paramId] = v;
    return prev < 0.5 && v >= 0.5;
  }
  let gateTimer: ReturnType<typeof setInterval> | null = null;
  function startGateLoop(): void {
    if (gateTimer !== null) return;
    gateTimer = setInterval(() => {
      const e = engineCtx.get();
      if (!e || !node) return;
      if (risingEdge('cv_start')) gateStart();
      if (risingEdge('cv_pause')) gatePause();
      if (risingEdge('cv_reset')) gateReset();
      if (risingEdge('cv_loop_toggle')) toggleLoop();
      // Asset selector: on a rising edge read the raw asset_pitch V/oct, map
      // it to a slot, and switch IF that slot holds a local video (black-key
      // pitch → null → ignore; empty/unlinked slot → ignore).
      if (risingEdge('asset_gate')) {
        const slot = slotForVOct(readCv('asset_pitch'));
        if (slot != null && slotHasLocalVideo(slot)) selectAssetSlot(slot);
      }
    }, 33);
  }
  function stopGateLoop(): void {
    if (gateTimer !== null) { clearInterval(gateTimer); gateTimer = null; }
  }

  // ---- Transport loop (rAF-driven): varispeed + window + loop/oneshot ----
  //
  // Forward varispeed: set <video>.playbackRate; the element advances itself.
  // Reverse: THROTTLED currentTime scrub (~10 Hz via reverseScrubStep) — NOT
  // per-frame; per-frame scrubbing is what killed #291's perf + froze the
  // downstream texture. The rAF loop only does cheap arithmetic + at most one
  // playbackRate write or one throttled seek per tick — no per-frame
  // allocations, no per-frame patch scans (CV-connection booleans are cached).
  let raf: number | null = null;
  let reverseActive = false;
  let reverseAccumMs = 0;
  let lastRafMs = 0;
  // RENDER-LOCAL one-shot latch. When a ONE-SHOT clip reaches END we must STOP
  // it, but we MUST NOT writePlaying(false) from inside this rAF loop: a live
  // SyncedStore write per frame is the cv-modulation write-storm bug class, and
  // worse, it can race + overwrite a Play click the user just made. Instead we
  // hold the element paused via this transient flag (never synced). togglePlay /
  // gateStart clear it so a fresh Play re-arms the transport. isPlaying stays
  // true (the user's intent); the latch just gates auto-play until re-triggered.
  let oneShotEnded = false;

  /** Advance every loaded NON-active slot's VIRTUAL playhead by `dt` at the
   *  current signed speed, wrapping each against its own duration. Keeps the
   *  inactive clips "running" so a switch jumps to a de-synced live position
   *  (clips loop independently by their differing lengths). Pure bookkeeping —
   *  no element/DOM/store writes (the inactive elements stay paused + warm). */
  function advanceVirtualPlayheads(dtMs: number, speed: number): void {
    if (!isPlaying || oneShotEnded || dtMs <= 0) return;
    const dtSec = dtMs / 1000;
    for (let i = 0; i < ASSET_SLOTS; i++) {
      if (i === activeSlot) continue;
      if ((slotNames[i] ?? null) === null) continue; // empty slot
      const dur = slotDurationSec(i);
      const w = windowForDuration(dur);
      if (!w.hasWindow) continue;
      const forward = speed >= 0;
      let pos = (slotPos[i] ?? 0) + speed * dtSec; // signed advance
      const action = decideEdgeAction(pos, w, forward, loop);
      if (action.kind === 'loop') pos = action.seekTo;
      else if (action.kind === 'stop') pos = action.clampTo;
      else pos = Math.min(Math.max(pos, w.startSec), w.endSec);
      slotPos[i] = pos;
    }
  }

  function transportTick(nowMs: number): void {
    raf = requestAnimationFrame(transportTick);
    if (!videoEl || !hasLocalFile) { lastRafMs = nowMs; return; }
    const dt = lastRafMs === 0 ? 0 : Math.max(0, nowMs - lastRafMs);
    lastRafMs = nowMs;

    const speed = effectiveSpeed();
    const w = currentWindow();

    // Keep the ACTIVE slot's virtual playhead synced to its element's real time
    // (so a switch-AWAY snapshots the right frame), and advance the inactive
    // slots' virtual playheads so they de-sync.
    if (Number.isFinite(videoEl.currentTime)) slotPos[activeSlot] = videoEl.currentTime;
    advanceVirtualPlayheads(dt, speed);

    // Empty window (START past END) -> no playback: hold the element paused.
    if (!w.hasWindow) {
      if (!videoEl.paused) { try { videoEl.pause(); } catch { /* */ } }
      return;
    }

    const forward = speed >= 0;

    // Reverse-mode bookkeeping (mute audio while reversing; pause native).
    if (!forward && !reverseActive) {
      reverseActive = true;
      reverseAccumMs = 0;
      videoEl.muted = true;
      try { videoEl.pause(); } catch { /* */ }
    } else if (forward && reverseActive) {
      reverseActive = false;
      videoEl.muted = false;
    }

    // Not playing, OR a one-shot already ran out: hold paused, don't auto-play.
    if (!isPlaying || oneShotEnded) return;

    if (forward) {
      const rate = Math.max(0.0625, Math.min(16, speed));
      if (Math.abs(videoEl.playbackRate - rate) > 0.001) {
        try { videoEl.playbackRate = rate; } catch { /* */ }
      }
      if (videoEl.paused) void videoEl.play().catch(() => { /* autoplay */ });
    } else {
      // Throttled reverse scrub: accumulate elapsed ms, seek at most once per
      // REVERSE_SCRUB_INTERVAL_MS. Each seek covers the accumulated ground so
      // the average reverse rate stays correct while issuing ~10 seeks/sec.
      reverseAccumMs += dt;
      const step = reverseScrubStep(videoEl.currentTime, Math.abs(speed), reverseAccumMs, w.startSec);
      if (step.seek) {
        reverseAccumMs = 0;
        try { videoEl.currentTime = step.toSec; } catch { /* */ }
      }
    }

    // Window edge: loop vs one-shot.
    const action = decideEdgeAction(videoEl.currentTime, w, forward, loop);
    if (action.kind === 'loop') {
      try { videoEl.currentTime = action.seekTo; } catch { /* */ }
      slotPos[activeSlot] = action.seekTo;
      if (forward && videoEl.paused) void videoEl.play().catch(() => { /* */ });
    } else if (action.kind === 'stop') {
      try { videoEl.currentTime = action.clampTo; } catch { /* */ }
      try { videoEl.pause(); } catch { /* */ }
      slotPos[activeSlot] = action.clampTo;
      // Render-local latch ONLY — NOT writePlaying(false) (see oneShotEnded).
      oneShotEnded = true;
    }
  }
  function startTransportLoop(): void {
    if (raf !== null) return;
    lastRafMs = 0;
    raf = requestAnimationFrame(transportTick);
  }
  function stopTransportLoop(): void {
    if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
  }

  // ---- Sync data.isPlaying -> element play/pause (manual + gate) ----
  // LOOP can never "end", so re-enabling LOOP clears a stale one-shot latch.
  $effect(() => {
    if (loop) oneShotEnded = false;
  });
  $effect(() => {
    void isPlaying;
    if (!videoEl || !hasLocalFile) return;
    const speed = effectiveSpeed();
    // Don't auto-play a one-shot that already ran out (the render-local latch);
    // a Play click / START gate clears it first.
    if (isPlaying && !oneShotEnded && videoEl.paused && speed >= 0) {
      void videoEl.play().catch(() => { /* autoplay blocked */ });
    } else if (!isPlaying && !videoEl.paused) {
      try { videoEl.pause(); } catch { /* */ }
    }
  });

  /** Resolve ALL populated slots' bytes for the portable "Export performance"
   *  (.zip) path. Each slot's bytes live ONLY in its local object URL (never on
   *  node.data — only per-slot fileMeta syncs), so we fetch each loaded URL. The
   *  registry flattens the array to one media entry per slot, each tagged with
   *  its `slot` index so the loader restores it into the matching slot. Returns
   *  null when nothing is loaded. Registered ONCE on mount; it reads the live
   *  slotUrls/slotNames each export, so it always reflects the current state. */
  async function resolveAllSlotBytes() {
    const out: { bytes: Uint8Array; name: string; slot: number }[] = [];
    for (let i = 0; i < ASSET_SLOTS; i++) {
      const u = slotUrls[i];
      if (!u) continue;
      try {
        const resp = await fetch(u);
        const ab = await (await resp.blob()).arrayBuffer();
        const bytes = new Uint8Array(ab);
        if (bytes.length === 0) continue;
        out.push({ bytes, name: slotNames[i] ?? `slot-${i}.mp4`, slot: i });
      } catch { /* revoked/torn-down URL — skip this slot */ }
    }
    return out.length > 0 ? out : null;
  }

  // ---- Mount / unmount ----
  onMount(() => {
    // Register the multi-slot bytes resolver for the portable .zip export. Done
    // once on mount (not per slot-0 load) so EVERY populated slot travels in the
    // bundle — the Fix B repair for "7 videos in, 1 video out".
    registerVideoExport(id, resolveAllSlotBytes);

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

    startGateLoop();
    startTransportLoop();
  });

  onDestroy(() => {
    stopGateLoop();
    stopTransportLoop();
    if (audioWireTimer) { clearTimeout(audioWireTimer); audioWireTimer = null; }
    if (keepAliveTimer) { clearTimeout(keepAliveTimer); keepAliveTimer = null; }
    const ve = videoEngine();
    try { ve?.attachExternalSource(id, 'video', null); } catch { /* */ }
    const extras = getExtras();
    extras?.unwireAudio();
    unregisterVideoExport(id);
    // Revoke every per-slot object URL (slot 0 == objectUrl).
    for (let i = 0; i < ASSET_SLOTS; i++) {
      if (slotUrls[i]) {
        try { URL.revokeObjectURL(slotUrls[i]!); } catch { /* */ }
        slotUrls[i] = null;
      }
    }
    objectUrl = null;
  });

  // ---- Displayed current position ----
  let displayPos = $state(0);
  let displayTimer: ReturnType<typeof setInterval> | null = null;
  function refreshDisplay(): void {
    if (videoEl && hasLocalFile) { displayPos = videoEl.currentTime; return; }
    displayPos = 0;
  }
  onMount(() => { displayTimer = setInterval(refreshDisplay, 100); });
  onDestroy(() => { if (displayTimer !== null) clearInterval(displayTimer); });

  function formatTime(s: number): string {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const mm = Math.floor(s / 60);
    const ss = Math.floor(s % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  }

  // ---- Reactive transport readouts ----
  let speedMult = $derived(
    speedKnobToMultiplier(effectiveSpeedKnob(paramVal('speed'), readCv('speedCv'))),
  );
  let speedLabel = $derived(`${speedMult >= 0 ? '+' : ''}${speedMult.toFixed(1)}×`);
  let windowValid = $derived(
    resolveWindow(durationSec || 1, paramVal('start'), paramVal('end')).hasWindow,
  );
</script>

<div
  class="vcard card video videovarispeed-card"
  class:drag-over={isDragOver}
  data-testid="videovarispeed-card"
  data-has-local-file={hasLocalFile}
  data-is-playing={isPlaying}
  data-loop={loop}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  oncontextmenu={onCardContextMenu}
  data-active-slot={activeSlot}
  role="region"
  aria-label="VIDEOVARISPEED video player"
>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="VIDEOVARISPEED" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
  <div class="body">
    <div class="preview-wrap" data-testid="videovarispeed-preview">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={slotEls[0]} data-testid="videovarispeed-video" playsinline></video>
      {#if !hasLocalFile && !fileMeta}
        <div class="overlay drop-hint" data-testid="videovarispeed-drop-hint">
          <div>Drop a video file</div>
          <div class="sub">or click to select</div>
        </div>
      {:else if !hasLocalFile && pendingHandle}
        <!-- One-click re-allow: a remembered handle exists but its read
             permission lapsed. Re-grant + reload in a single user gesture. -->
        <div class="overlay reallow-hint" data-testid="videovarispeed-reallow-hint">
          <div><strong>{fileMeta?.name}</strong></div>
          <button
            type="button"
            class="reallow-btn"
            onclick={onReAllow}
            data-testid="videovarispeed-reallow-btn"
          >Click to re-allow {fileMeta?.name}</button>
        </div>
      {:else if showRelinkPrompt}
        <!-- Re-link fallback (no usable handle / cross-machine): re-pick the
             clip. On Chromium onPickClick uses showOpenFilePicker so the
             re-picked file gets a fresh remembered handle. -->
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
        <label
          class="overlay relink-hint"
          data-testid="videovarispeed-relink-hint"
          onclick={onPickClick}
        >
          <input type="file" accept="video/*" onchange={onFileInputChange} data-testid="videovarispeed-relink-input" />
          <div class="relink-label">Re-link: drop "{fileMeta?.name}"</div>
        </label>
      {/if}
    </div>

    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
    <label class="pick-btn" data-testid="videovarispeed-pick-label" onclick={onPickClick}>
      <input
        type="file"
        accept="video/*"
        onchange={onFileInputChange}
        data-testid="videovarispeed-file-input"
      />
      <span>{hasLocalFile ? 'Pick another video…' : 'Choose video…'}</span>
    </label>

    {#if loadError}
      <div class="error" data-testid="videovarispeed-error">{loadError}</div>
    {/if}

    <div class="transport">
      <button
        type="button"
        class="play-btn"
        onclick={togglePlay}
        data-testid="videovarispeed-play-btn"
        aria-pressed={isPlaying}
      >{isPlaying ? 'Pause' : 'Play'}</button>
      <span class="time" data-testid="videovarispeed-time">
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
      data-testid="videovarispeed-seek"
      aria-label="Video playhead"
    />

    <div class="speed-row">
      <div class="knob-box">
        <Knob
          value={paramVal('speed')}
          min={0} max={1} defaultValue={defaultFor('speed')}
          label="SPEED" curve="linear"
          onchange={setParamFn('speed')} moduleId={id} paramId="speed"
        />
        <div class="speed-readout" data-testid="videovarispeed-speed-readout">{speedLabel}</div>
      </div>
      <button
        type="button"
        class="loop-btn"
        class:on={loop}
        onclick={toggleLoop}
        data-testid="videovarispeed-loop-btn"
        aria-pressed={loop}
        title="Toggle LOOP (jump to START at END) vs ONE-SHOT (stop at END)"
      >{loop ? 'LOOP' : '1-SHOT'}</button>
    </div>

    <div class="window-row">
      <label class="slider-label" for="vvs-start-{id}">START</label>
      <input
        id="vvs-start-{id}"
        class="window-slider"
        type="range"
        min="0" max="1" step="0.001"
        value={paramVal('start')}
        oninput={(e) => setParamFn('start')(Number((e.target as HTMLInputElement).value))}
        data-testid="videovarispeed-start"
        aria-label="Playback window start"
      />
    </div>
    <div class="window-row">
      <label class="slider-label" for="vvs-end-{id}">END</label>
      <input
        id="vvs-end-{id}"
        class="window-slider"
        type="range"
        min="0" max="1" step="0.001"
        value={paramVal('end')}
        oninput={(e) => setParamFn('end')(Number((e.target as HTMLInputElement).value))}
        data-testid="videovarispeed-end"
        aria-label="Playback window end"
      />
    </div>
    {#if !windowValid}
      <div class="warn" data-testid="videovarispeed-window-warn">START past END — no playback</div>
    {/if}

    {#if fileMeta}
      <div class="filename" title={fileMeta.name} data-testid="videovarispeed-filename">
        {fileMeta.name}
      </div>
    {/if}

    <!-- Hidden preloaded <video> elements for slots 1..6 (slot 0 is the main
         preview above). Each is bound so loadFileIntoSlot can drive it +
         attachExternalSource can sample it once it becomes active. They stay
         off-screen but resident so a gate switch is an instant element swap. -->
    <div class="slot-pool" aria-hidden="true">
      {#each [1, 2, 3, 4, 5, 6] as si (si)}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video bind:this={slotEls[si]} data-testid="videovarispeed-slot-video-{si}" playsinline muted></video>
      {/each}
    </div>

    {#if multiOpen}
      <!-- "Load multiple…" 7-slot panel. Right-click the card to toggle. Each
           row maps to a note (C..B) → asset slot; a clip player's note/gate
           output switches which slot plays (restarting from 0). -->
      <div class="multi-panel" data-testid="videovarispeed-multi-panel">
        <div class="multi-head">
          <span>Load multiple… (max {Math.round(VIDEOVARISPEED_MAX_SLOT_BYTES / (1024 * 1024))} MB/slot)</span>
          <button type="button" class="multi-close" onclick={() => (multiOpen = false)} data-testid="videovarispeed-multi-close" aria-label="Close">✕</button>
        </div>
        {#each ASSET_SLOT_LABELS as label, i (i)}
          <!-- data-slot-local: true once THIS browser holds the slot's bytes
               (slotNames[i] set), distinct from the synced slotMeta name a peer
               who never had the file would still show. The perf-zip round-trip
               e2e asserts on this to prove the BYTES reloaded, not just meta. -->
          <div class="slot-row" class:active={i === activeSlot} data-testid="videovarispeed-slot-{i}" data-slot-local={(slotNames[i] ?? null) !== null}>
            <span class="slot-note">{label}</span>
            <label class="slot-load">
              <input type="file" accept="video/*" onchange={(e) => onSlotFileInputChange(e, i)} data-testid="videovarispeed-slot-input-{i}" />
              <span>{slotLoading[i] ? '…' : 'Load video…'}</span>
            </label>
            <span class="slot-name" title={slotNames[i] ?? (slotMeta[i]?.name ?? '')} data-testid="videovarispeed-slot-name-{i}">{slotNames[i] ?? slotMeta[i]?.name ?? '—'}</span>
            {#if slotNames[i] || slotMeta[i]}
              <button type="button" class="slot-clear" onclick={() => clearSlot(i)} data-testid="videovarispeed-slot-clear-{i}" aria-label="Clear slot {label}">✕</button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 320px;
    min-height: 420px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .card.drag-over {
    border-color: var(--cable-video);
    box-shadow: 0 0 0 2px var(--cable-video), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
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
    min-height: 140px;
    aspect-ratio: 16 / 9;
    overflow: hidden;
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
  .overlay .sub { color: var(--text-dim); font-size: 0.6rem; }
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
  .pick-btn:hover { color: var(--text); border-color: #6a7282; }

  .error { font-size: 0.6rem; color: #ff6b6b; font-family: ui-monospace, monospace; }

  .transport { display: flex; align-items: center; gap: 8px; }
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
  .time { font-size: 0.65rem; color: var(--text-dim); font-family: ui-monospace, monospace; }

  .seek { width: 100%; accent-color: var(--cable-video); }
  .seek:disabled { opacity: 0.5; }

  .filename {
    font-size: 0.6rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .speed-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 4px;
  }
  .knob-box { display: flex; flex-direction: column; align-items: center; gap: 2px; }
  .speed-readout {
    font-family: ui-monospace, monospace;
    font-size: 0.6rem;
    color: var(--text-dim);
    letter-spacing: 0.05em;
    min-width: 52px;
    text-align: center;
  }
  .loop-btn {
    background: var(--module-bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.65rem;
    letter-spacing: 0.06em;
    padding: 5px 10px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
    min-width: 56px;
  }
  .loop-btn:hover { border-color: var(--accent-dim); }
  .loop-btn.on {
    background: rgba(135, 200, 255, 0.2);
    color: #87c8ff;
    border-color: #87c8ff;
  }
  .window-row { display: flex; align-items: center; gap: 8px; }
  .slider-label {
    font-size: 0.55rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    width: 36px;
    flex: none;
  }
  .window-slider { flex: 1; accent-color: var(--cable-cv); }
  .warn { font-size: 0.6rem; color: #ffb347; font-family: ui-monospace, monospace; }

  /* Hidden preloaded slot <video> elements (slots 1..6). Resident but
     off-layout; the active element renders via the engine FBO, not here. */
  .slot-pool { position: absolute; width: 0; height: 0; overflow: hidden; pointer-events: none; }
  .slot-pool video { width: 1px; height: 1px; }

  /* "Load multiple…" 7-slot panel (right-click toggle). Floats as an absolute
     overlay sheet over the card body INSTEAD of stacking in normal flow: the
     card is pinned to an exact rack-unit height (height + min/max-height locked
     by `.rack-sized` in _module-card.css) with `overflow: hidden`, so an
     in-flow panel pushed past the tier and its bottom rows (slots A/B) were
     clipped. As an overlay it sits within the fixed card box and scrolls if it
     ever exceeds it. */
  .multi-panel {
    position: absolute;
    left: 8px;
    right: 8px;
    top: 34px; /* below the card title */
    max-height: calc(100% - 42px); /* never exceed the card; scroll if it would */
    z-index: 6;
    padding: 6px;
    background: #0c0f14;
    border: 1px solid var(--cable-video);
    border-radius: 2px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    overflow-y: auto;
  }
  .multi-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.58rem;
    color: var(--cable-video);
    font-family: ui-monospace, monospace;
    letter-spacing: 0.03em;
    margin-bottom: 2px;
  }
  .multi-close, .slot-clear {
    background: none;
    border: none;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 0.65rem;
    padding: 0 2px;
    line-height: 1;
  }
  .multi-close:hover, .slot-clear:hover { color: #ff6b6b; }
  .slot-row {
    display: grid;
    grid-template-columns: 14px auto 1fr 14px;
    align-items: center;
    gap: 5px;
  }
  .slot-row.active .slot-note { color: #87c8ff; }
  .slot-note {
    font-size: 0.65rem;
    font-weight: 600;
    color: var(--cable-video);
    font-family: ui-monospace, monospace;
    text-align: center;
  }
  .slot-load {
    display: inline-block;
    padding: 1px 6px;
    background: var(--cable-video);
    color: #000;
    border-radius: 2px;
    font-size: 0.55rem;
    cursor: pointer;
    user-select: none;
  }
  .slot-load input { display: none; }
  .slot-name {
    font-size: 0.55rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
