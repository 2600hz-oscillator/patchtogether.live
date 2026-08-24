<script lang="ts">
  // PictureboxCard — file-picker source. User clicks "Choose image..."
  // → file is zoom-fit-cropped to the ENGINE RESOLUTION (TARGET_W×TARGET_H =
  // 1024×768) → encoded as JPEG q=85 → base64 → written into
  // node.data.imageBytes. The Y.Doc carries those bytes to every rack-mate;
  // every peer runs the reverse path (base64 → ImageBitmap → engine.setImage)
  // automatically — from the NODE-lifetime producer, not from this card (#1720;
  // see the note below).
  //
  // ⚠ THIS HEADER USED TO SAY "downscaled to 640x480" — wrong by 2.56× in area,
  // and contradicted by this card's own `synced (${TARGET_W}×${TARGET_H})` line
  // a few hundred lines below. Fixed with the faceplate promotion.
  //
  // ⚠ THIS CARD IS NO LONGER THE ONLY SURFACE. picturebox is promoted, so the
  // dock full view renders `<ModuleShell>` and the module's own
  // `picturebox/PictureboxAssetsBody.svelte` instead of this file; the card
  // still renders in the LANE under `?shell=legacy`. Both write node.data
  // through the one seam at `$lib/graph/picturebox-data.ts` — do not add a third
  // spelling of those writes to either surface.
  //
  // Multiplayer: image content NOW syncs across rack-mates — sizing,
  // codec, and limit decisions are documented in picturebox-encode.ts.
  import { type NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import {
    setSlotAsset,
    clearSlotAsset,
    setSingleImage,
  } from '$lib/graph/picturebox-data';
  import { pictureboxDef } from '$lib/video/modules/picturebox';
  import {
    encodePickedFile,
    GIF_MIME,
    TARGET_W,
    TARGET_H,
  } from '$lib/video/modules/picturebox-encode';
  import { ASSET_SLOTS, ASSET_SLOT_LABELS } from '$lib/video/asset-select';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { paramSpec, portsFromDef } from './card-kit';

  // ⚠ THE RANGE COMES FROM THE DEF, AND IT DID NOT USED TO (D3, the backdraft
  // class). This card passed `min={0} max={2}` as NUMERIC LITERALS while reading
  // `defaultValue` correctly off the def — a second copy of a number no gate
  // could see, because `contract-lock`, `module-docs-lint` and every range
  // assertion read the DEF. picturebox sat outside `RANGE_BOUND_CARDS`, which is
  // where CLAUDE.md says this class actually lives now.
  //
  // Promotion is what turns it from a hazard into a cost: from picturebox
  // entering STRICT_FACES the DOCK renders this fader straight off the
  // `ParamDef`, so a later edit to either copy would give one control two
  // travels depending on which surface you were looking at.
  //
  // ⚠ BOUND VIA `paramSpec`, NOT VIA A NEW EXPORTED CONSTANT — and the choice is
  // measured, not stylistic. `picturebox.ts` is in the WebGL attest basis, so an
  // exported `const PICTUREBOX_GAIN_RANGE` would be ordinary CODE and would move
  // the attest hash, costing a real-GPU re-attest that CI (SwiftShader) cannot
  // run. `paramSpec` adds nothing to the def at all: it reads the `ParamDef` the
  // def already declares. Same single source of truth, zero attest.
  const GAIN = paramSpec(pictureboxDef, 'gain');

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

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

  // ── THE PICTURE + THE ASSET-GATE POLL ARE NODE-OWNED (#1720) ──────────────
  //
  // This card used to own BOTH halves of its extras channel, and both broke the
  // same way. Under the faceplate shell an un-migrated module's card exists only
  // inside the dock full-view, so in the common case it is NEVER MOUNTED:
  //
  //   1. THE TEXTURE. `applyBytesToEngine` / `applySlotsToEngine` decoded
  //      node.data.imageBytes / .assets and uploaded them, retrying until the
  //      reconciler had built the engine node. Nothing else ever pushed, so a
  //      SAVED rack rendered the module's idle field instead of your image, on
  //      LOAD. Measured on the default /rack, reading the node's own output
  //      texture: meanRGB (5,15,20) never-mounted vs (0,0,254) with the card open.
  //
  //   2. THE CV INPUTS. A 33 ms interval was the ONLY consumer of ASSET GATE and
  //      ASSET PITCH: it polled the gate, rising-edge detected, and selected a
  //      slot. With no card the two jacks were patched, visibly connected and
  //      INERT — and the displayed slot LATCHED at its last selection rather than
  //      going dark, which is the stuck-value shape, not the placeholder shape.
  //      A fix that only restores the texture does NOT fix this one.
  //
  // Both MOVED to $lib/ui/media/extras-producers, driven by
  // $lib/ui/media/node-extras-registry, which is keyed to GRAPH lifetime and
  // swept from Canvas. The producer is now the ONLY writer of the texture and the
  // pump the ONLY reader of the gate, so there is no second code path to drift
  // from and no double edge-count. This card writes node.data and renders UI.
  //
  // The pump runs on ONE shared ticker for every pumped node at the same 33 ms
  // this card used, so gate timing is unchanged by the move.

  // ---- "Load multiple…" panel: per-slot file load --------------------
  //
  // ⚠ THE PAD-AND-SLICE MOVED OUT, AND IT WAS DUPLICATED HERE BEFORE IT DID.
  // `onSlotFileChange` and `clearSlot` were the SAME eighteen lines — keep the
  // three parallel arrays exactly ASSET_SLOTS long, write one index, reassign —
  // differing only in what they wrote. The dock faceplate's `fullViewBody` would
  // have been the third copy, so they were folded into ONE writer pair at
  // `$lib/graph/picturebox-data.ts` before the third was added. Same
  // LOCAL_ORIGIN transaction, same reassign semantics; the behaviour is
  // unchanged and `picturebox-data.test.ts` now pins it.
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
      setSlotAsset(id, slot, enc, file.name);
      // The node-lifetime extras producer pre-uploads the new slot bytes to the
      // engine on the next microtask (same path as a remote peer's update).
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      slotLoading[slot] = false;
      try { input.value = ''; } catch { /* */ }
    }
  }

  function clearSlot(slot: number): void {
    clearSlotAsset(id, slot);
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
      setSingleImage(id, enc, file.name);
      // The node-lifetime extras producer picks up the new bytes and applies
      // them to our local engine on the next microtask — same code path as a
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
    <NeonFader value={p('gain')} min={GAIN.min} max={GAIN.max} defaultValue={GAIN.defaultValue} label={GAIN.label} curve={GAIN.curve} onchange={setParam('gain')} moduleId={id} paramId="gain" />
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
