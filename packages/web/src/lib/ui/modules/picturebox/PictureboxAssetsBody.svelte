<script lang="ts">
  // packages/web/src/lib/ui/modules/picturebox/PictureboxAssetsBody.svelte
  //
  // The PICTUREBOX dock full-view body: the live picture, the file pickers, the
  // 7-slot asset bank, and the SCREEN ON/OFF switch the 2026-08-18 owner ruling
  // requires of every video module.
  //
  // ── ⚠ WHY THIS FILE EXISTS, AND WHY IT IS NOT JUST A SCREEN SWITCH ─────────
  //
  // Promotion sets `migrated(type)` true, and from that moment neither surface
  // renders `PictureboxCard.svelte` — `DockFullView.svelte` mounts
  // `<ModuleShell>` instead. For most faced video modules that costs a preview
  // and a toggle. For picturebox it would cost THE ENTIRE INPUT PATH: the
  // "Choose image…" picker and the seven per-slot pickers are `<input
  // type="file">` elements, and no `ParamCellKind` mounts one. A picturebox with
  // no body is a picture source that can never be given a picture.
  //
  // ── THE DEFECT THE MOVE FIXES (it is not a relocation) ────────────────────
  //
  // On the card, slots 2-7 are reachable ONLY through `oncontextmenu` on the
  // card root (`PictureboxCard.svelte:182-185`, bound at `:239`), which toggles
  // a "Load multiple…" overlay. Nothing on the card's visible surface says so —
  // the gesture is documented only on the docs site. So the module ships a
  // seven-slot instrument whose six extra slots are behind an undiscoverable
  // right-click, and that same right-click ALSO opens the shared node context
  // menu (both fire; `varispeed-panel-layout.spec.ts` presses Escape to dismiss
  // the menu its own right-click summoned).
  //
  // Here the bank is ALWAYS VISIBLE and nothing binds `oncontextmenu`, so the
  // shell's node menu is the only right-click — the fleet behaviour every other
  // faceplate already has.
  //
  // ── THE PICTURE IS THE ENGINE OUTPUT, NOT AN <img> OF `imageBytes` ────────
  //
  // ⚠ AND THE DIFFERENCE IS LOAD-BEARING, not stylistic. The card previews
  // `node.data.imageBytes` through a `data:` URL. That field is the SINGLE-image
  // slot; it is NOT the active slot. picturebox's whole idea is that a clip
  // player's PITCH + GATE select which of the seven slots is showing, and that
  // selection is local render state that is deliberately never written to the
  // Y.Doc (`picturebox.ts:154-156`). So an `<img>` of `imageBytes` shows the
  // WRONG PICTURE the moment a gate selects slot 3 — and it is also blind to
  // GAIN, which is the one control this faceplate ranks. Blitting the node's own
  // output shows the active slot, with gain applied, animating on the engine
  // clock. It is the same seam every other faced video module's body uses.
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import { drawPreviewDownscaled } from '../preview-downscale';
  import { ASSET_SLOTS, ASSET_SLOT_LABELS } from '$lib/video/asset-select';
  import { encodePickedFile, GIF_MIME, TARGET_W, TARGET_H } from '$lib/video/modules/picturebox-encode';
  import {
    setSlotAsset,
    clearSlotAsset,
    setSingleImage,
    padSlotArray,
  } from '$lib/graph/picturebox-data';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  let loading = $state(false);
  let error = $state<string | null>(null);
  let slotLoading = $state<boolean[]>(new Array(ASSET_SLOTS).fill(false));
  // ⚠ PER-SLOT, not one shared string. The card holds ONE `error`, so picking a
  // second file silently clobbers the first pick's outcome. Here the notice
  // stays on the row it describes.
  //
  // ⚠ AND IT IS SESSION-SCOPED, WHICH IS A KNOWN GAP RATHER THAN AN OVERSIGHT.
  // The honest signal is `enc.fellBack`, which exists only at pick time. It is
  // NOT recoverable from `node.data` afterwards: a flattened gif and a
  // single-frame gif BOTH persist as `.gif` filename + `image/jpeg` mime
  // (`encodePickedFile` sends a still gif down the JPEG path with
  // `fellBack: 'none'`), so deriving the warning from the persisted shape would
  // fire on a still gif that lost nothing. A wrong warning is worse than a
  // missing one, so this is not derived.
  let slotNotice = $state<(string | null)[]>(new Array(ASSET_SLOTS).fill(null));

  // ── node.data reads ───────────────────────────────────────────────────────
  let nodeData = $derived(patch.nodes[nodeId]?.data as Record<string, unknown> | undefined);
  let imageMime = $derived<string>((nodeData?.imageMime as string | undefined) ?? 'image/jpeg');
  let imageName = $derived<string | null>((nodeData?.imageName as string | null | undefined) ?? null);
  let hasImage = $derived(
    typeof nodeData?.imageBytes === 'string' && (nodeData.imageBytes as string).length > 0,
  );
  let assets = $derived(padSlotArray(nodeData?.assets));
  let assetNames = $derived(padSlotArray(nodeData?.assetNames));

  // ⚠ THE SYNC STATE IS SPEAKABLE, NOT PAINTED. The card prints
  // `gif` / `synced (1024×768)` under its preview. That is a state word and a
  // measurement about the module — neither is a control caption, an option name
  // or a section label, so it is exactly the shape the resting-text ruling
  // refuses on a faceplate. The information is not deleted: it is the picture's
  // accessible description, which is assertable and unpainted.
  let pictureDescription = $derived(
    !hasImage
      ? 'PICTUREBOX output — no image loaded; the module is showing its idle field'
      : imageMime === GIF_MIME
        ? `PICTUREBOX output — ${imageName ?? 'loaded image'}, an animated gif preserved frame-for-frame and playing on the engine clock`
        : `PICTUREBOX output — ${imageName ?? 'loaded image'}, synced at ${TARGET_W}×${TARGET_H}`,
  );

  // ── SCREEN ON/OFF ─────────────────────────────────────────────────────────
  //
  // ⚠ STATE ON THE NODE, NOT IN THE COMPONENT. This component unmounts on dock
  // collapse / LRU eviction (the card-unmount-kills-node-lifetime-state class,
  // #1531 / #1574 / #1583), and `node.data` is what survives a tab switch — the
  // owner's stated floor — plus a remount, a reload and collab sync.
  //
  // ⚠ IT IS THE SAME `previewCollapsed` KEY EVERY OTHER SURFACE USES. A second
  // spelling is how the key forks. Absent ⇒ false ⇒ ON.
  let previewCollapsed = $derived<boolean>((nodeData?.previewCollapsed as boolean | undefined) ?? false);
  function togglePreview(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }

  // ⚠ SCREEN OFF STOPS THE COPY AND KEEPS THE WATCH MARK (#1937).
  // `blitOutputForPreview` IS the engine's "someone is watching" signal — it
  // calls `markWatched` itself — and a node is a pull root only while that mark
  // is younger than `WATCH_TTL_MS`. A collapsed state that merely stopped
  // blitting would stop marking the node watched and drop it out of the pull
  // set, turning the toggle into a PRODUCER KILL SWITCH wherever nothing
  // downstream is watching. That is the #1720/#1721 class the ruling names when
  // it says the module KEEPS RENDERING.
  //
  // ⚠ AND THE STAKES ARE HIGHER HERE THAN ON A STATELESS EFFECT. picturebox is
  // not a pure per-frame function: an animated gif's frame index is advanced
  // INSIDE `surface.draw` off the engine clock (`picturebox.ts:380-389`). Stop
  // drawing and the gif's clock stops with it, so switching the screen back on
  // would resume a frozen animation from a stale frame — the exact failure the
  // ruling forbids, and one a stateless module cannot exhibit.
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
      // #1802 — gated preview blit (see VideoEngine.blitOutputForPreview).
      let blitted = false;
      try { blitted = videoEngine.blitOutputForPreview(nodeId); } catch { /* never nuke the rAF loop */ }
      if (!blitted) { rafId = requestAnimationFrame(draw); return; }
      const src = videoEngine.canvas as CanvasImageSource;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      const srcAspect = ENGINE_W / ENGINE_H;
      const dstAspect = cw / ch;
      let w = cw, h = ch, x = 0, y = 0;
      if (dstAspect > srcAspect) { h = ch; w = Math.round(h * srcAspect); x = Math.round((cw - w) / 2); }
      else { w = cw; h = Math.round(w / srcAspect); y = Math.round((ch - h) / 2); }
      drawPreviewDownscaled(ctx2d, src, x, y, w, h);
    }
    rafId = requestAnimationFrame(draw);
  }

  // ONE place owns the loop, and it runs in BOTH screen states (see above), so
  // nothing has to restart it on toggle — which removes the "switched back on
  // and the picture never came back" failure mode by construction.
  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });

  // ── the input path ────────────────────────────────────────────────────────
  //
  // Both handlers write through `$lib/graph/picturebox-data`, which is the SAME
  // seam the legacy card writes through. The pad-and-slice that keeps the three
  // per-slot arrays parallel was duplicated verbatim in the card; this body
  // would have been the third copy, so it was folded into one writer first.
  async function onFileChange(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    loading = true;
    error = null;
    try {
      const enc = await encodePickedFile(file);
      if (enc.fellBack === 'gif-too-large') error = 'gif too large — showing first frame only';
      setSingleImage(nodeId, enc, file.name);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
      // Reset so picking the SAME file twice fires a fresh change event.
      try { input.value = ''; } catch { /* not all browsers allow the reset */ }
    }
  }

  async function onSlotFileChange(ev: Event, slot: number): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    slotLoading[slot] = true;
    slotNotice[slot] = null;
    try {
      const enc = await encodePickedFile(file);
      if (enc.fellBack === 'gif-too-large') {
        slotNotice[slot] = 'gif too large — showing first frame only';
      }
      setSlotAsset(nodeId, slot, enc, file.name);
    } catch (err) {
      slotNotice[slot] = err instanceof Error ? err.message : String(err);
    } finally {
      slotLoading[slot] = false;
      try { input.value = ''; } catch { /* not all browsers allow the reset */ }
    }
  }
