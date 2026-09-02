<script lang="ts">
  // packages/web/src/lib/ui/modules/archivist/ArchivistArchiveBody.svelte
  //
  // The ARCHIVIST dock full-view body: the picture, the SCREEN switch, and the
  // archive.org browse surface this module exists for.
  //
  // ⚠ WHY THE FACE NEEDS A BODY AT ALL — and it is a different reason from
  // peertube's, though the two look alike. peertube LEFT `DOM_SOURCE_LANE_TYPES`
  // and has no card anywhere. archivist is still IN it, so promotion parks the
  // real `ArchivistCard.svelte` in `<HeadlessSourceHost>` at `left:-9999px`
  // with `pointer-events: none`: the card is MOUNTED — which is what keeps the
  // three node-owned elements attached and a loaded item playing — but nothing
  // on it is CLICKABLE. Keeping the source alive and keeping the module USABLE
  // are two different problems, and only the first one had a mechanism before
  // this face. Without this body a promoted archivist could never be given a
  // single item: `node.data.item` is null until a search writes one, and the
  // factory searches nothing on its own.
  //
  // ⚠ THE PICTURE IS BLITTED FROM THE ENGINE AND THE NODE-OWNED ELEMENTS ARE
  // NEVER ADOPTED HERE. A DOM node has exactly one parent and the card holds
  // all three leases (`nodeMedia.adopt(id, 'video'|'audio'|'image', …)`);
  // adopting one here would move it out from under the mount that owns the
  // attach, which is the cameraInput constraint in its unrecoverable form.
  // `blitOutputForPreview` reads the module's OWN output texture instead, which
  // is also strictly more honest: the output is what `gain` scales and what
  // downstream modules receive, and the card's raw-element preview
  // structurally cannot show `gain` at all.
  //
  // ⚠ AND THE BLIT IS WHY A *VIDEO* ITEM SHOWS NOTHING HERE, which is correct
  // rather than a defect to chase. archive.org serves its video without CORS,
  // so `archivist.ts` deliberately never textures a video element — the FBO
  // holds the idle pattern and this canvas faithfully paints it. The video
  // still plays and scrubs (the card's element is live off-screen and its
  // `playing`/`playhead`/`ended` jacks all fire); what is unavailable is the
  // PICTURE, which is exactly what the CLEAN OUT lamp says.
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import { archivistStatus, ARCHIVIST_STATUS_IDLE } from '$lib/ui/media/archivist-status-registry';
  import type { ArchivistData } from '$lib/video/modules/archivist';
  import { buildDetailsUrl, hasCleanOutput } from '$lib/video/modules/archivist-query';
  import { drawPreviewDownscaled } from '../preview-downscale';
  import ArchivistBrowseControls from './ArchivistBrowseControls.svelte';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets. */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // ── LEAF DERIVATIONS WITH THE NODE SIGNAL TOUCHED INSIDE ─────────────────
  //
  // ⚠ BOTH HALVES, AND THE SECOND ONE IS THE HALF THAT SHIPPED A BUG NEXT DOOR.
  // `nodeVersion(nodeId)` is how a surface subscribes to a node's per-node
  // signal — but touching it is NOT enough if the derivation returns the NODE:
  // the SyncedStore proxy has a stable identity, so a `$derived` that recomputes
  // to the same proxy is value-equal and Svelte notifies nobody. That is
  // measured, on recorderbox (#2314), where a RECORD press wrote the doc
  // correctly and the switch stayed on `● REC`. So every read below touches the
  // signal AND lands on a LEAF, and the leaves are what go down to the shared
  // controls as props.
  function data(): Partial<ArchivistData> | undefined {
    void nodeVersion(nodeId);
    return patch.nodes[nodeId]?.data as Partial<ArchivistData> | undefined;
  }

  let itemTitle = $derived<string | null>(data()?.item?.title ?? null);
  let itemType = $derived(data()?.item?.type ?? null);
  let itemIdentifier = $derived<string | null>(data()?.item?.identifier ?? null);
  let durationSec = $derived<number>(data()?.item?.duration ?? 0);
  let isPlaying = $derived<boolean>(data()?.isPlaying ?? false);
  let hasItem = $derived<boolean>(itemIdentifier !== null);
  let cleanOutput = $derived<boolean>(itemType ? hasCleanOutput(itemType) : false);
  let detailsUrl = $derived<string>(itemIdentifier ? buildDetailsUrl(itemIdentifier) : '');

  // The card's browser-local progress, for the transient overlays only.
  let statusTick = $state(0);
  $effect(() => archivistStatus.subscribe(nodeId, () => { statusTick += 1; }));
  let status = $derived.by(() => {
    void statusTick;
    return archivistStatus.read(nodeId) ?? ARCHIVIST_STATUS_IDLE;
  });

  // ── THE ITEM NAME LIVES ON THE ACCESSIBLE NAME, NOT IN A TEXT NODE ────────
  //
  // ⚠ THE CARD'S `Internet Archive · {type}` LINE IS DELETED, NOT HIDDEN.
  // Owner ruling: a faceplate paints no resting readout of derived state. The
  // media type restated the select two rows up and the source is the module's
  // entire identity, so neither clause survives as text. What the line actually
  // carried — which item is loaded and what kind it is — is here, speakable and
  // assertable, and the item's own NAME is still painted inside the attribution
  // anchor that opens it.
  let pictureLabel = $derived<string>(
    hasItem
      ? `ARCHIVIST picture — ${itemType} item “${itemTitle}” from the Internet Archive`
        + (cleanOutput ? '' : ' (play-only: no clean picture output)')
      : 'ARCHIVIST picture — nothing loaded',
  );

  // ── SCREEN, on the shared key ────────────────────────────────────────────
  // `previewCollapsed` is the FLEET-WIDE screen key, deliberately not declared
  // on any module's own Data interface (it appears in zero shell files and is
  // read untyped by every video body), so it is read off the raw record.
  let previewCollapsed = $derived<boolean>(
    ((data() as Record<string, unknown> | undefined)?.previewCollapsed as boolean | undefined) ?? false,
  );
  function togglePreview(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }

  // ── SCREEN OFF STOPS THE COPY AND KEEPS THE WATCH MARK ───────────────────
  //
  // The switch reclaims the preview's vertical space; it must never become a
  // MUTE for everything downstream. A lapsed watch mark drops the node from the
  // pull set, so the loop keeps marking the node watched while collapsed and
  // simply stops copying pixels into this canvas.
  //
  // ⚠ THE STAKES ARE THE SOURCE-MODULE ONES, IN THEIR STRONGEST FORM: archivist
  // is a pure SOURCE feeding `image`, `video` AND `audio_l`/`audio_r`, so a
  // lapsed mark would idle the picture every consumer samples. ⚠ AND SCREEN OFF
  // CANNOT REACH THE PLAYBACK AT ALL, which is a stronger guarantee than the
  // ordering-dependent one: the element, its `play()`, the 100 ms playhead pump
  // and the gate/CV writes are ALL the off-screen card's, and this component
  // never touches them. Turning the screen off skips a `drawImage`; the item
  // goes on playing, `playing`/`playhead`/`ended` go on firing, and the audio
  // jacks go on carrying signal.
  function draw() {
    rafId = null;
    const e = engineCtx.get();
    if (!e) { rafId = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); }
    catch { videoEngine = undefined; }
    if (!videoEngine) { rafId = requestAnimationFrame(draw); return; }

    if (previewCollapsed) {
      try { videoEngine.markWatched(nodeId); } catch { /* never nuke the rAF loop */ }
      rafId = requestAnimationFrame(draw);
      return;
    }

    if (!canvasEl) { rafId = requestAnimationFrame(draw); return; }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      let blitted = false;
      try { blitted = videoEngine.blitOutputForPreview(nodeId); } catch { /* never nuke the rAF loop */ }
      if (!blitted) { rafId = requestAnimationFrame(draw); return; }
      const srcCanvas = videoEngine.canvas as CanvasImageSource;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      const srcAspect = ENGINE_W / ENGINE_H;
      const dstAspect = cw / ch;
      let w = cw, h = ch, x = 0, y = 0;
      if (dstAspect > srcAspect) { h = ch; w = Math.round(h * srcAspect); x = Math.round((cw - w) / 2); }
      else { w = cw; h = Math.round(w / srcAspect); y = Math.round((ch - h) / 2); }
      drawPreviewDownscaled(ctx2d, srcCanvas, x, y, w, h);
    }
    rafId = requestAnimationFrame(draw);
  }

  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });
