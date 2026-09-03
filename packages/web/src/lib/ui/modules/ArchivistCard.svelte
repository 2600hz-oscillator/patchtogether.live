<script lang="ts">
  // ArchivistCard — universal Internet Archive (archive.org) media source.
  //
  // ⚠ THIS CARD OWNS NO LIFECYCLE ANY MORE (legacy-removal S1, 2026-09-03). The
  // archive.org search/load chain, the three node-owned media elements, the
  // engine attach, the audio wire, the transport and both polling loops moved to
  // `$lib/ui/media/node-archivist-source-registry` — a NODE-keyed controller
  // Canvas syncs from the graph. What is left here is a VIEW: the rack tile, the
  // patch panel, a preview of the three node-owned elements, and the shared
  // browse component that reaches the controller through the status seam.
  //
  // WHY. `archivist` was in `DOM_SOURCE_LANE_TYPES`, so the default shell kept
  // this card mounted OFF-SCREEN inside <HeadlessSourceHost> purely so the
  // module would have a source at all — the card was load-bearing, and a
  // load-bearing card cannot be deleted.
  //
  // ⚠ AND THE STAKES WERE THE HIGHEST OF THE THREE. camera and loopback lose a
  // way to START a source that would otherwise be running; a FRESH archivist has
  // NO item at all — `node.data.item` is null until a search writes one and
  // nothing searches on its own — so a module whose owner cannot be reached is
  // not degraded, it is a media source that can never be given any media.
  //
  // WHAT THE MODULE STILL DOES, unchanged: search archive.org → pick a RANDOM
  // matching item of the selected media type (image | audio | video | any) →
  // load and preview it, with scrub/seek for time-media. Per-type outputs,
  // subject to CORS:
  //   image → clean WebGL `image` texture output.
  //   audio → clean `audio_l/audio_r` output (analysable/routable).
  //   video → PLAY-ONLY: plays and scrubs, but archive.org video lacks CORS on
  //           the served file so the `video` texture output cannot be delivered
  //           (tainted). The CLEAN OUT lamp says so.
  //
  // PORTS: rendered through the shared yellow drill-down <PatchPanel> (NO raw
  // side handles — the #767 standard). Port ids are byte-identical to the module
  // def so the CV bridge + persisted edges route unchanged.
  //
  // Multiplayer: the loaded item, the search inputs and `isPlaying` live on
  // `node.data` (Yjs) so peers see the same item and can drive play/seek. Each
  // peer loads the URL locally — and, since the extraction, each peer's
  // CONTROLLER reacts to a peer's write on the graph snapshot, which is what
  // makes a rack-mate's tune actually land rather than sit in the document.

  import { onDestroy } from 'svelte';
  import { nodeMedia, type NodeMediaLease } from '$lib/ui/media/node-media-registry';
  import { type NodeProps } from '@xyflow/svelte';
  import { captureFlowStore } from './card-kit';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { startCornerResize } from './card-resize';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    type ArchivistData,
    type ArchivistItemMeta,
  } from '$lib/video/modules/archivist';
  import { buildDetailsUrl, hasCleanOutput } from '$lib/video/modules/archivist-query';
  import {
    archivistStatus,
    type ArchivistStatus,
  } from '$lib/ui/media/archivist-status-registry';
  import { ARCHIVIST_SLOTS } from '$lib/ui/media/node-archivist-source.svelte';
  import ArchivistBrowseControls from './archivist/ArchivistBrowseControls.svelte';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  // Guarded: the dock full-view plain-mounts this card OUTSIDE the SvelteFlow
  // provider, where a bare useStore() throws and killed the card at init (no
  // video in the expanded faceplate). Inside the provider this is
  // byte-identical; outside it's null -> zoom 1.
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
  //      the panel's Gates→CV→Audio grouping. ----
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

  // ---- The three NODE-owned elements, ADOPTED for display ----
  //
  // An archive.org item is a video, an image or an audio file, and the item
  // decides which. Each is its own registry slot so an item that switches TYPE
  // does not disturb the other two. The controller `ensure`s all three into
  // existence with no host at all; this card adopts them to SHOW them and
  // releases them on unmount, and both events are invisible to the source.
  let videoHost: HTMLDivElement | null = $state(null);
  let audioHost: HTMLDivElement | null = $state(null);
  let imageHost: HTMLDivElement | null = $state(null);
  let mediaEl: HTMLVideoElement | null = $state(null);
  let imgEl: HTMLImageElement | null = $state(null);
  const leases: (NodeMediaLease<HTMLElement> | null)[] = [null, null, null];

  // ---- Reactive reads from data (Yjs-backed) ----
  let item = $derived<ArchivistItemMeta | null>(
    (node?.data as Partial<ArchivistData> | undefined)?.item ?? null,
  );
  let isPlaying = $derived<boolean>(
    (node?.data as Partial<ArchivistData> | undefined)?.isPlaying ?? false,
  );
  let durationSec = $derived<number>(item?.duration ?? 0);
  let cleanOut = $derived<boolean>(item ? hasCleanOutput(item.type) : false);
  let detailsUrl = $derived<string>(item ? buildDetailsUrl(item.identifier) : '');

  // ---- The controller's published status, through the cross-surface seam ----
  //
  // ⚠ THE SAME SEAM `ArchivistBrowseControls` READS, deliberately, and this card
  // mounts that component. Reading the controller's `$state` record directly
  // would work and would leave the card and the shared browse row deriving
  // "loading" from two places — which on THIS module is exactly the write-only
  // mirror the extraction inherited a fix for.
  let live = $state<ArchivistStatus | null>(null);

  $effect(() => {
    const nodeId = id;
    const sync = (): void => { live = archivistStatus.read(nodeId); };
    sync();
    return archivistStatus.subscribe(nodeId, sync);
  });

  let loading = $derived<boolean>(live?.loading ?? false);
  let statusMsg = $derived<string | null>(live?.statusMsg ?? null);

  // ---- Adopt the three NODE-owned elements into this card ----
  $effect(() => {
    const hosts: [HTMLDivElement | null, string, 'video' | 'audio' | 'img'][] = [
      [videoHost, ARCHIVIST_SLOTS.video, 'video'],
      [audioHost, ARCHIVIST_SLOTS.audio, 'audio'],
      [imageHost, ARCHIVIST_SLOTS.image, 'img'],
    ];
    const taken: NodeMediaLease<HTMLElement>[] = [];
    hosts.forEach(([host, slot, kind], i) => {
      if (!host) return;
      // ⚠ NO `init` HERE ANY MORE. The testids and the element-shaping the card
      // used to apply at adoption time are set by the CONTROLLER when it
      // `ensure`s the element, because an attribute applied at adoption exists
      // only while that surface is mounted — the exact coupling this move
      // removes. `adopt` on an existing key is a transfer, not a creation.
      const lease = nodeMedia.adopt(id, slot, host, { kind });
      leases[i] = lease;
      taken.push(lease);
      if (kind === 'video') mediaEl = lease.el as HTMLVideoElement;
      if (kind === 'img') imgEl = lease.el as HTMLImageElement;
    });
    return () => {
      for (const l of taken) l.release();
    };
  });

  // The `class:hidden` / `alt` bindings, applied imperatively — these elements
  // are not declared by this component. Reading `item` here registers the
  // reactive dependency exactly as the markup did.
  $effect(() => {
    const t = item?.type;
    mediaEl?.classList.toggle('hidden', t !== 'video');
    imgEl?.classList.toggle('hidden', t !== 'image');
    if (imgEl) imgEl.alt = item?.title ?? 'archive.org image';
  });

  onDestroy(() => {
    // NOTE what is deliberately ABSENT: no detach, no unwireAudio, no timer
    // teardown. All three elements belong to the NODE and keep playing across a
    // card move; the controller owns every loop and dies with the node.
    for (const l of leases) l?.release();
    leases.fill(null);
  });

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
