<script lang="ts">
  // /media — the media-loader scaffold view. DELIBERATELY PLAIN: this page is
  // the plumbing demo for lib/media (drop ingestion + the centralized library
  // seam); the real UI design lands later on top of the same API. Full-page
  // drop target (files AND folders), hidden-input browse fallbacks, and a
  // bare list of loaded items with inline previews.
  import {
    ingestDrop,
    ingestFiles,
    type IngestResult,
    type RejectedMedia,
  } from '$lib/media/ingest';
  import {
    mediaLibrary,
    type MediaItem,
    type SkippedDuplicate,
  } from '$lib/media/library.svelte';

  // Depth counter: dragging across child elements fires enter/leave pairs;
  // the affordance stays on until the counter drains (or the drop lands).
  let dragDepth = $state(0);
  const dragActive = $derived(dragDepth > 0);

  // Most recent drop/browse outcome — replaced per action, not accumulated.
  let rejected = $state<RejectedMedia[]>([]);
  let skipped = $state<SkippedDuplicate[]>([]);

  let fileInput = $state<HTMLInputElement | undefined>();
  let folderInput = $state<HTMLInputElement | undefined>();

  function applyResult(result: IngestResult) {
    const addRes = mediaLibrary.add(result.accepted);
    rejected = result.rejected;
    skipped = addRes.skipped;
  }

  async function onDrop(ev: DragEvent) {
    ev.preventDefault();
    dragDepth = 0;
    if (!ev.dataTransfer) return;
    applyResult(await ingestDrop(ev.dataTransfer));
  }

  function onDragEnter(ev: DragEvent) {
    ev.preventDefault();
    dragDepth += 1;
  }

  function onDragOver(ev: DragEvent) {
    ev.preventDefault(); // required, or the browser navigates to the file
  }

  function onDragLeave(ev: DragEvent) {
    ev.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
  }

  function onPick(ev: Event) {
    const input = ev.currentTarget as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      applyResult(ingestFiles(input.files));
    }
    input.value = ''; // re-picking the same file must still fire (dupe notice)
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatMeta(item: MediaItem): string {
    const parts: string[] = [];
    if (item.meta.width != null && item.meta.height != null) {
      parts.push(`${item.meta.width}×${item.meta.height}`);
    }
    if (item.meta.durationS != null && Number.isFinite(item.meta.durationS)) {
      parts.push(`${item.meta.durationS.toFixed(2)}s`);
    }
    return parts.join(' · ');
  }
</script>

<svelte:head>
  <title>media loader — patchtogether.live</title>
</svelte:head>

