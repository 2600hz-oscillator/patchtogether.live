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
  import { nodeMedia, type NodeMediaLease } from '$lib/ui/media/node-media-registry';
  import { nodeVarispeed } from '$lib/ui/media/node-varispeed.svelte';
  import {
    registerVideoExport,
    unregisterVideoExport,
  } from '$lib/video/video-export-registry';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';
  import CropOverlay from '$lib/ui/video/CropOverlay.svelte';
  import { videoAspectStore } from '$lib/ui/video-aspect-store.svelte';
  import { defaultCropRect, refitCrop, type CropRect } from '$lib/video/crop-core';
  import { writeCrop as commitCrop, readCrop } from './crop-edit';
  import { testHooksEnabled } from '$lib/dev/test-hooks';

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
  // All 7 elements belong to the NODE, not to this card: they live in
  // $lib/ui/media/node-media-registry and are ADOPTED into `slotHosts[i]`
  // while this card is mounted. Expand/collapse moves the card between the
  // headless host and the dock full-view — two different MOUNTS — and the
  // pre-fix card destroyed all 7 elements and revoked all 7 object URLs on
  // every such move, which is the owner-reported "stops playing when
  // collapsed". See the registry header for the measurement.
  let slotHosts = $state<(HTMLDivElement | null)[]>(new Array(ASSET_SLOTS).fill(null));
  let slotEls = $state<(HTMLVideoElement | null)[]>(new Array(ASSET_SLOTS).fill(null));
  // ⚠ READ FROM THE CONTROLLER, NEVER CARD STATE (LEG-02 P2, #1511). This was
  // `$state(0)` with no persistence path anywhere — not `node.data`, not the
  // Y.Doc, not a registry — so every card remount snapped the player back to
  // slot 0. An expand or a collapse IS a remount (the card moves between the
  // headless host and the dock tray), so switching to slot 3 and expanding put
  // you back on slot 0 from the top. Node-owned state cannot be reset by a view
  // appearing or disappearing.
  let activeSlot = $derived(nodeVarispeed.view(id).activeSlot);
  let videoEl = $derived<HTMLVideoElement | null>(slotEls[activeSlot] ?? null);
  /** Registry key for asset slot `i`. Per-slot object URLs (local bytes, never
   *  synced) are owned by the registry under these keys — this card reads them
   *  via `nodeMedia.objectUrl` and NEVER revokes one. */
  const slotKey = (i: number): string => `slot${i}`;
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

  // ---- CROP output state -------------------------------------------------
  //
  // The crop rect is SYNCED node.data.crop (per-NODE, not per-slot — slot ops
  // never touch it). It's aspect-locked to the live OUTPUT aspect: the crop
  // region always has the 16:9/4:3 output shape and the CROP output re-samples
  // it scaled to full output resolution (a zoom). Read only through coerceCrop
  // (clamps + fits into frame). `cropEditing` is LOCAL UI state (the overlay is
  // shown only while editing — the default card face is unchanged).
  let outAspect = $derived<number>(
    videoAspectStore.engineRes.height > 0
      ? videoAspectStore.engineRes.width / videoAspectStore.engineRes.height
      : 4 / 3,
  );
  let cropState = $derived(readCrop(node, outAspect, outAspect));
  let cropActive = $derived<boolean>(cropState.active);
  let cropEditing = $state(false);

  /** "add crop" — drop a centered default rect + open the editor overlay. */
  function addCrop(): void {
    commitCrop(id, true, defaultCropRect(outAspect, outAspect));
    cropEditing = true;
  }
  /** "remove crop" — return the CROP output to full-frame passthrough. */
  function removeCrop(): void {
    commitCrop(id, false, cropState.rect);
    cropEditing = false;
  }
  function toggleCropEdit(): void { cropEditing = !cropEditing; }
  /** Overlay drag/resize callback — persist the new (already-fitted) rect. */
  function onCropChange(next: CropRect): void { commitCrop(id, true, next); }

  // Push the live crop rect into the engine (null ⇒ passthrough), RETRYING
  // until the engine materialized this node (same race ensureAudioWired guards).
  /** The persisted crop is pushed by the NODE's controller — including at node
   *  creation, which is what makes a rack saved WITH a crop apply it on load
   *  even though no card mounts. This only tells the controller the value moved. */
  function pushCrop(): void {
    nodeVarispeed.request(id, { kind: 'cropChanged' });
  }
  // Re-push whenever the crop rect / active flag changes (reactive).
  $effect(() => {
    void cropState.active; void cropState.rect.x; void cropState.rect.y; void cropState.rect.w;
    pushCrop();
  });
  // On an OUTPUT aspect flip (16:9↔4:3): re-fit the stored rect (preserve
  // center + width, recompute height, clamp) and persist if it actually moved,
  // so the synced value stays valid for the new aspect. Guarded to avoid a
  // write-storm (only writes on a real change).
  let lastRefitAspect = 0;
  $effect(() => {
    const a = outAspect;
    if (!cropActive) { lastRefitAspect = a; return; }
    if (a === lastRefitAspect) return;
    lastRefitAspect = a;
    const fitted = refitCrop(cropState.rect, a, a);
    if (
      Math.abs(fitted.x - cropState.rect.x) > 1e-6 ||
      Math.abs(fitted.y - cropState.rect.y) > 1e-6 ||
      Math.abs(fitted.w - cropState.rect.w) > 1e-6
    ) {
      commitCrop(id, true, fitted);
    }
  });

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
      // NOTE: this deliberately does NOT reset `isPlaying`. It used to, which
      // is a SECOND, independent cause of "it stopped playing": the IndexedDB
      // handle-reload path runs through loadFile → writeFileMeta, so a card
      // that restored its own file came back PAUSED even when the node's
      // synced state said it was playing. Play state belongs to the transport
      // (writePlaying), not to a metadata write. A genuinely NEW file still
      // pauses — `loadFileIntoSlot` is only reached from an explicit user load,
      // which sets the transport state itself.
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
    // Hand the new url to the NODE-owned registry: it revokes THIS slot's
    // previous url and keeps the new one alive across card unmounts.
    const url = URL.createObjectURL(file);
    nodeMedia.setObjectUrl(id, slotKey(slot), url, file.name);
    slotNames[slot] = file.name;
    if (slot === 0) {
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
    // Keep this (and every other loaded) slot's decode alive even while it's NOT
    // the active source, so a later switch lands on an already-warm element
    // (never the throttled-to-1fps bug). Retries until the engine materializes.
    nodeVarispeed.request(id, { kind: 'slotLoaded', slot });

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

    nodeVarispeed.request(id, { kind: 'slotLoaded', slot });
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
  // the engine-side attach (driven by the controller's retry) hasn't run. Calling
  // wireAudio exactly once (the old behaviour) lost this race and left audio_l /
  // audio_r stuck on the silent placeholder forever -> the operator's downstream
  // AUDIO-OUT patch was silent. wireAudio() is idempotent (guards on its own
  // audioWired flag), so retrying until isAudioWired() reports true is safe and
  // converges as soon as both the handle and the element are ready.
  let audioWireTimer: ReturnType<typeof setTimeout> | null = null;

  // Keep EVERY loaded slot's element decoding (persistent per-element keep-alive
  // in the engine), not just the active one — a melodic/random switch pattern
  // defeats any "active + predicted-next" hybrid, so every loaded slot must stay
  // warm or it throttles to ~1 fps and the switch lands on a frozen frame (the
  // original bug). keepSlotAlive is idempotent per element; retried until the
  // engine has materialized this node (same race ensureAudioWired guards).
  let keepAliveTimer: ReturnType<typeof setTimeout> | null = null;

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
    // An explicit user CLEAR is the one place a card may free a slot's url —
    // it is a deliberate content change, not a view teardown. The registry
    // owns the revoke so the bookkeeping stays in one place.
    nodeMedia.setObjectUrl(id, slotKey(slot), null);
    slotNames[slot] = null;
    slotDuration[slot] = 0;
    if (slot === 0) { localFileName = null; }
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

  // ---- Transport + slot select, FORWARDED to the node's controller ----
  //
  // ⚠ EVERYTHING THAT USED TO LIVE HERE IS GONE, not duplicated: the rAF
  // transport, the 33 ms CV poll (cv_start / cv_pause / cv_reset /
  // cv_loop_toggle / asset_gate), the gate-driven slot switch, the seven
  // virtual playheads and the one-shot latch. All of it is
  // $lib/ui/media/node-varispeed-registry, on GRAPH lifetime.
  //
  // Two of those were LIVE DEFECTS rather than refactor artefacts. A varispeed
  // inside a COLLAPSED GROUP has no card anywhere — `needsHeadlessSourceMount`
  // returns false for it on the `laneOmitsNode` arm — so the transport and all
  // five CV triggers were simply dead, and a clip player wired into ASSET
  // PITCH/GATE stopped switching clips with the jacks still visibly patched.
  // And `activeSlot`/`slotPos` were card `$state` with no persistence path, so
  // every expand or collapse reset the player to slot 0.
  //
  // What is left here is what a VIEW owns: the click, and nothing else.
  function togglePlay(): void {
    nodeVarispeed.request(id, { kind: 'togglePlay' });
  }
  function onSeek(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const target = Number(input.value);
    if (!Number.isFinite(target)) return;
    nodeVarispeed.request(id, { kind: 'seek', toSec: target });
  }

  /** True iff slot `i` holds LOCAL bytes — the UI uses it to enable a row. The
   *  controller re-derives this itself for the gate path; this copy only decides
   *  what to paint. */
  function slotHasLocalVideo(i: number): boolean {
    return i >= 0 && i < ASSET_SLOTS && (slotNames[i] ?? null) !== null;
  }

  /** A user CLICK on a slot row. The gate-driven path is the controller's. */
  function selectAssetSlot(i: number): void {
    nodeVarispeed.request(id, { kind: 'selectSlot', slot: i });
  }


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
      const u = nodeMedia.objectUrl(id, slotKey(i));
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

  // ---- Adopt the NODE-owned <video> elements into this card ----
  //
  // One effect per slot host. Adoption is a TRANSFER and release is
  // owner-checked in the registry, so the two card mounts a collapse
  // straddles cannot fight over an element in either order.
  const slotLeases: (NodeMediaLease<HTMLElement> | null)[] = new Array(ASSET_SLOTS).fill(null);
  $effect(() => {
    const hosts = slotHosts;
    const leases: NodeMediaLease<HTMLElement>[] = [];
    for (let i = 0; i < ASSET_SLOTS; i++) {
      const host = hosts[i];
      if (!host) continue;
      const lease = nodeMedia.adopt(id, slotKey(i), host, {
        kind: 'video',
        init: (el) => {
          const v = el as HTMLVideoElement;
          v.playsInline = true;
          // Slot 0 is the MAIN preview (audible); 1..6 are the hidden
          // preloaded pool and stay muted, exactly as the old markup declared.
          if (i > 0) v.muted = true;
          v.setAttribute(
            'data-testid',
            i === 0 ? 'videovarispeed-video' : `videovarispeed-slot-video-${i}`,
          );
        },
      });
      slotLeases[i] = lease;
      const el = lease.el as HTMLVideoElement;
      slotEls[i] = el;
      // REHYDRATE the card-local reactive mirrors from the node-owned
      // registry + the live element. Without this a remount believes the node
      // has no local bytes, re-shows the re-link prompt and lets the transport
      // pause a video that is still playing (measured on the re-expand leg).
      slotNames[i] = nodeMedia.mediaName(id, slotKey(i));
      if (Number.isFinite(el.duration) && el.duration > 0) slotDuration[i] = el.duration;
      if (i === 0) localFileName = slotNames[0];
      leases.push(lease);
    }
    return () => {
      for (const l of leases) l.release();
    };
  });

  // ---- Mount / unmount ----
  onMount(() => {
    // Register the multi-slot bytes resolver for the portable .zip export. Done
    // once on mount (not per slot-0 load) so EVERY populated slot travels in the
    // bundle — the Fix B repair for "7 videos in, 1 video out".
    registerVideoExport(id, resolveAllSlotBytes);

    // ⚠ NO attach poll, NO gate loop, NO transport loop. All three are the
    // controller's, on node lifetime — which is the mechanical fact that takes
    // videovarispeed out of `DOM_SOURCE_LANE_TYPES`: the grep gate derives that
    // set by walking this card's subtree for the engine attach CALL, so the
    // declaration and the code cannot drift.
  });

  onDestroy(() => {
    // NOTE what is deliberately ABSENT here: no engine detach, no per-slot
    // `revokeObjectURL`, no `unwireAudio()`. All
    // 7 elements, their urls and their audio wiring belong to the NODE and
    // must survive this card being unmounted — a collapse/expand is a card
    // move, not a node deletion. Teardown happens in nodeMedia.sweep() when
    // the node actually leaves the graph.
    unregisterVideoExport(id);
    for (const l of slotLeases) l?.release();
    slotLeases.fill(null);
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

  // ---- Test hook (gated on testHooksEnabled) --------------------------------
  //
  // Expose this card's PER-SLOT VIRTUAL PLAYHEAD (slotPos[]) + the active slot,
  // keyed by node id. The switch-path e2e uses it to assert a switch-BACK lands
  // on the engine's OWN tracked virtual position — a value on the SAME
  // frame-time (rAF) clock the switch jump reads (selectAssetSlot does
  // `next.currentTime = clamp(slotPos[i])`) — instead of a wall-clock
  // projection, which the frame-time playhead legitimately lags under CI
  // SwiftShader load (the old switch-back model's flake). Registry-keyed so
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
      <!-- The <video> is NOT declared here: it belongs to the NODE and is
           adopted into this host div (see the $effect above). Declaring it in
           markup is what tied its lifetime to the card. -->
      <div class="video-host" bind:this={slotHosts[0]}></div>
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
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions
             — a <label> wrapping a file <input>, whose onclick opens the Chromium showOpenFilePicker
             path. NOTE the codes are COMMA-separated: in runes mode svelte-ignore silently drops every
             code after the first unless they are, and this exact comment used to be space-separated,
             so the second rule was never actually suppressed. The picker is genuinely pointer-only
             (.pick-btn input is display:none, so the input is not in the tab order) — #1572. -->
        <label
          class="overlay relink-hint"
          data-testid="videovarispeed-relink-hint"
          onclick={onPickClick}
        >
          <input type="file" accept="video/*" onchange={onFileInputChange} data-testid="videovarispeed-relink-input" />
          <div class="relink-label">Re-link: drop "{fileMeta?.name}"</div>
        </label>
      {/if}

      <!-- CROP editor overlay — visible ONLY while editing (default card face
           unchanged). Aspect-locked to the live output; drag inside to move,
           drag a corner to resize. -->
      {#if cropEditing && cropActive}
        <CropOverlay rect={cropState.rect} aspect={outAspect} onchange={onCropChange} />
      {/if}
    </div>

    <!-- CROP controls: add a crop (opens the resizable aspect-locked box), or
         edit / remove an existing one. Passthrough until "add crop". -->
    <div class="crop-row">
      {#if !cropActive}
        <button
          type="button"
          class="crop-btn"
          onclick={addCrop}
          data-testid="videovarispeed-add-crop"
          title="Overlay a resizable, aspect-locked crop box; the CROP output zooms into it"
        >add crop</button>
      {:else}
        <button
          type="button"
          class="crop-btn"
          class:on={cropEditing}
          onclick={toggleCropEdit}
          data-testid="videovarispeed-edit-crop"
          aria-pressed={cropEditing}
          title="Show/hide the crop box editor"
        >{cropEditing ? 'done' : 'edit crop'}</button>
        <button
          type="button"
          class="crop-btn remove"
          onclick={removeCrop}
          data-testid="videovarispeed-remove-crop"
          title="Remove the crop — the CROP output returns to the full frame"
        >remove crop</button>
      {/if}
    </div>

    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions
         — a <label> wrapping a file <input>, whose onclick opens the Chromium showOpenFilePicker
         path. NOTE the codes are COMMA-separated: in runes mode svelte-ignore silently drops every
         code after the first unless they are, and this exact comment used to be space-separated,
         so the second rule was never actually suppressed. The picker is genuinely pointer-only
         (.pick-btn input is display:none, so the input is not in the tab order) — #1572. -->
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
        <div class="video-host" bind:this={slotHosts[si]}></div>
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
  /* The <video> elements are ADOPTED into .video-host at runtime (node-owned,
   * see $lib/ui/media/node-media-registry), so Svelte cannot scope-class them
   * — these rules must be :global(). `display: contents` on the host makes the
   * adopted element participate in the parent's layout exactly as the old
   * inline <video> did, so every descendant selector still matches. */
  .video-host { display: contents; }
  .video-host :global(video) {
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

  /* CROP controls */
  .crop-row { display: flex; gap: 6px; align-items: center; }
  .crop-btn {
    background: #1a1f2a;
    color: var(--text-dim);
    border: 1px solid #404652;
    border-radius: 2px;
    padding: 3px 9px;
    font-size: 0.62rem;
    cursor: pointer;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    font-family: ui-monospace, monospace;
  }
  .crop-btn:hover { color: var(--text); border-color: #6a7282; }
  .crop-btn.on {
    background: rgba(255, 59, 59, 0.16);
    border-color: #ff3b3b;
    color: #ff8a8a;
  }
  .crop-btn.remove:hover { color: #ff8a8a; border-color: #ff3b3b; }

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
  .slot-pool :global(video) { width: 1px; height: 1px; }

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