</script>

<div
  class="arc-body"
  data-testid="archivist-face-body"
  data-media-type={itemType ?? 'none'}
  data-has-item={hasItem}
  data-clean-output={cleanOutput}
  data-is-playing={isPlaying}
>
  <div
    class="preview-wrap"
    data-testid="archivist-face-preview"
    data-preview-collapsed={previewCollapsed ? 'true' : 'false'}
    role="img"
    aria-label={pictureLabel}
  >
    {#if !previewCollapsed}
      <canvas
        bind:this={canvasEl}
        width={480}
        height={270}
        data-testid="archivist-face-canvas"
        data-node-id={nodeId}
      ></canvas>
      <!-- Transient OUTCOMES and a placeholder naming this surface's own
           condition — not resting readouts. Each is replaced the moment an item
           exists (the samsloop NO SAMPLE LOADED shape). -->
      {#if status.loading}
        <div class="overlay" data-testid="archivist-face-loading">
          <div class="spinner" aria-hidden="true"></div>
          <div class="sub">{status.statusMsg ?? 'Loading…'}</div>
        </div>
      {:else if !hasItem}
        <div class="overlay" data-testid="archivist-face-empty">
          <div>Search the Internet Archive</div>
          <div class="sub">pick a type + term, press Enter</div>
        </div>
      {:else if itemType === 'audio'}
        <!-- An AUDIO item has no picture to show and the module's FBO holds the
             idle pattern, so this names that condition rather than leaving a
             dark rectangle that reads as a broken video. The title inside it is
             the loaded item's own caption — the picturebox per-slot-filename
             shape — not a restatement of a control. -->
        <div class="overlay audio-art" data-testid="archivist-face-audio-art">
          <div class="audio-art-icon" aria-hidden="true">♪</div>
          <div class="sub">{itemTitle}</div>
        </div>
      {/if}
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="archivist-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the picture is collapsed and its space reclaimed. THE ITEM KEEPS PLAYING and keeps feeding IMAGE, VIDEO and AUDIO OUT, and the PLAYING/PLAYHEAD/ENDED jacks keep firing: switching it back on shows the LIVE picture, not a stale frame.'
        : 'SCREEN — turn the picture off to collapse it and reclaim the vertical space. The item goes on playing and feeding OUT either way.'}
    >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
  </div>

  <ArchivistBrowseControls
    {nodeId}
    testidPrefix="archivist-face"
    {hasItem}
    {itemTitle}
    {itemType}
    {durationSec}
    {isPlaying}
    {cleanOutput}
    {detailsUrl}
  />
</div>

<style>
  .arc-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 0;
    padding: 4px 0;
  }

  .preview-wrap {
    position: relative;
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    overflow: hidden;
    flex: 0 0 auto;
  }
  .preview-wrap canvas {
    display: block;
    width: 100%;
    height: auto;
    aspect-ratio: 16 / 9;
    background: #000;
  }
  .preview-wrap[data-preview-collapsed='true'] { border-style: dashed; }

  .overlay {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center;
    background: rgba(5, 6, 8, 0.78);
    color: var(--text);
    font-size: 0.72rem; padding: 8px; gap: 6px;
    font-family: ui-monospace, monospace;
    pointer-events: none;
  }
  .overlay .sub { color: var(--text-dim); font-size: 0.6rem; }
  .audio-art .audio-art-icon { font-size: 2.4rem; color: var(--cable-audio); }
  .audio-art .sub {
    max-width: 90%; overflow: hidden; text-overflow: ellipsis;
    display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical;
  }
  .spinner {
    width: 18px; height: 18px; border-radius: 50%;
    border: 2px solid #2a3340; border-top-color: var(--cable-video);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .screen-btn {
    position: absolute; right: 4px; top: 4px;
    background: rgba(5, 6, 8, 0.8);
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 2px;
    padding: 1px 6px;
    font-size: 0.5rem;
    letter-spacing: 0.06em;
    font-family: ui-monospace, monospace;
    cursor: pointer;
    z-index: 2;
  }
  .screen-btn.on { color: var(--cable-video); border-color: var(--cable-video); }
  .preview-wrap[data-preview-collapsed='true'] .screen-btn { position: static; margin: 4px; }
</style>
