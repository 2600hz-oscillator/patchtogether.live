<script lang="ts">
  // LivecodeCard — programmable rack scripter. v2 runtime: a JS sandbox
  // (new Function with curated globals) replaces the v1 custom DSL.
  // Editor: CodeMirror 6 with JS syntax highlighting, port-aware
  // autocomplete, and red-underline diagnostics for invalid patch()
  // pairs.
  //
  // Card chrome:
  //   - LIVECODE title
  //   - Run button + status line
  //   - CodeMirror editor (resizable; vertical-fill)
  //   - Output log
  //   - Bottom-right resize handle
  //
  // Per-rack Y.Doc sync: `node.data.text` mirrors the editor content.
  // Remote edits update the editor view via setDoc(). Local typing
  // commits debounced to keep Yjs traffic bounded.

  import { onDestroy, onMount } from 'svelte';
  import { useStore, type NodeProps } from '@xyflow/svelte';
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import { run, type RunResult } from '$lib/livecode/runtime';
  import { applyMutations } from '$lib/livecode/apply';
  import { makeEditor, type EditorHandle } from '$lib/livecode/editor';
  import { makeCompletionSource } from '$lib/livecode/completions';
  import { makeLinter } from '$lib/livecode/diagnostics';
  import { looksLikeLegacy, migrateLegacyText } from '$lib/livecode/migrate';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const flowStore = useStore();

  // ───── Resize state (unchanged from v1) ─────────────────────────
  const DEFAULT_WIDTH = 460;
  const DEFAULT_HEIGHT = 380;
  const MIN_WIDTH = 320;
  const MIN_HEIGHT = 240;

  let cardWidth = $derived<number>(
    (node?.data?.width as number | undefined) ?? DEFAULT_WIDTH,
  );
  let cardHeight = $derived<number>(
    (node?.data?.height as number | undefined) ?? DEFAULT_HEIGHT,
  );
  let resizing = $state(false);
  let resizeAbort: AbortController | null = null;

  function onResizeStart(ev: PointerEvent) {
    ev.preventDefault();
    ev.stopPropagation();
    resizing = true;
    const startX = ev.clientX, startY = ev.clientY;
    const startW = cardWidth, startH = cardHeight;
    resizeAbort = new AbortController();
    const sig = resizeAbort.signal;
    const onMove = (mev: PointerEvent) => {
      const zoom = flowStore.viewport.zoom || 1;
      const dx = (mev.clientX - startX) / zoom;
      const dy = (mev.clientY - startY) / zoom;
      const w = Math.max(MIN_WIDTH, Math.round(startW + dx));
      const h = Math.max(MIN_HEIGHT, Math.round(startH + dy));
      const target = patch.nodes[id];
      if (target) {
        if (!target.data) target.data = {};
        target.data.width = w;
        target.data.height = h;
      }
    };
    const stop = () => {
      resizing = false;
      resizeAbort?.abort();
      resizeAbort = null;
    };
    window.addEventListener('pointermove', onMove, { signal: sig });
    window.addEventListener('pointerup', stop, { signal: sig });
    window.addEventListener('pointercancel', stop, { signal: sig });
  }

  // ───── Editor state ──────────────────────────────────────────────
  let storedText = $derived<string>((node?.data?.text as string | undefined) ?? '');
  let editorEl: HTMLDivElement | null = $state(null);
  let editor: EditorHandle | null = null;
  let commitTimer: ReturnType<typeof setTimeout> | null = null;
  const COMMIT_DEBOUNCE_MS = 250;

  function commitDraft(value: string) {
    const target = patch.nodes[id];
    if (!target) return;
    if ((target.data?.text as string | undefined) === value) return;
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      t.data.text = value;
    }, LOCAL_ORIGIN);
  }

  function scheduleCommit(value: string) {
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(() => commitDraft(value), COMMIT_DEBOUNCE_MS);
  }

  onMount(() => {
    if (!editorEl) return;
    // One-time migration: if the stored text looks like legacy DSL,
    // wrap it in a banner comment + leave a fresh canvas at the top.
    const initial = looksLikeLegacy(storedText)
      ? migrateLegacyText(storedText)
      : storedText;
    if (initial !== storedText) commitDraft(initial);

    editor = makeEditor({
      parent: editorEl,
      doc: initial,
      onChange: (value) => scheduleCommit(value),
      completionSource: makeCompletionSource(() => ({
        liveNodes: patch.nodes,
        liveEdges: patch.edges,
      })),
      lintSource: makeLinter(() => ({
        liveNodes: patch.nodes,
        liveEdges: patch.edges,
      })),
    });
  });

  // Sync remote → editor (Yjs update from a collaborator).
  $effect(() => {
    const t = storedText;
    if (!editor) return;
    editor.setDoc(t);
  });

  onDestroy(() => {
    if (commitTimer) clearTimeout(commitTimer);
    editor?.destroy();
    editor = null;
  });

  // ───── Run state ─────────────────────────────────────────────────
  let lastResult = $state<RunResult | null>(null);

  function runScript() {
    // Flush any pending edits.
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
    if (editor) commitDraft(editor.view.state.doc.toString());

    const src = editor ? editor.view.state.doc.toString() : storedText;
    const result = run({
      src,
      liveNodes: patch.nodes,
      liveEdges: patch.edges,
      spawnOrigin: {
        x: (node?.position?.x ?? 0) + cardWidth + 60,
        y: node?.position?.y ?? 0,
      },
      ownerNodeId: id,
    });
    lastResult = result;
    if (result.mutations.length === 0) return;
    // Apply mutations transactionally — both success + partial-failure
    // (the runtime may have emitted some mutations before throwing,
    // and the user may want them applied).
    ydoc.transact(() => applyMutations(result.mutations), LOCAL_ORIGIN);
  }

  // ───── Sizing ────────────────────────────────────────────────────
  const HEADER_PX = 56;
  const FOOTER_PX = 20;
  let bodyHeight = $derived(Math.max(160, cardHeight - HEADER_PX - FOOTER_PX));
  let outputHeight = $derived(Math.round(Math.max(80, bodyHeight * 0.28)));
  let editorHeight = $derived(Math.max(80, bodyHeight - outputHeight - 44));

  let statusText = $derived.by(() => {
    if (!lastResult) return 'Type a script and press Run';
    if (lastResult.ok) {
      const m = lastResult.mutations;
      return `OK — ${m.length} mutation${m.length === 1 ? '' : 's'} applied`;
    }
    return `${lastResult.error.line}:${lastResult.error.col}: ${lastResult.error.message}`;
  });

  let logLines = $derived.by<string[]>(() => {
    if (!lastResult) return [];
    const lines = lastResult.ok ? lastResult.log : lastResult.partialLog;
    return lines.map((l) => l.message);
  });

  // Dev-only test hook — same shape as the v1 card so existing E2E
  // tests that drive runScript via __livecode.<id>.run() keep working.
  if (import.meta.env.DEV) {
    $effect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = globalThis as any;
      if (!w.__livecode) w.__livecode = {};
      w.__livecode[id] = {
        run: (script?: string) => {
          if (typeof script === 'string' && editor) editor.setDoc(script);
          runScript();
        },
        getStatus: () => statusText,
        getLastResult: () => lastResult,
      };
      return () => {
        if (w.__livecode) delete w.__livecode[id];
      };
    });
  }
