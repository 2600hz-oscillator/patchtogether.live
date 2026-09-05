<script lang="ts">
  // packages/web/src/lib/ui/modules/peertube/PeerTubeBrowseBody.svelte
  //
  // The PEERTUBE dock full-view body: the picture, the SCREEN switch, and the
  // browse surface this module exists for.
  //
  // ⚠ WHY THE FACE NEEDS A BODY AT ALL. Promotion stops BOTH surfaces rendering
  // `PeerTubeCard.svelte` (`DockFullView` mounts `<ModuleShell>` instead), and
  // peertube is NOT in `DOM_SOURCE_LANE_TYPES` — it left with the rest of the
  // HLS pair in LEG-02 P3 (#1511) when its stream became node-owned — so there
  // is no `<HeadlessSourceHost>` keeping an off-screen card around either.
  // Under the shell the card is not mounted ANYWHERE. Without this file a
  // promoted peertube could not be searched at all.
  //
  // ⚠ THE PICTURE IS BLITTED FROM THE ENGINE AND THE `<video>` IS NEVER ADOPTED
  // HERE — the TvLibrarianTunerBody constraint, reached for the same two
  // reasons. A DOM node has exactly one parent, and this one belongs to a
  // NODE-lifetime owner that keeps it alive with nothing mounted: adopting it
  // here would move it out from under that owner. `blitOutputForPreview` reads
  // the module's OWN output texture instead, which is also strictly more honest
  // — the output is what `gain` scales and what downstream modules receive, and
  // a raw-element preview structurally cannot show `gain` at all.
  //
  // ⚠ NOT A SECOND OWNER. The stream, its hls.js demuxer, the engine attach,
  // the audio wire, the search catalogue and both trigger polls are all
  // `$lib/ui/media/node-hls-source`'s, on NODE lifetime. This body reads what
  // the controller publishes and forwards gestures to it, exactly as the card
  // does.
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { nodeHlsSource } from '$lib/ui/media/node-hls-source.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { PeerTubeData } from '$lib/video/modules/peertube-query';
  import { drawPreviewDownscaled } from '../preview-downscale';
  import PeerTubePicker from './PeerTubePicker.svelte';

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

  let src = $derived(nodeHlsSource.view(nodeId));
  let streamState = $derived(src.streamState);
  // ⚠ LEAF READS, PASSED DOWN AS LEAVES. A plain
  // `patch.nodes[nodeId]?.data.<leaf>` read IS reactive in this subtree — every
  // other faceplate body does the same — but stopping at `.data` and handing
  // the OBJECT to the picker is not: that proxy's identity never changes, so
  // the child's `$derived` would never re-run. See the `selectedHost` prop note
  // in PeerTubePicker.
  let selectedHost = $derived<string | null>(
    (patch.nodes[nodeId]?.data as Partial<PeerTubeData> | undefined)?.selectedHost ?? null,
  );
  let uuid = $derived<string | null>(
    (patch.nodes[nodeId]?.data as Partial<PeerTubeData> | undefined)?.uuid ?? null,
  );

  // ── THE VIDEO NAME LIVES ON THE ACCESSIBLE NAME, NOT IN A TEXT NODE ───────
  //
  // ⚠ THE CARD'S `peertube-now-playing` LABEL IS DELETED, NOT HIDDEN. Owner
  // ruling, 2026-08-17: a faceplate paints no resting readout of derived state,
  // and the data is REMOVED rather than tucked behind a hover. It was a
  // standalone restatement of which roster row is selected, painted outside
  // every control. It survives here — speakable and assertable — and the
  // roster's own highlighted row is the painted answer.
  //
  // ⚠ `selectionLabel` RATHER THAN THE ROSTER, and that is the difference from
  // tvLibrarian: `PEERTUBE_PROFILE.autoLoadCatalogue` is FALSE, so a reloaded
  // rack restores the selection with an EMPTY catalogue and no row to
  // highlight. The controller publishes `selectionLabel` from `node.data`, so
  // it survives that state where a roster-highlight argument would not.
  let pictureLabel = $derived<string>(
    src.selectionLabel
      ? `PEERTUBE picture — playing ${src.selectionLabel}${selectedHost ? ` on ${selectedHost}` : ''}`
      : 'PEERTUBE picture — nothing selected',
  );

  // ── SCREEN, on the shared key ────────────────────────────────────────────
  let previewCollapsed = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.previewCollapsed as boolean | undefined) ?? false,
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
  // simply stops copying pixels into this canvas. ⚠ AND THE STAKES ARE HIGHER
  // HERE THAN ON A MID-GRAPH EFFECT: peertube is a SOURCE feeding `video` AND
  // `audio_l`/`audio_r`, so a lapsed mark would idle the picture every consumer
  // samples while the element kept decoding. The stream itself is the
  // controller's and is not consulted here at all — turning the screen off
  // never stops the tuner.
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

<!-- State attributes ride the body root (the archivist/varispeed face-body
     pattern): `data-has-selection` is the same `uuid !== null` fact the card
     stamps, kept on both surfaces so neither can drift silently. -->
<div
  class="pt-browse-body"
  data-testid="peertube-face-body"
  data-stream-state={streamState}
  data-has-selection={uuid !== null}
>
  <div
    class="preview-wrap"
    data-testid="peertube-face-preview"
    data-preview-collapsed={previewCollapsed ? 'true' : 'false'}
    role="img"
    aria-label={pictureLabel}
  >
    {#if !previewCollapsed}
      <canvas
        bind:this={canvasEl}
        width={480}
        height={270}
        data-testid="peertube-face-canvas"
        data-node-id={nodeId}
      ></canvas>
      <!-- Transient OUTCOMES and a placeholder naming this surface's own
           condition — not resting readouts. Each is replaced the moment a
           stream exists (the samsloop NO SAMPLE LOADED shape). -->
      {#if streamState === 'loading'}
        <div class="overlay" data-testid="peertube-loading">loading…</div>
      {:else if streamState === 'unavailable'}
        <div class="overlay err" data-testid="peertube-unavailable">display unavailable — skipping</div>
      {:else if !uuid}
        <div class="overlay" data-testid="peertube-empty">search, then pick a video</div>
      {/if}
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="peertube-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the picture is collapsed and its space reclaimed. THE STREAM KEEPS RUNNING and keeps feeding VIDEO and AUDIO OUT: switching it back on shows the LIVE picture, not a stale frame.'
        : 'SCREEN — turn the picture off to collapse it and reclaim the vertical space. The video goes on playing and feeding OUT either way.'}
    >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
  </div>

  <PeerTubePicker {nodeId} {selectedHost} {uuid} />
</div>

<style>
  .pt-browse-body {
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
    display: flex; align-items: center; justify-content: center;
    text-align: center;
    background: rgba(5, 6, 8, 0.78);
    color: var(--text-dim);
    font-size: 0.65rem; padding: 6px;
    font-family: ui-monospace, monospace;
    pointer-events: none;
  }
  .overlay.err { color: #ffb86b; }

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