<div class="media-view">
  <header class="topbar">
    <h1>media loader</h1>
    <span class="topbar-note">scaffold — drop files or folders anywhere below</span>
    <a class="topbar-link" href="/rack">← rack</a>
  </header>

  <section
    class="drop-zone"
    class:drag-active={dragActive}
    data-testid="media-drop-zone"
    data-drag-active={dragActive ? 'true' : 'false'}
    aria-label="media drop target"
    ondragenter={onDragEnter}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={onDrop}
  >
    <div class="actions">
      <button type="button" data-testid="media-browse-files" onclick={() => fileInput?.click()}>
        browse files…
      </button>
      <button
        type="button"
        data-testid="media-browse-folder"
        onclick={() => folderInput?.click()}
      >
        browse folder…
      </button>
      {#if mediaLibrary.count > 0}
        <button
          type="button"
          class="danger"
          data-testid="media-clear-all"
          onclick={() => mediaLibrary.clear()}
        >
          clear all ({mediaLibrary.count})
        </button>
      {/if}
    </div>
    <input
      bind:this={fileInput}
      type="file"
      multiple
      hidden
      data-testid="media-file-input"
      onchange={onPick}
    />
    <input
      bind:this={folderInput}
      type="file"
      webkitdirectory
      hidden
      data-testid="media-folder-input"
      onchange={onPick}
    />

    {#if skipped.length > 0}
      <div class="notice" data-testid="media-skipped-notice">
        <strong>skipped {skipped.length} duplicate{skipped.length === 1 ? '' : 's'}:</strong>
        {#each skipped as s (s.relativePath)}
          <div class="notice-row" data-testid="media-skipped-item">{s.relativePath} — {s.reason}</div>
        {/each}
      </div>
    {/if}

    {#if rejected.length > 0}
      <div class="notice warn" data-testid="media-rejected-notice">
        <strong>couldn't load {rejected.length} item{rejected.length === 1 ? '' : 's'}:</strong>
        {#each rejected as r (r.relativePath)}
          <div class="notice-row" data-testid="media-rejected-item">{r.relativePath} — {r.reason}</div>
        {/each}
      </div>
    {/if}

    {#if mediaLibrary.count === 0}
      <p class="empty-hint" data-testid="media-empty-hint">
        drop video, image or audio files — or whole folders — anywhere on this page.<br />
        loaded media collects here.
      </p>
    {:else}
      <ul class="items" data-testid="media-item-list">
        {#each mediaLibrary.items as item (item.id)}
          <li
            class="item"
            data-testid="media-item"
            data-media-id={item.id}
            data-kind={item.kind}
            data-status={item.status}
          >
            <div class="preview">
              {#if item.kind === 'video'}
                <!-- svelte-ignore a11y_media_has_caption -- user-loaded media has no caption track -->
                <video muted controls preload="metadata" src={item.objectUrl} data-testid="media-item-preview"
                ></video>
              {:else if item.kind === 'image'}
                <img src={item.objectUrl} alt={item.name} data-testid="media-item-preview" />
              {:else}
                <audio controls preload="metadata" src={item.objectUrl} data-testid="media-item-preview"
                ></audio>
              {/if}
            </div>
            <div class="info">
              <span class="item-name" data-testid="media-item-name">{item.relativePath}</span>
              <span class="item-fact kind-badge" data-testid="media-item-kind">{item.kind}</span>
              <span class="item-fact" data-testid="media-item-size">{formatSize(item.size)}</span>
              <span class="item-fact" data-testid="media-item-status">
                {item.status === 'failed' ? `probe failed (${item.probeError})` : item.status}
              </span>
              {#if item.status === 'ready' && formatMeta(item) !== ''}
                <span class="item-fact" data-testid="media-item-meta">{formatMeta(item)}</span>
              {/if}
            </div>
            <button
              type="button"
              class="remove"
              data-testid="media-item-remove"
              aria-label={`remove ${item.relativePath}`}
              onclick={() => mediaLibrary.remove(item.id)}
            >
              ✕
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<style>
  .media-view {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-ui);
  }

  .topbar {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 10px 16px;
    background: var(--surface-1);
    border-bottom: 1px solid var(--border);
  }

  .topbar h1 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .topbar-note {
    color: var(--text-dim);
    font-size: 12px;
  }

  .topbar-link {
    margin-left: auto;
    color: var(--accent);
    font-size: 13px;
    text-decoration: none;
  }

  .drop-zone {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 16px;
    border: 2px dashed transparent;
    transition: border-color 120ms ease, background-color 120ms ease;
  }

  .drop-zone.drag-active {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 6%, var(--bg));
  }

  .actions {
    display: flex;
    gap: 8px;
  }

  .actions button {
    padding: 6px 12px;
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .actions button:hover {
    border-color: var(--accent-dim);
  }

  .actions button.danger:hover {
    border-color: var(--cable-gate);
  }

  .notice {
    padding: 8px 12px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 13px;
  }

  .notice.warn {
    border-color: var(--cable-audio);
  }

  .notice-row {
    color: var(--text-dim);
  }

  .empty-hint {
    margin: auto;
    text-align: center;
    color: var(--text-dim);
    font-size: 14px;
    line-height: 1.7;
  }

  .items {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .item {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 6px;
  }

  .preview {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
  }

  .preview video,
  .preview img {
    max-width: 200px;
    max-height: 112px;
    border-radius: 4px;
    background: var(--module-bg-deep);
  }

  .preview audio {
    width: 240px;
  }

  .info {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
  }

  .item-name {
    font-size: 14px;
    word-break: break-all;
  }

  .item-fact {
    color: var(--text-dim);
    font-size: 12px;
  }

  .kind-badge {
    padding: 1px 6px;
    border: 1px solid var(--border-strong);
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .remove {
    margin-left: auto;
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
    background: transparent;
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
  }

  .remove:hover {
    color: var(--text);
    border-color: var(--cable-gate);
  }
</style>
