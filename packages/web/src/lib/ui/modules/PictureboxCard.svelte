<script lang="ts">
  // PictureboxCard — file-picker source. User clicks "Choose image..."
  // → file is downscaled to 640x480 (zoom-fit-crop) → encoded as JPEG
  // q=85 → base64 → written into node.data.imageBytes. The Y.Doc carries
  // those bytes to every rack-mate; each peer's PictureboxCard runs the
  // reverse path (base64 → ImageBitmap → engine.setImage) automatically.
  //
  // Multiplayer: image content NOW syncs across rack-mates. See
  // .myrobots/plans/picturebox-multiplayer-sync.md for the sizing,
  // codec, and limit decisions.
  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { pictureboxDef, type PictureboxHandleExtras } from '$lib/video/modules/picturebox';
  import {
    encodePickedFile,
    base64ToImageBitmap,
    decodeAnimatedGif,
    GIF_MIME,
    TARGET_W,
    TARGET_H,
  } from '$lib/video/modules/picturebox-encode';
  import { ASSET_SLOTS, ASSET_SLOT_LABELS, slotForVOct } from '$lib/video/asset-select';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let loading = $state(false);
  let error = $state<string | null>(null);
  // "Load multiple…" 7-slot panel (opened via right-click on the card).
  let multiOpen = $state(false);
  let slotLoading = $state<boolean[]>(new Array(ASSET_SLOTS).fill(false));

  // Reactive reads of the persisted shape (lives on node.data). Survives
  // remote Yjs updates because data flows through the snapshot bus.
  let imageBytes = $derived<string | null>(
    (node?.data as { imageBytes?: string | null } | undefined)?.imageBytes ?? null,
  );
  let imageName = $derived<string | null>(
    (node?.data as { imageName?: string | null } | undefined)?.imageName ?? null,
  );
  let imageMime = $derived<string>(
    (node?.data as { imageMime?: string } | undefined)?.imageMime ?? 'image/jpeg',
  );
  let hasImage = $derived(imageBytes !== null && imageBytes.length > 0);
  // Animated gif → the card preview (a data: URL <img>) animates natively; a
  // still shows a static frame. Guarded on hasImage so an empty card (the VRT
  // baseline state) renders no preview.
  let isGif = $derived(imageMime === GIF_MIME);

  // v3: 7-slot asset arrays (synced base64 JPEGs + parallel filenames). The
  // DISPLAYED slot is local render state computed from the gate stream — NOT
  // synced — so we never write it to the Y.Doc per gate event.
  let assets = $derived<(string | null)[]>(
    (node?.data as { assets?: (string | null)[] } | undefined)?.assets
      ?? new Array(ASSET_SLOTS).fill(null),
  );
  let assetNames = $derived<(string | null)[]>(
    (node?.data as { assetNames?: (string | null)[] } | undefined)?.assetNames
      ?? new Array(ASSET_SLOTS).fill(null),
  );
  // v4: per-slot MIME (parallel to assets). Absent ⇒ all-jpeg (v3 nodes only
  // ever stored JPEGs), so a missing entry decodes down the static path.
  let assetMimes = $derived<(string | null)[]>(
    (node?.data as { assetMimes?: (string | null)[] } | undefined)?.assetMimes
      ?? new Array(ASSET_SLOTS).fill(null),
  );

  function p(name: string): number {
    const def = pictureboxDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  function getExtras(): PictureboxHandleExtras | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      const videoEngine = e.getDomain<VideoEngine>('video');
      const extras = videoEngine.read(id, 'extras') as PictureboxHandleExtras | undefined;
      return extras ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Push the latest persisted bytes into the local engine's source
   * texture. Runs whenever imageBytes changes (local file pick OR remote
   * peer update). Decoding happens off the main thread via
   * createImageBitmap (in picturebox-encode.ts). Re-runs are tolerated
   * by the engine — texImage2D simply overwrites.
   *
   * We track the last-applied bytes so a second card mount with the same
   * data doesn't redundantly decode (the $derived recomputes whenever
   * the snapshot bus fires, even when our specific byte string didn't
   * actually change).
   *
   * IMPORTANT: when this card mounts as part of a patch LOAD (envelope
   * already carries imageBytes, e.g. the GLITCHES GET RICHES demo or any
   * user-saved patch), the $effect fires on first mount BEFORE the
   * reconciler has instantiated the engine-side picturebox node. The
   * engine context exists but `read(id, 'extras')` returns undefined.
   * `engineCtx.get()` is a non-reactive getter — reading it does NOT
   * subscribe the $effect to engine readiness, so there is no natural
   * re-fire when extras becomes available. To bridge that, we RETRY
   * (mirroring VideoboxCard.ensureAudioWired's pattern) until extras
   * appears or we exhaust the attempt budget. ~5s @ 100ms is generous
   * for the reconciler microtask (typical end-to-end ~150ms post-click).
   */
  let lastAppliedBytes: string | null = null;
  let applyRetryTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const bytes = imageBytes;
    void bytes;
    void node?.id;
    if (bytes === lastAppliedBytes) return;
    lastAppliedBytes = bytes;
    if (applyRetryTimer) { clearTimeout(applyRetryTimer); applyRetryTimer = null; }
    void applyBytesToEngine(bytes, 0);
  });
  // Clear any pending retry on card unmount so we don't leak setTimeout
  // handles into the page's task queue when SvelteFlow tears down nodes
  // (e.g., user clears the patch while extras was still pending).
  $effect(() => {
    return () => {
      if (applyRetryTimer) { clearTimeout(applyRetryTimer); applyRetryTimer = null; }
    };
  });

  async function applyBytesToEngine(bytes: string | null, attempt: number): Promise<void> {
    const extras = getExtras();
    if (!extras) {
      // Engine hasn't materialized this card's video node yet (most
      // common during a patch load: the reconciler microtask runs
      // after the card mounts). Schedule a short retry — bytes are
      // stable on node.data so we can safely close over them. Cap
      // at ~50 attempts (5s) to bound the retry storm.
      if (attempt >= 50) return;
      // Reset lastAppliedBytes so a real `imageBytes` change during
      // the retry window still kicks off a fresh attempt via the
      // $effect (rather than getting suppressed by the equality check).
      lastAppliedBytes = null;
      applyRetryTimer = setTimeout(() => {
        applyRetryTimer = null;
        // Re-check the latest bytes off `node.data` (a remote write
        // during the wait window should win). Snapshot here so we don't
        // touch reactive state from the timeout callback.
        const latest = (node?.data as { imageBytes?: string | null } | undefined)?.imageBytes ?? null;
        lastAppliedBytes = latest;
        void applyBytesToEngine(latest, attempt + 1);
      }, 100);
      return;
    }
    if (bytes === null) {
      extras.setImage(null);
      extras.setAnimatedImage(null);
      extras.setFilename(null);
      return;
    }
    // Read the MIME fresh off node.data (a remote write during the retry window
    // should win, same as `bytes`).
    const mime = (node?.data as { imageMime?: string } | undefined)?.imageMime ?? 'image/jpeg';
    try {
      if (mime === GIF_MIME) {
        // Animated gif: decode all frames (WebCodecs) and let the module step
        // them on the engine clock. Where ImageDecoder is unavailable, fall back
        // to a static first frame — no error, just no motion.
        const gifFrames = await decodeAnimatedGif(bytes, mime);
        if (gifFrames && gifFrames.length > 1) {
          extras.setAnimatedImage(gifFrames);
          extras.setFilename(imageName);
          return;
        }
        const firstFrame = await base64ToImageBitmap(bytes, mime);
        extras.setImage(firstFrame);
        extras.setFilename(imageName);
        return;
      }
      const bitmap = await base64ToImageBitmap(bytes);
      extras.setImage(bitmap);
      extras.setFilename(imageName);
    } catch (err) {
      // Decode failure on a peer = the writer sent something we can't
      // parse. Don't reset hasImage — the writer's local copy still
      // works; just log + show the error in our UI.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[picturebox] decode failed:', msg);
      error = `Decode failed: ${msg}`;
    }
  }

  // ---- 7-slot asset pre-upload ----------------------------------------
  //
  // Decode every loaded `assets[i]` base64 → ImageBitmap and pre-upload it
  // into the engine slot texture, so a gate-driven switch is an instant
  // active-index flip (no decode/upload on the gate). Re-runs when the
  // synced `assets` array changes (local load OR remote peer). We track the
  // last-applied byte string per slot to avoid redundant re-decode when the
  // snapshot bus re-fires with unchanged bytes. Like the single-image path,
  // this RETRIES until the engine has materialized this node (patch load).
  const lastSlotBytes: (string | null)[] = new Array(ASSET_SLOTS).fill(undefined as unknown as null);
  let slotRetryTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const snapshot = assets.slice(0, ASSET_SLOTS);
    const mimeSnapshot = assetMimes.slice(0, ASSET_SLOTS);
    void node?.id;
    if (slotRetryTimer) { clearTimeout(slotRetryTimer); slotRetryTimer = null; }
    void applySlotsToEngine(snapshot, mimeSnapshot, 0);
  });
  $effect(() => () => {
    if (slotRetryTimer) { clearTimeout(slotRetryTimer); slotRetryTimer = null; }
  });

  async function applySlotsToEngine(
    snapshot: (string | null)[],
    mimeSnapshot: (string | null)[],
    attempt: number,
  ): Promise<void> {
    const extras = getExtras();
    if (!extras || !extras.setAssetAtSlot) {
      if (attempt >= 50) return;
      slotRetryTimer = setTimeout(() => {
        slotRetryTimer = null;
        const d = node?.data as { assets?: (string | null)[]; assetMimes?: (string | null)[] } | undefined;
        const latest = (d?.assets ?? new Array(ASSET_SLOTS).fill(null)).slice(0, ASSET_SLOTS);
        const latestMimes = (d?.assetMimes ?? new Array(ASSET_SLOTS).fill(null)).slice(0, ASSET_SLOTS);
        void applySlotsToEngine(latest, latestMimes, attempt + 1);
      }, 100);
      return;
    }
    for (let i = 0; i < ASSET_SLOTS; i++) {
      const bytes = snapshot[i] ?? null;
      if (bytes === lastSlotBytes[i]) continue;
      lastSlotBytes[i] = bytes;
      if (!bytes) {
        extras.setAssetAtSlot(i, null);
        continue;
      }
      const mime = mimeSnapshot[i] ?? 'image/jpeg';
      try {
        if (mime === GIF_MIME) {
          const gifFrames = await decodeAnimatedGif(bytes, mime);
          if (gifFrames && gifFrames.length > 1) {
            extras.setAnimatedAtSlot(i, gifFrames);
            continue;
          }
          // Degrade: static first frame.
          extras.setAssetAtSlot(i, await base64ToImageBitmap(bytes, mime));
          continue;
        }
        extras.setAssetAtSlot(i, await base64ToImageBitmap(bytes));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[picturebox] slot ${i} decode failed:`, msg);
      }
    }
  }

  // ---- asset_gate edge detection → slot select ------------------------
  //
  // Mirror VIDEOVARISPEED's polled gate loop: each tick read the raw
  // asset_gate level (bridge-written synthetic param), detect a rising
  // edge, and on a rising edge read the raw asset_pitch V/oct, map it to a
  // slot (asset-select.slotForVOct), and select that slot IF it holds an
  // asset. A black-key pitch (slotForVOct → null) or an empty slot is
  // ignored (keep showing the current asset). The selection is purely
  // LOCAL render state — every peer computes it from the same synced gate +
  // synced assets, so we never write it to the Y.Doc.
  let lastAssetGate = 0;
  function readParamLive(paramId: string): number {
    const e = engineCtx.get();
    if (!e || !node) return 0;
    const v = e.readParam(node, paramId);
    return typeof v === 'number' ? v : 0;
  }
  let gateTimer: ReturnType<typeof setInterval> | null = null;
  onMount(() => {
    gateTimer = setInterval(() => {
      const e = engineCtx.get();
      if (!e || !node) return;
      const g = readParamLive('asset_gate');
      const rising = lastAssetGate < 0.5 && g >= 0.5;
      lastAssetGate = g;
      if (!rising) return;
      const slot = slotForVOct(readParamLive('asset_pitch'));
      if (slot == null) return; // black key — no slot, ignore
      const extras = getExtras();
      if (extras?.slotHasAsset?.(slot)) extras.selectSlot(slot);
    }, 33);
  });
  onDestroy(() => {
    if (gateTimer !== null) { clearInterval(gateTimer); gateTimer = null; }
  });

  // ---- "Load multiple…" panel: per-slot file load --------------------
  async function onSlotFileChange(ev: Event, slot: number): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    slotLoading[slot] = true;
    error = null;
    try {
      const enc = await encodePickedFile(file);
      if (enc.fellBack === 'gif-too-large') {
        error = `gif too large — showing first frame only`;
      }
      ydoc.transact(() => {
        const target = patch.nodes[id];
        if (!target) return;
        if (!target.data) target.data = {};
        const d = target.data as Record<string, unknown>;
        const arr = Array.isArray(d.assets)
          ? (d.assets as (string | null)[]).slice(0, ASSET_SLOTS)
          : new Array(ASSET_SLOTS).fill(null);
        while (arr.length < ASSET_SLOTS) arr.push(null);
        arr[slot] = enc.base64;
        d.assets = arr;
        const names = Array.isArray(d.assetNames)
          ? (d.assetNames as (string | null)[]).slice(0, ASSET_SLOTS)
          : new Array(ASSET_SLOTS).fill(null);
        while (names.length < ASSET_SLOTS) names.push(null);
        names[slot] = file.name;
        d.assetNames = names;
        const mimes = Array.isArray(d.assetMimes)
          ? (d.assetMimes as (string | null)[]).slice(0, ASSET_SLOTS)
          : new Array(ASSET_SLOTS).fill(null);
        while (mimes.length < ASSET_SLOTS) mimes.push(null);
        mimes[slot] = enc.mime;
        d.assetMimes = mimes;
      }, LOCAL_ORIGIN);
      // The $effect pre-uploads the new slot bytes to the engine on the next
      // microtask (same path as a remote peer's update).
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      slotLoading[slot] = false;
      try { input.value = ''; } catch { /* */ }
    }
  }

  function clearSlot(slot: number): void {
    ydoc.transact(() => {
      const target = patch.nodes[id];
      if (!target) return;
      if (!target.data) target.data = {};
      const d = target.data as Record<string, unknown>;
      const arr = Array.isArray(d.assets)
        ? (d.assets as (string | null)[]).slice(0, ASSET_SLOTS)
        : new Array(ASSET_SLOTS).fill(null);
      while (arr.length < ASSET_SLOTS) arr.push(null);
      arr[slot] = null;
      d.assets = arr;
      const names = Array.isArray(d.assetNames)
        ? (d.assetNames as (string | null)[]).slice(0, ASSET_SLOTS)
        : new Array(ASSET_SLOTS).fill(null);
      while (names.length < ASSET_SLOTS) names.push(null);
      names[slot] = null;
      d.assetNames = names;
      const mimes = Array.isArray(d.assetMimes)
        ? (d.assetMimes as (string | null)[]).slice(0, ASSET_SLOTS)
        : new Array(ASSET_SLOTS).fill(null);
      while (mimes.length < ASSET_SLOTS) mimes.push(null);
      mimes[slot] = null;
      d.assetMimes = mimes;
    }, LOCAL_ORIGIN);
  }

  function onCardContextMenu(ev: MouseEvent): void {
    ev.preventDefault();
    multiOpen = !multiOpen;
  }

  async function onFileChange(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    loading = true;
    error = null;
    try {
      // Encode for sync: an animated gif within the size cap is preserved
      // byte-for-byte (mime 'image/gif' → the render path animates it); anything
      // else is downscaled + JPEG-encoded (the workhorse still path). Off the
      // main thread inside createImageBitmap + OffscreenCanvas.
      const enc = await encodePickedFile(file);
      if (enc.fellBack === 'gif-too-large') {
        error = `gif too large — showing first frame only`;
      }
      // Single transact so peers see one update with bytes + mime + name.
      ydoc.transact(() => {
        const target = patch.nodes[id];
        if (!target) return;
        if (!target.data) target.data = {};
        const d = target.data as Record<string, unknown>;
        d.imageBytes = enc.base64;
        d.imageMime = enc.mime;
        d.imageName = file.name;
      }, LOCAL_ORIGIN);
      // The $effect above will pick up the new bytes and apply them to
      // our local engine on the next microtask — same code path as a
      // remote peer's update, no special-casing.
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
      // Reset the input so picking the SAME file twice in a row triggers
      // a fresh change event (browsers suppress it otherwise).
      try {
        input.value = '';
      } catch {
        /* not all browsers allow input.value reset on file inputs */
      }
    }
  }

  const inputs = portsFromDef(pictureboxDef.inputs, {
    asset_pitch: 'ASSET PITCH', asset_gate: 'ASSET GATE',
  });
  const outputs = portsFromDef(pictureboxDef.outputs);
</script>

<div
  class="vcard card video"
  data-has-image={hasImage}
  data-testid="picturebox-card"
  oncontextmenu={onCardContextMenu}
  role="region"
  aria-label="PICTUREBOX image source"
>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="PICTUREBOX" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
  <div class="picker">
    <label class="pick-btn">
      <input type="file" accept="image/*" onchange={onFileChange} data-testid="picturebox-file-input" />
      <span>{loading ? 'Loading...' : 'Choose image...'}</span>
    </label>
    {#if hasImage}
      <!-- Card preview. A gif data: URL animates natively in the <img> (a cheap
           preview independent of the GL render); a still shows one frame. Hidden
           on an empty card so the VRT baseline is unaffected. -->
      <img
        class="preview"
        src={`data:${imageMime};base64,${imageBytes}`}
        alt={imageName ?? 'loaded image'}
        data-testid="picturebox-preview"
        data-animated={isGif}
      />
    {/if}
    {#if imageName}
      <div class="filename" title={imageName} data-testid="picturebox-filename">{imageName}</div>
    {/if}
    {#if hasImage}
      <div class="sync-hint" data-testid="picturebox-synced">
        {isGif ? 'gif' : `synced (${TARGET_W}×${TARGET_H})`}
      </div>
    {/if}
    {#if error}
      <div class="error" data-testid="picturebox-error">{error}</div>
    {/if}
  </div>

  <div class="fader-grid">
    <Fader value={p('gain')} min={0} max={2} defaultValue={pictureboxDef.params.find((x) => x.id === 'gain')!.defaultValue} label="Gain" curve="linear" onchange={setParam('gain')} moduleId={id} paramId="gain" />
  </div>

  {#if multiOpen}
    <!-- "Load multiple…" 7-slot panel. Right-click the card to toggle. Each
         row maps to a note (C..B) → asset slot; a clip player's note/gate
         output switches which slot displays. -->
    <div class="multi-panel" data-testid="picturebox-multi-panel">
      <div class="multi-head">
        <span>Load multiple…</span>
        <button type="button" class="multi-close" onclick={() => (multiOpen = false)} data-testid="picturebox-multi-close" aria-label="Close">✕</button>
      </div>
      {#each ASSET_SLOT_LABELS as label, i (i)}
        <div class="slot-row" data-testid="picturebox-slot-{i}">
          <span class="slot-note">{label}</span>
          <label class="slot-load">
            <input type="file" accept="image/*" onchange={(e) => onSlotFileChange(e, i)} data-testid="picturebox-slot-input-{i}" />
            <span>{slotLoading[i] ? '…' : 'Load file…'}</span>
          </label>
          <span class="slot-name" title={assetNames[i] ?? ''} data-testid="picturebox-slot-name-{i}">{assetNames[i] ?? '—'}</span>
          {#if assets[i]}
            <button type="button" class="slot-clear" onclick={() => clearSlot(i)} data-testid="picturebox-slot-clear-{i}" aria-label="Clear slot {label}">✕</button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
  </PatchPanel>
</div>

<style>
  .card {
    width: 220px;
    min-height: 240px;
  }
  .stripe {background: var(--cable-image); }  .picker {
    margin: 18px 16px 8px;
    text-align: center;
  }
  .pick-btn {
    display: inline-block;
    padding: 4px 10px;
    background: var(--cable-image);
    color: #000;
    border-radius: 2px;
    font-size: 0.7rem;
    cursor: pointer;
    user-select: none;
  }
  .pick-btn input { display: none; }
  .filename {
    margin-top: 6px;
    font-size: 0.6rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .preview {
    display: block;
    margin: 6px auto 0;
    max-width: 100%;
    max-height: 56px;
    border-radius: 2px;
    object-fit: contain;
    background: #000;
    image-rendering: auto;
  }
  .sync-hint {
    margin-top: 2px;
    font-size: 0.55rem;
    color: var(--cable-image);
    font-family: ui-monospace, monospace;
    opacity: 0.6;
  }
  .error {
    margin-top: 6px;
    font-size: 0.6rem;
    color: #f87171;
    font-family: ui-monospace, monospace;
  }
  .fader-grid {
    margin-top: 18px;
    padding: 0 12px;
    display: flex;
    justify-content: center;
  }

  /* "Load multiple…" 7-slot panel (right-click toggle). Floats as an absolute
     overlay sheet over the card body INSTEAD of stacking in normal flow: the
     card is pinned to an exact rack-unit height (min/max-height locked by
     `.rack-sized` in _module-card.css), so an in-flow panel pushed past the
     tier and spilled outside the card box. As an overlay it sits within the
     fixed card box and scrolls if it ever exceeds it. */
  .multi-panel {
    position: absolute;
    left: 8px;
    right: 8px;
    top: 34px; /* below the card title */
    max-height: calc(100% - 42px); /* never exceed the card; scroll if it would */
    z-index: 6;
    padding: 6px;
    background: #0c0f14;
    border: 1px solid var(--cable-image);
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
    font-size: 0.6rem;
    color: var(--cable-image);
    font-family: ui-monospace, monospace;
    letter-spacing: 0.04em;
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
  .multi-close:hover, .slot-clear:hover { color: #f87171; }
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
  .slot-load {
    display: inline-block;
    padding: 1px 5px;
    background: var(--cable-image);
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
