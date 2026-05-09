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
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import { pictureboxDef, type PictureboxHandleExtras } from '$lib/video/modules/picturebox';
  import {
    downscaleAndEncode,
    base64ToImageBitmap,
    TARGET_W,
    TARGET_H,
  } from '$lib/video/modules/picturebox-encode';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let loading = $state(false);
  let error = $state<string | null>(null);

  // Reactive reads of the persisted shape (lives on node.data). Survives
  // remote Yjs updates because data flows through the snapshot bus.
  let imageBytes = $derived<string | null>(
    (node?.data as { imageBytes?: string | null } | undefined)?.imageBytes ?? null,
  );
  let imageName = $derived<string | null>(
    (node?.data as { imageName?: string | null } | undefined)?.imageName ?? null,
  );
  let hasImage = $derived(imageBytes !== null && imageBytes.length > 0);

  function p(name: string): number {
    const def = pictureboxDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
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
   */
  let lastAppliedBytes: string | null = null;
  $effect(() => {
    const bytes = imageBytes;
    // Always read engineCtx fresh — the engine may not exist on first
    // mount if the user hasn't gestured yet; we'll get a re-run when the
    // engine context fills in via its $derived chain.
    void bytes;
    void node?.id;
    if (bytes === lastAppliedBytes) return;
    lastAppliedBytes = bytes;
    void applyBytesToEngine(bytes);
  });

  async function applyBytesToEngine(bytes: string | null): Promise<void> {
    const extras = getExtras();
    if (!extras) {
      // Engine not ready yet. The $effect will re-fire when the engine
      // context populates, at which point lastAppliedBytes (above) gets
      // reset by the next genuine change — but to handle the "engine
      // boots AFTER bytes arrive" race specifically, we also reset
      // lastAppliedBytes here so the next $effect run retries.
      lastAppliedBytes = null;
      return;
    }
    if (bytes === null) {
      extras.setImage(null);
      extras.setFilename(null);
      return;
    }
    try {
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

  async function onFileChange(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    loading = true;
    error = null;
    try {
      // Downscale + encode (640x480 zoom-fit-crop, JPEG q=0.85). This
      // is the workhorse: ~100ms for a typical photo, much faster for
      // small images. Off the main thread inside createImageBitmap +
      // OffscreenCanvas.
      const base64 = await downscaleAndEncode(file);
      // Single transact so peers see one update with both bytes + name.
      ydoc.transact(() => {
        const target = patch.nodes[id];
        if (!target) return;
        if (!target.data) target.data = {};
        const d = target.data as Record<string, unknown>;
        d.imageBytes = base64;
        d.imageMime = 'image/jpeg';
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
</script>

<div
  class="card video"
  data-has-image={hasImage}
  data-testid="picturebox-card"
>
  <div class="stripe"></div>
  <header class="title">PICTUREBOX</header>

  <Handle type="target" position={Position.Left} id="gain" style="top: 56px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 50px;">G</span>

  <Handle type="source" position={Position.Right} id="out" style="top: 56px; --handle-color: var(--cable-image);" />
  <span class="port-label right" style="top: 50px;">OUT</span>

  <div class="picker">
    <label class="pick-btn">
      <input type="file" accept="image/*" onchange={onFileChange} data-testid="picturebox-file-input" />
      <span>{loading ? 'Loading...' : 'Choose image...'}</span>
    </label>
    {#if imageName}
      <div class="filename" title={imageName} data-testid="picturebox-filename">{imageName}</div>
    {/if}
    {#if hasImage}
      <div class="sync-hint" data-testid="picturebox-synced">
        synced ({TARGET_W}×{TARGET_H})
      </div>
    {/if}
    {#if error}
      <div class="error" data-testid="picturebox-error">{error}</div>
    {/if}
  </div>

  <div class="fader-grid">
    <Fader value={p('gain')} min={0} max={2} defaultValue={pictureboxDef.params.find((x) => x.id === 'gain')!.defaultValue} label="Gain" curve="linear" onchange={setParam('gain')} />
  </div>
</div>

<style>
  .card {
    width: 220px;
    min-height: 240px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
  }
  :global(.svelte-flow__node:hover) .card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; background: var(--cable-image); }
  .title { font-size: 0.85rem; font-weight: 500; text-align: center; margin: 0 0 8px; letter-spacing: 0.05em; }
  .port-label { position: absolute; font-size: 0.6rem; color: var(--text-dim); pointer-events: none; font-family: ui-monospace, monospace; }
  .port-label.left { left: 14px; }
  .port-label.right { right: 14px; }
  .picker {
    margin: 28px 16px 8px;
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
</style>
