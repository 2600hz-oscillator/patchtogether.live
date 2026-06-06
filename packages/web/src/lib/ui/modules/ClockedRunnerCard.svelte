<script lang="ts">
  // ClockedRunnerCard — a mini-LIVECODE that owns a single clocked()
  // callback. Spawned by the parent LIVECODE card when the user
  // invokes clocked(division, fn); the runner stores the function body
  // + the division on node.data and the audio-domain factory's tick
  // re-evaluates the body on every division boundary.
  //
  // Card chrome:
  //   - Title with the runner name + the division (e.g. "1/16")
  //   - Per-tick error indicator (red dot when lastError is set)
  //   - Division dropdown (live edit — apply takes effect next tick)
  //   - CodeMirror editor (compact; no gutter)
  //   - Status line showing fires-since-mount + last error if any

  import { onDestroy, onMount } from 'svelte';
  import { useStore, type NodeProps } from '@xyflow/svelte';
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import { useEngine } from '$lib/audio/engine-context';
  import { makeEditor, type EditorHandle } from '$lib/livecode/editor';
  import { makeCompletionSource } from '$lib/livecode/completions';
  import { makeLinter } from '$lib/livecode/diagnostics';
  import { CLOCKED_DIVISIONS } from '$lib/livecode/api-surface';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  const flowStore = useStore();

  // ───── Sizing ─────────────────────────────────────────────────
  const DEFAULT_WIDTH = 360;
  const DEFAULT_HEIGHT = 220;
  const MIN_WIDTH = 280;
  const MIN_HEIGHT = 160;

  let cardWidth = $derived<number>((node?.data?.width as number | undefined) ?? DEFAULT_WIDTH);
  let cardHeight = $derived<number>((node?.data?.height as number | undefined) ?? DEFAULT_HEIGHT);
  let resizing = $state(false);
  let resizeAbort: AbortController | null = null;

  function onResizeStart(ev: PointerEvent) {
    ev.preventDefault(); ev.stopPropagation();
    resizing = true;
    const startX = ev.clientX, startY = ev.clientY;
    const startW = cardWidth, startH = cardHeight;
    resizeAbort = new AbortController();
    const sig = resizeAbort.signal;
    const onMove = (mev: PointerEvent) => {
      const zoom = flowStore.viewport.zoom || 1;
      const w = Math.max(MIN_WIDTH, Math.round(startW + (mev.clientX - startX) / zoom));
      const h = Math.max(MIN_HEIGHT, Math.round(startH + (mev.clientY - startY) / zoom));
      const target = patch.nodes[id];
      if (target) {
        if (!target.data) target.data = {};
        target.data.width = w;
        target.data.height = h;
      }
    };
    const stop = () => { resizing = false; resizeAbort?.abort(); resizeAbort = null; };
    window.addEventListener('pointermove', onMove, { signal: sig });
    window.addEventListener('pointerup', stop, { signal: sig });
    window.addEventListener('pointercancel', stop, { signal: sig });
  }

  // ───── Data ────────────────────────────────────────────────────
  // (displayName moved into ModuleTitle in the title chrome.)
  let division = $derived<string>((node?.data?.division as string | undefined) ?? '1/16');
  let storedSource = $derived<string>((node?.data?.source as string | undefined) ?? '');

  // ───── Editor ──────────────────────────────────────────────────
  let editorEl: HTMLDivElement | null = $state(null);
  let editor: EditorHandle | null = null;
  let commitTimer: ReturnType<typeof setTimeout> | null = null;
  const COMMIT_DEBOUNCE_MS = 250;

  function commitSource(value: string) {
    const target = patch.nodes[id];
    if (!target) return;
    if ((target.data?.source as string | undefined) === value) return;
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      t.data.source = value;
    }, LOCAL_ORIGIN);
  }

  function scheduleCommit(value: string) {
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(() => commitSource(value), COMMIT_DEBOUNCE_MS);
  }

  function setDivision(d: string) {
    const target = patch.nodes[id];
    if (!target) return;
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      t.data.division = d;
    }, LOCAL_ORIGIN);
  }

  onMount(() => {
    if (!editorEl) return;
    editor = makeEditor({
      parent: editorEl,
      doc: storedSource,
      onChange: (value) => scheduleCommit(value),
      completionSource: makeCompletionSource(() => ({
        liveNodes: patch.nodes,
        liveEdges: patch.edges,
      })),
      lintSource: makeLinter(() => ({
        liveNodes: patch.nodes,
        liveEdges: patch.edges,
      })),
      showGutter: false,
    });
  });

  $effect(() => {
    const s = storedSource;
    if (!editor) return;
    editor.setDoc(s);
  });

  onDestroy(() => {
    if (commitTimer) clearTimeout(commitTimer);
    editor?.destroy();
    editor = null;
  });

  // ───── Live status (polled from engine.read) ───────────────────
  let lastError = $state<string | null>(null);
  let firesSinceMount = $state(0);
  let pollId: ReturnType<typeof setInterval> | null = null;
  const POLL_MS = 200;

  function poll() {
    const e = engineCtx.get();
    if (!e || !node) return;
    const err = e.read(node, 'lastError');
    lastError = typeof err === 'string' ? err : null;
    const fires = e.read(node, 'firesSinceMount');
    firesSinceMount = typeof fires === 'number' ? fires : 0;
  }
  pollId = setInterval(poll, POLL_MS);
  onDestroy(() => {
    if (pollId !== null) clearInterval(pollId);
    pollId = null;
  });

  let statusText = $derived(
    lastError ? lastError : `fired ${firesSinceMount}× (every ${division})`,
  );

  // ───── Sizing ──────────────────────────────────────────────────
  const HEADER_PX = 56;
  const FOOTER_PX = 28;
  let bodyHeight = $derived(Math.max(80, cardHeight - HEADER_PX - FOOTER_PX));