</script>

<div class="picturebox-body" data-testid="picturebox-assets-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <canvas
        bind:this={canvasEl}
        width={320}
        height={240}
        data-testid="picturebox-face-canvas"
        data-node-id={nodeId}
        data-has-image={hasImage}
        aria-label={pictureDescription}
      ></canvas>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="picturebox-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the picture is collapsed and its space reclaimed. PICTUREBOX keeps rendering, and an animated gif keeps advancing on the engine clock: switching it back on shows the LIVE frame, not a stale one.'
        : 'SCREEN — turn the picture off to collapse it and reclaim the vertical space. The module goes on rendering either way.'}
    >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
  </div>

  <div class="single-row">
    <label class="pick-btn nodrag">
      <input type="file" accept="image/*" onchange={onFileChange} data-testid="picturebox-face-file-input" />
      <span>{loading ? 'Loading…' : 'Choose image…'}</span>
    </label>
    {#if imageName}
      <span class="filename" title={imageName} data-testid="picturebox-face-filename">{imageName}</span>
    {/if}
  </div>
  {#if error}
    <div class="notice" data-testid="picturebox-face-error">{error}</div>
  {/if}

  <!-- THE 7-SLOT BANK — always visible. Each row is one scale degree of C major
       (C D E F G A B); a clip player's pitch + gate select the row by PITCH
       CLASS, octave-independent. The note tag is an option/landmark NAME (it
       says which note reaches this slot), and the filename is the row's own
       caption — a file bank whose rows do not say which file is in them is not
       a file bank. -->
  <div class="bank" data-testid="picturebox-face-bank">
    {#each ASSET_SLOT_LABELS as label, i (i)}
      <div class="slot-row" data-testid="picturebox-face-slot-{i}">
        <span class="slot-note">{label}</span>
        <label class="slot-load nodrag">
          <input
            type="file"
            accept="image/*"
            onchange={(e) => onSlotFileChange(e, i)}
            data-testid="picturebox-face-slot-input-{i}"
            aria-label="Load an image into slot {label}"
          />
          <span>{slotLoading[i] ? '…' : 'Load file…'}</span>
        </label>
        <span class="slot-name" title={assetNames[i] ?? ''} data-testid="picturebox-face-slot-name-{i}"
          >{assetNames[i] ?? '—'}</span
        >
        {#if assets[i]}
          <button
            type="button"
            class="slot-clear nodrag"
            onclick={() => clearSlotAsset(nodeId, i)}
            data-testid="picturebox-face-slot-clear-{i}"
            aria-label="Clear slot {label}">✕</button
          >
        {:else}
          <span class="slot-clear-spacer" aria-hidden="true"></span>
        {/if}
      </div>
      {#if slotNotice[i]}
        <div class="notice" data-testid="picturebox-face-slot-notice-{i}">{slotNotice[i]}</div>
      {/if}
    {/each}
  </div>
</div>

<style>
  /* COMPACT BY DEFAULT. The plate sizes to content, and this body is the
     content — so its width IS the faceplate's width. The bank row is the widest
     element and the legacy card fits the same four columns in 220 px; 320 px
     here buys a legible filename column and nothing else. */
  .picturebox-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 320px;
    max-width: 100%;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SCREEN SWITCH COSTS ZERO LAYOUT HEIGHT — a fix, not a style choice
     (see the OVERLAY paragraph in module-faceplates.md: a stacked row cost
     ~18.8 px on a card with ~11 px of slack). It OVERLAYS the picture's
     bottom-right corner, so the body is exactly the height the picture is. */
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF: the canvas is gone, and without a
       floor the wrap would collapse to zero and take the absolutely-positioned
       button with it. Inert behind the canvas whenever the picture shows. */
    min-height: 18px;
  }
  .preview-wrap canvas {
    display: block;
    border-radius: 3px;
    background: #050608;
    max-width: 100%;
    height: auto;
  }
  .screen-btn {
    position: absolute;
    right: 4px;
    bottom: 4px;
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 2px;
    /* Legible over a live picture — a transparent button was not. */
    background: rgba(5, 6, 8, 0.72);
    color: var(--text-dim);
    cursor: pointer;
  }
  .screen-btn.on { color: var(--text); border-color: var(--accent-dim); }
  .screen-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }

  .single-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .pick-btn, .slot-load {
    display: inline-block;
    background: var(--cable-image);
    color: #000;
    border-radius: 2px;
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
  }
  .pick-btn { padding: 3px 8px; font-size: 0.65rem; }
  .slot-load { padding: 1px 5px; font-size: 0.55rem; }
  .pick-btn input, .slot-load input { display: none; }
  .filename, .slot-name {
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .filename { font-size: 0.6rem; flex: 1; }
  .slot-name { font-size: 0.55rem; }
  .notice {
    font-size: 0.6rem;
    color: #f87171;
    font-family: ui-monospace, monospace;
  }

  .bank {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .slot-row {
    display: grid;
    grid-template-columns: 14px auto 1fr 14px;
    align-items: center;
    gap: 4px;
  }
  .slot-note {
    font-size: 0.65rem;
    font-weight: 600;
    color: var(--cable-image);
    font-family: ui-monospace, monospace;
    text-align: center;
  }
  .slot-clear {
    background: none;
    border: none;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 0.65rem;
    padding: 0 2px;
    line-height: 1;
  }
  .slot-clear:hover { color: #f87171; }
  /* Keeps the four columns aligned on an empty slot, so the rows do not jitter
     as pictures are loaded and cleared. */
  .slot-clear-spacer { display: block; }
</style>
