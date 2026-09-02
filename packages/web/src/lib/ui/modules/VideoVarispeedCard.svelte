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
    type StoredFileHandle,
  } from '$lib/video/video-file-store';
  import { nodeMedia, type NodeMediaLease } from '$lib/ui/media/node-media-registry';
  import { nodeVarispeed, reAllowVarispeedHandle } from '$lib/ui/media/node-varispeed.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';
  import CropOverlay from '$lib/ui/video/CropOverlay.svelte';
  import { videoAspectStore } from '$lib/ui/video-aspect-store.svelte';
  import { defaultCropRect, type CropRect } from '$lib/video/crop-core';
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
  let status = $derived(nodeVarispeed.view(id));
  let activeSlot = $derived(status.activeSlot);
  let videoEl = $derived<HTMLVideoElement | null>(slotEls[activeSlot] ?? null);
  /** Registry key for asset slot `i`. Per-slot object URLs (local bytes, never
   *  synced) are owned by the registry under these keys — this card reads them
   *  via `nodeMedia.objectUrl` and NEVER revokes one. */
  const slotKey = (i: number): string => `slot${i}`;
  // ⚠ READ FROM THE CONTROLLER, NEVER MIRRORED. These were card `$state` with
  // a rehydration `$effect` to paper over the stale-mirror class; the loader is
  // the controller's now, so the names, the error, the lapsed-handle offer and
  // the per-slot load spinner are all read through `status`.
  let slotNames = $derived<readonly (string | null)[]>(status.slotNames);
  let slotLoading = $derived<readonly boolean[]>(status.loadingSlots);
  // Per-slot LOCAL duration (seconds), captured from el.duration at
  // `loadedmetadata`. The synced fileMeta.duration can lag a freshly-loaded
  // slot by a frame or two (an unsynced slot reads durationSec=0 → resolveWindow
  // collapses to hasWindow:false → the transport pauses every frame → Play looks
  // dead). Reading the local element duration closes that window race AND lets
  // each inactive slot's VIRTUAL playhead wrap against its own duration so the
  // 7 slots de-sync by their differing lengths (Step 2).
  // Per-slot VIRTUAL playhead (seconds). The ACTIVE slot tracks its element's
  // real currentTime; every OTHER loaded slot advances incrementally each
  // transport tick (dt × signed effective speed, wrapped via decideEdgeAction)
  // so a switch JUMPS the output to the selected clip at ITS live time rather
  // than restarting from 0. Incremental (not closed-form) so it integrates a
  // time-varying SPEED CV and survives loop wraps/clamps without drift.
  let isDragOver = $state(false);
  let loadError = $derived<string | null>(status.error);
  let pickError = $state<string | null>(null);
  // "Load multiple…" panel toggle (right-click on the card).
  let multiOpen = $state(false);

  // ---- Persistence: remembered file handle (Chromium) + re-link fallback ----
  // Mirrors VIDEOBOX: a picked/dropped FileSystemFileHandle is stashed in
  // IndexedDB keyed by an id stamped into fileMeta.handleId; on patch / perf-zip
  // load we reload that exact file (or the seeded blob the zip carried) so the
  // clip plays again WITHOUT a re-pick. Firefox / Safari never produce a handle
  // and fall back to the re-link prompt only.
  const canRememberHandle = canPersistVideoHandles();
  let pendingHandleName = $derived<string | null>(status.pendingHandleName);

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
  // ⚠ THE OUTPUT-ASPECT RE-FIT IS GONE FROM HERE AND IS THE CONTROLLER'S. It
  // re-fits the stored rect on a 16:9↔4:3 flip and re-persists it when it
  // actually moved — a PERSISTENCE-CORRECTNESS effect, not a view concern. As a
  // card `$effect` it only ran while a card happened to be mounted, so a rack
  // whose aspect flipped with the module collapsed (or, on the default shell,
  // simply not docked) kept a rect that is invalid for the new aspect, and the
  // next reader silently coerced it to something the player never chose.

  // ---- Transport param accessors (knob + sliders live on node.params) ----
  const { defaultFor, paramVal } = cardParams(videoVarispeedDef, () => id, () => node);
  const setParamFn = (k: string) => (v: number): void => {
    setNodeParam(id, k, v);
  };

  // ---- data writers ----
  //
  // ⚠ ONLY THE LOOP TOGGLE IS LEFT, and it is a REQUEST rather than a write:
  // `writePlaying`, `writeFileMeta` and `writeSlotMeta` all belonged to the
  // loader/transport and moved with it, so the two surfaces cannot write the
  // same synced keys through two different code paths.
  function toggleLoop(): void { nodeVarispeed.request(id, { kind: 'setLoop', loop: !loop }); }

  // ---- File loading, FORWARDED to the node's controller ----
  //
  // ⚠ EVERYTHING THAT USED TO LIVE HERE IS GONE, not duplicated: `loadFile`,
  // `loadFileIntoSlot`, `writeFileMeta`, `writeSlotMeta`, the slot-0 and
  // per-slot saved-handle restores and their two `$effect`s, the multi-slot
  // export resolver and the per-slot size cap. All of it is
  // $lib/ui/media/node-varispeed-registry, on GRAPH lifetime.
  //
  // That was a REPAIR, not a tidy-up. This card's `$effect` on
  // `fileMeta.handleId` was the documented delivery mechanism for THREE writers
  // outside the module — the Loaded-Assets picker spawn, `runAssetRebindSweep`
  // and the perf-zip restore — and videovarispeed gets no headless host, so on
  // the default shell no card was mounted to notice. Dropping a video into the
  // asset picker and never opening the dock loaded nothing.
  //
  // What is left here is what a VIEW owns: the gesture.
  function loadFile(file: File, opts?: { handle?: StoredFileHandle | null }): void {
    const res = nodeVarispeed.request(id, {
      kind: 'loadFile',
      slot: 0,
      file,
      handle: opts?.handle ?? undefined,
    });
    if (!res.delivered) {
      console.warn(`[videovarispeed] no controller for node ${id} — the graph sync has not run`);
    }
  }

  function onFileInputChange(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    // The native <input type=file> can't hand us a FileSystemFileHandle, so a
    // pick through this path gets no remembered-handle persistence. The picker
    // button path uses showOpenFilePicker when available to also persist one.
    if (file) loadFile(file);
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
      loadFile(file, { handle });
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') {
        pickError = `Could not open file: ${(e as Error)?.message ?? 'unknown error'}`;
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
    if (file) loadFile(file, { handle });
  }

  // One-click "re-allow": requestPermission() is honoured only inside a real
  // user gesture, so the click performs what the controller can only offer.
  async function onReAllow(): Promise<void> {
    await reAllowVarispeedHandle(id);
  }

  // Re-link prompt visibility: saved fileMeta exists (a file was loaded at save)
  // but THIS browser has no local copy + no usable handle.
  let showRelinkPrompt = $derived<boolean>(
    !hasLocalFile && fileMeta !== null && pendingHandleName === null,
  );

  // ---- "Load multiple…" 7-slot panel (right-click toggle) ------------
  function onCardContextMenu(ev: MouseEvent): void {
    ev.preventDefault();
    multiOpen = !multiOpen;
  }
  function onSlotFileInputChange(ev: Event, slot: number): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      const res = nodeVarispeed.request(id, { kind: 'loadFile', slot, file });
      if (!res.delivered) {
        console.warn(`[videovarispeed] no controller for node ${id} — the graph sync has not run`);
      }
    }
    try { input.value = ''; } catch { /* */ }
  }
  function clearSlot(slot: number): void {
    // An explicit user CLEAR is the one place a slot's bytes may be freed — a
    // deliberate content change, not a view teardown. The CONTROLLER owns the
    // revoke, the element reset, the synced write and the fall-back to slot 0,
    // so both surfaces perform exactly one clear.
    nodeVarispeed.request(id, { kind: 'clearSlot', slot });
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
      // ⚠ NO REHYDRATION STEP. The card used to mirror `slotNames`,
      // `slotDuration` and `localFileName` into its own `$state` and re-read
      // them here, because a remount otherwise believed the node had no local
      // bytes and re-showed the re-link prompt. Those mirrors are gone: every
      // one of them is now read THROUGH the controller's published status, so
      // there is nothing that can be stale.
      leases.push(lease);
    }
    return () => {
      for (const l of leases) l.release();
    };
  });

  // ---- Mount / unmount ----
  //
  // ⚠ NO attach poll, NO gate loop, NO transport loop, and — since the wave-4
  // face PR — NO export registration either. The multi-slot bytes resolver is
  // registered by the CONTROLLER on node lifetime, because this card is not
  // mounted on the default shell at all: registering it here meant a rack whose
  // videovarispeed was never docked exported none of its seven slots' bytes.
  //
  // The absence of the engine attach CALL is also the mechanical fact that
  // keeps videovarispeed out of `DOM_SOURCE_LANE_TYPES`: the grep gate derives
  // that set by walking this card's subtree for it, so the declaration and the
  // code cannot drift.
  onDestroy(() => {
    // NOTE what is deliberately ABSENT here: no engine detach, no per-slot
    // `revokeObjectURL`, no `unwireAudio()`, and no export unregister. All
    // 7 elements, their urls, their audio wiring and the export resolver belong
    // to the NODE and must survive this card being unmounted — a collapse or
    // expand is a card move, not a node deletion. Teardown happens in
    // `nodeMedia.sweep()` and the controller's own dispose when the node
    // actually leaves the graph.
    for (const l of slotLeases) l?.release();
    slotLeases.fill(null);
  });

  // ---- Displayed current position ----
  //
  // Published by the controller (its transport tick already samples the active
  // element every frame), so the card's own 100 ms `setInterval` mirror is gone
  // — one clock for one value, and it keeps running with no card mounted.
  let displayPos = $derived<number>(status.positionSec);

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
  /** One live engine read, for the two readouts this card still paints. The
   *  cached CV-connection scan the hot rAF loop needed is gone with the loop. */
  function readCvSample(paramId: string): number {
    const e = engineCtx.get();
    if (!e || !node) return 0;
    try {
      const v = e.readParam(node, paramId);
      return typeof v === 'number' ? v : 0;
    } catch { return 0; }
  }
  let speedMult = $derived(
    speedKnobToMultiplier(effectiveSpeedKnob(paramVal('speed'), readCvSample('speedCv'))),
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
      {:else if !hasLocalFile && pendingHandleName}
        <!-- One-click re-allow: a remembered handle exists but its read
             permission lapsed. Re-grant + reload in a single user gesture. -->
        <div class="overlay reallow-hint" data-testid="videovarispeed-reallow-hint">
          <div><strong>{pendingHandleName}</strong></div>
          <button
            type="button"
            class="reallow-btn"
            onclick={onReAllow}
            data-testid="videovarispeed-reallow-btn"
          >Click to re-allow {pendingHandleName}</button>
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
      <!-- ⚠ THE `0:04 / 2:00` LINE IS DELETED ON BOTH SURFACES (owner ruling
           2026-08-17): a derived value painted outside every control. Position
           survives on the seek slider below and on its aria-valuetext. Removed
           from the card too rather than only from the faceplate, so the two
           surfaces do not disagree about what this module shows. -->
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
      aria-valuetext="{formatTime(displayPos)} of {formatTime(durationSec)}"
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
         preview above). Each is adopted from the node-owned registry so the
         controller's loader can drive it + attachExternalSource can sample it
         once it becomes active. They stay
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
