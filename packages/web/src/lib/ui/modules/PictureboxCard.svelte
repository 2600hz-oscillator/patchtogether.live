<script lang="ts">
  // PictureboxCard — file-picker source. User clicks "Choose image..." and
  // the decoded ImageBitmap is uploaded into the module's source texture
  // via the handle's `read('extras')` channel.
  //
  // Phase-1 scope: per-user/local only. Multiplayer image sharing (Yjs
  // awareness handshake or CF R2) is deferred — see PR notes.
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { pictureboxDef, type PictureboxHandleExtras } from '$lib/video/modules/picturebox';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let filename = $state<string | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

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

  async function onFileChange(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    loading = true;
    error = null;
    try {
      // createImageBitmap handles decoding off the main thread; far better
      // than `<img>.onload` for large files.
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' as ImageBitmapOptions['imageOrientation'] });
      const extras = getExtras();
      if (!extras) {
        error = 'Engine not ready';
        return;
      }
      extras.setImage(bitmap);
      extras.setFilename(file.name);
      filename = file.name;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }
</script>

<div class="card video">
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
    {#if filename}
      <div class="filename" title={filename}>{filename}</div>
    {/if}
    {#if error}
      <div class="error">{error}</div>
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
    border: 1px solid #2a2f3a;
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
