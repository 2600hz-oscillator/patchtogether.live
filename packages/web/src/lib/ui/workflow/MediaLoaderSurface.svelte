<script lang="ts">
  // MediaLoaderSurface — the WORKFLOW topbar "+" slot (P3): the media
  // loader. Click → the file picker (audio/video/image); RIGHT-click →
  // the folder-picker variant; the button is ALSO a drop target for
  // files or whole folders (mixed folders load the loadable and report
  // the rest — ingestDrop's per-entry isolation).
  //
  // Everything feeds the centralized mediaLibrary (lib/media, PR #1049);
  // the Loaded Assets Picker (floppy slot) lists what lands here.
  // Rejected/duplicate files surface UNOBTRUSIVELY: a small transient
  // notice anchored under the slot, auto-dismissed, with a manual ✕.
  import {
    ingestDrop,
    ingestFiles,
    type IngestResult,
    type RejectedMedia,
  } from '$lib/media/ingest';
  import { mediaLibrary, type SkippedDuplicate } from '$lib/media/library.svelte';

  /** How long the rejected/skipped notice lingers (ms). */
  const NOTICE_MS = 6000;

  let fileInput = $state<HTMLInputElement | undefined>();
  let folderInput = $state<HTMLInputElement | undefined>();

  // Drag-over affordance (depth counter — enter/leave pairs fire across
  // child elements; the highlight drains when the counter does).
  let dragDepth = $state(0);
  const dragActive = $derived(dragDepth > 0);

  let rejected = $state<RejectedMedia[]>([]);
  let skipped = $state<SkippedDuplicate[]>([]);
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  const noticeOpen = $derived(rejected.length > 0 || skipped.length > 0);

  function dismissNotice(): void {
    rejected = [];
    skipped = [];
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = null;
  }

  function applyResult(result: IngestResult): void {
    const addRes = mediaLibrary.add(result.accepted);
    rejected = result.rejected;
    skipped = addRes.skipped;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = null;
    if (rejected.length > 0 || skipped.length > 0) {
      noticeTimer = setTimeout(dismissNotice, NOTICE_MS);
    }
  }

  function onPick(ev: Event): void {
    const input = ev.currentTarget as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      applyResult(ingestFiles(input.files));
    }
    input.value = ''; // re-picking the same file must still fire (dupe notice)
  }

  async function onDrop(ev: DragEvent): Promise<void> {
    ev.preventDefault();
    dragDepth = 0;
    if (!ev.dataTransfer) return;
    applyResult(await ingestDrop(ev.dataTransfer));
  }
  function onDragEnter(ev: DragEvent): void {
    ev.preventDefault();
    dragDepth += 1;
  }
  function onDragOver(ev: DragEvent): void {
    ev.preventDefault(); // required, or the browser navigates to the file
  }
  function onDragLeave(ev: DragEvent): void {
    ev.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
  }
</script>

<div class="loader-anchor" data-wf-anchor="media-loader">
  <button
    class="slot-trigger"
    class:drag-active={dragActive}
    data-testid="workflow-topbar-slot-media-loader"
    data-drag-active={dragActive ? 'true' : 'false'}
    onclick={() => fileInput?.click()}
    oncontextmenu={(e) => {
      e.preventDefault();
      folderInput?.click();
    }}
    ondragenter={onDragEnter}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={onDrop}
    title="Load media — click: pick files · right-click: pick a folder · or drop files/folders here"
    aria-label="Load media (sound, video or image)"
  >+</button>
  <input
    bind:this={fileInput}
    type="file"
    multiple
    accept="audio/*,video/*,image/*"
    hidden
    data-testid="workflow-media-file-input"
    onchange={onPick}
  />
  <input
    bind:this={folderInput}
    type="file"
    webkitdirectory
    hidden
    data-testid="workflow-media-folder-input"
    onchange={onPick}
  />

  {#if noticeOpen}
    <div class="notice" data-testid="workflow-media-notice" role="status">
      <button
        class="notice-dismiss"
        data-testid="workflow-media-notice-dismiss"
        onclick={dismissNotice}
        aria-label="Dismiss media notice"
      >✕</button>
      {#if rejected.length > 0}
        <div class="notice-head">couldn't load {rejected.length}:</div>
        {#each rejected as r (r.relativePath)}
          <div class="notice-row" data-testid="workflow-media-rejected-item">
            {r.relativePath} — {r.reason}
          </div>
        {/each}
      {/if}
      {#if skipped.length > 0}
        <div class="notice-head">already loaded:</div>
        {#each skipped as s (s.relativePath)}
          <div class="notice-row" data-testid="workflow-media-skipped-item">
            {s.relativePath}
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .loader-anchor {
    position: relative;
  }
  .slot-trigger {
    width: 30px;
    height: 26px;
    border-radius: 3px;
    border: 1px solid #404652;
    background: #2a2f3a;
    color: var(--text);
    font-size: 0.9rem;
    cursor: pointer;
  }
  .slot-trigger:hover {
    background: #353a47;
  }
  .slot-trigger.drag-active {
    border-color: var(--accent, #4a9eff);
    background: #1d2735;
  }
  .notice {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 60;
    min-width: 240px;
    max-width: 340px;
    background: #14171c;
    border: 1px solid #404652;
    border-radius: 4px;
    padding: 8px 26px 8px 10px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    font-size: 0.7rem;
  }
  .notice-head {
    color: var(--text);
    margin-bottom: 2px;
  }
  .notice-row {
    color: var(--text-dim);
    word-break: break-all;
  }
  .notice-dismiss {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 18px;
    height: 18px;
    background: transparent;
    border: none;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 0.7rem;
  }
  .notice-dismiss:hover {
    color: var(--text);
  }
</style>
