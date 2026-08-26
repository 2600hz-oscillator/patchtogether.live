<script lang="ts">
  // TvLibrarianCard — the SURFACE for an international live-TV source whose
  // lifecycle belongs to the NODE.
  //
  // ⚠ THIS CARD CREATES NOTHING AND DISPOSES NOTHING (LEG-02 P3, #1511). The
  // <video>, its hls.js demuxer, the engine attach, the audio wire + un-mute,
  // the CHANNEL catalogue, the channel→stream application, the next/random
  // trigger poll and the unavailable auto-skip are ALL owned by
  // `$lib/ui/media/node-hls-source-registry` on GRAPH lifetime, created and
  // swept from Canvas's own effects. This file adopts the node's element for
  // display, renders the picker, and forwards user GESTURES through
  // `nodeHlsSource.request(...)`.
  //
  // ⚠ NO `attachExternalSource` ANYWHERE IN THIS FILE — the mechanical fact that
  // takes `tvLibrarian` out of `DOM_SOURCE_LANE_TYPES`, since the grep gate
  // (`dom-source-modules.test.ts`) derives that set by walking each card's
  // component subtree for exactly this call.
  //
  // ⚠ NO `read(id, 'extras')` EITHER: a card that cannot reach the handle cannot
  // tear it down. Its EXTRAS_OWNERS entry went with it.
  //
  // WHAT THIS CARD STILL OWNS, and why: the COUNTRY dataset. The world map and
  // the dropdown are a picker, not engine-visible state — nothing downstream of
  // this module can tell whether the country list ever loaded, and no CV input
  // reaches it. The CHANNEL list is different and moved: `next` and `random` are
  // gate INPUTS, so the thing they advance through has to exist whether or not a
  // card does.
  //
  // FLOW (unchanged for the player): a 2D world map (NO three.js —
  // equirectangular, click → nearest country) OR a country dropdown → the
  // controller's channel list (filtered famelack data) → pick a channel → the
  // controller hands its .m3u8 to hls.js → the engine module (tv-librarian.ts)
  // samples the element into the FBO (video out) + extracts stereo audio
  // (audio_l/audio_r).
  //
  // THE AUDIO TRAP, for the reader who comes looking: the element is created
  // `muted` so the programmatic play() is allowed without a user gesture, and
  // MUST be un-muted after createMediaElementSource succeeds — a muted element
  // feeds SILENCE into its MediaElementAudioSourceNode because the mute gates
  // the audio AT THE SOURCE. That is #tv-librarian-audio, and the step now lives
  // in the controller's `ensureAudioWired` on node lifetime, which is what stops
  // a card unmount mid-retry from stranding the element muted forever.
  //
  // Legal posture: an in-card disclaimer ("third-party public streams, not
  // hosted here") + dataset attribution; geo-blocked channels are MARKED;
  // dead/unavailable streams fail cleanly → auto-skip, never hang.  //
  // ⚠ THE PICKER MOVED, AND THIS FILE IS NOW A SHELL AROUND IT. The map/list
  // toggle, the world map, the country dropdown, the channel roster, next/random
  // and the disclaimer all live in `./tvLibrarian/TvLibrarianPicker.svelte`,
  // which the FACEPLATE's tuner body mounts as well. Promotion stops both
  // surfaces rendering THIS card, and tvLibrarian is not in
  // `DOM_SOURCE_LANE_TYPES` any more (LEG-02 P3, #2209) so there is no headless
  // host either — the faceplate needs a real browse surface, and a second copy
  // of one is how the two drift. What stays here is what is genuinely the
  // CARD's: the adopted node-owned <video>, and the corner-drag resize the dock
  // does not need because the dock owns its own pane sizing.
  import { onDestroy } from 'svelte';
  import { nodeMedia, type NodeMediaLease } from '$lib/ui/media/node-media-registry';
  import { nodeHlsSource, HLS_SOURCE_SLOT } from '$lib/ui/media/node-hls-source.svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { mutateNode } from '$lib/graph/mutate';
  import { startCornerResize } from './card-resize';
  import ModuleTitle from './ModuleTitle.svelte';
  import TvLibrarianPicker from './tvLibrarian/TvLibrarianPicker.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    tvLibrarianDef,
    type TvLibrarianData,
    type TvChannelMeta,
  } from '$lib/video/modules/tv-librarian';
  import { languageLabel } from '$lib/video/modules/tv-librarian-data';
  import { captureFlowStore, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  // Guarded: the dock full-view plain-mounts this card OUTSIDE the
  // SvelteFlow provider, where a bare useStore() throws and killed the
  // card at init (no video in the expanded faceplate). Inside the
  // provider this is byte-identical; outside it's null -> zoom 1.
  const flowStore = captureFlowStore();

  // ---- Resize (mirror VIDEOBOX: user-resizable, 180-multiple defaults) ----
  const DEFAULT_WIDTH = 360;
  const DEFAULT_HEIGHT = 540;
  const MIN_WIDTH = 360;
  const MIN_HEIGHT = 360;
  /** Local size WHILE DRAGGING; null the rest of the time so the synced value
   *  wins (a peer's resize, an undo, a reload). */
  let gestureSize = $state<{ width: number; height: number } | null>(null);
  let cardWidth = $derived<number>(
    gestureSize?.width ?? (node?.data?.width as number | undefined) ?? DEFAULT_WIDTH,
  );
  let cardHeight = $derived<number>(
    gestureSize?.height ?? (node?.data?.height as number | undefined) ?? DEFAULT_HEIGHT,
  );

  // ---- Persisted (synced) reads ----
  let channel = $derived<TvChannelMeta | null>(
    (node?.data as Partial<TvLibrarianData> | undefined)?.channel ?? null,
  );
  let countryCode = $derived<string | null>(
    (node?.data as Partial<TvLibrarianData> | undefined)?.countryCode ?? null,
  );

  // ---- The controller's published status ----
  let src = $derived(nodeHlsSource.view(id));
  let streamState = $derived(src.streamState);

  // ⚠ THE STATION NAME IS THE PICTURE'S ACCESSIBLE NAME, NOT A PAINTED LABEL.
  // The card's `tv-now-playing` readout is DELETED (owner ruling, 2026-08-17:
  // the data is removed, not hidden), on BOTH surfaces rather than only on the
  // faceplate — a card and a faceplate disagreeing about what a module paints is
  // the drift this shared-picker refactor exists to prevent. The roster's
  // highlighted row, scrolled into view on tune, is the painted answer.
  let pictureLabel = $derived<string>(
    channel
      ? `TV LIBRARIAN picture — tuned to ${channel.name}${
          languageLabel(channel.languages) ? ` (${languageLabel(channel.languages)})` : ''
        }`
      : 'TV LIBRARIAN picture — nothing tuned',
  );

  // ---- Card-local UI state ----
  let videoHost: HTMLDivElement | null = $state(null);
  let mediaLease: NodeMediaLease<HTMLElement> | null = null;

  // ---- Adopt the NODE-owned <video> into this card ----
  //
  // ⚠ NO ATTACH CALL AND NO DISPOSER. The element arrives already attached and
  // already carrying its hls teardown: the controller `ensure`s it, attaches it
  // and registers the disposer at NODE creation, long before any card exists.
  // Adoption here is a DOM re-parent for display only, and it is a TRANSFER with
  // an owner-checked release, so the two mounts a collapse straddles cannot
  // fight over the element in either order.
  //
  // ⚠ AND THE FACEPLATE BODY DELIBERATELY DOES NOT DO THIS — it blits the
  // module's own OUTPUT texture instead, so the two surfaces can never be
  // fighting over one element with one parent. See TvLibrarianTunerBody's header.
  $effect(() => {
    const host = videoHost;
    if (!host) return;
    const lease = nodeMedia.adopt(id, HLS_SOURCE_SLOT, host, { kind: 'video' });
    mediaLease = lease;
    return () => {
      lease.release();
      if (mediaLease === lease) mediaLease = null;
    };
  });

  onDestroy(() => {
    // NOTE what is deliberately ABSENT: no teardownHls, no detach, no
    // unwireAudio, no setStreamOnline(false), no trigger-loop stop. NONE of
    // those exist here any more — they are the controller's, on node lifetime.
    // Everything released here is THIS CARD'S OWN.
    mediaLease?.release();
    mediaLease = null;
  });

  // ---- Corner-drag resize ----
  //
  // ⚠ ONE SYNCED COMMIT PER DRAG, INSIDE A TAGGED TRANSACTION. This used to
  // write `t.data.width` / `.height` BARE on every pointermove — no
  // `ydoc.transact`, no `LOCAL_ORIGIN` — while the same file tagged its other
  // `.data` writers correctly. Two consequences, both real: an untagged write is
  // invisible to the origin-filtered undo stack, so a resize could not be undone
  // and worse could not be told apart from a REMOTE edit; and one Y.Doc update
  // per pointer move is a write storm over a value nobody needs mid-gesture.
  // `gestureSize` carries the drag locally (so it stays responsive and what is
  // committed is what was shown) and `mutateNode` commits once at the end.
  let resizing = $state(false);
  let resizeAbort: AbortController | null = null;
  function onResizeStart(ev: PointerEvent): void {
    resizeAbort = startCornerResize(ev, {
      flowStore,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      getStartSize: () => ({ width: cardWidth, height: cardHeight }),
      apply: (w, h) => { gestureSize = { width: w, height: h }; },
      onStart: () => { resizing = true; },
      onEnd: () => {
        resizing = false;
        resizeAbort = null;
        const final = gestureSize;
        gestureSize = null;
        if (!final) return;
        mutateNode(id, (live) => {
          if (!live.data) live.data = {};
          (live.data as Record<string, unknown>).width = final.width;
          (live.data as Record<string, unknown>).height = final.height;
        });
      },
    });
  }
  onDestroy(() => { if (resizeAbort) resizeAbort.abort(); });

  const inputs = portsFromDef(tvLibrarianDef.inputs);
  const outputs = portsFromDef(tvLibrarianDef.outputs);
</script>

<div
  class="vcard card video tv-librarian-card"
  class:resizing
  style="width: {cardWidth}px; height: {cardHeight}px;"
  data-testid="tv-librarian-card"
  data-country={countryCode}
  data-stream-state={streamState}
  role="region"
  aria-label="TV LIBRARIAN"
>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="TV LIBRARIAN" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <!-- Preview -->
      <div class="preview-wrap" data-testid="tv-preview" aria-label={pictureLabel} role="img">
        <!-- The <video> is NOT declared here: it belongs to the NODE and is
             adopted into this host div (see the $effect above). Declaring it
             in markup is what tied its lifetime to the card. -->
        <div class="video-host" bind:this={videoHost}></div>
        {#if streamState === 'loading'}
          <div class="overlay" data-testid="tv-loading">tuning…</div>
        {:else if streamState === 'unavailable'}
          <div class="overlay err" data-testid="tv-unavailable">stream unavailable — skipping</div>
        {:else if !channel}
          <div class="overlay" data-testid="tv-empty">pick a country, then a channel</div>
        {/if}
      </div>

      <TvLibrarianPicker nodeId={id} {countryCode} {channel} />
    </div>
  </PatchPanel>

  <div
    class="resize-handle nodrag"
    role="separator"
    aria-label="Resize TV LIBRARIAN"
    data-testid="tv-resize-handle"
    onpointerdown={onResizeStart}
  ></div>
</div>

<style>
  .card {
    padding-bottom: 12px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .card.resizing { transition: none; }
  .body {
    margin-top: 26px;
    padding: 0 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .preview-wrap {
    position: relative;
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    flex: 0 0 auto;
  }
  /* The <video> is ADOPTED into .video-host at runtime (node-owned, see
   * $lib/ui/media/node-media-registry), so Svelte cannot scope-class it —
   * these rules must be :global(). `display: contents` makes the adopted
   * element participate in the parent's layout exactly as the old inline
   * <video> did, so every descendant selector still matches. */
  .video-host { display: contents; }
  .video-host :global(video) {
    display: block;
    width: 100%; height: 100%;
    object-fit: contain;
    background: #000;
  }
  .overlay {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    text-align: center;
    background: rgba(5, 6, 8, 0.78);
    color: var(--text-dim);
    font-size: 0.65rem; padding: 6px;
    font-family: ui-monospace, monospace;
  }
  .overlay.err { color: #ffb86b; }

  .resize-handle {
    position: absolute; right: 0; bottom: 0;
    width: 16px; height: 16px; cursor: nwse-resize;
    background: linear-gradient(135deg, transparent 50%, var(--cable-video) 50%, var(--cable-video) 60%, transparent 60%, transparent 70%, var(--cable-video) 70%, var(--cable-video) 80%, transparent 80%);
    opacity: 0.7; z-index: 5;
  }
  .resize-handle:hover { opacity: 1; }
</style>