</script>

<div
  class="card livecode"
  class:resizing
  style="width: {cardWidth}px; height: {cardHeight}px;"
  data-testid="livecode-card"
  data-node-id={id}
>
  <div class="stripe"></div>
  <header class="title">LIVECODE</header>

  <div class="body" style="height: {bodyHeight}px;">
    <div class="toolbar">
      <button
        type="button"
        class="run-btn nodrag"
        data-testid="livecode-run"
        onclick={(e) => { e.preventDefault(); e.stopPropagation(); runScript(); }}
      >Run</button>
      <span
        class="status"
        class:err={!!(lastResult && !lastResult.ok)}
        data-testid="livecode-status"
      >{statusText}</span>
    </div>
    <div
      bind:this={editorEl}
      class="editor nodrag"
      data-testid="livecode-editor"
      style="height: {editorHeight}px;"
    ></div>
    <div class="output" data-testid="livecode-output" style="height: {outputHeight}px;">
      {#if logLines.length === 0}
        <div class="output-empty">output log appears here after Run</div>
      {:else}
        {#each logLines as line, i (i)}
          <div class="output-line">{line}</div>
        {/each}
      {/if}
    </div>
  </div>

  <div
    class="resize-handle nodrag"
    role="separator"
    aria-label="Resize LIVECODE"
    data-testid="livecode-resize-handle"
    onpointerdown={onResizeStart}
  ></div>
</div>

<style>
  .card {
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
    overflow: hidden;
  }
  :global(.svelte-flow__node:hover) .card {
    border-color: var(--accent-dim);
  }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .card.resizing { transition: none; }
  .stripe {
    position: absolute; top: 0; left: 0; right: 0; height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--cable-cv);
  }
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
    letter-spacing: 0.05em;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0 12px;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .run-btn {
    background: var(--cable-audio);
    color: #1a1d23;
    border: 1px solid var(--cable-audio);
    border-radius: 3px;
    padding: 4px 12px;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
  }
  .run-btn:hover { filter: brightness(1.08); }
  .status {
    font-size: 0.65rem;
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status.err { color: #fca5a5; }
  .editor {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 2px;
    overflow: hidden;
  }
  .editor :global(.cm-editor) { height: 100%; }
  .editor :global(.cm-editor.cm-focused) { outline: 1px solid var(--accent-dim); outline-offset: -1px; }
  .output {
    background: rgba(10, 12, 16, 0.5);
    border: 1px solid var(--border);
    border-radius: 2px;
    padding: 6px 8px;
    overflow-y: auto;
    font-family: ui-monospace, monospace;
    font-size: 0.65rem;
    color: var(--text-dim);
  }
  .output-empty { font-style: italic; opacity: 0.6; }
  .output-line {
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .output-line + .output-line {
    border-top: 1px dashed rgba(255, 255, 255, 0.04);
    margin-top: 2px;
    padding-top: 2px;
  }
  .resize-handle {
    position: absolute; right: 0; bottom: 0;
    width: 16px; height: 16px;
    cursor: nwse-resize;
    background: linear-gradient(
      135deg,
      transparent 50%, var(--cable-cv) 50%, var(--cable-cv) 60%,
      transparent 60%, transparent 70%, var(--cable-cv) 70%,
      var(--cable-cv) 80%, transparent 80%
    );
    opacity: 0.7;
    z-index: 5;
  }
  .resize-handle:hover { opacity: 1; }
</style>