</script>

<div
  class="card clocked-runner"
  class:resizing
  class:err={!!lastError}
  style="width: {cardWidth}px; height: {cardHeight}px;"
  data-testid="clocked-runner-card"
  data-node-id={id}
>
  <div class="stripe"></div>
  <header class="title">
    <ModuleTitle {id} {data} defaultLabel="clockedRunner" inline />
    <select
      class="division-select nodrag"
      value={division}
      onchange={(e) => setDivision((e.target as HTMLSelectElement).value)}
      data-testid="clocked-runner-division"
    >
      {#each CLOCKED_DIVISIONS as d}
        <option value={d} selected={d === division}>{d}</option>
      {/each}
    </select>
  </header>

  <div
    bind:this={editorEl}
    class="editor nodrag"
    data-testid="clocked-runner-editor"
    style="height: {bodyHeight}px;"
  ></div>

  <div class="status" data-testid="clocked-runner-status" class:err={!!lastError}>
    {statusText}
  </div>

  <div
    class="resize-handle nodrag"
    role="separator"
    aria-label="Resize"
    onpointerdown={onResizeStart}
  ></div>
</div>

<style>
  .card {
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 16px;
    padding-bottom: 4px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
    overflow: hidden;
  }
  :global(.svelte-flow__node:hover) .card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .card.resizing { transition: none; }
  .card.err { border-color: #fca5a5; }
  .stripe {
    position: absolute; top: 0; left: 0; right: 0; height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--cable-gate);
  }
  .title {
    display: flex; align-items: center; gap: 8px;
    padding: 0 12px;
    font-size: 0.75rem;
    margin-bottom: 6px;
  }
  .title .name {
    color: var(--accent, #00f0ff);
    font-weight: 600;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, monospace;
  }
  .division-select {
    background: rgba(10, 12, 16, 0.8);
    color: var(--cable-gate, #ffd000);
    border: 1px solid var(--cable-gate, #ffd000);
    border-radius: 2px;
    padding: 1px 4px;
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
    cursor: pointer;
  }
  .editor {
    margin: 0 12px;
    border: 1px solid var(--border);
    border-radius: 2px;
    overflow: hidden;
  }
  .editor :global(.cm-editor) { height: 100%; }
  .status {
    font-size: 0.65rem;
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
    padding: 4px 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status.err { color: #fca5a5; }
  .resize-handle {
    position: absolute; right: 0; bottom: 0;
    width: 14px; height: 14px;
    cursor: nwse-resize;
    background: linear-gradient(135deg, transparent 60%, var(--cable-gate, #ffd000) 60%, var(--cable-gate, #ffd000) 70%, transparent 70%);
    opacity: 0.6;
  }
  .resize-handle:hover { opacity: 1; }
</style>
