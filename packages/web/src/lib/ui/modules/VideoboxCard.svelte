<script lang="ts">
  // VideoboxCard — a VIEW over the node's video source, plus the gestures only
  // a mounted surface can perform.
  //
  // ⚠ THIS CARD OWNS NO LIFECYCLE ANY MORE (LEG-02, #1511). It used to own the
  // `attachExternalSource` poll, the `wireAudio` retry, the 500 ms multiplayer
  // drift loop, the 33 ms `play_trigger` gate loop, the sync→element
  // application and the saved-handle restore — all in its own component
  // lifetime. So a rack containing VIDEOBOX had a source only because
  // `<HeadlessSourceHost>` parked this card off-screen, and videobox was in
  // `DOM_SOURCE_LANE_TYPES` for exactly that reason.
  //
  // All six now belong to a node-scoped controller
  // ($lib/ui/media/node-video-source-registry), created and disposed by the
  // GRAPH from Canvas's sync/sweep effects. This card CREATES NOTHING AND
  // DISPOSES NOTHING: it adopts the node-owned <video> for display, renders the
  // transport, and forwards user gestures through `nodeVideoSource.request(...)`.
  // Everything it still cleans up in `onDestroy` is its own (a display timer, a
  // resize listener, the media lease).
  //
  // The engine module (videobox.ts) samples the element each video frame into
  // its FBO + (after wireAudio) routes its audio into the cross-domain audio
  // bridge — unchanged, and deliberately: it is in the WebGL attest basis, so
  // this whole conversion reaches it only through existing public calls.
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
  import { type NodeProps } from '@xyflow/svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { startCornerResize } from './card-resize';
  import { createFullscreen } from './use-fullscreen.svelte';
  import { createFullFrame } from './use-full-frame.svelte';
  import { attachRenderLease } from './use-render-lease.svelte';
  import { nodeMedia, type NodeMediaLease } from '$lib/ui/media/node-media-registry';
  import VideoCanvasContextMenu from './VideoCanvasContextMenu.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import { videoboxDef, type VideoboxData } from '$lib/video/modules/videobox';
  import { type VideoboxFileMeta } from '$lib/video/modules/videobox-sync';
  import {
    canPersistVideoHandles,
    formatFileSize,
    type StoredFileHandle,
  } from '$lib/video/video-file-store';
  import {
    nodeVideoSource,
    reAllowVideoHandle,
    VIDEO_SOURCE_SLOT,
  } from '$lib/ui/media/node-video-source.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { captureFlowStore, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  // Guarded: the dock full-view plain-mounts this card OUTSIDE the
  // SvelteFlow provider, where a bare useStore() throws and killed the
  // card at init (no video in the expanded faceplate). Inside the
  // provider this is byte-identical; outside it's null -> zoom 1.
  const flowStore = captureFlowStore();

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
  // The <video> is owned by the NODE, not by this card: it lives in
  // $lib/ui/media/node-media-registry and is ADOPTED into `videoHost` while
  // this card is mounted. Expand/collapse moves the card between the headless
  // host and the dock full-view — two different MOUNTS — and the pre-fix card
  // destroyed its element + revoked its object URL on every such move, which
  // is the owner-reported "stops playing when collapsed". See the registry
  // header for the measurement.
  let videoHost: HTMLDivElement | null = $state(null);
  let videoEl: HTMLVideoElement | null = $state(null);
  const MEDIA_SLOT = VIDEO_SOURCE_SLOT;
  let isDragOver = $state(false);

  // ---- Status, READ from the node's controller ----
  //
  // ⚠ DERIVED, NEVER MIRRORED. These were card `$state` written by the card's
  // own load path, and that is precisely how a remount came up believing the
  // node had no local file — re-showing the re-link prompt over a video that
  // was still playing. Reading them through the controller makes the stale
  // mirror unspellable: there is one owner and the card is not it.
  let sourceStatus = $derived(nodeVideoSource.view(id));
  let localFileName = $derived<string | null>(sourceStatus.fileName);
  let loadError = $derived<string | null>(sourceStatus.error);
  /** The name of a remembered handle whose read permission is in the 'prompt'
   *  state. The controller can detect it but CANNOT act on it —
   *  `requestPermission()` is only honoured inside a real user gesture — so it
   *  publishes the offer and this card performs it (`onReAllow`). */
  let pendingHandleName = $derived<string | null>(sourceStatus.pendingHandleName);

  // ---- Persistence: remembered file handle (Chromium) ----
  // When the user picks a file via showOpenFilePicker() (or drops one and the
  // browser exposes getAsFileSystemHandle()), the handle rides along with the
  // load gesture and the CONTROLLER persists it in IndexedDB + stamps its id
  // into the synced fileMeta. Firefox / Safari never produce a handle and use
  // the re-link prompt path only. All this card decides is which picker to open.
  const canRememberHandle = canPersistVideoHandles();

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

  // ⚠ THIS CARD IS NO LONGER ON THE PRIVATE `extras` CHANNEL AT ALL, and that
  // is a stronger statement than "it stopped calling wireAudio". It used to
  // hold `getExtras()` (a `read(id,'extras')` reach into the handle) and
  // `videoEngine()` purely to drive the audio wiring and the attach retry. Both
  // are the controller's now, so both helpers are DELETED rather than left
  // unused — which is what takes `VideoboxCard` out of `EXTRAS_OWNERS` in
  // `card-media-lifetime.test.ts`, the same way textmarquee and picturebox left
  // it when their pushes moved to a node-lifetime producer. A card that cannot
  // reach the handle cannot tear it down.

  // ---- Gestures, FORWARDED to the node's controller ----
  //
  // ⚠ THE CARD NO LONGER LOADS ANYTHING. `loadFile` used to mint the object URL,
  // set `videoEl.src`, await metadata, persist the handle, write fileMeta and
  // drive the `wireAudio` retry — six node-lifetime concerns in a component that
  // may not be mounted. It now hands the File to the controller, which owns all
  // six and is alive for as long as the node is.
  //
  // A gesture is the ONE thing that genuinely needs a mounted surface: a file
  // picker and a permission re-grant are only honoured inside a real user
  // gesture. That is why the seam is a command rather than an ownership split.
  function loadFile(file: File, opts?: { handle?: StoredFileHandle | null }): void {
    const res = nodeVideoSource.request(id, {
      kind: 'load',
      file,
      handle: opts?.handle ?? undefined,
    });
    // DELIVERY IS REPORTED, NEVER DROPPED. A load writes nothing to the graph
    // until metadata resolves, so "the picker did nothing" and "no controller
    // was listening" are otherwise indistinguishable from the UI.
    if (!res.delivered) {
      console.warn(`[videobox] no source controller for node ${id} — the graph sync has not run`);
    }
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
      loadFile(file, { handle });
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

  // ---- The one-click "re-allow <name>" gesture ----
  //
  // The CONTROLLER detects that a remembered handle needs a permission re-grant
  // and publishes it as `pendingHandleName`; it deliberately does not act,
  // because `requestPermission()` is only honoured inside a real user gesture
  // and a controller has none. This handler runs inside the click, and hands the
  // resulting File straight back to the controller's normal load path — so the
  // card is the gesture, never the owner.
  async function onReAllow(): Promise<void> {
    await reAllowVideoHandle(id);
  }

  // Re-link prompt visibility: we have saved fileMeta (a file was loaded
  // when the patch was saved) but THIS browser has no local copy AND we
  // can't auto-reload from a remembered handle (none, denied, or a
  // different machine/browser). The pendingHandleName case shows the one-click
  // re-allow affordance instead.
  let showRelinkPrompt = $derived<boolean>(
    !hasLocalFile && fileMeta !== null && pendingHandleName === null,
  );

  // ---- Transport, FORWARDED ----
  //
  // ⚠ THE SAVED-HANDLE RESTORE IS GONE FROM HERE ENTIRELY, and its absence is
  // the headline of this conversion rather than a tidy-up. It used to be a card
  // `$effect`, so a rack saved with a loaded video and reopened with nothing
  // expanded restored NOTHING until the user opened the dock. The controller
  // runs it at node creation, which is what makes "rack save/reload restores the
  // source without a card ever mounting" true.
  //
  // Play/pause/seek forward for the same reason the load path does: the write is
  // a MULTIPLAYER write, and its correct position comes from the element the
  // controller owns, not from a `videoEl` this card may or may not have adopted.
  function togglePlay(): void {
    nodeVideoSource.request(id, { kind: 'togglePlay' });
  }

  function onSeek(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const target = Number(input.value);
    if (!Number.isFinite(target)) return;
    nodeVideoSource.request(id, { kind: 'seek', toSec: target });
  }

  // ---- What used to be here, and where it went ----
  //
  // THREE node-lifetime loops lived in this card and are now the controller's
  // ($lib/ui/media/node-video-source-registry):
  //
  //   * the SYNC→ELEMENT `$effect` — a peer's play/pause/seek reaching the local
  //     <video>. With the card unmounted it reached nothing, so a collaborator
  //     pressing play moved every rack except the one whose card was collapsed.
  //   * the 500 ms DRIFT loop — the periodic correction that keeps a local
  //     element from sliding away from the shared playhead.
  //   * the 33 ms `play_trigger` GATE loop — a patched gate cable toggling
  //     transport. Card-owned, it did nothing whenever no card was mounted,
  //     which under the shipping shell is the DEFAULT state of a saved rack.
  //
  // All three are pure functions of graph state and the node-owned element, so
  // none of them ever needed a component. Keeping them here is what put videobox
  // in `DOM_SOURCE_LANE_TYPES` and cost every rack an off-screen card mount.

  // ---- Adopt the NODE-owned <video> into this card ----
  //
  // The element is created once per node and parked off-screen; every card
  // mount adopts it and every unmount releases it. Adoption is a TRANSFER and
  // release is owner-checked in the registry, so the two mounts a collapse
  // straddles cannot fight over it in either order.
  let mediaLease: NodeMediaLease<HTMLElement> | null = null;
  $effect(() => {
    const host = videoHost;
    if (!host) return;
    const lease = nodeMedia.adopt(id, MEDIA_SLOT, host, {
      kind: 'video',
      init: (el) => {
        const v = el as HTMLVideoElement;
        v.playsInline = true;
        v.setAttribute('data-testid', 'videobox-video');
      },
    });
    mediaLease = lease;
    videoEl = lease.el as HTMLVideoElement;
    // ⚠ NO REHYDRATE STEP ANY MORE, and its deletion is the point. This used to
    // copy `nodeMedia.mediaName(...)` into a card-local `$state` mirror, because
    // a remount otherwise came up believing the node had no local file — it
    // re-showed the re-link prompt and let the transport pause a video that was
    // still playing. `localFileName` is now `$derived` from the controller's
    // published status, so there is no mirror to go stale and no moment at which
    // the card's answer and the node's answer can differ.
    //
    // ⚠ AND NO ATTACH CALL. The element arrives already attached: the controller
    // `ensure`s and attaches it at NODE creation, long before any card exists.
    // Adoption here is a DOM re-parent for display only.
    return () => {
      lease.release();
      if (mediaLease === lease) mediaLease = null;
    };
  });

  // ---- Mount / unmount ----
  //
  // ⚠ NO `attachExternalSource` ANYWHERE IN THIS FILE, and that is the
  // mechanical fact that takes videobox out of `DOM_SOURCE_LANE_TYPES`. The
  // grep gate (`dom-source-modules.test.ts`) derives that set by walking each
  // card's component subtree for exactly this call, so the declaration and the
  // code cannot drift: the type leaves the set in the same diff the call leaves
  // the card. The attach — and its retry against the engine's async `addNode` —
  // is the controller's, on node lifetime.
  //
  // The export resolver moved for the same reason: registered here, a node whose
  // card had never mounted was silently missing from "Export performance" even
  // though its bytes were live in the registry.
  onDestroy(() => {
    // Everything released here is THIS CARD'S OWN. The element, its object URL,
    // its audio wiring, the attach and all three loops belong to the node and
    // must survive this unmount — a collapse is a card move, not a node
    // deletion. Their teardown is Canvas's graph sweep.
    mediaLease?.release();
    mediaLease = null;
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
  // picker / transport / seekbar + the patch-panel jack affordances; the card
  // stays in the rack + remains resizable. Persisted in node.data.fullFrame (Y.Doc-
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

  // Presenting-mode hard render lease — VIDEOBOX has no present popup, but
  // fullscreen / full-frame are still surfaces that outlive the card's
  // viewport rect: scrolling a full-frame wall-of-TVs card off-screen froze
  // its engine node the same way (see use-render-lease).
  attachRenderLease({
    engine: () => engineCtx.get(),
    nodeId: () => id,
    presenting: () => fs.isFullscreen || fullFrame,
  });

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

  // Ports — all I/O lives in the shared yellow drill-down <PatchPanel> (the
  // post-#767 hard standard — NO raw side <Handle> jacks). Port `id`s are
  // byte-identical to videoboxDef so the CV bridge + persisted edges route
  // unchanged (play_trigger = gate; video/audio_l/audio_r = video/audio outs).
  const inputs = portsFromDef(videoboxDef.inputs, { play_trigger: 'TRIG' });
  const outputs = portsFromDef(videoboxDef.outputs, { video: 'VID', audio_l: 'A-L', audio_r: 'A-R' });
</script>

<div
  bind:this={cardEl}
  class="vcard card video videobox-card"
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

  <PatchPanel nodeId={id} {inputs} {outputs}>
  <div class="body">
    <!-- svelte-ignore a11y_no_static_element_interactions — the only handler here is `oncontextmenu`, which opens the canvas menu. Right-click
       already HAS a keyboard route the browser dispatches to this same event (the Menu key /
       Shift+F10), so an extra key handler would be a second path to the same menu. -->
    <div
      bind:this={wrapEl}
      class="preview-wrap"
      class:fullscreen={fs.isFullscreen}
      class:full-frame={fullFrame}
      data-testid="videobox-fs-wrap"
      oncontextmenu={onPreviewContextMenu}
    >
      <!-- The <video> is NOT declared here: it belongs to the NODE and is
           adopted into this host div (see the $effect above). Declaring it in
           markup is what tied its lifetime to the card. -->
      <div class="video-host" bind:this={videoHost}></div>
      {#if !hasLocalFile && !fileMeta}
        <div class="overlay drop-hint" data-testid="videobox-drop-hint">
          <div>Drop a video file</div>
          <div class="sub">or click to select</div>
        </div>
      {:else if !hasLocalFile && pendingHandleName}
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
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions
             — a <label> wrapping a file <input>, whose onclick opens the Chromium showOpenFilePicker
             path. NOTE the codes are COMMA-separated: in runes mode svelte-ignore silently drops every
             code after the first unless they are, and this exact comment used to be space-separated,
             so the second rule was never actually suppressed. The picker is genuinely pointer-only
             (.pick-btn input is display:none, so the input is not in the tab order) — #1572. -->
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

    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions
         — a <label> wrapping a file <input>, whose onclick opens the Chromium showOpenFilePicker
         path. NOTE the codes are COMMA-separated: in runes mode svelte-ignore silently drops every
         code after the first unless they are, and this exact comment used to be space-separated,
         so the second rule was never actually suppressed. The picker is genuinely pointer-only
         (.pick-btn input is display:none, so the input is not in the tab order) — #1572. -->
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
  </PatchPanel>

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
    overflow: hidden;
    /* The body fills the card below the header so the preview-wrap can
     * grow as the card is resized (and to 100% in full-frame). */
    display: flex;
    flex-direction: column;
  }
  .card.resizing { transition: none; }
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
    min-height: 160px;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    /* Grow to consume the card space above the transport controls so a
     * resized card shows a bigger preview. */
    flex: 1;
  }
  /* The <video> is ADOPTED into .video-host at runtime (node-owned, see the
   * registry), so Svelte cannot scope-class it — these rules must be
   * :global(). `display: contents` on the host makes the adopted element
   * participate in .preview-wrap's flex layout exactly as the old inline
   * <video> did, so every descendant selector below still matches. */
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
  .preview-wrap.fullscreen :global(video) {
    width: 100%;
    height: 100%;
    object-fit: contain;
    cursor: pointer;
  }

  /* ---------- FULL FRAME (in-app, NOT browser fullscreen) ---------- */
  /* The <video> preview consumes the whole card border; hide the title,
   * stripe, file picker, transport + seekbar so the card shows only video.
   * Stays in the rack + resizable; double-click exits. */
  .card.full-frame {
    padding: 0;
  }
  .card.full-frame .stripe,
  .card.full-frame .pick-btn,
  .card.full-frame .transport,
  .card.full-frame .seek,
  .card.full-frame .filename,
  .card.full-frame .error {
    display: none;
  }
  /* Hide the card's OWN PatchPanel jack affordances + Svelte Flow handles
   * while full-frame — keep the handles in the DOM (opacity/pointer-events,
   * not display:none) so existing cables stay connected; we hide, not
   * remove. The host stays display:contents so the body fills the card. */
  .card.full-frame :global(.patch-trigger) {
    opacity: 0;
    pointer-events: none;
  }
  .card.full-frame :global(.svelte-flow__handle) {
    opacity: 0;
    pointer-events: none;
  }
  .card.full-frame :global(.patch-panel-host) {
    display: contents;
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
  .preview-wrap.full-frame :global(video) {
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
