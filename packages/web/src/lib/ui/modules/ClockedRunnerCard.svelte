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
  import { type NodeProps } from '@xyflow/svelte';
  import { captureFlowStore } from './card-kit';
  import { createDebouncedCommit } from './debounced-commit';
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import {
    clockedRunnerDivisionValue,
    setClockedRunnerDivision,
  } from './clocked-runner-cell-actions';
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

  // ⚠ EVERY `node.data` DERIVATION BELOW IS KEYED ON THIS, and it is a fix
  // rather than ceremony. `patch.nodes[id]` is a Yjs proxy whose IDENTITY never
  // changes, so a `$derived` reading through it recomputes NEVER: the graph
  // updates and the view silently shows the value it had at mount — which on
  // THIS card means a `clocked()` call that rewrites the body would not appear.
  // `nodeVersion(id)` is the node's own Y.Doc revision, a value that changes.
  let dataVersion = $derived(nodeVersion(id));
  // Guarded: the dock full-view plain-mounts this card OUTSIDE the
  // SvelteFlow provider, where a bare useStore() throws and killed the
  // card at init (no video in the expanded faceplate). Inside the
  // provider this is byte-identical; outside it's null -> zoom 1.
  const flowStore = captureFlowStore();

  // ───── Sizing ─────────────────────────────────────────────────
  // Rounded to whole-u (180px) rack tiles (#759) so the default + min land on
  // the rack grid; this card is user-resizable so the rack CSS doesn't clamp it.
  const DEFAULT_WIDTH = 360;
  const DEFAULT_HEIGHT = 360;
  const MIN_WIDTH = 360;
  const MIN_HEIGHT = 180;

  let cardWidth = $derived.by<number>(() => {
    void dataVersion;
    return (node?.data?.width as number | undefined) ?? DEFAULT_WIDTH;
  });
  let cardHeight = $derived.by<number>(() => {
    void dataVersion;
    return (node?.data?.height as number | undefined) ?? DEFAULT_HEIGHT;
  });
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
      const zoom = flowStore?.viewport.zoom || 1;
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
  // ⚠ THE DEFAULT IS IMPORTED, NEVER RE-TYPED. It lived here as a literal
  // '1/16' while the def exported `CLOCKED_RUNNER_DEFAULT_DIVISION` and the
  // factory read that — two copies of one contract, in the file most likely to
  // be edited without the def open. `clockedRunnerDivisionValue` is the seam the
  // faceplate's selector cell reads, so the two surfaces cannot disagree.
  let division = $derived.by<string>(() => {
    void dataVersion;
    return clockedRunnerDivisionValue(node);
  });
  let storedSource = $derived.by<string>(() => {
    void dataVersion;
    return (node?.data?.source as string | undefined) ?? '';
  });

  // ───── Editor ──────────────────────────────────────────────────
  let editorEl: HTMLDivElement | null = $state(null);
  let editor: EditorHandle | null = null;
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

  // #1583: the debounce FLUSHES on unmount instead of dropping its pending value.
  // `commitSource` is the only writer of node.data.source, and onDestroy used to
  // `clearTimeout` the pending commit — so typing and then collapsing (or being
  // LRU-evicted when a third module is expanded) within COMMIT_DEBOUNCE_ms silently discarded
  // the edit. createDebouncedCommit exposes no `cancel`, so that is now unwritable.
  const draft = createDebouncedCommit<string>(commitSource, COMMIT_DEBOUNCE_MS);
  function scheduleCommit(value: string) {
    draft.schedule(value);
  }

  // ONE writer, shared with the faceplate's DIV cell.
  const setDivision = (d: string) => setClockedRunnerDivision(id, d);

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
    // FLUSH, never clearTimeout: a card unmount is a VIEW event (collapse / LRU
    // evict), not a signal that the user abandoned the edit (#1583).
    draft.flush();
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
  class="vcard card clocked-runner"
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
    padding-top: 16px;
    padding-bottom: 4px;
    overflow: hidden;
  }
  .card.resizing { transition: none; }
  .card.err { border-color: #fca5a5; }
  .stripe {
    background: var(--cable-gate);
  }
  .title {
    display: flex; align-items: center; gap: 8px;
    padding: 0 12px;
    font-size: 0.75rem;
    margin-bottom: 6px;
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
